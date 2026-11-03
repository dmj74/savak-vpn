import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../src/web.js';

/**
 * The dashboard is part of the product: if the user cannot interrogate the
 * "Auto" decision, the engine may as well be a superstition. These tests pin the
 * contract the UI renders — including the fact that the config shown is validated
 * server-side before it is displayed.
 */

const server = createServer();
after(() => server.close());
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const get = async (p) => {
  const res = await fetch(base + p);
  return { status: res.status, body: await res.text(), type: res.headers.get('content-type') };
};
const json = async (p) => JSON.parse((await get(p)).body);

test('the page is served as RTL Persian UI', async () => {
  const { status, body, type } = await get('/');
  assert.equal(status, 200);
  assert.match(type, /text\/html/);
  assert.match(body, /<html lang="fa" dir="rtl">/);
  assert.match(body, /پلکان هوشمند/);
});

test('meta exposes the modes and censor profiles the UI drives', async () => {
  const m = await json('/api/meta');
  for (const mode of ['auto', 'speed', 'stealth', 'game', 'resist']) assert.ok(m.modes.includes(mode), mode);
  for (const c of ['none', 'sni-only', 'udp-block', 'udp-throttle', 'port-qos', 'total-recall']) assert.ok(m.censors.includes(c), c);
  assert.equal(m.nodes.length, m.nodeLabels.length);
  assert.ok(m.rungs.length >= 11);
});

test('/api/plan answers the same engine the CLI uses, with a validated config', async () => {
  const p = await json('/api/plan?mode=speed&access=cellular&censor=sni-only&rtt=110&loss=7&bw=25&node=fra-1');
  assert.equal(p.mode, 'speed');
  assert.ok(p.chosen);
  assert.ok(p.decision.why.length > 5);
  assert.equal(p.validation.ok, true, `dashboard config invalid: ${p.validation.errors?.slice(0, 3)}`);
  assert.ok(p.ladder.find((l) => l.rungId === p.chosen).notes.length > 0, 'every pick must carry its explanation');
  assert.equal(p.link.rttMs, 110);
  assert.equal(p.link.lossPct, 7);
});

test('the dashboard reflects the censor profile: UDP-off changes the transport', async () => {
  const clean = await json('/api/plan?mode=speed&access=wifi&censor=none&node=fra-1');
  const blocked = await json('/api/plan?mode=speed&access=wifi&censor=udp-block&node=fra-1');
  const quicish = (x) => ['hy2_brutal', 'tuic_v5', 'naive_h3'].includes(x);
  assert.ok(quicish(clean.chosen) || clean.chosen === 'wg_uot', `clean path should stay on UDP, got ${clean.chosen}`);
  assert.equal(quicish(blocked.chosen), false, `UDP-blocked path must not pick a QUIC rung, got ${blocked.chosen}`);
  assert.ok(blocked.signals.includes('udpBlocked'));
});

test('/api/config is an attachable download with a meaningful filename', async () => {
  const res = await fetch(`${base}/api/config?mode=stealth&censor=deep-packet&node=fra-1`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition') ?? '', /savak-fra-1-/);
  const cfg = await res.json();
  assert.ok(cfg.inbounds?.[0]?.type === 'tun');
  assert.ok(cfg.outbounds.some((o) => o.type === 'hysteria2'));
  const hy2 = cfg.outbounds.find((o) => o.type === 'hysteria2');
  assert.equal(hy2.obfs?.type, 'gecko', 'stealth + deep DPI must pad packet sizes on the wire');
});

test('/api/nodes compares the fleet', async () => {
  const r = await json('/api/nodes?mode=auto&access=wifi&censor=none');
  assert.ok(Array.isArray(r.nodes));
  assert.equal(r.nodes.length, 2);
  assert.ok(r.best.id);
  assert.ok(r.nodes.every((n) => typeof n.score === 'number'));
});

test('unknown routes answer 404 in JSON, not HTML', async () => {
  const { status, type, body } = await get('/nope');
  assert.equal(status, 404);
  assert.match(type, /application\/json/);
  assert.match(body, /not found/);
});
