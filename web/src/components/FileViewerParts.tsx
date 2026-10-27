import { useState, useEffect, useMemo, useLayoutEffect, type ReactNode } from 'react';
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
import { DiffBlock } from './DiffBlock';
// Pure view-state helpers for the Changes view (WARDEN-786): the diff-response
// classifier (clean/empty vs dirty vs error vs loading) and the toolbar-toggle
// exclusivity resolver. Pure so both have unit coverage (fileViewerChanges.test.mjs).
import { classifyChangesView } from '@/lib/fileViewerChanges';
// Pure descriptor for the header toolbar's collapsible half (WARDEN-1019) — which
// controls collapse into the `⋯` menu below `md`, in what order, and with what
// pressed state. Unit-tested in fileViewerToolbar.test.mjs.
import {
  type ToolbarAction,
  type ToolbarActionKey,
} from '@/lib/fileViewerToolbar';
import { MarkdownBody } from './MarkdownBody';
import { tokenizeCode, languageFromPath, type Leaf } from '@/lib/highlight';
import { Loader2Icon, FileIcon, FolderIcon, AlertCircleIcon, EyeIcon, FilePenIcon, ChevronLeftIcon, EllipsisIcon } from 'lucide-react';
import { formatTimestamp, formatAbsoluteFull } from '@/lib/formatTimestamp';
import { useTimestampFormat } from '@/lib/uiStore';
// joinPath + the Entry shape are shared with FileBrowserDialog so a navigated
// sibling path is built identically to the browse dialog's selection.
import { joinPath, type Entry } from '@/lib/fileBrowserTree';
import { useStickToBottom } from '@/lib/useStickToBottom';
import { fetchBounded, readListBody } from '@/lib/api';
// The per-file git-diff READ seam (WARDEN-1187 / WARDEN-1194). BlameHash reads its
// popover diff through the DETAIL reader — the sibling that also keeps the commit
// body (`message`, WARDEN-388) off the same response — so this site honours both
// halves of warden's error convention instead of gating on `r.ok` alone.
import { readFileDiffDetail } from '@/lib/gitDiffApi';

// One row from /api/git-blame --line-porcelain. `date` is author-time as ISO 8601
// (the frontend formats it relative). `hash` is the full SHA — sliced for display,
// passed whole to /api/git-show on click so the commit resolves unambiguously.
export type BlameLine = { line: number; hash: string; author: string; date: string; summary: string };

// One row from /api/git-log with a `path` filter (file history, WARDEN-319). `date` is
// the relative %ar string straight from git ("2 days ago") — displayed VERBATIM, not
// re-relativized through formatTimestamp, matching the sibling git-log commit lists in
// ChatSidebar (the only other consumer of this route). `hash` is %h (abbreviated);
// git-show accepts abbreviated hashes, so it resolves unambiguously on click.
export type HistoryCommit = { hash: string; subject: string; author: string; date: string };

// One clickable ancestor in the path breadcrumb (WARDEN-740): `dir` is the
// cwd-relative directory /api/git-ls lists when the crumb is clicked, `label` is
// the segment name shown (empty for the root crumb, which renders a folder icon).
export type Crumb = { label: string; dir: string; isRoot: boolean };

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
export function StickRegion({ active, pinKey, children }: { active: boolean; pinKey: unknown; children: ReactNode }) {
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
export function HighlightedLine({ leaves }: { leaves: Leaf[] }) {
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
export function AnnotatedContent({ content, blame, blameLoading, blameError, chatId, filePath }: {
  content: string;
  blame: BlameLine[] | null;
  blameLoading: boolean;
  blameError: string | null;
  chatId: string;
  filePath: string;
}) {
  // WARDEN-1342 (slice 4): the blame author-dates honor the shared timestamp
  // pref — AnnotatedContent subscribes for itself instead of receiving the
  // value through FileViewer.
  const timestampFormat = useTimestampFormat();
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
export function HistoryContent({ commits, historyLoading, historyError, chatId, filePath, onViewAtCommit }: {
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
export function ChangesContent({ diff, untracked, loading, error }: {
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
export function CommitBlobView({ commit, filePath, content, loading, error, viewMode, isMarkdown, onOpenPath, onBack }: {
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
export type ToolbarActionMeta = {
  icon: ReactNode;
  onSelect: () => void;
  /** Icon-only on the inline row (the ↻ reload) — still labelled inside the menu. */
  iconOnly?: boolean;
  disabled?: boolean;
};

// One collapsible control as it renders ON the header row (>= `md`). Byte-for-byte
// the button that shipped before WARDEN-1019 — same variant/size/classes, same
// title, same aria-pressed — so the desktop toolbar is unchanged by the collapse.
export function ToolbarActionButton({ action, meta }: { action: ToolbarAction; meta: ToolbarActionMeta }) {
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
export function ToolbarOverflowMenu({ actions, metas, open, onOpenChange, className }: {
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
export function PathCrumb({ crumb, chatId, open, onOpenChange, onPick }: {
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
export function CollapsedCrumbs({ crumbs, chatId, open, onOpenChange, onPick }: {
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
export function CrumbSeparator() {
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
