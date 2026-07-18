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
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { Loader2Icon, FileIcon, GitCompare, AlertCircleIcon, ChevronUp, ChevronDown } from 'lucide-react';
import { classifyDiffLine, DIFF_LINE_CLASS, collectChangeRegions } from '@/lib/diff';
import { copyText } from '@/lib/clipboard';
import { basename } from '@/lib/chatDisplay';
import { toast } from 'sonner';
import { DiffStatChip } from '@/components/sidebar/DiffStatChip';
import type { DiffStat } from '@/components/sidebar/types';

interface DiffViewerProps {
  chatId: string;
  filePath: string;
  // WARDEN-369: when true, fetch `git diff --cached` (index-vs-HEAD = exactly what
  // will be committed) instead of the combined worktree-vs-HEAD diff. Set when a
  // STAGED file in the dirty-file list is clicked. Single-file mode only.
  staged?: boolean;
  // WARDEN-398: aggregated range-diff mode. When set, fetch the net unified diff of
  // the agent's whole unpushed (outgoing) or incoming (incoming) set via
  // /api/git-range-diff instead of the single-file /api/git-diff. The modal is then
  // titled "Unpushed changes (↑N)" / "Incoming changes (↓N)" rather than a file path.
  // WARDEN-449: `worktree` adds the ± axis — the combined staged+unstaged change vs
  // HEAD (`git diff HEAD`), titled "Uncommitted changes" with the `+N −M` magnitude
  // chip inline (the SAME set WARDEN-411's --shortstat counts). `filePath` is ignored
  // in this mode. One renderer for all three — same classifyDiffLine coloring as every
  // other committed diff (the "no second renderer" intent).
  range?: 'outgoing' | 'incoming' | 'worktree';
  // The commit count for the title ("↑N"/"↓N") in range mode. Display-only. (Unused
  // for worktree, which surfaces magnitude via `diffstat` instead of a commit count.)
  count?: number;
  // WARDEN-449: the ± magnitude for the worktree title (`+N −M`). Reuses an in-scope
  // GitBranchBadge prop — no new data path. Display-only; the modal fetches its own
  // diff. Renders nothing when clean/unavailable (DiffStatChip's own guard).
  diffstat?: DiffStat | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function DiffViewer({ chatId, filePath, staged, range, count, diffstat, open, onOpenChange }: DiffViewerProps) {
  // Range mode fetches /api/git-range-diff (net diff of the whole unpushed/incoming/
  // worktree set); single-file mode fetches /api/git-diff for one working-tree file.
  const isRange = range === 'outgoing' || range === 'incoming' || range === 'worktree';
  const [diff, setDiff] = useState<string | null>(null);
  const [untracked, setUntracked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) {
      setDiff(null);
      setUntracked(false);
      setError(null);
      return;
    }

    let cancelled = false;
    const fetchDiff = async () => {
      setLoading(true);
      setError(null);
      setDiff(null);
      setUntracked(false);
      try {
        // range mode → /api/git-range-diff?id=&range= ; single-file → /api/git-diff?id=&path=
        const url = isRange
          ? `/api/git-range-diff?id=${encodeURIComponent(chatId)}&range=${range}`
          : `/api/git-diff?id=${encodeURIComponent(chatId)}&path=${encodeURIComponent(filePath)}${staged ? '&staged=1' : ''}`;
        const response = await fetch(url);

        if (!response.ok) {
          const data = await response.json();
          if (!cancelled) setError(data.error || `Failed to load diff: ${response.statusText}`);
          return;
        }

        const data = await response.json();
        if (cancelled) return;
        setDiff(data.diff ?? null);
        // untracked only applies to a single working-tree file; the range endpoint
        // returns no `untracked` field, so this is always false in range mode.
        setUntracked(!!data.untracked);
        if (data.error) setError(data.error);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load diff');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    fetchDiff();
    return () => { cancelled = true; };
  }, [chatId, filePath, staged, range, isRange, open]);

  // WARDEN-663: prev/next changed-region nav. The changed regions are the maximal
  // runs of added/removed lines (collectChangeRegions collapses each run to its
  // first line index). `lineRefs` holds one ref per rendered diff line so a region's
  // jump target can be scrolled into view; `currentRegion` is the index into
  // `regions` the indicator reflects. Recompute regions purely from the loaded diff
  // string (no fetch, no data-model change) and reset the cursor whenever the diff
  // changes so a freshly-opened modal always starts at the first region.
  const lineRefs = useRef<(HTMLSpanElement | null)[]>([]);
  const regions = useMemo(() => (diff ? collectChangeRegions(diff) : []), [diff]);
  const [currentRegion, setCurrentRegion] = useState(0);
  useEffect(() => { setCurrentRegion(0); }, [diff]);

  const jumpTo = (idx: number) => {
    if (idx < 0 || idx >= regions.length) return;
    setCurrentRegion(idx);
    const lineIdx = regions[idx];
    // rAF guarantees the per-line DOM is committed before we scroll, mirroring
    // FileViewer's scrollIntoView call inside the same Radix ScrollArea (WARDEN-227).
    requestAnimationFrame(() => {
      lineRefs.current[lineIdx]?.scrollIntoView({ block: 'center', behavior: 'auto' });
    });
  };

  const empty = !loading && !error && diff !== null && diff.length === 0;
  // WARDEN-663 / WARDEN-68 (no dead chrome): only mount the prev/next control when
  // a real diff with >= 2 changed regions is on screen — never during loading,
  // error, empty, or untracked states, and never for a single-region/no-region diff
  // (one change has nowhere to jump).
  const showNav = !loading && !error && !untracked && !empty && regions.length >= 2;
  // Range mode titles the modal by the change set; single-file mode by the path.
  // Worktree has no commit count — its magnitude is the `+N −M` chip rendered inline
  // next to the title below (the SAME `git diff HEAD` set the chip counts).
  const title = isRange
    ? (range === 'outgoing' ? `Unpushed changes (↑${count ?? 0})`
      : range === 'incoming' ? `Incoming changes (↓${count ?? 0})`
      : 'Uncommitted changes')
    : filePath;

  // Copy text to the clipboard through the shared Electron-safe helper, surfacing
  // the boolean result via toast — never bare navigator.clipboard, which rejects
  // silently in Electron (WARDEN-285). Matches FileViewer / CollectionsSection.
  const handleCopy = async (text: string) => {
    const ok = await copyText(text);
    if (ok) toast.success('Copied');
    else toast.error('Copy failed');
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <DialogContent className="max-w-4xl max-h-[80vh]">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                {isRange ? <GitCompare className="w-4 h-4 shrink-0" /> : <FileIcon className="w-4 h-4 shrink-0" />}
                <span className="truncate">{title}</span>
                {/* WARDEN-449: the ± magnitude chip inline next to the worktree title — the
                    same `+N −M` the GitBranchBadge tooltip shows, so the modal's magnitude
                    matches the dirty glyph's count. Renders nothing for a clean/all-untracked
                    tree (DiffStatChip's own guard), and nothing in the other range modes. */}
                {range === 'worktree' && (
                  <DiffStatChip diffstat={diffstat} className="text-[11px]" />
                )}
                {staged && !isRange && (
                  <span className="shrink-0 rounded bg-green-500/15 px-1.5 py-px text-[10px] font-medium text-green-400" title="staged-only diff — exactly what will be committed (git diff --cached)">
                    staged
                  </span>
                )}
              </DialogTitle>
            </DialogHeader>

            <div className="relative">
              <ScrollArea className="h-[60vh] w-full rounded-md border bg-muted/50">
                <div className="p-4">
                  {loading && (
                    <div className="flex items-center justify-center gap-2 py-8 text-muted-foreground">
                      <Loader2Icon className="w-5 h-5 animate-spin" />
                      <span>Loading diff...</span>
                    </div>
                  )}

                  {error && (
                    <div className="flex items-center gap-2 py-8 text-red-400">
                      <AlertCircleIcon className="w-5 h-5" />
                      <span>{error}</span>
                    </div>
                  )}

                  {!loading && !error && untracked && (
                    <div className="flex items-center justify-center py-8 text-muted-foreground">
                      Untracked file — no diff yet.
                    </div>
                  )}

                  {!loading && !error && empty && (
                    <div className="flex items-center justify-center py-8 text-muted-foreground">
                      {isRange
                        ? (range === 'worktree' ? 'No tracked changes vs HEAD.' : 'No net changes between the two tips.')
                        : 'No changes — file matches HEAD.'}
                    </div>
                  )}

                  {!loading && !error && diff !== null && diff.length > 0 && (
                    <pre className="text-sm font-mono whitespace-pre">
                      {diff.split('\n').map((line, i) => (
                        <span
                          key={i}
                          ref={(el) => { lineRefs.current[i] = el; }}
                          className={`block ${DIFF_LINE_CLASS[classifyDiffLine(line)]}`}
                        >
                          {line || ' '}
                        </span>
                      ))}
                    </pre>
                  )}
                </div>
              </ScrollArea>
              {/* WARDEN-663: on-screen prev/next changed-region nav (pointer-accessible
                  only — no hotkeys, per the standing prohibition). Clamps at the ends
                  (buttons disable rather than wrapping) so the indicator is an honest
                  position, and lives as a floating control over the ScrollArea so it
                  groups with the content it navigates. `showNav` already excludes the
                  loading/error/empty/untracked and <2-region cases (WARDEN-68). */}
              {showNav && (
                <div className="absolute right-3 top-3 z-10 flex items-center gap-1 rounded-md border bg-background/95 p-1 shadow-sm backdrop-blur">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="h-7 w-7"
                    disabled={currentRegion === 0}
                    onClick={() => jumpTo(currentRegion - 1)}
                    title="Previous change"
                    aria-label="Previous change"
                  >
                    <ChevronUp className="h-4 w-4" />
                  </Button>
                  <span
                    className="min-w-[3.5rem] text-center text-xs tabular-nums text-muted-foreground"
                    aria-label={`change ${currentRegion + 1} of ${regions.length}`}
                  >
                    {currentRegion + 1} / {regions.length}
                  </span>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="h-7 w-7"
                    disabled={currentRegion === regions.length - 1}
                    onClick={() => jumpTo(currentRegion + 1)}
                    title="Next change"
                    aria-label="Next change"
                  >
                    <ChevronDown className="h-4 w-4" />
                  </Button>
                </div>
              )}
            </div>

            <DialogClose asChild>
              <Button variant="outline" className="w-full sm:w-auto">Close</Button>
            </DialogClose>
          </DialogContent>
        </ContextMenuTrigger>
        <ContextMenuContent>
          {/* Copies the FULL path regardless of the header's truncation
              (DiffViewer.tsx span.truncate) — the most natural "copy path" target.
              Disabled in range mode (unpushed / incoming / worktree), where the modal
              title is a change-set label, not a single file path. */}
          <ContextMenuItem disabled={isRange} onSelect={() => handleCopy(filePath)}>Copy file path</ContextMenuItem>
          {/* Mirrors the "Copy name" vocabulary of the collection-card / workspace-tab siblings. */}
          <ContextMenuItem disabled={isRange} onSelect={() => handleCopy(basename(filePath))}>Copy filename</ContextMenuItem>
          {/* Copies the net unified diff on screen. Disabled while diff === null
              (loading / error / before fetch) so it can never silently copy nothing —
              a faithful mirror of FileViewer's displayedContent === null guard. */}
          <ContextMenuItem
            disabled={diff === null}
            onSelect={() => { if (diff !== null) handleCopy(diff); }}
          >
            Copy diff
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
