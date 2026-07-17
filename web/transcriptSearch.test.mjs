// Tests for the pure search seam behind WARDEN-513's in-view transcript find:
// findTranscriptMatches (case-insensitive match indices) + stepMatchIndex (↑/↓
// wrap navigation) + activeMatchMessageIndex (cursor → message index, clamped).
//
// There is no front-end test runner in this repo, so (like fleetCommitSearch.test.mjs)
// this loads the REAL src/lib/transcriptSearch.ts (transpiled TS -> ESM via Vite's OXC
// transform) and exercises it directly. The non-pure pieces — the debounce timer, the
// scrollIntoView side effect, the bubble ref map — live in the React component and are
// verified by build/lint + static reasoning (browser QA is blocked in the worker
// sandbox, WARDEN-130). These tests cover only the testable seam.
//
// Run: node transcriptSearch.test.mjs   (from web/)
import { transformWithOxc } from 'vite';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const helperPath = resolve(__dirname, 'src/lib/transcriptSearch.ts');

// --- Load the REAL transcriptSearch.ts (TS -> ESM via the OXC transform Vite bundles) ---
const src = readFileSync(helperPath, 'utf8');
const { code } = await transformWithOxc(src, helperPath, {});
const tmpDir = mkdtempSync(join(tmpdir(), 'warden-transcript-search-test-'));
const tmpFile = join(tmpDir, 'transcriptSearch.mjs');
writeFileSync(tmpFile, code);
const { findTranscriptMatches, stepMatchIndex, activeMatchMessageIndex } = await import(tmpFile);
rmSync(tmpDir, { recursive: true, force: true });

let passed = 0;
const test = (name, fn) => {
  fn();
  passed += 1;
  console.log('  ok -', name);
};

// `text` is the only field the matcher reads — mirror the TranscriptMessage slice.
const msg = (text) => ({ text });

console.log('\nfindTranscriptMatches — case-insensitive match indices, in order');
test('a query matching several messages returns their indices in document order', () => {
  const m = findTranscriptMatches(
    [msg('hello world'), msg('nothing here'), msg('World domination'), msg('worldwide')],
    'world',
  );
  assert.deepEqual(m, [0, 2, 3]);
});
test('matching is case-insensitive (query lower/text upper, and the reverse)', () => {
  assert.deepEqual(findTranscriptMatches([msg('ERROR happened'), msg('all good')], 'error'), [0]);
  assert.deepEqual(findTranscriptMatches([msg('error happened'), msg('all good')], 'ERROR'), [0]);
});
test('a query that is a substring inside a word still matches (token-free substring search)', () => {
  // 'cat' sits inside 'concatenate' (positions 3-5) — not a standalone token.
  assert.deepEqual(findTranscriptMatches([msg('concatenate this')], 'cat'), [0]);
});
test('an empty query matches nothing (UI hides count + highlights when there is no query)', () => {
  assert.deepEqual(findTranscriptMatches([msg('a'), msg('b')], ''), []);
});
test('a whitespace-only query matches nothing (trimmed before matching)', () => {
  assert.deepEqual(findTranscriptMatches([msg('a'), msg('   ')], '   '), []);
});
test('a query absent everywhere returns an empty array', () => {
  assert.deepEqual(findTranscriptMatches([msg('alpha'), msg('beta')], 'gamma'), []);
});
test('a query with surrounding spaces is trimmed so it still matches', () => {
  assert.deepEqual(findTranscriptMatches([msg('fix login bug')], '  login  '), [0]);
});
test('every match is returned when all messages match', () => {
  assert.deepEqual(findTranscriptMatches([msg('ok'), msg('ok'), msg('ok')], 'ok'), [0, 1, 2]);
});
test('an empty message list is safe', () => {
  assert.deepEqual(findTranscriptMatches([], 'x'), []);
});

console.log('\nstepMatchIndex — ↑/↓ wrap navigation (mirrors xterm findNext/findPrevious)');
test('next advances the cursor by one', () => {
  assert.equal(stepMatchIndex(0, 1, 5), 1);
  assert.equal(stepMatchIndex(2, 1, 5), 3);
});
test('prev decrements the cursor by one', () => {
  assert.equal(stepMatchIndex(3, -1, 5), 2);
});
test('next at the LAST match wraps to 0 (wrap-around, like the live pane)', () => {
  assert.equal(stepMatchIndex(4, 1, 5), 0);
});
test('prev at 0 wraps to the last match (wrap-around)', () => {
  assert.equal(stepMatchIndex(0, -1, 5), 4);
});
test('with a single match, next and prev both stay at 0', () => {
  assert.equal(stepMatchIndex(0, 1, 1), 0);
  assert.equal(stepMatchIndex(0, -1, 1), 0);
});
test('with no matches, the cursor stays at 0 (UI disables ↑/↓)', () => {
  assert.equal(stepMatchIndex(0, 1, 0), 0);
  assert.equal(stepMatchIndex(3, -1, 0), 0);
});

console.log('\nactiveMatchMessageIndex — cursor → message index, clamped');
test('returns the message index of the active match', () => {
  assert.equal(activeMatchMessageIndex([2, 5, 9], 0), 2);
  assert.equal(activeMatchMessageIndex([2, 5, 9], 1), 5);
  assert.equal(activeMatchMessageIndex([2, 5, 9], 2), 9);
});
test('a cursor past the end (stale after results shrank) clamps to the last match', () => {
  // currentMatch=5 but only 3 matches remain → clamp to matches[2] = 9, never undefined.
  assert.equal(activeMatchMessageIndex([2, 5, 9], 5), 9);
});
test('a negative cursor clamps to the first match', () => {
  assert.equal(activeMatchMessageIndex([2, 5, 9], -3), 2);
});
test('no matches returns -1 (UI renders no active ring)', () => {
  assert.equal(activeMatchMessageIndex([], 0), -1);
});

console.log('\ncompose — the match → navigate → resolve round-trip the UI performs');
test('typing a phrase resolves the first match; ↓ walks forward then wraps to the first', () => {
  const messages = [msg('start'), msg('hit'), msg('miss'), msg('hit'), msg('hit')];
  const matches = findTranscriptMatches(messages, 'hit');   // [1, 3, 4]
  let cur = 0;
  assert.equal(activeMatchMessageIndex(matches, cur), 1);    // first match → msg 1
  cur = stepMatchIndex(cur, 1, matches.length);              // ↓
  assert.equal(activeMatchMessageIndex(matches, cur), 3);    // → msg 3
  cur = stepMatchIndex(cur, 1, matches.length);              // ↓
  assert.equal(activeMatchMessageIndex(matches, cur), 4);    // → msg 4
  cur = stepMatchIndex(cur, 1, matches.length);              // ↓ past last → wrap
  assert.equal(activeMatchMessageIndex(matches, cur), 1);    // → back to msg 1
});
test('Shift+↓-equivalent (prev) from the first match wraps to the last', () => {
  const matches = findTranscriptMatches([msg('x'), msg('y x'), msg('x z')], 'x'); // [0,1,2]
  const cur = stepMatchIndex(0, -1, matches.length);         // prev at 0 → wrap
  assert.equal(activeMatchMessageIndex(matches, cur), 2);    // → last match (msg 2)
});

console.log(`\n✓ TRANSCRIPT SEARCH TESTS PASS (${passed})`);
