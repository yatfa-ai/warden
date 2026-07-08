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
import type { Collection } from '@/lib/types';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (collection: Collection) => void;
  existingCollections?: Collection[];
}

export function CreateCollectionDialog({ open, onOpenChange, onCreated, existingCollections = [] }: Props) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [role, setRole] = useState('');
  const [project, setProject] = useState('');
  const [host, setHost] = useState('');
  const [color, setColor] = useState('#6366f1');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  // Reset form when dialog opens
  useEffect(() => {
    if (open) {
      setName('');
      setDescription('');
      setRole('');
      setProject('');
      setHost('');
      setColor('#6366f1');
      setError('');
    }
  }, [open]);

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

    // Check for duplicate names
    if (existingCollections.some((c) => c.name === trimmedName)) {
      setError(`Collection "${trimmedName}" already exists`);
      return;
    }

    // Build criteria object
    const criteria: Collection['criteria'] = {};
    if (role.trim()) criteria.role = role.trim();
    if (project.trim()) criteria.project = project.trim();
    if (host.trim()) criteria.host = host.trim();

    // Build metadata object
    const metadata: Collection['metadata'] = {};
    if (description.trim()) metadata.description = description.trim();
    if (color.trim()) metadata.color = color.trim();

    setLoading(true);
    try {
      const r = await fetch('/api/collections', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: trimmedName, criteria, metadata }),
      });

      if (!r.ok) {
        const j = await r.json();
        setError(j.error || 'Failed to create collection');
        setLoading(false);
        return;
      }

      const j = await r.json();
      onCreated(j.collection);
      onOpenChange(false);
    } catch (err) {
      setError('Network error — please try again');
    }
    setLoading(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create Collection</DialogTitle>
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
              </div>
              <span className="text-[10px] text-muted-foreground">
                Leave all empty to include all agents. Agents must match ALL specified criteria.
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
              {loading ? 'Creating…' : 'Create'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
