// snooze — pure logic for the time-boxed attention-alert snooze (WARDEN-551).
//
// The shipped per-agent mute (WARDEN-364) is PERMANENT: once muted, an agent
// stays muted until a human manually un-mutes it — forget, and the agent goes
// silently stale (its later real need-for-attention is suppressed forever). A
// snooze closes that gap: deliberate TEMPORARY suppression that restores itself.
// An agent snoozed for "1 hour" / "until tomorrow" fires no desktop alert exactly
// like a permanent mute, but only until its expiry — after which suppression
// auto-rearms (the key drops from the active set on the next attention cadence
// tick, no manual un-mute). This is the time-boxed twin of the permanent mute.
//
// Extracted as PURE functions on purpose (mirrors attentionRollup.ts /
// agentSparkline.ts + their web/*.test.mjs): the expiry/rearm math is testable
// without jsdom, and both useAttentionRollup (the suppression decision) and
// AttentionBadge (the visual muted state) stay thin call sites instead of inline
// logic. Every function takes `now` (ms-since-epoch) as an explicit parameter so
// tests are deterministic and the call sites read the clock once per cadence.
//
// Default state is an EMPTY snooze map — byte-for-byte today's behavior, zero
// regression on the existing mute/alerts (WARDEN-551 success criterion #6).

/** chat key → expiry (ms-since-epoch). The persisted snooze set (UiState.snoozedAlertKeys). */
export type SnoozeMap = Record<string, number>;

/** A snooze duration the human can pick from the per-row bell menu. */
export type SnoozeDuration = '1h' | 'tomorrow';

/**
 * The two time-boxed snooze durations, with their menu/dialog labels. SHARED by
 * the per-row bell menu (AttentionBadge) and the bulk SnoozeDialog (WARDEN-581)
 * so the durations + wording stay identical across the two entry points — one
 * snooze-duration vocabulary, two surfaces. Permanent mute is deliberately NOT a
 * member: it is a separate, stronger commitment (the bulk surface is snooze-only
 * per WARDEN-581's out-of-scope), and the per-row menu layers it on separately.
 */
export const SNOOZE_DURATION_OPTIONS: ReadonlyArray<{ value: SnoozeDuration; label: string }> = [
  { value: '1h', label: 'Mute for 1 hour' },
  { value: 'tomorrow', label: 'Mute until tomorrow' },
];

/**
 * The unified mute/snooze intent a row can be put into. `off` clears BOTH a
 * permanent mute and a snooze for the key (manual re-arm). `permanent` is the
 * WARDEN-364 permanent mute. `1h` / `tomorrow` are time-boxed snoozes. An agent
 * is in exactly ONE of these states per key — App's setter clears one when
 * setting another, so a permanent mute and a snooze never overlap on a key.
 */
export type AlertMuteMode = 'off' | 'permanent' | SnoozeDuration;

/**
 * The set of chat keys whose snooze is STILL ACTIVE at `now` (i.e. not yet
 * expired). A key is active iff `now < expiresAt`; the boundary `now ===
 * expiresAt` is treated as EXPIRED (the alert is free to fire again at the exact
 * expiry instant — a strict `<` keeps the suppression window closed-open, so a
 * 1h snooze set at 12:00 suppresses through 12:59:59.999 and re-arms at 13:00).
 * Entries with a non-finite / non-number expiry are dropped (defensive — the
 * load-time sanitizer already strips these, but the pure helper is robust to a
 * hand-built map too). This is what useAttentionRollup unions into the mute set
 * for the suppression decision; because the rollup recomputes on its cadence
 * reading `now` fresh each tick, an expired snooze naturally drops out here →
 * alerts resume without a manual un-mute (the core auto-rearm value).
 */
export function activeSnoozedKeys(snoozed: SnoozeMap, now: number): Set<string> {
  const out = new Set<string>();
  for (const [key, expiresAt] of Object.entries(snoozed)) {
    if (typeof expiresAt === 'number' && Number.isFinite(expiresAt) && now < expiresAt) {
      out.add(key);
    }
  }
  return out;
}

/**
 * Whether a single chat key's desktop alert is suppressed at `now` — TRUE for a
 * permanent mute OR an active snooze. This is the per-row decision the badge uses
 * to render the muted visual (line-through + BellOff) and that useAttentionRollup
 * mirrors (via the unioned set) to gate the OS notification. Pure composition of
 * the permanent-mute set + the snooze map; kept here so the "what counts as
 * suppressed" rule has one source of truth shared by the badge and the rollup.
 */
export function isSuppressed(
  key: string,
  mutedSet: ReadonlySet<string>,
  snoozed: SnoozeMap,
  now: number,
): boolean {
  if (mutedSet.has(key)) return true;
  const expiresAt = snoozed[key];
  return typeof expiresAt === 'number' && Number.isFinite(expiresAt) && now < expiresAt;
}

/**
 * Return a snooze map with every EXPIRED entry removed (those with a non-finite
 * expiry or `expiresAt <= now`). Used by App's prune effect (on mount + cadence)
 * so the persisted map + the badge visual stay clean: an entry that expired
 * while Warden was closed is dropped on the very next mount, and one that
 * expires mid-session is dropped within the prune cadence. Returns the SAME
 * reference when nothing changed (so a `setState(pruneExpired(...))` is a no-op
 * for React when no snooze has expired — no spurious re-render / persist), and a
 * fresh object only when at least one entry was pruned.
 */
export function pruneExpired(snoozed: SnoozeMap, now: number): SnoozeMap {
  let pruned = false;
  const out: SnoozeMap = {};
  for (const [key, expiresAt] of Object.entries(snoozed)) {
    if (typeof expiresAt === 'number' && Number.isFinite(expiresAt) && expiresAt > now) {
      out[key] = expiresAt;
    } else {
      pruned = true;
    }
  }
  return pruned ? out : snoozed;
}

/**
 * Return a snooze map without `key`, or the SAME reference when `key` was absent
 * (so a setState call that changes nothing is a React no-op — no spurious
 * re-render / persist). Used by App's setAlertMute to clear a snooze when setting
 * a permanent mute (and when resuming), keeping the two channels mutually exclusive
 * per key. Sibling of pruneExpired's stable-ref-when-unchanged discipline.
 */
export function withoutSnoozeKey(snoozed: SnoozeMap, key: string): SnoozeMap {
  if (!(key in snoozed)) return snoozed;
  const next: SnoozeMap = { ...snoozed };
  delete next[key];
  return next;
}

/**
 * Compute the expiry timestamp (ms-since-epoch) for a snooze `duration` set at
 * `now`. `1h` → exactly one hour later; `tomorrow` → the NEXT local midnight
 * (00:00) after `now`, so "mute until tomorrow" means alerts resume at the start
 * of the human's next local day. `setHours(24, 0, 0, 0)` rolls a Date forward to
 * the following midnight in the host's local timezone — the intended "tomorrow"
 * semantics (a DST boundary may shift this by an hour, an acceptable edge for a
 * coarse "until tomorrow" window). Pure: takes `now`, returns a number; the call
 * site reads the clock once at click time.
 */
export function snoozeExpiry(duration: SnoozeDuration, now: number): number {
  if (duration === '1h') return now + 60 * 60 * 1000;
  // 'tomorrow' — next local midnight.
  const d = new Date(now);
  d.setHours(24, 0, 0, 0);
  return d.getTime();
}

/**
 * Apply a time-boxed snooze of `duration` to EVERY key in `keys` at once — the
 * bulk setter backing App's multi-select Snooze (WARDEN-581), so N selected
 * agents snooze in a SINGLE state update (one write, one persist) instead of N
 * per-key `setAlertMute` fan-outs. Each selected key is mapped to
 * `snoozeExpiry(duration, now)` computed once (so every selected key shares the
 * same expiry base — the "one update" framing). Keys NOT in `keys` are preserved
 * untouched (a group snooze never disturbs another agent's existing snooze).
 *
 * Idempotent for already-snoozed keys: re-snoozing a key simply overwrites its
 * expiry with a fresh window — a refresh, never an error, never a duplicate
 * entry (a `Record` key is unique by construction). Returns the SAME reference
 * when `keys` is empty so a no-op bulk snooze causes no re-render or persist,
 * else a fresh object. Pure: takes `now`, returns a map. (The caller — App's
 * `snoozeMany` — separately drops any selected key from the PERMANENT-mute set
 * so the two channels stay mutually exclusive per key, mirroring `setAlertMute`.)
 */
export function snoozeManyKeys(
  snoozed: SnoozeMap,
  keys: readonly string[],
  duration: SnoozeDuration,
  now: number,
): SnoozeMap {
  if (keys.length === 0) return snoozed;
  const out: SnoozeMap = { ...snoozed };
  const expiresAt = snoozeExpiry(duration, now);
  for (const key of keys) out[key] = expiresAt;
  return out;
}

/**
 * A short, human-readable remaining-time label for a snooze shown in the badge's
 * per-row menu ("Snoozed — resumes in 42m"). Returns '' once expired (<= 0 ms
 * left) so the call site can hide the countdown. Granularity is minutes: "<1m"
 * for the final minute, "Nm" under an hour, "Hh Mm" (or "Hh" on the hour) beyond.
 * Bounded to whole minutes because the prune cadence (60s) and the badge's
 * re-render cadence are both coarse — a seconds-precision countdown would imply
 * a precision the UI does not actually refresh at. Pure: takes `expiresAt` + `now`.
 */
export function formatSnoozeRemaining(expiresAt: number, now: number): string {
  const ms = expiresAt - now;
  if (ms <= 0) return '';
  const totalMin = Math.floor(ms / 60000);
  if (totalMin < 1) return '<1m';
  if (totalMin < 60) return `${totalMin}m`;
  const hours = Math.floor(totalMin / 60);
  const mins = totalMin % 60;
  return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
}
