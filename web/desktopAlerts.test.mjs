// Tests for desktopAlerts — the pure decision + formatting helpers behind the two
// OS-notification channels that survive: the user-authored WATCH ping (WARDEN-378)
// and the token-spend BUDGET alarm (WARDEN-415).
//
// WARDEN-1274 removed a third, the fleet ATTENTION alert (shouldFireAlert /
// applySeverityPrefs / formatAlertMessage / diffNewAttention / excludeFocusedPane /
// applyFleetAttentionCooldown / formatInAppEntry / fireAttentionNotification), which
// fired off the guessing nine-regex pane classifier. Its coverage is deleted WITH the
// surfaces rather than left asserting against absent exports. Watch + budget coverage
// below is untouched.
//
// No front-end test runner in this repo, so (like attentionRollup.test.mjs) this
// loads the REAL src/lib/desktopAlerts.ts (transpiled TS -> ESM via Vite's OXC
// transform) and exercises the PURE helpers with plain objects. The module has NO
// runtime imports since WARDEN-1274 (its one, finalizeRollup, was used only by the
// retired applySeverityPrefs), so it loads standalone with no alias rewriting.
//
// The browser-touching helpers ARE exercised too, via the minimal `makeNotificationShim`
// harness at the fireWatchNotification block below (added by WARDEN-417 and reused by
// WARDEN-1109 for fireBudgetNotification). Still untested: the permission-prompt helper
// requestAlertPermission. Both fire helpers stay defensive so a construction failure can
// never crash the poll.
//
// This file is auto-discovered by `npm test` (`node --test` runs every *.test.mjs
// in web/), so it runs in CI with no package.json wiring.
//
// Run: node desktopAlerts.test.mjs   (from web/)
import { transformWithOxc } from 'vite';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const helperPath = resolve(__dirname, 'src/lib/desktopAlerts.ts');

// --- Load the REAL desktopAlerts.ts (TS -> ESM via the OXC transform Vite bundles) ----
// WARDEN-1274: the module is import-free again, so it transpiles and loads on its own —
// the attentionRollup.ts co-transpile + alias rewrite this loader used to need went with
// applySeverityPrefs, its only consumer of finalizeRollup. Keep the module import-free:
// a value import here would reintroduce an unresolvable bare specifier and the WHOLE
// suite would die with ERR_MODULE_NOT_FOUND at import, not just one test.
const src = readFileSync(helperPath, 'utf8');
const { code } = await transformWithOxc(src, helperPath, {});
const tmpDir = mkdtempSync(join(tmpdir(), 'warden-desktop-alerts-test-'));
const tmpFile = join(tmpDir, 'desktopAlerts.mjs');
writeFileSync(tmpFile, code);
const { shouldFireWatch, formatWatchMessage, watchReasonTone, formatWatchInApp, fireWatchNotification, fireBudgetNotification, watchStateLabel } = await import(tmpFile);
rmSync(tmpDir, { recursive: true, force: true });

let passed = 0;
const test = (name, fn) => {
  fn();
  passed += 1;
  console.log('  ok -', name);
};

console.log('\nformatWatchMessage (WARDEN-378): targeted body names the agent + quotes the signal');
test('body names the agent and quotes the triggering signal', () => {
  const r = { id: 'w', key: 'w', name: 'warden-worker', state: 'waiting', signal: 'press enter to continue' };
  const { title, body } = formatWatchMessage(r, 'waiting');
  assert.ok(body.includes('warden-worker'), 'body names the agent');
  assert.ok(body.includes("'press enter to continue'"), 'body quotes the signal verbatim');
  assert.ok(body.includes('waiting for your input'), 'body conveys the reason');
  assert.ok(title.startsWith('Warden:'), 'title is branded');
});
test('body conveys the reason even when no signal is present', () => {
  const r = { id: 'w', key: 'w', name: 'warden-worker', state: 'erroring', signal: null };
  const { body } = formatWatchMessage(r, 'erroring');
  assert.ok(body.includes('warden-worker'), 'still names the agent');
  assert.ok(body.includes('erroring'), 'conveys the reason');
  assert.ok(!body.includes("'"), 'no signal quote when signal absent');
});
test('completed reason has a human label in the body', () => {
  const r = { id: 'w', key: 'w', name: 'w', state: 'idle', signal: null };
  const { body } = formatWatchMessage(r, 'completed');
  assert.ok(body.includes('finished a task'), 'completed → "finished a task"');
});
test('falls back to id when name is absent', () => {
  const r = { id: 'container-1', state: 'stuck', signal: 'loop line' };
  const { body } = formatWatchMessage(r, 'stuck');
  assert.ok(body.includes('container-1'), 'falls back to id for the name');
});
test('custom reason (WARDEN-540) names the pattern + quotes the matching line', () => {
  // row.signal is the classifyPane signal; the match lives in row.customMatch. The
  // custom body must surface BOTH the pattern name and the matching line so the
  // human knows which of their rules tripped and what printed.
  const r = { id: 'w', key: 'w', name: 'deploy-agent', state: 'idle', customMatch: { pattern: 'Deploy failed', line: 'DEPLOY FAILED: exit 1' } };
  const { title, body } = formatWatchMessage(r, 'custom');
  assert.ok(title.includes('watch pattern'), 'title carries the generic custom label');
  assert.ok(body.includes('deploy-agent'), 'body names the agent');
  assert.ok(body.includes("'Deploy failed'"), 'body names the pattern');
  assert.ok(body.includes("'DEPLOY FAILED: exit 1'"), 'body quotes the matching line (not the classifyPane signal)');
});

console.log('\nwatchStateLabel (WARDEN-514): row tooltip = reason vocabulary + quoted signal');
test('returns the reason label alone when there is no signal', () => {
  assert.equal(watchStateLabel('waiting'), 'waiting for your input');
});
test('quotes the signal verbatim after the label', () => {
  assert.equal(watchStateLabel('waiting', 'press enter to continue'), "waiting for your input — 'press enter to continue'");
});
test('blocked reason has a human label (persistent current-state parity, WARDEN-514)', () => {
  assert.equal(watchStateLabel('blocked'), 'blocked — waiting on a dependency');
});
test('blocked quotes its signal too', () => {
  assert.equal(watchStateLabel('blocked', 'ticket #12'), "blocked — waiting on a dependency — 'ticket #12'");
});
test('omits the signal quote when the signal is empty/null', () => {
  assert.equal(watchStateLabel('erroring', null), 'erroring');
  assert.equal(watchStateLabel('stuck', ''), 'stuck (repeating output)');
});
test('uses the SAME vocabulary the watch ping body uses (one voice)', () => {
  const r = { id: 'w', key: 'w', name: 'w', state: 'waiting', signal: 'press enter' };
  // formatWatchMessage's body is "<name> · <watchStateLabel>"; the row tooltip is the
  // label tail alone — identical wording, so toast + row indicator speak with one voice.
  const { body } = formatWatchMessage(r, 'waiting');
  assert.ok(body.endsWith(watchStateLabel('waiting', 'press enter')), 'ping body ends with the row tooltip text');
});

// --- WARDEN-530: watchReasonTone + formatWatchInApp (the in-app watch ping's pure pieces) ----
//
// fireWatchInApp (the crafted in-app sonner toast for the at-Warden watch case) lives in
// useAttentionRollup.ts alongside the visibility branch — it imports the runtime 'sonner'
// module, so (like fireAttentionInApp and fireWatchNotification's delivery) it CANNOT load
// standalone under the OXC test transform. Its PURE inputs are testable here: the
// reason→tone mapping (watchReasonTone) and the title+description wording (formatWatchInApp).
//
// The watch fire-loop's visibility branch (visible → fireWatchInApp, no catch-up; hidden →
// fireWatchNotification + catch-up) is inline in the hook for the SAME reason the fleet's
// WARDEN-402 branch is: the branch composes pure building blocks that ARE each verified —
// shouldFireWatch (the focus+away gate, tested below), watchReasonTone + formatWatchInApp
// (here), and watchCatchup.shouldRecordMiss (watchCatchup.test.mjs). The inline control
// flow itself mirrors WARDEN-402's `document.visibilityState === 'visible'` branch exactly.
console.log('\nwatchReasonTone (WARDEN-530): reason → themed tone, incl. completed → success');
test('erroring → critical (broken agent — red)', () => {
  assert.equal(watchReasonTone('erroring'), 'critical');
});
test('stuck → critical (broken agent — red)', () => {
  assert.equal(watchReasonTone('stuck'), 'critical');
});
test('waiting → warning (needs your input — amber)', () => {
  assert.equal(watchReasonTone('waiting'), 'warning');
});
test('completed → success (positive — green, NOT forced into red/amber)', () => {
  assert.equal(watchReasonTone('completed'), 'success');
});
test('blocked → warning (mild state, shares amber with waiting — WARDEN-514 integration)', () => {
  // blocked is never a transition ping (diffWatchAlerts doesn't fire on it), so the
  // fire-loop never reaches watchReasonTone with blocked — but the pure fn is TOTAL over
  // WatchReason, and blocked ("waiting on a dependency") is mild, so it shares warning
  // with waiting, matching the row indicator's amber treatment of the pair.
  assert.equal(watchReasonTone('blocked'), 'warning');
});
test('every WatchReason resolves to a defined tone (no reason falls through)', () => {
  for (const reason of ['waiting', 'erroring', 'stuck', 'completed', 'blocked']) {
    assert.ok(['critical', 'warning', 'success'].includes(watchReasonTone(reason)), `${reason} maps to a tone`);
  }
});

console.log('\nformatWatchInApp (WARDEN-530): crafted title (agent name) + reason/signal description');
test('names the agent as the title and carries the reason as the description', () => {
  const r = { id: 'w', key: 'w', name: 'warden-worker', state: 'waiting', signal: null };
  const { title, description } = formatWatchInApp(r, 'waiting');
  assert.equal(title, 'warden-worker', 'title is the agent name (which chat)');
  assert.ok(description.includes('waiting for your input'), 'description conveys the reason (why)');
});
test('quotes the triggering signal verbatim in the description', () => {
  const r = { id: 'w', key: 'w', name: 'warden-worker', state: 'waiting', signal: 'press enter to continue' };
  const { description } = formatWatchInApp(r, 'waiting');
  assert.ok(description.includes("'press enter to continue'"), 'description quotes the signal');
  assert.ok(description.includes('waiting for your input'), 'still conveys the reason alongside the signal');
});
test('completed uses its positive label in the description', () => {
  const r = { id: 'w', key: 'w', name: 'w', state: 'idle', signal: null };
  const { description } = formatWatchInApp(r, 'completed');
  assert.ok(description.includes('finished a task'), 'completed → "finished a task"');
});
test('falls back to key for the title when name is absent', () => {
  const r = { id: 'container-1', key: 'k1', state: 'stuck', signal: 'loop line' };
  const { title } = formatWatchInApp(r, 'stuck');
  assert.equal(title, 'k1', 'falls back to key for the name');
});
test('a description with no signal is just the reason label (no dangling quote)', () => {
  const r = { id: 'e', key: 'e', name: 'e', state: 'erroring', signal: null };
  const { description } = formatWatchInApp(r, 'erroring');
  assert.equal(description, 'erroring');
  assert.ok(!description.includes("'"), 'no signal quote when signal absent');
});

// --- WARDEN-417: fireWatchNotification return contract (delivered vs lost) --------
//
// fireWatchNotification now returns whether the OS channel DELIVERED the ping: `false`
// on each silent no-op (Notifications unsupported / permission denied / restrictive
// webview rejecting `new Notification`), `true` only when a Notification was actually
// constructed. The catch-up records only when this returns false (or the human is away
// — see watchCatchup.shouldRecordMiss), so this contract is the recoverable-vs-delivered
// signal that keeps the catch-up a recovery net, not a second OS channel.
//
// The function touches the Notification + window globals, so (unlike the pure helpers
// above) we drive it with a minimal Notification shim. The three no-op cases are exactly
// the silent-failure modes the ticket enumerates (unsupported / denied / cleared); the
// success case asserts a real construct + the onclick deep-link. globals restored after.
const savedWindow = globalThis.window;
const savedNotification = globalThis.Notification;
let lastNotification = null;
const makeNotificationShim = (opts = {}) => {
  // A constructor that RETURNS its instance object (so `new` yields it) — avoids `this`
  // entirely, which keeps oxlint's no-this-in-sfc quiet while still satisfying the
  // `new Notification(title, options)` + `n.onclick = ...` shape fireWatchNotification uses.
  function NotificationCtor(title, options) {
    if (opts.throws) throw new Error('construction rejected');
    const instance = { title, options, onclick: null, close: () => {} };
    lastNotification = instance;
    return instance;
  }
  NotificationCtor.permission = opts.permission ?? 'granted';
  NotificationCtor.requestPermission = async () => NotificationCtor.permission;
  return NotificationCtor;
};
const restoreGlobals = () => {
  globalThis.window = savedWindow;
  globalThis.Notification = savedNotification;
  lastNotification = null;
};

console.log('\nfireWatchNotification (WARDEN-417): returns delivered=true only on a real construct');
test('returns true (delivered) when permission granted + construction succeeds', () => {
  globalThis.window = { focus() {} };
  globalThis.Notification = makeNotificationShim({ permission: 'granted' });
  lastNotification = null;
  const delivered = fireWatchNotification({ id: 'w', key: 'w', name: 'w', state: 'waiting', signal: null }, 'waiting');
  assert.equal(delivered, true);
  assert.ok(lastNotification, 'a Notification was constructed');
  restoreGlobals();
});
test('returns false (lost) when permission is denied — no construction', () => {
  globalThis.window = { focus() {} };
  globalThis.Notification = makeNotificationShim({ permission: 'denied' });
  lastNotification = null;
  const delivered = fireWatchNotification({ id: 'w', key: 'w', name: 'w', state: 'waiting' }, 'waiting');
  assert.equal(delivered, false);
  assert.equal(lastNotification, null, 'no Notification constructed when denied');
  restoreGlobals();
});
test('returns false (lost) when a restrictive webview rejects new Notification (catch)', () => {
  globalThis.window = { focus() {} };
  globalThis.Notification = makeNotificationShim({ permission: 'granted', throws: true });
  lastNotification = null;
  const delivered = fireWatchNotification({ id: 'w', key: 'w', name: 'w', state: 'waiting' }, 'waiting');
  assert.equal(delivered, false);
  restoreGlobals();
});
test('returns false (lost) when the Notifications API is unsupported (no Notification global)', () => {
  globalThis.window = { focus() {} };
  delete globalThis.Notification;
  const delivered = fireWatchNotification({ id: 'w', key: 'w', name: 'w', state: 'waiting' }, 'waiting');
  assert.equal(delivered, false);
  restoreGlobals();
});
test('onclick deep-links to the watched chat via onOpenChat + focuses the window', () => {
  globalThis.window = { focus() {} };
  globalThis.Notification = makeNotificationShim({ permission: 'granted' });
  let opened = null;
  let focused = 0;
  globalThis.window.focus = () => { focused += 1; };
  fireWatchNotification({ id: 'w', key: 'watched-key', name: 'w', state: 'waiting' }, 'waiting', (id) => { opened = id; });
  assert.ok(lastNotification?.onclick, 'onclick handler was wired on construction');
  lastNotification.onclick();
  assert.equal(opened, 'watched-key', 'onclick deep-links to the watched chat key');
  assert.equal(focused, 1, 'onclick focuses the Warden window');
  restoreGlobals();
});
test('a distinct tag per chat key so two watched chats never replace each other', () => {
  globalThis.window = { focus() {} };
  globalThis.Notification = makeNotificationShim({ permission: 'granted' });
  fireWatchNotification({ id: 'a', key: 'a', name: 'a', state: 'waiting' }, 'waiting');
  const tagA = lastNotification.options.tag;
  fireWatchNotification({ id: 'b', key: 'b', name: 'b', state: 'waiting' }, 'waiting');
  const tagB = lastNotification.options.tag;
  assert.notEqual(tagA, tagB, 'distinct tags per chat');
  assert.equal(tagA, 'warden-watch:a');
  assert.equal(tagB, 'warden-watch:b');
  restoreGlobals();
});
// The lost→record linkage itself (shouldRecordMiss(delivered, visibility)) is exercised
// directly in watchCatchup.test.mjs — fed by exactly this true/false return value.

console.log('\nshouldFireWatch (WARDEN-426): when PRESENT (visible), suppress ONLY for the focused pane');
test('present + focused === pane key (matched by key) → suppress (false)', () => {
  const row = { id: 'i', key: 'k', state: 'waiting', signal: 'press enter' };
  assert.equal(shouldFireWatch('k', row, 'visible'), false);
});
test('present + focused !== pane key → fire (true)', () => {
  const row = { id: 'i', key: 'k', state: 'waiting', signal: 'press enter' };
  assert.equal(shouldFireWatch('other-pane', row, 'visible'), true);
});
test('present + focused null → fire (true)', () => {
  const row = { id: 'i', key: 'k', state: 'waiting' };
  assert.equal(shouldFireWatch(null, row, 'visible'), true);
});
test('present + focused undefined (no focus context threaded) → fire (true)', () => {
  const row = { id: 'i', key: 'k', state: 'waiting' };
  assert.equal(shouldFireWatch(undefined, row, 'visible'), true);
});
test('present: a row with ONLY id (no key) is matched against focusedPaneKey by id', () => {
  const row = { id: 'container-1', state: 'stuck', signal: 'loop line' };
  assert.equal(shouldFireWatch('container-1', row, 'visible'), false); // focused on it → suppress
  assert.equal(shouldFireWatch('container-2', row, 'visible'), true);  // focused elsewhere → fire
});
test('present + empty-string focused key fires (treated as no real focus)', () => {
  // A nullish check (== null) intentionally lets '' fall through to the comparison;
  // '' never equals a real pane key (which is non-empty), so this still fires —
  // matching the "focused elsewhere" contract without special-casing ''.
  const row = { id: 'i', key: 'k', state: 'waiting' };
  assert.equal(shouldFireWatch('', row, 'visible'), true);
});

console.log('\nshouldFireWatch (WARDEN-426): when AWAY (hidden), ALWAYS fire — even if focused on that pane');
// THIS is the regression guard for the sticky-focus false-negative: a human who
// focused a watched pane and then stepped away still has focused===paneKey while
// Warden is hidden, and the watch poll keeps ticking. The ping must still reach
// them — that is the watch feature's whole purpose, and the in-app badge is not
// visible to carry the signal while away. Feeding 'hidden' goes RED on a
// shouldFireWatch that keys only on focus (it would return false) and GREEN here.
test('away + focused === pane key → fire (true) [the sticky-focus regression guard]', () => {
  const row = { id: 'i', key: 'k', state: 'waiting', signal: 'press enter' };
  assert.equal(shouldFireWatch('k', row, 'hidden'), true);
});
test('away + focused !== pane key → fire (true)', () => {
  const row = { id: 'i', key: 'k', state: 'waiting' };
  assert.equal(shouldFireWatch('other-pane', row, 'hidden'), true);
});
test('away + focused null → fire (true)', () => {
  const row = { id: 'i', key: 'k', state: 'waiting' };
  assert.equal(shouldFireWatch(null, row, 'hidden'), true);
});
test('away: a row with ONLY id focused on it still fires (id match does not suppress while away)', () => {
  const row = { id: 'container-1', state: 'stuck', signal: 'loop line' };
  assert.equal(shouldFireWatch('container-1', row, 'hidden'), true);
});

console.log('\nshouldFireWatch: the gate is reason-agnostic — every WatchReason suppresses equally (when present)');
test('present: suppresses uniformly across waiting/erroring/stuck/completed when focused on that pane', () => {
  const focus = 'k';
  for (const state of ['waiting', 'erroring', 'stuck', 'completed']) {
    const row = { id: 'i', key: 'k', state };
    assert.equal(shouldFireWatch(focus, row, 'visible'), false, `${state} suppresses when present + focused`);
  }
});
test('present: fires uniformly across waiting/erroring/stuck/completed when focused elsewhere', () => {
  const focus = 'other-pane';
  for (const state of ['waiting', 'erroring', 'stuck', 'completed']) {
    const row = { id: 'i', key: 'k', state };
    assert.equal(shouldFireWatch(focus, row, 'visible'), true, `${state} fires when present + focused elsewhere`);
  }
});
test('away: fires uniformly across waiting/erroring/stuck/completed even when focused on that pane', () => {
  const focus = 'k';
  for (const state of ['waiting', 'erroring', 'stuck', 'completed']) {
    const row = { id: 'i', key: 'k', state };
    assert.equal(shouldFireWatch(focus, row, 'hidden'), true, `${state} fires when away + focused on it`);
  }
});

// --- WARDEN-1109: fireBudgetNotification (the token-spend budget alarm, WARDEN-415) ----
//
// The "while the founder is away" alarm. Sibling of fireWatchNotification: same
// Web Notifications channel, same notificationsSupported /
// permission guards, same never-throw discipline. It takes PRE-FORMATTED title + body
// (tokenBudget.ts's formatBudgetMessageWith computes them) so desktopAlerts.ts does not
// import tokenBudget.ts — keeping this loader's transpile set to the one sibling above.
//
// Its sole caller is useTokenBudget.ts:110, which has runtime react + sonner imports and
// therefore cannot load in this OXC harness at all — so there is no indirect path to this
// function. It is driven directly, through the same makeNotificationShim built above.
//
// fireBudgetNotification returns void (unlike fireWatchNotification's delivered boolean),
// so "did it fire?" is asserted via `lastNotification` — null means nothing was constructed.

console.log('\nfireBudgetNotification: the three silent no-op guards (nothing must be constructed)');
test('no-op when the Notifications API is unsupported (no Notification global)', () => {
  globalThis.window = { focus() {} };
  delete globalThis.Notification;
  lastNotification = null;
  assert.doesNotThrow(() => fireBudgetNotification('Budget', 'over', () => {}));
  assert.equal(lastNotification, null, 'nothing constructed without a Notification global');
  restoreGlobals();
});
test('no-op when there is no window global at all (headless / non-browser host)', () => {
  globalThis.window = undefined;
  globalThis.Notification = makeNotificationShim({ permission: 'granted' });
  lastNotification = null;
  assert.doesNotThrow(() => fireBudgetNotification('Budget', 'over', () => {}));
  assert.equal(lastNotification, null, 'nothing constructed without a window global');
  restoreGlobals();
});
test('no-op when permission is denied — the human said no, so no OS ping', () => {
  globalThis.window = { focus() {} };
  globalThis.Notification = makeNotificationShim({ permission: 'denied' });
  lastNotification = null;
  fireBudgetNotification('Budget', 'over', () => {});
  assert.equal(lastNotification, null, 'no Notification constructed when denied');
  restoreGlobals();
});
test("no-op when permission is still 'default' — the guard is === 'granted', not !== 'denied'", () => {
  globalThis.window = { focus() {} };
  globalThis.Notification = makeNotificationShim({ permission: 'default' });
  lastNotification = null;
  fireBudgetNotification('Budget', 'over', () => {});
  assert.equal(lastNotification, null, "an unanswered OS prompt ('default') must not fire");
  restoreGlobals();
});

console.log('\nfireBudgetNotification: constructs with the pre-formatted title/body verbatim');
test('passes the caller-formatted title + body straight through to the Notification', () => {
  globalThis.window = { focus() {} };
  globalThis.Notification = makeNotificationShim({ permission: 'granted' });
  lastNotification = null;
  fireBudgetNotification('Token budget exceeded', 'worker-1 used 1.2M of 1M tokens');
  assert.ok(lastNotification, 'a Notification was constructed');
  assert.equal(lastNotification.title, 'Token budget exceeded');
  assert.equal(lastNotification.options.body, 'worker-1 used 1.2M of 1M tokens');
  restoreGlobals();
});

console.log("\nfireBudgetNotification: the 'warden-budget' tag — distinct from the watch tag, stable across repeats");
test("tags the budget ping 'warden-budget'", () => {
  globalThis.window = { focus() {} };
  globalThis.Notification = makeNotificationShim({ permission: 'granted' });
  fireBudgetNotification('Budget', 'over');
  assert.equal(lastNotification.options.tag, 'warden-budget');
  restoreGlobals();
});
test('the budget tag is stable across repeats, so a re-crossing REPLACES its prior ping (no stacking)', () => {
  globalThis.window = { focus() {} };
  globalThis.Notification = makeNotificationShim({ permission: 'granted' });
  fireBudgetNotification('Budget', 'first crossing');
  const first = lastNotification.options.tag;
  fireBudgetNotification('Budget', 'same breach, still over');
  const second = lastNotification.options.tag;
  assert.equal(first, second, 'same tag on a repeat crossing => the OS replaces, not stacks');
  restoreGlobals();
});
// The collision guard. desktopAlerts.ts states the budget tag is deliberately DISTINCT
// so the budget alarm "never replaces — and is never replaced by — a watch ping". A
// drift that made the two literals equal would silently overwrite one alarm with
// another: no error, no visible symptom. So this reads BOTH tags from the REAL
// functions (not from hardcoded strings, which could not detect the drift at all) and
// asserts distinctness. WARDEN-1274: this guarded THREE tags; the attention channel and
// its 'warden-attention' tag are retired, so two channels remain to keep apart.
test('the budget tag never collides with the watch tag (real tags, read from both fns)', () => {
  globalThis.window = { focus() {} };
  globalThis.Notification = makeNotificationShim({ permission: 'granted' });

  fireBudgetNotification('Budget', 'over');
  const budgetTag = lastNotification.options.tag;

  fireWatchNotification({ id: 'w', key: 'w', name: 'w', state: 'waiting', signal: null }, 'waiting');
  const watchTag = lastNotification.options.tag;

  assert.notEqual(budgetTag, watchTag, 'budget must not share the watch tag');
  assert.equal(new Set([budgetTag, watchTag]).size, 2, 'both channels distinct');
  restoreGlobals();
});

console.log('\nfireBudgetNotification: the onclick deep-link into the All Sessions usage view');
test('onclick calls onOpenSessions, then focuses the window, then closes the ping — in that order', () => {
  globalThis.window = { focus() {} };
  globalThis.Notification = makeNotificationShim({ permission: 'granted' });
  const seq = [];
  globalThis.window.focus = () => { seq.push('focus'); };
  fireBudgetNotification('Budget', 'over', () => { seq.push('open'); });
  assert.ok(lastNotification?.onclick, 'onclick handler was wired on construction');
  lastNotification.close = () => { seq.push('close'); };
  lastNotification.onclick();
  assert.deepEqual(seq, ['open', 'focus', 'close'], 'deep-link, then raise the window, then dismiss');
  restoreGlobals();
});
test('onclick does not throw when onOpenSessions is omitted (the param is optional)', () => {
  globalThis.window = { focus() {} };
  globalThis.Notification = makeNotificationShim({ permission: 'granted' });
  let focused = 0;
  let closed = 0;
  globalThis.window.focus = () => { focused += 1; };
  fireBudgetNotification('Budget', 'over');
  lastNotification.close = () => { closed += 1; };
  assert.doesNotThrow(() => lastNotification.onclick(), 'clicking a handler-less budget ping is safe');
  assert.equal(focused, 1, 'still raises the window');
  assert.equal(closed, 1, 'still dismisses the ping');
  restoreGlobals();
});

console.log('\nfireBudgetNotification: a rejected construction must never crash the budget poll');
test('swallows a restrictive webview rejecting new Notification (the catch at :815)', () => {
  globalThis.window = { focus() {} };
  globalThis.Notification = makeNotificationShim({ permission: 'granted', throws: true });
  lastNotification = null;
  assert.doesNotThrow(() => fireBudgetNotification('Budget', 'over', () => {}));
  assert.equal(lastNotification, null, 'nothing was constructed');
  restoreGlobals();
});
test('a throwing onOpenSessions is the CALLER contract, not swallowed by the try/catch', () => {
  // The try/catch wraps CONSTRUCTION only — onclick runs later, outside it. Pinning this
  // stops a future refactor from quietly widening the swallow to cover the click handler,
  // which would hide a broken deep-link instead of surfacing it in the console.
  globalThis.window = { focus() {} };
  globalThis.Notification = makeNotificationShim({ permission: 'granted' });
  fireBudgetNotification('Budget', 'over', () => { throw new Error('nav blew up'); });
  assert.throws(() => lastNotification.onclick(), /nav blew up/);
  restoreGlobals();
});

console.log(`\n✓ DESKTOP ALERTS TESTS PASS (${passed})`);
