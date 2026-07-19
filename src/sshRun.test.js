import { describe, it } from 'node:test';
import assert from 'node:assert';
import { EventEmitter } from 'node:events';
import { run } from './ssh.js';

/**
 * Locks ssh.js run()'s WARDEN-464/766 'close'-not-'exit' discipline — the remote-
 * transport twin of src/runLocalCapture.test.js. run() is the async spawn+capture
 * primitive EVERY remote git / docker-exec / read-file / search probe on a request
 * path funnels through (runGit's remote branches, runInContext's remote branches,
 * server.js's non-git routes), so its stdout-completeness contract is load-bearing
 * for every /api/git-* route that serves a REMOTE agent.
 *
 * Why these tests exist (the bug they prevent): run() used to resolve on the child
 * 'exit' event. 'exit' fires when the process ends but BEFORE the buffered stdio
 * pipe data finishes draining; the final 'data' chunks arrive AFTER 'exit'. Under
 * the fleet-wide /api/git-status fan (N remote agents × ~8 runGit probes each, all
 * in flight at once via Promise.allSettled — WARDEN-766), the saturated event loop
 * can process a given child's 'exit' callback before its final 'data' callback, so
 * resolving on 'exit' captured EMPTY stdout for a probe that exited 0. That made
 * `git status --porcelain` read as '' for a genuinely dirty remote repo → clean:true
 * (false clean), and the WARDEN-89 false-empty guard couldn't catch it (the server
 * returns a successful-but-wrong HTTP 200) — the exact remote-side failure the
 * WARDEN-766 rework closes the loop on. (The LOCAL twin runLocalCapture was fixed
 * in the same ticket; see src/runLocalCapture.test.js.)
 *
 * The mechanism is child-binary-independent (it's libuv pipe-drainage scheduling
 * under a saturated loop, not anything about ssh vs git), so the remote transport
 * races under the fan the same way the local one did pre-fix.
 *
 * 'close' fires only AFTER the stdio streams fully drain, so stdout/stderr are
 * always complete when the promise resolves. 'close' passes the same exit `code`
 * as 'exit', so the {ok, code, stdout, stderr} contract is UNCHANGED — it only
 * makes stdout complete, which helps (not hazards) isTransportFailure's classifier:
 * it sees real stdout instead of an emptied one.
 *
 * The `opts.spawn` seam (defaults to node's child_process.spawn) is the test seam:
 * a fake child emitting the adversarial order reproduces the race DETERMINISTICALLY
 * on every machine. There is NO empirical gate-2 here (unlike runLocalCapture.test.js)
 * because reproducing the race against a REAL ssh subprocess needs (a) an
 * ssh-capable host and (b) machine-dependent concurrency to surface the drain
 * scheduling — neither is reliably available in every sandbox. The DI gate-1 is the
 * right tool precisely because the adversarial 'exit'-before-final-'data' order
 * can't be reproduced by a real subprocess on every host.
 *
 * Run: node --test src/sshRun.test.js   (or `node --test src`)
 */

// A minimal ChildProcess stand-in: stdout/stderr are EventEmitters the production code
// reads via .on('data') (run() does NOT call setEncoding — it accumulates with +=, so
// the fake emits pre-decoded strings and needs no setEncoding stub); the child itself
// is an EventEmitter for 'error'/'close'. .kill is a no-op (run() always arms a timer;
// no test here lets it fire). Quacks just enough for run().
function fakeChild() {
  const c = new EventEmitter();
  c.stdout = new EventEmitter();
  c.stderr = new EventEmitter();
  c.kill = () => {};
  return c;
}

describe('run() — close, not exit (WARDEN-464 / WARDEN-766 remote transport)', () => {
  it('gate 1 (deterministic): resolves on close, so stdout is complete even when the final data drains AFTER exit', async () => {
    // The adversarial order a saturated event loop produces: the child EXITS (code 0)
    // BEFORE its final stdout 'data' chunk drains. Under the old 'exit'-based capture
    // the promise resolved HERE with stdout=''; under 'close' it waits for the drain.
    let child;
    const fakeSpawn = () => { child = fakeChild(); return child; };
    const p = run('host', 'git status --porcelain', { spawn: fakeSpawn, timeout: 60000 });
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

  it('gate 1b (deterministic): a non-zero exit code is still reported when stderr drains after exit', async () => {
    // Same drain-after-exit race, but the probe exits non-zero (git's "condition false"
    // signal, e.g. rev-parse @{u} with no upstream). 'close' carries the real code AND
    // the fully-drained stderr; 'exit' would have lost the stderr diagnostic.
    let child;
    const fakeSpawn = () => { child = fakeChild(); return child; };
    const p = run('host', 'git rev-parse --abbrev-ref @{u}', { spawn: fakeSpawn, timeout: 60000 });
    child.emit('exit', 128);
    child.stderr.emit('data', 'fatal: no upstream\n');
    child.emit('close', 128);
    const r = await p;
    assert.equal(r.ok, false);
    assert.equal(r.code, 128);
    assert.equal(r.stderr, 'fatal: no upstream\n', 'stderr must be fully drained too');
  });

  it('gate 1c (deterministic): a NULL exit code (signal-killed remote cmd) reports ok:false via close', async () => {
    // 'close' (like 'exit') receives `code` as null when the child was killed by a
    // signal (the SIGKILL timeout path, or a remote OOM-kill). The `code ?? -1`
    // coercion must still turn that into ok:false. Emitted with 'exit' too so the
    // case never hangs waiting on an event the (current) handler doesn't listen for.
    let child;
    const fakeSpawn = () => { child = fakeChild(); return child; };
    const p = run('host', 'git status --porcelain', { spawn: fakeSpawn, timeout: 60000 });
    child.stdout.emit('data', '');
    child.emit('exit', null, null);
    child.emit('close', null, null);
    const r = await p;
    assert.equal(r.ok, false);
    assert.equal(r.code, -1);
  });

  it('normal order (data then exit then close): captures complete stdout', async () => {
    // Sanity (not a regression guard — gate 1/1b/1c are): the natural data→exit→close
    // order resolves cleanly under any handler. Emitted with 'exit' too so the case
    // never hangs waiting on an event the (current) handler doesn't listen for.
    let child;
    const fakeSpawn = () => { child = fakeChild(); return child; };
    const p = run('host', 'git rev-parse --abbrev-ref HEAD', { spawn: fakeSpawn, timeout: 60000 });
    child.stdout.emit('data', 'main\n');
    child.emit('exit', 0);
    child.emit('close', 0);
    const r = await p;
    assert.equal(r.ok, true);
    assert.equal(r.stdout, 'main\n');
  });

  it('resolves (never rejects) on a spawn error, folding the error into stderr', async () => {
    // WARDEN-464 never-reject shape: a fire-and-forget caller must not get an unhandled
    // rejection. run() folds a spawn 'error' into stderr (stderr + String(err)) rather
    // than surfacing a separate `error` field (its contract differs from
    // runLocalCapture's here) — isTransportFailure then classifies the empty-stdout +
    // populated stderr as a transport failure so the WARDEN-129 self-heal can retry.
    let child;
    const fakeSpawn = () => { child = fakeChild(); return child; };
    const p = run('host', 'git status --porcelain', { spawn: fakeSpawn, timeout: 60000 });
    const err = Object.assign(new Error('spawn ssh ENOENT'), { code: 'ENOENT' });
    child.emit('error', err);
    const r = await p;
    assert.equal(r.ok, false);
    assert.equal(r.code, -1);
    assert.ok(String(r.stderr).includes('spawn ssh ENOENT'), 'spawn error folded into stderr');
  });
});
