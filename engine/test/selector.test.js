import { test } from 'node:test';
import assert from 'node:assert/strict';
import { synthesizeLink } from '../src/probes.js';
import { scoreParts, rankLadder, feasibility, AdaptiveSelector, coldStartPick } from '../src/score.js';
import { RUNGS, RUNG_BY_ID, allowedRungsFor, carrierOf } from '../src/ladder.js';
import { POLICIES, resolvePolicy } from '../src/tune.js';
import { planForNode } from '../src/index.js';
import { exampleProfile } from '../src/profile.js';

const android = { platform: 'android', mtu: 1420, interfaces: { wifi: true, cellular: false }, capabilities: { graphicalClient: true, packetInjection: false, mptcp: false } };
const node = (protocols) => ({ protocols, capabilities: { reality: true, tls: true, tfo: true, zeroRtt: true, tcpBrutal: true, probeResistant: true } });

test('UDP blocked ⇒ QUIC rungs are gated out before any scoring happens', () => {
  const link = synthesizeLink({ access: 'cellular', censor: 'udp-block' });
  for (const id of ['hy2_brutal', 'tuic_v5', 'wg_uot']) {
    const g = feasibility(RUNG_BY_ID[id], link, android, node([id]), resolvePolicy({}));
    assert.equal(g.ok, false, `${id} must be infeasible when UDP is gone`);
    assert.match(g.reason, /UDP|QUIC/);
  }
  const g = feasibility(RUNG_BY_ID.vless_reality_tcp, link, android, node(['vless_reality_tcp']), resolvePolicy({}));
  assert.equal(g.ok, true);
});

test('lossy but fat link ⇒ pacing-based Hysteria2 outranks plain window-based transports', () => {
  const lossy = synthesizeLink({ access: 'cellular', lossPct: 12, downMbps: 90, rttMs: 70 });
  const clean = synthesizeLink({ access: 'wifi', lossPct: 0.05, downMbps: 300, rttMs: 18 });
  const hy = scoreParts(RUNG_BY_ID.hy2_brutal, null, lossy, resolvePolicy({ mode: 'speed' })).throughput;
  const ss = scoreParts(RUNG_BY_ID.ss2022, null, lossy, resolvePolicy({ mode: 'speed' })).throughput;
  assert.ok(hy > ss, `expected BRUTAL (${hy.toFixed(3)}) to beat a loss-fragile rung (${ss.toFixed(3)}) at 12% loss`);
  const hyClean = scoreParts(RUNG_BY_ID.hy2_brutal, null, clean, resolvePolicy({ mode: 'speed' })).throughput;
  const wgClean = scoreParts(RUNG_BY_ID.wg_uot, null, clean, resolvePolicy({ mode: 'speed' })).throughput;
  assert.ok(wgClean >= hyClean, `on a clean 300 Mbps link the cheap rung should keep up (wg ${wgClean.toFixed(3)} vs hy ${hyClean.toFixed(3)})`);
});

test('MTU floor removes the QUIC rungs on a squeezed path', () => {
  const link = { ...synthesizeLink({ access: 'cellular' }), mtuCap: 1280 };
  const g = feasibility(RUNG_BY_ID.hy2_brutal, link, { ...android, mtu: 1180 }, node(['hy2_brutal']), resolvePolicy({}));
  assert.equal(g.ok, false);
  assert.match(g.reason, /MTU/);
});

test('a node that does not speak a rung can never be chosen for it', () => {
  const link = synthesizeLink({ access: 'wifi' });
  const ranked = rankLadder({ link, client: android, server: node(['ss2022']), policy: { mode: 'auto', allowLegacy: true } });
  const chosen = ranked.find((r) => r.feasible);
  assert.equal(chosen.rungId, 'ss2022', 'only the rung the node advertises may survive');
});

test('scores measured on the wire beat model priors', () => {
  const link = synthesizeLink({ access: 'wifi', downMbps: 200 });
  const ranked = rankLadder({
    link,
    client: android,
    server: node(['hy2_brutal', 'anytls']),
    policy: { mode: 'speed' },
    samples: {
      hy2_brutal: { downMbps: 25, rttMs: 90, attempts: 6, failures: 3 }, // shaped/quota-capped in reality
      anytls: { downMbps: 170, rttMs: 34, attempts: 6, failures: 0 },
    },
  });
  assert.equal(ranked.find((r) => r.feasible).rungId, 'anytls', 'the measured winner must win, whatever the priors said');
});

test('hysteresis: no switch for a marginal win, switch only on a sustained one', () => {
  let clock = 0;
  const sel = new AdaptiveSelector({ mode: 'auto' }, () => clock);
  const link = synthesizeLink({ access: 'wifi' });
  const server = node(['hy2_brutal', 'anytls', 'tuic_v5', 'vless_reality_tcp', 'ss2022', 'wg_uot', 'naive_h3', 'vless_reality_grpc']);
  const rank = (anytlsBoost) => {
    const rows = rankLadder({ link, client: android, server, policy: { mode: 'auto' }, samples: {}, history: sel.history() });
    // simulate the incumbent leading, then the challenger leading by a controlled margin
    const inc = rows.find((r) => r.rungId === 'hy2_brutal');
    inc.score = 0.9;
    const alt = rows.find((r) => r.rungId === 'anytls');
    alt.score = anytlsBoost;
    rows.sort((a, b) => b.score - a.score);
    return rows;
  };
  sel.current = 'hy2_brutal';
  sel.since = 0;
  let d = sel.decide(rank(0.93)); // +3.3% — noise
  assert.equal(d.pick, 'hy2_brutal', 'must not flap on a 3% difference');
  assert.match(d.why, /within/);
  d = sel.decide(rank(0.99)); // +10% — above the 15% gate? no, 10%
  assert.equal(d.pick, 'hy2_brutal', '10% is still below the gate');
  clock += 60_000; // let the dwell timer expire
  d = sel.decide(rank(1.05)); // +16.7% sustained candidate
  assert.equal(d.pick, 'hy2_brutal', 'first confirming sample only arms the switch');
  d = sel.decide(rank(1.05));
  assert.equal(d.pick, 'anytls', 'second confirming sample completes the handover');
  assert.equal(d.switched, true);
});

test('repeated failures park a rung in an exponential cooldown and it is re-tried later', () => {
  let clock = 0;
  const sel = new AdaptiveSelector({}, () => clock);
  sel.observe('hy2_brutal', false);
  sel.observe('hy2_brutal', false);
  const st = sel.state.hy2_brutal;
  assert.ok(st.cooldownUntil > clock, 'two failures must open a cooldown');
  const first = st.cooldownUntil - clock;
  sel.observe('hy2_brutal', false);
  const second = sel.state.hy2_brutal.cooldownUntil - clock;
  assert.ok(second > first, `backoff must grow (${first} → ${second})`);
  assert.ok(second <= 15 * 60_000, 'backoff must stay bounded');
  clock = second + 1;
  const link = synthesizeLink({ access: 'wifi' });
  const ranked = rankLadder({ link, client: android, server: node(['hy2_brutal']), policy: { mode: 'auto' }, history: sel.history() });
  assert.ok(ranked.find((r) => r.rungId === 'hy2_brutal').score > 0, 'a rung is never banned forever — censors change too');
});

test('cold start is deterministic and explainable', () => {
  const a = coldStartPick(synthesizeLink({ access: 'wifi' }), android, node(['hy2_brutal', 'anytls']), resolvePolicy({ mode: 'speed' }));
  const b = coldStartPick(synthesizeLink({ access: 'wifi' }), android, node(['hy2_brutal', 'anytls']), resolvePolicy({ mode: 'speed' }));
  assert.equal(a.rungId, b.rungId);
  assert.ok(RUNGS.some((r) => r.id === a.rungId));
});

test('policy modes change the decision, not just the label', () => {
  const profile = exampleProfile();
  const pick = (mode, censor) =>
    planForNode({ profile, nodeId: 'fra-1', policy: { mode }, linkSpec: { access: 'cellular', censor, lossPct: 6 } }).chosen;
  // A protocol-wide UDP throttle: pacing has nothing to pace into, so TCP must win.
  const throttled = planForNode({ profile, nodeId: 'fra-1', policy: { mode: 'speed' }, linkSpec: { access: 'cellular', censor: 'udp-throttle', lossPct: 6 } });
  assert.ok(['vless_reality_tcp', 'vless_reality_grpc', 'anytls', 'naive_h3', 'vless_ws_cdn', 'ss2022'].includes(throttled.chosen), `speed mode must leave UDP when all UDP is throttled, got ${throttled.chosen}`);
  // Per-port QoS is the opposite case: stay on UDP and hop away from the shaped port.
  const qos = planForNode({ profile, nodeId: 'fra-1', policy: { mode: 'speed' }, linkSpec: { access: 'cellular', censor: 'port-qos', lossPct: 6 } });
  assert.equal(qos.chosen, 'hy2_brutal', 'hopping should beat paying a TLS+TCP tax for a port problem');
  assert.ok(qos.ladder.find((l) => l.rungId === 'hy2_brutal').tuning.hop.server_ports?.length, 'the winner must actually hop');
  // Latency-first on a clean path must not choose a TCP rung.
  assert.ok(['hy2_brutal', 'tuic_v5', 'wg_uot'].includes(pick('game', 'none')), 'on a clean path latency-first prefers a UDP rung');
  // Under a UDP block, latency-first takes the cheapest handshake available (no TLS).
  assert.ok(['ss2022', 'anytls', 'vless_reality_tcp', 'naive_h3'].includes(pick('game', 'udp-block')));
  // Deep DPI: whatever wins must have paid for it on the wire.
  const deep = planForNode({ profile, nodeId: 'fra-1', policy: { mode: 'stealth' }, linkSpec: { access: 'cellular', censor: 'deep-packet', lossPct: 6 } });
  const deepChosen = deep.ladder.find((l) => l.rungId === deep.chosen);
  assert.ok(deepChosen.parts.evasion >= 0.75, `stealth picked ${deep.chosen} with evasion ${deepChosen.parts.evasion}`);
  assert.ok(deepChosen.flags.some((f) => f.flag.startsWith('obfs')), 'deep DPI must trigger size padding');
});

test('selector members must all be outbound carriers', () => {
  assert.equal(carrierOf('wg_uot'), 'endpoint');
  assert.equal(carrierOf('hy2_brutal'), 'outbound');
  const profile = exampleProfile();
  const plan = planForNode({ profile, nodeId: 'fra-1', linkSpec: { access: 'wifi', censor: 'none' } });
  const sel = plan.config.outbounds.find((o) => o.type === 'selector');
  assert.ok(sel, 'expected a selector so switching needs no restart');
  assert.equal(sel.outbounds.includes('savak-wg_uot'), false, 'an endpoint cannot be a selector member');
  assert.ok(sel.outbounds.includes('savak-hy2_brutal'));
  assert.equal(sel.default, `savak-${plan.chosen}`);
});

test('WG winning produces an interface config instead of a selector config', () => {
  const profile = exampleProfile({
    servers: [
      {
        id: 'wg-only',
        label: 'Frankfurt WG',
        address: 'wg.savak.example',
        ports: { wg: 51820 },
        protocols: ['wg_uot'],
        capabilities: { tls: true },
        credentials_hint: 'wg',
      },
    ],
  });
  const plan = planForNode({
    profile,
    nodeId: 'wg-only',
    policy: { mode: 'game' },
    link: { ...synthesizeLink({ access: 'wifi', lossPct: 0.02, downMbps: 400, rttMs: 12 }), mtuCap: 1500 },
  });
  assert.equal(plan.chosen, 'wg_uot');
  assert.equal(plan.config.endpoints?.[0]?.type, 'wireguard');
  assert.equal(plan.config.inbounds, undefined, 'the endpoint owns the interface, so no TUN inbound is emitted');
  assert.equal(plan.config.route.final, 'savak-direct');
});

test('allowedRungsFor keeps Tor out of everything except resistance mode', () => {
  for (const mode of Object.keys(POLICIES).filter((m) => m !== 'resist')) {
    assert.equal(allowedRungsFor(mode, { allowLegacy: true }).some((r) => r.id === 'tor_bridge'), false, mode);
  }
  assert.ok(allowedRungsFor('resist').some((r) => r.id === 'tor_bridge'));
});
