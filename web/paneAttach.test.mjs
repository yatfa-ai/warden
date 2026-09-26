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
//   - paneIdOf(chat)               — the paneHost write key = the pane-open id
//                                    (the WARDEN-1422 unnamed-shell fix)
//   - bumpReconnectToken / reconnectTokenOf / reconnectBumpPending /
//     resumeShouldReattach          — the per-pane reconnect-token chain (the
//                                    WARDEN-1422 QA round 5 fix): a sidebar
//                                    respawn or a session_dead resume click
//                                    re-attaches an OPEN dead pane, and
//                                    nothing else ever does.
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
const { hostKeyOf, attachEffectDeps, paneIdOf, bumpReconnectToken, reconnectTokenOf, reconnectBumpPending, resumeShouldReattach } = await import(tmpFile);rmSync(tmpDir, { recursive: true, force: true });

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

// ---------------------------------------------------------------------------
console.log('\npaneIdOf — the paneHost write key = the pane-open id (WARDEN-1422 QA round 4)');
// ---------------------------------------------------------------------------
// The server's spawn response carries BOTH ids: `id` is the composite
// "host:session", `key` the bare tmux session. A pane OPENS with
// `chat.key || chat.id`; paneHost must be written under THAT id or
// PaneGrid's `host={paneHost[t.id]}` misses and the attach goes out
// host-less — the server skips its refreshHost seed and the just-spawned
// shell resolves to "no chat matches" (Couldn't attach). These tests model
// the full chain on the REAL spawn-response shape: spawnShell writes
// paneHost[paneIdOf(chat)], openChat opens paneIdOf(chat), PaneGrid reads
// paneHost[paneIdOf(chat)] → the attach message's host field.

test('paneIdOf returns the bare key (the pane id), never the composite id', () => {
  const spawned = { id: '(local):shell-8rhg3b', key: 'shell-8rhg3b', host: '(local)', temporary: true };
  assert.equal(paneIdOf(spawned), 'shell-8rhg3b');
});
test('a key-less chat falls back to id (defensive — server always sets key)', () => {
  assert.equal(paneIdOf({ id: 'c1' }), 'c1');
});
test('THE REGRESSION: the unnamed-shell attach message carries its host', () => {
  // "+ shell" (no name) — the exact QA repro, modeled end to end with the
  // real /api/spawn response shape.
  const spawned = { id: '(local):shell-8rhg3b', key: 'shell-8rhg3b', host: '(local)', temporary: true };
  const paneHost = {};
  // spawnShell (and handlePaneSpawned) write the pane's host hint…
  const paneId = paneIdOf(spawned);
  paneHost[paneId] = spawned.host || '(local)';
  // …openChat opens the pane under the SAME id (this is t.id in PaneGrid)…
  assert.equal(paneId, paneIdOf(spawned));
  // …so PaneGrid's `host={paneHost[t.id]}` resolves and the attach message
  // carries it: `streamApi.send({ type:'attach', id, host: sendHost, … })`.
  const attachHost = paneHost[paneIdOf(spawned)];
  assert.equal(attachHost, '(local)', 'the attach message must carry the host');
  // And the host field is honest: hostKeyOf(chat, hint) agrees with it.
  assert.equal(hostKeyOf(spawned, attachHost), '(local)');
});
test('the old composite-id key is exactly the bug (control, not behavior)', () => {
  // Documents WHY the key matters: writing under chat.id — what the
  // first cut did — leaves the pane's own lookup empty. This is a control
  // pinning the failure shape, so a future regression to chat.id keying
  // makes the assertion above impossible to satisfy silently.
  const spawned = { id: '(local):shell-8rhg3b', key: 'shell-8rhg3b', host: '(local)', temporary: true };
  const stale = {};
  stale[spawned.id] = spawned.host;
  const openedPaneId = paneIdOf(spawned);
  assert.equal(stale[openedPaneId], undefined, 'composite-id keying starves the pane lookup — the bug');
});
test('a named spawn (persistent chat) keys identically', () => {
  const named = { id: '(local):release-train-0-1-75', key: 'release-train-0-1-75', host: '(local)' };
  assert.equal(paneIdOf(named), 'release-train-0-1-75');
});
test('a remote spawn carries ITS host through the chain', () => {
  const remote = { id: 'macmini:shell-9kq2xz', key: 'shell-9kq2xz', host: 'macmini', temporary: true };
  const paneHost = {};
  paneHost[paneIdOf(remote)] = remote.host;
  const attachHost = paneHost[paneIdOf(remote)];
  assert.equal(attachHost, 'macmini');
  assert.equal(hostKeyOf(remote, attachHost), 'macmini');
});

// ---------------------------------------------------------------------------
console.log('\nreconnect tokens — sidebar respawn / resume-click → open-dead-pane re-attach (WARDEN-1422 QA round 5)');
// ---------------------------------------------------------------------------
// The QA round-5 blocker: a saved session that stops while its pane is OPEN
// leaves the pane stuck on the session_dead recovery panel. The sidebar's
// respawn recreated the tmux session and flipped the row to WORKING, but
// nothing signalled the open pane to re-attach — respawnChat only POSTed,
// openChat's already-open branch only focused, and the attach effect's deps
// are [id, retryNonce], so no re-attach ever fired and the pane stayed dead
// until a reload. The fix: App keeps a per-pane reconnect token, bumps it at
// the two moments the pane must re-attach NOW (successful sidebar respawn;
// a resume click that finds the pane in session_dead), and PaneTile folds a
// CHANGE of its token into retryNonce — the external value never widens the
// attachEffectDeps contract.

// Drive BOTH sides of the fix the way React would run them:
//   - the App side: which token value reaches the pane on each render
//     (bumpReconnectToken produces the map, reconnectTokenOf reads it);
//   - the PaneTile side: the fold effect converts a token CHANGE into a
//     retryNonce bump (reconnectBumpPending), and the attach effect
//     (attachEffectDeps) re-fires iff its deps changed. The last-seen-token
//     ref initializes to the MOUNT-time token, exactly as the component does.
function simulateReconnect(events) {
  const sent = [];
  let tokens = {};          // App's reconnectTokens map
  let lastSeenToken = null; // PaneTile's ref (null = not mounted yet)
  let retryNonce = 0;
  let prevDeps = null;
  for (const ev of events) {
    if (ev.bump) tokens = bumpReconnectToken(tokens, ev.bump);
    if (ev.unmount) { prevDeps = null; lastSeenToken = null; retryNonce = 0; sent.push('unmount'); continue; }
    const token = reconnectTokenOf(tokens, 'p1');
    // The fold effect runs on each render AFTER mount.
    if (lastSeenToken !== null && reconnectBumpPending(lastSeenToken, token)) retryNonce += 1;
    lastSeenToken = token;
    const deps = attachEffectDeps({ id: 'p1', retryNonce, host: undefined, hostKey: '(local)' });
    const reattach = prevDeps === null || depsChanged(prevDeps, deps);
    if (prevDeps !== null && reattach) sent.push('detach');
    if (reattach) sent.push('attach');
    prevDeps = deps;
  }
  return sent;
}

test('bumpReconnectToken — per-pane, absent id starts at 1, others untouched, original map unmuted', () => {
  const t0 = { other: 3 };
  const t1 = bumpReconnectToken(t0, 'p1');
  assert.deepEqual(t1, { other: 3, p1: 1 });
  assert.deepEqual(t0, { other: 3 }, 'the input map is never mutated');
  assert.deepEqual(bumpReconnectToken(t1, 'p1'), { other: 3, p1: 2 });
  assert.deepEqual(bumpReconnectToken(t1, 'p2'), { other: 3, p1: 1, p2: 1 }, 'bumping one pane leaves the others');
});
test('reconnectTokenOf — an absent map or id reads as 0, never undefined', () => {
  assert.equal(reconnectTokenOf(undefined, 'p1'), 0);
  assert.equal(reconnectTokenOf({}, 'p1'), 0);
  assert.equal(reconnectTokenOf({ p1: 4 }, 'p1'), 4);
  assert.equal(reconnectTokenOf({ p1: 4 }, 'p2'), 0);
});
test('reconnectBumpPending — a changed token is pending; an unchanged token never is', () => {
  assert.equal(reconnectBumpPending(0, 1), true);
  assert.equal(reconnectBumpPending(3, 4), true);
  assert.equal(reconnectBumpPending(3, 3), false, 'a plain re-render must never re-attach');
});
test('resumeShouldReattach — ONLY session_dead triggers a resume re-attach', () => {
  assert.equal(resumeShouldReattach('session_dead'), true);
  assert.equal(resumeShouldReattach('connected'), false, 'a live pane must not flicker on row click');
  assert.equal(resumeShouldReattach('connecting'), false, 'an attaching pane is already doing the work');
  assert.equal(resumeShouldReattach('host_unreachable'), false, 'its own recovery panel owns that recovery');
  assert.equal(resumeShouldReattach('error'), false, 'its own recovery panel owns that recovery');
  assert.equal(resumeShouldReattach(undefined), false, 'no report yet → change nothing');
});

test('THE QA REPRO: stopped session, open dead pane → sidebar respawn → the pane re-attaches', () => {
  // Render walk of the exact QA repro (4/4 failures before this fix):
  //   1. pane open, session working          → one attach.
  //   2. session stops; sidebar poll flips
  //      the row to STOPPED (renders, but
  //      nothing App-side touches the pane)  → still attached, dead panel showing.
  //   3. row's respawn clicked; POST
  //      /api/respawn succeeds; App bumps
  //      the pane's token                    → fold bumps retryNonce →
  //                                            detach + RE-ATTACH.
  //   4. user clicks the row (resume)        → phase already connected → no bump,
  //                                            focus only, NO re-attach.
  const sent = simulateReconnect([
    {},
    { bump: 'p1' }, // respawnChat's setReconnectTokens
    {},             // the row click — openChat's already-open branch
  ]);
  assert.equal(sent.filter((s) => s === 'attach').length, 2, 'initial attach + exactly one re-attach on respawn');
  assert.equal(sent[sent.length - 1], 'attach', 'the pane ends attached');
});

test('CONTROL: without the token bump (the old code) the pane stays dead', () => {
  // The pre-fix shape: respawn posted, discovery refreshed, but no signal ever
  // reached the pane — the row click only focused. Pins the regression: if the
  // bump disappears from respawnChat, this control and the repro test cannot
  // both pass.
  const sent = simulateReconnect([{}, {}, {}]);
  assert.equal(sent.filter((s) => s === 'attach').length, 1, 'one attach, ever — the pane never re-attaches');
});

test('the resume-click half: openChat bumping a pane still in session_dead re-attaches it', () => {
  // The session came back WITHOUT a sidebar respawn (external recreate) — or
  // the row click lands before the respawn POST resolves. App's openChat sees
  // the pane's reported phase session_dead and bumps; the pane re-attaches.
  const sent = simulateReconnect([{}, { bump: 'p1' }]);
  assert.equal(sent.filter((s) => s === 'attach').length, 2);
  assert.equal(sent.includes('detach'), true, 'the dead stream was torn down before the re-bind');
});

test('a resume click on a LIVE open pane re-attaches nothing', () => {
  // Pane connected, user clicks its row to focus it — the common case. No
  // bump (resumeShouldReattach is false for 'connected'), no re-attach: the
  // live PTY must never flicker.
  const sent = simulateReconnect([{}, {}]);
  assert.deepEqual(sent, ['attach']);
});

test('a pane OPENED after a respawn attaches exactly once (no mount double-attach)', () => {
  // The token was already bumped (or a respawn happened earlier in the
  // session); the pane opens fresh with the post-bump token. Its fold ref
  // initializes to the mount-time value, so the first render attaches once —
  // the mount must not read the pre-existing token as a "change".
  const sent = simulateReconnect([{ bump: 'p1' }]);
  assert.deepEqual(sent, ['attach']);
});

test('an unbumped re-render storm (catalog polls, workspace switches) never re-attaches', () => {
  // The WARDEN-365 discipline holds with the token in the payload: only the
  // TOKEN's value decides. Any number of re-renders between bumps is silent.
  const sent = simulateReconnect([{}, {}, {}, {}, { bump: 'p1' }, {}, {}, {}]);
  assert.equal(sent.filter((s) => s === 'attach').length, 2, 'initial + the one respawn re-attach');
  assert.equal(sent.filter((s) => s === 'detach').length, 1);
});

test('remount after the token settled: fresh pane, fresh fold, single attach per mount', () => {
  // Pane closed while stopped, respawned from the row, pane re-opened. The
  // unmount resets the fold ref; the new mount carries the current token and
  // attaches ONCE — the mount must not read the pre-existing token as a
  // "change" — and a LATER bump while open still re-attaches it.
  const sent = simulateReconnect([
    {},                    // open, attach
    { unmount: true },     // close the dead pane
    { bump: 'p1' },        // respawn (pane not open — the entry waits unused)
    {},                    // re-open: carries token 1 at mount → one attach
    {},                    // the render after the mount — still silent
    { bump: 'p1' },        // a later respawn while open → re-attach
  ]);
  // attach #1 the first open; #2 the re-open mount; #3 the later respawn.
  assert.equal(sent.filter((s) => s === 'attach').length, 3);
  // The exact post-unmount sequence: the re-open's single attach, then the
  // later respawn's detach + re-attach. Nothing between the re-open attach
  // and the respawn — the pre-existing token did not read as a change.
  assert.deepEqual(sent.slice(sent.indexOf('unmount') + 1), ['attach', 'detach', 'attach']);
});

console.log(`\n  ${passed} passed`);
