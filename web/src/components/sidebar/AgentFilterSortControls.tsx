// Agent filter + sort popover extracted from ChatSidebar.tsx (WARDEN-315).
// Pure structural move — no behavior change.

import { SlidersHorizontal } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { FILTER_OPTIONS, SORT_OPTIONS, type AgentFilter, type AgentSort } from '@/lib/agentFilter';

// Filter + sort popover shared by the root, host, and collection view headers.
// Collapsing both controls behind a single icon keeps the header from
// overflowing at the default sidebar width (220px) — two inline selects did not
// fit.
export function AgentFilterSortControls({
  agentFilter,
  agentSort,
  onFilterChange,
  onSortChange,
  hideHostSort = false,
  hideSort = false,
}: {
  agentFilter: AgentFilter;
  agentSort: AgentSort;
  onFilterChange: (v: AgentFilter) => void;
  onSortChange: (v: AgentSort) => void;
  hideHostSort?: boolean;
  // WARDEN-949: the root list mirrors the pane grid and never runs sortChats,
  // so the root header offers filter only. Without this the sort Select was
  // reachable there and reordered nothing — and worse, picking a non-manual
  // sort tinted the trigger `active` as if it had, an affirmative false signal.
  hideSort?: boolean;
}) {
  // A hidden sort must not count toward the "something is in effect" tint.
  const active = agentFilter !== 'all' || (!hideSort && agentSort !== 'manual');
  const sortOptions = hideHostSort ? SORT_OPTIONS.filter((o) => o.value !== 'host') : SORT_OPTIONS;
  const label = hideSort ? 'filter' : 'filter & sort';
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon-xs"
          title={label}
          aria-label={label}
          className={active ? 'text-primary' : 'text-muted-foreground'}
        >
          <SlidersHorizontal />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-56 p-3">
        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-xs uppercase tracking-wider text-muted-foreground">filter</span>
            <Select value={agentFilter} onValueChange={(v) => onFilterChange(v as AgentFilter)}>
              <SelectTrigger className="h-7 w-full text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {FILTER_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          {!hideSort && (
            <label className="flex flex-col gap-1">
              <span className="text-xs uppercase tracking-wider text-muted-foreground">sort</span>
              <Select value={agentSort} onValueChange={(v) => onSortChange(v as AgentSort)}>
                <SelectTrigger className="h-7 w-full text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {sortOptions.map((o) => (
                    <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
