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

// Send a chat message: literal text via `send-keys -l`, then a separate Enter.
export async function send(chat, cfg, text) {
  const s = sess(chat, cfg);
  let r = await runTmux(chat, ['send-keys', '-t', s, '-l', String(text)]);
  if (r.ok) r = await runTmux(chat, ['send-keys', '-t', s, 'Enter']);
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
// for local), then the command (claude / bash / …) as trailing argv.
export async function spawn(chat, _cfg) {
  const s = sess(chat, _cfg);
  const cwd = chat.host === '(local)' ? toMsysPath(chat.cwd || '') : (chat.cwd || '');
  const cmdParts = String(chat.cmd || 'claude --dangerously-skip-permissions').split(/\s+/).filter(Boolean);
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
