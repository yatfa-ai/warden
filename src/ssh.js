// Transports for warden: run commands either over SSH (remote hosts) or locally
// (this machine). tmux is required everywhere, so a "chat" is always a tmux
// session; the only difference is whether tmux runs here or on a remote host.
import { spawn, spawnSync } from 'node:child_process';
import * as nodePty from 'node-pty';
import fs from 'node:fs';

// POSIX single-quote. Safe for the local ssh arg layer and remote bash.
export function shellQuote(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

export const SSH_BASE_OPTS = [
  '-o', 'BatchMode=yes', // key auth only — never hang on a password prompt
  '-o', 'StrictHostKeyChecking=accept-new',
  '-o', 'ServerAliveInterval=30',  // Keep-alive for persistent connections
  '-o', 'ServerAliveCountMax=3',   // 3 unresponsive keep-alives → disconnect
];
export const SSH_BIN = process.platform === 'win32' ? 'ssh.exe' : 'ssh';

// ---------------- Connection Pool ----------------
// Persistent SSH connections to remote hosts. Reused across operations for
// better performance (no repeated SSH handshakes) and reliability (fewer
// connection attempts = fewer transient failures).

const connectionPool = new Map(); // host -> { conn: SSHClient, lastUsed: number, refs: number, healthy: boolean }
const POOL_IDLE_TIMEOUT = 5 * 60 * 1000; // 5 minutes
const POOL_HEALTH_CHECK_INTERVAL = 60 * 1000; // 1 minute

// Simple SSH client wrapper for persistent connections.
// NOTE: This class is currently unused. The implementation uses SSH ControlMaster
// sockets instead (see ensureControlMaster below). This class is retained for
// potential future implementation alternatives or reference.
class SSHClient {
  constructor(host, connectTimeout) {
    this.host = host;
    this.connectTimeout = connectTimeout;
    this.destroyed = false;
    this.pendingCommands = new Map(); // id -> { resolve, reject, timer }
    this.commandId = 0;
    this.process = null;
    this.buffer = '';
    this.currentCommand = null;
  }

  async connect() {
    return new Promise((resolve, reject) => {
      const args = [...SSH_BASE_OPTS, '-o', `ConnectTimeout=${this.connectTimeout}`, this.host];
      const child = spawn(SSH_BIN, args, { windowsHide: true });
      this.process = child;

      let connected = false;
      const connectTimer = setTimeout(() => {
        if (!connected) {
          this.destroy();
          reject(new Error(`SSH connection timeout to ${this.host}`));
        }
      }, this.connectTimeout * 1000);

      child.on('error', (err) => {
        clearTimeout(connectTimer);
        this.destroy();
        reject(new Error(`SSH connection failed to ${this.host}: ${err.message}`));
      });

      // SSH master mode: we use multiplexing for persistent connections
      // For now, we'll use a simpler approach: keep the process alive and use stdin for commands
      // But SSH doesn't work that way - we need ControlMaster for real pooling

      // For the initial implementation, we'll use SSH ControlMaster sockets
      // This is the standard way to do SSH connection pooling
    });
  }

  destroy() {
    this.destroyed = true;
    if (this.process) {
      this.process.kill('SIGTERM');
      this.process = null;
    }
    // Clear all pending commands
    for (const { timer, reject } of this.pendingCommands.values()) {
      clearTimeout(timer);
      reject(new Error('SSH connection destroyed'));
    }
    this.pendingCommands.clear();
  }
}

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
    const child = spawn(SSH_BIN, ['-O', sub, '-S', socketPath, host], {
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

async function ensureControlMaster(host, cfg) {
  const socketPath = `${controlMasterPath()}-${host.replace(/[^a-zA-Z0-9]/g, '_')}`;
  const timeout = (cfg?.connectTimeout ?? 10);

  // Check if master is already running (async — never blocks the event loop).
  if ((await sshControl(host, socketPath, 'check', 2000)) === 0) {
    return { socketPath, existing: true };
  }

  // Start new control master
  const args = [
    '-o', 'ControlMaster=yes',
    '-o', 'ControlPath=' + socketPath,
    '-o', 'ControlPersist=10m',  // Keep alive for 10 minutes after last use
    '-o', `ConnectTimeout=${timeout}`,
    '-N',  // No remote command
    host
  ];

  return new Promise((resolve, reject) => {
    const child = spawn(SSH_BIN, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`ControlMaster connect timeout to ${host}`));
    }, timeout * 1000 + 5000);

    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`ControlMaster spawn failed: ${err.message}`));
    });

    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve({ socketPath, existing: false, process: child });
      } else {
        reject(new Error(`ControlMaster failed to ${host}: ${stderr || `exit ${code}`}`));
      }
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

// Pre-warm connection pool for configured hosts
export async function preWarmConnectionPool(hosts, cfg) {
  const remoteHosts = hosts.filter(h => h !== '(local)');
  if (remoteHosts.length === 0) return;

  console.log(`[SSH pool] Pre-warming connections for ${remoteHosts.length} hosts...`);
  const results = await Promise.allSettled(
    remoteHosts.map(async (host) => {
      try {
        await getConnection(host, cfg);
        releaseConnection(host);
        console.log(`[SSH pool] Pre-warmed connection to ${host}`);
      } catch (e) {
        console.warn(`[SSH pool] Failed to pre-warm ${host}:`, e.message);
      }
    })
  );

  const succeeded = results.filter(r => r.status === 'fulfilled').length;
  const failed = results.filter(r => r.status === 'rejected').length;
  console.log(`[SSH pool] Pre-warming complete: ${succeeded} succeeded, ${failed} failed`);
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

  // Build args with optional ControlMaster for connection pooling
  const args = [...SSH_BASE_OPTS, '-o', `ConnectTimeout=${connectTimeout}`];

  // Add ControlPath if we have a pooled connection
  const socketPath = opts.socketPath;
  if (socketPath) {
    args.push('-o', 'ControlPath=' + socketPath);
  }

  args.push(host, remote);

  return new Promise((resolve) => {
    const child = spawnFn(SSH_BIN, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, code: -1, stdout, stderr: stderr + String(err) });
    });
    // 'close' (NOT 'exit') — see the function header: 'close' fires only after the
    // stdio streams drain, so stdout/stderr are complete. 'exit' can fire first and,
    // under the fleet-wide concurrency, capture empty stdout (false-clean git-status)
    // (WARDEN-464/766). 'close' passes the same `code`, so the {ok, code, stdout, stderr}
    // contract is unchanged — it only makes stdout complete, which helps (not hazards)
    // isTransportFailure's classifier: it sees real stdout instead of an emptied one.
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, code: code ?? -1, stdout, stderr });
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
  const args = ['-tt', ...SSH_BASE_OPTS, host, remote];
  const child = spawn(SSH_BIN, args, { stdio: 'inherit' });
  return new Promise((resolve) => child.on('exit', (c) => resolve(c ?? 0)));
}

// Live web pane (remote): ssh inside a real local PTY (node-pty) whose size we can
// change → SIGWINCH → ssh → remote tmux. Returns a node-pty IPty.
export function attachPty(host, cmd, { cols = 100, rows = 30 } = {}) {
  const remote = `export LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8; bash -lc ${shellQuote(cmd)}`;
  const args = ['-tt', ...SSH_BASE_OPTS, host, remote];
  return nodePty.spawn(SSH_BIN, args, { cols, rows, useConpty: true });
}

// ---------------- local transport (this machine) ----------------

// MSYS2 env for Windows tmux (no-op on Linux/macOS).
export const LOCAL_ENV = process.platform === 'win32'
  ? { ...process.env, MSYSTEM: process.env.MSYSTEM || 'MSYS' }
  : process.env;

// Find tmux on this machine. Linux/macOS: 'tmux'. Windows: ABSOLUTE path preferred —
// node-pty's winpty doesn't reliably resolve a bare 'tmux' from PATH when spawning
// (it reports "File not found: "), so we use the full MSYS2 path.
//
// Load-time one-shot (WARDEN-440): this `spawnSync('where', ...)` runs ONCE at
// module import on win32. It is the documented "extreme necessity" exception to
// the async-spawn rule — it executes before the server starts serving, so it can
// never block a request or timer, and it must resolve before any tmux op can be
// issued. Synchronous here is safe; the hot local-tmux transport itself
// (runLocalTmux) is fully async.
const TMUX_BIN = (() => {
  if (process.platform !== 'win32') return 'tmux';
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

// Windows cwd → MSYS path (C:\Users\foo → /c/Users/foo). Identity elsewhere.
export function toMsysPath(p) {
  if (process.platform !== 'win32' || !p) return p || '';
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
  return new Promise((resolve) => {
    const child = spawn(TMUX_BIN, args, { env: LOCAL_ENV, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const ms = Number.isFinite(opts.timeout) ? opts.timeout : null;
    const timer = ms && ms > 0 ? setTimeout(() => child.kill('SIGTERM'), ms) : null;
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      resolve({ ok: false, code: -1, stdout, stderr: stderr + String(err) });
    });
    // Resolve on 'close' (NOT 'exit'): 'close' fires only AFTER the stdio streams
    // have fully drained, so stdout/stderr hold the COMPLETE output. 'exit' can
    // fire while buffered pipe data is still being read — for a large capture
    // (e.g. full-scrollback `capture-pane -S - -E -`, which can exceed the 64KB
    // pipe buffer) that would truncate the tail and lose the most-recent content.
    // The old spawnSync returned complete stdout; 'close' preserves that.
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ ok: code === 0, code: code ?? -1, stdout, stderr });
    });
  });
}

// Local live pane: spawn tmux attach in a local PTY (node-pty).
export function attachLocalTmux(args, { cols = 100, rows = 30 } = {}) {
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
  // belt-and-suspenders.
  const cmds = [
    'zsh -lic "command -v claude" 2>/dev/null',
    'bash -lc "command -v claude" 2>/dev/null',
    'for p in ~/.local/bin/claude /opt/homebrew/bin/claude /usr/local/bin/claude ~/bin/claude ~/n/bin/claude; do [ -x "$p" ] && { echo "$p"; break; }; done',
  ];
  const results = await Promise.all(cmds.map((cmd) =>
    run(host, cmd, { timeout: 8000 }, {}).catch(() => ({ ok: false, code: -1, stdout: '', stderr: '' })),
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
