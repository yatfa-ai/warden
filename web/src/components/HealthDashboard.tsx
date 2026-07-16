import { useState, useEffect, useMemo } from 'react';
import { toast } from 'sonner';
import { ScrollArea } from '@/components/ui/scroll-area';
import type { HealthData, Chat } from '@/lib/types';
import {
  HealthState,
  getHealthIcon,
  formatHealthState,
  normalizeHealthState,
  groupByHost,
  compareHostGroups,
  resourceTone,
  summarizeHostLoad,
  type HealthStateValue,
  type HostHealthGroup,
} from '@/lib/healthUtils';
import { StatusDot, type StatusTone } from '@/components/StatusDot';
import { Sparkline } from '@/components/Sparkline';
import { formatTimestamp, type TimestampFormat } from '@/lib/formatTimestamp';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { KillDialog } from './KillDialog';
import { KeySendDialog } from './KeySendDialog';
import { SelectionActionBar } from './sidebar/SidebarBits';
import { formatKillToast, runKillFanout } from '@/lib/kill';
import { formatKeySendToast, runKeySendFanout } from '@/lib/keysend';
import { isSelectedAll, toggleGroupSelection } from '@/lib/selection';
import { useHostStatuses } from '@/lib/useHostStatuses';
import { useActivitySeries } from '@/lib/useActivitySeries';
import { useNotificationPrefs } from '@/lib/useNotificationPrefs';
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
  // "Group agents by: Health | Host" mode (WARDEN-237). Lifted to App + persisted
  // (WARDEN-468) so the toggle survives a Warden restart — App owns the single
  // source of truth and this is read-only here except for the change handler.
  // Health stays the default (DEFAULT_UI.healthGroupBy) so the dashboard is
  // unchanged unless a human opts into the per-host view.
  groupBy: GroupMode;
  onGroupByChange: (mode: GroupMode) => void;
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

export type GroupMode = 'health' | 'host';

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

export function HealthDashboard({ onOpenChat, onClose, timestampFormat, groupBy, onGroupByChange: setGroupBy }: Props) {
  const [healthData, setHealthData] = useState<HealthData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hostLabels = useHostLabels();
  const [collapsedHosts, setCollapsedHosts] = useState<Record<string, boolean>>({});
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

  // Multi-select batch-kill (WARDEN-371): the set of selected agent ids, held at
  // the dashboard level so it can span every health/host section. Mirrors the
  // sidebar's WARDEN-328 surface (selectedIds Set keyed by `key || id`). Selection
  // is ephemeral React state — no persistence/serialization boundary touched —
  // exactly like the sidebar's selectedIds.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [killOpen, setKillOpen] = useState(false);
  const [interruptOpen, setInterruptOpen] = useState(false);
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

  useEffect(() => {
    fetchHealth();
    // Poll every 10 seconds for updates
    const interval = setInterval(fetchHealth, 10000);
    return () => clearInterval(interval);
  }, []);

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
    // Host mode: only non-collapsed hosts' agents are rendered.
    return hostGroups.flatMap((g) => (collapsedHosts[g.host] ? [] : g.agents.map(agentIdOf)));
  }, [healthData, groupBy, closedExpanded, collapsedHosts, hostGroups]);

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
      onClick={() => onOpenChat(agent.id)}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpenChat(agent.id); } }}
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
          {/* Group-by toggle (WARDEN-237): Health (default, no regression) / Host.
              Two shadcn Buttons in a labelled group — the active option uses
              variant="secondary" so the selection reads at a glance, and size="xs"
              supplies the compact sizing (replacing the old magic-number
              px-1.5 py-0.5 text-[10px]). */}
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
          </div>
          <button className="text-xs text-muted-foreground hover:text-foreground active:scale-95 transition-all duration-150 ease-out" onClick={fetchHealth} disabled={loading}>
            {loading ? '…' : '↻'}
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
                        onClick={() => setCollapsedHosts(prev => ({ ...prev, [group.host]: !prev[group.host] }))}
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

      {/* Timestamp */}
      {healthData && (
        <div className="px-3 py-1 border-t text-[10px] text-muted-foreground text-center">
          Last updated: {formatTimestamp(healthData.timestamp, timestampFormat)}
        </div>
      )}
    </div>
  );
}
