/**
 * Profile bundle for the phone.
 * ============================
 *
 * Split of responsibility that the whole design hangs on:
 *
 *   • the *engine* (this repo) knows sing-box's config grammar, so it renders one
 *     finished sing-box config per feasible rung, offline, and signs the result;
 *   • the *phone* cannot run Node, but it is the only place that knows what the path
 *     actually feels like right now — RTT, loss, which port got throttled, whether
 *     WiFi and cellular are both up. So it carries a faithful port of the scorer and
 *     chooses among the pre-rendered configs.
 *
 * A switch between rungs is therefore "hand libbox the other already-valid config",
 * not "generate and trust a config on the device": fewer bytes, no config grammar to
 * keep in sync on the phone, and nothing the app can be talked into inventing.
 */

import { planForNode } from './index.js';
import { resolvePolicy } from './tune.js';
import { guardClientConfig } from './singbox.js';
import { verifyProfile } from './profile.js';
import { validateConfig } from './validate.js';
import { RUNGS } from './ladder.js';

export const BUNDLE_VERSION = 1;

/**
 * @param {object} p.profile      profile document (sign it before shipping)
 * @param {object} [p.client]     device capability hint baked into generation
 * @param {object} [p.policy]
 * @param {object} [p.link]       the link assumption used for tuning; the phone only
 *                                re-runs the *choice*, the knobs are precomputed
 * @param {string[]} [p.only]     restrict the emitted rungs
 * @param {boolean} [p.validate]  schema-validate every embedded config
 */
export async function buildBundle({ profile, client = {}, policy = {}, link, linkSpec, only = [], validate = true, trustedKeys = {} } = {}) {
  // The trust anchors are NOT part of the signed document (that would make the signature
  // cover its own verifier); they are baked into the app, or pinned in its config.
  const trust = profile.signature ? verifyProfile(profile, trustedKeys) : { ok: true, reason: 'unsigned bundle (development only)' };
  const nodes = [];
  const errors = [];

  // A feed-derived profile is *imported*, not trusted: its endpoints were chosen by
  // whoever wrote the list, not measured by this device. Refuse to build unless the
  // caller opts in, and say so in the bundle instead of quietly shipping it.
  const feedGate = profile.feedTrust === 'unverified' && !policy.allowUnverifiedFeed
    ? { ok: false, reason: `profile is a ${profile.feedTrust} feed (${profile.servers.length} imported endpoints): refusing to build a bundle that routes traffic through unmeasured exits. Re-run with policy.allowUnverifiedFeed=true to override, and expect the ladder to gate each node until it is probed.` }
    : null;
  // Refuse *before* touching a single endpoint: evaluating the ladder against a stranger's
  // credentials is neither needed nor safe, and a half-built bundle is the worst possible
  // output of a trust check.
  if (feedGate) {
    return { bundleVersion: BUNDLE_VERSION, profileId: profile.profileId, ok: false, errors: [feedGate.reason], feedGate, nodes: [] };
  }

  for (const server of profile.servers) {
    const scoped = { ...policy, ...(only.length ? { only } : {}) };
    let base;
    try {
      base = planForNode({ profile, nodeId: server.id, client, policy: scoped, link, linkSpec });
    } catch (e) {
      // A malformed or partial server (a subscription with one bad node is the common
      // case) must surface as an error row, not as a crash that hides the other servers.
      errors.push(`${server.id}: plan failed: ${e.message}`);
      continue;
    }
    const wanted = base.ranking.filter((r) => r.feasible).map((r) => r.rungId).filter((id) => !only.length || only.includes(id));

    const configs = {};
    const tuning = {};
    for (const rungId of wanted) {
      // One config per rung: the full ladder is still inside it (so a fallback is one
      // API call away), only the selector's `default` differs.
      const pinned = planForNode({ profile, nodeId: server.id, client, policy: scoped, link, linkSpec, pin: rungId });
      const cfg = pinned.config;
      const selector = cfg.outbounds.find((o) => o.type === 'selector');
      if (selector) selector.default = `savak-${rungId}`;
      configs[rungId] = cfg;
      if (validate) {
        const v = await validateConfig(cfg);
        if (!v.ok) errors.push(`${server.id}/${rungId}: ${v.errors.slice(0, 3).join('; ')}`);
      }
      // The kill-switch state is pre-rendered too, per node: on a phone the moment the
      // tunnel dies is the worst possible time to be composing JSON.
      if (policy.killSwitch) {
        // resolved policy, not the raw one: the guard's TUN must be byte-identical in shape
        // to the live config (same mtu/addresses/udp_timeout), or entering the guard
        // rebuilds the interface and reopens the leak window it exists to close.
        configs.__guard ??= guardClientConfig({ client, policy: resolvePolicy(scoped), link });
        if (validate) {
          const vg = await validateConfig(configs.__guard);
          if (!vg.ok) errors.push(`${server.id}/guard: ${vg.errors.slice(0, 3).join('; ')}`);
        }
      }
      const row = pinned.ladder.find((l) => l.rungId === rungId);
      tuning[rungId] = {
        bandwidth: row?.tuning.bandwidth,
        hop: row?.tuning.hop,
        obfs: row?.tuning.obfs,
        mux: row?.tuning.mux,
        windows: { connection: row?.tuning.connectionReceiveWindow, stream: row?.tuning.streamReceiveWindow },
        initialPacketSize: row?.tuning.initialPacketSize,
        zeroRtt: row?.tuning.zeroRtt,
        flags: row?.tuning.evadeFlags,
        notes: row?.notes,
      };
    }

    const guard = configs.__guard ?? null;
    delete configs.__guard;

    nodes.push({
      id: server.id,
      label: server.label,
      address: server.address,
      region: server.region,
      preferredRung: base.chosen,
      allowedRungs: wanted,
      configs,
      /** Pre-rendered lockdown config: TUN stays up, everything is `block`. Null when the
       *  profile did not ask for a kill switch. */
      guard,
      tuning,
      shareLinks: Object.fromEntries(Object.entries(base.shareLinks).filter(([k]) => wanted.includes(k))),
      ranking: base.ranking.map((r) => ({ rungId: r.rungId, feasible: r.feasible, score: r.score, reason: r.reason })),
      /**
       * Everything the device's own scorer cannot re-derive, per rung — how many evasion
       * flags the server actually applied, whether a hop pool exists, whether naive was
       * measured over H2, and which rungs the node/device cannot serve at all. Without this
       * the phone re-ranks from a *different* model of the same config and drifts quietly;
       * `LadderParityCheck` in the app asserts against these numbers.
       */
      scoringInputs: Object.fromEntries(base.scoringTrace.map((t) => [t.rungId, t.inputs])),
      // An imported node carries its own warning, per node rather than once per bundle: the
      // screen that shows a rung list has to say which endpoint nobody measured, next to the
      // endpoint it is recommending.
      warnings: server.trust === 'unverified' || profile.feedTrust === 'unverified'
        ? [...(base.warnings ?? []), 'trust:unverified — imported from a list, never measured by this device; do not put accounts or work traffic behind it']
        : base.warnings,
    });
  }

  if (feedGate) {
    return {
      bundleVersion: BUNDLE_VERSION,
      profileId: profile.profileId,
      ok: false,
      errors: [feedGate.reason],
      feedGate,
      nodes: [],
    };
  }

  return {
    bundleVersion: BUNDLE_VERSION,
    profileId: profile.profileId,
    issuer: profile.issuer,
    // Carried through because the *user-visible* label for a running tunnel has to come from
    // the signed document too. A notification titled after the app, not the profile, makes
    // "which of my three profiles is running right now?" unanswerable on the lock screen.
    profileName: profile.user ?? profile.name ?? null,
    user: profile.user,
    signature: profile.signature,
    trust,
    engine: { version: '0.2.0', singBoxSchema: '1.14.4', ladder: RUNGS.map((r) => r.id) },
    policy: {
      mode: policy.mode ?? 'auto',
      ...(() => {
        const r = resolvePolicy(policy);
        return { lowLatencyDial: r.lowLatencyDial ?? false, stack: r.stack, udpRelayMode: r.udpRelayMode };
      })(),
      minSwitchGainPct: policy.minSwitchGainPct,
      dwellMs: policy.dwellMs,
      // The phone applies these verbatim; they are *not* re-derived on the device, so a
      // missing field here means the feature is off, never "guessed on".
      killSwitch: policy.killSwitch ?? null,
      split: policy.split ?? null,
    },
    feedGate,
    linkAssumption: link ?? linkSpec ?? null,
    nodes,
    ok: errors.length === 0,
    errors,
  };
}
