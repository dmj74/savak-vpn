import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planForNode, serverConfigForTest } from './helpers.js';
import { exampleProfile } from '../src/profile.js';
import { validateConfig } from '../src/validate.js';
import { POLICIES } from '../src/tune.js';
import { CENSOR_PROFILES } from '../src/probes.js';
import { RUNGS } from '../src/ladder.js';

/**
 * The point of this file: every config the engine can emit must actually parse in
 * sing-box 1.14. `additionalProperties:false` in the official schema makes this a
 * real test, not a formality — a single made-up key fails here.
 */

const ACCESS = ['wifi', 'cellular'];

test('every emitted client config validates against the official sing-box schema', async () => {
  const profile = exampleProfile();
  let checked = 0;
  for (const mode of Object.keys(POLICIES)) {
    for (const access of ACCESS) {
      for (const censor of Object.keys(CENSOR_PROFILES)) {
        for (const root of [false, true]) {
          for (const nodeId of [profile.servers[0].id, profile.servers[1].id]) {
            const plan = planForNode({
              profile,
              nodeId,
              policy: { mode, allowLegacy: true },
              link: undefined,
              linkSpec: { access, censor, rttMs: censor === 'none' ? 40 : 90, lossPct: access === 'cellular' ? 3.5 : 0.2, downMbps: 120 },
              client: root
                ? { platform: 'linux', mtu: 1460, capabilities: { packetInjection: true, kernelTls: true, graphicalClient: false, cdnFronting: false, mptcp: true } }
                : { platform: 'android' },
            });
            const res = await validateConfig(plan.config);
            checked++;
            assert.ok(res.ok, `${mode}/${access}/${censor}/root=${root}/${nodeId} → ${res.errors.slice(0, 4).join('; ')}`);
            assert.equal(res.engine, 'ajv', 'ajv must be installed for this test to mean anything');
          }
        }
      }
    }
  }
  assert.ok(checked >= 100, `expected a wide matrix, only checked ${checked}`);
});

test('server config for the full ladder validates', async () => {
  const profile = exampleProfile();
  const cfg = serverConfigForTest(profile, profile.servers[0].id);
  const res = await validateConfig(cfg);
  assert.ok(res.ok, res.errors.slice(0, 10).join('\n'));
  const types = cfg.inbounds.map((i) => i.type);
  for (const want of ['hysteria2', 'tuic', 'anytls', 'shadowsocks', 'vless']) {
    assert.ok(types.includes(want), `server should listen for ${want}, got ${types.join(',')}`);
  }
  assert.ok(cfg.endpoints.some((e) => e.type === 'wireguard'), 'wg endpoint missing');
});

test('server config validates for a minimal node too', async () => {
  const profile = exampleProfile();
  const cfg = serverConfigForTest(profile, profile.servers[1].id);
  const res = await validateConfig(cfg);
  assert.ok(res.ok, res.errors.slice(0, 10).join('\n'));
  assert.equal(cfg.inbounds.some((i) => i.type === 'tuic'), false, 'node 2 does not advertise tuic');
});

test('ladder always contains at least one rung under the harshest censor profile', () => {
  const profile = exampleProfile();
  for (const access of ACCESS) {
    const plan = planForNode({ profile, policy: { mode: 'resist', allowLegacy: true }, linkSpec: { access, censor: 'total-recall', lossPct: 8 } });
    assert.ok(plan.chosen, 'resist mode must find something');
  }
  // …and the *auto* ladder may legitimately be empty only if the node speaks nothing.
  const dead = exampleProfile({ servers: [{ id: 'x', label: 'dead', address: '127.0.0.1', ports: { hy2: 443 }, protocols: ['wg_uot'], capabilities: {} }] });
  assert.throws(
    () => planForNode({ profile: dead, nodeId: 'x', linkSpec: { access: 'wifi', censor: 'udp-block' } }),
    /ladder-empty/,
  );
});

test('generated configs never contain keys sing-box removed', async () => {
  const profile = exampleProfile();
  const plan = planForNode({ profile, policy: { mode: 'speed' }, linkSpec: { access: 'cellular', censor: 'deep-packet' } });
  const blob = JSON.stringify(plan.config);
  for (const dead of ['"gso"', '"geoip"', '"geosite"', '"kernel_rx"', '"route":{"sniff"', '"tproxy_mode"']) {
    assert.equal(blob.includes(dead), false, `config must not contain ${dead}`);
  }
  // insecure verification is a MITM hole, not a tuning knob
  assert.equal(blob.includes('"insecure":true'), false);
  assert.ok(RUNGS.length >= 10);
});
