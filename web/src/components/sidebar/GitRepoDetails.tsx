// GitRepoDetails — the repo's full detail (the old badge popover BODY) plus its private
// list-fetch machinery, split out of GitBadges.tsx (WARDEN-1976). Pure structural move:
// the shared row/summary vocabulary (CommitRow, StashFile, STALE_HEAD_AGE_MS, …) stays in
// GitBadges.tsx and is imported one-way from here — GitBadges must never import this file.

import { useState, useEffect, useMemo, useCallback } from 'react';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { EditableContextMenu } from '@/components/ui/editable-context-menu';
import { IconTooltip } from '@/components/ui/icon-tooltip';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from '@/components/ui/context-menu';
import { copyWithToast } from '@/lib/clipboardToast';
import { openExternalUrl } from '@/lib/electron';
import { GitCompare, Search, X, ExternalLink } from 'lucide-react';
import { DiffViewer } from '@/components/DiffViewer';
import { cn } from '@/lib/utils';
import { formatTimestamp, formatAbsoluteFull } from '@/lib/formatTimestamp';
import { useTimestampFormat, useSourceControlExpandedHash, useSetSourceControlExpandedHash, useSourceControlGrepInput, useSetSourceControlGrepInput } from '@/lib/uiStore';
import type { GitCommit, GitFile, GitStash, GitReflogEntry, GitRemote, GitBranch, DiffStat } from './types';
import { DiffStatChip } from './DiffStatChip';
import { fetchBounded, readListBody, readListResponse } from '@/lib/api';
import { CommitRow, StashFile, STALE_HEAD_AGE_MS } from './GitBadges';

// A list section's failure as reported by its DATA source — never pre-phrased. The
// two kinds are genuinely different events and only one of them carries a message, so
// the kind (not a composed string) is what crosses the data→render boundary
// (WARDEN-1014 review: `listFor` was composing user-facing copy inside a helper whose
// job is choosing between the search and browse sources).
type ListFailure =
  /** The commit-grep RPC failed. It reports no message of its own. */
  | { kind: 'search' }
  /** A list fetch failed; `reason` is the raw text readListResponse produced. */
  | { kind: 'fetch'; reason: string };

// The ONE home for a failed git-list fetch: both the phrasing AND the colour. Every
// surface that reports a list failure goes through here — the stash / reflog / branch
// terminal rows, the three commit lists, and the origin row — so the same semantic
// event cannot render as amber in one half of a popover and destructive-red in the
// other, and the `failed to load: …` copy has exactly one definition (WARDEN-1014
// review found it built in two places and coloured two ways in a single diff).
//
// `truncate` + `title` keep a long git message from blowing out the narrow sidebar
// column. `noun` names WHICH list when the row sits outside its own section (the origin
// row reports the *remote* fetch from inside the branch header). `className` is merged
// through `cn`/tailwind-merge, so a caller can restate spacing without forking colour.
function ListErrorRow({ failure, noun, className }: { failure: ListFailure; noun?: string; className?: string }) {
  const text = failure.kind === 'search'
    ? 'search failed — try again'
    : `failed to load${noun ? ` ${noun}` : ''}: ${failure.reason}`;
  return (
    <div className={cn('truncate px-1 py-1 text-[10px] text-amber-400', className)} title={text}>
      {text}
    </div>
  );
}

// One lazy list section's terminal row: the FAILURE state when the fetch reported an
// error, else the plain empty state. Before WARDEN-1014 every one of these sections
// rendered only the empty state, so a 200 carrying {error} (an unreachable SSH host, a
// cwd-less chat) was indistinguishable from a genuinely clean repo — "no stashes" for
// both. The amber failure row makes the two visually distinguishable. Mirrors the
// in-file positive control at the commit-inspect sites (`?.error ? 'failed to load'
// : 'no files'`), which fetchShow/fetchStashShow have always fed correctly.
function ListStateRow({ error, empty }: { error: string | null; empty: string }) {
  if (error) return <ListErrorRow failure={{ kind: 'fetch', reason: error }} />;
  return <div className="px-1 py-1 text-[10px] text-muted-foreground">{empty}</div>;
}

// Shared skeleton for GitRepoDetails' four lazy list-fetchers (stash / reflog /
// remote / branch), which were the same twelve lines written four times, differing
// ONLY in route, response key and state pair — the "mirrors fetchStash" / "mirrors
// fetchReflog" comments documented that duplication instead of factoring it. Same DRY
// move as useGitLogFetcher in ChatSidebar (:177) and DiffInspectRow here (WARDEN-1003).
// GET /api/git-<axis>?id=…, store the list, toggle the loading flag. Always fetches —
// dedup is at the call site (the expand effect guards on `list === undefined`; each
// refresh button is disabled while loading). All four routes are read-only.
// `onBeforeFetch` runs after the loading flag is raised and before the request, for an
// axis that must reset companion state first (stash's WARDEN-340 cache drop — see its
// call site). Deps are all stable, so the fetcher's identity is too.
//
// WARDEN-1014 closes the banked follow-up this comment used to concede ("`j.error` is
// still discarded"): the read now goes through the shared `readListResponse`, which
// honours BOTH halves of the backend convention — a non-2xx AND a 200 whose body
// carries `{error}` alongside the `gitDefaults` empty array (src/gitRoutes.js:490,
// :494). `setError` is the channel added alongside `setList`, mirroring how showCache
// stores `{ files, error }`. A failure STILL caches `[]` so the expand effect's
// `=== undefined` guard doesn't loop on re-expand — the difference is that the error
// now rides alongside it, so the render distinguishes "failed" from "empty" instead of
// silently showing "no stashes" for an unreachable host (the WARDEN-89 false-empty).
function useGitListFetcher<T>({ chatId, route, responseKey, label, setList, setError, setLoading, onBeforeFetch }: {
  chatId: string;
  route: string;
  responseKey: string;
  /** Human-readable noun for the failure copy ('stashes', 'branches', …). */
  label: string;
  setList: (items: T[]) => void;
  setError: (error: string | null) => void;
  setLoading: (value: boolean) => void;
  onBeforeFetch?: () => void;
}) {
  return useCallback(async () => {
    setLoading(true);
    setError(null);
    onBeforeFetch?.();
    try {
      // WARDEN-1144: bounded — gates this section's `loading` (stash / reflog /
      // remote / branch panels), cleared only by the finally after this await.
      const r = await fetchBounded(`${route}?id=${encodeURIComponent(chatId)}`);
      // Tolerant on !ok, STRICT on 2xx — a 2xx body that fails to parse reaches the
      // catch instead of becoming an empty list with no error (WARDEN-1014 review).
      const j = await readListBody(r);
      const { items, error } = readListResponse<T>(r, j, responseKey, label);
      setList(items);
      setError(error);
    } catch (e) {
      setList([]);
      setError(e instanceof Error ? e.message : `Failed to load ${label}`);
    } finally {
      setLoading(false);
    }
  }, [chatId, route, responseKey, label, setList, setError, setLoading, onBeforeFetch]);
}

/**
 * The focused repo's FULL detail, rendered INLINE inside the git section
 * (WARDEN-975). This is the per-row GitBranchBadge's popover BODY, verbatim in
 * content and behaviour — commit search, the recent / unpushed / incoming commit
 * lists with their per-commit changed-files + inline diffs, the aggregated
 * "full diff" range affordances, stashes, the reflog, the branch topology and the
 * origin row — minus the popover shell and its chat-row trigger.
 *
 * Lazy-fetch discipline is unchanged, only re-anchored: everything the popover
 * fetched on first OPEN is fetched when the section is first EXPANDED, each guarded
 * so a re-expand reuses the cache. The component stays mounted while collapsed (only
 * its body is hidden) so those caches — and any expanded commit — survive a
 * collapse/expand round trip exactly as they survived a popover close/reopen. The
 * caller keys it by chat id, so switching the focused pane remounts it with a clean
 * cache rather than showing the previous repo's commits.
 *
 * Nothing here navigates: every control opens a diff, expands a list, or opens a
 * file — never a pane.
 */
export function GitRepoDetails({ branch, clean, commits, commitsError, loading, onFetch, ahead, behind, chatId, stashCount, diffstat, incomingCommits, incomingError, incomingLoading, onFetchIncoming, outgoingCommits, outgoingError, outgoingLoading, onFetchOutgoing, detached, headSha, upstream, onOpenFile, expanded }: {
  branch: string;
  clean: boolean | null;
  commits?: GitCommit[];
  // WARDEN-1014: the failure reason for the recent-commits fetch, or null/undefined
  // when it succeeded. Owned by ChatSidebar alongside the cache itself (that is where
  // useGitLogFetcher writes it) and forwarded through SourceControlPanel, exactly like
  // the `commits` / `loading` pair it rides with.
  commitsError?: string | null;
  loading?: boolean;
  onFetch?: () => void;
  ahead?: number | null;
  behind?: number | null;
  chatId: string;
  stashCount?: number | null;
  // WARDEN-411: net insertions/deletions of the working-tree edits vs HEAD, or null
  // when clean/unavailable. Rendered as the uncommitted section's +N −M chip and
  // threaded to the aggregated worktree DiffViewer so the chip and the diff agree.
  diffstat?: DiffStat | null;
  // WARDEN-225: the "behind" half — commits @{u} has that HEAD doesn't. Lazily
  // fetched on expand when behindCount > 0, with its own cache/loader so it refreshes
  // independently of the local recent-commits list. Explorable (WARDEN-348): each row
  // expands to its changed files + per-file diff via /api/git-show — these are local
  // objects reachable from the upstream remote-tracking ref (@{u}), so git show serves
  // them without a pull.
  incomingCommits?: GitCommit[];
  /** WARDEN-1014: incoming fetch failure reason, or null. Mirrors commitsError. */
  incomingError?: string | null;
  incomingLoading?: boolean;
  onFetchIncoming?: () => void;
  // WARDEN-252: the "ahead/unpushed" half — commits HEAD has that @{u} doesn't. The
  // symmetric counterpart to incomingCommits. Lazily fetched on expand when aheadCount
  // > 0, with its own cache/loader. Explorable (WARDEN-303): each row expands to its
  // changed files + per-file diff via /api/git-show. Both halves are explorable —
  // outgoing commits are reachable from HEAD, incoming from @{u} (WARDEN-348).
  outgoingCommits?: GitCommit[];
  /** WARDEN-1014: outgoing fetch failure reason, or null. Mirrors commitsError. */
  outgoingError?: string | null;
  outgoingLoading?: boolean;
  onFetchOutgoing?: () => void;
  // WARDEN-239: HEAD is not on a branch (an agent checked out a specific commit).
  // Rendered as the detached short SHA (+ its commit deep-link) instead of the
  // misleading literal "HEAD" branch label. ahead/behind are null on detached.
  detached?: boolean;
  headSha?: string | null;
  // WARDEN-243: the short upstream tracking branch (e.g. origin/feature), or null
  // when HEAD has no upstream. Selects the primary remote for the deep-links below.
  upstream?: string | null;
  // WARDEN-478: open a touched file's full content in the FileViewer from inside the
  // commit lists. Threaded to each CommitFile row (recent, outgoing, incoming) so a
  // committed file is readable — with blame/history one click away — not just diffable.
  onOpenFile?: (path: string) => void;
  // Whether the git section is expanded. Drives BOTH the body's visibility and the
  // lazy fetches (the popover's onOpenChange, re-anchored).
  expanded: boolean;
}) {
  const aheadCount = typeof ahead === 'number' ? ahead : 0;
  const behindCount = typeof behind === 'number' ? behind : 0;
  // WARDEN-1342 (slice 4 — the reach fix): per-branch freshness used to call
  // formatRelative directly, hardcoding relative mode. Honors the pref now.
  const timestampFormat = useTimestampFormat();
  const stashN = typeof stashCount === 'number' ? stashCount : 0;
  const isDetached = detached === true;
  const sha = typeof headSha === 'string' ? headSha.trim() : '';

  // Per-commit expand state + the /api/git-show files cache (keyed by hash) so a
  // repeat expansion is instant. This component owns the interaction, so the state
  // lives here rather than being prop-drilled through the section/ChatSidebar.
  //
  // WARDEN-1798 (slice 66): `expandedHash` (and the search term, `grepInput`, below) live
  // on the uiStore keyed by chatId, NOT in component-local cells — App's Settings ternary
  // unmounts this whole subtree, so local cells reset on return. `showCache`/`showLoading`
  // stay LOCAL (server data is not mirrored into the store), so a restored `expandedHash`
  // has no cache after remount; the restore effect below re-fetches it.
  const expandedHash = useSourceControlExpandedHash(chatId);
  const setExpandedHashFor = useSetSourceControlExpandedHash();
  const setExpandedHash = (hash: string | null) => setExpandedHashFor(chatId, hash);
  const [showCache, setShowCache] = useState<Record<string, { files?: GitFile[]; message?: string; error?: string | null }>>({});
  const [showLoading, setShowLoading] = useState<Record<string, boolean>>({});

  // Lazy stash detail (mirror of fetchShow for commits): undefined = not yet
  // fetched, [] = fetched-but-empty (stashes dropped since the count was read),
  // so we don't refetch forever on a legitimately-empty result.
  const [stashList, setStashList] = useState<GitStash[] | undefined>(undefined);
  const [stashLoading, setStashLoading] = useState(false);
  // WARDEN-1014: the error channel added alongside each list. null = no failure.
  // Set by useGitListFetcher from readListResponse, so it is non-null for BOTH a
  // non-2xx AND a 200 carrying {error} beside the gitDefaults empty array.
  const [stashError, setStashError] = useState<string | null>(null);

  // Lazy reflog detail (WARDEN-460): the agent's operation history — resets,
  // checkouts, abandoned rebases, force-pushes (the non-commit ops that leave no
  // commit AND no dirty file, diagnosable only in the reflog). Unlike stash this
  // has no eager count prop (the roadmap keeps it off the always-on badge), so we
  // fetch it on every first-open of the expanded view, guarded by `=== undefined`
  // so a repeat open reuses the cache. undefined = not yet fetched, [] = fetched-
  // but-empty (a fresh repo with no commits, or a non-git cwd soft-fail).
  const [reflogList, setReflogList] = useState<GitReflogEntry[] | undefined>(undefined);
  const [reflogLoading, setReflogLoading] = useState(false);
  const [reflogError, setReflogError] = useState<string | null>(null);

  // WARDEN-528: which remote repo this checkout maps to + its web host URL — the one
  // coordination fact every OTHER git facet omits. Lazily fetched on first open
  // (mirrors reflog: undefined = not yet fetched, [] = fetched-but-empty so a repeat
  // open reuses the cache). Read-only (/api/git-remote runs `git remote -v`, which
  // never mutates); never gated on a count because the remote identity is relevant
  // for EVERY repo (the deep-links + origin row render from it), not just a dirty one.
  const [remoteList, setRemoteList] = useState<GitRemote[] | undefined>(undefined);
  const [remoteLoading, setRemoteLoading] = useState(false);
  const [remoteError, setRemoteError] = useState<string | null>(null);

  // WARDEN-577: the agent's local branches — the topology the badge's single
  // current-branch name only gestures at (which OTHER branches exist, whether
  // work is scattered, whether a branch is stranded/unmerged or its upstream
  // gone). Lazily fetched on first open (mirrors reflog/remote: undefined = not
  // yet fetched, [] = fetched-but-empty so a repeat open reuses the cache).
  // Read-only (/api/git-branch runs `git for-each-ref refs/heads/`, which never
  // mutates); never gated on a count because every repo with a commit has at
  // least one branch.
  const [branchList, setBranchList] = useState<GitBranch[] | undefined>(undefined);
  const [branchLoading, setBranchLoading] = useState(false);
  const [branchError, setBranchError] = useState<string | null>(null);

  // Per-stash expand state + the /api/git-stash-show files cache (keyed by ref), a
  // parallel of expandedHash/showCache/showLoading for commits — so expanding a
  // stash is INDEPENDENT of expanding a commit (and vice versa). Mirrors the
  // commit-inspect pattern exactly; the only divergence is `ref=` instead of
  // `hash=` (a stash is addressed by its reflog selector stash@{n}). (WARDEN-340)
  // WARDEN-1798 deliberate exclusion: this stays LOCAL (not on the uiStore like expandedHash).
  // Stash refs are reflog selectors that shift on push/pop, and fetchStash's onBeforeFetch
  // (resetStashDetail) clears the expanded stash on every (re)fetch — which fires on remount —
  // so a restored ref would be cleared immediately or could show the wrong stash.
  const [expandedStashRef, setExpandedStashRef] = useState<string | null>(null);
  const [stashShowCache, setStashShowCache] = useState<Record<string, { files?: GitFile[]; error?: string | null }>>({});
  const [stashShowLoading, setStashShowLoading] = useState<Record<string, boolean>>({});

  // WARDEN-398: the aggregated range-diff modal target. Set by the "View full diff"
  // affordance in the outgoing (↑N) or incoming (↓N) section; null while closed.
  // WARDEN-449: extended to the ± (worktree) axis — `git diff HEAD`, no count (the
  // magnitude is the in-scope `diffstat` prop, not a commit count). Rendered by the
  // generalized DiffViewer (range mode) as a sibling of this section body.
  const [rangeDiff, setRangeDiff] = useState<{ kind: 'outgoing' | 'incoming' | 'worktree'; count?: number } | null>(null);

  // WARDEN-498: commit-message search across the per-agent lists. A small debounced
  // input above the lists fetches /api/git-log?grep= for each VISIBLE range (recent
  // always; outgoing when ahead; incoming when behind) so one term filters every list
  // at once. Results are held LOCALLY (mirrors the stash/reflog lazy-fetch pattern:
  // expanded-view-only, transient, lives in the badge that owns the interaction) so the
  // cached browse lists stay intact — clearing the box simply drops these and each
  // section reverts to its cached list (no refetch). The list RENDERING is unchanged —
  // only each section's data source swaps (see listFor below), so matches drill down via
  // the existing expand→changed-files→DiffBlock path with no new row type.
  // WARDEN-1798: store-backed (see expandedHash above); the debounced search effect below
  // re-runs on mount with the restored term and refetches the results.
  const grepInput = useSourceControlGrepInput(chatId);
  const setGrepInputFor = useSetSourceControlGrepInput();
  const setGrepInput = (text: string) => setGrepInputFor(chatId, text);
  // searchResults is keyed by range: '' (recent), 'outgoing', 'incoming'. A key's value
  // is `undefined` while that range's fetch is pending (or not yet started for this
  // term); `{ status: 'ok', commits }` once it resolved (possibly empty); or
  // `{ status: 'error' }` if the fetch failed (non-ok HTTP, network, or bad JSON). The
  // three states keep "loading", "fetched, no matches", and "fetch failed" distinct so
  // the empty/error states are honest (WARDEN-89 — never let a failure masquerade as a
  // barren history).
  type GrepResult = { status: 'ok'; commits: GitCommit[] } | { status: 'error' };
  const [searchResults, setSearchResults] = useState<Record<string, GrepResult | undefined>>({});
  const [searchLoading, setSearchLoading] = useState(false);
  const searching = grepInput.trim().length > 0;

  useEffect(() => {
    const q = grepInput.trim();
    if (!q) {
      // Cleared → drop search results so every section reverts to its cached browse list.
      setSearchResults({});
      setSearchLoading(false);
      return;
    }
    setSearchLoading(true);
    // Clear the previous term's results immediately so stale matches are never rendered
    // under the new query while the debounce + fetch are in flight (mirrors the
    // WARDEN-161 session-search discipline in OpenChatBrowserPage).
    setSearchResults({});
    let cancelled = false;
    // Only the ranges currently shown by the popover are worth searching — a hidden list
    // (e.g. outgoing when not ahead) has no rows to match, so skip it rather than issuing
    // a harmless-but-wasteful fetch. `range` is '' for the recent (HEAD-reachable) list.
    const ranges: string[] = [''];
    if (aheadCount > 0) ranges.push('outgoing');
    if (behindCount > 0) ranges.push('incoming');
    const t = setTimeout(async () => {
      const settled = await Promise.all(
        ranges.map(async (range): Promise<[string, GrepResult]> => {
          try {
            const url = `/api/git-log?id=${encodeURIComponent(chatId)}&grep=${encodeURIComponent(q)}` + (range ? `&range=${range}` : '');
            // WARDEN-1144: bounded — gates `searchLoading` (the grep popover's
            // "searching…"), which only clears once every range in this
            // Promise.all settles: ONE stalled range held the whole popover.
            const r = await fetchBounded(url);
            // WARDEN-1216: the response read goes through the shared readListBody +
            // readListResponse pair (the reference use lives in useGitListFetcher
            // above), so a 200 whose body carries {error} — git-log's documented
            // failure convention (withGitRepo src/gitRoutes.js:490/:494 spreads the
            // empty gitDefaults alongside error) — becomes { status: 'error' } instead
            // of a confident "no matches". Gating on r.ok alone (the previous fix)
            // catches the 404 half but not the 200 half.
            const j = await readListBody(r);
            const { items, error } = readListResponse<GitCommit>(r, j, 'commits', 'commits');
            if (error) throw new Error(error);
            return [range, { status: 'ok', commits: items }];
          } catch (error) {
            // WARDEN-89: never swallow silently — log with the range + term so a network
            // failure or bad JSON leaves a trace instead of looking like "no matches".
            console.warn('[WARDEN-498 git-log grep] failed:', error, { range, q });
            return [range, { status: 'error' }];
          }
        }),
      );
      if (cancelled) return;
      const next: Record<string, GrepResult | undefined> = {};
      for (const [range, result] of settled) next[range] = result;
      setSearchResults(next);
      setSearchLoading(false);
    }, 300);
    return () => { cancelled = true; clearTimeout(t); };
  }, [grepInput, chatId, aheadCount, behindCount]);

  // Resolve what a given section should render right now: its grep-filtered results when
  // a search is active, else its cached browse list. Returns the items (possibly
  // undefined while pending) and whether the section is in a loading state. Used below
  // to swap each list's data source without touching its row markup.
  // WARDEN-1014: `error` was a boolean meaning "the SEARCH failed"; it is now the
  // failure itself, so the BROWSE leg can report its own fetch failure through the
  // same channel. The browse error arrives as a prop — ChatSidebar's useGitLogFetcher
  // owns these three caches and now reads /api/git-log through readListResponse, so a
  // 200 carrying {error} no longer renders as "no commits". The value handed back is
  // the RAW failure, never user-facing copy: phrasing and colour live in ListErrorRow
  // (WARDEN-1014 review — composing strings here put presentation inside a helper that
  // only picks a data source, and duplicated the copy the row already owned).
  const listFor = (
    range: '' | 'outgoing' | 'incoming',
    browse: GitCommit[] | undefined,
    browseLoading: boolean,
    browseError?: string | null,
  ): { items: GitCommit[] | undefined; loading: boolean; error: ListFailure | null } => {
    if (searching) {
      const hit = searchResults[range];
      if (hit === undefined) return { items: undefined, loading: true, error: null };
      if (hit.status === 'error') return { items: undefined, loading: false, error: { kind: 'search' } };
      return { items: hit.commits, loading: false, error: null };
    }
    return { items: browse, loading: !!browseLoading, error: browseError ? { kind: 'fetch', reason: browseError } : null };
  };

  // Resolve each section's render source once (browse cache vs grep results) so the JSX
  // below reads the same whether or not a search is active.
  const recent = listFor('', commits, !!loading, commitsError);
  const outList = listFor('outgoing', outgoingCommits, !!outgoingLoading, outgoingError);
  const incList = listFor('incoming', incomingCommits, !!incomingLoading, incomingError);

  // WARDEN-1707: the section-header context menus copy from the SAME resolved lists the
  // rows render; the hash/subject items are disabled while a list is loading, errored
  // or empty so a copy never writes a partial / blank payload.
  const listCopyDisabled = (l: { items?: GitCommit[]; loading: boolean; error: unknown }) =>
    l.loading || !!l.error || !l.items || l.items.length === 0;
  const hashesOf = (l: { items?: GitCommit[] }) => (l.items ?? []).map((cm) => cm.hash).join('\n');
  const subjectsOf = (l: { items?: GitCommit[] }) => (l.items ?? []).map((cm) => cm.subject).join('\n');

  // WARDEN-1715: the stash / reflog / branch / uncommitted section-header menus. Same
  // contract as above: lists are `undefined` before the first fetch, so every list copy
  // is disabled while loading, errored or empty rather than writing a blank payload.
  const stashCopyDisabled = stashLoading || !!stashError || !stashList || stashList.length === 0;
  const reflogCopyDisabled = reflogLoading || !!reflogError || !reflogList || reflogList.length === 0;
  const branchCopyDisabled = branchLoading || !!branchError || !branchList || branchList.length === 0;
  // Mirrors DiffStatChip's guard: an all-untracked WIP (+0 −0) has nothing to copy.
  const diffstatCopyDisabled = !diffstat || (diffstat.insertions === 0 && diffstat.deletions === 0);

  const fetchShow = async (hash: string) => {
    if (showCache[hash] || showLoading[hash]) return;
    setShowLoading((p) => ({ ...p, [hash]: true }));
    try {
      // WARDEN-1144: bounded — gates this hash's `showLoading` entry ("loading
      // files…"), cleared only by the finally after this await.
      const r = await fetchBounded(`/api/git-show?id=${encodeURIComponent(chatId)}&hash=${encodeURIComponent(hash)}`);
      const j = await r.json();
      setShowCache((p) => ({ ...p, [hash]: { files: Array.isArray(j.files) ? j.files : [], message: typeof j.message === 'string' ? j.message : undefined, error: j.error } }));
    } catch {
      setShowCache((p) => ({ ...p, [hash]: { files: [], error: 'fetch failed' } }));
    } finally {
      setShowLoading((p) => ({ ...p, [hash]: false }));
    }
  };

  // A refresh is an explicit request for FRESH data, so drop the per-stash caches
  // and collapse any expanded stash row BEFORE the fetch. Stash refs (`stash@{n}`) are
  // reflog selectors, NOT immutable keys like commit hashes — `stash@{0}` shifts to a
  // DIFFERENT stash whenever one is popped or created above it. Without this reset,
  // after the agent adds/pops a stash the refreshed subject (e.g. "WIP: B") would
  // render under a stale file list cached for the PREVIOUS stash@{0} (e.g. "WIP: A")
  // — subject and files would disagree, and toggleStash's dedup guard would keep
  // serving the stale entry on re-collapse. CommitFile's cache-by-hash pattern
  // doesn't have this problem because a hash always names the same commit (WARDEN-340).
  // This is the one axis with a prologue, so it rides in as the hook's onBeforeFetch
  // rather than being inlined into the shared skeleton.
  const resetStashDetail = useCallback(() => {
    setStashShowCache({});
    setExpandedStashRef(null);
  }, []);

  const fetchStash = useGitListFetcher<GitStash>({
    chatId, route: '/api/git-stash', responseKey: 'stashes', label: 'stashes',
    setList: setStashList, setError: setStashError, setLoading: setStashLoading, onBeforeFetch: resetStashDetail,
  });
  const fetchReflog = useGitListFetcher<GitReflogEntry>({
    chatId, route: '/api/git-reflog', responseKey: 'entries', label: 'recent operations',
    setList: setReflogList, setError: setReflogError, setLoading: setReflogLoading,
  });
  const fetchRemote = useGitListFetcher<GitRemote>({
    chatId, route: '/api/git-remote', responseKey: 'remotes', label: 'remotes',
    setList: setRemoteList, setError: setRemoteError, setLoading: setRemoteLoading,
  });
  const fetchBranches = useGitListFetcher<GitBranch>({
    chatId, route: '/api/git-branch', responseKey: 'branches', label: 'branches',
    setList: setBranchList, setError: setBranchError, setLoading: setBranchLoading,
  });

  // WARDEN-975: the lazy-fetch trigger, re-anchored from the popover's onOpenChange
  // to the SECTION's expand. Identical policy, identical guards: fetch the local
  // recent commits, the incoming list (only when behind upstream), the outgoing list
  // (only when ahead), and shelved stashes (only when some are parked) on first
  // expand; fetch the reflog / remote / branch topology unconditionally (they are the
  // diagnostics for a repo that LOOKS clean, so they carry no count gate). Every call
  // is guarded on its cache being undefined, so a re-expand reuses it rather than
  // re-hitting the endpoint. Collapsing drops any active commit-message search so a
  // re-expand starts from the unfiltered browse lists (the popover did the same on
  // close — a stale term surviving would be confusing).
  //
  // Deps are the gate values only: the fetchers close over the freshest state and the
  // `=== undefined` guards make a repeat run a no-op, so re-running on a count change
  // (e.g. ahead 0 → 1 after a commit lands) is exactly the desired top-up.
  useEffect(() => {
    if (!expanded) {
      setGrepInput('');
      return;
    }
    if (commits === undefined && !loading) onFetch?.();
    if (behindCount > 0 && incomingCommits === undefined && !incomingLoading) onFetchIncoming?.();
    if (aheadCount > 0 && outgoingCommits === undefined && !outgoingLoading) onFetchOutgoing?.();
    if (stashN > 0 && stashList === undefined && !stashLoading) fetchStash();
    if (reflogList === undefined && !reflogLoading) fetchReflog();
    if (remoteList === undefined && !remoteLoading) fetchRemote();
    if (branchList === undefined && !branchLoading) fetchBranches();
    // Deps are the gate values only — NOT the fetchers. The parent's onFetch* props are
    // fresh arrows each render, so depending on them would re-run this every render;
    // the loading flags they'd bring are read inside the guards anyway. (oxlint's
    // exhaustive-deps warning here is deliberate, matching the several other
    // intentionally-narrow effect dep lists in this codebase.)
  }, [expanded, aheadCount, behindCount, stashN, commits, incomingCommits, outgoingCommits, stashList, reflogList, remoteList, branchList]);

  // WARDEN-528: resolve the ONE remote this section speaks for + the deep-link URLs.
  // A repo can have several remotes (origin, upstream, fork); the branch HEAD is on
  // tracks a specific one (`origin/feature` → the `origin` remote), so prefer that —
  // else the first remote with a web URL (conventionally `origin` in `git remote -v`
  // order). The branch / HEAD / upstream labels below deep-link to THAT host. When
  // there is no web-resolvable remote (non-git, SSH-only, or all bare paths) every
  // link is null and the origin row renders nothing — the badge stays as today.
  const primaryRemote = useMemo<GitRemote | null>(() => {
    if (!remoteList || remoteList.length === 0) return null;
    if (upstream) {
      const remoteName = upstream.split('/')[0];
      const tracked = remoteList.find((r) => r.name === remoteName);
      if (tracked) return tracked;
    }
    return remoteList.find((r) => r.web) ?? remoteList[0];
  }, [remoteList, upstream]);
  const originWeb = primaryRemote?.web ?? null;
  // Encode a ref for a /tree/ URL segment PRESERVING the path separator: a slash-
  // bearing branch (`feature/x`, the common case) must stay `feature/x` in the href,
  // not collapse to `feature%2Fx` (which hosts that don't decode %2F in the path
  // won't resolve). Each segment is still encoded so spaces/`#`/`?` are safe.
  const encodeTreeRef = (ref: string) => ref.split('/').map(encodeURIComponent).join('/');
  // branch → {web}/tree/{branch}; detached sha → {web}/commit/{sha}; the upstream
  // tracking ref (e.g. origin/feature) → {web}/tree/{feature} (remote prefix stripped,
  // but a slash-bearing branch like feature/x is preserved). All URL-encoded. null
  // when there is no web host to link to.
  const branchHref = !isDetached && branch && branch !== 'HEAD' && originWeb
    ? `${originWeb}/tree/${encodeTreeRef(branch)}` : null;
  const shaHref = isDetached && sha && originWeb ? `${originWeb}/commit/${encodeURIComponent(sha)}` : null;
  const upstreamBranch = upstream && upstream.includes('/') ? upstream.slice(upstream.indexOf('/') + 1) : upstream;
  const upstreamHref = !isDetached && upstream && originWeb && upstreamBranch
    ? `${originWeb}/tree/${encodeTreeRef(upstreamBranch)}` : null;

  // WARDEN-1798 restore trap: after a Settings round trip `expandedHash` is restored from the
  // store but the per-hash `showCache` is local and empty. Fetch the restored commit's files
  // once (fetchShow dedups on cache/loading); CommitRow treats an absent cache entry as
  // "loading files…" so no false "no files" flashes in the meantime.
  useEffect(() => {
    if (expanded && expandedHash && !showCache[expandedHash]) fetchShow(expandedHash);
    // Deps are the gate values only (fetchShow closes over the freshest state and dedups).
  }, [expanded, expandedHash]);

  const toggleCommit = (hash: string) => {
    if (expandedHash === hash) {
      setExpandedHash(null);
    } else {
      setExpandedHash(hash);
      if (!showCache[hash]) fetchShow(hash);
    }
  };

  // Fetch the changed files for ONE stash (the stash's tree diff vs its base) via
  // /api/git-stash-show. A parallel of fetchShow for commits — `ref` is the stash
  // reflog selector (stash@{n}) from parseStashList / /api/git-stash. Dedup'd so a
  // repeat expand reuses the cache instead of re-hitting the endpoint. (WARDEN-340)
  const fetchStashShow = async (ref: string) => {
    if (stashShowCache[ref] || stashShowLoading[ref]) return;
    setStashShowLoading((p) => ({ ...p, [ref]: true }));
    try {
      // WARDEN-1144: bounded — gates this ref's `stashShowLoading` entry ("loading
      // files…"), cleared only by the finally after this await.
      const r = await fetchBounded(`/api/git-stash-show?id=${encodeURIComponent(chatId)}&ref=${encodeURIComponent(ref)}`);
      const j = await r.json();
      setStashShowCache((p) => ({ ...p, [ref]: { files: Array.isArray(j.files) ? j.files : [], error: j.error } }));
    } catch {
      setStashShowCache((p) => ({ ...p, [ref]: { files: [], error: 'fetch failed' } }));
    } finally {
      setStashShowLoading((p) => ({ ...p, [ref]: false }));
    }
  };

  // Toggle a stash's expand, mirroring toggleCommit. Expanded state keys off a
  // separate expandedStashRef (not expandedHash) so a stash and a commit can be
  // open at the same time. (WARDEN-340)
  const toggleStash = (ref: string) => {
    if (expandedStashRef === ref) {
      setExpandedStashRef(null);
    } else {
      setExpandedStashRef(ref);
      if (!stashShowCache[ref]) fetchStashShow(ref);
    }
  };

  // Collapsed ⇒ render no body (the section header alone speaks), but stay MOUNTED so
  // the caches above survive a collapse/expand round trip exactly as they survived a
  // popover close/reopen. The range-diff DiffViewer is a sibling of the body for the
  // same reason it was a sibling of the popover: it must outlive whatever opened it.
  return (
    <>
      {expanded && (
        <div className="flex flex-col px-1 pb-1 text-[10px]">
          <ContextMenu>
            <ContextMenuTrigger asChild>
              <div className="mb-1 flex items-center justify-between gap-2 px-0.5">
                <span className="truncate text-[10px] font-medium text-muted-foreground">
                  recent commits ·{' '}
                  {isDetached ? (
                    <>
                      detached
                      {sha && (shaHref ? (
                        // WARDEN-528: deep-link the detached HEAD commit to {web}/commit/<sha>.
                        <a href={shaHref} target="_blank" rel="noreferrer noopener" onClick={(e) => e.stopPropagation()} title={`open commit ${sha} on the host`} className="font-mono text-primary underline underline-offset-2 hover:opacity-80">{` @ ${sha}`}</a>
                      ) : (
                        ` @ ${sha}`
                      ))}
                    </>
                  ) : branchHref ? (
                    // WARDEN-528: deep-link the branch to {web}/tree/<branch>.
                    <a href={branchHref} target="_blank" rel="noreferrer noopener" onClick={(e) => e.stopPropagation()} title={`open branch ${branch} on the host`} className="text-primary underline underline-offset-2 hover:opacity-80">{branch}</a>
                  ) : branch}
                  {aheadCount > 0 && <span className="text-amber-400"> · ↑ {aheadCount} unpushed</span>}
                </span>
                <IconTooltip label="refresh" disabled={loading || incomingLoading || outgoingLoading}>
                  <button
                    type="button"
                    // One ↻ refreshes ALL halves (local recent + incoming + outgoing), so a
                    // human checking for fresh commits after a remote fetch doesn't have to
                    // hunt for a second button.
                    onClick={(e) => { e.stopPropagation(); onFetch?.(); if (behindCount > 0) onFetchIncoming?.(); if (aheadCount > 0) onFetchOutgoing?.(); }}
                    className="shrink-0 text-[10px] text-muted-foreground hover:text-foreground disabled:opacity-50"
                    disabled={loading || incomingLoading || outgoingLoading}
                  >↻</button>
                </IconTooltip>
              </div>
            </ContextMenuTrigger>
            <ContextMenuContent>
              <ContextMenuItem disabled={listCopyDisabled(recent)} onSelect={() => copyWithToast(hashesOf(recent))}>Copy commit hashes</ContextMenuItem>
              <ContextMenuItem disabled={listCopyDisabled(recent)} onSelect={() => copyWithToast(subjectsOf(recent))}>Copy commit subjects</ContextMenuItem>
              {isDetached ? (sha && <ContextMenuItem onSelect={() => copyWithToast(sha)}>Copy HEAD commit</ContextMenuItem>) : (branch && <ContextMenuItem onSelect={() => copyWithToast(branch)}>Copy branch name</ContextMenuItem>)}
            </ContextMenuContent>
          </ContextMenu>
          {/* WARDEN-528: the compact origin row — which source repo this checkout maps
              to. Renders ONLY when a remote was resolved (non-git / SSH-only / all-bare
              remotes render nothing, leaving the badge exactly as before). The host +
              owner/repo (or the raw URL for a non-web remote) deep-link to the repo's
              web home; when HEAD tracks an upstream, that ref links to its branch too.
              stopPropagation on each anchor keeps a click from toggling the popover —
              target="_blank" is routed to the system browser by the Electron main
              process's setWindowOpenHandler (electron/external-nav.cjs, WARDEN-1906). */}
          {/* WARDEN-1014: a failed /api/git-remote leaves primaryRemote null, so the
              origin row (and every deep link derived from it) silently vanished —
              identical to a repo with no web-resolvable remote. Say so instead. */}
          {!primaryRemote && remoteError && (
            <ListErrorRow failure={{ kind: 'fetch', reason: remoteError }} noun="remotes" className="mb-1 px-0.5 py-0" />
          )}
          {primaryRemote && (
            <div className="mb-1 flex flex-wrap items-center gap-x-1 gap-y-0.5 px-0.5 text-[10px] text-muted-foreground">
              {originWeb ? (
                <a
                  href={originWeb}
                  target="_blank"
                  rel="noreferrer noopener"
                  onClick={(e) => e.stopPropagation()}
                  title={`open ${originWeb} in the browser`}
                  className="inline-flex min-w-0 max-w-full items-center gap-0.5 text-primary underline underline-offset-2 hover:opacity-80"
                >
                  <ExternalLink className="size-2.5 shrink-0" />
                  <span className="min-w-0 truncate">{primaryRemote.host}{primaryRemote.owner && primaryRemote.repo ? ` · ${primaryRemote.owner}/${primaryRemote.repo}` : ''}</span>
                </a>
              ) : (
                // Non-web remote (bare/file/single-segment) — show the raw URL, not
                // clickable (no browser target exists). Owner/repo are absent here.
                <span className="inline-flex min-w-0 max-w-full items-center gap-0.5" title={primaryRemote.url}>
                  <ExternalLink className="size-2.5 shrink-0 opacity-40" />
                  <span className="min-w-0 truncate">{primaryRemote.url}</span>
                </span>
              )}
              {upstreamHref && (
                <>
                  <span className="text-muted-foreground/60">·</span>
                  <a
                    href={upstreamHref}
                    target="_blank"
                    rel="noreferrer noopener"
                    onClick={(e) => e.stopPropagation()}
                    title={`open ${upstream} on ${primaryRemote.host} in the browser`}
                    className="text-primary underline underline-offset-2 hover:opacity-80"
                  >
                    {upstream}
                  </a>
                </>
              )}
            </div>
          )}
          {/* WARDEN-498: commit-message search across every visible list. Debounced
              (the effect at the top of the component fetches on a 300ms settle). A
              non-empty term swaps each section's data source to its grep results via
              listFor; the ✕ clears it so the unfiltered browse lists return. shadcn
              <Input>/<Button> — never raw form elements (WARDEN-68); the leading Search
              icon + trailing clear use the shadcn icon-input convention (relative
              wrapper, absolutely-positioned affordances, padded input). Sizes are on the
              Tailwind scale (text-xs), not arbitrary literals (WARDEN-68 Rule 2).
              stopPropagation keeps typing/clearing from toggling the row/pane beneath.
              Searches the FULL message (subject + body), case-insensitive, over a wider
              window than the browse cap. */}
          <div className="relative mb-1">
            <Search className="pointer-events-none absolute left-1.5 top-1/2 size-3 -translate-y-1/2 text-muted-foreground" />
            <EditableContextMenu>
              <Input
                type="text"
                value={grepInput}
                onChange={(e) => setGrepInput(e.target.value)}
                onClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => e.stopPropagation()}
                placeholder="search commit messages…"
                aria-label="search commit messages"
                className="h-6 text-xs md:text-xs pl-6 pr-6"
              />
            </EditableContextMenu>
            {(searching || searchLoading) && (
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                onClick={(e) => { e.stopPropagation(); setGrepInput(''); }}
                onKeyDown={(e) => e.stopPropagation()}
                aria-label="clear commit search"
                title="clear search"
                className="absolute right-0.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                <X className="size-3" />
              </Button>
            )}
          </div>
          {recent.error ? (
            <ListErrorRow failure={recent.error} />
          ) : recent.loading && (!recent.items || recent.items.length === 0) ? (
            <div className="flex items-center gap-1.5 px-1 py-1">
              <Skeleton className="size-2 rounded-full" /><span className="text-[10px] text-muted-foreground">{searching ? 'searching…' : 'loading…'}</span>
            </div>
          ) : recent.items && recent.items.length > 0 ? (
            <ul className="max-h-72 overflow-auto">
              {recent.items.map((cm) => (
                <CommitRow
                  key={cm.hash}
                  cm={cm}
                  hashClass="text-cyan-400/80"
                  title="click to inspect the files this commit changed"
                  expandedHash={expandedHash}
                  toggleCommit={toggleCommit}
                  showCache={showCache}
                  chatId={chatId}
                  onOpenFile={onOpenFile}
                />
              ))}
            </ul>
          ) : (
            <div className="px-1 py-1 text-[10px] text-muted-foreground">{searching ? 'no matching commits' : 'no commits'}</div>
          )}
          {clean === false && (
            <div className="mt-1.5 border-t border-border pt-1.5">
              <ContextMenu>
                <ContextMenuTrigger asChild>
                  <div className="mb-1 flex items-center justify-between gap-2 px-0.5">
                    <span className="flex items-center gap-1 text-[10px] font-medium text-yellow-400">
                      uncommitted · ±
                      {/* The ± magnitude (+N −M) — the SAME `git diff HEAD --shortstat` the
                          full diff below covers, so the chip's count and the diff content are
                          consistent by construction (WARDEN-411). Renders nothing for an
                          all-untracked WIP (DiffStatChip's own +0−0 guard). */}
                      <DiffStatChip diffstat={diffstat} />
                    </span>
                    {/* WARDEN-449: the ± axis's aggregated "full diff" — the net `git diff
                        HEAD` of every uncommitted (staged+unstaged) change as one view,
                        answering "what is this agent changing right now, in full?" without
                        expanding each dirty file (WARDEN-151). Mirrors the ↑/↓ affordances
                        (WARDEN-398); appears only when the tree is dirty (`clean === false`),
                        just as those appear only when ahead/behind > 0. A real <Button>
                        (WARDEN-68); closes the popover so the DiffViewer modal takes focus. */}
                    <Button
                      variant="ghost"
                      size="xs"
                      onClick={(e) => { e.stopPropagation(); setRangeDiff({ kind: 'worktree' }); }}
                      className="text-muted-foreground hover:text-yellow-300"
                      aria-label="view the full uncommitted diff"
                      title="view the aggregated uncommitted diff — net git diff HEAD"
                    >
                      <GitCompare />
                      full diff
                    </Button>
                  </div>
                </ContextMenuTrigger>
                <ContextMenuContent>
                  <ContextMenuItem onSelect={() => setRangeDiff({ kind: 'worktree' })}>View full diff</ContextMenuItem>
                  <ContextMenuSeparator />
                  <ContextMenuItem disabled={diffstatCopyDisabled} onSelect={() => copyWithToast(`+${diffstat?.insertions ?? 0} −${diffstat?.deletions ?? 0}`)}>Copy diff stat</ContextMenuItem>
                  <ContextMenuItem onSelect={() => copyWithToast('uncommitted')}>Copy section name</ContextMenuItem>
                </ContextMenuContent>
              </ContextMenu>
            </div>
          )}
          {aheadCount > 0 && (
            <div className="mt-1.5 border-t border-border pt-1.5">
              <ContextMenu>
                <ContextMenuTrigger asChild>
                  <div className="mb-1 flex items-center justify-between gap-2 px-0.5">
                    <span className="text-[10px] font-medium text-amber-400">unpushed · ↑ {aheadCount} ahead</span>
                    {/* WARDEN-398: the net unified diff of the WHOLE unpushed set as one
                        view — answers "what is this agent about to push?" without expanding
                        each commit. A real <Button> (not a role=button div): it sits in the
                        plain section header, so there's no nested-interactive issue (the chip
                        + popover trigger are the only other buttons, neither an ancestor of
                        this portaled content) — per WARDEN-68. Closes the popover so the
                        DiffViewer modal takes focus. */}
                    <Button
                      variant="ghost"
                      size="xs"
                      onClick={(e) => { e.stopPropagation(); setRangeDiff({ kind: 'outgoing', count: aheadCount }); }}
                      className="text-muted-foreground hover:text-amber-300"
                      aria-label={`view the full unpushed diff (${aheadCount} commit${aheadCount === 1 ? '' : 's'})`}
                      title={`view the aggregated unpushed diff (${aheadCount} commit${aheadCount === 1 ? '' : 's'}) — net git diff @{u}..HEAD`}
                    >
                      <GitCompare />
                      full diff
                    </Button>
                  </div>
                </ContextMenuTrigger>
                <ContextMenuContent>
                  <ContextMenuItem onSelect={() => setRangeDiff({ kind: 'outgoing', count: aheadCount })}>View full diff</ContextMenuItem>
                  <ContextMenuSeparator />
                  <ContextMenuItem disabled={listCopyDisabled(outList)} onSelect={() => copyWithToast(hashesOf(outList))}>Copy commit hashes</ContextMenuItem>
                  <ContextMenuItem disabled={listCopyDisabled(outList)} onSelect={() => copyWithToast(subjectsOf(outList))}>Copy commit subjects</ContextMenuItem>
                  <ContextMenuItem onSelect={() => copyWithToast(`unpushed · ↑ ${aheadCount} ahead`)}>Copy section name</ContextMenuItem>
                </ContextMenuContent>
              </ContextMenu>
              {outList.error ? (
                <ListErrorRow failure={outList.error} />
              ) : outList.loading && (!outList.items || outList.items.length === 0) ? (
                <div className="flex items-center gap-1.5 px-1 py-1">
                  <Skeleton className="size-2 rounded-full" /><span className="text-[10px] text-muted-foreground">{searching ? 'searching…' : 'loading…'}</span>
                </div>
              ) : outList.items && outList.items.length > 0 ? (
                <ul className="max-h-72 overflow-auto">
                  {outList.items.map((cm) => (
                    // Explorable (WARDEN-303): each row expands to its changed files +
                    // per-file diff via /api/git-show — these commits are local objects
                    // reachable from HEAD. The incoming list below is explorable too
                    // (WARDEN-348): reachability from @{u}'s remote-tracking ref — not
                    // HEAD-membership — is what makes git show reliable there. The row
                    // itself is the shared CommitRow (WARDEN-1039); the amber hash tint
                    // matches this list's "unpushed" styling.
                    <CommitRow
                      key={cm.hash}
                      cm={cm}
                      hashClass="text-amber-400/80"
                      title="unpushed commit (local, not yet pushed) — click to inspect the files this commit changed"
                      expandedHash={expandedHash}
                      toggleCommit={toggleCommit}
                      showCache={showCache}
                      chatId={chatId}
                      onOpenFile={onOpenFile}
                    />
                  ))}
                </ul>
              ) : (
                <div className="px-1 py-1 text-[10px] text-muted-foreground">{searching ? 'no matching commits' : 'no unpushed commits'}</div>
              )}
            </div>
          )}
          {behindCount > 0 && (
            <div className="mt-1.5 border-t border-border pt-1.5">
              <ContextMenu>
                <ContextMenuTrigger asChild>
                  <div className="mb-1 flex items-center justify-between gap-2 px-0.5">
                    <span className="text-[10px] font-medium text-blue-400">incoming · ↓ {behindCount} behind</span>
                    {/* WARDEN-398: the net unified diff of the WHOLE incoming set as one
                        view — answers "what will land if I bring this agent up to upstream?"
                        without expanding each commit. See the outgoing affordance above for
                        the <Button>-not-div rationale (WARDEN-68). */}
                    <Button
                      variant="ghost"
                      size="xs"
                      onClick={(e) => { e.stopPropagation(); setRangeDiff({ kind: 'incoming', count: behindCount }); }}
                      className="text-muted-foreground hover:text-blue-300"
                      aria-label={`view the full incoming diff (${behindCount} commit${behindCount === 1 ? '' : 's'})`}
                      title={`view the aggregated incoming diff (${behindCount} commit${behindCount === 1 ? '' : 's'}) — net git diff HEAD..@{u}`}
                    >
                      <GitCompare />
                      full diff
                    </Button>
                  </div>
                </ContextMenuTrigger>
                <ContextMenuContent>
                  <ContextMenuItem onSelect={() => setRangeDiff({ kind: 'incoming', count: behindCount })}>View full diff</ContextMenuItem>
                  <ContextMenuSeparator />
                  <ContextMenuItem disabled={listCopyDisabled(incList)} onSelect={() => copyWithToast(hashesOf(incList))}>Copy commit hashes</ContextMenuItem>
                  <ContextMenuItem disabled={listCopyDisabled(incList)} onSelect={() => copyWithToast(subjectsOf(incList))}>Copy commit subjects</ContextMenuItem>
                  <ContextMenuItem onSelect={() => copyWithToast(`incoming · ↓ ${behindCount} behind`)}>Copy section name</ContextMenuItem>
                </ContextMenuContent>
              </ContextMenu>
              {incList.error ? (
                <ListErrorRow failure={incList.error} />
              ) : incList.loading && (!incList.items || incList.items.length === 0) ? (
                <div className="flex items-center gap-1.5 px-1 py-1">
                  <Skeleton className="size-2 rounded-full" /><span className="text-[10px] text-muted-foreground">{searching ? 'searching…' : 'loading…'}</span>
                </div>
              ) : incList.items && incList.items.length > 0 ? (
                <ul className="max-h-72 overflow-auto">
                  {incList.items.map((cm) => (
                    // Explorable (WARDEN-348): an incoming commit is reachable from
                    // the branch's upstream remote-tracking ref (@{u}, a LOCAL object
                    // updated by the last git fetch), so a per-commit /api/git-show is
                    // reliable WITHOUT a pull — reachability, not HEAD-membership, is
                    // what git show needs. The row itself is the shared CommitRow
                    // (WARDEN-1039); the blue hash tint matches this list's styling.
                    <CommitRow
                      key={cm.hash}
                      cm={cm}
                      hashClass="text-blue-400/80"
                      title="incoming commit (behind upstream, already fetched) — click to inspect the files this commit changed"
                      expandedHash={expandedHash}
                      toggleCommit={toggleCommit}
                      showCache={showCache}
                      chatId={chatId}
                      onOpenFile={onOpenFile}
                    />
                  ))}
                </ul>
              ) : (
                <div className="px-1 py-1 text-[10px] text-muted-foreground">{searching ? 'no matching commits' : 'no incoming commits'}</div>
              )}
            </div>
          )}
          {stashN > 0 && (
            <div className="mt-1.5 border-t border-border pt-1.5">
              <ContextMenu>
                <ContextMenuTrigger asChild>
                  <div className="mb-0.5 flex items-center justify-between gap-2 px-0.5">
                    <span className="truncate text-[10px] font-medium text-fuchsia-400">🗄 stashed work · {stashN}</span>
                    <IconTooltip label="refresh stashes" disabled={stashLoading}>
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); fetchStash(); }}
                        className="shrink-0 text-[10px] text-muted-foreground hover:text-foreground disabled:opacity-50"
                        disabled={stashLoading}
                      >↻</button>
                    </IconTooltip>
                  </div>
                </ContextMenuTrigger>
                <ContextMenuContent>
                  <ContextMenuItem disabled={stashCopyDisabled} onSelect={() => copyWithToast((stashList ?? []).map((st) => st.ref).join('\n'))}>Copy stash refs</ContextMenuItem>
                  <ContextMenuItem disabled={stashCopyDisabled} onSelect={() => copyWithToast((stashList ?? []).map((st) => st.subject).join('\n'))}>Copy stash subjects</ContextMenuItem>
                  <ContextMenuItem onSelect={() => copyWithToast(`stashed work · ${stashN}`)}>Copy section name</ContextMenuItem>
                </ContextMenuContent>
              </ContextMenu>
              {stashLoading && stashList === undefined ? (
                <div className="flex items-center gap-1.5 px-1 py-1">
                  <Skeleton className="size-2 rounded-full" /><span className="text-[10px] text-muted-foreground">loading…</span>
                </div>
              ) : stashList && stashList.length > 0 ? (
                <ul className="max-h-40 overflow-auto">
                  {stashList.map((s, i) => (
                    // Explorable (WARDEN-340): each stash row expands to its changed
                    // files + per-file diff via /api/git-stash-show, mirroring the
                    // recent/outgoing commit rows above. A role="button" div (not a
                    // <button>) so it's keyboard-operable without nesting interactive
                    // rows (each StashFile is itself a role="button" div) inside this
                    // portaled popover — the same pattern CommitFile/the commit rows use.
                    <li key={s.ref || i} className="rounded">
                      {/* WARDEN-1649: themed right-click menu. The trigger wraps ONLY the
                          role="button" header (asChild merges handlers onto it, so role /
                          tabIndex / aria-* / onClick / onKeyDown stay on that same div); the
                          expansion body with StashFile rows stays a SIBLING outside it, else
                          right-click on a StashFile would resolve to the stash menu. */}
                      <ContextMenu>
                        <ContextMenuTrigger asChild>
                          <div
                            role="button"
                            tabIndex={0}
                            aria-expanded={expandedStashRef === s.ref}
                            aria-label={`inspect files in stash ${s.ref}`}
                            onClick={(e) => { e.stopPropagation(); toggleStash(s.ref); }}
                            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); toggleStash(s.ref); } }}
                            title="click to inspect the files this stash changed"
                            className="flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left hover:bg-accent cursor-pointer focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary"
                          >
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-[10px] text-foreground" title={s.subject}>{s.subject}</span>
                              {s.date && <span className="block text-[10px] text-muted-foreground">{s.date}</span>}
                            </span>
                            <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">{expandedStashRef === s.ref ? '▾' : '▸'}</span>
                          </div>
                        </ContextMenuTrigger>
                        <ContextMenuContent>
                          <ContextMenuItem onSelect={() => toggleStash(s.ref)}>Inspect files</ContextMenuItem>
                          <ContextMenuItem onSelect={() => copyWithToast(s.ref)}>Copy stash ref</ContextMenuItem>
                          <ContextMenuItem onSelect={() => copyWithToast(s.subject)}>Copy stash subject</ContextMenuItem>
                          {s.date && <ContextMenuItem onSelect={() => copyWithToast(s.date)}>Copy timestamp</ContextMenuItem>}
                        </ContextMenuContent>
                      </ContextMenu>
                      {expandedStashRef === s.ref && (
                        <div className="pb-1 pl-1">
                          {stashShowLoading[s.ref] && !stashShowCache[s.ref] ? (
                            <div className="px-1 text-[10px] text-muted-foreground">loading files…</div>
                          ) : (stashShowCache[s.ref]?.files?.length ?? 0) > 0 ? (
                            <div className="flex flex-col gap-0.5">
                              {stashShowCache[s.ref]!.files!.map((f) => (
                                <StashFile key={f.path} chatId={chatId} stashRef={s.ref} file={f} />
                              ))}
                            </div>
                          ) : (
                            <div className="px-1 text-[10px] text-muted-foreground">{stashShowCache[s.ref]?.error ? 'failed to load' : 'no files'}</div>
                          )}
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              ) : (
                <ListStateRow error={stashError} empty="no stashes" />
              )}
            </div>
          )}
          {/* WARDEN-460: read-only "recent operations" (git reflog). The fourth axis
              alongside commits / working-tree / stash: the non-commit ops (reset,
              checkout, abandoned rebase, force-push) that leave no commit AND no dirty
              file. Rendered once the lazy fetch has started (no count gate — the reflog
              is the diagnostic for a repo that LOOKS clean), reusing the stash row
              styling. Expanded-view-only; no always-on badge. */}
          {(reflogList !== undefined || reflogLoading) && (
            <div className="mt-1.5 border-t border-border pt-1.5">
              <ContextMenu>
                <ContextMenuTrigger asChild>
                  <div className="mb-0.5 flex items-center justify-between gap-2 px-0.5">
                    <span className="truncate text-[10px] font-medium text-muted-foreground">⏱ recent operations</span>
                    <IconTooltip label="refresh operations" disabled={reflogLoading}>
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); fetchReflog(); }}
                        className="shrink-0 text-[10px] text-muted-foreground hover:text-foreground disabled:opacity-50"
                        disabled={reflogLoading}
                      >↻</button>
                    </IconTooltip>
                  </div>
                </ContextMenuTrigger>
                <ContextMenuContent>
                  <ContextMenuItem disabled={reflogCopyDisabled} onSelect={() => copyWithToast((reflogList ?? []).map((op) => op.subject).join('\n'))}>Copy operations</ContextMenuItem>
                  <ContextMenuItem disabled={reflogCopyDisabled} onSelect={() => copyWithToast((reflogList ?? []).map((op) => op.hash).filter(Boolean).join('\n'))}>Copy commit hashes</ContextMenuItem>
                  <ContextMenuItem onSelect={() => copyWithToast('recent operations')}>Copy section name</ContextMenuItem>
                </ContextMenuContent>
              </ContextMenu>
              {reflogLoading && reflogList === undefined ? (
                <div className="flex items-center gap-1.5 px-1 py-1">
                  <Skeleton className="size-2 rounded-full" /><span className="text-[10px] text-muted-foreground">loading…</span>
                </div>
              ) : reflogList && reflogList.length > 0 ? (
                <ul className="max-h-40 overflow-auto">
                  {reflogList.map((op, i) => (
                    /* WARDEN-460: key by index, NOT op.hash. A reflog records ops, and
                       several ops point HEAD at the SAME commit — `git reset --hard HEAD~1`
                       revisits a prior commit, so one hash can appear on multiple rows.
                       Unlike stash refs (stash@{0}, stash@{1}, …), the reflog has no
                       per-entry unique selector, so `op.hash || i` still collides on a
                       duplicated (non-empty) hash. The list is a static snapshot fetched on
                       expand/refresh, so positional keys are correct. */
                    <ContextMenu key={i}>
                      {/* WARDEN-1649: themed right-click menu; trigger wraps the <li>. */}
                      <ContextMenuTrigger asChild>
                        <li className="rounded px-1 py-0.5 text-left">
                          {/* The subject IS the operation (git's %gs), e.g. "reset: moving to HEAD~1" / "checkout: moving from main to feat". */}
                          <span className="block truncate text-[10px] text-foreground" title={op.subject}>{op.subject}</span>
                          {op.hash && <span className="block text-[10px] text-muted-foreground"><span className="font-mono">{op.hash}</span>{op.date ? ` · ${op.date}` : ''}</span>}
                        </li>
                      </ContextMenuTrigger>
                      <ContextMenuContent>
                        <ContextMenuItem onSelect={() => copyWithToast(op.subject)}>Copy operation</ContextMenuItem>
                        {op.hash && <ContextMenuItem onSelect={() => copyWithToast(op.hash)}>Copy commit hash</ContextMenuItem>}
                        {op.date && <ContextMenuItem onSelect={() => copyWithToast(op.date)}>Copy timestamp</ContextMenuItem>}
                      </ContextMenuContent>
                    </ContextMenu>
                  ))}
                </ul>
              ) : (
                <ListStateRow error={reflogError} empty="no operations" />
              )}
            </div>
          )}
          {/* WARDEN-577: the agent's local branches — the topology the badge's single
              current-branch name only gestures at. Each row: current-marker, name
              (bold + ● when HEAD is on it), `· Nd` freshness (reuses formatRelative,
              amber when stale like the badge append), `↑N`/`↓N` (ahead/behind, the
              same glyphs/colors the badge uses), an amber `gone` when the upstream
              tracking ref was deleted, and a green `✓` when merged into HEAD (shown
              only on non-current branches — current is trivially merged, so the ✓
              would be noise there; its ABSENCE on another branch is the "stranded
              work" signal). The name deep-links to {web}/tree/<branch> via the same
              primaryRemote web base + encodeTreeRef the HEAD/upstream links use
              (WARDEN-528); a repo with no web remote renders the name plain. Read-
              only throughout — list+render only, no checkout/merge/delete affordance
              (the WARDEN-199 line). stopPropagation on the link keeps a click from
              toggling the popover; target=_blank opens the system browser. */}
          {(branchList !== undefined || branchLoading) && (
            <div className="mt-1.5 border-t border-border pt-1.5">
              <ContextMenu>
                <ContextMenuTrigger asChild>
                  <div className="mb-0.5 flex items-center justify-between gap-2 px-0.5">
                    <span className="truncate text-[10px] font-medium text-muted-foreground">⎇ branches · {branchList?.length ?? 0}</span>
                    <IconTooltip label="refresh branches" disabled={branchLoading}>
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); fetchBranches(); }}
                        className="shrink-0 text-[10px] text-muted-foreground hover:text-foreground disabled:opacity-50"
                        disabled={branchLoading}
                      >↻</button>
                    </IconTooltip>
                  </div>
                </ContextMenuTrigger>
                <ContextMenuContent>
                  <ContextMenuItem disabled={branchCopyDisabled} onSelect={() => copyWithToast((branchList ?? []).map((b) => b.name).join('\n'))}>Copy branch names</ContextMenuItem>
                  <ContextMenuItem onSelect={() => copyWithToast(`branches · ${branchList?.length ?? 0}`)}>Copy section name</ContextMenuItem>
                </ContextMenuContent>
              </ContextMenu>
              {branchLoading && branchList === undefined ? (
                <div className="flex items-center gap-1.5 px-1 py-1">
                  <Skeleton className="size-2 rounded-full" /><span className="text-[10px] text-muted-foreground">loading…</span>
                </div>
              ) : branchList && branchList.length > 0 ? (
                <ul className="max-h-40 overflow-auto">
                  {branchList.map((b, i) => {
                    const ms = b.headDate ? Date.parse(b.headDate) : NaN;
                    const fresh = Number.isFinite(ms);
                    const stale = fresh && Date.now() - ms > STALE_HEAD_AGE_MS;
                    const href = originWeb ? `${originWeb}/tree/${encodeTreeRef(b.name)}` : null;
                    const titleParts = [b.name];
                    if (b.current) titleParts.push('current');
                    if (b.gone) titleParts.push('upstream gone — remote tracking branch deleted, work is local-only');
                    else if (b.upstream) titleParts.push(`tracking ${b.upstream}`);
                    else titleParts.push('no remote tracking — local-only, not backed up');
                    if (fresh) titleParts.push(`last commit ${formatAbsoluteFull(ms)}`);
                    if (b.ahead > 0) titleParts.push(`${b.ahead} unpushed`);
                    if (b.behind > 0) titleParts.push(`${b.behind} behind remote`);
                    if (!b.merged) titleParts.push('not merged into HEAD — may carry unlanded commits');
                    return (
                      <ContextMenu key={b.name || i}>
                        {/* WARDEN-1649: themed right-click menu; trigger wraps the <li>. Key by
                            name when stable; a duplicate/empty name falls back to the index. */}
                        <ContextMenuTrigger asChild>
                          <li
                            /* key by name when stable; a duplicate/empty name (a
                               pathological repo) falls back to the positional index so
                               the list never crashes. */
                            className="flex items-center gap-1 rounded px-1 py-0.5 text-left text-[10px]"
                          >
                            <span className={b.current ? 'text-cyan-400' : 'text-muted-foreground/40'}>{b.current ? '●' : '○'}</span>
                            {href ? (
                              <a
                                href={href}
                                target="_blank"
                                rel="noreferrer noopener"
                                onClick={(e) => e.stopPropagation()}
                                title={titleParts.join(' · ')}
                                className={cn('min-w-0 flex-1 truncate underline underline-offset-2 hover:opacity-80', b.current ? 'font-medium text-primary' : 'text-primary/80')}
                              >
                                {b.name}
                              </a>
                            ) : (
                              <span
                                title={titleParts.join(' · ')}
                                className={cn('min-w-0 flex-1 truncate', b.current ? 'font-medium text-foreground' : 'text-foreground/80')}
                              >
                                {b.name}
                              </span>
                            )}
                            {fresh && (
                              <span className={stale ? 'text-amber-400' : 'text-muted-foreground'}>· {formatTimestamp(ms, timestampFormat)}</span>
                            )}
                            {b.ahead > 0 && <span className="text-amber-400">↑{b.ahead}</span>}
                            {b.behind > 0 && <span className="text-blue-400">↓{b.behind}</span>}
                            {b.gone && <span className="text-amber-400">gone</span>}
                            {b.merged && !b.current && <span className="text-green-400" title="merged into HEAD">✓</span>}
                          </li>
                        </ContextMenuTrigger>
                        <ContextMenuContent>
                          {href && <ContextMenuItem onSelect={() => { void openExternalUrl(href); }}>Open on remote</ContextMenuItem>}
                          <ContextMenuItem onSelect={() => copyWithToast(b.name)}>Copy branch name</ContextMenuItem>
                          {b.headSha && <ContextMenuItem onSelect={() => copyWithToast(b.headSha)}>Copy tip commit</ContextMenuItem>}
                        </ContextMenuContent>
                      </ContextMenu>
                    );
                  })}
                </ul>
              ) : (
                <ListStateRow error={branchError} empty="no branches" />
              )}
            </div>
          )}
        </div>
      )}
      {/* WARDEN-398: the aggregated range-diff modal. Rendered as a sibling of the
          section body (not inside it) so it survives a collapse and Radix's Dialog
          portal stacks cleanly — the same sibling discipline it had beside the
          popover. Range mode fetches /api/git-range-diff; filePath is unused here. */}
      <DiffViewer
        chatId={chatId}
        filePath=""
        range={rangeDiff?.kind}
        count={rangeDiff?.count}
        diffstat={rangeDiff?.kind === 'worktree' ? diffstat : undefined}
        open={!!rangeDiff}
        onOpenChange={(o) => { if (!o) setRangeDiff(null); }}
      />
    </>
  );
}
