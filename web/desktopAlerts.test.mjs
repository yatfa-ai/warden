// Tests for desktopAlerts — the pure decision + formatting helpers behind the
// opt-in "desktop alert when agents need attention" feature (WARDEN-259).
//
// No front-end test runner in this repo, so (like attentionRollup.test.mjs) this
// loads the REAL src/lib/desktopAlerts.ts (transpiled TS -> ESM via Vite's OXC
// transform) and exercises the PURE helpers with plain objects. The `import type`
// in that file is erased at transpile time, so the emitted module is import-free
// and loads standalone — the browser-touching helpers (requestAlertPermission /
// fireAttentionNotification) are not exercised here (no Notification API under
// Node); they are kept defensive so a construction failure can never crash the
// poll.
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
const src = readFileSync(helperPath, 'utf8');
const { code } = await transformWithOxc(src, helperPath, {});
const tmpDir = mkdtempSync(join(tmpdir(), 'warden-desktop-alerts-test-'));
const tmpFile = join(tmpDir, 'desktopAlerts.mjs');
writeFileSync(tmpFile, code);
const { shouldFireAlert, shouldFireWatch, formatAlertMessage, applySeverityPrefs, ATTENTION_SEVERITY_DEFAULTS, alertAgentKey, formatWatchMessage, watchReasonTone, formatWatchInApp, diffNewAttention, excludeFocusedPane, applyFleetAttentionCooldown, formatInAppEntry, fireWatchNotification, watchStateLabel } = await import(tmpFile);
rmSync(tmpDir, { recursive: true, force: true });

let passed = 0;
const test = (name, fn) => {
  fn();
  passed += 1;
  console.log('  ok -', name);
};

// Builder: hand-roll an AttentionRollup exactly as buildAttentionRollup would —
// total is always the sum of the eight buckets, so the cases read as "which
// attention" not a wall of literals with hand-maintained totals. The four pane-state
// buckets (WARDEN-344) default to empty arrays like the real rollup guarantees.
const agent = (id) => ({ id, key: id, name: id });
const roll = (b = {}) => {
  const critical = b.critical ?? [];
  const warning = b.warning ?? [];
  const stuck = b.stuck ?? [];
  const erroring = b.erroring ?? [];
  const waiting = b.waiting ?? [];
  const blocked = b.blocked ?? [];
  const custom = b.custom ?? [];
  const directives = b.directives ?? 0;
  const errors = b.errors ?? 0;
  const total = critical.length + warning.length + stuck.length + erroring.length +
    waiting.length + blocked.length + custom.length + directives + errors;
  return { critical, warning, stuck, erroring, waiting, blocked, custom, directives, errors, total };
};

// Severity-prefs builder mirroring ATTENTION_SEVERITY_DEFAULTS (all true) so a
// partial override reads as "which bucket disabled".
const prefs = (p = {}) => ({
  alertCritical: p.alertCritical ?? true,
  alertWarning: p.alertWarning ?? true,
  alertDirective: p.alertDirective ?? true,
  alertError: p.alertError ?? true,
});

// Convenience: route a raw rollup through applySeverityPrefs with the DEFAULTS +
// an optional mute set — exactly what the alert effect does — so the "would this
// fire?" cases read as a one-liner.
const routable = (r, muted = new Set()) => applySeverityPrefs(r, ATTENTION_SEVERITY_DEFAULTS, muted);

console.log('\nshouldFireAlert: fires ONLY on a genuine total increase');
test('increase from 0 → 1 fires', () => {
  assert.equal(shouldFireAlert(roll(), roll({ critical: [agent('c1')] })), true);
});
test('increase from 2 → 3 fires', () => {
  assert.equal(shouldFireAlert(roll({ errors: 2 }), roll({ errors: 3 })), true);
});
test('decrease from 3 → 1 does NOT fire (recovery is not an alert)', () => {
  assert.equal(shouldFireAlert(roll({ errors: 3 }), roll({ errors: 1 })), false);
});
test('no change (2 → 2) does NOT fire (no repeat spam for a persistent condition)', () => {
  assert.equal(shouldFireAlert(roll({ errors: 2 }), roll({ errors: 2 })), false);
});
test('a much larger increase still fires once', () => {
  assert.equal(shouldFireAlert(roll(), roll({ critical: [agent('c1'), agent('c2')], errors: 5 })), true);
});

console.log('\nshouldFireAlert: missing input never fires (defensive — startup / first poll)');
test('null previous (first poll) does NOT fire', () => {
  assert.equal(shouldFireAlert(null, roll({ critical: [agent('c1')] })), false);
});
test('null next does NOT fire', () => {
  assert.equal(shouldFireAlert(roll(), null), false);
});
test('both null does NOT fire', () => {
  assert.equal(shouldFireAlert(null, null), false);
});

console.log('\nshouldFireAlert: only the TOTAL matters — any net bucket increase fires');
test('errors entering the window raise the total → fires', () => {
  assert.equal(shouldFireAlert(roll(), roll({ errors: 2 })), true);
});
test('an agent recovering while an error appears (net unchanged) does NOT fire', () => {
  // prev: 1 critical; next: 0 critical + 1 error → total stays 1
  assert.equal(shouldFireAlert(roll({ critical: [agent('c1')] }), roll({ errors: 1 })), false);
});
test('directives landing raise the total → fires', () => {
  assert.equal(shouldFireAlert(roll(), roll({ directives: 1 })), true);
});

console.log('\napplySeverityPrefs: the positive "finished" (done) bucket passes through unchanged (WARDEN-575)');
test('a rollup with done agents carries them through the routable view', () => {
  const doneRow = { id: 'w1', key: 'w1', name: 'w1', state: 'idle' };
  const r = applySeverityPrefs({ ...roll({ critical: [agent('c1')] }), done: [doneRow] }, ATTENTION_SEVERITY_DEFAULTS);
  assert.equal(r.done.length, 1, 'done agents survive the severity filter');
  assert.equal(r.done[0].key, 'w1');
});
test('done agents do NOT raise the routable total (a finish is not a problem increase)', () => {
  // A finish alone must never trip the increase-only shouldFireAlert gate: the done
  // bucket is excluded from the routable total, identical to the raw rollup.
  const doneRow = { id: 'w1', key: 'w1', name: 'w1', state: 'idle' };
  const prev = applySeverityPrefs({ ...roll(), done: [] }, ATTENTION_SEVERITY_DEFAULTS);
  const next = applySeverityPrefs({ ...roll(), done: [doneRow] }, ATTENTION_SEVERITY_DEFAULTS);
  assert.equal(next.total, 0, 'done does not inflate the routable total');
  assert.equal(shouldFireAlert(prev, next), false, 'a finish never fires the problem alert');
});
test('a rollup without done degrades to an empty done bucket (defensive)', () => {
  const r = applySeverityPrefs(roll({ critical: [agent('c1')] }), ATTENTION_SEVERITY_DEFAULTS);
  assert.deepEqual(r.done, []);
});

console.log('\nformatAlertMessage: title carries the Warden prefix + accurate count');
test('single item title is singular', () => {
  assert.equal(formatAlertMessage(roll({ critical: [agent('c1')] })).title, 'Warden: 1 item needs attention');
});
test('multiple items title is plural', () => {
  assert.equal(formatAlertMessage(roll({ errors: 2 })).title, 'Warden: 2 items need attention');
});
test('title uses "items" (total includes directives/errors, not just agents)', () => {
  assert.equal(formatAlertMessage(roll({ directives: 1 })).title, 'Warden: 1 item needs attention');
});

console.log('\nformatAlertMessage: body enumerates only non-zero buckets, ·-separated');
test('mixed buckets list all four in a fixed order', () => {
  const r = roll({ critical: [agent('c1'), agent('c2')], warning: [agent('w1')], directives: 1, errors: 3 });
  assert.equal(formatAlertMessage(r).body, '2 critical · 1 warning · 1 directive · 3 errors');
});
test('directives + errors pluralize', () => {
  assert.equal(formatAlertMessage(roll({ directives: 2, errors: 3 })).body, '2 directives · 3 errors');
});
test('only errors → just the error bucket', () => {
  assert.equal(formatAlertMessage(roll({ errors: 2 })).body, '2 errors');
});
test('only a warning → singular label', () => {
  assert.equal(formatAlertMessage(roll({ warning: [agent('w1')] })).body, '1 warning');
});

console.log('\nformatAlertMessage: pane-state buckets (WARDEN-344) name stuck/erroring/waiting/blocked');
test('a stuck agent appears in the body as "stuck"', () => {
  assert.equal(formatAlertMessage(roll({ stuck: [agent('s1')] })).body, '1 stuck');
});
test('an erroring agent appears in the body as "erroring"', () => {
  assert.equal(formatAlertMessage(roll({ erroring: [agent('e1')] })).body, '1 erroring');
});
test('a waiting agent appears in the body as "waiting"', () => {
  assert.equal(formatAlertMessage(roll({ waiting: [agent('w1'), agent('w2')] })).body, '2 waiting');
});
test('a blocked agent appears in the body as "blocked"', () => {
  assert.equal(formatAlertMessage(roll({ blocked: [agent('b1')] })).body, '1 blocked');
});
test('a watch-pattern match appears in the body as "watch pattern(s)" (WARDEN-540)', () => {
  // custom counts toward total, so the body must enumerate it (else title/body disagree).
  const customRow = { id: 'd1', key: 'd1', name: 'd1', state: 'idle', customMatch: { pattern: 'X', line: 'l' } };
  assert.equal(formatAlertMessage(roll({ custom: [customRow] })).body, '1 watch pattern');
  assert.equal(formatAlertMessage(roll({ custom: [customRow, { ...customRow, id: 'd2', key: 'd2' }] })).body, '2 watch patterns');
});
test('red pane states sort before amber in the body (critical, stuck, erroring, warning, waiting, blocked)', () => {
  const r = roll({
    critical: [agent('c1')], stuck: [agent('s1')], erroring: [agent('e1')],
    warning: [agent('w1')], waiting: [agent('w1')], blocked: [agent('b1')],
  });
  assert.equal(formatAlertMessage(r).body, '1 critical · 1 stuck · 1 erroring · 1 warning · 1 waiting · 1 blocked');
});

console.log('\nshouldFireAlert: a pane flipping to a stuck/erroring/waiting state raises the total → fires');
test('a pane newly stuck (0 → 1) fires', () => {
  assert.equal(shouldFireAlert(roll(), roll({ stuck: [agent('s1')] })), true);
});
test('a pane newly erroring fires', () => {
  assert.equal(shouldFireAlert(roll(), roll({ erroring: [agent('e1')] })), true);
});
test('a pane newly waiting fires', () => {
  assert.equal(shouldFireAlert(roll(), roll({ waiting: [agent('w1')] })), true);
});
test('a persistent stuck condition (1 → 1) does NOT repeat', () => {
  assert.equal(shouldFireAlert(roll({ stuck: [agent('s1')] }), roll({ stuck: [agent('s1')] })), false);
});
test('a stuck pane recovering (1 → 0) does NOT fire', () => {
  assert.equal(shouldFireAlert(roll({ stuck: [agent('s1')] }), roll()), false);
});

// --- WARDEN-364: applySeverityPrefs (per-severity routing + per-agent mute) ----
console.log('\napplySeverityPrefs: defaults preserve the raw rollup bit-for-bit');
test('defaults leave every bucket + total intact', () => {
  const r = roll({ critical: [agent('c1'), agent('c2')], warning: [agent('w1')], directives: 2, errors: 3 });
  const out = applySeverityPrefs(r, ATTENTION_SEVERITY_DEFAULTS, new Set());
  assert.equal(out.critical.length, 2);
  assert.equal(out.warning.length, 1);
  assert.equal(out.directives, 2);
  assert.equal(out.errors, 3);
  assert.equal(out.total, r.total);
});
test('defaults → shouldFireAlert over routable == over raw (behavior-preserving)', () => {
  const prev = roll({ critical: [agent('c1')] });
  const next = roll({ critical: [agent('c1'), agent('c2')], errors: 1 });
  assert.equal(shouldFireAlert(prev, next), shouldFireAlert(routable(prev), routable(next)));
});
test('defaults → formatAlertMessage over routable == over raw', () => {
  const r = roll({ critical: [agent('c1')], warning: [agent('w1')], directives: 2, errors: 3 });
  assert.deepEqual(formatAlertMessage(applySeverityPrefs(r, ATTENTION_SEVERITY_DEFAULTS, new Set())), formatAlertMessage(r));
});

console.log('\napplySeverityPrefs: WARDEN-344 pane-state buckets pass through (integration with severity routing)');
test('pane-state buckets survive applySeverityPrefs under defaults (lengths intact)', () => {
  const r = roll({ stuck: [agent('s1')], erroring: [agent('e1')], waiting: [agent('w1'), agent('w2')], blocked: [agent('b1')] });
  const out = applySeverityPrefs(r, ATTENTION_SEVERITY_DEFAULTS, new Set());
  assert.equal(out.stuck.length, 1);
  assert.equal(out.erroring.length, 1);
  assert.equal(out.waiting.length, 2);
  assert.equal(out.blocked.length, 1);
  assert.equal(out.total, r.total); // pane states counted in the routable total → still escalate
});
test('a pane newly stuck still FIRES under defaults (WARDEN-344 escalation preserved across the routing layer)', () => {
  const prev = applySeverityPrefs(roll(), ATTENTION_SEVERITY_DEFAULTS, new Set());
  const next = applySeverityPrefs(roll({ stuck: [agent('s1')] }), ATTENTION_SEVERITY_DEFAULTS, new Set());
  assert.equal(shouldFireAlert(prev, next), true);
});
test('pane-state buckets are NOT affected by the four severity toggles (only health/directive/error are)', () => {
  // All severity toggles OFF — yet the stuck pane still contributes to the routable
  // total and would fire. Pane states are silenced via WARDEN-344's `enabledStates`
  // (rollup-build level), not the desktop-only severity toggles here.
  const none = prefs({ alertCritical: false, alertWarning: false, alertDirective: false, alertError: false });
  const out = applySeverityPrefs(roll({ stuck: [agent('s1')], critical: [agent('c1')] }), none, new Set());
  assert.equal(out.stuck.length, 1); // survives
  assert.equal(out.critical.length, 0); // severity toggle zeroed the health bucket
  assert.equal(out.total, 1); // only the stuck pane
});

console.log('\napplySeverityPrefs: disabling a bucket zeros ONLY that bucket');
test('alertCritical off → critical zeroed, rest + total recomputed', () => {
  const out = applySeverityPrefs(roll({ critical: [agent('c1')], warning: [agent('w1')], directives: 1, errors: 1 }), prefs({ alertCritical: false }), new Set());
  assert.equal(out.critical.length, 0);
  assert.equal(out.warning.length, 1);
  assert.equal(out.directives, 1);
  assert.equal(out.errors, 1);
  assert.equal(out.total, 3); // warning(1) + directives(1) + errors(1)
});
test('alertWarning off → warning zeroed', () => {
  const out = applySeverityPrefs(roll({ critical: [agent('c1')], warning: [agent('w1'), agent('w2')] }), prefs({ alertWarning: false }), new Set());
  assert.equal(out.warning.length, 0);
  assert.equal(out.critical.length, 1);
  assert.equal(out.total, 1);
});
test('alertDirective off → directives zeroed', () => {
  const out = applySeverityPrefs(roll({ directives: 5, errors: 2 }), prefs({ alertDirective: false }), new Set());
  assert.equal(out.directives, 0);
  assert.equal(out.errors, 2);
  assert.equal(out.total, 2);
});
test('alertError off → errors zeroed', () => {
  const out = applySeverityPrefs(roll({ errors: 5, directives: 2 }), prefs({ alertError: false }), new Set());
  assert.equal(out.errors, 0);
  assert.equal(out.directives, 2);
  assert.equal(out.total, 2);
});
test('all buckets off → empty routable regardless of input', () => {
  const out = applySeverityPrefs(roll({ critical: [agent('c1')], warning: [agent('w1')], directives: 9, errors: 9 }), prefs({ alertCritical: false, alertWarning: false, alertDirective: false, alertError: false }), new Set());
  assert.equal(out.total, 0);
});

console.log('\napplySeverityPrefs: per-agent mute filters ONLY the health buckets');
test('a muted critical agent is dropped from routable.critical', () => {
  const out = applySeverityPrefs(roll({ critical: [agent('c1'), agent('c2')] }), ATTENTION_SEVERITY_DEFAULTS, new Set(['c1']));
  assert.equal(out.critical.length, 1);
  assert.equal(out.critical[0].id, 'c2');
  assert.equal(out.total, 1);
});
test('a muted warning agent is dropped from routable.warning', () => {
  const out = applySeverityPrefs(roll({ warning: [agent('w1'), agent('w2')] }), ATTENTION_SEVERITY_DEFAULTS, new Set(['w1']));
  assert.equal(out.warning.length, 1);
  assert.equal(out.warning[0].id, 'w2');
});
test('mute keys on agent.key when present (a.key || a.id), not just id', () => {
  const keyed = { id: 'i1', key: 'k1', name: 'n1' };
  const out = applySeverityPrefs(roll({ critical: [keyed, agent('c2')] }), ATTENTION_SEVERITY_DEFAULTS, new Set(['k1']));
  assert.equal(out.critical.length, 1); // 'k1' muted, survives only c2
});
test('mute does NOT touch directives/errors (aggregate, not per-agent)', () => {
  const out = applySeverityPrefs(roll({ directives: 4, errors: 7 }), ATTENTION_SEVERITY_DEFAULTS, new Set(['anything']));
  assert.equal(out.directives, 4);
  assert.equal(out.errors, 7);
  assert.equal(out.total, 11);
});
test('alertAgentKey resolves key || id', () => {
  assert.equal(alertAgentKey({ id: 'i', key: 'k' }), 'k');
  assert.equal(alertAgentKey({ id: 'i' }), 'i');
  assert.equal(alertAgentKey({}), '');
});

console.log('\nrouting end-to-end: an increase in ONLY a disabled/muted bucket stays quiet');
test('critical increase with alertCritical OFF fires nothing (routable total flat at 0)', () => {
  const p = prefs({ alertCritical: false });
  const prev = applySeverityPrefs(roll({ critical: [agent('c1')] }), p, new Set());
  const next = applySeverityPrefs(roll({ critical: [agent('c1'), agent('c2')] }), p, new Set());
  assert.equal(shouldFireAlert(prev, next), false);
});
test('error entering the window with alertError OFF fires nothing', () => {
  const p = prefs({ alertError: false });
  const prev = applySeverityPrefs(roll({ critical: [agent('c1')] }), p, new Set());
  const next = applySeverityPrefs(roll({ critical: [agent('c1')], errors: 3 }), p, new Set());
  assert.equal(shouldFireAlert(prev, next), false); // raw total rose 1→4, routable stayed 1
});
test('the ONLY increase being a muted agent fires nothing', () => {
  const muted = new Set(['b']);
  const prev = applySeverityPrefs(roll({ critical: [agent('a')] }), ATTENTION_SEVERITY_DEFAULTS, muted);
  const next = applySeverityPrefs(roll({ critical: [agent('a'), agent('b')] }), ATTENTION_SEVERITY_DEFAULTS, muted);
  assert.equal(shouldFireAlert(prev, next), false); // a stays, b muted → routable total flat at 1
});
test('a non-muted agent going critical STILL fires alongside a muted one', () => {
  const muted = new Set(['a']);
  const prev = applySeverityPrefs(roll({ critical: [agent('a')] }), ATTENTION_SEVERITY_DEFAULTS, muted); // routable []
  const next = applySeverityPrefs(roll({ critical: [agent('a'), agent('b')] }), ATTENTION_SEVERITY_DEFAULTS, muted); // routable [b]
  assert.equal(shouldFireAlert(prev, next), true); // 0 → 1
});

console.log('\nrouting end-to-end: recovery never fires (decrease or no-change)');
test('recovery (routable decrease) does NOT fire', () => {
  const prev = applySeverityPrefs(roll({ critical: [agent('a'), agent('b')] }), ATTENTION_SEVERITY_DEFAULTS, new Set());
  const next = applySeverityPrefs(roll({ critical: [agent('a')] }), ATTENTION_SEVERITY_DEFAULTS, new Set());
  assert.equal(shouldFireAlert(prev, next), false);
});
test('a muted agent recovering while nothing else changes does NOT fire', () => {
  const muted = new Set(['a']);
  const prev = applySeverityPrefs(roll({ critical: [agent('a'), agent('b')] }), ATTENTION_SEVERITY_DEFAULTS, muted); // routable [b]
  const next = applySeverityPrefs(roll({ critical: [agent('b')] }), ATTENTION_SEVERITY_DEFAULTS, muted); // routable [b]
  assert.equal(shouldFireAlert(prev, next), false); // 1 → 1
});

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

// --- WARDEN-402: diffNewAttention (the in-app ping's "WHICH agent is newly needy") ----
//
// shouldFireAlert decides WHETHER to ping by comparing only totals; diffNewAttention
// decides WHO is newly needy so the at-Warden sonner toast can name the specific
// chat/agent + its concrete reason (the granularity shouldFireAlert can't provide).
// Mirrors the purity discipline above: plain rollup objects, no browser globals. The
// `toast(...)` delivery itself (a browser-global side effect) is left untested, exactly
// as fireAttentionNotification is — only the pure diff + formatter are exercised.
// A pane-state row builder carrying the optional `signal` (AgentStateRow-shape); the
// health buckets use the existing agent() builder (a Chat has no `signal` field).
const pane = (id, signal = null, state = 'stuck') => ({ id, key: id, name: id, state, signal });

console.log('\ndiffNewAttention: a single new pane-state agent surfaces with its reason + signal');
test('a newly-stuck agent surfaces once, keyed by id, with the stuck reason + signal', () => {
  const prev = roll();
  const next = roll({ stuck: [pane('s1', 'loop line', 'stuck')] });
  const out = diffNewAttention(prev, next);
  assert.equal(out.length, 1);
  assert.equal(out[0].key, 's1');
  assert.equal(out[0].name, 's1');
  assert.equal(out[0].tone, 'critical');
  assert.ok(out[0].reason.toLowerCase().includes('stuck'), 'reason conveys stuck');
  assert.equal(out[0].signal, 'loop line');
});
test('a newly-waiting agent surfaces as the amber tone with its signal', () => {
  const next = roll({ waiting: [pane('w1', 'press enter to continue', 'waiting')] });
  const out = diffNewAttention(roll(), next);
  assert.equal(out.length, 1);
  assert.equal(out[0].tone, 'warning');
  assert.equal(out[0].signal, 'press enter to continue');
});

console.log('\ndiffNewAttention: multiple new entrants across buckets, severity-ordered (red before amber)');
test('a critical agent + a waiting agent surface both, red before amber', () => {
  const next = roll({
    critical: [agent('c1')],
    waiting: [pane('w1', null, 'waiting')],
  });
  const out = diffNewAttention(roll(), next);
  assert.equal(out.length, 2);
  assert.equal(out[0].key, 'c1'); // red first
  assert.equal(out[0].tone, 'critical');
  assert.equal(out[1].key, 'w1');
  assert.equal(out[1].tone, 'warning');
});
test('entrants across all six named buckets each surface (no cross-bucket collision)', () => {
  const next = roll({
    critical: [agent('c1')],
    stuck: [pane('s', null, 'stuck')],
    erroring: [pane('e', null, 'erroring')],
    warning: [agent('w1')],
    waiting: [pane('wt', null, 'waiting')],
    blocked: [pane('b', null, 'blocked')],
  });
  const out = diffNewAttention(roll(), next);
  assert.equal(out.length, 6);
});

console.log('\ndiffNewAttention: net-zero churn surfaces the NEW entrant, NOT the recovering one');
test('one agent recovers while another newly errors → only the new one surfaces', () => {
  // prev: 'a' stuck. next: 'a' recovered (gone) + 'b' newly erroring. Total 1 → 1.
  const prev = roll({ stuck: [pane('a', null, 'stuck')] });
  const next = roll({ erroring: [pane('b', null, 'erroring')] });
  const out = diffNewAttention(prev, next);
  assert.equal(out.length, 1);
  assert.equal(out[0].key, 'b'); // the newly-needy one
  assert.ok(!out.find((e) => e.key === 'a'), 'the recovering agent does not surface');
});
test('an agent MOVING bucket (waiting → erroring) is NOT a new entrant (same key)', () => {
  const prev = roll({ waiting: [pane('a', null, 'waiting')] });
  const next = roll({ erroring: [pane('a', null, 'erroring')] });
  assert.equal(diffNewAttention(prev, next).length, 0);
});

console.log('\ndiffNewAttention: a persistent condition does not repeat (increase-only parity)');
test('the same agent stuck across two polls surfaces zero times on the second', () => {
  const prev = roll({ stuck: [pane('a', null, 'stuck')] });
  assert.equal(diffNewAttention(prev, prev).length, 0);
});

console.log('\ndiffNewAttention: health-bucket entrants surface with the label reason and NO signal');
test('a newly-critical health agent surfaces with the critical label and no signal', () => {
  // A Chat carries no `signal` field — the bucket label IS the reason.
  const out = diffNewAttention(roll(), roll({ critical: [agent('c1')] }));
  assert.equal(out.length, 1);
  assert.equal(out[0].key, 'c1');
  assert.equal(out[0].name, 'c1');
  assert.equal(out[0].tone, 'critical');
  assert.ok(out[0].reason.toLowerCase().includes('critical'));
  assert.equal(out[0].signal, undefined); // health rows carry no signal
});
test('a newly-warning health agent surfaces as amber with no signal', () => {
  const out = diffNewAttention(roll(), roll({ warning: [agent('w1')] }));
  assert.equal(out.length, 1);
  assert.equal(out[0].tone, 'warning');
  assert.equal(out[0].signal, undefined);
});

console.log('\ndiffNewAttention: one entry per key (an agent newly in two buckets surfaces once)');
test('an agent newly critical AND erroring surfaces ONCE, red-first (not twice)', () => {
  const next = roll({
    critical: [agent('x')],
    erroring: [pane('x', null, 'erroring')],
  });
  const out = diffNewAttention(roll(), next);
  assert.equal(out.length, 1); // deduped by key
  assert.equal(out[0].key, 'x');
  assert.ok(out[0].reason.toLowerCase().includes('critical'), 'surfaces in the first (critical) bucket');
});

console.log('\ndiffNewAttention: aggregate directives/errors deltas surface as summary entries (no deep-link)');
test('an errors-count increase surfaces a summary entry with no key/name', () => {
  const out = diffNewAttention(roll({ errors: 1 }), roll({ errors: 3 }));
  assert.equal(out.length, 1);
  assert.equal(out[0].key, '');
  assert.equal(out[0].name, '');
  assert.equal(out[0].tone, 'critical');
  assert.match(out[0].reason, /2 recent errors/);
});
test('a directives-count increase surfaces an amber summary entry', () => {
  const out = diffNewAttention(roll(), roll({ directives: 2 }));
  assert.equal(out.length, 1);
  assert.equal(out[0].key, '');
  assert.equal(out[0].tone, 'warning');
  assert.match(out[0].reason, /2 pending directives/);
});
test('a count DECREASE (recovery) does NOT produce a phantom aggregate entry', () => {
  assert.equal(diffNewAttention(roll({ errors: 5 }), roll({ errors: 1 })).length, 0); // delta clamped at 0
});
test('named entrants + an aggregate delta both surface (named first, then aggregate)', () => {
  const out = diffNewAttention(roll(), roll({ stuck: [pane('s', null, 'stuck')], errors: 2 }));
  assert.equal(out.length, 2);
  assert.equal(out[0].key, 's'); // named (red) first
  assert.equal(out[1].key, ''); // aggregate after
});

console.log('\ndiffNewAttention: identity is key || id (parity with the badge / alertAgentKey)');
test('an agent known by key in prev suppresses the same key in a different next bucket', () => {
  const prev = roll({ critical: [{ id: 'i1', key: 'k1', name: 'n1' }] });
  const next = roll({ erroring: [{ id: 'i1', key: 'k1', name: 'n1', state: 'erroring' }] });
  assert.equal(diffNewAttention(prev, next).length, 0);
});
test('a row with neither key nor id is skipped (un-actionable, un-trackable)', () => {
  const out = diffNewAttention(roll(), roll({ stuck: [{ state: 'stuck', signal: 'x' }] }));
  assert.equal(out.length, 0);
});
test('a newly-matching watch pattern is a named entrant carrying the matching line (WARDEN-540)', () => {
  // The entrant's signal is the MATCHING line (customMatch.line), not classifyPane's
  // signal — the match is what the human asked to be told about.
  const customRow = { id: 'd1', key: 'd1', name: 'deploy-agent', state: 'idle', customMatch: { pattern: 'Deploy failed', line: 'DEPLOY FAILED: exit 1' } };
  const out = diffNewAttention(roll(), roll({ custom: [customRow] }));
  assert.equal(out.length, 1);
  assert.equal(out[0].key, 'd1');
  assert.equal(out[0].reason, 'Matched a watch pattern');
  assert.equal(out[0].signal, 'DEPLOY FAILED: exit 1', 'signal is the matching line, not classifyPane signal');
  assert.equal(out[0].tone, 'warning');
});
test('a persistent custom match (already in prev) is not a new entrant', () => {
  const customRow = { id: 'd1', key: 'd1', name: 'd1', state: 'idle', customMatch: { pattern: 'X', line: 'l' } };
  assert.equal(diffNewAttention(roll({ custom: [customRow] }), roll({ custom: [customRow] })).length, 0);
});

console.log('\ndiffNewAttention: missing input is defensive (returns [])');
test('null prev returns []', () => {
  assert.deepEqual(diffNewAttention(null, roll({ critical: [agent('c1')] })), []);
});
test('null next returns []', () => {
  assert.deepEqual(diffNewAttention(roll(), null), []);
});
test('both null returns []', () => {
  assert.deepEqual(diffNewAttention(null, null), []);
});

console.log('\nformatInAppEntry (WARDEN-402): named entrant → name title + reason/signal description');
test('named entrant with a signal quotes it verbatim in the description', () => {
  const e = { key: 'w', name: 'worker', reason: 'Waiting for your input', signal: 'press enter to continue', tone: 'warning' };
  const { title, description } = formatInAppEntry(e);
  assert.equal(title, 'worker');
  assert.ok(description.includes('Waiting for your input'), 'description carries the reason');
  assert.ok(description.includes("'press enter to continue'"), 'description quotes the signal');
});
test('named entrant without a signal uses the reason alone as the description', () => {
  const e = { key: 'c', name: 'crit-agent', reason: 'Critical — no recent activity', tone: 'critical' };
  const { title, description } = formatInAppEntry(e);
  assert.equal(title, 'crit-agent');
  assert.equal(description, 'Critical — no recent activity');
  assert.ok(!description.includes("'"), 'no signal quote when signal absent');
});
test('aggregate entrant (no name) renders its reason as the title with NO description', () => {
  const e = { key: '', name: '', reason: '2 recent errors', tone: 'critical' };
  const { title, description } = formatInAppEntry(e);
  assert.equal(title, '2 recent errors');
  assert.equal(description, undefined);
});

// --- WARDEN-482: excludeFocusedPane (focus-gate the live in-app attention ping) ----
//
// fireAttentionInApp loops diffNewAttention's entrants and fires a sonner toast for
// each. The entrant whose key === the pane the human is ALREADY reading must NOT toast
// — pinging the pane they're staring at is the roadmap's named product-killer. This
// filter is the symmetric "not-after" gate to shouldFireWatch (WARDEN-421/426) which
// closed the same trust bar for the watch ping. The `toast(...)` delivery itself lives
// in useAttentionRollup.ts (it imports 'sonner' + React + the `@/` alias, so it cannot
// load under the OXC test transform — exactly why fireAttentionNotification's delivery
// is untested too); only this pure filter is exercised, mirroring the discipline above.
//
// Minimal NewAttentionEntry builder — excludeFocusedPane reads only `key`.
const entry = (key, extra = {}) => ({ key, name: key || 'summary', reason: 'x', tone: 'critical', ...extra });
const AGG = { key: '', name: '', reason: '2 recent errors', tone: 'critical' }; // aggregate (no pane identity)

console.log('\nexcludeFocusedPane (WARDEN-482): drop the entrant for the focused pane, keep the rest');
test('the entrant whose key === focusedPaneKey is dropped (no toast for the pane being read)', () => {
  const out = excludeFocusedPane([entry('a'), entry('b'), entry('c')], 'b');
  assert.deepEqual(out.map((e) => e.key), ['a', 'c']);
});
test('a NON-focused entrant still toasts alongside the focused one', () => {
  const out = excludeFocusedPane([entry('focused'), entry('other')], 'focused');
  assert.deepEqual(out.map((e) => e.key), ['other']);
});
test('an aggregate (key: "") entrant STILL toasts even when a focus key is set (names no single pane)', () => {
  const out = excludeFocusedPane([entry('focused'), AGG], 'focused');
  assert.deepEqual(out.map((e) => e.key), ['']); // aggregate survives; focused dropped
});
test('only the ONE matching entrant is dropped — every other named pane still toasts', () => {
  const out = excludeFocusedPane([entry('a'), entry('b'), entry('c'), entry('d')], 'c');
  assert.deepEqual(out.map((e) => e.key), ['a', 'b', 'd']);
});

console.log('\nexcludeFocusedPane: no focus context → nothing dropped (every entrant toasts)');
test('focusedPaneKey null → all entrants survive (no focus context)', () => {
  const es = [entry('a'), entry('b'), AGG];
  assert.equal(excludeFocusedPane(es, null), es, 'returns the SAME array reference (no copy, no drop)');
});
test('focusedPaneKey undefined → all entrants survive', () => {
  const es = [entry('a'), AGG];
  assert.deepEqual(excludeFocusedPane(es, undefined).map((e) => e.key), ['a', '']);
});
test('focusedPaneKey not matching any entrant → all survive', () => {
  const out = excludeFocusedPane([entry('a'), entry('b')], 'not-open');
  assert.deepEqual(out.map((e) => e.key), ['a', 'b']);
});
test('an empty-string focused key behaves as no real focus → all survive (aggregates are NEVER dropped)', () => {
  // App derives focusedPaneKey as `a.key || a.id || null`, so '' is unreachable; but the
  // `e.key &&` guard makes it harmless regardless: aggregates (key '') always survive and
  // no named pane has key '' to match. Asserted to pin the ticket's "aggregates still
  // toast" guarantee as unconditional, not just for the real null/non-empty inputs.
  const out = excludeFocusedPane([entry('a'), AGG], '');
  assert.deepEqual(out.map((e) => e.key), ['a', ''], 'named + aggregate both survive under an empty focus key');
});

console.log('\nexcludeFocusedPane: integration with diffNewAttention (the real entrant shape)');
test('a real diff where the focused pane is the new entrant → its toast is suppressed', () => {
  // prev healthy; next: the focused pane 'w1' newly waiting + an unrelated 's1' stuck.
  const next = roll({ waiting: [pane('w1', 'press enter', 'waiting')], stuck: [pane('s1', 'loop', 'stuck')] });
  const out = excludeFocusedPane(diffNewAttention(roll(), next), 'w1');
  assert.deepEqual(out.map((e) => e.key), ['s1'], 'focused w1 dropped; s1 still pings');
});
test('a real diff with an aggregate delta + a focused named entrant → aggregate survives', () => {
  const next = roll({ waiting: [pane('w1', null, 'waiting')], errors: 2 });
  const out = excludeFocusedPane(diffNewAttention(roll(), next), 'w1');
  assert.deepEqual(out.map((e) => e.key), [''], 'named focused entrant dropped; aggregate error delta still toasts');
});

// --- WARDEN-891: applyFleetAttentionCooldown (the fleet problem-state alert's flap cooldown) ----
//
// The per-key cooldown gate for the THIRD attention channel (the fleet problem-state alert).
// Sibling of applyWatchCooldown (chatWatch.ts, WARDEN-452) + the done ping's DONE_PING_COOLDOWN_MS
// gate (WARDEN-575): a flapping UNWATCHED agent (erroring → active → erroring across polls)
// re-fires ONE alert per need-episode (escalations override + reset), closing the asymmetry
// where this channel alone re-fired on every recover→re-enter. Reads only `key` + `tone` off
// each entrant, so a minimal NewAttentionEntry suffices (reusing the `entry` shape above).
const fentry = (key, tone = 'critical', extra = {}) => ({ key, name: key || 'summary', reason: 'x', tone, ...extra });

console.log('\napplyFleetAttentionCooldown (WARDEN-891): one alert per flapping need-episode');
test('first fire (no prior) fires + anchors the window at now', () => {
  const { fire, lastFired } = applyFleetAttentionCooldown([fentry('a', 'critical')], {}, 1000, 5000);
  assert.equal(fire.length, 1);
  assert.equal(fire[0].key, 'a');
  assert.equal(lastFired.a.tone, 'critical');
  assert.equal(lastFired.a.firedAt, 1000);
});

test('null lastFired → every entrant fires (first-fire baseline)', () => {
  const { fire, lastFired } = applyFleetAttentionCooldown([fentry('a', 'warning'), fentry('b', 'critical')], null, 1000, 5000);
  assert.equal(fire.length, 2);
  assert.equal(lastFired.a.firedAt, 1000);
  assert.equal(lastFired.b.firedAt, 1000);
});

test('same key + same tone re-entered WITHIN the window is SUPPRESSED', () => {
  const prev = { a: { tone: 'critical', firedAt: 1000 } };
  const { fire, lastFired } = applyFleetAttentionCooldown([fentry('a', 'critical')], prev, 3000, 5000);
  assert.equal(fire.length, 0);
  // the anchor is NOT advanced — the window stays measured from the first fire
  assert.equal(lastFired.a.firedAt, 1000);
  assert.equal(lastFired.a.tone, 'critical');
});

test('same key + same tone re-entered AFTER the window fires + re-anchors', () => {
  const prev = { a: { tone: 'critical', firedAt: 1000 } };
  const { fire, lastFired } = applyFleetAttentionCooldown([fentry('a', 'critical')], prev, 7000, 5000);
  assert.equal(fire.length, 1);
  assert.equal(lastFired.a.firedAt, 7000);
});

test('warning → critical WITHIN the window is an ESCALATION → fires + resets timer', () => {
  // lower priority number = more urgent: critical(0) < warning(1)
  const prev = { a: { tone: 'warning', firedAt: 1000 } };
  const { fire, lastFired } = applyFleetAttentionCooldown([fentry('a', 'critical')], prev, 3000, 5000);
  assert.equal(fire.length, 1);
  assert.equal(lastFired.a.tone, 'critical');
  assert.equal(lastFired.a.firedAt, 3000); // reset
});

test('escalation RESETS the timer: a later same-tone re-entry is suppressed vs the NEW anchor', () => {
  // fire warning@1000; escalate critical@3000 (resets anchor to 3000); re-enter
  // critical@7000. From the RESET anchor: 7000-3000=4000 < 5000 → suppressed. From
  // the original t=1000 it would be 6000 >= 5000 → fire. The suppress proves reset.
  let lastFired = {};
  let fired = 0;
  const step = (entries, now) => {
    const r = applyFleetAttentionCooldown(entries, lastFired, now, 5000);
    lastFired = r.lastFired;
    fired += r.fire.length;
  };
  step([fentry('a', 'warning')], 1000);  // fires (1)
  step([fentry('a', 'critical')], 3000); // escalation → fires + resets to 3000 (2)
  step([fentry('a', 'critical')], 7000); // 7000-3000=4000 < 5000 → suppressed
  assert.equal(fired, 2);
});

test('critical → warning WITHIN the window is LOWER urgency → suppressed', () => {
  const prev = { a: { tone: 'critical', firedAt: 1000 } };
  const { fire } = applyFleetAttentionCooldown([fentry('a', 'warning')], prev, 3000, 5000);
  assert.equal(fire.length, 0);
});

test('a flapping key (erroring → active → erroring each poll) → ONE alert per episode window', () => {
  const cooldown = 5 * 60 * 1000;
  let lastFired = {};
  let fired = 0;
  const step = (entries, now) => {
    const r = applyFleetAttentionCooldown(entries, lastFired, now, cooldown);
    lastFired = r.lastFired;
    fired += r.fire.length;
  };
  // episode window [0, 5min): several re-entries into erroring (critical tone)
  step([fentry('a', 'critical')], 0);            // first erroring → fires (1)
  step([fentry('a', 'critical')], 60_000);       // re-entry within window → suppressed
  step([fentry('a', 'critical')], 120_000);      // suppressed
  step([fentry('a', 'critical')], 240_000);      // suppressed
  assert.equal(fired, 1);
  // after the window elapses, a re-entry fires again (a new episode)
  step([fentry('a', 'critical')], cooldown + 60_000);
  assert.equal(fired, 2);
});

test('different keys are independent (no cross-key cooldown)', () => {
  const prev = { a: { tone: 'critical', firedAt: 1000 } };
  // key a same-tone within window → suppressed; key b no prior → fires
  const { fire } = applyFleetAttentionCooldown([fentry('a', 'critical'), fentry('b', 'critical')], prev, 3000, 5000);
  assert.equal(fire.length, 1);
  assert.equal(fire[0].key, 'b');
});

test('a key with a prior anchor but no entrant this diff KEEPS its anchor (carry-forward)', () => {
  // THIS is what collapses the recover→re-enter flap: the agent leaves every rollup
  // bucket while recovered (no entrant that poll), so its identity is "absent" — the
  // carried-forward anchor keeps the window measured correctly across that absence.
  const prev = { a: { tone: 'critical', firedAt: 1000 }, b: { tone: 'warning', firedAt: 2000 } };
  const { fire, lastFired } = applyFleetAttentionCooldown([], prev, 3000, 5000);
  assert.equal(fire.length, 0);
  assert.equal(lastFired.a.firedAt, 1000); // preserved
  assert.equal(lastFired.b.firedAt, 2000); // preserved
});

test('the input lastFired map is NOT mutated (immutability)', () => {
  const prev = { a: { tone: 'critical', firedAt: 1000 } };
  const { lastFired } = applyFleetAttentionCooldown([fentry('a', 'critical')], prev, 3000, 5000);
  assert.equal(prev.a.firedAt, 1000);      // input unchanged
  assert.equal(lastFired.a.firedAt, 1000); // suppressed → anchor retained
  assert.notEqual(lastFired, prev);        // a new map is returned
});

console.log('\napplyFleetAttentionCooldown: aggregate (key: "") entrants pass through unchanged');
test('an aggregate entrant always fires (no per-key identity to anchor)', () => {
  // A count rise is not a flap; aggregate entries stay on the increase-only shouldFireAlert gate.
  const { fire, lastFired } = applyFleetAttentionCooldown([AGG], { a: { tone: 'critical', firedAt: 1000 } }, 3000, 5000);
  assert.equal(fire.length, 1);
  assert.equal(fire[0].key, '');
  assert.ok(!('' in lastFired), 'aggregate never enters the map (no key to anchor)');
});
test('a flapping named key is suppressed while an aggregate delta still fires', () => {
  const prev = { a: { tone: 'critical', firedAt: 1000 } };
  const { fire } = applyFleetAttentionCooldown([fentry('a', 'critical'), AGG], prev, 3000, 5000);
  assert.deepEqual(fire.map((e) => e.key), [''], 'flapping a suppressed; aggregate passes through');
});

console.log('\napplyFleetAttentionCooldown: composes with diffNewAttention (the real entrant shape)');
test('a flapping agent (recovered→re-enter) fires ONCE per window end-to-end', () => {
  // The end-to-end flap the ticket targets: in the hook, prev advances each poll, so a
  // recovered-then-re-entered key is ABSENT from prev's buckets and reads as "new" to
  // diffNewAttention — but the cooldown's carried-forward anchor collapses it to one fire.
  const cooldown = 5 * 60 * 1000;
  let lastFired = {};
  let prev = roll();
  let fired = 0;
  const poll = (next, now) => {
    const entrants = diffNewAttention(prev, next);
    const r = applyFleetAttentionCooldown(entrants, lastFired, now, cooldown);
    lastFired = r.lastFired;
    prev = next;
    fired += r.fire.length;
  };
  poll(roll({ erroring: [pane('a', null, 'erroring')] }), 60_000);   // first erroring → fires (1)
  poll(roll(), 120_000);                                             // recovery (no entrant; anchor carried)
  poll(roll({ erroring: [pane('a', null, 'erroring')] }), 180_000);  // re-entry within window → suppressed
  poll(roll(), 240_000);                                             // recovery
  poll(roll({ erroring: [pane('a', null, 'erroring')] }), 300_000);  // suppressed (1)
  assert.equal(fired, 1);
  // after the window from the first fire (t=60_000) elapses, a re-entry fires
  poll(roll(), 60_000 + cooldown + 10_000);
  poll(roll({ erroring: [pane('a', null, 'erroring')] }), 60_000 + cooldown + 20_000);  // fires (2)
  assert.equal(fired, 2);
});
test('a genuine escalation (waiting→erroring) overrides + resets the window end-to-end', () => {
  const cooldown = 5 * 60 * 1000;
  let lastFired = {};
  let prev = roll();
  let fired = 0;
  const poll = (next, now) => {
    const entrants = diffNewAttention(prev, next);
    const r = applyFleetAttentionCooldown(entrants, lastFired, now, cooldown);
    lastFired = r.lastFired;
    prev = next;
    fired += r.fire.length;
  };
  poll(roll({ waiting: [pane('a', null, 'waiting')] }), 60_000);    // waiting (warning) → fires (1)
  poll(roll(), 120_000);                                            // recovery
  poll(roll({ erroring: [pane('a', null, 'erroring')] }), 180_000); // re-entry as erroring (critical) = ESCALATION → fires (2)
  assert.equal(fired, 2, 'the escalation fired despite being within the window');
});
test('a persistently-needy agent (no recovery) is NOT re-alerted', () => {
  // The existing increase-only shouldFireAlert gate already prevents a persistent condition
  // from re-firing (total stays flat → diffNewAttention returns no entrant). The cooldown
  // adds no false positive on top: no entrant → no fire, anchor carried untouched.
  const cooldown = 5 * 60 * 1000;
  let lastFired = {};
  let prev = roll();
  let fired = 0;
  const poll = (next, now) => {
    const entrants = diffNewAttention(prev, next);
    const r = applyFleetAttentionCooldown(entrants, lastFired, now, cooldown);
    lastFired = r.lastFired;
    prev = next;
    fired += r.fire.length;
  };
  poll(roll({ stuck: [pane('a', null, 'stuck')] }), 60_000);  // first stuck → fires (1)
  poll(roll({ stuck: [pane('a', null, 'stuck')] }), 120_000); // persists → no entrant → no fire
  poll(roll({ stuck: [pane('a', null, 'stuck')] }), 180_000); // persists → no fire
  assert.equal(fired, 1);
});

// --- WARDEN-426: shouldFireWatch (focus-gate the per-chat watch ping) ----
// The helper takes the live document.visibilityState as its 3rd arg because
// `focused` is STICKY: it is not cleared when Warden hides, so focus-on-the-pane
// must NOT be allowed to suppress a ping while the human is away. The focus-
// dimension cases below feed 'visible' (present human); the away dimension has
// its own block immediately after.
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

console.log(`\n✓ DESKTOP ALERTS TESTS PASS (${passed})`);
