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
import { Loader2Icon, FileIcon, AlertCircleIcon, GitCommitHorizontalIcon, BookOpenIcon, Code2Icon } from 'lucide-react';
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
      setViewMode('rendered'); // start each markdown open rendered (avoid stale source mode)
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
                variant={annotate ? 'default' : 'outline'}
                size="sm"
                className="h-7 shrink-0 gap-1.5 text-xs"
                onClick={() => setAnnotate((a) => !a)}
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

            {!loading && !error && content !== null && !annotate && !hasLine && (
              isMarkdown && viewMode === 'rendered' ? (
                <div className="flex flex-col gap-2 text-sm leading-relaxed">
                  <MarkdownBody>{content}</MarkdownBody>
                </div>
              ) : (
                <pre className="text-sm font-mono whitespace-pre-wrap break-words">
                  {content}
                </pre>
              )
            )}

            {!loading && !error && content !== null && !annotate && hasLine && (
              <div className="text-sm font-mono">
                {content.split('\n').map((text, i) => {
                  const n = i + 1;
                  const isTarget = n === line;
                  return (
                    <div key={n} ref={isTarget ? highlightRef : undefined}
                      className={`flex ${isTarget ? 'bg-primary/20 ring-1 ring-inset ring-primary/40 rounded-sm' : ''}`}>
                      <span className="select-none pr-3 text-right text-muted-foreground/40 min-w-[2.5rem]">{n}</span>
                      <span className="whitespace-pre-wrap break-words flex-1">{text}</span>
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

            {!loading && !error && content === null && (
              <div className="flex items-center justify-center py-8 text-muted-foreground">
                No content
              </div>
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
                  <BlameHash chatId={chatId} filePath={filePath} blame={b} />
                  <span className="min-w-0 truncate text-cyan-300/60" title={b.author}>{b.author}</span>
                  <span className="ml-auto shrink-0 text-muted-foreground/60" title={b.date}>{timeAgo(b.date)}</span>
                </>
              ) : null}
            </div>
            <span className="flex-1 whitespace-pre-wrap break-words leading-5">{text || ' '}</span>
          </div>
        );
      })}
    </div>
  );
}

// A clickable blame hash. Opens a popover that fetches what that commit did to THIS
// file (the per-file `git show` diff, ?hash&path) and renders it via DiffBlock — the
// same committed-diff inspector as the sidebar's expanded commit (WARDEN-180). Owns
// its fetch state so a re-open is instant. Mirrors CommitFile's self-contained shape.
function BlameHash({ chatId, filePath, blame }: { chatId: string; filePath: string; blame: BlameLine }) {
  const [open, setOpen] = useState(false);
  const [diff, setDiff] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [fetched, setFetched] = useState(false);

  const handleOpenChange = async (next: boolean) => {
    setOpen(next);
    if (!next || fetched) return;
    setLoading(true);
    try {
      const r = await fetch(`/api/git-show?id=${encodeURIComponent(chatId)}&hash=${encodeURIComponent(blame.hash)}&path=${encodeURIComponent(filePath)}`);
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

  const shortHash = blame.hash.slice(0, 8);

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
            <span className="min-w-0 flex-1 truncate text-[10px] text-foreground" title={blame.summary}>{blame.summary || '(no summary)'}</span>
          </div>
          <div className="truncate text-[10px] text-muted-foreground">{blame.author}{blame.date ? ` · ${timeAgo(blame.date)}` : ''}</div>
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
