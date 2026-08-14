// Native local-Windows terminal transport (WARDEN-922).
//
// On Windows, Warden's local transport used to be Unix at its core: every local
// chat was an MSYS2 tmux session (`C:/msys64/usr/bin/tmux.exe` under
// `MSYSTEM=MSYS`), so "spawn a terminal" opened *bash* — the user never asked for
// bash — and `claude --resume <id>` failed because a Windows-installed `claude`
// isn't visible to `bash -lc "command -v claude"` and Windows paths break under
// MSYS path translation.
//
// This module removes tmux from the LOCAL WINDOWS path entirely. Warden already
// drives the live pane with node-pty and `useConpty: true`; the only thing that
// changes is WHAT node-pty spawns — the native shell directly, exactly the
// primitive VSCode's integrated terminal uses. Everything else (Linux/macOS
// local, remote SSH, docker/yatfa) is untouched and still tmux.
//
// The shape of the integration: the rest of Warden speaks *tmux argv* through
// ssh.js `runLocalTmux` / `attachLocalTmux`. Rather than rewrite every call site,
// this module implements the small tmux argv subset Warden actually issues
// (new-session / has-session / kill-session / list-sessions / capture-pane /
// send-keys / set-buffer / paste-buffer / set-option / display-message / attach)
// against an IN-PROCESS registry of ConPTY sessions. Call sites keep their single
// local/remote branch; only the local-Windows implementation of that branch moves.
//
// DELIBERATE BEHAVIOR CHANGE (decided in WARDEN-922, not an oversight): a local
// Windows session lives in the Warden process and does NOT survive Warden being
// closed — same contract as VSCode's integrated terminal. Detached survival
// across a restart remains a property of remote/cross-host chats (still tmux). A
// local pty-host daemon that would restore detached local persistence is
// explicitly out of scope.
//
// Detach ≠ kill: `attachNative()` hands back a per-client VIEW over the session
// (server.js calls `pty.kill()` on detach and on ws close). Killing a client
// unsubscribes that client only; the session keeps running so re-attach works,
// which is the tmux behavior the pane lifecycle assumes.
import nodePty from 'node-pty';
import fs from 'node:fs';
import { stripAnsi } from './agentState.js';

// Escape hatch: WARDEN_WIN_TMUX=1 forces the legacy MSYS2-tmux local path on
// Windows (for anyone whose workflow depends on detached-across-restart local
// sessions). Anything non-win32 is never native — Linux/macOS stay on real tmux.
export function isNativeLocal(env = process.env, platform = process.platform) {
  if (platform !== 'win32') return false;
  return env.WARDEN_WIN_TMUX !== '1';
}

// ---------------- scrollback ----------------

const MAX_LINES = 5000;

// A line-oriented approximation of tmux's `capture-pane`.
//
// tmux keeps a full terminal screen model, so `capture-pane` returns rendered
// lines. We do not run a headless emulator server-side, so we keep the pty's
// output as lines and apply the two rewrites that actually matter for the two
// consumers Warden has (the transcript read and the one-line activity preview):
// a bare `\r` restarts the current line (spinners / progress bars last-write-wins)
// and `\b` deletes the previous character. Cursor-addressing escapes are NOT
// replayed — the LIVE pane is unaffected by this (it receives the raw byte
// stream and renders it in a real xterm), this only shapes capture-pane output.
export class Scrollback {
  constructor(max = MAX_LINES) {
    this.lines = [''];
    this.max = max;
  }

  write(chunk) {
    const s = String(chunk).replace(/\r\n/g, '\n');
    for (const ch of s) {
      if (ch === '\n') {
        this.lines.push('');
        // `max` bounds COMPLETED lines; the trailing element is the still-open
        // current line, so the cap is max+1 entries.
        if (this.lines.length > this.max + 1) this.lines.splice(0, this.lines.length - (this.max + 1));
      } else if (ch === '\r') {
        this.lines[this.lines.length - 1] = '';
      } else if (ch === '\b') {
        const cur = this.lines[this.lines.length - 1];
        this.lines[this.lines.length - 1] = cur.slice(0, -1);
      } else {
        this.lines[this.lines.length - 1] += ch;
      }
    }
  }

  // `lines: null` → the whole scrollback (tmux `-S -`). `ansi: false` → strip the
  // escape sequences (tmux only keeps them when `-e` is passed).
  capture({ ansi = false, lines = null } = {}) {
    let out = this.lines;
    // A trailing empty element is the (still-unterminated) current line, not a
    // real blank line — tmux would not report it as content.
    if (out.length > 1 && out[out.length - 1] === '') out = out.slice(0, -1);
    if (lines != null && out.length > lines) out = out.slice(out.length - lines);
    const text = out.join('\n');
    return ansi ? text : stripAnsi(text);
  }

  // True when the current line is still OPEN — the byte stream did not end with a
  // newline, so the cursor sits mid-line (a live shell prompt awaiting input is
  // the normal case). `capture()` keeps that open line's text but, having joined
  // with `\n`, cannot say whether the terminal ever emitted a line ending after
  // it. The attach replay needs exactly that distinction: it may only restore an
  // ending `capture()` structurally dropped, never fabricate one.
  get openLine() { return this.lines[this.lines.length - 1] !== ''; }
}

// `capture()` returns tmux `capture-pane` TEXT — `\n`-separated lines, with every
// `\r` already consumed by the line model above. That is correct for its two
// consumers (the transcript read and the activity preview), and matches what real
// `tmux capture-pane -p` emits. But the attach replay feeds that same string to a
// real xterm constructed with `convertEol: false`, where a bare LF moves the
// cursor DOWN without returning it to column 0 — so the replayed screen
// staircases. A terminal byte stream needs CRLF; the captured text does not.
// Convert at that boundary only, never in `capture()` itself.
function toCrlf(s) { return String(s).replace(/\r?\n/g, '\r\n'); }

// ---------------- key + argv helpers ----------------

// tmux key names → the bytes a terminal actually sends. Mirrors tmux.js
// ALLOWED_KEYS (the trust boundary stays in tmux.js; this is just the encoding).
const KEYS = {
  Enter: '\r',
  Escape: '\x1b',
  'C-c': '\x03',
  'C-d': '\x04',
  'C-u': '\x15',
  'C-k': '\x0b',
  Tab: '\t',
  BSpace: '\x7f',
  Up: '\x1b[A',
  Down: '\x1b[B',
  Right: '\x1b[C',
  Left: '\x1b[D',
  Home: '\x1b[H',
  End: '\x1b[F',
  PageUp: '\x1b[5~',
  PageDown: '\x1b[6~',
  Space: ' ',
  F1: '\x1bOP',
  F2: '\x1bOQ',
};

function flagValue(args, flag) {
  const i = args.indexOf(flag);
  return i > -1 && i + 1 < args.length ? args[i + 1] : null;
}

// tmux `-S -N` (N lines back) / `-S -` (everything). Returns a positive line
// count, or null for "all".
function captureDepth(args) {
  const raw = flagValue(args, '-S');
  if (raw == null || raw === '-') return null;
  const n = Number.parseInt(String(raw).replace(/^-/, ''), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

const err = (code, stderr) => ({ ok: false, code, stdout: '', stderr });
const ok = (stdout = '') => ({ ok: true, code: 0, stdout, stderr: '' });
const noSession = (name) => err(1, `can't find session: ${name}\n`);

// Quote one argv element for a cmd.exe command line. cmd.exe (unlike a POSIX
// shell) has no escaping we can rely on inside quotes, so we only wrap when the
// element carries a character cmd would otherwise treat as syntax.
export function quoteWinArg(a) {
  const s = String(a);
  return /[\s&|<>^()"]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// Decide how to hand a command to ConPTY.
//
// A real executable is spawned DIRECTLY (clean process tree, no shell layer). A
// `.cmd` / `.bat` — which is how npm installs `claude` on Windows — is NOT an
// executable image: CreateProcess (and therefore ConPTY) cannot launch it, so it
// must go through the command processor. This is the concrete reason the old
// path could never resume Claude natively, and why `where claude` returning
// `…\npm\claude.cmd` is a first-class case rather than an edge case.
export function buildLaunch(cmdParts, shell, comspec) {
  if (!cmdParts.length) return { file: shell.file, args: shell.args };
  const exe = String(cmdParts[0]);
  const ext = (exe.match(/\.[^.\\/]+$/) || [''])[0].toLowerCase();
  if (ext === '.exe' || ext === '.com') return { file: exe, args: cmdParts.slice(1) };
  // `/d` skips AutoRun, `/s` makes cmd strip exactly the outer quote pair and run
  // the rest verbatim — the only cmd.exe quoting form that survives a path with
  // spaces (e.g. C:\Program Files\...). Passed as a STRING so node-pty forwards
  // the command line untouched instead of re-quoting each element.
  return { file: comspec, args: `/d /s /c "${cmdParts.map(quoteWinArg).join(' ')}"` };
}

// Resolve the shell to spawn when no explicit command is given. Prefer
// PowerShell (what a Windows user means by "a terminal", and VSCode's default),
// fall back to %ComSpec% / cmd.exe which always exists. WARDEN_WIN_SHELL
// overrides both.
export function resolveShell(env = process.env, exists = fs.existsSync) {
  if (env.WARDEN_WIN_SHELL) return { file: env.WARDEN_WIN_SHELL, args: [] };
  const root = env.SystemRoot || env.windir || 'C:\\Windows';
  const pwsh = `${root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
  if (exists(pwsh)) return { file: pwsh, args: ['-NoLogo'] };
  return { file: env.ComSpec || 'cmd.exe', args: [] };
}

// ---------------- session manager ----------------

// `deps` is a test seam (production callers omit it), matching the injectable-deps
// convention the rest of this repo uses instead of module mocking (node:test's
// mock.module is unavailable on Node 20 — see ssh.test.js).
export function createSessionManager(deps = {}) {
  const spawnPty = deps.spawnPty ?? ((file, args, opts) => nodePty.spawn(file, args, opts));
  const env = deps.env ?? process.env;
  const shell = deps.shell ?? (() => resolveShell(env, deps.exists));
  const comspec = deps.comspec ?? (env.ComSpec || 'cmd.exe');

  /** @type {Map<string, object>} */
  const sessions = new Map();
  /** @type {Map<string, string>} */
  const buffers = new Map();

  function create(name, { cwd, cols, rows, cmdParts }) {
    const launch = buildLaunch(cmdParts, typeof shell === 'function' ? shell() : shell, comspec);
    const pty = spawnPty(launch.file, launch.args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: cwd || undefined,
      env: { ...env, LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' },
      useConpty: true,
    });
    const session = {
      name,
      pty,
      cwd: cwd || '',
      cols,
      rows,
      scrollback: new Scrollback(),
      clients: new Set(),
      // Whether the foreground app has enabled bracketed paste (DECSET 2004).
      // Tracked off the real output stream so `paste-buffer -p` reproduces tmux's
      // rule exactly: wrap in \e[200~ … \e[201~ only when the app opted in, send
      // raw otherwise — we never "fix" an app that hasn't.
      bracketedPaste: false,
      dead: false,
    };
    pty.onData((d) => {
      const s = String(d);
      session.scrollback.write(s);
      if (s.includes('\x1b[?2004h')) session.bracketedPaste = true;
      if (s.includes('\x1b[?2004l')) session.bracketedPaste = false;
      for (const c of session.clients) c._data(s);
    });
    pty.onExit(({ exitCode } = {}) => {
      session.dead = true;
      sessions.delete(name);
      // Snapshot before iterating: each `_exit` removes its own client from the
      // set, so iterating the live Set would skip clients (a linter will call the
      // spread useless — it is load-bearing).
      for (const c of [...session.clients]) c._exit(exitCode ?? 0);
      session.clients.clear();
    });
    sessions.set(name, session);
    return session;
  }

  function write(session, data) {
    try {
      session.pty.write(data);
      return ok();
    } catch (e) {
      return err(1, String((e && e.message) || e));
    }
  }

  // Execute one tmux argv against the in-process registry. Returns the SAME
  // {ok, code, stdout, stderr} shape runLocalTmux/run() produce, so every caller
  // (tmux.js read/send/hasSession/spawn/kill, chats.js list-sessions +
  // capture-pane, server.js preflight) is byte-compatible with the tmux path.
  async function run(args) {
    const argv = (args || []).map(String);
    const [cmd, ...rest] = argv;
    switch (cmd) {
      // Preflight (`tmux -V`): the native transport is always "installed".
      case '-V':
        return ok('warden-native ConPTY (no tmux required)\n');

      case 'new-session': {
        const name = flagValue(rest, '-s');
        if (!name) return err(1, 'new-session: no session name\n');
        if (sessions.has(name)) return err(1, `duplicate session: ${name}\n`);
        const cols = Number.parseInt(flagValue(rest, '-x') || '', 10) || 120;
        const rows = Number.parseInt(flagValue(rest, '-y') || '', 10) || 32;
        const cwd = flagValue(rest, '-c') || '';
        // Trailing argv after the last flag+value pair is the command to run.
        // An EMPTY command means "the host's default shell" (WARDEN-223) — here
        // that is the native Windows shell rather than tmux's login shell.
        const cmdParts = trailingCommand(rest);
        try {
          create(name, { cwd, cols, rows, cmdParts });
        } catch (e) {
          return err(1, `failed to start session: ${String((e && e.message) || e)}\n`);
        }
        return ok();
      }

      case 'has-session': {
        const name = flagValue(rest, '-t');
        return sessions.has(name) ? ok() : noSession(name);
      }

      case 'kill-session': {
        const name = flagValue(rest, '-t');
        const s = sessions.get(name);
        if (!s) return noSession(name);
        sessions.delete(name);
        try { s.pty.kill(); } catch { /* already gone */ }
        return ok();
      }

      case 'list-sessions': {
        // Mirrors tmux: no sessions → non-zero, which callers read as "nothing
        // alive" (chats.js localAliveSessions returns an empty Set on !ok).
        if (!sessions.size) return err(1, 'no server running\n');
        return ok([...sessions.keys()].join('\n') + '\n');
      }

      case 'capture-pane': {
        const name = flagValue(rest, '-t');
        const s = sessions.get(name);
        if (!s) return noSession(name);
        return ok(s.scrollback.capture({ ansi: rest.includes('-e'), lines: captureDepth(rest) }));
      }

      case 'send-keys': {
        const name = flagValue(rest, '-t');
        const s = sessions.get(name);
        if (!s) return noSession(name);
        if (rest.includes('-l')) {
          // Literal text: everything after `-l`.
          const i = rest.indexOf('-l');
          return write(s, rest.slice(i + 1).join(' '));
        }
        // A key name (already validated against ALLOWED_KEYS by tmux.js).
        const key = rest[rest.length - 1];
        const bytes = KEYS[key];
        if (bytes == null) return err(1, `unknown key: ${key}\n`);
        return write(s, bytes);
      }

      case 'set-buffer': {
        const name = flagValue(rest, '-b');
        // `--` guards data that starts with `-`; the payload is everything after.
        const i = rest.indexOf('--');
        const data = i > -1 ? rest.slice(i + 1).join(' ') : rest[rest.length - 1];
        buffers.set(name, data);
        return ok();
      }

      case 'paste-buffer': {
        const name = flagValue(rest, '-b');
        const target = flagValue(rest, '-t');
        const s = sessions.get(target);
        if (!s) return noSession(target);
        if (!buffers.has(name)) return err(1, `no buffer ${name}\n`);
        const data = buffers.get(name);
        if (rest.includes('-d')) buffers.delete(name);
        // tmux sends the pasted block with \r line endings (that is what a real
        // terminal paste delivers), bracketed only when the app enabled it.
        const body = data.replace(/\r?\n/g, '\r');
        const wrapped = rest.includes('-p') && s.bracketedPaste
          ? `\x1b[200~${body}\x1b[201~`
          : body;
        return write(s, wrapped);
      }

      case 'delete-buffer': {
        const name = flagValue(rest, '-b');
        if (!buffers.delete(name)) return err(1, `no buffer ${name}\n`);
        return ok();
      }

      // `set-option window-size latest` only exists to stop tmux locking the
      // window so it follows the active client. ConPTY has no such lock — the
      // pane's own resize() call already drives the real SIGWINCH — so this is a
      // successful no-op rather than an error.
      case 'set-option':
        return ok();

      case 'display-message': {
        const name = flagValue(rest, '-t');
        const s = sessions.get(name);
        if (!s) return noSession(name);
        return ok(s.cwd ? `${s.cwd}\n` : '\n');
      }

      default:
        return err(1, `unknown command: ${cmd}\n`);
    }
  }

  // Attach a CLIENT to an existing session and return an IPty-compatible handle
  // (onData / onExit / write / resize / kill / pid) — the exact surface
  // server.js's pane websocket drives.
  //
  // `kill()` DETACHES this client; it does not kill the session. server.js calls
  // it on every detach and on ws close, and tmux's `attach` semantics are the
  // same: the session outlives its clients so re-attach shows the same terminal.
  function attach(args, { cols = 100, rows = 30 } = {}) {
    const argv = (args || []).map(String);
    const name = flagValue(argv, '-t');
    const session = sessions.get(name);
    if (!session) throw new Error(`can't find session: ${name}`);
    const dataCbs = [];
    const exitCbs = [];
    let detached = false;

    // Everything the terminal already holds, snapshotted at ATTACH time so the
    // replay and any live output that arrives before the first flush stay in
    // order. Live chunks queue behind the backlog until it has been delivered —
    // without this, output produced between onData() and the deferred flush would
    // reach the pane BEFORE the history it comes after.
    // Bounded to the client's viewport because that is what `tmux attach` does:
    // it repaints the CURRENT SCREEN, not the entire history buffer. Our
    // scrollback is a linear log of every line the pty ever printed, so for a
    // full-screen TUI (Claude Code, the headline consumer, redraws its whole
    // frame continuously) an unbounded replay would push thousands of stale
    // frames ahead of the live stream on every attach.
    // Trade the bound carries: attributes established BEFORE the window are not
    // carried in, so an SGR set further back than `rows` is sliced off while the
    // text it colored remains — that text replays unstyled. Real `tmux
    // capture-pane -e` has the comparable limitation.
    const backlog = toCrlf(session.scrollback.capture({ ansi: true, lines: rows }));
    // Snapshotted alongside the backlog, not read inside the deferred flush: by
    // then the pty may have printed more and moved the line model on.
    const openLine = session.scrollback.openLine;
    const queued = [];
    let flushed = false;
    function flush() {
      if (flushed) return;
      flushed = true;
      // The trailing `\r\n` is a REPAIR, not decoration: when the stream ended on
      // a newline, the line model's final element is '' and `capture()` drops it
      // (it is the unterminated current line, not content), taking a real line
      // ending with it. Restore it there and only there — appending while the
      // current line is open would fabricate an ending the terminal never emitted,
      // parking the pane's cursor one row below where the shell's actually is.
      if (backlog) emit(openLine || backlog.endsWith('\r\n') ? backlog : backlog + '\r\n');
      while (queued.length) emit(queued.shift());
    }
    function emit(d) { for (const cb of [...dataCbs]) cb(d); }

    const client = {
      _data(d) {
        if (detached) return;
        if (!flushed) {
          // Bounded: a client that never registers onData (no real caller does)
          // must not accumulate output forever.
          if (queued.length < 512) queued.push(d);
          return;
        }
        emit(d);
      },
      _exit(code) {
        if (detached) return;
        // Deliver whatever the terminal printed on its way out before reporting
        // the exit — the last lines are usually the reason it died.
        flush();
        detached = true;
        session.clients.delete(client);
        for (const cb of [...exitCbs]) cb({ exitCode: code, signal: 0 });
      },
      get pid() { return session.pty.pid; },
      onData(cb) {
        dataCbs.push(cb);
        // Deferred one turn so the caller can finish wiring onExit first — the
        // pane's attach lands on the terminal's existing content rather than a
        // blank screen, which is what `tmux attach` gives you.
        setImmediate(() => { if (!detached) flush(); });
        return { dispose() { const i = dataCbs.indexOf(cb); if (i > -1) dataCbs.splice(i, 1); } };
      },
      onExit(cb) {
        exitCbs.push(cb);
        return { dispose() { const i = exitCbs.indexOf(cb); if (i > -1) exitCbs.splice(i, 1); } };
      },
      write(d) { if (!detached) session.pty.write(String(d)); },
      resize(c, r) {
        if (detached) return;
        session.cols = c;
        session.rows = r;
        // The real ConPTY resize — this IS the SIGWINCH equivalent the pane needs.
        session.pty.resize(c, r);
      },
      kill() {
        if (detached) return;
        detached = true;
        session.clients.delete(client);
      },
    };
    session.clients.add(client);
    if (cols && rows) { try { session.pty.resize(cols, rows); } catch { /* noop */ } }
    return client;
  }

  return {
    run,
    attach,
    // Test/introspection helpers.
    _sessions: sessions,
    _buffers: buffers,
  };
}

// tmux argv for new-session is `[-d] [-s NAME] [-x C] [-y R] [-c CWD] cmd...`
// (src/tmux.js spawn builds exactly that). Walk the known flags and treat the
// remainder as the command.
function trailingCommand(rest) {
  const withValue = new Set(['-s', '-x', '-y', '-c', '-n', '-t']);
  let i = 0;
  while (i < rest.length) {
    const a = rest[i];
    if (withValue.has(a)) { i += 2; continue; }
    if (a.startsWith('-')) { i += 1; continue; }
    break;
  }
  return rest.slice(i);
}

// Process-wide manager: local Windows sessions live in the Warden process, so a
// single registry per process is the whole model.
let shared = null;
function manager() {
  if (!shared) shared = createSessionManager();
  return shared;
}

// `opts` (the `{ timeout }` runLocalTmux passes through) is accepted and
// deliberately IGNORED: a native command is answered from the in-process session
// registry with no child process and no I/O, so it always settles synchronously —
// there is nothing a timeout could interrupt. Named rather than omitted so the
// divergence from the ssh `run` contract is visible at the signature.
export function runNative(args, _opts = {}) {
  return manager().run(args);
}

export function attachNative(args, opts) {
  return manager().attach(args, opts);
}
