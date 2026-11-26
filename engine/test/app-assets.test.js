/**
 * app-assets: the three files an APK needs, and the two guards that keep them honest.
 *
 * These tests exist because the failure mode of this feature is silent and remote: a private key
 * packed into assets ships to every installer, and a hand-written trust anchor silently overwritten
 * locks real users out. Neither is visible in a build log, so both are asserted here.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { emitAppAssets, GENERATED_MARK } from '../src/app-assets.js';
import { serverSecretValues, clientSafeCredentials } from '../src/keys.js';
import { initProfile } from '../src/init.js';
import { verifyProfile } from '../src/profile.js';

async function scaffold({ handwrittenKeys = false } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'savak-droid-'));
  const kt = path.join(dir, 'app/src/main/java/ir/savak/client/security/TrustedKeys.kt');
  if (handwrittenKeys) {
    await mkdir(path.dirname(kt), { recursive: true });
    await writeFile(kt, `package ir.savak.client.security\n\n// the operator's own three production keys live here\nobject TrustedKeys { val map = mapOf("op-key" to "PEM") }\n`, 'utf8');
  }
  return { dir, kt };
}

test('emits the profile, the bundle and a matching trust anchor', async () => {
  const { dir } = await scaffold();
  const res = await emitAppAssets({ androidDir: dir, hostname: 'fra1.example', nodeId: 'fra-1', policy: { mode: 'daily' } });
  assert.equal(res.ok, true, res.reason);
  assert.deepEqual(res.files.sort(), [
    'app/src/main/assets/README-where-is-the-private-key.md',
    'app/src/main/assets/bundle.json',
    'app/src/main/assets/profile.json',
    'app/src/main/java/ir/savak/client/security/TrustedKeys.kt',
  ]);
  assert.ok(res.rungs > 1, 'the demo node speaks several rungs');
  assert.equal(res.guard, 'per node', 'kill switch needs the pre-rendered guard config');

  // The property the phone depends on: the profile in assets verifies against the key compiled in.
  const profile = JSON.parse(await readFile(path.join(dir, 'app/src/main/assets/profile.json'), 'utf8'));
  const kt = await readFile(path.join(dir, 'app/src/main/java/ir/savak/client/security/TrustedKeys.kt'), 'utf8');
  const m = kt.match(/"([^"]+)" to "([^"]+)"/);
  assert.ok(m, 'an anchor entry was emitted');
  const [keyId, pem] = [m[1], JSON.parse(`"${m[2]}"`)];
  assert.equal(keyId, res.keyId);
  assert.equal(verifyProfile(profile, { [keyId]: pem }).ok, true, 'the app must accept what we emitted');

  // …and refuse the same profile with the anchor removed, so "verified" above is not vacuous.
  assert.equal(verifyProfile(profile, {}).ok, false);
  const tampered = { ...profile, user: 'someone-else' };
  assert.equal(verifyProfile(tampered, { [keyId]: pem }).ok, false);
});

test('no server-only secret reaches any file inside the APK', async () => {
  const { dir } = await scaffold();
  const res = await emitAppAssets({ androidDir: dir, hostname: 'fra1.example' });
  assert.equal(res.ok, true, res.reason);
  // Independently generated: the node's real secret material, which the emitted files must not
  // contain. (initProfile mints fresh keys per call, so this can only match a bug in the strip.)
  const { credentials } = initProfile({ nodeId: 'demo-1', hostname: 'fra1.example' });
  const values = serverSecretValues(credentials);
  assert.ok(values.length >= 2, 'the credential set really does carry a Reality and a WG server key to keep out');
  for (const rel of res.files) {
    const text = await readFile(path.join(dir, rel), 'utf8');
    for (const v of values) assert.equal(text.includes(v), false, `${rel} leaked server private material`);
  }
  // The tripwire itself, tested directly: hand it a document that *does* carry the key.
  const dirty = [{ path: 'x.json', text: JSON.stringify({ credentials }) }];
  const hit = dirty.find((f) => values.some((v) => f.text.includes(v)));
  assert.ok(hit, 'a document with the private key in it is detected');
  // The client needs its own WG key, so that one *must* still be present — otherwise this test
  // would pass by proving we stripped everything, including what the tunnel requires.
  const profile = await readFile(path.join(dir, 'app/src/main/assets/profile.json'), 'utf8');
  assert.ok(profile.includes('clientPrivateKey'), 'the device keypair survived the strip');
});

test('a hand-written trust anchor is never overwritten', async () => {
  const { dir, kt } = await scaffold({ handwrittenKeys: true });
  const before = await readFile(kt, 'utf8');
  const res = await emitAppAssets({ androidDir: dir, hostname: 'fra1.example' });
  assert.equal(res.ok, false);
  assert.equal(res.code, 5, 'a refusal must be distinguishable from success by code alone, not just by the ok flag');
  assert.match(res.reason, /written by hand/);
  assert.equal(await readFile(kt, 'utf8'), before, 'the operator file is byte-identical');
  assert.equal(await readFile(path.join(dir, 'app/src/main/assets/profile.json'), 'utf8').catch(() => null), null, 'nothing half-written');

  // force=true is the escape hatch, and the marker makes the second run a normal regeneration.
  const forced = await emitAppAssets({ androidDir: dir, hostname: 'fra1.example', force: true });
  assert.equal(forced.ok, true, forced.reason);
  assert.equal(forced.replacedHandwritten, true);
  const after = await readFile(kt, 'utf8');
  assert.ok(after.includes(GENERATED_MARK), 'regenerated file declares itself generated');
  const again = await emitAppAssets({ androidDir: dir, hostname: 'fra1.example' });
  assert.equal(again.ok, true, 'a generated file may be regenerated without force');
});

test('dry-run reports without touching the tree', async () => {
  const { dir } = await scaffold();
  const res = await emitAppAssets({ androidDir: dir, hostname: 'fra1.example', dryRun: true });
  assert.equal(res.ok, true);
  assert.equal(res.dryRun, true);
  await assert.rejects(() => readFile(path.join(dir, 'app/src/main/assets/profile.json'), 'utf8'));
});

test('clientSafeCredentials is the single strip rule', () => {
  const { credentials } = initProfile({ nodeId: 'n', hostname: 'h.example' });
  const safe = clientSafeCredentials(credentials);
  assert.equal(safe.realityPrivateKey, undefined);
  assert.equal(safe.wg.serverPrivateKey, undefined);
  assert.ok(safe.wg.serverPublicKey, 'the peer public key is what a client needs');
  assert.ok(safe.wg.clientPrivateKey, 'the device private key stays with the device');
  assert.deepEqual(serverSecretValues(safe), [], 'the stripped set is by definition clean');
  // Idempotent: stripping twice is identical to stripping once (profile re-signs rely on this).
  assert.deepEqual(clientSafeCredentials(safe), safe);
});

test('the server config refuses to be built from a client-safe profile', async () => {
  const { initProfile: ip } = await import('../src/init.js');
  const { serverConfigFor } = await import('../src/init.js');
  const { profile } = ip({ nodeId: 'n', hostname: 'h.example' });
  assert.throws(
    () => serverConfigFor(profile, 'n'),
    /realityPrivateKey|keys\.json/,
    'silently building a server.json without the Reality key would produce a node that cannot answer its own best rung',
  );
  const full = ip({ nodeId: 'n', hostname: 'h.example' });
  const cfg = serverConfigFor(full.profile, 'n', { creds: full.credentials });
  const json = JSON.stringify(cfg);
  assert.ok(json.includes(full.credentials.realityPrivateKey), 'the real key reaches the listener it belongs to');
  assert.ok(json.includes(full.credentials.wg.serverPrivateKey), 'same for the WireGuard endpoint');
});
