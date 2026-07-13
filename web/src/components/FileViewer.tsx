import { useState, useEffect, useMemo, useRef } from 'react';
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
import { DiffBlock } from './DiffBlock';
import { MarkdownBody } from './MarkdownBody';
import { tokenizeCode, languageFromPath, type Leaf } from '@/lib/highlight';
import { Loader2Icon, FileIcon, AlertCircleIcon, GitCommitHorizontalIcon, BookOpenIcon, Code2Icon, HistoryIcon, EyeIcon } from 'lucide-react';
import { timeAgo } from '@/lib/utils';

interface FileViewerProps {
  chatId: string;
  filePath: string;
  open: boolean;
  /** Optional 1-based line to scroll to and visually highlight (WARDEN-227: when
   *  opened by Ctrl/Cmd+clicking a `path:line` token in a live terminal pane). */
  line?: number;
  onOpenChange: (open: boolean) => void;
}

// One row from /api/git-blame --line-porcelain. `date` is author-time as ISO 8601
// (the frontend formats it relative). `hash` is the full SHA — sliced for display,
// passed whole to /api/git-show on click so the commit resolves unambiguously.
type BlameLine = { line: number; hash: string; author: string; date: string; summary: string };

// One row from /api/git-log with a `path` filter (file history, WARDEN-319). `date` is
// the relative %ar string straight from git ("2 days ago") — displayed VERBATIM, not
// re-relativized through timeAgo, matching the sibling git-log commit lists in
// ChatSidebar (the only other consumer of this route). `hash` is %h (abbreviated);
// git-show accepts abbreviated hashes, so it resolves unambiguously on click.
type HistoryCommit = { hash: string; subject: string; author: string; date: string };

export function FileViewer({ chatId, filePath, open, line, onOpenChange }: FileViewerProps) {
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // Ref on the highlighted line row so we can scroll it into view once content renders.
  const highlightRef = useRef<HTMLDivElement>(null);

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

  // Rendered ⇄ Source view mode for markdown files (WARDEN-266). Only the plain
  // view branch (!annotate && !hasLine) honors it; line-jump and blame views stay
  // source-based regardless. Defaults to rendered so opening a README shows docs.
  const [viewMode, setViewMode] = useState<'rendered' | 'source'>('rendered');

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
      setViewMode('rendered'); // start each markdown open rendered (avoid stale source mode)
      setViewAtCommit(null); // clear any at-commit snapshot (avoid stale blob for a prior file)
      setBlobContent(null);
      setBlobError(null);
      setBlobLoading(false);
      blobCache.current.clear();
      return;
    }

    const fetchFile = async () => {
      setLoading(true);
      setError(null);
      try {
        const response = await fetch('/api/read-file', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: chatId, path: filePath }),
        });

        if (!response.ok) {
          const data = await response.json();
          setError(data.error || `Failed to read file: ${response.statusText}`);
          return;
        }

        const data = await response.json();
        setContent(data.content);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to read file');
      } finally {
        setLoading(false);
      }
    };

    fetchFile();
  }, [chatId, filePath, open]);

  // Fetch blame only while annotating. Gates the success path on response.ok so a
  // 4xx/5xx (e.g. an unknown chat → 404) is surfaced as an error, not silent success
  // (WARDEN-89: a resolved fetch is not necessarily a success).
  useEffect(() => {
    if (!open || !annotate) return;
    let cancelled = false;
    const fetchBlame = async () => {
      setBlameLoading(true);
      setBlameError(null);
      try {
        const r = await fetch(`/api/git-blame?id=${encodeURIComponent(chatId)}&path=${encodeURIComponent(filePath)}`);
        if (!r.ok) {
          if (!cancelled) setBlameError(`Failed to load annotation (${r.status})`);
          return;
        }
        const j = await r.json();
        if (cancelled) return;
        setBlame(Array.isArray(j.lines) ? j.lines : []);
        setBlameError(j.error || null);
      } catch (e) {
        if (!cancelled) setBlameError(e instanceof Error ? e.message : 'Failed to load annotation');
      } finally {
        if (!cancelled) setBlameLoading(false);
      }
    };
    fetchBlame();
    return () => { cancelled = true; };
  }, [open, annotate, chatId, filePath]);

  // Fetch the file's commit history only while in history view-mode. Mirrors the blame
  // fetch above: gates the success path on response.ok so a 4xx/5xx (e.g. unknown chat
  // → 404) surfaces as an error, not silent success (WARDEN-89). The `path` query
  // flips /api/git-log into file-history mode (git log --follow -- <path>), so this
  // lists every commit that touched the open file, across renames.
  useEffect(() => {
    if (!open || !history) return;
    let cancelled = false;
    const fetchHistory = async () => {
      setHistoryLoading(true);
      setHistoryError(null);
      try {
        const r = await fetch(`/api/git-log?id=${encodeURIComponent(chatId)}&path=${encodeURIComponent(filePath)}&limit=20`);
        if (!r.ok) {
          if (!cancelled) setHistoryError(`Failed to load history (${r.status})`);
          return;
        }
        const j = await r.json();
        if (cancelled) return;
        setCommits(Array.isArray(j.commits) ? j.commits : []);
        setHistoryError(j.error || null);
      } catch (e) {
        if (!cancelled) setHistoryError(e instanceof Error ? e.message : 'Failed to load history');
      } finally {
        if (!cancelled) setHistoryLoading(false);
      }
    };
    fetchHistory();
    return () => { cancelled = true; };
  }, [open, history, chatId, filePath]);

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
        const r = await fetch(`/api/git-cat-file?id=${encodeURIComponent(chatId)}&hash=${encodeURIComponent(viewAtCommit.hash)}&path=${encodeURIComponent(filePath)}`);
        const j = await r.json().catch(() => ({}));
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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[80vh]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 pr-8">
            <FileIcon className="w-4 h-4 shrink-0" />
            <span className="truncate">{filePath}</span>
            <div className="ml-auto flex items-center gap-2">
              {isMarkdown && (
                <Button
                  type="button"
                  variant={viewMode === 'rendered' ? 'default' : 'outline'}
                  size="sm"
                  className="h-7 shrink-0 gap-1.5 text-xs"
                  onClick={() => setViewMode((m) => (m === 'rendered' ? 'source' : 'rendered'))}
                  title={viewMode === 'rendered' ? 'Show raw markdown source' : 'Show rendered documentation'}
                  aria-pressed={viewMode === 'rendered'}
                >
                  {viewMode === 'rendered' ? (
                    <BookOpenIcon className="w-3.5 h-3.5" />
                  ) : (
                    <Code2Icon className="w-3.5 h-3.5" />
                  )}
                  {viewMode === 'rendered' ? 'Rendered' : 'Source'}
                </Button>
              )}
              <Button
                type="button"
                variant={history ? 'default' : 'outline'}
                size="sm"
                className="h-7 shrink-0 gap-1.5 text-xs"
                onClick={() => {
                  setHistory((h) => {
                    const next = !h;
                    if (next) setAnnotate(false); // history + annotate are exclusive view modes
                    else setViewAtCommit(null); // leaving history → drop any at-commit snapshot
                    return next;
                  });
                }}
                title={history ? 'Hide file commit history' : 'Show commit history for this file (every commit that touched it, across renames)'}
                aria-pressed={history}
              >
                <HistoryIcon className="w-3.5 h-3.5" />
                History
              </Button>
              <Button
                type="button"
                variant={annotate ? 'default' : 'outline'}
                size="sm"
                className="h-7 shrink-0 gap-1.5 text-xs"
                onClick={() => {
                  setAnnotate((a) => {
                    const next = !a;
                    if (next) { setHistory(false); setViewAtCommit(null); } // annotate forces history off → drop any snapshot
                    return next;
                  });
                }}
                title={annotate ? 'Hide per-line git blame' : 'Show per-line git blame (which commit last touched each line)'}
                aria-pressed={annotate}
              >
                <GitCommitHorizontalIcon className="w-3.5 h-3.5" />
                Annotate
              </Button>
            </div>
          </DialogTitle>
        </DialogHeader>

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
                onBack={() => setViewAtCommit(null)}
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
                  <MarkdownBody>{content}</MarkdownBody>
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

        <DialogClose asChild>
          <Button variant="outline" className="w-full sm:w-auto">Close</Button>
        </DialogClose>
      </DialogContent>
    </Dialog>
  );
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
function AnnotatedContent({ content, blame, blameLoading, blameError, chatId, filePath }: {
  content: string;
  blame: BlameLine[] | null;
  blameLoading: boolean;
  blameError: string | null;
  chatId: string;
  filePath: string;
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
                  <BlameHash chatId={chatId} filePath={filePath} hash={b.hash} summary={b.summary} author={b.author} dateLabel={timeAgo(b.date)} />
                  <span className="min-w-0 truncate text-cyan-300/60" title={b.author}>{b.author}</span>
                  <span className="ml-auto shrink-0 text-muted-foreground/60" title={b.date}>{timeAgo(b.date)}</span>
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
// (caller passes timeAgo(iso)), history has git's relative %ar text (caller passes it
// verbatim). Either way the popover just stamps it next to the author.
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
  const [loading, setLoading] = useState(false);
  const [fetched, setFetched] = useState(false);

  const handleOpenChange = async (next: boolean) => {
    setOpen(next);
    if (!next || fetched) return;
    setLoading(true);
    try {
      const r = await fetch(`/api/git-show?id=${encodeURIComponent(chatId)}&hash=${encodeURIComponent(hash)}&path=${encodeURIComponent(filePath)}`);
      if (!r.ok) { setDiff(null); return; }
      const j = await r.json();
      setDiff(typeof j.diff === 'string' ? j.diff : null);
    } catch {
      setDiff(null);
    } finally {
      setLoading(false);
      setFetched(true);
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
        ) : diff ? (
          <DiffBlock diff={diff} />
        ) : (
          <div className="px-1 text-[10px] text-muted-foreground">no diff for this file at this commit</div>
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
function CommitBlobView({ commit, filePath, content, loading, error, viewMode, isMarkdown, onBack }: {
  commit: HistoryCommit;
  filePath: string;
  content: string | null;
  loading: boolean;
  error: string | null;
  viewMode: 'rendered' | 'source';
  isMarkdown: boolean;
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
            <MarkdownBody>{content}</MarkdownBody>
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
