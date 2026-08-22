// Unit tests for the shared spawn-capture core (WARDEN-1138).
//
// The three callers (run, runLocalTmux, runLocalCapture) each keep their own
// end-to-end suites — sshRun.test.js, sshEncoding.test.js, runLocalCapture.test.js
// — which are the behavior-preservation gates for this refactor and were NOT
// edited for it. These tests pin the helper's OWN contract directly, so a future
// change to it fails here with a precise message instead of only rippling out
// through the callers.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { captureAndSettle } from './childCapture.js';

// A child close enough to the real thing for the decode under test to be node's
// own: real Readable streams, so `setEncoding` installs the production
// StringDecoder rather than a test double.
function fakeChild() {
  return Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: () => {},
  });
}

const tick = () => new Promise((r) => setImmediate(r));

// The stderr-folding error leg, i.e. run()'s / runLocalTmux's contract.
const foldIntoStderr = (err, stdout, stderr) => ({ ok: false, code: -1, stdout, stderr: stderr + String(err) });

describe('captureAndSettle (WARDEN-1138)', () => {
  test('settles on close with the accumulated {ok, code, stdout, stderr}', async () => {
    const child = fakeChild();
    const p = new Promise((resolve) => captureAndSettle(child, resolve, { onSpawnError: foldIntoStderr }));
    child.stdout.write('out-a');
    child.stderr.write('err-a');
    await tick();
    child.stdout.write('out-b');
    await tick();
    child.emit('close', 0);
    assert.deepEqual(await p, { ok: true, code: 0, stdout: 'out-aout-b', stderr: 'err-a' });
  });

  test('a nonzero close code settles ok:false, carrying that code', async () => {
    const child = fakeChild();
    const p = new Promise((resolve) => captureAndSettle(child, resolve, { onSpawnError: foldIntoStderr }));
    child.emit('close', 3);
    const r = await p;
    assert.equal(r.ok, false);
    assert.equal(r.code, 3);
  });

  test('a null close code (killed by signal) becomes -1, not null', async () => {
    // A child killed by a signal closes with code === null. Callers branch on a
    // numeric code, so the contract normalizes it.
    const child = fakeChild();
    const p = new Promise((resolve) => captureAndSettle(child, resolve, { onSpawnError: foldIntoStderr }));
    child.emit('close', null);
    const r = await p;
    assert.equal(r.code, -1);
    assert.equal(r.ok, false);
  });

  test('the error leg settles with onSpawnError\'s result, passing it the error and the output so far', async () => {
    // The two production callers disagree on this leg ON PURPOSE (run() folds the
    // error into stderr; runLocalCapture carries it as a separate `error` field),
    // so the helper must delegate rather than impose a shape. Here we assert the
    // delegation itself: the return value is used verbatim, and the callback sees
    // both the error and whatever had already accumulated.
    const child = fakeChild();
    const err = Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' });
    const seen = [];
    const p = new Promise((resolve) => captureAndSettle(child, resolve, {
      onSpawnError: (e, stdout, stderr) => {
        seen.push({ e, stdout, stderr });
        return { ok: false, code: -1, stdout, stderr, error: e };
      },
    }));
    child.stdout.write('partial-out');
    child.stderr.write('partial-err');
    await tick();
    child.emit('error', err);
    const r = await p;

    assert.equal(seen.length, 1, 'onSpawnError must be invoked exactly once');
    assert.equal(seen[0].e, err, 'the error object is passed through by identity');
    assert.equal(seen[0].stdout, 'partial-out', 'output accumulated before the error is visible to the leg');
    assert.equal(seen[0].stderr, 'partial-err');
    assert.equal(r.error, err, 'the leg\'s return value is what the promise settles with');
    assert.equal(r.ok, false);
  });

  test('never rejects: an error on the child settles the promise instead', async () => {
    const child = fakeChild();
    const p = new Promise((resolve) => captureAndSettle(child, resolve, { onSpawnError: foldIntoStderr }));
    child.emit('error', new Error('spawn ssh ENOENT'));
    const r = await p;
    assert.equal(r.ok, false);
    assert.match(r.stderr, /spawn ssh ENOENT/);
  });

  test('clears the caller\'s timer on the close leg', async () => {
    const child = fakeChild();
    let killed = false;
    const timer = setTimeout(() => { killed = true; }, 5);
    const p = new Promise((resolve) => captureAndSettle(child, resolve, { timer, onSpawnError: foldIntoStderr }));
    child.emit('close', 0);
    await p;
    await new Promise((r) => setTimeout(r, 25));
    assert.equal(killed, false, 'a settled capture must not leave its kill timer armed');
  });

  test('clears the caller\'s timer on the error leg too', async () => {
    const child = fakeChild();
    let killed = false;
    const timer = setTimeout(() => { killed = true; }, 5);
    const p = new Promise((resolve) => captureAndSettle(child, resolve, { timer, onSpawnError: foldIntoStderr }));
    child.emit('error', new Error('boom'));
    await p;
    await new Promise((r) => setTimeout(r, 25));
    assert.equal(killed, false, 'the error leg must clear the timer as well as the close leg');
  });

  test('tolerates timer === null (the callers that arm no timeout)', async () => {
    // runLocalTmux passes null when no finite positive timeout was given, and
    // runLocalCapture when `timeout` is falsy. Both legs must survive that.
    const closeChild = fakeChild();
    const closed = new Promise((resolve) => captureAndSettle(closeChild, resolve, { timer: null, onSpawnError: foldIntoStderr }));
    closeChild.emit('close', 0);
    assert.equal((await closed).ok, true);

    const errChild = fakeChild();
    const errored = new Promise((resolve) => captureAndSettle(errChild, resolve, { timer: null, onSpawnError: foldIntoStderr }));
    errChild.emit('error', new Error('boom'));
    assert.equal((await errored).ok, false);
  });

  test('carries utf8 decoder state across chunk boundaries on both streams', async () => {
    // The WARDEN-1045 bug, at the one place it now lives. Without setEncoding,
    // each chunk is decoded in isolation and a character split across the boundary
    // is destroyed into two U+FFFD.
    const expected = '┌' + '─'.repeat(64) + '┐ ünïcødé';
    const buf = Buffer.from(expected, 'utf8');
    const cut = 2; // lands INSIDE the leading 3-byte '┌'
    assert.ok(buf.subarray(0, cut).toString('utf8').includes('�'), 'the split must land mid-sequence for this test to mean anything');

    const child = fakeChild();
    const p = new Promise((resolve) => captureAndSettle(child, resolve, { onSpawnError: foldIntoStderr }));
    child.stdout.write(buf.subarray(0, cut));
    child.stderr.write(buf.subarray(0, cut));
    await tick();
    child.stdout.write(buf.subarray(cut));
    child.stderr.write(buf.subarray(cut));
    await tick();
    child.emit('close', 0);

    const r = await p;
    assert.equal(r.stdout, expected, 'stdout must be byte-identical to the child output');
    assert.equal(r.stderr, expected, 'stderr must be byte-identical too');
  });

  test('settles on close, NOT exit — an exit that beats the final data chunk still yields complete stdout', async () => {
    // The WARDEN-464/766 invariant. Under a saturated event loop a child's 'exit'
    // callback can run BEFORE its final 'data' callback; resolving there captured
    // empty/partial stdout for a probe that exited 0 (the false-clean git-status).
    // Here we stage that adversarial order directly.
    const child = fakeChild();
    const p = new Promise((resolve) => captureAndSettle(child, resolve, { onSpawnError: foldIntoStderr }));
    child.stdout.write('first');
    await tick();
    child.emit('exit', 0);          // must NOT settle
    child.stdout.write('-last');    // still arrives after 'exit'
    await tick();

    let settledEarly = false;
    p.then(() => { settledEarly = true; });
    await tick();
    assert.equal(settledEarly, false, "'exit' must not settle the promise — only 'close' may");

    child.emit('close', 0);
    const r = await p;
    assert.equal(r.stdout, 'first-last', 'stdout must be COMPLETE, including data that landed after exit');
  });
});
