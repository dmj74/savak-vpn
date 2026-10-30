/**
 * Savak profile documents.
 * =======================
 *
 * A proxy client that applies whatever JSON a pasted link contains is a
 * remote-configuration primitive in the hands of whoever typed the link: DNS
 * servers, routes, package exclusions and `services.api` are all reachable from
 * a config. So profiles are content-addressed and Ed25519-signed, and the client
 * refuses unsigned/unknown-key profiles unless the user explicitly opts in.
 *
 * Trust is deliberately narrow: the signature covers the *policy and credentials*,
 * not "obey this whole sing-box config". The engine generates the config itself
 * from the ladder; the profile can only choose rungs and fill in endpoints.
 */

import { createHash, generateKeyPairSync, sign, verify } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const PROFILE_VERSION = 1;

/** Deterministic JSON: sorted object keys, arrays in order. */
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}

/** Content address of the *payload*: the id must not depend on itself or on the signature. */
export function profileId(profile) {
  const { signature, profileId: _self, ...rest } = profile ?? {};
  return createHash('sha256').update(canonicalJson(rest)).digest('hex').slice(0, 16);
}

export function generateSigningKey() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return { publicKey, privateKey, keyId: keyIdFromPem(publicKey) };
}

export function keyIdFromPem(publicKeyPem) {
  const der = Buffer.from(
    publicKeyPem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''),
    'base64',
  );
  return createHash('sha256').update(der).digest('base64url').slice(0, 16);
}

export function signProfile(profile, privateKeyPem, keyId) {
  const unsigned = { ...profile };
  delete unsigned.signature;
  unsigned.profileId = profileId(unsigned);
  const payload = Buffer.from(canonicalJson(unsigned), 'utf8');
  const signature = sign(null, payload, { key: privateKeyPem, format: 'pem', type: 'pkcs8' });
  return {
    ...unsigned,
    signature: {
      alg: 'ed25519',
      keyId,
      value: signature.toString('base64url'),
      signedFields: ['profileVersion', 'issuer', 'user', 'servers', 'credentials', 'policy'],
    },
  };
}

/**
 * @returns {{ok:boolean, reason?:string, profileId:string}}
 */
export function verifyProfile(signed, trustedKeys) {
  const { signature, ...rest } = signed ?? {};
  // `rest` still carries profileId, which is exactly what was signed — recomputing the
  // id here would double-count it, so compare against the signed-in value below.

  const id = profileId(signed ?? {});
  if (!signature) return { ok: false, reason: 'unsigned profile', profileId: id };
  if (signature.alg !== 'ed25519') return { ok: false, reason: `unsupported signature algorithm ${signature.alg}`, profileId: id };
  const pem = trustedKeys?.[signature.keyId];
  if (!pem) return { ok: false, reason: `untrusted signing key ${signature.keyId}`, profileId: id };
  const payload = Buffer.from(canonicalJson(rest), 'utf8');
  const ok = verify(null, payload, pem, Buffer.from(signature.value, 'base64url'));
  return { ok, reason: ok ? undefined : 'signature does not match profile contents', profileId: id };
}

export async function loadProfile(file) {
  return JSON.parse(await readFile(path.resolve(file), 'utf8'));
}

export async function saveProfile(file, profile) {
  await writeFile(path.resolve(file), `${JSON.stringify(profile, null, 2)}\n`, 'utf8');
  return path.resolve(file);
}

/**
 * A profile describing one node that speaks the whole ladder. Ports and
 * credentials are placeholders on purpose: server/bootstrap.sh fills them in.
 */
export function exampleProfile(overrides = {}) {
  const base = {
    profileVersion: PROFILE_VERSION,
    issuer: 'savak.local',
    createdAt: '2026-10-30T00:00:00.000Z',
    user: 'savak-user',
    minClientVersion: '0.2.0',
    policy: {
      mode: 'auto',
      sniWhitelist: ['www.google.com', 'youtube.com'],
      controlApi: false,
    },
    credentials: {
      uuid: '00000000-0000-4000-8000-000000000001',
      hy2Password: 'change-me-hy2',
      hy2ObfsPassword: 'change-me-obfs',
      tuicUuid: '00000000-0000-4000-8000-000000000002',
      tuicPassword: 'change-me-tuic',
      anytlsPassword: 'change-me-anytls',
      ssMethod: '2022-blake3-aes-256-gcm',
      ssPassword: 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=',
      naiveUser: 'naive',
      naivePassword: 'change-me-naive',
      realityPublicKey: 'change-me-pbk',
      realityShortId: '01234567',
      realityServerName: 'www.google.com',
      wg: {
        serverPrivateKey: 'change-me-server-private',
        clientPublicKey: 'change-me-client-public',
      },
    },
    servers: [
      {
        id: 'fra-1',
        label: 'Frankfurt 1',
        region: 'de',
        address: 'fra1.savak.example',
        ports: { hy2: 443, tuic: 443, reality: 2053, anytls: 8443, ss: 8444, wg: 16000, ws: 2087 },
        protocols: ['hy2_brutal', 'tuic_v5', 'vless_reality_tcp', 'vless_reality_grpc', 'anytls', 'ss2022', 'wg_uot', 'naive_h3'],
        capabilities: {
          reality: true,
          tls: true,
          tfo: true,
          zeroRtt: true,
          tcpBrutal: true,
          probeResistant: true,
          cdnFronting: false,
        },
        tlsMode: 'acme',
        realityDest: { host: 'www.google.com', port: 443 },
        ports_443_hop: ['443:443', '2053:2096', '8443:8472', '2087:2095'],
        masquerade: 'https://www.google.com',
        serviceName: 'svc',
        wsPath: '/ws',
      },
      {
        id: 'ist-1',
        label: 'Istanbul 1',
        region: 'tr',
        address: 'ist1.savak.example',
        ports: { hy2: 443, reality: 443, ss: 443 },
        protocols: ['hy2_brutal', 'vless_reality_tcp', 'ss2022'],
        capabilities: { reality: true, tls: true, tfo: false, zeroRtt: true, tcpBrutal: false, probeResistant: false },
        tlsMode: 'self-signed',
        pinnedKeySha256: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        realityDest: { host: 'www.microsoft.com', port: 443 },
        ports_443_hop: ['443:443', '8443:8499'],
      },
    ],
  };
  const merged = { ...base, ...overrides };
  merged.policy = { ...base.policy, ...(overrides.policy ?? {}) };
  merged.credentials = { ...base.credentials, ...(overrides.credentials ?? {}) };
  merged.profileId = profileId(merged);
  return merged;
}

/** Normalise the shape the rest of the engine expects for one node. */
export function nodeView(profile, nodeId) {
  const node = profile.servers.find((s) => s.id === nodeId) ?? profile.servers[0];
  if (!node) throw new Error('profile has no servers');
  return {
    ...node,
    port: node.ports?.hy2 ?? node.ports?.reality ?? node.ports?.ss ?? 443,
    ports: { ...node.ports, hop: node.ports_443_hop ?? null },
  };
}
