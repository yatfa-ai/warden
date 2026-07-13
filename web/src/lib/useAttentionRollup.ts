// useAttentionRollup — the live, visibility-gated data source for the header
// AttentionBadge (WARDEN-228), extended in WARDEN-344 to also poll each open pane's
// CLASSIFIED STATE (stuck / erroring / waiting / blocked) so an agent actively
// emitting a loop / stack trace / "press enter" prompt no longer reads "Healthy".
//
// Three signals are folded into one AttentionRollup via the pure buildAttentionRollup:
//   - /api/health        (inactivity-based critical/warning)   — 10s cadence
//   - /api/activity/stats (recent directive/error event counts) — 10s cadence
//   - /api/agent-states   (per-open-pane classified state)      — 30s cadence  [NEW]
//
// The pane-state poll runs on a DEDICATED slower cadence (~30s, never the 10s health
// poll) and classifies ONLY the panes the human has open (passed as ?panes=), because
// it costs one batched capturePanes SSH round-trip. The Observer already batch-
// captures open panes every turn, so the SSH cost is already incurred during active
// use; this rides a slower beat. (WARDEN-344 scope item #5.)
//
// Why a standalone hook (not a shared /api/health context with HealthDashboard):
// the health side panel is collapsed by default, so the badge is the ONLY always-on
// health consumer. Duplicate /api/health polling only happens while the user has
// deliberately expanded HealthDashboard — an acceptable trade for a cheap local
// endpoint every 10s, and far smaller risk than refactoring HealthDashboard onto a
// shared context. See WARDEN-228 impl notes ("standalone hook is acceptable").
import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
  buildAttentionRollup,
  type AttentionRollup,
  type AttentionRollupOptions,
} from '@/lib/attentionRollup';
import {
  shouldFireAlert,
  fireAttentionNotification,
  applySeverityPrefs,
  ATTENTION_SEVERITY_DEFAULTS,
  type AttentionSeverityPrefs,
} from '@/lib/desktopAlerts';
import type { HealthData, ActivityStats, AgentStateRow, AgentStatesData } from '@/lib/types';

// Recent-error / recent-directive window. ActivityStats counts raw events in the
// queried window — there is NO server-side "unresolved"/"pending" flag — so a
// bounded recent window is the proxy for "needs your eye". 15 min is a glanceable
// "what just happened" horizon that doesn't grow unbounded over a long session.
// (The "While you were away" startup banner keeps its own since-last-close window;
// this is the live, always-on rollup, so it uses a fixed rolling window instead.)
export const ATTENTION_RECENT_WINDOW_MS = 15 * 60 * 1000;

// Health + activity stay on HealthDashboard's 10s cadence. Pane-state classification
// runs capturePanes (a batched SSH round-trip), so it gets a DEDICATED slower cadence.
const HEALTH_POLL_MS = 10_000;
const AGENT_STATE_POLL_MS = 30_000;

// A stable empty array default for `mutedAlertKeys` so the memoized Set and the
// effect dep list stay reference-stable when no caller passes a mute set.
const EMPTY_MUTED_KEYS: readonly string[] = [];

export interface AttentionRollupState {
  rollup: AttentionRollup;
  /** True only during the very first fetch (before any data has arrived). */
  loading: boolean;
}

export function useAttentionRollup(
  attentionDesktopAlerts = false,
  openPanes: string[] = [],
  enabledStates?: AttentionRollupOptions['enabledStates'],
  severityPrefs: AttentionSeverityPrefs = ATTENTION_SEVERITY_DEFAULTS,
  mutedAlertKeys: readonly string[] = EMPTY_MUTED_KEYS,
): AttentionRollupState {
  const [health, setHealth] = useState<HealthData | null>(null);
  const [stats, setStats] = useState<ActivityStats | null>(null);
  const [agentStates, setAgentStates] = useState<AgentStateRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [agentStatesLoaded, setAgentStatesLoaded] = useState(false);
  // The previous ROUTABLE sub-rollup (severity + per-agent-mute filtered), for the
  // desktop-alert increase detector below. Tracked in a ref (not state) so updating
  // it never triggers a re-render. We compare the FILTERED view — not the raw rollup
  // — so an increase in ONLY a disabled/muted bucket (raw total up, routable total
  // unchanged) does NOT fire (WARDEN-364). With defaults (every bucket on, no mutes)
  // the routable view is content-identical to the raw view, so this is behavior-
  // preserving. (WARDEN-344 tracked the raw rollup here; WARDEN-364 reroutes the
  // comparison through the filtered view while keeping the baseline-priming guard.)
  const prevRoutableRef = useRef<AttentionRollup | null>(null);
  // Whether the first real rollup has been observed (the desktop-alert baseline).
  const primedRef = useRef(false);
  // Memoize the mute set so its reference is stable across renders unless the
  // underlying muted-key array actually changes — keeping the gate effect's dep
  // list quiet on unrelated re-renders (popover open/close, etc.).
  const mutedSet = useMemo(() => new Set(mutedAlertKeys), [mutedAlertKeys]);

  // Refs so the interval closures read the LIVE open-panes set without the interval
  // being rebuilt on every openPanes change (which would reset the 10s health cadence).
  const openPanesRef = useRef(openPanes);
  openPanesRef.current = openPanes;

  const fetchHealthStats = useCallback(async () => {
    const after = new Date(Date.now() - ATTENTION_RECENT_WINDOW_MS).toISOString();
    // allSettled: a health OR stats failure must not blank the other half of the
    // rollup, and must not crash the badge. A failed half degrades to null and the
    // last good data for the other half is preserved (state isn't cleared on failure).
    const [healthRes, statsRes] = await Promise.allSettled([
      fetch('/api/health').then((r) => (r.ok ? (r.json() as Promise<HealthData>) : Promise.reject(new Error(`health ${r.status}`)))),
      fetch(`/api/activity/stats?after=${encodeURIComponent(after)}`).then((r) => (r.ok ? (r.json() as Promise<ActivityStats>) : Promise.reject(new Error(`stats ${r.status}`)))),
    ]);
    setHealth(healthRes.status === 'fulfilled' ? healthRes.value : null);
    setStats(statsRes.status === 'fulfilled' ? statsRes.value : null);
    setLoading(false);
  }, []);

  const fetchAgentStates = useCallback(async () => {
    const panes = openPanesRef.current;
    if (!panes.length) { setAgentStates([]); setAgentStatesLoaded(true); return; }
    try {
      const res = await fetch(`/api/agent-states?panes=${encodeURIComponent(panes.join(','))}`);
      if (!res.ok) { setAgentStatesLoaded(true); return; }
      const data = (await res.json()) as AgentStatesData;
      setAgentStates(Array.isArray(data?.agents) ? data.agents : []);
    } catch {
      // A failed state poll must not blank the other halves or crash the badge.
    }
    setAgentStatesLoaded(true);
  }, []);

  // Health + stats on the 10s cadence (unchanged from WARDEN-228).
  useEffect(() => {
    void fetchHealthStats();
    // Visibility-gated: a backgrounded tab never burns requests (matches the catalog
    // auto-refresh in App.tsx). On regaining focus we poll immediately because state
    // may be stale while hidden.
    //
    // EXCEPT when desktop alerts are opted in (WARDEN-259): then the poll MUST keep
    // running while hidden, otherwise the rollup would never update while the human
    // is away and the "fire on increase-while-hidden" alert would have no trigger.
    const tick = () => {
      if (attentionDesktopAlerts || document.visibilityState === 'visible') void fetchHealthStats();
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') void fetchHealthStats();
    };
    const intervalId = window.setInterval(tick, HEALTH_POLL_MS);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.clearInterval(intervalId);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [fetchHealthStats, attentionDesktopAlerts]);

  // Pane states on the dedicated ~30s cadence (WARDEN-344). Classifies ONLY open
  // panes; an empty open-panes set is a cheap no-op. Re-fires immediately when the
  // open-panes set changes so a freshly-opened stuck pane surfaces within a poll,
  // not after 30s. Same visibility relaxation as the health poll when alerts are on.
  useEffect(() => {
    void fetchAgentStates();
    const tick = () => {
      if (attentionDesktopAlerts || document.visibilityState === 'visible') void fetchAgentStates();
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') void fetchAgentStates();
    };
    const intervalId = window.setInterval(tick, AGENT_STATE_POLL_MS);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.clearInterval(intervalId);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [fetchAgentStates, attentionDesktopAlerts, openPanes]);

  // Derive the rollup from the three signals + the per-state toggle. useMemo so a
  // toggle change re-aggregates without a refetch, and so the badge only re-renders
  // when something that affects the count actually changed.
  const rollup = useMemo(
    () => buildAttentionRollup(health, stats, agentStates, { enabledStates }),
    [health, stats, agentStates, enabledStates],
  );

  // Fire an OS desktop notification on a genuine rollup INCREASE while Warden is
  // unfocused (WARDEN-259). The always-on AttentionBadge already covers the in-app
  // case, so a desktop alert while looking at Warden is pure noise — hence the hidden
  // guard. shouldFireAlert returns true ONLY on a total increase, so a persistent
  // condition never repeats and a recovery never fires. prevRoutableRef always
  // advances (even when we don't fire) so the next comparison is against the last
  // ROUTABLE rollup, not a stale one. No-op entirely when the master toggle is off.
  //
  // WARDEN-364: the decision runs over the ROUTABLE sub-rollup (severity prefs +
  // per-agent mute applied), so an increase in only a disabled/muted bucket fires
  // nothing while still appearing in the in-app badge (which consumes the raw
  // rollup). The visibility-gate relaxation in the poll effects above stays keyed
  // on the MASTER toggle only — the sub-toggles never add polling.
  //
  // Baseline priming: the FIRST rollup observed after both initial fetches land
  // becomes the baseline (no fire) — so pre-existing attention at launch/reload does
  // not fire (the "While you were away" banner covers that), matching shouldFireAlert's
  // "either input missing → false". A pane that flips stuck/erroring/waiting AFTER
  // that raises total → fires.
  useEffect(() => {
    if (loading || !agentStatesLoaded) return;
    const routable = applySeverityPrefs(rollup, severityPrefs, mutedSet);
    if (!primedRef.current) {
      primedRef.current = true;
      prevRoutableRef.current = routable;
      return;
    }
    const prev = prevRoutableRef.current;
    prevRoutableRef.current = routable;
    if (!attentionDesktopAlerts) return;
    if (document.visibilityState === 'visible') return;
    if (shouldFireAlert(prev, routable)) {
      fireAttentionNotification(routable);
    }
  }, [rollup, attentionDesktopAlerts, loading, agentStatesLoaded, severityPrefs, mutedSet]);

  return { rollup, loading };
}
