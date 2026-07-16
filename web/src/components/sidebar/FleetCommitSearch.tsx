// Fleet-wide commit search (WARDEN-534 message axis + WARDEN-559 content axis). A
// single sidebar-level search input that fans the per-agent /api/git-log search across
// EVERY one of the human's active project agents at once, showing matches grouped by
// agent — each group carrying the agent name · project · how many hits are ↑unpushed,
// and each commit row carrying its own ↑ mark — so one query finds WHERE a change landed
// across the fleet instead of N manual per-agent searches. Read-only; reuses the
// shipped /api/git-log handler VERBATIM (no new endpoint) — the backend pickaxe param
// added in WARDEN-559 is the only backend change, and it stays byte-for-byte unchanged
// when absent.
//
// Two axes, one fan-out:
//  • MESSAGE mode (WARDEN-534, default) — `git log --grep` over commit messages; the
//     classic "find the commit whose message said X". As-you-type, 300ms debounce.
//  • CONTENT mode (WARDEN-559) — `git log -S`/`-G` (pickaxe) over commit-history DIFFS;
//     finds the commit that ADDED or REMOVED a code string ("who introduced the billing
//     off-by-one"). Far costlier than --grep — it walks history computing a per-commit
//     diff — so CONTENT mode is Enter-to-submit ONLY: the 2N (recent + outgoing) fan-out
//     is paid ONCE on submit, never 2N full-history-diff walks per keystroke. The
//     ↑unpushed outgoing join is KEPT (valuable + the fleet convention is honest about
//     unpushed state); its doubled cost is now paid once per submit. (WARDEN-559 cost
//     nuance.)
//
// The fan-out follows the fleet convention — Promise.allSettled, like the batch
// kill/broadcast fan-outs in ChatSidebar.tsx — so one unreachable / non-git agent
// does NOT reject the whole search and blank the others; per-agent failures are
// counted and surfaced as an honest "(N unreachable)" note (WARDEN-89 — never let
// a failure masquerade as a barren history). The per-commit ↑unpushed mark is the
// precise outgoing-intersection join (WARDEN-534 research note (a)): a match
// present in BOTH the agent's recent search and its range=outgoing (@{u}..HEAD)
// search is unpushed. That join works for EVERY agent in the fleet — not just open
// panes whose git status (aheadCount) is cached — which is why it is preferred
// over the coarse aheadCount>0 signal (note (b)).
//
// The pure aggregation (population gate + URL builder + grouping + the unpushed join)
// lives in @/lib/gitStateSummary so it is unit-testable without React; this component
// owns only the mode/debounce/submit policy + fetch + render.

import { useState, useEffect, useMemo } from 'react';
import { Search, X, GitCommitHorizontal, Regex } from 'lucide-react';
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
  buildFleetSearchBaseUrl,
  type FleetCommitSearchResult,
  type FleetCommitSearchMode,
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
  // message (WARDEN-534, default) ⇄ content/pickaxe (WARDEN-559). The aggregation layer
  // is mode-agnostic; mode only selects the fetch param (grep= vs pickaxe=) via
  // buildFleetSearchBaseUrl.
  const [mode, setMode] = useState<FleetCommitSearchMode>('message');
  // Content mode's regex sub-toggle: off → `-S` (occurrence-count change, the precise
  // "added/removed it" signal); on → `-G` (regex match against the diff, broader).
  const [pickaxeRegex, setPickaxeRegex] = useState(false);
  const [query, setQuery] = useState('');        // text in the input (always current)
  const [committed, setCommitted] = useState(''); // CONTENT mode: the submitted query (Enter)
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<FleetCommitSearchResult | null>(null);

  // The searchable fleet: active project agents, keyed & deduped by key, in
  // chats iteration order. Memoized so a stable array reference feeds the search
  // effect's deps (avoids refiring on every chats re-render that didn't change
  // membership).
  const eligible = useMemo(() => fleetCommitSearchEligible(chats), [chats]);
  const fleetN = eligible.length;

  // The single reactive search term. Message mode drives off the typed `query`
  // (as-you-type); content mode drives off the `committed` (submitted) query — so
  // TYPING in content mode does NOT change this value and therefore does NOT refire
  // the effect (the WARDEN-559 cost gate: no 2N full-history-diff walks per keystroke).
  // Computed OUTSIDE the effect so only `searchTerm` (not `query`/`committed`) is a dep.
  const searchTerm = mode === 'content' ? committed : query;

  // Debounced (300ms, MESSAGE mode) / immediate-on-submit (CONTENT mode) fleet fan-out.
  // Message mode: each keystroke over N agents is N runGit invocations (×2 — recent +
  // outgoing), so the debounce matters more here than in the single-agent WARDEN-498
  // box. Content mode: pickaxe is far costlier (per-commit diff), so it is gated to
  // submit only — `searchTerm` changes solely on Enter (or a regex-toggle re-run) — and
  // the 0ms timer just defers the fire to the next tick so the cleanup can still cancel
  // a rapid resubmit. Mirrors the WARDEN-498 effect's discipline: clear the old results
  // immediately so stale matches never render under the new query while the fetch is in
  // flight; a `cancelled` flag drops a late-resolving fetch.
  useEffect(() => {
    const q = searchTerm.trim();
    if (!q) {
      setResult(null);
      setLoading(false);
      return;
    }
    // No searchable agents → resolve immediately to an empty result rather than
    // spinning the loading state forever (e.g. a fresh install with no chats).
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
      // whole. Each agent fires its recent search + its outgoing search concurrently;
      // a hash in both is ↑unpushed. buildFleetSearchBaseUrl swaps grep= ↔ pickaxe=
      // (and adds pickaxeRegex=1) by mode — the only mode-dependent line.
      const settled = await Promise.allSettled(
        eligible.map(async ({ key, project }) => {
          const base = buildFleetSearchBaseUrl(key, q, mode, pickaxeRegex);
          const [recentR, outgoingR] = await Promise.all([fetch(base), fetch(`${base}&range=outgoing`)]);
          // WARDEN-89: fetch() resolves (does NOT reject) on a 4xx/5xx — gate on
          // r.ok so an unreachable agent (404) throws and is counted as that
          // agent's error instead of reading undefined `commits` as an empty list
          // (false-empty disease). The recent fetch is the reachability probe.
          if (!recentR.ok) throw new Error(`git-log search HTTP ${recentR.status}`);
          const rj = await recentR.json();
          const matches = Array.isArray(rj.commits) ? rj.commits : [];
          // The outgoing search may 404 too, but if `recent` resolved the agent is
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
        if (s.status === 'rejected') console.warn('[fleet commit search] agent search failed:', s.reason, { q, mode });
      }
      setResult(buildFleetCommitGroups(outcomes));
      setLoading(false);
    }, mode === 'content' ? 0 : 300);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [searchTerm, mode, pickaxeRegex, eligible]);

  // Switching axis starts a fresh search: clear results and drop any stale CONTENT-mode
  // committed term so content mode never auto-fires on a query typed under message mode.
  // The typed `query` is preserved so a user who typed then switched modes can submit it
  // with Enter in content mode.
  const switchMode = (m: FleetCommitSearchMode) => {
    if (m === mode) return;
    setMode(m);
    setCommitted('');
    setResult(null);
    setLoading(false);
  };

  // CONTENT-mode submit: commit the typed query → flips `searchTerm` → fires the effect
  // once. Bound to Enter on the input (and is the only way content mode runs a search).
  const submitContent = () => {
    if (mode === 'content') setCommitted(query);
  };

  // Drop the search on close so a reopen starts fresh (mirrors GitBranchBadge's
  // close-clears-grep discipline). Resets both the typed query and the committed term.
  const handleOpenChange = (o: boolean) => {
    setOpen(o);
    if (!o) {
      setQuery('');
      setCommitted('');
    }
  };

  const q = query.trim();
  const groups = result?.groups ?? [];
  const errorCount = result?.errorCount ?? 0;
  const totalHits = groups.reduce((n, g) => n + g.commits.length, 0);
  // CONTENT mode: true when there is typed text that has not been submitted yet — the
  // cue to show the "press Enter" hint (the search will not run until submitted).
  const contentPending = mode === 'content' && q.length > 0 && q !== committed.trim();

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
        {/* Mode toggle (WARDEN-559): message (commit messages, WARDEN-534) ⇄ content
            (added/removed code via pickaxe, WARDEN-559). A two-button segment of shadcn
            <Button>s (never raw form elements — WARDEN-68); the active axis is `secondary`,
            the other `ghost`. In content mode a regex sub-toggle (-S ⇄ -G) appears. */}
        <div className="mb-1.5 flex items-center gap-1 px-0.5">
          <div className="flex gap-0.5 rounded bg-muted p-0.5">
            <Button
              type="button"
              variant={mode === 'message' ? 'secondary' : 'ghost'}
              size="xs"
              onClick={() => switchMode('message')}
              aria-pressed={mode === 'message'}
              className="h-5 px-1.5 text-[10px]"
              title="search commit messages (subject + body)"
            >
              Messages
            </Button>
            <Button
              type="button"
              variant={mode === 'content' ? 'secondary' : 'ghost'}
              size="xs"
              onClick={() => switchMode('content')}
              aria-pressed={mode === 'content'}
              className="h-5 px-1.5 text-[10px]"
              title="search commit content — added/removed code (pickaxe)"
            >
              Content
            </Button>
          </div>
          {mode === 'content' && (
            <Button
              type="button"
              variant={pickaxeRegex ? 'secondary' : 'ghost'}
              size="xs"
              onClick={() => setPickaxeRegex((v) => !v)}
              aria-pressed={pickaxeRegex}
              className="h-5 gap-1 px-1.5 text-[10px]"
              title={pickaxeRegex
                ? 'regex (-G): match against the diff text (broader). click for -S'
                : 'string (-S, default): commits that changed the occurrence count (added/removed). click for -G regex'}
            >
              <Regex className="size-3" />
              regex
            </Button>
          )}
        </div>
        {/* shadcn <Input>/<Button> — never raw form elements (WARDEN-68); the
            leading Search icon + trailing clear use the icon-input convention
            (relative wrapper, absolutely-positioned affordances, padded input)
            lifted from the per-agent WARDEN-498 box. stopPropagation keeps
            typing/clearing from toggling the row/pane beneath. In CONTENT mode,
            Enter submits the search (it does not run as-you-type). */}
        <div className="relative mb-1.5">
          <Search className="pointer-events-none absolute left-1.5 top-1/2 size-3 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); submitContent(); } }}
            placeholder={mode === 'content'
              ? 'search added/removed code across the fleet — press Enter'
              : 'search commit messages across the fleet…'}
            aria-label={mode === 'content'
              ? 'search commit content across the fleet'
              : 'search commit messages across the fleet'}
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
        {contentPending && (
          <div className="mb-1.5 px-1 text-[10px] text-muted-foreground">
            press Enter to search the fleet's diffs
          </div>
        )}
        {!q ? (
          <div className="px-1 py-2 text-[10px] text-muted-foreground">
            {mode === 'content'
              ? 'Find where a string was added or removed across the fleet — searches every active project agent\'s commit-history diffs (git log -S' + (pickaxeRegex ? ' / -G regex' : '') + ').'
              : 'Find where a change landed across the fleet — searches every active project agent\'s commit messages (subject + body), case-insensitive.'}
          </div>
        ) : contentPending ? (
          // CONTENT mode with typed-but-unsubmitted text: the "press Enter" hint above is
          // the whole cue — render nothing else (no false "no matching commits", since the
          // search has not run yet). Message mode is never pending (as-you-type), so this
          // branch is content-only.
          null
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

