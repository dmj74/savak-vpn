import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

/**
 * These two tests are the contract between the engine and the Android app.
 *
 * The phone re-runs the ladder's scoring so it can change transports between check-ins.
 * For that to be safe, the constants it scores with and the numbers it is expected to
 * produce must come from *this* repo, generated, not copied by hand. If either is stale,
 * the app is running a stale model of the network — a bug that looks like a bad day.
 */

const run = (args) => execFileSync(process.execPath, args, { cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8' });

test('the generated Kotlin ladder table matches the engine catalogue', () => {
  let out;
  try {
    out = run(['tools/gen-kotlin-ladder.mjs', '--check']);
  } catch (e) {
    assert.fail(`android LadderTable.kt is out of date with engine/src/ladder.js\n${e.stdout ?? ''}${e.stderr ?? ''}`);
  }
  assert.match(out, /up to date/);
});

test('the parity fixture matches what the engine scores right now', () => {
  let out;
  try {
    out = run(['tools/golden.mjs', '--check']);
  } catch (e) {
    assert.fail(`android parity/golden.json is out of date with the engine\n${e.stdout ?? ''}${e.stderr ?? ''}`);
  }
  assert.match(out, /up to date/);
});

test('the fixture is dense enough to catch a silent divergence', async () => {
  const text = await readFile(fileURLToPath(new URL('../../android/app/src/test/resources/parity/golden.json', import.meta.url)), 'utf8');
  const doc = JSON.parse(text);
  assert.ok(doc.scenarios.length >= 8, 'need enough link variety to pin the model');
  const names = doc.scenarios.map((s) => s.name);
  for (const need of ['udp', 'quic', 'shaped', 'mtu', 'game']) {
    assert.ok(names.some((n) => n.includes(need)), `no scenario exercises "${need}"`);
  }
  let rows = 0;
  const reasons = new Set();
  let withGatedRungs = 0;
  for (const sc of doc.scenarios) {
    rows += sc.expected.length;
    // `game`/`speed` modes legitimately narrow the ladder to five rungs; anything smaller
    // than that means the fixture lost rows rather than the policy being strict.
    assert.ok(sc.expected.length >= 5, `${sc.name}: only ${sc.expected.length} rows — too thin to compare ordering`);
    const gated = sc.expected.filter((r) => !r.feasible);
    if (gated.length) withGatedRungs++;
    for (const r of gated) reasons.add(r.reason.split(' ').slice(0, 3).join(' '));
    // Distinct scores: a fixture where everything ties proves nothing about ordering.
    const scores = sc.expected.map((r) => r.score);
    assert.ok(new Set(scores).size === scores.length, `${sc.name}: duplicate scores make the expected order ambiguous`);
    for (const r of sc.expected) {
      assert.ok('evasionApplied' in r.inputs && 'canHop' in r.inputs, `${sc.name}/${r.rungId}: missing scorer inputs`);
      for (const [k, v] of Object.entries(r.parts)) {
        assert.ok(typeof v === 'number' && v >= 0 && v <= 1.0001, `${sc.name}/${r.rungId}.${k} = ${v} out of range`);
      }
    }
    const sorted = [...scores];
    assert.deepEqual(scores, [...scores].sort((a, b) => b - a), `${sc.name}: fixture is not in descending order`);
    assert.ok(sorted.length > 1);
  }
  assert.ok(rows >= 70, `only ${rows} rows total`);
  // Every hard gate must be represented somewhere, or a regression in it goes unnoticed.
  assert.ok(withGatedRungs >= 3, `only ${withGatedRungs} scenarios gate a rung out`);
  for (const need of ['UDP is blocked', 'QUIC', 'needs MTU']) {
    assert.ok([...reasons].some((r) => r.includes(need)), `no fixture row shows the "${need}" gate (saw: ${[...reasons].join(' / ')})`);
  }
});
