import { describe, it } from 'node:test';
import assert from 'node:assert';
import { EventEmitter } from 'node:events';
import { ensureControlMaster, SSH_BASE_OPTS } from './ssh.js';

/**
 * Locks ensureControlMaster's SETTLE-TRIGGER ASYMMETRY (WARDEN-1107).
 *
 * ensureControlMaster is the one spawn-and-capture primitive in the repo whose two
 * outcome paths must settle on DIFFERENT child events, and each direction has its
 * own failure mode:
 *
 *   FAILURE path — was settling on 'exit', which fires when the child ends but
 *   BEFORE its stdio pipes drain. The rejection message is built FROM stderr
 *   (`ControlMaster failed to ${host}: ${stderr || \`exit ${code}\`}`), so losing
 *   that race threw away the real ssh diagnostic ("Permission denied (publickey)",
 *   "Host key verification failed", "Could not resolve hostname") and degraded it
 *   to the bare `exit 255` fallback. That console.error'd message is how an
 *   unreachable host actually gets diagnosed server-side — browser surfaces
 *   genericize it by design — so `exit 255` is not a diagnosis. Same WARDEN-464/766
 *   drain race its three siblings (run, runLocalTmux, runLocalCapture) were fixed
 *   for. Gate 1 below.
 *
 *   SUCCESS path — must KEEP settling on 'exit'. This child DAEMONIZES:
 *   `ssh -N -o ControlMaster=yes -o ControlPersist=10m` forks a background master
 *   and the foreground process exits 0 while the backgrounded master retains the
 *   inherited stdout/stderr pipe fds. The write ends stay open, so 'close' may
 *   NEVER fire on success. A naive one-line 'exit'→'close' swap would therefore
 *   hang every successful connect until the connect timer fired and reject it as
 *   `ControlMaster connect timeout` — turning the primary remote-host path
 *   (getConnection → runWithPool → chats.js discover, every poll tick) into a
 *   total failure. Gate 2 below is the guard that keeps that swap from landing.
 *
 * The `cfg.spawn` seam (defaults to node's child_process.spawn) is what makes both
 * gates deterministic — a real subprocess can reproduce neither 'exit'-before-the-
 * final-'data' nor a success that never closes, reliably on every machine. Mirrors
 * runLocalCapture's seam (gitRoutes.js) and run()'s (src/sshRun.test.js).
 *
 * Note on hermeticity: ensureControlMaster first runs its `ssh -O check` probe
 * (sshControl) to detect an already-live master. That probe deliberately keeps the
 * real `spawn` — it is the untouched positive control for this ticket ('exit' is
 * CORRECT there because it discards stdio, so there is nothing to drain). It is
 * harmless here: the control socket these tests name does not exist, so the probe
 * fails immediately without any network I/O (and resolves -1 at once when ssh is
 * absent entirely), and it is bounded at 2s regardless.
 *
 * Run: node --test src/sshControlMaster.test.js   (or `node --test src`)
 */

// A minimal ChildProcess stand-in. stdout/stderr are EventEmitters the production
// code reads via .setEncoding + .on('data'); the child itself is an EventEmitter for
// 'error'/'exit'/'close'. .setEncoding RECORDS its argument rather than being a bare
// no-op, so the WARDEN-1045 utf8 discipline is assertable (the fake emits pre-decoded
// strings, so there is no decoder state to actually carry). .kill records that it was
// called. Quacks just enough for ensureControlMaster.
function fakeChild() {
  const encodings = {};
  const c = new EventEmitter();
  c.stdout = Object.assign(new EventEmitter(), { setEncoding(e) { encodings.stdout = e; } });
  c.stderr = Object.assign(new EventEmitter(), { setEncoding(e) { encodings.stderr = e; } });
  c.killed = 0;
  c.kill = () => { c.killed++; };
  c.encodings = encodings;
  return c;
}

// ensureControlMaster awaits its `-O check` probe BEFORE spawning, so the fake child
// does not exist synchronously. Hand back a promise that settles the moment the
// injected spawn is called, so every test drives a real, already-wired child.
function harness(cfg = {}) {
  let child = null;
  let announce;
  const spawned = new Promise((r) => { announce = r; });
  const calls = [];
  const spawn = (bin, args, opts) => {
    child = fakeChild();
    calls.push({ bin, args, opts });
    announce(child);
    return child;
  };
  return { spawn, spawned, calls, get child() { return child; } };
}

describe("ensureControlMaster — failure drains stderr, success never waits for 'close' (WARDEN-1107)", () => {
  it('gate 1 (the bug): a failing connect surfaces the real ssh stderr even when it drains AFTER exit', async () => {
    // The adversarial order: the child EXITS non-zero BEFORE its final stderr chunk
    // drains. Under the old 'exit'-based settle the promise rejected HERE with an
    // empty stderr, so the message fell through to the `exit 255` fallback and the
    // actual cause was lost. Waiting for 'close' keeps the diagnostic.
    const h = harness();
    const p = ensureControlMaster('remote-a', { spawn: h.spawn });
    const child = await h.spawned;

    child.stderr.emit('data', 'user@remote-a: ');    // partial diagnostic has arrived
    child.emit('exit', 255);                          // old code rejected HERE → "exit 255"
    child.stderr.emit('data', 'Permission denied (publickey).\n'); // the rest drains AFTER exit
    child.emit('close', 255);                         // drain complete → reject built here

    const caught = await p.then(() => null, (e) => e);
    assert.ok(caught instanceof Error, 'a failing connect must reject');
    assert.match(
      caught.message,
      /ControlMaster failed to remote-a: user@remote-a: Permission denied \(publickey\)\./,
      'the FULL post-exit stderr is in the message');
    assert.ok(
      !/exit 255/.test(caught.message),
      'the `exit <code>` fallback must NOT fire when ssh actually said something');
  });

  it('gate 2 (the regression guard): a successful connect resolves on exit and never waits for close', async () => {
    // Models the ControlPersist daemon: the foreground ssh exits 0, the backgrounded
    // master keeps the inherited pipe fds, so 'close' NEVER arrives. If this ever
    // settles on 'close' the promise hangs here until the connect timer rejects it
    // with `ControlMaster connect timeout` — i.e. every successful remote connection
    // becomes a failure. This test is what stops the naive one-line swap from landing.
    const h = harness();
    const p = ensureControlMaster('remote-b', { spawn: h.spawn });
    const child = await h.spawned;

    child.emit('exit', 0);
    // deliberately NO 'close', ever.

    const res = await p;
    assert.strictEqual(res.existing, false, 'a freshly-established master');
    assert.strictEqual(res.process, child,
      'the child is handed back — getConnection attaches its pool-eviction exit listener to it');
    assert.ok(typeof res.socketPath === 'string' && res.socketPath.includes('remote_b'),
      'the ControlPath socket is returned (host sanitized into the path)');
  });

  it('gate 2b: a late close after a successful exit cannot double-settle', async () => {
    // 'close' CAN still arrive on success (e.g. ssh closed the fds before daemonizing).
    // The settled guard must make it a no-op — a second settle attempt on an already-
    // resolved promise would otherwise be a silent contract violation, and a reject
    // after resolve would surface as an unhandled rejection.
    const h = harness();
    const p = ensureControlMaster('remote-c', { spawn: h.spawn });
    const child = await h.spawned;

    child.emit('exit', 0);
    child.emit('close', 0);
    child.emit('close', 0);
    child.emit('error', new Error('too late'));

    const res = await p;
    assert.strictEqual(res.existing, false, 'still the original resolution');
    assert.strictEqual(child.killed, 0, 'the connect timer never fired, so nothing was SIGTERMed');
  });

  it("bounds the drain: a child that exits non-zero and never closes still rejects, with whatever stderr arrived", async () => {
    // The pathological case the grace window exists for. It must not hang waiting on
    // a 'close' that never comes — and it must not fall through to the connect-timeout
    // message either: the child has already exited, so this is a connect FAILURE.
    const h = harness();
    const p = ensureControlMaster('remote-d', { spawn: h.spawn, drainGrace: 10 });
    const child = await h.spawned;

    child.stderr.emit('data', 'Host key verification failed.\n');
    child.emit('exit', 255);
    // no 'close' — the grace timer is the only way out.

    await assert.rejects(() => p, (e) => {
      assert.match(e.message, /ControlMaster failed to remote-d: Host key verification failed\./);
      return true;
    });
  });

  it('preserves the `exit <code>` fallback when ssh genuinely wrote nothing', async () => {
    const h = harness();
    const p = ensureControlMaster('remote-e', { spawn: h.spawn, drainGrace: 10 });
    const child = await h.spawned;

    child.emit('exit', 3);
    child.emit('close', 3);

    await assert.rejects(() => p, (e) => {
      assert.strictEqual(e.message, 'ControlMaster failed to remote-e: exit 3');
      return true;
    });
  });

  it('a spawn error still rejects with the spawn-failure message', async () => {
    const h = harness();
    const p = ensureControlMaster('remote-f', { spawn: h.spawn });
    const child = await h.spawned;

    child.emit('error', new Error('spawn ssh ENOENT'));
    child.emit('close', -1);   // node emits 'close' after a spawn 'error'; must be a no-op

    await assert.rejects(() => p, (e) => {
      assert.match(e.message, /ControlMaster spawn failed: spawn ssh ENOENT/);
      return true;
    });
  });

  it('spawns the unchanged argv (no SSH_BASE_OPTS) and sets utf8 on both streams', async () => {
    // Guards the WARDEN-989 argv identity (the twin of ssh.test.js "site 2/7") through
    // the new injection seam, and the WARDEN-1045 setEncoding discipline the seam now
    // makes directly observable.
    const h = harness();
    const p = ensureControlMaster('remote-g', { spawn: h.spawn });
    const child = await h.spawned;
    child.emit('exit', 0);
    const res = await p;

    const { args } = h.calls[0];
    assert.deepStrictEqual(args, [
      '-o', 'ControlMaster=yes',
      '-o', 'ControlPath=' + res.socketPath,
      '-o', 'ControlPersist=10m',
      '-o', 'ConnectTimeout=10',
      '-N',
      '--', 'remote-g',
    ], 'argv is byte-identical to before the seam was added');
    for (const opt of SSH_BASE_OPTS) {
      // Skip the bare '-o' flag itself — this argv legitimately carries five of them.
      // The load-bearing check is that no base-opt VALUE (BatchMode=yes,
      // StrictHostKeyChecking=…, ServerAlive*) leaked in.
      if (opt === '-o') continue;
      assert.ok(!args.includes(opt), `${opt} still absent (baseOpts:false is preserved)`);
    }
    assert.deepStrictEqual(child.encodings, { stdout: 'utf8', stderr: 'utf8' },
      "setEncoding('utf8') on both streams (WARDEN-1045)");
    assert.deepStrictEqual(h.calls[0].opts.stdio, ['ignore', 'pipe', 'pipe'],
      'stdio is captured, not inherited — there is something to drain');
  });
});
