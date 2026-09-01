// WARDEN-1259 — STATIC SOURCE GUARD for the fleet close-stamp write.
//
// WHY THIS FILE EXISTS: `handleBeforeUnload` in web/src/App.tsx stamps
// `warden:lastClose` on page close, and it runs from TWO escape-sensitive
// sites — the `beforeunload` listener (page teardown) and the LAST statement
// of the mount effect's cleanup (React does not isolate destroy-function
// exceptions, so a throw there aborts any remaining teardown). Every sibling
// localStorage writer in web/src/lib/ follows the WARDEN-89 convention
// (storage.ts:18-20: "persistence errors are surfaced via console.warn rather
// than swallowed... never silent"), and watchCatchup.ts's discipline paragraph
// asserts by name that the fleet `warden:lastClose` stamp "console.warn[s] on
// quota, never throws" — a false fact until this guard landed, because this
// was the one bare setItem of the 10 in the codebase (the other 9 were
// retrofitted by WARDEN-1230/#1229-family fixes, which each disclosed App.tsx
// as out of scope).
//
// This repo has no React/DOM test runner, so component-embedded behavior is
// pinned via static source assertions — the same approach as the #1247
// source-contract tests on SnippetsSection.tsx (storage.test.mjs) and the
// #1241 sessionTagCap.test.mjs "STATIC SOURCE GUARD" precedent: a source scan
// can see a try/catch-containment relationship a unit test over pure helpers
// cannot.

import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const appSrc = readFileSync(resolve(__dirname, 'src/App.tsx'), 'utf8');

// Locates the handleBeforeUnload function and returns the slice from its
// declaration to the `window.addEventListener('beforeunload', ...)` call that
// immediately follows it — the region the write must be guarded within.
function handleBeforeUnloadRegion(src) {
  const fnStart = src.indexOf('const handleBeforeUnload = () => {');
  assert.notEqual(fnStart, -1, 'handleBeforeUnload is findable in App.tsx source');
  const listenerIdx = src.indexOf("window.addEventListener('beforeunload', handleBeforeUnload)", fnStart);
  assert.notEqual(listenerIdx, -1, 'the beforeunload listener registration is findable after the function');
  return src.slice(fnStart, listenerIdx);
}

test('the warden:lastClose stamp is written inside a try whose catch console.warns', () => {
  const region = handleBeforeUnloadRegion(appSrc);

  const tryIdx = region.indexOf('try {');
  const setItemIdx = region.indexOf("localStorage.setItem('warden:lastClose'");
  const catchIdx = region.indexOf('} catch (e) {', setItemIdx);
  const warnIdx = region.indexOf('console.warn(', catchIdx);

  assert.notEqual(setItemIdx, -1, 'the warden:lastClose setItem is findable in the region');
  assert.notEqual(tryIdx, -1, 'a try block is findable in the region');
  assert.notEqual(catchIdx, -1, 'a catch clause follows the setItem');
  assert.notEqual(warnIdx, -1, 'the catch console.warns');

  // Ordering probes: the write must sit INSIDE the try, and the warn must sit
  // INSIDE the catch — a try placed after the write, or a catch that does not
  // warn, guards nothing.
  assert.ok(tryIdx < setItemIdx,
    'the try must open BEFORE the setItem — a try after the write catches nothing');
  assert.ok(catchIdx > setItemIdx && catchIdx < region.length,
    'the catch must follow the setItem within the region');
  assert.ok(warnIdx > catchIdx,
    'the console.warn must live inside the catch clause');
});

test('the guard warns in the exact sibling format: [warden:app] prefix + "<fn> failed" shape', () => {
  const region = handleBeforeUnloadRegion(appSrc);
  assert.match(
    region,
    /console\.warn\('\[warden:app\] saveLastClose failed', e\);/,
    "every guarded writer warns as `[warden:<module>] <fn> failed` — App.tsx's module prefix is 'app' and the fn name is saveLastClose"
  );
});

test('the happy-path write shape is unchanged: same key, same String(Date.now()) payload', () => {
  const region = handleBeforeUnloadRegion(appSrc);
  assert.match(
    region,
    /localStorage\.setItem\('warden:lastClose', String\(Date\.now\(\)\)\);/,
    'the stamp must remain the exact same key + payload — only the failure MODE changes'
  );
});

test('both call sites survive: the beforeunload listener AND the effect-cleanup invocation', () => {
  // Site (a): the listener — page teardown is the production-reachable path.
  assert.ok(
    appSrc.includes("window.addEventListener('beforeunload', handleBeforeUnload);"),
    'the beforeunload listener registration must remain'
  );
  // Site (b): the cleanup call — the last statement of the effect's destroy
  // function (React does not isolate its exceptions), which is exactly why
  // the write must not throw.
  const cleanupIdx = appSrc.indexOf('window.removeEventListener', appSrc.indexOf("window.addEventListener('beforeunload', handleBeforeUnload);"));
  assert.notEqual(cleanupIdx, -1, 'the cleanup block removing the listener is findable');
  const cleanupCallIdx = appSrc.indexOf('handleBeforeUnload();', cleanupIdx);
  assert.notEqual(cleanupCallIdx, -1,
    'the cleanup must still invoke handleBeforeUnload to stamp the close on unmount');
});

test('App.tsx writes localStorage only inside an open try block (WARDEN-89 census invariant)', () => {
  // Success criterion 1: every setItem in App.tsx must be guarded — the file
  // owned exactly ONE bare write before this fix, and if a future one appears
  // bare this fails so it gets the same treatment. A write is "guarded" when a
  // `try {` opens after any preceding `} catch` and before the write — i.e.
  // the write sits inside a live try body, not before its block or after it.
  let idx = appSrc.indexOf('localStorage.setItem(');
  assert.ok(idx !== -1, 'App.tsx still contains its warden:lastClose write');
  while (idx !== -1) {
    const preceding = appSrc.slice(Math.max(0, idx - 400), idx);
    const lastTry = preceding.lastIndexOf('try {');
    const lastCatch = preceding.lastIndexOf('} catch');
    assert.ok(
      lastTry !== -1 && lastTry > lastCatch,
      `the localStorage.setItem at offset ${idx} must sit inside an open try block (WARDEN-89 convention)`
    );
    idx = appSrc.indexOf('localStorage.setItem(', idx + 1);
  }
});
