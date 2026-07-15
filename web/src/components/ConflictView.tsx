// Read-only ours-vs-theirs conflict view (WARDEN-428) — the conflict-CONTENT leg
// that completes WARDEN-186's conflict-STATE visibility (the red `!XY` badge).
//
// When an agent is stuck mid-merge/rebase/cherry-pick, clicking a conflicted file
// (UU/AA/UD/…) from the changed-files list opens THIS modal instead of the generic
// DiffViewer (`git diff --cached`, which for an unmerged path is not a usable
// ours/theirs view). It fetches /api/git-conflict — git's stage blobs `:2:` (ours /
// HEAD) and `:3:` (theirs / MERGE_HEAD) — and renders the two sides side-by-side,
// read-only, so a human can see what the conflict actually is without leaving Warden.
//
// Strictly a VIEW: no 3-way/base merge editor, no `git checkout --ours/--theirs`,
// no `git add` (the WARDEN-199 read-only line). Modeled on DiffViewer (the Dialog
// shell + loading/error/empty/ready states) and CollisionCompareDialog (a two-side
// compare with a header per side). Raw stage-blob content carries NO `+`/`-`
// markers, so the panes are a plain code view — an honest baseline, not a diff
// (classifyDiffLine would tag every line `context`; a computed ours-vs-theirs diff
// is an optional enhancement, out of scope here).
import { useState, useEffect } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogClose,
} from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Button } from '@/components/ui/button';
import { Loader2Icon, FileIcon, AlertCircleIcon, GitBranch } from 'lucide-react';

interface ConflictViewProps {
  chatId: string;
  filePath: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface ConflictData {
  ours: string | null;
  theirs: string | null;
  path: string;
  error: string | null;
}

export function ConflictView({ chatId, filePath, open, onOpenChange }: ConflictViewProps) {
  const [data, setData] = useState<ConflictData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setData(null);
      setError(null);
      return;
    }

    let cancelled = false;
    const fetchConflict = async () => {
      setLoading(true);
      setError(null);
      setData(null);
      try {
        const url = `/api/git-conflict?id=${encodeURIComponent(chatId)}&path=${encodeURIComponent(filePath)}`;
        const response = await fetch(url);
        if (!response.ok) {
          const j = await response.json().catch(() => ({}));
          if (!cancelled) setError(j.error || `Failed to load conflict: ${response.statusText}`);
          return;
        }
        const j: ConflictData = await response.json();
        if (cancelled) return;
        setData(j);
        // The backend returns 200 with a populated `error` for every soft failure
        // (oversize / binary / non-git / no-conflict-content) — surface it like
        // DiffViewer surfaces /api/git-diff's in-body `error`.
        if (j.error) setError(j.error);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load conflict');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    fetchConflict();
    return () => { cancelled = true; };
  }, [chatId, filePath, open]);

  const ours = data?.ours ?? null;
  const theirs = data?.theirs ?? null;
  // Both sides null with no error = the non-git-cwd soft-fail (or a closed/empty
  // state). Distinct from a real `error` so it renders as a muted note, not red.
  const bothEmpty = !loading && !error && ours === null && theirs === null;
  const ready = !loading && !error && !bothEmpty && (ours !== null || theirs !== null);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-5xl max-h-[85vh] flex flex-col">
        <DialogHeader className="shrink-0">
          <DialogTitle className="flex items-center gap-2">
            <FileIcon className="w-4 h-4 shrink-0" />
            <span className="truncate" title={filePath}>{filePath || 'conflict'}</span>
            <span className="shrink-0 rounded bg-red-500/15 px-1.5 py-px text-[10px] font-medium text-red-400" title="merge conflict — ours vs theirs (read-only)">
              conflict
            </span>
          </DialogTitle>
          <DialogDescription>
            The two conflicting sides from git's stage blobs — <strong>ours</strong> (HEAD) and <strong>theirs</strong> (MERGE_HEAD). Read-only; resolving is out of scope.
          </DialogDescription>
        </DialogHeader>

        <ScrollArea className="flex-1 min-h-0 rounded-md border bg-muted/50">
          <div className="p-3">
            {loading && (
              <div className="flex items-center justify-center gap-2 py-12 text-muted-foreground">
                <Loader2Icon className="w-5 h-5 animate-spin" />
                <span>Loading conflict…</span>
              </div>
            )}

            {error && (
              <div className="flex items-center gap-2 py-12 text-red-400">
                <AlertCircleIcon className="w-5 h-5 shrink-0" />
                <span className="break-words">{error}</span>
              </div>
            )}

            {!loading && !error && bothEmpty && (
              <div className="flex items-center justify-center py-12 text-muted-foreground">
                No conflict content for this file.
              </div>
            )}

            {ready && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <ConflictPane label="ours" sublabel="HEAD" content={ours} tone="cyan" />
                <ConflictPane label="theirs" sublabel="MERGE_HEAD" content={theirs} tone="amber" />
              </div>
            )}
          </div>
        </ScrollArea>

        <div className="shrink-0 pt-2">
          <DialogClose asChild>
            <Button variant="outline" className="w-full sm:w-auto">Close</Button>
          </DialogClose>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** One read-only side of the conflict: a labeled header over the stage-blob content.
 *  `content === null` means that side has no version of the file (modify/delete, or
 *  add/add where one side lacks it) — rendered as an explicit "absent" note so a
 *  missing side reads as a real signal, not a broken empty pane. Mirrors the
 *  per-panel empty/error vocabulary of CollisionCompareDialog's PanelBody. */
function ConflictPane({ label, sublabel, content, tone }: {
  label: string;
  sublabel: string;
  content: string | null;
  tone: 'cyan' | 'amber';
}) {
  const accent = tone === 'cyan' ? 'text-cyan-400/80' : 'text-amber-400/80';
  return (
    <section className="flex min-w-0 flex-col overflow-hidden rounded-md border border-border">
      <div className="flex shrink-0 items-center gap-1.5 border-b border-border bg-accent/30 px-2 py-1.5">
        <GitBranch className={`w-3.5 h-3.5 ${accent}`} />
        <span className="text-xs font-medium text-foreground">{label}</span>
        <span className="text-[10px] text-muted-foreground">· {sublabel}</span>
      </div>
      {content === null ? (
        <div className="flex items-center justify-center py-12 text-[11px] text-muted-foreground">
          absent — this side has no version of the file
        </div>
      ) : content.length === 0 ? (
        <div className="flex items-center justify-center py-12 text-[11px] text-muted-foreground">
          empty file
        </div>
      ) : (
        <pre className="overflow-auto p-2 text-sm font-mono whitespace-pre">
          {content.split('\n').map((line, i) => (
            <span key={i} className="block">{line || ' '}</span>
          ))}
        </pre>
      )}
    </section>
  );
}
