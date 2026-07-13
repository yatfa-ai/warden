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
// ZERO NEW endpoints (acceptance criterion #4): every input is data the sidebar
// already fetches via the existing read-only endpoints —
//   • /api/git-log   → `commits` (recent history, `{ hash, subject, author, date, epoch }`)
//   • /api/git-status → `changedFileCount` (|files|) + `stashCount`
// The since-filter needs an EXACT timestamp to compare against lastSeen. The
// original v1 tried to do this with zero backend changes by parsing git's
// coarse relative `%ar` ("1 hour ago") — but %ar floors to a whole unit and
// DRIFTS as the commit ages, so an already-seen commit flips back to "new" an
// hour later (false-positive flicker — the WARDEN-356 review's blocker). The
// string has already lost the precision, so there is no correct client-side
// fix from %ar alone. The fix is a single one-field backend addition: `%ct`
// (committer date, UNIX seconds) appended to GIT_LOG_PRETTY (src/server.js),
// threaded through parseGitLogLine → GitCommit → WhatsNewCommit as `epoch`.
// This is the documented tension with "v1 = zero backend changes" — correctness
// wins, and the cost is one read-only field (still no mutating op). The since
// filter is then exact: `commit.epoch*1000 >= lastSeen`. A server `since` param
// remains the documented future optimization for very large logs — not needed now.
//
// Pure (no React import) so it is unit-testable directly via node, mirroring
// gitStateSummary.ts / agentFilter.ts (extracted "so it's testable without a
// React runner"). The only I/O is the localStorage getters/setters for lastSeen,
// which mirror loadUi/saveUi's localStorage discipline.

// localStorage key prefix, per chatId. Mirrors the fleet-wide `warden:lastClose`
// key (App.tsx) but scoped per-agent: `warden:lastSeen:<chatId>` → epoch-ms
// string (the same `String(Date.now())` shape `warden:lastClose` writes).
export const LAST_SEEN_PREFIX = 'warden:lastSeen:';

// How many recent commits the what's-new fetch asks /api/git-log for. The marker
// COUNTS commits newer than lastSeen, so the fetch must return enough to capture
// everything that landed since the last visit — a rare visitor gone days could
// have dozens. 50 matches the existing incoming/outgoing fetches
// (fetchGitLogIncoming/Outgoing), so a visited agent's recent-commits popover and
// its what's-new marker see the same window. If even 50 all-new commits come back
// (the fetch is capped server-side at 50), the summary reports `truncated` and the
// marker renders "✦50+" rather than silently understating progress — the
// WARDEN-356 review's "count capped at 5" fix.
export const WHATS_NEW_FETCH_LIMIT = 50;

// A commit row from /api/git-log (matches sidebar/types.ts GitCommit). Defined
// locally rather than imported from the React-layer types so this helper stays
// decoupled and testable with plain objects — the same decoupling
// gitStateSummary.ts relies on. `date` is git's relative `%ar` string
// ("2 hours ago") for DISPLAY in the popover. `epoch` is the EXACT committer
// timestamp (git %ct, UNIX SECONDS) the since-filter compares against — it's
// optional only so a stale pre-%ct cache entry degrades (treated as "can't prove
// it's new" → excluded, never a false positive). The filter never parses `date`.
export interface WhatsNewCommit {
  hash: string;
  subject: string;
  author: string;
  date: string;
  epoch?: number;
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
// English/locale-dependent, and a future/odd locale string may not match.
//
// RETAINED AS A UTILITY (WARDEN-356 review): the since-filter previously used
// this, but %ar floors to a whole unit and drifts as a commit ages — so an
// already-seen commit would flip back to "new" an hour later (false-positive
// flicker). The filter now compares the EXACT %ct epoch instead (see
// summarizeWhatsNew). This parser is kept (and tested) for any future caller
// that wants a best-effort parsed age from a relative string; it is NOT used by
// the new-since filter, and must not be — %ar has already lost the precision.
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
  // The per-agent last-visit epoch-ms (getLastSeen). 0 = never visited: the summary
  // still computes (for the popover) but hasUnreviewedProgress gates on null.
  since: number;
  // Current working-tree change count (|gitStatus.files|) — current state, NOT
  // since-filtered (the ticket's "Current working-tree changes"). Shown in the
  // summary line as context alongside the since-filtered commit count.
  changedFileCount?: number;
  // Current stash count (gitStatus.stashCount) — current state, shown as context.
  stashCount?: number | null;
  // The cap the caller fetched `commits` with (default WHATS_NEW_FETCH_LIMIT=50).
  // Used only to detect truncation — when every fetched commit is new AND we hit
  // this cap, there may be more new commits beyond it, so the summary reports
  // `truncated` and the marker renders "✦N+". Not used for the filter itself.
  fetchLimit?: number;
}

export interface WhatsNewSummary {
  // Commits that landed since the last visit: `commit.epoch*1000 >= since` using
  // the EXACT %ct epoch. Ordered as /api/git-log returns them (newest-first).
  // A commit whose epoch is missing (stale pre-%ct cache) is EXCLUDED — we can't
  // prove it's new, and the old "conservative include" rule is exactly what cried
  // wolf, so it's retired. The next fetch (seconds later) brings the epoch.
  newCommits: WhatsNewCommit[];
  // Current working-tree change count (unchanged from input; 0 when unknown).
  changedFileCount: number;
  // Current stash count (unchanged from input; 0 when unknown/null).
  stashCount: number;
  // True iff EVERY fetched commit is new AND the fetch hit its cap — meaning the
  // new-commits count may understate (more could exist beyond the cap). The
  // marker then renders "✦N+" and the summary line "N+ new commits" so progress
  // is never silently understated. False whenever the new/old boundary was found
  // within the fetched window (the count is then exact).
  truncated: boolean;
}

// Turn the already-fetched git data into a since-filtered summary. Pure: given
// the same { commits, since, changedFileCount, stashCount, fetchLimit } it always
// returns the same summary. The comparison is the EXACT %ct epoch vs lastSeen
// (both resolved to ms) — not git's coarse %ar, which drifts and mislabels. A
// commit counts as "new" iff the agent has been visited (since > 0) AND its
// epoch is present AND `epoch*1000 >= since` (>= so a commit landing the exact
// visit-second is surfaced, never dropped at the boundary). An agent never
// visited (since === 0) has no "new since" — newCommits stays empty.
export function summarizeWhatsNew(input: WhatsNewInput): WhatsNewSummary {
  const commits = input.commits ?? [];
  const fetchLimit = input.fetchLimit ?? WHATS_NEW_FETCH_LIMIT;
  const newCommits: WhatsNewCommit[] = [];
  for (const cm of commits) {
    if (input.since <= 0) continue; // never visited → nothing is "since"
    // epoch is %ct (seconds); since is ms. Compare in ms. Missing epoch → can't
    // prove new → skip (never a false positive; the old conservative-include is retired).
    if (typeof cm.epoch === 'number' && Number.isFinite(cm.epoch) && cm.epoch * 1000 >= input.since) {
      newCommits.push(cm);
    }
  }
  // Truncation: every fetched commit is new AND we hit the fetch cap → there may
  // be more beyond the window. When newCommits < commits.length, the new/old
  // boundary was found inside the window, so the count is exact (not truncated).
  const truncated =
    newCommits.length > 0 &&
    newCommits.length === commits.length &&
    commits.length >= fetchLimit;
  return {
    newCommits,
    changedFileCount: typeof input.changedFileCount === 'number' ? input.changedFileCount : 0,
    stashCount: typeof input.stashCount === 'number' && Number.isFinite(input.stashCount) ? input.stashCount : 0,
    truncated,
  };
}

// The one-glance summary line, e.g. "3 new commits · 7 changed files · 1 stash"
// (the ticket's example shape). Only the segments that are non-zero render, so a
// quiet agent shows "" rather than "0 new commits · 0 changed files · 0 stashes"
// — an empty string is the summary's "nothing new" signal (the marker is hidden
// separately by hasUnreviewedProgress). Pluralization is exact per segment. When
// `truncated` is set (the fetch hit its cap with all-new commits), the commit
// count renders "N+" so progress is never silently understated.
export function formatWhatsNewLine(s: WhatsNewSummary): string {
  const parts: string[] = [];
  if (s.newCommits.length > 0) {
    const n = s.newCommits.length;
    const suffix = s.truncated ? '+' : '';
    parts.push(`${n}${suffix} new commit${n === 1 && !s.truncated ? '' : 's'}`);
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
