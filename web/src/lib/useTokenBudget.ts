// useTokenBudget — the live data source + DEBOUNCED one-shot alarm for the
// token-spend budget (WARDEN-415).
//
// Polls /api/budget on a slow cadence (~120s, matching the backend accumulator
// in src/server.js — which itself reuses the existing per-session token fetch on
// the same beat). /api/budget is a cheap cache read (no SSH), so this poll is
// light even when the budget is disabled. On a genuine crossing into an alerted
// state (shouldFireBudgetAlert) it fires ONCE:
//   - an in-app sonner toast (the "beautiful notification" surface) with a
//     "View sessions" action that deep-links to the All Sessions usage view, AND
//   - an OS desktop notification (the "while the founder is away" channel) when
//     the human opted into desktop alerts (attentionDesktopAlerts).
//
// Delivery rules (mirrors useAttentionRollup's away/at-Warden split so there is
// never a double fire):
//   - toast fires when Warden is VISIBLE (the human is here);
//   - desktop fires when HIDDEN + opted-in (the human stepped away);
//   - a breach that happened WHILE AWAY is caught up as a toast on focus-regain
//     (so the founder learns about it the moment they return), re-arming only
//     after the budget recovers.
//
// The desktop master toggle (attentionDesktopAlerts) gates the OS notification —
// the same opt-in the attention alerts respect. The budget's own master switch
// (config.tokenBudgetEnabled) gates whether /api/budget reports an alerted state
// at all; when off, this hook never fires.
import { useState, useEffect, useRef } from 'react';
import { toast } from 'sonner';
import {
  type BudgetState,
  EMPTY_BUDGET,
  shouldFireBudgetAlert,
  formatBudgetMessageWith,
} from '@/lib/tokenBudget';
import { fireBudgetNotification } from '@/lib/desktopAlerts';
import { formatTokens } from '@/lib/formatTokens';

// Match the backend accumulator's beat. The endpoint is a cheap cache read, so
// this stays light; aligning to BUDGET_INTERVAL_MS means a poll lands soon after
// each backend sweep rather than racing it.
const BUDGET_POLL_MS = 120_000;

export interface UseTokenBudgetArgs {
  /** Master opt-in for OS desktop alerts (same toggle the attention alerts use). */
  attentionDesktopAlerts?: boolean;
  /** Deep-link: open the All Sessions usage view (the offending session floats top). */
  onOpenSessions?: () => void;
}

export interface UseTokenBudgetResult {
  budget: BudgetState;
  /** True only during the very first fetch (before any data has arrived). */
  loading: boolean;
}

export function useTokenBudget(
  { attentionDesktopAlerts = false, onOpenSessions }: UseTokenBudgetArgs = {},
): UseTokenBudgetResult {
  const [budget, setBudget] = useState<BudgetState>(EMPTY_BUDGET);
  const [loading, setLoading] = useState(true);

  // Live refs so the poll closure + visibility listener read current values
  // without rebuilding the interval (which would reset the cadence).
  const onOpenSessionsRef = useRef(onOpenSessions);
  onOpenSessionsRef.current = onOpenSessions;

  // --- Debounce state (refs — updating them never re-renders) ---
  // prevRef: the last observed snapshot, for the crossing detector.
  const prevRef = useRef<BudgetState | null>(null);
  // primedRef: false until the first real observation lands (baseline).
  const primedRef = useRef(false);
  // shownForBreachRef: whether the CURRENT alerted stretch has already been
  // surfaced (toast/desktop). Re-arms (false) only when the budget recovers, so
  // a persistent breach never repeats and a fresh breach after recovery fires.
  const shownForBreachRef = useRef(false);

  const deliver = (b: BudgetState) => {
    const { title, body } = formatBudgetMessageWith(b, formatTokens);
    const open = () => onOpenSessionsRef.current?.();
    // In-app toast: the visible-channel surface. Single one-shot per crossing.
    toast.warning(title, {
      description: body,
      duration: 12_000,
      action: { label: 'View sessions', onClick: open },
    });
    // Desktop: the away-channel surface. Only when opted in AND hidden, so a
    // human looking at Warden gets the toast alone (no double fire) and a human
    // who stepped away gets the OS notification.
    if (attentionDesktopAlerts && document.visibilityState === 'hidden') {
      fireBudgetNotification(title, body, open);
    }
  };

  const fetchBudget = async () => {
    try {
      const r = await fetch('/api/budget');
      if (!r.ok) return;
      const next = (await r.json()) as BudgetState;
      if (!next || typeof next !== 'object') return;
      setBudget(next);
      evaluate(next);
    } catch {
      // A failed poll must not crash the hook or blank the progress surface.
    } finally {
      // The first fetch lands the cache; afterwards the slow-cadence poll keeps
      // it fresh. Loading stays true only until that first response resolves.
      setLoading(false);
    }
  };

  // The debounce + delivery decision, split out so fetchBudget and the
  // focus-regain listener share one implementation.
  const evaluate = (next: BudgetState) => {
    const prev = prevRef.current;
    // Baseline priming: the FIRST observation seeds prev without firing — BUT a
    // pre-existing breach at launch/reload IS surfaced once (the human just
    // opened Warden and a runaway is already burning; they should learn now,
    // unlike the attention system whose "While you were away" banner covers it).
    if (!primedRef.current) {
      primedRef.current = true;
      if (next.alerted) deliver(next);
      shownForBreachRef.current = next.alerted;
      prevRef.current = next;
      return;
    }
    if (shouldFireBudgetAlert(prev, next)) {
      deliver(next);
      shownForBreachRef.current = true;
    }
    // Re-arm when recovered (both thresholds back under) so the next breach fires.
    if (!next.alerted) shownForBreachRef.current = false;
    prevRef.current = next;
  };

  // Slow-cadence poll + immediate seed. Runs regardless of `enabled` because
  // /api/budget is a cheap cache read and reports enabled:false when off — so a
  // mid-session enable (false→true crossing) is caught naturally without extra
  // plumbing. Visibility-gated: a backgrounded tab never burns polls UNLESS the
  // human opted into desktop alerts (then the away-alarm needs a live trigger,
  // mirroring useAttentionRollup).
  useEffect(() => {
    void fetchBudget();
    const tick = () => {
      if (attentionDesktopAlerts || document.visibilityState === 'visible') void fetchBudget();
    };
    const onVisibility = () => {
      if (document.visibilityState !== 'visible') return;
      // Catch-up: a breach that crossed while away surfaces as a toast the
      // moment the human returns (it would otherwise be silently one-shot past).
      const cur = prevRef.current;
      if (cur && cur.alerted && !shownForBreachRef.current) {
        deliver(cur);
        shownForBreachRef.current = true;
      }
      void fetchBudget();
    };
    const intervalId = window.setInterval(tick, BUDGET_POLL_MS);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.clearInterval(intervalId);
      document.removeEventListener('visibilitychange', onVisibility);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attentionDesktopAlerts]);

  return { budget, loading };
}
