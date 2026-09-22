// Saved-session rows for the rebuilt sidebar (WARDEN-1422 — "Ink · Saved").
//
// The sidebar lists ONLY sessions you named and saved (warden catalog chats +
// auto-discovered yatfa agents). A saved row is an Ink row: an identity chip,
// the name ALONE on line one, metadata (relative time · directory; the host
// joins in cross-host views) on line two — metadata never competes with the
// name. Names wrap (`wrap-anywhere`) and are never clamped or ellipsised: a
// long name reflows the row instead of tearing it.
//
// The two dots ARE the classification (working = solid green — a live tmux
// session a click reconnects to; stopped = hollow ring — nothing is running,
// respawn starts a fresh process under the same identity). There is no badge
// cluster: delete sits at rest on every row, respawn sits at rest on stopped
// rows (it is the point of the row), rename and note join on hover. Agent-owned
// rows carry the `agent` tag and are NOT renameable (the agent owns the name).
//
// Right-click menus keep the context-menu capabilities that predate the rebuild
// (copy session id / cwd, kill); the static exhibit could not represent them.

import { useState } from 'react';
import { Pencil, StickyNote, Trash2, RotateCw } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from '@/components/ui/context-menu';
import { IconTooltip } from '@/components/ui/icon-tooltip';
import { StatusDot } from '@/components/StatusDot';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { copyWithToast } from '@/lib/clipboardToast';
import { formatTimestamp, formatAbsoluteFull } from '@/lib/formatTimestamp';
import { useTimestampFormat } from '@/lib/uiStore';
import type { Chat } from '@/lib/types';

// Deterministic identity-chip hue: the same string always paints the same chip,
// so a session keeps its colour across reloads and hosts (the exhibit's hash —
// the chip is decoration, not data; it only needs to be STABLE and distinct
// next to its neighbours).
export function hueOf(name: string): number {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}

// Substring match split for search highlighting: [pre][hit][post], case-
// insensitive, first occurrence only. Null when the text does not match (the
// caller renders it plain). Empty query → null (nothing is highlighted).
export interface MatchParts { pre: string; hit: string; post: string }
export function matchHighlight(text: string, query: string): MatchParts | null {
  const q = query.trim().toLowerCase();
  if (!q) return null;
  const idx = text.toLowerCase().indexOf(q);
  if (idx < 0) return null;
  return { pre: text.slice(0, idx), hit: text.slice(idx, idx + q.length), post: text.slice(idx + q.length) };
}

// The saved view's whole classification: working (live tmux — click reconnects)
// vs stopped (hollow — respawn recreates). `active === false` is the ONLY
// stopped signal; `active === true` is working; `active == null` (undiscovered,
// the lazy-mode disk answer) renders as working with a muted dot — the host
// view triggers discovery on mount, so null is a transient state, and a dead
// session that clicks through to the recovery panel is a softer failure than
// hiding a session the host HAS.
export function splitSaved(chats: Chat[]): { working: Chat[]; stopped: Chat[] } {
  return {
    working: chats.filter((c) => c.active !== false),
    stopped: chats.filter((c) => c.active === false),
  };
}

// Row ordering: most recently active first (the exhibit's 12s / 3m / 6m …
// reading order). A chat with no lastActivity sinks below one that has one;
// ties break by name so the order is stable across re-renders.
export function byRecencyDesc(a: Chat, b: Chat): number {
  const at = a.lastActivity ?? 0;
  const bt = b.lastActivity ?? 0;
  if (at !== bt) return bt - at;
  return (a.name || a.key || a.id).localeCompare(b.name || b.key || b.id);
}

// The name span, with the search query's first match highlighted. Highlighting
// is decoration on the hit — never a second copy of the text (screen readers
// read the row once).
function HighlightedName({ name, query }: { name: string; query?: string }) {
  const parts = matchHighlight(name, query || '');
  if (!parts) return <>{name}</>;
  return (
    <>
      {parts.pre}
      <span className="rounded-[2px] bg-green-500/30 px-px">{parts.hit}</span>
      {parts.post}
    </>
  );
}

// Metadata segment: relative time · directory · (host). Rendered muted at
// text-[10px] on line two, wrap-anywhere so a long cwd reflows the row. The
// directory yields at the narrow tier (@max-[13rem]) — the name and the actions
// never do (the exhibit's narrow degradation).
function RowMeta({ chat, stopped, showHost, hostLabel }: { chat: Chat; stopped: boolean; showHost?: boolean; hostLabel?: string }) {
  const timestampFormat = useTimestampFormat();
  const time = chat.lastActivity ? formatTimestamp(chat.lastActivity, timestampFormat, { withSuffix: timestampFormat === 'relative' }) : '';
  const full = chat.lastActivity ? formatAbsoluteFull(chat.lastActivity) : undefined;
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[10px] text-muted-foreground" title={full}>
      {stopped ? (
        <span>{time ? <>stopped {time}</> : 'stopped'}</span>
      ) : (
        time ? <span>{time}</span> : null
      )}
      {chat.cwd && <span className="@max-[13rem]:hidden">·</span>}
      {chat.cwd && <span className="wrap-anywhere @max-[13rem]:hidden">{chat.cwd}</span>}
      {showHost && hostLabel && (
        <>
          <span>·</span>
          <span className="shrink-0">{hostLabel}</span>
        </>
      )}
    </span>
  );
}

const ACT_BTN = 'inline-flex items-center gap-1 rounded px-1 py-0.5 text-[10px] text-muted-foreground hover:text-foreground active:scale-95 transition-all duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background';

export interface SavedSessionRowProps {
  chat: Chat;
  // The pane is currently focused in the grid — the row renders as "current"
  // (accent background), the exhibit's focused state.
  focused: boolean;
  // One-shot "saved" marker: a temporary session was just named/saved.
  justSaved?: boolean;
  // The host this row's session runs on — shown ONLY in cross-host views
  // (collections, search results), where it is the one extra piece of metadata.
  hostLabel?: string;
  showHost?: boolean;
  // Live-search query — highlights the matching substring of the name.
  query?: string;
  note?: string;
  onOpen: () => void;
  onDelete: () => void;
  onRename: (name: string) => void;
  onSetNote: (text: string) => void;
  // Stopped rows only: recreate the session (a fresh process under the same
  // name and directory). Absent when the chat has nothing to re-run.
  onRespawn?: () => void;
}

export function SavedSessionRow({ chat, focused, justSaved, hostLabel, showHost, query, note, onOpen, onDelete, onRename, onSetNote, onRespawn }: SavedSessionRowProps) {
  const stopped = chat.active === false;
  const isAgent = chat.kind === 'yatfa' || chat.isAgent === true;
  // Agent-owned rows are not renameable — the agent owns the name. Note and
  // delete still apply.
  const canRename = chat.kind === 'tmux' && !isAgent;
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(() => chat.name || chat.key || chat.id);
  const [noteEditing, setNoteEditing] = useState(false);
  const [noteVal, setNoteVal] = useState('');
  const name = chat.name || chat.key || chat.id;

  const commitRename = () => {
    setEditing(false);
    const v = val.trim();
    if (v && v !== name) onRename(v);
  };
  const commitNote = () => {
    setNoteEditing(false);
    const v = noteVal.trim();
    if (v !== (note || '')) onSetNote(v);
  };

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          role="button"
          tabIndex={0}
          aria-label={`${stopped ? 'stopped session' : 'working session'} ${name}`}
          aria-current={focused ? 'true' : undefined}
          onClick={onOpen}
          onKeyDown={(e) => { if (!editing && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onOpen(); } }}
          className={cn(
            'group mx-0.5 block cursor-pointer rounded-[7px] px-2 pb-1 pt-[5px] transition-all duration-150 ease-out hover:bg-accent',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background',
            focused && 'bg-accent',
            stopped && 'stop',
          )}
        >
          {/* line one — identity chip · status dot · the NAME (nothing else competes) */}
          <div className="flex items-start gap-[7px]">
            <span
              aria-hidden="true"
              className="w-[3px] shrink-0 self-stretch rounded-[2px] [min-height:15px]"
              style={{ backgroundColor: `hsl(${hueOf(name)} 62% 58%)` }}
            />
            <span className="mt-1 shrink-0">
              <StatusDot
                tone={stopped ? 'muted' : 'green'}
                variant={stopped ? 'ring' : 'solid'}
                label={stopped ? 'stopped — nothing running' : 'working — live tmux session'}
              />
            </span>
            {editing ? (
              <Input
                autoFocus
                value={val}
                onClick={(e) => e.stopPropagation()}
                onChange={(e) => setVal(e.target.value)}
                onBlur={commitRename}
                onKeyDown={(e) => { if (e.key === 'Enter') commitRename(); if (e.key === 'Escape') { setVal(name); setEditing(false); } }}
                aria-label="rename session"
                className="h-5 min-w-0 flex-1 px-1 text-[11px]"
              />
            ) : (
              <span className="min-w-0 flex-1 wrap-anywhere text-xs leading-tight text-foreground">
                <HighlightedName name={name} query={query} />
              </span>
            )}
            {!editing && isAgent && <span className="mt-0.5 shrink-0 text-[9.5px] italic text-cyan-400">agent</span>}
            {!editing && note && <StickyNote aria-hidden="true" className="mt-1 size-2.5 shrink-0 text-yellow-600" />}
            {!editing && justSaved && (
              <span className="mt-0.5 shrink-0 rounded-[5px] border border-green-500/45 px-1 text-[9.5px] leading-4 text-green-500">saved</span>
            )}
          </div>
          {/* line two — metadata · actions. Rename + note are hover/focus-revealed;
              delete is at rest; respawn is at rest on stopped rows. */}
          <div className="ml-[10px] mt-0.5 flex min-h-4 flex-wrap items-center gap-x-1.5">
            <RowMeta chat={chat} stopped={stopped} showHost={showHost} hostLabel={hostLabel} />
            <div className="ml-auto flex shrink-0 items-center gap-px">
              {stopped && onRespawn && (
                <IconTooltip label="respawn — starts a fresh process under this name in the same directory; the stopped one cannot be resurrected">
                  <button
                    className={cn(ACT_BTN, 'border border-border hover:border-green-600')}
                    onClick={(e) => { e.stopPropagation(); onRespawn(); }}
                    aria-label="respawn session"
                  >
                    <RotateCw aria-hidden="true" className="size-2.5" />
                    respawn
                  </button>
                </IconTooltip>
              )}
              {canRename && (
                <IconTooltip label="rename">
                  <button
                    className={cn(ACT_BTN, 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100')}
                    onClick={(e) => { e.stopPropagation(); setVal(name); setEditing(true); }}
                    aria-label="rename session"
                  >
                    <Pencil aria-hidden="true" className="size-2.5" />
                  </button>
                </IconTooltip>
              )}
              <IconTooltip label={note ? 'edit note' : 'add note'}>
                <button
                  className={cn(ACT_BTN, 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100', note && 'text-yellow-600')}
                  onClick={(e) => { e.stopPropagation(); setNoteVal(note || ''); setNoteEditing(true); }}
                  aria-label={note ? 'edit note' : 'add note'}
                >
                  <StickyNote aria-hidden="true" className="size-2.5" />
                </button>
              </IconTooltip>
              <IconTooltip label="delete this saved session">
                <button
                  className={cn(ACT_BTN, 'hover:text-red-500')}
                  onClick={(e) => { e.stopPropagation(); onDelete(); }}
                  aria-label="delete this saved session"
                >
                  <Trash2 aria-hidden="true" className="size-2.5" />
                </button>
              </IconTooltip>
            </div>
          </div>
          {/* the note — a third line in italics, never squeezed onto the metadata line */}
          {noteEditing ? (
            <Input
              autoFocus
              value={noteVal}
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => setNoteVal(e.target.value)}
              onBlur={commitNote}
              onKeyDown={(e) => { if (e.key === 'Enter') commitNote(); if (e.key === 'Escape') setNoteEditing(false); }}
              placeholder="add a note…"
              maxLength={200}
              className="ml-[10px] mt-0.5 block h-5 w-[calc(100%-10px)] px-1 text-[10px] text-muted-foreground"
            />
          ) : note ? (
            <span className="ml-[10px] mt-0.5 block wrap-anywhere text-[10px] italic text-muted-foreground" title={note}>{note}</span>
          ) : null}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={() => onOpen()}>{stopped ? 'Open (recovery)' : 'Open — reconnect'}</ContextMenuItem>
        <ContextMenuItem onSelect={() => copyWithToast(chat.session || chat.key || chat.id)}>Copy session id</ContextMenuItem>
        {chat.cwd && <ContextMenuItem onSelect={() => copyWithToast(chat.cwd!)}>Copy working directory</ContextMenuItem>}
        <ContextMenuSeparator />
        <ContextMenuItem variant="destructive" onSelect={() => onDelete()}>Delete</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

// Loading skeleton for a host's saved sessions (the exhibit's loading state:
// dot · bar · action chip, shimmering).
export function SavedRowSkeleton() {
  return (
    <div className="mx-0.5 flex items-center gap-2 px-2 py-1.5" aria-hidden="true">
      <Skeleton className="size-2 shrink-0 rounded-full" />
      <Skeleton className="h-2.5 flex-1" />
      <Skeleton className="h-2.5 w-6" />
    </div>
  );
}
