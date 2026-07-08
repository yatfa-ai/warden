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

const SSH_BASE_OPTS = [
  '-o', 'BatchMode=yes', // key auth only — never hang on a password prompt
  '-o', 'StrictHostKeyChecking=accept-new',
  '-o', 'ServerAliveInterval=30',  // Keep-alive for persistent connections
  '-o', 'ServerAliveCountMax=3',   // 3 unresponsive keep-alives → disconnect
];
const SSH_BIN = process.platform === 'win32' ? 'ssh.exe' : 'ssh';

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

async function ensureControlMaster(host, cfg) {
  const socketPath = `${controlMasterPath()}-${host.replace(/[^a-zA-Z0-9]/g, '_')}`;
  const timeout = (cfg?.connectTimeout ?? 10);

  // Check if master is already running
  const checkResult = spawnSync(SSH_BIN, ['-O', 'check', '-S', socketPath, host], {
    windowsHide: true,
    timeout: 2000,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  if (checkResult.status === 0) {
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

  const cached = connectionPool.get(host);
  const timeout = (cfg?.connectTimeout ?? 10);

  // Return existing healthy connection
  if (cached && cached.healthy && cached.socketPath) {
    // Verify the control socket is still valid
    const checkResult = spawnSync(SSH_BIN, ['-O', 'check', '-S', cached.socketPath, host], {
      windowsHide: true,
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    if (checkResult.status === 0) {
      cached.refs++;
      cached.lastUsed = Date.now();
      return { socketPath: cached.socketPath, existing: true };
    } else {
      // Control master died, remove from pool
      connectionPool.delete(host);
    }
  }

  // Establish new connection
  try {
    const { socketPath, existing, process } = await ensureControlMaster(host, { connectTimeout: timeout });

    // Monitor process exit to mark connection unhealthy
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

function markConnectionUnhealthy(host) {
  const cached = connectionPool.get(host);
  if (cached) {
    cached.healthy = false;
    // Terminate the control master
    try {
      spawnSync(SSH_BIN, ['-O', 'exit', '-S', cached.socketPath, host], {
        windowsHide: true,
        timeout: 5000,
        stdio: ['ignore', 'pipe', 'pipe']
      });
    } catch (e) {
      // Ignore errors during cleanup
    }
    connectionPool.delete(host);
  }
}

// Background cleanup for idle connections
export function startConnectionPoolCleanup() {
  setInterval(() => {
    const now = Date.now();
    for (const [host, state] of connectionPool.entries()) {
      if (state.refs === 0 && (now - state.lastUsed) > POOL_IDLE_TIMEOUT) {
        // Close idle connection
        try {
          spawnSync(SSH_BIN, ['-O', 'exit', '-S', state.socketPath, host], {
            windowsHide: true,
            timeout: 5000,
            stdio: ['ignore', 'pipe', 'pipe']
          });
        } catch (e) {
          // Ignore errors during cleanup
        }
        connectionPool.delete(host);
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
export function run(host, cmd, opts = {}, cfg = {}) {
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
    const child = spawn(SSH_BIN, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, code: -1, stdout, stderr: stderr + String(err) });
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, code: code ?? -1, stdout, stderr });
    });
  });
}

// Run with automatic connection pooling (preferred method)
export async function runWithPool(host, cmd, opts = {}, cfg = {}) {
  if (host === '(local)') {
    return run(host, cmd, opts, cfg);
  }

  try {
    const conn = await getConnection(host, cfg);
    const result = await run(host, cmd, { ...opts, socketPath: conn.socketPath }, cfg);
    releaseConnection(host);
    return result;
  } catch (e) {
    if (e instanceof HostConnectionError) {
      throw e;
    }
    // Fallback to direct connection if pooling fails
    return run(host, cmd, opts, cfg);
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

// Run tmux locally with argv. Returns {ok, code, stdout, stderr}.
export function runLocalTmux(args) {
  const r = spawnSync(TMUX_BIN, args, { env: LOCAL_ENV, windowsHide: true, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
  return { ok: r.status === 0, code: r.status ?? -1, stdout: r.stdout || '', stderr: r.stderr || '' };
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
  if (chat.host === '(local)') return runLocalTmux(args);
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
export async function detectClaude(host) {
  if (host === '(local)') {
    const exe = process.env.CLAUDE_CODE_EXECPATH;
    if (exe && fs.existsSync(exe)) return exe;
    try { if (spawnSync('claude', ['--version'], { env: LOCAL_ENV, windowsHide: true }).status === 0) return 'claude'; } catch { /* noop */ }
    return null;
  }
  for (const cmd of ['zsh -lic "command -v claude" 2>/dev/null', 'bash -lc "command -v claude" 2>/dev/null']) {
    const r = await runWithPool(host, cmd, { timeout: 8000 }, {});
    const p = (r.stdout || '').trim().split(/\r?\n/).pop().trim();
    if (p.startsWith('/')) return p;
  }
  const r = await runWithPool(host, 'for p in ~/.local/bin/claude /opt/homebrew/bin/claude /usr/local/bin/claude ~/bin/claude ~/n/bin/claude; do [ -x "$p" ] && { echo "$p"; break; }; done', { timeout: 8000 }, {});
  const p2 = (r.stdout || '').trim();
  return p2.startsWith('/') ? p2 : null;
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
