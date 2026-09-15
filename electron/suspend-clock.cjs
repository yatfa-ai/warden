'use strict';

// Pure suspend-window tracker (WARDEN-1376).
//
// WHY THIS EXISTS: the main-process event-loop heartbeat (telemetry-source.cjs)
// measures wall-clock lag between ticks, and a SUSPENDED process looks identical
// to a BLOCKED one — the first tick after the machine wakes is overdue by the
// whole sleep duration. Live telemetry shows exactly this: 6 of 9 retained
// main-runtime `performance-stall` events carry lagMs between 44 minutes and
// 12 hours (sleep/wake artifacts), and 2 of the 3 human-scale events fired at
// the same wall-clock second as a wake — the OS resume storm, not warden work.
// Electron's powerMonitor ('suspend'/'resume') is the only signal that
// DISTINGUISHES the two regimes, so main.cjs wires those events into this
// tracker and both stall detectors (the telemetry heartbeat and the local
// attribution monitor) consult it before reporting a stall.
//
// PURE + INJECTABLE: the clock is injected, no Electron import, no fs — the
// module is unit-testable under node --test (web/suspend-clock.test.mjs) and
// main.cjs wires the live powerMonitor events to it, same split as
// window-state.cjs / crash-sentinel.cjs.
//
// SEMANTICS: a suspend window is [suspendedAt, resumedAt]. A stall whose
// overdue gap (from, to) OVERLAPS a suspend window — including a still-open
// one (suspended, not yet resumed: the machine went down mid-window) — is a
// suspension artifact, not a loop block. The overlap test is
// `suspendedAt < to && resumedAt >= from`: a block that ENDS exactly at the
// resume instant is the wake tick itself, and a block that STARTS exactly at
// the resume instant is the resume storm (disk spin-up, driver re-init, AV
// rescan) — both belong to the OS, not to warden work. Strict on the
// suspend-start boundary only: a block ending exactly when the suspend began
// is causally pre-suspend and stays reportable.

// Bounded history: a long-lived session accumulates suspend windows (lid
// closes, Modern Standby doze cycles); 512 covers weeks of sleep cycles at a
// few hundred bytes each, and the oldest drop once the cap is hit. The query
// below scans the retained windows — bounded work on a 1/s tick path.
const DEFAULT_MAX_WINDOWS = 512;

function createSuspendClock(opts) {
  const o = opts || {};
  const now =
    typeof o.now === 'function'
      ? o.now
      : () => Date.now();
  const maxWindows =
    Number.isInteger(o.maxWindows) && o.maxWindows > 0 ? o.maxWindows : DEFAULT_MAX_WINDOWS;

  // Closed suspend windows, oldest first: { from, to }.
  const windows = [];
  // The in-flight suspend, if the machine is (as far as we know) down. At most
  // one can be open — a 'suspend' while already suspended is the OS repeating
  // itself, not a second concurrent sleep.
  let openFrom = null;

  function onSuspend() {
    if (openFrom != null) return; // idempotent: already suspended
    openFrom = now();
  }

  function onResume() {
    if (openFrom == null) return; // a resume with no tracked suspend — ignore
    const from = openFrom;
    openFrom = null;
    const to = now();
    windows.push({ from, to });
    while (windows.length > maxWindows) windows.shift();
  }

  // True iff the half-open query range (from, to) overlaps any suspend window
  // — including one still open (the machine suspended inside the range and
  // has not woken yet, or the resume event has not been delivered yet).
  // Boundary semantics (see the header comment): touching the RESUME instant
  // counts (wake tick / resume storm); touching the SUSPEND instant does not
  // (that block finished before the machine went down). Never throws: a
  // diagnostic must not be able to break the tick that asks.
  function spansSuspend(from, to) {
    if (typeof from !== 'number' || typeof to !== 'number') return false;
    if (!(to > from)) return false;
    if (openFrom != null && openFrom < to) return true;
    for (const w of windows) {
      if (w.from < to && w.to >= from) return true;
    }
    return false;
  }

  // Test/inspection seam: how many closed windows are retained + whether one
  // is currently open.
  function stats() {
    return { closedWindows: windows.length, suspendedNow: openFrom != null };
  }

  return { onSuspend, onResume, spansSuspend, stats };
}

module.exports = { createSuspendClock, DEFAULT_MAX_WINDOWS };
