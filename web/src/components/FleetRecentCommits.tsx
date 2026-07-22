import { useState, useEffect, useMemo, useRef } from 'react';
import { RotateCw } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '@/components/ui/context-menu';
import { cn } from '@/lib/utils';
import { displayName } from '@/lib/chatDisplay';
import { copyText } from '@/lib/clipboard';
import {
  fleetCommitSearchEligible,
  mergeFleetCommitsByEpoch,
  buildFleetRecentCommitsUrl,
  bindFleetRowOpenFile,
  type FleetRecentCommitsResult,
} from '@/lib/gitStateSummary';
import { CommitFile, CommitMessage } from './sidebar/GitBadges';
import type { Chat } from '@/lib/types';
import type { GitFile } from './sidebar/types';

/**
 * FleetRecentCommits — a no-query, time-sorted "what the fleet just shipped" feed
 * (WARDEN-597). The commit-history analog of FleetActivityHeatmap (WARDEN-532):
 * where the heatmap promoted independent per-agent activity strips into one
 * coordinated matrix, this promotes independent per-agent commit lists (the
 * GitBadges popover) into ONE cross-fleet list. It fans the existing per-agent
 * `/api/git-log?limit=N` across every active project agent, merges every returned
 * commit by committer epoch (newest first), and renders the top rows as a glanceable
 * feed — so "who just shipped / who went quiet / two agents committing the same area"
 * reads in one glance, which the mutually-unaligned per-agent lists cannot do.
 *
 * Each row = agent display name + commit subject + relative time; clicking a row
 * expands it to that commit's changed files + per-file diff through the SAME
 * `/api/git-show` path the per-agent GitBadges commit row uses (reusing CommitFile /
 * CommitMessage verbatim — the only divergence is the `id`: each fleet row passes
 * its OWN agent key, where the badge passes one chatId for all its rows).
 *
 * Purely additive — NO new endpoint, NO new poll, NO new SSH:
 *  • reuses /api/git-log (limit) for the fan-out;
 *  • reuses /api/git-show for the click-through-to-diff;
 *  • reuses the Promise.allSettled fleet convention (one unreachable agent never
 *    blanks the others — WARDEN-89).
 *
 * The pure aggregation (population gate + URL builder + the epoch merge) lives in
 * @/lib/gitStateSummary (unit-tested without React); this file owns only the
 * fan-out + the expand-to-diff render.
 *
 * Refresh strategy (decision #1): fetch-on-mount + a MANUAL refresh affordance. This
 * view's data is NOT already in scope (unlike the heatmap, which rides the 60s
 * useActivitySeries poll), and it introduces its own N-fetch fan-out — so it does NOT
 * silently poll at 60s across N agents (a steady N requests every minute). The
 * human pulls a fresh "what just shipped" on demand. ↑unpushed join (WARDEN-723):
 * each agent fires its recent + outgoing (range=outgoing, @{u}..HEAD) fetches
 * concurrently (2N) so each row can carry the precise per-hash ↑ mark — ported from
 * FleetCommitSearch. Decision #1 still bounds the 2N: it fires only on mount /
 * membership change / manual ↻, never on a steady auto-poll cadence.
 */

interface Props {
  /** The fleet agents (healthData.agents) — the population the feed fans out over. */
  agents: readonly Chat[];
  // Open a committed file in the FileViewer (WARDEN-757). Multi-agent analog of
  // GitBadges' per-popover onOpenFile: because this feed rolls every agent's
  // commits into one list, the callback carries the chatId (the row's agent key)
  // so HealthDashboard's single FileViewer knows WHICH agent's repo to read from
  // — exactly the identifier already passed as chatId={row.key} to each CommitFile
  // below. Mirrors how ChatSidebar binds c.key per ChatRow closure, lifted one
  // level since the .map lives here. Optional: when absent, CommitFile renders
  // WITHOUT the 📄 open-file affordance, preserving today's inline-diff-only
  // fleet behavior (the asymmetry this closes only when the host opts in).
  onOpenFile?: (chatId: string, path: string) => void;
}

// Per-agent fetch limit AND the display slice bound. The fan-out asks each active
// project agent for its RECENT_LIMIT newest commits; the merged, epoch-sorted result
// is then sliced to the same number so the feed stays a GLANCE (top ~25 across the
// fleet), not a firehose — the same bounded-glance discipline as the heatmap. Within
// the 20–30 the ticket steers; the backend clamps limit to [1,50] regardless.
const FLEET_RECENT_LIMIT = 25;

// One expanded commit's /api/git-show outcome (files + body), keyed by `${key}:${hash}`
// so the cache is correct per-agent — git-show's `id` is the agent key, and (in the
// degenerate case of two keys resolving to the same repo) a hash must not share its
// file list across agents. Matches GitBadges' showCache shape, minus its single-
// agent assumption.
type ShowCache = Record<string, { files?: GitFile[]; message?: string; error?: string | null }>;

export function FleetRecentCommits({ agents, onOpenFile }: Props) {
  // LOCAL collapse state — never serialized to /api/config (avoids the dead-pref
  // trap). Defaults open so the fleet's recent shipments are glanceable on entry.
  const [open, setOpen] = useState(true);

  // The searchable fleet: active project agents, keyed & deduped by key, in
  // catalog order. Memoized on `agents` — a CHEAP filter, fine to recompute. NOTE:
  // this array is NOT reference-stable across unchanged membership: `agents`
  // (healthData.agents) is a fresh array every ~10s (HealthDashboard polls
  // /api/health on a 10s setInterval and setHealthData()s a new res.json() object
  // each tick), so useMemo([agents]) re-allocates every 10s even when the member
  // SET is identical. The fan-out effect below must NOT key on this churned
  // reference (that would refire N /api/git-log fetches every 10s — the silent
  // auto-poll decision #1 + success criterion #3 forbid); it keys on `eligibleKey`.
  const eligible = useMemo(() => fleetCommitSearchEligible(agents), [agents]);
  const fleetN = eligible.length;
  // A primitive SIGNATURE of the eligible fleet (the joined agent keys). A string is
  // value-compared in the effect's deps, so it is identical across the 10s healthData
  // array churn and changes ONLY when the actual member SET changes (a key
  // added/removed/replaced). `fleetCommitSearchEligible` already dedupes by key, so
  // the key list IS the fleet identity — this is what the fetch effect depends on,
  // NOT the churned array reference.
  const eligibleKey = eligible.map((a) => a.key).join('\n');
  // Hand the effect the FRESHEST eligible fleet without putting that churned array
  // reference in the deps: the effect dereferences this ref at fire time. (Reading
  // `eligible` straight from the effect closure would also work — same membership
  // between signature-unchanged renders — but the ref is unambiguously current and
  // survives any future re-render mid-fan-out.)
  const eligibleRef = useRef(eligible);
  eligibleRef.current = eligible;

  const [result, setResult] = useState<FleetRecentCommitsResult | null>(null);
  const [loading, setLoading] = useState(false);
  // Bumped by the manual refresh button to force a refetch (fetch-on-mount otherwise).
  const [refreshTick, setRefreshTick] = useState(0);

  // Click-through expand state: the `${key}:${hash}` of the one expanded commit row
  // (single-open, mirroring GitBadges' expandedHash). Null = all collapsed.
  const [expandedRow, setExpandedRow] = useState<string | null>(null);
  const [showCache, setShowCache] = useState<ShowCache>({});
  const [showLoading, setShowLoading] = useState<Record<string, boolean>>({});

  // Resolve each agent's display name by its resolved key (key || id) — the same key
  // fleetCommitSearchEligible dedupes on, so every merged row's key resolves here.
  const nameByKey = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of agents) m.set(c.key || c.id, displayName(c));
    return m;
  }, [agents]);

  // Fetch-on-mount + manual refresh. NO auto-poll (decision #1 + success criterion
  // #3): this view's N-fetch fan-out is paid on demand, never on a steady cadence.
  // The effect keys on `eligibleKey` (a primitive signature of fleet membership) +
  // `refreshTick` (the manual ↻ button) — NOT on the `eligible` array, whose
  // reference churns every ~10s with healthData. So it fires ONLY on mount, on a
  // real membership change (a key added/removed), or on a manual refresh — never on
  // the 10s health tick. The freshest eligible fleet is read from `eligibleRef` at
  // fire time so the fan-out always iterates the current fleet.
  useEffect(() => {
    const cur = eligibleRef.current;
    // No searchable agents → resolve immediately to an empty result rather than
    // spinning the loading state forever (e.g. a fleet with no active project chats).
    if (cur.length === 0) {
      setResult({ rows: [], errorCount: 0 });
      setLoading(false);
      return;
    }
    setLoading(true);
    let cancelled = false;
    (async () => {
      // Promise.allSettled (the fleet convention, ChatSidebar.tsx handleBroadcast /
      // handleKillSelected + FleetCommitSearch): one unreachable / non-git agent never
      // rejects the whole; a per-agent failure is counted and surfaced as an honest
      // "(N unreachable)" note (WARDEN-89 — never let a failure masquerade as a barren
      // history). Each agent fires TWO concurrent fetches — recent + outgoing
      // (range=outgoing, @{u}..HEAD) — so each row can carry the precise per-hash
      // ↑unpushed mark (WARDEN-723, ported from FleetCommitSearch). 2N, but decision
      // #1 bounds it to mount / membership change / manual ↻ (no auto-poll).
      const settled = await Promise.allSettled(
        cur.map(async ({ key, project }) => {
          // buildFleetRecentCommitsUrl stays range-free; &range=outgoing is appended
          // HERE (mirroring how FleetCommitSearch appends it to the range-free
          // buildFleetSearchBaseUrl) so the pure URL builder stays single-purpose.
          const base = buildFleetRecentCommitsUrl(key, FLEET_RECENT_LIMIT);
          const [recentR, outgoingR] = await Promise.all([fetch(base), fetch(`${base}&range=outgoing`)]);
          // WARDEN-89: fetch() resolves (does NOT reject) on a 4xx/5xx — gate on
          // recentR.ok so an unreachable agent (404) throws and is counted as that
          // agent's error instead of reading undefined `commits` as an empty list
          // (false-empty disease). The recent fetch is the reachability probe.
          if (!recentR.ok) throw new Error(`git-log HTTP ${recentR.status}`);
          const j = await recentR.json();
          const commits = Array.isArray(j.commits) ? j.commits : [];
          // The outgoing fetch may 404 / non-ok too, but if `recent` resolved the agent
          // is reachable; a failed outgoing fetch just yields no unpushed marks — a
          // commit is never WRONGLY marked unpushed by a missing outgoing set (the
          // graceful-degradation contract, ported verbatim from FleetCommitSearch).
          const outgoingHashes = new Set<string>();
          if (outgoingR.ok) {
            const oj = await outgoingR.json();
            if (Array.isArray(oj.commits)) for (const c of oj.commits) outgoingHashes.add(c.hash);
          }
          return { ok: true as const, key, project, commits, outgoingHashes };
        }),
      );
      if (cancelled) return;
      // Unwrap allSettled → outcomes in input (catalog) order; a rejected promise (a
      // thrown !r.ok, or a bad-JSON throw) becomes that agent's error outcome, keyed
      // from the same `cur` entry so it still carries key/project.
      const outcomes = settled.map((s, i) =>
        s.status === 'fulfilled'
          ? s.value
          : { ok: false as const, key: cur[i].key, project: cur[i].project },
      );
      // WARDEN-89: never swallow a per-agent failure silently — log with context so a
      // network failure or bad JSON leaves a trace instead of "no commits."
      for (const s of settled) {
        if (s.status === 'rejected') console.warn('[fleet recent commits] agent fetch failed:', s.reason);
      }
      setResult(mergeFleetCommitsByEpoch(outcomes));
      setLoading(false);
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `eligibleKey` is the
    // primitive membership signature (value-stable across the 10s healthData array
    // churn); the fan-out reads the freshest fleet from `eligibleRef`, so `eligible`
    // is intentionally NOT in deps — depending on the array would refire every 10s.
  }, [eligibleKey, refreshTick]);

  // Fetch a commit's changed files + body via /api/git-show (the click-through path
  // the per-agent GitBadges row uses). Cached by `${key}:${hash}` (per-agent). A plain
  // function, not useCallback — nothing memoizes around it (toggleRow is inline too),
  // so it always reads the freshest cache. Mirrors GitBadges' fetchShow, diverging
  // only in the per-row key (multi-agent).
  const fetchShow = async (key: string, hash: string) => {
    const cacheKey = `${key}:${hash}`;
    if (showCache[cacheKey] || showLoading[cacheKey]) return;
    setShowLoading((p) => ({ ...p, [cacheKey]: true }));
    try {
      const r = await fetch(`/api/git-show?id=${encodeURIComponent(key)}&hash=${encodeURIComponent(hash)}`);
      const j = await r.json();
      setShowCache((p) => ({ ...p, [cacheKey]: { files: Array.isArray(j.files) ? j.files : [], message: typeof j.message === 'string' ? j.message : undefined, error: j.error } }));
    } catch {
      setShowCache((p) => ({ ...p, [cacheKey]: { files: [], error: 'fetch failed' } }));
    } finally {
      setShowLoading((p) => ({ ...p, [cacheKey]: false }));
    }
  };

  // Toggle a row's expand. Expanding fires the file-list fetch (once, cached); the
  // expanded row is the sole open one (single-open, mirroring GitBadges).
  const toggleRow = (key: string, hash: string) => {
    const cacheKey = `${key}:${hash}`;
    if (expandedRow !== cacheKey) fetchShow(key, hash);
    setExpandedRow((cur) => (cur === cacheKey ? null : cacheKey));
  };

  const refresh = () => {
    setExpandedRow(null);
    setRefreshTick((t) => t + 1);
  };

  // Copy via the Electron-safe helper + a sonner success/error toast — the same
  // pattern WorkspaceSearchDialog / GlobalSearchDialog Copy items use. Never bare
  // navigator.clipboard, which fails silently in Electron (WARDEN-68 Rule 3); the
  // caller owns the toast per the copyText contract (lib/clipboard.ts).
  const handleCopy = async (text: string) => {
    const ok = await copyText(text);
    if (ok) toast.success('Copied');
    else toast.error('Copy failed');
  };

  // The glance: slice the merged, epoch-sorted rows to the bound (top FLEET_RECENT_LIMIT
  // across the fleet). Slice AFTER the sort so the newest N survive regardless of how
  // many each agent contributed.
  const rows = result?.rows.slice(0, FLEET_RECENT_LIMIT) ?? [];
  const errorCount = result?.errorCount ?? 0;
  const hasRows = rows.length > 0;
  // EVERY agent's fetch failed → a true "couldn't reach the fleet" empty, surfaced
  // honestly with the unreachable note rather than a silent "no commits" (WARDEN-89
  // false-empty guard). Requires errorCount to cover the WHOLE eligible fleet, not
  // merely be > 0: a PARTIAL failure (some agents reached but barren, some
  // unreachable) is NOT this case — those reached agents simply had no commits, so
  // the body falls through to the "No recent commits" empty state while the yellow
  // note above still names the unreachable count. (errorCount <= fleetN always — one
  // outcome per eligible agent — so >= is "all"; !hasRows is implied but kept
  // defensive in case errorCount accounting ever drifts.)
  const allFailed = fleetN > 0 && errorCount >= fleetN && !hasRows;
  const hasEligible = fleetN > 0;

  return (
    <section
      className="rounded-md border border-border bg-card/40"
      aria-label="Recent commits across the fleet"
    >
      {/* Collapsible header — the ▾/▸ affordance mirrors FleetActivityHeatmap so the
          collapse reads the same everywhere in Fleet Health. The manual refresh (↻)
          is the only way to pull a fresh view past mount (no auto-poll). */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 px-2 py-1.5 text-left text-[11px] font-semibold uppercase tracking-wider text-muted-foreground hover:bg-accent rounded-md transition-colors"
      >
        <span className="text-[10px] text-muted-foreground/60 w-2 shrink-0">{open ? '▾' : '▸'}</span>
        <span>Recent commits</span>
        <span className="ml-auto normal-case tracking-normal text-[10px] text-muted-foreground/70">
          {hasEligible ? `${fleetN} agent${fleetN === 1 ? '' : 's'}` : ''}
        </span>
        {/* stopPropagation so the ↻ refreshes without also toggling the collapse. */}
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          onClick={(e) => { e.stopPropagation(); refresh(); }}
          disabled={loading || !hasEligible}
          aria-label="refresh recent commits across the fleet"
          title="refresh — pull the fleet's newest commits on demand (no auto-poll)"
          className="text-muted-foreground hover:text-foreground"
        >
          <RotateCw className={cn('size-3', loading && 'animate-spin')} />
        </Button>
      </button>

      {open && (
        <div className="px-2 pb-2 pt-0.5">
          {/* Honest partial-failure note (WARDEN-89): rendered ABOVE the list whether or
              not rows survived, so an all-failed fleet never reads as a silent empty. */}
          {errorCount > 0 && (
            <div className="mb-1 px-0.5 text-[10px] text-yellow-500/80">
              {errorCount} agent{errorCount === 1 ? '' : 's'} unreachable{hasRows ? ' — showing the rest' : ''}
            </div>
          )}
          {loading && !result ? (
            <div className="flex items-center gap-1.5 px-1 py-2">
              <Skeleton className="size-2 rounded-full" />
              <span className="text-[10px] text-muted-foreground">loading recent commits across {fleetN} agent{fleetN === 1 ? '' : 's'}…</span>
            </div>
          ) : !hasEligible ? (
            <div className="py-2 text-center text-[10px] text-muted-foreground">
              No active project agents to show commits for.
            </div>
          ) : allFailed ? (
            <div className="py-2 text-center text-[10px] text-muted-foreground">
              Couldn't reach any agent's commit history.
            </div>
          ) : !hasRows ? (
            <div className="py-2 text-center text-[10px] text-muted-foreground">
              No recent commits across active project agents.
            </div>
          ) : (
            <ul className="flex max-h-[60vh] flex-col gap-0.5 overflow-auto">
              {rows.map((row) => {
                const name = nameByKey.get(row.key) ?? row.key;
                const cacheKey = `${row.key}:${row.commit.hash}`;
                const isExpanded = expandedRow === cacheKey;
                const shown = showCache[cacheKey];
                const files = shown?.files ?? [];
                return (
                  // One merged commit row: agent name + subject + relative time. The
                  // cross-fleet differentiator is the AGENT name (the per-agent lists
                  // each carry only their own), so it leads. role="button" div (not a
                  // nested <button>) so it is keyboard-operable and can host the
                  // expanded file list as a sibling — the FleetCommitSearch / GitBadges
                  // pattern. Click → expand to that commit's /api/git-show diff.
                  <li key={cacheKey} className="rounded">
                    <ContextMenu>
                      <ContextMenuTrigger asChild>
                        <div
                          role="button"
                          tabIndex={0}
                          aria-expanded={isExpanded}
                          aria-label={`inspect ${name} commit ${row.commit.hash}: ${row.commit.subject}`}
                          onClick={() => toggleRow(row.key, row.commit.hash)}
                          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleRow(row.key, row.commit.hash); } }}
                          title={`inspect files changed by ${row.commit.hash} — ${name}`}
                          className="flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left hover:bg-accent cursor-pointer focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary"
                        >
                          <span className="min-w-0 flex-1">
                            {/* Agent name (foreground) · relative time (muted, right). The
                                relative time is %ar from GIT_LOG_PRETTY — the same "2 hours
                                ago" the per-agent row shows. */}
                            <span className="flex items-baseline gap-1">
                              <span className="truncate text-[10px] font-medium text-foreground" title={name}>{name}</span>
                              <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">{row.commit.date}</span>
                            </span>
                            {/* hash (cyan mono, mirrors GitBadges) · amber ↑ when the commit is
                                still unpushed (local-only — HEAD has it, @{u} doesn't; the
                                outgoing (@{u}..HEAD) hash-join WARDEN-723 ported from
                                FleetCommitSearch) · subject (truncated). */}
                            <span className="flex items-center gap-1">
                              <span className="shrink-0 font-mono text-[10px] text-cyan-400/80">{row.commit.hash}</span>
                              {row.unpushed && <span className="shrink-0 text-[10px] text-amber-400" title="unpushed (local, not yet pushed)">↑</span>}
                              <span className="min-w-0 truncate text-[10px] text-foreground" title={row.commit.subject}>{row.commit.subject}</span>
                            </span>
                          </span>
                          <span className="ml-auto shrink-0 self-center text-[10px] text-muted-foreground">{isExpanded ? '▾' : '▸'}</span>
                        </div>
                      </ContextMenuTrigger>
                      {/* Themed right-click Copy menu (Context-Menu Completeness roadmap /
                          WARDEN-875): wraps the ROW div only, so the expanded CommitFile
                          sub-rows below stay menu-less. Each item copies a field that is
                          rendered-but-truncated / selection-hostile today (the subject +
                          agent name are tooltip-only). onSelect (not onClick) mirrors every
                          sibling Copy slice. asChild only adds onContextMenu — left-click
                          still toggles, Enter·Space still expand. */}
                      <ContextMenuContent>
                        <ContextMenuItem onSelect={() => handleCopy(row.commit.hash)}>Copy commit hash</ContextMenuItem>
                        <ContextMenuItem onSelect={() => handleCopy(row.commit.subject)}>Copy commit subject</ContextMenuItem>
                        <ContextMenuItem onSelect={() => handleCopy(name)}>Copy agent name</ContextMenuItem>
                      </ContextMenuContent>
                    </ContextMenu>
                    {isExpanded && (
                      // Expanded: that commit's changed files + per-file diff via
                      // /api/git-show — the SAME path GitBadges' per-agent row takes,
                      // reusing CommitMessage + CommitFile verbatim. Each CommitFile
                      // passes this row's agent key as chatId so its per-file diff
                      // resolves against the right repo (git-show's id = the agent key).
                      <div className="pb-1 pl-1">
                        <CommitMessage message={shown?.message} />
                        {showLoading[cacheKey] && !shown ? (
                          <div className="px-1 text-[10px] text-muted-foreground">loading files…</div>
                        ) : files.length > 0 ? (
                          <div className="flex flex-col gap-0.5">
                            {files.map((f) => (
                              <CommitFile key={`${cacheKey}:${f.path}`} chatId={row.key} hash={row.commit.hash} file={f} onOpenFile={bindFleetRowOpenFile(onOpenFile, row.key)} />
                            ))}
                          </div>
                        ) : (
                          <div className="px-1 text-[10px] text-muted-foreground">{shown?.error ? 'failed to load' : 'no files'}</div>
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          {/* Honest cap note (bounded-glance discipline): never let a silent slice
              read as "everything." If the merge produced more than the bound, say so. */}
          {hasRows && (result?.rows.length ?? 0) > FLEET_RECENT_LIMIT && (
            <div className="mt-1 px-0.5 text-[10px] text-muted-foreground/70">
              top {FLEET_RECENT_LIMIT} of {result?.rows.length} recent commits
            </div>
          )}
        </div>
      )}
    </section>
  );
}
