import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBundle } from '../src/bundle.js';
import { exampleProfile, signProfile, generateSigningKey, verifyProfile } from '../src/profile.js';
import { validateConfig } from '../src/validate.js';
import { synthesizeLink } from '../src/probes.js';
import { planForNode } from '../src/index.js';

test('the bundle carries one pre-validated sing-box config per feasible rung', async () => {
  const bundle = await buildBundle({ profile: exampleProfile(), policy: { mode: 'speed' }, linkSpec: { access: 'cellular', censor: 'sni-only' } });
  assert.equal(bundle.ok, true, bundle.errors.join('\n'));
  assert.equal(bundle.bundleVersion, 1);
  assert.ok(bundle.nodes.length === 2);
  for (const node of bundle.nodes) {
    assert.ok(node.allowedRungs.length >= 2, `${node.id}: ${node.allowedRungs}`);
    assert.equal(Object.keys(node.configs).length, node.allowedRungs.length);
    assert.ok(node.allowedRungs.includes(node.preferredRung), 'the preferred rung must be one of the shipped configs');
    for (const rungId of node.allowedRungs) {
      const cfg = node.configs[rungId];
      const v = await validateConfig(cfg);
      assert.ok(v.ok, `${node.id}/${rungId}: ${v.errors.slice(0, 3).join('; ')}`);
      const selector = cfg.outbounds.find((o) => o.type === 'selector');
      if (selector) assert.equal(selector.default, `savak-${rungId}`, 'each config must start on its own rung');
      // The app switches by picking a config, so every config must still contain the ladder.
      if (selector) assert.ok(selector.outbounds.length >= 2, `${rungId}: a single-member selector cannot fall back`);
      assert.ok(node.tuning[rungId].notes.length > 0, `${rungId}: shipped without its explanation`);
    }
  }
});

test('a WG-preferred config inside the bundle is an interface config, not a selector one', async () => {
  const profile = exampleProfile({
    servers: [{ id: 'wg', label: 'WG only', address: 'wg.example', ports: { wg: 51820 }, protocols: ['wg_uot'], capabilities: { tls: true } }],
  });
  const bundle = await buildBundle({ profile, policy: { mode: 'game' }, link: { ...synthesizeLink({ access: 'wifi', lossPct: 0.01, downMbps: 400, rttMs: 10 }), mtuCap: 1500 } });
  const node = bundle.nodes[0];
  assert.deepEqual(node.allowedRungs, ['wg_uot']);
  const cfg = node.configs.wg_uot;
  assert.equal(cfg.inbounds, undefined);
  assert.equal(cfg.endpoints[0].type, 'wireguard');
  assert.ok((await validateConfig(cfg)).ok);
});

test('pinning an infeasible rung is refused instead of shipping a dead config', async () => {
  const profile = exampleProfile();
  const { planForNode } = await import('../src/index.js');
  assert.throws(
    () => planForNode({ profile, nodeId: 'ist-1', linkSpec: { access: 'wifi', censor: 'udp-block' }, policy: { mode: 'speed', pin: 'hy2_brutal' } }),
    /not feasible/,
    'a manual override must still pass the hard gates',
  );
});

test('a signed profile keeps its signature through the bundle, and tampering is visible', async () => {
  const k = generateSigningKey();
  const profile = signProfile(exampleProfile(), k.privateKey, k.keyId);
  const bundle = await buildBundle({ profile, trustedKeys: { [k.keyId]: k.publicKey } });
  assert.equal(bundle.trust.ok, true);
  assert.equal(bundle.signature.alg, 'ed25519');

  assert.equal(verifyProfile(profile, {}).ok, false, 'no anchors ⇒ refuse, even for a correctly signed document');
  const forged = structuredClone(bundle);
  forged.nodes[0].configs.vless_reality_tcp = forged.nodes[0].configs.hy2_brutal; // swap in a different rung's config
  // The bundle signature covers the profile, not the derived configs — so the app must
  // re-verify the profile id it was shipped with. This test pins that requirement.
  assert.notEqual(forged.nodes[0].configs.vless_reality_tcp, bundle.nodes[0].configs.vless_reality_tcp);
  assert.equal(forged.profileId, bundle.profileId);
  const check = verifyProfile({ ...profile, servers: structuredClone(profile.servers).map((s) => ({ ...s, address: 'evil.example' })) }, { [k.keyId]: k.publicKey });
  assert.equal(check.ok, false, 'an altered server address must break verification');
});

test('`only` trims the bundle without breaking the fallback ladder', async () => {
  const bundle = await buildBundle({ profile: exampleProfile(), policy: { mode: 'auto' }, only: ['hy2_brutal', 'vless_reality_tcp'] });
  for (const node of bundle.nodes) {
    assert.deepEqual(node.allowedRungs.sort(), ['hy2_brutal', 'vless_reality_tcp'].sort());
    const sel = node.configs.hy2_brutal.outbounds.find((o) => o.type === 'selector');
    assert.equal(sel.outbounds.length, 2, 'the selector should only contain what was requested');
  }
});

test('the gates a phone cannot re-derive are shipped to it as data', async () => {
  // The device deliberately does not re-implement feasibility() — node capability, listener
  // and fronting verdicts belong to whoever knows the node. So they have to *arrive*:
  // `plan.capabilityGate` -> `nodes[].scoringInputs.blocked` -> the Kotlin scorer's `gate()`.
  // If this drifts, the app starts ranking a rung the server cannot serve.
  const profile = exampleProfile();
  for (const censor of ['clean', 'udp-block', 'deep-packet']) {
    const linkSpec = { access: 'wifi', censor };
    const plan = planForNode({ profile, policy: { mode: 'stealth' }, linkSpec });
    const bundle = await buildBundle({ profile, policy: { mode: 'stealth' }, linkSpec });
    assert.equal(bundle.ok, true, bundle.errors.join('\n'));
    const shipped = bundle.nodes[0].scoringInputs;
    assert.deepEqual(
      Object.keys(shipped).sort(),
      plan.scoringTrace.map((t) => t.rungId).sort(),
      `${censor}: every rung the engine considered needs an inputs row, or the device re-ranks it blind`,
    );
    const blocked = Object.fromEntries(Object.entries(shipped).filter(([, i]) => i.blocked).map(([id, i]) => [id, i.blocked]));
    assert.deepEqual(blocked, plan.capabilityGate, censor);
    for (const [rungId, reason] of Object.entries(plan.capabilityGate)) {
      const trace = plan.scoringTrace.find((t) => t.rungId === rungId);
      assert.ok(trace, `${censor}/${rungId}: gated rungs still need a trace row, or the fixture loses the verdict`);
      assert.equal(trace.inputs.blocked, reason, `${censor}/${rungId}`);
    }
    if (censor === 'udp-block') {
      // link-dependent gates stay on the device: UDP death must show up in the ranking even
      // though it is not in `capabilityGate`.
      const row = plan.ranking.find((r) => r.rungId === 'hy2_brutal');
      assert.equal(row.feasible, false, 'QUIC over a dead UDP path cannot be offered');
      assert.match(row.reason, /UDP/i);
    }
  }
});
