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
];
const SSH_BIN = process.platform === 'win32' ? 'ssh.exe' : 'ssh';

// ---------------- SSH transport (remote hosts) ----------------

// Run a remote command, capture stdout/stderr. Returns {ok, code, stdout, stderr}.
export function run(host, cmd, opts = {}) {
  const timeout = opts.timeout ?? 30000;
  const connectTimeout = Math.min(20, Math.max(3, Math.ceil(timeout / 1000)));
  const remote = `bash -lc ${shellQuote(cmd)}`;
  const args = [...SSH_BASE_OPTS, '-o', `ConnectTimeout=${connectTimeout}`, host, remote];
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
  const remote = `bash -lc ${shellQuote(cmd)}`;
  const args = ['-tt', ...SSH_BASE_OPTS, host, remote];
  return nodePty.spawn(SSH_BIN, args, { cols, rows, useConpty: false });
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
  return nodePty.spawn(TMUX_BIN, args, { cols, rows, env: LOCAL_ENV, useConpty: false });
}

// ---------------- unified tmux transport ----------------
// `args` is a tmux argv (without the leading `tmux`). Routes by chat.host.
// For a yatfa chat (container set) on a remote, prefixes `docker exec <c>`.

export async function runTmux(chat, args, opts = {}) {
  if (chat.host === '(local)') return runLocalTmux(args);
  const prefix = chat.container ? `docker exec ${shellQuote(chat.container)} ` : '';
  return run(chat.host, prefix + 'tmux ' + args.map(shellQuote).join(' '), opts);
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
    const r = await run(host, cmd, { timeout: 8000 });
    const p = (r.stdout || '').trim().split(/\r?\n/).pop().trim();
    if (p.startsWith('/')) return p;
  }
  const r = await run(host, 'for p in ~/.local/bin/claude /opt/homebrew/bin/claude /usr/local/bin/claude ~/bin/claude ~/n/bin/claude; do [ -x "$p" ] && { echo "$p"; break; }; done', { timeout: 8000 });
  const p2 = (r.stdout || '').trim();
  return p2.startsWith('/') ? p2 : null;
}

export function attachInteractiveTmux(chat, args) {
  // CLI: stdio-inherit. Local spawns tmux directly; remote goes over ssh.
  if (chat.host === '(local)') {
    const child = spawn(TMUX_BIN, args, { stdio: 'inherit', env: LOCAL_ENV });
    return new Promise((res) => child.on('exit', (c) => res(c ?? 0)));
  }
  const prefix = chat.container ? `docker exec -it ${shellQuote(chat.container)} ` : '';
  return attach(chat.host, prefix + 'tmux ' + args.map(shellQuote).join(' '));
}
