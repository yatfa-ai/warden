import { useState, useEffect } from 'react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import type { Collection, Chat } from '@/lib/types';

interface Props {
  chats: Chat[];
  onEnterCollection: (collection: Collection) => void;
  onCreateCollection: () => void;
}

export function CollectionsSection({ chats, onEnterCollection, onCreateCollection }: Props) {
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
        <button className="text-xs text-muted-foreground hover:text-foreground" onClick={fetchCollections} disabled={loading} title="refresh">{loading ? '…' : '↻'}</button>
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
                onClick={() => onEnterCollection(collection)}
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

function CollectionCard({ collection, agentCount, onClick }: { collection: Collection; agentCount: number; onClick: () => void }) {
  const color = collection.metadata?.color;
  const description = collection.metadata?.description;

  return (
    <button
      onClick={onClick}
      className="flex flex-col gap-0.5 px-2 py-1.5 rounded-md text-left text-xs hover:bg-accent w-full group"
    >
      <div className="flex items-center gap-2">
        <span
          className="w-2 h-2 rounded-full shrink-0"
          style={{ backgroundColor: color || '#6366f1' }}
        />
        <span className="truncate flex-1 font-medium">{collection.name}</span>
        <span className="text-[10px] text-muted-foreground">{agentCount}</span>
        <span className="text-muted-foreground/60 group-hover:text-foreground transition-colors">›</span>
      </div>
      {description && (
        <span className="text-[10px] text-muted-foreground truncate ml-4">{description}</span>
      )}
    </button>
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
