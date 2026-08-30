// The one spawn-capture core (WARDEN-1138).
//
// Three primitives — `run()` (remote ssh) and `runLocalTmux()` in src/ssh.js, and
// `runLocalCapture()` in src/gitRoutes.js — each hand-rolled the SAME 12 lines:
// accumulate a child's stdout/stderr as utf8, then settle once the streams have
// drained. Both bugs that ever bit this family lived entirely inside those 12
// lines, and both had to be repaired at every site independently:
//
//   - the missing `setEncoding('utf8')` (WARDEN-1045) was one bug fixed at FOUR
//     production sites in a single commit — `runLocalCapture` already had it, and
//     "that divergence was the whole bug";
//   - the 'exit' → 'close' invariant (WARDEN-464/766) was closed piecemeal across
//     FOUR commits (WARDEN-440, WARDEN-766, companion, WARDEN-1107).
//
// With the core here, the next such fix is one line at one site.
//
// This module is deliberately transport-neutral: gitRoutes.js should not have to
// import the ssh transport for a generic child-process concern.
//
// What is NOT here, on purpose — the things these three callers legitimately
// differ on stay at the call site: the `spawn` call itself, the timeout arming,
// the kill signal (run() SIGKILL, the two local ones SIGTERM — pinned by no test,
// so uniformizing them would ship a silent regression), and the error leg, whose
// contract differs by design between `run()` (folds the error into `stderr`,
// pinned by sshRun.test.js) and `runLocalCapture()` (carries it as a separate
// `error` field, pinned by runLocalCapture.test.js).
//
// `ensureControlMaster` (ssh.js) is NOT a member of this family and must not be
// folded in: it rejects rather than resolving, and settles on 'exit' for success
// because the forked ControlPersist daemon retains the inherited pipe fds, so
// 'close' may never fire. sshControlMaster.test.js gate 2 guards that.

// Wire a spawned child's stdout/stderr into a single accumulated {ok, code, stdout,
// stderr} settlement, and hand it to the caller's `resolve`.
//
// Takes `resolve` rather than owning the Promise ON PURPOSE: each caller keeps its
// own `new Promise((resolve) => { ... })` with the `spawn` call INSIDE the executor,
// so a synchronous throw from an injected `spawn` still REJECTS the promise. Hoisting
// the spawn out of the executor would convert that into a synchronous throw at the
// caller — a real behavior change, since both `run()` (`opts.spawn`) and
// `runLocalCapture()` (`{ spawn: spawnFn }`) expose an injectable spawn seam.
//
// Listeners are attached synchronously in the same tick as the spawn, so no 'data'
// event can be missed.
//
// @param child        the spawned ChildProcess (must have piped stdout + stderr)
// @param resolve      the enclosing Promise's resolve
// @param timer        the caller's timeout handle, or null when none was armed;
//                     cleared on BOTH settle legs
// @param onSpawnError (err, stdout, stderr) => result — the per-caller 'error' leg
export function captureAndSettle(child, resolve, { timer = null, onSpawnError } = {}) {
  let stdout = '';
  let stderr = '';
  // setEncoding('utf8') BEFORE the 'data' listeners (WARDEN-1045). Without it,
  // `stdout += d` calls Buffer#toString on each chunk IN ISOLATION: a multibyte
  // character straddling a read boundary (which is what happens once output
  // exceeds the 64KB pipe buffer and arrives in several chunks) has its leading
  // bytes decoded at the end of one chunk and its continuation bytes at the
  // start of the next — both become U+FFFD and the character is destroyed
  // irrecoverably. setEncoding installs a StringDecoder that holds an incomplete
  // trailing sequence back and prepends it to the following chunk, so the
  // accumulated string is byte-identical to the child's output. Nothing
  // downstream can repair this: U+FFFD is valid JSON, so the corruption is
  // silent all the way to the user (the pane they read, the transcript they
  // download).
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d) => { stderr += d; });
  child.on('error', (err) => {
    if (timer) clearTimeout(timer);
    resolve(onSpawnError(err, stdout, stderr));
  });
  // Resolve on 'close' (NOT 'exit'): 'close' fires only AFTER the stdio streams
  // have fully drained, so stdout/stderr hold the COMPLETE output. 'exit' can fire
  // while buffered pipe data is still being read — under the fleet-wide concurrency
  // a saturated event loop runs a child's 'exit' callback BEFORE its final 'data'
  // callback, which captured EMPTY stdout for a probe that exited 0 (the WARDEN-766
  // false-clean `git status --porcelain`), and for a large capture truncates the
  // tail. 'close' passes the same `code`, so the {ok, code, stdout, stderr} contract
  // is unchanged — it only makes stdout complete (WARDEN-464/766).
  child.on('close', (code) => {
    if (timer) clearTimeout(timer);
    resolve({ ok: code === 0, code: code ?? -1, stdout, stderr });
  });
}
