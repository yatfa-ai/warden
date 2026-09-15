'use strict';

// Collision-proof atomic persistence for the Electron main process
// (WARDEN-1376 audit fix).
//
// WHY THIS EXISTS: WARDEN-1376 moved the main process's steady-state session
// persists (window-state, transmission-log) from synchronous writes to ASYNC
// ones so a slow create+write+rename (Windows real-time AV: hundreds of ms)
// can no longer block the loop the user is typing into. The first cut staged
// every write to ONE fixed `${filePath}.tmp`. That staging name was safe when
// every save was synchronous (one thread, sequential by construction), but the
// async move opened two interleavings on that single shared path (audit of
// PR #622):
//   (1) async × async — a maximize capture's write in flight while the pending
//       resize/move debounce fires: the second writer's open(tmp,'w') truncate
//       can land between the first writer's write and its rename → the renamed
//       file is EMPTY, or the two offset-0 writes interleave → torn fragments.
//       loadWindowState then JSON.parse-fails → defaults → the user's window
//       layout is silently lost.
//   (2) async × quit-sync — a debounced save in flight when the user quits:
//       the quit path runs the SYNC twin, and the stale async write can still
//       land over the final durable state.
// This module is the fix, shaped as the one mechanism all four writers share:
//
//   • UNIQUE PER-WRITE TEMP NAMES (the `tempPath` scheme from src/persist.js:
//     `${file}.${pid}.${Date.now(36)}.${counter}.tmp`) — two concurrent writers
//     stage on two different inodes, so neither's truncate/write can touch the
//     other's bytes. Torn/empty target files become impossible.
//   • A PER-TARGET GENERATION GATE — every write request (async or sync)
//     bumps the target's generation; a write whose generation was superseded
//     while it was in flight DISCARDS its own staging file at its land-step
//     instead of renaming. Combined with a per-target serialized land-step
//     (the renames of gate-passed writes execute in request order), this makes
//     LAST-REQUESTED-WINS the invariant: the file always ends holding the most
//     recently requested snapshot, never a stale predecessor that merely
//     finished later (the maximize-vs-debounce race) and never a stale async
//     write that outlived the quit path's sync twin.
//
// THE INVARIANT: the target file is never observed partial, and the content
// that lands last is always the snapshot that was REQUESTED last.
//
// ASYNC + SYNC: steady state uses write() (async — yields the loop; the whole
// point of WARDEN-1376). The terminal moments (window close, before-quit,
// powerMonitor 'shutdown') use writeSync(), which must land before the process
// exits and therefore cannot await the land-step chain. Both paths share the
// generation gate, so a writeSync() call supersedes any in-flight async write:
// an async write still in its (potentially slow) staging phase self-discards.
// BOUNDED RESIDUAL, stated honestly: an async write whose gate ALREADY passed
// (its rename submitted to the thread pool) in the same instant a writeSync
// lands can still execute its rename after the sync one — the file then holds
// a COMPLETE (parseable, never torn) but possibly stale snapshot. That window
// is submit-to-pool-execution (sub-millisecond) versus the whole-write window
// the gate removes (hundreds of ms under AV), and the pre-fix behavior in the
// same instant was a torn file. Close-to-impossible to hit, non-corrupting
// when hit; fixing it fully would mean making the quit path await, which
// Electron's synchronous teardown cannot.
//
// NO FSYNC: parity with the pre-existing writers (neither the old sync saves
// nor the first async cut fsynced). Rename atomicity is the bar here; the
// server-side store (src/persist.js) fsyncs because it is the durable config
// source — different bar, different module.
//
// PURE + INJECTABLE: `fs` (sync ops) and `fsp` (async ops) default to
// node:fs / node:fs.promises and can be injected, so the interleavings above
// are reproducible deterministically in web/atomic-persist.test.mjs with a
// fake fs — no real-disk timing races in tests. Errors PROPAGATE to the
// caller (mechanism, not policy): main.cjs's writers wrap every call in
// catch + warn because a persist failure must never break its host path.
// This module is required by main.cjs (CJS, no electron import) and never
// touches `app` at require time, so it is safe at module load.

const fs = require('node:fs');
const fsp = fs.promises;

// Per-process write counter so two writes in the same millisecond still get
// distinct temp paths (pid + ms + counter — the src/persist.js scheme).
let writeCounter = 0;
function tempPathFor(file) {
  const counter = (writeCounter++).toString(36);
  return `${file}.${process.pid}.${Date.now().toString(36)}.${counter}.tmp`;
}

/**
 * Create a collision-proof atomic writer. One instance per logical target is
 * the intended shape (main.cjs creates one for window-state, one for the
 * transmission log); the generation/chain state is keyed by absolute target
 * path, so a single instance shared across targets is also correct.
 *
 *   writer.write(filePath, text)    — async steady-state save. Resolves when
 *                                     the write has LANDED (or self-discarded
 *                                     as superseded). Rejects on fs error
 *                                     (after cleaning its staging file).
 *   writer.writeSync(filePath, text)— synchronous terminal-moment save.
 *                                     Supersedes in-flight async writes.
 *                                     Throws on fs error (caller guards).
 */
function createAtomicFileWriter(deps = {}) {
  const fsSync = deps.fs || fs;
  const fspAsync = deps.fsp || fsp;

  // Per-target state, keyed by target path:
  //   generations — bumped by EVERY write request; a write records its own
  //                 generation and is stale iff the key no longer equals it.
  //   landTails   — the tail of the per-target rename chain. Renames of
  //                 gate-passed writes are serialized through it so their
  //                 EXECUTION order equals their gate-pass (request) order.
  const generations = new Map();
  const landTails = new Map();

  function bump(file) {
    const next = (generations.get(file) || 0) + 1;
    generations.set(file, next);
    return next;
  }

  // Queue `step` behind the target's land-step chain. `.then(step, step)` (not
  // a rejection filter): one failed rename must never wedge the chain — the
  // NEXT write still gets to run its own step. The map entry is dropped when
  // the tail settles so idle targets do not accumulate promises.
  function enqueueLandStep(file, step) {
    const tail = (landTails.get(file) || Promise.resolve()).then(step, step);
    landTails.set(file, tail);
    const dropIfCurrent = () => {
      if (landTails.get(file) === tail) landTails.delete(file);
    };
    tail.then(dropIfCurrent, dropIfCurrent);
    return tail;
  }

  async function write(file, text) {
    const myGen = bump(file);
    const tmp = tempPathFor(file);
    try {
      await fspAsync.writeFile(tmp, text, 'utf8');
    } catch (err) {
      await fspAsync.unlink(tmp).catch(() => {}); // never leak the staging file
      throw err;
    }
    // Land-step (runs on the main thread, serialized per target): a write
    // superseded while its staging was in flight discards itself — a newer
    // request owns the target. Rename errors clean the staging file and
    // propagate to the caller.
    return enqueueLandStep(file, async () => {
      if (generations.get(file) !== myGen) {
        await fspAsync.unlink(tmp).catch(() => {});
        return;
      }
      try {
        await fspAsync.rename(tmp, file);
      } catch (err) {
        await fspAsync.unlink(tmp).catch(() => {});
        throw err;
      }
    });
  }

  function writeSync(file, text) {
    const myGen = bump(file); // supersedes any in-flight async write's gate
    const tmp = tempPathFor(file);
    try {
      fsSync.writeFileSync(tmp, text, 'utf8');
      // No gate check here and none needed: JS is single-threaded and there is
      // no await between bump and rename — no other request can interleave
      // inside a synchronous stretch.
      fsSync.renameSync(tmp, file);
    } catch (err) {
      try {
        fsSync.unlinkSync(tmp);
      } catch {
        /* best effort — never mask the original error */
      }
      throw err;
    }
  }

  return { write, writeSync };
}

module.exports = { createAtomicFileWriter, tempPathFor };
