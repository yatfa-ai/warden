// Transports for warden: run commands either over SSH (remote hosts) or locally
// (this machine). A "chat" is a tmux session everywhere EXCEPT local Windows,
// which since WARDEN-922 spawns the native shell through ConPTY directly (no
// tmux, no MSYS2, no forced bash) — see winsession.js. The local/remote branch
// below is unchanged; only the local-Windows implementation of it moved.
import { spawn, spawnSync } from 'node:child_process';
import * as nodePty from 'node-pty';
import fs from 'node:fs';
import { captureAndSettle } from './childCapture.js';
import { isNativeLocal, runNative, attachNative } from './winsession.js';

// POSIX single-quote. Safe for the local ssh arg layer and remote bash.
export function shellQuote(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

// Split a command STRING into argv, honoring double quotes.
//
// The chat's `cmd` is stored as a string and split into argv before it becomes
// tmux/ConPTY arguments. A plain `split(/\s+/)` shreds any path containing a
// space — which on Windows is the common case, not an edge case (`C:\Program
// Files\…\claude.cmd`), so `claude --resume <id>` resolved to a real installed
// binary and then failed to launch (WARDEN-922). Quoting is the only way to
// express "this space is part of the path", so the splitter has to understand it.
// Unquoted input splits exactly as before, so every existing caller is unchanged.
export function splitCmd(str) {
  const out = [];
  let cur = '';
  let quoted = false;
  let has = false;
  for (const ch of String(str)) {
    if (ch === '"') { quoted = !quoted; has = true; continue; }
    if (!quoted && /\s/.test(ch)) {
      if (has) { out.push(cur); cur = ''; has = false; }
      continue;
    }
    cur += ch;
    has = true;
  }
  if (has) out.push(cur);
  return out;
}

export const SSH_BASE_OPTS = [
  '-o', 'BatchMode=yes', // key auth only — never hang on a password prompt
  '-o', 'StrictHostKeyChecking=accept-new',
  '-o', 'ServerAliveInterval=30',  // Keep-alive for persistent connections
  '-o', 'ServerAliveCountMax=3',   // 3 unresponsive keep-alives → disconnect
];
export const SSH_BIN = process.platform === 'win32' ? 'ssh.exe' : 'ssh';

// Build ssh argv with the end-of-options separator structurally guaranteed.
//
// `--` ends ssh's option parsing: a host beginning with `-` is then treated as a
// (bogus) hostname instead of an option. Without it, `-oProxyCommand=<cmd>`
// arriving as a `host` makes ssh execute <cmd> on THIS machine. An argv array
// stops the shell, not the callee's own option parser — so the separator has to
// be terminated here, in the builder, where every caller is covered
// (WARDEN-140 Trap 5). Hand-assembling it per call site leaked twice: WARDEN-969
// fixed "all 5" ssh.js sites and still left the 2 companion.js sites exposed for
// another ticket cycle (WARDEN-979). `--` is unconditional and always
// immediately precedes the host, so a caller CANNOT forget it.
//
// Pure (just builds an array) so every transport is unit-testable without ssh —
// same argument as buildDockerGitArgv in gitStatus.js.
//
// `baseOpts: false` is a NAMED decision, not an omission: sshControl and
// ensureControlMaster genuinely do not carry SSH_BASE_OPTS today (no BatchMode,
// no StrictHostKeyChecking), and passing `false` preserves that argv exactly
// while making the divergence greppable instead of invisible. Whether that
// divergence should exist at all is a separate, deliberately out-of-scope
// question — changing it here would be a behavior change, not a refactor.
export function buildSshArgv(host, { tty = false, baseOpts = true, opts = [], command } = {}) {
  const args = [];
  if (tty) args.push('-tt');
  if (baseOpts) args.push(...SSH_BASE_OPTS);
  args.push(...opts);
  args.push('--', host);                       // the invariant, in exactly one place
  if (command !== undefined) args.push(command);
  return args;
}

// ---------------- Connection Pool ----------------
// Persistent SSH connections to remote hosts. Reused across operations for
// better performance (no repeated SSH handshakes) and reliability (fewer
// connection attempts = fewer transient failures).

const connectionPool = new Map(); // host -> { socketPath: string, lastUsed: number, refs: number, healthy: boolean, process: ChildProcess }
const POOL_IDLE_TIMEOUT = 5 * 60 * 1000; // 5 minutes
const POOL_HEALTH_CHECK_INTERVAL = 60 * 1000; // 1 minute

// SSH ControlMaster socket-based connection pooling
// This uses SSH's built-in multiplexing feature for persistent connections

const controlMasterPath = () => {
  const tmpDir = process.env.TMP || process.env.TMPDIR || '/tmp';
  return `${tmpDir}/ssh-ctrl-${process.pid}`;
};

// Async `ssh -O <sub> -S <socketPath> <host>` (sub = 'check' | 'exit') for the
// ControlMaster lifecycle — the non-blocking replacement for the spawnSync probes
// that previously froze the whole event loop on every pooled request (`-O check`)
// and on the pool's idle-cleanup timer (`-O exit`) (WARDEN-441). Mirrors the
// spawn + Promise pattern run() already uses, so a control-socket probe or
// teardown never blocks the server while it runs. Resolves the child's exit code
// (0 = success, e.g. master-alive for `check`; non-zero/-1 otherwise) and NEVER
// rejects — a dead/absent socket just resolves non-zero, exactly the signal the
// callers already branch on. Bounded by `timeout` (ms) via SIGTERM so a wedged
// `ssh -O` can never hang. stdio is drained (captured, not inherited) so ssh's
// control diagnostics never spam the console.
function sshControl(host, socketPath, sub, timeout = 5000) {
  return new Promise((resolve) => {
    // baseOpts:false — this probe has never carried SSH_BASE_OPTS (see buildSshArgv).
    const argv = buildSshArgv(host, { baseOpts: false, opts: ['-O', sub, '-S', socketPath] });
    const child = spawn(SSH_BIN, argv, {
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const timer = setTimeout(() => { try { child.kill('SIGTERM'); } catch { /* noop */ } }, timeout);
    let settled = false;
    const finish = (code) => { if (!settled) { settled = true; clearTimeout(timer); resolve(code); } };
    child.stdout.on('data', () => {});
    child.stderr.on('data', () => {});
    child.on('error', () => finish(-1)); // binary absent / spawn failure → like a non-zero exit
    child.on('exit', (code) => finish(code ?? -1));
  });
}

// How long the FAILURE path may wait for the dead child's stdio to drain before
// it gives up and rejects with whatever stderr has arrived. Bounded so a
// pathological child that exits non-zero and never closes its pipes cannot hang
// the promise (the connect timer is already cleared by then — see below).
const CONTROL_MASTER_DRAIN_GRACE_MS = 300;

// Establish (or reuse) the ControlMaster every pooled request multiplexes over.
//
// SETTLE-TRIGGER ASYMMETRY (WARDEN-1107) — this is the ONE spawn-and-capture
// primitive in the repo that legitimately diverges from its siblings' blanket
// "resolve on 'close', not 'exit'" rule (run() src/ssh.js:371, runLocalTmux(),
// runLocalCapture() gitRoutes.js:94 — WARDEN-464/766). The two paths settle on
// DIFFERENT events, on purpose:
//
//   success (code === 0) → settle on 'exit'. Unlike its siblings this child is
//     DAEMONIZING: `ssh -N -o ControlMaster=yes -o ControlPersist=10m` forks a
//     background master and the foreground process exits 0 while the backgrounded
//     master RETAINS the inherited stdout/stderr pipe fds. The write ends stay
//     open, so 'close' may never fire on success — waiting for it would hang until
//     the connect timer fired and turn every successful remote connection into a
//     bogus `ControlMaster connect timeout`. A naive one-line 'exit'→'close' swap
//     here is a severe regression on the primary remote-host path
//     (getConnection → runWithPool → chats.js discover, every poll tick). It would
//     also delay resolution past the child's exit, which the pool's
//     `process.on('exit', …)` eviction listener (src/ssh.js) depends on.
//
//   failure (code !== 0) → wait for the stdio drain ('close', bounded by
//     CONTROL_MASTER_DRAIN_GRACE_MS). The rejection message is built FROM stderr,
//     and 'exit' can fire before the pipe drains — so settling on 'exit' reads a
//     still-empty stderr and the real ssh diagnostic ("Permission denied
//     (publickey)", "Host key verification failed", "Could not resolve hostname")
//     degrades to the `exit 255` fallback. That fallback firing IS the bug: this
//     console.error'd message is how an unreachable host actually gets diagnosed
//     server-side (browser surfaces genericize it by design). On failure no master
//     is established, so nothing holds the pipes open and 'close' does arrive.
//
// `spawn` is injectable (defaults to node's child_process.spawn) so BOTH halves of
// that asymmetry have deterministic unit tests — a real subprocess can't reproduce
// 'exit'-before-final-'data', nor a success that never closes, reliably on every
// machine. Mirrors runLocalCapture's seam (gitRoutes.js:77).
export async function ensureControlMaster(host, cfg) {
  const socketPath = `${controlMasterPath()}-${host.replace(/[^a-zA-Z0-9]/g, '_')}`;
  const timeout = (cfg?.connectTimeout ?? 10);
  const spawnFn = cfg?.spawn ?? spawn;
  const drainGrace = cfg?.drainGrace ?? CONTROL_MASTER_DRAIN_GRACE_MS;

  // Check if master is already running (async — never blocks the event loop).
  if ((await sshControl(host, socketPath, 'check', 2000)) === 0) {
    return { socketPath, existing: true };
  }

  // Start new control master.
  // baseOpts:false preserves this argv EXACTLY as it has always been — this is
  // the one connection every pooled request multiplexes over, and it does not
  // carry SSH_BASE_OPTS. Named rather than silent; see buildSshArgv.
  const args = buildSshArgv(host, {
    baseOpts: false,
    opts: [
      '-o', 'ControlMaster=yes',
      '-o', 'ControlPath=' + socketPath,
      '-o', 'ControlPersist=10m',  // Keep alive for 10 minutes after last use
      '-o', `ConnectTimeout=${timeout}`,
      '-N',  // No remote command
    ],
  });

  return new Promise((resolve, reject) => {
    const child = spawnFn(SSH_BIN, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';

    // Single-settle guard (the pattern sshControl already uses above): 'exit',
    // 'close', 'error', the connect timer and the drain timer can all fire, and
    // exactly one of them may settle the promise. Every path clears both timers.
    let settled = false;
    let drainTimer = null;
    let timer = null;
    const settle = (fn) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (drainTimer) clearTimeout(drainTimer);
      fn();
    };
    // The failure rejection, built AFTER the drain so `stderr` is the real ssh
    // diagnostic. The `stderr || \`exit ${code}\`` fallback is preserved verbatim —
    // it is still the correct answer for a child that genuinely wrote nothing.
    const rejectFailure = (code) =>
      settle(() => reject(new Error(`ControlMaster failed to ${host}: ${stderr || `exit ${code}`}`)));

    timer = setTimeout(() => {
      settle(() => {
        child.kill('SIGTERM');
        reject(new Error(`ControlMaster connect timeout to ${host}`));
      });
    }, timeout * 1000 + 5000);

    // setEncoding('utf8') BEFORE the 'data' listeners (WARDEN-1045): `stdout += d`
    // on a Buffer decodes each chunk IN ISOLATION, so a multibyte sequence split
    // across a read boundary is destroyed (both halves → U+FFFD). setEncoding
    // installs a StringDecoder that carries the partial tail into the next chunk.
    // Additive consistency here — this stdout is discarded and the stderr is a
    // short connect diagnostic — but the idiom must not diverge between siblings.
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => { stderr += d; });

    child.on('error', (err) => {
      settle(() => reject(new Error(`ControlMaster spawn failed: ${err.message}`)));
    });

    child.on('exit', (code) => {
      if (settled) return;
      if (code === 0) {
        // SUCCESS — settle HERE, on 'exit', never on 'close'. The ControlPersist
        // daemon this call just forked holds the inherited pipe fds open, so
        // 'close' may never arrive. See the function header.
        settle(() => resolve({ socketPath, existing: false, process: child }));
      } else {
        // FAILURE — the message is built from stderr, which may still be draining.
        // Hand off to 'close'. The connect timer is disarmed (the child has already
        // exited; there is nothing left to time out or SIGTERM) and replaced by a
        // short bounded grace so a child that never closes its pipes still rejects
        // — with whatever stderr arrived, exactly as today.
        clearTimeout(timer);
        drainTimer = setTimeout(() => rejectFailure(code), drainGrace);
      }
    });

    // 'close' fires only after the stdio streams drain, and passes the same `code`
    // as 'exit' — so the reject contract is unchanged, only its message is complete.
    // Reached on the failure path (and on a spawn failure that emits 'close' with no
    // 'exit'); a no-op after the success path has already settled on 'exit'.
    child.on('close', (code) => {
      if (settled) return;
      rejectFailure(code ?? -1);
    });
  });
}

async function getConnection(host, cfg) {
  if (host === '(local)') return null;

  // Windows OpenSSH does not support ControlMaster socket multiplexing — it fails
  // with "getsockname failed: Not a socket". (In dev this was masked because Git's
  // MSYS ssh was on PATH and does emulate the sockets; a double-clicked packaged
  // app resolves Windows OpenSSH instead.) Skip pooling on win32 and use plain
  // direct ssh, which works everywhere. ControlMaster only helps on macOS/Linux.
  if (process.platform === 'win32') return { socketPath: null };

  const cached = connectionPool.get(host);
  const timeout = (cfg?.connectTimeout ?? 10);

  // Return existing healthy connection
  if (cached && cached.healthy && cached.socketPath) {
    // Verify the control socket is still valid (async — never blocks the event loop).
    if ((await sshControl(host, cached.socketPath, 'check', 2000)) === 0) {
      cached.refs++;
      cached.lastUsed = Date.now();
      return { socketPath: cached.socketPath, existing: true };
    }
    // Control master died, remove from pool
    connectionPool.delete(host);
  }

  // Establish new connection
  try {
    const { socketPath, existing, process } = await ensureControlMaster(host, { connectTimeout: timeout });

    // Monitor the ControlMaster CHILD's exit (the master died) → evict its pool
    // entry. Fire-and-forget: markConnectionUnhealthy is async but never rejects,
    // and this exit callback can't (and needn't) await it.
    if (process) {
      process.on('exit', () => {
        markConnectionUnhealthy(host);
      });
    }

    connectionPool.set(host, {
      socketPath,
      lastUsed: Date.now(),
      refs: 1,
      healthy: true,
      process
    });

    return { socketPath, existing };
  } catch (e) {
    throw new HostConnectionError(
      host,
      e.message,
      'Check if the host is reachable and SSH is running. Test: ssh ' + host
    );
  }
}

function releaseConnection(host) {
  const cached = connectionPool.get(host);
  if (cached) {
    cached.refs = Math.max(0, cached.refs - 1); // Prevent underflow
    // Don't close immediately - keep alive for reuse
    // Background cleanup task closes idle connections
  }
}

// Tear down a suspect/dead control master and evict it from the pool. Async: the
// `ssh -O exit` (spawn-based, non-blocking) is AWAITED so that by the time a
// caller (notably runWithPool's self-healing retry) asks for a fresh connection,
// the dead master has actually exited and ensureControlMaster rebuilds a brand-new
// socket instead of reusing the wedged one — preserving the pre-WARDEN-441
// behavior where the sync spawnSync completed before the retry. Never rejects
// (sshControl resolves on both success and failure), so fire-and-forget callers
// (the child-exit monitor below) can invoke it without awaiting.
async function markConnectionUnhealthy(host) {
  const cached = connectionPool.get(host);
  if (cached) {
    cached.healthy = false;
    const socketPath = cached.socketPath;
    connectionPool.delete(host);
    await sshControl(host, socketPath, 'exit', 5000); // best-effort teardown; never rejects
  }
}

// Background cleanup for idle connections. Runs on a setInterval (a timer path):
// the per-idle-host teardown is a non-blocking `ssh -O exit` (WARDEN-441) so the
// timer never freezes the event loop the way the old sync spawnSync did.
export function startConnectionPoolCleanup() {
  setInterval(() => {
    const now = Date.now();
    for (const [host, state] of connectionPool.entries()) {
      if (state.refs === 0 && (now - state.lastUsed) > POOL_IDLE_TIMEOUT) {
        const socketPath = state.socketPath;
        connectionPool.delete(host);
        // Fire-and-forget: best-effort teardown, never blocks the timer, never rejects.
        sshControl(host, socketPath, 'exit', 5000);
        console.log(`[SSH pool] Closed idle connection to ${host}`);
      }
    }
  }, POOL_HEALTH_CHECK_INTERVAL);
}

// ---------------- Enhanced Error Handling ----------------

export class HostConnectionError extends Error {
  constructor(host, reason, recovery) {
    super(`Cannot connect to ${host}: ${reason}`);
    this.name = 'HostConnectionError';
    this.host = host;
    this.reason = reason;
    this.recovery = recovery;
  }
}

// ---------------- Pre-connection Health Checks ----------------

export async function validateHost(host, cfg) {
  if (host === '(local)') return { ok: true, host };

  try {
    // Quick health check: run a simple command via the pool
    const result = await runWithPool(host, 'echo OK', { timeout: 5000 }, cfg);
    if (result.ok) return { ok: true, host };

    return {
      ok: false,
      host,
      error: 'Host unreachable',
      suggestion: 'Verify SSH access: ssh ' + host
    };
  } catch (e) {
    return {
      ok: false,
      host,
      error: e.message,
      suggestion: 'Check network and SSH configuration'
    };
  }
}

// ---------------- SSH transport (remote hosts) ----------------

// Run a remote command, capture stdout/stderr. Returns {ok, code, stdout, stderr}.
//
// Resolves on the child 'close' event (NOT 'exit') — the WARDEN-464/766
// stdout-completeness discipline. 'exit' fires when the process ends but BEFORE
// the buffered stdio pipe finishes draining; the final 'data' chunks arrive
// AFTER 'exit'. Under the fleet-wide /api/git-status fan (N remote agents × ~8
// runGit probes each, all in flight at once via Promise.allSettled — WARDEN-766),
// the saturated event loop can process a given child's 'exit' callback before
// its final stdout 'data' callback, so resolving on 'exit' captured EMPTY stdout
// for a probe that exited 0 — `git status --porcelain` read as '' for a genuinely
// dirty remote repo → clean:true (false clean), the exact failure WARDEN-766's
// LOCAL twin (runLocalCapture) was fixed for. The mechanism is child-binary-
// independent (it's libuv pipe-drainage scheduling under a saturated loop, not
// anything about ssh vs git), so the remote transport races under the fan the
// same way the local one did pre-fix. 'close' fires only AFTER the stdio streams
// fully drain, so stdout/stderr are always complete when the promise resolves —
// the same discipline runLocalCapture and runLocalTmux already ship.
//
// `spawn` is injectable via opts.spawn (defaults to node's child_process.spawn)
// so the 'close'-not-'exit' guard has a DETERMINISTIC unit test: a fake child
// emitting 'exit' BEFORE its final stdout 'data' (the adversarial order the
// saturated loop produces) must still resolve with COMPLETE stdout — a real ssh
// subprocess can't reproduce that order reliably on every machine (and ssh isn't
// available in every sandbox). Mirrors runLocalCapture's `spawn` seam; runWithPool
// uses the same idea via its `deps` param.
export function run(host, cmd, opts = {}, cfg = {}) {
  const spawnFn = opts.spawn ?? spawn;
  const timeout = opts.timeout ?? 30000;
  const connectTimeout = Math.min(20, Math.max(3, Math.ceil(timeout / 1000)));
  const remote = `bash -lc ${shellQuote(cmd)}`;

  // Build args with optional ControlMaster for connection pooling.
  // The `--` separator before the host comes from buildSshArgv — see there.
  const socketPath = opts.socketPath;
  const args = buildSshArgv(host, {
    opts: [
      '-o', `ConnectTimeout=${connectTimeout}`,
      // Add ControlPath if we have a pooled connection
      ...(socketPath ? ['-o', 'ControlPath=' + socketPath] : []),
    ],
    command: remote,
  });

  return new Promise((resolve) => {
    const child = spawnFn(SSH_BIN, args, { windowsHide: true });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
    // The stdout/stderr accumulation + 'close'-not-'exit' settlement is the shared
    // core — see captureAndSettle (childCapture.js). Passing `timer` is equivalent
    // to the old unconditional clearTimeout: the line above arms unconditionally,
    // so it is always a truthy Timeout here. The complete stdout that settling on
    // 'close' yields helps (not hazards) isTransportFailure's classifier: it sees
    // real stdout instead of an emptied one.
    captureAndSettle(child, resolve, {
      timer,
      // run()'s error leg folds the spawn error INTO stderr — deliberately unlike
      // runLocalCapture's separate `error` field. Both directions are pinned by
      // green tests (sshRun.test.js:133, runLocalCapture.test.js:106).
      onSpawnError: (err, stdout, stderr) => ({ ok: false, code: -1, stdout, stderr: stderr + String(err) }),
    });
  });
}

// Classify a `run()` result ({ok, code, stdout, stderr}) as an SSH *transport*
// failure versus a *command*-level result. This is the safety core of the
// self-healing retry (WARDEN-129): only transport failures may be retried.
//
// The distinction that matters:
//   - transport failure: the command provably did NOT run on the remote host —
//     SSH bailed at *connection / channel-establishment* time, before any
//     command could be delivered (wedged ControlMaster, half-open TCP at
//     connect, idle/reaped socket, DNS/refused/timed-out at connect). Safe to
//     retry, because no side effect could have been committed.
//   - command result: the command ran on the remote host and returned its own
//     exit code (including non-zero, e.g. `tmux has-session` reporting an absent
//     session). NEVER retried — otherwise side-effecting commands like
//     `tmux send-keys` could double-execute.
//
// CRITICAL — connection-establishment ONLY, never mid-stream:
// We classify ONLY connection/channel-establishment signals as transport.
// Mid-stream break signals ("connection closed", "connection reset",
// "broken pipe") are deliberately NOT retried: they are ambiguous. The same
// stderr is produced whether the channel died (a) at session-request — before
// the command ran (safe to retry) — or (b) AFTER a side-effecting command such
// as `send-keys` already ran, but before ssh returned the exit status (retrying
// would deliver the keys a SECOND time). stderr alone cannot tell the two apart,
// so we never retry these — the safe default. This still heals the documented
// root cause (`Control socket connect failed`).
//
// Heuristic: a transport failure leaves no usable command output on stdout. If
// there is meaningful stdout, the command ran, so we never retry regardless of
// how transport-y the stderr looks. With no stdout, we then look for
// connection-establishment signals in stderr/code.
export function isTransportFailure(result) {
  if (!result || result.ok) return false;

  // Meaningful command output → the remote command provably ran. A non-zero
  // exit here is a command-level result, NOT transport. Never retry.
  if ((result.stdout || '').trim().length > 0) return false;

  const stderr = result.stderr || '';
  const stderrLower = stderr.toLowerCase();

  // code === -1 means the local `ssh` process was killed by a signal (our
  // timeout SIGKILL, run()'s child.on('error') spawn failure, or an external
  // signal) — NOT that the remote command exited. With no stdout, no remote
  // command completed, so this is a transport failure. (A remote command killed
  // by a signal is forwarded by ssh as 128+signal, e.g. 137, not -1.)
  if (result.code === -1) return true;

  // Connection-establishment error phrases (case-insensitive). These appear when
  // SSH fails to establish the channel — at connect/session-request time, BEFORE
  // any command runs — so retrying cannot double-execute a side effect.
  // NOTE: mid-stream signals ("connection closed", "connection reset",
  // "broken pipe") are deliberately omitted — see the comment above the
  // function: they can also surface AFTER a command already ran, so they are
  // not safe to retry. "killed by signal" is omitted too: a remote command can
  // log "killed by signal 15" with empty stdout, which would be misclassified.
  const TRANSPORT_PHRASES = [
    'control socket',          // "Control socket connect(...): ..." / "... connect failed" (wedged/absent master)
    'connection timed out',    // "Connection timed out" at connect time (also matched by the ssh: rule below)
  ];
  if (TRANSPORT_PHRASES.some((p) => stderrLower.includes(p))) return true;

  // ssh:-prefixed error lines, e.g.:
  //   ssh: connect to host X port 22: Connection refused
  //   ssh: Could not resolve hostname foo: Name or service not known
  //   ssh: connect to host X port 22: No route to host
  // Auth failures ("Permission denied (publickey).") and host-key errors do NOT
  // start with "ssh:" and are intentionally NOT classified as transport — they
  // are not transient, so retrying would only waste a round-trip.
  if (/(^|\n)\s*ssh:/i.test(stderr)) return true;

  return false;
}

// Run with automatic connection pooling (preferred method).
//
// Self-healing (WARDEN-129): when a pooled `run()` fails with an SSH *transport*
// failure, evict the suspect connection (so the next call rebuilds the socket
// immediately instead of waiting out the ~90s keepalive window) and retry the
// command ONCE on a fresh connection. Retries are strictly transport-conditioned
// via isTransportFailure — and `isTransportFailure` matches only
// channel-establishment failures (the command provably never ran), so a genuine
// command non-zero exit — or an ambiguous mid-stream break after the command ran
// — is never retried. Side-effecting commands like `tmux send-keys` therefore
// cannot be double-executed.
//
// `deps` is an optional test seam (production callers omit it): inject
// `run` / `getConnection` / `markConnectionUnhealthy` to drive the retry
// sequence deterministically without spawning real ssh processes.
export async function runWithPool(host, cmd, opts = {}, cfg = {}, deps = {}) {
  const doRun = deps.run ?? run;
  const getConn = deps.getConnection ?? getConnection;
  const markUnhealthy = deps.markConnectionUnhealthy ?? markConnectionUnhealthy;

  if (host === '(local)') {
    return doRun(host, cmd, opts, cfg);
  }

  try {
    const conn = await getConn(host, cfg);
    const result = await doRun(host, cmd, { ...opts, socketPath: conn.socketPath }, cfg);
    releaseConnection(host);

    if (!result.ok && isTransportFailure(result)) {
      // Evict the wedged socket (awaiting its `-O exit` teardown so the dead master
      // is really gone), then retry once on a freshly built connection.
      await markUnhealthy(host);
      try {
        const freshConn = await getConn(host, cfg);
        const retry = await doRun(host, cmd, { ...opts, socketPath: freshConn.socketPath }, cfg);
        releaseConnection(host);
        return retry;
      } catch (e) {
        // Fresh connection could not be established — fall back to a direct ssh
        // call (no ControlPath). run() resolves {ok:false} rather than throwing.
        return doRun(host, cmd, opts, cfg);
      }
    }

    return result;
  } catch (e) {
    // Pool failed (ControlMaster unsupported, host down, etc.). Fall back to a
    // plain direct ssh call — never let a pool failure propagate and crash the
    // server. run() resolves {ok:false} on failure rather than throwing.
    return doRun(host, cmd, opts, cfg);
  }
}

// Attach with a PTY, inheriting stdio. Used by the CLI for `tmux attach` (remote).
export function attach(host, cmd, _opts = {}) {
  const remote = `bash -lc ${shellQuote(cmd)}`;
  const args = buildSshArgv(host, { tty: true, command: remote });
  const child = spawn(SSH_BIN, args, { stdio: 'inherit' });
  return new Promise((resolve) => child.on('exit', (c) => resolve(c ?? 0)));
}

// Live web pane (remote): ssh inside a real local PTY (node-pty) whose size we can
// change → SIGWINCH → ssh → remote tmux. Returns a node-pty IPty.
export function attachPty(host, cmd, { cols = 100, rows = 30 } = {}) {
  const remote = `export LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8; bash -lc ${shellQuote(cmd)}`;
  const args = buildSshArgv(host, { tty: true, command: remote });
  return nodePty.spawn(SSH_BIN, args, { cols, rows, useConpty: true });
}

// ---------------- local transport (this machine) ----------------

// MSYS2 env for Windows tmux. Only applies to the LEGACY Windows tmux path
// (WARDEN_WIN_TMUX=1); the native ConPTY path must NOT be handed an MSYS
// environment — that is precisely what forced every local Windows terminal into
// bash and broke Windows path handling (WARDEN-922). No-op on Linux/macOS.
export const LOCAL_ENV = process.platform === 'win32' && !isNativeLocal()
  ? { ...process.env, MSYSTEM: process.env.MSYSTEM || 'MSYS' }
  : process.env;

// Find tmux on this machine. Linux/macOS: 'tmux'. Windows (legacy path only):
// ABSOLUTE path preferred — node-pty's winpty doesn't reliably resolve a bare
// 'tmux' from PATH when spawning (it reports "File not found: "), so we use the
// full MSYS2 path.
//
// Load-time one-shot (WARDEN-440): this `spawnSync('where', ...)` runs ONCE at
// module import on win32. It is the documented "extreme necessity" exception to
// the async-spawn rule — it executes before the server starts serving, so it can
// never block a request or timer, and it must resolve before any tmux op can be
// issued. Synchronous here is safe; the hot local-tmux transport itself
// (runLocalTmux) is fully async.
//
// SKIPPED entirely under the native Windows transport (WARDEN-922): there is no
// tmux to find, so we neither probe for it nor pay the spawnSync at import.
const TMUX_BIN = (() => {
  if (process.platform !== 'win32') return 'tmux';
  if (isNativeLocal()) return '(native ConPTY)';
  const msys = 'C:/msys64/usr/bin/tmux.exe';
  if (fs.existsSync(msys)) return msys;
  try {
    const r = spawnSync('where', ['tmux'], { env: LOCAL_ENV, windowsHide: true, encoding: 'utf8' });
    const p = (r.stdout || '').split(/\r?\n/)[0].trim();
    if (p) return p.replace(/\\/g, '/');
  } catch { /* noop */ }
  return 'tmux';
})();
export { TMUX_BIN };

// Windows cwd → MSYS path (C:\Users\foo → /c/Users/foo). Identity elsewhere —
// AND identity under the native Windows transport (WARDEN-922), where the cwd is
// handed to ConPTY as a real Windows path and translating it would break it.
export function toMsysPath(p) {
  if (process.platform !== 'win32' || !p) return p || '';
  if (isNativeLocal()) return p;
  return p.replace(/^([A-Za-z]):[\\/]/, (_m, d) => `/${d.toLowerCase()}/`).replace(/\\/g, '/');
}

// Run tmux locally with argv. Returns a Promise of {ok, code, stdout, stderr}.
//
// ASYNC (WARDEN-440): uses async `spawn()` — NOT `spawnSync` — so the Node event
// loop is NEVER held while tmux runs. The local tmux path (read/send/spawn/kill/
// probe/resize via runTmux, the 2s pane monitor's per-pane capture, the catalog
// alive/list-sessions sweep) all flow through here, so a single synchronous
// `spawnSync` anywhere on it froze the ENTIRE server (every HTTP request, WS
// frame, and timer queued behind it) for the child's duration — see WARDEN-88
// Anti-Pattern 1B. `opts.timeout` (ms) reproduces spawnSync's bounded behavior:
// we SIGTERM the child when the budget is exceeded (only armed for a positive
// finite timeout, so an absent timeout never fires a 0ms kill). Shape mirrors
// the remote `run()` path so runTmux's local and remote branches stay symmetric.
export function runLocalTmux(args, opts = {}) {
  // Native local Windows (WARDEN-922): the same tmux argv is executed against the
  // in-process ConPTY session registry instead of an MSYS2 tmux binary. Same
  // {ok, code, stdout, stderr} contract, so every caller is unchanged.
  if (isNativeLocal()) return runNative(args, opts);
  return new Promise((resolve) => {
    const child = spawn(TMUX_BIN, args, { env: LOCAL_ENV, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const ms = Number.isFinite(opts.timeout) ? opts.timeout : null;
    const timer = ms && ms > 0 ? setTimeout(() => child.kill('SIGTERM'), ms) : null;
    // The stdout/stderr accumulation + 'close'-not-'exit' settlement is the shared
    // core — see captureAndSettle (childCapture.js). It matters especially here:
    // this is the pane-capture transport, and `capture-pane -p -e` output is full
    // of multibyte box drawing while /api/pane-export captures 5000 lines (hundreds
    // of KB), so the read arrives in many chunks and both the utf8 decoder state
    // and the full drain are load-bearing. `timer` is null when no finite positive
    // timeout was given, which captureAndSettle tolerates.
    captureAndSettle(child, resolve, {
      timer,
      onSpawnError: (err, stdout, stderr) => ({ ok: false, code: -1, stdout, stderr: stderr + String(err) }),
    });
  });
}

// Local live pane: spawn tmux attach in a local PTY (node-pty).
//
// Native local Windows (WARDEN-922): there is no tmux to attach to — the session
// IS a node-pty already, so this returns a per-client VIEW of it (the identical
// onData/onExit/write/resize/kill surface server.js drives). Detaching a client
// does not end the session, matching `tmux attach` semantics.
export function attachLocalTmux(args, { cols = 100, rows = 30 } = {}) {
  if (isNativeLocal()) return attachNative(args, { cols, rows });
  const env = { ...LOCAL_ENV, LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' };
  return nodePty.spawn(TMUX_BIN, args, { cols, rows, env, useConpty: true });
}

// ---------------- unified tmux transport ----------------
// `args` is a tmux argv (without the leading `tmux`). Routes by chat.host.
// For a yatfa chat (container set) on a remote, prefixes `docker exec <c>`.

export async function runTmux(chat, args, opts = {}) {
  if (chat.host === '(local)') return runLocalTmux(args, { timeout: opts.timeout });
  const prefix = chat.container ? `docker exec ${shellQuote(chat.container)} ` : '';

  // Use pooled connection for remote hosts
  try {
    const cmd = prefix + 'tmux ' + args.map(shellQuote).join(' ');
    return await runWithPool(chat.host, cmd, opts, {});
  } catch (e) {
    if (e instanceof HostConnectionError) {
      throw e;
    }
    // Fallback to direct connection
    return run(chat.host, prefix + 'tmux ' + args.map(shellQuote).join(' '), opts);
  }
}

export function attachTmux(chat, args, { cols = 100, rows = 30 } = {}) {
  if (chat.host === '(local)') return attachLocalTmux(args, { cols, rows });
  // attach needs a tty: `docker exec -it` for yatfa containers.
  const prefix = chat.container ? `docker exec -it ${shellQuote(chat.container)} ` : '';
  return attachPty(chat.host, prefix + 'tmux ' + args.map(shellQuote).join(' '), { cols, rows });
}

// Extensions Windows can actually LAUNCH — `.exe`/`.com` are executable images
// CreateProcess runs directly, `.cmd`/`.bat` are scripts cmd.exe runs. Anything
// else `where` reports (notably npm's extensionless POSIX shim and its `.ps1`
// sibling) is not something ConPTY can start.
const LAUNCHABLE_EXT = /\.(exe|com|cmd|bat)$/i;

// Resolve a binary through the WINDOWS PATH (`where`), PATHEXT-aware. Returns an
// absolute path to a LAUNCHABLE hit (see LAUNCHABLE_EXT — not merely the first
// line; see the note at the resolve below), or null. Async (WARDEN-440): never
// blocks the event loop. `deps.spawn` is a test seam so the Windows branch is
// assertable from a Linux CI runner.
export function whereWindows(bin, deps = {}) {
  const sp = deps.spawn ?? spawn;
  return new Promise((resolve) => {
    let out = '';
    let child;
    try {
      child = sp('where', [bin], { env: LOCAL_ENV, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      return resolve(null);
    }
    child.stdout.on('data', (d) => { out += d; });
    child.on('error', () => resolve(null));
    // 'close' (not 'exit') so stdout has fully drained before we read it.
    child.on('close', (code) => {
      if (code !== 0) return resolve(null);
      const hits = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      // NOT simply `hits[0]`. `where` lists the EXACT-name match first, and npm on
      // Windows drops three files in its prefix dir — `claude`, `claude.cmd`,
      // `claude.ps1` — so the first line of the overwhelmingly common install is
      // the EXTENSIONLESS POSIX shim (the same shape as the familiar
      // `where npm` → `…\nodejs\npm` then `…\nodejs\npm.cmd`). That shim is not a
      // launchable image: CreateProcess/ConPTY cannot run it, and handing it to
      // cmd.exe would only work by accident, via cmd's implicit PATHEXT search.
      // Choose the launchable entry explicitly instead — that is what makes
      // buildLaunch's `.cmd` → %ComSpec% branch the branch that actually runs.
      resolve(hits.find((p) => LAUNCHABLE_EXT.test(p)) || hits[0] || null);
    });
  });
}

// Find the `claude` binary on this machine / host → returns the full path or null.
// claude is often in a dir added by .zshrc (e.g. ~/.local/bin), which `bash -lc`
// (what tmux's shell runs) does NOT source — so we try zsh interactive login first.
//
// `deps` is an optional test seam (production callers omit it): inject
// `runWithPool` to drive the remote candidate probes deterministically without
// spawning real ssh — mirroring the deps seams on runWithPool/discover so the
// WARDEN-440 concurrency (all probes in flight at once, not serial) is assertable.
export async function detectClaude(host, deps = {}) {
  const run = deps.runWithPool ?? runWithPool;
  if (host === '(local)') {
    const exe = process.env.CLAUDE_CODE_EXECPATH;
    if (exe && fs.existsSync(exe)) return exe;
    // Windows (WARDEN-922): resolve through the WINDOWS PATH, not a Unix lookup.
    // Two reasons the old `spawn('claude', ['--version'])` probe could not work
    // here: (a) npm installs claude as a `claude.cmd` shim, which CreateProcess
    // (and therefore child_process.spawn without a shell) cannot execute at all,
    // so the probe reported "not found" on a machine where claude was installed;
    // (b) the caller needs the FULL PATH — a bare `claude` is not launchable by
    // ConPTY for the same .cmd reason. `where` gives us both, PATHEXT-aware, and
    // costs one async spawn.
    if (process.platform === 'win32') {
      return whereWindows('claude', deps);
    }
    // ASYNC spawn (WARDEN-440): `claude --version` is a Node CLI cold-start; a
    // synchronous spawnSync here held the event loop for its duration on every
    // /api/claude-sessions hit. stdio is ignored — we only care about exit status.
    const ok = await new Promise((resolve) => {
      const child = spawn('claude', ['--version'], { env: LOCAL_ENV, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore'] });
      child.on('error', () => resolve(false));
      child.on('exit', (code) => resolve(code === 0));
    });
    return ok ? 'claude' : null;
  }
  // Run the candidate probes CONCURRENTLY (WARDEN-440): the previous serial loop
  // issued up to 3 SSH probes in series, each on an 8s timeout — a single slow or
  // wedged host stalled /api/claude-sessions + /api/resume for ~10–24s (WARDEN-88
  // Anti-Pattern 1A). Promise.all collapses that to ≈ one timeout (≤8s) regardless
  // of how many probes miss. Priority is preserved by evaluating results in order
  // (zsh login → bash login → explicit path search) and returning the first
  // `/`-prefixed hit — the same preference the serial short-circuit expressed.
  // Each probe is caught so a transport error on one candidate can't reject the
  // whole search; runWithPool already resolves (never throws) on failure, this is
  // belt-and-suspenders — and it stays: execInContext resolves too, so the belt
  // is harmless on the companion path as well.
  const cmds = [
    'zsh -lic "command -v claude" 2>/dev/null',
    'bash -lc "command -v claude" 2>/dev/null',
    'for p in ~/.local/bin/claude /opt/homebrew/bin/claude /usr/local/bin/claude ~/bin/claude ~/n/bin/claude; do [ -x "$p" ] && { echo "$p"; break; }; done',
  ];
  // WARDEN-1284 (companion transport): the three probes deliver through the
  // shared routing guard, so under the `companionTransportEnabled` toggle they
  // ride the persistent companion channel. Unlike the other eight legs this one
  // IS pooled today (the `run` above is runWithPool), but a cold pool still pays
  // a real handshake per probe — and this fan is one half of
  // `/api/claude-sessions` (the other being remoteClaudeSessionsDetail), so
  // leaving it on raw SSH would keep that endpoint paying handshakes under the
  // toggle. PARITY: the probe strings are unchanged and delivered byte-for-byte
  // by either transport (no container → the companion runs them via `bash -lc`,
  // run()'s exact delivery shape); the toggle-off path is still `run(...)`, i.e.
  // runWithPool with its pooling and its transport-failure retry intact.
  //
  // ⚠️ WHY A LAZY import() AND NOT A STATIC ONE. companion.js imports THIS module
  // (`run as defaultRun`, SSH_BIN, buildSshArgv, shellQuote), so a static import
  // here would make ssh.js ⇄ companion.js a true cycle — ssh.js is the graph's
  // bottom leaf and every other module in the repo depends on that staying true.
  // ESM would tolerate the cycle (neither module touches the other at module-eval
  // time), but "the leaf imports nothing of ours" is worth more than saving one
  // cached await on a 3-probe fan that already costs ≤8s. The dynamic import is
  // resolved ONCE by the module cache; `deps.deliverRemoteScript` skips it
  // entirely for tests. The other eight WARDEN-1284 legs import it statically —
  // they are not the leaf.
  //
  // The default-path transport rides `opts.run` (NOT `deps.run`): this leg's
  // toggle-off path is `runWithPool`, while `deps.run` is the companion
  // BOOTSTRAP transport — conflating the two would silently re-route the binary
  // upload through the pool. The existing `deps.runWithPool` seam is unchanged.
  const deliver = deps.deliverRemoteScript
    ?? (await import('./companion.js')).deliverRemoteScript;
  const results = await Promise.all(cmds.map((cmd) =>
    deliver(host, cmd, { timeout: 8000, run }, {}, deps)
      .catch(() => ({ ok: false, code: -1, stdout: '', stderr: '' })),
  ));
  for (const r of results) {
    const p = (r.stdout || '').trim().split(/\r?\n/).pop().trim();
    if (p.startsWith('/')) return p;
  }
  return null;
}

export function attachInteractiveTmux(chat, args) {
  // CLI: stdio-inherit. Local spawns tmux directly; remote goes over ssh.
  if (chat.host === '(local)') {
    // Native local Windows (WARDEN-922): local sessions live INSIDE the Warden
    // server process, so a separate CLI process has nothing to attach to. Say so
    // plainly rather than failing with a confusing "tmux not found" — the web
    // pane is the way in, and remote chats (still tmux) are unaffected.
    if (isNativeLocal()) {
      console.error(
        'Local Windows chats run natively in the Warden process (no tmux), so `attach` from the CLI\n' +
        'cannot reach them. Open the chat in the Warden dashboard instead (`warden ui`).\n' +
        'Remote chats still attach normally: warden attach --host <host>',
      );
      return Promise.resolve(1);
    }
    const child = spawn(TMUX_BIN, args, { stdio: 'inherit', env: LOCAL_ENV });
    return new Promise((res) => child.on('exit', (c) => res(c ?? 0)));
  }
  // For remote: after tmux exits (detached), continue to an interactive shell.
  // This keeps the SSH session open and drops the user at a shell prompt.
  // Command structure: tmux attach -t agent; <shell>
  const prefix = chat.container ? `docker exec -it ${shellQuote(chat.container)} ` : '';
  const tmuxCmd = prefix + 'tmux ' + args.map(shellQuote).join(' ');

  // Build the shell command that runs after tmux exits.
  // For docker: skip cwd (host path doesn't exist in container), just start bash.
  // For bare: use cwd if available (it's a valid host path).
  const shellCmd = chat.container
    ? `docker exec -it ${shellQuote(chat.container)} bash`
    : (chat.cwd ? `bash -lc ${shellQuote(`cd ${shellQuote(chat.cwd)} && exec bash`)}` : `bash`);

  const cmd = `${tmuxCmd}; ${shellCmd}`;
  return attach(chat.host, cmd);
}
