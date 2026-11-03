import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPublicKey } from 'node:crypto';
import {
  canonicalJson,
  profileId,
  signProfile,
  verifyProfile,
  generateSigningKey,
  exampleProfile,
  nodeView,
  PROFILE_VERSION,
} from '../src/profile.js';

test('canonical JSON is order-independent but content-sensitive', () => {
  assert.equal(canonicalJson({ b: 1, a: [1, { d: 2, c: 3 }] }), canonicalJson({ a: [1, { c: 3, d: 2 }], b: 1 }));
  // Exact bytes, not just "sorted": the Kotlin verifier on the phone has to agree with this
  // string one character at a time, and a stray separator space (Kotlin's joinToString
  // default is ", ") silently rejects every signed profile.
  assert.equal(canonicalJson({ b: 1, a: [1, { d: 2, c: 3 }] }), '{"a":[1,{"c":3,"d":2}],"b":1}');
  assert.notEqual(canonicalJson({ a: 1 }), canonicalJson({ a: 1, b: undefined, c: null }));
  assert.equal(canonicalJson({ a: 1, c: null }), '{"a":1,"c":null}');
});

test('profileId is stable across key insertion order', () => {
  const p = exampleProfile();
  // Same content, keys pushed through a different insertion order (and nested too).
  const reordered = Object.fromEntries(Object.entries(p).map(([k, v]) => [k === 'policy' ? k : k, v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).reverse()) : v]).reverse());
  assert.equal(profileId(p), profileId(reordered));
});

test('a signed profile verifies, and any byte of tampering breaks it', () => {
  const { publicKey, privateKey, keyId } = generateSigningKey();
  const signed = signProfile(exampleProfile(), privateKey, keyId);
  assert.equal(verifyProfile(signed, { [keyId]: publicKey }).ok, true);
  assert.equal(signed.signature.alg, 'ed25519');
  assert.ok(signed.signature.value.length > 40);

  const tampered = structuredClone(signed);
  tampered.servers[0].protocols = ['wg_uot']; // attacker tries to force the raw-UDP rung (no SNI protection)
  const v = verifyProfile(tampered, { [keyId]: publicKey });
  assert.equal(v.ok, false);
  assert.match(v.reason, /signature/);

  const dnsHijack = structuredClone(signed);
  dnsHijack.policy = { ...dnsHijack.policy, dohServer: 'evil.example' };
  assert.equal(verifyProfile(dnsHijack, { [keyId]: publicKey }).ok, false, 'a swapped DoH server must not survive the signature');
});

test('unsigned and unknown-key profiles are refused', () => {
  const { publicKey, keyId } = generateSigningKey();
  assert.equal(verifyProfile(exampleProfile(), { [keyId]: publicKey }).ok, false);
  assert.match(verifyProfile(exampleProfile(), { [keyId]: publicKey }).reason, /unsigned/);
  const signed = signProfile(exampleProfile(), generateSigningKey().privateKey, 'someone-elses-key');
  const v = verifyProfile(signed, { [keyId]: publicKey });
  assert.equal(v.ok, false);
  assert.match(v.reason, /untrusted signing key/);
});

test('signature survives JSON round-trip over the wire', () => {
  const k = generateSigningKey();
  const signed = signProfile(exampleProfile(), k.privateKey, k.keyId);
  const overTheWire = JSON.parse(JSON.stringify(signed));
  assert.equal(verifyProfile(overTheWire, { [k.keyId]: k.publicKey }).ok, true);
  assert.equal(overTheWire.profileVersion, PROFILE_VERSION);
});

test('node view normalises ports and exposes the hop pool', () => {
  const p = exampleProfile();
  const fra = nodeView(p, 'fra-1');
  assert.equal(fra.port, 443);
  assert.deepEqual(fra.ports.hop, p.servers[0].ports_443_hop);
  const ist = nodeView(p, 'ist-1');
  assert.equal(ist.ports.hop, p.servers[1].ports_443_hop);
  assert.throws(() => nodeView({ servers: [] }, 'x'), /no servers/);
  assert.equal(nodeView(p, 'does-not-exist').id, 'fra-1', 'an unknown node id must fall back to the first, not crash the app');
});
