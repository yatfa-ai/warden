// Tests for summarizeProjectGitState — the pure aggregator behind the project
// filter chips' uncommitted/unpushed WIP badges (WARDEN-201).
//
// There is no front-end test runner in this repo, so (like diff.test.mjs) this
// loads the REAL src/lib/gitStateSummary.ts (transpiled TS -> ESM via Vite's OXC
// transform) and exercises it directly with plain objects. The helper must be a
// faithful, sparse mirror of the per-row GitBranchBadge vocabulary: clean===false
// ⇒ dirty (yellow ±), ahead > 0 ⇒ unpushed (amber ↑N) — and a chat with unknown
// status (missing from the cached gitStatus map) must count as NEITHER, never as
// clean, so a still-loading agent can't masquerade as a clean repo.
//
// Run: node gitStateSummary.test.mjs   (from web/)
import { transformWithOxc } from 'vite';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const helperPath = resolve(__dirname, 'src/lib/gitStateSummary.ts');

// --- Load the REAL gitStateSummary.ts (TS -> ESM via the OXC transform Vite bundles) ----
const src = readFileSync(helperPath, 'utf8');
const { code } = await transformWithOxc(src, helperPath, {});
const tmpDir = mkdtempSync(join(tmpdir(), 'warden-gitstate-test-'));
const tmpFile = join(tmpDir, 'gitStateSummary.mjs');
writeFileSync(tmpFile, code);
const { summarizeProjectGitState } = await import(tmpFile);
rmSync(tmpDir, { recursive: true, force: true });

let passed = 0;
const test = (name, fn) => {
  fn();
  passed += 1;
  console.log('  ok -', name);
};

// A tiny builder so each case reads as "which agents have which status" rather
// than a wall of {key,id,project,active} literals.
const agent = (id, project, key) => ({ id, project, active: true, key });
const status = (clean, ahead) => ({ clean, ahead });

const sum = (chats, gitStatus) => summarizeProjectGitState(chats, gitStatus);

console.log('\nclean project → no counts (badges hidden)');
test('a clean, pushed agent yields no per-project entry and zero totals', () => {
  const r = sum([agent('a1', 'warden')], { a1: status(true, 0) });
  assert.deepEqual(r.perProject, {});
  assert.deepEqual(r.total, { dirty: 0, unpushed: 0 });
});

console.log('\ndirty-only → counts toward dirty, not unpushed');
test('clean===false with ahead 0 → dirty:1, unpushed:0', () => {
  const r = sum([agent('a1', 'warden')], { a1: status(false, 0) });
  assert.deepEqual(r.perProject, { warden: { dirty: 1, unpushed: 0 } });
  assert.deepEqual(r.total, { dirty: 1, unpushed: 0 });
});

console.log('\nunpushed-only → counts toward unpushed, not dirty');
test('clean repo with ahead 3 → dirty:0, unpushed:1', () => {
  const r = sum([agent('a1', 'warden')], { a1: status(true, 3) });
  assert.deepEqual(r.perProject, { warden: { dirty: 0, unpushed: 1 } });
  assert.deepEqual(r.total, { dirty: 0, unpushed: 1 });
});

console.log('\nboth → one agent contributes once to each counter (not doubled)');
test('clean===false AND ahead 2 → dirty:1, unpushed:1', () => {
  const r = sum([agent('a1', 'warden')], { a1: status(false, 2) });
  assert.deepEqual(r.perProject, { warden: { dirty: 1, unpushed: 1 } });
  assert.deepEqual(r.total, { dirty: 1, unpushed: 1 });
});

console.log('\nmulti-project aggregation');
test('counts accumulate per project and across projects independently', () => {
  const chats = [
    agent('a1', 'warden'),
    agent('a2', 'warden'),
    agent('a3', 'warden'),
    agent('b1', 'tinker'),
  ];
  // warden: 2 dirty (a1,a2) + 1 also unpushed (a2); a3 clean.
  // tinker: 1 unpushed only (b1).
  const gitStatus = {
    a1: status(false, 0), // dirty only
    a2: status(false, 2), // dirty + unpushed
    a3: status(true, 0),  // clean → contributes nothing
    b1: status(true, 5),  // unpushed only
  };
  const r = sum(chats, gitStatus);
  assert.deepEqual(r.perProject, {
    warden: { dirty: 2, unpushed: 1 },
    tinker: { dirty: 0, unpushed: 1 },
  });
  assert.deepEqual(r.total, { dirty: 2, unpushed: 2 });
});

console.log('\nunknown status (missing from gitStatus) counts as NEITHER, never clean');
test('an active project agent absent from the map → no entry, no totals', () => {
  const r = sum([agent('a1', 'warden')], {});
  assert.deepEqual(r.perProject, {});
  assert.deepEqual(r.total, { dirty: 0, unpushed: 0 });
});
test('a still-loading agent never masks a dirty sibling in the same project', () => {
  // a1 dirty & known, a2 unknown: a2 must NOT be treated as clean and must not
  // dilute a1's dirty count (the false-clean trap this slice guards against).
  const r = sum([agent('a1', 'warden'), agent('a2', 'warden')], { a1: status(false, 0) });
  assert.deepEqual(r.perProject, { warden: { dirty: 1, unpushed: 0 } });
  assert.deepEqual(r.total, { dirty: 1, unpushed: 0 });
});

console.log('\nnull/unknown field values are quiet, not counted');
test('clean:null is not dirty (only explicit clean===false is)', () => {
  const r = sum([agent('a1', 'warden')], { a1: status(null, 1) });
  assert.deepEqual(r.perProject, { warden: { dirty: 0, unpushed: 1 } });
});
test('ahead:null is not unpushed (only a number > 0 is)', () => {
  const r = sum([agent('a1', 'warden')], { a1: status(false, null) });
  assert.deepEqual(r.perProject, { warden: { dirty: 1, unpushed: 0 } });
});
test('ahead:0 is not unpushed', () => {
  const r = sum([agent('a1', 'warden')], { a1: status(false, 0) });
  assert.equal(r.perProject.warden.unpushed, 0);
});

console.log('\npopulation matches projectCounts: inactive / project-less chats are skipped');
test('inactive agent (active:false) is ignored even when dirty', () => {
  const r = sum([{ id: 'a1', project: 'warden', active: false }], { a1: status(false, 5) });
  assert.deepEqual(r.perProject, {});
  assert.deepEqual(r.total, { dirty: 0, unpushed: 0 });
});
test('active agent without a project is ignored (chips are project-scoped)', () => {
  const r = sum([{ id: 'a1', active: true }], { a1: status(false, 5) });
  assert.deepEqual(r.perProject, {});
  assert.deepEqual(r.total, { dirty: 0, unpushed: 0 });
});

console.log('\nkey resolution: status is looked up by key || id (matches per-row lookups)');
test('when key is set, the status is read from gitStatus[key], not gitStatus[id]', () => {
  // container key 'warden-worker' set; status keyed by key. An entry keyed by the
  // bare id must be IGNORED so a yatfa agent isn't misread from a stale id-keyed row.
  const chats = [agent('raw-id', 'warden', 'warden-worker')];
  const gitStatus = {
    'raw-id': status(false, 5),      // must be ignored (wrong key)
    'warden-worker': status(true, 0), // clean → no counts
  };
  const r = sum(chats, gitStatus);
  assert.deepEqual(r.perProject, {});
  assert.deepEqual(r.total, { dirty: 0, unpushed: 0 });
});
test('when no key, the status is read from gitStatus[id]', () => {
  const chats = [{ id: 'chat-1', project: 'warden', active: true }];
  const r = sum(chats, { 'chat-1': status(false, 0) });
  assert.deepEqual(r.perProject, { warden: { dirty: 1, unpushed: 0 } });
});

console.log('\ntotal always equals the sum across projects');
test('total.dirty and total.unpushed equal the per-project sums', () => {
  const chats = [
    agent('a1', 'warden'), agent('a2', 'warden'),
    agent('b1', 'tinker'), agent('c1', 'nova'),
  ];
  const gitStatus = {
    a1: status(false, 0), a2: status(true, 4),
    b1: status(false, 1), c1: status(true, 0),
  };
  const r = sum(chats, gitStatus);
  const sumDirty = Object.values(r.perProject).reduce((n, p) => n + p.dirty, 0);
  const sumUnpushed = Object.values(r.perProject).reduce((n, p) => n + p.unpushed, 0);
  assert.equal(r.total.dirty, sumDirty);
  assert.equal(r.total.unpushed, sumUnpushed);
  // c1 is clean → 'nova' is absent from the sparse map.
  assert.equal('nova' in r.perProject, false);
});

console.log('\nempty inputs are safe');
test('no chats → empty per-project, zero totals', () => {
  const r = sum([], { x: status(false, 5) });
  assert.deepEqual(r.perProject, {});
  assert.deepEqual(r.total, { dirty: 0, unpushed: 0 });
});

console.log(`\n✓ GIT STATE SUMMARY TESTS PASS (${passed})`);
