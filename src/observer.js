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
// here unchanged — summarize_chats / read_chats / alert_changes still classify panes
// with the exact same logic. stripAnsi + inferGoal are also used directly below.
import { classifyPane, stripAnsi, inferGoal } from './agentState.js';

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
- summarize_chats({per_agent_lines?, changed_only?}): structured, size-bounded summary of every open chat — one entry per pane with role, state (active/idle/stuck/erroring/blocked/waiting), last action, errors, current step, and goal. Failed captures are flagged per-entry, never omitted. Use this when the user asks "what's happening", "what are they working on", or you need a complete picture to advise well. Set changed_only: true to get back only agents whose state or content changed since the last read.
- analyze_agents(): detect patterns across all open tabs. Returns structured insights about which agents are stuck, erroring, idle, or need coordination. Use this to answer "what needs attention?" or diagnose workflow issues.
- suggest_next_actions(): analyze all open agent tabs and suggest prioritized, concrete next actions for the human. Classifies agent states (stuck, erroring, waiting, blocked, idle, active) and identifies urgent issues requiring immediate attention. Returns sorted suggestions with urgency levels.
- alert_changes(): on-demand check that reports ONLY open agents newly entering a state worth alerting on since the last read — idle, erroring, stuck (repeating output), or completed-a-task. It diffs against the last-read cache, so only CHANGES surface (no re-reading everything). Use this when the user asks "what needs attention", "who finished", or "what changed". NOTE: the first call on a cold cache establishes a baseline and returns no alerts — call summarize_chats first, then alert_changes later to see what changed.
- write_file({path, content, append?}): save TEXT to a file under the warden data dir (~/.yatfa-warden/), e.g. reports/summary.md or snapshots/agent-X.md. Use this to persist observations, findings, snapshots, or reports worth keeping between turns — it is your only durable output channel besides send_directive (which only talks to agents). path is relative to the data dir; set append: true to add to a file instead of overwriting. Writes are confined to the data dir.

Your job:
1. Watch — read the chats the user cares about; keep an accurate, current picture of each agent's work.
2. Advise — tell the user what's going on: who is progressing, who is stuck, who is idle, what needs a human decision right now. Be concrete and brief; cite what you read.
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

When using summarize_chats, the tool returns STRUCTURED per-agent state (not raw terminal dumps) — synthesize your advice from those fields:
- Each entry has role, state, lastAction, errors, currentStep, goal, and a bounded excerpt.
- Triage by state: erroring/stuck agents need attention first; blocked agents depend on others; waiting agents need your input; idle agents may be done or stalled.
- captureError: true means that pane could not be captured (host unreachable). The entry is still present — flag it to the user; do NOT assume the agent is idle.
- Be concrete: name the agents, cite the errors/currentStep you read, and recommend the next action.

When using analyze_agents, prioritize:
1. Stuck agents (repeating output) — need human intervention or restart
2. Erroring agents — surface the error type and suggest next steps
3. Coordination blockers — which agents are waiting on others
4. Idle agents — what input they need to proceed

Be specific. Name the agents, state the problem, and suggest concrete actions.

Be concise. Highlight what needs attention NOW.`;

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
    name: 'summarize_chats',
    description: 'Read all open tabs at once and return a structured, size-bounded summary of what each agent is doing. Returns one entry per open chat with role, state (active/idle/stuck/erroring/blocked/waiting), last action, errors, current step, and goal. Capture failures are flagged per-entry, not omitted. Pass per_agent_lines to bound how much recent pane output each entry carries (default 15). Set changed_only: true to get back only agents whose state or content changed since the last read.',
    input_schema: {
      type: 'object',
      properties: {
        per_agent_lines: { type: 'number', description: 'Max recent pane lines to include per agent (default 15). Lower = more concise summary; higher = more context.' },
        changed_only: { type: 'boolean', description: 'If true, return only agents whose state or content changed since the last read (diff against the last-read cache). Default false.' },
      },
      required: [],
    },
  },
  {
    name: 'analyze_agents',
    description: 'Analyze all open agent tabs for actionable patterns and states. Returns structured insights about stuck agents, errors, idle agents, and coordination needs. Use this when the user asks "what needs attention", "is anyone stuck", or you need to diagnose issues.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'suggest_next_actions',
    description: 'Analyze all open agent tabs and suggest prioritized, concrete next actions for the human. Classifies agent states (stuck, erroring, waiting, blocked, idle, active) and identifies urgent issues requiring immediate attention. Returns sorted suggestions with urgency levels.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'alert_changes',
    description: "On-demand: check the open agents and report ONLY those that newly entered a state worth alerting on since the last read — idle, erroring, stuck (repeating output), or completed-a-task. No background watcher; call this when the user asks 'what needs attention' or 'who finished'. It reads each open pane and (for Claude Code agents) the transcript to detect a task completing, then diffs against the last-read cache so only CHANGES surface. The FIRST call on a cold cache establishes a baseline and returns no alerts — call it once after a summarize, then again later to see what changed. No extra LLM calls.",
    input_schema: { type: 'object', properties: {}, required: [] },
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

function logDirective(chat, text) {
  fs.mkdirSync(path.dirname(DIRECTIVES_LOG), { recursive: true });
  const header = fs.existsSync(DIRECTIVES_LOG) ? '' : '# Yatfa Warden directives log\n';
  const ts = new Date().toISOString();
  const entry = `${header}\n## ${ts} → ${chat.container}@${chat.host} (${chat.role || 'agent'})\n\n${text}\n`;
  fs.appendFileSync(DIRECTIVES_LOG, entry);
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

// Pane-state classification (classifyPane), the SUMM_* regexes, stripAnsi, and
// inferGoal now live in agentState.js (WARDEN-344) — imported above. They were
// lifted out verbatim so the HTTP layer's /api/agent-states endpoint can reuse the
// exact same detector the Observer summarize_chats tool uses, with no duplication.

// ---------------- change-aware state cache (WARDEN-166) ----------------
//
// The conservative core of change-awareness: a per-agent last-read snapshot
// (pane state + content signature + transcript phase + timestamp) kept as a
// side-effect of normal opt-in reads, a "what changed since last read" diff,
// and an on-demand alert trigger. NO background polling, NO autonomous token
// spend (WARDEN-75) — every read is caller-driven. The pure helpers below are
// fully unit-testable with no SSH/tmux; the async DI core (alertChangedAgents)
// takes capturePanes + readTranscriptPhase as injected dependencies for the same
// reason (mock.module is unavailable on the project's Node — WARDEN-130).

// Content signature for change detection: stable across reads unless the pane's
// line count or its last line actually changed. Two captures with the same sig
// are "unchanged content", so the diff can skip them on follow-up reads.
export function paneSignature(cleanPane) {
  const lines = String(cleanPane).split('\n').map((l) => l.trimEnd()).filter((l) => l.trim().length > 0);
  const last = lines.length ? lines[lines.length - 1] : '';
  return `${lines.length}:${last.slice(0, 120)}`;
}

// ---- completed-a-task detection (the one genuinely new signal) ----
//
// Idle / erroring / Stuck / Blocked / Waiting / Active are already returned by
// classifyPane — reused as-is, no new patterns. "Completed" is new and its
// PRIMARY signal is the Claude Code transcript (not pane text): a turn flips
// mid-turn → awaiting-input when an agent finishes and is waiting for the next
// prompt. Bare-tmux tabs without a transcript fall back to a pane-state
// transition (working → clean idle).

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

// Did this agent just complete a task? Transcript path is authoritative when both
// phases are known (fires on the mid-turn → awaiting-input flip); otherwise the
// transcript-less fallback fires on a working-state → clean-idle transition.
const WORKING_STATES = new Set(['active', 'stuck', 'erroring', 'blocked', 'waiting']);
export function detectCompleted(priorState, priorPhase, curState, curPhase) {
  if (priorPhase && curPhase) {
    return priorPhase === 'mid-turn' && curPhase === 'awaiting-input';
  }
  return WORKING_STATES.has(priorState) && curState === 'idle';
}

// States that warrant an alert when newly entered. ('completed' is a transient
// event derived in diffAlerts, not a persistent classifyPane state.)
const ALERTABLE_STATES = new Set(['idle', 'erroring', 'stuck']);
const ALERT_PRIORITY = { erroring: 0, stuck: 1, completed: 2, idle: 3 };

// Diff a prior cache snapshot against a freshly observed one and surface ONLY
// agents that newly entered an alertable state (idle / erroring / stuck /
// completed) since the last read. Fires on change-into-state only: an agent
// already in the state produces no alert, and an agent with no prior baseline
// (first observation) produces none either. At most ONE alert per agent per
// diff, chosen by urgency: a newly-erroring/stuck pane beats "completed" (an
// error is more actionable than "it finished"), and "completed" beats a bare
// newly-idle (idle is the expected post-completion pane, so reporting both is
// redundant). Pure — the heart of AC #3.
export function diffAlerts(priorReadState, curObserved) {
  const prior = priorReadState || {};
  const cur = curObserved || {};
  const alerts = [];
  for (const [key, c] of Object.entries(cur)) {
    const p = prior[key];
    if (!p) continue; // no last read → no diff
    const completed = detectCompleted(p.state, p.phase, c.state, c.phase);
    const newlyEntered = ALERTABLE_STATES.has(c.state) && p.state !== c.state;
    // Urgency precedence: erroring > stuck > completed > idle. Newly-erroring or
    // newly-stuck wins over a simultaneous completed flip (don't mask an error
    // behind "it finished"). Completed wins over bare idle (post-finish idle is
    // expected, not a separate alert).
    let alert = null;
    if (c.state === 'erroring' && newlyEntered) alert = 'erroring';
    else if (c.state === 'stuck' && newlyEntered) alert = 'stuck';
    else if (completed) alert = 'completed';
    else if (c.state === 'idle' && newlyEntered) alert = 'idle';
    if (alert) {
      alerts.push({ id: c.id, key, host: c.host, role: c.role, project: c.project,
        alert, fromState: p.state || null, toState: c.state });
    }
  }
  alerts.sort((a, b) => (ALERT_PRIORITY[a.alert] ?? 9) - (ALERT_PRIORITY[b.alert] ?? 9));
  const count = (a) => alerts.filter((x) => x.alert === a).length;
  return {
    alerts,
    summary: {
      total: alerts.length,
      erroring: count('erroring'),
      stuck: count('stuck'),
      completed: count('completed'),
      idle: count('idle'),
    },
  };
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

// Pure, dependency-injected core of the summarize_chats tool. capturePanes is passed
// in so this logic is unit-testable without SSH/tmux (mock.module is unavailable on
// the project's Node version). Returns a STRUCTURED per-agent summary (not raw ANSI):
// one entry per open pane, with capture failures flagged per-entry rather than
// silently dropped. `opts.per_agent_lines` (default 15) bounds each entry's excerpt.
export async function summarizeOpenChats(openTabs, lastChats, capturePanes, cfg, opts = {}, readTranscriptPhase, lastReadState) {
  const open = new Set(openTabs || []);
  if (open.size === 0) return { error: 'no tabs are open. open some agent panes first.' };

  // Filter to only open tabs
  const openChats = lastChats.filter(c =>
    open.has(c.container || c.session) || open.has(c.key)
  );

  if (openChats.length === 0) {
    return { error: 'open tabs do not match any discovered chats. try refreshing with list_chats.' };
  }

  const perAgentLines = Math.max(1, Number.isFinite(opts.per_agent_lines) ? opts.per_agent_lines : 15);
  // Transcript phase is read ONLY when the caller opted in (passed a
  // readTranscriptPhase fn) — a plain summarize stays a single capturePanes
  // round-trip. WARDEN-75: no autonomous cost, change-awareness is opt-in.
  const wantPhase = typeof readTranscriptPhase === 'function';
  const diffing = opts.changed_only === true && !!lastReadState;

  try {
    const panes = await capturePanes(openChats, cfg);

    // Build the structured per-agent entries AND a parallel observedState map
    // (key → {state, phase, sig}) in one pass. observedState is the side-channel
    // the Observer merges into its last-read cache (WARDEN-166); it is stripped
    // from the LLM-facing result by the dispatcher and never reaches the model.
    const built = openChats.map(c => {
      const base = {
        id: c.container || c.session,
        host: c.host,
        project: c.project,
        role: c.role,
        active: c.active,
      };

      // A capture that succeeded always sets panes[c.key] (even to '' for an empty
      // pane). A MISSING key means capturePanes silently dropped this chat — the
      // WARDEN-165 "1 of 6" root cause: capturePanes does `if (!res.ok) return;` per
      // host, so every pane on a host whose SSH fails vanishes. Surface it as a
      // flagged failure instead of omitting the entry (failures reported, not dropped).
      if (!Object.prototype.hasOwnProperty.call(panes, c.key)) {
        return {
          entry: {
            ...base,
            state: 'capture_failed',
            captureError: true,
            error: `failed to capture pane on ${c.host} (host unreachable or tmux capture error)`,
            errors: [],
            lastAction: null,
            currentStep: null,
            goal: inferGoal('', c),
            excerpt: null,
          },
          key: c.key,
          state: 'capture_failed',
          sig: null,
        };
      }

      const clean = stripAnsi(panes[c.key] || '');
      const excerpt = clean.split('\n').slice(-perAgentLines).join('\n').trim();
      const cls = classifyPane(clean, c);
      return {
        entry: {
          ...base,
          ...cls,
          captureError: false,
          excerpt,
        },
        key: c.key,
        state: cls.state,
        sig: paneSignature(clean),
      };
    });

    // observedState reflects EVERY open agent (so the cache stays current), not
    // just the diff-filtered subset.
    const observedState = {};
    for (const b of built) observedState[b.key] = { state: b.state, phase: null, sig: b.sig };

    // Optional transcript-phase pass (concurrent, per-agent failures → null).
    if (wantPhase) {
      await Promise.all(openChats.map(async (c) => {
        const ob = observedState[c.key];
        if (!ob || ob.state === 'capture_failed') return;
        try { ob.phase = await readTranscriptPhase(c, cfg); }
        catch { ob.phase = null; }
      }));
    }

    // Opt-in diff (WARDEN-166 AC #2): return only agents whose state OR content
    // changed since the last read. observedState still covers all agents; only the
    // returned `chats` set is narrowed. A newly seen agent (no prior) counts as
    // changed so the first diff surfaces everything once.
    let chats = built.map(b => b.entry);
    if (diffing) {
      chats = built
        .filter(b => {
          const p = lastReadState[b.key];
          if (!p) return true;
          return p.state !== b.state || p.sig !== b.sig;
        })
        .map(b => b.entry);
    }

    const countBy = (pred) => chats.filter(pred).length;
    return {
      chats,
      observedState,
      count: chats.length,
      changedOnly: diffing === true,
      summary: {
        total: chats.length,
        active: countBy(e => e.state === 'active'),
        idle: countBy(e => e.state === 'idle'),
        stuck: countBy(e => e.state === 'stuck'),
        erroring: countBy(e => e.state === 'erroring'),
        blocked: countBy(e => e.state === 'blocked'),
        waiting: countBy(e => e.state === 'waiting'),
        captureFailed: countBy(e => e.captureError),
      },
    };
  } catch (e) {
    return { error: e.message };
  }
}

// Pure, dependency-injected core of the read_chats tool — a BATCHED read of many
// panes in ONE capturePanes call. capturePanes groups by host and runs Promise.all
// per host (chats.js), so worst-case latency scales with HOST count, not pane
// count (WARDEN-88): reading 6 open panes is one round-trip, not six serial
// read_chat calls. Distinct from summarize_chats (structured/lossy classification):
// this returns the RAW pane text for specific panes the observer must read in full.
//
// Two resolution modes:
//   openOnly === true → read exactly the observer's effective open tabs
//                       (the caller passes effectiveOpenTabs()), matching the
//                       summarize_chats filter so open_only reads what's watched,
//                       bound chat included (seamless cross-host resume).
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

// Pure, dependency-injected core of the suggest_next_actions tool. capturePanes is
// passed in so the classification logic is unit-testable without SSH/tmux
// (mock.module is unavailable on the project's Node version). Behavior is identical
// to the inlined tool handler.
export async function suggestNextActions(openTabs, lastChats, capturePanes, cfg) {
  const open = new Set(openTabs || []);
  if (open.size === 0) return { error: 'no tabs are open. open some agent panes first.' };

  // Filter to only open tabs
  const openChats = lastChats.filter(c =>
    open.has(c.container || c.session) || open.has(c.key)
  );

  if (openChats.length === 0) {
    return { error: 'open tabs do not match any discovered chats. try refreshing with list_chats.' };
  }

  try {
    const panes = await capturePanes(openChats, cfg);

    // Classification patterns (regex-based, no LLM calls).
    // NOTE: BLOCKED_RE is scoped to coordination/dependency language (other agents,
    // external dependencies) — it deliberately does NOT match the bare fragment
    // "waiting for", which would otherwise swallow "waiting for user" (a human-input
    // signal classified as 'waiting' below). The two states stay distinct, matching
    // the ticket spec: waiting = human input, blocked = other agents/dependencies.
    const ERROR_RE = /error|failed|exception|traceback|panic/i;
    const WAITING_RE = /please|respond|continue\?|input|press enter|waiting for user/i;
    const BLOCKED_RE = /blocked by|blocked on|depends on|waiting for (?:the |an |a )?(?:agent|worker|planner|reviewer|researcher|dependency|approval from)/i;
    const ACTIVE_RE = /running|processing|building|installing|downloading|executing|working on|implement/i;

    const suggestions = [];

    for (const c of openChats) {
      const pane = panes[c.key] || '';
      const agentId = c.container || c.session;
      const role = c.role || 'agent';
      const project = c.project || 'unknown';

      let state = 'idle';
      let urgency = 'informational';
      let action = 'No action needed - agent is idle.';

      // Detect repeating output (stuck agent) using line-by-line comparison
      const lines = pane.split('\n');
      const last3 = lines.slice(-3).join('\n');
      const prev3 = lines.slice(-6, -3).join('\n');
      const stuck = last3 === prev3 && last3.length > 50;

      // Classify agent state using regex patterns. BLOCKED is checked before WAITING:
      // because BLOCKED_RE is scoped to coordination signals, no human-input pane can
      // match it, so genuine waiting input always reaches the WAITING branch.
      if (ERROR_RE.test(pane)) {
        state = 'erroring';
        urgency = 'urgent';
        action = `Agent encountered an error. Review the pane content and investigate the failure. Consider sending a directive to retry or fix the issue.`;
      } else if (stuck) {
        state = 'stuck';
        urgency = 'urgent';
        action = `Agent appears stuck (repeating output detected). Interrupt and redirect with a new directive, or terminate if needed.`;
      } else if (BLOCKED_RE.test(pane)) {
        state = 'blocked';
        urgency = 'important';
        action = `Agent is blocked on a dependency. Check what it's waiting for and unblock it, or redirect to other work.`;
      } else if (WAITING_RE.test(pane)) {
        state = 'waiting';
        urgency = 'important';
        action = `Agent is waiting for input. Respond to its request or provide the needed information.`;
      } else if (ACTIVE_RE.test(pane) && c.active) {
        state = 'active';
        urgency = 'informational';
        action = `Agent is actively working. No immediate action needed, but monitor for completion or issues.`;
      } else if (pane.trim().length > 100) {
        state = 'idle';
        urgency = 'informational';
        action = `Agent has output but appears inactive. Check if it completed its task or needs direction.`;
      } else {
        state = 'idle';
        urgency = 'informational';
        action = `Agent is idle with minimal output. Consider assigning work or checking if it needs direction.`;
      }

      suggestions.push({
        agentId: agentId,
        agentName: agentId,
        role,
        project,
        host: c.host,
        state,
        urgency,
        action,
        pane_excerpt: pane.slice(-200).trim(), // Last 200 chars for context
      });
    }

    // Sort by urgency: urgent > important > informational
    const urgencyOrder = { urgent: 0, important: 1, informational: 2 };
    suggestions.sort((a, b) => urgencyOrder[a.urgency] - urgencyOrder[b.urgency]);

    return {
      suggestions,
      summary: {
        total: suggestions.length,
        urgent: suggestions.filter(s => s.urgency === 'urgent').length,
        important: suggestions.filter(s => s.urgency === 'important').length,
        informational: suggestions.filter(s => s.urgency === 'informational').length,
      },
    };
  } catch (e) {
    return { error: e.message };
  }
}

// Pure, dependency-injected core of the alert_changes tool (WARDEN-166 AC #3).
// An ON-DEMAND trigger — never called by a background loop (WARDEN-75). It
// captures every open pane (concurrent via capturePanes — WARDEN-88), classifies
// each with the EXISTING classifyPane (no new patterns, no extra LLM calls),
// reads each agent's transcript phase (readTranscriptPhase injected so this is
// unit-testable with no SSH/tmux), and diffs against the last-read cache to
// surface ONLY agents newly entering an alertable state (idle / erroring /
// stuck / completed). Returns the alerts plus an observedState side-channel the
// Observer merges into its cache so the NEXT diff has a fresh baseline.
export async function alertChangedAgents(openTabs, lastChats, capturePanes, readTranscriptPhase, cfg, lastReadState) {
  const open = new Set(openTabs || []);
  if (open.size === 0) return { error: 'no tabs are open. open some agent panes first.' };

  const openChats = (lastChats || []).filter(c =>
    open.has(c.container || c.session) || open.has(c.key)
  );

  if (openChats.length === 0) {
    return { error: 'open tabs do not match any discovered chats. try refreshing with list_chats.' };
  }

  try {
    const panes = await capturePanes(openChats, cfg);

    // Per-agent observe (concurrent): classify the pane + read the transcript
    // phase. Capture failures and transcript failures are surfaced/degraded per
    // agent, never dropped — a missing pane key is a capture_failed state, and a
    // transcript error resolves to phase null (the pane-state fallback path).
    const observedState = {};
    let captureFailed = 0;
    await Promise.all(openChats.map(async (c) => {
      if (!Object.prototype.hasOwnProperty.call(panes, c.key)) {
        observedState[c.key] = { state: 'capture_failed', phase: null, sig: null };
        captureFailed += 1;
        return;
      }
      const clean = stripAnsi(panes[c.key] || '');
      const state = classifyPane(clean, c).state;
      let phase = null;
      if (typeof readTranscriptPhase === 'function') {
        try { phase = await readTranscriptPhase(c, cfg); } catch { phase = null; }
      }
      observedState[c.key] = { state, phase, sig: paneSignature(clean) };
    }));

    // Attach chat metadata to the observed snapshot so diffAlerts can build
    // self-describing alert objects (id/host/role/project).
    const curObserved = {};
    for (const c of openChats) {
      const ob = observedState[c.key];
      if (!ob) continue;
      curObserved[c.key] = {
        ...ob,
        id: c.container || c.session,
        key: c.key,
        host: c.host,
        role: c.role,
        project: c.project,
      };
    }

    const { alerts, summary: diffSummary } = diffAlerts(lastReadState || {}, curObserved);

    return {
      alerts,
      observedState,
      // Guidance for the model: if there is no baseline yet, the first call only
      // establishes one (no alerts) — say so explicitly so it doesn't conclude
      // "nothing needs attention" from a cold cache.
      baseline: Object.keys(lastReadState || {}).length === 0,
      summary: {
        total: openChats.length,
        alertCount: alerts.length,
        captureFailed,
        ...diffSummary,
      },
    };
  } catch (e) {
    return { error: e.message };
  }
}

export class Observer {
  constructor(cfg, { sid, gate, onTool, onToolResult, onText, chatContext } = {}) {
    this.cfg = cfg;
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
    // Updated as a SIDE-EFFECT of summarize_chats / read_chats / read_chat — never
    // by a background loop (WARDEN-75). In-memory, matching lastChats. Drives the
    // changed_only diff and the alert_changes trigger.
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
    const { chats } = await discoverAll(this.cfg.hosts, this.cfg);
    this.lastChats = chats;
    return chats;
  }

  async _resolve(id) {
    const result = resolveChat(id, this.lastChats, null);

    // If we got a definitive result, return it (converting to chat or error object)
    if (result.chat) return result.chat;
    if (result.error) return { error: result.error };

    // No match in cache - refresh and try again
    const chats = await this._refreshChats();
    const result2 = resolveChat(id, chats, null);

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
        const pane = await readPane(chat, this.cfg, input.lines || 120);
        // WARDEN-166: cache the last-read pane state + content signature as a
        // side-effect of the read. Phase is left to the opt-in change-awareness
        // tools (summarize/read_chats with changed_only, or alert_changes) so a
        // plain read_chat stays a single round-trip. Best-effort, never blocks.
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
        this.lastChats, capturePanes, this.cfg, input, rtp, this.lastReadState);
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
        await sendPane(chat, this.cfg, text);
        logDirective(chat, text);
        return { sent: true, to: `${chat.container}@${chat.host}`, chars: text.length };
      } catch (e) { return { error: e.message }; }
    }
    if (name === 'summarize_chats') {
      // changed_only opts into change-awareness (threads readTranscriptPhase +
      // the cache); a plain summarize stays phase-free and single-round-trip.
      const rtp = input.changed_only ? readTranscriptPhase : undefined;
      const res = await summarizeOpenChats(this.effectiveOpenTabs(), this.lastChats, capturePanes, this.cfg, input, rtp, this.lastReadState);
      this._mergeReadState(res.observedState);
      const out = { ...res };
      delete out.observedState;
      return out;
    }
    if (name === 'analyze_agents') {
      const open = new Set(this.effectiveOpenTabs());
      if (open.size === 0) return { error: 'no tabs are open. open some agent panes first.' };

      // Filter to only open tabs
      const openChats = this.lastChats.filter(c =>
        open.has(c.container || c.session) || open.has(c.key)
      );

      if (openChats.length === 0) {
        return { error: 'open tabs do not match any discovered chats. try refreshing with list_chats.' };
      }

      try {
        const panes = await capturePanes(openChats, this.cfg);

        const insights = openChats.map(c => {
          const pane = panes[c.key] || '';
          const lines = pane.split('\n');

          // Detect repeating output (stuck agent)
          const last3 = lines.slice(-3).join('\n');
          const prev3 = lines.slice(-6, -3).join('\n');
          const stuck = last3 === prev3 && last3.length > 50;

          // Detect errors
          const hasError = /error|exception|failed|traceback|fatal/i.test(pane);
          const errorLines = lines.filter(l => /error|exception|failed/i.test(l)).slice(-2);

          // Detect idle/waiting
          const isIdle = /prompt|waiting|input|approval|press|continue/i.test(pane);

          // Detect coordination signals
          const mentionsAgent = /agent|worker|planner|reviewer|researcher/i.test(pane);
          const blocked = /blocked|waiting on|depends|need.*from/i.test(pane);

          return {
            id: c.container || c.session,
            host: c.host,
            role: c.role,
            state: stuck ? 'stuck' : (hasError ? 'erroring' : (isIdle ? 'idle' : 'active')),
            signals: {
              stuck,
              hasError,
              errorSample: errorLines.join('; '),
              isIdle,
              mentionsAgent,
              blocked,
            },
          };
        });

        const summary = {
          total: insights.length,
          stuck: insights.filter(i => i.state === 'stuck').length,
          erroring: insights.filter(i => i.state === 'erroring').length,
          idle: insights.filter(i => i.state === 'idle').length,
          active: insights.filter(i => i.state === 'active').length,
        };

        return { insights, summary };
      } catch (e) {
        return { error: e.message };
      }
    }
    if (name === 'suggest_next_actions') {
      return suggestNextActions(this.effectiveOpenTabs(), this.lastChats, capturePanes, this.cfg);
    }
    if (name === 'alert_changes') {
      // On-demand change-awareness trigger (WARDEN-166). Always reads transcript
      // phase so a completed-task flip can fire. Never invoked by a background
      // loop (WARDEN-75). The first call on a cold cache only establishes a
      // baseline (no alerts) — surfaced via res.baseline.
      const res = await alertChangedAgents(this.effectiveOpenTabs(), this.lastChats, capturePanes, readTranscriptPhase, this.cfg, this.lastReadState);
      this._mergeReadState(res.observedState);
      const out = { ...res };
      delete out.observedState;
      return out;
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
