// Fleet Health's per-agent row layer, extracted verbatim from HealthDashboard.tsx
// (WARDEN-1942 — second decomposition slice of that file, after the chip layer
// in StatusChips.tsx, WARDEN-1937): `renderSparkline` + `renderAgent`, each with
// its original doc comment intact. The ONLY deltas from the origin are this
// import header, the exported ctx interface, the ctx destructuring and the
// trailing `return renderAgent(...)`. The bodies close over nine bindings that
// live in the main component; they are threaded explicitly through
// `AgentRowCtx` rather than imported, so this module owns no state (no hooks).
import type { Chat } from '@/lib/types';
import { Sparkline } from '@/components/Sparkline';
import { Checkbox } from '@/components/ui/checkbox';
import { ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem } from '@/components/ui/context-menu';
import { copyWithToast } from '@/lib/clipboardToast';
import { formatTimestamp, type TimestampFormat } from '@/lib/formatTimestamp';
import { selectAgentSparkline, type AgentActivityMap } from '@/lib/agentSparkline';
import { hostLabelFor, type HostLabels } from '@/lib/chatDisplay';
import type { FleetGitStatusState } from '@/lib/useFleetGitStatus';
import { cn } from '@/lib/utils';
import { normalizeHealthState } from '@/lib/healthUtils';
import { HealthDot, ResourceChip, TokenChip, WipChip, ConflictChip, BehindChip, UnpushedChip, StalledChip, StashChip } from './StatusChips';

// The nine bindings the moved bodies close over in the main component.
export interface AgentRowCtx {
  selectedIds: ReadonlySet<string>;
  toggleSelect: (id: string) => void;
  onOpenChat: (id: string) => void;
  fleetGit: FleetGitStatusState;
  hostLabels: HostLabels;
  timestampFormat: TimestampFormat;
  agentIdOf: (a: Chat) => string;
  agentActivity: AgentActivityMap;
  bucketCount: number;
}

export function renderAgentRow(agent: Chat, showHost: boolean, ctx: AgentRowCtx) {
  const { selectedIds, toggleSelect, onOpenChat, fleetGit, hostLabels, timestampFormat, agentIdOf, agentActivity, bucketCount } = ctx;
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
    <ContextMenu key={agent.id}>
      <ContextMenuTrigger asChild>
    <div
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

      {/* Per-agent merge-conflict block (WARDEN-796): the rose ⚑ + "N unmerged"
          magnitude for THIS agent — the conflict axis WipChip cannot speak to. Renders
          the ⚑ only when the fanned status reports conflictCount > 0 (an unmerged
          path); absent / no-conflict → nothing, identical graceful-N/A. See
          ConflictChip. Sibling to WipChip because a mid-merge repo is dirty too: BOTH
          may render (the +N −M magnitude AND the ⚑). */}
      <ConflictChip status={fleetGit.statusByKey[id]} />

      {/* Per-agent behind-upstream block (WARDEN-815): the blue ↓ + "N" magnitude for
          THIS agent — the staleness axis WipChip/ConflictChip cannot speak to. Renders
          the ↓ only when the fanned status reports behind > 0 (HEAD behind upstream);
          absent / fresh (0) / non-git-or-no-upstream (null) → nothing, identical
          graceful-N/A. See BehindChip. Sibling to WipChip/ConflictChip: a behind agent
          is often clean too, so ↓ may render alone OR alongside the ±N/⚑. */}
      <BehindChip status={fleetGit.statusByKey[id]} />

      {/* Per-agent unpushed-commits block (WARDEN-822): the amber ↑N magnitude for
          THIS agent — the ahead axis clean cannot speak to. Renders the ↑ only when the
          fanned status reports ahead > 0 (committed-but-unpushed work); absent /
          in-sync / no-upstream → nothing, identical graceful-N/A. See UnpushedChip.
          Sibling to WipChip AND ConflictChip because an unpushed agent is often dirty
          too: the three axes are orthogonal, so ALL THREE may render at once. */}
      <UnpushedChip status={fleetGit.statusByKey[id]} />

      {/* Per-agent stalled-HEAD block (WARDEN-847): the sky 💤 for THIS agent — the sole
          RECENCY axis the state axes (dirty/conflict/behind/unpushed) cannot speak to.
          Renders the 💤 only when the fanned status reports stalled === true (HEAD commit
          >7d old); absent / fresh / no-commits / non-git → nothing, identical graceful-
          N/A. See StalledChip. This is the canonical blind-spot case: an agent that is
          clean, conflict-free, in sync, AND fully pushed reads ZERO across every axis
          above, so the 💤 may render ALONE where every other chip is absent. */}
      <StalledChip status={fleetGit.statusByKey[id]} />

      {/* Per-agent parked-WIP block (WARDEN-871): the fuchsia 🗄N for THIS agent — the
          parked-WIP axis every state/recency axis above is blind to. Renders the 🗄N
          only when the fanned status reports stashCount > 0 (`git stash`-shelved work
          porcelain status never surfaces); absent / stash-free (0) / non-git-or-no-branch
          (null) → nothing, identical graceful-N/A. See StashChip. This is the canonical
          blind-spot case: an agent that is clean, conflict-free, in sync, fully pushed,
          AND fresh-HEAD but stashed its WIP reads ZERO across every axis above, so the 🗄N
          may render ALONE where every other chip is absent. */}
      <StashChip status={fleetGit.statusByKey[id]} />
    </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        {/* Open mirrors the row click and the Enter/Space keyboard open. */}
        <ContextMenuItem onSelect={() => onOpenChat(agent.key || agent.id)}>Open</ContextMenuItem>
        {/* The truncated name / host are selection-hostile in the row, so the
            menu is the ergonomic way to copy them. Host copies the RAW SSH /
            docker-exec identifier (agent.host) — what a human pastes into a
            command — not the display label. */}
        <ContextMenuItem onSelect={() => copyWithToast(agent.name || agent.key || agent.id)}>Copy agent name</ContextMenuItem>
        <ContextMenuItem onSelect={() => copyWithToast(agent.host)}>Copy host</ContextMenuItem>
        {/* Role appears only for yatfa agents that carry one — mirrors the row's
            `agent.isAgent && agent.role` badge; manual/tmux chats show no role. */}
        {agent.isAgent && agent.role && (
          <ContextMenuItem onSelect={() => copyWithToast(agent.role!)}>Copy role</ContextMenuItem>
        )}
      </ContextMenuContent>
    </ContextMenu>
    );
  };

  return renderAgent(agent, showHost);
}
