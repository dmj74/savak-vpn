/**
 * `savak init-profile` — one command that produces a node's whole key material and a
 * signed profile, so `server/bootstrap.sh` (and any operator) never hand-assembles a
 * profile and never has to trust a `sed` script with base64 in it.
 *
 * Everything generated here goes through the same validators the tests use, so a
 * freshly initialised node cannot produce a config the phone would reject.
 */

import { generateCredentials, spkiPin, tlsKeypairForQuic } from './keys.js';
import { exampleProfile, signProfile, generateSigningKey, profileId } from './profile.js';
import { validateConfig } from './validate.js';
import { clientConfig, serverConfig } from './singbox.js';
import { tuneFor, resolvePolicy } from './tune.js';
import { RUNGS } from './ladder.js';
import { synthesizeLink } from './probes.js';
import { nodeView } from './profile.js';

export const DEFAULT_PORT_MAP = Object.freeze({
  hy2: 443,
  tuic: 8443,
  reality: 2053,
  realityGrpc: 2054,
  anytls: 8444,
  ss: 8445,
  wg: 16000,
  ws: 2087,
  probeUdp: 20125,
  api: 20124,
});

/**
 * @param {object} o
 * @param {string} o.nodeId
 * @param {string} o.hostname
 * @param {string} [o.user]
 * @param {boolean} [o.tcpBrutal]  server has the tcp_brutal kernel module
 * @param {string} [o.tlsMode]     acme | self-signed
 * @param {object[]} [o.protocols] restrict which rungs this node speaks
 * @param {string} [o.masquerade]
 * @param {object} [o.credentials] pre-supplied credentials (idempotent re-runs)
 * @param {object} [o.signingKey]  reuse a key so an existing profile keeps verifying
 */
export function initProfile({
  nodeId = 'node-1',
  hostname = 'node.local',
  user = 'user',
  tcpBrutal = false,
  tlsMode = hostname.endsWith('.local') ? 'self-signed' : 'acme',
  protocols,
  masquerade = 'https://www.google.com',
  credentials = {},
  signingKey,
  ports = DEFAULT_PORT_MAP,
  mode = 'auto',
} = {}) {
  const creds = generateCredentials(credentials);
  const key = signingKey ?? generateSigningKey();
  const all = RUNGS.map((r) => r.id).filter((id) => id !== 'tor_bridge' && id !== 'naive_h3' && id !== 'vless_ws_cdn' && id !== 'vmess_ws');
  const profile = signProfile(
    exampleProfile({
      issuer: `savak@${hostname}`,
      user,
      policy: { mode, sniWhitelist: ['www.google.com', 'youtube.com'] },
      credentials: creds,
      servers: [
        {
          id: nodeId,
          label: hostname,
          region: (hostname.split('.')[0] || 'node').slice(0, 6),
          address: hostname,
          ports: { hy2: ports.hy2, tuic: ports.tuic, reality: ports.reality, realityGrpc: ports.realityGrpc, anytls: ports.anytls, ss: ports.ss, wg: ports.wg, ws: ports.ws },
          protocols: protocols ?? all,
          capabilities: {
            reality: true,
            tls: true,
            tfo: true,
            zeroRtt: true,
            tcpBrutal: !!tcpBrutal,
            probeResistant: true,
            cdnFronting: false,
          },
          tlsMode,
          realityDest: creds.realityDest,
          ports_443_hop: [`${ports.hy2}:${ports.hy2}`, `${ports.reality}:${ports.reality + 43}`, `${ports.tuic}:${ports.tuic + 29}`, `${ports.ws}:${ports.ws + 8}`],
          masquerade,
          serviceName: 'svc',
          wsPath: '/ws',
        },
      ],
    }),
    key.privateKey,
    key.keyId,
  );
  return { profile, signingKey: key, credentials: creds };
}

/**
 * Pin the SPKI the client will accept for self-signed QUIC rungs, so the profile
 * carries a *pin* rather than `insecure: true`.
 */
export function attachPinnedKey(profile, publicKeyPem) {
  const pin = spkiPin(publicKeyPem);
  return {
    ...profile,
    servers: profile.servers.map((s) => ({ ...s, pinnedKeySha256: pin })),
  };
}

/** Server config for the initialised node, with the ladder's own tuning applied. */
export function serverConfigFor(profile, nodeId, options = {}) {
  const node = nodeView(profile, nodeId);
  const link = synthesizeLink({ access: 'wifi' });
  const policy = resolvePolicy({ mode: profile.policy?.mode ?? 'auto' });
  const ladder = RUNGS.map((rung) => {
    const tuning = tuneFor({
      rung,
      link,
      client: { platform: 'linux', mtu: options.mtu ?? 1420, tlsVersionAtLeast13: true, capabilities: { kernelTls: true, graphicalClient: false, packetInjection: false } },
      server: { ...node, capabilities: node.capabilities ?? {} },
      creds: profile.credentials,
      policy,
      notes: [],
    });
    return { id: rung.id, rung, tuning, feasible: (node.protocols ?? []).includes(rung.id) };
  });
  return serverConfig({
    profile,
    node,
    server: node,
    creds: profile.credentials,
    policy,
    ladder,
    options: {
      hostname: node.address,
      certificateProvider: node.tlsMode !== 'self-signed',
      acmeEmail: options.acmeEmail,
      masqueradeUrl: node.masquerade,
      realityDest: node.realityDest,
      apiListen: options.apiListen,
      apiSecret: options.apiSecret,
      hysteriaBandwidth: options.hysteriaBandwidth,
      paths: { cert: options.cert ?? '/etc/savak/tls.crt', key: options.key ?? '/etc/savak/tls.key', state: options.state ?? '/var/lib/savak' },
    },
  });
}

/** What the phone should run for this node, per rung, validated. */
export async function clientConfigsFor(profile, nodeId, { mode, access = 'wifi', censor = 'none' } = {}) {
  const policy = resolvePolicy({ mode: mode ?? profile.policy?.mode ?? 'auto' });
  const link = synthesizeLink({ access, censor });
  const node = nodeView(profile, nodeId);
  const out = {};
  for (const id of node.protocols ?? []) {
    const pinned = clientConfig({
      profile,
      node,
      client: { platform: 'android', mtu: 1420, capabilities: { graphicalClient: true } },
      policy,
      link,
      ladder: [{ rungId: id, id, feasible: true, tag: `savak-${id}`, tuning: tuneFor({ rung: RUNGS.find((r) => r.id === id), link, client: { platform: 'android', mtu: 1420, capabilities: { graphicalClient: true } }, server: node, creds: profile.credentials, policy, notes: [] }), outbound: buildOutbound(id, profile, node, policy, link) }],
      chosen: `savak-${id}`,
    });
    out[id] = { config: pinned, validation: await validateConfig(pinned) };
  }
  return out;
}

function buildOutbound(id, profile, node, policy, link) {
  const rung = RUNGS.find((r) => r.id === id);
  const tuning = tuneFor({ rung, link, client: { platform: 'android', mtu: 1420, capabilities: { graphicalClient: true } }, server: node, creds: profile.credentials, policy, notes: [] });
  const ctx = { tag: `savak-${id}`, server: { ...node, capabilities: node.capabilities ?? {}, ports: node.ports ?? {} }, creds: profile.credentials, client: { platform: 'android', mtu: 1420 }, policy, profile: { user: profile.user }, paths: {} };
  return rung.build(ctx, tuning);
}

export { profileId };
