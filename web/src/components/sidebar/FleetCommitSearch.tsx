// Fleet-wide commit-message search (WARDEN-534). A single sidebar-level search
// input that fans the per-agent --grep (WARDEN-498) across EVERY one of the
// human's active project agents at once, showing matches grouped by agent — each
// group carrying the agent name · project · how many hits are ↑unpushed, and each
// commit row carrying its own ↑ mark — so one query finds WHERE a change landed
// across the fleet instead of N manual per-agent greps. Read-only; reuses the
// shipped WARDEN-498 /api/git-log?grep= handler VERBATIM (no new endpoint, no
// backend change).
//
// The fan-out follows the fleet convention — Promise.allSettled, like the batch
// kill/broadcast fan-outs in ChatSidebar.tsx — so one unreachable / non-git agent
// does NOT reject the whole search and blank the others; per-agent failures are
// counted and surfaced as an honest "(N unreachable)" note (WARDEN-89 — never let
// a failure masquerade as a barren history). The per-commit ↑unpushed mark is the
// precise outgoing-intersection join (WARDEN-534 research note (a)): a match
// present in BOTH the agent's recent grep and its range=outgoing (@{u}..HEAD)
// grep is unpushed. That join works for EVERY agent in the fleet — not just open
// panes whose git status (aheadCount) is cached — which is why it is preferred
// over the coarse aheadCount>0 signal (note (b)).
//
// The pure aggregation (population gate + grouping + the unpushed join) lives in
// @/lib/gitStateSummary so it is unit-testable without React; this component owns
// only the debounce + fetch + render.

import { useState, useEffect, useMemo } from 'react';
import { Search, X, GitCommitHorizontal } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { findChat } from '@/lib/agentFilter';
import { displayName } from '@/lib/chatDisplay';
import {
  fleetCommitSearchEligible,
  buildFleetCommitGroups,
  type FleetCommitSearchResult,
} from '@/lib/gitStateSummary';
import type { Chat } from '@/lib/types';

export function FleetCommitSearch({ chats, onOpenChat }: {
  chats: Chat[];
  // Clicking a group header or a commit row jumps to the owning agent. Like the
  // GitStateBadge / GitCollisionBadge jump rows, this opens the agent's pane
  // (where its GitBranchBadge → the per-agent git panel lives); there is no
  // deeper deep-link API, so this mirrors the established jump-to-agent pattern.
  onOpenChat: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<FleetCommitSearchResult | null>(null);

  // The searchable fleet: active project agents, keyed + deduped by key, in
  // chats iteration order. Memoized so a stable array reference feeds the search
  // effect's deps (avoids refiring on every chats re-render that didn't change
  // membership).
  const eligible = useMemo(() => fleetCommitSearchEligible(chats), [chats]);
  const fleetN = eligible.length;

  // Debounced (300ms) fleet fan-out. Each keystroke over N agents is N runGit
  // invocations (×2 — recent + outgoing), so the debounce matters more here than
  // in the single-agent WARDEN-498 box. Mirrors that effect's discipline: clear
  // the old results immediately so stale matches never render under the new
  // query while the fetch is in flight; a `cancelled` flag drops a late-resolving
  // fetch; the 300ms settle gates the fire.
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setResult(null);
      setLoading(false);
      return;
    }
    // No searchable agents → resolve immediately to an empty result rather than
    // spinning the loading state forever (e.g. a fresh install with no chats).
    // `eligible.length` (not the `fleetN` alias) so the effect's only reactive
    // inputs are query + eligible — both already deps — and exhaustive-deps stays clean.
    if (eligible.length === 0) {
      setResult({ groups: [], errorCount: 0 });
      setLoading(false);
      return;
    }
    setLoading(true);
    setResult(null);
    let cancelled = false;
    const timer = setTimeout(async () => {
      // Promise.allSettled (the fleet convention, ChatSidebar.tsx handleBroadcast
      // / handleKillSelected): one unreachable / non-git agent never rejects the
      // whole. Each agent fires its recent grep + its outgoing grep concurrently;
      // a hash in both is ↑unpushed.
      const settled = await Promise.allSettled(
        eligible.map(async ({ key, project }) => {
          const base = `/api/git-log?id=${encodeURIComponent(key)}&grep=${encodeURIComponent(q)}`;
          const [recentR, outgoingR] = await Promise.all([fetch(base), fetch(`${base}&range=outgoing`)]);
          // WARDEN-89: fetch() resolves (does NOT reject) on a 4xx/5xx — gate on
          // r.ok so an unreachable agent (404) throws and is counted as that
          // agent's error instead of reading undefined `commits` as an empty list
          // (false-empty disease). The recent fetch is the reachability probe.
          if (!recentR.ok) throw new Error(`git-log grep HTTP ${recentR.status}`);
          const rj = await recentR.json();
          const matches = Array.isArray(rj.commits) ? rj.commits : [];
          // The outgoing grep may 404 too, but if `recent` resolved the agent is
          // reachable; a failed outgoing fetch just yields no unpushed marks — a
          // commit is never WRONGLY marked unpushed by a missing outgoing set.
          const outgoingHashes = new Set<string>();
          if (outgoingR.ok) {
            const oj = await outgoingR.json();
            if (Array.isArray(oj.commits)) for (const c of oj.commits) outgoingHashes.add(c.hash);
          }
          return { ok: true as const, key, project, matches, outgoingHashes };
        }),
      );
      if (cancelled) return;
      // Unwrap allSettled → outcomes in input (chats) order; a rejected promise
      // (a thrown !r.ok, or a bad-JSON throw) becomes that agent's error outcome,
      // keyed from the same `eligible` entry so it still carries key/project.
      const outcomes = settled.map((s, i) =>
        s.status === 'fulfilled'
          ? s.value
          : { ok: false as const, key: eligible[i].key, project: eligible[i].project },
      );
      // WARDEN-89: never swallow a per-agent failure silently — log with the term
      // so a network failure or bad JSON leaves a trace instead of "no matches."
      for (const s of settled) {
        if (s.status === 'rejected') console.warn('[WARDEN-534 fleet commit search] agent grep failed:', s.reason, { q });
      }
      setResult(buildFleetCommitGroups(outcomes));
      setLoading(false);
    }, 300);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [query, eligible]);

  // Drop the search on close so a reopen starts fresh (mirrors GitBranchBadge's
  // close-clears-grep discipline).
  const handleOpenChange = (o: boolean) => {
    setOpen(o);
    if (!o) setQuery('');
  };

  const q = query.trim();
  const groups = result?.groups ?? [];
  const errorCount = result?.errorCount ?? 0;
  const totalHits = groups.reduce((n, g) => n + g.commits.length, 0);

  // The jump-to-agent handler shared by every group header + commit row: open the
  // agent's pane and dismiss the popover so the pane takes focus.
  const jump = (key: string) => {
    setOpen(false);
    onOpenChat(key);
  };

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon-xs"
          title="search commits across all agents"
          aria-label="search commits across all agents"
          className={cn('text-muted-foreground', totalHits > 0 && 'text-primary')}
        >
          <GitCommitHorizontal />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-2">
        <div className="mb-1 flex items-center justify-between gap-2 px-0.5">
          <span className="text-[10px] font-medium text-muted-foreground">fleet commit search</span>
          <span className="text-[10px] text-muted-foreground" title="searchable active project agents">
            {fleetN} agent{fleetN === 1 ? '' : 's'}
          </span>
        </div>
        {/* shadcn <Input>/<Button> — never raw form elements (WARDEN-68); the
            leading Search icon + trailing clear use the icon-input convention
            (relative wrapper, absolutely-positioned affordances, padded input)
            lifted from the per-agent WARDEN-498 box. stopPropagation keeps
            typing/clearing from toggling the row/pane beneath. */}
        <div className="relative mb-1.5">
          <Search className="pointer-events-none absolute left-1.5 top-1/2 size-3 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="search commit messages across the fleet…"
            aria-label="search commit messages across the fleet"
            className="h-7 text-xs pl-6 pr-6"
            autoFocus
          />
          {(q || loading) && (
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              onClick={() => setQuery('')}
              aria-label="clear fleet commit search"
              title="clear search"
              className="absolute right-0.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              <X className="size-3" />
            </Button>
          )}
        </div>
        {!q ? (
          <div className="px-1 py-2 text-[10px] text-muted-foreground">
            Find where a change landed across the fleet — searches every active project agent's commit messages (subject + body), case-insensitive.
          </div>
        ) : loading ? (
          <div className="flex items-center gap-1.5 px-1 py-2">
            <Skeleton className="size-2 rounded-full" />
            <span className="text-[10px] text-muted-foreground">searching {fleetN} agent{fleetN === 1 ? '' : 's'}…</span>
          </div>
        ) : groups.length === 0 ? (
          <div className="px-1 py-2 text-[10px] text-muted-foreground">
            no matching commits
            {errorCount > 0 && (
              <span className="mt-0.5 block text-yellow-500/80">{errorCount} agent{errorCount === 1 ? '' : 's'} unreachable</span>
            )}
          </div>
        ) : (
          <div className="flex max-h-[60vh] flex-col gap-1.5 overflow-auto">
            {errorCount > 0 && (
              <div className="px-0.5 text-[10px] text-yellow-500/80">{errorCount} agent{errorCount === 1 ? '' : 's'} unreachable — showing the rest</div>
            )}
            {groups.map((g) => {
              const c = findChat(chats, g.key);
              const name = displayName(c);
              const unpushedN = g.commits.filter((cm) => cm.unpushed).length;
              return (
                <div key={g.key} className="rounded">
                  {/* Group header: agent name · project · match count + ↑unpushed
                      count. role="button" div (not a nested <button>) so it is
                      keyboard-operable inside the portaled popover; click → open
                      the agent's pane. Mirrors GitStateBadge's popover rows. */}
                  <div
                    role="button"
                    tabIndex={0}
                    aria-label={`open ${name}`}
                    onClick={() => jump(g.key)}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); jump(g.key); } }}
                    title={`open ${name}`}
                    className="flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left hover:bg-accent cursor-pointer focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[10px] font-medium text-foreground" title={name}>{name}</span>
                      <span className="block truncate text-[10px] text-muted-foreground" title={g.project}>{g.project}</span>
                    </span>
                    <span className="shrink-0 text-[10px] text-muted-foreground">
                      {g.commits.length} match{g.commits.length === 1 ? '' : 'es'}
                      {unpushedN > 0 && <span className="text-amber-400"> · ↑{unpushedN}</span>}
                    </span>
                  </div>
                  <ul>
                    {g.commits.map((cm) => (
                      // The commit row mirrors GitBranchBadge's recent-commit row
                      // (hash · subject · date·author), with an amber ↑ when the
                      // hit is also in the agent's outgoing set. role="button" div
                      // (sibling of the header, NOT nested) — click → open the
                      // agent's pane to drill in via its git panel.
                      <li key={`${g.key}:${cm.hash}`}>
                        <div
                          role="button"
                          tabIndex={0}
                          aria-label={`open ${name} (commit ${cm.hash})`}
                          onClick={() => jump(g.key)}
                          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); jump(g.key); } }}
                          title={`open ${name} — inspect in its git panel`}
                          className="flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left hover:bg-accent cursor-pointer focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary"
                        >
                          <span className="shrink-0 font-mono text-[10px] text-cyan-400/80">{cm.hash}</span>
                          {cm.unpushed && <span className="shrink-0 text-[10px] text-amber-400" title="unpushed (local, not yet pushed)">↑</span>}
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-[10px] text-foreground" title={cm.subject}>{cm.subject}</span>
                            <span className="block text-[10px] text-muted-foreground">{cm.date}{cm.author ? ` · ${cm.author}` : ''}</span>
                          </span>
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
