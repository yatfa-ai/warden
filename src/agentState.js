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
// stuck-repeat logic the Observer uses to classify panes (read_chats) and that
// feeds the deterministic /api/agent-states path, now
// also exposing a `signal` (the line that triggered the state) so a badge row can
// show WHY an agent needs attention.

// Classification regexes — the pane-state classifier (classifyPane; WARDEN-74:
// regex over LLM). BLOCKED is coordination/dependency language only; the
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

// Classify CLEANED pane text into structured per-agent fields (WARDEN-165
// criterion #2): state, errors, lastAction, currentStep, goal — plus `signal` (the triggering line, for the Attention badge).
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

// ─── User-authored output-pattern alerts (WARDEN-540) ─────────────────────────
//
// The deterministic, zero-LLM, user-authored complement to the fixed Watch
// categories above. A human teaches Warden "ping me when a watched agent prints X"
// (a deploy returning non-200, `pytest` printing `1 failed`, a billing/paywall
// page, "merge conflict", a custom CI marker) — signals the hard-coded SUMM_*_RE
// regexes are blind to. This is categorically DISTINCT from the Observer LLM
// (WARDEN-8): it is a pure substring/regex match over already-captured pane text,
// evaluated on the SAME /api/agent-states capture cadence Watch already uses for
// watched chats → zero new SSH cost (the codebase's hard SSH-cost discipline).
//
// Sibling of classifyPane: a pure function over already-cleaned (stripAnsi'd) pane
// text, intentionally dependency-free so it is unit-testable in isolation
// (agentState.test.js) and importable from server.js's pollAgentStates WITHOUT
// pulling fs / ssh / llm / node-pty. classifyPane decides the pane's STATE from a
// fixed developer-chosen vocabulary; this decides whether a USER-chosen string just
// appeared — an additive signal that never overrides the state (an agent can be
// both `erroring` AND match a custom pattern; both are independent dimensions).
//
// Shape of one pattern (the persisted cfg.watchPatterns entry): { id, name,
// expression, mode: 'string'|'regex', enabled }. The matcher only reads
// { name, expression, mode, enabled } (duck-typed — `id` is for UI keys + dedup,
// not matching), so a JSDoc typedef suffices; no runtime type is needed.

/**
 * @typedef {Object} WatchPattern
 * @property {string} id        Stable unique id (UI React key + PUT dedup).
 * @property {string} name      Human label, shown in the alert ("pattern: <name>").
 * @property {string} expression The text to match (substring or regex source).
 * @property {'string'|'regex'} mode Match semantics.
 * @property {boolean} enabled  false → the matcher skips it (no alert).
 */

/**
 * @typedef {Object} WatchPatternMatch
 * @property {string} pattern The matching pattern's `name` (for the alert body).
 * @property {string} line    The matching pane line (the actionable "where to look").
 */

// Caps mirrored verbatim in web/src/lib/storage.ts (WATCH_PATTERN_*_MAX) so the UI's
// maxLength + validatePatternName agree with this load/PUT sanitizer on one bound —
// a name/expression the UI accepts can never be silently dropped on save/reload.
// Mirrors the SNIPPET_*_MAX discipline (storage.ts) + parseSnippets (server side).
const WATCH_PATTERN_NAME_MAX = 64;
const WATCH_PATTERN_EXPRESSION_MAX = 500;
const WATCH_PATTERN_MAX_COUNT = 50;

/**
 * Pure: does any ENABLED user pattern match the cleaned pane text? Sibling of
 * classifyPane (WARDEN-540). Returns the FIRST enabled pattern that matches (in
 * array order — the user's defined order is the precedence), as
 * { pattern, line }, or null when no enabled pattern matches.
 *
 *  - `mode:'string'` = case-insensitive SUBSTRING, mirroring /api/search-pane's
 *    semantics exactly (line.toLowerCase().includes(expr.toLowerCase())). No RegExp
 *    is built, so a metacharacter-laden literal ("$ ? ( )") matches as plain text.
 *  - `mode:'regex'` = a case-insensitive RegExp built from the user's expression.
 *    An INVALID regex NEVER throws — it is skipped (the UI surfaces the validity
 *    error at authoring time; the matcher is the defense-in-depth backstop so a
 *    stale/invalid pattern can never crash /api/agent-states).
 *  - `enabled === false` patterns are skipped (the human silenced it).
 *  - Entries missing a name/expression are skipped (defensive — the PUT sanitizer
 *    already drops these, but the matcher never trusts its input).
 *  - The FIRST matching pattern wins (array order); for that pattern, the LAST
 *    (most recent) matching line is returned, trimmed + sliced to 200 chars —
 *    mirroring classifyPane's signal slicing so the alert body fits a toast.
 *
 * Pure + dependency-free (no RegExp.parse / no throws on bad input) so
 * agentState.test.js exercises string / regex / invalid-regex-doesn't-throw /
 * disabled / first-match-wins / last-line directly.
 *
 * @param {string} cleanText Already stripAnsi'd pane text (the same `clean` classifyPane reads).
 * @param {WatchPattern[]|null|undefined} patterns The user's cfg.watchPatterns.
 * @returns {WatchPatternMatch|null}
 */
export function matchWatchPatterns(cleanText, patterns) {
  if (typeof cleanText !== 'string' || !Array.isArray(patterns) || patterns.length === 0) return null;
  const lines = cleanText.split('\n');
  for (const p of patterns) {
    if (!p || p.enabled === false) continue;
    const name = typeof p.name === 'string' ? p.name.trim() : '';
    const expression = typeof p.expression === 'string' ? p.expression : '';
    if (!name || !expression.trim()) continue;
    const isRegex = p.mode === 'regex';
    let re = null;
    if (isRegex) {
      try { re = new RegExp(expression, 'i'); } catch { continue; } // invalid → skip, NEVER throw
    }
    // Walk from the END so the LAST (most recent) matching line wins — the pane's
    // live bottom is what the human needs to act on, mirroring classifyPane's
    // recency-bound signal. First matching pattern wins, so we return immediately.
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      const hit = isRegex ? re.test(line) : line.toLowerCase().includes(expression.toLowerCase());
      if (hit) {
        return { pattern: name, line: line.trim().slice(0, 200) };
      }
    }
  }
  return null;
}

/**
 * Pure: sanitize a raw watchPatterns payload (from PUT /api/config's req.body) into
 * a valid WatchPattern[] — the persistence-boundary type-guard (WARDEN-540). Mirrors
 * the parseSnippets drop-bad-entries discipline (web/src/lib/storage.ts): never
 * throws on malformed input (WARDEN-89), drops bad entries instead so one corrupt
 * entry can never blank the list or crash /api/config.
 *
 * Returns a SANITIZED ARRAY when `raw` is an array (possibly empty — all entries
 * dropped), or `null` when `raw` is not an array. The PUT handler treats `null` as
 * "field absent → no mutation" (mirroring `if (typeof X === 'string')` guards), so a
 * PUT that omits watchPatterns leaves the stored list intact while a PUT with a
 * malformed (non-array) value is ignored rather than blanking it.
 *
 * Drops entries that: aren't objects; lack a non-empty id/name/expression; have a
 * name/expression over the caps; dedups by id (first occurrence wins). Coerces `mode`
 * to 'string' for anything but the literal 'regex'. `enabled` defaults to true
 * (enabled !== false) so a legacy/partial entry without the flag still alerts.
 *
 * @param {unknown} raw
 * @returns {WatchPattern[]|null}
 */
export function sanitizeWatchPatterns(raw) {
  if (!Array.isArray(raw)) return null;
  const seen = new Set();
  const out = [];
  for (const entry of raw) {
    if (out.length >= WATCH_PATTERN_MAX_COUNT) break; // cap payload size
    if (!entry || typeof entry !== 'object') continue;
    const id = typeof entry.id === 'string' ? entry.id.trim() : '';
    const name = typeof entry.name === 'string' ? entry.name.trim() : '';
    const expression = typeof entry.expression === 'string' ? entry.expression.trim() : '';
    if (!id || !name || !expression) continue;
    if (name.length > WATCH_PATTERN_NAME_MAX) continue;
    if (expression.length > WATCH_PATTERN_EXPRESSION_MAX) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    const mode = entry.mode === 'regex' ? 'regex' : 'string';
    const enabled = entry.enabled !== false;
    out.push({ id, name, expression, mode, enabled });
  }
  return out;
}

export { WATCH_PATTERN_NAME_MAX, WATCH_PATTERN_EXPRESSION_MAX, WATCH_PATTERN_MAX_COUNT };
