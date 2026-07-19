import { describe, it } from 'node:test';
import assert from 'node:assert';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { runLocalCapture, runGit } from './gitRoutes.js';

/**
 * Locks runLocalCapture's WARDEN-464 'close'-not-'exit' discipline (the WARDEN-766
 * fleet-git-status root-cause fix). src/gitRoutes.js's runLocalCapture is the single
 * async spawn+capture primitive every LOCAL git / docker-exec / rg / grep on a request
 * path funnels through, so its stdout-completeness contract is load-bearing for every
 * /api/git-* route.
 *
 * Why these tests exist (the bug they prevent): runLocalCapture used to resolve on the
 * child 'exit' event. 'exit' fires when the process ends but BEFORE the buffered stdio
 * pipe data finishes draining; the final 'data' chunks arrive AFTER 'exit'. Under the
 * fleet-wide /api/git-status fan (N agents × ~8 runGit probes each, all in flight at
 * once — WARDEN-766), the saturated event loop can process a given child's 'exit'
 * callback before its final 'data' callback, so resolving on 'exit' captured EMPTY
 * stdout for a probe that exited 0. That made `git status --porcelain` read as '' for a
 * genuinely dirty repo → clean:true (false clean), and `rev-parse` read as '' →
 * clean:null — the exact non-deterministic failure QA observed (and that gate-1 below
 * pins deterministically, and gate-2 reproduces against the real runGit→git path).
 *
 * 'close' fires only AFTER the stdio streams fully drain, so stdout/stderr are always
 * complete when the promise resolves. ssh.js's runLocalTmux AND the remote run() both
 * resolve on 'close' for the same reason (run() was switched from 'exit' to 'close' in
 * the WARDEN-766 rework — the fleet fan exercises the remote transport identically, so
 * the same race that false-cleaned local reads would have false-cleaned remote ones;
 * see src/sshRun.test.js for run()'s own gate-1).
 *
 * The `spawn` option (defaults to node's) is the test seam: a fake child emitting the
 * adversarial order reproduces the race DETERMINISTICALLY on every machine, where a
 * real subprocess only reproduces it under heavy, machine-dependent concurrency.
 *
 * Run: node --test src/runLocalCapture.test.js   (or `node --test src`)
 */

// A minimal ChildProcess stand-in: stdout/stderr are EventEmitters the production code
// reads via .setEncoding + .on('data'); the child itself is an EventEmitter for
// 'error'/'close'. .setEncoding is a no-op (the fake emits pre-decoded strings); .kill
// is a no-op (no timeout is set in these tests). Quacks just enough for runLocalCapture.
function fakeChild() {
  const c = new EventEmitter();
  c.stdout = Object.assign(new EventEmitter(), { setEncoding() {} });
  c.stderr = Object.assign(new EventEmitter(), { setEncoding() {} });
  c.kill = () => {};
  return c;
}

describe('runLocalCapture — close, not exit (WARDEN-464 / WARDEN-766)', () => {
  it('gate 1 (deterministic): resolves on close, so stdout is complete even when the final data drains AFTER exit', async () => {
    // The adversarial order a saturated event loop produces: the child EXITS (code 0)
    // BEFORE its final stdout 'data' chunk drains. Under the old 'exit'-based capture
    // the promise resolved HERE with stdout=''; under 'close' it waits for the drain.
    let child;
    const fakeSpawn = () => { child = fakeChild(); return child; };
    const p = runLocalCapture('git', ['status', '--porcelain'], { spawn: fakeSpawn });
    child.emit('exit', 0);                     // old 'exit' code resolved here → stdout=''
    child.stdout.emit('data', ' M f.txt\n');   // porcelain drains AFTER exit
    child.emit('close', 0);                    // 'close' resolves here → stdout complete
    const r = await p;
    assert.equal(r.ok, true);
    assert.equal(r.code, 0);
    // The load-bearing assertion: stdout is the FULL drain, not whatever had arrived
    // at 'exit' time. (Inverted to an 'exit' handler in the production source during
    // development: this assertion went red with stdout === ''; restored → green.)
    assert.equal(r.stdout, ' M f.txt\n', "stdout must be fully drained — resolve on 'close', not 'exit'");
    assert.equal(r.stderr, '');
  });

  it('gate 1b (deterministic): a non-zero exit code is still reported when stdout drains after exit', async () => {
    // Same drain-after-exit race, but the probe exits non-zero (git's "condition false"
    // signal, e.g. rev-parse @{u} with no upstream). 'close' carries the real code AND
    // the fully-drained stdout; 'exit' would have lost the stderr diagnostic.
    let child;
    const fakeSpawn = () => { child = fakeChild(); return child; };
    const p = runLocalCapture('git', ['rev-parse', '--abbrev-ref', '@{u}'], { spawn: fakeSpawn });
    child.emit('exit', 128);
    child.stderr.emit('data', 'fatal: no upstream\n');
    child.emit('close', 128);
    const r = await p;
    assert.equal(r.ok, false);
    assert.equal(r.code, 128);
    assert.equal(r.stderr, 'fatal: no upstream\n', 'stderr must be fully drained too');
  });

  it('normal order (data then exit then close): captures complete stdout', async () => {
    // Sanity (not a regression guard — gate 1/1b are): the natural data→exit→close
    // order resolves cleanly under any handler. Emitted with 'exit' too so the case
    // never hangs waiting on an event the (current) handler doesn't listen for.
    let child;
    const fakeSpawn = () => { child = fakeChild(); return child; };
    const p = runLocalCapture('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { spawn: fakeSpawn });
    child.stdout.emit('data', 'main\n');
    child.emit('exit', 0);
    child.emit('close', 0);
    const r = await p;
    assert.equal(r.ok, true);
    assert.equal(r.stdout, 'main\n');
  });

  it('resolves (never rejects) on a spawn error, carrying the error', async () => {
    // WARDEN-464 never-reject shape: a fire-and-forget caller must not get an unhandled
    // rejection. A spawn 'error' resolves { ok:false, code:-1, error } instead.
    let child;
    const fakeSpawn = () => { child = fakeChild(); return child; };
    const p = runLocalCapture('rg', ['--version'], { spawn: fakeSpawn });
    const err = Object.assign(new Error('spawn rg ENOENT'), { code: 'ENOENT' });
    child.emit('error', err);
    const r = await p;
    assert.equal(r.ok, false);
    assert.equal(r.code, -1);
    assert.equal(r.error, err);
    assert.equal(r.error.code, 'ENOENT');
  });
});

describe('runLocalCapture — real runGit under fleet-fan concurrency (WARDEN-766)', () => {
  // The empirical counterpart to gate 1: the REAL runGit → runLocalCapture → spawn →
  // git path, driven the way /api/git-status's fleet fan drives it. Under the old
  // 'exit' capture this produced ~60% false-clean reads (status porcelain captured
  // empty → clean:true for dirty repos); under 'close' it is 0. Over-subscribed
  // (every probe across all agents fired at once, ~40 in flight) so the machine-
  // dependent 'exit'-before-drain race is deterministic on any host: with 'close' the
  // data is correct 100% of the time, so a non-zero mismatch count is a real
  // regression, never flake.
  it('gate 2 (empirical): ~40 concurrent runGit probes never yield a false-clean status', async () => {
    const LOCAL = '(local)';
    const sh = (cmd, cwd) => spawnSync('sh', ['-c', cmd], { cwd, stdio: 'ignore' });
    const mkRepo = (state) => {
      const d = mkdtempSync(join(tmpdir(), `qa766-${state}-`));
      if (state === 'nogit') return d;
      sh('git init -q && git config user.email t@t && git config user.name t && git commit -q --allow-empty -m base', d);
      if (state === 'dirty') { writeFileSync(join(d, 'f.txt'), 'tracked-mod\n'); sh('git add f.txt', d); }
      if (state === 'untracked') { writeFileSync(join(d, 'u.txt'), 'untracked\n'); }
      return d;
    };
    const repos = {
      dirtyA: mkRepo('dirty'),
      dirtyB: mkRepo('dirty'),
      untracked: mkRepo('untracked'),
      clean: mkRepo('clean'),
      nogit: mkRepo('nogit'),
    };
    const chat = (cwd) => ({ container: null, host: LOCAL, cwd });
    // Expected resolved `clean` per /api/git-status's `branch ? clean : null` gate:
    // dirty/untracked → false (uncommitted WIP), clean → true, non-git → null.
    const expected = { dirtyA: false, dirtyB: false, untracked: false, clean: true, nogit: null };
    try {
      // Derive `clean` the SAME way /api/git-status does (branch gate + porcelain).
      const status = async (cwd) => {
        const bR = await runGit(chat(cwd), ['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
        const branch = bR.ok ? bR.stdout.trim() : '';
        const sR = await runGit(chat(cwd), ['status', '--porcelain'], cwd);
        const clean = (sR.ok ? sR.stdout : '').trim().length === 0;
        return branch ? clean : null;
      };
      const keys = Object.keys(repos);
      let mismatches = 0;
      let checks = 0;
      const seen = [];
      const ROUNDS = 12;
      for (let i = 0; i < ROUNDS; i++) {
        // Fire every probe across all agents at once — ~40 runGit spawns in flight,
        // over-subscribing the real route's per-request sequential 8 so the race
        // reproduces deterministically here (the real route's lower concurrency only
        // raced on some hosts, which is why QA caught it but a naive test wouldn't).
        const inflight = keys.map((k) => status(repos[k]).then((r) => ({ k, r })));
        for (const k of keys) {
          const cwd = repos[k];
          inflight.push(runGit(chat(cwd), ['rev-list', '--left-right', '--count', '@{u}...HEAD'], cwd));
          inflight.push(runGit(chat(cwd), ['rev-parse', '--abbrev-ref', '@{u}'], cwd));
          inflight.push(runGit(chat(cwd), ['symbolic-ref', '-q', 'HEAD'], cwd));
          inflight.push(runGit(chat(cwd), ['log', '-1', '--format=%cI', 'HEAD'], cwd));
          inflight.push(runGit(chat(cwd), ['stash', 'list'], cwd));
          inflight.push(runGit(chat(cwd), ['diff', 'HEAD', '--shortstat'], cwd));
        }
        const settled = await Promise.all(inflight);
        for (const { k, r } of settled.slice(0, keys.length)) {
          checks++;
          if (expected[k] !== r) {
            mismatches++;
            if (seen.length < 6) seen.push(`round ${i} ${k}: expected=${expected[k]} got=${r}`);
          }
        }
      }
      assert.equal(
        mismatches,
        0,
        `${mismatches}/${checks} agents read a wrong clean under concurrency — the 'exit'-before-drain race is back (runLocalCapture must resolve on 'close'). First: ${seen[0] || 'n/a'}`,
      );
    } finally {
      for (const d of Object.values(repos)) try { rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  });
});
