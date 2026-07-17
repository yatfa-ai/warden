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
  excludeFocusedPane,
  formatInAppEntry,
  watchReasonTone,
  formatWatchInApp,
  ATTENTION_SEVERITY_DEFAULTS,
  type AttentionSeverityPrefs,
} from '@/lib/desktopAlerts';
import { diffWatchAlerts, indexByWatchKey, applyWatchCooldown, detectWatchCompleted, type WatchLastFiredMap, type WatchReason } from '@/lib/chatWatch';
import { recordWatchMiss, shouldRecordMiss } from '@/lib/watchCatchup';
import { activeSnoozedKeys, type SnoozeMap } from '@/lib/snooze';
import type { HealthData, ActivityStats, AgentStateRow, AgentStatesData } from '@/lib/types';

// Recent-error / recent-directive window. ActivityStats counts raw events in the
// queried window — there is NO server-side "unresolved"/"pending" flag — so a
// bounded recent window is the proxy for "needs your eye". 15 min is a glanceable
// "what just happened" horizon that doesn't grow unbounded over a long session.
// (The "While you were away" startup banner keeps its own since-last-close window;
// this is the live, always-on rollup, so it uses a fixed rolling window instead.)
export const ATTENTION_RECENT_WINDOW_MS = 15 * 60 * 1000;

// WARDEN-575: how long a finished agent stays in the badge's green "Finished"
// section. A completion is a transient "just stopped" cue — long enough to notice
// when the human glances at Warden (~3 min), short enough that the section clears
// once the work is no longer news. The DURABLE signal is the desktop/webhook ping
// (fired once on the transition); this window only governs the in-badge visibility.
const DONE_RECENT_WINDOW_MS = 3 * 60 * 1000;
// WARDEN-575: per-key cooldown for the fleet done PING (the badge section is
// separately windowed above). A flapping open pane (active→idle→active→idle on
// successive polls) would otherwise fire a "Finished a task" toast on every
// active→idle — exactly the flap-spam WARDEN-452 collapsed for the watch ping with
// applyWatchCooldown. This is the fleet-done equivalent: one done ping per key per
// window. Mirrors WATCH_PING_COOLDOWN_MS (5 min) so a flap reads identically whether
// the pane is watched (watch ping) or merely open (fleet done ping).
const DONE_PING_COOLDOWN_MS = 5 * 60 * 1000;

// Health + activity stay on HealthDashboard's 10s cadence. Pane-state classification
// runs capturePanes (a batched SSH round-trip), so it gets a DEDICATED slower cadence.
const HEALTH_POLL_MS = 10_000;
const AGENT_STATE_POLL_MS = 30_000;
// WARDEN-571: the fleet sweep runs on its OWN slower cadence (distinct from the 30s
// open∪watched poll). It classifies the REST of the fleet — the hidden / un-watched
// agents the 30s poll never reaches — via the companion-backed sweep endpoint (no SSH
// sweep: one batched companion RPC per hidden host per sweep, never an SSH probe), so a
// hidden agent needing attention surfaces within one sweep cycle instead of reading
// HEALTHY forever. 90s sits in the ticket's 60–120s band and off the :00/:30 marks so it
// never lands on the same tick as another poll.
const FLEET_SWEEP_POLL_MS = 90_000;

// A stable empty array default for `mutedAlertKeys` so the memoized Set and the
// effect dep list stay reference-stable when no caller passes a mute set.
const EMPTY_MUTED_KEYS: readonly string[] = [];
// WARDEN-551: a stable empty object default for `snoozedAlertKeys` so the
// suppression effect's dep list stays reference-stable when no caller passes a
// snooze map (mirrors EMPTY_MUTED_KEYS).
const EMPTY_SNOOZED_KEYS: SnoozeMap = {};

export interface AttentionRollupState {
  rollup: AttentionRollup;
  /** True only during the very first fetch (before any data has arrived). */
  loading: boolean;
  /**
   * WARDEN-476: the watched chats' CURRENT states — the watched subset of the open ∪
   * watched rows fetched for the watch diff, exposed (pre-open-filter) so the per-chat
   * watch catch-up can reconcile away misses against current pane state on return and
   * suppress the ones whose chats have since recovered. Built from the SAME ~30s poll
   * the watch diff already rides, so this adds ZERO SSH cost. Empty before the first
   * successful poll lands; preserved (not blanked) on a transient fetch failure.
   */
  watchedStates: AgentStateRow[];
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
  // WARDEN-482: the pane the human is currently focused on (focusedPaneRef.current at
  // the call site). The entrant matching this key is the pane the human is already
  // reading, so its toast is suppressed by excludeFocusedPane before the loop — the
  // symmetric "not-after" focus-gate to the watch ping's WARDEN-421 gate. Aggregate
  // (no-key) entrants still toast. Only ever passed on the VISIBLE branch below, which
  // is exactly when focus is meaningful.
  focusedPaneKey?: string | null,
): void {
  // WARDEN-482: drop the entrant for the focused pane BEFORE toasting — the pure,
  // unit-tested excludeFocusedPane. (See desktopAlerts.ts: a focused pane is open +
  // visible, so it already appears in the OPEN-only AttentionBadge with its "because
  // X" signal; pinging it is the "fires when nothing's needed" product-killer.)
  const entries = excludeFocusedPane(diffNewAttention(prev, next), focusedPaneKey);
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

/**
 * Show the crafted in-app WATCH ping (WARDEN-530). Sibling of fireAttentionInApp (the
 * fleet's at-Warden ping, WARDEN-402) for the per-chat watch channel: instead of the raw
 * OS toast — which is fragile when Warden is the focused app (OSes routinely suppress
 * banners for the focused window or under DND — the "a ping that misses a real need
 * breaks trust" failure mode) — this renders a themed sonner toast, reason-specific and
 * one-click deep-linkable, for a watched chat (open OR closed pane) that NEWLY needs the
 * human WHILE they are looking at Warden. That closes the asymmetry with the fleet: a
 * watched chat newly needing the human at-Warden previously produced only the raw OS
 * toast, not the "beautiful notification" (WARDEN-68) the bar demands.
 *
 * The tone comes from the pure watchReasonTone (red for a broken agent, amber for
 * waiting, green for completed), and the wording from the pure formatWatchInApp (agent
 * name as the title, reason + verbatim signal as the description). A stable per-key
 * sonner `id` (`warden-watch:<key>` — the SAME identity space fireWatchNotification's OS
 * `tag` uses) means a still-visible ping for the same chat UPDATES rather than stacking.
 * A one-click "Open" action deep-links via App's openChat — the same path the OS ping's
 * click uses. Auto-dismisses (sonner's transience): fires ONCE per genuine new need (the
 * transition detector + cooldown the caller already enforced) and then leaves.
 *
 * Fires ONLY on the VISIBLE branch of the watch fire-loop (the human is present and sees
 * it), so — mirroring the fleet's visible path — NO catch-up miss is recorded: the human
 * saw it, so recording it would only become stale catch-up noise. Never throws.
 */
function fireWatchInApp(
  row: AgentStateRow,
  reason: WatchReason,
  onOpenChat?: (id: string) => void,
): void {
  const { title, description } = formatWatchInApp(row, reason);
  // Themed tone maps reason → sonner variant (WARDEN-68): a broken agent (erroring/stuck)
  // → error (red); waiting → warning (amber); completed → success (green). 'critical' maps
  // to sonner's `error` (parallels the fleet's tone vocabulary); 'warning'/'success' map
  // 1:1. Called as a METHOD on `toast` (not a destructured ref) so its internal binding is
  // preserved.
  const tone = watchReasonTone(reason);
  const method: 'error' | 'warning' | 'success' = tone === 'critical' ? 'error' : tone;
  const key = row.key || row.id;
  toast[method](title, {
    description,
    // Noticeable but still transient — the same horizon the fleet's in-app ping uses.
    duration: 6000,
    // One stable ping per chat (the SAME identity space as the OS `tag`): a still-visible
    // ping for the same chat updates instead of stacking.
    ...(key ? { id: `warden-watch:${key}` } : {}),
    // One-click deep-link to the watched pane — the same openChat path the OS ping uses.
    ...(key && onOpenChat
      ? { action: { label: 'Open', onClick: () => onOpenChat(key) } }
      : {}),
  });
}

export function useAttentionRollup(
  attentionDesktopAlerts = false,
  openPanes: string[] = [],
  enabledStates?: AttentionRollupOptions['enabledStates'],
  severityPrefs: AttentionSeverityPrefs = ATTENTION_SEVERITY_DEFAULTS,
  mutedAlertKeys: readonly string[] = EMPTY_MUTED_KEYS,
  // WARDEN-551: chat key → expiry (ms). A snoozed agent is suppressed on the
  // desktop-alert channel EXACTLY like a permanent mute (unioned into mutedSet
  // below) but only until its expiry, after which it auto-rearms. Suppression is
  // computed inside the gate effect reading Date.now() FRESH, so an expired snooze
  // drops out on the very next cadence tick — alerts resume with no manual un-mute.
  snoozedAlertKeys: SnoozeMap = EMPTY_SNOOZED_KEYS,
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
  // WARDEN-575: the open-pane keys that finished within DONE_RECENT_WINDOW_MS — the
  // membership set the rollup's `done` bucket reads. Kept in STATE (not a ref) so a
  // completion/refesh re-aggregates the rollup and the badge's green section updates.
  const [doneKeys, setDoneKeys] = useState<Set<string>>(() => new Set());
  // WARDEN-476: the watched chats' current states (watched subset of the fetched rows),
  // exposed for the catch-up's return-time reconciliation. See AttentionRollupState.
  const [watchedStates, setWatchedStates] = useState<AgentStateRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [agentStatesLoaded, setAgentStatesLoaded] = useState(false);
  // WARDEN-571: the hidden-fleet sweep rows (stuck/erroring/waiting/blocked agents that
  // are NEITHER open NOR watched). Folded into the SAME rollup below so a hidden agent
  // needing attention surfaces in the badge + fires the opt-in alert. `sweep_skipped`
  // rows (non-companion / LOCAL hosts the cost gate never probes) are present here too
  // but match no rollup bucket, so they never count. Preserved (not blanked) on a
  // transient fetch failure, mirroring agentStates.
  const [fleetSweepStates, setFleetSweepStates] = useState<AgentStateRow[]>([]);
  // WARDEN-571: the baseline-priming gate also waits for the FIRST sweep to land, so a
  // hidden agent that was ALREADY stuck at launch/reload does not fire a "new" alert —
  // the same "pre-existing attention does not fire (the return banner covers it)"
  // principle the open-pane poll's priming already enforces.
  const [fleetSweepLoaded, setFleetSweepLoaded] = useState(false);
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
  // WARDEN-575: live refs for the done-ping gates, read inside the fetchAgentStates
  // closure (a [] useCallback) so the master toggle + the done per-state toggle take
  // effect without rebuilding the ~30s poll.
  const attentionDesktopAlertsRef = useRef(attentionDesktopAlerts);
  attentionDesktopAlertsRef.current = attentionDesktopAlerts;
  const enabledStatesDoneRef = useRef<boolean>(enabledStates?.done !== false);
  enabledStatesDoneRef.current = enabledStates?.done !== false;
  const watchPrevRef = useRef<Record<string, AgentStateRow>>({});
  // The set of keys that were watched when the last watch diff ran. A key NEWLY
  // added to the watch set must start fresh (its first observation is a baseline,
  // not a fire) — so a stale prior carried over from a previous watch session is
  // dropped before the diff (see fetchAgentStates).
  const prevWatchedRef = useRef<Set<string> | null>(null);
  // WARDEN-452: per-key cooldown anchor for the LIVE watch-ping channel. Sibling of
  // watchPrevRef: a {key → {reason, firedAt}} map advanced each fire so a flapping
  // watched chat re-fires ONE ping per episode window, not one per re-entry once the
  // prior toast is gone (escalations override + reset). Pruned to watched keys below
  // so an un-watched key's stale anchor can't suppress a fresh re-watch's first ping.
  const watchLastFiredRef = useRef<WatchLastFiredMap>({});

  // WARDEN-575: the done-detection baseline + window for OPEN panes. `openPrevRef`
  // holds each open pane's last observed state (key → state) so a working→idle flip
  // is detected via the SAME detectWatchCompleted the watch subsystem uses. The
  // ping for a finished OPEN pane reuses the watch-completed delivery (success tone
  // + "finished a task" wording), so the fleet done ping and the per-watch
  // completed ping stay in sync — no duplicate wording/tone to drift.
  const openPrevRef = useRef<Record<string, string>>({});
  // key → epoch-ms the agent finished; entries older than DONE_RECENT_WINDOW_MS are
  // pruned each poll so the "Finished" section is transient.
  const doneRecentRef = useRef<Map<string, number>>(new Map());
  // WARDEN-575: key → epoch-ms the done PING last fired for that key — the flap
  // cooldown (see DONE_PING_COOLDOWN_MS). Distinct from doneRecentRef: the badge
  // section must drop a pane the instant it goes active again (pruned below), but
  // the ping cooldown must PERSIST across that flap so a re-finish within the window
  // does not re-ping. Pruned to open keys each poll so it stays bounded.
  const doneLastFiredRef = useRef<Map<string, number>>(new Map());

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
    if (!union.length) { setAgentStates([]); setWatchedStates([]); setAgentStatesLoaded(true); return; }
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
          // WARDEN-452: cooldown the LIVE watch-ping channel BEFORE firing. A flapping
          // watched chat re-enters its needs-state on every poll, and each re-entry
          // would ping anew once the prior toast is dismissed / DND'd / auto-timed-out
          // (the OS `tag` only replaces a still-displayed notification). applyWatchCooldown
          // collapses such a key to ONE ping per episode window — escalations to a more
          // urgent need override + reset; same-or-lower-urgency re-entries within the
          // window are suppressed. It returns the subset that may fire + the updated
          // per-key anchor map. Suppressed alerts skip BOTH the fire AND the catch-up
          // record below — else stale awayMisses rows would undermine the catch-up's
          // own dedup. WARDEN-426's focus-gate is a second pre-fire filter on this same
          // loop (now merged on main); both must pass to fire — the cooldown runs first
          // (producing `fireable`), then the focus-gate wraps each survivor's fire+record.
          const now = Date.now();
          const { fire: fireable, lastFired: nextLastFiredRaw } = applyWatchCooldown(
            alerts,
            watchLastFiredRef.current,
            now,
          );
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
          // WARDEN-452: prune the cooldown anchors to watched keys (mirrors the nextPrev
          // rebuild above). The gate carried every prior anchor forward; this drops the
          // un-watched ones so the map stays bounded to watched-keys-that-fired and a
          // stale anchor can't suppress a fresh re-watch's first ping.
          const nextLastFired: WatchLastFiredMap = {};
          for (const k of watched) {
            if (nextLastFiredRaw[k]) nextLastFired[k] = nextLastFiredRaw[k];
          }
          watchLastFiredRef.current = nextLastFired;
          // WARDEN-452 + WARDEN-426 compose as two pre-fire filters on this loop,
          // both of which must pass for a ping to fire:
          //  - WARDEN-452 (cooldown): the loop runs over `fireable` — the subset of
          //    `alerts` that survived the per-key cooldown (one ping per flapping
          //    need-episode; escalations override + reset). A suppressed re-entry
          //    never reaches here, so it skips BOTH the fire AND the catch-up record.
          //  - WARDEN-426 (focus-gate): for each surviving alert, `shouldFireWatch`
          //    decides whether to actually ping given the human's focus + presence.
          for (const a of fireable) {
            // WARDEN-426: focus-gate the ping — if the human is BOTH focused on
            // this exact pane AND present (Warden visible), skip the ping: a focused
            // pane is open + visible, so they can already see it via the OPEN-only
            // AttentionBadge. `shouldFireWatch` also takes the live
            // document.visibilityState: `focused` is STICKY workspace state that is NOT
            // cleared when Warden hides, so when the human is AWAY (hidden) the ping
            // ALWAYS fires regardless of focus — that is the watch feature's purpose
            // (watch, step away, get pinged) and the badge is not visible to carry the
            // signal while away. Gating on focus alone would swallow the away-ping
            // entirely (the baseline above already advanced → no later re-fire either).
            //
            // WARDEN-530: with the gate passed, visibility now BRANCHES the delivery
            // channel (mirrors the fleet's WARDEN-402 cutover for fireAttentionInApp):
            //   - VISIBLE  → fireWatchInApp — the crafted, themed IN-APP sonner ping, the
            //     reliable at-Warden signal (an OS banner is fragile when Warden is the
            //     focused app: OSes suppress banners for the focused window or under DND).
            //     NO catch-up record — the human is present and sees it, mirroring the
            //     fleet's visible path (which records no miss).
            //   - HIDDEN   → unchanged: fireWatchNotification (the OS away toast) + the
            //     shouldRecordMiss/recordWatchMiss recovery net (WARDEN-417).
            // The focus-gate wraps BOTH branches; the only case BOTH are skipped is
            // present + focused-on-this-pane, where neither a transient ping NOR a
            // catch-up record is wanted (the human saw it in the badge).
            if (shouldFireWatch(focusedPaneRef.current, a.row, document.visibilityState)) {
              if (document.visibilityState === 'visible') {
                // WARDEN-530: the at-Warden crafted ping — reason-specific, themed, and
                // one-click deep-linkable. No catch-up miss: the human is present.
                fireWatchInApp(a.row, a.reason, onOpenChatRef.current);
              } else {
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
        }
        // The rollup (AttentionBadge) stays OPEN-only (WARDEN-344): a watched-but-
        // closed pane does NOT inflate the fleet attention count — its signal reaches
        // the human through the targeted watch ping, not the lumped badge.
        const openSet = new Set(open);
        const openRows = rows.filter((r) => openSet.has(r.key ?? r.id));
        setAgentStates(openRows);
        // WARDEN-575: detect working→idle COMPLETIONS on OPEN panes and (a) keep a
        // time-boxed "recently finished" set that feeds the badge's green `done`
        // bucket, and (b) fire a positive "agent X finished" ping on the NEW
        // transition. Watched chats are EXCLUDED here — the watch subsystem above
        // already pings their `completed` transition, so this covers the open-but-
        // NOT-watched panes (the fleet). Reuses detectWatchCompleted (the shared
        // working→idle rule) + the watch-completed delivery, so wording/tone match.
        const watchedSetForDone = new Set(watched);
        const prevOpen = openPrevRef.current;
        const doneRecent = doneRecentRef.current;
        const doneLastFired = doneLastFiredRef.current;
        const now = Date.now();
        const nextOpenPrev: Record<string, string> = {};
        for (const r of openRows) {
          const key = r.key ?? r.id;
          nextOpenPrev[key] = r.state;
          if (watchedSetForDone.has(key)) continue; // watched → the watch ping handles it
          const prev = prevOpen[key];
          if (detectWatchCompleted(prev ?? null, r.state)) {
            doneRecent.set(key, now);
            // Fire the positive done ping, gated exactly like the watch ping: master
            // toggle + the done per-state toggle + the per-key flap-cooldown + focus +
            // visibility (visible → the crafted in-app toast; hidden → the OS away
            // toast). A focused-on-this-pane + present human skips it (they can already
            // see it idle). The cooldown collapses a flapping pane (active→idle→active
            // →idle) to one ping per window — the fleet-done analog of the watch ping's
            // WARDEN-452 cooldown.
            const lastFired = doneLastFired.get(key) ?? 0;
            if (now - lastFired > DONE_PING_COOLDOWN_MS
              && attentionDesktopAlertsRef.current && enabledStatesDoneRef.current
              && shouldFireWatch(focusedPaneRef.current, r, document.visibilityState)) {
              doneLastFired.set(key, now);
              if (document.visibilityState === 'visible') {
                fireWatchInApp(r, 'completed', onOpenChatRef.current);
              } else {
                fireWatchNotification(r, 'completed', onOpenChatRef.current);
              }
            }
          }
        }
        openPrevRef.current = nextOpenPrev;
        // Prune the recently-finished window: drop entries older than the horizon, and
        // drop a key whose pane is no longer idle (it went active again → no longer
        // "just finished"). A pane ABSENT this poll keeps its entry (host blip).
        const currentlyIdleKeys = new Set(openRows.filter((r) => r.state === 'idle').map((r) => r.key ?? r.id));
        for (const [k, t] of doneRecent) {
          if (now - t > DONE_RECENT_WINDOW_MS || (nextOpenPrev[k] !== undefined && !currentlyIdleKeys.has(k))) {
            doneRecent.delete(k);
          }
        }
        setDoneKeys(new Set(doneRecent.keys()));
        // Prune the cooldown map to currently-open keys (bounded across a long
        // session; a closed pane's stale anchor can't suppress a fresh re-open's
        // first finish). Entries older than the cooldown also drop.
        const openKeySet = new Set(Object.keys(nextOpenPrev));
        for (const [k, t] of doneLastFired) {
          if (!openKeySet.has(k) || now - t > DONE_PING_COOLDOWN_MS) doneLastFired.delete(k);
        }
        // WARDEN-476: expose the watched chats' CURRENT states — the WATCHED subset of
        // the pre-open-filter `rows` (which include watched-but-closed panes the open
        // filter above just discarded). This is the data the per-chat watch catch-up
        // reconciles away misses against on return, so a miss whose chat recovered is
        // suppressed. It is already in-flight on THIS same poll (fetched for the watch
        // diff above), so it adds zero SSH cost. Built before the open filter drops the
        // watched-but-closed rows — those are exactly the chats the catch-up covers.
        const watchedSet = new Set(watched);
        setWatchedStates(rows.filter((r) => watchedSet.has(r.key ?? r.id)));
      }
    } catch {
      // A failed state poll must not blank the other halves or crash the badge.
    }
    setAgentStatesLoaded(true);
  }, []);

  // WARDEN-571: the hidden-fleet sweep fetch. Classifies every active chat that is
  // NEITHER open NOR watched, so a hidden agent stuck-looping / waiting for input /
  // error-spamming surfaces in the badge instead of reading HEALTHY forever. The sweep
  // is companion-backed (no SSH sweep — one batched companion RPC per hidden host per
  // sweep); non-companion / LOCAL hosts come back `sweep_skipped` and never inflate the
  // count. The result folds into the SAME rollup (see the useMemo below), so the existing
  // badge + opt-in alert fire for a hidden agent that newly needs attention — Snooze
  // (WARDEN-551), mute, and the
  // excludeFocusedPane (WARDEN-482) exclusion all apply unchanged because the rows are
  // ordinary AgentStateRow's bucketed by the same buildAttentionRollup.
  const fetchFleetStates = useCallback(async () => {
    const open = openPanesRef.current;
    const watched = watchedChatsRef.current;
    // The sweep set = the whole fleet MINUS what the 30s open∪watched poll already
    // covers. Pass the union as ?exclude= so the sweep never re-classifies (or double-
    // counts) a pane the faster poll owns.
    const exclude = Array.from(new Set([...open, ...watched]));
    try {
      const res = await fetch(`/api/agent-states/fleet?exclude=${encodeURIComponent(exclude.join(','))}`);
      if (res.ok) {
        const data = (await res.json()) as AgentStatesData;
        const rows = Array.isArray(data?.agents) ? data.agents : [];
        // Defensive: a pane that just became open/watched between this sweep and the
        // last must NOT contribute a sweep row — it is now owned by the 30s poll, and a
        // stale sweep copy would double-count it for up to one sweep cycle. The server
        // already excludes these via ?exclude=; this is the belt-and-suspenders guard.
        const owned = new Set([...open, ...watched]);
        setFleetSweepStates(rows.filter((r) => !owned.has(r.key ?? r.id)));
      }
      // A failed sweep must not blank the rollup (mirrors fetchAgentStates) — leave the
      // prior sweep rows in place.
    } catch {
      // best-effort: keep the last good sweep rows.
    }
    setFleetSweepLoaded(true);
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

  // Fleet sweep on a DEDICATED slow cadence (~90s — distinct from the 30s open∪watched
  // poll above) so a HIDDEN agent needing attention surfaces within one sweep cycle
  // (WARDEN-571). The sweep is companion-backed (no SSH sweep — one batched companion RPC
  // per hidden host per sweep; the 30s subscription TTL evicts between sweeps). It runs
  // whenever its results would be ACTED on — Warden visible (the badge shows them) OR the
  // fleet alert opted in (an away alert fires) — mirroring the 30s poll's visibility
  // relaxation. The exclude set is read LIVE via refs (openPanesRef/watchedChatsRef), so
  // opening/watching a pane (which SHRINKS the sweep set) never rebuilds this slow
  // cadence — responsiveness for those panes is the 30s poll's job; this is the
  // background sweep for everything else.
  useEffect(() => {
    void fetchFleetStates();
    const tick = () => {
      if (attentionDesktopAlerts || document.visibilityState === 'visible') void fetchFleetStates();
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') void fetchFleetStates();
    };
    const intervalId = window.setInterval(tick, FLEET_SWEEP_POLL_MS);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.clearInterval(intervalId);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [fetchFleetStates, attentionDesktopAlerts]);

  // Derive the rollup from the three signals + the per-state toggle. useMemo so a
  // toggle change re-aggregates without a refetch, and so the badge only re-renders
  // when something that affects the count actually changed.
  // WARDEN-571: the hidden-fleet sweep rows are folded in HERE — alongside the open-
  // pane agentStates — so a hidden agent needing attention (stuck/erroring/waiting/
  // blocked/custom) appears as a needs-attention row. sweep_skipped rows match no
  // bucket and never count. buildAttentionRollup is unchanged (it buckets by state);
  // the fold is purely the concatenation here.
  //
  // WARDEN-344 invariant preserved: the rollup stays OPEN-only — a WATCHED-but-closed
  // pane surfaces via the targeted watch ping, not the lumped badge. The sweep's purpose
  // is precisely the HIDDEN / un-watched fleet, so a sweep row whose pane is currently
  // OPEN or WATCHED is dropped before the merge. This also closes the ≤1-sweep-cycle
  // stale window (a pane swept, then newly opened/watched) so the invariant never
  // transiently breaks and an open pane is never double-counted (its open row in
  // agentStates is always the current one). agentStates is already open-only.
  //
  // WARDEN-575: doneKeys — the open-pane keys that finished within
  // DONE_RECENT_WINDOW_MS — seeds the rollup's green `done` bucket (a passive, transient
  // "just finished" cue in the badge). It does NOT affect the increase-only alert gate
  // (done is excluded from `total` in buildAttentionRollup), so the sweep fold above and
  // the done bucket compose without either perturbing the other.
  const rollup = useMemo(() => {
    const covered = new Set([...openPanes, ...watchedChats]);
    const sweepRows = fleetSweepStates.filter((r) => !covered.has(r.key ?? r.id));
    return buildAttentionRollup(health, stats, [...agentStates, ...sweepRows], { enabledStates, doneKeys });
  }, [health, stats, agentStates, fleetSweepStates, openPanes, watchedChats, enabledStates, doneKeys]);

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
  // Baseline priming: the FIRST rollup observed after all initial fetches land
  // becomes the baseline (no fire) — so pre-existing attention at launch/reload does
  // not fire (the "While you were away" banner covers that), matching shouldFireAlert's
  // "either input missing → false". A pane that flips stuck/erroring/waiting AFTER
  // that raises total → fires. WARDEN-571: the gate also waits for the first sweep to
  // land, so a hidden agent that was ALREADY stuck at launch does not fire a "new"
  // alert once the slow sweep discovers it (the banner covers launch state too).
  useEffect(() => {
    if (loading || !agentStatesLoaded || !fleetSweepLoaded) return;
    // WARDEN-551: union the ACTIVE snoozes into the mute set, reading Date.now()
    // FRESH here (not from a memoized value) so an expired snooze drops out on
    // the very next cadence tick — the auto-rearm. The merged set is what
    // applySeverityPrefs suppresses, so a snoozed agent's critical/warning
    // increase fires no OS notification, identically to a permanent mute. When
    // the snooze later expires, the key re-enters the routable set → a total
    // increase vs the prior (suppressed) baseline → shouldFireAlert fires again
    // IF the agent still needs attention, exactly the "alerts resume" value.
    const suppressed = new Set(mutedSet);
    for (const snoozedKey of activeSnoozedKeys(snoozedAlertKeys, Date.now())) {
      suppressed.add(snoozedKey);
    }
    const routable = applySeverityPrefs(rollup, severityPrefs, suppressed);
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
        fireAttentionInApp(prev, routable, onOpenChatRef.current, focusedPaneRef.current);
      } else {
        fireAttentionNotification(routable);
      }
    }
  }, [rollup, attentionDesktopAlerts, loading, agentStatesLoaded, fleetSweepLoaded, severityPrefs, mutedSet, snoozedAlertKeys]);

  return { rollup, loading, watchedStates };
}
