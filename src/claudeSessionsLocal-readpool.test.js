import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { localClaudeSessions } from './claudeSessionsLocal.js';

// WARDEN-2199 — pins localClaudeSessions' depth-4 bounded read pool (WARDEN-2198
// replaced the sequential per-file read loop with a worker pool). The behaviors
// that are NEW vs the sequential loop, all exercised over real fs:
//
//   1. ROW ORDER is restored by original index: rows come back in
//      collectLocalSessionFiles' mtime-descending order no matter which pool
//      worker finishes first. The probe reverses read-completion order against
//      catalog order (newest transcripts read slowest), which kills the naive
//      completion-order shape (`map((f) => readOne(f).then((row) => out.push(row)))`).
//   2. Reads OVERLAP but stay BOUNDED at depth 4: in-flight fs.promises.readFile
//      calls peak at exactly 4 on a window wider than the pool (the sequential
//      loop peaks at 1; an unbounded Promise.all peaks at N).
//   3. The pool also overlaps below depth (a 2-file window peaks at 2), and a
//      per-file read failure still isolates to its own row (EISDIR on a
//      directory named *.jsonl → that row's cwd is empty → dropped) without
//      failing the batch.
//
// The concurrency probe patches fs.promises.readFile: the module aliases
// `const fsp = fs.promises` at import time but dereferences `fsp.readFile` off
// that SHARED object at call time, so a patch installed here is observed by the
// module's reads. Every patch is installed inside a test and restored in a
// finally block so no other test sees it.

let savedHome;
let home;
let projectsDir;

beforeEach(() => {
  savedHome = process.env.HOME;
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-claudeSessionsLocal-readpool-'));
  process.env.HOME = home;
  projectsDir = path.join(home, '.claude', 'projects');
});

afterEach(() => {
  process.env.HOME = savedHome;
  fs.rmSync(home, { recursive: true, force: true });
});

function writeSession(project, id, lines, mtimeSec) {
  const dir = path.join(projectsDir, project);
  fs.mkdirSync(dir, { recursive: true });
  const fp = path.join(dir, `${id}.jsonl`);
  fs.writeFileSync(fp, lines.map((l) => JSON.stringify(l)).join('\n') + (lines.length ? '\n' : ''));
  if (mtimeSec != null) fs.utimesSync(fp, mtimeSec, mtimeSec);
  return fp;
}

function cwdLine(cwd) {
  return { type: 'user', cwd, message: { role: 'user', content: 'hello' } };
}

// Install an fs.promises.readFile probe: count concurrently in-flight calls,
// optionally delay each call by a per-file (id → ms) map BEFORE performing the
// real read. Returns { restore, peak } — restore MUST run in a finally block.
function probeReadFile(delaysById) {
  const orig = fs.promises.readFile;
  let inFlight = 0;
  const state = { peak: 0, started: 0 };
  fs.promises.readFile = async function probed(file, opts) {
    state.started += 1;
    inFlight += 1;
    state.peak = Math.max(state.peak, inFlight);
    try {
      const id = path.basename(String(file), '.jsonl');
      const delay = delaysById && delaysById.get(id);
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      return await orig.call(fs.promises, file, opts);
    } finally {
      inFlight -= 1;
    }
  };
  return {
    restore() { fs.promises.readFile = orig; },
    peak: () => state.peak,
    started: () => state.started,
  };
}

describe('localClaudeSessions depth-4 read pool (WARDEN-2199)', () => {
  it('returns rows in mtime-descending catalog order even when read completions land in a different order', async () => {
    // Ten sessions seeded so s0 is the NEWEST (mtime 1009 → catalog index 0)
    // and s9 the OLDEST (mtime 1000 → catalog index 9): the expected row order
    // is exactly s0..s9.
    const count = 10;
    for (let i = 0; i < count; i++) {
      writeSession('p', `s${i}`, [cwdLine(`/w/${i}`)], 1000 + (count - 1 - i));
    }
    // Delay each read so the NEWEST transcript (s0, catalog index 0) reads
    // slowest and the OLDEST completes first — completions land in REVERSED
    // catalog order (s9 first, s0 last), which kills the naive completion-order
    // shape (`map((f) => readOne(f).then((row) => out.push(row)))`): it would
    // return s9..s0.
    const delays = new Map();
    for (let i = 0; i < count; i++) delays.set(`s${i}`, 10 + (count - 1 - i) * 8);

    const probe = probeReadFile(delays);
    let out;
    try {
      out = await localClaudeSessions();
    } finally {
      probe.restore();
    }

    assert.equal(probe.started(), count, 'every catalog file was read exactly once');
    assert.deepEqual(out.map((s) => s.id), Array.from({ length: count }, (_, i) => `s${i}`));
    // Each row carries its OWN body's cwd — reads are not crossed across rows.
    assert.deepEqual(out.map((s) => s.cwd), Array.from({ length: count }, (_, i) => `/w/${i}`));
  });

  it('peaks in-flight transcript reads at 4 (the pool depth) on a window wider than the pool', async () => {
    const count = 12; // wider than depth 4: the pool stays saturated end to end
    for (let i = 0; i < count; i++) {
      writeSession('p', `s${i}`, [cwdLine(`/w/${i}`)], 1000 + (count - 1 - i));
    }

    const probe = probeReadFile(null);
    let out;
    try {
      out = await localClaudeSessions();
    } finally {
      probe.restore();
    }

    assert.equal(out.length, count);
    // A sequential loop peaks at 1 (no overlap); an unbounded Promise.all
    // peaks at `count`. The pool deterministically holds exactly `depth` in
    // flight while the window outstrips it.
    assert.equal(probe.peak(), 4);
  });

  it('also overlaps reads on a window smaller than the pool (2 files → 2 concurrent reads)', async () => {
    // s0 carries the higher mtime → newest → expected catalog head.
    for (let i = 0; i < 2; i++) {
      writeSession('p', `s${i}`, [cwdLine(`/w/${i}`)], 1000 + (1 - i));
    }

    const probe = probeReadFile(null);
    let out;
    try {
      out = await localClaudeSessions();
    } finally {
      probe.restore();
    }

    assert.deepEqual(out.map((s) => s.id), ['s0', 's1']);
    assert.equal(probe.peak(), 2);
    assert.ok(probe.peak() > 1, 'reads overlap even below the pool depth');
  });

  it('drops only the unreadable transcript — one pool read failure never fails the batch', async () => {
    // A DIRECTORY named *.jsonl passes the enumeration filters (readdir lists
    // it; collectLocalSessionFiles stats it fine) but fails fsp.readFile with
    // EISDIR — root-proof, unlike an EACCES permission trick.
    writeSession('p', 'good-old', [cwdLine('/w/old')], 1000);
    fs.mkdirSync(path.join(projectsDir, 'p', 'broken.jsonl'));
    writeSession('p', 'good-new', [cwdLine('/w/new')], 1002);

    let out;
    try {
      out = await localClaudeSessions();
    } finally {
      // no probe this example — the failure path needs no instrumentation
    }

    // The EISDIR row's cwd stays empty → the final filter drops it in place;
    // the two well-formed reads still come back newest-first.
    assert.deepEqual(out.map((s) => s.id), ['good-new', 'good-old']);
  });
});
