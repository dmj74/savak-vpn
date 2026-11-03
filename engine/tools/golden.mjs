#!/usr/bin/env node
/**
 * `npm run golden` — writes the parity fixture the Android unit test compares against.
 *
 * The phone re-implements scoring (so it can switch transports between check-ins), and a
 * silent divergence between Kotlin and JavaScript looks exactly like "the app picked a bad
 * protocol today". Pinning expected numbers here turns that into a failing test instead.
 *
 *   node tools/golden.mjs [outfile]
 */
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RUNGS } from '../src/ladder.js';
import { planForNode } from '../src/index.js';
import { synthesizeLink } from '../src/probes.js';
import { exampleProfile } from '../src/profile.js';

const SCENARIOS = [
  { name: 'clean wifi, high capacity', link: { access: 'wifi', rttMs: 12, lossPct: 0, downMbps: 300, mtu: 1500 }, mode: 'auto', samples: {} },
  { name: 'cellular, lossy, 40 Mbps', link: { access: 'cellular', rttMs: 68, lossPct: 4, downMbps: 40, upMbps: 8, mtu: 1420 }, mode: 'auto', samples: { hy2_brutal: { attempts: 3, failures: 0, downMbps: 31, rttMs: 70 } } },
  { name: 'udp blocked entirely', link: { access: 'wifi', rttMs: 30, lossPct: 0, downMbps: 120, udpBlocked: true, mtu: 1500 }, mode: 'speed', samples: {} },
  { name: 'quic killed, sni filtered', link: { access: 'cellular', rttMs: 90, lossPct: 1.5, downMbps: 25, quicBlocked: true, sniFiltered: true, mtu: 1400 }, mode: 'stealth', samples: {} },
  { name: 'udp throttled protocol-wide', link: { access: 'wifi', rttMs: 22, lossPct: 9, downMbps: 60, udpThrottled: true, mtu: 1500 }, mode: 'auto', samples: {} },
  { name: 'per-port qos only', link: { access: 'wifi', rttMs: 22, lossPct: 9, downMbps: 60, portThrottled: true, mtu: 1500 }, mode: 'auto', samples: {} },
  { name: 'shaped + size heuristic', link: { access: 'cellular', rttMs: 120, lossPct: 2, downMbps: 15, bandwidthShaped: true, sizeHeuristic: true, mtu: 1400 }, mode: 'speed', samples: {} },
  { name: 'game: low rtt matters', link: { access: 'wifi', rttMs: 8, lossPct: 0.5, downMbps: 200, mtu: 1500 }, mode: 'game', samples: { wg_uot: { attempts: 5, failures: 0, downMbps: 190, rttMs: 9 } } },
  { name: 'resist: active probing suspected', link: { access: 'wifi', rttMs: 40, lossPct: 1, downMbps: 50, activeProbeSuspected: true, sniFiltered: true, mtu: 1500 }, mode: 'resist', samples: {} },
  { name: 'tiny mtu squeezes QUIC out', link: { access: 'cellular', rttMs: 55, lossPct: 3, downMbps: 12, mtu: 1180 }, mode: 'auto', samples: {} },
];

const ALL_PROTOCOLS = RUNGS.map((r) => r.id);

/** One node speaking every rung, so a scenario only varies the *link*. */
function fullLadderProfile() {
  const base = exampleProfile();
  return {
    ...base,
    signature: undefined,
    servers: [
      {
        ...base.servers[0],
        protocols: ALL_PROTOCOLS,
        capabilities: { reality: true, tls: true, tfo: true, zeroRtt: true, tcpBrutal: true, naivePow: true, cdnFronting: true, probeResistant: true, ech: false },
        ports: { hy2: 443, tuic: 443, reality: 443, realityGrpc: 8443, anytls: 8444, ss: 8445, ws: 443, wg: 16000 },
        ports_443_hop: ['443:443', '2053:2096', '8443:8472'],
      },
      ...base.servers.slice(1),
    ],
  };
}

function round(v) {
  return typeof v === 'number' ? Number(v.toFixed(6)) : v ?? null;
}

const scenarios = [];
for (const sc of SCENARIOS) {
  // Deliberately generated through the *same* entry point the CLI/dashboard use, so the
  // fixture pins the whole pipeline (tuning included), not just the scoring formula.
  const plan = planForNode({
    profile: fullLadderProfile(),
    nodeId: 'fra-1',
    client: { platform: 'android', mtu: sc.link.mtu ?? 1420, capabilities: { graphicalClient: true, packetInjection: false, kernelTls: false } },
    policy: { mode: sc.mode },
    // linkSpec, not link: this routes the scenario through synthesizeLink() inside the
    // engine, so BOTH sides score the identical derived object (jitter, flows, tcpOnly,
    // mtuCap). Passing `link:` handed the engine the raw scenario while the fixture shipped
    // a synthesized view — 15 rows disagreed for exactly that reason, and the fixture would
    // have certified a port that reads a different link than the server does.
    linkSpec: sc.link,
    samples: sc.samples ?? {},
  });
  const rows = (plan.scoringTrace ?? []).filter((r) => r.inLadder);
  // CRITICAL: this must be the object the scorer actually received — plan.link, after the
  // engine's own synthesis. Rebuilding it here would hide a divergence in the derivation
  // itself (which fields get filled, which stay undefined).
  const scored = plan.link;
  const view = {};
  for (const k of ['access', 'rttMs', 'jitterMs', 'lossPct', 'downMbps', 'upMbps', 'flows', 'mtu', 'mtuCap', 'udpBlocked', 'quicBlocked', 'http2Killed', 'wgSignatureBlocked', 'ssSaltBlocked', 'quicRateLimited', 'sniFiltered', 'quicFingerprinted', 'portThrottled', 'portBlocked', 'udpThrottled', 'bandwidthShaped', 'sizeHeuristic', 'activeProbeSuspected', 'ipRangeBlocked', 'tcpOnly', 'pmtuDrops', 'ipv6Flaky', 'tlsEoT', 'source']) {
    if (scored[k] !== undefined) view[k] = scored[k];
  }
  // The capability-side gates come from the plan itself (plan.capabilityGate) — the exact
  // map the bundle ships to phones. Recomputing them here would let the fixture and the
  // bundle disagree, which is the very failure this file exists to prevent.
  const nodeGate = plan.capabilityGate ?? {};
  scenarios.push({
    name: sc.name,
    mode: sc.mode,
    requested: { ...sc.link },
    link: view,
    nodeGate,
    samples: sc.samples ?? {},
    expected: rows.map((r) => ({
      rungId: r.rungId,
      feasible: r.feasible,
      reason: r.reason,
      score: round(r.score),
      // The device cannot observe the server's hop pool or the naive-H3 verdict, so the
      // bundle has to state them; without these fields the parity check is theatre.
      inputs: { evasionApplied: round(r.inputs.evasionApplied), canHop: !!r.inputs.canHop, ...(r.inputs.naiveQuic === undefined ? {} : { naiveQuic: !!r.inputs.naiveQuic }) },
      parts: {
        throughput: round(r.parts.throughput),
        latency: round(r.parts.latency),
        stability: round(r.parts.stability),
        evasion: round(r.parts.evasion),
        cost: round(r.parts.cost),
      },
    })),
  });
}

const out = {
  note: 'GENERATED by engine/tools/golden.mjs — do not edit. Regenerate with `npm run golden` after changing the engine.',
  generatedFrom: 'sing-box 1.14.4 ladder, engine/src/score.js via planForNode()',
  tolerance: 1e-5,
  scenarios,
};

const check = process.argv.includes('--check');
const target = new URL('../../android/app/src/test/resources/parity/golden.json', import.meta.url);
const asPath = fileURLToPath(target);
const text = `${JSON.stringify(out, null, 1)}\n`;
if (check) {
  const { readFile } = await import('node:fs/promises');
  let existing = null;
  try {
    existing = await readFile(asPath, 'utf8');
  } catch {
    /* missing */
  }
  if (existing !== text) {
    console.error('android/app/src/test/resources/parity/golden.json is STALE — run `npm run gen:golden` and commit it.');
    process.exitCode = 1;
  } else {
    console.log(`parity fixture is up to date (${scenarios.length} scenarios)`);
  }
} else {
  await mkdir(dirname(asPath), { recursive: true });
  await writeFile(asPath, text);
  console.log(`${asPath}: ${scenarios.length} scenarios, ${scenarios.reduce((n, s) => n + s.expected.length, 0)} ranking rows`);
}
