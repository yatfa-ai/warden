// Unit tests for the collision-proof atomic persistence writers
// (electron/atomic-persist.cjs — the WARDEN-1376 audit fix).
//
// The audit of PR #622 found that the main process's session-persist writers
// staged every write to ONE fixed `${filePath}.tmp`. Safe while every save was
// synchronous (sequential by construction), but WARDEN-1376's async move
// opened two interleavings on that shared path:
//   (1) async × async — a maximize capture's write in flight while the pending
//       resize/move debounce fires → the second writer's truncate lands between
//       the first writer's write and its rename → EMPTY/torn target file
//       (loadWindowState then JSON.parse-fails → defaults → layout lost).
//   (2) async × quit-sync — a debounced save in flight at quit racing the SYNC
//       twin that exists precisely so the final state is durable before exit.
// The fix: unique per-write temp names (torn writes impossible) + a per-target
// generation gate with a serialized land-step (LAST-REQUESTED-WINS — a write
// superseded while in flight discards itself instead of landing stale bytes).
//
// The module injects `fs`/`fsp`, so the interleavings above are reproduced
// here DETERMINISTICALLY with a fake fs whose async staging can be held and
// released on command — no real-disk timing races. Like
// web/telemetry-transmission-log.test.mjs (the established pattern for
// "main-process CJS module required from web/"), it loads the REAL module via
// createRequire. Auto-discovered by `npm test` in web/ (`node --test`).
//
// Run: node atomic-persist.test.mjs   (from web/)
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { createAtomicFileWriter, tempPathFor } = require('../electron/atomic-persist.cjs');

let passed = 0;
const test = (name, fn) => {
  fn();
  passed += 1;
  console.log('  ok -', name);
};

// Drain pending microtasks (the module's chain steps run as promise
// continuations) without real timers.
const flush = () => new Promise((r) => setImmediate(r));

// ---------------------------------------------------------------------------
// Fake fs: records every op, keeps a path→content map, and can HOLD the async
// staging writes (deferred until releaseStaging) or fail the next op on demand.
// The sync half ignores the hold — exactly like the real quit path, which must
// land synchronously while async writes are still in flight.
// ---------------------------------------------------------------------------
function createFakeFs() {
  const files = new Map();
  const calls = {
    staged: [],
    renamed: [],
    unlinked: [],
    stagedSync: [],
    renamedSync: [],
    unlinkedSync: [],
  };
  let holding = false;
  let held = [];
  let holdingLands = false;
  let heldLands = [];
  let failNextWrite = false;
  let failNextRename = false;
  let failNextSyncWrite = false;

  const defer = () => {
    let resolve;
    const promise = new Promise((r) => { resolve = r; });
    return { promise, resolve };
  };

  const fsp = {
    writeFile(p, text) {
      calls.staged.push(p);
      if (failNextWrite) { failNextWrite = false; return Promise.reject(new Error('EACCES: disk on fire')); }
      if (!holding) { files.set(p, text); return Promise.resolve(); }
      const gate = defer();
      held.push({ gate, p, text });
      return gate.promise.then(() => { files.set(p, text); });
    },
    async rename(from, to) {
      calls.renamed.push([from, to]);
      if (failNextRename) { failNextRename = false; throw new Error('EIO: rename refused'); }
      if (!files.has(from)) throw new Error(`ENOENT: ${from}`);
      if (holdingLands) {
        const gate = defer();
        heldLands.push({ gate, from, to });
        await gate.promise;
      }
      files.set(to, files.get(from));
      files.delete(from);
    },
    async unlink(p) {
      calls.unlinked.push(p);
      files.delete(p);
    },
  };
  const fs = {
    writeFileSync(p, text) {
      calls.stagedSync.push(p);
      if (failNextSyncWrite) { failNextSyncWrite = false; throw new Error('EACCES: disk on fire (sync)'); }
      files.set(p, text);
    },
    renameSync(from, to) {
      calls.renamedSync.push([from, to]);
      if (!files.has(from)) throw new Error(`ENOENT: ${from}`);
      files.set(to, files.get(from));
      files.delete(from);
    },
    unlinkSync(p) {
      calls.unlinkedSync.push(p);
      files.delete(p);
    },
  };

  return {
    fsp,
    fs,
    files,
    calls,
    holdStaging() { holding = true; },
    releaseStaging() {
      holding = false;
      for (const h of held) h.gate.resolve();
      held = [];
    },
    holdLands() { holdingLands = true; },
    releaseLands() {
      holdingLands = false;
      for (const h of heldLands) h.gate.resolve();
      heldLands = [];
    },
    failNextWriteNow() { failNextWrite = true; },
    failNextRenameNow() { failNextRename = true; },
    failNextSyncWriteNow() { failNextSyncWrite = true; },
  };
}

// ==========================================================================
// tempPathFor — unique per-write staging names (the torn-write fix)
// ==========================================================================

test('tempPathFor yields a DISTINCT staging path for every write (same ms included)', () => {
  const seen = new Set();
  for (let i = 0; i < 50; i++) seen.add(tempPathFor('/data/state.json'));
  assert.equal(seen.size, 50, 'no collision even within one millisecond');
  const [first] = seen;
  assert.ok(first.includes(String(process.pid)), 'staging name embeds the pid');
  assert.ok(first.endsWith('.tmp'), 'staging name is a .tmp sibling');
  assert.ok(first.startsWith('/data/state.json'), 'staging name sits beside its target');
});

// ==========================================================================
// Happy paths — content lands, staging file consumed
// ==========================================================================

test('write() lands the content at the target (async happy path)', async () => {
  const fake = createFakeFs();
  const w = createAtomicFileWriter({ fs: fake.fs, fsp: fake.fsp });
  await w.write('/data/a.json', 'AAA');
  assert.equal(fake.files.get('/data/a.json'), 'AAA');
  assert.equal(fake.calls.renamed.length, 1, 'exactly one rename executed');
  assert.equal(fake.calls.staged.length, 1);
  assert.equal(fake.files.size, 1, 'staging file consumed by the rename');
});

test('writeSync() lands the content at the target (sync happy path)', () => {
  const fake = createFakeFs();
  const w = createAtomicFileWriter({ fs: fake.fs, fsp: fake.fsp });
  w.writeSync('/data/b.json', 'BBB');
  assert.equal(fake.files.get('/data/b.json'), 'BBB');
  assert.equal(fake.calls.renamedSync.length, 1);
  assert.equal(fake.files.size, 1, 'staging file consumed by the rename');
});

test('sequential writes land in request order (last requested wins)', async () => {
  const fake = createFakeFs();
  const w = createAtomicFileWriter({ fs: fake.fs, fsp: fake.fsp });
  await w.write('/data/c.json', 'first');
  await w.write('/data/c.json', 'second');
  await w.write('/data/c.json', 'third');
  assert.equal(fake.files.get('/data/c.json'), 'third');
});

// ==========================================================================
// Interleave (1) from the audit — async × async, ordinary steady state.
// The maximize capture starts staging (slow AV write), the pending debounce
// write is requested and finishes first. Pre-fix: torn/empty file or a stale
// last-FINISHED-wins overwrite. Post-fix: the superseded write discards itself.
// ==========================================================================

test('a write superseded while staging is in flight DISCARDS itself (last-requested-wins)', async () => {
  const fake = createFakeFs();
  const w = createAtomicFileWriter({ fs: fake.fs, fsp: fake.fsp });
  fake.holdStaging();

  const slowOld = w.write('/data/d.json', 'OLD-SNAPSHOT'); // requested first, will finish last
  const fastNew = w.write('/data/d.json', 'NEW-SNAPSHOT'); // requested second, finishes first
  assert.equal(fake.calls.staged.length, 2, 'both writes staged');
  assert.notEqual(fake.calls.staged[0], fake.calls.staged[1], 'each write stages on its OWN tmp path (no shared fixed .tmp)');

  fake.releaseStaging();
  await Promise.all([slowOld, fastNew]);

  assert.equal(fake.files.get('/data/d.json'), 'NEW-SNAPSHOT', 'the LAST-REQUESTED snapshot is what landed');
  const renamedTargets = fake.calls.renamed.map(([from]) => from);
  assert.ok(!renamedTargets.includes(fake.calls.staged[0]), 'the superseded write NEVER renamed');
  assert.ok(renamedTargets.includes(fake.calls.staged[1]), 'the newer write renamed');
  assert.ok(fake.calls.unlinked.includes(fake.calls.staged[0]), 'the superseded write cleaned up its own staging file');
  assert.equal(fake.files.size, 1, 'no staging file left behind');
});

test('a burst of overlapping writes lands exactly the LAST-REQUESTED content (one rename)', async () => {
  const fake = createFakeFs();
  const w = createAtomicFileWriter({ fs: fake.fs, fsp: fake.fsp });
  fake.holdStaging();

  // The maximize × debounce × resize shape: several saves requested in quick
  // succession, all still staging when the later ones arrive.
  const pending = [
    w.write('/data/e.json', 'T1'),
    w.write('/data/e.json', 'T2'),
    w.write('/data/e.json', 'T3'),
    w.write('/data/e.json', 'T4'),
    w.write('/data/e.json', 'T5'),
  ];
  fake.releaseStaging();
  await Promise.all(pending);

  assert.equal(fake.files.get('/data/e.json'), 'T5', 'the last-requested snapshot won');
  assert.equal(fake.calls.renamed.length, 1, 'every earlier write self-discarded — only the newest renamed');
  assert.equal(fake.calls.unlinked.length, 4, 'the four superseded writes cleaned their staging files');
  assert.equal(fake.files.size, 1, 'no staging file left behind');
});

test('non-superseded overlapping writes land in request order (chain keeps execution ordered)', async () => {
  const fake = createFakeFs();
  const w = createAtomicFileWriter({ fs: fake.fs, fsp: fake.fsp });
  // No hold: both stage instantly, but the land-steps still go through the
  // serialized chain — execution order must equal request order.
  const p1 = w.write('/data/f.json', 'first');
  const p2 = w.write('/data/f.json', 'second');
  await Promise.all([p1, p2]);
  assert.equal(fake.files.get('/data/f.json'), 'second', 'the chain landed them in request order, not completion order');
});

// ==========================================================================
// Interleave (2) from the audit — async × quit-sync. A debounced save is in
// its slow staging phase when the user quits; the quit path runs the SYNC twin
// so the final state is durable before exit. The stale async write must
// discard itself instead of overwriting the final state.
// ==========================================================================

test('a writeSync at quit supersedes an in-flight async write (the final state survives)', async () => {
  const fake = createFakeFs();
  const w = createAtomicFileWriter({ fs: fake.fs, fsp: fake.fsp });
  fake.holdStaging();

  const inFlight = w.write('/data/g.json', 'STALE-DEBOUNCED'); // in flight when quit happens
  w.writeSync('/data/g.json', 'FINAL-AT-QUIT'); // the sync twin lands immediately
  assert.equal(fake.files.get('/data/g.json'), 'FINAL-AT-QUIT', 'the sync twin landed before the async write finished');

  fake.releaseStaging();
  await inFlight;

  assert.equal(fake.files.get('/data/g.json'), 'FINAL-AT-QUIT', 'the stale async write did NOT overwrite the quit-path state');
  const asyncRenameTargets = fake.calls.renamed.map(([from]) => from);
  assert.ok(!asyncRenameTargets.includes(fake.calls.staged[0]), 'the stale async write never renamed');
  assert.ok(fake.calls.unlinked.includes(fake.calls.staged[0]), 'it cleaned its staging file instead');
});

// DOCUMENTED RESIDUAL, pinned so it stays a stated boundary rather than a
// surprise: a write whose gate ALREADY passed and whose rename is mid-flight
// (submitted to the thread pool) when a writeSync lands will EXECUTE after it
// — the file then holds the async snapshot, COMPLETE (never torn, always
// parseable) but possibly stale. The gate removes the whole slow STAGING
// window (hundreds of ms under AV — the realistic in-flight-at-quit case,
// covered by the test above); this residual is the submit-to-execution window
// (sub-millisecond) of a rename that beat the quit path to the pool.
test('RESIDUAL (documented): a rename already in flight executes after a landing writeSync — complete file, possibly stale', async () => {
  const fake = createFakeFs();
  const w = createAtomicFileWriter({ fs: fake.fs, fsp: fake.fsp });
  fake.holdLands(); // the land-step passes its gate, then holds mid-rename

  const inFlight = w.write('/data/h.json', 'SUBMITTED-BEFORE-QUIT');
  await flush(); // gate passed; rename now held mid-flight (the pool window)
  w.writeSync('/data/h.json', 'FINAL-AT-QUIT'); // quit lands during the window
  assert.equal(fake.files.get('/data/h.json'), 'FINAL-AT-QUIT');

  fake.releaseLands();
  await inFlight;
  assert.equal(fake.files.get('/data/h.json'), 'SUBMITTED-BEFORE-QUIT', 'the already-submitted rename executed after the sync write (documented residual)');
  assert.equal(fake.files.size, 1, 'still no staging litter — the file is complete and parseable, never torn');
});


// ==========================================================================
// Failure paths — a failed write cleans its staging file and never wedges the
// chain for the next write (mechanism throws; main.cjs adds catch + warn).
// ==========================================================================
test('a failing staging write rejects, cleans its tmp, and the NEXT write still lands', async () => {
  const fake = createFakeFs();
  const w = createAtomicFileWriter({ fs: fake.fs, fsp: fake.fsp });
  fake.failNextWriteNow();
  await assert.rejects(() => w.write('/data/i.json', 'doomed'), /disk on fire/);
  assert.ok(fake.calls.unlinked.includes(fake.calls.staged[0]), 'the failed write cleaned its staging file');
  assert.equal(fake.files.has('/data/i.json'), false, 'target untouched by the failure');

  await w.write('/data/i.json', 'recovers');
  assert.equal(fake.files.get('/data/i.json'), 'recovers', 'the chain was not wedged by the failed step');
});

test('a failing rename rejects, cleans its tmp, and the NEXT write still lands', async () => {
  const fake = createFakeFs();
  const w = createAtomicFileWriter({ fs: fake.fs, fsp: fake.fsp });
  fake.failNextRenameNow();
  await assert.rejects(() => w.write('/data/j.json', 'doomed'), /rename refused/);
  assert.ok(fake.calls.unlinked.includes(fake.calls.staged[0]), 'the rename failure cleaned its staging file');

  await w.write('/data/j.json', 'recovers');
  assert.equal(fake.files.get('/data/j.json'), 'recovers');
});

test('a failing sync write throws, cleans its tmp (caller guards — never masks the error)', () => {
  const fake = createFakeFs();
  const w = createAtomicFileWriter({ fs: fake.fs, fsp: fake.fsp });
  fake.failNextSyncWriteNow();
  assert.throws(() => w.writeSync('/data/k.json', 'doomed'), /disk on fire/);
  assert.ok(fake.calls.unlinkedSync.includes(fake.calls.stagedSync[0]), 'the failed sync write cleaned its staging file');
  assert.equal(fake.files.has('/data/k.json'), false);
});

// ==========================================================================
// Real-fs integration — keeps the fake honest: the production shape (pretty
// JSON via write + the quit twin) lands parseable content and leaves no .tmp
// litter behind.
// ==========================================================================

test('REAL fs: steady-state write + quit-path writeSync land parseable content, zero tmp litter', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'atomic-persist-'));
  try {
    const file = join(dir, 'window-state.json');
    const w = createAtomicFileWriter(); // real node:fs — the production wiring
    await w.write(file, JSON.stringify({ width: 800, height: 600 }, null, 2));
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { width: 800, height: 600 });
    w.writeSync(file, JSON.stringify({ width: 1024, height: 768 }, null, 2));
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { width: 1024, height: 768 });

    // The maximize × debounce race on a real filesystem: last requested wins.
    await Promise.all([
      w.write(file, JSON.stringify({ stale: true })),
      w.write(file, JSON.stringify({ fresh: true })),
    ]);
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { fresh: true });

    await flush();
    const litter = readdirSync(dir).filter((n) => n.endsWith('.tmp'));
    assert.deepEqual(litter, [], 'no staging files left behind after settling');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('REAL fs: a write to an unwritable directory rejects (and leaves no tmp)', async () => {
  const base = mkdtempSync(join(tmpdir(), 'atomic-persist-'));
  const missing = join(base, 'nope', 'state.json'); // parent dir intentionally absent
  try {
    const w = createAtomicFileWriter(); // real fs — the production wiring
    await assert.rejects(() => w.write(missing, 'x'), /ENOENT/);
    assert.deepEqual(readdirSync(base), [], 'nothing staged, nothing leaked into the existing dir');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

console.log(`\n✓ ATOMIC PERSIST TESTS PASS (${passed})`);
