import { test } from 'node:test';
import assert from 'node:assert/strict';
import { POLICIES, resolvePolicy, sizeWindows, initialPacketSize, tuneFor, ANYTLS_PADDING } from '../src/tune.js';
import { RUNGS, RUNG_BY_ID, pacingBandwidth } from '../src/ladder.js';
import { synthesizeLink } from '../src/probes.js';
import { exampleProfile } from '../src/profile.js';
import { nodeView } from '../src/profile.js';

const android = { platform: 'android', mtu: 1420, interfaces: { wifi: true, cellular: true }, capabilities: { graphicalClient: true, packetInjection: false, kernelTls: false, mptcp: false } };
const desktop = { platform: 'linux', mtu: 1460, tlsVersionAtLeast13: true, interfaces: { wifi: true }, capabilities: { graphicalClient: false, packetInjection: true, kernelTls: true, mptcp: true } };

const tune = (rungId, { link, client = android, mode = 'auto', creds, server } = {}) => {
  const rung = RUNG_BY_ID[rungId];
  const prof = exampleProfile();
  const node = server ?? nodeView(prof, 'fra-1');
  return tuneFor({
    rung,
    link: link ?? synthesizeLink({ access: 'wifi' }),
    client,
    server: node,
    creds: creds ?? prof.credentials,
    policy: resolvePolicy({ mode }),
    notes: [],
  });
};

test('catalogue is well-formed: every rung has an id, family, lineage, cost and affinity', () => {
  const ids = new Set();
  for (const r of RUNGS) {
    assert.match(r.id, /^[a-z0-9_]+$/);
    assert.ok(!ids.has(r.id), `duplicate rung id ${r.id}`);
    ids.add(r.id);
    assert.ok(['quic', 'tls-tcp', 'raw-udp', 'relay'].includes(r.family), r.id);
    assert.ok(r.lineage.length > 30, `${r.id} must say where it comes from`);
    assert.ok(typeof r.cost.cpuLoad === 'number' && r.cost.cpuLoad >= 0 && r.cost.cpuLoad <= 1, r.id);
    assert.ok(r.cost.overheadPct >= 0 && r.cost.overheadPct < 1, r.id);
    for (const k of ['loss', 'shaping', 'dpi_sni', 'dpi_quic', 'active_probe', 'tcp_only']) {
      assert.equal(typeof r.affinity[k], 'number', `${r.id} missing affinity.${k}`);
    }
    assert.equal(typeof r.build, 'function', r.id);
  }
  assert.ok(RUNGS.length >= 11, 'the ladder should span the famous tools');
});

test('BDP sizing: bigger pipe or fatter RTT must open the windows, never close them', () => {
  const small = sizeWindows({ downMbps: 10, rttMs: 30, streams: 4 });
  const fat = sizeWindows({ downMbps: 200, rttMs: 90, streams: 4 });
  assert.ok(fat.stream > small.stream * 6, `stream windows must scale with BDP (${fat.stream} vs ${small.stream})`);
  assert.ok(fat.connection >= small.connection);
  const capped = sizeWindows({ downMbps: 1000, rttMs: 500, streams: 8 });
  assert.ok(capped.connection <= 96 * 1024 * 1024, 'must stay bounded on absurd inputs');
  assert.ok(capped.stream <= 24 * 1024 * 1024, 'must stay bounded on absurd inputs');
  // A 1 MiB stream window over 80 ms is a ~100 Mbps per-flow ceiling; the point of the
  // sizing is that a fat pipe must not be left at that ceiling.
  const fatLink = sizeWindows({ downMbps: 400, rttMs: 80, streams: 4 });
  assert.ok(fatLink.stream / (80 / 1000) * 8 / 1e6 > 150, 'per-flow ceiling must exceed the link');
});

test('QUIC initial packet never exceeds what the path can carry', () => {
  assert.ok(initialPacketSize({ mtu: 1280 }, synthesizeLink({ access: 'cellular' })) <= 1280 - 76 + 1);
  const pmtud = initialPacketSize({ mtu: 1420 }, { ...synthesizeLink(), pmtuDrops: true });
  assert.ok(pmtud <= 1140, `PMTUD blackhole should shrink the first flight, got ${pmtud}`);
});

test('BRUTAL only engages with a real measurement; otherwise BBR is used', () => {
  const unmeasured = tune('hy2_brutal', { link: { ...synthesizeLink(), measured: false, downMbps: 0 } });
  assert.equal(unmeasured.bandwidth.downMbps, 0);
  assert.ok(['conservative', 'standard', 'aggressive'].includes(unmeasured.bbrProfile));
  const measured = tune('hy2_brutal', { link: { ...synthesizeLink(), downMbps: 120, upMbps: 40, lossPct: 9 }, mode: 'speed' });
  assert.ok(measured.bandwidth.downMbps > 90 && measured.bandwidth.downMbps < 120, `${measured.bandwidth.downMbps}`);
  assert.equal(measured.bandwidth.upMbps, pacingBandwidth({ measured: true, downMbps: 120, upMbps: 40 }, resolvePolicy({ mode: 'speed' })).upMbps);
});

test('evasion is conditional: clean path pays nothing, SNI-filtered path pays only what works', () => {
  const clean = tune('vless_reality_tcp', { link: synthesizeLink({ censor: 'none' }) });
  assert.equal(clean.tls.record_fragment, undefined);
  assert.equal(clean.tls.fragment, undefined);
  assert.equal(clean.tls.spoof, undefined);
  assert.deepEqual(clean.obfs, null);
  assert.deepEqual(clean.hop, {});

  const filteredAndroid = tune('vless_reality_tcp', { link: synthesizeLink({ censor: 'sni-only' }), creds: { ...exampleProfile().credentials, realityPublicKey: null } });
  assert.equal(filteredAndroid.tls.record_fragment, true, 'Android must fragment records — it cannot inject packets');
  assert.equal(filteredAndroid.tls.spoof, undefined);

  const filteredDesktop = tune('vless_reality_tcp', {
    link: synthesizeLink({ censor: 'sni-only' }),
    client: desktop,
    creds: { ...exampleProfile().credentials, realityPublicKey: null },
    server: { ...nodeView(exampleProfile(), 'fra-1'), capabilities: { tls: true, reality: false } },
  });
  assert.equal(typeof filteredDesktop.tls.spoof, 'string', 'desktop with raw sockets should forge a whitelisted Hello');
  assert.ok(['wrong-sequence', 'wrong-checksum', 'wrong-ack', 'wrong-md5', 'wrong-timestamp'].includes(filteredDesktop.tls.spoof_method));
});

test('Reality wins whenever the node supports it, and never claims to be a QUIC feature', () => {
  const t = tune('vless_reality_tcp', { link: synthesizeLink({ censor: 'sni-only' }) });
  assert.equal(t.tls.reality.enabled, true);
  assert.equal(t.tls.min_version, '1.3');
  const hy = tune('hy2_brutal', { link: synthesizeLink({ censor: 'sni-only' }) });
  assert.equal(hy.tls.reality, undefined, 'Reality over QUIC is not a thing — do not emit it');
});

test('uTLS is opt-in and loud about it', () => {
  const off = tune('vless_reality_tcp', { link: synthesizeLink({ censor: 'deep-packet' }) });
  assert.equal(off.tls.utls, undefined);
  const prof = exampleProfile();
  const on = tuneFor({
    rung: RUNG_BY_ID.vless_reality_tcp,
    link: synthesizeLink({ censor: 'deep-packet' }),
    client: android,
    server: nodeView(prof, 'ist-1'),
    creds: { ...prof.credentials, realityPublicKey: null },
    policy: resolvePolicy({ mode: 'resist', allowLegacyUtls: true }),
    notes: (globalThis.__n = []),
  });
  assert.ok(on.tls.utls?.enabled, 'resist mode may use uTLS against a non-Reality node');
  assert.ok(['chrome', 'firefox', 'edge', 'safari', '360', 'qq', 'ios', 'android', 'random', 'randomized'].includes(on.tls.utls.fingerprint));
});

test('port hopping only appears when UDP survives and the node has a port pool', () => {
  const throttled = tune('hy2_brutal', { link: { ...synthesizeLink(), portThrottled: true } });
  assert.ok(Array.isArray(throttled.hop.server_ports) && throttled.hop.server_ports.length > 1);
  assert.match(throttled.hop.hop_interval, /s$/);
  assert.notEqual(throttled.hop.hop_interval, throttled.hop.hop_interval_max, 'the interval must be randomised, not fixed');
  const blocked = tune('hy2_brutal', { link: { ...synthesizeLink(), portThrottled: true, udpBlocked: true } });
  assert.equal(blocked.hop?.server_ports, undefined);
});

test('kernel TLS: TX on desktop TCP rungs, RX never, and not under mux', () => {
  const linux = tune('vless_reality_tcp', { client: { ...desktop, capabilities: { ...desktop.capabilities } }, mode: 'speed' });
  // speed mode does not mux, so kTLS TX is legal here
  assert.ok(!linux.tls.kernel_rx, 'kernel_rx is documented as a pessimisation — must never be emitted');
  const withMux = tune('ss2022', { client: desktop, mode: 'auto' });
  assert.ok(withMux.mux, 'auto mode muxes the raw rung');
  assert.equal(withMux.tls.kernel_tx, undefined, 'splice(2) cannot be used behind a mux — kTLS must be off');
});

test('radio bonding only on graphical clients that actually have two radios', () => {
  const both = tune('hy2_brutal', {});
  assert.equal(both.dial.network_strategy, 'hybrid');
  const wifiOnly = tune('hy2_brutal', { client: { ...android, interfaces: { wifi: true, cellular: false } } });
  assert.equal(wifiOnly.dial.network_strategy, undefined);
  const headless = tune('hy2_brutal', { client: desktop });
  assert.equal(headless.dial.network_strategy, undefined, 'headless/CLI cannot use the graphical-client bonding');
});

test('game mode trades padding and hopping for latency', () => {
  const g = tune('hy2_brutal', { mode: 'game', link: synthesizeLink({ censor: 'sni-only', lossPct: 0.2 }) });
  assert.equal(g.obfs, null);
  assert.deepEqual(g.hop, {});
  const s = tune('hy2_brutal', { mode: 'stealth', link: synthesizeLink({ censor: 'sni-only', lossPct: 0.2 }) });
  assert.equal(s.obfs.type, 'gecko', 'stealth should always pad sizes');
});

test('anytls padding scheme is a real OpenVPN-like distribution', () => {
  assert.ok(ANYTLS_PADDING.some((l) => l.startsWith('2=')) && ANYTLS_PADDING.some((l) => l.includes(',c,')));
});

test('every policy mode produces a coherent weight vector that sums to ~1', () => {
  for (const [mode, p] of Object.entries(POLICIES)) {
    const sum = Object.values(p.weights).reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(sum - 1) < 0.02, `${mode} weights sum to ${sum}`);
    assert.ok(p.minSwitchGainPct >= 10, `${mode} must not switch on noise`);
  }
  const merged = resolvePolicy({ mode: 'speed', weights: { latency: 0.5 } });
  assert.equal(merged.weights.latency, 0.5, 'user overrides must survive');
  assert.equal(merged.weights.throughput, POLICIES.speed.weights.throughput);
});
