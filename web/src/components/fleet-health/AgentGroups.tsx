// Fleet Health's grouped agent catalog, extracted verbatim from
// HealthDashboard.tsx (WARDEN-1962 — third decomposition slice of that file,
// after the chip layer in StatusChips.tsx, WARDEN-1937, and the per-agent row
// layer in AgentRow.tsx, WARDEN-1942): the `groupBy === 'health' ? ... :
// groupBy === 'project' ? ... : (host)` chain, each wrapper keeping its original
// doc comment and `key=` prop. The ONLY deltas from the origin are this import
// header, the exported ctx interface, the ctx destructuring and the
// `return (...)` wrapper. The chain closes over fifteen bindings that live in
// the main component; they are threaded explicitly through `AgentGroupsCtx`
// rather than imported, so this module owns no state (no hooks). The constants
// and helpers used only by the chain (and by HealthDashboard's `renderedIds`)
// moved with it.
import { Fragment, type ReactNode } from 'react';
import type { HealthData, Chat } from '@/lib/types';
import {
  HealthState,
  HEALTH_STATES,
  formatHealthState,
  summarizeProjectHosts,
  resourceTone,
  summarizeHostLoad,
  type HealthStateValue,
  type HostHealthGroup,
  type ProjectHealthGroup,
} from '@/lib/healthUtils';
import { StatusDot } from '@/components/StatusDot';
import { CompanionIndicator } from '../CompanionIndicator';
import { companionStatusText } from '@/lib/companionStatusText';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem, ContextMenuSeparator } from '@/components/ui/context-menu';
import { copyWithToast } from '@/lib/clipboardToast';
import { isSelectedAll } from '@/lib/selection';
import { hostTagOf, THIS_MACHINE } from '@/lib/chatDisplay';
import type { HostLabels } from '@/lib/chatDisplay';
import type { useHostStatuses } from '@/lib/useHostStatuses';
import { Trash2 } from 'lucide-react';
import { paneIdOf } from '@/lib/paneAttach';

// Section render order. Derived from the canonical health-state vocabulary
// (healthUtils.ts `HEALTH_STATES`, WARDEN-1104) rather than re-typed, so a new
// member gets a section automatically. The canonical order IS the display order:
// closed sits between idle and unknown because a dead session is non-critical and
// less actionable than an idle (potentially waking) one, so it sinks toward the
// tail. (WARDEN-245)
export const HEALTH_SECTION_ORDER = HEALTH_STATES;

// Typed Record<HealthStateValue, …> (not Record<string, …>) so omitting a state
// is a COMPILE error — matching its HEALTH_DIST_COLOR neighbour below, which has
// always been enforced this way. (WARDEN-1104)
const SECTION_LABELS: Record<HealthStateValue, { title: string; color: string; icon: string }> = {
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
export const CLOSED_COLLAPSED_LIMIT = 5;
export const CLOSED_EXPANDED_LIMIT = 20;

// Most-recent last-known activity first, for ordering the bounded Closed section.
// Chats with no retained lastActivity sink to the bottom (stable among ties).
// (WARDEN-245)
export function byRecencyDesc(a: Chat, b: Chat): number {
  const av = a.lastActivity ?? -Infinity;
  const bv = b.lastActivity ?? -Infinity;
  return bv - av;
}
export type GroupMode = 'health' | 'host' | 'project';

// The fifteen bindings the moved chain closes over in the main component.
export interface AgentGroupsCtx {
  groupBy: GroupMode;
  healthData: HealthData;
  closedExpanded: boolean;
  setClosedExpanded: (v: boolean) => void;
  selectedIds: ReadonlySet<string>;
  toggleGroup: (ids: string[]) => void;
  renderAgent: (agent: Chat, showHost: boolean) => ReactNode;
  projectGroups: ProjectHealthGroup[];
  hostGroups: HostHealthGroup[];
  hostStatuses: ReturnType<typeof useHostStatuses>;
  hostLabels: HostLabels;
  collapsedHosts: Record<string, boolean>;
  setCollapsedHosts: (v: Record<string, boolean>) => void;
  companionTransportEnabled: boolean;
  setRemoveCompanionHost: (host: string | null) => void;
}

export function renderAgentGroups(ctx: AgentGroupsCtx) {
  const { groupBy, healthData, closedExpanded, setClosedExpanded, selectedIds, toggleGroup, renderAgent, projectGroups, hostGroups, hostStatuses, hostLabels, collapsedHosts, setCollapsedHosts, companionTransportEnabled, setRemoveCompanionHost } = ctx;
  return (
            groupBy === 'health' ? (
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
                const sectionIds = shown.map(paneIdOf);

                return (
                  <div key={section} className="flex flex-col gap-1">
                    {/* Section Header — themed right-click menu (WARDEN-1679).
                        Only the header is the trigger; the agent rows below stay
                        OUTSIDE it so agent rows keep their own row menu. */}
                    <ContextMenu>
                    <ContextMenuTrigger asChild>
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
                    </ContextMenuTrigger>
                    <ContextMenuContent>
                      <ContextMenuItem
                        disabled={sectionIds.length === 0}
                        onSelect={() => toggleGroup(sectionIds)}
                      >
                        {isSelectedAll(selectedIds, sectionIds) ? 'Deselect all' : 'Select all'}
                      </ContextMenuItem>
                      <ContextMenuSeparator />
                      <ContextMenuItem onSelect={() => copyWithToast(sectionInfo.title)}>Copy section name</ContextMenuItem>
                      <ContextMenuItem onSelect={() => copyWithToast(shown.map(agent => agent.name || agent.key || agent.id).join('\n'))}>
                        Copy agent names
                      </ContextMenuItem>
                    </ContextMenuContent>
                    </ContextMenu>

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
                        onClick={() => setClosedExpanded(!closedExpanded)}
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
                  const projectIds = group.agents.map(paneIdOf);
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
                      {/* WARDEN-1673: themed right-click menu on the Project-mode
                          header (Roadmap WARDEN-362). ONE asChild trigger wraps the
                          three header lines (name/checkbox/count, health distribution,
                          host-span chips) so a right-click anywhere in them opens the
                          menu; the agent rows beneath stay OUTSIDE it and keep their
                          own menu. Left-click/hover (checkbox, CompanionIndicator
                          tooltips) are untouched. */}
                      <ContextMenu>
                      <ContextMenuTrigger asChild>
                      <div className="flex flex-col gap-1 min-w-0">
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
                          const spanLabel = hostTagOf(span.host, hostLabels);
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
                                {/* WARDEN-878: companion state, the same indicator the Host header shows. */}
                                <CompanionIndicator companion={span.companion} />
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
                      </div>
                      </ContextMenuTrigger>
                      <ContextMenuContent>
                        <ContextMenuItem
                          disabled={projectIds.length === 0}
                          onSelect={() => toggleGroup(projectIds)}
                        >
                          {isSelectedAll(selectedIds, projectIds) ? 'Deselect all' : 'Select all'}
                        </ContextMenuItem>
                        <ContextMenuSeparator />
                        <ContextMenuItem onSelect={() => copyWithToast(group.project)}>Copy project name</ContextMenuItem>
                        <ContextMenuItem onSelect={() => copyWithToast(group.agents.map(agent => agent.name || agent.key || agent.id).join('\n'))}>
                          Copy agent names
                        </ContextMenuItem>
                      </ContextMenuContent>
                      </ContextMenu>

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
                  const companionText = companionStatusText(status?.companion);
                  const collapsed = !!collapsedHosts[group.host];
                  const dist = HEALTH_SECTION_ORDER.filter(s => group.counts[s] > 0);
                  const hostLabel = hostTagOf(group.host, hostLabels);
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
                  const hostIds = collapsed ? [] : group.agents.map(paneIdOf);

                  return (
                    <div key={group.host} className="flex flex-col gap-1 min-w-0">
                      {/*
                        Per-host header — TWO lines, so the health distribution
                        (the most diagnosis-relevant content) always has its own
                        line and is never squeezed by a long hostname.

                        Why two lines (UX): the dashboard panel is 320px
                        (HEALTH_WIDTH). Fusing connectivity + a long hostname + a
                        rich 6-segment distribution onto one line is noisy and
                        fragile; giving the distribution line 2 the full panel
                        width (indented under the hostname) keeps it legible. The
                        distribution line itself is `flex-wrap`, so a very wide
                        distribution (6 states, 3-digit counts) that still exceeds
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
                      {/* WARDEN-1667: themed right-click menu on the per-host header
                          (Roadmap WARDEN-362). The trigger wraps ONLY the header row
                          (asChild — no extra DOM) so a right-click anywhere in it,
                          descendants included, opens the menu; the agent rows below
                          keep their own menu. Left-click behaviour of the checkbox /
                          collapse / trash controls is untouched. */}
                      <ContextMenu>
                      <ContextMenuTrigger asChild>
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
                          {/* WARDEN-878: per-host companion transport state, next to the
                              connectivity dot (active/bootstrapping/errored; absent when the
                              transport is off or there is nothing actionable to show). */}
                          <CompanionIndicator companion={status?.companion} />
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
                            wide distribution (all 6 states, 3-digit counts) + the load segment
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
                        {/* WARDEN-882 — per-host "Remove companion" (Removability
                            outcome of roadmap WARDEN-270). A ghost icon Button
                            (shadcn, icon-xs size — no magic-number sizing, no raw
                            element — WARDEN-68 Rule 1/2) SIBLING of the collapse
                            Button, so clicking it does NOT toggle collapse (no
                            nesting). Rendered ONLY for remote hosts when the
                            companion transport is enabled — the same gate every
                            companion surface uses. Local hosts never carry a
                            companion; the trash is omitted for them. Opens the
                            destructive ConfirmDialog below. */}
                        {companionTransportEnabled && group.host !== THIS_MACHINE && (
                          <span className="flex items-center pt-1 shrink-0">
                            <Button
                              variant="ghost"
                              size="icon-xs"
                              onClick={() => setRemoveCompanionHost(group.host)}
                              title={`Remove the warden companion binary from ${hostLabel}`}
                              aria-label={`Remove companion from ${hostLabel}`}
                              className="text-muted-foreground hover:text-destructive"
                            >
                              <Trash2 />
                            </Button>
                          </span>
                        )}
                      </div>
                      </ContextMenuTrigger>
                      <ContextMenuContent>
                        <ContextMenuItem
                          onSelect={() => setCollapsedHosts({ ...collapsedHosts, [group.host]: !collapsedHosts[group.host] })}
                        >
                          {collapsed ? 'Expand' : 'Collapse'}
                        </ContextMenuItem>
                        <ContextMenuSeparator />
                        <ContextMenuItem onSelect={() => copyWithToast(group.host)}>Copy host name</ContextMenuItem>
                        {group.host !== THIS_MACHINE && (
                          <ContextMenuItem onSelect={() => copyWithToast(`ssh ${group.host}`)}>Copy SSH address</ContextMenuItem>
                        )}
                        {companionText !== null && (
                          <ContextMenuItem onSelect={() => copyWithToast(companionText)}>Copy companion status</ContextMenuItem>
                        )}
                        {companionTransportEnabled && group.host !== THIS_MACHINE && (
                          <>
                            <ContextMenuSeparator />
                            <ContextMenuItem variant="destructive" onSelect={() => setRemoveCompanionHost(group.host)}>
                              Remove companion…
                            </ContextMenuItem>
                          </>
                        )}
                      </ContextMenuContent>
                      </ContextMenu>

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
            )
  );
}
