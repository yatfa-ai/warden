import { Fragment, useState, useEffect, useCallback } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Loader2Icon,
  ChevronRightIcon,
  ChevronDownIcon,
  FolderIcon,
  FolderOpenIcon,
  FileIcon,
} from 'lucide-react';
// Pure tree logic (DirState/Entry/EMPTY_DIR/joinPath/applyToggle) lives in
// src/lib so it is unit-testable without a DOM — the WARDEN-573 subdir-expansion
// decision is asserted against the real function (see web/fileBrowser.test.mjs).
import { type DirState, EMPTY_DIR, joinPath, applyToggle } from '@/lib/fileBrowserTree';

interface Props {
  chatId: string;
  cwd?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  // WARDEN-573: hands the chosen file path (relative to cwd) to the parent so it
  // can open the EXISTING FileViewer — same contract as WorkspaceSearchDialog's
  // onSelectFile, minus the line (a browse has no line to scroll to).
  onSelectFile: (file: string) => void;
}

// Read-only directory browser (WARDEN-573) — the STRUCTURAL twin of
// WorkspaceSearchDialog: where that finds a file by CONTENT (grep), this finds
// it by POSITION (browse dirs → filenames) with no prior knowledge of either.
// Fetches GET /api/git-ls (git ls-files --exclude-standard, gitignored + cwd-
// contained) and renders a lazily expanded directory tree; clicking a file hands
// its path back to the parent to open the EXISTING FileViewer — no new editor.
// Built on the same shadcn Dialog/ScrollArea primitives as the grep dialog so it
// reads as one system. Rows are NATIVE <button>s (keyboard + screen-reader role
// for free), not <div onClick> — the WARDEN-68 affordance-vs-outcome rule.
export function FileBrowserDialog({ chatId, cwd, open, onOpenChange, onSelectFile }: Props) {
  const [tree, setTree] = useState<Record<string, DirState>>({});

  const fetchDir = useCallback(async (dir: string) => {
    setTree((t) => ({ ...t, [dir]: { ...(t[dir] || EMPTY_DIR), loading: true, error: null } }));
    try {
      const res = await fetch(`/api/git-ls?id=${encodeURIComponent(chatId)}&dir=${encodeURIComponent(dir)}`);
      const data = await res.json();
      // /api/git-ls returns transport errors at HTTP 200 with an `error` field
      // (no-cwd / not-a-git-repo), mirroring /api/git-status + /api/search-files
      // — so check data.error too, not just res.ok, or a real error renders as
      // "empty directory" (the same honest-error discipline as the grep dialog).
      setTree((t) => ({
        ...t,
        [dir]: {
          loaded: true,
          loading: false,
          error: !res.ok || data.error ? (data.error || 'ls failed') : null,
          entries: Array.isArray(data.entries) ? data.entries : [],
          expanded: true,
        },
      }));
    } catch {
      setTree((t) => ({ ...t, [dir]: { loaded: true, loading: false, error: 'ls failed', entries: [], expanded: true } }));
    }
  }, [chatId]);

  // Load the root listing on open; clear stale tree state on close so a reopen
  // reflects fresh repo contents. Mirrors the grep dialog's reset-on-open.
  useEffect(() => {
    if (!open) {
      setTree({});
      return;
    }
    // Seed root as expanded + loading so the first paint shows "Loading…" rather
    // than a flash of "empty" before fetchDir resolves.
    setTree({ '': { ...EMPTY_DIR, expanded: true, loading: true } });
    fetchDir('');
  }, [open, fetchDir]);

  const toggleDir = (dir: string) => {
    // Delegate to the pure applyToggle (exported + unit-tested) so the
    // seed-on-demand expansion decision — the WARDEN-573 fix — cannot regress.
    const { tree: nextTree, needsFetch } = applyToggle(tree, dir);
    setTree(nextTree);
    if (needsFetch) fetchDir(dir);
  };

  const handleSelect = (file: string) => {
    onSelectFile(file);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md" onOpenAutoFocus={(e) => e.preventDefault()}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FolderOpenIcon className="w-4 h-4" />
            Browse workspace files
          </DialogTitle>
          <DialogDescription>
            Directory tree in <span className="font-mono">{cwd || '.'}</span> — click a file to open it in the file viewer.
          </DialogDescription>
        </DialogHeader>

        {/* WARDEN-68: viewport-relative height matches the sibling dialogs'
            ScrollAreas (the grep dialog uses 40vh, FileViewer 60vh); a tree sits
            between, so 50vh flexes with the viewport instead of a fixed pixel.
            Layout here is statically reasoned from the flex/CSS spec, not
            browser-measured — the worker sandbox can't run visual QA (seccomp
            SIGTRAPs Chromium, WARDEN-130); the reviewer sandbox measures it. */}
        <ScrollArea className="h-[50vh] w-full rounded-md border">
          <div className="p-1">
            <DirChildren dir="" depth={0} tree={tree} onToggle={toggleDir} onSelectFile={handleSelect} />
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}

// Recursive directory listing. Renders one node's children (dirs are themselves
// expandable <DirChildren>; files select). Defined at MODULE scope so it does not
// remount on each parent render (a stable identity for the whole tree).
function DirChildren({
  dir,
  depth,
  tree,
  onToggle,
  onSelectFile,
}: {
  dir: string;
  depth: number;
  tree: Record<string, DirState>;
  onToggle: (dir: string) => void;
  onSelectFile: (file: string) => void;
}) {
  const node = tree[dir];
  if (!node || !node.expanded) return null;

  const indent = depth * 14 + 8;
  // First-load spinner (loading && not-yet-loaded). Subsequent re-loads show the
  // cached children; an empty/error node shows its message instead of a flash.
  if (node.loading && !node.loaded) {
    return (
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground py-1.5" style={{ paddingLeft: indent + 20 }}>
        <Loader2Icon className="w-3.5 h-3.5 animate-spin" />
        Loading…
      </div>
    );
  }
  if (node.error) {
    return <div className="text-xs text-destructive py-1.5" style={{ paddingLeft: indent + 20 }}>{node.error}</div>;
  }
  if (node.entries.length === 0) {
    return <div className="text-xs text-muted-foreground py-1.5 italic" style={{ paddingLeft: indent + 20 }}>empty</div>;
  }

  return (
    <>
      {node.entries.map((e) => {
        const childPath = joinPath(dir, e.name);
        if (e.type === 'dir') {
          const expanded = !!tree[childPath]?.expanded;
          return (
            <Fragment key={childPath}>
              <button
                type="button"
                onClick={() => onToggle(childPath)}
                className="flex items-center gap-1 w-full text-left py-1 pr-2 rounded hover:bg-accent transition-colors text-sm"
                style={{ paddingLeft: indent }}
                aria-expanded={expanded}
              >
                {expanded
                  ? <ChevronDownIcon className="w-3.5 h-3.5 shrink-0 text-muted-foreground" />
                  : <ChevronRightIcon className="w-3.5 h-3.5 shrink-0 text-muted-foreground" />}
                {expanded
                  ? <FolderOpenIcon className="w-3.5 h-3.5 shrink-0 text-muted-foreground" />
                  : <FolderIcon className="w-3.5 h-3.5 shrink-0 text-muted-foreground" />}
                <span className="truncate">{e.name}</span>
              </button>
              <DirChildren dir={childPath} depth={depth + 1} tree={tree} onToggle={onToggle} onSelectFile={onSelectFile} />
            </Fragment>
          );
        }
        return (
          <button
            key={childPath}
            type="button"
            onClick={() => onSelectFile(childPath)}
            className="flex items-center gap-1 w-full text-left py-1 pr-2 rounded hover:bg-accent transition-colors text-sm"
            // Indent files one chevron-width past their sibling dirs so the file
            // name aligns under the folder NAME (not the chevron).
            style={{ paddingLeft: indent + 18 }}
          >
            <FileIcon className="w-3.5 h-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate">{e.name}</span>
          </button>
        );
      })}
    </>
  );
}
