/**
 * Savak Smart Evasion Engine — public API.
 *
 * The whole point of this module is that a *decision* is never separated from its
 * *evidence*: planForNode() returns the chosen transport together with the per-rung
 * scores, the tuning it applied, and a `why` for every knob, so the app can show the
 * user what the phone measured instead of asking them to trust a mystery "Auto" button.
 */

export { RUNGS, RUNG_BY_ID, FAMILY, allowedRungsFor, DEFAULT_HANDSHOOK_HOSTS } from './ladder.js';
export { POLICIES, resolvePolicy, tuneFor, sizeWindows, initialPacketSize } from './tune.js';
export { feasibility, scoreParts, rankLadder, AdaptiveSelector, coldStartPick } from './score.js';
export { clientConfig, serverConfig, DEFAULT_EVASION_DOMAINS, DEFAULT_DIRECT_DOMAINS } from './singbox.js';
export { synthesizeLink, CENSOR_PROFILES, measureLink, probeTcpRtt, probeUdp, probeThroughput, probeSniFilter, classifySniProbe } from './probes.js';
export { shareLinkFor, parseShareLink, wgConf } from './sharelinks.js';
export { signProfile, verifyProfile, generateSigningKey, exampleProfile, nodeView, profileId, loadProfile, saveProfile, canonicalJson } from './profile.js';
export { validateConfig, structuralLint } from './validate.js';
export { buildBundle, BUNDLE_VERSION } from './bundle.js';
export { x25519Keypair, wireGuardKeypair, realityKeypair, shadowsocks2022Key, generateCredentials, spkiPin, tlsKeypairForQuic, REALITY_CANDIDATES, pickRealityDest, uuid, secret } from './keys.js';

import { RUNGS, RUNG_BY_ID } from './ladder.js';
import { resolvePolicy, tuneFor } from './tune.js';
import { feasibility, scoreParts, rankLadder, weightedScore, AdaptiveSelector } from './score.js';
import { allowedRungsFor } from './ladder.js';
import { clientConfig, serverConfig } from './singbox.js';
import { shareLinkFor } from './sharelinks.js';
import { nodeView } from './profile.js';
import { synthesizeLink } from './probes.js';

const DEFAULT_CLIENT = Object.freeze({
  platform: 'android',
  capabilities: { graphicalClient: true, packetInjection: false, kernelTls: false, cdnFronting: false, torExecutable: null, mptcp: true },
  interfaces: { wifi: true, cellular: true },
  mtu: 1420,
});

function wireGuardEndpoint({ ctx, tuning, client }) {
  const creds = ctx.creds;
  const wg = creds.wg ?? {};
  return {
    type: 'wireguard',
    tag: ctx.tag,
    address: [tuning.clientIp ?? '10.66.66.2/32'],
    private_key: wg.clientPrivateKey,
    mtu: tuning.mtu ?? client.mtu ?? 1420,
    system: false, // userspace data path on Android (no root for a kernel interface)
    udp_fragment: !!tuning.dial?.udp_fragment,
    udp_mapping: 'endpoint_independent',
    udp_filtering: 'endpoint_independent',
    peers: [
      {
        address: ctx.server.address,
        port: ctx.server.ports?.wg ?? ctx.server.port,
        public_key: wg.serverPublicKey ?? wg.serverPrivateKey,
        ...(wg.psk ? { pre_shared_key: wg.psk } : {}),
        allowed_ips: ['0.0.0.0/0', '::/0'],
        persistent_keepalive_interval: ctx.server.access === 'cellular' ? 25 : 0,
      },
    ],
  };
}

/**
 * Build the per-node plan: tune every rung, gate it, score it, pick one, and
 * assemble a sing-box config that carries the entire feasible ladder.
 *
 * @param {object} p
 * @param {object} p.profile            signed/unsigned savak profile
 * @param {string} [p.nodeId]
 * @param {object} [p.client]           device capabilities (see DEFAULT_CLIENT)
 * @param {object} [p.policy]           {mode:'auto'|'speed'|'stealth'|'game'|'resist', ...overrides}
 * @param {object} [p.link]             measured/estimated link; else `linkSpec` is synthesised
 * @param {object} [p.linkSpec]         {access, censor, rttMs, lossPct, downMbps}
 * @param {object} [p.samples]          per-rung measurements {rungId:{downMbps,rttMs,failures,attempts}}
 * @param {object} [p.selector]         an AdaptiveSelector (stateful); else stateless pick
 */
export function planForNode({ profile, nodeId, client = {}, policy = {}, link, linkSpec, samples = {}, selector, incumbent } = {}) {
  const node = nodeView(profile, nodeId);
  const resolved = resolvePolicy(policy);
  const linkObj = link ?? synthesizeLink(linkSpec ?? { access: resolved.access });
  const mergedClient = { ...DEFAULT_CLIENT, ...client, capabilities: { ...DEFAULT_CLIENT.capabilities, ...(client.capabilities ?? {}) } };

  const ladderAllowed = new Set(allowedRungsFor(resolved.mode, { allowLegacy: resolved.allowLegacy, only: resolved.rungs ?? resolved.only }).map((r) => r.id));
  const ladder = RUNGS.map((rung) => {
    const ctx = {
      tag: `savak-${rung.id}`,
      server: { ...node, capabilities: node.capabilities ?? {}, ports: node.ports ?? {} },
      creds: profile.credentials ?? {},
      client: mergedClient,
      policy: resolved,
      profile: { user: profile.user ?? 'savak-user' },
      paths: {},
    };
    const notes = [];
    const tuning = tuneFor({ rung, link: linkObj, client: mergedClient, server: ctx.server, creds: ctx.creds, policy: resolved, notes });
    const gate = feasibility(rung, linkObj, mergedClient, node, resolved);
    if (!ladderAllowed.has(rung.id)) gate.ok = false, (gate.reason ??= 'not in the requested rung set');
    const applied = (tuning.evadeFlags ?? []).filter((f) => f.flag !== 'clean').length;
    const parts = scoreParts(rung, samples[rung.id], linkObj, resolved, applied, tuning);
    let outbound = null;
    let endpoint = null;
    if (gate.ok) {
      try {
        if (rung.id === 'wg_uot') endpoint = wireGuardEndpoint({ ctx, tuning, client: mergedClient });
        else outbound = rung.build(ctx, tuning);
      } catch (e) {
        return { rungId: rung.id, title: rung.title, feasible: false, reason: `build failed: ${e.message}`, score: 0, parts, tuning, notes };
      }
    }
    return {
      rungId: rung.id,
      id: rung.id,
      title: rung.title,
      lineage: rung.lineage,
      family: rung.family,
      tag: ctx.tag,
      feasible: gate.ok,
      reason: gate.ok ? '' : gate.reason,
      parts,
      tuning,
      notes,
      evadeFlags: tuning.evadeFlags,
      outbound,
      endpoint,
    };
  });

  const ranked = rankLadder({
    link: linkObj,
    client: mergedClient,
    server: node,
    policy: resolved,
    samples,
    history: selector?.history() ?? {},
    tunings: Object.fromEntries(ladder.map((r) => [r.rungId, r.tuning])),
  });
  const byId = Object.fromEntries(ladder.map((r) => [r.rungId, r]));
  for (const row of ranked) Object.assign(row, { title: byId[row.rungId]?.title, lineage: byId[row.rungId]?.lineage });

  let chosen;
  let decision;
  if (policy.pin) {
    // Manual override from the app's UI ("use this rung"). Still gated: pinning an
    // infeasible transport would produce a config that cannot connect, so it is refused.
    const row = ranked.find((r) => r.rungId === policy.pin);
    if (!row?.feasible) throw new Error(`pin=${policy.pin} is not feasible: ${row?.reason ?? 'not in this policy ladder'}`);
    chosen = policy.pin;
    decision = { pick: chosen, switched: chosen !== incumbent && !!incumbent, gainPct: 0, why: 'pinned by the user; the engine will not override a pin' };
  } else if (selector) {
    selector.current = incumbent ?? selector.current;
    decision = selector.decide(ranked);
    chosen = decision.pick;
  } else {
    const best = ranked.find((r) => r.feasible);
    chosen = best?.rungId;
    decision = { pick: chosen, switched: false, gainPct: 0, why: 'stateless pick: highest ranked feasible rung' };
  }
  if (!chosen) throw new Error(`ladder-empty for node ${node.id}: ${ranked.map((r) => `${r.rungId}:${r.reason || 'ok'}`).join(', ')}`);

  const usable = ranked.filter((r) => r.feasible).map((r) => ({ ...r, ...byId[r.rungId], score: r.score }));
  if (usable.some((r) => r.rungId === 'wg_uot') && chosen === 'wg_uot') {
    // Interface mode: report what we gave up, so the UI can say so honestly.
    for (const r of usable) if (r.rungId === 'wg_uot') r.notes = [...(r.notes ?? []), { key: 'carrier.endpoint', why: 'WG runs as its own interface: no per-domain evasion table, no split tunnel, no selector — reconnect cost on a switch is a full interface bring-up' }];
  }
  const config = clientConfig({
    profile,
    node,
    client: mergedClient,
    policy: resolved,
    link: linkObj,
    ladder: usable,
    chosen: `savak-${chosen}`,
    mtu: mergedClient.mtu,
  });

  const shareLinks = {};
  for (const row of usable) {
    const linkStr = shareLinkFor(row.rungId, { tag: `savak-${row.rungId}`, server: node, creds: profile.credentials ?? {}, access: linkObj.access }, row.tuning);
    if (linkStr) shareLinks[row.rungId] = linkStr;
  }

  // Which rungs the *node or the device* cannot serve, independent of today's link: the
  // subset of the gates a phone cannot re-derive (no TLS listener, no CDN fronting
  // configured, legacy interop off). Shipped so the device refuses the same rungs for the
  // same reason instead of inventing a verdict it has no data for.
  const capabilityGate = {};
  for (const rung of RUNGS) {
    const g = feasibility(rung, { source: 'neutral', access: 'wifi', rttMs: 30, lossPct: 0, downMbps: 50, mtuCap: 1500 }, mergedClient, node, resolved);
    if (!g.ok) capabilityGate[rung.id] = g.reason;
  }

  return {
    node: { id: node.id, label: node.label, address: node.address, region: node.region, protocols: node.protocols },
    mode: resolved.mode,
    link: linkObj,
    ladder: usable.map((r) => ({ rungId: r.rungId, title: r.title, lineage: r.lineage, family: r.family, score: round(r.score), parts: roundParts(r.parts), tuning: r.tuning, notes: r.notes, flags: r.evadeFlags })),
    ranking: ranked.map((r) => ({ rungId: r.rungId, title: r.title, feasible: r.feasible, reason: r.reason, score: round(r.score), explore: round(r.explore) })),
    /**
     * Full-precision trace of the same decision. `ranking` is rounded for humans; this is
     * what the generated parity fixture (android/.../parity/golden.json) and the app's own
     * scorer are compared against, because "close enough" in a 3-decimal score is exactly
     * how a Kotlin/JavaScript divergence hides for months and then eats a support week.
     * `inputs.blocked` inside it is the node/device-side gate the phone cannot re-derive
     * (no TLS listener, no CDN fronting, legacy interop off) — the same verdicts as
     * `capabilityGate` above, carried per row so the port never has to invent a reason.
     */
    capabilityGate,
    scoringTrace: ranked.map((r) => ({
      rungId: r.rungId,
      inLadder: r.inLadder,
      feasible: r.feasible,
      reason: r.reason,
      score: r.score,
      raw: r.raw,
      explore: r.explore,
      parts: r.parts,
      inputs: {
        evasionApplied: r.evasionApplied ?? 0,
        canHop: !!r.canHop,
        ...(r.naiveQuic === null || r.naiveQuic === undefined ? {} : { naiveQuic: r.naiveQuic }),
        // Capability/legacy/fronting rejections cannot be re-derived on the device, so the
        // bundle states them; the phone still decides the link-dependent gates itself.
        ...(capabilityGate[r.rungId] ? { blocked: capabilityGate[r.rungId] } : {}),
      },
    })),
    excluded: ranked.filter((r) => !r.feasible).map((r) => ({ rungId: r.rungId, reason: r.reason })),
    chosen,
    decision,
    outbound: byId[chosen].outbound ?? byId[chosen].endpoint ?? null,
    config,
    shareLinks,
    warnings: collectWarnings(ladder, linkObj, resolved),
  };
}

/** Race every node in a profile and return them best-first, plus the merged plan. */
export function planAcrossNodes(args) {
  const { profile, ...rest } = args;
  const perNode = profile.servers.map((s) => {
    try {
      return { ok: true, ...planForNode({ ...rest, profile, nodeId: s.id }) };
    } catch (e) {
      return { ok: false, node: { id: s.id, label: s.label }, error: e.message };
    }
  });
  const scored = perNode
    .filter((p) => p.ok)
    .map((p) => {
      const best = p.ladder.find((l) => l.rungId === p.chosen) ?? p.ladder[0];
      return { id: p.node.id, label: p.node.label, rung: p.chosen, throughputMbps: round1(best?.parts?.measured ?? best?.parts?.modelledMbps ?? 0), rttMs: round1(p.link.rttMs ?? 0), score: round(best?.score ?? 0) };
    })
    .sort((a, b) => b.score - a.score);
  const winner = scored[0];
  return { nodes: scored, best: winner ?? null, plans: perNode, config: winner ? perNode.find((p) => p.ok && p.node.id === winner.id).config : null };
}

const round = (v) => Math.round(v * 1000) / 1000;
const round1 = (v) => Math.round(v * 10) / 10;
const roundParts = (p) => Object.fromEntries(Object.entries(p).map(([k, v]) => [k, typeof v === 'number' ? round(k.endsWith('Mbps') ? v : v) : v]));

function collectWarnings(ladder, link, policy) {
  const w = [];
  if (policy.mode === 'speed' && link.lossPct > 6) w.push('speed mode on a lossy link: BRUTAL pacing amplifies loss — consider mode:auto');
  if (link.sniFiltered && !ladder.some((r) => r.tuning?.tls?.reality?.enabled || r.tuning?.tls?.ech?.enabled || r.tuning?.tls?.spoof)) {
    w.push('SNI filtering detected but nothing hides the SNI on this node: upgrade the node to Reality (server/bootstrap.sh --reality)');
  }
  if (clientAndroidNoSpoof(policy, link)) w.push('tls.spoof needs raw sockets (Linux/macOS/Windows + privileges); on Android the engine falls back to record_fragment');
  if (link.udpBlocked && policy.portHopping === 'always') w.push('port hopping is useless without UDP; disabling it');
  if (ladder.some((r) => r.tuning?.tls?.utls)) w.push('uTLS in use — upstream documents it as detectable; keep it only for legacy servers');
  return w;
}
const clientAndroidNoSpoof = (policy, link) => link.sniFiltered && policy.sniWhitelist?.length > 0 && link.platform === 'android';

export { weightedScore };
