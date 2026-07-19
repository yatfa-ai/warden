import { useState, useMemo, Fragment } from 'react';
import { toast } from 'sonner';
import { ScrollArea } from '@/components/ui/scroll-area';
import type { HealthData, Chat } from '@/lib/types';
import type { FleetGitStatusSlice } from '@/lib/gitStateSummary';
import {
  HealthState,
  getHealthIcon,
  formatHealthState,
  normalizeHealthState,
  groupByHost,
  compareHostGroups,
  groupByProject,
  compareProjectGroups,
  summarizeProjectHosts,
  resourceTone,
  summarizeHostLoad,
  type HealthStateValue,
  type HostHealthGroup,
  type ProjectHealthGroup,
} from '@/lib/healthUtils';
import { StatusDot, type StatusTone } from '@/components/StatusDot';
import { Sparkline } from '@/components/Sparkline';
import { FleetActivityHeatmap } from '@/components/FleetActivityHeatmap';
import { FleetRecentCommits } from '@/components/FleetRecentCommits';
import { FileViewer } from '@/components/FileViewer';
import { formatTimestamp, type TimestampFormat } from '@/lib/formatTimestamp';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { KillDialog } from './KillDialog';
import { KeySendDialog } from './KeySendDialog';
import { SelectionActionBar } from './sidebar/SidebarBits';
import { DiffStatChip } from './sidebar/DiffStatChip';
import { formatKillToast, runKillFanout } from '@/lib/kill';
import { formatKeySendToast, runKeySendFanout } from '@/lib/keysend';
import { isSelectedAll, toggleGroupSelection } from '@/lib/selection';
import { useHostStatuses } from '@/lib/useHostStatuses';
import { useActivitySeries } from '@/lib/useActivitySeries';
import { useFleetGitStatus } from '@/lib/useFleetGitStatus';
import { useNotificationPrefs } from '@/lib/useNotificationPrefs';
import { useVisiblePoller } from '@/lib/useVisiblePoller';
import { buildAgentActivity, selectAgentSparkline } from '@/lib/agentSparkline';
import { displayName, hostLabelFor } from '@/lib/chatDisplay';
import { formatTokens } from '@/lib/formatTokens';
import { useHostLabels } from '@/lib/hostLabels';
import { cn } from '@/lib/utils';

interface Props {
  onOpenChat: (id: string) => void;
  onClose: () => void;
  // Timestamp format pref (WARDEN-213): routes the fleet last-activity + "Last
  // updated" times through the shared formatTimestamp helper. Pure client-side.
  timestampFormat: TimestampFormat;
  // FileViewer rendered/source view mode (WARDEN-757): App owns this as a
  // persisted pref (the SAME one ChatSidebar's FileViewer honors, WARDEN-480) so
  // the choice is shared across both surfaces and survives opens/reloads.
  // Read-only here except for the change handler — no new App state, just
  // threading the existing setter.
  fileViewerViewMode: 'rendered' | 'source';
  onFileViewerViewModeChange: (mode: 'rendered' | 'source') => void;
  // Follow live-update cadence for the fleet FileViewer (WARDEN-749). The SAME
  // already-resolved web-safe interval App owns for ChatSidebar's FileViewer
  // (resolvePollIntervalMs at the source) so Follow shares the dashboard's
  // cadence rather than hardcoding its own. WARDEN-757 mounted the fleet
  // FileViewer "mirroring ChatSidebar's mount verbatim" but OMITTED this prop
  // (FileViewerProps.pollIntervalMs is required since WARDEN-749) — surfaced as a
  // tsc error when this branch rebased past WARDEN-749/757; threaded here to keep
  // the build green and complete the mirror the WARDEN-757 commit intended.
  pollIntervalMs: number;
  // "Group agents by: Health | Host | Project" mode (WARDEN-237; Project added in
  // WARDEN-741). Lifted to App + persisted (WARDEN-468) so the toggle survives a
  // Warden restart — App owns the single source of truth and this is read-only
  // here except for the change handler. Health stays the default
  // (DEFAULT_UI.healthGroupBy) so the dashboard is unchanged unless a human opts
  // into the per-host or per-project view.
  groupBy: GroupMode;
  onGroupByChange: (mode: GroupMode) => void;
  // Per-host expand/collapse state inside Host grouping (WARDEN-237). Lifted to
  // App + persisted (WARDEN-500) so which hosts a human collapses survives a
  // Warden restart — App owns the single source of truth and this is read-only
  // here except for the change handler. Completes the persistence WARDEN-468
  // started for the grouping toggle itself. Default {} = every host expanded.
  collapsedHosts: Record<string, boolean>;
  onCollapsedHostsChange: (next: Record<string, boolean>) => void;
}

// Closed sits between idle and unknown: a dead session is non-critical and less
// actionable than an idle (potentially waking) one, so it sinks toward the tail.
// (WARDEN-245)
const HEALTH_SECTION_ORDER = ['healthy', 'warning', 'critical', 'idle', 'closed', 'unknown'] as const;

const SECTION_LABELS: Record<string, { title: string; color: string; icon: string }> = {
  healthy: { title: 'Healthy Agents', color: 'text-green-500', icon: '●' },
  warning: { title: 'Warning Agents', color: 'text-yellow-500', icon: '◐' },
  critical: { title: 'Critical Agents', color: 'text-red-500', icon: '●' },
  idle: { title: 'Idle Sessions', color: 'text-gray-500', icon: '○' },
  closed: { title: 'Closed Sessions', color: 'text-gray-500', icon: '■' },
  unknown: { title: 'Unknown Status', color: 'text-muted-foreground', icon: '·' }
};

// Per-state text colors for the host-mode distribution line. Mirrors the fleet
// summary bar's -500 shades exactly so a per-host line reads as a per-host copy
// of the fleet summary, not a new color vocabulary.
const HEALTH_DIST_COLOR: Record<HealthStateValue, string> = {
  [HealthState.HEALTHY]: 'text-green-500',
  [HealthState.WARNING]: 'text-yellow-500',
  [HealthState.CRITICAL]: 'text-red-500',
  [HealthState.IDLE]: 'text-gray-500',
  [HealthState.CLOSED]: 'text-gray-500',
  [HealthState.UNKNOWN]: 'text-muted-foreground',
};

// The Closed section is bounded so dead catalog sessions can no longer flood the
// panel: 5 rows collapsed, 20 expanded max, with the true total always visible
// so the cap is never silent. (WARDEN-245)
const CLOSED_COLLAPSED_LIMIT = 5;
const CLOSED_EXPANDED_LIMIT = 20;

export type GroupMode = 'health' | 'host' | 'project';

// Compact "used" portion of a docker-stats MemUsage string like
// "310.2MiB / 2GiB" → "310.2MiB" (everything before the first ' / '). Returns ''
// when there's nothing to show, including docker's `--` placeholder (emitted for
// a container too new to have a sample) so a fresh container renders no chip
// rather than a confusing `--`. (WARDEN-309)
function memUsedShort(memUsage?: string): string {
  if (!memUsage) return '';
  const used = memUsage.split('/')[0].trim();
  if (!used || /^[-\s]*$/.test(used)) return '';
  return used;
}

// resourceTone() moved to healthUtils (WARDEN-361) so the single band definition
// also colors the per-host aggregate load line (renderHostLoad) and the ＋ new-chat
// picker annotation. Elevated = CPU OR mem ≥ 80 (amber); ≥ 90 (red). (WARDEN-309)

// Inline chip label: "42% · 310.2MiB" (rounded CPU% · used memory). Each part is
// included only when present, so a chat with only cpuPct still renders "42%".
// (WARDEN-309)
function resourceLabel(agent: Chat): string {
  const parts: string[] = [];
  if (agent.cpuPct != null) parts.push(`${Math.round(agent.cpuPct)}%`);
  const used = memUsedShort(agent.memUsage);
  if (used) parts.push(used);
  return parts.join(' · ');
}

// Full tooltip text for the resource chip: precise CPU%, mem%, and the raw
// used / total string. (WARDEN-309)
function resourceTitle(agent: Chat): string {
  const parts: string[] = [];
  if (agent.cpuPct != null) parts.push(`CPU ${agent.cpuPct.toFixed(1)}%`);
  if (agent.memPct != null) parts.push(`Mem ${agent.memPct.toFixed(1)}%`);
  if (agent.memUsage) parts.push(agent.memUsage);
  return parts.join(' · ');
}

// Rank a health state by its display order (healthy → unknown). Used to keep a
// host's agents in the same health-dot order the health-state view uses.
function healthRank(state: HealthStateValue): number {
  const i = HEALTH_SECTION_ORDER.indexOf(state);
  return i === -1 ? HEALTH_SECTION_ORDER.length : i;
}

/** Map a health state to a StatusDot color family. */
function healthTone(state: HealthStateValue): StatusTone {
  switch (state) {
    case HealthState.HEALTHY:
      return 'green';
    case HealthState.WARNING:
      return 'yellow';
    case HealthState.CRITICAL:
      return 'red';
    case HealthState.IDLE:
      return 'gray';
    case HealthState.CLOSED:
      // Same gray family as idle; the distinct glyph (■ vs ○) carries the
      // state under grayscale / CVD (WCAG 1.4.1). (WARDEN-245)
      return 'gray';
    default:
      return 'muted';
  }
}

// Most-recent last-known activity first, for ordering the bounded Closed section.
// Chats with no retained lastActivity sink to the bottom (stable among ties).
// (WARDEN-245)
function byRecencyDesc(a: Chat, b: Chat): number {
  const av = a.lastActivity ?? -Infinity;
  const bv = b.lastActivity ?? -Infinity;
  return bv - av;
}

// Selection identity for a fleet agent — the same `key || id` the sidebar's
// multi-select (WARDEN-328) and /api/kill use. Module-scope so it's stable
// across renders (safe to reference inside memos without re-creating closures).
// (WARDEN-371)
function agentIdOf(a: Chat): string {
  return a.key || a.id;
}

/**
 * Health status indicator — pairs the health color with a distinct per-state
 * glyph (from getHealthIcon) plus an accessible name, so health state survives
 * grayscale / color-vision deficiency and is announced by screen readers.
 */
function HealthDot({ state }: { state: HealthStateValue }) {
  return (
    <StatusDot
      variant="glyph"
      glyph={getHealthIcon(state)}
      tone={healthTone(state)}
      label={formatHealthState(state)}
    />
  );
}

/**
 * Per-agent resource chip (CPU% · memory used) from `docker stats` (WARDEN-309).
 * Rendered ONLY when the chat carries a resource field — i.e. a yatfa docker
 * agent on a host whose `docker stats` succeeded. Bare-tmux/manual agents and
 * hosts whose stats failed render nothing (graceful N/A). Elevated usage
 * (CPU or mem ≥ 80%) is amber/red so a runaway is visible at a glance in a
 * 50-row fleet. `tabular-nums` keeps the digits equal-width so the chip doesn't
 * jitter as the numbers tick on refresh.
 */
function ResourceChip({ agent }: { agent: Chat }) {
  const label = resourceLabel(agent);
  if (!label) return null;
  return (
    <span
      className={`text-[10px] tabular-nums ${resourceTone(agent.cpuPct, agent.memPct)}`}
      title={resourceTitle(agent)}
    >
      {label}
    </span>
  );
}

/**
 * Per-agent token spend (WARDEN-466): the lifetime total of the budget session
 * this chat joined to, surfaced beside CPU/mem so the cost dimension lives at the
 * SAME surface as the kill button. A runaway that is cheap on CPU but burning
 * tokens is now visible at the moment the human decides to stop it.
 *
 * Mirrors the proven per-session chip in OpenChatBrowserPage exactly
 * (text-[10px] text-amber-500/80 tabular-nums + formatTokens) so cost reads in
 * the same color vocabulary everywhere it appears (WARDEN-68 — reuse, no new
 * styling). Rendered ONLY when the chat carries a joined tokenUsage — budget off,
 * no usage, or no cwd+host match render nothing, identical graceful-N/A to a
 * missing CPU/mem field. The number is model-agnostic tokens (dollar cost is out
 * of scope). `tabular-nums` keeps the digits steady as the total ticks.
 *
 * Join limitation (path A, noted in the tooltip): the total comes from a budget
 * session matched by cwd+host (NOT id — a chat id is a container/tmux key, never
 * the claude uuid). A fleet running multiple roles for one repo on one host
 * shares cwd+host, so this may show the heaviest role's spend against a sibling —
 * stale-but-plausible, pure observability, never a mutation.
 */
function TokenChip({ agent }: { agent: Chat }) {
  const label = formatTokens(agent.tokenUsage?.total);
  if (!label) return null;
  return (
    <span
      className="text-[10px] text-amber-500/80 shrink-0 tabular-nums"
      title={`Token spend (lifetime total of the budget session this agent joined): ${label}. Matched by cwd + host — multiple roles on one repo/host may share this number (heaviest shown).`}
    >
      {label}
    </span>
  );
}

/**
 * Per-agent uncommitted-WIP chip (WARDEN-766): the fanned /api/git-status dirty
 * signal + ±N magnitude for THIS agent, surfaced in the row so a coordinator sees
 * which agents hold uncommitted work WITHOUT leaving Fleet Health for the sidebar.
 *
 * Renders the +N −M chip ONLY when the fanned status reports `clean === false`. The
 * magnitude comes from the SAME `diffstat` field /api/git-status serves and the
 * sidebar's per-row DiffStatChip renders, so this REUSES DiffStatChip verbatim (no
 * new glyph/color vocabulary — WARDEN-68). DiffStatChip itself returns null for a
 * null/+0−0 diffstat; a dirty agent with an all-untracked WIP (no tracked edits) thus
 * shows nothing here — never a misleading +0 −0 — while the summary bar's dirtyCount
 * still counts it (clean === false), so the agent is surfaced at the fleet level
 * even when its row carries no magnitude. The `hasMagnitude` pre-check mirrors that
 * guard so the titled wrapper renders ONLY when there is a chip to hover (no empty
 * titled span for an all-untracked dirty agent).
 *
 * `status` absent (still loading / not eligible / unreachable) → renders nothing,
 * the same graceful-N/A contract ResourceChip / TokenChip follow.
 */
function WipChip({ status }: { status?: FleetGitStatusSlice | null }) {
  if (!status || status.clean !== false) return null;
  const ins = status.diffstat?.insertions ?? 0;
  const del = status.diffstat?.deletions ?? 0;
  // Mirror DiffStatChip's own +0−0/null guard so the titled wrapper exists ONLY when
  // the chip renders — a dirty-but-all-untracked agent shows nothing (the summary-bar
  // count still carries it).
  if (ins === 0 && del === 0) return null;
  return (
    <span
      className="shrink-0 tabular-nums"
      title={`uncommitted working-tree WIP — +${ins} −${del} (insertions/deletions vs HEAD)`}
    >
      <DiffStatChip diffstat={status.diffstat} />
    </span>
  );
}

export function HealthDashboard({ onOpenChat, onClose, timestampFormat, fileViewerViewMode, onFileViewerViewModeChange, pollIntervalMs, groupBy, onGroupByChange: setGroupBy, collapsedHosts, onCollapsedHostsChange: setCollapsedHosts }: Props) {
  const [healthData, setHealthData] = useState<HealthData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hostLabels = useHostLabels();
  // Closed-section expansion (WARDEN-245): collapsed shows the 5 most-recent dead
  // sessions; expanded shows up to 20. The true total is always surfaced so the
  // cap is never silent.
  const [closedExpanded, setClosedExpanded] = useState(false);
  // Shared /api/hosts/status poll (singleton) — fuses per-host connectivity into
  // each host section's summary line.
  const hostStatuses = useHostStatuses();
  // Per-agent 24h activity series for the row sparklines (WARDEN-299). Fetched on
  // its own slow ~60s cadence inside the hook — explicitly NOT part of the 10s
  // /api/health poll below, so adding the sparklines is a no-op on the hot path.
  const { series: activitySeries } = useActivitySeries();
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
  // is ephemeral React state — no persistence/serialization boundary touched —
  // exactly like the sidebar's selectedIds.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [killOpen, setKillOpen] = useState(false);
  const [interruptOpen, setInterruptOpen] = useState(false);
  // Fleet-recent-commits FileViewer target (WARDEN-757). Set by the feed's
  // onOpenFile callback; drives the single FileViewer mounted below. Transient
  // dialog state — NOT persisted / serialized to /api/config — mirroring
  // ChatSidebar's fileTarget (also a local useState, never in the persisted UI
  // state). Null = the viewer is closed.
  const [fileTarget, setFileTarget] = useState<{ chatId: string; path: string } | null>(null);
  // Result-toast gating reuses the sidebar's notifyChatOps pref so a kill from
  // Fleet Health has the SAME UX contract (toast on success / partial failure) as
  // a kill from the sidebar (WARDEN-328).
  const { prefs } = useNotificationPrefs();

  // Toggle one agent's membership; select/clear a whole group via the pure tri-
  // state reducer (so the section/host select-all checkboxes share one tested
  // helper). clearSelection empties the set (the action bar's "Clear" + the
  // post-kill reset).
  const toggleSelect = (id: string) => setSelectedIds((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const toggleGroup = (ids: string[]) => setSelectedIds((prev) => toggleGroupSelection(prev, ids));
  const clearSelection = () => setSelectedIds(new Set());

  const fetchHealth = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/health');
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
  useVisiblePoller(fetchHealth, 10000, []);

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
  // (the per-row join is a plain O(1) Map lookup in renderSparkline).
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

  // The per-row sparkline, or null. Delegates the three cases (no container →
  // none; container + events → real series; container + no events → idle flat
  // baseline) to the pure selectAgentSparkline so the logic is unit-testable.
  // Sized with spacing tokens and tightened under `.compact` to track row density.
  const renderSparkline = (agent: Chat) => {
    const sel = selectAgentSparkline(agent, agentActivity, bucketCount);
    if (!sel) return null;
    return (
      <Sparkline
        values={sel.values}
        errors={sel.errors}
        ariaLabel={sel.ariaLabel}
        className="w-14 h-4 compact:w-12 compact:h-3.5"
      />
    );
  };

  // One agent row, reused by both the health-state and host views. `showHost`
  // hides the per-row host tag in host mode (the section header already names
  // the host — a repeated tag would be noise).
  //
  // The row is a `<div role="button">` (not a real `<button>`) so it can nest
  // the selection Checkbox (WARDEN-371) — mirroring the sidebar's ChatRow, which
  // uses the same shape for the same reason (Radix Checkbox renders a button, and
  // a button can't nest a button). The row-body click still opens the chat
  // (onClick + Enter/Space); the checkbox's click/keydown stopPropagation so
  // toggling selection never also opens the chat.
  const renderAgent = (agent: Chat, showHost: boolean) => {
    const id = agentIdOf(agent);
    const isSelected = selectedIds.has(id);
    const selectionActive = selectedIds.size > 0;
    return (
    <div
      key={agent.id}
      role="button"
      tabIndex={0}
      aria-label={`open chat ${agent.name || agent.key || agent.id}`}
      onClick={() => onOpenChat(agent.key || agent.id)}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpenChat(agent.key || agent.id); } }}
      className="group flex items-center gap-2 px-2 py-1.5 rounded-md text-left text-xs hover:bg-accent active:bg-accent/80 transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background"
    >
      {/* Selection checkbox (WARDEN-371). Mirrors ChatRow: sits leftmost, click +
          keydown stop propagation so toggling selection never also opens the chat.
          Subtle (hover/focus-revealed) until selection is active somewhere in the
          view or this row is itself selected — keeps the default fleet list quiet
          while staying keyboard-accessible (focus-within reveals it). */}
      <span
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
        className={cn('flex shrink-0 items-center', isSelected || selectionActive ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 focus-within:opacity-100')}
      >
        <Checkbox
          checked={isSelected}
          onCheckedChange={() => toggleSelect(id)}
          aria-label={`${isSelected ? 'deselect' : 'select'} ${agent.name || agent.key || agent.id}`}
        />
      </span>
      {/* Status Indicator */}
      <HealthDot state={normalizeHealthState(agent.healthState)} />

      {/* Agent Name */}
      <span className="truncate flex-1">
        {agent.name || agent.key || agent.id}
      </span>

      {/* Role Badge for agents */}
      {agent.isAgent && agent.role && (
        <span className="text-[10px] text-blue-400">
          {agent.role}
        </span>
      )}

      {/* Host/Project Info */}
      {showHost && agent.host !== '(local)' && (
        <span className="text-[10px] text-muted-foreground">
          {hostLabelFor(agent.host, hostLabels) || agent.host}
        </span>
      )}

      {/* Activity sparkline (WARDEN-299). Only yatfa agents (which carry a
          container) sparkline; manual/tmux chats render nothing. An agent with
          events draws a bar series (error buckets tint red); an idle agent — a
          container with zero events in the window — draws a deliberately flat
          baseline, not a blank (criterion #1). See selectAgentSparkline. */}
      {renderSparkline(agent)}

      {/* Last Activity */}
      {agent.lastActivity && (
        <span className="text-[10px] text-muted-foreground">
          {formatTimestamp(agent.lastActivity, timestampFormat, { withSuffix: true })}
        </span>
      )}

      {/* Resource usage (WARDEN-309): per-agent CPU% / memory from `docker stats`,
          cache-carried from discover (zero SSH on this 10s poll). Renders nothing
          when the chat has no resource fields. */}
      <ResourceChip agent={agent} />

      {/* Per-agent token spend (WARDEN-466): the joined budget-session lifetime
          total, surfaced beside CPU/mem at the kill-decision surface. Renders
          nothing when the chat doesn't join a budget session (budget off / no
          usage / no cwd+host match). */}
      <TokenChip agent={agent} />

      {/* Per-agent uncommitted WIP (WARDEN-766): the fanned /api/git-status dirty
          signal + ±N magnitude for THIS agent. Renders the +N −M chip only when the
          fanned status says clean === false; absent (loading / not eligible /
          unreachable) or clean → nothing, identical graceful-N/A to the chips above.
          See WipChip. */}
      <WipChip status={fleetGit.statusByKey[id]} />
    </div>
    );
  };

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
          fetch(`/api/discover?host=${encodeURIComponent(h)}`).catch(() => {}),
        ),
      );
      await fetchHealth();
    });
    const outcome = formatKillToast(summary);
    if (prefs.notifyChatOps) {
      if (outcome.variant === 'success') {
        toast.success(outcome.title);
      } else {
        // whitespace-pre-line so the per-agent failure list (joined with \n in
        // formatKillToast) renders one failure per line instead of collapsing.
        toast.error(outcome.title, { description: <span className="whitespace-pre-line">{outcome.description}</span> });
      }
    }
    // The kill's intent is discharged — clear the selection regardless of outcome.
    setSelectedIds(new Set());
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
    const outcome = formatKeySendToast(summary, key);
    if (prefs.notifyChatOps) {
      if (outcome.variant === 'success') {
        toast.success(outcome.title);
      } else {
        // whitespace-pre-line so the per-agent failure list (joined with \n in
        // formatKeySendToast) renders one failure per line instead of collapsing.
        toast.error(outcome.title, { description: <span className="whitespace-pre-line">{outcome.description}</span> });
      }
    }
    // The interrupt's intent is discharged — clear the selection regardless of outcome.
    setSelectedIds(new Set());
    return summary;
  };

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Header */}
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

      {/* Summary Bar */}
      {healthData && (
        <div className="px-3 py-2 border-b bg-muted/30">
          <div className="flex items-center gap-2 text-xs">
            <span className="font-medium">{healthData.summary.total} agents</span>
            <span className="text-muted-foreground">·</span>
            <span className="text-green-500">{healthData.summary.healthy} healthy</span>
            <span className="text-yellow-500">{healthData.summary.warning} warning</span>
            <span className="text-red-500">{healthData.summary.critical} critical</span>
            <span className="text-gray-500">{healthData.summary.idle} idle</span>
            <span className="text-gray-500">{healthData.summary.closed} closed</span>
            {/* Fleet-wide uncommitted-WIP count (WARDEN-766): the # of fanned agents
                whose /api/git-status reported clean === false — the missing
                repository-state axis in the summary bar. Reuses the sidebar's amber/
                yellow dirty vocabulary (the ±N chip family) so "dirty" reads in the
                same color everywhere. Only rendered when > 0 so a clean fleet stays
                quiet. dirtyCount excludes error/loading agents (counted below), so a
                transiently-unreachable agent is never misread as clean OR dirty. */}
            {fleetGit.dirtyCount > 0 && (
              <>
                <span className="text-muted-foreground">·</span>
                <span
                  className="text-yellow-500"
                  title={`${fleetGit.dirtyCount} agent${fleetGit.dirtyCount === 1 ? '' : 's'} with uncommitted working-tree WIP (fanned /api/git-status across active project agents)`}
                >
                  {fleetGit.dirtyCount} dirty
                </span>
              </>
            )}
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
              timestampFormat={timestampFormat}
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
            {groupBy === 'health' ? (
              HEALTH_SECTION_ORDER.filter(section => {
                const agents = healthData.groups[section];
                return agents && agents.length > 0;
              }).map(section => {
                const agents = healthData.groups[section];
                const sectionInfo = SECTION_LABELS[section];
                const count = agents.length;

                // Closed section is bounded + recency-ordered (WARDEN-245): dead
                // catalog sessions no longer flood the panel. Sort most-recent
                // last-known activity first; cap 5 collapsed / 20 expanded. The
                // total (count, in the header) is always shown so the cap is
                // never silent, and a "...and M more" note surfaces the 20-cap.
                const isClosed = section === 'closed';
                const ordered = isClosed ? [...agents].sort(byRecencyDesc) : agents;
                const limit = isClosed
                  ? (closedExpanded ? CLOSED_EXPANDED_LIMIT : CLOSED_COLLAPSED_LIMIT)
                  : agents.length;
                const shown = isClosed ? ordered.slice(0, limit) : ordered;
                const hiddenBeyondCap = isClosed ? count - shown.length : 0;
                const showToggle = isClosed && count > CLOSED_COLLAPSED_LIMIT;
                // The ids actually rendered in this section — the select-all
                // checkbox targets exactly these (the bounded `shown` subset for
                // Closed, so it never selects agents hidden behind the cap).
                const sectionIds = shown.map(agentIdOf);

                return (
                  <div key={section} className="flex flex-col gap-1">
                    {/* Section Header */}
                    <div className={`flex items-center gap-1.5 px-2 py-1 text-[10px] uppercase tracking-wider font-semibold ${sectionInfo.color}`}>
                      {/* Select all in this section (WARDEN-371). Boolean checked
                          = every RENDERED agent in the section is selected.
                          Toggling adds/removes exactly this section's rendered ids
                          via the pure toggleGroupSelection reducer (partial → all,
                          all → none). */}
                      <Checkbox
                        checked={isSelectedAll(selectedIds, sectionIds)}
                        onCheckedChange={() => toggleGroup(sectionIds)}
                        disabled={sectionIds.length === 0}
                        aria-label={`select all ${sectionInfo.title.toLowerCase()}`}
                      />
                      <span>{sectionInfo.icon} {sectionInfo.title} ({count})</span>
                    </div>

                    {/* Agent List */}
                    <div className="flex flex-col gap-0.5">
                      {shown.map(agent => renderAgent(agent, true))}
                    </div>

                    {/* Closed-section expansion toggle (WARDEN-245). Collapsed →
                        "show more (N total)"; expanded → "show less". The label
                        always carries the true total so the cap is never silent. */}
                    {showToggle && (
                      <button
                        type="button"
                        onClick={() => setClosedExpanded(v => !v)}
                        className="self-start px-2 py-0.5 text-[10px] text-muted-foreground hover:text-foreground hover:bg-accent rounded-md transition-colors"
                        aria-expanded={closedExpanded}
                      >
                        {closedExpanded
                          ? 'show less'
                          : `show more (${count} total)`}
                      </button>
                    )}

                    {/* When expanded but the total exceeds the 20-row hard cap,
                        surface the remainder so the cap is explicit, not silent. */}
                    {isClosed && closedExpanded && hiddenBeyondCap > 0 && (
                      <div className="px-2 text-[10px] text-muted-foreground/70">
                        …and {hiddenBeyondCap} more (showing {shown.length} of {count})
                      </div>
                    )}
                  </div>
                );
              })
            ) : groupBy === 'project' ? (
              projectGroups.length === 0 ? (
                <div className="p-4 text-center text-xs text-muted-foreground">No agents to group.</div>
              ) : (
                projectGroups.map(group => {
                  const dist = HEALTH_SECTION_ORDER.filter(s => group.counts[s] > 0);
                  // Select-all targets every agent in this project — no collapse
                  // state in project mode, so all are rendered (matches the action
                  // bar's "All" via renderedIds).
                  const projectIds = group.agents.map(agentIdOf);
                  return (
                    <div key={group.project} className="flex flex-col gap-1 min-w-0">
                      {/*
                        Per-project header — TWO lines, mirroring the Host section
                        above so a returning human reads the same shape. Line 1 =
                        select-all checkbox + project name (truncates) + agent count;
                        line 2 = the health distribution (the per-project copy of the
                        fleet summary bar). Projects have NO connectivity signal (a
                        project can span hosts), so the Host header's connectivity
                        dot + latency are dropped. No collapse state (simpler than
                        host): the header is a plain div, not a collapse Button.
                        (WARDEN-741)
                      */}
                      <div className="flex items-center gap-1.5 px-1 py-1 min-w-0">
                        <span className="flex items-center shrink-0 pl-1">
                          <Checkbox
                            checked={isSelectedAll(selectedIds, projectIds)}
                            onCheckedChange={() => toggleGroup(projectIds)}
                            disabled={projectIds.length === 0}
                            aria-label={`select all agents in ${group.project}`}
                          />
                        </span>
                        <span className="text-xs font-semibold truncate flex-1 min-w-0">
                          {group.project}
                        </span>
                        <span className="text-[10px] text-muted-foreground/50 shrink-0">·</span>
                        <span className="text-[10px] text-muted-foreground shrink-0">
                          {group.agents.length} agent{group.agents.length !== 1 ? 's' : ''}
                        </span>
                      </div>
                      {/* Line 2: health distribution — only non-zero states, colored
                          to match the summary bar (mirrors the Host section's dist
                          line, WARDEN-237). pl-7 indents it under the project name,
                          matching the Host header's line-2 indentation. */}
                      {dist.length > 0 && (
                        <div className="flex flex-wrap items-center gap-1.5 min-w-0 pl-7">
                          {dist.map(s => (
                            <span key={s} className={`text-[10px] ${HEALTH_DIST_COLOR[s]}`}>
                              {group.counts[s]} {formatHealthState(s).toLowerCase()}
                            </span>
                          ))}
                        </div>
                      )}
                      {/*
                        Line 3: host span (WARDEN-780) — the SET of hosts this
                        project's agents run on, each with its connectivity dot +
                        an agent count, so a coordinator in Project mode can see
                        whether the project's agents are co-located or scattered
                        (and spot one sitting on a DOWN host) without switching to
                        Host mode. Offline hosts surface first (offline-first
                        ordering inside summarizeProjectHosts) and carry a visible
                        red `offline` flag; latency stays in the dot's `title`
                        only (the line is multi-host and must stay scannable, so
                        latency is never added to the visible text). Indented
                        (pl-7) under the project name, matching the dist line;
                        `flex-wrap` so a project spanning many hosts wraps rather
                        than clips (same pattern as the dist line and the Host
                        section's dist line). Connectivity comes from the same
                        hostStatuses poll Host mode uses — no new fetch. The dot's
                        tone/variant mirror the Host header's connectivity dot
                        (online→green solid / offline→red square / else gray ring).
                        (WARDEN-780)
                      */}
                      <div className="flex flex-wrap items-center gap-1.5 min-w-0 pl-7">
                        {summarizeProjectHosts(group.agents, (h) => hostStatuses[h]).map((span, i) => {
                          const spanLabel = hostLabelFor(span.host, hostLabels) || (span.host === '(local)' ? 'local' : span.host);
                          return (
                            <Fragment key={span.host}>
                              {i > 0 && <span className="text-[10px] text-muted-foreground/40">·</span>}
                              <span className="flex items-center gap-1 min-w-0">
                                <StatusDot
                                  tone={span.status === 'online' ? 'green' : span.status === 'offline' ? 'red' : 'gray'}
                                  variant={span.status === 'online' ? 'solid' : span.status === 'offline' ? 'square' : 'ring'}
                                  label={
                                    span.status === 'online'
                                      ? `Online${span.latency_ms != null ? ` (${span.latency_ms}ms)` : ''}`
                                      : span.status === 'offline' ? 'Offline' : 'Unknown connectivity'
                                  }
                                  title={
                                    span.status === 'online' && span.latency_ms != null
                                      ? `${span.status} (${span.latency_ms}ms)`
                                      : span.status || 'unknown'
                                  }
                                />
                                <span className="text-[10px] text-muted-foreground truncate">{spanLabel}</span>
                                <span className="text-[10px] text-muted-foreground/60">({span.agentCount})</span>
                                {span.status === 'offline' && (
                                  <span className="text-[10px] text-red-500">offline</span>
                                )}
                              </span>
                            </Fragment>
                          );
                        })}
                      </div>

                      {/* Agents beneath, reusing the standard row (showHost=false —
                          project, like host, is the section key; don't repeat it
                          in-row). (WARDEN-741) */}
                      <div className="flex flex-col gap-0.5">
                        {group.agents.map(agent => renderAgent(agent, false))}
                      </div>
                    </div>
                  );
                })
              )
            ) : (
              hostGroups.length === 0 ? (
                <div className="p-4 text-center text-xs text-muted-foreground">No agents to group.</div>
              ) : (
                hostGroups.map(group => {
                  const status = hostStatuses[group.host];
                  const collapsed = !!collapsedHosts[group.host];
                  const dist = HEALTH_SECTION_ORDER.filter(s => group.counts[s] > 0);
                  const hostLabel = hostLabelFor(group.host, hostLabels) || (group.host === '(local)' ? 'local' : group.host);
                  // Per-host rolled-up CPU/mem (WARDEN-361): mean cpu, MAX mem, or
                  // null when no agent carries docker-stats. Rendered in the line-2
                  // distribution area so an overloaded host (≥90% mem) is red and
                  // identifiable WITHOUT expanding rows or scanning per-agent chips.
                  // agentCount already sits on line 1, so this only shows cpu/mem.
                  const load = summarizeHostLoad(group.agents);
                  const hasLoad = load.avgCpu != null || load.memPct != null;
                  const loadTitle = `Host load: ${load.avgCpu != null ? `${load.avgCpu.toFixed(0)}% avg CPU` : 'no CPU data'} · ${load.memPct != null ? `${load.memPct.toFixed(0)}% max mem` : 'no mem data'} (across ${load.agentCount} agent${load.agentCount !== 1 ? 's' : ''})`;
                  // Select-all targets the agents currently RENDERED for this
                  // host — empty while collapsed (nothing rendered → checkbox is
                  // disabled), all of the host's agents when expanded. This
                  // matches the Closed-section bounding and the action bar's
                  // "All" (renderedIds), so every select-all targets exactly what
                  // is visible, never agents hidden behind a collapse/cap.
                  const hostIds = collapsed ? [] : group.agents.map(agentIdOf);

                  return (
                    <div key={group.host} className="flex flex-col gap-1 min-w-0">
                      {/*
                        Per-host header — TWO lines, so the health distribution
                        (the most diagnosis-relevant content) always has its own
                        line and is never squeezed by a long hostname.

                        Why two lines (UX): the dashboard panel is 320px
                        (HEALTH_WIDTH). Fusing connectivity + a long hostname + a
                        rich 5-segment distribution onto one line is noisy and
                        fragile; giving the distribution line 2 the full panel
                        width (indented under the hostname) keeps it legible. The
                        distribution line itself is `flex-wrap`, so a very wide
                        distribution (5 states, 3-digit counts) that still exceeds
                        the panel width wraps to a third line rather than clipping
                        — no segment is ever cut off.

                        Overflow handling is NOT done here — it lives in CSS. The
                        `health-fleet-scroll` class on the ScrollArea (above)
                        switches Radix's `display:table` viewport wrapper to
                        `display:block`, which gives the wrapper a DEFINITE width
                        (the panel width). Only against that definite width can
                        `truncate flex-1 min-w-0` on the hostname actually shrink
                        and ellipsize it — on its own (under the table wrapper's
                        indefinite, grow-to-max-content sizing) it does nothing,
                        and a long FQDN inflates the row past the panel and
                        hard-clips without an ellipsis. See the rule + trace in
                        index.css. The `min-w-0`s here are belt-and-suspenders.
                        (WARDEN-237)
                      */}
                      <div className="flex items-start gap-1 w-full min-w-0">
                        {/* Select all agents RENDERED for this host (WARDEN-371).
                            SIBLING of the collapse Button (interactive elements
                            can't nest). Boolean checked = every rendered agent
                            on the host is selected; disabled while collapsed
                            (nothing rendered to select). pt-1 aligns it with
                            line 1. The shrink-0 cell + the Button's flex-1/
                            min-w-0 keep the hostname-truncation chain intact (the
                            definite panel width still reaches the truncate span). */}
                        <span className="flex items-center pt-1 pl-1 shrink-0">
                          <Checkbox
                            checked={isSelectedAll(selectedIds, hostIds)}
                            onCheckedChange={() => toggleGroup(hostIds)}
                            disabled={hostIds.length === 0}
                            aria-label={`select all agents on ${hostLabel}`}
                          />
                        </span>
                      <Button
                        variant="ghost"
                        onClick={() => setCollapsedHosts({ ...collapsedHosts, [group.host]: !collapsedHosts[group.host] })}
                        aria-expanded={!collapsed}
                        aria-label={`${hostLabel}: ${group.agents.length} agent${group.agents.length !== 1 ? 's' : ''}${collapsed ? ', expand' : ', collapse'}`}
                        title={collapsed ? 'Expand host' : 'Collapse host'}
                        className="flex flex-col items-stretch justify-start gap-0.5 h-auto flex-1 min-w-0 px-2 py-1 rounded-md font-normal"
                      >
                        {/* Line 1: chevron + connectivity dot + host (truncates) + status + count */}
                        <div className="flex items-center gap-1.5 min-w-0">
                          <span className="text-[10px] text-muted-foreground/60 w-2 shrink-0">{collapsed ? '▸' : '▾'}</span>
                          <StatusDot
                            tone={status?.status === 'online' ? 'green' : status?.status === 'offline' ? 'red' : 'gray'}
                            variant={status?.status === 'online' ? 'solid' : status?.status === 'offline' ? 'square' : 'ring'}
                            label={
                              status?.status === 'online'
                                ? `Online${status.latency_ms ? ` (${status.latency_ms}ms)` : ''}`
                                : status?.status === 'offline' ? 'Offline' : 'Unknown connectivity'
                            }
                            title={
                              status?.status === 'online' && status.latency_ms
                                ? `${status.status} (${status.latency_ms}ms)`
                                : status?.status || 'unknown'
                            }
                          />
                          <span className="text-xs font-semibold truncate flex-1 min-w-0">
                            {hostLabel}
                          </span>
                          <span className="text-[10px] text-muted-foreground shrink-0">
                            {status?.status ?? 'unknown'}
                            {status?.status === 'online' && status.latency_ms ? ` ${status.latency_ms}ms` : ''}
                          </span>
                          <span className="text-[10px] text-muted-foreground/50 shrink-0">·</span>
                          <span className="text-[10px] text-muted-foreground shrink-0">
                            {group.agents.length} agent{group.agents.length !== 1 ? 's' : ''}
                          </span>
                        </div>
                        {/* Line 2: health distribution + rolled-up resource load (WARDEN-361).
                            Only non-zero health states are shown, colored to match the summary
                            bar. The trailing resource segment reuses resourceTone bands (≥80
                            amber, ≥90 red) so a host whose agents collectively sit at ≥90% mem
                            is red here too. Indented (pl-7) to align under the hostname.
                            `flex-wrap` makes the line bulletproof against overflow: if a very
                            wide distribution (all 5 states, 3-digit counts) + the load segment
                            still exceeds the panel width, the excess wraps to a third line
                            instead of being clipped. Each segment is its own flex item, so a
                            wrapped segment stays whole (it never breaks mid-word). (WARDEN-237) */}
                        {(dist.length > 0 || hasLoad) && (
                          <div className="flex flex-wrap items-center gap-1.5 min-w-0 pl-7">
                            {dist.map(s => (
                              <span key={s} className={`text-[10px] ${HEALTH_DIST_COLOR[s]}`}>
                                {group.counts[s]} {formatHealthState(s).toLowerCase()}
                              </span>
                            ))}
                            {/* Per-host resource aggregate (WARDEN-361): "41% cpu · 87% mem",
                                mean cpu · MAX mem across the host's agents. Colored by resourceTone
                                so ≥90% mem reads red. Rendered ONLY when at least one agent carries
                                docker-stats (graceful N/A — a bare-tmux / stats-less host renders
                                nothing, exactly as today). `tabular-nums` keeps the digits steady. */}
                            {hasLoad && (
                              <span
                                className={`text-[10px] tabular-nums ${resourceTone(load.avgCpu, load.memPct)}`}
                                title={loadTitle}
                              >
                                {load.avgCpu != null && `${Math.round(load.avgCpu)}% cpu`}
                                {load.avgCpu != null && load.memPct != null && ' · '}
                                {load.memPct != null && `${Math.round(load.memPct)}% mem`}
                              </span>
                            )}
                          </div>
                        )}
                      </Button>
                      </div>

                      {/* Agents beneath, reusing the standard row */}
                      {!collapsed && (
                        <div className="flex flex-col gap-0.5">
                          {group.agents.map(agent => renderAgent(agent, false))}
                        </div>
                      )}
                    </div>
                  );
                })
              )
            )}
          </div>
        </ScrollArea>
      )}

      {/* Selection action bar (WARDEN-371): appears only while ≥1 agent is
          selected. "All" selects every agent currently rendered in the dashboard
          (renderedIds — respects the Closed-section bounding + host collapse);
          "Clear" empties the selection; "Kill N…" opens the confirm gate.
          Broadcast (Send) is omitted — out of scope for this slice. shrink-0 so
          it pins at the bottom while the fleet list scrolls above it, mirroring
          the sidebar's bar. */}
      {selectedIds.size > 0 && (
        <SelectionActionBar
          count={selectedIds.size}
          onSelectAll={() => setSelectedIds(new Set(renderedIds))}
          onClear={clearSelection}
          onInterrupt={() => setInterruptOpen(true)}
          onKill={() => setKillOpen(true)}
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
        timestampFormat={timestampFormat}
        viewMode={fileViewerViewMode}
        onViewModeChange={onFileViewerViewModeChange}
        pollIntervalMs={pollIntervalMs}
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
