// Pure frontend helpers for the token-spend budget (WARDEN-415) — the ALARM that
// completes the meter WARDEN-367 shipped. This module is the UI-side mirror of
// src/budget.js: it holds the TypeScript shape of the /api/budget response and
// the PURE formatting + debounce + progress helpers that BOTH the in-app toast
// (useTokenBudget) and the desktop channel (desktopAlerts.fireBudgetNotification)
// consume.
//
// Kept PURE + dependency-free (only erased `import type` below — none here) so
// web/tokenBudget.test.mjs can load it standalone via Vite's OXC transform and
// exercise the formula with plain objects, exactly as attentionRollup.test.mjs /
// desktopAlerts.test.mjs do. The debounce helper mirrors src/budget.js's
// shouldFireBudgetAlert on both sides — kept in sync so it is unit-testable in
// each runtime without coupling them.

// The heaviest window-active session — the specific runaway a per-session alarm
// points at. Identity (id + host) lets the UI deep-link to the offending row.
export interface BudgetTopOffender {
  id: string;
  host: string;
  cwd: string;
  summary: string;
  total: number;
}

// The /api/budget snapshot. Mirrors src/budget.js's computeBudgetState (with
// windowMs translated to windowHours for the UI). `enabled` reflects the master
// config switch; when false (or before the first sweep lands) every other field
// is zeroed so the progress surface + debounce run uniformly.
export interface BudgetState {
  enabled: boolean;
  threshold: number;
  perSessionThreshold: number;
  windowHours: number;
  /** Aggregate lifetime total of sessions active in the window. */
  fleetSpent: number;
  /** Count of sessions active in the window (rows the sum ran over). */
  sessionCount: number;
  fleetBreached: boolean;
  perSessionBreached: boolean;
  topOffender: BudgetTopOffender | null;
  /** True when EITHER threshold is breached — what the debounce keys on. */
  alerted: boolean;
  /** ms-since-epoch of the last sweep, or null before the first lands. */
  evaluatedAt: number | null;
}

export const EMPTY_BUDGET: BudgetState = {
  enabled: false,
  threshold: 0,
  perSessionThreshold: 0,
  windowHours: 0,
  fleetSpent: 0,
  sessionCount: 0,
  fleetBreached: false,
  perSessionBreached: false,
  topOffender: null,
  alerted: false,
  evaluatedAt: null,
};

// Pure: fire ONLY on the transition into an alerted state (!prev.alerted →
// next.alerted). The "debounced one-shot" — fires once per crossing, never while
// persistently over (no spam every poll), never on recovery, never on the first
// observation (baseline priming). Mirrors src/budget.js's shouldFireBudgetAlert.
export function shouldFireBudgetAlert(prev: BudgetState | null, next: BudgetState | null): boolean {
  if (!prev || !next) return false;
  return !prev.alerted && next.alerted;
}

// The delivery channel a budget breach should use, given the human's presence
// (tab visibility) and their opt-in to OS desktop alerts. The "no double fire"
// visibility split (WARDEN-415) — the two live channels are MUTUALLY EXCLUSIVE
// so a breach never fires both the sonner toast and the OS notification at the
// same instant:
//   - VISIBLE            → 'toast'    (the human is at Warden → in-app sonner only)
//   - HIDDEN + opted-in  → 'desktop'  (the human stepped away → OS notification)
//   - HIDDEN + not-opted → 'none'     (no channel now; useTokenBudget's focus-
//                                      regain catch-up surfaces the toast on return)
// A 'desktop'/'none' outcome leaves the in-app toast UN-shown, so the hook keeps
// its "toast shown for this breach" flag false and the catch-up fires the toast
// the moment the human returns — the at-Warden surfacing of the same crossing,
// not a repeat of one already toasted while visible. Pure + dependency-free so
// web/tokenBudget.test.mjs can pin the contract directly (mirrors
// shouldFireBudgetAlert's testability).
export type BudgetChannel = 'toast' | 'desktop' | 'none';
export function pickBudgetChannel(visible: boolean, optedInDesktop: boolean): BudgetChannel {
  if (visible) return 'toast';
  return optedInDesktop ? 'desktop' : 'none';
}

// Pure: spent/threshold as a 0..1 fraction, clamped for a progress-bar width.
// Returns 0 when there's no threshold (budget off / misconfigured) so the bar
// renders empty rather than dividing by zero. The RAW ratio (which can exceed 1)
// is NOT clamped by the caller's choice — surfaced separately via
// budgetOverPercent so "180% of budget" reads honestly instead of capping at 100.
export function budgetProgress(spent: number, threshold: number): number {
  if (!threshold || threshold <= 0 || !Number.isFinite(spent)) return 0;
  return Math.max(0, Math.min(1, spent / threshold));
}

// Pure: whole-percent of the budget consumed, UNclamped (can exceed 100). 0 when
// there is no threshold. Used for the "180% of budget" readout beside the bar.
export function budgetOverPercent(spent: number, threshold: number): number {
  if (!threshold || threshold <= 0 || !Number.isFinite(spent)) return 0;
  return Math.round((spent / threshold) * 100);
}

// The human label for a host in the offender line — '(local)' reads as "this
// machine" to match OpenChatBrowserPage's hostTagOf. Inline (no import) so this
// module stays runtime-import-free for the standalone test.
const THIS_MACHINE = '(local)';
export function offenderHostLabel(host: string): string {
  return host === THIS_MACHINE ? 'this machine' : host;
}

// Pure: the message shown in BOTH the desktop notification and the in-app toast
// (single source of truth for the wording — desktopAlerts.fireBudgetNotification
// and useTokenBudget's sonner toast both call this). Names the offending session
// when a single runaway crossed the per-session threshold; otherwise frames the
// breach as aggregate fleet drift. Token counts use formatTokens for compactness
// (imported by the caller, not here, to keep this module runtime-import-free —
// the caller passes a pre-formatted string via formatBudgetMessageWith).
export interface BudgetMessage {
  title: string;
  body: string;
}

// Build the title + body from a budget snapshot, given a token-formatter. The
// formatter is injected (rather than imported) so this pure module stays free of
// runtime imports — the caller passes formatTokens from @/lib/formatTokens.
export function formatBudgetMessageWith(
  b: BudgetState,
  fmt: (n: number | null | undefined) => string,
): BudgetMessage {
  const windowLabel = b.windowHours >= 24 ? `${Math.round(b.windowHours / 24)}d` : `${b.windowHours}h`;
  if (b.perSessionBreached && b.topOffender) {
    const where = offenderHostLabel(b.topOffender.host);
    const name = b.topOffender.summary || b.topOffender.cwd || b.topOffender.id;
    return {
      title: 'Token budget breached — possible runaway agent',
      body: `"${name}" (${where}) spent ${fmt(b.topOffender.total)} over ${windowLabel} — past the per-session limit of ${fmt(b.perSessionThreshold)}.`,
    };
  }
  if (b.fleetBreached) {
    return {
      title: 'Token budget breached',
      body: `Fleet spent ${fmt(b.fleetSpent)} over ${windowLabel} — past the limit of ${fmt(b.threshold)}.`,
    };
  }
  // Not breached — a defensive fallback. Callers gate on `alerted` before
  // showing, but the message still reads sensibly if reached.
  return {
    title: 'Token budget',
    body: `Fleet spent ${fmt(b.fleetSpent)} of ${fmt(b.threshold)} over ${windowLabel}.`,
  };
}
