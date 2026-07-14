import { useState, useEffect, useRef } from 'react';
import { toast } from 'sonner';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { IconTooltip } from '@/components/ui/icon-tooltip';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { copyText } from '@/lib/clipboard';
import type { Collection, Chat } from '@/lib/types';

interface Props {
  chats: Chat[];
  onEnterCollection: (collection: Collection) => void;
  onCreateCollection: () => void;
  // Notifies the sidebar host that a collection mutated so it can sync its own
  // derived state: refresh its duplicate-name list (CreateCollectionDialog) and,
  // on delete, reset the live view if the deleted collection was open. The
  // card list itself is refreshed inside CollectionsSection via fetchCollections.
  onCollectionChange?: (change: { type: 'rename' | 'delete'; id: string }) => void;
}

export function CollectionsSection({ chats, onEnterCollection, onCreateCollection, onCollectionChange }: Props) {
  const [collections, setCollections] = useState<Collection[]>([]);
  const [loading, setLoading] = useState(false);

  const fetchCollections = async () => {
    setLoading(true);
    try {
      const r = await fetch('/api/collections');
      const j = await r.json();
      setCollections(j.collections || []);
    } catch {
      setCollections([]);
    }
    setLoading(false);
  };

  useEffect(() => {
    fetchCollections();
  }, []);

  // Rename a collection via PATCH. Server trims + caps the name at 60 chars and
  // enforces uniqueness, returning 400 `Collection "X" already exists` on
  // conflict (src/collections.js:91-96). Returns the outcome so the card can
  // decide whether to close the inline editor or keep it open on conflict.
  const renameCollection = async (id: string, name: string): Promise<{ ok: boolean; error?: string }> => {
    try {
      const r = await fetch(`/api/collections/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => null);
        return { ok: false, error: (j && j.error) || 'Failed to rename collection' };
      }
      await fetchCollections();
      onCollectionChange?.({ type: 'rename', id });
      return { ok: true };
    } catch {
      return { ok: false, error: 'Network error — please try again' };
    }
  };

  // Delete a collection via DELETE. Only the saved criteria are removed — the
  // underlying chats are unaffected. Refreshes the card list + notifies the host.
  const deleteCollection = async (id: string): Promise<{ ok: boolean; error?: string }> => {
    try {
      const r = await fetch(`/api/collections/${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (!r.ok) {
        const j = await r.json().catch(() => null);
        return { ok: false, error: (j && j.error) || 'Failed to delete collection' };
      }
      await fetchCollections();
      onCollectionChange?.({ type: 'delete', id });
      return { ok: true };
    } catch {
      return { ok: false, error: 'Network error — please try again' };
    }
  };

  // Count agents matching each collection's criteria
  const collectionCounts = new Map<string, number>();
  for (const collection of collections) {
    const count = countAgentsInCollection(collection, chats);
    collectionCounts.set(collection.id, count);
  }

  return (
    <div className="mt-2 border-t border-border/50">
      <div className="flex items-center gap-2 px-2 py-2">
        <span className="text-xs text-muted-foreground flex-1">collections</span>
        <Badge variant="secondary" className="text-xs">{collections.length}</Badge>
        <IconTooltip label="refresh" disabled={loading}><button className="text-xs text-muted-foreground hover:text-foreground active:scale-95 transition-all duration-150 ease-out" onClick={fetchCollections} disabled={loading}>{loading ? '…' : '↻'}</button></IconTooltip>
        <Button size="sm" variant="ghost" className="h-5 text-xs px-2" onClick={onCreateCollection}>+</Button>
      </div>
      {collections.length > 0 ? (
        <ScrollArea className="max-h-48">
          <div className="px-1.5 flex flex-col gap-0.5">
            {collections.map((collection) => (
              <CollectionCard
                key={collection.id}
                collection={collection}
                agentCount={collectionCounts.get(collection.id) || 0}
                onOpen={() => onEnterCollection(collection)}
                onRename={renameCollection}
                onDelete={deleteCollection}
              />
            ))}
          </div>
        </ScrollArea>
      ) : (
        <div className="px-3 py-3 text-xs text-muted-foreground text-center">
          no collections — create one to organize agents
        </div>
      )}
    </div>
  );
}

function CollectionCard({ collection, agentCount, onOpen, onRename, onDelete }: {
  collection: Collection;
  agentCount: number;
  onOpen: () => void;
  onRename: (id: string, name: string) => Promise<{ ok: boolean; error?: string }>;
  onDelete: (id: string) => Promise<{ ok: boolean; error?: string }>;
}) {
  const color = collection.metadata?.color;
  const description = collection.metadata?.description;
  // Inline rename editor state — mirrors sidebar/ChatRows.tsx (editing/val +
  // startEdit/commit + the Input swap). Commit fires PATCH; on conflict the
  // editor stays open so the user can adjust, with the error surfaced via toast.
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(collection.name);
  const [confirmDelete, setConfirmDelete] = useState(false);
  // Guards the async commit against a double-fire (Enter then blur during the
  // PATCH round-trip would otherwise issue a second rename request).
  const committingRef = useRef(false);

  const startEdit = () => { setVal(collection.name); setEditing(true); };
  const commit = async () => {
    if (committingRef.current) return;
    const v = val.trim();
    if (!v || v === collection.name) { setEditing(false); return; }
    committingRef.current = true;
    const res = await onRename(collection.id, v);
    committingRef.current = false;
    if (res.ok) {
      setEditing(false);
    } else {
      // Conflict / network error — keep the editor open with the typed value
      // intact so the user can tweak it; surface the reason via toast.
      toast.error(res.error || 'Failed to rename collection');
    }
  };

  const handleCopy = async (text: string) => {
    const ok = await copyText(text);
    if (ok) toast.success('Copied');
    else toast.error('Copy failed');
  };

  const handleDelete = async () => {
    setConfirmDelete(false);
    const res = await onDelete(collection.id);
    if (res.ok) toast.success('Collection deleted');
    else toast.error(res.error || 'Failed to delete collection');
  };

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          {/*
            div role="button" (not a native <button>) so the inline rename
            <Input> can live inside it during editing — interactive content
            cannot be nested in a <button>. Mirrors sidebar/ChatRows.tsx rows.
          */}
          <div
            role="button"
            tabIndex={0}
            aria-label={`collection ${collection.name}`}
            onClick={() => { if (!editing) onOpen(); }}
            onKeyDown={(e) => { if (!editing && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onOpen(); } }}
            className="flex flex-col gap-0.5 px-2 py-1.5 rounded-md text-left text-xs hover:bg-accent active:bg-accent/80 w-full group transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            <div className="flex items-center gap-2">
              <span
                className="w-2 h-2 rounded-full shrink-0"
                style={{ backgroundColor: color || '#6366f1' }}
              />
              {editing ? (
                <Input
                  autoFocus
                  value={val}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => setVal(e.target.value)}
                  onBlur={commit}
                  onKeyDown={(e) => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') { setVal(collection.name); setEditing(false); } }}
                  maxLength={60}
                  className="h-5 text-[11px] px-1 flex-1"
                />
              ) : (
                <span className="truncate flex-1 font-medium">{collection.name}</span>
              )}
              {!editing && <span className="text-[10px] text-muted-foreground">{agentCount}</span>}
              {!editing && <span className="text-muted-foreground/60 group-hover:text-foreground transition-colors">›</span>}
            </div>
            {description && !editing && (
              <span className="text-[10px] text-muted-foreground truncate ml-4">{description}</span>
            )}
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onSelect={() => onOpen()}>Open</ContextMenuItem>
          <ContextMenuItem onSelect={startEdit}>Rename</ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={() => handleCopy(collection.name)}>Copy name</ContextMenuItem>
          <ContextMenuItem onSelect={() => handleCopy(JSON.stringify(collection.criteria ?? {}, null, 2))}>Copy criteria</ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem variant="destructive" onSelect={() => setConfirmDelete(true)}>Delete</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Delete "${collection.name}"?`}
        description="The saved criteria will be removed. Underlying chats are not affected."
        confirmLabel="Delete"
        destructive
        onConfirm={handleDelete}
      />
    </>
  );
}

// Count agents matching the collection's criteria
function countAgentsInCollection(collection: Collection, chats: Chat[]): number {
  if (!collection.criteria) return 0;

  const { criteria } = collection;
  let count = 0;

  for (const chat of chats) {
    let matches = true;

    // Role filter
    if (criteria.role && chat.role !== criteria.role) {
      matches = false;
    }

    // Project filter
    if (matches && criteria.project && chat.project !== criteria.project) {
      matches = false;
    }

    // Host filter
    if (matches && criteria.host && chat.host !== criteria.host) {
      matches = false;
    }

    // Custom filter (array of strings, chat must match at least one)
    if (matches && criteria.custom && Array.isArray(criteria.custom) && criteria.custom.length > 0) {
      const customMatch = criteria.custom.some((value) => {
        return (
          chat.role === value ||
          chat.project === value ||
          chat.host === value ||
          chat.name === value
        );
      });
      if (!customMatch) {
        matches = false;
      }
    }

    if (matches) count++;
  }

  return count;
}
