// Regression test for WARDEN-365: the 0.1.11 attach-lifecycle regression where a
// transient `chats.find()` miss flipped `hostKey` across renders and re-fired the
// pane attach effect, binding a SECOND live PTY to the same xterm (duplicate
// text, flicker/jump, dropped lines).
//
// The browser is unavailable in the worker sandbox (WARDEN-130), and the attach
// effect lives inside the React PaneTile component — so the fix extracted the
// attach-TRIGGER decision into a pure, importable seam (src/lib/paneAttach.ts):
//   - hostKeyOf(chat, host)        — the host-key derivation (send-time only)
//   - attachEffectDeps(inputs)     — the dependency tuple the effect uses
// This test drives the triggering render sequence through that seam and asserts
// a SINGLE attach per pane lifetime. It fails if host/hostKey are ever returned
// from attachEffectDeps (i.e. re-added to the deps) — the regression.
//
// paneAttach.ts carries only an `import type { Chat }`, which Vite's OXC
// transform erases entirely (never reaches the emitted JS), so the same
// transpile-to-temp-`.mjs` + dynamic-`import()` harness used by
// chatDisplay.test.mjs / broadcast.test.mjs loads the REAL module.
//
// Run: node paneAttach.test.mjs   (from web/)
import { transformWithOxc } from 'vite';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const libPath = resolve(__dirname, 'src/lib/paneAttach.ts');

// --- Load the REAL paneAttach.ts (TS -> ESM via the OXC transform Vite bundles)
const src = readFileSync(libPath, 'utf8');
const { code } = await transformWithOxc(src, libPath, {});
const tmpDir = mkdtempSync(join(tmpdir(), 'warden-paneattach-test-'));
const tmpFile = join(tmpDir, 'paneAttach.mjs');
writeFileSync(tmpFile, code);
const { hostKeyOf, attachEffectDeps } = await import(tmpFile);
rmSync(tmpDir, { recursive: true, force: true });

let passed = 0;
const test = (name, fn) => { fn(); passed += 1; console.log('  ok -', name); };

// React re-fires a useEffect iff any value in its deps tuple changed by
// Object.is — model that here to decide whether the attach effect tears down +
// re-binds between two renders.
const depsChanged = (prev, next) =>
  prev.length !== next.length || next.some((v, i) => !Object.is(v, prev[i]));

// Tiny chat builder so each case reads as "what kind of chat is this".
const chat = (over = {}) => ({ id: 'c1', host: '(local)', ...over });

// ---------------------------------------------------------------------------
console.log('\nhostKeyOf — the host-key derivation (send-time value, never a dep)');
// ---------------------------------------------------------------------------
test('chat.host wins (remote pane whose chat is loaded)', () => {
  assert.equal(hostKeyOf(chat({ host: 'myserver' }), undefined), 'myserver');
});
test('falls back to the restore hint when chat is absent (transient miss)', () => {
  assert.equal(hostKeyOf(undefined, 'myserver'), 'myserver');
});
test('falls back to (local) when both chat and hint are absent', () => {
  assert.equal(hostKeyOf(undefined, undefined), '(local)');
});
test('chat.host=(local) resolves to (local)', () => {
  assert.equal(hostKeyOf(chat({ host: '(local)' }), undefined), '(local)');
});
test('a transient miss of a LOCAL pane is a no-op (hostKey stays (local))', () => {
  // Local panes never flip — chat.host === hint === '(local)' — which is why the
  // regression bit REMOTE panes hardest. Assert the local case is stable.
  const present = hostKeyOf(chat({ host: '(local)' }), undefined);
  const missed = hostKeyOf(undefined, undefined);
  assert.equal(present, missed);
});

// ---------------------------------------------------------------------------
console.log('\nattachEffectDeps — only id + retryNonce trigger a re-attach');
// ---------------------------------------------------------------------------
test('returns a 2-tuple of [id, retryNonce]', () => {
  assert.deepEqual([...attachEffectDeps({ id: 'p', retryNonce: 0, host: 'h', hostKey: 'hk' })], ['p', 0]);
});
test('the SAME render context yields deps that do NOT re-attach', () => {
  const a = attachEffectDeps({ id: 'p', retryNonce: 3, host: 'myserver', hostKey: 'myserver' });
  const b = attachEffectDeps({ id: 'p', retryNonce: 3, host: 'myserver', hostKey: 'myserver' });
  assert.equal(depsChanged(a, b), false);
});

// The heart of the fix: host and hostKey are accepted on the input but must NOT
// affect the returned tuple. Asserting varying them leaves the deps identical is
// what fails if anyone re-adds them to the deps (the regression).
test('changing host does NOT change the deps (host is send-time only)', () => {
  const a = attachEffectDeps({ id: 'p', retryNonce: 0, host: undefined, hostKey: '(local)' });
  const b = attachEffectDeps({ id: 'p', retryNonce: 0, host: 'myserver', hostKey: 'myserver' });
  assert.equal(depsChanged(a, b), false);
});
test('a hostKey flip (transient chats.find() miss) does NOT change the deps', () => {
  // This is the exact 0.1.11 trigger: chat.host='myserver' present, then chat
  // absent (hostKey falls through to (local) because paneHost is unset), then
  // present again. The deps must be identical across all three.
  const r1 = attachEffectDeps({ id: 'p', retryNonce: 0, host: undefined, hostKey: hostKeyOf(chat({ host: 'myserver' }), undefined) });
  const r2 = attachEffectDeps({ id: 'p', retryNonce: 0, host: undefined, hostKey: hostKeyOf(undefined, undefined) });
  const r3 = attachEffectDeps({ id: 'p', retryNonce: 0, host: undefined, hostKey: hostKeyOf(chat({ host: 'myserver' }), undefined) });
  assert.equal(depsChanged(r1, r2), false);
  assert.equal(depsChanged(r2, r3), false);
});

// Positive controls — the deps must STILL trigger on the legitimate reasons.
test('a different pane id DOES change the deps (re-attach on identity change)', () => {
  const a = attachEffectDeps({ id: 'p1', retryNonce: 0, host: 'h', hostKey: 'hk' });
  const b = attachEffectDeps({ id: 'p2', retryNonce: 0, host: 'h', hostKey: 'hk' });
  assert.equal(depsChanged(a, b), true);
});
test('a retryNonce bump (Retry / Re-spawn) DOES change the deps', () => {
  const a = attachEffectDeps({ id: 'p', retryNonce: 0, host: 'h', hostKey: 'hk' });
  const b = attachEffectDeps({ id: 'p', retryNonce: 1, host: 'h', hostKey: 'hk' });
  assert.equal(depsChanged(a, b), true);
});

// ---------------------------------------------------------------------------
console.log('\nWARDEN-365 — single attach per pane lifetime (behavioral simulation)');
// ---------------------------------------------------------------------------
// Drive the pane attach lifecycle across a sequence of renders the way React
// would: on mount the effect body sends {attach}; on any later render whose deps
// changed, the prior cleanup sends {detach} then the new body sends {attach}.
// host + hostKey are read at send-time (mirroring the ref reads), so each sent
// attach carries THAT render's values — but they never decide whether a
// re-attach happens (only attachEffectDeps does).
function simulate(renders) {
  const sent = [];
  let prevDeps = null;
  for (const r of renders) {
    const deps = attachEffectDeps({ id: r.id, retryNonce: r.retryNonce, host: r.host, hostKey: hostKeyOf(r.chat, r.host) });
    const reattach = prevDeps === null || depsChanged(prevDeps, deps);
    if (prevDeps !== null && reattach) sent.push({ type: 'detach' });
    if (reattach) sent.push({ type: 'attach', host: r.host, hostKey: hostKeyOf(r.chat, r.host) });
    prevDeps = deps;
  }
  return sent;
}

const counts = (sent) => ({
  attach: sent.filter((m) => m.type === 'attach').length,
  detach: sent.filter((m) => m.type === 'detach').length,
});

test('THE REGRESSION: a transient chats.find() miss does NOT re-attach a live pane', () => {
  // Remote pane (chat.host='myserver'), paneHost unset (the restored-remote /
  // workspace-switch case from the ticket). chat drops for one render then
  // returns. Under the broken 0.1.11 deps [id, host, hostKey, retryNonce],
  // hostKey flipped myserver → (local) → myserver and re-fired attach twice
  // (3 attaches → duplicate text). After the fix: exactly one attach, never
  // torn down.
  const renders = [
    { id: 'pane-1', host: undefined, chat: chat({ host: 'myserver' }), retryNonce: 0 },
    { id: 'pane-1', host: undefined, chat: undefined,                  retryNonce: 0 }, // transient miss
    { id: 'pane-1', host: undefined, chat: chat({ host: 'myserver' }), retryNonce: 0 },
  ];
  const c = counts(simulate(renders));
  assert.equal(c.attach, 1, 'exactly one attach for the pane lifetime');
  assert.equal(c.detach, 0, 'the live stream was never torn down');
});

test('a catalog refresh that briefly empties then repopulates chats stays attached', () => {
  // Multi-render churn (e.g. /api/chats refresh replacing the list) — the pane
  // must attach once and stay attached through every transient miss.
  const renders = [
    { id: 'pane-1', host: 'myserver', chat: chat({ host: 'myserver' }), retryNonce: 0 },
    { id: 'pane-1', host: 'myserver', chat: undefined,                  retryNonce: 0 },
    { id: 'pane-1', host: 'myserver', chat: undefined,                  retryNonce: 0 },
    { id: 'pane-1', host: 'myserver', chat: chat({ host: 'myserver' }), retryNonce: 0 },
  ];
  const c = counts(simulate(renders));
  assert.equal(c.attach, 1);
  assert.equal(c.detach, 0);
});

test('Retry re-attaches exactly once (detach then attach), then stays attached', () => {
  // Positive control: a legitimate re-attach (retryNonce bump) tears down the
  // old stream and binds a new one — once — and a subsequent transient miss
  // does NOT re-attach again. This proves the fix preserves Retry/Re-spawn
  // (WARDEN-231 recovery) while still collapsing the spurious re-fires.
  const renders = [
    { id: 'pane-1', host: 'myserver', chat: chat({ host: 'myserver' }), retryNonce: 0 },
    { id: 'pane-1', host: 'myserver', chat: chat({ host: 'myserver' }), retryNonce: 1 }, // Retry
    { id: 'pane-1', host: 'myserver', chat: undefined,                  retryNonce: 1 }, // miss after retry
    { id: 'pane-1', host: 'myserver', chat: chat({ host: 'myserver' }), retryNonce: 1 },
  ];
  const c = counts(simulate(renders));
  assert.equal(c.attach, 2, 'initial attach + one re-attach on Retry');
  assert.equal(c.detach, 1, 'the pre-Retry stream was torn down exactly once');
});

test('toggling Seamless copy (hostOptions change) does NOT re-attach', () => {
  // seamlessCopy is derived from hostOptions[hostKey] inside the effect and read
  // via a ref — toggling it must apply on the NEXT attach, never re-attach an
  // open pane. attachEffectDeps doesn't even receive seamlessCopy, so a "toggle"
  // is just a same-id/same-nonce render: no re-attach. (Mirrors the WARDEN-261
  // contract that hostOptions stays out of the deps.)
  const renders = [
    { id: 'pane-1', host: 'myserver', chat: chat({ host: 'myserver' }), retryNonce: 0 },
    { id: 'pane-1', host: 'myserver', chat: chat({ host: 'myserver' }), retryNonce: 0 }, // toggle Seamless
    { id: 'pane-1', host: 'myserver', chat: chat({ host: 'myserver' }), retryNonce: 0 },
  ];
  const c = counts(simulate(renders));
  assert.equal(c.attach, 1);
  assert.equal(c.detach, 0);
});

console.log(`\n  ${passed} passed`);
