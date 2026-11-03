import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPublicKey, createPrivateKey, diffieHellman } from 'node:crypto';
import {
  x25519Keypair,
  wireGuardKeypair,
  realityKeypair,
  shadowsocks2022Key,
  SS2022_KEY_SIZES,
  generateCredentials,
  spkiPin,
  tlsKeypairForQuic,
  pickRealityDest,
  REALITY_CANDIDATES,
} from '../src/keys.js';

// DER for an X25519 SubjectPublicKeyInfo is 12 header bytes + the 32 raw bytes;
// BIT STRING length is 0x21 (33 = the unused-bits byte plus 32), not 0x42.
const X25519_SPKI = Buffer.from('302a300506032b656e032100', 'hex');
const X25519_PKCS8 = Buffer.from('302e020100300506032b656e04220420', 'hex');
const spki = (raw32) => Buffer.concat([X25519_SPKI, raw32]);
const pkcs8 = (raw32) => Buffer.concat([X25519_PKCS8, raw32]);

test('the X25519 pair is a real key agreement and the raw bytes agree with the PEM', () => {
  const a = x25519Keypair();
  const b = x25519Keypair();
  assert.equal(a.private.length, 32);
  assert.equal(a.public.length, 32);

  // 1. Agreement works in both directions.
  const pemA = { private: createPrivateKey({ key: a.pem.private, format: 'pem' }), public: createPublicKey({ key: a.pem.public, format: 'pem' }) };
  const pemB = { private: createPrivateKey({ key: b.pem.private, format: 'pem' }), public: createPublicKey({ key: b.pem.public, format: 'pem' }) };
  const s1 = diffieHellman({ privateKey: pemA.private, publicKey: pemB.public });
  const s2 = diffieHellman({ privateKey: pemB.private, publicKey: pemA.public });
  assert.equal(Buffer.compare(Buffer.from(s1), Buffer.from(s2)), 0);
  assert.equal(Buffer.from(s1).length, 32);

  // 2. The *base64 strings* the config gets must describe the same key. WireGuard and
  //    Reality both do raw-key X25519, so if the encoding were off by a DER wrapper or
  //    a base64 flavour, every handshake would fail at 3am and look like a censor attack.
  const rawPubA = createPublicKey({ key: spki(a.public), format: 'der', type: 'spki' });
  const rawPrivB = createPrivateKey({ key: pkcs8(b.private), format: 'der', type: 'pkcs8' });
  const fromRaw = Buffer.from(diffieHellman({ privateKey: rawPrivB, publicKey: rawPubA }));
  assert.deepEqual(fromRaw, Buffer.from(s1), 'raw-bytes agreement must equal the PEM agreement');
  assert.deepEqual(Buffer.from(a.public).toString('base64url'), pemA.public.export({ format: 'jwk' }).x);
  assert.deepEqual(Buffer.from(a.private).toString('base64'), b64of(pemA.private));
});

function b64of(privateKeyObject) {
  const der = privateKeyObject.export({ format: 'der', type: 'pkcs8' });
  return der.subarray(der.length - 32).toString('base64');
}

test('WireGuard and Reality keys differ only by encoding, exactly as their tools do', () => {
  const wg = wireGuardKeypair();
  const reality = realityKeypair();
  assert.match(wg.publicKey, /^[A-Za-z0-9+/]{43}=$/, 'WireGuard uses padded base64 with + and /');
  assert.doesNotMatch(reality.publicKey, /=/, 'Reality uses base64url without padding');
  assert.match(reality.publicKey, /^[A-Za-z0-9_-]+$/);
  assert.match(reality.shortId, /^([0-9a-f]{2}){0,4}$/, 'short_id must be 0-8 hex digits, even count');
});

test('shadowsocks 2022 keys are the right size for their cipher', () => {
  for (const [method, size] of Object.entries(SS2022_KEY_SIZES)) {
    const { password } = shadowsocks2022Key(method);
    assert.equal(Buffer.from(password, 'base64').length, size, method);
  }
  assert.throws(() => shadowsocks2022Key('aes-256-gcm'), /not a 2022-blake3 method/, 'classic methods take a password, not a key — refuse to confuse them');
});

test('a generated credential set is internally consistent and usable', () => {
  const c = generateCredentials();
  assert.match(c.uuid, /^[0-9a-f-]{36}$/);
  assert.match(c.tuicUuid, /^[0-9a-f-]{36}$/);
  assert.equal(Buffer.from(c.wg.serverPrivateKey, 'base64').length, 32);
  assert.notEqual(c.wg.serverPublicKey, c.wg.clientPublicKey);
  assert.ok(c.hy2Password.length >= 32, 'a QUIC password should not be brute-forceable on a 443 listener');
  assert.ok(REALITY_CANDIDATES.includes(c.realityDest));
  // reality keys are independent per run
  assert.notEqual(generateCredentials().realityPublicKey, c.realityPublicKey);
});

test('QUIC rungs get an ECDSA pair because the Chrome parrot cannot verify Ed25519', () => {
  const ec = tlsKeypairForQuic('ec');
  assert.match(ec.publicKey, /BEGIN PUBLIC KEY/);
  assert.match(ec.note, /Chrome-QUIC-compatible/);
  const ed = tlsKeypairForQuic('ed25519');
  assert.match(ed.note, /disable_chrome_parrot/);
  const pin = spkiPin(ec.publicKey);
  assert.equal(Buffer.from(pin, 'base64').length, 32, 'the SPKI pin is a sha256 digest');
  assert.equal(spkiPin(ec.publicKey), pin, 'pinning must be reproducible from the public key alone');
});

test('reality destination choice is stable for a given seed and rotates across seeds', () => {
  assert.equal(pickRealityDest(0), pickRealityDest(0));
  const picked = new Set([pickRealityDest(1).host, pickRealityDest(2).host, pickRealityDest(3).host, pickRealityDest(4).host]);
  assert.ok(picked.size > 1);
});
