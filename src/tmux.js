// tmux operations for a chat. Each chat is a tmux session (yatfa: inside a docker
// container; manual: a host/local tmux session). This module builds tmux argv and
// executes them via the transport layer (ssh.js runTmux/attachTmux), which routes
// to a remote host over SSH or to this machine locally. tmux is required everywhere.
import { runTmux, attachTmux, attachInteractiveTmux, toMsysPath } from './ssh.js';
import { isCompanionTransportEnabled, hasSession as companionHasSession, spawnSession, killSession, resize as companionResize } from './companion.js';

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
  if (!r.ok) {
    // paste-buffer -d reclaims the buffer only on success. If paste failed
    // (e.g. the target session is dead: "can't find session"), the named
    // buffer would leak on the durable tmux server until the server is
    // killed — and a retry loop against a dead session leaks one copy of the
    // full payload every attempt. Reclaim it best-effort. delete-buffer
    // errors if the buffer is already gone (set-buffer failed, or -d already
    // deleted it on a paste that succeeded before send-keys failed) — so the
    // .catch swallows that; the happy path is unchanged (still a single -d).
    await run(chat, ['delete-buffer', '-b', buf]).catch(() => {});
    throw new Error((r.stderr || '').trim() || `send failed (exit ${r.code})`);
  }
  return true;
}

export async function sendKey(chat, cfg, k) {
  if (!ALLOWED_KEYS.has(k)) throw new Error(`unsupported key "${k}". allowed: ${[...ALLOWED_KEYS].join(', ')}`);
  const r = await runTmux(chat, ['send-keys', '-t', sess(chat, cfg), k]);
  if (!r.ok) throw new Error((r.stderr || '').trim() || `key failed (exit ${r.code})`);
  return true;
}

// Companion transport routing for the liveness probe (WARDEN-382, slice 3 of
// roadmap WARDEN-270). For a REMOTE host under WARDEN_COMPANION_TRANSPORT=1 the
// probe takes ONE hasSession RPC round-trip over the persistent companion channel
// (zero per-op SSH handshakes — today probeSession spawns one ssh process per
// probe). The result is mapped to the SAME raw {ok,code,stdout,stderr} shape
// runTmux produces, so classifyProbe yields the identical attach reason the
// default path emits — only sharper: the companion channel separates
// reachability from session-existence, eliminating the ambiguous "transport vs
// command failure" gap the raw-SSH isTransportFailure heuristic can only guess at.
//   ok && exists      → {ok:true}                       → alive (classifyProbe null)
//   ok && !exists     → {ok:false,code:1,"can't find"}   → session_dead
//   !ok && transport  → {ok:false,code:-1}               → host_unreachable
//   !ok && !transport → {ok:false,code:1}                → session_dead (parity: the
//                                                          default path also classifies
//                                                          a host-side command failure,
//                                                          e.g. tmux missing, as dead)
// LOCAL never routes through the companion. `deps.runTmux` / `deps.companionHasSession`
// / `deps.isCompanionTransportEnabled` are optional test seams (mirrors the deps seam
// in ssh.js runWithPool / tmux send / tmux spawn+kill).
function companionHasSessionResultToProbe(res, session) {
  if (res && res.ok) {
    return res.exists
      ? { ok: true, code: 0, stdout: '', stderr: '' }
      : { ok: false, code: 1, stdout: '', stderr: `can't find session: ${session}\n` };
  }
  if (res && res.transport) {
    return { ok: false, code: -1, stdout: '', stderr: res.error || 'companion transport failed' };
  }
  return { ok: false, code: 1, stdout: '', stderr: (res && res.error) || 'companion has-session failed' };
}

async function probeViaCompanion(chat, cfg, deps) {
  const fn = deps.companionHasSession ?? companionHasSession;
  const session = sess(chat, cfg);
  const res = await fn(chat.host, { container: chat.container, session }, cfg, {});
  return companionHasSessionResultToProbe(res, session);
}

// tmux is alive for this chat? (has-session exits 0 if yes)
export async function hasSession(chat, cfg, deps = {}) {
  if (chat.host !== '(local)' && (deps.isCompanionTransportEnabled ?? isCompanionTransportEnabled)()) {
    const r = await probeViaCompanion(chat, cfg, deps);
    return r.ok;
  }
  const run = deps.runTmux ?? runTmux;
  const r = await run(chat, ['has-session', '-t', sess(chat, cfg)]);
  return r.ok;
}

// Bounded liveness probe (WARDEN-231). Runs `has-session` with a timeout and
// returns the RAW {ok, code, stdout, stderr} result — unlike hasSession() which
// collapses it to a boolean. The raw result is what lets the server tell three
// cases apart:
//   ok                → the session exists; attach normally.
//   !ok && !transport → the session is absent but the host answered (tmux exits
//                       non-zero, e.g. "can't find session") → session_dead.
//   !ok && transport  → SSH never delivered the command (refused/timed-out/
//                       wedged ControlMaster) or the probe timed out → host_unreachable.
// `timeout` bounds both the remote (SIGKILL on the ssh child) and the local
// (spawnSync SIGTERM) path so a wedged host can never hang the probe forever.
// Under WARDEN_COMPANION_TRANSPORT=1 a REMOTE host probes via the companion RPC
// (see companionHasSessionResultToProbe); the timeout then bounds nothing extra
// (the channel has its own RPC timeout) but is accepted for signature parity.
export async function probeSession(chat, cfg, { timeout = 8000 } = {}, deps = {}) {
  if (chat.host !== '(local)' && (deps.isCompanionTransportEnabled ?? isCompanionTransportEnabled)()) {
    return probeViaCompanion(chat, cfg, deps);
  }
  const run = deps.runTmux ?? runTmux;
  return run(chat, ['has-session', '-t', sess(chat, cfg)], { timeout });
}

// Set window-size latest so tmux follows whichever client is active (Warden's
// ConPTY SIGWINCH propagates through ssh → tmux automatically). Don't use
// `manual` — it locks the window and prevents other clients from resizing.
// One call on attach is enough; ConPTY handles subsequent resizes via SIGWINCH.
//
// Companion routing (WARDEN-409, slice 4 of roadmap WARDEN-270): for a REMOTE
// host under WARDEN_COMPANION_TRANSPORT=1 this is ONE resize RPC over the
// persistent companion channel (zero per-op SSH handshakes — today resize spawns
// one ssh process per open AND one per in-session resize). The companion client
// returns the SAME raw {ok,code,stdout,stderr} shape runTmux produces, so the
// call sites are unchanged. LOCAL never routes through the companion.
// `deps.runTmux` / `deps.companionResize` are optional test seams (mirrors
// probeSession's deps seam).
function companionRawResult(res) {
  // The companion client always returns {host, ok, code, stdout, stderr}; strip
  // the host envelope so the result is byte-identical to runTmux's {ok, code,
  // stdout, stderr} — the "both paths agree by construction" parity contract.
  if (res && res.ok) {
    return { ok: true, code: res.code ?? 0, stdout: res.stdout || '', stderr: res.stderr || '' };
  }
  return {
    ok: false,
    code: res && typeof res.code === 'number' ? res.code : -1,
    stdout: (res && res.stdout) || '',
    stderr: (res && res.stderr) || 'companion control-plane op failed',
  };
}

async function resizeViaCompanion(chat, cfg, deps) {
  const fn = deps.companionResize ?? companionResize;
  const session = sess(chat, cfg);
  const res = await fn(chat.host, { container: chat.container, session }, cfg, {});
  return companionRawResult(res);
}

// resize() fires on attach AND on every in-session resize (server.js wraps both
// in try/catch noop). Signature keeps (cols, rows) for call-site compatibility
// even though set-option window-size latest takes no geometry — the ConPTY SIGWINCH
// is what actually resizes; this just unlocks the window to follow it.
export async function resize(chat, cfg, _cols, _rows, deps = {}) {
  if (chat.host !== '(local)' && isCompanionTransportEnabled()) {
    await resizeViaCompanion(chat, cfg, deps);
    return;
  }
  const s = sess(chat, cfg);
  const run = deps.runTmux ?? runTmux;
  await run(chat, ['set-option', '-t', s, 'window-size', 'latest']);
}

// Spawn the chat's tmux session (detached): new-session -d, cwd (msys-translated
// for local), then the command (claude / bash / …) as trailing argv. An empty
// `cmd` is honored: no trailing argv is appended, so tmux launches its own
// default shell — the host's login shell (auto-detected). This is the ＋ split
// path's "no explicit shell" case (WARDEN-223): the caller chooses the shell by
// omitting it rather than hardcoding `bash`. Every caller sets `cmd` explicitly
// (the /api/spawn handler defaults it to claude when omitted), so dropping the
// former `|| 'claude …'` fallback here only changes the empty-string case.
//
// `deps` is an optional test seam (mirrors send's deps.runTmux): inject
// isCompanionTransportEnabled / spawnSession / runTmux to drive the routing guard
// + the exact argv without real ssh. Production callers omit it.
export async function spawn(chat, _cfg, deps = {}) {
  const s = sess(chat, _cfg);
  const cwd = chat.host === '(local)' ? toMsysPath(chat.cwd || '') : (chat.cwd || '');
  const cmdParts = chat.cmd ? String(chat.cmd).split(/\s+/).filter(Boolean) : [];
  const args = ['new-session', '-d', '-s', s, '-x', '120', '-y', '32'];
  if (cwd) args.push('-c', cwd);
  args.push(...cmdParts);
  // Experimental companion transport (WARDEN-386): for REMOTE hosts only, when
  // WARDEN_COMPANION_TRANSPORT=1 is set, route spawn through the persistent
  // companion channel (one RPC, zero per-op ssh handshakes — the create/destroy
  // twin of discover/capturePanes). The default runTmux path below is byte-for-
  // byte unchanged and remains the default. The companion reproduces this exact
  // argv on the host side (companion/main.go spawnSession); cwd is passed
  // VERBATIM (the msys translation above is local-only and does not apply on the
  // companion path). companion-or-fail: spawnSession returns {ok:false} with an
  // actionable error and never silently falls back to runTmux here.
  const isEnabled = deps.isCompanionTransportEnabled ?? isCompanionTransportEnabled;
  if (chat.host !== '(local)' && isEnabled()) {
    const r = await (deps.spawnSession ?? spawnSession)(chat.host, {
      container: chat.container || null,
      session: s,
      cwd,
      cmd: cmdParts,
    }, _cfg);
    if (!r.ok) throw new Error(r.error || `spawn failed`);
    return true;
  }
  const run = deps.runTmux ?? runTmux;
  const r = await run(chat, args);
  if (!r.ok) throw new Error((r.stderr || '').trim() || `spawn failed (exit ${r.code})`);
  return true;
}

// Kill the chat's tmux session. Best-effort / idempotent: kill-session on an
// already-dead session is a no-op the caller already swallows (server.js
// /api/kill try/catch noop, "a dead session may not exist"). The default runTmux
// path never throws on a kill-session failure (runWithPool catches the
// HostConnectionError and falls back to run(), which resolves {ok:false}), so
// this discard-and-never-throw shape mirrors it exactly — the companion path
// does the same (the host-side RPC surfaces "session not found" as a benign ok).
// `deps` is the same test seam as spawn.
export async function kill(chat, cfg, deps = {}) {
  const s = sess(chat, cfg);
  const isEnabled = deps.isCompanionTransportEnabled ?? isCompanionTransportEnabled;
  if (chat.host !== '(local)' && isEnabled()) {
    await (deps.killSession ?? killSession)(chat.host, {
      container: chat.container || null,
      session: s,
    }, cfg);
    return;
  }
  await (deps.runTmux ?? runTmux)(chat, ['kill-session', '-t', s]);
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
