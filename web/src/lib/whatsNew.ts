// Per-agent "What's new since you last looked" catch-up (WARDEN-356).
//
// WARDEN's rare-visitor human needs a one-glance answer to "what did THIS agent
// change since I was last here?" — per-agent, not fleet-wide. The only existing
// "since" concept is app-close-tied and aggregate (the "While you were away"
// banner in App.tsx, keyed off `warden:lastClose`). This module adds a PER-AGENT
// lastSeen timestamp (mirroring that exact localStorage pattern) plus the pure
// logic that turns the already-fetched git-log + git-status data into a
// since-filtered summary + a glanceable "unreviewed progress" signal.
//
// ZERO backend changes (acceptance criterion #4): every input is data the
// sidebar already fetches via the existing read-only endpoints —
//   • /api/git-log   → `commits` (recent history, `{ hash, subject, author, date }`)
//   • /api/git-status → `changedFileCount` (|files|) + `stashCount`
// The `since` filter is applied CLIENT-SIDE here, exactly as the ticket specifies
// ("filter the existing /api/git-log result by lastSeen client-side"). A server
// `since` param is the documented future optimization if client-side filtering of
// large logs ever proves slow — not needed for v1.
//
// Pure (no React import) so it is unit-testable directly via node, mirroring
// gitStateSummary.ts / agentFilter.ts (extracted "so it's testable without a
// React runner"). The only I/O is the localStorage getters/setters for lastSeen,
// which mirror loadUi/saveUi's localStorage discipline.

// localStorage key prefix, per chatId. Mirrors the fleet-wide `warden:lastClose`
// key (App.tsx) but scoped per-agent: `warden:lastSeen:<chatId>` → epoch-ms
// string (the same `String(Date.now())` shape `warden:lastClose` writes).
export const LAST_SEEN_PREFIX = 'warden:lastSeen:';

// A commit row from /api/git-log (matches sidebar/types.ts GitCommit). Defined
// locally rather than imported from the React-layer types so this helper stays
// decoupled and testable with plain objects — the same decoupling
// gitStateSummary.ts relies on. `date` is git's relative `%ar` string
// ("2 hours ago", "3 days ago", …) — NOT an epoch; parseRelativeDate converts it.
export interface WhatsNewCommit {
  hash: string;
  subject: string;
  author: string;
  date: string;
}

// Read the per-agent last-visit epoch (ms). Returns null when the agent was
// never visited (no key) or the stored value is corrupt/empty — never throws
// (WARDEN-89 discipline: a bad value is ignored, not fatal). Mirrors how
// App.tsx reads `warden:lastClose` as a bare `parseInt`.
export function getLastSeen(chatId: string): number | null {
  if (typeof localStorage === 'undefined') return null;
  const raw = localStorage.getItem(LAST_SEEN_PREFIX + chatId);
  if (!raw) return null;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// Stamp the per-agent last-visit epoch (ms). Writes the same `String(Date.now())`
// shape `warden:lastClose` writes on close. `now` is optional ONLY so tests can
// pin the clock; production callers omit it. Never throws — a quota/serialize
// failure is console.warn'd, matching saveUi. Returns the epoch written.
export function stampLastSeen(chatId: string, now: number = Date.now()): number {
  try {
    localStorage.setItem(LAST_SEEN_PREFIX + chatId, String(now));
  } catch (e) {
    console.warn('[warden:whatsNew] stampLastSeen failed', e);
  }
  return now;
}

// The duration of each relative-date unit git's %ar can emit, in milliseconds.
// A month is the 30.44-day average git uses; a year is 365.25 days. Kept as a
// table so the parser is one loop over unit names rather than a branch ladder.
const RELATIVE_UNIT_MS: Record<string, number> = {
  second: 1_000,
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
  week: 604_800_000,
  month: 2_629_800_000, // ~30.44 days (git's approximation)
  year: 31_557_600_000, // ~365.25 days
};

// Parse a git `%ar` relative-date string ("2 hours ago", "3 days ago",
// "1 year, 2 months ago", …) into an epoch-ms instant, relative to `now`.
// Returns null when the string carries no recognized unit — git's %ar is
// English/locale-dependent, and a future/odd locale string may not match; the
// caller treats null as "unknown age" and (per the "don't miss progress" rule)
// surfaces such commits rather than hiding them.
//
// Handles the singular+plural forms and git's compound "N years, M months ago".
// Each matched `(\d+) (unit)s?` contributes `now - count*unitMs`; multiple
// matches (the compound form) sum, so "1 year, 2 months ago" →
// now - 1*yearMs - 2*monthMs. Anchored on the trailing " ago" when present but
// also tolerates a bare "N units" (defensive — some git builds / forks differ).
export function parseRelativeDate(input: string, now: number): number | null {
  const s = (input ?? '').trim().toLowerCase();
  if (!s) return null;
  // Sum every "(\d+) unit(s)" occurrence in the string. global regex; each match
  // contributes its unit's ms. At least one match is required for a non-null
  // result — a string with no unit ("yesterday", a locale word) → null.
  const re = /(\d+)\s*(seconds?|minutes?|hours?|days?|weeks?|months?|years?)/g;
  let delta = 0;
  let matched = false;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    const count = parseInt(m[1], 10);
    // Singular/plural share a stem: peel a trailing 's' so "minute"/"minutes"
    // both map to the `minute` unit key.
    const unit = m[2].endsWith('s') ? m[2].slice(0, -1) : m[2];
    const ms = RELATIVE_UNIT_MS[unit];
    if (ms !== undefined && Number.isFinite(count)) {
      delta += count * ms;
      matched = true;
    }
  }
  return matched ? now - delta : null;
}

export interface WhatsNewInput {
  // Recent commits from /api/git-log (newest-first). Undefined = not yet fetched
  // (the summary then reports zero new commits — can't claim unseen progress
  // from data we don't have).
  commits?: WhatsNewCommit[];
  // The per-agent last-visit epoch (getLastSeen). 0 = never visited: the summary
  // still computes (for the popover) but hasUnreviewedProgress gates on null.
  since: number;
  // The current wall clock, used to resolve relative dates. Passed in (not read
  // via Date.now) so the function is pure and deterministic under test.
  now: number;
  // Current working-tree change count (|gitStatus.files|) — current state, NOT
  // since-filtered (the ticket's "Current working-tree changes"). Shown in the
  // summary line as context alongside the since-filtered commit count.
  changedFileCount?: number;
  // Current stash count (gitStatus.stashCount) — current state, shown as context.
  stashCount?: number | null;
}

export interface WhatsNewSummary {
  // Commits that landed since the last visit: either provably (parsed date >
  // since) or conservatively (a date git's %ar couldn't parse — treated as new
  // so potential progress is never silently hidden; the safe failure mode for a
  // "don't miss it" signal). Ordered as /api/git-log returns them (newest-first).
  newCommits: WhatsNewCommit[];
  // Current working-tree change count (unchanged from input; 0 when unknown).
  changedFileCount: number;
  // Current stash count (unchanged from input; 0 when unknown/null).
  stashCount: number;
}

// Turn the already-fetched git data into a since-filtered summary. Pure: given
// the same { commits, since, now, changedFileCount, stashCount } it always
// returns the same summary. The two judgment calls are (1) a commit counts as
// "new" iff the agent has been visited (since > 0) AND its date is either
// unparseable (conservative include) or parsed to AFTER since, and (2) an agent
// never visited (since === 0) has no "new since" — newCommits stays empty.
export function summarizeWhatsNew(input: WhatsNewInput): WhatsNewSummary {
  const commits = input.commits ?? [];
  const newCommits: WhatsNewCommit[] = [];
  for (const cm of commits) {
    if (input.since <= 0) continue; // never visited → nothing is "since"
    const epoch = parseRelativeDate(cm.date, input.now);
    if (epoch === null || epoch > input.since) {
      newCommits.push(cm);
    }
  }
  return {
    newCommits,
    changedFileCount: typeof input.changedFileCount === 'number' ? input.changedFileCount : 0,
    stashCount: typeof input.stashCount === 'number' && Number.isFinite(input.stashCount) ? input.stashCount : 0,
  };
}

// The one-glance summary line, e.g. "3 new commits · 7 changed files · 1 stash"
// (the ticket's example shape). Only the segments that are non-zero render, so a
// quiet agent shows "" rather than "0 new commits · 0 changed files · 0 stashes"
// — an empty string is the summary's "nothing new" signal (the marker is hidden
// separately by hasUnreviewedProgress). Pluralization is exact per segment.
export function formatWhatsNewLine(s: WhatsNewSummary): string {
  const parts: string[] = [];
  if (s.newCommits.length > 0) {
    parts.push(`${s.newCommits.length} new commit${s.newCommits.length === 1 ? '' : 's'}`);
  }
  if (s.changedFileCount > 0) {
    parts.push(`${s.changedFileCount} changed file${s.changedFileCount === 1 ? '' : 's'}`);
  }
  if (s.stashCount > 0) {
    parts.push(`${s.stashCount} stash${s.stashCount === 1 ? '' : 'es'}`);
  }
  return parts.join(' · ');
}

// Marker visibility: an agent has UNREVIEWED PROGRESS iff the human has visited
// it before (since !== null) AND commits have landed since that visit
// (summary.newCommits.length > 0 — which already folds in any unparseable-date
// commit conservatively). Current dirty/stash state is intentionally NOT part of
// this: that's the existing ± / 🗄 badge's job (current state), whereas THIS
// marker means "the agent shipped commits you haven't seen" (the clearest
// "workspace advanced" signal). Distinct from "stuck/erroring" (WARDEN-343, red)
// and "new terminal output" (cyan) — see WhatsNewMarker for the distinct indigo
// treatment.
export function hasUnreviewedProgress(since: number | null, summary: WhatsNewSummary): boolean {
  if (since === null) return false; // never visited → nothing is "since"
  return summary.newCommits.length > 0;
}
