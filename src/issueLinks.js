// The per-project issue-key → tracker mapping for the terminal issue linkifier
// (WARDEN-1388, slice 1 of roadmap WARDEN-1386).
//
// Pure + dependency-free, exactly like the sibling sanitizers this module's
// shape follows (sanitizeWatchPatterns in agentState.js): config-schema.js
// imports the ONE sanitizer here for the `issueLinkTrackers` descriptor's PUT
// guard, and nothing in this file touches Electron, the renderer, or the fs.
//
// THE LINK IS STATED BY A HUMAN, NEVER INFERRED (the ticket's non-negotiable):
// a mapping entry names the warden project, the issue-key PREFIX that belongs
// to it, and the tracker host (with optional path) keys live under. Nothing is
// guessed from container names, hostnames, or key text — an unconfigured
// project has NO prefix and therefore linkifies nothing, by construction.
//
// Entry grammar (the human-stated string form, e.g. in config.json):
//
//   <project>=<prefix>@<host>[:<port>][/<path>]
//
//   warden=WARDEN@github.com/acme/warden/issues
//   yatfa=YATFA@tracker.example.com:8443/browse
//
//   project — the pane's chat.project (the container name minus the role).
//             Strict, case-SENSITIVE equality against it; no normalization,
//             no inference.
//   prefix  — the issue-key prefix, 1–16 chars, starting with a letter.
//             NORMALIZED to UPPERCASE (issue keys are conventionally upper).
//   tracker — host[:port][/path]. NO scheme (https is always what the opener
//             builds), no query/hash, no trailing slash.
//
// The OPENED URL is `https://<tracker>/<KEY>` — the KEY goes at the END of the
// configured base. That one shape covers GitHub (`github.com/org/repo/issues/
// WARDEN-1385`), Jira (`jira.acme.com/browse/WARDEN-1385`), Gitea/GitLab
// (`host/project/-/issues/WARDEN-1385`), and any tracker with the same
// tail-positioned key. A tracker with a different key placement simply cannot
// be stated yet — refusing to invent one keeps the wire contract honest.
//
// Storage/GET shape is the SANITIZED STRUCTURED entry
// `{ project, prefix, tracker }` — unambiguous on read, and the sanitizer
// accepts BOTH forms (string in → parsed; already-structured in → re-validated)
// so a Settings round-trip (GET output PUT back) survives, and a human editing
// config.json may write whichever form reads better to them.

// Caps — payload hygiene, mirroring WATCH_PATTERN_MAX_*'s intent: a corrupted
// or hostile config can't grow the persisted array or any single entry without
// bound. Generous for real use (a handful of projects).
export const ISSUE_LINK_TRACKER_MAX_COUNT = 64;
export const ISSUE_LINK_PROJECT_MAX = 64;
export const ISSUE_LINK_PREFIX_MAX = 16;
export const ISSUE_LINK_TRACKER_MAX = 200;

// The whole-entry grammar, anchored both ends: `project=prefix@tracker`.
// Groups: 1 = project, 2 = prefix, 3 = tracker (host[:port][/path], no scheme).
// The tracker group is validated FURTHER by TRACKER_RE below (the grammar's
// \S+ here just keeps the regex readable; the specific shape check lives there).
const ISSUE_LINK_ENTRY_RE = /^([A-Za-z0-9][A-Za-z0-9._-]{0,63})=([A-Za-z][A-Za-z0-9]{0,15})@(\S+)$/;

// tracker = host[:port][/path]. Host is letters/digits/dots/hyphens (a hostname
// or an IP; no scheme — a `://` can never match), port optional digits, path a
// slash-led run with no whitespace, `?`, or `#` (the opener only ever builds a
// plain path URL; query/hash strings belong to the tracker's own UI, not a
// key deep-link).
const TRACKER_RE = /^[A-Za-z0-9.-]+(?::\d+)?(\/[^\s?#]*)?$/;

export function isValidIssueLinkProject(v) {
  return typeof v === 'string' && v.length > 0 && v.length <= ISSUE_LINK_PROJECT_MAX
    && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(v);
}

export function isValidIssueLinkPrefix(v) {
  return typeof v === 'string' && v.length > 0 && v.length <= ISSUE_LINK_PREFIX_MAX
    && /^[A-Za-z][A-Za-z0-9]*$/.test(v);
}

export function isValidIssueLinkTracker(v) {
  return typeof v === 'string' && v.length > 0 && v.length <= ISSUE_LINK_TRACKER_MAX
    && TRACKER_RE.test(v) && !v.includes('://');
}

// Parse ONE human-stated string entry (`project=prefix@tracker`) into its
// structured form, or null when it does not parse. Exported for tests + the
// Settings surface that will eventually own the string input.
export function parseIssueLinkEntry(raw) {
  if (typeof raw !== 'string') return null;
  const entry = raw.trim();
  if (!entry) return null;
  const m = ISSUE_LINK_ENTRY_RE.exec(entry);
  if (!m) return null;
  const tracker = m[3].replace(/\/+$/, '');
  if (!isValidIssueLinkTracker(tracker)) return null;
  return { project: m[1], prefix: m[2].toUpperCase(), tracker };
}

// Validate an ALREADY-STRUCTURED entry (the GET/storage shape): every field
// through the same rules the string grammar enforces, prefix uppercased, so a
// structured entry and its string form are interchangeable on the wire.
function normalizeStructuredEntry(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const { project, prefix, tracker } = entry;
  if (!isValidIssueLinkProject(project)) return null;
  if (!isValidIssueLinkPrefix(prefix)) return null;
  if (!isValidIssueLinkTracker(tracker)) return null;
  return { project, prefix: prefix.toUpperCase(), tracker: tracker.replace(/\/+$/, '') };
}

// Sanitize a `issueLinkTrackers` candidate (the PUT guard + load-time hygiene).
//
// Returns null for a non-array (→ the caller leaves the stored value untouched,
// the sanitizeWatchPatterns contract); otherwise the sanitized array — bad
// entries DROPPED (never fail the whole save for one typo'd line), deduped by
// project (first occurrence wins — one mapping per project; a later duplicate
// is the human changing their mind mid-list and the first statement is kept,
// mirroring sanitizeWatchPatterns' dedupe-by-id), capped at
// ISSUE_LINK_TRACKER_MAX_COUNT.
//
// @param {unknown} raw
// @returns {{project: string, prefix: string, tracker: string}[]|null}
export function sanitizeIssueLinkTrackers(raw) {
  if (!Array.isArray(raw)) return null;
  const seen = new Set();
  const out = [];
  for (const entry of raw) {
    if (out.length >= ISSUE_LINK_TRACKER_MAX_COUNT) break; // cap payload size
    // String form (human-stated) and structured form (GET round-trip /
    // hand-edited config.json) are both admitted; the structured form is what
    // is STORED, so the wire shape is one thing, not two.
    const cleaned = typeof entry === 'string'
      ? parseIssueLinkEntry(entry)
      : normalizeStructuredEntry(entry);
    if (!cleaned) continue;
    if (seen.has(cleaned.project)) continue;
    seen.add(cleaned.project);
    out.push(cleaned);
  }
  return out;
}
