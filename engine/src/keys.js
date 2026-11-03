/**
 * Key material generation, with no sing-box binary and no network.
 *
 * `sing-box generate reality-keypair` and a WireGuard keypair are both X25519 —
 * the only difference is the encoding (Reality uses base64url of the raw key,
 * WireGuard base64 of it). Node's crypto gives us the raw bytes through JWK, so the
 * bootstrap script never has to shell out to a Go tool that may not be installed yet.
 *
 * ECH is deliberately not here: an ECH keypair is HPKE/`ech_config` framed and must be
 * produced by `sing-box generate ech-keypair`, otherwise we would be shipping a
 * subtly-wrong encoding that fails at handshake time on the phone.
 */

import { createCipheriv, createHash, createPublicKey, diffieHellman, generateKeyPairSync, randomBytes, randomUUID, createPrivateKey } from 'node:crypto';

const b64 = (buf) => buf.toString('base64');
const b64url = (buf) => buf.toString('base64url');

/** Raw 32-byte X25519 secret/public pair, in every encoding the ladder needs. */
export function x25519Keypair() {
  const { privateKey, publicKey } = generateKeyPairSync('x25519');
  const jwkPriv = privateKey.export({ format: 'jwk' });
  const jwkPub = publicKey.export({ format: 'jwk' });
  const raw = (s) => Buffer.from(s, 'base64url');
  return {
    private: raw(jwkPriv.d),
    public: raw(jwkPub.x),
    pem: {
      private: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      public: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    },
  };
}

export function wireGuardKeypair() {
  const k = x25519Keypair();
  return {
    privateKey: b64(k.private),
    publicKey: b64(k.public),
  };
}

export function realityKeypair() {
  const k = x25519Keypair();
  return {
    // Reality wants base64url and no padding; `short_id` is 0-8 hex chars, even length.
    privateKey: b64url(k.private),
    publicKey: b64url(k.public),
    shortId: randomBytes(4).toString('hex'),
  };
}

/**
 * Reality's `handshake` target must be a site whose TLS behaviour is stable and
 * whose IP range the censor will not block wholesale; the *site* is also what an
 * active prober sees, so pick something boring with a big anycast footprint.
 */
export const REALITY_CANDIDATES = Object.freeze([
  { host: 'www.google.com', port: 443, why: 'anycast, never fully blocked, TLS 1.3 with a real cert chain' },
  { host: 'www.microsoft.com', port: 443, why: 'same shape, different ASN — useful when one is throttled' },
  { host: 'apple.com', port: 443, why: 'session resumption behaves well under probing' },
  { host: 'dl.google.com', port: 443, why: 'large downloads keep the fingerprint lively' },
]);

export function pickRealityDest(seed = randomBytes(2).readUInt16LE(0)) {
  return REALITY_CANDIDATES[seed % REALITY_CANDIDATES.length];
}

/** SS-2022 keys are *raw* key bytes in base64 at exactly the cipher's key size. */
export const SS2022_KEY_SIZES = Object.freeze({
  '2022-blake3-aes-128-gcm': 16,
  '2022-blake3-aes-256-gcm': 32,
  '2022-blake3-chacha20-poly1305': 32,
});

export function shadowsocks2022Key(method = '2022-blake3-aes-256-gcm') {
  const size = SS2022_KEY_SIZES[method];
  if (!size) throw new Error(`not a 2022-blake3 method: ${method}`);
  return { method, password: b64(randomBytes(size)) };
}

export function uuid() {
  return randomUUID();
}

/** Passwords for HY2/TUIC/AnyTLS: 32 url-safe bytes is ~190 bits, no quoting issues in a JSON or a share link. */
export function secret(bytes = 32) {
  return b64url(randomBytes(bytes));
}

/**
 * A fresh, complete credential set for one node — the piece bootstrap.sh needs before
 * it can write a config, and the piece people otherwise paste from a blog post.
 */
export function generateCredentials(overrides = {}) {
  const wg = wireGuardKeypair();
  const wgClient = wireGuardKeypair();
  const reality = realityKeypair();
  const ss = shadowsocks2022Key();
  return {
    uuid: uuid(),
    hy2Password: secret(),
    hy2ObfsPassword: secret(16),
    tuicUuid: uuid(),
    tuicPassword: secret(),
    anytlsPassword: secret(),
    ssMethod: ss.method,
    ssPassword: ss.password,
    naiveUser: 'savak',
    naivePassword: secret(16),
    realityPublicKey: reality.publicKey,
    realityPrivateKey: reality.privateKey,
    realityShortId: reality.shortId,
    realityDest: pickRealityDest(),
    wg: {
      serverPrivateKey: wg.privateKey,
      serverPublicKey: wg.publicKey,
      clientPrivateKey: wgClient.privateKey,
      clientPublicKey: wgClient.publicKey,
      psk: b64(randomBytes(32)),
    },
    ...overrides,
  };
}

/**
 * Self-signed certificate for the QUIC rungs (they need a cert; Reality does not).
 * ECDSA P-256 on purpose: Chrome's QUIC parrot does not advertise Ed25519 support,
 * so an Ed25519 leaf makes the handshake fail exactly when `disable_chrome_parrot`
 * is off — which is the configuration we want for fingerprinting reasons.
 */
export function tlsKeypairForQuic(alg = 'ec') {
  const { publicKey, privateKey } = generateKeyPairSync(alg === 'ec' ? 'ec' : 'ed25519', {
    namedCurve: alg === 'ec' ? 'prime256v1' : undefined,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return { publicKey, privateKey, note: alg === 'ec' ? 'ECDSA P-256: Chrome-QUIC-compatible' : 'Ed25519: incompatible with the Chrome parrot, set disable_chrome_parrot' };
}

/** SPKI SHA-256 pin, the value `tls.certificate_public_key_sha256` expects. */
export function spkiPin(publicKeyPem) {
  const der = createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' });
  return createHash('sha256').update(der).digest('base64');
}
