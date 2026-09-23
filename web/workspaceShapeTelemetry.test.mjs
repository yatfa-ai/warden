// Tests for web/src/lib/workspaceShapeTelemetry.ts (WARDEN-1424) — the RENDERER
// producer of the workspace-shape COUNT snapshot (the paneLatency discipline:
// pure core with an injected clock + injected read; the browser-side singleton
// is inert under node --test).
//
// Pinned here:
//   • ONE event per window carrying the EXACT counts the injected read returns
//     — never a row per pane, per open/close, or per workspace switch;
//   • the window is CLOSED AND RESET by flush() — an interval flush + a
//     pagehide flush can never emit two events for one window's evidence;
//   • the peaks fold over a scripted change sequence (a burst of open-then-
//     close inside a window that ends quiet stays visible), and the closing
//     state carries into the next window's accumulators (a one-tick window is
//     still honestly peaked);
//   • LIVENESS — an all-zero workspace still produces the event (the snapshot
//     doubles as the consented liveness signal: silence then means app-closed
//     or consent-off, never "alive but idle");
//   • CONSENT is MAIN's gate — the end-to-end producer→receipt flow is proven
//     with a togglable consent wrapping the send exactly as main.cjs's receipt
//     wraps buildWorkspaceShapeEvent: consent ON records, consent OFF drops at
//     flush, a MID-FLIP revoke drops at the receipt;
//   • the flushed window validates against the REAL canonical schema (v8) and
//     the REAL main-process validator — the wire contract, not a restatement.
//
// The browser-side singleton wiring (setInterval/pagehide installation) is
// deliberately NOT exercised here (no DOM) — the pure core is the contract.
//
// Run: node --test workspaceShapeTelemetry.test.mjs   (from web/)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { transformWithOxc } from 'vite';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// --- Load the REAL producer (TS -> ESM via the OXC transform Vite bundles) ---
const libPath = resolve(__dirname, 'src/lib/workspaceShapeTelemetry.ts');
const { code } = await transformWithOxc(readFileSync(libPath, 'utf8'), libPath, {});
const tmpDir = mkdtempSync(join(tmpdir(), 'warden-workspaceshape-test-'));
const tmpFile = join(tmpDir, 'workspaceShapeTelemetry.mjs');
writeFileSync(tmpFile, code);
const { createWorkspaceShapeSampler, WORKSPACE_SHAPE_FLUSH_MS, getWorkspaceShapeSampler, __resetWorkspaceShapeSingletonForTests } = await import(tmpFile);
try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }

// --- Load the REAL canonical schema + the REAL main-process validator ---------
const schemaPath = resolve(__dirname, 'src/lib/telemetry/schema.ts');
const { code: schemaCode } = await transformWithOxc(readFileSync(schemaPath, 'utf8'), schemaPath, {});
const schemaDir = mkdtempSync(join(tmpdir(), 'warden-workspaceshape-schema-'));
const schemaFile = join(schemaDir, 'schema.mjs');
writeFileSync(schemaFile, schemaCode);
const { SCHEMA_VERSION, validateEvent } = await import(schemaFile);
try { rmSync(schemaDir, { recursive: true, force: true }); } catch { /* best-effort */ }
const { validateBaseEvent } = require('../electron/telemetry-source.cjs');

// Controllable fake clock — ONE timeline drives BOTH the sampling clock
// (`now`) and the epoch stamp clock (`stamp`), so window rotation is
// deterministic under test.
function makeClock() {
  let t = 1_000_000;
  return { now: () => t, stamp: () => t, advance: (ms) => { t += ms; } };
}

const COUNTS = (workspaces, panesOpen, panesActive, chats) =>
  ({ workspaces, panesOpen, panesActive, chats });

test('ONE event per window carries the exact counts — and validates against the REAL v8 schema', () => {
  const clock = makeClock();
  const sent = [];
  const sampler = createWorkspaceShapeSampler({
    stampNow: clock.stamp,
    read: () => COUNTS(3, 7, 4, 12),
  });
  clock.advance(WORKSPACE_SHAPE_FLUSH_MS);
  const win = sampler.flush();
  assert.equal(sent.length, 0, 'the sampler does not send by itself');
  assert.equal(win.workspaces, 3);
  assert.equal(win.panesOpen, 7);
  assert.equal(win.panesActive, 4);
  assert.equal(win.chats, 12);
  assert.equal(win.peakPanesOpen, 7, 'the closing state IS part of the window (seed + close fold)');
  assert.equal(win.peakChats, 12);
  assert.equal(typeof win.startedAt, 'number');
  assert.equal(typeof win.endedAt, 'number');
  // The REAL wire contract — both validators, the exact shapes main builds from.
  const event = {
    schemaVersion: SCHEMA_VERSION,
    type: 'workspace-shape',
    runtime: 'renderer',
    timestamp: Date.now(),
    windowStartedAt: win.startedAt,
    windowEndedAt: win.endedAt,
    workspaces: win.workspaces,
    panesOpen: win.panesOpen,
    panesActive: win.panesActive,
    chats: win.chats,
    peakPanesOpen: win.peakPanesOpen,
    peakChats: win.peakChats,
  };
  assert.equal(validateEvent(event), true, 'the canonical v8 schema validates the flushed window');
  assert.equal(validateBaseEvent(event), true, 'the main-process validator agrees');
});

test('flush closes AND resets — interval + pagehide can never double-count one window', () => {
  const clock = makeClock();
  let state = COUNTS(1, 2, 2, 3);
  const sampler = createWorkspaceShapeSampler({ stampNow: clock.stamp, read: () => state });
  clock.advance(WORKSPACE_SHAPE_FLUSH_MS);
  const first = sampler.flush();
  assert.equal(first.workspaces, 1);
  // The window rotated: the next flush reports the NEXT window's evidence only.
  state = COUNTS(5, 9, 4, 8);
  clock.advance(WORKSPACE_SHAPE_FLUSH_MS);
  const second = sampler.flush();
  assert.equal(second.workspaces, 5, 'the second window reports only its own closing state');
  assert.equal(second.startedAt >= first.endedAt, true, 'windows never overlap');
  assert.notEqual(second.startedAt, first.startedAt, 'the stamp rotated with the window');
});

test('peaks fold over a scripted change sequence — an open-then-close burst stays visible', () => {
  const clock = makeClock();
  let state = COUNTS(1, 2, 2, 4);
  const sampler = createWorkspaceShapeSampler({ stampNow: clock.stamp, read: () => state });
  // A burst: nine panes open, then eight close again before the window ends.
  sampler.tick(); // seed observed at construct; tick with 2
  state = COUNTS(1, 9, 4, 4); sampler.tick();
  state = COUNTS(1, 9, 4, 4); sampler.tick();
  state = COUNTS(1, 1, 1, 4); sampler.tick();
  const win = sampler.flush(); // closing state 1/1/1/4
  assert.equal(win.panesOpen, 1, 'the window CLOSED on the quiet state');
  assert.equal(win.peakPanesOpen, 9, 'and the burst is still visible in the peak');
  assert.equal(win.peakChats, 4);
  // The peak is a WINDOW fact: the next window's peak starts from ITS OWN
  // evidence, seeded with the closing state — never from the old burst.
  const next = sampler.flush();
  assert.equal(next.peakPanesOpen, 1, 'the old burst does not leak into the next window');
});

test('an all-zero workspace still produces the event — the liveness signal', () => {
  const clock = makeClock();
  const sampler = createWorkspaceShapeSampler({
    stampNow: clock.stamp,
    read: () => COUNTS(0, 0, 0, 0),
  });
  const win = sampler.flush();
  assert.equal(win.workspaces, 0);
  assert.equal(win.chats, 0);
  assert.equal(win.peakChats, 0);
  assert.equal(
    validateEvent({
      schemaVersion: SCHEMA_VERSION, type: 'workspace-shape', runtime: 'renderer',
      timestamp: 1, windowStartedAt: win.startedAt, windowEndedAt: win.endedAt,
      workspaces: 0, panesOpen: 0, panesActive: 0, chats: 0, peakPanesOpen: 0, peakChats: 0,
    }),
    true,
    'a zero workspace is a VALID snapshot — the event doubles as the consented liveness signal',
  );
});

test('a throwing read never breaks the window — it folds as the empty observation', () => {
  const clock = makeClock();
  let boom = false;
  const sampler = createWorkspaceShapeSampler({
    stampNow: clock.stamp,
    read: () => { if (boom) throw new Error('refs torn down'); return COUNTS(1, 1, 1, 1); },
  });
  boom = true;
  const win = sampler.flush();
  assert.equal(win.workspaces, 0, 'the failing tick reports nothing observed');
  assert.equal(win.peakPanesOpen, 1, 'the seed observation (before the failure) still bounds the peak');
});

// ==========================================================================
// The end-to-end consent flow: producer → MAIN's receipt gate → event.
// The producer forwards aggregates only; the consent gate is MAIN's receipt
// (the same double gate every renderer window rides). This models it with a
// togglable consent wrapping the send exactly as main.cjs does.
// ==========================================================================

function wiredProducer({ consent }) {
  const clock = makeClock();
  const recorded = [];
  const sampler = createWorkspaceShapeSampler({
    stampNow: clock.stamp,
    read: () => COUNTS(2, 4, 3, 6),
  });
  // main.cjs's receipt, verbatim in shape: refuse unless the category is on,
  // then build + record (the field mapping is exactly buildWorkspaceShapeEvent's:
  // startedAt/endedAt ride the wire as windowStartedAt/windowEndedAt). A revoked
  // window lands here MID-FLIP and is dropped.
  const receipt = (win) => {
    if (consent() !== true) return; // the mid-flip drop
    recorded.push({
      schemaVersion: SCHEMA_VERSION,
      type: 'workspace-shape',
      runtime: 'renderer',
      timestamp: clock.now(),
      windowStartedAt: win.startedAt,
      windowEndedAt: win.endedAt,
      workspaces: win.workspaces,
      panesOpen: win.panesOpen,
      panesActive: win.panesActive,
      chats: win.chats,
      peakPanesOpen: win.peakPanesOpen,
      peakChats: win.peakChats,
    });
  };
  return { clock, sampler, recorded, flush: () => receipt(sampler.flush()) };
}

test('consent ON: exactly ONE v8-valid event per window', () => {
  let on = true;
  const p = wiredProducer({ consent: () => on });
  p.flush();
  assert.equal(p.recorded.length, 1, 'one event, not one per pane/chat/workspace');
  assert.equal(validateEvent(p.recorded[0]), true);
  p.clock.advance(WORKSPACE_SHAPE_FLUSH_MS);
  p.flush();
  assert.equal(p.recorded.length, 2, 'the next window produces exactly one more');
});

test('consent OFF (the default): the window is dropped at flush — zero events, zero retention', () => {
  const p = wiredProducer({ consent: () => false });
  p.flush();
  p.clock.advance(WORKSPACE_SHAPE_FLUSH_MS);
  p.flush();
  assert.equal(p.recorded.length, 0, 'nothing recorded while off');
});

test('MID-FLIP revoke: a window in flight is dropped at the RECEIPT (the double gate closes)', () => {
  let on = true;
  const p = wiredProducer({ consent: () => on });
  p.flush();
  assert.equal(p.recorded.length, 1);
  on = false; // the user revokes AFTER a window was in flight
  p.flush();
  assert.equal(p.recorded.length, 1, 'the in-flight window is refused at the receipt');
  assert.equal(validateEvent(p.recorded[0]), true, 'what WAS recorded under consent stays valid');
});

// ==========================================================================
// The singleton — inert under node --test (no window), no-op without a bridge
// ==========================================================================

test('the singleton is inert under node --test and no-ops without a bridge', () => {
  __resetWorkspaceShapeSingletonForTests();
  const sent = [];
  // No `window` exists under node --test, so the wiring adds no timers and no
  // pagehide listener; the sampler still folds (bounded), and with no
  // sendWindow the flush is a local no-op — exactly the paneLatency posture.
  const s = getWorkspaceShapeSampler({
    read: () => COUNTS(1, 1, 1, 1),
  });
  const win = s.sampler.flush();
  assert.equal(win.workspaces, 1, 'the window still folds without a bridge');
  assert.equal(sent.length, 0, 'and ships nothing');
  __resetWorkspaceShapeSingletonForTests();
});
