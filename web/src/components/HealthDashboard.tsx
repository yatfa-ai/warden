import { useState, useMemo, Fragment } from 'react';
import { toast } from 'sonner';
import { ScrollArea } from '@/components/ui/scroll-area';
import type { HealthData, Chat } from '@/lib/types';
import {
  normalizeHealthState,
  groupByHost,
  compareHostGroups,
  groupByProject,
  compareProjectGroups,
  formatFleetSummaryText,
  type HostHealthGroup,
  type ProjectHealthGroup,
} from '@/lib/healthUtils';
import { FleetActivityHeatmap } from '@/components/FleetActivityHeatmap';
import { FleetStateTimeline } from '@/components/FleetStateTimeline';
import { FleetRecentCommits } from '@/components/FleetRecentCommits';
import { FileViewer } from '@/components/FileViewer';
import { formatTimestamp } from '@/lib/formatTimestamp';
import { useTimestampFormat } from '@/lib/uiStore';
import { Button } from '@/components/ui/button';
import { ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem, ContextMenuSeparator } from '@/components/ui/context-menu';
import { copyWithToast } from '@/lib/clipboardToast';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { KillDialog } from './KillDialog';
import { KeySendDialog } from './KeySendDialog';
import { SelectionActionBar } from './sidebar/SidebarBits';
import { healthRank } from './fleet-health/StatusChips';
import { renderAgentRow } from './fleet-health/AgentRow';
import { renderAgentGroups, HEALTH_SECTION_ORDER, CLOSED_COLLAPSED_LIMIT, CLOSED_EXPANDED_LIMIT, byRecencyDesc, type GroupMode } from './fleet-health/AgentGroups';

export type { GroupMode };
import { formatKillToast, runKillFanout } from '@/lib/kill';
import { formatKeySendToast, runKeySendFanout } from '@/lib/keysend';
import { showFanoutToast } from '@/lib/fanoutToast';
import { useHostStatuses, refreshHostStatuses } from '@/lib/useHostStatuses';
import { useActivitySeries } from '@/lib/useActivitySeries';
import { fetchBounded, pollerFetchOptions } from '@/lib/api';
import { useFleetGitStatus } from '@/lib/useFleetGitStatus';
import { useNotificationPrefsReader } from '@/lib/appConfigHooks';
import { useVisiblePoller } from '@/lib/useVisiblePoller';
import { buildAgentActivity } from '@/lib/agentSparkline';
import { displayName, hostLabelFor } from '@/lib/chatDisplay';
import { useHealthSelectedIds, useToggleHealthSelected, useToggleHealthGroup, useSetHealthSelected, useClearHealthSelected, useHealthClosedExpanded, useSetHealthClosedExpanded, useHostLabels, useHealthGroupBy, useSetHealthGroupBy, useHealthCollapsedHosts, useSetHealthCollapsedHosts } from '@/lib/uiStore';

// The fleet-health poll cadence. WARDEN-1144 named it (it was an inline `10000`)
// so the bounded-read deadline is DERIVED from the period rather than guessed
// beside it — the poller policy is "deadline strictly shorter than the period",
// and that invariant only holds if the two numbers cannot drift apart.
const HEALTH_POLL_MS = 10_000;
const HEALTH_FETCH_OPTS = pollerFetchOptions(HEALTH_POLL_MS);

interface Props {
  onOpenChat: (id: string) => void;
  onClose: () => void;
  // WARDEN-882 — whether the companion transport is enabled. Gates the per-host
  // "Remove companion" affordance's visibility (Host mode, remote hosts only).
  // The same gate every companion surface uses; the action is hidden unless the
  // transport is on. Lifted from App, which reads it from /api/config.
  companionTransportEnabled: boolean;
}

// Selection identity for a fleet agent — the same `key || id` the sidebar's
// multi-select (WARDEN-328) and /api/kill use. Module-scope so it's stable
// across renders (safe to reference inside memos without re-creating closures).
// (WARDEN-371)
function agentIdOf(a: Chat): string {
  return a.key || a.id;
}

// The Fleet Health summary bar's git axes as ONE ordered set (WARDEN-1228).
// The order of this array IS the severity ordering — stated here, once:
// dirty → conflict → behind → unpushed → stalled → stashed, then the muted
// "N unreachable" note the summary bar renders after the loop. These axes used
// to be six hand-copied JSX blocks, five of which restated this ordering in
// their own comments (three of those restatements had already drifted stale);
// no entry restates it now, so it can no longer disagree with itself. Adding a
// seventh axis is one entry below, not a new copy plus five comment edits.
export type FleetGitAxis = {
  // The FleetGitStatusResult field driving this axis's fleet-wide count.
  count: 'dirtyCount' | 'conflictCount' | 'behindCount' | 'aheadCount' | 'stalledCount' | 'stashedCount';
  // Tailwind text colour — the sidebar chip family's colour for this state.
  color: string;
  // The tooltip tail appended after the shared `${n} agent(s) ` prefix.
  titleTail: string;
  // The label word (always singular — "2 conflict", never "conflicts").
  label: string;
};

const FLEET_GIT_AXES: FleetGitAxis[] = [
  {
    // Fleet-wide uncommitted-WIP count (WARDEN-766): the # of fanned agents
    // whose /api/git-status reported clean === false — the missing
    // repository-state axis in the summary bar. Reuses the sidebar's amber/
    // yellow dirty vocabulary (the ±N chip family) so "dirty" reads in the
    // same color everywhere. Only rendered when > 0 so a clean fleet stays
    // quiet. dirtyCount excludes error/loading agents (counted below), so a
    // transiently-unreachable agent is never misread as clean OR dirty.
    count: 'dirtyCount',
    color: 'text-yellow-500',
    titleTail: 'with uncommitted working-tree WIP (fanned /api/git-status across active project agents)',
    label: 'dirty',
  },
  {
    // Fleet-wide merge-conflict count (WARDEN-796): the # of fanned agents
    // BLOCKED mid-merge/rebase/cherry-pick (conflictCount > 0) — the conflict
    // axis alongside the dirty count, the one git state that means "stuck and
    // needs attention." Reuses the sidebar's rose ⚑ vocabulary (the atRisk
    // chip family) so "conflict" reads in the same color everywhere. Only
    // rendered when > 0 so a healthy fleet stays quiet. conflictCount counts
    // BLOCKED AGENTS (the mirror of dirtyCount), not total unmerged files, and
    // excludes error/loading agents (counted in errorCount), so a
    // transiently-unreachable agent is never misread as blocked.
    count: 'conflictCount',
    color: 'text-rose-500',
    titleTail: 'blocked mid-merge/rebase/cherry-pick with unmerged paths (fanned /api/git-status across active project agents)',
    label: 'conflict',
  },
  {
    // Fleet-wide behind-upstream count (WARDEN-815): the # of fanned agents
    // running on stale, behind-upstream code (behind > 0) — the staleness axis
    // alongside the dirty/conflict counts, the one git state that means "this
    // agent's base is outdated and further edits will diverge." Reuses the
    // sidebar's blue ↓ vocabulary (the behind chip family) so "behind" reads in
    // the same color everywhere. Only rendered when > 0 so a fresh fleet stays
    // quiet. behindCount counts stale AGENTS (the mirror of
    // dirtyCount/conflictCount/aheadCount), not total behind-commits, and
    // excludes error/loading agents (counted in errorCount) + null-behind
    // non-git/no-upstream cwds, so a transiently-unreachable or non-git agent
    // is never misread as stale.
    count: 'behindCount',
    color: 'text-blue-500',
    titleTail: 'behind upstream (stale — pulling re-syncs before further edits diverge; fanned /api/git-status across active project agents)',
    label: 'behind',
  },
  {
    // Fleet-wide unpushed-commits count (WARDEN-822): the # of fanned agents
    // with committed-but-unpushed work (ahead > 0) — the ahead axis alongside
    // the dirty/conflict/behind counts, surfacing the blind spot clean cannot
    // speak to: such an agent has clean === true, so WITHOUT this axis it is
    // indistinguishable from an agent fully in sync — its finished work is
    // stranded locally and invisible to the rest of the fleet. Reuses the
    // sidebar's amber ↑ vocabulary (the unpushed chip family, GitBadges.tsx) so
    // "unpushed" reads in the same color everywhere. Only rendered when > 0 so
    // a fresh fleet stays quiet. aheadCount counts stranded AGENTS (the mirror
    // of dirtyCount/conflictCount/behindCount), not total unpushed commits, and
    // excludes error/loading agents (counted in errorCount) and
    // no-upstream/in-sync agents (ahead: null / 0), so a transiently-unreachable
    // agent is never misread as stranded.
    count: 'aheadCount',
    color: 'text-amber-500',
    titleTail: "with committed-but-unpushed work (fanned /api/git-status across active project agents; stranded locally — pulling/re-syncing elsewhere won't see this work yet)",
    label: 'unpushed',
  },
  {
    // Fleet-wide stalled-HEAD count (WARDEN-847): the # of fanned agents whose
    // HEAD commit is >7d old (stalled) — the sole RECENCY axis alongside the
    // dirty/conflict/behind/unpushed STATE axes, surfacing the canonical blind
    // spot: such an agent is clean, conflict-free, in sync, AND fully pushed, so
    // WITHOUT this axis it is indistinguishable from a healthy agent — yet its
    // HEAD has gone quiet for >7d and the work may be stalled or forgotten.
    // Reuses the sidebar's sky 💤 vocabulary (the stalled chip family,
    // GitBadges.tsx) so "stalled" reads in the same color everywhere. Only
    // rendered when > 0 so a fresh fleet stays quiet. stalledCount counts
    // stalled AGENTS (the mirror of
    // dirtyCount/conflictCount/behindCount/aheadCount), not a sum, and excludes
    // error/loading agents (counted in errorCount) + null-headDate non-git /
    // no-commits cwds (Date.parse → NaN → not stalled), so a transiently-
    // unreachable or non-git agent is never misread as stalled.
    count: 'stalledCount',
    color: 'text-sky-500',
    titleTail: 'whose HEAD commit is >7d old (fanned /api/git-status across active project agents; may be silently stalled, abandoned, or rotting)',
    label: 'stalled',
  },
  {
    // Fleet-wide parked-WIP count (WARDEN-871): the # of fanned agents holding
    // `git stash`-shelved work (stashCount > 0) — the parked-WIP axis alongside
    // the dirty/conflict/behind/unpushed/stalled axes, surfacing the canonical
    // blind spot: such an agent has a clean tree (porcelain status never surfaces
    // stashes), so WITHOUT this axis it is indistinguishable from a healthy agent
    // — yet it holds easily-forgotten, drift-prone shelved WIP. Reuses the
    // sidebar's fuchsia 🗄 vocabulary (the stashed chip family, GitBadges.tsx) so
    // "stashed" reads in the same color everywhere. Only rendered when > 0 so a
    // stash-free fleet stays quiet. stashedCount counts parked-WIP AGENTS (the
    // mirror of dirtyCount/conflictCount/behindCount/aheadCount/stalledCount),
    // not a sum of stashes, and excludes error/loading agents (counted in
    // errorCount) + stashCount: null / 0 non-git / no-branch / stash-free
    // agents, so a transiently-unreachable or stash-free agent is never
    // misread as parked.
    count: 'stashedCount',
    color: 'text-fuchsia-500',
    titleTail: 'with parked git-stash WIP (fanned /api/git-status across active project agents; easily forgotten / drift-prone shelved work)',
    label: 'stashed',
  },
];

export function HealthDashboard({ onOpenChat, onClose, companionTransportEnabled }: Props) {
  const [healthData, setHealthData] = useState<HealthData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hostLabels = useHostLabels();
  // WARDEN-1426 (slice 13): the health pair — "Group agents by: Health | Host |
  // Project" (WARDEN-237/741, persisted WARDEN-468) and the per-host collapse
  // map inside Host grouping (WARDEN-500) — read from the shared store instead
  // of four props from App. This component is the pair's only reader AND only
  // writer, so the four JSX pass sites and the four Props entries are gone; the
  // setters below are the same writes the mode buttons and the per-host toggle
  // always made. Persistence is unchanged: App keeps the compile-locked
  // snapshot fields, so the ONE saveUi effect still writes both. Health stays
  // the default (DEFAULT_UI.healthGroupBy) and {} = every host expanded.
  //
  // The two `GroupMode` annotations are deliberate, not decoration: the store
  // declares its own INLINE literal union (lib/ must not import from
  // components/), so annotating here pins the two unions together — widening
  // one without the other is a compile error rather than a silent drift.
  const groupBy: GroupMode = useHealthGroupBy();
  const setGroupBy: (mode: GroupMode) => void = useSetHealthGroupBy();
  const collapsedHosts = useHealthCollapsedHosts();
  const setCollapsedHosts = useSetHealthCollapsedHosts();
  // WARDEN-1342 (slice 4): the dashboard's own timestamps (last-activity, "Last
  // updated") read the shared pref; the fleet panels + FileViewer below
  // subscribe for themselves, so the pass-through prop is gone.
  const timestampFormat = useTimestampFormat();
  // Closed-section expansion (WARDEN-245): collapsed shows the 5 most-recent dead
  // sessions; expanded shows up to 20. The true total is always surfaced so the
  // cap is never silent.
  // WARDEN-1768 (slice 61): lives on the uiStore (NOT persisted) so it survives the
  // Settings round trip (HealthDashboard unmounts while Settings is open).
  const closedExpanded = useHealthClosedExpanded();
  const setClosedExpanded = useSetHealthClosedExpanded();
  // Shared /api/hosts/status poll (singleton) — fuses per-host connectivity into
  // each host section's summary line.
  const hostStatuses = useHostStatuses();
  // Per-agent 24h activity series for the row sparklines (WARDEN-299). Fetched on
  // its own slow ~60s cadence inside the hook — explicitly NOT part of the 10s
  // /api/health poll below, so adding the sparklines is a no-op on the hot path.
  // `loading` + `error` are threaded to the two fleet-wide panels below so their
  // empty states can tell "still fetching" from "fetched, and it failed"
  // — `series == null` alone conflates the two, which is how both panels used to
  // render "Loading…" forever on a persistently failing endpoint (WARDEN-1078).
  const {
    series: activitySeries,
    loading: activityLoading,
    error: activityError,
  } = useActivitySeries();
  // Per-agent uncommitted-WIP fan (WARDEN-766): fans /api/git-status across the
  // eligible fleet (active project agents) and lifts { statusByKey, dirtyCount,
  // errorCount, refresh, loading } so BOTH the per-row WipChip in renderAgent AND the
  // summary-bar "N dirty" count read off the ONE fan-out. Fetch-on-mount + manual ↻
  // only (no auto-poll) — see useFleetGitStatus. `healthData?.agents ?? []` no-ops
  // cleanly before the first /api/health response (empty eligible → empty result).
  const fleetGit = useFleetGitStatus(healthData?.agents ?? []);

  // Multi-select batch-kill (WARDEN-371): the set of selected agent ids, held at
  // the dashboard level so it can span every health/host section. Mirrors the
  // sidebar's WARDEN-328 surface (selectedIds Set keyed by `key || id`). Selection
  // is a NON-persisted uiStore session fact (WARDEN-1778, slice 63) — no
  // persistence/serialization boundary touched, but it survives the Settings
  // round trip that unmounts this dashboard. A restart starts empty.
  const selectedIds = useHealthSelectedIds();
  const toggleSelect = useToggleHealthSelected();
  const toggleGroup = useToggleHealthGroup();
  const setHealthSelected = useSetHealthSelected();
  const clearSelection = useClearHealthSelected();
  const [killOpen, setKillOpen] = useState(false);
  const [interruptOpen, setInterruptOpen] = useState(false);
  // Fleet-recent-commits FileViewer target (WARDEN-757). Set by the feed's
  // onOpenFile callback; drives the single FileViewer mounted below. Transient
  // dialog state — NOT persisted / serialized to /api/config — mirroring
  // ChatSidebar's fileTarget (also a local useState, never in the persisted UI
  // state). Null = the viewer is closed.
  const [fileTarget, setFileTarget] = useState<{ chatId: string; path: string } | null>(null);
  // WARDEN-882 — the host targeted by the per-host "Remove companion" action
  // (Host mode header). Null = the confirm dialog is closed; the host string is
  // the raw config host (the same value /api/companion/uninstall takes).
  // `removingCompanion` drives the confirm button's spinner (mirrors KillDialog's
  // killing state). Transient dialog state — never persisted.
  const [removeCompanionHost, setRemoveCompanionHost] = useState<string | null>(null);
  const [removingCompanion, setRemovingCompanion] = useState(false);
  // Result-toast gating reuses the sidebar's notifyChatOps pref so a kill from
  // Fleet Health has the SAME UX contract (toast on success / partial failure) as
  // a kill from the sidebar (WARDEN-328).
  const readNotificationPrefs = useNotificationPrefsReader();

  // Toggle one agent's membership; select/clear a whole group via the pure tri-
  // state reducer (so the section/host select-all checkboxes share one tested
  // helper). clearSelection empties the set (the action bar's "Clear" + the
  // post-kill reset).

  const fetchHealth = async () => {
    setLoading(true);
    setError(null);
    try {
      // WARDEN-1144: this read gates `loading` (the ↻ spinner and the
      // "Loading health data…" body), so it is bounded by the shared deadline on
      // the POLLER policy — no retries, deadline < the 10s period. This is the
      // case that set the bar for that policy: on the one-shot defaults a stalled
      // tick would spend 3 x 8s ~= 24s of attempts inside a 10s window, stacking
      // three ticks' worth of requests against an already-blocked event loop. The
      // next tick IS the retry.
      const res = await fetchBounded('/api/health', HEALTH_FETCH_OPTS);
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      }
      const data = await res.json();
      setHealthData(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  // Poll every 10 seconds for updates, gated on Page Visibility so a backgrounded
  // tab never burns a fetch + render churn every tick — the same invariant every
  // other poller in the app applies. On regaining focus we poll immediately
  // because state may be stale while hidden. (WARDEN-661; consolidated WARDEN-753.)
  useVisiblePoller(fetchHealth, HEALTH_POLL_MS, []);

  // Bucket agents by host, order hosts degraded-first (offline → critical-heavy
  // → agent count), and order each host's agents healthy → critical. Pure inputs
  // → cheap to memoize; recomputes when the catalog or connectivity changes.
  //
  // The `.sort()` calls mutate `groups` and each `g.agents` in place. That is safe
  // because `groupByHost` returns fresh arrays it owns (a new array per host, plus
  // a spread copy of EMPTY_COUNTS) — nothing here is shared with `healthData`, so
  // sorting cannot mutate the wire data. If `groupByHost` is ever refactored to
  // return shared/cached arrays, these sorts would silently mutate them — revisit.
  const hostGroups = useMemo<HostHealthGroup[]>(() => {
    if (!healthData) return [];
    const groups = groupByHost(healthData.agents);
    groups.sort((a, b) => compareHostGroups(a, b, (h) => hostStatuses[h]?.status));
    for (const g of groups) {
      g.agents.sort(
        (a, b) => healthRank(normalizeHealthState(a.healthState)) - healthRank(normalizeHealthState(b.healthState)),
      );
    }
    return groups;
  }, [healthData, hostStatuses]);

  // Bucket agents by project, order projects degraded-first, and order each
  // project's agents healthy → critical (WARDEN-741, extended WARDEN-780). The
  // project ladder now fuses the connectivity axis: a project with ANY agent on
  // an offline host sorts to the top (the #1 Host-mode signal), above
  // critical-heavy — so a coordinator in Project mode spots a partly-down
  // project without switching modes. Connectivity comes from the same
  // hostStatuses poll Host mode uses (no new fetch), which is why hostStatuses
  // is now a memo dep: the sort depends on it. Pure inputs → cheap to memoize;
  // recomputes when the catalog OR connectivity changes. The in-place `.sort()`
  // is safe for the same reason as hostGroups: groupByProject returns fresh
  // arrays it owns.
  const projectGroups = useMemo<ProjectHealthGroup[]>(() => {
    if (!healthData) return [];
    const groups = groupByProject(healthData.agents);
    groups.sort((a, b) => compareProjectGroups(a, b, (h) => hostStatuses[h]?.status));
    for (const g of groups) {
      g.agents.sort(
        (a, b) => healthRank(normalizeHealthState(a.healthState)) - healthRank(normalizeHealthState(b.healthState)),
      );
    }
    return groups;
  }, [healthData, hostStatuses]);

  // Per-agent 24h activity series for the row sparklines (WARDEN-299), joined by
  // `container`. Memoized on `activitySeries` ONLY — the 24h series refreshes on
  // its own ~60s cadence, so the 10s /api/health tick above never recomputes it
  // (the per-row join is a plain O(1) Map lookup in AgentRow.tsx's renderSparkline).
  const agentActivity = useMemo(() => buildAgentActivity(activitySeries), [activitySeries]);
  const bucketCount = activitySeries?.buckets.length ?? 0;

  // Resolve the selected ids to their chats (in catalog order) for the confirm
  // dialog's target list. Mirrors the sidebar's selectedChats memo: stale ids
  // (an agent that died between selecting and killing) simply don't resolve and
  // are absent from the list — but they are STILL killed via runKillFanout (which
  // iterates selectedIds, not this list) so a dead target is reported as a
  // per-agent failure rather than silently dropped.
  const selectedChats = useMemo(
    () => (selectedIds.size === 0 ? [] : (healthData?.agents ?? []).filter((a) => selectedIds.has(agentIdOf(a)))),
    [healthData, selectedIds],
  );

  // The ids of every agent currently RENDERED in the dashboard — the action
  // bar's "All" selects exactly these. Health mode respects the Closed-section
  // bounding (5 collapsed / 20 expanded); host mode respects per-host collapse —
  // so "All" never silently targets an agent you can't see. KEEP THIS IN SYNC
  // with the per-section `shown` computation in the JSX below (they apply the
  // same bounding/collapse rules); a future refactor could lift both into one
  // `useRenderedSections` hook.
  const renderedIds = useMemo(() => {
    if (!healthData) return [] as string[];
    if (groupBy === 'health') {
      const ids: string[] = [];
      for (const section of HEALTH_SECTION_ORDER) {
        const agents = healthData.groups[section];
        if (!agents || agents.length === 0) continue;
        const isClosed = section === 'closed';
        const limit = isClosed
          ? (closedExpanded ? CLOSED_EXPANDED_LIMIT : CLOSED_COLLAPSED_LIMIT)
          : agents.length;
        const shown = isClosed ? [...agents].sort(byRecencyDesc).slice(0, limit) : agents;
        for (const a of shown) ids.push(agentIdOf(a));
      }
      return ids;
    }
    if (groupBy === 'project') {
      // Project mode has no per-section collapse/bounding — every group's agents
      // render, so "All" targets exactly the rendered project-section agents.
      return projectGroups.flatMap((g) => g.agents.map(agentIdOf));
    }
    // Host mode: only non-collapsed hosts' agents are rendered.
    return hostGroups.flatMap((g) => (collapsedHosts[g.host] ? [] : g.agents.map(agentIdOf)));
  }, [healthData, groupBy, closedExpanded, collapsedHosts, hostGroups, projectGroups]);

  // Per-agent row layer lives in fleet-health/AgentRow.tsx (WARDEN-1942); the
  // nine bindings its bodies close over are threaded through this ctx.
  const ctx = { selectedIds, toggleSelect, onOpenChat, fleetGit, hostLabels, timestampFormat, agentIdOf, agentActivity, bucketCount };
  const renderAgent = (agent: Chat, showHost: boolean) => renderAgentRow(agent, showHost, ctx);

  // Fan a KILL out to every selected agent via the shared runKillFanout
  // (@/lib/kill; the same helper the sidebar's WARDEN-328 path uses), supplying
  // this surface's reconciliation as `onSettled`: re-discover each distinct host
  // so dead tmux sessions drop from the server cache, then re-read health. The
  // dashboard owns its own fetches (no App-level refresh/discover props), so this
  // is self-contained — /api/discover per host mirrors the sidebar's
  // onDiscoverHost, and fetchHealth() mirrors onRefresh. The result toast +
  // selection clear stay here (view concerns). runKillFanout never throws;
  // partial failure is encoded in the summary.
  const handleKillSelected = async () => {
    const ids = Array.from(selectedIds);
    const nameOf = (id: string) => {
      const a = (healthData?.agents ?? []).find((c) => agentIdOf(c) === id);
      return a ? displayName(a) : id;
    };
    const summary = await runKillFanout(ids, nameOf, async () => {
      const hosts = new Set<string>();
      selectedChats.forEach((c) => { if (c.host) hosts.add(c.host); });
      await Promise.all(
        Array.from(hosts).map((h) =>
          // WARDEN-1144: this reconcile runs inside the KillDialog's `busy` gate
          // (runKillFanout awaits onSettled), so an unbounded discover would hold
          // the dialog's spinner with nothing left to clear it. One-shot shape →
          // the primitive's defaults.
          fetchBounded(`/api/discover?host=${encodeURIComponent(h)}`).catch(() => {}),
        ),
      );
      await fetchHealth();
    });
    showFanoutToast(formatKillToast(summary), readNotificationPrefs().notifyChatOps);
    // The kill's intent is discharged — clear the selection regardless of outcome.
    clearSelection();
    return summary;
  };

  // Fan a CONTROL KEY (Ctrl-C / Esc) out to every selected agent via the shared
  // runKeySendFanout (@/lib/keysend; the non-destructive sibling of runKillFanout,
  // WARDEN-492). Interrupt is the safe middle ground that DOES belong on a health
  // surface: a human can non-destructively stop the stuck/erroring agents Fleet
  // Health surfaces without killing them (broadcast-by-health stays out of scope).
  //
  // runKeySendFanout never throws; partial failure is encoded in the summary. The
  // dashboard owns its own fetches, but interrupt is NON-DESTRUCTIVE — no session
  // is destroyed, so (unlike kill) there is nothing to reconcile: a signaled agent
  // reclassifies off stuck/erroring on the next health/classify tick and reflects
  // here then. The result toast + selection clear stay here (view concerns).
  const handleInterruptSelected = async (key: string) => {
    const ids = Array.from(selectedIds);
    const nameOf = (id: string) => {
      const a = (healthData?.agents ?? []).find((c) => agentIdOf(c) === id);
      return a ? displayName(a) : id;
    };
    const summary = await runKeySendFanout(ids, key, nameOf);
    showFanoutToast(formatKeySendToast(summary, key), readNotificationPrefs().notifyChatOps);
    // The interrupt's intent is discharged — clear the selection regardless of outcome.
    clearSelection();
    return summary;
  };

  // Remove warden's auto-bootstrapped companion binary from a remote host on
  // request (WARDEN-882 — the Removability outcome of roadmap WARDEN-270). The
  // write/action sibling of the kill path above: where that stops an agent's
  // tmux session, this takes warden's own companion binary off the host. POSTs
  // {host} to /api/companion/uninstall (the same {ok}/{error} shape /api/kill
  // serves), then toasts the result and refreshes both host surfaces: the
  // /api/hosts/status poll (so the row's CompanionIndicator reflects the
  // removal) and /api/health (the agent rows). Never throws — failure is
  // encoded as a toast.
  // The companion serves REMOTE hosts only, and the affordance is rendered only
  // when companionTransportEnabled is on (the gate every companion surface uses).
  const handleRemoveCompanion = async (host: string) => {
    setRemovingCompanion(true);
    try {
      const r = await fetch('/api/companion/uninstall', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ host }),
      });
      // The verdict is `r.ok` ALONE (WARDEN-1094). The route's only 2xx is
      // res.json({ok:true}), emitted after uninstallCompanion() already
      // succeeded, and every failure leg is a 400/500 carrying {error} — so the
      // body tells us nothing the status does not. Reading it as part of the
      // guard could only get the verdict WRONG: fetch resolves on headers, so a
      // 200 whose body truncates mid-stream parses to {}, and the old
      // `r.ok && body.ok` sent a provably-successful removal down the failure
      // leg — toasting "HTTP 200", leaving the confirm dialog open, and skipping
      // the refreshes the comment below exists to guarantee. This mirrors the
      // /api/kill sibling declared above, runFanout in lib/fanout.ts, which
      // likewise gates on r.ok and lets the body inform only the error string.
      if (r.ok) {
        // WARDEN-1475 — the removal is now DURABLE: the backend records the
        // host on the persisted companionExcludedHosts list so the 60s
        // lifecycle tick cannot silently re-install the binary. Say so, and
        // say where to reverse it — a bare "Removed" would leave the operator
        // unable to find the one gesture that undoes it.
        toast.success(`Removed companion from ${hostLabelFor(host, hostLabels) || host}`, {
          description: 'Added to "Companion excluded hosts" (Settings → Performance) so it is not re-installed. This host now uses the default SSH path.',
        });
        setRemoveCompanionHost(null);
        // Reflect the removal immediately. The host-status surface that carries
        // the per-host companion field — and so feeds the row's WARDEN-878
        // CompanionIndicator — is /api/hosts/status (polled by useHostStatuses),
        // NOT /api/health: the backend clears the host's companionStatus entry
        // during uninstall, and refreshHostStatuses() re-reads that surface so the
        // indicator flips to "inactive" (companion absent) at once instead of
        // lagging up to 30s for the next poll. fetchHealth() refreshes the
        // separate /api/health agent rows in parallel.
        await Promise.all([fetchHealth(), refreshHostStatuses()]);
      } else {
        // Failure leg only: here the body is genuinely optional — a 4xx/5xx may
        // carry {error}, or may be a gateway's HTML, so the .catch fallback to
        // `HTTP ${r.status}` is the legitimate use of this pattern (WARDEN-89).
        const body = await r.json().catch(() => ({}));
        toast.error(`Failed to remove companion from ${hostLabelFor(host, hostLabels) || host}`, {
          description: body.error || `HTTP ${r.status}`,
        });
      }
    } catch (e) {
      toast.error(`Failed to remove companion from ${hostLabelFor(host, hostLabels) || host}`, {
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setRemovingCompanion(false);
    }
  };

  // ONE shared menu body for the two bare chrome surfaces — the title row and the
  // summary bar (WARDEN-1739) — so the two triggers cannot drift. Agent rows and
  // group headers keep their own menus; nothing here touches those blocks.
  const fleetChromeMenu = (
    <ContextMenuContent>
      <ContextMenuItem
        disabled={loading || fleetGit.loading}
        onSelect={() => { void fetchHealth(); fleetGit.refresh(); }}
      >
        Refresh
      </ContextMenuItem>
      {groupBy !== 'host' && <ContextMenuItem onSelect={() => setGroupBy('host')}>Group by Host</ContextMenuItem>}
      {groupBy !== 'project' && <ContextMenuItem onSelect={() => setGroupBy('project')}>Group by Project</ContextMenuItem>}
      {groupBy !== 'health' && <ContextMenuItem onSelect={() => setGroupBy('health')}>Group by Health</ContextMenuItem>}
      <ContextMenuItem
        disabled={!healthData}
        onSelect={() => {
          if (!healthData) return;
          copyWithToast(formatFleetSummaryText({ summary: healthData.summary, axes: FLEET_GIT_AXES, git: fleetGit, errorCount: fleetGit.errorCount }));
        }}
      >
        Copy fleet summary
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem onSelect={onClose}>Close panel</ContextMenuItem>
    </ContextMenuContent>
  );

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Header */}
      <ContextMenu>
      <ContextMenuTrigger asChild>
      <div className="flex items-center gap-2 px-3 py-2 border-b shrink-0">
        <span className="font-semibold tracking-wide text-sm">Fleet Health</span>
        <div className="ml-auto flex items-center gap-1.5">
          {/* Group-by toggle (WARDEN-237): Health (default, no regression) / Host /
              Project (WARDEN-741). Three shadcn Buttons in a labelled group — the
              active option uses variant="secondary" so the selection reads at a
              glance, and size="xs" supplies the compact sizing (replacing the old
              magic-number px-1.5 py-0.5 text-[10px]). */}
          <div
            className="flex items-center rounded-md border border-border overflow-hidden"
            role="group"
            aria-label="Group agents by"
          >
            <Button
              variant={groupBy === 'health' ? 'secondary' : 'ghost'}
              size="xs"
              aria-pressed={groupBy === 'health'}
              onClick={() => setGroupBy('health')}
              title="Group agents by health state"
              className="rounded-none"
            >Health</Button>
            <Button
              variant={groupBy === 'host' ? 'secondary' : 'ghost'}
              size="xs"
              aria-pressed={groupBy === 'host'}
              onClick={() => setGroupBy('host')}
              title="Group agents by host, with connectivity + health distribution"
              className="rounded-none"
            >Host</Button>
            {/*
              Project grouping (WARDEN-741): the 3rd group-by axis for a human
              running multiple projects (warden + warden-telemetry + …). Mirrors
              the Health/Host toggles exactly so the 3-way control reads as one
              set. Selecting it buckets the fleet into per-project sections below.
            */}
            <Button
              variant={groupBy === 'project' ? 'secondary' : 'ghost'}
              size="xs"
              aria-pressed={groupBy === 'project'}
              onClick={() => setGroupBy('project')}
              title="Group agents by project, with per-health-state distribution"
              className="rounded-none"
            >Project</Button>
          </div>
          {/* Header ↻ (WARDEN-766): composed to refresh BOTH health AND the per-agent
              git-status fan. The git fan has no dedicated panel header of its own (it
              is distributed — a per-row WipChip + the summary-bar count), so the fleet
              ↻ is the natural place to re-pull it; a coordinator pressing ↻ expects
              "refresh the fleet view," which now includes repository state. This does
              NOT add an auto-poll: the 10s /api/health interval below calls fetchHealth
              directly (not this handler), so the N-fetch git fan still fires ONLY on
              mount / membership change / this manual ↻ — useFleetGitStatus's no-auto-
              poll contract is preserved. FleetRecentCommits / FleetActivityHeatmap
              keep their OWN per-panel ↻ (each is a discrete collapsible panel with a
              header); the git fan is not, so it rides this one. */}
          <button
            className="text-xs text-muted-foreground hover:text-foreground active:scale-95 transition-all duration-150 ease-out"
            onClick={() => { void fetchHealth(); fleetGit.refresh(); }}
            disabled={loading || fleetGit.loading}
            title="refresh fleet health + per-agent git status"
          >
            {loading || fleetGit.loading ? '…' : '↻'}
          </button>
          <button className="text-xs text-muted-foreground hover:text-foreground active:scale-95 transition-all duration-150 ease-out" onClick={onClose}>
            ×
          </button>
        </div>
      </div>
      </ContextMenuTrigger>
      {fleetChromeMenu}
      </ContextMenu>

      {/* Summary Bar */}
      {healthData && (
        <ContextMenu>
        <ContextMenuTrigger asChild>
        <div className="px-3 py-2 border-b bg-muted/30">
          {/* flex-wrap, not a single line (WARDEN-1068): this panel is pinned to a
              fixed HEALTH_WIDTH (320px, web/src/lib/layout.ts) inside an
              overflow-hidden section, so the row has ~295px of usable width and no
              viewport-responsive slack. The six health chips alone measure ~324px, and
              a 2-/3-digit fleet or the conditional git chips below widen it further —
              without wrapping the trailing chip is silently clipped mid-word ("6 unkno")
              with no ellipsis or scroll. Wrapping grows the bar by a line instead of
              hiding a count the user is meant to reconcile against "N agents". */}
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="font-medium">{healthData.summary.total} agents</span>
            <span className="text-muted-foreground">·</span>
            <span className="text-green-500">{healthData.summary.healthy} healthy</span>
            <span className="text-yellow-500">{healthData.summary.warning} warning</span>
            <span className="text-red-500">{healthData.summary.critical} critical</span>
            <span className="text-gray-500">{healthData.summary.idle} idle</span>
            <span className="text-gray-500">{healthData.summary.closed} closed</span>
            <span className="text-muted-foreground">{healthData.summary.unknown} unknown</span>
            {/* The six git axes, rendered by ONE loop (WARDEN-1228): each
                FLEET_GIT_AXES entry contributes its separator dot + coloured
                count span when its count is > 0 (a zero axis renders nothing,
                keeping a healthy fleet quiet), in the array's
                severity-descending order — stated once, above the set. */}
            {FLEET_GIT_AXES.map((axis) => {
              const n = fleetGit[axis.count];
              return n > 0 ? (
                <Fragment key={axis.count}>
                  <span className="text-muted-foreground">·</span>
                  <span
                    className={axis.color}
                    title={`${n} agent${n === 1 ? '' : 's'} ${axis.titleTail}`}
                  >
                    {n} {axis.label}
                  </span>
                </Fragment>
              ) : null;
            })}
            {/* Honest partial-failure note (WARDEN-89): a per-agent git-status fetch
                that failed (host unreachable / non-ok HTTP / an HTTP-200 `error` body)
                is surfaced here rather than read as a false clean/empty — mirrors
                FleetRecentCommits' "N unreachable" note. Only rendered when > 0. */}
            {fleetGit.errorCount > 0 && (
              <span
                className="text-muted-foreground/70"
                title={`${fleetGit.errorCount} agent${fleetGit.errorCount === 1 ? '' : 's'} whose /api/git-status fan-out failed (counted, not read as clean)`}
              >
                · {fleetGit.errorCount} unreachable
              </span>
            )}
          </div>
        </div>
        </ContextMenuTrigger>
        {fleetChromeMenu}
        </ContextMenu>
      )}

      {/* Error State */}
      {error && (
        <div className="p-4 text-center text-xs text-red-500">
          Failed to load health data: {error}
        </div>
      )}

      {/* Loading State */}
      {loading && !healthData && (
        <div className="p-4 text-center text-xs text-muted-foreground">
          Loading health data…
        </div>
      )}

      {/* Agent catalog */}
      {healthData && (
        <ScrollArea className="flex-1 min-h-0 health-fleet-scroll">
          <div className="p-2 flex flex-col gap-3 min-w-0">
            {/*
              Fleet-wide 24h activity heatmap (WARDEN-532). A collapsible overview
              above the agent sections, consuming the SAME in-scope activitySeries
              the per-row sparklines use (the 60s useActivitySeries hook) + the
              full fleet agents list. Sits as the first item so a returning human
              scans the fleet's behavior pattern before drilling into rows; it
              scrolls with the list (not pinned) so expanding it never eats the
              viewport. Pure additive — no new fetch/hook/state lifted here. */}
            <FleetActivityHeatmap
              series={activitySeries}
              agents={healthData.agents}
              loading={activityLoading}
              error={activityError}
              onOpenChat={onOpenChat}
            />
            {/*
              Fleet-wide 24h per-agent STATE timeline (WARDEN-788). The orthogonal
              complement of the heatmap above: where that plots event VOLUME, this
              plots each agent's classified STATE per hourly bucket (colored +
              glyphed segments). An agent oscillating stuck→active→stuck shows
              visibly distinct repeating segments here — a pattern the volume
              heatmap and the point-in-time snapshot cannot reveal. Pure additive:
              consumes the SAME in-scope activitySeries the heatmap does (its
              stateSeries field, delivered by the existing 60s useActivitySeries
              poll — no new fetch/poll/SSH) + the same fleet agents list. Sits
              directly under the heatmap so the two fleet-wide overviews share an
              axis and a scan order (behavior volume, then behavior pattern). */}
            <FleetStateTimeline
              series={activitySeries}
              agents={healthData.agents}
              loading={activityLoading}
              error={activityError}
              onOpenChat={onOpenChat}
            />
            {/*
              Fleet-wide recent-commits feed (WARDEN-597). The commit-history analog
              of the heatmap above: fans the per-agent /api/git-log?limit=N across the
              same in-scope fleet agents and merges every returned commit by committer
              epoch into one time-sorted "what the fleet just shipped" list. Sits right
              under the activity matrix so a returning human scans behavior pattern,
              then the actual shipments, before drilling into rows. Clicking a row
              opens that commit's diff via /api/git-show. Pure additive — no new
              endpoint/poll/SSH; fetch-on-mount + manual refresh (introduces its own
              N-fetch fan-out, so it does NOT ride the 60s series poll like the heatmap).
              WARDEN-757: onOpenFile threads the feed's open-file affordance into the
              dashboard's FileViewer so a coordinator can READ any just-shipped file
              (read/blame/history/at-commit snapshot) without leaving the fleet view —
              closing the asymmetry where the per-agent GitBadges popover could open a
              committed file but the fleet feed (built to roll those lists into one)
              could only inline-diff it. The callback carries the row's chatId so the
              single FileViewer reads from the CORRECT agent's repo. */}
            <FleetRecentCommits agents={healthData.agents} onOpenFile={(chatId, path) => setFileTarget({ chatId, path })} />
            {renderAgentGroups({ groupBy, healthData, closedExpanded, setClosedExpanded, selectedIds, toggleGroup, renderAgent, projectGroups, hostGroups, hostStatuses, hostLabels, collapsedHosts, setCollapsedHosts, companionTransportEnabled, setRemoveCompanionHost })}
          </div>
        </ScrollArea>
      )}

      {/* Selection action bar (WARDEN-371): appears only while ≥1 agent is
          selected. "All" selects every agent currently rendered in the dashboard
          (renderedIds — respects the Closed-section bounding + host collapse);
          "Clear" empties the selection; "Kill N…" opens the confirm gate.
          shrink-0 so it pins at the bottom while the fleet list scrolls above it. */}
      {selectedIds.size > 0 && (
        <SelectionActionBar
          count={selectedIds.size}
          onSelectAll={() => setHealthSelected(renderedIds)}
          onClear={clearSelection}
          onInterrupt={() => setInterruptOpen(true)}
          onKill={() => setKillOpen(true)}
          selectedNames={selectedChats.map((c) => displayName(c))}
        />
      )}

      {/* The confirm-and-stop safety gate (reused unchanged from WARDEN-328).
          Shows the resolved target list; the actual fan-out + result toast +
          reconcile live in handleKillSelected. Nothing is stopped until the
          destructive Confirm. */}
      <KillDialog
        open={killOpen}
        onOpenChange={setKillOpen}
        targets={selectedChats}
        onKill={handleKillSelected}
      />

      {/* The confirm-and-interrupt safety gate (WARDEN-492). Non-destructive: the
          session + scrollback survive, unlike Kill. The fan-out + result toast
          live in handleInterruptSelected; nothing is sent until the Confirm. */}
      <KeySendDialog
        open={interruptOpen}
        onOpenChange={setInterruptOpen}
        targets={selectedChats}
        onSend={handleInterruptSelected}
      />

      {/* WARDEN-882 — per-host "Remove companion" destructive confirm. Reuses the
          shared ConfirmDialog (shadcn Dialog + Button — WARDEN-68 Rule 1/7: a
          short, bounded confirmation is exactly the ≤200-symbol modal case).
          Nothing is removed until the destructive Confirm; Cancel/Esc/overlay
          just close. Spins while the uninstall runs (mirrors KillDialog's
          killing state). */}
      <ConfirmDialog
        open={removeCompanionHost !== null}
        onOpenChange={(o) => { if (!removingCompanion) setRemoveCompanionHost(o ? removeCompanionHost : null); }}
        title={`Remove companion from ${removeCompanionHost ? (hostLabelFor(removeCompanionHost, hostLabels) || removeCompanionHost) : ''}?`}
        description={
          <>
            Removes warden&apos;s companion binary from <code className="bg-muted px-1 rounded">{removeCompanionHost ?? ''}</code> and stops its cached SSH connection. <code className="bg-muted px-1 rounded">~/.warden</code> is removed only if empty — your other files there are kept.
            {/* WARDEN-1475 — say what the removal now DOES, because it changed
                meaning. It used to be an in-memory teardown the next 60s
                lifecycle tick silently undid; it is now durable, which means it
                adds the host to the persisted "Companion excluded hosts" list
                and the host rides the default SSH path until you take it off.
                A confirm that did not say so would hide both halves: that the
                removal holds, and where to reverse it. */}
            {' '}The host is added to <strong>Companion excluded hosts</strong> (Settings → Performance) so warden does not re-install it on the next poll — its operations keep working over the default SSH path. Remove it from that list to install the companion again.
          </>
        }
        confirmLabel={removingCompanion ? 'Removing…' : 'Remove'}
        destructive
        onConfirm={() => { if (removeCompanionHost && !removingCompanion) void handleRemoveCompanion(removeCompanionHost); }}
      />

      {/* Fleet-recent-commits FileViewer (WARDEN-757). Mounted as a sibling of the
          dialogs above and driven by the local fileTarget state set by the feed's
          onOpenFile callback. Mirrors ChatSidebar's mount verbatim (ChatSidebar's
          fileTarget is the established pattern): reuses /api/read-file, /api/git-blame,
          and /api/git-log — the SAME routes ChatSidebar's FileViewer already exercises,
          so NO backend change. The chatId comes from the feed row's agent key
          (threaded through onOpenFile), so read/blame/history/at-commit-snapshot all
          resolve against the CORRECT agent's repo — not the focused pane. viewMode +
          onViewModeChange are the App-owned rendered/source pref shared with
          ChatSidebar's FileViewer; onNavigate is wired so breadcrumb / sibling
          navigation works identically to the sidebar viewer. */}
      <FileViewer
        chatId={fileTarget?.chatId ?? ''}
        filePath={fileTarget?.path ?? ''}
        open={!!fileTarget}
        onNavigate={(p) => setFileTarget((prev) => (prev ? { ...prev, path: p } : prev))}
        onOpenChange={(o) => { if (!o) setFileTarget(null); }}
      />

      {/* Timestamp */}
      {healthData && (
        <div className="px-3 py-1 border-t text-[10px] text-muted-foreground text-center">
          Last updated: {formatTimestamp(healthData.timestamp, timestampFormat)}
        </div>
      )}
    </div>
  );
}
