// Yatfa Warden observer — the "meta chat". An LLM agent (GLM via Anthropic API) that
// watches the yatfa agent chats through the warden control plane, discusses them
// with the user, and composes directives. Sends are draft-then-confirm: every
// send_directive is intercepted by a human gate before reaching a live agent.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { discoverAll, capturePanes, resolveChat } from './chats.js';
import { run, shellQuote } from './ssh.js';
import { read as readPane, send as sendPane } from './tmux.js';
import { complete } from './llm.js';
import { getSession, saveMessages, appendTranscript } from './sessions.js';
// The pane-state classifier was extracted into agentState.js (WARDEN-344) so the
// proactive attention surfaces can reach it without this Observer's LLM. Re-imported
// here unchanged — read_chats still classifies panes with the exact same
// logic. stripAnsi is also used directly below.
import { classifyPane, stripAnsi } from './agentState.js';
// WARDEN-359: log a directive_sent activity event at the moment a directive actually
// reaches an agent (covers BOTH the human-approved gate path AND auto-safe early-approve
// sends, which previously had no activity record at all). Imported here because
// logDirective (below) is the single point every confirmed send flows through.
import { appendEvent } from './activity.js';

const LOCAL = '(local)';

const DIRECTIVES_LOG = path.join(os.homedir(), '.yatfa-warden', 'directives.md');
// Warden data dir — the ONLY root write_file may write under (user decision:
// writes confined to the data dir). Matches the directives.md/activity.js
// precedent. Evaluated at module load like DIRECTIVES_LOG; the pure write core
// below takes its data dir as a parameter for HOME-independent tests.
const DATA_DIR = path.join(os.homedir(), '.yatfa-warden');

const SYSTEM = `You are Yatfa Warden — an observer and orchestrator for several yatfa software agents. Each agent runs as a "chat" in a remote tmux session (a planner / worker / reviewer / researcher). You watch them and help the human direct them.

You operate ONLY through these tools:
- list_chats(): discover every agent chat + whether it is active (running its TUI) or idle.
- read_chat({id, lines}): read an agent's current terminal pane. ALWAYS read before you advise on a specific agent — never assume.
- read_chats({ids, open_only?, lines?, changed_only?}): read several panes in ONE batched call — much cheaper than several read_chat round trips when you must read multiple agents in full. Pass ids (array of substrings) OR open_only: true to read all open panes at once. Returns each pane's raw content per pane; capture failures are reported per pane, never dropped. Set changed_only: true on a follow-up to get back only panes whose content changed since the last read.
- send_directive({id, directive}): propose a message to an agent. The user MUST approve every send; you propose and wait for the gate.
- write_file({path, content, append?}): save TEXT to a file under the warden data dir (~/.yatfa-warden/), e.g. reports/summary.md or snapshots/agent-X.md. Use this to persist observations, findings, snapshots, or reports worth keeping between turns — it is your only durable output channel besides send_directive (which only talks to agents). path is relative to the data dir; set append: true to add to a file instead of overwriting. Writes are confined to the data dir.

Your job:
1. Watch — read the chats the user cares about; keep an accurate, current picture of each agent's work.
2. Advise — explain what's going on: who is progressing, who is stuck, who is idle, and what each is working on. Be concrete and brief; cite what you read. You do NOT own "what needs attention right now": the always-visible header Attention badge already ranks that deterministically — when the user asks "where am I needed" or "what needs attention", point them at its "You're needed in {name} {reason}" callout (and the per-chat watch ping) instead of synthesizing your own urgency ranking.
3. Direct — when the user wants action, compose a PROPER directive and send it to the right agent via send_directive.

A "proper" directive is a self-contained message addressed to the receiving agent, including: the goal, any context it may lack (paths, ticket ids, decisions), any constraints, and a "done when" condition. Write it as clear natural instructions to that agent — not a rigid template. One focused directive per send.

Rules:
- Never claim you sent something without calling send_directive (and the gate approving).
- Never fabricate an agent's state — call read_chat first.
- Chats marked "open": true in list_chats are the ones the user is actively watching (open panes).
  ONLY read those by default. If the user asks about others, read them on request.
- Do NOT read every chat on every turn. Read only the open ones, and only when needed.
- If you're unsure which agent or what exactly to send, ask the user.
- Keep your own replies to the user concise.

Be concise. For "what needs attention" or "where am I needed", defer to the header Attention badge (its "You're needed in {name} {reason}" callout, plus the per-chat watch ping) — it is the authoritative, deterministic signal; your job is to read chats and explain the why, not to rebuild the ranking.`;

export const TOOLS = [
  {
    name: 'list_chats',
    description: 'List all agent chats across configured hosts with their active/idle status and role.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'read_chat',
    description: "Read an agent chat's current terminal pane to see what it is doing. id is any unique substring (container name, project, or role). lines = scrollback lines (default 120).",
    input_schema: {
      type: 'object',
      properties: { id: { type: 'string' }, lines: { type: 'number' } },
      required: ['id'],
    },
  },
  {
    name: 'send_directive',
    description: 'Propose sending a directive to an agent. The user must approve before it is actually sent. id is any unique substring. directive is the full message text to deliver to the agent.',
    input_schema: {
      type: 'object',
      properties: { id: { type: 'string' }, directive: { type: 'string' } },
      required: ['id', 'directive'],
    },
  },
  {
    name: 'read_chats',
    description: "Read several agent panes at once in ONE batched call — far cheaper than many read_chat round trips when you must read multiple agents in full. Pass ids (array of unique substrings: container, project, or role) and an optional lines cap, OR pass open_only: true to read exactly the user's open panes. Returns each pane's raw content keyed per pane in one result. Per-pane capture or id-resolution failures are reported per pane, never dropped. Set changed_only: true to get back only panes whose content changed since the last read (skips unchanged agents on follow-up).",
    input_schema: {
      type: 'object',
      properties: {
        ids: { type: 'array', items: { type: 'string' }, description: 'Agent ids (unique substrings) to read in full.' },
        open_only: { type: 'boolean', description: "If true, read exactly the open panes (the user's watched tabs); ids are ignored." },
        lines: { type: 'number', description: 'Max scrollback lines per pane (default 60; capture fetches up to 60).' },
        changed_only: { type: 'boolean', description: 'If true, return only panes whose content changed since the last read (diff against the last-read cache). Default false.' },
      },
      required: [],
    },
  },
  {
    name: 'write_file',
    description: 'Persist TEXT to a file under the warden data dir (~/.yatfa-warden/), e.g. reports/summary.md or snapshots/agent-X.md. This is your durable persistence channel for observations, findings, snapshots, and reports (besides send_directive, which only talks to agents). path is relative to the data dir (e.g. "reports/foo.md"); content is the text to write. Set append: true to add to an existing file instead of overwriting it. Writes are confined to the data dir — ../ traversal, absolute paths, and symlinks pointing outside it are rejected.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Destination path relative to the warden data dir, e.g. "reports/2026-07-09.md".' },
        content: { type: 'string', description: 'Text content to write.' },
        append: { type: 'boolean', description: 'If true, append to the file (creating it if needed) instead of overwriting. Default false (overwrite).' },
      },
      required: ['path', 'content'],
    },
  },
];

// Single-source the agent-target identity (`<container-or-session>@<host>`) for
// the directive log writer (logDirective) and the send_directive `to:` return
// value. `container` is null for local/tmux chats (server.js buildAndSpawn and
// resume factories both set `container: null, key: session`), and a bare
// `${chat.container}` stringifies that null to the literal "null" — which
// directives.md would then record as `null@host` and DirectiveHistory would
// render in its badge and "Copy agent@host" payload verbatim (WARDEN-642). Fall
// back to the session key (the tmux session name, always set for local chats),
// then the session, then a literal "local" — matching the
// `chatKey || container || host` lineage in this file's resume path and
// ObserverPanel.tsx's container-fallback rendering. Docker/yatfa chats keep
// their container name unchanged. The fallback MUST carry no `@`, `(`, `)`, or
// space to round-trip through readDirectives' HEADER regex below; tmux session
// names satisfy this in practice (NAME_RE: letters/digits/_-.), the same
// constraint docker container names already impose on the existing writer.
export function agentTarget(chat) {
  return `${chat.container || chat.key || chat.session || 'local'}@${chat.host}`;
}

export function logDirective(chat, text) {
  fs.mkdirSync(path.dirname(DIRECTIVES_LOG), { recursive: true });
  const header = fs.existsSync(DIRECTIVES_LOG) ? '' : '# Yatfa Warden directives log\n';
  const ts = new Date().toISOString();
  const entry = `${header}\n## ${ts} → ${agentTarget(chat)} (${chat.role || 'agent'})\n\n${text}\n`;
  fs.appendFileSync(DIRECTIVES_LOG, entry);
}

// Read directives.md back into structured records — the inverse of `logDirective`.
// Mirrors activity.js readEvents' graceful-empty contract: a missing or empty
// file returns [] and never throws, and malformed blocks are skipped with a warn
// (matching activity.js:52). The parser anchors a block header on its leading ISO
// timestamp (`## <ts> → …`) so a directive body that happens to contain a `## `
// markdown line is never mistaken for a new block. Results are newest-first.
//
// `agent`/`host` filter by container/host (the ActivityTimeline agent/host
// filters use the same fields); `limit` caps the count.
export function readDirectives({ agent, host, limit } = {}) {
  if (!fs.existsSync(DIRECTIVES_LOG)) return [];
  const content = fs.readFileSync(DIRECTIVES_LOG, 'utf8');
  if (!content.trim()) return [];

  // Header authored by logDirective: `## <ISO ts> → <container>@<host> (<role>)`.
  // `<ts>` is `\S+` (ISO timestamps carry no spaces); `host` is `[^ ]+` (hosts
  // carry no spaces); the role is always present (logDirective defaults 'agent').
  const HEADER = /^## (\S+) → (.+)@([^ ]+) \(([^)]+)\)$/;
  const directives = [];
  let cur = null;
  for (const line of content.split('\n')) {
    // Skip the first-write file header line (not a directive block).
    if (line.startsWith('# Yatfa Warden directives log')) continue;
    const m = HEADER.exec(line);
    if (m) {
      if (cur) directives.push(cur);
      cur = { timestamp: m[1], container: m[2], host: m[3], role: m[4] || 'agent', _lines: [] };
    } else if (cur) {
      cur._lines.push(line);
    } else {
      // Non-header, non-directive content before any block: ignore.
    }
  }
  if (cur) directives.push(cur);

  const out = [];
  for (const d of directives) {
    const text = d._lines.join('\n').replace(/^\n+/, '').replace(/\n+$/, '');
    if (!d.timestamp || !new Date(d.timestamp).getTime()) {
      // Malformed/unparseable timestamp — warn and skip rather than surface junk.
      console.warn(`[directives] Malformed block skipped (bad timestamp): ${d.timestamp}`);
      continue;
    }
    out.push({ timestamp: d.timestamp, container: d.container, host: d.host, role: d.role, text });
  }

  out.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

  let result = out;
  if (agent) result = result.filter((d) => d.container === agent);
  if (host) result = result.filter((d) => d.host === host);
  if (limit && result.length > limit) result = result.slice(0, limit);
  return result;
}

// Resolve `absTarget` (an absolute path built lexically under the data dir) to
// its real on-disk location, following ALL symlinks, and confirm the final
// resolved path stays within `dataDirReal`. This is the WARDEN-96 check applied
// to WRITES, where the target file (or some ancestors) may not exist yet.
//
// `realpathSync.native` alone is insufficient for writes: it throws ENOENT when
// the final path (or a symlink's target) does not exist yet, and a naive fallback
// to `path.resolve` would miss a symlink whose TARGET is missing — i.e. a link
// inside the data dir that points outside, where a write would CREATE the
// outside file. So when realpath fails we lstat the component: if it is itself a
// symlink we follow its target (readlink) and re-check, otherwise we peel it
// into the not-yet-existing tail. The deepest existing ancestor is real-pathed
// and bounds-checked, then the non-existent tail (which can hold no symlinks) is
// re-appended lexically. `path.resolve` is therefore only ever applied to a tail
// of components that do not yet exist — never to a live symlink.
function resolveWithinDataDir(dataDirReal, absTarget) {
  let existing = absTarget;
  let missing = '';
  const MAX_ITERS = 40; // SYMLOOP_MAX-style guard against symlink cycles
  for (let i = 0; i < MAX_ITERS; i++) {
    let real;
    try {
      real = fs.realpathSync.native(existing);
    } catch (e) {
      if (e.code !== 'ENOENT') throw e; // EACCES/EIO/… — surface, never swallow (WARDEN-89)
      // realpath failed: `existing` (or a symlink target along it) is missing.
      let st = null;
      try { st = fs.lstatSync(existing, { throwIfNoEntry: false }); } catch { st = null; }
      if (st && st.isSymbolicLink()) {
        // `existing` is a symlink whose target can't be fully resolved (dangling
        // or points through a missing node). Follow it explicitly so a write
        // can't create a file at an out-of-bounds target. Relative link targets
        // resolve against the link's own directory.
        const target = fs.readlinkSync(existing);
        existing = path.resolve(path.dirname(existing), target);
        continue; // re-evaluate the link target (may itself be missing/escaped)
      }
      // Genuinely missing (not a symlink) — peel it into the not-yet-existing
      // tail and retry its parent. (dataDirReal itself always exists.)
      const parent = path.dirname(existing);
      if (parent === existing) {
        // Walked off the FS root without an in-bounds existing ancestor.
        throw new Error('path is outside the warden data directory');
      }
      missing = missing ? path.join(path.basename(existing), missing) : path.basename(existing);
      existing = parent;
      continue;
    }
    // Re-attach the not-yet-existing tail to the real (in-bounds) ancestor. The
    // tail cannot contain a `..` (absTarget was normalized by path.resolve) nor a
    // symlink (its components do not exist on disk yet), so the result is safe.
    const fullReal = missing ? path.join(real, missing) : real;
    if (fullReal !== dataDirReal && !fullReal.startsWith(dataDirReal + path.sep)) {
      throw new Error('path escapes the warden data directory (symlink)');
    }
    return fullReal;
  }
  throw new Error('path resolves through too many symlinks (possible cycle)');
}

// Pure, dependency-injected core of the write_file tool. Writes TEXT content to
// a file under `dataDir` (~/.yatfa-warden/, e.g. reports/foo.md), optionally
// appending instead of overwriting — matching the logDirective/activity.js
// append-to-the-data-dir precedent. `dataDir` is passed in (not read from
// os.homedir() inside) so this is unit-testable with a throwaway dir, free of
// the HOME-freezes-at-first-import caveat (WARDEN-130) and needing no SSH/tmux.
//
// Security (WARDEN-96, mandatory for this tool): the path is resolved with
// fs.realpathSync.native() and confirmed in-bounds under the data dir AFTER
// symlink resolution. `../` traversal, absolute paths, prefix-sibling tricks,
// and symlinks that escape the data dir are all rejected. Content is coerced to
// a UTF-8 string — binary writes are out of scope here (follow WARDEN-97 if
// that is ever added).
//
// Returns { ok, path, bytes, appended } on success; throws on any violation or
// I/O failure so _execTool can surface it as { error } (WARDEN-89: never a
// silent write failure).
export function writeReportFile(dataDir, relPath, content, opts = {}) {
  if (typeof dataDir !== 'string' || dataDir.length === 0) {
    throw new Error('dataDir is required');
  }
  const p = typeof relPath === 'string' ? relPath.trim() : '';
  if (!p) throw new Error('path is required');
  if (path.isAbsolute(p)) {
    throw new Error('path must be relative to the warden data directory');
  }

  const text = typeof content === 'string' ? content : String(content ?? '');

  const dataDirReal = fs.realpathSync.native(dataDir); // caller ensures it exists
  const absTarget = path.resolve(dataDirReal, p);

  // Lexical containment — rejects ../ traversal and prefix-sibling escapes.
  if (absTarget !== dataDirReal && !absTarget.startsWith(dataDirReal + path.sep)) {
    throw new Error('path is outside the warden data directory');
  }

  // Symlink-aware containment — rejects in-bounds-looking symlinks pointing out.
  const fullReal = resolveWithinDataDir(dataDirReal, absTarget);

  fs.mkdirSync(path.dirname(fullReal), { recursive: true });
  const append = opts && opts.append === true;
  if (append) {
    fs.appendFileSync(fullReal, text, 'utf8');
  } else {
    fs.writeFileSync(fullReal, text, 'utf8');
  }
  const bytes = fs.statSync(fullReal).size;
  return {
    ok: true,
    path: path.relative(dataDirReal, fullReal) || path.basename(fullReal),
    bytes,
    appended: append,
  };
}

// Pane-state classification (classifyPane), the SUMM_* regexes, and stripAnsi
// now live in agentState.js (WARDEN-344) — imported above. They were lifted out
// verbatim so the HTTP layer's /api/agent-states endpoint can reuse the exact
// same detector the Observer's read_chats tool uses, with no duplication.

// ---------------- change-aware state cache (WARDEN-166) ----------------
//
// The conservative core of change-awareness: a per-agent last-read snapshot
// (pane state + content signature + transcript phase + timestamp) kept as a
// side-effect of normal opt-in reads, surfaced as a "what changed since last
// read" diff via changed_only on read_chats. NO background
// polling, NO autonomous token spend (WARDEN-75) — every read is caller-driven.
// The pure helpers below are fully unit-testable with no SSH/tmux.
// (WARDEN-509 retired the on-demand alert_changes tool that consumed this cache;
// "where am I needed" is now owned by the deterministic AttentionBadge.)

// Content signature for change detection: stable across reads unless the pane's
// line count or its last line actually changed. Two captures with the same sig
// are "unchanged content", so the diff can skip them on follow-up reads.
export function paneSignature(cleanPane) {
  const lines = String(cleanPane).split('\n').map((l) => l.trimEnd()).filter((l) => l.trim().length > 0);
  const last = lines.length ? lines[lines.length - 1] : '';
  return `${lines.length}:${last.slice(0, 120)}`;
}

// ---- transcript phase detection (mid-turn vs awaiting-input) ----
//
// classifyPane already returns idle / erroring / stuck / blocked / waiting /
// active — reused as-is, no new patterns. The extra signal here is the Claude
// Code transcript phase: a turn is 'mid-turn' until it ends, then
// 'awaiting-input' (the agent finished and is waiting for the next prompt). It
// is recorded in the change-aware cache so read_chats
// changed_only can detect progress. (WARDEN-509 removed the on-demand
// alert_changes derivation that turned a mid-turn → awaiting-input flip into a
// "completed" alert; "who finished" / "where am I needed" is now surfaced by the
// deterministic AttentionBadge + per-chat watch, which read pane state directly.)

// Transcript entry types that carry no conversational signal — skipped when
// locating the "last real" entry (per WARDEN-166 spec).
const TRANSCRIPT_METADATA_TYPES = new Set([
  'mode', 'ai-title', 'last-prompt', 'file-history-snapshot',
  'attachment', 'system', 'summary', 'permission-mode',
]);
const STOP_AWAITING_INPUT = new Set(['end_turn', 'stop_sequence', 'max_tokens']);

// Keep only real conversational entries (user / assistant), dropping metadata.
export function filterRealTranscriptEntries(entries) {
  return (entries || []).filter((e) => e && (e.type === 'user' || e.type === 'assistant')
    && !TRANSCRIPT_METADATA_TYPES.has(e.type));
}

// Parse a transcript tail (raw text) into an array of JSON objects, skipping
// unparseable lines. The leading partial line left by `tail -c N` is naturally
// dropped because JSON.parse throws on it.
export function parseTranscriptTail(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* partial / malformed → skip */ }
  }
  return out;
}

// Determine an agent's turn phase from its transcript entries:
//   'awaiting-input' — last real entry is an assistant message that ended a turn
//                      (stop_reason ∈ {end_turn, stop_sequence, max_tokens}).
//   'mid-turn'       — last real entry is a user message, OR an assistant message
//                      mid-tool-use (stop_reason = 'tool_use'): the turn is ongoing.
//   null             — indeterminate (no real entries, or an assistant line with an
//                      unrecognized stop_reason). A stale mid-turn from a dead agent
//                      never flips to end_turn, so this never false-fires.
export function transcriptPhaseOf(entries) {
  const real = filterRealTranscriptEntries(entries);
  if (!real.length) return null;
  const last = real[real.length - 1];
  const stopReason = last && last.message ? last.message.stop_reason : undefined;
  if (last.type === 'assistant') {
    if (STOP_AWAITING_INPUT.has(stopReason)) return 'awaiting-input';
    if (stopReason === 'tool_use') return 'mid-turn';
    return null;
  }
  return 'mid-turn'; // last real entry is a user message → turn in progress
}

// ---- reading a live agent's transcript tail (the impure part) ----
//
// The completed signal needs the transcript's last assistant stop_reason. The
// history browser already walks ~/.claude/projects/*/*.jsonl, but only on the
// SSH HOST — a yatfa agent's `claude` runs INSIDE its container, so its
// transcript lives at the in-container $HOME/.claude/projects. buildTranscriptTailScript
// is the host/container-portable script that finds the most-recently-modified
// .jsonl and tails it; readTranscriptPhase wraps it for the three chat shapes.

// Shell script: locate the most-recently-modified transcript and tail its last
// 8 KB (plenty for the last assistant message + stop_reason). Emits ___TAIL /
// ___NONE markers parsed by parsePhaseFromTailOutput. Runs on a host or inside a
// container (via docker exec) unchanged — it only touches $HOME/.claude/projects.
export function buildTranscriptTailScript() {
  return [
    'f=$(ls -t "$HOME"/.claude/projects/*/*.jsonl 2>/dev/null | head -1)',
    'if [ -n "$f" ]; then',
    "  printf '___TAIL\\n'; tail -c 8192 \"$f\"",
    'else',
    "  printf '___NONE\\n'",
    'fi',
  ].join('\n');
}

// Parse the marked stdout of buildTranscriptTailScript into a phase (or null when
// there is no transcript / the host was unreachable). Pure — fed fake stdout in
// tests exactly like parseSessionReadOutput is (WARDEN-130 testing pattern).
export function parsePhaseFromTailOutput(stdout) {
  const s = String(stdout || '');
  const idx = s.indexOf('___TAIL');
  if (idx < 0) return null; // ___NONE, empty, or host unreachable
  return transcriptPhaseOf(parseTranscriptTail(s.slice(idx + '___TAIL'.length)));
}

// Read the local filesystem's most-recent transcript tail and return it in the
// ___TAIL-marked shape parsePhaseFromTailOutput expects (or '' if none). Uses
// os.homedir(), so a test redirects HOME to a throwaway dir to isolate it.
function readLocalTranscriptTail() {
  const dir = path.join(os.homedir(), '.claude', 'projects');
  const files = [];
  let projects;
  try { projects = fs.readdirSync(dir); } catch { return ''; } // no ~/.claude/projects
  for (const proj of projects) {
    const pdir = path.join(dir, proj);
    try { if (!fs.statSync(pdir).isDirectory()) continue; } catch { continue; }
    for (const f of fs.readdirSync(pdir)) {
      if (!f.endsWith('.jsonl')) continue;
      const fp = path.join(pdir, f);
      try { files.push({ fp, mtime: fs.statSync(fp).mtimeMs }); } catch { /* skip */ }
    }
  }
  if (!files.length) return '';
  files.sort((a, b) => b.mtime - a.mtime);
  const { fp } = files[0];
  const size = fs.statSync(fp).size;
  const len = Math.min(size, 8192);
  const fd = fs.openSync(fp, 'r');
  const buf = Buffer.alloc(len);
  fs.readSync(fd, buf, 0, len, size - len);
  fs.closeSync(fd);
  return '___TAIL\n' + buf.toString('utf8');
}

// Read a live agent's transcript phase. Returns 'mid-turn' | 'awaiting-input' |
// null (null = no transcript available → caller falls back to the pane-state
// path). Best-effort: any failure resolves to null so a transcript read can never
// block or break a pane read (WARDEN-89: failures surfaced, never fatal).
export async function readTranscriptPhase(chat, cfg = {}) {
  if (!chat) return null;
  try {
    let stdout = '';
    if (chat.container) {
      // yatfa docker agent: claude runs in-container, so reach its transcript via
      // docker exec (no existing code path did this — WARDEN-166 adds it).
      const cmd = `docker exec ${shellQuote(chat.container)} sh -c ${shellQuote(buildTranscriptTailScript())}`;
      const res = await run(chat.host, cmd, { timeout: 10000 }, cfg);
      if (!res.ok) return null;
      stdout = res.stdout;
    } else if (chat.host === LOCAL) {
      // bare local tmux 'claude' session: transcript on the local filesystem.
      stdout = readLocalTranscriptTail();
    } else {
      // bare remote tmux session: transcript on the remote host.
      const res = await run(chat.host, buildTranscriptTailScript(), { timeout: 10000 }, cfg);
      if (!res.ok) return null;
      stdout = res.stdout;
    }
    return parsePhaseFromTailOutput(stdout);
  } catch {
    return null;
  }
}

// Pure, dependency-injected core of the read_chats tool — a BATCHED read of many
// panes in ONE capturePanes call. capturePanes groups by host and runs Promise.all
// per host (chats.js), so worst-case latency scales with HOST count, not pane
// count (WARDEN-88): reading 6 open panes is one round-trip, not six serial
// read_chat calls. This returns the RAW pane text for specific panes the observer
// must read in full (no structured/lossy classification).
//
// Two resolution modes:
//   openOnly === true → read exactly the observer's effective open tabs
//                       (the caller passes effectiveOpenTabs()), reading what's
//                       watched — bound chat included (seamless cross-host resume).
//   ids (array)       → each id substring-resolved via resolveChat (same matcher
//                       _resolve/read_chat use). Ambiguous/unmatched ids are
//                       surfaced per-id, never dropped.
//
// Failures are reported, not dropped (WARDEN-89): capturePanes silently skips a
// whole host on SSH failure (`if (!res.ok) return;`) and an individual local pane
// on a capture error, so a MISSING key in the result map means that pane's capture
// failed — surfaced here as a flagged entry. Output is bounded: `lines` (default
// 60) trims each pane to its recent lines, and `maxPanes` (default 8) caps how
// many panes are captured, with the overflow surfaced as skipped (no silent
// truncation). capturePanes fetches up to 60 lines per pane, so `lines` trims
// within that window.
export async function readChats(ids, openOnly, openTabs, lastChats, capturePanes, cfg, opts = {}, readTranscriptPhase, lastReadState) {
  const lines = Math.max(1, Number.isFinite(opts.lines) ? opts.lines : 60);
  const maxPanes = Math.max(1, Number.isFinite(opts.maxPanes) ? opts.maxPanes : 8);
  const wantPhase = typeof readTranscriptPhase === 'function';
  const diffing = opts.changed_only === true && !!lastReadState;
  const chats = (lastChats || []);
  const resolutionErrors = [];

  let resolved;
  if (openOnly) {
    const open = new Set(openTabs || []);
    resolved = chats.filter((c) => open.has(c.container || c.session) || open.has(c.key));
    if (resolved.length === 0) {
      return {
        error: open.size === 0
          ? 'no tabs are open. open some agent panes first.'
          : 'open tabs do not match any discovered chats. try refreshing with list_chats.',
      };
    }
  } else {
    const idList = (Array.isArray(ids) ? ids : [])
      .map((x) => (typeof x === 'string' ? x.trim() : ''))
      .filter((x) => x.length > 0);
    if (idList.length === 0) {
      return { error: 'provide an array of ids or set open_only: true.' };
    }
    // Resolve each id via the same matcher read_chat/_resolve use. Dedupe by key so
    // two ids that hit the same pane aren't read twice. Unmatched/ambiguous ids
    // become per-id errors rather than aborting the whole batch.
    const seen = new Set();
    resolved = [];
    for (const id of idList) {
      const r = resolveChat(id, chats, null);
      if (r.chat) {
        if (!seen.has(r.chat.key)) { seen.add(r.chat.key); resolved.push(r.chat); }
      } else if (r.error) {
        resolutionErrors.push({ id, error: r.error });
      } else {
        // needsRefresh — not in the current cache. The core stays pure (no refresh);
        // the observer refreshes via list_chats, so point the caller there.
        resolutionErrors.push({ id, error: `no chat matches "${id}". try refreshing with list_chats.` });
      }
    }
    if (resolved.length === 0) {
      return {
        error: 'none of the requested ids resolved to a chat. try refreshing with list_chats.',
        errors: resolutionErrors,
      };
    }
  }

  // Overall cap: capture only the first `maxPanes`; surface the rest as skipped so
  // the result stays token-safe without silently truncating.
  const toCapture = resolved.slice(0, maxPanes);
  const overflow = resolved.slice(maxPanes);

  try {
    const panes = await capturePanes(toCapture, cfg);

    const base = (c) => ({
      id: c.container || c.session, host: c.host, project: c.project, role: c.role, active: c.active,
    });

    // Build the raw-pane entries AND the observedState side-channel (key →
    // {state, phase, sig}) for the last-read cache (WARDEN-166). Entries stay RAW
    // (a `pane` field, no classification) — observedState carries the state for
    // caching without polluting the raw-content result. Per-pane phase reads run
    // concurrently (WARDEN-88) and only when opted in; per-pane failures → null.
    const observedState = {};
    const read = await Promise.all(toCapture.map(async (c) => {
      if (!Object.prototype.hasOwnProperty.call(panes, c.key)) {
        observedState[c.key] = { state: 'capture_failed', phase: null, sig: null };
        return {
          ...base(c), ok: false,
          error: `failed to capture pane on ${c.host} (host unreachable or tmux capture error)`,
        };
      }
      const raw = panes[c.key] || '';
      const clean = stripAnsi(raw);
      let phase = null;
      if (wantPhase) {
        try { phase = await readTranscriptPhase(c, cfg); } catch { phase = null; }
      }
      observedState[c.key] = { state: classifyPane(clean, c).state, phase, sig: paneSignature(clean) };
      return { ...base(c), ok: true, pane: raw.split('\n').slice(-lines).join('\n') };
    }));

    const skipped = overflow.map((c) => ({
      ...base(c), ok: false, skipped: true,
      error: `omitted: max pane cap (${maxPanes}) reached — narrow your ids or use open_only.`,
    }));

    // Opt-in diff (WARDEN-166 AC #2): drop successfully-read panes whose content
    // signature is unchanged since the last read. Failed captures and skipped
    // (cap-overflow) entries are kept — they are conditions, not "unchanged
    // content", and must stay surfaced (WARDEN-89).
    let readForResult = read;
    if (diffing) {
      readForResult = read.filter((e) => {
        if (!e.ok) return true;
        const p = lastReadState[e.id]; // id === key for both chat shapes
        if (!p) return true; // newly read → changed
        return p.sig !== (observedState[e.id] && observedState[e.id].sig);
      });
    }

    const entries = [...readForResult, ...skipped];
    return {
      chats: entries,
      observedState,
      errors: resolutionErrors,
      changedOnly: diffing === true,
      count: entries.length,
      summary: {
        total: resolved.length,
        read: readForResult.filter((e) => e.ok).length,
        captureFailed: read.filter((e) => !e.ok).length,
        skipped: skipped.length,
        resolutionFailed: resolutionErrors.length,
      },
    };
  } catch (e) {
    return { error: e.message };
  }
}

export class Observer {
  constructor(cfg, { sid, gate, onTool, onToolResult, onText, chatContext, io } = {}) {
    this.cfg = cfg;
    // Injectable I/O deps for the dispatch layer (_execTool + _refreshChats +
    // _resolve). Production callers pass no `io`, so this defaults to the real
    // module-level imports and behavior is byte-for-byte identical. Tests inject
    // fakes to exercise dispatch routing end-to-end — Node 20 lacks
    // mock.module (WARDEN-130), so the module bindings themselves can't be
    // mocked, which is exactly why this DI seam exists. Mirrors the convention
    // ssh.js/tmux.js/hostStatus.js and the readChats pure core already follow.
    this._io = io || { discoverAll, capturePanes, resolveChat, readPane, sendPane };
    this.sid = sid || null;
    // gate: async (chat, directive) => { approved: boolean, edited?: string }
    this.gate = gate;
    // onTool: optional (name, input) => void  for UI tracing
    this.onTool = onTool;
    // onToolResult: optional (name, result) => void  for handling tool results
    this.onToolResult = onToolResult;
    // onText: optional (text) => void  streams assistant text emitted mid-loop
    this.onText = onText;
    this.lastChats = [];
    // Per-agent last-read state cache (WARDEN-166): key → { state, phase, sig, ts }.
    // Updated as a SIDE-EFFECT of read_chats / read_chat — never
    // by a background loop (WARDEN-75). In-memory, matching lastChats. Drives the
    // changed_only diff on read_chats.
    this.lastReadState = {};
    // resume an existing persisted conversation (if any)
    const existing = sid ? getSession(sid) : null;
    this.name = existing?.name || null;
    this.messages = existing?.messages || [];
    // Chat context: which agent chat this observer session is bound to. On
    // resume, the context persisted with the session is the source of truth
    // (so a reconnect restores the bound agent); otherwise use the context
    // passed at creation. This is what makes resume seamless across hosts —
    // the observer remembers which agent it was watching.
    this.chatContext = (existing && (existing.chatKey || existing.container || existing.host))
      ? {
          host: existing.host || null,
          container: existing.container || null,
          project: existing.project || null,
          role: existing.role || null,
          chatKey: existing.chatKey || null,
        }
      : (chatContext || null);
  }

  // The chat key (container name) this session is bound to, if any.
  get boundKey() {
    return this.chatContext?.container || this.chatContext?.chatKey || null;
  }

  // The open tabs plus the bound chat. The bound agent is always treated as
  // "open" so observer tools (summarize/analyze) watch it even when its pane
  // isn't open in the UI — the core of seamless cross-host resumption.
  effectiveOpenTabs() {
    const tabs = new Set(this.openTabs || []);
    const key = this.boundKey;
    if (key) tabs.add(key);
    return Array.from(tabs);
  }

  // Merge a read's observedState side-channel into the last-read cache (the
  // side-effect that makes the cache change-aware). Timestamped so a future
  // persisted-cache refinement could age entries out (WARDEN-88 sizing); today
  // it is in-memory only, matching lastChats.
  _mergeReadState(observed) {
    if (!observed || typeof observed !== 'object') return;
    const ts = Date.now();
    for (const [key, v] of Object.entries(observed)) {
      if (!v || typeof v !== 'object') continue;
      // Preserve a previously cached transcript phase when this read didn't
      // observe one (a plain read_chat/summarize only refreshes pane state), so
      // the next alert diff still has a phase to flip against.
      const prevPhase = this.lastReadState[key] && this.lastReadState[key].phase;
      this.lastReadState[key] = {
        state: v.state,
        phase: v.phase != null ? v.phase : (prevPhase != null ? prevPhase : null),
        sig: v.sig != null ? v.sig : null,
        ts,
      };
    }
  }

  getChatContext() {
    return this.chatContext;
  }

  // Reconstruct a UI-visible conversation from the raw LLM message history.
  serializeForUi() {
    const items = [];
    for (const m of this.messages) {
      if (m.role === 'user') {
        if (typeof m.content === 'string') items.push({ role: 'user', text: m.content });
        // tool_result blocks (array content) are skipped in the UI history
      } else if (m.role === 'assistant' && Array.isArray(m.content)) {
        for (const b of m.content) {
          if (b.type === 'text' && b.text) items.push({ role: 'assistant', text: b.text });
          else if (b.type === 'tool_use') items.push({ role: 'tool', name: b.name, id: (b.input && b.input.id) || '' });
        }
      }
    }
    return items;
  }

  async _refreshChats() {
    const { chats } = await this._io.discoverAll(this.cfg.hosts, this.cfg);
    this.lastChats = chats;
    return chats;
  }

  async _resolve(id) {
    const result = this._io.resolveChat(id, this.lastChats, null);

    // If we got a definitive result, return it (converting to chat or error object)
    if (result.chat) return result.chat;
    if (result.error) return { error: result.error };

    // No match in cache - refresh and try again
    const chats = await this._refreshChats();
    const result2 = this._io.resolveChat(id, chats, null);

    if (result2.chat) return result2.chat;
    if (result2.error) return { error: result2.error };

    // Should not reach here, but just in case. Uses c.id (always present and
    // typeable for every chat kind) rather than c.container, which is null for
    // manual/tmux chats and would render as an empty/dropped entry in the list
    // (Array.join converts null to ""), so the manual chat vanishes from the
    // suggestion instead of appearing as a usable identifier.
    return { error: `no chat matches "${id}". try one of: ${this.lastChats.map((c) => c.id).join(', ')}` };
  }

  async _execTool(name, input) {
    if (this.onTool) this.onTool(name, input);
    if (name === 'list_chats') {
      const chats = await this._refreshChats();
      const open = new Set(this.effectiveOpenTabs());
      return chats.map((c) => ({
        id: c.container || c.session, host: c.host, project: c.project, role: c.role,
        active: c.active, status: c.status,
        open: open.has(c.container || c.session) || open.has(c.key),
      }));
    }
    if (name === 'read_chat') {
      const chat = await this._resolve(input.id);
      if (chat.error) return chat;
      try {
        const pane = await this._io.readPane(chat, this.cfg, input.lines || 120);
        // WARDEN-166: cache the last-read pane state + content signature as a
        // side-effect of the read. Phase is left to the opt-in change-awareness
        // tools (summarize/read_chats with changed_only) so a plain read_chat
        // stays a single round-trip. Best-effort, never blocks.
        try {
          const clean = stripAnsi(pane);
          this._mergeReadState({
            [chat.key]: { state: classifyPane(clean, chat).state, phase: null, sig: paneSignature(clean) },
          });
        } catch { /* cache update is best-effort */ }
        return { id: chat.container, host: chat.host, pane: pane.slice(-8000) };
      } catch (e) { return { error: e.message }; }
    }
    if (name === 'read_chats') {
      // changed_only opts into change-awareness: thread readTranscriptPhase so the
      // cache records a transcript phase, and the last-read cache so the result is
      // narrowed to changed panes. A plain read_chats stays phase-free (cheap).
      const rtp = input.changed_only ? readTranscriptPhase : undefined;
      const res = await readChats(input.ids, !!input.open_only, this.effectiveOpenTabs(),
        this.lastChats, this._io.capturePanes, this.cfg, input, rtp, this.lastReadState);
      this._mergeReadState(res.observedState);
      const out = { ...res };
      delete out.observedState;
      return out;
    }
    if (name === 'send_directive') {
      const chat = await this._resolve(input.id);
      if (chat.error) return chat;
      const decision = await this.gate(chat, input.directive);
      if (!decision.approved) return { sent: false, reason: 'user declined the directive' };
      const text = decision.edited != null ? decision.edited : input.directive;
      try {
        await this._io.sendPane(chat, this.cfg, text);
        logDirective(chat, text);
        // Record the *sent* directive in the activity log. This is the single
        // point that proves the directive actually reached an agent, so it
        // captures BOTH paths: gated human-approve AND auto-safe auto-send
        // (which skips the directive_proposed gate entirely). The Activity
        // banner/timeline count `directive_sent` (not `directive_proposed`) so
        // rejected directives are no longer miscounted as sent.
        appendEvent({ type: 'directive_sent', container: chat.container, host: chat.host, role: chat.role, directive: text });
        return { sent: true, to: agentTarget(chat), chars: text.length };
      } catch (e) { return { error: e.message }; }
    }
    if (name === 'write_file') {
      // Writes confined to the warden data dir only. Ensure it exists (first run),
      // then delegate to the pure core; any violation / I/O error is surfaced as
      // { error } so a write never fails silently (WARDEN-89).
      try {
        fs.mkdirSync(DATA_DIR, { recursive: true });
        return writeReportFile(DATA_DIR, input.path, input.content, input);
      } catch (e) {
        return { error: e.message };
      }
    }
    return { error: `unknown tool ${name}` };
  }

  // Run one user turn; returns the observer's final text. Tool calls loop internally.
  async step(userText) {
    this.messages.push({ role: 'user', content: userText });
    if (this.sid) appendTranscript(this.sid, 'user', userText);
    let finalText = '';
    for (let i = 0; i < 8; i++) {
      const resp = await complete({ system: SYSTEM, messages: this.messages, tools: TOOLS, max_tokens: this.cfg.llm?.maxTokens ?? 2048 });
      const content = resp.content || [];
      this.messages.push({ role: 'assistant', content });
      const toolUses = content.filter((b) => b.type === 'tool_use');
      const text = content.filter((b) => b.type === 'text').map((b) => b.text).join('');
      if (!toolUses.length) { finalText = text; break; }
      if (text && this.onText) this.onText(text);
      const results = [];
      for (const tu of toolUses) {
        const out = await this._execTool(tu.name, tu.input || {});
        if (this.onToolResult) this.onToolResult(tu.name, out);
        results.push({
          type: 'tool_result',
          tool_use_id: tu.id,
          content: JSON.stringify(out).slice(0, 12000),
        });
      }
      this.messages.push({ role: 'user', content: results });
    }
    if (!finalText) finalText = '(tool loop limit reached — try simplifying your request)';
    if (this.sid) {
      saveMessages(this.sid, this.messages, this.name);
      appendTranscript(this.sid, 'assistant', finalText);
    }
    return finalText;
  }
}

export { DIRECTIVES_LOG, DATA_DIR };
