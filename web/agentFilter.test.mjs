// Tests for the agent filter/sort cluster (WARDEN-249), extracted from
// ChatSidebar into src/lib/agentFilter.ts so it is unit-testable without a React
// runner. The extracted functions are PURE (no React), so (like diff.test.mjs
// and gitStateSummary.test.mjs) this loads the REAL src/lib/agentFilter.ts
// (transpiled TS -> ESM via Vite's OXC transform) and exercises it directly with
// plain objects. Since WARDEN-936 it has one relative sibling import
// (chatType from ./chatDisplay), loaded via the kill.test.mjs two-file pattern
// below rather than duplicated into the module.
//
// Coverage focus: the branching cases that lived untested inside the component —
// matchesAgentFilter's 4 cases (claude matches both claude+resume, manual
// matches both shell+manual), compareChats' status active-first with id
// tiebreak, sortChats' manual no-op (drag order preserved), and findChat's
// key-||-id lookup. (chatType/processCwdLabel/displayName/basename are tested in
// chatDisplay.test.mjs — their canonical and now SOLE home after WARDEN-216 /
// WARDEN-936; chatType is exercised here only indirectly via matchesAgentFilter.)
// WARDEN-372: the 'active'/'hidden' filter cases are abolished (the root list is
// the open panes; hide/unhide is gone), so matchesAgentFilter takes no
// hiddenTabs arg and FILTER_OPTIONS has 4 values.
//
// Run: node agentFilter.test.mjs   (from web/)
import { transformWithOxc } from 'vite';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const libDir = resolve(__dirname, 'src/lib');
const libPath = join(libDir, 'agentFilter.ts');

// --- Load the REAL agentFilter.ts + its chatDisplay.ts dependency (TS -> ESM
// via the OXC transform Vite bundles). agentFilter imports chatType from
// ./chatDisplay (WARDEN-936), and chatDisplay's only import is an erased
// `import type` — so transpile BOTH and rewrite agentFilter's relative
// specifier to the transpiled chatDisplay.mjs in the temp dir, exactly as
// kill.test.mjs does for ./fanout (WARDEN-328).
const tmpDir = mkdtempSync(join(tmpdir(), 'warden-agentfilter-test-'));
const chatDisplaySrc = readFileSync(join(libDir, 'chatDisplay.ts'), 'utf8');
const { code: chatDisplayCode } = await transformWithOxc(chatDisplaySrc, join(libDir, 'chatDisplay.ts'), {});
writeFileSync(join(tmpDir, 'chatDisplay.mjs'), chatDisplayCode);

// Rewrite the ./chatDisplay import on the SOURCE string before transform so the
// relative specifier resolves from the temp dir (transformWithOxc keeps import
// specifiers as-is).
const src = readFileSync(libPath, 'utf8')
  .replace(/from ['"]\.\/chatDisplay['"]/, 'from "./chatDisplay.mjs"');
const { code } = await transformWithOxc(src, libPath, {});
const tmpFile = join(tmpDir, 'agentFilter.mjs');
writeFileSync(tmpFile, code);
const {
  matchesAgentFilter, compareChats, sortChats, findChat, displayNameFor,
  FILTER_OPTIONS, SORT_OPTIONS,
} = await import(tmpFile);
rmSync(tmpDir, { recursive: true, force: true });

let passed = 0;
const test = (name, fn) => {
  fn();
  passed += 1;
  console.log('  ok -', name);
};

// Tiny builders so each case reads as "what kind of chat is this" rather than a
// wall of {id,key,kind,cmd,...} literals.
const chat = (over = {}) => ({ id: 'c1', ...over });

// ---------------------------------------------------------------------------
console.log('\nmatchesAgentFilter — the 4 filter cases');
// ---------------------------------------------------------------------------
const yatfa = chat({ id: 'y1', kind: 'yatfa' });
const claude = chat({ id: 'c1', cmd: 'claude' });
const resumed = chat({ id: 'r1', cmd: 'claude --resume x' });
const shell = chat({ id: 's1', cmd: 'bash' });
const arbitrary = chat({ id: 'n1', cmd: 'node app.js' });

test('"all" passes everything (a yatfa, a shell, an arbitrary bin)', () => {
  assert.equal(matchesAgentFilter(yatfa, 'all'), true);
  assert.equal(matchesAgentFilter(shell, 'all'), true);
  assert.equal(matchesAgentFilter(arbitrary, 'all'), true);
});
test('"yatfa" matches only yatfa kind', () => {
  assert.equal(matchesAgentFilter(yatfa, 'yatfa'), true);
  assert.equal(matchesAgentFilter(claude, 'yatfa'), false);
});
test('"claude" matches BOTH a fresh claude and a --resume session', () => {
  assert.equal(matchesAgentFilter(claude, 'claude'), true);
  assert.equal(matchesAgentFilter(resumed, 'claude'), true);
  assert.equal(matchesAgentFilter(yatfa, 'claude'), false);
  assert.equal(matchesAgentFilter(shell, 'claude'), false);
});
test('"manual" matches shell, but NOT an arbitrary bin or yatfa', () => {
  assert.equal(matchesAgentFilter(shell, 'manual'), true);
  assert.equal(matchesAgentFilter(arbitrary, 'manual'), false);
  assert.equal(matchesAgentFilter(yatfa, 'manual'), false);
  assert.equal(matchesAgentFilter(claude, 'manual'), false);
});

// ---------------------------------------------------------------------------
console.log('\ncompareChats — non-manual comparators');
// ---------------------------------------------------------------------------
test('name sort → localeCompare on name (falls back to id)', () => {
  const a = chat({ id: 'a', name: 'zebra' });
  const b = chat({ id: 'b', name: 'apple' });
  assert.ok(compareChats(a, b, 'name') > 0); // zebra after apple
  assert.ok(compareChats(b, a, 'name') < 0);
});
test('name sort falls back to id when name is absent', () => {
  const a = chat({ id: 'x' }); // no name
  const b = chat({ id: 'a' });
  assert.ok(compareChats(a, b, 'name') > 0); // 'x' after 'a'
});
test('host sort → localeCompare on host (empty host sorts first)', () => {
  const a = chat({ id: 'a', host: 'zeta' });
  const b = chat({ id: 'b', host: 'alpha' });
  assert.ok(compareChats(a, b, 'host') > 0);
  const noHost = chat({ id: 'c' });
  assert.ok(compareChats(noHost, a, 'host') < 0); // '' < 'zeta'
});
test('status sort → active chats sort before inactive', () => {
  const active = chat({ id: 'a', active: true });
  const inactive = chat({ id: 'b', active: false });
  assert.ok(compareChats(active, inactive, 'status') < 0); // active first
  assert.ok(compareChats(inactive, active, 'status') > 0);
});
test('status sort tiebreak → equal activity breaks by id ascending', () => {
  const a = chat({ id: 'bbb', active: true });
  const b = chat({ id: 'aaa', active: true });
  assert.ok(compareChats(a, b, 'status') > 0); // same status → 'bbb' after 'aaa'
  // both inactive also tiebreak by id
  const c = chat({ id: 'bbb', active: false });
  const d = chat({ id: 'aaa', active: false });
  assert.ok(compareChats(c, d, 'status') > 0);
});
test('activity sort → higher lastActivity first (descending)', () => {
  const newer = chat({ id: 'a', lastActivity: 200 });
  const older = chat({ id: 'b', lastActivity: 100 });
  assert.ok(compareChats(newer, older, 'activity') < 0); // 100 - 200 < 0 → newer first
});
test('activity sort treats missing lastActivity as 0', () => {
  const withActivity = chat({ id: 'a', lastActivity: 5 });
  const noActivity = chat({ id: 'b' });
  assert.ok(compareChats(withActivity, noActivity, 'activity') < 0); // 0 - 5 < 0
});
test('manual (and any unknown) sort → comparator is 0 (caller preserves order)', () => {
  const a = chat({ id: 'a', name: 'x' });
  const b = chat({ id: 'b', name: 'y' });
  assert.equal(compareChats(a, b, 'manual'), 0);
  assert.equal(compareChats(b, a, 'manual'), 0);
});

// ---------------------------------------------------------------------------
console.log('\nsortChats — manual is a no-op; others return a sorted copy');
// ---------------------------------------------------------------------------
test('manual sort returns the SAME array reference (drag order preserved)', () => {
  const arr = [chat({ id: 'a' }), chat({ id: 'b' })];
  assert.equal(sortChats(arr, 'manual'), arr); // identity, not a copy
});
test('non-manual sort returns a NEW array (does not mutate the input)', () => {
  const arr = [chat({ id: 'a' }), chat({ id: 'b' })];
  const out = sortChats(arr, 'name');
  assert.notEqual(out, arr); // a copy
  assert.equal(arr.length, 2); // input untouched
});
test('status sort orders the copy active-first, id tiebreak', () => {
  const arr = [
    chat({ id: 'b', active: false }),
    chat({ id: 'a', active: true }),
    chat({ id: 'c', active: true }),
  ];
  const out = sortChats(arr, 'status');
  assert.deepEqual(out.map((c) => c.id), ['a', 'c', 'b']);
});
test('activity sort orders the copy by lastActivity descending', () => {
  const arr = [
    chat({ id: 'old', lastActivity: 1 }),
    chat({ id: 'new', lastActivity: 99 }),
    chat({ id: 'mid', lastActivity: 50 }),
  ];
  const out = sortChats(arr, 'activity');
  assert.deepEqual(out.map((c) => c.id), ['new', 'mid', 'old']);
});

// ---------------------------------------------------------------------------
console.log('\nfindChat — lookup by key || id');
// ---------------------------------------------------------------------------
test('finds a chat by key when key is set', () => {
  const arr = [chat({ id: '1', key: 'hostA:1' }), chat({ id: '2', key: 'hostA:2' })];
  assert.equal(findChat(arr, 'hostA:2')?.id, '2');
});
test('a bare id does NOT match when a key is set (key takes precedence)', () => {
  const arr = [chat({ id: '1', key: 'hostA:1' })];
  assert.equal(findChat(arr, '1'), undefined);
});
test('finds a chat by id when no key is set', () => {
  const arr = [chat({ id: 'abc' })];
  assert.equal(findChat(arr, 'abc')?.id, 'abc');
});
test('returns undefined when no chat matches', () => {
  const arr = [chat({ id: '1' })];
  assert.equal(findChat(arr, 'missing'), undefined);
});

// ---------------------------------------------------------------------------
console.log('\ndisplayNameFor — fleet-action target label, raw-id fallback');
// ---------------------------------------------------------------------------
// The resolver the three ChatSidebar fleet fan-outs pass as `nameOf`
// (WARDEN-1121, collapsing the byte-identical copies at :564/:591/:629). It is
// findChat + displayName composed, so these cases assert the RESOLVED LABEL
// each precedence branch produces — not merely that a string came back.
test('resolves a hit to the yatfa key (displayName precedence)', () => {
  const arr = [chat({ id: '1', key: 'proj-worker', kind: 'yatfa' })];
  assert.equal(displayNameFor(arr, 'proj-worker'), 'proj-worker');
});
test('resolves a hit to the user rename when name differs from key', () => {
  const arr = [chat({ id: '2', key: 'hostA:2', kind: 'tmux', name: 'my agent' })];
  assert.equal(displayNameFor(arr, 'hostA:2'), 'my agent');
});
test('resolves a hit to the process·cwd fallback when unrenamed', () => {
  const arr = [chat({ id: '3', key: 'hostA:3', kind: 'tmux', cmd: 'claude', cwd: '/home/u/myproj' })];
  assert.equal(displayNameFor(arr, 'hostA:3'), 'claude · myproj');
});
test('falls back to the RAW ID for an orphan id (dead/unknown target)', () => {
  const arr = [chat({ id: '1', key: 'hostA:1' })];
  assert.equal(displayNameFor(arr, 'hostA:9'), 'hostA:9');
});
test('falls back to the raw id against an empty chat list', () => {
  assert.equal(displayNameFor([], 'hostA:1'), 'hostA:1');
});
test('a bare id whose chat has a key is an orphan → raw id, not the chat label', () => {
  // findChat matches on key||id, so a bare '1' misses a chat keyed 'hostA:1'.
  // The fan-out toast must then show '1' verbatim rather than that chat's name.
  const arr = [chat({ id: '1', key: 'hostA:1', kind: 'tmux', name: 'my agent' })];
  assert.equal(displayNameFor(arr, '1'), '1');
});
test('never yields undefined or the string "undefined" on a miss', () => {
  // The orphan-id contract the fan-out summarizers rely on
  // (fanout.test.mjs:240-248, broadcast.test.mjs:115-120): a target that cannot
  // be resolved still reads as its own id in the toast.
  const out = displayNameFor([], 'chat-abc123');
  assert.equal(typeof out, 'string');
  assert.notEqual(out, 'undefined');
  assert.equal(out, 'chat-abc123');
});

// ---------------------------------------------------------------------------
console.log('\noption metadata is exported intact');
// ---------------------------------------------------------------------------
test('FILTER_OPTIONS has the 4 values in order', () => {
  assert.deepEqual(FILTER_OPTIONS.map((o) => o.value), ['all', 'yatfa', 'claude', 'manual']);
});
test('SORT_OPTIONS has the 5 values in order', () => {
  assert.deepEqual(SORT_OPTIONS.map((o) => o.value), ['manual', 'name', 'host', 'status', 'activity']);
});

console.log(`\n✓ AGENT FILTER TESTS PASS (${passed})`);
