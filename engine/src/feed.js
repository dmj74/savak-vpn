/**
 * Community / free node feeds — intake, classification, and a trust gate.
 * ======================================================================
 *
 * The request this module exists to serve is "add more free servers". A VPN client can
 * do that in two ways, and only one of them is honest:
 *
 *   ✗ embed a list of stranger-operated exit addresses in the shipped config, mark them
 *     usable, and let the ladder pick among them. Whoever runs those nodes sees every
 *     plaintext byte the tunnel carries, and nothing in this repo can tell you which of
 *     them are run by the same entity doing the filtering. A "free server" list is not a
 *     convenience feature in a censorship-circumvention tool — it is a trust decision
 *     made on the user's behalf by whoever edited the file.
 *
 *   ✓ take a list the *user* chose, parse it, classify each entry by what the link
 *     itself proves (protocol, Reality key, SNI), cap the blast radius, and keep every
 *     entry **unverified** until this device has measured it. Unverified means what it
 *     says: the ladder will not route production traffic to it.
 *
 * So: no list ships in this repo, and nothing imported from one is ever treated as
 * trusted. `trust: 'unverified'` is stamped here and enforced in bundle.js.
 */

import { parseShareLink } from './sharelinks.js';
import { PROFILE_VERSION, profileId } from './profile.js';

export const FEED_SCHEMA_VERSION = 1;

/** Links we understand; anything else is reported, never guessed at. */
const KNOWN_RUNGS = new Set(['hy2_brutal', 'tuic_v5', 'vless_reality_tcp', 'vless_reality_grpc', 'vless_ws_cdn', 'anytls', 'ss2022']);

const RISK = Object.freeze({
  freeExit: 'exit-node is operated by someone you did not choose: they can see and alter plaintext flows',
  noReality: 'no Reality/short-id in the link — the server name is visible to the censor and the certificate cannot be pinned',
  noSni: 'no SNI/sni parameter — masquerade settings are guesses, not facts',
  insecureTls: 'link requests an insecure/none TLS mode; refusing to keep it',
  wsCdn: 'WebSocket-over-CDN depends on the CDN fronting it staying reachable and on the operator’s TLS being what it claims',
  credential: 'shared credentials: other users of this exact link can be correlated with you on timing',
});

/** Subscription payloads are usually one base64 blob of newline-separated links. */
function expandBase64(text) {
  const one = text.replace(/\s+/g, '');
  if (one.length < 64 || one.includes('://')) return null;
  let decoded;
  try {
    decoded = Buffer.from(one, 'base64').toString('utf8');
  } catch {
    return null;
  }
  return decoded.includes('://') ? decoded : null;
}

const isIpv4ish = (s) => /^(\d{1,3}\.){3}\d{1,3}$/.test(s);
const isHost = (s) => typeof s === 'string' && /^[a-zA-Z0-9._-]+$/.test(s) && (isIpv4ish(s) || s.includes('.'));

/**
 * @param {object} p
 * @param {string} [p.text]   raw feed body (lines, commas, or a base64 subscription)
 * @param {string[]} [p.links] explicit link list (takes precedence over `text`)
 * @param {number} [p.maxNodes] hard cap on how much of a stranger's list you accept
 * @param {boolean} [p.requireReality] drop everything without a pinned Reality key
 * @param {boolean} [p.allowInsecureTls] default false — `security=none` links are refused
 */
export function ingestFeed({ text = '', links, maxNodes = 150, requireReality = false, allowInsecureTls = false } = {}) {
  const raw = Array.isArray(links) && links.length ? links : (expandBase64(text) ?? text).split(/[\n,\s]+/);
  const nodes = [];
  const rejected = [];
  const seen = new Set();

  for (const entry of raw) {
    const line = String(entry ?? '').trim();
    if (!line || !line.includes('://')) continue;
    if (nodes.length >= maxNodes) {
      rejected.push({ line: line.slice(0, 60), reason: `maxNodes=${maxNodes} reached — the rest of the list was not imported` });
      continue;
    }
    let parsed;
    try {
      parsed = parseShareLink(line);
    } catch (e) {
      rejected.push({ line: line.slice(0, 60), reason: `unparsable: ${e.message}` });
      continue;
    }
    if (!parsed?.rungId || !KNOWN_RUNGS.has(parsed.rungId)) {
      rejected.push({ line: line.slice(0, 60), reason: `unsupported link type: ${parsed?.unsupported ?? '(no scheme)'}` });
      continue;
    }
    const address = parsed.server?.address;
    const port = Number(parsed.server?.port);
    if (!isHost(address) || !Number.isInteger(port) || port < 1 || port > 65535) {
      rejected.push({ line: line.slice(0, 60), reason: `bad endpoint ${address}:${parsed.server?.port}` });
      continue;
    }
    const reality = Boolean(parsed.creds?.realityPublicKey);
    if (requireReality && !reality) {
      rejected.push({ line: line.slice(0, 60), reason: 'dropped by --require-reality (no pinned Reality key)' });
      continue;
    }
    const params = parsed.params ?? {};
    const truthy = (v) => v === '1' || v === 'true' || v === 'yes';
    if (!allowInsecureTls && (params.security === 'none' || truthy(params.allowInsecure) || truthy(params.insecure) || params.fp === '')) {
      rejected.push({ line: line.slice(0, 60), reason: RISK.insecureTls });
      continue;
    }
    const key = `${address}:${port}:${parsed.rungId}`;
    if (seen.has(key)) {
      rejected.push({ line: line.slice(0, 60), reason: 'duplicate of an already-imported endpoint' });
      continue;
    }
    seen.add(key);

    const caveats = [RISK.freeExit, RISK.credential];
    if (!reality) caveats.push(RISK.noReality);
    if (!parsed.creds?.realityServerName && !params.sni && !params.host) caveats.push(RISK.noSni);
    if (parsed.rungId === 'vless_ws_cdn') caveats.push(RISK.wsCdn);

    nodes.push({
      id: `feed-${Buffer.from(key).toString('base64url').slice(0, 10)}`,
      label: String(parsed.tag ?? key).slice(0, 60),
      address,
      port,
      rung: parsed.rungId,
      creds: parsed.creds ?? {},
      // Capabilities the *link itself* proves. Nothing here is a claim about the operator.
      capabilities: { reality, udp: parsed.rungId === 'hy2_brutal' || parsed.rungId === 'tuic_v5' },
      trust: 'unverified',
      caveats,
    });
  }

  const byRung = nodes.reduce((acc, n) => ((acc[n.rung] = (acc[n.rung] ?? 0) + 1), acc), {});
  return {
    feedVersion: FEED_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    imported: nodes.length,
    rejected: rejected.length,
    byRung,
    nodes,
    rejectedDetail: rejected,
    /** The one field that must never be true for an imported feed. */
    trusted: false,
  };
}

/**
 * A feed becomes a profile document only in this shape: unsigned, with no trust anchor,
 * and carrying `feedTrust` so the bundle step can refuse it unless you opt in explicitly.
 */
export function feedToProfile(feed, { name = 'imported-feed', issuer = 'unverified-feed', defaultPort = null, minClientVersion = '0.2.0' } = {}) {
  if (feed.trusted) throw new Error('a feed marked trusted is a bug: imported endpoints are never trusted');
  // The same document shape `savak init` produces, on purpose: readProfile, the app's
  // parser, ProfileVerifier and the parity tools all speak that grammar, and an "import"
  // that invents a second profile format is a second format to audit — and the one place a
  // `trustAnchor` could go missing. `createdAt` is the epoch rather than now(), so the
  // content-addressed id of a given list is reproducible across machines and runs.
  const base = {
    profileVersion: PROFILE_VERSION,
    issuer,
    user: name,
    createdAt: '1970-01-01T00:00:00.000Z',
    minClientVersion,
    policy: { mode: 'auto', controlApi: false },
    feedTrust: 'unverified',
    signature: null,
    trustAnchor: null,
    servers: feed.nodes.map((n) => ({
      id: n.id,
      label: n.label,
      address: n.address,
      port: defaultPort ?? n.port,
      region: 'unknown (imported)',
      // The link names one endpoint on one port for one protocol. So that is the only thing
      // advertised: `protocols: [n.rung]` makes score.js's feasibility gate refuse every other
      // rung for this server, which is the difference between "a node we configured" and
      // "a node we invented four protocols for". The port keys mirror what the rung needs.
      protocols: [n.rung],
      ports: { [n.rung]: n.port, tcp: [n.port], udp: [n.port] },
      capabilities: n.capabilities,
      trust: 'unverified',
      caveats: n.caveats,
      // The ladder needs *some* node description; these are the link's own facts, copied.
      credentials: n.creds,
    })),
  };
  return { ...base, profileId: profileId(base) };
}

/** Human summary for the CLI. Keeps the caveats in the operator's face, not in a footnote. */
export function describeFeed(feed) {
  const lines = [];
  lines.push(`feed      imported=${feed.imported} rejected=${feed.rejected} trust=${feed.trusted ? 'TRUSTED(!)' : 'unverified'}`);
  lines.push(`rungs     ${Object.entries(feed.byRung).map(([k, v]) => `${k}×${v}`).join(' ') || '(none)'}`);
  const noReality = feed.nodes.filter((n) => !n.capabilities.reality).length;
  if (noReality) lines.push(`risk      ${noReality}/${feed.imported} without a pinned Reality key — they can be identified and are not pinned`);
  for (const r of feed.rejectedDetail.slice(0, 8)) lines.push(`  drop      ${r.reason} ← ${r.line}`);
  if (feed.rejectedDetail.length > 8) lines.push(`  …           ${feed.rejectedDetail.length - 8} more rejected`);
  return lines.join('\n');
}
