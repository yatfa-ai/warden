import { useState, useEffect } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { parseCustomCriteria } from '@/lib/collections';
import type { Collection } from '@/lib/types';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  // Create mode
  onCreated?: (collection: Collection) => void;
  existingCollections?: Collection[];
  // Edit mode — pass `collection` to open the dialog pre-filled for editing that
  // collection (WARDEN-553). When set, submit PATCHes /api/collections/:id and
  // calls onSaved instead of POSTing + onCreated; the duplicate-name guard skips
  // the collection's own id so an unchanged name doesn't self-collide.
  collection?: Collection | null;
  onSaved?: (collection: Collection) => void;
}

export function CreateCollectionDialog({
  open,
  onOpenChange,
  onCreated,
  existingCollections = [],
  collection = null,
  onSaved,
}: Props) {
  const isEditing = !!collection;
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [role, setRole] = useState('');
  const [project, setProject] = useState('');
  const [host, setHost] = useState('');
  const [custom, setCustom] = useState('');
  const [color, setColor] = useState('#6366f1');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  // Reset/populate the form when the dialog opens. In edit mode, prefill from the
  // target collection (criteria.custom joins back to comma text); in create mode,
  // start blank. Re-runs when `collection` changes so opening Edit on a different
  // card repopulates correctly while the dialog is already mounted.
  useEffect(() => {
    if (!open) return;
    if (collection) {
      setName(collection.name);
      setDescription(collection.metadata?.description ?? '');
      setRole(collection.criteria?.role ?? '');
      setProject(collection.criteria?.project ?? '');
      setHost(collection.criteria?.host ?? '');
      setCustom((collection.criteria?.custom ?? []).join(', '));
      setColor(collection.metadata?.color ?? '#6366f1');
    } else {
      setName('');
      setDescription('');
      setRole('');
      setProject('');
      setHost('');
      setCustom('');
      setColor('#6366f1');
    }
    setError('');
  }, [open, collection]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    const trimmedName = name.trim();
    if (!trimmedName) {
      setError('Collection name is required');
      return;
    }

    if (trimmedName.length > 60) {
      setError('Name must be 60 characters or less');
      return;
    }

    // Check for duplicate names. In edit mode, skip this collection's own id —
    // otherwise saving an unchanged (or same-named) collection self-collides.
    const ownId = collection?.id ?? null;
    if (existingCollections.some((c) => c.name === trimmedName && c.id !== ownId)) {
      setError(`Collection "${trimmedName}" already exists`);
      return;
    }

    // Build criteria object — custom is parsed from comma text into a clean
    // string[] (split + trim + drop-empty + dedupe); an empty result is omitted
    // so the key round-trips to "no custom constraint".
    const customValues = parseCustomCriteria(custom);
    const criteria: Collection['criteria'] = {};
    if (role.trim()) criteria.role = role.trim();
    if (project.trim()) criteria.project = project.trim();
    if (host.trim()) criteria.host = host.trim();
    if (customValues.length > 0) criteria.custom = customValues;

    // Build metadata object
    const metadata: Collection['metadata'] = {};
    if (description.trim()) metadata.description = description.trim();
    if (color.trim()) metadata.color = color.trim();

    setLoading(true);
    try {
      const r = isEditing
        ? await fetch(`/api/collections/${encodeURIComponent(collection!.id)}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            // PATCH spreads updates over the stored collection, so sending the
            // full criteria + metadata replaces them wholesale (the intended
            // edit semantics). The server route passes req.body through with no
            // allow-list (src/server.js ~line 470).
            body: JSON.stringify({ name: trimmedName, criteria, metadata }),
          })
        : await fetch('/api/collections', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: trimmedName, criteria, metadata }),
          });

      if (!r.ok) {
        const j = await r.json();
        setError(j.error || (isEditing ? 'Failed to save collection' : 'Failed to create collection'));
        setLoading(false);
        return;
      }

      const j = await r.json();
      if (isEditing) onSaved?.(j.collection);
      else onCreated?.(j.collection);
      onOpenChange(false);
    } catch {
      setError('Network error — please try again');
    }
    setLoading(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{isEditing ? 'Edit Collection' : 'Create Collection'}</DialogTitle>
          <DialogDescription>
            Organize agents into a persistent group based on role, project, host, or custom criteria.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit}>
          <div className="flex flex-col gap-4 py-4">
            {/* Name */}
            <div className="flex flex-col gap-2">
              <Label htmlFor="name">Name</Label>
              <Input
                id="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g., Warden Workers"
                maxLength={60}
                required
              />
              <span className="text-[10px] text-muted-foreground">{name.length}/60</span>
            </div>

            {/* Description (optional) */}
            <div className="flex flex-col gap-2">
              <Label htmlFor="description">Description (optional)</Label>
              <Input
                id="description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="e.g., All worker agents in the warden project"
                maxLength={200}
              />
            </div>

            {/* Criteria */}
            <div className="flex flex-col gap-2">
              <Label>Filter Criteria (optional)</Label>
              <div className="flex flex-col gap-2">
                <Input
                  value={role}
                  onChange={(e) => setRole(e.target.value)}
                  placeholder="Role (e.g., worker, reviewer)"
                />
                <Input
                  value={project}
                  onChange={(e) => setProject(e.target.value)}
                  placeholder="Project (e.g., warden, tinker)"
                />
                <Input
                  value={host}
                  onChange={(e) => setHost(e.target.value)}
                  placeholder="Host (e.g., server1, (local))"
                />
                {/*
                  Custom criteria (WARDEN-553): the writable half of the grouping
                  the dialog's description advertises. A chat matches if ANY
                  custom value equals its role, project, host, OR name (OR within
                  custom; AND across role/project/host/custom). Comma-separated
                  text → string[] on submit (parseCustomCriteria splits, trims,
                  drops empties, dedupes).
                */}
                <Input
                  value={custom}
                  onChange={(e) => setCustom(e.target.value)}
                  placeholder="Custom (e.g., warden, server1, My Agent)"
                />
              </div>
              <span className="text-[10px] text-muted-foreground">
                Leave all empty to include all agents. Agents must match ALL specified criteria. Custom matches if any value equals an agent's role, project, host, or name.
              </span>
            </div>

            {/* Color */}
            <div className="flex flex-col gap-2">
              <Label htmlFor="color">Color</Label>
              <div className="flex items-center gap-2">
                <Input
                  id="color"
                  type="color"
                  value={color}
                  onChange={(e) => setColor(e.target.value)}
                  className="w-12 h-8 p-0 border-0"
                />
                <Input
                  value={color}
                  onChange={(e) => setColor(e.target.value)}
                  placeholder="#6366f1"
                  className="flex-1"
                />
              </div>
            </div>

            {/* Error */}
            {error && (
              <div className="text-xs text-red-500 bg-red-500/10 border border-red-500/30 rounded-md px-2 py-1.5">
                {error}
              </div>
            )}
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={loading || !name.trim()}>
              {loading ? (isEditing ? 'Saving…' : 'Creating…') : isEditing ? 'Save' : 'Create'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
