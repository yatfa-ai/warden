// The "Compare edits" dialog for cross-agent file-edit collisions (WARDEN-321) —
// the resolution layer on top of WARDEN-287/288's detection.
//
// The collision popover (GitCollisionBadge in ChatSidebar) already knows WHICH
// paths ≥2 agents are racing on and WHO the agents are; it shows neither HOW
// their edits diverge nor whether the touched regions even overlap. This dialog
// is that view: for one colliding path, fan out /api/git-diff per contributing
// agent and render each agent's uncommitted diff as a stacked, collapsible panel
// (name · host · branch header + that agent's diff via DiffBlock). A glance then
// tells a human whether the edits are disjoint (a false alarm — both can proceed)
// or truly overlapping (pick who proceeds) — coordination before the collision
// lands, which was the badge's stated purpose all along.
//
// The network fan-out lives HERE (it touches fetch + per-panel state); the
// TESTABLE pure seam — reducing the allSettled outcomes into a per-agent panel
// model with ok/untracked/empty/error classification — is extracted into
// @/lib/collisionCompare (reduceCollisionDiffs), mirroring broadcast.ts. Partial
// failure is the load-bearing property: one agent's host being unreachable (a
// rejected promise) or its file no longer being dirty (status 'empty') is
// surfaced PER-PANEL and does NOT blank the others — Promise.allSettled (not
// Promise.all) so a single down host never hides the reachable agent's diff.
//
// Deliberately out of scope (v1 is a read-only VIEW, not an auto-merger): no
// 3-way merge editor, no "stash agent B" write-back. This informs a human
// decision; it does not make one. Modeled on BroadcastDialog (Dialog structure +
// the keep-state-out-of-parent discipline) and DiffViewer (the loading/error/
// untracked/empty branches), rendering each settled diff through the stateless
// DiffBlock (the same primitive FileViewer and the sidebar's expanded commits
// use) so a collision panel reads identically to that agent's own diff modal.
import { useState, useEffect, useMemo } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  ChevronDown,
  ChevronRight,
  FileIcon,
  AlertCircleIcon,
  ExternalLink,
} from 'lucide-react';
import { DiffBlock } from './DiffBlock';
import { reduceCollisionDiffs, type CollisionDiffPanel, type GitDiffResult } from '@/lib/collisionCompare';
import type { FileCollision } from '@/lib/gitStateSummary';
import { displayName, hostTagOf } from '@/lib/chatDisplay';
import { findChat } from '@/lib/agentFilter';
import type { Chat } from '@/lib/types';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The colliding path to compare across agents. Empty while closed. */
  path: string;
  /** The ≥2 agents contributing to this path's collision (from FileCollision.agents). */
  agents: FileCollision['agents'];
  chats: Chat[];
  /** Minimal slice the panel headers read (branch label) — structurally compatible
   *  with ChatSidebar's full gitStatus map. */
  gitStatus: Record<string, { branch: string | null }>;
  onOpenChat: (id: string) => void;
}

export function CollisionCompareDialog({ open, onOpenChange, path, agents, chats, gitStatus, onOpenChat }: Props) {
  // null = fan-out in flight (or not yet started); once settled this is exactly
  // one panel per agent (reduceCollisionDiffs never throws — partial failure is
  // encoded per-panel, not by rejecting the whole fan-out).
  const [panels, setPanels] = useState<CollisionDiffPanel[] | null>(null);

  // Stable identity for the effect dep so a new `agents` array reference each
  // parent render does NOT re-trigger the fan-out. The actual fetch keys are this
  // joined string; same keys → same value → effect skips.
  const agentKeys = useMemo(() => agents.map((a) => a.key).join('\n'), [agents]);

  useEffect(() => {
    if (!open || !path || agents.length === 0) {
      setPanels(null);
      return;
    }

    let cancelled = false;
    const keys = agents.map((a) => a.key);
    setPanels(null);

    // Fan out one /api/git-diff per colliding agent. Promise.allSettled (not
    // Promise.all) so a single down host never aborts the reachable ones — each
    // agent's diff is settled independently and reduced into its own panel. The
    // fetch callback normalizes a non-ok HTTP status into `{ error }` (mirroring
    // broadcast.ts's fan-out mapping of 404/500 → { ok:false, error }) so the
    // reducer sees only settled data, never a Response object.
    (async () => {
      const results = await Promise.allSettled(
        keys.map((id) =>
          fetch(`/api/git-diff?id=${encodeURIComponent(id)}&path=${encodeURIComponent(path)}`)
            .then(async (r): Promise<GitDiffResult> => {
              const j = await r.json().catch(() => ({}));
              if (!r.ok) return { diff: null, untracked: false, error: j.error || `HTTP ${r.status}` };
              return { diff: j.diff ?? null, untracked: !!j.untracked, error: j.error ?? null };
            }),
        ),
      );
      if (cancelled) return;
      setPanels(reduceCollisionDiffs(agents, results));
    })();

    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, path, agentKeys]);

  // Open the agent's chat AND close the dialog so the human lands on the agent
  // they chose to act on (mirrors the popover rows, which setOpen(false) + jump).
  const handleJump = (id: string) => { onOpenChange(false); onOpenChat(id); };

  const loading = panels === null;
  const count = agents.length;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-4xl max-h-[85vh] flex flex-col">
        <DialogHeader className="shrink-0">
          <DialogTitle className="flex items-center gap-2">
            <FileIcon className="w-4 h-4 shrink-0" />
            <span className="truncate" title={path}>{path || 'collision'}</span>
          </DialogTitle>
          <DialogDescription>
            {count} agent{count === 1 ? '' : 's'} editing this file — each panel below is one agent's uncommitted diff vs HEAD. Stacked so you can see whether the touched regions overlap (true conflict) or are disjoint (false alarm).
          </DialogDescription>
        </DialogHeader>

        <ScrollArea className="flex-1 min-h-0">
          <div className="flex flex-col gap-2 p-1 pr-3">
            {loading && (
              // One skeleton per agent so the human sees how many panels are
              // coming and roughly where, rather than a single opaque spinner.
              Array.from({ length: Math.max(count, 1) }).map((_, i) => (
                <div key={i} className="rounded-md border border-border p-2">
                  <Skeleton className="h-4 w-40" />
                  <Skeleton className="mt-2 h-2 w-full" />
                  <Skeleton className="mt-1 h-2 w-3/4" />
                </div>
              ))
            )}

            {!loading && panels !== null && panels.length === 0 && (
              <div className="flex items-center justify-center gap-2 py-8 text-muted-foreground">
                <AlertCircleIcon className="w-4 h-4" />
                <span>No agents to compare.</span>
              </div>
            )}

            {!loading && panels !== null && panels.length > 0 && panels.map((panel) => {
              const c = findChat(chats, panel.key);
              return (
                <AgentDiffPanel
                  key={panel.key}
                  panel={panel}
                  chat={c}
                  branch={gitStatus[panel.key]?.branch ?? null}
                  onOpenChat={handleJump}
                />
              );
            })}
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}

/** One agent's diff panel — header (name · host · branch + jump-to-agent) over
 *  that agent's uncommitted diff for the path. Owns its own collapse state so the
 *  human can focus one agent's edit and fold the rest; defaults to EXPANDED so
 *  all the diffs are visible at once for the side-by-side-by-side comparison that
 *  is the whole point of opening this dialog. Mirrors CommitFile's own-open-state
 *  pattern (a role="button" header toggling inline content rendered via DiffBlock). */
function AgentDiffPanel({ panel, chat, branch, onOpenChat }: {
  panel: CollisionDiffPanel;
  chat: Chat | undefined;
  branch: string | null;
  onOpenChat: (id: string) => void;
}) {
  // Default expanded (false = not collapsed) — see component docstring.
  const [collapsed, setCollapsed] = useState(false);
  const name = displayName(chat);
  const host = chat ? hostTagOf(chat.host || '') : '?';

  return (
    <section className="rounded-md border border-border">
      {/* Header: collapse toggle · name · host · branch · jump-to-agent. Sibling
          interactive elements inside a non-interactive header row (no nesting). */}
      <div className="flex items-center gap-1.5 px-2 py-1.5 border-b border-border bg-accent/30">
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={() => setCollapsed((c) => !c)}
          aria-label={collapsed ? 'expand this agent’s diff' : 'collapse this agent’s diff'}
          aria-expanded={!collapsed}
          className="text-muted-foreground"
        >
          {collapsed ? <ChevronRight /> : <ChevronDown />}
        </Button>
        <span className="min-w-0 flex-1 truncate text-xs">
          <span className="font-medium text-foreground" title={name}>{name}</span>
          <span className="ml-1.5 text-muted-foreground">· {host}</span>
          {branch && (
            <span className="ml-1.5 text-cyan-400/80" title={branch}>⎇ {branch}</span>
          )}
        </span>
        {/* Jump-to-agent (mirrors the popover rows): opens this agent's chat and
            closes the dialog. A real <Button> (not nested inside another interactive
            element) per WARDEN-68. */}
        <Button
          variant="ghost"
          size="xs"
          onClick={() => onOpenChat(panel.key)}
          className="text-muted-foreground hover:text-foreground"
          title={`open ${name}`}
        >
          <ExternalLink />
          Open
        </Button>
      </div>

      {!collapsed && (
        <div className="p-2">
          <PanelBody panel={panel} />
        </div>
      )}
    </section>
  );
}

/** The diff/error/empty body of one agent's panel, branched on the pure
 *  reducer's status classification. Each branch mirrors DiffViewer's own states so
 *  a panel reads identically to opening that agent's diff modal — no second
 *  vocabulary for the same outcomes. */
function PanelBody({ panel }: { panel: CollisionDiffPanel }) {
  switch (panel.status) {
    case 'ok':
      return <DiffBlock diff={panel.diff} />;
    case 'untracked':
      // A new file HEAD has no record of. If the transport returned content (the
      // new file as additions) render it; otherwise a plain note — never a broken
      // empty diff block.
      return (
        <div className="flex flex-col gap-1">
          <span className="text-[10px] text-muted-foreground">new file (untracked) — no tracked baseline to diff against</span>
          {panel.diff.length > 0 && <DiffBlock diff={panel.diff} />}
        </div>
      );
    case 'empty':
      // The file matches HEAD on THIS agent's side — the collision may already
      // have resolved here (the agent committed/reverted). A real signal, not a
      // bug: it tells the human this agent is no longer racing.
      return (
        <div className="flex items-center gap-1.5 py-1 text-[11px] text-muted-foreground">
          <span>No changes — file matches HEAD. This agent may no longer be editing it.</span>
        </div>
      );
    case 'error':
      return (
        <div className="flex items-start gap-1.5 py-1 text-[11px] text-red-400">
          <AlertCircleIcon className="mt-px w-3.5 h-3.5 shrink-0" />
          <span className="break-words">{panel.error}</span>
        </div>
      );
    default:
      return null;
  }
}
