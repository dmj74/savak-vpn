// Anti-drift: the Android side hardcodes the list of mode names it will honour when it
// restores a persisted choice at boot. If that list and engine/src/tune.js POLICIES ever
// disagree, the app silently drops the user's mode (unknown → falls back to the bundle's)
// — a bug with no error message anywhere. So the two are compared here, in CI, from source.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { POLICIES } from '../src/tune.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');

const read = (rel) => readFileSync(join(root, rel), 'utf8');

test('MainActivity KNOWN_MODES is exactly the engine POLICIES key set', () => {
  const kt = read('android/app/src/main/java/ir/savak/client/MainActivity.kt');
  const m = kt.match(/KNOWN_MODES = setOf\(([^)]*)\)/);
  assert.ok(m, 'MainActivity must declare KNOWN_MODES (see the boot-time mode restore)');
  const kotlin = m[1].split(',').map((x) => x.trim().replace(/^"|"$/g, '')).filter(Boolean).sort();
  assert.deepEqual(kotlin, Object.keys(POLICIES).sort(), 'mode names must not drift between engine and app');
});

test('every mode has a chip in the UI picker and a string resource', () => {
  const main = read('android/app/src/main/java/ir/savak/client/MainActivity.kt');
  const picker = main.match(/private fun ModePicker[\s\S]*?\n}\n/);
  assert.ok(picker, 'ModePicker must exist');
  for (const mode of Object.keys(POLICIES)) {
    assert.ok(new RegExp('"' + mode + '" to').test(picker[0]), `ModePicker must offer "${mode}" — a mode with no chip is unreachable`);
  }
  const strings = read('android/app/src/main/res/values/strings.xml');
  for (const mode of Object.keys(POLICIES)) {
    assert.ok(strings.includes(`name="mode_${mode}"`), `strings.xml is missing mode_${mode}`);
  }
});

test('the R stub keeps every string the app references, or typecheck.sh would not be meaningful', () => {
  const r = read('android/tools/kotlinc-stubs/SavakR.kt');
  const strings = read('android/app/src/main/res/values/strings.xml');
  const names = [...strings.matchAll(/<string name="([a-z0-9_]+)"/g)].map((x) => x[1]);
  for (const n of names) {
    assert.ok(r.includes(`const val ${n} =`), `R stub is missing string.${n} — a real AGP build would have R, the stub must keep pace`);
  }
});
