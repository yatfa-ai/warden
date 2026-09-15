'use strict';

// SESSION-PERSIST — the main process's ordered async atomic writer (WARDEN-1376).
//
// WHY THIS EXISTS: every session-time persist in the Electron MAIN process —
// the debounced telemetry-transmission-log save after each send (WARDEN-782)
// and the debounced window-state capture after each resize/move (WARDEN-263) —
// used to run `writeFileSync` + `renameSync` ON THE MAIN THREAD. Main's JS
// event loop IS Chromium's browser UI thread, so each of those writes froze
// input delivery for its duration; on win32, filter drivers / antivirus scans
// routinely stretch a small JSON rename into the multi-second regime the main
// heartbeat records as `stall:event-loop` (WARDEN-1376's telemetry-confirmed
// freezes). The fix at the root: session-time writes leave the critical path
// (async), while exit-path writes stay synchronous — on the quit path a
// blocking write is invisible (the process is going away) and durability there
// is load-bearing, which an async write could NOT promise (app.quit() does not
// wait for a pending promise).
//
// ORDERING: async whole-file rewrites can now overlap, and a same-named tmp
// file under two concurrent writers would let a rename pair with the wrong
// bytes. This module therefore SERIALIZES async writes through a promise chain:
// one write in flight at a time, applied in call order, failures logged and
// skipped without wedging the chain. Callers that need the value on disk before
// the process dies call `persistSync` (quit/flush paths).
//
// CALLER CONTRACT: `next` is the ALREADY-DECIDED state — callers derive it from
// their in-memory truth and update that truth synchronously at call time, so
// the queue can never write a stale snapshot (the value was final when it was
// enqueued). Zero electron imports, injectable writers, never throws — the
// same testability + defensive discipline as window-state.cjs and
// telemetry-transmission-log.cjs.

function createSessionPersister(opts) {
  const o = opts || {};
  const writeAsync = typeof o.writeAsync === 'function' ? o.writeAsync : null;
  const writeSync = typeof o.writeSync === 'function' ? o.writeSync : null;
  const onError = typeof o.onError === 'function' ? o.onError : () => {};

  let chain = Promise.resolve();
  let pending = 0;

  // Enqueue one ordered async write. The chain step never rejects (a rejection
  // here would poison every later write); failures surface through onError and
  // the chain continues with the next write. A missing writeAsync is a
  // PROGRAMMING error (a mis-wired main.cjs) and fails fast at the call site —
  // it never enters the chain.
  function persist(next) {
    if (typeof o.writeAsync !== 'function') {
      throw new TypeError('createSessionPersister: writeAsync dependency is required');
    }
    pending += 1;
    const step = () =>
      Promise.resolve()
        .then(() => writeAsync(next))
        .then(
          () => {},
          (e) => {
            try {
              onError(e);
            } catch {
              /* an error listener must never break the persist chain */
            }
          },
        );
    chain = chain.then(step, step);
    const settled = () => {
      pending -= 1;
    };
    chain.then(settled, settled);
    return chain;
  }

  // Materialize `next` synchronously (exit/flush paths). A failure is reported
  // through onError and swallowed — a persist failure must never break the
  // quit path (the same contract saveWindowState/saveTransmissionLog had). A
  // missing writeSync fails fast at the call site, same as persist.
  function persistSync(next) {
    if (typeof o.writeSync !== 'function') {
      throw new TypeError('createSessionPersister: writeSync dependency is required');
    }
    try {
      writeSync(next);
    } catch (e) {
      try {
        onError(e);
      } catch {
        /* never propagate out of a persist */
      }
    }
  }

  // How many async writes are not yet settled (diagnostics/tests only).
  function inFlight() {
    return pending;
  }

  // Resolve when every enqueued async write has settled (tests only — the quit
  // path deliberately does NOT wait, it writes synchronously instead).
  function idle() {
    return chain.then(() => {});
  }

  return { persist, persistSync, inFlight, idle };
}

module.exports = { createSessionPersister };
