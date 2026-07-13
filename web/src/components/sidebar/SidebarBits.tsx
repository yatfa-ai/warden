// Small presentational sidebar helpers extracted from ChatSidebar.tsx
// (WARDEN-315). Pure structural move — no behavior change.

import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { ago } from '@/lib/chatDisplay';

// Subtle "updated Xs ago" affordance next to the sidebar ↻ button, signalling
// the agent list is live. Re-renders only itself each second (not the whole
// sidebar) so the relative time visibly advances between auto-refresh ticks.
export function UpdatedAgo({ at }: { at?: number | null }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);
  if (!at) return null;
  return <span className="text-[10px] text-muted-foreground tabular-nums">{ago(at)} ago</span>;
}

/**
 * A small expand/collapse section header — "▾/▸ label (count)" — that toggles a
 * collapsed summary group in the sidebar (hidden tabs, offline hosts).
 * Built on shadcn <Button> per WARDEN-68 (Rule 1 + Rule 2): no raw <button>, and
 * sizes come from the Tailwind scale (text-xs) rather than arbitrary literals.
 */
export function SectionToggle({ expanded, onClick, label, title }: {
  expanded: boolean;
  onClick: () => void;
  label: string;
  title?: string;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      onClick={onClick}
      title={title}
      className="justify-start gap-1 w-full h-auto px-2 pt-2 pb-1 text-xs font-normal uppercase tracking-wider text-muted-foreground/60"
    >
      <span aria-hidden="true">{expanded ? '▾' : '▸'}</span>
      <span className="flex-1 truncate text-left">{label}</span>
    </Button>
  );
}

/**
 * The contextual action bar for multi-select broadcast (WARDEN-292). Appears at
 * the foot of a fleet view only when ≥1 agent is selected, showing the live
 * count and the three selection actions: select-all (within the current visible
 * list), clear, and "Send to N…" (which opens the confirm-and-send dialog —
 * nothing is sent until the dialog's explicit Confirm). Built on shadcn <Button>
 * per the WARDEN-68 quality bar. shrink-0 so it stays pinned at the bottom while
 * the fleet list scrolls above it.
 */
export function BroadcastActionBar({ count, onSelectAll, onClear, onSend }: {
  count: number;
  onSelectAll: () => void;
  onClear: () => void;
  onSend: () => void;
}) {
  return (
    <div className="flex items-center gap-1.5 px-2 py-1.5 border-t shrink-0 bg-accent/40">
      <span className="text-xs text-muted-foreground whitespace-nowrap">{count} selected</span>
      <div className="ml-auto flex items-center gap-1">
        <Button variant="ghost" size="xs" onClick={onSelectAll} title="select every agent in this list">All</Button>
        <Button variant="ghost" size="xs" onClick={onClear} title="clear the selection">Clear</Button>
        <Button size="xs" onClick={onSend}>Send to {count}…</Button>
      </div>
    </div>
  );
}
