import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const CLI = path.join(import.meta.dirname, '..', 'src', 'cli.js');
const dir = await mkdtemp(path.join(tmpdir(), 'savak-cli-'));
const node = (args) => run(process.execPath, [CLI, ...args], { maxBuffer: 8 * 1024 * 1024 });

test('savak plan explains the choice and writes a valid config', async () => {
  const out = path.join(dir, 'client.json');
  const { stdout } = await node(['plan', '--mode', 'speed', '--access', 'cellular', '--censor', 'sni-only', '--validate', '--links', '--out', out]);
  assert.match(stdout, /CHOSEN +\w+/);
  assert.match(stdout, /applied tuning/);
  assert.match(stdout, /BDP/, 'the window sizing must be explained, not silently applied');
  assert.match(stdout, /share links/);
  assert.match(stdout, /validate\(ajv\): OK/, `validation failed:\n${stdout}`);
  const cfg = JSON.parse(await readFile(out, 'utf8'));
  assert.equal(cfg.route.final, 'savak-ladder');
  assert.ok(cfg.outbounds.some((o) => o.type === 'hysteria2' || o.type === 'vless' || o.type === 'anytls' || o.type === 'tuic' || o.type === 'naive' || o.type === 'shadowsocks'));
});

test('savak ladder lists the whole catalogue with provenance', async () => {
  const { stdout } = await node(['ladder']);
  for (const id of ['hy2_brutal', 'tuic_v5', 'vless_reality_tcp', 'wg_uot', 'anytls', 'ss2022', 'naive_h3', 'tor_bridge']) {
    assert.ok(stdout.includes(id), id);
  }
  assert.match(stdout, /Hysteria/);
  assert.match(stdout, /Reality/);
});

test('savak nodes ranks the fleet, and a dead node is reported instead of crashing', async () => {
  const profilePath = path.join(dir, 'profile.json');
  await (await import('node:fs/promises')).writeFile(
    profilePath,
    JSON.stringify({
      profileVersion: 1,
      user: 'u',
      credentials: { uuid: 'u1', hy2Password: 'p', ssMethod: '2022-blake3-aes-256-gcm', ssPassword: 'x', anytlsPassword: 'y', wg: {} },
      policy: {},
      servers: [
        { id: 'ok', label: 'Alive', address: 'a.example', ports: { hy2: 443 }, protocols: ['hy2_brutal'], capabilities: { tls: true } },
        { id: 'dead', label: 'Speaks nothing', address: 'b.example', ports: {}, protocols: [], capabilities: {} },
      ],
    }),
  );
  const { stdout } = await node(['nodes', '--profile', profilePath, '--mode', 'speed']);
  assert.match(stdout, /Alive/);
  assert.match(stdout, /best node: Alive/);
});

test('savak validate rejects a hand-edited config that would not start', async () => {
  const bad = path.join(dir, 'bad.json');
  await (await import('node:fs/promises')).writeFile(
    bad,
    JSON.stringify({
      inbounds: [{ type: 'tun', tag: 't', gso: true, geoip: {} }],
      outbounds: [{ type: 'hysteria2', tag: 'h', server: 'x', server_port: 443, password: 'p', tls: { enabled: true, insecure: true }, made_up_field: 1 }],
      route: { final: 'nope', sniff: true },
    }),
  );
  await assert.rejects(node(['validate', bad]), (e) => {
    const out = `${e.stdout}${e.stderr}`;
    assert.match(out, /FAILED/);
    assert.match(out, /route\.sniff was removed/);
    assert.match(out, /insecure=true is a MITM hole/);
    assert.match(out, /route\.final references unknown outbound/);
    return true;
  });
});

test('savak profile emits a signature the verifier accepts', async () => {
  const prof = path.join(dir, 'signed.json');
  const keys = path.join(dir, 'keys.json');
  const { stdout } = await node(['profile', '--out', prof, '--keypair-out', keys]);
  assert.match(stdout, /signature=ed25519/);
  assert.match(stdout, /verify: OK/);
  const signed = JSON.parse(await readFile(prof, 'utf8'));
  assert.equal(signed.signature.alg, 'ed25519');
  const { verifyProfile, profileId } = await import('../src/profile.js');
  const k = JSON.parse(await readFile(keys, 'utf8'));
  assert.equal(verifyProfile(signed, { [k.keyId]: k.publicKey }).ok, true);
  // the id in the file must match its own contents
  assert.equal(signed.profileId, profileId(signed));
});

test('savak server writes a config that validates too', async () => {
  const out = path.join(dir, 'server.json');
  const { stdout } = await node(['server', '--out', out, '--hostname', 'fra1.savak.example', '--acme', '--masquerade', 'https://www.google.com']);
  assert.match(stdout, /validate\(ajv\): OK/, stdout);
  const cfg = JSON.parse(await readFile(out, 'utf8'));
  assert.ok(cfg.inbounds.length >= 4, 'a full-ladder node should be listening on every rung it advertises');
  assert.ok(cfg.certificate_providers?.[0]?.type === 'acme');
});
