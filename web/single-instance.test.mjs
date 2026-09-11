// WARDEN-1346 — STATIC SOURCE GUARD for the Electron single-instance lock.
//
// WHY THIS FILE EXISTS: `electron/main.cjs` must hold a single-instance lock —
// `app.requestSingleInstanceLock()` at MODULE SCOPE, with the losing instance
// quitting before any whenReady work. Without it, a double-launch (ordinary on
// Windows, the shipping platform) reaches whenReady, and that boot's
// killStalePort() force-kills the RUNNING instance's healthy backend — it
// cannot tell a crashed previous run's stale server from the live one — then
// forks its own backend onto the same port, leaving window #1 silently served
// by a foreign process. The behavior is a second Electron process deciding not
// to boot, which no unit test can reach: this repo has no Electron test runner,
// so the contract is pinned via static source assertions — the same approach as
// web/lastCloseGuard.test.mjs ("STATIC SOURCE GUARD"), web/esm-import-specifier.test.mjs,
// and web/menu-template.test.mjs.
//
// EVERY probe is anchored to a known-present string first (killStalePort,
// app.whenReady, requestSingleInstanceLock…), so a rename cannot silently turn
// a missing lock into a vacuous pass — the anchors fail loudly instead.

import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const mainSrc = readFileSync(resolve(__dirname, '..', 'electron', 'main.cjs'), 'utf8');

// The REAL whenReady call site: `app.whenReady().then(` appears only at the
// call — bare `app.whenReady(` also occurs inside explanatory comments, which
// would make a naive indexOf anchor to prose instead of code.
function whenReadyCallIdx(src) {
  const idx = src.indexOf('app.whenReady().then(');
  assert.notEqual(idx, -1, 'the app.whenReady().then( call is present in electron/main.cjs');
  return idx;
}

test('anchors: the strings the lock contract is wired against are all present', () => {
  for (const anchor of [
    'killStalePort',                       // the hazard's carrier — unchanged by this fix
    'app.whenReady().then(',               // the boot path the lock must precede
    'app.requestSingleInstanceLock()',     // the lock call itself
    "app.on('second-instance'",            // the raise-the-existing-window handler
  ]) {
    assert.ok(mainSrc.includes(anchor), `anchor ${JSON.stringify(anchor)} is findable in electron/main.cjs`);
  }
});

test('requestSingleInstanceLock is called at module scope, before whenReady', () => {
  const lockIdx = mainSrc.indexOf('app.requestSingleInstanceLock()');
  const whenReadyIdx = whenReadyCallIdx(mainSrc);
  const firstFnDeclIdx = mainSrc.indexOf('function ');
  assert.notEqual(lockIdx, -1, 'the lock call is present');
  assert.notEqual(whenReadyIdx, -1, 'the whenReady call is present');
  assert.ok(
    lockIdx < whenReadyIdx,
    `the lock call (index ${lockIdx}) precedes app.whenReady( (index ${whenReadyIdx}) — ` +
    'a lock taken after whenReady has already let a second instance run killStalePort()',
  );
  assert.ok(
    firstFnDeclIdx === -1 || lockIdx < firstFnDeclIdx,
    'the lock call sits before the first function declaration — module scope, not inside one',
  );
  // The call is bound at top level (`const gotTheLock = …` at column 0), not
  // nested — a lock result captured inside a function would not gate the boot.
  assert.match(
    mainSrc.slice(0, lockIdx + 'app.requestSingleInstanceLock();'.length),
    /(^|\n)const gotTheLock = app\.requestSingleInstanceLock\(\);/,
    'the lock result is captured in a top-level `const gotTheLock`',
  );
});

test('the !gotTheLock branch quits and runs none of the second-instance boot work', () => {
  const branchIdx = mainSrc.indexOf('if (!gotTheLock)');
  assert.notEqual(branchIdx, -1, 'the !gotTheLock branch is present');
  // The branch is a one-liner: slice from it to the end of the statement.
  const stmtEnd = mainSrc.indexOf(';', branchIdx);
  assert.notEqual(stmtEnd, -1, 'the branch statement terminates');
  const branch = mainSrc.slice(branchIdx, stmtEnd + 1);

  assert.ok(branch.includes('app.quit()'), 'the losing instance calls app.quit()');
  for (const forbidden of ['fork(', 'new BrowserWindow', 'killStalePort(']) {
    assert.ok(
      !branch.includes(forbidden),
      `the !gotTheLock branch must not contain ${JSON.stringify(forbidden)}`,
    );
  }
});

test('whenReady bails out without the lock before any boot work', () => {
  const whenReadyIdx = whenReadyCallIdx(mainSrc);
  // The guard must be the first statement of the callback — before the menu
  // install and the killStalePort() call, the two operations that damage the
  // running instance if they run without the lock.
  const menuCallIdx = mainSrc.indexOf('installApplicationMenu()', whenReadyIdx);
  assert.notEqual(menuCallIdx, -1, 'the menu install call is findable after whenReady');
  const body = mainSrc.slice(whenReadyIdx, menuCallIdx);
  assert.match(
    body,
    /if \(!gotTheLock\) return;/,
    'whenReady opens with `if (!gotTheLock) return;` — the quit-before-ready race guard',
  );
});

test("a second-instance handler exists and raises the existing window (show/focus)", () => {
  const handlerIdx = mainSrc.indexOf("app.on('second-instance'");
  assert.notEqual(handlerIdx, -1, "an app.on('second-instance', …) handler is registered");
  // Slice to the handler's closing `});` so the probes below cannot be
  // satisfied by unrelated code further down the file.
  const closeIdx = mainSrc.indexOf('\n});', handlerIdx);
  assert.notEqual(closeIdx, -1, 'the second-instance handler block closes');
  const body = mainSrc.slice(handlerIdx, closeIdx);

  // The gesture must reach the window: show and focus (the existing
  // showMainWindow() helper does both; calling it satisfies this by name).
  const reachesShow = /showMainWindow\(|\.show\(\)/.test(body);
  const reachesFocus = /showMainWindow\(|\.focus\(\)/.test(body);
  assert.ok(reachesShow, 'the handler reaches show (showMainWindow() or win.show())');
  assert.ok(reachesFocus, 'the handler reaches focus (showMainWindow() or win.focus())');
  // A minimized window must be restored before the show, or the show is a
  // no-op on some platforms.
  assert.ok(
    body.includes('win.isMinimized()'),
    'the handler restores a minimized window',
  );
});

test('killStalePort survives unchanged in purpose — the stale-backend cleanup stays', () => {
  // The lock makes killStalePort SAFE (any PID on the port at boot is a
  // crashed previous run's leftover); this ticket explicitly must not remove
  // or weaken it. Anchor: its declaration and its whenReady call both remain.
  const declIdx = mainSrc.indexOf('function killStalePort()');
  const callIdx = mainSrc.indexOf('killStalePort();', whenReadyCallIdx(mainSrc));
  assert.notEqual(declIdx, -1, 'killStalePort is still declared');
  assert.notEqual(callIdx, -1, 'killStalePort is still called from whenReady');
});
