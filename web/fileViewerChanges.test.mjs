// FileViewer "Changes" view tests (WARDEN-786).
//
// The Changes view adds a fourth file-understanding surface to FileViewer — the
// open file's uncommitted working-tree diff vs HEAD (fetched via the existing
// GET /api/git-diff?id=&path=). There is no front-end DOM test runner in this
// repo, so (like breadcrumbs.test.mjs and collisionCompare.test.mjs) this loads
// the REAL src/lib/fileViewerChanges.ts (transpiled TS -> ESM via Vite's OXC
// transform) and drives the two pure seams the component's behavior hinges on:
//
//   - classifyChangesView: the untracked vs clean/empty vs dirty vs error vs
//     loading render decision. This is where a wrong branch silently misleads a
//     coordinator: masking an `error` as "No uncommitted changes" hides a real
//     failure (WARDEN-89 / WARDEN-68 honest-state discipline); treating an empty-
//     string diff as dirty would show a blank diff box for a clean file; and —
//     the bug this suite guards against — folding an untracked (brand-new) file
//     into the clean empty-state hides exactly the kind of change this view
//     exists to surface (agents create new files constantly). The endpoint
//     returns { diff: null, untracked: true } for an untracked file (git diff
//     HEAD -- <untracked> is empty, so the route disambiguates with
//     `git ls-files --error-unmatch`), so the REAL production input for "new
//     file" is diff:null + untracked:true, which MUST classify as `untracked`,
//     never `clean`. Only diff null OR '' with untracked=false reads as clean.
//
//   - resolveViewToggles: the mutual-exclusivity contract for the toolbar's
//     alternate views (annotate / history / changes). Forgetting to clear
//     `changes` when annotate turns on would overlay two views; this pins that
//     turning any one ON clears the other two, and turning one OFF leaves the
//     others alone.
//
// Run: node fileViewerChanges.test.mjs   (or: npm test, from web/)
import { transformWithOxc } from 'vite';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const libPath = resolve(__dirname, 'src/lib/fileViewerChanges.ts');

// --- Load the REAL fileViewerChanges.ts (TS -> ESM via the OXC transform Vite bundles)
const src = readFileSync(libPath, 'utf8');
const { code } = await transformWithOxc(src, libPath, {});
const tmpDir = mkdtempSync(join(tmpdir(), 'warden-fileviewer-changes-test-'));
const tmpFile = join(tmpDir, 'fileViewerChanges.mjs');
writeFileSync(tmpFile, code);
const { classifyChangesView, resolveViewToggles } = await import(tmpFile);
rmSync(tmpDir, { recursive: true, force: true });

let passed = 0;
const test = (name, fn) => {
  fn();
  passed += 1;
  console.log('  ok -', name);
};

// /api/git-diff response builder — mirrors the route contract (src/gitRoutes.js
// /api/git-diff) and the `gitDiff` fixture in collisionCompare.test.mjs:
// { diff, untracked, error }. diff is string|null, error is string|null.
const resp = (diff, untracked = false, error = null) => ({ diff, untracked, error });

console.log('\nclassifyChangesView — clean empty-state (success criterion 3)');

test('a null diff with no error is clean (clean tracked file)', () => {
  assert.deepEqual(classifyChangesView(resp(null), false), { kind: 'clean' });
});

test('an empty-string diff with no error is also clean (git diff HEAD can yield "")', () => {
  // The route returns null for a clean tracked file, but `git diff HEAD -- <f>`
  // can return '' — both must read as clean, never a blank/empty dirty box.
  assert.deepEqual(classifyChangesView(resp(''), false), { kind: 'clean' });
});

test('loading pre-empts the response — a prior file\'s stale diff must not flash', () => {
  // A non-null diff from the previous file is still in state when the viewer
  // opens a new file; loading=true must win so the spinner shows, not stale diff.
  assert.deepEqual(classifyChangesView(resp('+stale\n'), true), { kind: 'loading' });
});

console.log('\nclassifyChangesView — dirty render (success criterion 2)');

test('a non-empty diff is dirty and carries the diff string verbatim', () => {
  const diff = '@@ -1 +1 @@\n-old\n+new\n';
  assert.deepEqual(classifyChangesView(resp(diff), false), { kind: 'dirty', diff, untracked: false });
});

console.log('\nclassifyChangesView — untracked new file (success criterion 2, the case the view exists to surface)');

test('a brand-new (untracked) file classifies as untracked, NOT clean — the real production input', () => {
  // This is the input the endpoint ACTUALLY delivers for a new file: git diff
  // HEAD -- <untracked> is empty, so the route disambiguates with
  // `git ls-files --error-unmatch` and returns { diff: null, untracked: true }.
  // A new file is 100% a change, so it must render its own `untracked` state —
  // never the "No uncommitted changes" clean empty-state. (On the pre-fix
  // main-tip this assertion goes RED: untracked was folded into `clean`.)
  assert.deepEqual(classifyChangesView(resp(null, true), false), { kind: 'untracked' });
});

test('an empty-string diff with untracked=true is also untracked (git diff HEAD yields "" for a new file)', () => {
  // Same disambiguation as above if the empty branch happened to return '' rather
  // than null — untracked wins over the empty/clean reading.
  assert.deepEqual(classifyChangesView(resp('', true), false), { kind: 'untracked' });
});

test('untracked is checked BEFORE clean — diff:null + untracked:true is never clean', () => {
  // The dangerous misclassification the original code shipped: an untracked file
  // fell through to `clean`. Pin the precedence explicitly so a reordering can't
  // silently resurrect the bug.
  const result = classifyChangesView(resp(null, true), false);
  assert.notEqual(result.kind, 'clean');
  assert.equal(result.kind, 'untracked');
});

console.log('\nclassifyChangesView — error surfacing (success criterion 4)');

test('a non-null error is surfaced, never masked as a clean empty-state', () => {
  // The endpoint returns 200 with a populated `error` for soft failures — masking
  // it as clean would hide a real failure (WARDEN-89 / WARDEN-68).
  assert.deepEqual(
    classifyChangesView(resp(null, false, 'not a git repository'), false),
    { kind: 'error', message: 'not a git repository' },
  );
});

test('error wins over a present diff (error takes precedence)', () => {
  // If the endpoint ever returns both, the error is the honest state to show.
  assert.deepEqual(
    classifyChangesView(resp('+new\n', false, 'diff failed'), false),
    { kind: 'error', message: 'diff failed' },
  );
});

test('error wins over loading===false only — loading still pre-empts error', () => {
  // While loading, no half-applied error is shown; the spinner owns the frame.
  assert.deepEqual(
    classifyChangesView(resp(null, false, 'pending error'), true),
    { kind: 'loading' },
  );
});

console.log('\nresolveViewToggles — mutual exclusivity (success criterion 5)');

test('turning Changes ON clears annotate and history', () => {
  // With annotate+history both on (impossible in practice, but the contract must
  // hold regardless), toggling changes on drops them.
  assert.deepEqual(
    resolveViewToggles({ annotate: true, history: true, changes: false }, 'changes', true),
    { annotate: false, history: false, changes: true },
  );
});

test('turning Annotate ON clears history and Changes', () => {
  assert.deepEqual(
    resolveViewToggles({ annotate: false, history: true, changes: true }, 'annotate', true),
    { annotate: true, history: false, changes: false },
  );
});

test('turning History ON clears annotate and Changes', () => {
  assert.deepEqual(
    resolveViewToggles({ annotate: true, history: false, changes: true }, 'history', true),
    { annotate: false, history: true, changes: false },
  );
});

test('turning a view OFF leaves the other views alone', () => {
  // The user dismissed the view, didn't switch to another — siblings stay as-is.
  assert.deepEqual(
    resolveViewToggles({ annotate: false, history: true, changes: false }, 'history', false),
    { annotate: false, history: false, changes: false },
  );
});

test('turning a view OFF preserves a sibling that is on', () => {
  assert.deepEqual(
    resolveViewToggles({ annotate: true, history: false, changes: false }, 'annotate', false),
    { annotate: false, history: false, changes: false },
  );
});

test('exclusivity is total: turning any one ON never leaves another ON', () => {
  // Property check across all three modes from an all-on starting state — the
  // result must have exactly one true (the mode just turned on).
  for (const mode of ['annotate', 'history', 'changes']) {
    const next = resolveViewToggles({ annotate: true, history: true, changes: true }, mode, true);
    const onCount = (next.annotate ? 1 : 0) + (next.history ? 1 : 0) + (next.changes ? 1 : 0);
    assert.equal(onCount, 1, `turning ${mode} on should leave exactly one view active`);
    assert.equal(next[mode], true, `turning ${mode} on should set it true`);
  }
});

console.log(`\n${passed} passed`);
