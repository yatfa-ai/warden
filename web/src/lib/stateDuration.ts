// stateDuration — pure logic for "how long has each agent been in its current
// attention state?" (WARDEN-587).
//
// The header AttentionBadge already shows WHICH agents need attention (stuck /
// erroring / waiting / blocked / done), but a returning rare-visitor human cannot
// tell an agent stuck for 90s from one stuck for 4h — they render identically. This
// adds the missing TIME dimension: a live, monotonically increasing duration on each
// row ("stuck 2h 14m", "waiting 47m", "finished 3m ago") so the human can triage the
// LANGUISHING agents from the just-flipped ones.
//
// The transition is already detected client-side in useAttentionRollup (the
// fetchAgentStates open-pane loop compares each key's prior state to its current
// state). This module only formats + classifies the per-key enteredAt timestamp that
// loop now stamps; it adds zero SSH, zero backend, zero new polling.
//
// Extracted as PURE functions on purpose (mirrors snooze.ts / whatsNew.ts +
// their web/*.test.mjs): the duration + languishing math is testable without jsdom,
// and AttentionBadge (the suffix) + useAttentionRollup (the stamp) stay thin call
// sites. Every pure function takes `now` (ms-since-epoch) as an explicit parameter so
// tests are deterministic and the call sites read the clock once per cadence.
//
// The localStorage I/O for the persisted {key → enteredAt} map lives here too,
// mirroring the whatsNew.ts per-chat lastSeen pattern (getLastSeen / stampLastSeen) so
// a human who restarts Warden after lunch still reads "stuck 3h", not "stuck 0s".

// ─── Languishing tone thresholds ────────────────────────────────────────────
//
// The duration SUFFIX escalates in tone the longer an agent has been stuck, so a
// glance picks out the languishing rows. The TEXT itself always carries the signal
// (the count "2h 14m" is readable on its own); color is supplementary only — never
// the sole cue (WCAG 1.4.1, the codebase's stated discipline per WARDEN-178). These
// are sensible defaults; user-configurable thresholds are out of scope (the ticket
// ships defaults first).
//
//   fresh  (< 15m): muted — a recent flip, probably still resolving
//   amber  (15m–1h): the agent has been waiting long enough to notice
//   red    (> 1h):   languishing — the row a returning human most needs to act on
export const LANGUISHING_AMBER_MS = 15 * 60 * 1000;
export const LANGUISHING_RED_MS = 60 * 60 * 1000;

// localStorage key for the persisted {agentKey → enteredAt(ms)} map. A SINGLE JSON
// map (not per-key, unlike whatsNew's per-chat `warden:lastSeen:<chatId>`) because
// the badge needs the WHOLE map hydrated at once on mount — one read + JSON.parse
// beats enumerating N per-key entries. The values are the same epoch-ms shape
// `warden:lastClose` / `stampLastSeen` write, and the I/O helpers below share their
// console.warn-on-failure discipline (a quota/serialize blip never crashes the badge).
export const STATE_ENTERED_AT_KEY = 'warden:stateEnteredAt';

/** The languishing tone for a duration suffix — drives the color (supplementary). */
export type StateDurationTone = 'fresh' | 'amber' | 'red';

/**
 * A compact relative-duration label for how long an agent has been in its current
 * attention state (WARDEN-587). Direct sibling of `formatSnoozeRemaining` (snooze.ts):
 * same minute granularity (the rollup's coarse ~10s render / 30s poll cadence makes
 * seconds-precision false precision), extended to DAYS (an agent can languish for
 * days) and with the sub-minute window SUPPRESSED.
 *
 * Why sub-minute is suppressed (returns ''): the FIRST observation of a key stamps
 * `enteredAt = now` as a baseline, so its initial duration is ~0s. Rendering "0s"
 * (or even "<1m") the instant a state is first seen implies a precision the UI does
 * not have — an agent that was ALREADY stuck when Warden launched would read "stuck
 * <1m", falsely implying it just flipped. Hiding the suffix under a minute honors the
 * ticket's "first poll → show NO duration, never 0s" edge case. Once a state has held
 * for ≥1m the label appears and grows monotonically ("1m" → "47m" → "2h 14m" → "3d"),
 * which is exactly the languishing-vs-just-flipped signal a returning human needs.
 *
 * Returns '' for a missing/non-finite `enteredAt` (a row never stamped — e.g. a
 * health-bucket Chat that has no pane state, or a row observed before any transition)
 * and for a future `enteredAt` (clock skew), so the caller renders no suffix at all
 * rather than a nonsensical value. Pure: takes `enteredAt` + `now`.
 *
 * `opts.subMinute` overrides the sub-minute '' return — used ONLY by the "Finished" (ago)
 * tense, where the stamp is a real completion event and recency IS the signal (the
 * section is a transient 3-min window, so the first minute is the MOST relevant readout,
 * not noise). The ongoing tense passes nothing, preserving the "first poll → no suffix,
 * never 0s" false-precision guard.
 */
export function formatStateDuration(
  enteredAt: number | null | undefined,
  now: number,
  opts?: { subMinute?: string },
): string {
  if (typeof enteredAt !== 'number' || !Number.isFinite(enteredAt)) return '';
  const ms = now - enteredAt;
  if (ms < 0) return ''; // future enteredAt (clock skew) — never a suffix, even with opts.subMinute
  if (ms < 60_000) return opts?.subMinute ?? ''; // sub-minute: suppressed (first-poll / just-flipped < 1m) unless a label is provided
  const totalMin = Math.floor(ms / 60000);
  if (totalMin < 60) return `${totalMin}m`;
  const totalHours = Math.floor(totalMin / 60);
  const mins = totalMin % 60;
  if (totalHours < 24) return mins > 0 ? `${totalHours}h ${mins}m` : `${totalHours}h`;
  const totalDays = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  return hours > 0 ? `${totalDays}d ${hours}h` : `${totalDays}d`;
}

/**
 * The verbose, screen-reader-friendly form of the same duration — for the row's
 * title/aria ("stuck for 2 hours 14 minutes"). Mirrors `formatStateDuration` exactly
 * (same thresholds, same sub-minute suppression) so the compact label and the
 * verbose tooltip never disagree. Singular/plural is exact per unit. Pure.
 *
 * Returns '' alongside the compact form when there is no duration to show, so the
 * caller omits the title/aria entirely on those rows (no empty tooltip).
 */
export function formatStateDurationVerbose(enteredAt: number | null | undefined, now: number): string {
  if (typeof enteredAt !== 'number' || !Number.isFinite(enteredAt)) return '';
  const ms = now - enteredAt;
  if (ms < 60_000) return '';
  const totalMin = Math.floor(ms / 60000);
  if (totalMin < 60) return `${totalMin} minute${totalMin === 1 ? '' : 's'}`;
  const totalHours = Math.floor(totalMin / 60);
  const mins = totalMin % 60;
  if (totalHours < 24) {
    const h = `${totalHours} hour${totalHours === 1 ? '' : 's'}`;
    return mins > 0 ? `${h} ${mins} minute${mins === 1 ? '' : 's'}` : h;
  }
  const totalDays = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  const d = `${totalDays} day${totalDays === 1 ? '' : 's'}`;
  return hours > 0 ? `${d} ${hours} hour${hours === 1 ? '' : 's'}` : d;
}

/**
 * The languishing tone for an `enteredAt` at `now` — drives the supplementary color of
 * the duration suffix (muted → amber → red). The duration TEXT always carries the
 * primary signal (WCAG 1.4.1); this only adds the glanceable escalation. Returns
 * 'fresh' (muted) for a missing/non-finite `enteredAt` so an unstamped row never
 * accidentally reads as languishing. Pure.
 */
export function languishingTone(enteredAt: number | null | undefined, now: number): StateDurationTone {
  if (typeof enteredAt !== 'number' || !Number.isFinite(enteredAt)) return 'fresh';
  const ms = now - enteredAt;
  if (ms < LANGUISHING_AMBER_MS) return 'fresh';
  if (ms < LANGUISHING_RED_MS) return 'amber';
  return 'red';
}

/**
 * The pure decision behind the stamp loop in useAttentionRollup: given a key's PRIOR
 * state (`prev`, or null when first observed this session), its CURRENT state (`cur`),
 * whether it already has a stamp, and the clock, return the stamp to record — or `null`
 * to KEEP the existing stamp (no write). Extracted so the stamp-on-transition /
 * reset-on-change rule is unit-tested directly (without a React runner), mirroring how
 * snooze.ts extracted its decision logic.
 *
 *   prev === null (first obs):  no existing stamp → `now` (baseline); existing stamp
 *                               (persisted across restart, or set in a prior poll) →
 *                               KEEP (a restart must not reset a real duration to 0).
 *   prev !== cur (transition):  `now` (RESET — the agent entered a new state; the
 *                               duration of the old state is no longer relevant).
 *   prev === cur (unchanged):   KEEP (the state held → the duration keeps growing).
 *
 * Pure: takes the inputs, returns a number (stamp) or null (keep).
 */
export function computeEnteredAt(
  prev: string | null,
  cur: string,
  hasStamp: boolean,
  now: number,
): number | null {
  if (prev === null) return hasStamp ? null : now;
  return prev !== cur ? now : null;
}

/**
 * Sort a rollup bucket's rows so the OLDEST `enteredAt` (longest-held state) comes
 * FIRST — the row a returning human most needs to act on is the one at the top of its
 * section (WARDEN-587 success criterion #3). A row with no stamp (`undefined`) sorts
 * LAST (it is treated as age `Infinity`, so a freshly-observed row never leapfrogs a
 * languishing one). Section SEVERITY ordering (red before amber) is unchanged — this
 * only reorders WITHIN a section.
 *
 * NaN-safe: when two rows tie (both unstamped → both `Infinity`, OR the same finite
 * stamp) the comparator returns 0 so the stable sort preserves input order — never
 * `Infinity - Infinity = NaN`, which would give `Array#sort` undefined ordering.
 * Generic over `{ enteredAt? }` so it applies to any rollup bucket. Pure: returns a
 * new sorted array, does not mutate the input.
 */
export function sortOldestEnteredAtFirst<T extends { enteredAt?: number }>(rows: readonly T[]): T[] {
  return rows.slice().sort((a, b) => {
    const ai = a.enteredAt ?? Infinity;
    const bi = b.enteredAt ?? Infinity;
    if (ai === bi) return 0;
    return ai - bi;
  });
}

// ─── Persistence (mirrors whatsNew.ts getLastSeen / stampLastSeen) ──────────

/**
 * Read the persisted {agentKey → enteredAt(ms)} map from localStorage. Returns a fresh
 * empty object when storage is unavailable, the key is absent, or the payload is
 * corrupt — never throws (a bad value is ignored, not fatal: WARDEN-89 discipline).
 * Sanitizes each entry: only finite, positive epoch-ms values survive, so a stale or
 * hand-corrupted entry can't produce a nonsense duration ("stuck -5m"). Used on mount
 * to hydrate the stamp map so a restart preserves durations.
 */
export function loadStateEnteredAt(): Record<string, number> {
  if (typeof localStorage === 'undefined') return {};
  try {
    const raw = localStorage.getItem(STATE_ENTERED_AT_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'number' && Number.isFinite(v) && v > 0) out[k] = v;
    }
    return out;
  } catch (e) {
    console.warn('[warden:stateDuration] loadStateEnteredAt failed', e);
    return {};
  }
}

/**
 * Persist the {agentKey → enteredAt(ms)} map to localStorage as one JSON blob. Called
 * by useAttentionRollup whenever the stamp map changes (a transition or a prune), so a
 * restart hydrates the same durations. Never throws — a quota/serialize failure is
 * console.warn'd (matching `stampLastSeen` / `saveUi`), so a full localStorage never
 * crashes the badge; the worst case is durations reset on next restart.
 */
export function saveStateEnteredAt(map: Record<string, number>): void {
  try {
    localStorage.setItem(STATE_ENTERED_AT_KEY, JSON.stringify(map));
  } catch (e) {
    console.warn('[warden:stateDuration] saveStateEnteredAt failed', e);
  }
}
