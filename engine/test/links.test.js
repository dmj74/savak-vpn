import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shareLinkFor, parseShareLink, wgConf } from '../src/sharelinks.js';
import { exampleProfile, nodeView } from '../src/profile.js';
import { tuneFor } from '../src/tune.js';
import { resolvePolicy } from '../src/tune.js';
import { RUNG_BY_ID } from '../src/ladder.js';
import { synthesizeLink } from '../src/probes.js';

const profile = exampleProfile();

function ctxFor(rungId, mode = 'auto') {
  const node = nodeView(profile, 'fra-1');
  const rung = RUNG_BY_ID[rungId];
  const tuning = tuneFor({
    rung,
    link: synthesizeLink({ access: 'cellular', censor: 'none' }),
    client: { platform: 'android', mtu: 1420, capabilities: { graphicalClient: true } },
    server: node,
    creds: profile.credentials,
    policy: resolvePolicy({ mode }),
    notes: [],
  });
  return { ctx: { tag: `savak-${rungId}`, server: node, creds: profile.credentials }, tuning };
}

test('every rung exports a link its own ecosystem can import', () => {
  const expected = {
    hy2_brutal: 'hy2://',
    tuic_v5: 'tuic://',
    vless_reality_tcp: 'vless://',
    vless_reality_grpc: 'vless://',
    anytls: 'anytls://',
    ss2022: 'ss://',
    vless_ws_cdn: 'vless://',
    wg_uot: '[Interface]',
  };
  for (const [rungId, prefix] of Object.entries(expected)) {
    const { ctx, tuning } = ctxFor(rungId);
    const link = shareLinkFor(rungId, ctx, tuning);
    assert.ok(link, `${rungId} produced no link`);
    assert.ok(link.startsWith(prefix), `${rungId} → ${link.slice(0, 30)}`);
    if (prefix !== '[Interface]') {
      const u = new URL(link);
      assert.ok(u.hostname.length > 0 || link.includes('@'), `${rungId} link has no host`);
      assert.ok(link.endsWith('savak-' + rungId), `${rungId} must carry its tag: ${link.slice(-30)}`);
    }
  }
});

test('Reality parameters travel inside the vless link (pbk/sid/sni) — no separate blob', () => {
  const { ctx, tuning } = ctxFor('vless_reality_tcp');
  const link = shareLinkFor('vless_reality_tcp', ctx, tuning);
  const p = new URL(link).searchParams;
  assert.equal(p.get('security'), 'reality');
  assert.equal(p.get('pbk'), profile.credentials.realityPublicKey);
  assert.equal(p.get('sid'), profile.credentials.realityShortId);
  assert.equal(p.get('flow'), 'xtls-rprx-vision');
  assert.equal(p.get('encryption'), 'none');
});

test('hysteria link keeps the pacing numbers and the obfuscator the engine chose', () => {
  const { ctx, tuning } = ctxFor('hy2_brutal', 'stealth');
  const link = shareLinkFor('hy2_brutal', ctx, tuning);
  const p = new URL(link).searchParams;
  assert.equal(p.get('obfs'), 'gecko', 'stealth mode chose gecko, so the exported link must say so or another client will not interop');
  assert.ok(['0', '1'].includes(p.get('insecure')));
  assert.equal(link.split('@')[0], `hy2://${profile.credentials.hy2Password}`);
});

test('shadowsocks 2022 link uses base64url(method:password)', () => {
  const { ctx, tuning } = ctxFor('ss2022');
  const link = shareLinkFor('ss2022', ctx, tuning);
  const info = Buffer.from(link.slice(5, link.indexOf('@')), 'base64url').toString();
  assert.equal(info, `${profile.credentials.ssMethod}:${profile.credentials.ssPassword}`);
});

test('import round-trip: link out → node in, credentials preserved', () => {
  for (const rungId of ['hy2_brutal', 'tuic_v5', 'vless_reality_tcp', 'anytls', 'ss2022']) {
    const { ctx, tuning } = ctxFor(rungId);
    const parsed = parseShareLink(shareLinkFor(rungId, ctx, tuning));
    assert.equal(parsed.rungId, rungId, `${rungId} came back as ${parsed.rungId}`);
    assert.equal(parsed.server.address, 'fra1.savak.example');
    assert.equal(parsed.server.port, 443);
    const creds = parsed.creds;
    if (rungId === 'hy2_brutal') assert.equal(creds.hy2Password, profile.credentials.hy2Password);
    if (rungId === 'tuic_v5') assert.equal(creds.tuicUuid, profile.credentials.tuicUuid);
    if (rungId === 'vless_reality_tcp') {
      assert.equal(creds.uuid, profile.credentials.uuid);
      assert.equal(creds.realityPublicKey, profile.credentials.realityPublicKey);
      assert.equal(creds.realityShortId, profile.credentials.realityShortId);
    }
    if (rungId === 'ss2022') assert.equal(creds.ssMethod, profile.credentials.ssMethod);
    if (rungId === 'anytls') assert.equal(creds.anytlsPassword, profile.credentials.anytlsPassword);
  }
});

test('unknown schemes are reported, never silently accepted', () => {
  const r = parseShareLink('socks5://user:pass@host:1080#x');
  assert.equal(r.rungId, null);
  assert.equal(r.unsupported, 'socks5');
});

test('wireguard export is an importable .ini, and never carries the server private key', () => {
  const { ctx, tuning } = ctxFor('wg_uot');
  const conf = wgConf({ ...ctx, creds: { ...ctx.creds, wg: { clientPrivateKey: 'cpriv', serverPublicKey: 'spub', psk: 'p' } } }, { ...tuning, mtu: 1400, keepalive: 25 });
  assert.match(conf, /\[Interface\][\s\S]*\[Peer\]/);
  assert.match(conf, /PrivateKey = cpriv/);
  assert.match(conf, /PublicKey = spub/);
  assert.match(conf, /PersistentKeepalive = 25/);
  assert.match(conf, /MTU = 1400/);
  assert.equal(conf.includes('serverPrivateKey'), false);
  assert.equal(conf.includes(profile.credentials.wg?.serverPrivateKey ?? '\u0000never'), false);
});
