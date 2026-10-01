// Tests for web/src/lib/recordOnExpand.ts (WARDEN-1494) — the pure core behind
// useRecordOnExpand, which records `panel-expand-sidebar` /
// `panel-expand-observer` on the collapsed true -> false STATE EDGE so every
// expand path (header button, Alt+S / Alt+O, openActivityTab) counts exactly
// once. Origin/main recorded inline on the header buttons only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { transformWithOxc } from 'vite';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const libPath = resolve(__dirname, 'src/lib/recordOnExpand.ts');
const { code } = await transformWithOxc(readFileSync(libPath, 'utf8'), libPath, {});
const tmpDir = mkdtempSync(join(tmpdir(), 'warden-recordonexpand-'));
const tmpFile = join(tmpDir, 'recordOnExpand.mjs');
writeFileSync(tmpFile, code);
const { isExpandTransition, observeCollapsed } = await import(tmpFile);
try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }

// Drive a sequence of collapsed values the way the hook does: prev starts at
// the MOUNT value, then each render observes the next value.
function run(mount, ...values) {
  const calls = [];
  let prev = mount;
  for (const v of values) prev = observeCollapsed(prev, v, () => calls.push('rec'));
  return calls.length;
}

test('isExpandTransition is true only on collapsed true -> false', () => {
  assert.equal(isExpandTransition(true, false), true);
  assert.equal(isExpandTransition(false, true), false);
  assert.equal(isExpandTransition(true, true), false);
  assert.equal(isExpandTransition(false, false), false);
});

test('Alt+S/Alt+O/openActivityTab expand: collapsed -> expanded records exactly one', () => {
  assert.equal(run(true, false), 1);
});

test('toggling when already expanded records zero (nothing to expand)', () => {
  assert.equal(run(false, false), 0);
  // openActivityTab on an already-expanded observer is setState(false) -> no change
  assert.equal(run(false, false, false), 0);
});

test('header-button expand records exactly one — the hook is the ONLY recorder', () => {
  // One flip, one observation: a second inline seed would make this 2.
  assert.equal(run(true, false), 1);
  // Re-observing the same value (StrictMode double effect / re-render) adds none.
  assert.equal(run(true, false, false, false), 1);
});

test('mount with persisted collapsed=true records nothing; the mount value is the baseline', () => {
  assert.equal(run(true, true), 0);
  assert.equal(run(true), 0);
});

test('collapse direction records nothing', () => {
  assert.equal(run(false, true), 0);
});

test('a full cycle expand→collapse→expand records one per expand edge', () => {
  assert.equal(run(true, false, true, false), 2);
});

test('observeCollapsed returns the next value as the new prev', () => {
  assert.equal(observeCollapsed(true, false, () => {}), false);
  assert.equal(observeCollapsed(false, true, () => {}), true);
});
