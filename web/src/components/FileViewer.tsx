import { Fragment, useState, useEffect, useMemo, useRef, useCallback, useLayoutEffect, type ReactNode, type DependencyList } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogClose,
} from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Badge } from '@/components/ui/badge';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { DiffBlock } from './DiffBlock';
// Pure view-state helpers for the Changes view (WARDEN-786): the diff-response
// classifier (clean/empty vs dirty vs error vs loading) and the toolbar-toggle
// exclusivity resolver. Pure so both have unit coverage (fileViewerChanges.test.mjs).
import { classifyChangesView, resolveViewToggles } from '@/lib/fileViewerChanges';
// Pure descriptor for the header toolbar's collapsible half (WARDEN-1019) — which
// controls collapse into the `⋯` menu below `md`, in what order, and with what
// pressed state. Unit-tested in fileViewerToolbar.test.mjs.
import {
  secondaryToolbarActions,
  TOOLBAR_LEADING_KEYS,
  TOOLBAR_TRAILING_KEYS,
  type ToolbarAction,
  type ToolbarActionKey,
} from '@/lib/fileViewerToolbar';
import { MarkdownBody } from './MarkdownBody';
import { tokenizeCode, languageFromPath, type Leaf } from '@/lib/highlight';
import { Loader2Icon, FileIcon, FolderIcon, AlertCircleIcon, GitCommitHorizontalIcon, BookOpenIcon, Code2Icon, HistoryIcon, EyeIcon, RotateCwIcon, CircleDotIcon, FilePenIcon, ChevronLeftIcon, EllipsisIcon } from 'lucide-react';
import { formatTimestamp, formatAbsoluteFull, type TimestampFormat } from '@/lib/formatTimestamp';
import { copyWithToast } from '@/lib/clipboardToast';
import { basename } from '@/lib/chatDisplay';
// Pure breadcrumb geometry (splitPathSegments / ancestorDir) for the clickable
// path-segment crumbs (WARDEN-740) — kept UI-free in src/lib so it is unit-
// tested directly (see web/breadcrumbs.test.mjs).
import { splitPathSegments, ancestorDir, collapseCrumbs, crumbRunNeedsFloor } from '@/lib/pathBreadcrumbs';
// joinPath + the Entry shape are shared with FileBrowserDialog so a navigated
// sibling path is built identically to the browse dialog's selection.
import { joinPath, type Entry } from '@/lib/fileBrowserTree';
import { toast } from 'sonner';
import { useStickToBottom } from '@/lib/useStickToBottom';
import { WEB_POLL_DEFAULT_MS } from '@/lib/pollInterval';
import { fetchBounded, readListBody, readListResponse } from '@/lib/api';
// The per-file git-diff READ seam (WARDEN-1187 / WARDEN-1194). BlameHash reads its
// popover diff through the DETAIL reader — the sibling that also keeps the commit
// body (`message`, WARDEN-388) off the same response — so this site honours both
// halves of warden's error convention instead of gating on `r.ok` alone.
import { readFileDiffDetail } from '@/lib/gitDiffApi';
// The shared client-state store (WARDEN-1271 / roadmap WARDEN-1204). The
// Rendered ⇄ Source view mode is subscribed to here directly instead of being
// prop-drilled through this viewer's four mount-site ancestors (WARDEN-1288).
import { useFileViewerViewMode, useSetFileViewerViewMode } from '@/lib/uiStore';

interface FileViewerProps {
  chatId: string;
  filePath: string;
  open: boolean;
  /** Optional 1-based line to scroll to and visually highlight (WARDEN-227: when
   *  opened by Ctrl/Cmd+clicking a `path:line` token in a live terminal pane). */
  line?: number;
  // "Timestamp format" pref (WARDEN-422): honors the client-side relative vs
  // absolute pref on blame author-dates, mirroring every other timestamp surface.
  timestampFormat: TimestampFormat;
  // Rendered ⇄ Source view mode for markdown (WARDEN-480) is no longer a prop:
  // it is a SHARED client-state fact this component subscribes to directly via
  // useFileViewerViewMode()/useSetFileViewerViewMode() (WARDEN-1288, roadmap
  // WARDEN-1204 slice 2). It has exactly one reader (here) and one writer (this
  // toolbar), yet it used to be drilled through four pure pass-through carriers
  // — those hops are gone. Persistence is unchanged and still SINGLE-WRITER:
  // the store write re-renders App's subscription, whose PersistedPrefSnapshot
  // drives the one compile-locked saveUi effect. The CommitBlobView historical
  // snapshot honors the same value (passed internally below).
  //
  // In-place file navigation (WARDEN-740): a breadcrumb ancestor crumb or a
  // sibling picked from its /api/git-ls listing calls this with the new cwd-
  // relative path. The parent owns `filePath` (controlled), so it updates its
  // own state and the new path flows back down — every effect (content, blame,
  // history, at-commit blob) re-fetches on `filePath` change for free, so this
  // needs ZERO new fetch logic.
  // Optional so a render site that only needs to display (never navigate)
  // degrades to the plain non-clickable path; all three current sites wire it.
  onNavigate?: (path: string) => void;
  // Follow live-update cadence (WARDEN-749): the already-resolved web-safe poll
  // interval. App owns + resolves cfg.pollIntervalMs via resolvePollIntervalMs at
  // the source (the same value the catalog poll uses), so Follow shares the
  // dashboard's cadence rather than hardcoding its own. Drives ONLY the Follow
  // toggle's visibility-gated poller; the rest of the viewer ignores it.
  pollIntervalMs: number;
  onOpenChange: (open: boolean) => void;
}

// One row from /api/git-blame --line-porcelain. `date` is author-time as ISO 8601
// (the frontend formats it relative). `hash` is the full SHA — sliced for display,
// passed whole to /api/git-show on click so the commit resolves unambiguously.
type BlameLine = { line: number; hash: string; author: string; date: string; summary: string };

// One row from /api/git-log with a `path` filter (file history, WARDEN-319). `date` is
// the relative %ar string straight from git ("2 days ago") — displayed VERBATIM, not
// re-relativized through formatTimestamp, matching the sibling git-log commit lists in
// ChatSidebar (the only other consumer of this route). `hash` is %h (abbreviated);
// git-show accepts abbreviated hashes, so it resolves unambiguously on click.
type HistoryCommit = { hash: string; subject: string; author: string; date: string };

// One clickable ancestor in the path breadcrumb (WARDEN-740): `dir` is the
// cwd-relative directory /api/git-ls lists when the crumb is clicked, `label` is
// the segment name shown (empty for the root crumb, which renders a folder icon).
type Crumb = { label: string; dir: string; isRoot: boolean };

// Identifies the `…` overflow menu in the single `openCrumb` popover slot
// (WARDEN-1006). A NUL byte cannot occur in a path segment, so this can never
// collide with a real crumb's `dir` — including the root crumb's `''`.
const OVERFLOW_CRUMB_KEY = '\u0000overflow';

// Shared gated-fetch for a git-data slice shown only while a view-mode is on
// (blame / history). Collapses two byte-mirrored effects into one envelope: the
// cancelled guard, the loading/error reset, the try → fetch → read → catch body,
// and the `return () => { cancelled = true }` cleanup. The six per-slice
// differences are the parameters (WARDEN-884; same DRY move as useGitLogFetcher in
// ChatSidebar + DiffInspectRow in GitBadges).
//
// WARDEN-1014: the response-READING step is now the shared `readListResponse` from
// lib/api.ts rather than an inline `!r.ok` early-return + `Array.isArray(j[field])`
// + `j.error || null`. Behaviour here is unchanged — this hook was already the only
// correct copy of the two-halves read, so it is the template the other two hooks
// adopt, not a site being fixed. A 4xx still reports `Failed to load <label>
// (<status>)` and still leaves the previously-loaded list untouched; a 2xx carrying
// `{error}` still surfaces that string.
function useGatedFetch<T>(opts: {
  gate: boolean;
  buildUrl: () => string;
  onData: (data: T[]) => void;
  onLoading: (loading: boolean) => void;
  onError: (error: string | null) => void;
  field: string;
  label: string;
  deps: DependencyList;
}): void {
  const { gate, buildUrl, onData, onLoading, onError, field, label, deps } = opts;
  useEffect(() => {
    if (!gate) return;
    let cancelled = false;
    const run = async () => {
      onLoading(true);
      onError(null);
      try {
        // WARDEN-1144: bounded — this hook gates `blameLoading` / `historyLoading`
        // via `onLoading`, cleared only by the finally after this await. The
        // `cancelled` flag is a STALENESS guard for a settled result, not a
        // deadline. One-shot (fires when the tab is opened) → the defaults.
        const r = await fetchBounded(buildUrl());
        // Tolerant on !ok (the status carries the message), STRICT on 2xx — a body
        // that fails to parse on a 2xx is a real failure and must reach the catch
        // below rather than becoming a confident empty list (WARDEN-1014 review).
        const j = await readListBody(r);
        if (cancelled) return;
        const { items, error } = readListResponse<T>(r, j, field, label);
        // On a hard HTTP failure `items` is the server's placeholder, not data —
        // report the error and leave whatever was already loaded on screen (the
        // pre-refactor early-return did exactly this).
        if (!r.ok) {
          onError(error);
          return;
        }
        onData(items);
        onError(error);
      } catch (e) {
        if (!cancelled) onError(e instanceof Error ? e.message : `Failed to load ${label}`);
      } finally {
        if (!cancelled) onLoading(false);
      }
    };
    run();
    return () => { cancelled = true; };
    // deps are passed verbatim by each caller (the exact list each effect used
    // pre-refactor); setters are stable state dispatchers and buildUrl closes over
    // the same chatId/filePath as before, so behavior is identical. Satisfied
    // out-of-band — hence the exhaustive-deps disable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

export function FileViewer({ chatId, filePath, open, line, timestampFormat, onNavigate, pollIntervalMs, onOpenChange }: FileViewerProps) {
  // The Rendered ⇄ Source toggle (WARDEN-480), read and written straight off the
  // shared client-state store (WARDEN-1288) rather than drilled down from App.
  const viewMode = useFileViewerViewMode();
  const onViewModeChange = useSetFileViewerViewMode();
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // Ref on the highlighted line row so we can scroll it into view once content renders.
  const highlightRef = useRef<HTMLDivElement>(null);

  // Which ancestor crumb's directory-listing Popover is open (WARDEN-740). Holds
  // the crumb's dir ('' = repo root) so at most one popover is open at a time;
  // null when none. Local to the viewer — the actual file swap is the parent's
  // job via onNavigate; this only owns the open/close of the pick list.
  const [openCrumb, setOpenCrumb] = useState<string | null>(null);

  // Annotate (git blame) state — separate from the file content fetch so toggling
  // annotate doesn't refetch the (already-shown) file. Blame is fetched ONCE when the
  // toggle turns on (or the file/chat changes), then cached for the dialog's lifetime.
  const [annotate, setAnnotate] = useState(false);
  const [blame, setBlame] = useState<BlameLine[] | null>(null);
  const [blameError, setBlameError] = useState<string | null>(null);
  const [blameLoading, setBlameLoading] = useState(false);

  // History (file commit timeline) state — the temporal counterpart to blame
  // (WARDEN-319). Separate from the file-content fetch for the same reason annotate
  // is: toggling history shouldn't refetch the (already-shown) file. History is
  // fetched ONCE when the toggle turns on (or the file/chat changes). History and
  // annotate are mutually exclusive view modes (the toggles clear each other) so the
  // body never has to reconcile two alternate layouts at once.
  const [history, setHistory] = useState(false);
  const [commits, setCommits] = useState<HistoryCommit[] | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);

  // View file at a historical commit (WARDEN-354): the snapshot leg of the
  // temporal trio, opened from HistoryContent's per-commit "view file at this
  // commit" affordance. `viewAtCommit` holds the commit whose full blob is on
  // screen (null = not viewing a snapshot). The blob fetch owns its own
  // loading/error/content state, separate from the current-file fetch — and a
  // per-hash cache so re-viewing a commit is instant (mirrors BlameHash's
  // `fetched` flag).
  const [viewAtCommit, setViewAtCommit] = useState<HistoryCommit | null>(null);
  const [blobContent, setBlobContent] = useState<string | null>(null);
  const [blobLoading, setBlobLoading] = useState(false);
  const [blobError, setBlobError] = useState<string | null>(null);
  const blobCache = useRef<Map<string, { content: string | null; error: string | null }>>(new Map());

  // Follow live-update (WARDEN-749): when ON, re-read the file on the poll
  // cadence so an open file refreshes as an agent writes to it — the workspace
  // analogue of `tail -f`, scoped to the file already on screen. Ephemeral UI
  // state: reset on close (not persisted across opens), exactly as annotate/
  // history reset per open. A human supervising a (often remote) yatfa agent
  // can pin its output file and watch progress accumulate.
  const [follow, setFollow] = useState(false);
  // Brief in-flight flag for the manual ↻ reload button's spinner. The Follow
  // interval never sets this — its polls are silent background refreshes.
  const [manualReloading, setManualReloading] = useState(false);
  // The `⋯` header-toolbar overflow menu (WARDEN-1019) — only reachable below
  // `md`, where the low-priority controls collapse into it.
  const [toolbarMenuOpen, setToolbarMenuOpen] = useState(false);

  // Changes view (WARDEN-786): the open file's uncommitted working-tree diff vs
  // HEAD — the missing fourth file-understanding surface (History = what committed
  // it, Annotate = who wrote each line, Follow = live state, Changes = what's
  // uncommitted in *this* file). Ephemeral, resets on close, and mutually
  // exclusive with annotate/history/at-commit (joining that exclusivity set via
  // resolveViewToggles). The diff fetch owns its own loading/error/diff state,
  // mirroring blame/history's per-view separation. `untracked` rides along so a
  // brand-new file can be badged (the whole file shows as added in the diff).
  const [changes, setChanges] = useState(false);
  const [changesDiff, setChangesDiff] = useState<string | null>(null);
  const [changesUntracked, setChangesUntracked] = useState(false);
  const [changesError, setChangesError] = useState<string | null>(null);
  // Which (chatId:filePath) the held diff is for. While Changes is active but the
  // diff is for a DIFFERENT file (navigation) or has never been fetched, a
  // foreground fetch is in-flight → show the spinner. The derived loading flag
  // (changesViewLoading, computed at render) reads this so a toggle/navigation
  // can't flash a stale or null diff as 'clean' before the fetch effect (which
  // runs after paint) catches up — the same class of race WARDEN-561 guards for
  // the content fetch. loadChangesDiff records the live key once a response lands;
  // the Changes toggle clears it so each toggle-on shows a clean spinner.
  const [changesFetchedKey, setChangesFetchedKey] = useState<string | null>(null);
  // One AbortController per open session; close/switch/unmount aborts the
  // in-flight read so a stale fetch never setContent/setError after the dialog
  // is gone. Replaces the inline fetch's per-effect `cancelled` flag (WARDEN-561)
  // now that the same fetch is shared by the initial open, the ↻ button, and the
  // Follow interval.
  const abortRef = useRef<AbortController | null>(null);

  // Rendered ⇄ Source view mode for markdown files (WARDEN-266). Now App-owned
  // and persisted (WARDEN-480): `viewMode` is the controlled prop (see Props);
  // the toggle handler calls `onViewModeChange`. Only the plain view branch
  // (!annotate && !hasLine) honors it; line-jump and blame views stay source-
  // based regardless. Defaults to rendered so opening a README shows docs.

  // Read the open file. Extracted (WARDEN-749) so the manual ↻ reload and the
  // Follow interval re-run the SAME path as the initial open. Two independent
  // options separate the three call styles:
  //   - foreground (initial open, default): sets `loading` so the body shows the
  //     spinner, and surfaces fetch errors via `error` state (blanks the viewer
  //     with the red error box — correct for the first read, where there is no
  //     last-good content to keep).
  //   - background (↻ reload, Follow poll): updates content IN PLACE with no
  //     loading flash.
  // `surfaceErrors` only matters in background mode — it decouples the no-flash
  // update from failure reporting:
  //   - manual ↻ passes `surfaceErrors: true`: the user asked for a refresh, so a
  //     deleted/renamed/unreadable file must NOT fail silently — a non-blocking
  //     `toast.error` says the reload didn't land while the last-good content
  //     stays on screen (the viewer is not blanked; only the initial-open path
  //     owns the blank-with-error state).
  //   - Follow poll leaves it false: a transient blip must not nag a reader
  //     watching a live feed; the next poll recovers.
  // All calls during one open session share that session's AbortController, so
  // close/switch/unmount aborts the in-flight read and the `ac.signal.aborted`
  // guards prevent any post-close setState (the WARDEN-561 race the inline
  // fetch's `cancelled` flag guarded against — now generalized to 3 callers).
  const loadContent = useCallback(async (opts?: { background?: boolean; surfaceErrors?: boolean }) => {
    const background = opts?.background === true;
    const surfaceErrors = opts?.surfaceErrors === true;
    const ac = abortRef.current;
    if (!ac) return; // dialog closed / no active session
    if (!background) setLoading(true);
    try {
      // WARDEN-1144: bounded, COMPOSED with the session AbortController rather
      // than replacing it — the two answer different questions and both must be
      // answerable. `ac.signal` still cancels on close/switch/unmount (it is
      // passed through as the helper's caller `signal`, and a caller abort is
      // terminal: it rejects with `ac`'s own reason so every `ac.signal.aborted`
      // guard below still fires and no retry runs). The DEADLINE is what ends a
      // wait nobody cancelled — a stall on the foreground path held `loading`
      // with nothing left to clear it. A READ that happens to be a POST.
      const response = await fetchBounded('/api/read-file', {
        signal: ac.signal,
        init: {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: chatId, path: filePath }),
        },
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        if (ac.signal.aborted) return;
        const msg = data.error || `Failed to read file: ${response.statusText}`;
        if (!background) setError(msg);
        else if (surfaceErrors) toast.error(msg); // manual ↻: non-blocking, last-good content stays
        return;
      }

      const data = await response.json();
      if (ac.signal.aborted) return;
      // Change detection (WARDEN-749): skip the state write when content is
      // unchanged so a static file doesn't re-render / re-tokenize on every poll
      // (and a reader's scroll is preserved). Returning the PREVIOUS value from
      // the updater makes React bail out of the re-render entirely (Object.is).
      // `data.content` is a fresh string each fetch, so `===` is a value compare.
      setContent((prev) => (prev === data.content ? prev : data.content));
      setError(null);
    } catch (e) {
      if (ac.signal.aborted) return; // close/switch abort — ignore, no setState
      const msg = e instanceof Error ? e.message : 'Failed to read file';
      if (!background) setError(msg);
      else if (surfaceErrors) toast.error(msg); // manual ↻: tell the user the reload didn't land
      // background + !surfaceErrors (Follow poll): silent on transient error —
      // keep the last-good content so a live follow stays readable across a
      // network blip; the next poll recovers.
    } finally {
      if (!ac.signal.aborted && !background) setLoading(false);
    }
  }, [chatId, filePath]);

  // Fetch the open file's uncommitted working-tree diff vs HEAD (WARDEN-786).
  // Extracted (mirroring loadContent) so the foreground fetch (Changes toggle on
  // / file change) and the Follow-poll background refresh re-run the SAME path.
  // GET /api/git-diff?id=&path= with NO staged/range params is exactly the
  // worktree-vs-HEAD unified diff for one file (the contract the route defaults
  // to). Shares the session AbortController so close/switch/unmount aborts an
  // in-flight diff and the aborted guards prevent any post-close setState — the
  // same WARDEN-561 discipline loadContent follows.
  //
  // `background` (Follow poll) decouples the no-flash refresh from failure
  // reporting, exactly as loadContent does: a transient blip on a live follow
  // must NOT blank the diff with a red error — the last-good diff stays so a
  // coordinator watching an agent edit keeps reading across a network hiccup;
  // the next poll recovers.
  const loadChangesDiff = useCallback(async (opts?: { background?: boolean }) => {
    const background = opts?.background === true;
    const ac = abortRef.current;
    if (!ac) return; // dialog closed / no active session
    // The key for THIS fetch — recorded when a response lands so the derived
    // loading flag (`${chatId}:${filePath}` !== changesFetchedKey) clears.
    const key = `${chatId}:${filePath}`;
    try {
      // WARDEN-1144: bounded, composed with the session AbortController (same
      // rationale as loadContent above). This gates the DERIVED changes-view
      // loading flag, which clears only when `changesFetchedKey` is written —
      // and every write to it sits after this await.
      const response = await fetchBounded(`/api/git-diff?id=${encodeURIComponent(chatId)}&path=${encodeURIComponent(filePath)}`, {
        signal: ac.signal,
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        if (ac.signal.aborted) return;
        const msg = data.error || `Failed to load changes (${response.status})`;
        if (!background) {
          setChangesError(msg);
          setChangesDiff(null);
          setChangesFetchedKey(key); // foreground error is a terminal result → clear loading
        }
        // background: keep last-good diff + error, don't flash on a blip.
        return;
      }
      const data = await response.json();
      if (ac.signal.aborted) return;
      // The endpoint's in-body `error` (soft failure: not-a-git-repo / oversize /
      // binary) MUST surface (ConflictView.tsx:85 precedent) — never mask as clean.
      setChangesDiff(typeof data.diff === 'string' ? data.diff : null);
      setChangesUntracked(!!data.untracked);
      setChangesError(data.error || null);
      setChangesFetchedKey(key); // success → record the key (clears derived loading)
    } catch (e) {
      if (ac.signal.aborted) return; // close/switch abort — ignore, no setState
      const msg = e instanceof Error ? e.message : 'Failed to load changes';
      if (!background) {
        setChangesError(msg);
        setChangesFetchedKey(key); // foreground transport error → terminal result
      }
      // background + Follow poll: silent on transient error — keep the last-good
      // diff readable; the next poll recovers.
    }
  }, [chatId, filePath]);

  // Initial / on-file-change fetch. Resets per-open ephemeral state (including
  // Follow) so a stale mode never carries into a fresh open, arms the session
  // AbortController, then kicks the foreground load. The cleanup aborts so a
  // fast close/switch can't flash a just-closed file's content (WARDEN-561).
  useEffect(() => {
    if (!open) {
      setContent(null);
      setError(null);
      setAnnotate(false); // start each open fresh (avoid stale blame for a prior file)
      setBlame(null);
      setBlameError(null);
      setHistory(false); // likewise reset file-history (avoid stale commits for a prior file)
      setCommits(null);
      setHistoryError(null);
      // viewMode is NOT reset here (WARDEN-480): it's now a persisted App pref,
      // so the Rendered⇄Source choice survives across opens/reloads. The other
      // resets here clear genuinely stale per-file state; viewMode is global.
      setViewAtCommit(null); // clear any at-commit snapshot (avoid stale blob for a prior file)
      setBlobContent(null);
      setBlobError(null);
      setBlobLoading(false);
      blobCache.current.clear();
      setFollow(false); // Follow is ephemeral (WARDEN-749): reset on close, not persisted
      setManualReloading(false);
      setChanges(false); // Changes is ephemeral (WARDEN-786): reset on close, not persisted
      setChangesDiff(null);
      setChangesUntracked(false);
      setChangesError(null);
      setChangesFetchedKey(null);
      abortRef.current = null;
      return;
    }

    const ac = new AbortController();
    abortRef.current = ac;
    loadContent();
    return () => { ac.abort(); abortRef.current = null; };
  }, [chatId, filePath, open, loadContent]);

  // Follow poller (WARDEN-749): while the dialog is open AND Follow is ON, re-read
  // the file on the resolved poll cadence so an agent's writes appear without a
  // close/reopen. Visibility-gated — a backgrounded tab must not burn polls — with
  // an immediate refresh on focus regain (state may be stale while hidden). This
  // is the codebase-wide poller invariant (WARDEN-678), mirrored from
  // useLiveTimeline: BOTH the tick gate AND the visibilitychange immediate-refresh
  // listener are present, and cleanup removes both. Tearing down on follow/open/
  // cadence/file change clears the interval + listener (no leaked timers).
  useEffect(() => {
    if (!open || !follow) return;
    const intervalMs = pollIntervalMs ?? WEB_POLL_DEFAULT_MS;
    const tick = () => {
      if (document.visibilityState !== 'visible') return;
      void loadContent({ background: true });
      // Optional Changes enhancement (WARDEN-786): while the diff view is ALSO
      // on, re-fetch it on Follow's existing cadence so a coordinator watching
      // an agent edit sees the uncommitted delta accumulate live — the tail -f
      // analogue for "what has the agent changed here since HEAD?". No NEW poll
      // loop: this rides Follow's interval, gated on `changes` so it only fires
      // when the diff view is the active content.
      if (changes) void loadChangesDiff({ background: true });
    };
    const onVisibility = () => {
      if (document.visibilityState !== 'visible') return;
      void loadContent({ background: true });
      if (changes) void loadChangesDiff({ background: true });
    };
    const intervalId = window.setInterval(tick, intervalMs);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      clearInterval(intervalId);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [open, follow, pollIntervalMs, loadContent, changes, loadChangesDiff]);

  // Fetch the working-tree-vs-HEAD diff only while the Changes view is active
  // (WARDEN-786). Mirrors the blame/history gated-fetch effects: foreground load
  // (sets the spinner) when the toggle turns on or the file/chat changes. Re-runs
  // on `changes` so toggling off→on re-fetches, and on chatId/filePath so a
  // navigated file (breadcrumb / sibling pick) refreshes the diff for the new path.
  useEffect(() => {
    if (!open || !changes) return;
    loadChangesDiff();
  }, [open, changes, chatId, filePath, loadChangesDiff]);

  // Fetch blame only while annotating. useGatedFetch owns the cancelled guard,
  // the loading/error reset, the response.ok-gated fetch + j.error surfacing, and
  // the cleanup (WARDEN-884); a 4xx/5xx (e.g. unknown chat → 404) surfaces as an
  // error, not a silent success (WARDEN-89: a resolved fetch is not a success).
  useGatedFetch<BlameLine>({
    gate: open && annotate,
    buildUrl: () => `/api/git-blame?id=${encodeURIComponent(chatId)}&path=${encodeURIComponent(filePath)}`,
    onData: setBlame,
    onLoading: setBlameLoading,
    onError: setBlameError,
    field: 'lines',
    label: 'annotation',
    deps: [open, annotate, chatId, filePath],
  });

  // Fetch the file's commit history only while in history view-mode. Mirrors the
  // blame fetch via useGatedFetch (WARDEN-884): a 4xx/5xx (e.g. unknown chat → 404)
  // surfaces as an error, not a silent success (WARDEN-89). The `path` query flips
  // /api/git-log into file-history mode (git log --follow -- <path>), so this lists
  // every commit that touched the open file, across renames.
  useGatedFetch<HistoryCommit>({
    gate: open && history,
    buildUrl: () => `/api/git-log?id=${encodeURIComponent(chatId)}&path=${encodeURIComponent(filePath)}&limit=20`,
    onData: setCommits,
    onLoading: setHistoryLoading,
    onError: setHistoryError,
    field: 'commits',
    label: 'history',
    deps: [open, history, chatId, filePath],
  });

  // Fetch the file's full blob at the selected historical commit (WARDEN-354).
  // Mirrors the blame/history fetches: gates the success path on response.ok so a
  // 4xx/5xx (e.g. unknown chat → 404) surfaces as an error, not silent success
  // (WARDEN-89). A per-hash cache makes re-viewing a commit instant — the
  // endpoint is read-only and stable for a given (chat, file, hash), so a cached
  // result never goes stale within a dialog session.
  useEffect(() => {
    if (!open || !viewAtCommit) return;
    const key = `${chatId}:${filePath}:${viewAtCommit.hash}`;
    const cached = blobCache.current.get(key);
    if (cached) {
      setBlobContent(cached.content);
      setBlobError(cached.error);
      setBlobLoading(false);
      return;
    }
    let cancelled = false;
    setBlobLoading(true);
    setBlobError(null);
    setBlobContent(null);
    const fetchBlob = async () => {
      let content: string | null = null;
      let error: string | null = null;
      try {
        // WARDEN-1144: bounded — gates `blobLoading`, cleared only after this await.
        const r = await fetchBounded(`/api/git-cat-file?id=${encodeURIComponent(chatId)}&hash=${encodeURIComponent(viewAtCommit.hash)}&path=${encodeURIComponent(filePath)}`);
        // Tolerant on !ok (the status carries the message), STRICT on 2xx — a 2xx
        // body that fails to parse is a real failure and must reach the catch below
        // rather than becoming empty content with no error at all (WARDEN-1014).
        // The `?? {}` is load-bearing: readListBody resolves to `undefined` on the
        // !ok leg, and both fields are dereferenced unconditionally right below.
        const j = ((await readListBody(r)) as { content?: string; error?: string }) ?? {};
        content = typeof j.content === 'string' ? j.content : null;
        error = j.error || (r.ok ? null : `Failed to load file at commit (${r.status})`);
      } catch (e) {
        error = e instanceof Error ? e.message : 'Failed to load file at commit';
      }
      if (cancelled) return;
      blobCache.current.set(key, { content, error });
      setBlobContent(content);
      setBlobError(error);
      setBlobLoading(false);
    };
    fetchBlob();
    return () => { cancelled = true; };
  }, [open, viewAtCommit, chatId, filePath]);

  // The at-commit snapshot belongs to the open file's history — clear it when the
  // file changes so a stale blob (for a commit of a prior file) is never shown.
  useEffect(() => { setViewAtCommit(null); }, [chatId, filePath]);

  // When a target line is requested and the content has rendered, scroll that line
  // to the center of the viewport so the user lands on the relevant location. rAF
  // guarantees the per-line DOM is committed before we measure/scroll it. Re-runs
  // if the same file is re-opened at a different line (content is reused; only the
  // scroll target moves) — `line` is in the dep list for exactly that case.
  useEffect(() => {
    if (!open || typeof line !== 'number' || line < 1 || loading || error || content === null) return;
    const id = requestAnimationFrame(() => {
      highlightRef.current?.scrollIntoView({ block: 'center', behavior: 'auto' });
    });
    return () => cancelAnimationFrame(id);
  }, [open, line, loading, error, content]);

  const hasLine = typeof line === 'number' && line > 0;

  // Whether the stick-to-bottom region should auto-pin: Follow ON and the plain
  // view only. Line-jump / annotate / history / commit-snapshot views own their
  // own scroll semantics and must not be auto-scrolled on a poll. Computed here
  // and handed to <StickRegion> (which owns the useStickToBottom hook).
  const stickActive = follow && !hasLine && !annotate && !history && !viewAtCommit && !changes;

  // Synchronous loading derive for the Changes view (WARDEN-786): true while a
  // foreground fetch is in-flight for the current file. Read at render from the
  // live (chatId:filePath) vs the held result's key (changesFetchedKey) — no
  // effect-timing window, so toggling Changes or navigating files can't flash a
  // stale/null diff as 'clean' before the fetch lands. Follow's background polls
  // reuse loadChangesDiff WITHOUT clearing the key, so a live tail updates the
  // diff in place (no spinner flashing on every poll).
  const changesViewLoading = `${chatId}:${filePath}` !== changesFetchedKey;

  // Markdown files render as formatted docs in the plain view branch (WARDEN-266).
  // Case-insensitive so .MD / .Markdown match too. Line-jump and Annotate views
  // stay source-based regardless.
  const isMarkdown = /\.(md|markdown)$/i.test(filePath);

  // Source-code highlighting (WARDEN-281): infer the language from the path and
  // tokenize the file ONCE into per-line colored leaves, so the plain + line-jump
  // branches below can drop colored spans into each row WITHOUT collapsing the file
  // into a single tokenized blob (that would break the one-row-per-line grid
  // WARDEN-227's scrollIntoView target and WARDEN-205's blame gutter rely on).
  // `null` for an unsupported extension — including markdown, whose rendered mode is
  // left untouched and whose source mode stays plain monospace. AnnotatedContent
  // tokenizes independently (it owns its own content/filePath + the blame alignment).
  const sourceLang = useMemo(() => languageFromPath(filePath), [filePath]);
  const tokenLines = useMemo(
    () => (sourceLang && content !== null ? tokenizeCode(content, sourceLang) : null),
    [content, sourceLang],
  );

  // The content currently on screen, used by the "Copy file content" menu item.
  // In normal view that's the fetched `content`, but while viewing a historical
  // commit snapshot (viewAtCommit !== null, WARDEN-354) the on-screen text is the
  // fetched `blobContent` instead. null while loading / in error / empty — the copy
  // item is disabled then, never copying an empty string (a no-op copy is not the
  // same as a silent copy of "").
  const displayedContent = viewAtCommit ? blobContent : content;

  // Breadcrumb geometry (WARDEN-740). `segments` is the normalized split of the
  // cwd-relative path; `crumbs` are the clickable PROPER ancestors (a root crumb
  // that lists the repo root, then one per directory segment that lists its own
  // dir) — empty for a root-level file, which has no ancestors. The final segment
  // is the open file (not clickable). Each crumb carries the dir /api/git-ls
  // lists when clicked (ancestorDir = slice(0, i), exactly the ticket's contract).
  const segments = useMemo(() => splitPathSegments(filePath), [filePath]);
  const crumbs = useMemo<Crumb[]>(() => {
    // A root-level file has a single segment and no proper ancestors — render no
    // crumbs (the file name stands alone), matching the WARDEN-740 segmentation pin.
    if (segments.length <= 1) return [];
    return [
      { label: '', dir: '', isRoot: true }, // repo root → lists dir=''
      ...segments.slice(0, -1).map((seg, i) => ({ label: seg, dir: ancestorDir(segments, i + 1), isRoot: false })),
    ];
  }, [segments]);
  const fileName = segments[segments.length - 1] ?? filePath;
  // A deep path's crumbs cannot all fit the title row, so the middle of the run
  // collapses behind the `…` overflow menu (WARDEN-1006). Pure, and unit-tested
  // in breadcrumbs.test.mjs — `lead + hidden + tail` is always the whole list,
  // so collapsing hides crumbs from the row but never from the UI.
  const { lead, hidden, tail } = useMemo(() => collapseCrumbs(crumbs), [crumbs]);
  // Whether the crumb run gets its minimum width — see crumbRunNeedsFloor for why
  // this is decided here rather than in CSS (a `min-width` that always applied
  // would inflate a short path's crumb run).
  const floorCrumbRun = useMemo(
    () => crumbRunNeedsFloor([...lead, ...tail], hidden.length > 0),
    [lead, hidden, tail],
  );
  // Degrade to the plain non-clickable path when no navigation callback is wired
  // (all three render sites wire it, but the prop is optional for safety).
  const navigable = typeof onNavigate === 'function';

  // Manual ↻ reload (WARDEN-749): a one-shot refresh independent of Follow —
  // today no refresh exists at all, so a stale file forces a close/reopen. Runs
  // as a background-style load (no loading flash; content updates in place) and
  // toggles a brief button spinner via `manualReloading` for visible feedback.
  // `surfaceErrors: true` so a deleted/renamed/unreadable file does NOT fail
  // silently — the user asked for the current content, so a missed reload toasts
  // (non-blocking; the last-good content stays on screen rather than blanking).
  const handleManualReload = useCallback(async () => {
    setManualReloading(true);
    try {
      await loadContent({ background: true, surfaceErrors: true });
    } finally {
      setManualReloading(false);
    }
  }, [loadContent]);

  // The collapsible half of the header toolbar (WARDEN-1019). `secondaryToolbarActions`
  // owns WHICH controls collapse, in what order, and what state each reports —
  // pure, so the contract has real unit coverage (fileViewerToolbar.test.mjs) in a
  // repo with no DOM test runner. Icons and handlers stay here, keyed by `key`, so
  // the inline row and the `⋯` menu drive the SAME callback and the same pressed
  // state rather than being two copies that can drift.
  const secondaryActions = useMemo(
    () => secondaryToolbarActions({ isMarkdown, viewMode, history, annotate, follow, manualReloading }),
    [isMarkdown, viewMode, history, annotate, follow, manualReloading],
  );
  const leadingActions = secondaryActions.filter((a) => TOOLBAR_LEADING_KEYS.includes(a.key));
  const trailingActions = secondaryActions.filter((a) => TOOLBAR_TRAILING_KEYS.includes(a.key));
  const actionMeta: Record<ToolbarActionKey, ToolbarActionMeta> = {
    viewmode: {
      icon: viewMode === 'rendered' ? <BookOpenIcon className="w-3.5 h-3.5" /> : <Code2Icon className="w-3.5 h-3.5" />,
      onSelect: () => onViewModeChange(viewMode === 'rendered' ? 'source' : 'rendered'),
    },
    history: {
      icon: <HistoryIcon className="w-3.5 h-3.5" />,
      onSelect: () => {
        // resolveViewToggles (WARDEN-786) centralizes the toolbar's
        // mutual-exclusivity contract now that Changes joins the set:
        // turning history on clears annotate + changes. viewAtCommit
        // (a snapshot reached from the history list) is cleared when
        // leaving history — its own history-specific asymmetry.
        const t = resolveViewToggles({ annotate, history, changes }, 'history', !history);
        setAnnotate(t.annotate);
        setHistory(t.history);
        setChanges(t.changes);
        if (!t.history) setViewAtCommit(null); // leaving history → drop any at-commit snapshot
      },
    },
    annotate: {
      icon: <GitCommitHorizontalIcon className="w-3.5 h-3.5" />,
      onSelect: () => {
        // Turning annotate on clears history + changes (resolveViewToggles)
        // and drops any at-commit snapshot (annotate replaces the content).
        const t = resolveViewToggles({ annotate, history, changes }, 'annotate', !annotate);
        setAnnotate(t.annotate);
        setHistory(t.history);
        setChanges(t.changes);
        if (t.annotate) setViewAtCommit(null); // annotate forces history off → drop any snapshot
      },
    },
    // Manual reload (WARDEN-749): a one-shot refresh. Independently useful —
    // before this no refresh existed, so a stale file forced a close/reopen.
    // Spinner swaps in while in-flight; icon-only on the row, labelled in the menu.
    reload: {
      icon: manualReloading
        ? <Loader2Icon className="h-3.5 w-3.5 animate-spin" />
        : <RotateCwIcon className="h-3.5 w-3.5" />,
      onSelect: handleManualReload,
      iconOnly: true,
      disabled: manualReloading,
    },
    // Follow toggle (WARDEN-749): live-update the open file on the poll cadence
    // as an agent writes to it (tail -f). Ephemeral — resets on close. Pauses
    // while the tab is hidden.
    follow: {
      icon: <CircleDotIcon className="h-3.5 w-3.5" />,
      onSelect: () => setFollow((f) => !f),
    },
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <DialogContent className="sm:max-w-4xl max-h-[80vh]">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 pr-8">
                <FileIcon className="w-4 h-4 shrink-0" />
                {navigable && crumbs.length > 0 ? (
                  <nav aria-label="File path" className="flex min-w-0 items-center gap-0.5 overflow-hidden">
                    {/* The crumbs are fixed-size click targets, so a deep path's
                        min-content width exceeds the title row. Three parts to the
                        fix (WARDEN-1006):

                        STRUCTURAL — `collapseCrumbs` hides the MIDDLE of a deep
                        path behind the `…` menu, which still lists those dirs, so
                        the collapse is visible and none of the navigation it
                        represents is lost. CSS alone cannot choose which crumbs
                        to drop; it can only slice whatever runs past the edge.

                        PRIORITY — the crumb run is the heavily-weighted flex item
                        (`shrink-[9999]`), so it yields the row's shrink long
                        before the FILENAME — the part that says what you are
                        looking at — gives up a pixel.

                        FLOOR — but not ALL of it: `lg:min-w-48` stops the run
                        being squeezed to nothing, which is how the crumbs would
                        otherwise "survive" a long path (present, 8px wide, empty).
                        Under the floor the crumbs `truncate` — a squeezed crumb
                        reads as a word with an ellipsis and stays a real click
                        target — instead of being sliced mid-glyph. The floor is
                        applied only to a run wide enough to need it (see
                        `crumbRunNeedsFloor`: a `min-width` beats content width, so
                        an unconditional one would INFLATE a short crumb run and
                        leave a gap before the filename) and only at `lg`, below
                        which the dialog is narrow enough that reserving 12rem for
                        the path would starve the filename instead.

                        `overflow-hidden` here is the outer guarantee that makes
                        the floor safe: if the row is narrower than the floor the
                        crumb run is clipped at the nav's edge rather than painting
                        over the toolbar and the close X — the WARDEN-1006 defect
                        itself. The crumb buttons use `ring-inset` so a focus ring
                        at the boundary is drawn inside the button and survives the
                        clip. Before WARDEN-1006 none of this was needed because
                        the whole dialog stretched to fit the header; now that
                        DialogContent's children are held to the panel, the header
                        has to divide a finite row. */}
                    <span className={`flex min-w-0 shrink-[9999] items-center gap-0.5 overflow-hidden${floorCrumbRun ? ' lg:min-w-48' : ''}`}>
                      {lead.map((c) => (
                        <Fragment key={c.dir || '__root'}>
                          <PathCrumb
                            crumb={c}
                            chatId={chatId}
                            open={openCrumb === c.dir}
                            onOpenChange={(o) => setOpenCrumb(o ? c.dir : null)}
                            onPick={(p) => { setOpenCrumb(null); onNavigate?.(p); }}
                          />
                          <CrumbSeparator />
                        </Fragment>
                      ))}
                      {hidden.length > 0 && (
                        <Fragment key={OVERFLOW_CRUMB_KEY}>
                          <CollapsedCrumbs
                            crumbs={hidden}
                            chatId={chatId}
                            open={openCrumb === OVERFLOW_CRUMB_KEY}
                            onOpenChange={(o) => setOpenCrumb(o ? OVERFLOW_CRUMB_KEY : null)}
                            onPick={(p) => { setOpenCrumb(null); onNavigate?.(p); }}
                          />
                          <CrumbSeparator />
                        </Fragment>
                      )}
                      {tail.map((c) => (
                        <Fragment key={c.dir || '__root'}>
                          <PathCrumb
                            crumb={c}
                            chatId={chatId}
                            open={openCrumb === c.dir}
                            onOpenChange={(o) => setOpenCrumb(o ? c.dir : null)}
                            onPick={(p) => { setOpenCrumb(null); onNavigate?.(p); }}
                          />
                          <CrumbSeparator />
                        </Fragment>
                      ))}
                    </span>
                    <span className="min-w-0 truncate text-foreground" title={filePath}>{fileName}</span>
                  </nav>
                ) : (
                  <span className="truncate">{filePath}</span>
                )}
                {/* The header toolbar (WARDEN-1019).

                    Below `md` only `Changes` and the close X stay on the row and
                    everything else collapses into the `⋯` overflow menu. Every
                    control is `shrink-0`, so the full toolbar's min-content width
                    (~510px with a markdown file's six controls) is a floor the row
                    cannot go under: at 375px it paints through DialogTitle's `pr-8`
                    close-X reserve and past the panel's right edge, and a click
                    aimed at `Changes` lands on the close X or the overlay and shuts
                    the viewer. `Changes` is the control that mis-hit was reported
                    against, so it is the one that never collapses.

                    Gated in CSS (`hidden md:flex` / `md:hidden`) rather than by a
                    JS media query so there is no resize listener and no wrong-width
                    first paint. The two inline groups straddle `Changes` to keep the
                    desktop row exactly as it shipped — see TOOLBAR_LEADING_KEYS. */}
                <div className="ml-auto flex items-center gap-2">
                  <div className="hidden items-center gap-2 md:flex">
                    {leadingActions.map((a) => (
                      <ToolbarActionButton key={a.key} action={a} meta={actionMeta[a.key]} />
                    ))}
                  </div>
                  {/* Changes view (WARDEN-786): the missing fourth file-understanding
                      surface — this file's uncommitted working-tree diff vs HEAD, so a
                      coordinator can answer "what has the agent changed here since HEAD?"
                      without leaving FileViewer for GitBadges' dirty popover. Fetches
                      /api/git-diff?id=&path= (worktree-vs-HEAD) and renders via DiffBlock.
                      Mutually exclusive with Annotate/History/at-commit (resolveViewToggles). */}
                  <Button
                    type="button"
                    variant={changes ? 'default' : 'outline'}
                    size="sm"
                    className="h-7 shrink-0 gap-1.5 text-xs"
                    onClick={() => {
                      const t = resolveViewToggles({ annotate, history, changes }, 'changes', !changes);
                      setAnnotate(t.annotate);
                      setHistory(t.history);
                      setChanges(t.changes);
                      if (t.changes) {
                        setViewAtCommit(null); // changes replaces the content → drop any snapshot
                        // Clear the held result so the derive shows a spinner until the
                        // fresh fetch lands — never a stale/null 'clean' flash on a dirty file.
                        setChangesFetchedKey(null);
                        setChangesError(null);
                      }
                    }}
                    title={changes ? 'Hide uncommitted changes' : "Show this file's uncommitted changes vs HEAD (what the agent has changed since the last commit)"}
                    aria-pressed={changes}
                  >
                    <FilePenIcon className="w-3.5 h-3.5" />
                    Changes
                  </Button>
                  <div className="hidden items-center gap-2 md:flex">
                    {trailingActions.map((a) => (
                      <ToolbarActionButton key={a.key} action={a} meta={actionMeta[a.key]} />
                    ))}
                  </div>
                  <ToolbarOverflowMenu
                    className="md:hidden"
                    actions={secondaryActions}
                    metas={actionMeta}
                    open={toolbarMenuOpen}
                    onOpenChange={setToolbarMenuOpen}
                  />
                </div>
              </DialogTitle>
            </DialogHeader>

            {/* StickRegion wraps the ScrollArea so the useStickToBottom hook
                mounts WITH the dialog content (Radix only mounts DialogContent
                when open; the hook resolves the viewport once on its OWN mount).
                Re-pins to the tail on a Follow content update when `stickActive`
                — tail -f behavior that respects a reader scrolled up. See
                StickRegion below. (WARDEN-749) */}
            <StickRegion active={stickActive} pinKey={content}>
            <ScrollArea className="h-[60vh] w-full rounded-md border bg-muted/50">
              <div className="p-4">
                {viewAtCommit ? (
                  <CommitBlobView
                    commit={viewAtCommit}
                    filePath={filePath}
                    content={blobContent}
                    loading={blobLoading}
                    error={blobError}
                    viewMode={viewMode}
                    isMarkdown={isMarkdown}
                    onOpenPath={navigable ? (p) => onNavigate?.(p) : undefined}
                    onBack={() => setViewAtCommit(null)}
                  />
                ) : changes ? (
                  <ChangesContent
                    diff={changesDiff}
                    untracked={changesUntracked}
                    loading={changesViewLoading}
                    error={changesError}
                  />
                ) : (
                  <>
                {loading && (
                  <div className="flex items-center justify-center gap-2 py-8 text-muted-foreground">
                    <Loader2Icon className="w-5 h-5 animate-spin" />
                    <span>Loading file...</span>
                  </div>
                )}

                {error && (
                  <div className="flex items-center gap-2 py-8 text-red-400">
                    <AlertCircleIcon className="w-5 h-5" />
                    <span>{error}</span>
                  </div>
                )}

                {!loading && !error && content !== null && !annotate && !history && !hasLine && (
                  isMarkdown && viewMode === 'rendered' ? (
                    <div className="flex flex-col gap-2 text-sm leading-relaxed">
                      <MarkdownBody
                        baseFilePath={filePath}
                        onOpenPath={navigable ? (p) => onNavigate?.(p) : undefined}
                      >
                        {content}
                      </MarkdownBody>
                    </div>
                  ) : (
                    <pre className="text-sm font-mono whitespace-pre-wrap break-words">
                      {tokenLines ? (
                        tokenLines.map((line, i) => (
                          <div key={i}><HighlightedLine leaves={line} /></div>
                        ))
                      ) : (
                        content
                      )}
                    </pre>
                  )
                )}

                {!loading && !error && content !== null && !annotate && !history && hasLine && (
                  <div className="text-sm font-mono">
                    {content.split('\n').map((text, i) => {
                      const n = i + 1;
                      const isTarget = n === line;
                      return (
                        <div key={n} ref={isTarget ? highlightRef : undefined}
                          className={`flex ${isTarget ? 'bg-primary/20 ring-1 ring-inset ring-primary/40 rounded-sm' : ''}`}>
                          <span className="select-none pr-3 text-right text-muted-foreground/40 min-w-[2.5rem]">{n}</span>
                          <span className="whitespace-pre-wrap break-words flex-1">
                            {tokenLines ? <HighlightedLine leaves={tokenLines[i] ?? []} /> : text}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                )}

                {!loading && !error && content !== null && annotate && (
                  <AnnotatedContent
                    content={content}
                    blame={blame}
                    blameLoading={blameLoading}
                    blameError={blameError}
                    chatId={chatId}
                    filePath={filePath}
                    timestampFormat={timestampFormat}
                  />
                )}

                {!loading && !error && content !== null && history && (
                  <HistoryContent
                    commits={commits}
                    historyLoading={historyLoading}
                    historyError={historyError}
                    chatId={chatId}
                    filePath={filePath}
                    onViewAtCommit={setViewAtCommit}
                  />
                )}

                {!loading && !error && content === null && (
                  <div className="flex items-center justify-center py-8 text-muted-foreground">
                    No content
                  </div>
                )}
                  </>
                )}
              </div>
            </ScrollArea>
            </StickRegion>

            <DialogClose asChild>
              <Button variant="outline" className="w-full sm:w-auto">Close</Button>
            </DialogClose>
          </DialogContent>
        </ContextMenuTrigger>
        <ContextMenuContent>
          {/* Copies the FULL path regardless of the header's truncation
              (FileViewer.tsx span.truncate) — the most natural "copy path" target. */}
          <ContextMenuItem onSelect={() => copyWithToast(filePath)}>Copy file path</ContextMenuItem>
          {/* Mirrors the "Copy name" vocabulary of the collection-card / workspace-tab siblings. */}
          <ContextMenuItem onSelect={() => copyWithToast(basename(filePath))}>Copy filename</ContextMenuItem>
          {/* Copies whatever is on screen: the live file, or — while viewing a
              historical snapshot (WARDEN-354) — that commit's blob. Disabled while
              nothing is loaded so it can never silently copy an empty string. */}
          <ContextMenuItem
            disabled={displayedContent === null}
            onSelect={() => { if (displayedContent !== null) copyWithToast(displayedContent); }}
          >
            Copy file content
          </ContextMenuItem>
          <ContextMenuSeparator />
          {/* Closing a read-only viewer is non-destructive, so default variant
              (not destructive). Same close affordance as the bottom Close button. */}
          <ContextMenuItem onSelect={() => onOpenChange(false)}>Close</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    </Dialog>
  );
}

// The Follow stick-to-bottom region (WARDEN-749). Wraps the FileViewer's
// ScrollArea so the shared useStickToBottom hook mounts WITH the dialog content.
//
// Why a sub-component and not a hook called directly in FileViewer: Radix
// <Dialog> only mounts its <DialogContent> (and everything inside it) while
// `open` is true, but FileViewer itself is always mounted (the ChatSidebar path
// renders it with open=false before the first open). useStickToBottom resolves
// the Radix scroll viewport ONCE, in a useLayoutEffect that runs on its owner's
// mount — so if the owner is FileViewer, the viewport is absent at mount (the
// dialog is closed) and the hook returns early, never re-running: stick-to-
// bottom would silently never engage. StickRegion is rendered INSIDE
// DialogContent, so it mounts exactly when the scroll DOM appears, and the hook
// resolves the viewport at the right time. (ObserverPanel doesn't hit this
// because its scroll region is always mounted.)
//
// `active` = Follow ON and the plain view (line-jump / annotate / history /
// commit-snapshot own their scroll semantics). `pinKey` = the file content, so
// the re-pin fires once per Follow content update. stickIfPinned no-ops unless
// the user is already near the tail, so a reader scrolled up is never yanked
// down — the hook's synchronous followingRef is what makes the two coexist.
//
// `active` is also passed to useStickToBottom as its `enabled` flag, so the
// scroll/resize/mutation observers attach ONLY while Follow is on. This closes
// the niche short-file trap: with Follow OFF, a content change (toggling
// Annotate/History) used to fire the always-on observers and — for a file short
// enough that `followingRef` is true at mount — snap the view to the bottom
// (e.g. opening History landed at the commit-list bottom, not the top). With
// the observers gated on `active`, nothing auto-pins unless Follow is on.
// ObserverPanel, the hook's other consumer, omits the arg and stays always-on.
function StickRegion({ active, pinKey, children }: { active: boolean; pinKey: unknown; children: ReactNode }) {
  const { rootRef, stickIfPinned } = useStickToBottom(active);
  useLayoutEffect(() => {
    if (!active) return;
    stickIfPinned();
  }, [active, pinKey, stickIfPinned]);
  return <div ref={rootRef}>{children}</div>;
}

// Render one source line's colored leaves, or a single space for an empty line so
// the row keeps its height (matches the `' '` fallback the source branches used
// before highlighting). Shared by all three source-rendering branches so a file
// reads identically in the plain, line-jump, and annotate views (WARDEN-281). Each
// leaf is a `<span class="tok-…">` whose color comes from the `.tok-*` theme in
// index.css; a leaf with an empty className is untyped whitespace/punctuation that
// inherits the row's default text color.
function HighlightedLine({ leaves }: { leaves: Leaf[] }) {
  if (leaves.length === 0) return <>{' '}</>;
  return <>{leaves.map((lf, i) => <span key={i} className={lf.className}>{lf.value}</span>)}</>;
}

// The annotated view: one row per file line, with a left gutter showing per-line
// provenance (commit hash, author, relative date) and the line content on the right.
// Provenance is shown only at the START of each blame "run" (consecutive lines from
// the same commit) — mirroring how editors display blame — so a long file isn't
// wallpapered with repeated commit info. The hash opens a popover that fetches what
// that commit did to THIS file (/api/git-show ?hash&path), reusing the same committed-
// diff inspector as the sidebar's expanded commit (WARDEN-180) and DiffBlock.
function AnnotatedContent({ content, blame, blameLoading, blameError, chatId, filePath, timestampFormat }: {
  content: string;
  blame: BlameLine[] | null;
  blameLoading: boolean;
  blameError: string | null;
  chatId: string;
  filePath: string;
  timestampFormat: TimestampFormat;
}) {
  // Drop a single phantom trailing element (content ending in "\n" splits to an extra
  // "") so line numbers align with blame's 1-based result lines.
  const lines = useMemo(() => {
    const split = content.split('\n');
    if (split.length > 1 && content.endsWith('\n')) split.pop();
    return split;
  }, [content]);

  // Source highlighting for the blame view (WARDEN-281): one leaf-row per source
  // line, aligned to the SAME phantom-trailing-line drop applied to `lines` above so
  // a highlighted row stays 1:1 with its blame entry (and its 1-based line number) —
  // without that slice, a trailing newline would offset every colored row by one.
  const tokenLines = useMemo(() => {
    const lang = languageFromPath(filePath);
    if (!lang) return null;
    const full = tokenizeCode(content, lang);
    if (!full) return null;
    if (full.length > 1 && content.endsWith('\n')) return full.slice(0, -1);
    return full;
  }, [content, filePath]);

  const blameByLine = useMemo(() => {
    const m = new Map<number, BlameLine>();
    for (const b of blame ?? []) m.set(b.line, b);
    return m;
  }, [blame]);

  const hasBlame = !!blame && blame.length > 0;

  // Track the previous line's hash across the map iteration to detect run boundaries
  // (where the provenance should be shown). A line with no blame entry breaks the run.
  let prevHash = '';

  return (
    <div className="font-mono text-sm">
      {blameLoading && (
        <div className="mb-2 flex items-center gap-1.5 text-xs text-muted-foreground">
          <Loader2Icon className="w-3.5 h-3.5 animate-spin" />
          <span>Loading annotation…</span>
        </div>
      )}
      {!blameLoading && !blameError && !hasBlame && (
        <div className="mb-2 text-xs text-muted-foreground">No git history for this file.</div>
      )}
      {!blameLoading && blameError && (
        <div className="mb-2 flex items-center gap-1.5 text-xs text-red-400">
          <AlertCircleIcon className="w-3.5 h-3.5" />
          <span>{blameError}</span>
        </div>
      )}
      {lines.map((text, i) => {
        const lineNo = i + 1;
        const b = blameByLine.get(lineNo);
        const atBoundary = !!b && b.hash !== prevHash;
        prevHash = b ? b.hash : '';
        return (
          <div key={lineNo} className="group/line flex items-start gap-2 rounded px-1 hover:bg-accent/30">
            <span className="w-8 shrink-0 select-none pr-2 text-right text-xs leading-5 text-muted-foreground/40 group-hover/line:text-muted-foreground">{lineNo}</span>
            <div className="flex w-56 shrink-0 items-center gap-1.5 text-xs leading-5">
              {b && atBoundary ? (
                <>
                  <BlameHash chatId={chatId} filePath={filePath} hash={b.hash} summary={b.summary} author={b.author} dateLabel={formatTimestamp(b.date, timestampFormat)} />
                  <span className="min-w-0 truncate text-cyan-300/60" title={b.author}>{b.author}</span>
                  <span className="ml-auto shrink-0 text-muted-foreground/60" title={formatAbsoluteFull(b.date)}>{formatTimestamp(b.date, timestampFormat)}</span>
                </>
              ) : null}
            </div>
            <span className="flex-1 whitespace-pre-wrap break-words leading-5">
              {tokenLines ? <HighlightedLine leaves={tokenLines[i] ?? []} /> : (text || ' ')}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// A clickable commit hash. Opens a popover that fetches what that commit did to THIS
// file (the per-file `git show` diff, ?hash&path) and renders it via DiffBlock — the
// same committed-diff inspector as the sidebar's expanded commit (WARDEN-180). Shared
// by the annotate (blame) gutter and the history commit list (WARDEN-319): both need
// a per-file-commit diff inspector, so this owns the fetch+render once. Owns its fetch
// state so a re-open is instant. Mirrors CommitFile's self-contained shape.
//
// `dateLabel` is the ALREADY-formatted display date — formatting stays the caller's job
// because the two callers carry dates in different shapes: blame has author-time ISO
// (caller passes formatTimestamp(iso, pref)), history has git's relative %ar text
// (caller passes it verbatim). Either way the popover just stamps it next to the author.
function BlameHash({ chatId, filePath, hash, summary, author, dateLabel }: {
  chatId: string;
  filePath: string;
  hash: string;
  summary: string;
  author: string;
  dateLabel: string;
}) {
  const [open, setOpen] = useState(false);
  const [diff, setDiff] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [fetched, setFetched] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleOpenChange = async (next: boolean) => {
    setOpen(next);
    if (!next || fetched) return;
    setLoading(true);
    // Clear any previous failure BEFORE retrying, so a retry that succeeds does not
    // render its diff underneath a stale error line.
    setError(null);
    try {
      // WARDEN-1194: read through the extracted seam, which honours BOTH halves of
      // warden's error convention (non-2xx, AND the 200-with-{error} half that the
      // old `r.ok` gate missed entirely — `no cwd`, a route throw, and since
      // WARDEN-1192 a genuine `git show failed` for a deleted cwd / non-git cwd /
      // stopped container / dropped tunnel). It THROWS on failure, so a broken
      // repository can no longer arrive here disguised as an empty diff and render
      // the popover's confident "no diff for this file at this commit".
      // The DETAIL reader, not `readFileDiff`, because this popover renders a second
      // field off the same response: the commit body (WARDEN-388), below.
      // WARDEN-1144: the fetch below is bounded (fetchBounded) — it gates this
      // popover's `loading`, which the finally after this await is the only thing
      // that clears. One-shot (fires once per open) → the primitive's defaults.
      const { diff: text, message: body } = await readFileDiffDetail(
        await fetchBounded(`/api/git-show?id=${encodeURIComponent(chatId)}&hash=${encodeURIComponent(hash)}&path=${encodeURIComponent(filePath)}`),
      );
      // A genuinely empty diff stays empty and still renders "no diff for this file
      // at this commit" — only a real failure takes the catch below.
      setDiff(text || null);
      // The commit's body rides the same per-file fetch (no extra round-trip). Empty
      // for a subject-only commit → null so it renders nothing above the diff (the
      // hash row already shows the summary/subject) (WARDEN-388).
      setMessage(body || null);
      // Cache the SUCCESS only. Setting this in a `finally` (as the pre-fix code did)
      // pinned a failed popover to its wrong state forever: the guard above is
      // `if (!next || fetched)`, so closing and re-opening — the user's only recovery
      // affordance — silently did nothing until the component remounted. On the
      // failure path `fetched` stays false, so a re-open RE-ISSUES the fetch.
      // Successful caching (instant re-open) is unchanged. (WARDEN-1187's coupling,
      // same shape, same reason.)
      setFetched(true);
    } catch (e) {
      setDiff(null);
      setMessage(null);
      setError(e instanceof Error && e.message ? e.message : 'Failed to load diff');
    } finally {
      setLoading(false);
    }
  };

  const shortHash = hash.slice(0, 8);

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="xs"
          className="h-auto shrink-0 px-0 font-mono text-cyan-400/80 hover:text-cyan-300 hover:underline"
          title={`inspect what commit ${shortHash} did to this file`}
          onClick={(e) => e.stopPropagation()}
        >
          {shortHash}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={4}
        className="w-80 max-w-[22rem] p-1.5 text-xs"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-1 px-0.5">
          <div className="flex items-center gap-1.5">
            <span className="shrink-0 font-mono text-[10px] text-cyan-400/80">{shortHash}</span>
            <span className="min-w-0 flex-1 truncate text-[10px] text-foreground" title={summary}>{summary || '(no summary)'}</span>
          </div>
          <div className="truncate text-[10px] text-muted-foreground">{author}{dateLabel ? ` · ${dateLabel}` : ''}</div>
        </div>
        {loading ? (
          <div className="px-1 text-[10px] text-muted-foreground">loading diff…</div>
        ) : error ? (
          // WARDEN-1194 / WARDEN-89: a backend failure is NOT "no diff for this file at
          // this commit". That empty state is a confident factual assertion about the
          // user's data, and rendering it for a repository we could not read asserts
          // the opposite of the truth. Kept in-place and quiet at the popover's own
          // scale (it has no toast surface), visually distinct from the empty state,
          // `role="status"` so AT announces it. `fetched` is not set on this path, so
          // closing and re-opening the popover retries the fetch.
          <div className="px-1 text-[10px] text-muted-foreground" role="status">
            could not load diff — {error}
          </div>
        ) : (
          <>
            {message ? (
              <div className="mb-0.5 whitespace-pre-wrap break-words px-0.5 text-[10px] text-muted-foreground">{message}</div>
            ) : null}
            {diff ? (
              <DiffBlock diff={diff} />
            ) : (
              <div className="px-1 text-[10px] text-muted-foreground">no diff for this file at this commit</div>
            )}
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}

// The history view (WARDEN-319): the temporal counterpart to blame. One row per commit
// that touched this file (git log --follow -- <path>), newest first, each explorable
// to its per-file diff via the shared BlameHash popover AND to its full-file snapshot
// via the "view file at this commit" affordance (WARDEN-354). Where blame shows the
// LATEST commit per line (spatial), history shows the FULL commit sequence (temporal)
// — so a human never needs `git log -- <path>` in a terminal. Owns its own loading/
// error/empty states, mirroring AnnotatedContent's shape.
function HistoryContent({ commits, historyLoading, historyError, chatId, filePath, onViewAtCommit }: {
  commits: HistoryCommit[] | null;
  historyLoading: boolean;
  historyError: string | null;
  chatId: string;
  filePath: string;
  onViewAtCommit: (c: HistoryCommit) => void;
}) {
  const hasCommits = !!commits && commits.length > 0;

  return (
    <div className="text-sm">
      {historyLoading && (
        <div className="flex items-center gap-1.5 py-2 text-xs text-muted-foreground">
          <Loader2Icon className="w-3.5 h-3.5 animate-spin" />
          <span>Loading history…</span>
        </div>
      )}
      {!historyLoading && !historyError && !hasCommits && (
        <div className="py-2 text-xs text-muted-foreground">No git history for this file.</div>
      )}
      {!historyLoading && historyError && (
        <div className="flex items-center gap-1.5 py-2 text-xs text-red-400">
          <AlertCircleIcon className="w-3.5 h-3.5" />
          <span>{historyError}</span>
        </div>
      )}
      {!historyLoading && !historyError && hasCommits && (
        <div className="flex flex-col divide-y divide-border/40">
          {commits.map((c, i) => (
            <div key={`${c.hash}-${i}`} className="group/hcommit flex items-center gap-2 py-1.5">
              <BlameHash chatId={chatId} filePath={filePath} hash={c.hash} summary={c.subject} author={c.author} dateLabel={c.date} />
              <Button
                variant="ghost"
                size="xs"
                className="h-auto shrink-0 px-1 text-muted-foreground/60 opacity-60 hover:text-foreground group-hover/hcommit:opacity-100"
                title="view the full file as it existed at this commit"
                aria-label={`view full file at commit ${c.hash.slice(0, 8)}`}
                onClick={(e) => { e.stopPropagation(); onViewAtCommit(c); }}
              >
                <EyeIcon className="w-3.5 h-3.5" />
              </Button>
              <span className="min-w-0 flex-1 truncate text-foreground" title={c.subject}>{c.subject}</span>
              <span className="shrink-0 max-w-[8rem] truncate text-muted-foreground/70" title={c.author}>{c.author}</span>
              <span className="shrink-0 text-muted-foreground/60">{c.date}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// The Changes view (WARDEN-786): the open file's uncommitted working-tree diff vs
// HEAD, rendered via DiffBlock — the missing fourth file-understanding surface
// (History = what committed it, Annotate = who wrote each line, Follow = live
// state, Changes = what's uncommitted in *this* file). The fetch + loading/error
// state live in FileViewer (passed in here), mirroring AnnotatedContent /
// HistoryContent's presentational shape. classifyChangesView turns the response
// into the render decision (loading spinner / surfaced error / untracked new-file
// notice / clean empty-state / DiffBlock), so the honest-state discipline
// (WARDEN-89 / WARDEN-68) is enforced at the pure, unit-tested layer — a non-null
// `error` is never masked as a misleading "No uncommitted changes", a brand-new
// untracked file is surfaced as a change (never the clean empty-state), and a
// clean tracked file (null OR empty-string diff) never renders a blank diff box.
function ChangesContent({ diff, untracked, loading, error }: {
  diff: string | null;
  untracked: boolean;
  loading: boolean;
  error: string | null;
}) {
  const view = classifyChangesView({ diff, untracked, error }, loading);
  return (
    <div className="text-sm">
      {view.kind === 'loading' && (
        <div className="flex items-center gap-1.5 py-8 text-muted-foreground">
          <Loader2Icon className="w-4 h-4 animate-spin" />
          <span>Loading changes…</span>
        </div>
      )}
      {view.kind === 'error' && (
        <div className="flex items-center gap-2 py-8 text-red-400">
          <AlertCircleIcon className="w-4 h-4" />
          <span>{view.message}</span>
        </div>
      )}
      {view.kind === 'untracked' && (
        // A brand-new file not yet in git is 100% a change this view exists to
        // surface (agents create new files constantly). The endpoint returns
        // { diff: null, untracked: true } for one — git diff HEAD -- <untracked>
        // is empty, so there is no diff to render; surface it as its own state so
        // it is never mistaken for the "no uncommitted changes" clean empty-state
        // (the route's `untracked` flag exists exactly to let the UI say
        // "untracked" instead of "no changes" — src/gitRoutes.js getLocalGitDiff).
        <div className="flex items-center gap-2 py-8 text-muted-foreground">
          <FilePenIcon className="w-4 h-4 shrink-0" />
          <span>New file — not yet tracked (no committed history to diff against)</span>
        </div>
      )}
      {view.kind === 'clean' && (
        <div className="flex items-center justify-center py-8 text-muted-foreground">
          No uncommitted changes to this file
        </div>
      )}
      {view.kind === 'dirty' && (
        // DiffBlock handles whatever non-null diff string the endpoint returns.
        // (Untracked files never reach here in production — they pair with
        // diff:null and render the `untracked` branch above — but `view.untracked`
        // is carried defensively in case the contract ever changes.)
        <DiffBlock diff={view.diff} />
      )}
    </div>
  );
}

// The file's full content at a historical commit (WARDEN-354): the snapshot leg
// of the temporal trio (blame = per-line provenance, history = commit sequence +
// diff, this = full file state at a commit). Opened from HistoryContent's per-
// commit "view file at this commit" affordance; renders the blob with the
// FileViewer's EXISTING primitives — tokenizeCode + HighlightedLine for source,
// MarkdownBody for rendered markdown (honoring the shared viewMode) — so a
// historical file reads identically to the current one. The amber banner stamps
// which commit/version is on screen so the human never mistakes a snapshot for
// the working tree, with a back control to return to the commit list.
// Presentational: the fetch + per-hash cache (instant re-open, mirroring
// BlameHash's `fetched` flag) live in FileViewer and are passed in here.
function CommitBlobView({ commit, filePath, content, loading, error, viewMode, isMarkdown, onOpenPath, onBack }: {
  commit: HistoryCommit;
  filePath: string;
  content: string | null;
  loading: boolean;
  error: string | null;
  viewMode: 'rendered' | 'source';
  isMarkdown: boolean;
  // Forwarded to MarkdownBody so a relative link in a historical doc snapshot
  // also swaps the viewer (WARDEN-805). Undefined when no onNavigate is wired;
  // undefined after this snapshot's click navigates to the LIVE file and exits
  // the history view — consistent with how the breadcrumb already behaves here.
  onOpenPath?: (resolvedPath: string) => void;
  onBack: () => void;
}) {
  const shortHash = commit.hash.slice(0, 8);
  // Source highlighting for the snapshot, mirroring the plain view's useMemo so
  // the blob is tokenized once into per-line leaves (one DOM row per source line).
  const lang = useMemo(() => languageFromPath(filePath), [filePath]);
  const tokenLines = useMemo(
    () => (lang && content ? tokenizeCode(content, lang) : null),
    [content, lang],
  );

  return (
    <div className="text-sm">
      {/* orientation banner: makes clear this is a historical snapshot, not the
          working tree, with a back control to return to the commit list. */}
      <div className="mb-3 flex flex-wrap items-center gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-2.5 py-1.5 text-xs">
        <Button
          variant="ghost"
          size="xs"
          className="h-auto shrink-0 px-1 text-amber-300 hover:text-amber-200"
          onClick={onBack}
          title="Back to commit history"
        >
          ← Back
        </Button>
        <span className="shrink-0 font-mono text-amber-300/90">{shortHash}</span>
        <span className="min-w-0 flex-1 truncate text-foreground" title={commit.subject}>{commit.subject || '(no summary)'}</span>
        <span className="shrink-0 max-w-[8rem] truncate text-muted-foreground/70" title={commit.author}>{commit.author}</span>
        <span className="shrink-0 text-muted-foreground/60">{commit.date}</span>
      </div>
      <div className="mb-2 text-[11px] text-muted-foreground/70">
        Viewing <span className="font-mono text-foreground/80">{filePath}</span> as it existed at this commit
      </div>
      {loading && (
        <div className="flex items-center gap-1.5 py-8 text-muted-foreground">
          <Loader2Icon className="w-4 h-4 animate-spin" />
          <span>Loading file at commit…</span>
        </div>
      )}
      {!loading && error && (
        <div className="flex items-center gap-2 py-8 text-red-400">
          <AlertCircleIcon className="w-4 h-4" />
          <span>{error}</span>
        </div>
      )}
      {!loading && !error && content !== null && (
        isMarkdown && viewMode === 'rendered' ? (
          <div className="flex flex-col gap-2 text-sm leading-relaxed">
            <MarkdownBody baseFilePath={filePath} onOpenPath={onOpenPath}>
              {content}
            </MarkdownBody>
          </div>
        ) : (
          <pre className="text-sm font-mono whitespace-pre-wrap break-words">
            {tokenLines ? (
              tokenLines.map((line, i) => (
                <div key={i}><HighlightedLine leaves={line} /></div>
              ))
            ) : (
              content
            )}
          </pre>
        )
      )}
      {!loading && !error && content === null && (
        <div className="flex items-center justify-center py-8 text-muted-foreground">
          No content at this commit
        </div>
      )}
    </div>
  );
}

// The per-key UI half of a collapsible header-toolbar control (WARDEN-1019): its
// icon and its click handler. Paired with the pure `ToolbarAction` descriptor by
// `key`, so the inline row and the `⋯` overflow menu render the SAME action from
// ONE definition — a menu item and a button that can't drift apart.
type ToolbarActionMeta = {
  icon: ReactNode;
  onSelect: () => void;
  /** Icon-only on the inline row (the ↻ reload) — still labelled inside the menu. */
  iconOnly?: boolean;
  disabled?: boolean;
};

// One collapsible control as it renders ON the header row (>= `md`). Byte-for-byte
// the button that shipped before WARDEN-1019 — same variant/size/classes, same
// title, same aria-pressed — so the desktop toolbar is unchanged by the collapse.
function ToolbarActionButton({ action, meta }: { action: ToolbarAction; meta: ToolbarActionMeta }) {
  return (
    <Button
      type="button"
      variant={action.pressed ? 'default' : 'outline'}
      size="sm"
      className={meta.iconOnly ? 'h-7 w-7 shrink-0 p-0 text-xs' : 'h-7 shrink-0 gap-1.5 text-xs'}
      onClick={meta.onSelect}
      disabled={meta.disabled}
      title={action.title}
      // A toggle announces its state; a plain icon-only action needs a name instead.
      aria-pressed={action.pressed ?? undefined}
      aria-label={meta.iconOnly ? action.label : undefined}
    >
      {meta.icon}
      {!meta.iconOnly && action.label}
    </Button>
  );
}

// The `⋯` menu holding the toolbar controls that do not fit a narrow row
// (WARDEN-1019) — the toolbar analog of CollapsedCrumbs, so a collapse stays
// non-destructive: every collapsed control is still listed, still reachable, and
// still SHOWS its state.
//
// It is a real MENU, not a Popover of buttons (WARDEN-1028). Below `md` this is
// the SOLE path to History/Annotate/Reload/Follow (+ Rendered⇄Source on a
// markdown file), so the affordance it replaces must not be downgraded: Radix's
// DropdownMenu gives the content `role="menu"`, each row
// `role="menuitemcheckbox"` (or `role="menuitem"` for the one non-toggle),
// roving focus, arrow-key navigation, typeahead, and Escape-returns-focus —
// none of which a generic popover of N sequential tab stops has.
//
// The rows keep their explicit ON/OFF pill rather than the menu-standard "check
// mark when active" (hence `indicator={false}`): four of the five are toggles,
// and a check that simply vanishes when off reads as "this action is
// unavailable" instead of "this view is currently off". `aria-checked` — set by
// Radix from `checked` — carries the same fact to assistive tech.
//
// Rendered only below `md` (the caller passes `md:hidden`). Above it the controls
// are on the row and this trigger would be a second, redundant path to them.
function ToolbarOverflowMenu({ actions, metas, open, onOpenChange, className }: {
  actions: ToolbarAction[];
  metas: Record<ToolbarActionKey, ToolbarActionMeta>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  className?: string;
}) {
  const on = actions.filter((a) => a.pressed).map((a) => a.label);
  // Every one of these swaps what the viewer is SHOWING, so the menu must not
  // stay open over the result. Radix closes on select by default — this makes
  // the close explicit and orders it before the state change, matching the
  // behavior the Popover version shipped with. (Never `onSelect: preventDefault`
  // to keep a CheckboxItem open, which is the usual multi-toggle idiom.)
  const select = (meta: ToolbarActionMeta) => {
    onOpenChange(false);
    meta.onSelect();
  };
  return (
    // Non-modal, matching the Popover it replaces: this menu lives inside the
    // FileViewer's own modal Dialog, which already owns the outside-interaction
    // and scroll-lock contract.
    <DropdownMenu open={open} onOpenChange={onOpenChange} modal={false}>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className={`h-7 w-7 shrink-0 p-0 text-xs ${className ?? ''}`}
          // The summary rides in the tooltip/accessible name so the collapsed
          // state is legible WITHOUT opening the menu.
          title={on.length > 0 ? `More file actions (on: ${on.join(', ')})` : 'More file actions'}
          aria-label={on.length > 0 ? `More file actions, ${on.length} on` : 'More file actions'}
          onClick={(e) => e.stopPropagation()}
        >
          <EllipsisIcon className="h-3.5 w-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        sideOffset={4}
        className="w-56 p-1 text-xs"
        onClick={(e) => e.stopPropagation()}
      >
        {actions.map((a) => {
          const meta = metas[a.key];
          const body = (
            <>
              <span className="shrink-0 text-muted-foreground">{meta.icon}</span>
              <span className="truncate">{a.label}</span>
              {a.pressed !== null && (
                <Badge
                  variant={a.pressed ? 'default' : 'secondary'}
                  className="ml-auto uppercase"
                >
                  {a.pressed ? 'on' : 'off'}
                </Badge>
              )}
            </>
          );
          // `pressed: null` is the one plain action (↻ Reload file) — a
          // `menuitem`, not a `menuitemcheckbox`. It keeps its disabled +
          // spinner state while a manual reload is in flight; Radix keeps a
          // disabled item in the roving-focus ring via `aria-disabled`, which
          // is correct and deliberate.
          return a.pressed === null ? (
            <DropdownMenuItem
              key={a.key}
              title={a.title}
              disabled={meta.disabled}
              onSelect={() => select(meta)}
            >
              {body}
            </DropdownMenuItem>
          ) : (
            <DropdownMenuCheckboxItem
              key={a.key}
              title={a.title}
              checked={a.pressed}
              indicator={false}
              disabled={meta.disabled}
              onSelect={() => select(meta)}
            >
              {body}
            </DropdownMenuCheckboxItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// One clickable ancestor crumb in the FileViewer's path breadcrumb (WARDEN-740):
// a Popover trigger whose content lists that directory, so a human can browse a
// sibling/parent and open it in place.
//
// Extracted from the header in WARDEN-1006 because the run now renders crumbs in
// two groups (before and after the `…` overflow menu) — one component keeps both
// groups byte-identical instead of two drifting copies.
//
// A non-root crumb is `min-w-0 truncate`, NOT `shrink-0`: when the row is tight
// the label ellipsizes inside the crumb and stays a legible, clickable word,
// where a fixed-size crumb could only be sliced mid-glyph by the run's clip box.
// The root crumb is an icon, so it has nothing to truncate and stays `shrink-0`.
function PathCrumb({ crumb, chatId, open, onOpenChange, onPick }: {
  crumb: Crumb;
  chatId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPick: (path: string) => void;
}) {
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={`rounded px-1 py-0.5 text-sm text-muted-foreground hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset ${crumb.isRoot ? 'shrink-0' : 'min-w-0 truncate'}`}
          title={crumb.isRoot ? 'Browse repository root' : `Browse ${crumb.dir}`}
          onClick={(e) => e.stopPropagation()}
        >
          {crumb.isRoot ? <FolderIcon className="h-3.5 w-3.5" /> : crumb.label}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={4}
        className="w-64 p-1 text-xs"
        onClick={(e) => e.stopPropagation()}
      >
        <DirListing chatId={chatId} dir={crumb.dir} onPick={onPick} />
      </PopoverContent>
    </Popover>
  );
}

// The `…` overflow menu holding the crumbs a deep path collapsed out of the row
// (WARDEN-1006). This is what makes the collapse non-destructive: every hidden
// ancestor is still listed here and still opens its own directory listing, so
// the browse-an-ancestor capability the crumbs exist for survives at any depth —
// and the `…` itself is the on-screen affordance saying the path was collapsed.
//
// Two levels inside one Popover: the hidden ancestors, then (on pick) that dir's
// DirListing with a back link. The drill-in resets whenever the menu is not
// open — see the note on the reset below for why that has to key off `open`
// rather than off the dismiss callback — so it never reopens deep.
function CollapsedCrumbs({ crumbs, chatId, open, onOpenChange, onPick }: {
  crumbs: Crumb[];
  chatId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPick: (path: string) => void;
}) {
  const [browsing, setBrowsing] = useState<string | null>(null);
  const labels = crumbs.map((c) => c.label).join(' / ');
  // The drill-in resets on `open` itself, NOT in the dismiss callback. Radix
  // does not fire `onOpenChange` when a CONTROLLED `open` is flipped false by
  // the parent — and that is exactly what a successful pick does (`onPick` →
  // `setOpenCrumb(null)`), so a reset that hangs off the dismiss callback is
  // skipped on the one path that matters: after using the menu, it reopened
  // into the stale directory instead of the hidden ancestors. Depending on
  // `open` covers both close paths (dismiss and parent-controlled) with one
  // reset. `hiddenKey` is in the deps as well so navigating by a VISIBLE crumb,
  // which changes the hidden set without ever closing the menu, cannot leave a
  // dir behind that is no longer hidden either. Reopening therefore always
  // lands on level 1, which is the only level guaranteed to match `crumbs`.
  const hiddenKey = crumbs.map((c) => c.dir).join('\u0000');
  useEffect(() => { setBrowsing(null); }, [open, hiddenKey]);
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="shrink-0 rounded px-1 py-0.5 text-sm text-muted-foreground hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset"
          title={`Browse ${crumbs.length} hidden folders: ${labels}`}
          aria-label={`Show ${crumbs.length} hidden folders`}
          onClick={(e) => e.stopPropagation()}
        >
          …
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={4}
        className="w-64 p-1 text-xs"
        onClick={(e) => e.stopPropagation()}
      >
        {browsing === null ? (
          <div className="flex flex-col">
            <div className="px-1.5 py-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              Hidden folders
            </div>
            {crumbs.map((c) => (
              <button
                key={c.dir}
                type="button"
                title={`Browse ${c.dir}`}
                onClick={(e) => { e.stopPropagation(); setBrowsing(c.dir); }}
                className="flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-xs hover:bg-accent"
              >
                <FolderIcon className="h-3 w-3 shrink-0 text-muted-foreground" />
                <span className="truncate">{c.label}</span>
              </button>
            ))}
          </div>
        ) : (
          <div className="flex flex-col">
            <button
              type="button"
              title="Back to the hidden folders"
              onClick={(e) => { e.stopPropagation(); setBrowsing(null); }}
              className="flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-xs text-muted-foreground hover:bg-accent"
            >
              <ChevronLeftIcon className="h-3 w-3 shrink-0" />
              <span className="truncate">{browsing}</span>
            </button>
            <DirListing chatId={chatId} dir={browsing} onPick={onPick} />
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

// The `/` between two crumbs. Decorative only — the path is already announced by
// the crumb buttons' own labels, so it is aria-hidden.
function CrumbSeparator() {
  return <span className="shrink-0 text-muted-foreground/50" aria-hidden="true">/</span>;
}

// The directory listing shown inside a breadcrumb crumb's Popover (WARDEN-740).
// Fetches GET /api/git-ls?dir=<curDir> and renders one native <button> row per
// entry — a FILE row picks it (→ onPick → onNavigate → the file swaps in place,
// same bound chatId), a DIR row drills one level deeper (re-lists that subdir
// within the same popover, so a human can descend into a child directory without
// reopening). Mirrors FileBrowserDialog's fetch + honest-error contract: a
// transport error, a not-a-git-repo, or an unsafe dir surfaces its `error` field
// verbatim — never masked as "empty" (WARDEN-68 / AC5). Owns its loading/error/
// empty state exactly like AnnotatedContent / HistoryContent.
//
// Only mounted while its crumb's Popover is open (Radix unmounts PopoverContent
// when closed), so the fetch fires on open — not N times for N crumbs at viewer
// open. `curDir` starts at the anchor dir and follows drills; a sync effect keeps
// it tracking the `dir` prop should the crumb change identity while mounted.
function DirListing({ chatId, dir, onPick }: {
  chatId: string;
  dir: string;
  onPick: (path: string) => void;
}) {
  const [curDir, setCurDir] = useState(dir);
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Keep curDir in step with the anchor dir if the crumb's identity changes
  // while this listing happens to stay mounted (defensive — Radix normally
  // unmounts on close).
  useEffect(() => { setCurDir(dir); }, [dir]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    // WARDEN-1144: bounded — gates this listing's `loading`, cleared only by the
    // .finally below, which a promise that never settles never reaches.
    fetchBounded(`/api/git-ls?id=${encodeURIComponent(chatId)}&dir=${encodeURIComponent(curDir)}`)
      .then(async (r) => {
        // Tolerant on !ok (the status carries the message), STRICT on 2xx — a 2xx
        // body that fails to parse must reach the .catch below rather than becoming
        // a confident "empty directory" (WARDEN-1014). The `?? {}` is load-bearing:
        // readListBody resolves to `undefined` on the !ok leg, which the `!r.ok`
        // branch below dereferences.
        const data = ((await readListBody(r)) as { error?: string; entries?: Entry[] }) ?? {};
        if (cancelled) return;
        // /api/git-ls returns transport errors at HTTP 200 with an `error` field
        // (no-cwd / not-a-git-repo) and a 400 for an unsafe dir — check BOTH
        // res.ok and data.error, or a real error renders as "empty directory"
        // (same honest-error discipline as FileBrowserDialog / the grep dialog).
        if (!r.ok || data.error) { setError(data.error || 'ls failed'); setEntries([]); }
        else setEntries(Array.isArray(data.entries) ? data.entries : []);
      })
      .catch(() => { if (!cancelled) { setError('ls failed'); setEntries([]); } })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [chatId, curDir]);

  return (
    <div className="flex flex-col">
      {loading && (
        <div className="flex items-center gap-1.5 px-1.5 py-1 text-xs text-muted-foreground">
          <Loader2Icon className="h-3 w-3 animate-spin" />
          Loading…
        </div>
      )}
      {!loading && error && (
        <div className="flex items-center gap-1.5 px-1.5 py-1 text-xs text-red-400">
          <AlertCircleIcon className="h-3 w-3 shrink-0" />
          <span>{error}</span>
        </div>
      )}
      {!loading && !error && entries && entries.length === 0 && (
        <div className="px-1.5 py-1 text-xs italic text-muted-foreground">empty directory</div>
      )}
      {!loading && !error && entries && entries.length > 0 && (
        <ScrollArea className="max-h-60">
          {entries.map((e) => {
            const childPath = joinPath(curDir, e.name);
            return (
              <button
                key={childPath}
                type="button"
                title={e.type === 'dir' ? `Browse into ${childPath}` : `Open ${childPath}`}
                onClick={(e2) => {
                  e2.stopPropagation();
                  if (e.type === 'dir') setCurDir(childPath); // drill into the subdir (re-list)
                  else onPick(childPath); // pick the sibling file → navigate in place
                }}
                className="flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-xs hover:bg-accent"
              >
                {e.type === 'dir'
                  ? <FolderIcon className="h-3 w-3 shrink-0 text-muted-foreground" />
                  : <FileIcon className="h-3 w-3 shrink-0 text-muted-foreground" />}
                <span className="truncate">{e.name}</span>
              </button>
            );
          })}
        </ScrollArea>
      )}
    </div>
  );
}
