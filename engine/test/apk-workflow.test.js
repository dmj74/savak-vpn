/**
 * The `.github/workflows` copy of the APK pipeline must not drift from `ci/apk-only.yml`.
 *
 * Why a test and not a comment: the repo keeps its CI definitions under `ci/` and only *installs*
 * one into `.github/workflows` when an operator decides to turn builds on (the Contents API refuses
 * writes to that path for an integration token, so it is a human act). Two copies of a build
 * pipeline, edited at different times, is how you end up with "CI is green" describing a build that
 * is not the one documented. The check is byte equality — anything looser would pass while the
 * pinned sing-box version or the keystore handling silently differed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const SOURCE = path.join(ROOT, 'ci', 'apk-only.yml');
const INSTALLED = path.join(ROOT, '.github', 'workflows', 'apk-only.yml');

async function read(p) {
  try {
    return await readFile(p, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

test('the source pipeline exists and carries the two guards that make its APK meaningful', async () => {
  const yml = await readFile(SOURCE, 'utf8');
  assert.match(yml, /app-assets/, 'an APK without a bundle opens empty — the pipeline must generate one');
  assert.match(yml, /name: refuse a silent skip/, 'the app-assets step must fail loudly if it produced nothing');
  assert.match(yml, /BUILD_APK_WITH_DEMO_BUNDLE: \$\{\{ github.event_name == 'workflow_dispatch'/, 'tag builds must not carry a CI-minted profile');
  assert.match(yml, /SINGBOX_VERSION: 1\.14\.4/, 'the core version is pinned; a bump is a deliberate edit');
  assert.match(yml, /if-no-files-found: error/, 'an artifact step that tolerates a missing APK reports success on a broken build');
});

test('an installed copy is byte-identical to the source', async () => {
  const [src, installed] = [await read(SOURCE), await read(INSTALLED)];
  if (installed === null) {
    // Not enabled here — the activation is the operator's one-line act. Recorded, not asserted,
    // so the suite stays honest about which world it ran in.
    return;
  }
  assert.equal(installed, src, '.github/workflows/apk-only.yml differs from ci/apk-only.yml — re-copy it');
});

test('the installed copy is not the only place a step is documented', async () => {
  const installed = await read(INSTALLED);
  if (installed === null) return;
  const stepNames = (txt) => [...txt.matchAll(/^ {6}- (?:name: (.+)|run:)/gm)].map((m) => m[1] ?? 'inline').sort();
  assert.deepEqual(stepNames(installed), stepNames(await read(SOURCE)));
});
