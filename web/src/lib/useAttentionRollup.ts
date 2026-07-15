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
import { toast } from 'sonner';
import {
  buildAttentionRollup,
  type AttentionRollup,
  type AttentionRollupOptions,
} from '@/lib/attentionRollup';
import {
  shouldFireAlert,
  shouldFireWatch,
  fireAttentionNotification,
  fireWatchNotification,
  applySeverityPrefs,
  diffNewAttention,
  formatInAppEntry,
  ATTENTION_SEVERITY_DEFAULTS,
  type AttentionSeverityPrefs,
} from '@/lib/desktopAlerts';
import { diffWatchAlerts, indexByWatchKey } from '@/lib/chatWatch';
import { recordWatchMiss, shouldRecordMiss } from '@/lib/watchCatchup';
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

/**
 * Show the crafted in-app attention ping (WARDEN-402). Sibling of
 * fireAttentionNotification (the OS channel) for the AT-WARDEN case: instead of the
 * raw "N items need attention" OS toast — which is hard-gated to fire only while
 * Warden is UNFOCUSED — this renders a themed sonner toast, reason-specific and
 * one-click deep-linkable, for each genuinely NEW entrant that appeared WHILE the
 * human was looking at Warden. That closes the prior "visible → return" gap, which
 * left a watched chat newly needing them producing only the header badge silently
 * ticking up — exactly the "noise the human learns to ignore" the roadmap rejects.
 *
 * The entrants come from the pure diffNewAttention (so the ping names the SPECIFIC
 * chat/agent + its concrete reason, not a lumped count), and each NAMED entrant's
 * toast carries a one-click "Open" action that deep-links via App's openChat. A
 * stable per-key sonner `id` means a still-visible ping for the same chat updates
 * rather than stacking — the in-app analog of the OS channel's stable `tag`.
 *
 * Auto-dismisses (sonner's transience — the property the relaxed visible-gate's
 * noise-avoidance relied on): it fires ONCE per genuine new need (the increase-only
 * shouldFireAlert gate the caller already enforced) and then leaves, so it is NOT
 * the always-on repetition the visible→return gate existed to suppress. Aggregate
 * directives/errors entrants (no pane identity) surface with no deep-link — their
 * resolution path is the Activity tab, surfaced in the badge. Never throws.
 */
function fireAttentionInApp(
  prev: AttentionRollup,
  next: AttentionRollup,
  onOpenChat?: (id: string) => void,
): void {
  const entries = diffNewAttention(prev, next);
  for (const entry of entries) {
    const { title, description } = formatInAppEntry(entry);
    // Themed tone maps 1:1 to the badge's red/amber severity split (WARDEN-68): a
    // broken agent (critical/stuck/erroring/recent-error) → error (red); a slowing
    // one (warning/waiting/blocked/directive) → warning (amber). Called as a METHOD
    // on `toast` (not a destructured ref) so its internal binding is preserved.
    const method = entry.tone === 'critical' ? 'error' : 'warning';
    toast[method](title, {
      description,
      // Noticeable but still transient — longer than a "chat renamed" toast (this is
      // the product's most important signal), short enough never to linger as noise.
      duration: 6000,
      // One stable ping per chat: a still-visible ping updates instead of stacking.
      ...(entry.key ? { id: `warden-attention:${entry.key}` } : {}),
      // One-click deep-link for named entrants. Aggregate entrants have no pane to
      // open, so they carry no action (the Activity tab is their resolution path).
      ...(entry.key && onOpenChat
        ? { action: { label: 'Open', onClick: () => onOpenChat(entry.key) } }
        : {}),
    });
  }
}

export function useAttentionRollup(
  attentionDesktopAlerts = false,
  openPanes: string[] = [],
  enabledStates?: AttentionRollupOptions['enabledStates'],
  severityPrefs: AttentionSeverityPrefs = ATTENTION_SEVERITY_DEFAULTS,
  mutedAlertKeys: readonly string[] = EMPTY_MUTED_KEYS,
  // WARDEN-378: pane keys the human opted into per-chat "watch" — unioned into the
  // ?panes= poll so a watched chat is classified even when its pane is NOT open, and
  // diffed for a targeted ping when it newly needs the human.
  watchedChats: string[] = [],
  // Deep-link click handler for the watch ping — reuses App's openChat to land on
  // the pane that needs attention. Optional (the ping still fires without it).
  onOpenChat?: (id: string) => void,
  // WARDEN-426: the pane key the human is currently focused on. Suppresses the
  // per-chat watch ping when a watched pane transitions into a needs-you state
  // WHILE the human is present (Warden visible) AND already reading that exact
  // pane (they can already see it — it's in the OPEN-only AttentionBadge). This
  // is NOT, on its own, an away signal: `focused` is sticky workspace state that
  // is not cleared when Warden hides, so the actual away check is the
  // document.visibilityState passed at the call site (hidden → always fire). Trailing
  // + optional so existing call sites stay compatible.
  focusedPaneKey?: string | null,
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
  // WARDEN-378: watched-chats set + the open-chat deep-link, as refs for the same
  // reason (live reads inside the interval closure without rebuilding it). And the
  // per-chat prior-state baseline the watch transition detector diffs against —
  // tracked per-key so a watched-but-closed pane's transitions are correct.
  const watchedChatsRef = useRef(watchedChats);
  watchedChatsRef.current = watchedChats;
  const onOpenChatRef = useRef(onOpenChat);
  onOpenChatRef.current = onOpenChat;
  // WARDEN-426: live focused-pane key, as a ref for the same reason (read inside
  // the interval closure without rebuilding the ~30s poll on every focus change —
  // focus shifts WHAT fires, not WHAT's classified, so it must not reset cadence).
  const focusedPaneRef = useRef(focusedPaneKey);
  focusedPaneRef.current = focusedPaneKey;
  const watchPrevRef = useRef<Record<string, AgentStateRow>>({});
  // The set of keys that were watched when the last watch diff ran. A key NEWLY
  // added to the watch set must start fresh (its first observation is a baseline,
  // not a fire) — so a stale prior carried over from a previous watch session is
  // dropped before the diff (see fetchAgentStates).
  const prevWatchedRef = useRef<Set<string> | null>(null);

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
    const open = openPanesRef.current;
    const watched = watchedChatsRef.current;
    // WARDEN-378: watched ∪ open — a watched chat is classified even when its pane
    // isn't open (the whole point of "watch this chat, step away"). Same ~30s poll,
    // no new poller. Deduped (a watched+open pane is requested once). The server
    // resolves arbitrary ?panes= keys from the cache, so a watched-but-closed key
    // (its chat still in the catalog) resolves the same as an open one.
    const union = Array.from(new Set([...open, ...watched]));
    if (!union.length) { setAgentStates([]); setAgentStatesLoaded(true); return; }
    try {
      const res = await fetch(`/api/agent-states?panes=${encodeURIComponent(union.join(','))}`);
      if (res.ok) {
        const data = (await res.json()) as AgentStatesData;
        const rows = Array.isArray(data?.agents) ? data.agents : [];
        // WARDEN-378: per-chat watch transition detector. Runs on WATCHED keys only,
        // over the full fetched set (which includes watched-but-closed panes). First
        // observation is a baseline (no fire); a ping fires ONLY on a change-into a
        // needs-you state — the near-zero-false-signal bar (chatWatch.diffWatchAlerts).
        if (watched.length) {
          const curByKey = indexByWatchKey(rows);
          // Newly-watched keys (absent from the previous watched set) start fresh:
          // drop any stale prior carried over from a prior watch session so their
          // first observation is a baseline, not a fire (the
          // first-observation-is-baseline rule, applied across un/re-watch).
          const prevWatched = prevWatchedRef.current;
          if (prevWatched) {
            for (const k of watched) {
              if (!prevWatched.has(k)) delete watchPrevRef.current[k];
            }
          }
          prevWatchedRef.current = new Set(watched);
          const alerts = diffWatchAlerts(watchPrevRef.current, curByKey, watched);
          // Advance the per-key baseline for watched keys. A key observed this poll
          // updates; a watched key ABSENT this poll (host blip / gone chat) KEEPS its
          // last-known state so a recover-into-needs-you still diffs correctly. The
          // map is rebuilt from watched keys only — bounded across a long session,
          // and a stale prior for an un-watched key can't surprise on a re-watch.
          const nextPrev: Record<string, AgentStateRow> = {};
          for (const k of watched) {
            const cur = curByKey[k];
            if (cur) nextPrev[k] = cur;
            else if (watchPrevRef.current[k]) nextPrev[k] = watchPrevRef.current[k];
          }
          watchPrevRef.current = nextPrev;
          for (const a of alerts) {
            // WARDEN-426: focus-gate the ping — if the human is BOTH focused on
            // this exact pane AND present (Warden visible), skip the OS ping: a
            // focused pane is open + visible, so they can already see it via the
            // OPEN-only AttentionBadge. `shouldFireWatch` also takes the live
            // document.visibilityState: `focused` is STICKY workspace state that
            // is NOT cleared when Warden hides, so when the human is AWAY
            // (hidden) the ping ALWAYS fires regardless of focus — that is the
            // watch feature's purpose (watch, step away, get pinged) and the
            // badge is not visible to carry the signal while away. Gating on
            // focus alone would swallow the away-ping entirely (the baseline
            // below already advanced → no later re-fire either).
            //
            // SCOPE NOTE: the gate wraps BOTH the OS ping AND the catch-up
            // record (recordWatchMiss). That is correct ONLY because of the
            // visibility short-circuit: away (hidden) → shouldFireWatch is true →
            // the block runs and shouldRecordMiss(_, 'hidden') records the miss
            // (WARDEN-417's recovery net stays armed for the away case). The
            // only case both are skipped is present + focused-on-this-pane, where
            // neither a transient ping NOR a catch-up record is wanted (the human
            // saw it in the badge). The ticket's plan wrapped only the ping; the
            // record rides along here because the two share the same "human is
            // present and reading this exact pane" precondition.
            if (shouldFireWatch(focusedPaneRef.current, a.row, document.visibilityState)) {
              // WARDEN-378: fire the OS notification. WARDEN-417: capture whether
              // the OS channel DELIVERED it (false on unsupported / denied /
              // restrictive-webview) so the catch-up records ONLY what the OS
              // lost — not a duplicate channel.
              const delivered = fireWatchNotification(a.row, a.reason, onOpenChatRef.current);
              // WARDEN-417: durably record the ping for the in-app catch-up
              // surfaced on return (watchCatchup) when the OS channel LOST it
              // (delivered === false) OR the human is away (hidden — a delivered
              // ping may yet be cleared / DND'd). A ping the OS delivered to a
              // PRESENT human is NOT recorded (they saw it). shouldRecordMiss is
              // the pure, unit-tested gate carrying BOTH outcomes. Never throws.
              if (shouldRecordMiss(delivered, document.visibilityState)) recordWatchMiss(a.row, a.reason);
            }
          }
        }
        // The rollup (AttentionBadge) stays OPEN-only (WARDEN-344): a watched-but-
        // closed pane does NOT inflate the fleet attention count — its signal reaches
        // the human through the targeted watch ping, not the lumped badge.
        const openSet = new Set(open);
        setAgentStates(rows.filter((r) => openSet.has(r.key ?? r.id)));
      }
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

  // Pane states on the dedicated ~30s cadence (WARDEN-344). Classifies the OPEN
  // panes ∪ the watched-chats set (WARDEN-378 — a watched chat is classified even
  // when its pane isn't open); an empty union is a cheap no-op. Re-fires immediately
  // when the open-panes OR watched set changes so a freshly-watched / freshly-opened
  // pane surfaces within a poll, not after 30s. Visibility relaxation fires while
  // hidden when the fleet alert is opted in OR any chat is watched (step-away case).
  useEffect(() => {
    void fetchAgentStates();
    const tick = () => {
      // WARDEN-378: a watched chat must keep being classified while Warden is hidden
      // (the human stepped away — the watch's whole premise), so the visibility
      // relaxation extends to "any watched chat", not just the fleet alert opt-in.
      if (attentionDesktopAlerts || watchedChats.length > 0 || document.visibilityState === 'visible') void fetchAgentStates();
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
  }, [fetchAgentStates, attentionDesktopAlerts, openPanes, watchedChats]);

  // Derive the rollup from the three signals + the per-state toggle. useMemo so a
  // toggle change re-aggregates without a refetch, and so the badge only re-renders
  // when something that affects the count actually changed.
  const rollup = useMemo(
    () => buildAttentionRollup(health, stats, agentStates, { enabledStates }),
    [health, stats, agentStates, enabledStates],
  );

  // Fire an attention notification on a genuine rollup INCREASE (WARDEN-259). The
  // increase-only shouldFireAlert returns true ONLY on a total increase, so a
  // persistent condition never repeats and a recovery never fires. prevRoutableRef
  // always advances (even when we don't fire) so the next comparison is against the
  // last ROUTABLE rollup, not a stale one. No-op entirely when the master toggle is
  // off. Both delivery channels below share the SAME opt-in pref + increase-only
  // gate (no new noise).
  //
  // WARDEN-364: the decision runs over the ROUTABLE sub-rollup (severity prefs +
  // per-agent mute applied), so an increase in only a disabled/muted bucket fires
  // nothing while still appearing in the in-app badge (which consumes the raw
  // rollup). The visibility-gate relaxation in the poll effects above stays keyed
  // on the MASTER toggle only — the sub-toggles never add polling.
  //
  // WARDEN-402: visibility now BRANCHES the delivery channel instead of gating it.
  // UNFOCUSED → the raw OS desktop toast (the away channel, unchanged). VISIBLE →
  // the crafted, themed IN-APP sonner ping (fireAttentionInApp above), reason-
  // specific + one-click deep-linkable. This closes the prior "visible → return"
  // gap (a watched chat newly needing the human while they were AT Warden produced
  // no transient ping at all — only the header badge ticking up). The in-app
  // toast's transience (sonner auto-dismiss) is what keeps the relaxed gate from
  // reintroducing the noise the visible-return originally existed to suppress.
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
    // `prev &&` narrows the nullable ref for TS — and is a true no-op logically, since
    // shouldFireAlert already returns false when prev is null (its missing-input guard).
    if (prev && shouldFireAlert(prev, routable)) {
      if (document.visibilityState === 'visible') {
        fireAttentionInApp(prev, routable, onOpenChatRef.current);
      } else {
        fireAttentionNotification(routable);
      }
    }
  }, [rollup, attentionDesktopAlerts, loading, agentStatesLoaded, severityPrefs, mutedSet]);

  return { rollup, loading };
}
