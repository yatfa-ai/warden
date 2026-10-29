// Companion RPC transport layer — WARDEN-2014. The leaf transport pieces of
// companion.js (error types, the persistent-ssh CompanionChannel, the dead
// transport, and the binary upload stream), moved verbatim. companion.js
// re-exports every public name so importers are unchanged. This module imports
// companionOps.js and companionBootstrap.js, never companion.js (no cycle).

import fs from 'node:fs';
import readline from 'node:readline';
import { SSH_BIN, buildSshArgv, shellQuote } from './ssh.js';
import { encodeRequest, buildUploadScript } from './companionBootstrap.js';
import { recordCompanionOp, recordCompanionOpFailure } from './companionOps.js';

// ------------------------------- errors -------------------------------------

export class CompanionTransportError extends Error {
  constructor(host, reason, recovery) {
    super(`companion transport error for ${host}: ${reason}`);
    this.name = 'CompanionTransportError';
    this.host = host;
    this.reason = reason;
    this.recovery = recovery ||
      `Set WARDEN_COMPANION_TRANSPORT=0 to use the default SSH path, exclude this host in Settings → Performance ("Companion excluded hosts") to route just it over the default SSH path, or verify the host is reachable (ssh ${host}).`;
  }
}

// A companion RPC returned {ok:false}. Distinct from a transport/bootstrap error.
export class CompanionRpcError extends Error {
  constructor(host, message) {
    super(`companion RPC error on ${host}: ${message}`);
    this.name = 'CompanionRpcError';
    this.host = host;
  }
}

// Format the actionable message a thrown channel error carries — the ONE place
// the op sites (discover/capturePanes/hasSession/…) get their error text: a
// CompanionTransportError's message plus its recovery hint (how to return to the
// default SSH path), an RPC error's message, or a generic fallback naming the op.
// Centralised so the WARDEN-878 status surface shows byte-identical text to the
// op contracts (a failed host's tooltip and the op's thrown error read the same).
//
// `op` names the operation in the generic fallback — the ONLY thing that varied
// across the seven hand-rolled ladders this helper replaced (WARDEN-933). It
// defaults to the literal 'op' for the callers that are not a single named
// operation (the bootstrap status capture, and mapCmdError's best-effort
// envelope), preserving their `companion op failed on <host>` text verbatim.
// (WARDEN-878, WARDEN-933)
export function formatCompanionError(host, e, op = 'op') {
  if (e instanceof CompanionTransportError) {
    // Surface the actionable recovery hint (opt-out env var) so the user knows
    // exactly how to return to the default SSH path — no silent fallback.
    return e.message + (e.recovery ? ` ${e.recovery}` : '');
  }
  if (e instanceof CompanionRpcError) {
    return e.message;
  }
  return `companion ${op} failed on ${host}: ${e?.message ?? e}`;
}

// ------------------------------- RPC channel --------------------------------
// A CompanionChannel wraps ONE persistent ssh-to-companion process and multiplexes
// request/response by id. The transport layer (write/onLine/onExit/kill) is
// injectable so the framing + bootstrap are unit-testable with no real ssh.

// WARDEN-1598 — module-level observer for CompanionChannel.call(): invoked once per
// settled RPC with (method, durationMs, ok). Same shape as setInputAckObserver /
// ssh.js setSshRunObserver: null by default, a non-function resets to null, called
// inside try/catch. Only the method name, a duration and a boolean cross it —
// host, params, result and error text never do.
let companionRpcObserver = null;
export function setCompanionRpcObserver(fn) {
  companionRpcObserver = typeof fn === 'function' ? fn : null;
}

export class CompanionChannel {
  constructor(host, transport) {
    this.host = host;
    this.transport = transport;
    this.nextId = 1;
    this.pending = new Map(); // String(id) -> { resolve, reject, timer }
    this.dead = false;
    this._diedWith = null;
    this._eventHandler = null; // unsolicited event handler (WARDEN-413)
    this._methods = null;      // cached ping `methods` (feature-detect; WARDEN-413)
    transport.onLine((line) => this._onLine(line));
    transport.onExit((err) => this._die(err || new Error('companion process exited')));
  }

  _onLine(line) {
    const trimmed = (line || '').trim();
    if (!trimmed) return;
    let msg;
    try { msg = JSON.parse(trimmed); } catch { return; } // ignore non-JSON noise
    // WARDEN-413: an UNSOLICITED event line carries an `event` field and NO id
    // (e.g. {"event":"paneDelta","panes":{…}}). RPC responses never carry `event`
    // (they carry `ok`), so this is unambiguous and strictly additive: dispatch
    // to the registered handler instead of dropping it as an unknown id.
    if (msg.event) {
      if (this._eventHandler) {
        try { this._eventHandler(msg); } catch { /* handler must not break the channel */ }
      }
      return;
    }
    const p = this.pending.get(String(msg.id));
    if (!p) return; // response for an unknown/already-resolved id
    this.pending.delete(String(msg.id));
    clearTimeout(p.timer);
    if (msg.ok) {
      p.resolve(msg.result);
    } else {
      p.reject(new CompanionRpcError(this.host, msg.error || 'rpc returned ok:false with no error'));
    }
  }

  // Register a handler for unsolicited event lines (subscribePanes paneDelta
  // pushes). At most one handler per channel; the channel is shared per host so
  // the handler fans updates into the host's delta cache. Returns the handler so
  // it can be re-installed idempotently. (WARDEN-413)
  onEvent(handler) {
    this._eventHandler = handler;
    return handler;
  }

  offEvent() {
    this._eventHandler = null;
  }

  _die(err) {
    if (this.dead) return;
    this.dead = true;
    this._diedWith = err;
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(err);
    }
    this.pending.clear();
    // WARDEN-1295: a live attach is a STREAM, not a pending request — it has no
    // entry in `pending`, so the loop above cannot tell it the channel died and
    // its pane would spin forever on a companion that is already gone. Dead
    // handlers are how a stream learns; each one is best-effort so a throwing
    // consumer can't stop the rest from being notified.
    const handlers = this._deadHandlers || [];
    this._deadHandlers = [];
    for (const cb of handlers) {
      try { cb(err); } catch { /* a dead-handler throw must not break teardown */ }
    }
  }

  // Register a callback for channel death (WARDEN-1295). Fires immediately if the
  // channel is ALREADY dead — a stream that registers late must still learn,
  // otherwise it hangs on a death it merely missed. Handlers fire at most once.
  onDead(cb) {
    if (this.dead) {
      try { cb(this._diedWith); } catch { /* noop */ }
      return;
    }
    (this._deadHandlers ||= []).push(cb);
  }

  // WARDEN-1598 — the per-RPC telemetry seam. Wraps the real call (`_call`) with an
  // observer; what a caller sees (resolution, rejection, unhandled-rejection
  // behaviour) is identical to before. `ok` = "the channel DELIVERED A VERDICT": the transport rejects (dead
  // channel / timeout / write throw / channel death mid-flight) are ok:false, while
  // a host-side ok:false response (CompanionRpcError) is a COMMAND RESULT and is
  // ok:true — the WARDEN-1531 handshake-vs-verdict discipline. ping (infra) and
  // attachInput (already folded as companion-input-ack) are not observed here.
  // Latency is request-write → settle on the JS side (includes host serial-lane
  // queueing and the ssh hop); a timeout folds at its timeout value.
  call(method, params, opts = {}) {
    const startedAt = Date.now();
    const p = this._call(method, params, opts);
    if (method === 'ping' || method === 'attachInput') return p;
    const report = (ok) => {
      const obs = companionRpcObserver;
      if (!obs) return;
      try { obs(method, Date.now() - startedAt, ok); } catch { /* observing must never alter call() */ }
    };
    // Settle through a thin wrapper rather than `p.then(a, b)` on the side: a side
    // `.then(a, b)` would mark `p` HANDLED and silently suppress Node's
    // unhandled-rejection report for a caller that drops a rejected call(). The
    // caller holds THIS promise, so resolution value, rejection reason and
    // unhandled-rejection behaviour are exactly what they were.
    return new Promise((resolve, reject) => {
      p.then(
        (v) => { report(true); resolve(v); },
        (e) => { report(e instanceof CompanionRpcError); reject(e); },
      );
    });
  }

  _call(method, params, opts = {}) {
    // WARDEN-1312: count the op at the seam. `n` increments once per issued op
    // (ping excluded — infra, see the companionOps block comment), including ops
    // that go on to fail, so `failures <= n` always holds. Each of the three
    // transport-failure rejects below (dead channel / timeout / write throw)
    // ALSO increments `failures`; the host-side ok:false path rejects in _onLine
    // (not here) and correctly counts in `n` only.
    recordCompanionOp(this.host, method);
    if (this.dead) {
      recordCompanionOpFailure(this.host, method);
      return Promise.reject(new CompanionTransportError(
        this.host, `channel is dead (${this._diedWith?.message || 'exited'}); cannot send '${method}'`));
    }
    const id = this.nextId++;
    const key = String(id);
    const req = encodeRequest(id, method, params);
    const timeout = opts.timeout ?? 30000;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(key)) {
          recordCompanionOpFailure(this.host, method);
          reject(new CompanionTransportError(
            this.host, `timed out waiting for companion response to '${method}' after ${timeout}ms`));
        }
      }, timeout);
      this.pending.set(key, { resolve, reject, timer });
      try {
        this.transport.write(req);
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(key);
        recordCompanionOpFailure(this.host, method);
        reject(new CompanionTransportError(this.host, `failed to write '${method}' request: ${e.message}`));
      }
    });
  }

  kill() {
    this._die(new Error('killed'));
    try { this.transport.kill(); } catch { /* noop */ }
  }
}

// ----------------------- ssh transports (real + seams) ----------------------

// Spawn the persistent ssh-to-companion process and return a Transport
// ({write,onLine,onExit,kill}). One process per host; reused for every RPC.
// Exported (alongside streamFileToHost below) so the two `child.stdin` write
// sites can be driven directly by a test with an injected `spawnFn` — the
// mid-write EPIPE race in WARDEN-983 is unreachable through the fakeDeps()
// bootstrap harness, which stubs both legs out.
export function spawnPersistentChannel(host, remotePath, cfg, spawnFn) {
  // argv (including the `--` separator before the host) comes from ssh.js's
  // buildSshArgv, so this site is covered by the same invariant as every other
  // ssh transport even though it spawns directly rather than via run()
  // (WARDEN-969 could not reach it; WARDEN-979 patched it by hand; WARDEN-989
  // routed it through the builder).
  const args = buildSshArgv(host, {
    opts: ['-o', `ConnectTimeout=${cfg.connectTimeout ?? 10}`],
    command: remotePath,
  });
  let child;
  try {
    child = spawnFn(SSH_BIN, args, { windowsHide: true });
  } catch (e) {
    return makeDeadTransport(new Error(`failed to spawn companion ssh: ${e.message}`));
  }
  const rl = readline.createInterface({ input: child.stdout });
  let lineCb = null;
  let exitCb = null;
  rl.on('line', (line) => { if (lineCb) lineCb(line); });
  const onExit = (err) => { if (exitCb) exitCb(err); };
  child.on('exit', (code) => onExit(new Error(`companion ssh exited with code ${code}`)));
  child.on('error', (e) => onExit(e));
  // `child.stdin` is its OWN Socket emitter, and an 'error' event with no listener
  // THROWS — killing the whole warden server, mid-request. The try/catch in write()
  // below does NOT cover this: it catches only a *synchronous* throw (e.g.
  // ERR_STREAM_DESTROYED). An EPIPE from ssh dying while a write is in flight
  // surfaces ASYNCHRONOUSLY as an 'error' event here, outside that try block
  // entirely. Route it through onExit so it tears the channel down as an ordinary
  // transport death (CompanionTransportError, which every caller already handles).
  // Both guards are needed — sync and async are different paths. (WARDEN-983.)
  child.stdin.on('error', (e) => onExit(new Error(`stdin write failed: ${e.message}`)));
  return {
    write(line) {
      try { child.stdin.write(line + '\n'); }
      catch (e) { onExit(new Error(`stdin write failed: ${e.message}`)); }
    },
    onLine(cb) { lineCb = cb; },
    onExit(cb) { exitCb = cb; },
    kill() { try { child.kill('SIGTERM'); } catch { /* noop */ } },
  };
}

// A transport that is already dead — used when spawn itself throws.
function makeDeadTransport(err) {
  let exitCb = null;
  // Fire onExit asynchronously so the CompanionChannel constructor (which calls
  // onExit AFTER assigning it) still observes the death.
  setImmediate(() => { if (exitCb) exitCb(err); });
  return {
    write() { /* noop */ },
    onLine() {},
    onExit(cb) { exitCb = cb; },
    kill() {},
  };
}

// How long streamFileToHost's 'exit' waits for 'close' before settling on its
// own. See the hang guard in that function for why this exists and why it is
// generous. Exported so its test asserts against the real value rather than
// hard-coding a sleep.
export const UPLOAD_CLOSE_GRACE_MS = 1000;

// Stream the bundled binary to the host over ssh stdin (the VS Code Remote-SSH
// model). Returns { ok, code, stderr }. The binary is only ever exec'd on the
// REMOTE host after this upload, never locally.
// Exported for the WARDEN-983 stdin-EPIPE guard — see spawnPersistentChannel.
//
// Known, deliberate exception to the WARDEN-464 'close'-not-'exit' discipline
// this function now follows: `ensureControlMaster` (src/ssh.js:139) also
// accumulates stderr and returns it through the same degrading
// `${stderr || `exit ${code}`}` idiom, but it must STAY on 'exit'. It starts a
// persistent `-N` ControlMaster with ControlPersist=10m and resolves
// `{ ..., process: child }` on success; the backgrounded master can hold its
// stdio open indefinitely, so 'close' may never fire and converting it would
// risk wedging the whole connection pool — far worse than a degraded message on
// its failure leg.
export function streamFileToHost(host, localBinaryPath, remotePath, cfg, spawnFn) {
  const cmd = buildUploadScript(remotePath);
  // argv from ssh.js's buildSshArgv — see spawnPersistentChannel above.
  const args = buildSshArgv(host, {
    opts: ['-o', `ConnectTimeout=${cfg.connectTimeout ?? 10}`],
    command: `bash -lc ${shellQuote(cmd)}`,
  });
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnFn(SSH_BIN, args, { windowsHide: true });
    } catch (e) {
      resolve({ ok: false, code: -1, stderr: `spawn failed: ${e.message}` });
      return;
    }
    let stderr = '';
    let resolved = false;
    let graceTimer = null;
    const done = (r) => {
      if (graceTimer) { clearTimeout(graceTimer); graceTimer = null; }
      if (!resolved) { resolved = true; resolve(r); }
    };
    const stream = fs.createReadStream(localBinaryPath);
    stream.on('error', (e) => {
      try { child.kill('SIGKILL'); } catch { /* noop */ }
      done({ ok: false, code: -1, stderr: `read binary failed: ${e.message}` });
    });
    child.on('error', (e) => done({ ok: false, code: -1, stderr: String(e) }));
    // setEncoding('utf8') before the 'data' listener (WARDEN-1045): accumulating
    // Buffers with `+=` decodes each chunk in isolation, so a multibyte character
    // split across a read boundary is destroyed. Additive consistency only — this
    // stderr carries short ssh diagnostics, well under the 64KB pipe buffer — but
    // the idiom must not diverge between the spawn-and-collect siblings.
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => { stderr += d; });
    // Drain stdout. 'close' waits for ALL stdio to close, and this function never
    // reads child.stdout — an unconsumed pipe fills its buffer and stalls the
    // child (and therefore the close we now resolve on). Same reason sshControl
    // resumes the streams it ignores (src/ssh.js:90-91).
    if (child.stdout) child.stdout.resume();
    // 'close' (NOT 'exit') — this resolver ACCUMULATES stderr and RETURNS it, and
    // that stderr is the ONLY diagnostic a user gets when a host fails to provision
    // (bootstrapChannel's `upload failed: ${stderr || `ssh exited ${code}`}` — the
    // `||` means a truncated stderr does not error, it silently degrades the real
    // cause, e.g. "No space left on device", to a bare "ssh exited 1"). 'exit'
    // fires BEFORE the stdio pipes drain, so it can capture a truncated or empty
    // tail; 'close' fires only after they drain. The race is wide here because we
    // pipe ~2.1MB through child.stdin, saturating the loop in exactly the window
    // the child exits and its stderr tail must drain. Same class as WARDEN-464/766
    // (ssh.js run(), runLocalCapture, gitRoutes) — 'close' passes the same `code`,
    // so the {ok, code, stderr} contract is unchanged; only stderr gets completer.
    child.on('close', (code) => {
      stream.destroy();
      done({ ok: code === 0, code: code ?? -1, stderr });
    });
    // Hang guard. 'close' requires every stdio stream to close; a child whose
    // stdio is held open (inherited by a grandchild, a wedged pipe) would leave a
    // promise that resolves TODAY pending forever. So 'exit' — which we no longer
    // resolve on — arms a bounded grace instead: if 'close' has not landed within
    // it, settle with whatever stderr drained. 'close' clears the timer, and both
    // paths funnel through the idempotent done(), so whichever lands first wins
    // and the other no-ops. The grace is ~1000x a real drain (microseconds), so in
    // practice 'close' always wins; when it doesn't, the result is today's
    // possibly-truncated stderr — never worse than the status quo, never a hang.
    // NOT unref'd: this timer is the only thing keeping the promise alive on that
    // path, and an unref'd one would let node exit with the upload unsettled.
    child.on('exit', (code) => {
      if (resolved) return;
      stream.destroy();
      graceTimer = setTimeout(() => {
        graceTimer = null;
        done({ ok: code === 0, code: code ?? -1, stderr });
      }, UPLOAD_CLOSE_GRACE_MS);
    });
    // `child.stdin` is its own Socket emitter and an unlistened 'error' THROWS —
    // process death, taking the warden server with it. The pipe below streams
    // ~2.1MB, so the window where ssh can die mid-write (EPIPE, delivered
    // ASYNCHRONOUSLY as this event) is wide. `child.on('error')` above does NOT
    // cover it: that fires for spawn failures, not for writes to the child's pipe.
    // Route it through the idempotent done() so the upload resolves as a failed
    // upload; whichever of stdin-error / exit lands first wins, the other no-ops.
    // (WARDEN-983.)
    // APPEND the accumulated remote stderr, never replace it (WARDEN-1018). When
    // the remote dies mid-upload (disk full, mkdir/auth failure) it stops reading
    // while ~2.1MB is still piped, so the write EPIPEs — and because child.stdin
    // is one of the stdio streams 'close' waits on, THIS handler necessarily runs
    // before 'close' and wins deterministically. Reporting only the local symptom
    // ("write EPIPE") would therefore discard the remote cause on the DOMINANT
    // failure leg, exactly the diagnostic the 'close' comment above calls "the
    // ONLY diagnostic a user gets when a host fails to provision".
    // Additive by construction: with an empty accumulator the message is
    // byte-identical to the pre-WARDEN-1018 one, so no path can regress.
    // NOT solved by arming the UPLOAD_CLOSE_GRACE_MS timer here so 'close' wins
    // with complete stderr — that reds companion.test.js:1864, which requires the
    // stdin path (not the exit path) to produce this result.
    // Caveat, deliberately not oversold: stdin's 'error' precedes the stderr
    // pipe's full drain, so this recovers what has DRAINED SO FAR, not a
    // guaranteed-complete remote message. Strictly better than discarding it.
    child.stdin.on('error', (e) => {
      stream.destroy();
      const remote = stderr.trim();
      done({
        ok: false,
        code: -1,
        stderr: `upload stdin failed: ${e.message}${remote ? ` — remote said: ${remote}` : ''}`,
      });
    });
    stream.pipe(child.stdin);
  });
}
