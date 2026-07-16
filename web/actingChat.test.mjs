// Acting-pane resolution tests (WARDEN-563).
//
// There is no front-end test runner in this repo, so (like paneGrid.test.mjs,
// layout.test.mjs, and storage.test.mjs) this loads the REAL src/lib/actingChat.ts
// (transpiled TS -> ESM via Vite's OXC transform) and drives the contract.
//
// WHY THIS FILE EXISTS: the workspace content-search (🔍) and open-file-from-
// directory (📄) affordances used to live on the grid toolbar and operated on the
// FOCUSED pane. WARDEN-563 relocates them onto each pane's own context menu, so
// right-clicking a NON-focused pane must search/open in THAT pane's repo. The
// dialogs resolve the pane to act on via resolveActingChat(actingPaneId, ...).
//
// The hazard this guards (the WARDEN-115 "reaches the observer" trap): if the
// dialogs still resolved focusedChat, right-clicking an unfocused pane would be a
// silent no-op — the slice would reproduce the focused-pane bug it claims to fix.
// These tests lock in that the right-clicked pane wins, and document the fallback
// policy (focused pane when nothing is seeded; focused pane when the seeded pane's
// chat has vanished, so an open dialog stays mounted rather than blanking).
//
// Run: node actingChat.test.mjs   (from web/)
import { transformWithOxc } from 'vite';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const actingChatPath = resolve(__dirname, 'src/lib/actingChat.ts');

// --- Load the REAL actingChat.ts (TS -> ESM via the OXC transform Vite bundles) --
const src = readFileSync(actingChatPath, 'utf8');
const { code } = await transformWithOxc(src, actingChatPath, {});
const tmpDir = mkdtempSync(join(tmpdir(), 'warden-actingChat-test-'));
const tmpFile = join(tmpDir, 'actingChat.mjs');
writeFileSync(tmpFile, code);
const { resolveActingChat } = await import(tmpFile);
rmSync(tmpDir, { recursive: true, force: true });

let passed = 0;
const test = (name, fn) => {
  fn();
  passed += 1;
  console.log('  ok -', name);
};

// Chats carry both an `id` and (for yatfa/manual) a `key`; panes are addressed by
// (key || id) — the same expression PaneGrid uses everywhere it binds a tile id.
const chat = (id, opts = {}) => ({ id, key: opts.key, cwd: opts.cwd ?? `/repo-${id}` });

console.log('\nacting pane wins: the right-clicked pane is resolved, not the focused one (WARDEN-563)');

test('a seeded acting pane resolves to THAT pane, not the focused pane', () => {
  // Two panes; B is focused, but the user right-clicked A's context menu.
  const a = chat('A');
  const focusedB = chat('B');
  const acting = resolveActingChat('A', focusedB, [a, focusedB]);
  assert.equal(acting, a, 'acting chat is A (the right-clicked pane), not B (focused)');
  assert.equal(acting?.cwd, '/repo-A', "search/file scope to A's repo");
});

test('the OLD focused-pane behavior is gone when an acting pane is seeded', () => {
  // This is the regression the ticket exists to fix: pre-fix the dialogs mounted
  // against focusedChat, so right-clicking an unfocused pane silently queried the
  // focused pane's repo. With actingPaneId set, focusedChat must NOT win.
  const a = chat('A');
  const focusedB = chat('B');
  const acting = resolveActingChat('A', focusedB, [a, focusedB]);
  assert.notEqual(acting, focusedB, 'focused pane B is NOT the acting chat when A was right-clicked');
});

test('a pane addressed by `key` resolves (panes bind tile id as key || id)', () => {
  // yatfa/manual chats carry a `key` (container/session); pane ids are key || id.
  const a = chat('id-A', { key: 'container-A', cwd: '/srv/app' });
  const focusedB = chat('B');
  const acting = resolveActingChat('container-A', focusedB, [a, focusedB]);
  assert.equal(acting, a, 'pane addressed by its key resolves to that chat');
  assert.equal(acting?.cwd, '/srv/app');
});

console.log('\nfallback policy: no acting pane (or a vanished one) falls back to focused');

test('no seeded acting pane falls back to the focused pane (today’s behavior)', () => {
  // Before any right-click seeds an id, nothing changes vs the focused pane.
  const focusedB = chat('B');
  const acting = resolveActingChat(null, focusedB, [chat('A'), focusedB]);
  assert.equal(acting, focusedB, 'null acting id resolves to the focused pane');
});

test('no seeded acting pane AND no focused pane resolves to null', () => {
  const acting = resolveActingChat(null, null, [chat('A')]);
  assert.equal(acting, null, 'null acting id + null focused → null (dialog stays unmounted)');
});

test('a seeded acting pane whose chat has vanished falls back to the focused pane', () => {
  // The right-clicked pane was closed/killed mid-flow (its chat is gone from the
  // list). Rather than blanking an open dialog, we fall back to the focused pane
  // — graceful degradation, never a null mid-use when a focused pane exists.
  const focusedB = chat('B');
  const acting = resolveActingChat('ghost', focusedB, [focusedB]); // 'ghost' not in list
  assert.equal(acting, focusedB, 'vanished acting pane falls back to the focused pane');
});

test('a seeded acting pane whose chat has vanished AND no focused pane resolves to null', () => {
  const acting = resolveActingChat('ghost', null, [chat('A')]); // 'ghost' not in list
  assert.equal(acting, null, 'vanished acting pane + no focused → null');
});

test('the first matching chat wins when two chats share an id (defensive, matches Array.find)', () => {
  // Mirrors PaneGrid's existing chats.find(...) resolution everywhere else.
  const first = chat('A', { cwd: '/first' });
  const dup = chat('A', { cwd: '/second' });
  const acting = resolveActingChat('A', null, [first, dup]);
  assert.equal(acting, first, 'first match wins (consistent with Array.find)');
});

console.log(`\n✓ ACTINGCHAT TESTS PASS (${passed})`);
