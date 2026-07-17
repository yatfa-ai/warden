// Tests for the pure collision-compare helpers in src/lib/collisionCompare.ts
// (WARDEN-321).
//
// The fan-out itself (Promise.allSettled over /api/git-diff per colliding agent)
// lives in CollisionCompareDialog because it touches fetch + per-panel state.
// These tests cover the extracted pure seam — reduceCollisionDiffs — so the
// load-bearing classification logic has real coverage: a partial failure MUST
// NOT blank the other agents' panels (the whole point of allSettled), the four
// status branches (ok / untracked / empty / error) MUST map to the right shape,
// and `results[i]` MUST stay aligned with `agents[i].key`.
//
// collisionCompare.ts is `import type`-free at runtime (no value imports), so
// Vite's OXC transform emits clean ESM JS and the same transpile-to-temp-`.mjs`
// + dynamic `import()` harness used by broadcast.test.mjs / gitStateSummary.test.mjs
// loads the REAL module (not a hand-rolled re-implementation).
//
// Run: node collisionCompare.test.mjs   (from web/)
import { transformWithOxc } from 'vite';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const libPath = resolve(__dirname, 'src/lib/collisionCompare.ts');

// --- Load the REAL collisionCompare.ts (TS -> ESM via the OXC transform Vite bundles)
const src = readFileSync(libPath, 'utf8');
const { code } = await transformWithOxc(src, libPath, {});
const tmpDir = mkdtempSync(join(tmpdir(), 'warden-collision-compare-test-'));
const tmpFile = join(tmpDir, 'collisionCompare.mjs');
writeFileSync(tmpFile, code);
const { reduceCollisionDiffs, reduceCrossAgentDiff } = await import(tmpFile);
rmSync(tmpDir, { recursive: true, force: true });

let passed = 0;
const test = (name, fn) => {
  fn();
  passed += 1;
  console.log('  ok -', name);
};

// Promise.allSettled result builders + /api/git-diff response builders — keep the
// test bodies honest about shape. `gitDiff` mirrors the server.js:1377-1402
// response: { diff, untracked, error }. `crossDiff` mirrors /api/cross-agent-diff:
// { diff, error }.
const fulfilled = (value) => ({ status: 'fulfilled', value });
const rejected = (reason) => ({ status: 'rejected', reason });
const gitDiff = (diff, untracked = false, error = null) => ({ diff, untracked, error });
const crossDiff = (diff, error = null) => ({ diff, error });
// A single-agent fixture for the per-branch classification tests (one result in,
// one panel out). AGENTS (3) is reserved for the order/partial-failure cases.
const ONE = [{ key: 'a' }];
const AGENTS = [{ key: 'a' }, { key: 'b' }, { key: 'c' }];

// ---------------------------------------------------------------------------
console.log('\nreduceCollisionDiffs — status classification');
// ---------------------------------------------------------------------------
test('a real diff → status ok, diff carried through', () => {
  const panels = reduceCollisionDiffs(ONE, [
    fulfilled(gitDiff('@@ -1 +1 @@\n-old\n+new\n')),
  ]);
  assert.equal(panels.length, 1);
  assert.equal(panels[0].key, 'a');
  assert.equal(panels[0].status, 'ok');
  assert.equal(panels[0].diff, '@@ -1 +1 @@\n-old\n+new\n');
  assert.equal(panels[0].error, null);
});
test('untracked:true → status untracked (new file, no tracked baseline)', () => {
  const panels = reduceCollisionDiffs(ONE, [fulfilled(gitDiff(null, true))]);
  assert.equal(panels[0].status, 'untracked');
  assert.equal(panels[0].diff, '');
  assert.equal(panels[0].error, null);
});
test('untracked with content → status untracked AND diff carried (new file as additions)', () => {
  // If a transport returns the untracked file's body, the panel should still be
  // able to render it — status marks it untracked, but the content passes through.
  const panels = reduceCollisionDiffs(ONE, [fulfilled(gitDiff('+brand new line\n', true))]);
  assert.equal(panels[0].status, 'untracked');
  assert.equal(panels[0].diff, '+brand new line\n');
});
test('empty diff, no error, not untracked → status empty (collision already resolved here)', () => {
  const panels = reduceCollisionDiffs(ONE, [fulfilled(gitDiff('', false))]);
  assert.equal(panels[0].status, 'empty');
  assert.equal(panels[0].diff, '');
  assert.equal(panels[0].error, null);
});
test('null diff, no error, not untracked → status empty (null and "" both read as empty)', () => {
  const panels = reduceCollisionDiffs(ONE, [fulfilled(gitDiff(null, false))]);
  assert.equal(panels[0].status, 'empty');
});
test('fulfilled with .error → status error (the 200-with-error + 4xx/5xx shapes)', () => {
  const panels = reduceCollisionDiffs(ONE, [fulfilled(gitDiff(null, false, 'diff failed'))]);
  assert.equal(panels[0].status, 'error');
  assert.equal(panels[0].diff, '');
  assert.equal(panels[0].error, 'diff failed');
});
test('a rejected promise → status error reading reason.message (a network throw)', () => {
  const panels = reduceCollisionDiffs(ONE, [rejected(new Error('network down'))]);
  assert.equal(panels[0].status, 'error');
  assert.equal(panels[0].error, 'network down');
  assert.equal(panels[0].key, 'a');
});
test('a rejected non-Error reason stringifies (does not print [object Object])', () => {
  const panels = reduceCollisionDiffs(ONE, [rejected('timeout')]);
  assert.equal(panels[0].error, 'timeout');
});
test('a rejected null/undefined reason falls back to "unreachable" (not "null")', () => {
  assert.equal(reduceCollisionDiffs(ONE, [rejected(null)])[0].error, 'unreachable');
  assert.equal(reduceCollisionDiffs(ONE, [rejected(undefined)])[0].error, 'unreachable');
});

// ---------------------------------------------------------------------------
console.log('\nreduceCollisionDiffs — order preservation + partial-failure independence');
// ---------------------------------------------------------------------------
test('results[i] ↔ agents[i].key: each panel keeps its own key, in order', () => {
  const panels = reduceCollisionDiffs(AGENTS, [
    fulfilled(gitDiff('A-diff')),
    fulfilled(gitDiff('B-diff')),
    fulfilled(gitDiff('C-diff')),
  ]);
  assert.deepEqual(panels.map((p) => p.key), ['a', 'b', 'c']);
  assert.deepEqual(panels.map((p) => p.diff), ['A-diff', 'B-diff', 'C-diff']);
});
test('PARTIAL FAILURE does not blank siblings: ok + error + untracked all render', () => {
  // The load-bearing property: one agent down must NOT abort or hide the others.
  // The human is comparing divergent edits — the reachable agent's diff is the
  // whole point and must survive a sibling being unreachable.
  const panels = reduceCollisionDiffs(AGENTS, [
    fulfilled(gitDiff('@@ a @@')),
    rejected(new Error('ssh: connect to host port 22: Connection refused')),
    fulfilled(gitDiff(null, true)),
  ]);
  assert.equal(panels.length, 3);
  assert.equal(panels[0].status, 'ok');
  assert.equal(panels[0].diff, '@@ a @@');
  assert.equal(panels[1].status, 'error');
  assert.match(panels[1].error, /Connection refused/);
  assert.equal(panels[2].status, 'untracked');
});
test('a missing results slot → status error (does not crash or silently drop)', () => {
  // A buggy call site that fans out fewer fetches than agents must surface the
  // mis-sized agent as unreachable rather than throwing or skipping it.
  const panels = reduceCollisionDiffs(AGENTS, [fulfilled(gitDiff('only-one'))]);
  assert.equal(panels.length, 3);
  assert.equal(panels[0].status, 'ok');
  assert.equal(panels[1].status, 'error');
  assert.equal(panels[1].error, 'unreachable');
  assert.equal(panels[2].status, 'error');
  assert.equal(panels[2].error, 'unreachable');
});
test('a fulfilled value of null/undefined is treated as empty (defensive, not a crash)', () => {
  const panels = reduceCollisionDiffs(AGENTS, [fulfilled(undefined), fulfilled(null)]);
  assert.equal(panels[0].status, 'empty');
  assert.equal(panels[1].status, 'empty');
});

// ---------------------------------------------------------------------------
console.log('\nreduceCollisionDiffs — edge cases');
// ---------------------------------------------------------------------------
test('error takes precedence over untracked (an errored untracked file is still an error)', () => {
  // If the transport set BOTH error and untracked, the error is the actionable
  // signal — surface it rather than masking it behind the untracked branch.
  const panels = reduceCollisionDiffs(ONE, [fulfilled(gitDiff(null, true, 'no cwd'))]);
  assert.equal(panels[0].status, 'error');
  assert.equal(panels[0].error, 'no cwd');
});
test('whitespace-only diff is NOT empty (a real, if tiny, edit)', () => {
  // A diff of just a newline or spaces is still a non-empty string — the agent
  // touched the file — so it reads as ok, not empty. length===0 is the only empty.
  const panels = reduceCollisionDiffs(ONE, [fulfilled(gitDiff('\n'))]);
  assert.equal(panels[0].status, 'ok');
  assert.equal(panels[0].diff, '\n');
});
test('empty agents → empty panels (nothing to compare)', () => {
  assert.deepEqual(reduceCollisionDiffs([], []), []);
});
test('two-agent collision (the minimum) → two panels, each independently classified', () => {
  // The canonical WARDEN-321 case: two agents diverging on one file.
  const two = [{ key: 'worker-1' }, { key: 'worker-2' }];
  const panels = reduceCollisionDiffs(two, [
    fulfilled(gitDiff('@@ -10 +10 @@\n-    return x;\n+    return y;\n')),
    fulfilled(gitDiff('@@ -80 +80 @@\n-    foo();\n+    bar();\n')),
  ]);
  assert.equal(panels.length, 2);
  assert.ok(panels.every((p) => p.status === 'ok'));
  // Disjoint regions (line 10 vs line 80) are visible to the human by reading
  // the two stacked panels — exactly the disjoint-vs-overlap legibility goal.
  assert.match(panels[0].diff, /-10 \+10/);
  assert.match(panels[1].diff, /-80 \+80/);
});

// ---------------------------------------------------------------------------
console.log('\nreduceCrossAgentDiff — A↔B overlap classification (WARDEN-593)');
// ---------------------------------------------------------------------------
// The A↔B reducer classifies the SINGLE cross-agent-diff outcome (two agents'
// working trees diffed directly) — a sibling of reduceCollisionDiffs, sharing its
// settled-result → status discipline so the rejected/error/empty mapping lives in
// the tested pure seam, not the component. PAIR holds the two agent keys; ONEAB is
// the canonical 2-agent collision.
const PAIR = ['worker-1', 'worker-2'];
test('a real A↔B diff → status differ, diff carried through', () => {
  const panel = reduceCrossAgentDiff(PAIR[0], PAIR[1], fulfilled(crossDiff('@@ -1 +1 @@\n-old\n+new\n')));
  assert.equal(panel.keyA, 'worker-1');
  assert.equal(panel.keyB, 'worker-2');
  assert.equal(panel.status, 'differ');
  assert.equal(panel.diff, '@@ -1 +1 @@\n-old\n+new\n');
  assert.equal(panel.error, null);
});
test('empty diff, no error → status identical (both made the same change — no conflict)', () => {
  // The load-bearing A↔B signal: two working trees byte-identical → the collision
  // is a false alarm. Distinct from per-agent 'empty' (one agent vs its OWN HEAD).
  const panel = reduceCrossAgentDiff(...PAIR, fulfilled(crossDiff('')));
  assert.equal(panel.status, 'identical');
  assert.equal(panel.diff, '');
  assert.equal(panel.error, null);
});
test('null diff, no error → status identical (null and "" both read as identical)', () => {
  const panel = reduceCrossAgentDiff(PAIR[0], PAIR[1], fulfilled(crossDiff(null)));
  assert.equal(panel.status, 'identical');
});
test('fulfilled with .error → status error carrying the server-prefixed side', () => {
  // The server prefixes the failing side; the reducer passes it straight through.
  const panel = reduceCrossAgentDiff(PAIR[0], PAIR[1], fulfilled(crossDiff(null, 'A: file not found')));
  assert.equal(panel.status, 'error');
  assert.equal(panel.diff, '');
  assert.equal(panel.error, 'A: file not found');
});
test('a rejected promise → status error reading reason.message (a network throw)', () => {
  const panel = reduceCrossAgentDiff(PAIR[0], PAIR[1], rejected(new Error('ssh: connect to host port 22')));
  assert.equal(panel.status, 'error');
  assert.match(panel.error, /connect to host port 22/);
});
test('a rejected non-Error reason stringifies (does not print [object Object])', () => {
  const panel = reduceCrossAgentDiff(PAIR[0], PAIR[1], rejected('timeout'));
  assert.equal(panel.error, 'timeout');
});
test('a rejected null/undefined reason falls back to "unreachable" (not "null")', () => {
  assert.equal(reduceCrossAgentDiff(...PAIR, rejected(null)).error, 'unreachable');
  assert.equal(reduceCrossAgentDiff(...PAIR, rejected(undefined)).error, 'unreachable');
});
test('a missing outcome (undefined) → status error (does not crash or render a broken panel)', () => {
  // <2 agents, or a buggy call site that did not produce an outcome — surface it
  // rather than throwing. Keys are still carried so the panel could label it.
  const panel = reduceCrossAgentDiff(PAIR[0], PAIR[1], undefined);
  assert.equal(panel.status, 'error');
  assert.equal(panel.error, 'unreachable');
  assert.equal(panel.keyA, 'worker-1');
  assert.equal(panel.keyB, 'worker-2');
});
test('whitespace-only A↔B diff is NOT identical (a real, if tiny, divergence)', () => {
  // A diff of just a newline is still a non-empty string — the two trees diverge —
  // so it reads as differ, not identical. length===0 is the only identical.
  const panel = reduceCrossAgentDiff(...PAIR, fulfilled(crossDiff('\n')));
  assert.equal(panel.status, 'differ');
  assert.equal(panel.diff, '\n');
});
test('error takes precedence over an empty diff (an errored identical read is still an error)', () => {
  // If the transport set BOTH error and an empty diff, the error is the actionable
  // signal — surface it rather than masking it behind the identical branch.
  const panel = reduceCrossAgentDiff(...PAIR, fulfilled(crossDiff('', 'B: binary file')));
  assert.equal(panel.status, 'error');
  assert.equal(panel.error, 'B: binary file');
});

console.log(`\n✓ COLLISION COMPARE TESTS PASS (${passed})`);
