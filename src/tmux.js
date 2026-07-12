// tmux operations for a chat. Each chat is a tmux session (yatfa: inside a docker
// container; manual: a host/local tmux session). This module builds tmux argv and
// executes them via the transport layer (ssh.js runTmux/attachTmux), which routes
// to a remote host over SSH or to this machine locally. tmux is required everywhere.
import { runTmux, attachTmux, attachInteractiveTmux, toMsysPath } from './ssh.js';

const sess = (chat, cfg) => (chat && chat.session) || (cfg && cfg.tmuxSession) || 'agent';

const ALLOWED_KEYS = new Set([
  'Escape', 'C-c', 'C-d', 'C-u', 'C-k', 'Enter', 'Tab', 'BSpace',
  'Up', 'Down', 'Left', 'Right', 'Home', 'End', 'PageUp', 'PageDown',
  'Space', 'F1', 'F2',
]);

// Capture the pane: colored scrollback (ANSI via -e), up to `lines` back.
export async function read(chat, cfg, lines = 500) {
  const r = await runTmux(chat, ['capture-pane', '-t', sess(chat, cfg), '-p', '-e', '-S', `-${lines}`, '-E', '-']);
  if (!r.ok) throw new Error((r.stderr || '').trim() || `read failed (exit ${r.code})`);
  return r.stdout;
}

// Send a chat message to the agent.
//
// Single-line text (no embedded newline): unchanged — literal text via
// `send-keys -l`, then a separate `Enter`.
//
// Multiline text: delivered as a single bracketed paste so the whole block is
// treated as one input instead of submitting line-by-line. `tmux paste-buffer -p`
// is the canonical paste path: it wraps the text in `\e[200~ … \e[201~` ONLY when
// the pane app has enabled bracketed paste (DECSET 2004), and sends raw newlines
// otherwise — exactly matching a real terminal paste into the same session. A
// single trailing `Enter` then submits the block as one message. Verified against
// tmux 3.3a (WARDEN-254): with the app in raw mode + bracketed paste enabled,
// the pane receives `\e[200~line1\rline2\rline3\e[201~`; with it disabled it
// receives `line1\rline2\rline3` (raw), never the markers — so we never "fix" an
// app that hasn't opted in.
//
// `deps.runTmux` is an optional test seam (production callers omit it); mirrors
// the deps seam in ssh.js runWithPool, since node:test mock.module is unavailable
// on Node 20 and child_process exports are non-configurable (see ssh.test.js).
let sendSeq = 0;
export async function send(chat, cfg, text, deps = {}) {
  const run = deps.runTmux ?? runTmux;
  const s = sess(chat, cfg);
  const str = String(text);
  if (!str.includes('\n')) {
    let r = await run(chat, ['send-keys', '-t', s, '-l', str]);
    if (r.ok) r = await run(chat, ['send-keys', '-t', s, 'Enter']);
    if (!r.ok) throw new Error((r.stderr || '').trim() || `send failed (exit ${r.code})`);
    return true;
  }
  // Multiline → bracketed paste via a per-send named buffer. The name is unique
  // per call so two concurrent sends to the same tmux server can't clobber each
  // other's buffer between the set-buffer and paste-buffer calls. `paste-buffer
  // -d` deletes the buffer after pasting (cleanup on the happy path); `--` lets
  // the data start with `-` without tmux parsing it as a flag (verified: tmux
  // otherwise errors `set-buffer: unknown flag -f`).
  const buf = `warden-send-${Date.now()}-${++sendSeq}`;
  let r = await run(chat, ['set-buffer', '-b', buf, '--', str]);
  if (r.ok) r = await run(chat, ['paste-buffer', '-p', '-d', '-b', buf, '-t', s]);
  if (r.ok) r = await run(chat, ['send-keys', '-t', s, 'Enter']);
  if (!r.ok) throw new Error((r.stderr || '').trim() || `send failed (exit ${r.code})`);
  return true;
}

export async function sendKey(chat, cfg, k) {
  if (!ALLOWED_KEYS.has(k)) throw new Error(`unsupported key "${k}". allowed: ${[...ALLOWED_KEYS].join(', ')}`);
  const r = await runTmux(chat, ['send-keys', '-t', sess(chat, cfg), k]);
  if (!r.ok) throw new Error((r.stderr || '').trim() || `key failed (exit ${r.code})`);
  return true;
}

// tmux is alive for this chat? (has-session exits 0 if yes)
export async function hasSession(chat, cfg) {
  const r = await runTmux(chat, ['has-session', '-t', sess(chat, cfg)]);
  return r.ok;
}

// Set window-size latest so tmux follows whichever client is active (Warden's
// ConPTY SIGWINCH propagates through ssh → tmux automatically). Don't use
// `manual` — it locks the window and prevents other clients from resizing.
// One call on attach is enough; ConPTY handles subsequent resizes via SIGWINCH.
export async function resize(chat, cfg, cols, rows) {
  const s = sess(chat, cfg);
  await runTmux(chat, ['set-option', '-t', s, 'window-size', 'latest']);
}

// Spawn the chat's tmux session (detached): new-session -d, cwd (msys-translated
// for local), then the command (claude / bash / …) as trailing argv. An empty
// `cmd` is honored: no trailing argv is appended, so tmux launches its own
// default shell — the host's login shell (auto-detected). This is the ＋ split
// path's "no explicit shell" case (WARDEN-223): the caller chooses the shell by
// omitting it rather than hardcoding `bash`. Every caller sets `cmd` explicitly
// (the /api/spawn handler defaults it to claude when omitted), so dropping the
// former `|| 'claude …'` fallback here only changes the empty-string case.
export async function spawn(chat, _cfg) {
  const s = sess(chat, _cfg);
  const cwd = chat.host === '(local)' ? toMsysPath(chat.cwd || '') : (chat.cwd || '');
  const cmdParts = chat.cmd ? String(chat.cmd).split(/\s+/).filter(Boolean) : [];
  const args = ['new-session', '-d', '-s', s, '-x', '120', '-y', '32'];
  if (cwd) args.push('-c', cwd);
  args.push(...cmdParts);
  const r = await runTmux(chat, args);
  if (!r.ok) throw new Error((r.stderr || '').trim() || `spawn failed (exit ${r.code})`);
  return true;
}

export async function kill(chat, cfg) {
  await runTmux(chat, ['kill-session', '-t', sess(chat, cfg)]);
}

// ---- Seamless copy (WARDEN-261) -------------------------------------------
// On some hosts tmux has mouse mode on (`set -g mouse on` in ~/.tmux.conf), so
// tmux grabs the mouse for its own selection and xterm never gets one — meaning
// the pane's Ctrl/Cmd+C copy path (term.getSelection()) copies nothing. Warden
// normalizes this with an opt-in per-host "Seamless copy" setting: when on, the
// host's tmux mouse is disabled on attach so xterm owns the selection and the
// standard select+copy gesture works with zero tmux knowledge.
//
// The `mouse` option is tmux's unified mouse toggle (since tmux 2.1, 2015).
// `set -g mouse off` disables it server-wide for the chat's tmux (yatfa: that
// container's tmux; bare-tmux remote: that host's shared tmux server; local:
// this machine's tmux). `show-options -g mouse` reads the current global value
// (`mouse on` / `mouse off`) so we can tell the user copy is impaired when they
// have NOT opted in. Both go through runTmux, so the docker-exec prefix and SSH
// routing are handled by the existing transport.

// Parse `tmux show-options -g mouse` stdout into a tri-state: true (mouse on →
// copy impaired), false (mouse off → copy works), or null (unreadable / unknown,
// so the hint is never shown on a failure). Pure + exported so the tri-state
// logic has a direct unit test (mirrors parseAheadBehind). Accepts the `-v` form
// (`on`/`off`) and the default form (`mouse on`/`mouse off`) by taking the last
// whitespace-separated token; anything else is null.
export function parseMouseState(stdout) {
  const val = String(stdout || '').trim().split(/\s+/).pop();
  if (val === 'on') return true;
  if (val === 'off') return false;
  return null;
}

// Disable tmux mouse for the chat's tmux server (opt-in "Seamless copy"). Best-
// effort: returns the runTmux result; callers swallow failures so a mouse-off
// failure never blocks the attach. A short timeout keeps a slow/unreachable host
// from hanging the attach.
export async function disableMouse(chat, cfg, opts = {}) {
  return runTmux(chat, ['set', '-g', 'mouse', 'off'], { timeout: 3000, ...opts });
}

// Read the chat's tmux global mouse state. Returns true/false/null (null when
// the value can't be read — host down, tmux error, no server yet). Best-effort:
// a failed read is null, which the frontend treats as "don't show the hint".
export async function detectMouse(chat, cfg, opts = {}) {
  const r = await runTmux(chat, ['show-options', '-g', 'mouse'], { timeout: 3000, ...opts });
  if (!r.ok) return null;
  return parseMouseState(r.stdout);
}

// Attach argv (for the transport helpers).
export function attachArgs(chat, cfg) {
  return ['attach', '-t', sess(chat, cfg)];
}

// Live web pane: returns a node-pty (local exec or ssh).
export function attachStream(chat, cfg, { cols = 100, rows = 30 } = {}) {
  return attachTmux(chat, attachArgs(chat, cfg), { cols, rows });
}

// CLI interactive attach (stdio inherit). Returns exit code.
export function attachInteractive(chat, cfg) {
  return attachInteractiveTmux(chat, attachArgs(chat, cfg));
}
