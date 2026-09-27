// WARDEN-1466 — STATIC SOURCE GUARD for the workspace-shape PEAKS' event-driven
// tick.
//
// WHY THIS FILE EXISTS: the workspace-shape producer (WARDEN-1424) promises
// per-window peaks (peakPanesOpen / peakChats) "so an open-then-close burst
// inside a window that ended on a quiet state is still visible". Through
// WARDEN-1466 the ONLY method that folds an intra-window observation into the
// peak accumulators was `tick()` (workspaceShapeTelemetry.ts) — and NOTHING in
// production called it: the singleton's interval and pagehide both call
// `flush()`, which folds only the closing sample, so every shipped peak
// degenerated to max(open-sample, close-sample) — a 9-pane burst that closed
// before the window ended shipped `peakPanesOpen: 1`, and the loss is
// undetectable on the wire (the validators only enforce peak >= closing).
//
// The pure-core burst test in workspaceShapeTelemetry.test.mjs drives `tick()`
// BY HAND, so it proves the core can fold a burst but never checks that
// anything drives it — the suite stayed green through the whole outage.
//
// This repo has no React/DOM test runner, and the singleton wiring is inert
// under `node --test` (no `window`), so the WIRING is pinned the way this repo
// pins component-embedded behavior: a static source assertion over App.tsx
// (precedent: web/esm-import-specifier.test.mjs, web/lastCloseGuard.test.mjs,
// web/sessionTagCap.test.mjs). The guard pins exactly what makes the peaks
// real: a production `sampler.tick()` call inside a `useEffect` whose
// dependency array is keyed on BOTH changing inputs (workspaces, chats),
// declared after the build-once singleton effect (the first tick must meet a
// sampler that already holds the real `read()`) and after the chatsRef sync
// effect (the first tick must see fresh counts).
//
// Mutation check: delete the tick effect (or its dependency array) in App.tsx
// and this file goes red.
//
// Auto-discovered by `npm test` in web/ (`node --test`).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));

const appSrc = readFileSync(resolve(__dirname, 'src', 'App.tsx'), 'utf8');

const COUNTS = (workspaces, panesOpen, panesActive, chats) =>
  ({ workspaces, panesOpen, panesActive, chats });

// Locates the tick effect: the first `.sampler.tick()` AFTER the build-once
// `getWorkspaceShapeSampler({...})` singleton creation, plus its enclosing
// `useEffect(...)`. Returns the effect source.
function workspaceShapeTickEffect(src) {
  const creatorIdx = src.indexOf('getWorkspaceShapeSampler(');
  assert.notEqual(creatorIdx, -1, 'the build-once workspace-shape singleton creation is findable in App.tsx');
  const tickIdx = src.indexOf('.sampler.tick()', creatorIdx);
  assert.notEqual(tickIdx, -1, 'a production caller of the workspace-shape sampler tick() exists AFTER the singleton creation');
  const effectStart = src.lastIndexOf('useEffect(', tickIdx);
  assert.notEqual(effectStart, -1, 'the tick() call sits inside a useEffect');
  return src.slice(effectStart, tickIdx + 600);
}

test('the workspace-shape sampler is ticked from an event-driven effect keyed on workspaces AND chats', () => {
  const effect = workspaceShapeTickEffect(appSrc);

  // The dependency array is the WHOLE contract: workspaces and chats are the
  // only reactive inputs the shape counts change through (the read closure
  // reads refs), so the array must be exactly [workspaces, chats]. A `[]`
  // array or a partial key is the silent regression: the tick stops riding the
  // changes and the peaks degenerate back to max(open, close).
  const depMatch = /\}\s*,\s*\[([^\]]*)\]\s*\)/.exec(effect);
  assert.notEqual(depMatch, null, 'the tick effect closes with a dependency array');
  const deps = depMatch[1].split(',').map((d) => d.trim()).filter(Boolean);
  assert.deepEqual(deps, ['workspaces', 'chats'],
    'the tick effect must be keyed on BOTH changing inputs (workspaces, chats)');
});

test('the tick effect is ordered after the singleton creation and the chatsRef sync effect', () => {
  const creatorIdx = appSrc.indexOf('getWorkspaceShapeSampler(');
  const tickIdx = appSrc.indexOf('.sampler.tick()', creatorIdx);
  const effectStart = appSrc.lastIndexOf('useEffect(', tickIdx);
  // React runs effects in declaration order. The chatsRef sync effect must be
  // declared EARLIER so the first tick's read() sees the fresh counts, and the
  // build-once creation earlier still so the singleton already holds the real
  // read closure (the no-arg re-fetch relies on the build-once singleton).
  const chatsRefIdx = appSrc.indexOf('chatsRef.current = chats');
  assert.notEqual(chatsRefIdx, -1, 'the chatsRef sync effect is findable in App.tsx');
  assert.ok(chatsRefIdx < effectStart,
    'the chatsRef sync effect must be declared BEFORE the tick effect (the first tick reads fresh counts)');
  assert.ok(creatorIdx < effectStart,
    'the singleton creation effect must be declared BEFORE the tick effect (the first tick meets the real read)');
});

// ---------------------------------------------------------------------------
// The mechanism the App effect relies on, as executable proof: the tick calls
// `getWorkspaceShapeSampler()` with NO arguments and expects the build-once
// singleton — the same instance that holds the REAL `read` closure. Pin that
// identity against the REAL module (the pure core is tested in
// workspaceShapeTelemetry.test.mjs; this is the re-fetch semantics).
// ---------------------------------------------------------------------------

test('the no-arg getWorkspaceShapeSampler() re-fetch returns the SAME build-once instance with the real read', async () => {
  const { transformWithOxc } = await import('vite');
  const libPath = resolve(__dirname, 'src', 'lib', 'workspaceShapeTelemetry.ts');
  const { code } = await transformWithOxc(readFileSync(libPath, 'utf8'), libPath, {});
  const tmpDir = mkdtempSync(join(tmpdir(), 'warden-shape-tick-guard-'));
  const tmpFile = join(tmpDir, 'workspaceShapeTelemetry.mjs');
  writeFileSync(tmpFile, code);
  const { getWorkspaceShapeSampler, __resetWorkspaceShapeSingletonForTests } = await import(tmpFile);
  try {
    __resetWorkspaceShapeSingletonForTests();
    let chats = 2;
    // App's build-once creation: singleton armed with the REAL read closure.
    const created = getWorkspaceShapeSampler({ read: () => COUNTS(1, 1, 1, chats) });
    // App's tick effect: the NO-ARG call. It must return the same instance —
    // if it built a second sampler on the zero-count default read, every tick
    // would fold nothing and the peaks would silently die again.
    const refetched = getWorkspaceShapeSampler();
    assert.equal(refetched, created, 'the no-arg call returns the build-once singleton (the default read does NOT replace the real one)');
    // A count changes in the app state; the tick through the REFETCHED handle
    // must see it through the real closure and fold it into the peaks.
    chats = 9;
    refetched.sampler.tick();
    const win = created.sampler.flush();
    assert.equal(win.chats, 9, 'the tick folded the changed count through the real read');
    assert.equal(win.peakChats, 9, 'and the peak accumulator saw it');
  } finally {
    __resetWorkspaceShapeSingletonForTests();
    rmSync(tmpDir, { recursive: true, force: true });
  }
});
