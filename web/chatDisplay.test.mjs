// Tests for the chat display-label helpers in src/lib/chatDisplay.ts (WARDEN-216).
// These were originally covered by agentFilter.test.mjs while the helpers lived in
// the agentFilter extraction (WARDEN-249); WARDEN-216 moved the DISPLAY helpers
// (basename, chatType, processCwdLabel, displayName, ago, hostTagOf) into their own
// chatDisplay module, so the coverage moved with them to their canonical home.
//
// chatDisplay.ts carries an `import type { Chat }` — that is a TYPE-ONLY import,
// which Vite's OXC transform erases entirely (it never reaches the emitted JS), so
// the same transpile-to-temp-`.mjs` + dynamic-`import()` harness used by
// diff.test.mjs / gitStateSummary.test.mjs / agentFilter.test.mjs works here too.
//
// Coverage focus: chatType's claude-vs-resume + empty-cmd-is-shell (WARDEN-223)
// classification, processCwdLabel's "proc · dir" fallback, displayName's WARDEN-163
// precedence, and basename's path normalization. (ago is time-relative and
// hostTagOf/THIS_MACHINE are trivial presentational tags — left untested here.)
//
// Run: node chatDisplay.test.mjs   (from web/)
import { transformWithOxc } from 'vite';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const libPath = resolve(__dirname, 'src/lib/chatDisplay.ts');

// --- Load the REAL chatDisplay.ts (TS -> ESM via the OXC transform Vite bundles)
const src = readFileSync(libPath, 'utf8');
const { code } = await transformWithOxc(src, libPath, {});
const tmpDir = mkdtempSync(join(tmpdir(), 'warden-chatdisplay-test-'));
const tmpFile = join(tmpDir, 'chatDisplay.mjs');
writeFileSync(tmpFile, code);
const { basename, chatType, processCwdLabel, displayName } = await import(tmpFile);
rmSync(tmpDir, { recursive: true, force: true });

let passed = 0;
const test = (name, fn) => {
  fn();
  passed += 1;
  console.log('  ok -', name);
};

// Tiny builder so each case reads as "what kind of chat is this" rather than a
// wall of {id,key,kind,cmd,...} literals.
const chat = (over = {}) => ({ id: 'c1', ...over });

// ---------------------------------------------------------------------------
console.log('\nchatType — process classification');
// ---------------------------------------------------------------------------
test('undefined chat → ?', () => {
  assert.equal(chatType(undefined), '?');
});
test('yatfa kind → yatfa (regardless of cmd)', () => {
  assert.equal(chatType(chat({ kind: 'yatfa', cmd: 'whatever' })), 'yatfa');
});
test('claude cmd → claude', () => {
  assert.equal(chatType(chat({ cmd: 'claude' })), 'claude');
});
test('claude --resume → resume (the resumed-session variant)', () => {
  assert.equal(chatType(chat({ cmd: 'claude --resume abc-123' })), 'resume');
});
test('claude.exe (Windows binary) → claude', () => {
  assert.equal(chatType(chat({ cmd: 'claude.exe' })), 'claude');
});
test('claude launched via an absolute path still classifies as claude', () => {
  assert.equal(chatType(chat({ cmd: '/usr/local/bin/claude' })), 'claude');
});
test('claude.exe via a Windows path → claude (basename is claude.exe)', () => {
  assert.equal(chatType(chat({ cmd: 'C:\\Users\\me\\claude.exe' })), 'claude');
});
for (const bin of ['bash', 'sh', 'zsh', 'fish', 'pwsh', 'powershell', 'cmd.exe']) {
  test(`shell bin "${bin}" → shell`, () => {
    assert.equal(chatType(chat({ cmd: bin })), 'shell');
  });
}
test('empty cmd → shell (login shell, the WARDEN-223 ＋-split case, NOT manual)', () => {
  assert.equal(chatType(chat({ cmd: '' })), 'shell');
});
test('missing cmd → shell (same as empty)', () => {
  assert.equal(chatType(chat({})), 'shell');
});
test('arbitrary bin (e.g. node) → that bin name', () => {
  assert.equal(chatType(chat({ cmd: 'node server.js' })), 'node');
});
test('arbitrary bin launched via a path → the basename', () => {
  assert.equal(chatType(chat({ cmd: '/usr/bin/python script.py' })), 'python');
});

// ---------------------------------------------------------------------------
console.log('\nprocessCwdLabel — "proc · dir" fallback label');
// ---------------------------------------------------------------------------
test('with a cwd → "proc · basename"', () => {
  assert.equal(processCwdLabel(chat({ cmd: 'claude', cwd: '/home/warden' })), 'claude · warden');
});
test('trailing slash on cwd is stripped before taking the basename', () => {
  assert.equal(processCwdLabel(chat({ cmd: 'bash', cwd: '/foo/bar/' })), 'shell · bar');
});
test('without a cwd → just the process type', () => {
  assert.equal(processCwdLabel(chat({ cmd: 'claude', cwd: '' })), 'claude');
  assert.equal(processCwdLabel(chat({ cmd: 'claude' })), 'claude');
});
test('backslash paths (Windows) resolve to the final segment', () => {
  assert.equal(processCwdLabel(chat({ cmd: 'claude', cwd: 'C:\\dev\\warden' })), 'claude · warden');
});

// ---------------------------------------------------------------------------
console.log('\ndisplayName — WARDEN-163 precedence');
// ---------------------------------------------------------------------------
test('undefined → ?', () => {
  assert.equal(displayName(undefined), '?');
});
test('yatfa → key (the container/project-role name), not the id', () => {
  assert.equal(displayName(chat({ id: 'chat-xyz', key: 'warden-worker', kind: 'yatfa' })), 'warden-worker');
});
test('yatfa without a key falls back to id', () => {
  assert.equal(displayName(chat({ id: 'chat-xyz', kind: 'yatfa' })), 'chat-xyz');
});
test('user rename (name !== key) → the user-chosen name', () => {
  assert.equal(displayName(chat({ id: '1', key: 'chat-abc', name: 'my-agent', cmd: 'claude' })), 'my-agent');
});
test('fresh spawn (name === key) → processCwdLabel, never the raw id', () => {
  // name === key is the tell that no rename / no resumed description happened.
  const c = chat({ id: '1', key: 'chat-abc', name: 'chat-abc', cmd: 'claude', cwd: '/home/warden' });
  assert.equal(displayName(c), 'claude · warden');
});
test('no name at all → processCwdLabel', () => {
  const c = chat({ id: '1', key: 'chat-abc', cmd: 'bash', cwd: '/x/y' });
  assert.equal(displayName(c), 'shell · y');
});
test('a resumed claude carries its description as name (name !== key) → shown', () => {
  const c = chat({ id: '1', key: 'hostA:1', name: 'Fix login bug', cmd: 'claude --resume x' });
  assert.equal(displayName(c), 'Fix login bug');
});

// ---------------------------------------------------------------------------
console.log('\nbasename — path helper (dependency of processCwdLabel)');
// ---------------------------------------------------------------------------
test('takes the final path segment', () => {
  assert.equal(basename('/home/warden'), 'warden');
});
test('strips a trailing slash before splitting', () => {
  assert.equal(basename('/foo/bar/'), 'bar');
});
test('normalizes backslashes (Windows)', () => {
  assert.equal(basename('C:\\dev\\warden'), 'warden');
});
test('empty string → empty string', () => {
  assert.equal(basename(''), '');
});

console.log(`\n✓ CHAT DISPLAY TESTS PASS (${passed})`);
