// Tests for the pure quick-reply helpers in src/lib/quickReply.ts (WARDEN-770).
//
// WARDEN-770 adds an inline quick-reply affordance to the three attention surfaces
// (AttentionBadge popover, return-banner callout, WatchCatchup rows), gated to the two
// states that resolve with a short human input (waiting / blocked). These tests cover
// the extracted PURE seam — which states earn the affordance (canReply), the empty /
// whitespace guard that stops a blank send (sanitizeReplyText), the confirm-gate
// predicate (canSendReply), and the snippet-preview slice (replySnippetPreview) — so the
// load-bearing rules have real coverage WITHOUT a React component harness (this repo has
// none: the test plan in WARDEN-770 honestly scopes component behavior to the smoke
// harness + WARDEN-68 manual QA).
//
// quickReply.ts is `import type`-only at runtime (the Snippet import is erased), so
// Vite's OXC transform emits clean import-free ESM and the same transpile-to-temp-`.mjs`
// + dynamic `import()` harness used by attentionRollup.test.mjs loads the REAL module
// rather than a hand-rolled re-implementation.
//
// Run: node quickReply.test.mjs   (from web/)
import { transformWithOxc } from 'vite';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const helperPath = resolve(__dirname, 'src/lib/quickReply.ts');

// --- Load the REAL quickReply.ts (TS -> ESM via the OXC transform Vite bundles) ----
const src = readFileSync(helperPath, 'utf8');
const { code } = await transformWithOxc(src, helperPath, {});
const tmpDir = mkdtempSync(join(tmpdir(), 'warden-quickreply-test-'));
const tmpFile = join(tmpDir, 'quickReply.mjs');
writeFileSync(tmpFile, code);
const {
  canReply,
  sanitizeReplyText,
  canSendReply,
  replySnippetPreview,
  QUICK_REPLY_SNIPPET_PREVIEW,
} = await import(tmpFile);
rmSync(tmpDir, { recursive: true, force: true });

let passed = 0;
const test = (name, fn) => {
  fn();
  passed += 1;
  console.log('  ok -', name);
};

const snippet = (name, text) => ({ name, text });

console.log('\ncanReply — only waiting + blocked earn the affordance');
test('waiting → true', () => {
  assert.equal(canReply('waiting'), true);
});
test('blocked → true', () => {
  assert.equal(canReply('blocked'), true);
});
test('stuck → false (needs inspection, not a one-liner)', () => {
  assert.equal(canReply('stuck'), false);
});
test('erroring → false', () => {
  assert.equal(canReply('erroring'), false);
});
test('critical → false', () => {
  assert.equal(canReply('critical'), false);
});
test('warning → false', () => {
  assert.equal(canReply('warning'), false);
});
test('custom (watch-pattern match) → false', () => {
  assert.equal(canReply('custom'), false);
});
test('idle → false', () => {
  assert.equal(canReply('idle'), false);
});
test('empty string → false (degrades to open-pane-only)', () => {
  assert.equal(canReply(''), false);
});
test('a future/unknown state → false (never a broken reply control)', () => {
  assert.equal(canReply('hibernating'), false);
});

console.log('\nsanitizeReplyText — trims; empty/whitespace → null (no blank send)');
test('trims surrounding whitespace', () => {
  assert.equal(sanitizeReplyText('  hello  '), 'hello');
});
test('trims a trailing newline from the textarea', () => {
  assert.equal(sanitizeReplyText('run tests\n'), 'run tests');
});
test('keeps internal whitespace + newlines (a real multi-line reply)', () => {
  assert.equal(sanitizeReplyText('line one\nline two'), 'line one\nline two');
});
test('plain non-empty text → trimmed as-is', () => {
  assert.equal(sanitizeReplyText('ok'), 'ok');
});
test('empty string → null', () => {
  assert.equal(sanitizeReplyText(''), null);
});
test('spaces only → null', () => {
  assert.equal(sanitizeReplyText('     '), null);
});
test('tabs/newlines only → null', () => {
  assert.equal(sanitizeReplyText('\n\t  \n'), null);
});
test('null/undefined input → null (defensive against a missing textarea value)', () => {
  assert.equal(sanitizeReplyText(null), null);
  assert.equal(sanitizeReplyText(undefined), null);
});

console.log('\ncanSendReply — the confirm gate (real text AND not sending)');
test('real text, idle → true', () => {
  assert.equal(canSendReply({ text: 'go ahead', sending: false }), true);
});
test('whitespace text, idle → false (blank send blocked)', () => {
  assert.equal(canSendReply({ text: '   ', sending: false }), false);
});
test('empty text, idle → false', () => {
  assert.equal(canSendReply({ text: '', sending: false }), false);
});
test('real text, sending → false (no double-send)', () => {
  assert.equal(canSendReply({ text: 'go ahead', sending: true }), false);
});
test('whitespace text, sending → false', () => {
  assert.equal(canSendReply({ text: '  ', sending: true }), false);
});

console.log('\nreplySnippetPreview — the first N snippets as one-click fills');
test('returns the first QUICK_REPLY_SNIPPET_PREVIEW in library order', () => {
  const all = [snippet('a', '1'), snippet('b', '2'), snippet('c', '3'), snippet('d', '4'), snippet('e', '5'), snippet('f', '6')];
  assert.equal(replySnippetPreview(all).length, QUICK_REPLY_SNIPPET_PREVIEW);
  assert.deepEqual(
    replySnippetPreview(all).map((s) => s.name),
    ['a', 'b', 'c', 'd'],
  );
});
test('fewer than the cap → all shown (no padding)', () => {
  const all = [snippet('only', 'x')];
  assert.deepEqual(replySnippetPreview(all), all);
});
test('empty library → empty list (chip row hides)', () => {
  assert.deepEqual(replySnippetPreview([]), []);
});
test('null/undefined list → empty list (defensive)', () => {
  assert.deepEqual(replySnippetPreview(null), []);
  assert.deepEqual(replySnippetPreview(undefined), []);
});
test('does not mutate the input list', () => {
  const all = [snippet('a', '1'), snippet('b', '2')];
  replySnippetPreview(all);
  assert.equal(all.length, 2);
});

console.log(`\n✓ QUICK-REPLY TESTS PASS (${passed})`);
