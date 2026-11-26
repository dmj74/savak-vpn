/**
 * `savak app-assets` — the one command that makes an APK actually show a ladder.
 * ==============================================================================
 *
 * Why this exists: the Android app refuses to run on an unsigned profile and refuses to trust a
 * signature from a key it does not have compiled in. So an APK built from a clean checkout is
 * installable but *empty*: "باندل موجود نیست". Building it is the easy half; the three files
 * below are what turn it into something a person can open. This module writes exactly those,
 * and nothing else:
 *
 *   <android>/app/src/main/assets/profile.json      signed profile (the trust input)
 *   <android>/app/src/main/assets/bundle.json       pre-rendered, validated per-rung configs
 *   <android>/app/src/main/java/…/security/TrustedKeys.kt   the key that must verify it
 *
 * Two rules keep this from becoming a foot-gun:
 *   • It never overwrites a TrustedKeys.kt it did not generate unless `force` is set. An
 *     operator who hand-added three production keys would otherwise lose them silently, and the
 *     symptom (profiles from those keys refused) shows up on someone else's phone.
 *   • Everything it writes is *derived*: the same signing key is used for the profile and the
 *     anchor, the bundle is validated against the real sing-box schema before it is shipped, and
 *     the emitted Kotlin is checked by the engine's own verifier before the call returns. If the
 *     round trip does not verify, nothing is claimed as written.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { initProfile } from './init.js';
import { serverSecretValues } from './keys.js';
import { buildBundle } from './bundle.js';
import { verifyProfile } from './profile.js';

export const GENERATED_MARK = 'savak:generated';

const KOTLIN_HEADER = (argv) => `// Trust anchors for profile signatures. ${GENERATED_MARK}
//
// Written by \`savak ${argv}\`. The engine's verifier accepts a profile only if one of the keys
// below signs it, so an empty map here means "refuse everything" — that is the safe default for a
// hand-maintained file, and the reason this one is generated rather than typed: a key that was
// pasted from a terminal window is a key that can silently be the wrong one.
//
// Add a key with:  savak app-assets --androidDir android …        (regenerates this file)
// or hand-edit the map, keeping one entry per line so a diff shows exactly which key changed.
`;

function kotlinFor(entries) {
  const body = entries.length
    ? entries.map(([keyId, publicPem]) => `        "${keyId}" to ${JSON.stringify(publicPem.trim())},`).join('\n')
    : '        // empty by design: no trusted key → every profile is refused until one is added';
  return `${KOTLIN_HEADER('app-assets --androidDir android --hostname <host>')
}package ir.savak.client.security

object TrustedKeys {
    /** keyId → PEM public key. Deliberately PEM, not raw DER: ProfileVerifier reads it with
     *  java.security.KeyFactory, and a base64 blob in a diff is unreadable when it is wrong. */
    val map: Map<String, String> = mapOf(
${body}
    )
}
`;
}

/**
 * @param {object} p
 * @param {string} p.androidDir        the `android/` module root
 * @param {string} [p.hostname]        node address to bake in
 * @param {string} [p.nodeId]
 * @param {string} [p.user]
 * @param {object} [p.policy]          {mode, killSwitch, split, allowLegacy, …}
 * @param {object} [p.client]          device capabilities (default: an Android phone)
 * @param {object} [p.link]            measured link for ranking; else the engine synthesises one
 * @param {boolean} [p.validate=true]  validate every embedded config against the sing-box schema
 * @param {boolean} [p.force=false]    overwrite a TrustedKeys.kt that already exists
 * @param {boolean} [p.dryRun=false]   report what would be written
 */
export async function emitAppAssets({
  androidDir,
  hostname = 'demo.savak.example',
  nodeId = 'demo-1',
  user = 'savak-demo',
  policy = {},
  client,
  link,
  validate = true,
  force = false,
  dryRun = false,
} = {}) {
  if (!androidDir) throw new Error('app-assets needs --androidDir (the android/ module root)');
  const assetsDir = path.join(androidDir, 'app/src/main/assets');
  const keysFile = path.join(androidDir, 'app/src/main/java/ir/savak/client/security/TrustedKeys.kt');

  // An existing hand-written anchor file is protected; a previously generated one is fair game,
  // because regenerating with a new key is the normal flow (key rotation).
  let existing = null;
  try {
    existing = await readFile(keysFile, 'utf8');
  } catch {
    /* first run */
  }
  const protectedExisting = existing !== null && !existing.includes(GENERATED_MARK);
  if (protectedExisting && !force) {
    return {
      ok: false,
      code: 5,
      reason: `${keysFile} was written by hand (no \`${GENERATED_MARK}\` marker) — refusing to overwrite a trust anchor. Add the entry to TrustedKeys.map yourself, or pass force=true to replace the file.`,
      files: [],
    };
  }

  const { profile, signingKey, credentials } = initProfile({ nodeId, hostname, user, mode: policy.mode ?? 'auto' });
  const mergedClient = { platform: 'android', mtu: 1420, interfaces: { wifi: true, cellular: true }, capabilities: { graphicalClient: true }, ...(client ?? {}) };
  const bundle = await buildBundle({
    profile,
    client: mergedClient,
    policy: { killSwitch: 'block', ...policy },
    ...(link ? { link } : {}),
    validate,
  });
  if (!bundle.ok) {
    // Do not half-write: an APK with a profile whose bundle failed validation is worse than no
    // APK, because the phone would try to run configs the validator refused.
    return { ok: false, code: 5, reason: `bundle validation failed: ${bundle.errors.slice(0, 4).join('; ')}`, files: [], profileId: profile.profileId };
  }

  // The round trip the phone will perform, performed here instead: the profile the app reads must
  // verify against the key the app has compiled in. If this fails, the APK is a brick and no
  // amount of "build succeeded" downstream would matter.
  const verify = verifyProfile(profile, { [signingKey.keyId]: signingKey.publicKey });
  if (!verify.ok) {
    return { ok: false, code: 5, reason: `emitted profile does not verify against the emitted key: ${verify.reason}`, files: [] };
  }

  const files = [
    { path: path.join(assetsDir, 'profile.json'), text: `${JSON.stringify(profile, null, 2)}\n` },
    { path: path.join(assetsDir, 'bundle.json'), text: `${JSON.stringify(bundle, null, 2)}\n` },
    { path: keysFile, text: kotlinFor([[signingKey.keyId, signingKey.publicKey]]) },
    // keys.json is *not* written into the app: it holds the private key and every node
    // credential. It goes to the operator's server directory, not into an installable artifact.
    { path: path.join(assetsDir, 'README-where-is-the-private-key.md'), text: privateKeyNote(signingKey.keyId, profile.profileId) },
  ];

  // The tripwire. Everything above is a *convention* (strip before signing); this is the check
  // that makes the convention unbreakable from this side: if any server-only secret value — the
  // Reality private key, the WireGuard server private key — appears in any byte we are about to
  // place inside the APK, we stop. `assets/` in an APK is a zip entry anyone can read, so a
  // regression in init.js or a hand-passed `credentials` override would otherwise ship the node's
  // identity to every installer and every store crawler.
  const secrets = serverSecretValues(credentials);
  if (secrets.length) {
    const hit = files.find((f) => secrets.some((v) => f.text.includes(v)));
    if (hit) {
      return { ok: false, code: 5, reason: `refusing to write ${hit.path}: it contains server-only private material`, files: [] };
    }
  }

  if (!dryRun) {
    await mkdir(assetsDir, { recursive: true });
    await mkdir(path.dirname(keysFile), { recursive: true });
    for (const f of files) await writeFile(f.path, f.text, 'utf8');
  }

  return {
    ok: true,
    dryRun,
    files: files.map((f) => path.relative(androidDir, f.path)),
    keyId: signingKey.keyId,
    publicKeyB64: signingKey.publicKeyB64,
    profileId: profile.profileId,
    nodes: bundle.nodes.length,
    rungs: bundle.nodes[0]?.allowedRungs?.length ?? 0,
    guard: bundle.nodes[0]?.guard ? 'per node' : 'none',
    validated: validate,
    replacedHandwritten: protectedExisting && force,
    credentialsHint: `the node's own credentials (needed for server.json) are: ${Object.keys(credentials).slice(0, 4).join(', ')} — keep them out of the APK`,
  };
}

function privateKeyNote(keyId, profileId) {
  return `# why there is no keys.json here

\`savak app-assets\` wrote ${'`'}profile.json${'`'} and ${'`'}bundle.json${'`'} into this assets
directory on purpose: those two are *public* — the profile is a signed document, and a signature
is worthless if the signed content has to stay secret.

What is deliberately **not** here is ${'`'}keys.json${'`'}: the profile signing private key, the
Reality keypair and the Hy2/TUIC/SS passwords. Anything in ${'`'}src/main/assets${'`'} ends up
inside the APK, which is a zip anyone can open.

If you need to re-sign or re-issue: the signing keyId is \`${keyId}\` and it signed profileId
\`${profileId}\`. Re-running ${'`'}savak init --outDir server/${'`'} regenerates a *new* key — it
will not match this profile. Keep the ${'`'}keys.json${'`'} that produced this pair next to the
server, in ${'`'}/etc/savak/${'`'}, mode 0600.
`;
}
