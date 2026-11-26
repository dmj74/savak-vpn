import { test } from 'node:test';
import assert from 'node:assert/strict';
import { POLICIES, resolvePolicy } from '../src/tune.js';
import { allowedRungsFor } from '../src/ladder.js';
import { tunInbound, routeBlock, guardClientConfig, clientConfig } from '../src/singbox.js';
import { buildBundle } from '../src/bundle.js';
import { ingestFeed, feedToProfile, describeFeed } from '../src/feed.js';
import { profileId } from '../src/profile.js';
import { validateConfig } from '../src/validate.js';
import { exampleProfile } from '../src/profile.js';

const android = { platform: 'android', mtu: 1420, interfaces: { wifi: true, cellular: true }, capabilities: { graphicalClient: true, packetInjection: false, kernelTls: false, mptcp: false } };
const link = { source: 'synthetic', access: 'cellular', rttMs: 34, lossPct: 0.2, jitterMs: 4, downMbps: 45, upMbps: 12, measured: true };

/* ── 1) the daily mode is a real mode, not a label ─────────────────────────────────────── */

test('daily policy: weights are a full distribution and it is a distinct choice from auto', () => {
  const daily = POLICIES.daily;
  assert.ok(daily, 'POLICIES.daily must exist');
  const sum = Object.values(daily.weights).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 1) < 0.02, `daily weights must sum to ~1, got ${sum}`);
  // Steady and low-latency, not peak-throughput: this is the whole point of the mode.
  assert.ok(daily.weights.latency > POLICIES.auto.weights.latency);
  assert.ok(daily.weights.stability > POLICIES.auto.weights.stability);
  assert.ok(daily.weights.throughput < POLICIES.auto.weights.throughput);
  assert.ok(daily.minSwitchGainPct > POLICIES.auto.minSwitchGainPct, 'daily must resist flapping');
  assert.ok(daily.probeIntervalMs.cellular > POLICIES.auto.probeIntervalMs.cellular, 'daily must probe less (battery)');
  assert.equal(daily.bondInterfaces, false, 'daily runs one interface');
  assert.equal(daily.lowLatencyDial, true);
});

test('daily excludes Tor but keeps everything else auto keeps', () => {
  const daily = allowedRungsFor('daily').map((r) => r.id);
  assert.ok(!daily.includes('tor_bridge'));
  assert.ok(daily.includes('wg_uot') && daily.includes('vless_reality_tcp'));
});

test('lowLatencyDial tightens the timeout that decides how long a dead path hurts', () => {
  const plain = resolvePolicy({ mode: 'auto' });
  const daily = resolvePolicy({ mode: 'daily' });
  assert.equal(plain.lowLatencyDial, undefined);
  assert.equal(daily.lowLatencyDial, true);
  const route = routeBlock({ policy: daily, client: android, link, useBond: false, fakeIp: true, final: 'savak-ladder' });
  assert.equal(route.default_fallback_delay, '200ms');
  const tun = tunInbound({ client: android, policy: daily, link, mtu: 1400 });
  assert.equal(tun.udp_timeout, '1m', 'cellular: short UDP mapping lifetime');
  const off = tunInbound({ client: android, policy: plain, link, mtu: 1400 });
  assert.equal(off.udp_timeout, undefined, 'auto must not silently change NAT behaviour');
});

/* ── 2) split tunneling reaches the config in the fields sing-box actually reads ───────── */

test('split tunneling: apps, prefixes and domains land in the tun/route blocks', () => {
  const policy = resolvePolicy({ mode: 'daily', split: { excludePackages: ['com.bank.app'], bypassDomains: ['intranet.ir'], bypassPrefixes: ['10.0.0.0/8'], excludePrefixes: ['192.168.0.0/16'] } });
  const tun = tunInbound({ client: android, policy, link, mtu: 1400 });
  assert.deepEqual(tun.exclude_package, ['com.bank.app']);
  assert.deepEqual(tun.route_exclude_address, ['192.168.0.0/16']);
  const route = routeBlock({ policy, client: android, link, useBond: false, fakeIp: true, final: 'savak-ladder' });
  assert.ok(route.rules.some((r) => r.outbound === 'savak-direct' && r.domain_suffix?.includes('intranet.ir')), 'bypassDomains must produce a direct rule');
  assert.ok(route.rules.some((r) => r.outbound === 'savak-direct' && r.ip_cidr?.includes('10.0.0.0/8')), 'bypassPrefixes must produce a direct rule');
  assert.equal(route.find_process, false, 'no per-packet UID lookup unless asked for');
});

test('split tunneling by process name pays for find_process, and include-mode wins over exclude', () => {
  const byProcess = routeBlock({ policy: resolvePolicy({ split: { bypassProcessNames: ['ir.mfa.app'] } }), client: android, link, useBond: false, fakeIp: true, final: 'savak-ladder' });
  assert.equal(byProcess.find_process, true);
  assert.ok(byProcess.rules.some((r) => r.process_name?.includes('ir.mfa.app')));

  const both = tunInbound({ client: android, policy: resolvePolicy({ includePackages: ['com.only.this'], excludePackages: ['com.contradiction'] }), link, mtu: 1400 });
  assert.deepEqual(both.include_package, ['com.only.this']);
  assert.equal(both.exclude_package, undefined, 'sing-box rejects include+exclude; the engine must not emit both');
});

/* ── 3) kill switch: the guard config is leak-free by construction ─────────────────────── */

test('killSwitch:block turns on strict_route on Android (it was off, which is the leak)', () => {
  const off = tunInbound({ client: android, policy: resolvePolicy({}), link, mtu: 1400 });
  const on = tunInbound({ client: android, policy: resolvePolicy({ killSwitch: 'block' }), link, mtu: 1400 });
  assert.equal(off.strict_route, false);
  assert.equal(on.strict_route, true);
});

test('guard config contains no path to the clear network and validates under the real schema', async () => {
  const g = guardClientConfig({ client: android, policy: { split: { excludePackages: ['com.bank.app'] } }, link, mtu: 1400 });
  const tags = g.outbounds.map((o) => o.tag);
  assert.ok(!tags.includes('savak-direct'), 'a direct outbound in the guard would be the leak');
  assert.deepEqual(g.outbounds, [{ type: 'block', tag: 'savak-block' }]);
  assert.equal(g.route.final, 'savak-block');
  assert.deepEqual(g.route.rules, [], 'no rules: nothing may be routed anywhere');
  // Same interface shape as the live config: changing addresses would rebuild the TUN and
  // briefly reopen the exact window the guard exists to close.
  assert.deepEqual(g.inbounds[0].address, tunInbound({ client: android, policy: resolvePolicy({}), link, mtu: 1400 }).address);
  assert.deepEqual(g.inbounds[0].exclude_package, ['com.bank.app'], 'split decisions survive the guard');
  const v = await validateConfig(g);
  assert.ok(v.ok, `guard config must satisfy the vendored sing-box schema: ${v.errors.join('; ')}`);
});

/* ── 4) the bundle carries it all, validated ───────────────────────────────────────────── */

test('bundle: guard per node, controls echoed, every embedded config schema-validated', async () => {
  const profile = exampleProfile();
  const bundle = await buildBundle({
    profile,
    client: android,
    link,
    policy: { mode: 'daily', killSwitch: 'block', split: { excludePackages: ['com.bank.app'], bypassDomains: ['intranet.ir'] } },
  });
  assert.ok(bundle.ok, `bundle must validate: ${bundle.errors.join('; ')}`);
  assert.equal(bundle.errors.length, 0);
  assert.equal(bundle.policy.mode, 'daily');
  assert.equal(bundle.policy.killSwitch, 'block');
  assert.deepEqual(bundle.policy.split.excludePackages, ['com.bank.app']);
  assert.equal(bundle.policy.lowLatencyDial, true);
  assert.equal(bundle.feedGate, null);
  // The notification label must come from the signed document, not be invented by the app.
  assert.equal(bundle.profileName, exampleProfile().user);
  for (const node of bundle.nodes) {
    assert.ok(node.guard, 'each node needs its own pre-rendered lockdown config');
    assert.equal(node.guard.route.final, 'savak-block');
    assert.ok(!Object.keys(node.configs).includes('__guard'), 'guard must not masquerade as a rung');
    for (const [rungId, cfg] of Object.entries(node.configs)) {
      const tun = cfg.inbounds.find((i) => i.type === 'tun');
      assert.equal(tun.strict_route, true, `${rungId}: kill switch must be inside the live config too`);
      assert.deepEqual(tun.exclude_package, ['com.bank.app']);
    }
  }
  const noKill = await buildBundle({ profile, client: android, link, policy: { mode: 'auto' } });
  assert.equal(noKill.nodes[0].guard, null, 'no kill switch asked for → no guard shipped');
  assert.equal(noKill.policy.killSwitch, null);
});

/* ── 5) feeds: imported ≠ trusted, and the gate is not decorative ──────────────────────── */

const FEED_LINKS = [
  'vless://b831f0a5-1234-4c8f-9a1f-0f5c2f0a9d11@reality.example:443?security=reality&sni=www.microsoft.com&pbk=SbXX4cSmLTAjZGFFhXXb0YbXZq0Z0fXw9ZQKk0hX4Gk&sid=ab&fp=chrome&type=tcp#reality-ok',
  'hy2://password123@hy.example:443?insecure=1&sni=www.microsoft.com#hy-insecure',
  'hy2://goodpass@hy2.example:443?sni=www.microsoft.com#hy-good',
  'ss://Y2hhY2hhMjAtaWV0Zi1wb2x5MTMwNTpzMWNyZXQ%3D@ss.example:8443#ss-node',
  'vless://uuid-no-reality@plain.example:8080?security=none&type=ws#no-tls',
  'trojan://x@ignored.example:443#unsupported-scheme',
  'not a link at all',
  'hy2://goodpass@hy2.example:443?sni=www.microsoft.com#duplicate-of-earlier',
];

test('feed: classifies what the link proves, rejects the rest, and never claims trust', () => {
  const feed = ingestFeed({ text: FEED_LINKS.join('\n') });
  assert.equal(feed.trusted, false, 'an imported list is never trusted');
  const ids = feed.nodes.map((n) => n.rung).sort();
  assert.ok(ids.includes('vless_reality_tcp') && ids.includes('hy2_brutal') && ids.includes('ss2022'), `got ${ids}`);
  const reasons = feed.rejectedDetail.map((r) => r.reason).join(' | ');
  assert.match(reasons, /unsupported link type/, 'trojan must be reported, not guessed');
  assert.match(reasons, /duplicate/, 'the same endpoint twice must be collapsed');
  assert.match(reasons, /insecure/, 'security=none is refused by default');
  const reality = feed.nodes.find((n) => n.rung === 'vless_reality_tcp');
  assert.equal(reality.capabilities.reality, true, 'the Reality key in the link is a fact about the link');
  const hy = feed.nodes.find((n) => n.rung === 'hy2_brutal');
  assert.ok(hy.caveats.some((c) => c.includes('exit-node is operated by someone you did not choose')), 'the operator risk is stated per node, not in a footnote');
  assert.ok(describeFeed(feed).includes('imported='));
});

test('feed: --require-reality and maxNodes are enforced before anything is imported', () => {
  const strict = ingestFeed({ text: FEED_LINKS.join('\n'), requireReality: true });
  assert.deepEqual(strict.nodes.map((n) => n.rung), ['vless_reality_tcp']);
  const capped = ingestFeed({ text: FEED_LINKS.join('\n'), maxNodes: 1 });
  assert.equal(capped.imported, 1);
  assert.match(capped.rejectedDetail.at(-1).reason, /maxNodes=1 reached/);
});

test('feed: base64 subscription bodies are expanded, junk lines never become servers', () => {
  const packed = Buffer.from(FEED_LINKS.slice(0, 2).join('\n')).toString('base64');
  const feed = ingestFeed({ text: packed });
  assert.equal(feed.imported, 1, 'the insecure one is refused, the reality one is kept');
  assert.equal(feed.nodes[0].capabilities.reality, true);
});

test('feed: buildBundle refuses an unverified feed until it is explicitly allowed', async () => {
  const feed = ingestFeed({ text: FEED_LINKS.join('\n') });
  const profile = feedToProfile(feed, { name: 'test-feed' });
  assert.equal(profile.signature, null);
  assert.equal(profile.trustAnchor, null);
  // A feed profile must be a *profile*, not a parallel format: same version field, same
  // content-addressed id rule, no trust anchor to lose.
  assert.equal(profile.profileVersion, 1);
  assert.equal(profile.user, 'test-feed');
  assert.ok(profile.createdAt, 'createdAt must exist or canonicalJson/verify diverge');
  assert.equal(profile.profileId, profileId(profile), 'profileId must be the content hash, as everywhere else');

  const refused = await buildBundle({ profile, client: android, link, policy: { mode: 'auto' }, validate: false });
  assert.equal(refused.ok, false, 'an unverified feed must not build a usable bundle by default');
  assert.match(refused.errors.join(' '), /unverified feed/);
  assert.deepEqual(refused.nodes, [], 'and it must not leak half-built nodes');
  assert.match(refused.feedGate.reason, /allowUnverifiedFeed/);

  const allowed = await buildBundle({ profile, client: android, link, policy: { mode: 'auto', allowUnverifiedFeed: true }, validate: false });
  assert.ok(allowed.nodes.length >= 1, 'with the opt-in it builds, so the gate is a decision and not a bug');
  assert.equal(allowed.feedGate, null);
  // A link names one protocol on one port; the bundle must not hand the phone six rungs to
  // try against an endpoint that never advertised them.
  for (const node of allowed.nodes) {
    assert.equal(node.allowedRungs.length, 1, `${node.id}: an imported node may only be offered the rung its link proves`);
    assert.ok(node.warnings.some((w) => /unverified|not measured|imported/i.test(w)) || node.notes?.length, 'the unverified origin must be visible per node');
  }
});

test('feed: clientConfig for a feed node still validates under the schema (no invented fields)', async () => {
  const feed = ingestFeed({ text: FEED_LINKS.join('\n') });
  const node = feed.nodes.find((n) => n.rung === 'vless_reality_tcp');
  const cfg = clientConfig({
    profile: feedToProfile(feed),
    node: { ...node, capabilities: { ...node.capabilities, reality: true, ports: { tcp: [443] } } },
    client: android,
    policy: resolvePolicy({ mode: 'daily', killSwitch: 'block' }),
    link,
    ladder: [{ rungId: 'vless_reality_tcp', feasible: true, tuning: { dial: {} }, outbound: { type: 'vless', tag: 'savak-vless_reality_tcp', server: node.address, server_port: node.port, uuid: node.creds.uuid, flow: '', tls: { enabled: true, server_name: 'www.microsoft.com', reality: { enabled: true, public_key: node.creds.realityPublicKey, short_id: node.creds.realityShortId } } } }],
    chosen: 'savak-vless_reality_tcp',
    mtu: 1400,
  });
  const v = await validateConfig(cfg);
  assert.ok(v.ok, `imported nodes must not smuggle invalid fields: ${v.errors.join('; ')}`);
  assert.equal(cfg.inbounds[0].strict_route, true);
});
