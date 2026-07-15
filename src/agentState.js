// Pure pane-state classifier (WARDEN-344) — the detector WARDEN-33 built, lifted
// out of observer.js so the proactive attention surfaces (the header AttentionBadge
// + opt-in desktop alert) can reach it WITHOUT the Observer LLM having to invoke a
// tool. Before this, classifyPane was module-private inside observer.js and the
// HTTP layer had zero references to it; an agent actively emitting a repeating
// loop / stack trace / "press enter" prompt read HEALTHY because /api/health only
// looks at time-since-last-output.
//
// This module is intentionally dependency-free (no fs / ssh / llm / node-pty) so it
// is unit-testable in isolation (the agentState.test.js sibling) and importable from
// both observer.js (its original consumer) and server.js's new /api/agent-states
// endpoint. No heuristics were added or changed here — this is the exact regex +
// stuck-repeat logic that already classified Observer summarize_chats entries, now
// also exposing a `signal` (the line that triggered the state) so a badge row can
// show WHY an agent needs attention.

// Classification regexes — reused/extended from the summarize_chats classifier
// (classifyPane; WARDEN-74: regex over LLM). BLOCKED is coordination/dependency language only; the
// bare "waiting for" fragment is intentionally NOT matched, so human-input panes reach
// the WAITING branch (waiting = human input, blocked = other agents/deps).
export const SUMM_ERROR_RE = /error|failed|exception|traceback|panic|fatal/i;
export const SUMM_WAITING_RE = /please|respond|continue\?|input|press enter|waiting for user/i;
export const SUMM_BLOCKED_RE = /blocked by|blocked on|depends on|waiting for (?:the |an |a )?(?:agent|worker|planner|reviewer|researcher|dependency|approval)/i;
const SUMM_ACTIVE_RE = /running|processing|building|installing|downloading|executing|working on|implement/i;
const SUMM_TICKET_RE = /\b([A-Z][A-Z0-9]{1,}-\d+|#\d{2,})\b/;

// Strip ANSI escape sequences (tmux `capture-pane -e` keeps them) and stray
// carriage returns so classification reads clean text, not color/cursor noise.
// Handles CSI (SGR colors, cursor moves), OSC (titles), and lone escape bytes.
export function stripAnsi(s) {
  return String(s)
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '') // OSC sequences (title etc.)
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')          // CSI sequences (colors, cursor)
    .replace(/\x1b[@-Z\\-_]/g, '')                       // other single-char escape sequences
    .replace(/\r/g, '');
}

// Classify CLEANED pane text into the structured per-agent fields summarize_chats
// promises per entry (WARDEN-165 criterion #2): state, errors, lastAction,
// currentStep, goal — plus `signal` (the triggering line, for the Attention badge).
// All inference is regex-based — no LLM call.
//
// `c` is the chat object (role/project/active used for goal inference + the active
// state guard). It is optional only in the sense that the classifier degrades
// gracefully (treats a missing chat as not-active), but real callers always pass it.
export function classifyPane(clean, c) {
  // tmux `capture-pane` pads the captured region to the pane height, so a real
  // capture ends with trailing blank lines even when the agent's output doesn't.
  // Strip them BEFORE the repeat check, otherwise a stuck loop reads as
  // [line, "", ""] vs [line, line, line] and silently escapes detection. (WARDEN-344)
  const raw = clean.split('\n');
  let allLines = raw;
  while (allLines.length > 1 && allLines[allLines.length - 1].trim() === '') {
    allLines = allLines.slice(0, -1);
  }
  const nonEmpty = allLines.map(l => l.trimEnd()).filter(l => l.trim().length > 0);

  // Stuck: the last 3 lines repeat the previous 3 (repeating-output loop).
  const last3 = allLines.slice(-3).join('\n');
  const prev3 = allLines.slice(-6, -3).join('\n');
  const stuck = last3.length > 50 && last3 === prev3;

  const errors = nonEmpty
    .filter(l => SUMM_ERROR_RE.test(l))
    .slice(-3)
    .map(l => l.trim().slice(0, 200));

  const lastAction = nonEmpty.length ? nonEmpty[nonEmpty.length - 1].trim().slice(0, 200) : null;

  // Recency-bound the STATE decision (WARDEN-390): erroring/blocked/waiting are
  // decided against the LIVE BOTTOM of the pane (a recent tail of non-empty lines),
  // not the full ~60-line capture. A triggering line that has scrolled OUT of the
  // tail, with active/other output below it, no longer flips the state — so an agent
  // that hit an error and recovered stops reading "needs attention" while the stale
  // line still lingers in the window. `stuck` is already recency-safe (the last-6
  // repeat check above); `active` keeps scanning the full window so a busy-but-
  // briefly-quiet agent doesn't false-flip to the alertable 'idle'. Precedence
  // (erroring > stuck > blocked > waiting > active) still holds among the tail's
  // lines — erroring is tested first, so an error + blocked both in the tail → erroring.
  const STATE_TAIL_LINES = 15; // ~one visible screen of non-empty output
  const tail = nonEmpty.slice(-STATE_TAIL_LINES).join('\n');

  let state;
  if (SUMM_ERROR_RE.test(tail)) state = 'erroring';
  else if (stuck) state = 'stuck';
  else if (SUMM_BLOCKED_RE.test(tail)) state = 'blocked';
  else if (SUMM_WAITING_RE.test(tail)) state = 'waiting';
  else if (SUMM_ACTIVE_RE.test(clean) && c && c.active) state = 'active';
  else state = 'idle';

  const stepMatch = clean.match(/\b(?:running|building|installing|testing|compiling|deploying|starting|executing|processing|analyzing|reviewing|implementing|fixing|refactoring)\b[^\n]{0,80}/i);
  const currentStep = stepMatch ? stepMatch[0].trim().slice(0, 160) : lastAction;

  return {
    state,
    errors,
    lastAction,
    currentStep,
    goal: inferGoal(clean, c),
    signal: paneStateSignal(state, { last3, errors, nonEmpty }),
  };
}

// The human-readable "why" for an attention-worthy state — the line that triggered
// the classification, shown in the Attention badge row so the human can see what to
// act on without opening the pane. null for active/idle (no alert to explain) and
// when no specific triggering line could be isolated.
function paneStateSignal(state, { last3, errors, nonEmpty }) {
  if (state === 'stuck') {
    // The repeating line — first line of the duplicated last-3 block.
    const line = (last3.split('\n')[0] || '').trim();
    return line.slice(0, 200) || null;
  }
  if (state === 'erroring') {
    // The most recent error line (errors already slices the last 3, ascending).
    return errors.length ? errors[errors.length - 1] : null;
  }
  if (state === 'waiting' || state === 'blocked') {
    const re = state === 'waiting' ? SUMM_WAITING_RE : SUMM_BLOCKED_RE;
    // The LAST matching line (most recent prompt / coordination signal).
    for (let i = nonEmpty.length - 1; i >= 0; i--) {
      if (re.test(nonEmpty[i])) return nonEmpty[i].trim().slice(0, 200);
    }
    return null;
  }
  return null;
}

// Best-effort goal inference from pane content (regex only). Returns null only if
// nothing at all can be inferred — otherwise prefers an explicit ticket reference,
// then an action phrase, then a role/project fallback.
export function inferGoal(clean, c) {
  const ticket = clean.match(SUMM_TICKET_RE);
  if (ticket) return ticket[1];
  const action = clean.match(/\b(?:working on|implementing|fixing|building|refactoring|reviewing|investigating)\b[^\n]{0,80}/i);
  if (action) return action[0].trim().slice(0, 120);
  if (c && c.role && c.project) return `${c.role} on ${c.project}`;
  if (c && c.role) return c.role;
  return null;
}
