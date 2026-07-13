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
const { shouldFireAlert, formatAlertMessage } = await import(tmpFile);
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

console.log(`\n✓ DESKTOP ALERTS TESTS PASS (${passed})`);
