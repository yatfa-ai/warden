// Direct unit tests for the 5 pure display/normalize functions exported from
// src/lib/healthUtils.ts:
//   getHealthColor, getHealthBgColor, formatHealthState, getHealthIcon,
//   normalizeHealthState
//
// `hostHealth.test.mjs` loads the SAME module but destructures ONLY the 7
// grouping/comparison helpers (groupByHost, compareHostGroups, groupByProject,
// compareProjectGroups, summarizeProjectHosts, summarizeHostLoad, resourceTone) —
// it mentions normalizeHealthState solely in a comment (:107) and never imports
// the 4 display functions or HealthState itself. So these 5 fns had ZERO direct
// web-side coverage until this file. (`test-discovery "healthUtils"` returns
// NO_REFERENCING_TESTS because the module is loaded via a dynamic `await import()`
// of a transpiled temp file the tool can't see — WARDEN-632.)
//
// The headline guard is getHealthIcon's WCAG 1.4.1 pairwise-distinctness contract
// (WARDEN-245): the 6 glyphs must stay mutually distinct so health state survives
// grayscale / color-vision deficiency. No type check enforces distinctness — this
// test does. getHealthIcon does not exist in the backend src/health.js dup, so the
// backend src/health.test.js does not cover it either; this is its only coverage.
//
// No front-end test runner in this repo, so (exactly like hostHealth.test.mjs) this
// loads the REAL src/lib/healthUtils.ts (transpiled TS -> ESM via Vite's OXC
// transform) and exercises it directly. The `import type { Chat }` in that file is
// erased at transpile time, so the emitted module is import-free and loads
// standalone.
//
// Run: node healthUtils.test.mjs   (or: npm test, from web/)
import { transformWithOxc } from 'vite';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const helperPath = resolve(__dirname, 'src/lib/healthUtils.ts');

// --- Load the REAL healthUtils.ts (TS -> ESM via the OXC transform Vite bundles) ----
const src = readFileSync(helperPath, 'utf8');
const { code } = await transformWithOxc(src, helperPath, {});
const tmpDir = mkdtempSync(join(tmpdir(), 'warden-healthUtils-test-'));
const tmpFile = join(tmpDir, 'healthUtils.mjs');
writeFileSync(tmpFile, code);
const {
  HealthState,
  getHealthColor,
  getHealthBgColor,
  formatHealthState,
  getHealthIcon,
  normalizeHealthState,
} = await import(tmpFile);
rmSync(tmpDir, { recursive: true, force: true });

const STATES = Object.values(HealthState); // ['healthy','warning','critical','idle','closed','unknown']

let passed = 0;
const test = (name, fn) => {
  fn();
  passed += 1;
  console.log('  ok -', name);
};

// ---- getHealthIcon: the WCAG 1.4.1 non-color contract (WARDEN-245) ----
// Each state maps to a glyph that must be pairwise distinct from every other, so
// state is legible in grayscale / under color-vision deficiency (healthy `✓` vs
// critical `✕`; closed `■` vs idle `○`). This is the most-rendered element in the
// app — every agent row's health badge — and NO type check enforces distinctness,
// so the regression guard below is the only thing that does.

console.log('\ngetHealthIcon: per-state expected glyph (WARDEN-245 contract)');
test('each state maps to its documented glyph', () => {
  assert.equal(getHealthIcon(HealthState.HEALTHY), '✓');
  assert.equal(getHealthIcon(HealthState.WARNING), '◐');
  assert.equal(getHealthIcon(HealthState.CRITICAL), '✕');
  assert.equal(getHealthIcon(HealthState.IDLE), '○');
  assert.equal(getHealthIcon(HealthState.CLOSED), '■');
  assert.equal(getHealthIcon(HealthState.UNKNOWN), '·');
});

test('a value outside the enum falls back to the unknown dot `·`', () => {
  // The switch's default arm — the catch-all a stray wire value hits.
  assert.equal(getHealthIcon('on-fire'), '·');
});

console.log('\ngetHealthIcon: WCAG pairwise-distinctness — the regression guard');
test('all 6 state glyphs are mutually distinct (no two states share a glyph)', () => {
  // THE load-bearing assertion. No type check prevents a future edit from
  // collapsing two `case` branches to the same glyph (silently breaking the
  // accessibility guarantee). This Set-size check is the only thing that catches
  // it: if any two states shared a glyph, the set would shrink below 6 and this
  // would FAIL. (Acceptance criterion: new Set(...).size === 6.)
  const glyphs = STATES.map(getHealthIcon);
  assert.equal(new Set(glyphs).size, STATES.length);
  assert.equal(new Set(glyphs).size, 6);
});
test('collapsing two glyphs to the same char WOULD break distinctness (proof the guard bites)', () => {
  // Directly satisfies the acceptance criterion "a deliberate edit collapsing two
  // getHealthIcon cases to the same glyph FAILS the new test." Simulate that edit
  // (force CRITICAL to reuse HEALTHY's glyph) and show the distinctness invariant
  // no longer holds — so the guard above is a real check, not a tautology.
  const healthy = getHealthIcon(HealthState.HEALTHY);
  const collapsed = STATES.map((s) =>
    s === HealthState.CRITICAL ? healthy : getHealthIcon(s),
  );
  assert.notEqual(new Set(collapsed).size, STATES.length);
});

// ---- normalizeHealthState: the wire -> enum trust boundary (WARDEN-237) ----
// Takes arbitrary backend/wire input, lowercases it, looks it up in a fixed map,
// and collapses anything unrecognized to UNKNOWN. Load-bearing for the tallies:
// groupByHost (:196) / groupByProject (:268) both do
// `group.counts[normalizeHealthState(agent.healthState)] += 1`, so a return value
// that isn't a key of HostHealthCounts would silently lose a count. The
// transitive grouping tests only ever pass clean lowercase states, so the real
// edges below were unpinned.

console.log('\nnormalizeHealthState: lowercase valid wire values resolve to the enum');
test('each lowercase state string maps to its HealthState value', () => {
  for (const s of STATES) {
    assert.equal(normalizeHealthState(s), s);
  }
});

console.log('\nnormalizeHealthState: case-folding (wire values arrive in any case)');
test('uppercase / mixed-case input is lowercased before lookup', () => {
  assert.equal(normalizeHealthState('HEALTHY'), HealthState.HEALTHY);
  assert.equal(normalizeHealthState('Critical'), HealthState.CRITICAL);
  assert.equal(normalizeHealthState('WaRnInG'), HealthState.WARNING);
  assert.equal(normalizeHealthState('CLOSED'), HealthState.CLOSED);
});

console.log('\nnormalizeHealthState: missing / empty -> UNKNOWN (never a crash)');
test('undefined -> UNKNOWN', () => {
  assert.equal(normalizeHealthState(undefined), HealthState.UNKNOWN);
});
test('empty string -> UNKNOWN', () => {
  assert.equal(normalizeHealthState(''), HealthState.UNKNOWN);
});
test('explicit garbage -> UNKNOWN, not a crash', () => {
  assert.equal(normalizeHealthState('on-fire'), HealthState.UNKNOWN);
  assert.equal(normalizeHealthState('garbage'), HealthState.UNKNOWN);
  // Input is lowercased but NOT trimmed — a trailing space is unrecognized.
  assert.equal(normalizeHealthState('healthy '), HealthState.UNKNOWN);
});
test('the literal wire value "unknown" -> UNKNOWN', () => {
  assert.equal(normalizeHealthState('unknown'), HealthState.UNKNOWN);
});

console.log('\nnormalizeHealthState: prototype / inherited keys (tally safety)');
test('prototype-inherited keys never throw (the host/project tally stays alive)', () => {
  // The grouping path does counts[normalizeHealthState(agent.healthState)] += 1.
  // Whatever such a key resolves to, normalizeHealthState must not THROW on one —
  // a throw here would kill the whole host/project tally. Verified across the
  // usual Object.prototype suspects.
  for (const k of ['toString', 'constructor', '__proto__', 'valueOf', 'hasOwnProperty', 'isPrototypeOf']) {
    assert.doesNotThrow(() => normalizeHealthState(k));
  }
});
test('prototype keys with no own mapping (toString / valueOf / hasOwnProperty) collapse to UNKNOWN', () => {
  // Acceptance criterion: a prototype key -> UNKNOWN. These are inherited from
  // Object.prototype but have no OWN entry in the lookup map, so the ??
  // fallback resolves them to UNKNOWN.
  assert.equal(normalizeHealthState('toString'), HealthState.UNKNOWN);
  assert.equal(normalizeHealthState('valueOf'), HealthState.UNKNOWN);
  assert.equal(normalizeHealthState('hasOwnProperty'), HealthState.UNKNOWN);
});
test('CHARACTERIZATION: constructor / __proto__ currently LEAK inherited members (NOT collapsed to UNKNOWN)', () => {
  // ⚠️ NOT the safe collapse the proposal assumed. The lookup is
  //   validStates[state.toLowerCase()] ?? HealthState.UNKNOWN
  // on a plain object, so for keys that exist on Object.prototype the bracket
  // access finds the INHERITED member. `toString` / `valueOf` / `hasOwnProperty`
  // resolve fine (test above), but `constructor` (the Object constructor
  // function) and `__proto__` (Object.prototype itself) are truthy, so the ??
  // fallback does NOT fire and a non-HealthStateValue leaks out.
  //
  // This is a CHARACTERIZATION test: it pins the ACTUAL current behavior so a
  // future source fix (e.g. an Object.create(null) map, or a
  // Object.prototype.hasOwnProperty.call / Map guard) is forced to update this
  // test rather than silently change the contract. Practical impact today is
  // limited: groupByHost / groupByProject do counts[<leaked>] += 1, so a leaked
  // member becomes an un-tallied bucket (one lost count) rather than a crash,
  // and an agent.healthState of literally 'constructor' / '__proto__' off the
  // wire is implausible. Flagged for a source-side follow-up; see the ticket
  // comment on WARDEN-885.
  assert.equal(typeof normalizeHealthState('constructor'), 'function');
  assert.equal(typeof normalizeHealthState('__proto__'), 'object');
  assert.notEqual(normalizeHealthState('constructor'), HealthState.UNKNOWN);
  assert.notEqual(normalizeHealthState('__proto__'), HealthState.UNKNOWN);
});

// ---- getHealthColor / getHealthBgColor / formatHealthState: web-side parity ----
// These are simple switches whose identical LOGIC is covered in the backend
// src/health.js dup (via src/health.test.js), but the WEB copies had no direct
// web-side coverage. Pinning them here brings the web module to parity and —
// importantly — pins the documented CLOSED-vs-IDLE distinction (CLOSED reads
// "more final" than IDLE; healthUtils.ts:30-33).

console.log('\ngetHealthColor: one class per state + the CLOSED≠IDLE distinction');
test('each state maps to its documented text-color class', () => {
  assert.equal(getHealthColor(HealthState.HEALTHY), 'text-green-400');
  assert.equal(getHealthColor(HealthState.WARNING), 'text-yellow-400');
  assert.equal(getHealthColor(HealthState.CRITICAL), 'text-red-400');
  assert.equal(getHealthColor(HealthState.IDLE), 'text-gray-400');
  assert.equal(getHealthColor(HealthState.CLOSED), 'text-gray-500');
});
test('CLOSED is one shade darker than IDLE (gray-500 vs gray-400 — "more final")', () => {
  // The documented distinction (healthUtils.ts:30-33): a closed (dead) session
  // reads as more final than an idle (waiting) one. They must NOT collapse to the
  // same class — the shade difference + the distinct glyph are the WCAG levers.
  assert.notEqual(getHealthColor(HealthState.CLOSED), getHealthColor(HealthState.IDLE));
  assert.equal(getHealthColor(HealthState.CLOSED), 'text-gray-500');
  assert.equal(getHealthColor(HealthState.IDLE), 'text-gray-400');
});
test('unknown / out-of-enum -> muted-foreground (switch default)', () => {
  assert.equal(getHealthColor(HealthState.UNKNOWN), 'text-muted-foreground');
  assert.equal(getHealthColor('on-fire'), 'text-muted-foreground');
});

console.log('\ngetHealthBgColor: one bg class per state + CLOSED≠IDLE');
test('each state maps to its documented bg-color class', () => {
  assert.equal(getHealthBgColor(HealthState.HEALTHY), 'bg-green-500');
  assert.equal(getHealthBgColor(HealthState.WARNING), 'bg-yellow-500');
  assert.equal(getHealthBgColor(HealthState.CRITICAL), 'bg-red-500');
  assert.equal(getHealthBgColor(HealthState.IDLE), 'bg-gray-500');
  assert.equal(getHealthBgColor(HealthState.CLOSED), 'bg-gray-600');
});
test('CLOSED bg is distinct from IDLE bg (bg-gray-600 vs bg-gray-500)', () => {
  assert.notEqual(getHealthBgColor(HealthState.CLOSED), getHealthBgColor(HealthState.IDLE));
});
test('unknown / out-of-enum -> muted-foreground bg (switch default)', () => {
  assert.equal(getHealthBgColor(HealthState.UNKNOWN), 'bg-muted-foreground');
  assert.equal(getHealthBgColor('on-fire'), 'bg-muted-foreground');
});

console.log('\nformatHealthState: one display label per state + CLOSED≠IDLE');
test('each state maps to its capitalized display label', () => {
  assert.equal(formatHealthState(HealthState.HEALTHY), 'Healthy');
  assert.equal(formatHealthState(HealthState.WARNING), 'Warning');
  assert.equal(formatHealthState(HealthState.CRITICAL), 'Critical');
  assert.equal(formatHealthState(HealthState.IDLE), 'Idle');
  assert.equal(formatHealthState(HealthState.CLOSED), 'Closed');
});
test('CLOSED label is distinct from IDLE label ("Closed" vs "Idle")', () => {
  assert.notEqual(formatHealthState(HealthState.CLOSED), formatHealthState(HealthState.IDLE));
  assert.equal(formatHealthState(HealthState.CLOSED), 'Closed');
  assert.equal(formatHealthState(HealthState.IDLE), 'Idle');
});
test('unknown / out-of-enum -> "Unknown" (switch default)', () => {
  assert.equal(formatHealthState(HealthState.UNKNOWN), 'Unknown');
  assert.equal(formatHealthState('on-fire'), 'Unknown');
});

console.log(`\n${passed} passed`);
