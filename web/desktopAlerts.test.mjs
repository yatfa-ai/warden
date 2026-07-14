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
const { shouldFireAlert, formatAlertMessage, applySeverityPrefs, ATTENTION_SEVERITY_DEFAULTS, alertAgentKey } = await import(tmpFile);
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
  const directives = b.directives ?? 0;
  const errors = b.errors ?? 0;
  const total = critical.length + warning.length + stuck.length + erroring.length +
    waiting.length + blocked.length + directives + errors;
  return { critical, warning, stuck, erroring, waiting, blocked, directives, errors, total };
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

console.log(`\n✓ DESKTOP ALERTS TESTS PASS (${passed})`);
