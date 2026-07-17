import { useState, useEffect, useMemo } from 'react';
import { RotateCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { displayName } from '@/lib/chatDisplay';
import {
  fleetCommitSearchEligible,
  mergeFleetCommitsByEpoch,
  buildFleetRecentCommitsUrl,
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
 * human pulls a fresh "what just shipped" on demand. Recent-only (decision #2): one
 * fetch per agent (N, not the 2N the query-driven search pays for its ↑unpushed
 * join); the ↑unpushed mark is a deferred follow-up.
 */

interface Props {
  /** The fleet agents (healthData.agents) — the population the feed fans out over. */
  agents: readonly Chat[];
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

export function FleetRecentCommits({ agents }: Props) {
  // LOCAL collapse state — never serialized to /api/config (avoids the dead-pref
  // trap). Defaults open so the fleet's recent shipments are glanceable on entry.
  const [open, setOpen] = useState(true);

  // The searchable fleet: active project agents, keyed & deduped by key, in
  // catalog order. Memoized on `agents` so a stable array reference feeds the fetch
  // effect's deps (avoids refiring on every re-render that didn't change membership).
  const eligible = useMemo(() => fleetCommitSearchEligible(agents), [agents]);
  const fleetN = eligible.length;

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

  // Fetch-on-mount + manual refresh. NO 60s auto-poll (decision #1): this view's
  // N-fetch fan-out is paid on demand, not on a steady cadence. `refreshTick` is the
  // only way to force a refetch beyond mount — a stable identity dep so the effect
  // doesn't refire on every render. `eligible` is memoized (stable across unchanged
  // membership), so the effect fires on mount, on a membership change, or on refresh.
  useEffect(() => {
    // No searchable agents → resolve immediately to an empty result rather than
    // spinning the loading state forever (e.g. a fleet with no active project chats).
    if (eligible.length === 0) {
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
      // history). Recent-only (decision #2): ONE fetch per agent (N, not 2N — no
      // outgoing ↑unpushed join).
      const settled = await Promise.allSettled(
        eligible.map(async ({ key, project }) => {
          const r = await fetch(buildFleetRecentCommitsUrl(key, FLEET_RECENT_LIMIT));
          // WARDEN-89: fetch() resolves (does NOT reject) on a 4xx/5xx — gate on r.ok
          // so an unreachable agent (404) throws and is counted as that agent's error
          // instead of reading undefined `commits` as an empty list (false-empty disease).
          if (!r.ok) throw new Error(`git-log HTTP ${r.status}`);
          const j = await r.json();
          const commits = Array.isArray(j.commits) ? j.commits : [];
          return { ok: true as const, key, project, commits };
        }),
      );
      if (cancelled) return;
      // Unwrap allSettled → outcomes in input (catalog) order; a rejected promise (a
      // thrown !r.ok, or a bad-JSON throw) becomes that agent's error outcome, keyed
      // from the same `eligible` entry so it still carries key/project.
      const outcomes = settled.map((s, i) =>
        s.status === 'fulfilled'
          ? s.value
          : { ok: false as const, key: eligible[i].key, project: eligible[i].project },
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
  }, [eligible, refreshTick]);

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

  // The glance: slice the merged, epoch-sorted rows to the bound (top FLEET_RECENT_LIMIT
  // across the fleet). Slice AFTER the sort so the newest N survive regardless of how
  // many each agent contributed.
  const rows = result?.rows.slice(0, FLEET_RECENT_LIMIT) ?? [];
  const errorCount = result?.errorCount ?? 0;
  const hasRows = rows.length > 0;
  // Every agent failed (or no eligible fleet) → a true empty, surfaced honestly with
  // the unreachable note rather than a silent "no commits" (WARDEN-89 false-empty guard).
  const allFailed = fleetN > 0 && !hasRows && errorCount > 0;
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
                        {/* hash (cyan mono, mirrors GitBadges) · subject (truncated). */}
                        <span className="flex items-center gap-1">
                          <span className="shrink-0 font-mono text-[10px] text-cyan-400/80">{row.commit.hash}</span>
                          <span className="min-w-0 truncate text-[10px] text-foreground" title={row.commit.subject}>{row.commit.subject}</span>
                        </span>
                      </span>
                      <span className="ml-auto shrink-0 self-center text-[10px] text-muted-foreground">{isExpanded ? '▾' : '▸'}</span>
                    </div>
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
                              <CommitFile key={`${cacheKey}:${f.path}`} chatId={row.key} hash={row.commit.hash} file={f} />
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
