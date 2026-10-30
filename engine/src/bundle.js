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

  for (const server of profile.servers) {
    const scoped = { ...policy, ...(only.length ? { only } : {}) };
  const base = planForNode({ profile, nodeId: server.id, client, policy: scoped, link, linkSpec });
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

    nodes.push({
      id: server.id,
      label: server.label,
      address: server.address,
      region: server.region,
      preferredRung: base.chosen,
      allowedRungs: wanted,
      configs,
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
      warnings: base.warnings,
    });
  }

  return {
    bundleVersion: BUNDLE_VERSION,
    profileId: profile.profileId,
    issuer: profile.issuer,
    user: profile.user,
    signature: profile.signature,
    trust,
    engine: { version: '0.2.0', singBoxSchema: '1.14.4', ladder: RUNGS.map((r) => r.id) },
    policy: { mode: policy.mode ?? 'auto', minSwitchGainPct: policy.minSwitchGainPct, dwellMs: policy.dwellMs },
    linkAssumption: link ?? linkSpec ?? null,
    nodes,
    ok: errors.length === 0,
    errors,
  };
}
