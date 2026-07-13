// Per-past-session tag chips + the tag-filter chip row (WARDEN-342).
//
// Tags are short reusable labels a human puts on a past Claude session so the ☁
// sessions list can be sliced by topic (e.g. #shipped, #needs-review). They are a
// LOCAL sidecar keyed by claude-session id (never written into Claude's transcripts)
// — the parent owns the {id → string[]} map + the PUT helper; these components are
// pure presentational surfaces over it:
//
//   · SessionTagChips   — rendered on each session row. Shows the session's tags as
//                          removable chips (inline ×) and a lightweight "+ tag"
//                          affordance that opens an inline input to add one.
//   · SessionTagFilterRow — rendered above the session list. Lists the distinct tags
//                          currently in use as toggle chips; selecting one or more
//                          scopes the list to sessions bearing any of them (union).
//
// The chips deliberately render as SIBLINGS of the resume <button> (see ChatSidebar),
// not nested inside it: nested interactive elements are invalid HTML and browsers
// misbehave (the same reason the project-filter chips use role=button spans elsewhere).

import { useState } from 'react';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

const MAX_TAG_LEN = 40; // mirror the backend per-tag cap (src/server.js)

// One chip is shared by both surfaces. `onClick` (when given) toggles/marks the
// chip as a filter target; `onRemove` (when given) renders the inline × and drops
// the tag from the session. They are independent: filter chips pass onClick only,
// per-row chips pass onRemove only.
function TagChip({ tag, active, onClick, onRemove }: {
  tag: string;
  active?: boolean;
  onClick?: () => void;
  onRemove?: () => void;
}) {
  // When onClick is present the chip itself is the button (filter toggle); when only
  // onRemove is present the chip is a static <span> and the × is the button.
  const cls = cn(
    'inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded-full border transition-all duration-150 active:scale-95',
    active
      ? 'bg-cyan-500/20 text-cyan-300 border-cyan-500/40'
      : 'bg-cyan-500/5 text-cyan-500/80 border-cyan-500/20 hover:bg-cyan-500/15 hover:text-cyan-400',
  );
  const label = <span className="truncate max-w-[120px]">#{tag}</span>;
  if (onClick) {
    return (
      <button type="button" onClick={onClick} className={cls} aria-pressed={active ? 'true' : 'false'} aria-label={`filter by ${tag}`}>
        {label}
      </button>
    );
  }
  return (
    <span className={cn(cls, 'bg-cyan-500/10 text-cyan-400 border-cyan-500/25')}>
      {label}
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          className="text-cyan-400/50 hover:text-red-400 -mr-0.5 ml-0.5 leading-none"
          aria-label={`remove tag ${tag}`}
        >
          ×
        </button>
      )}
    </span>
  );
}

/**
 * Per-row editable tag chips for a past Claude session. `tags` are the session's
 * current (already-cleaned) labels; `onAdd`/`onRemove` mutate the persisted map via
 * the parent's PUT helper. The "+ tag" affordance opens an inline Input (Enter or
 * blur commits, Escape cancels) — the same inline-edit pattern ChatRow uses for notes.
 *
 * When the session has no tags the line stays quiet (the "+" reveals on row hover
 * via `group-hover`) so an untagged 12-row list isn't drowned in repeated chrome.
 */
export function SessionTagChips({ tags, onAdd, onRemove }: {
  tags: string[];
  onAdd: (tag: string) => void;
  onRemove: (tag: string) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [val, setVal] = useState('');
  const commit = () => {
    setAdding(false);
    const v = val.trim().slice(0, MAX_TAG_LEN);
    setVal('');
    if (v) onAdd(v);
  };

  const addBtn = adding ? (
    <Input
      autoFocus
      value={val}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => setVal(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') { e.preventDefault(); commit(); }
        if (e.key === 'Escape') { setVal(''); setAdding(false); }
      }}
      placeholder="tag…"
      maxLength={MAX_TAG_LEN}
      className="h-4 w-20 text-[10px] px-1"
    />
  ) : (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); setAdding(true); }}
      // Reveal on row hover (group-hover) so an untagged list stays quiet, but keep
      // it visible once the row already has tags (the line is already there).
      className={cn(
        'shrink-0 text-[10px] px-1 py-0.5 rounded text-muted-foreground hover:text-foreground transition-all duration-150 active:scale-95',
        tags.length === 0 && 'opacity-0 group-hover:opacity-100 focus-within:opacity-100',
      )}
      aria-label="add tag"
    >
      + tag
    </button>
  );

  return (
    <div className="flex flex-wrap items-center gap-1" onClick={(e) => e.stopPropagation()}>
      {tags.map((t) => (
        <TagChip key={t} tag={t} onRemove={() => onRemove(t)} />
      ))}
      {addBtn}
    </div>
  );
}

/**
 * The tag-filter chip row, rendered above the ☁ sessions list. `tagsInUse` is the
 * distinct set of tags among the host's currently-loaded sessions (the parent
 * computes it, restricted to in-list session ids so orphans are hidden). Clicking a
 * chip toggles its membership in `active` (union semantics: a session matches if it
 * bears ANY active tag). Renders nothing when no tags are in use.
 */
export function SessionTagFilterRow({ tagsInUse, active, onToggle, onClear }: {
  tagsInUse: string[];
  active: Set<string>;
  onToggle: (tag: string) => void;
  onClear: () => void;
}) {
  if (tagsInUse.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1 px-2 pt-0.5 pb-1">
      {tagsInUse.map((t) => (
        <TagChip key={t} tag={t} active={active.has(t)} onClick={() => onToggle(t)} />
      ))}
      {active.size > 0 && (
        <button
          type="button"
          onClick={onClear}
          className="text-[10px] px-1 py-0.5 text-muted-foreground hover:text-foreground transition-colors"
          aria-label="clear tag filter"
        >
          clear
        </button>
      )}
    </div>
  );
}
