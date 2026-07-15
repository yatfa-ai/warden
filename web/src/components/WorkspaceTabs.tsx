import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Plus, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { copyText } from '@/lib/clipboard';
import { PANE_DRAG_MIME } from '@/lib/dnd';
import type { WorkspacePaneSet } from '@/lib/storage';

interface Props {
  workspaces: WorkspacePaneSet[];
  activeWorkspaceId: string | null;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onRename: (id: string, name: string) => void;
  onClose: (id: string) => void;
  // Drop a dragged pane onto an existing workspace tab → move it there.
  // The dropped pane id leads — matching movePaneToWorkspace(paneId, targetId)
  // and onDropPaneNew(paneId) — so the prop wires straight through with no
  // arg-order adapter (which is exactly what caused the prior swap bug).
  onDropPane: (paneId: string, workspaceId: string) => void;
  // Drop a dragged pane onto the ＋ button → new workspace containing it.
  onDropPaneNew: (paneId: string) => void;
  className?: string;
}

export function WorkspaceTabs({ workspaces, activeWorkspaceId, onSelect, onCreate, onRename, onClose, onDropPane, onDropPaneNew, className }: Props) {
  // Inline rename state. `editingId` is the workspace being renamed; `draft` is
  // the in-flight name (committed on Enter/blur, reverted on Escape).
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  // The workspace id (or 'new' for the ＋ button) currently under a dragged pane,
  // for the drop-target highlight. Cleared on drag leave / drop.
  const [dragOverId, setDragOverId] = useState<string | null>(null);

  // Focus the rename input when it appears (controlled via ref, not a DOM query
  // — WARDEN-68 Rule 4) and select-all so a fresh name is one keystroke away.
  useEffect(() => {
    if (editingId) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editingId]);

  const startRename = (ws: WorkspacePaneSet) => {
    setEditingId(ws.id);
    setDraft(ws.name);
  };
  const commitRename = () => {
    if (editingId !== null) onRename(editingId, draft);
    setEditingId(null);
  };
  const cancelRename = () => setEditingId(null);

  // Read the pane id from a drag payload, if any. Returns null when the drag did
  // not originate from a PaneTile (so a foreign drop is a no-op, never a move).
  const paneIdFrom = (e: React.DragEvent): string | null => {
    const id = e.dataTransfer.getData(PANE_DRAG_MIME);
    return id || null;
  };

  // Shared drop handlers: preventDefault on dragover is what makes a div a drop
  // target; the actual move fires on drop. The pane id is the only payload.
  const onChipDragOver = (e: React.DragEvent, id: string) => {
    if (!e.dataTransfer.types.includes(PANE_DRAG_MIME)) return;
    e.preventDefault();
    if (dragOverId !== id) setDragOverId(id);
  };
  const onChipDrop = (e: React.DragEvent, id: string) => {
    e.preventDefault();
    setDragOverId(null);
    const paneId = paneIdFrom(e);
    if (paneId) onDropPane(paneId, id);
  };
  const onNewDragOver = (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes(PANE_DRAG_MIME)) return;
    e.preventDefault();
    if (dragOverId !== 'new') setDragOverId('new');
  };
  const onNewDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOverId(null);
    const paneId = paneIdFrom(e);
    if (paneId) onDropPaneNew(paneId);
  };

  return (
    <div className={cn('flex items-center gap-1 h-full min-w-0 overflow-x-auto py-1', className)}>
      {workspaces.map((ws) => {
        const active = ws.id === activeWorkspaceId;
        const editing = editingId === ws.id;
        const over = dragOverId === ws.id;
        // Copy the tab name via the shared Electron-safe clipboard util — never
        // bare navigator.clipboard, which fails silently in Electron (see
        // ActivityTimeline.tsx for the rationale). Mirrors CollectionsSection.
        const handleCopyName = async () => {
          const ok = await copyText(ws.name);
          if (ok) toast.success('Copied'); else toast.error('Copy failed');
        };
        return (
          <ContextMenu key={ws.id}>
            <ContextMenuTrigger asChild disabled={editing}>
              {/*
                Structural chip container (the visual tab). The interactive
                affordances inside are real shadcn <Button>/<Input>; this div only
                groups them + serves as the drop target, so it carries role=tab.
                asChild merges the radix trigger onto this div (no extra wrapper),
                so the onDragOver/onDrop drop-target handlers and role=tab are
                preserved. disabled while renaming so a right-click inside the
                <Input> falls through to the native text-edit menu instead of this
                themed one (radix honors disabled on the trigger without disabling
                pointer events).
              */}
              <div
                role="tab"
                aria-selected={active}
                onDragOver={(e) => onChipDragOver(e, ws.id)}
                onDragLeave={() => { if (dragOverId === ws.id) setDragOverId(null); }}
                onDrop={(e) => onChipDrop(e, ws.id)}
                className={cn(
                  'group inline-flex items-center gap-0.5 rounded-md px-0.5 min-w-0 shrink-0 transition-colors',
                  active ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
                  over && 'ring-2 ring-primary ring-offset-1 ring-offset-background',
                )}
              >
                {editing ? (
                  <Input
                    ref={inputRef}
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onBlur={commitRename}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') { e.preventDefault(); commitRename(); }
                      else if (e.key === 'Escape') { e.preventDefault(); cancelRename(); }
                    }}
                    className="h-6 w-28 text-xs px-1.5"
                    aria-label={`Rename ${ws.name}`}
                  />
                ) : (
                  <Button
                    variant="ghost"
                    size="xs"
                    onClick={() => onSelect(ws.id)}
                    onDoubleClick={() => startRename(ws)}
                    className="max-w-40 min-w-0"
                    title={ws.name}
                  >
                    <span className="truncate">{ws.name}</span>
                  </Button>
                )}
                {/* Close: removed only when more than one workspace remains. Hidden
                    until hover/active so the strip stays calm; still keyboard-reachable. */}
                {!editing && workspaces.length > 1 && (
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    onClick={(e) => { e.stopPropagation(); onClose(ws.id); }}
                    className={cn('shrink-0', active ? 'opacity-70' : 'opacity-0 group-hover:opacity-70')}
                    title="Close workspace"
                    aria-label={`Close ${ws.name}`}
                  >
                    <X />
                  </Button>
                )}
              </div>
            </ContextMenuTrigger>
            <ContextMenuContent>
              {/* Surfaces the double-click-only rename affordance; no new logic. */}
              <ContextMenuItem onSelect={() => startRename(ws)}>Rename</ContextMenuItem>
              <ContextMenuItem onSelect={handleCopyName}>Copy name</ContextMenuItem>
              <ContextMenuSeparator />
              {/* Mirrors the in-component invariant that hides the X for a single
                  workspace: the menu must not offer to close the last workspace. */}
              <ContextMenuItem variant="destructive" disabled={workspaces.length <= 1} onSelect={() => onClose(ws.id)}>Close</ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        );
      })}
      <Button
        variant="ghost"
        size="icon-xs"
        onClick={onCreate}
        onDragOver={onNewDragOver}
        onDragLeave={() => { if (dragOverId === 'new') setDragOverId(null); }}
        onDrop={onNewDrop}
        className={cn('shrink-0', dragOverId === 'new' && 'ring-2 ring-primary ring-offset-1 ring-offset-background')}
        title="New workspace"
        aria-label="New workspace"
      >
        <Plus />
      </Button>
    </div>
  );
}
