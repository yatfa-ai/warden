// Chat-row rendering extracted from ChatSidebar.tsx (WARDEN-315).
// Pure structural move — no behavior, props, classname, or DOM change.
// Groups the loading skeletons and the two row components (fleet rows + the
// primary opened-tabs working-set rows).

import { useState } from 'react';
import { WifiOff, Eye } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from '@/components/ui/context-menu';
import { IconTooltip } from '@/components/ui/icon-tooltip';
import { StatusDot } from '@/components/StatusDot';
import { cn } from '@/lib/utils';
import { chatType, displayName, hostTagOf, hostLabelFor } from '@/lib/chatDisplay';
import { useHostLabels } from '@/lib/hostLabels';
import { formatTimestamp, formatAbsoluteFull, type TimestampFormat } from '@/lib/formatTimestamp';
import type { Chat, AgentStateRow } from '@/lib/types';
import type { GitCommit, GitFile, DiffStat } from './types';
import { GitBranchBadge, GitChangedFile, WhatsNewMarker } from './GitBadges';
import { DiffStatChip } from './DiffStatChip';
import { getLastSeen, summarizeWhatsNew, hasUnreviewedProgress } from '@/lib/whatsNew';
import { currentWatchNeed } from '@/lib/chatWatch';
import { watchStateLabel } from '@/lib/desktopAlerts';

// Compute the per-agent "What's new since your last visit" summary for a row
// (WARDEN-356) from the git-log + git-status data the row already holds, plus
// the client-side lastSeen timestamp App stamps on pane open/focus. Pure-ish
// (reads localStorage + the clock, both cheap) and recomputed each render — so
// it stays fresh as ChatSidebar refetches git-log/git-status on poll. Returns
// the raw `since` (null when never visited, so hasUnreviewedProgress can gate)
// alongside the summary. Shared by ChatRow + OpenedChatRow to avoid divergence.
function computeWhatsNew(chatId: string, commits: GitCommit[] | undefined, gitInfo: { files?: GitFile[]; stashCount?: number | null } | undefined) {
  const since = getLastSeen(chatId);
  const summary = summarizeWhatsNew({
    commits,
    since: since ?? 0,
    changedFileCount: gitInfo?.files?.length,
    stashCount: gitInfo?.stashCount,
    // `truncated` only needs the default WHATS_NEW_FETCH_LIMIT, which is also the
    // limit the ChatSidebar what's-new fetch uses — so the truncation signal stays
    // honest without threading a second number through the row props.
  });
  return { since, summary, show: hasUnreviewedProgress(since, summary) };
}

const TYPE_COLOR: Record<string, string> = {
  resume: 'text-cyan-400', claude: 'text-green-400', shell: 'text-yellow-400',
  yatfa: 'text-blue-400', manual: 'text-violet-400', '?': 'text-muted-foreground',
};

// Skeleton components for loading states
export function ChatRowSkeleton({ dim = false }: { dim?: boolean }) {
  return (
    <div className={`flex items-center gap-2 px-2 py-1.5 rounded-md ${dim ? 'opacity-60' : ''}`}>
      <Skeleton className="size-2 rounded-full" />
      <Skeleton className="flex-1 h-3" />
      <Skeleton className="h-3 w-12" />
    </div>
  );
}

export function SessionRowSkeleton() {
  return (
    <div className="flex flex-col gap-0.5 px-2 py-1.5 rounded-md">
      <Skeleton className="h-3 w-3/4" />
      <Skeleton className="h-2.5 w-1/2" />
    </div>
  );
}

// WARDEN-514: the state-aware watch indicator shared by ChatRow + OpenPaneRow. When a
// WATCHED chat's CURRENT state needs the human (waiting/erroring/stuck/blocked —
// currentWatchNeed over the threaded watchState), the static blue Eye is replaced by a
// themed, at-a-glance StatusDot (red + pulsing for the broken states erroring/stuck;
// amber + solid for the milder waiting/blocked — the SAME red/amber split the
// AttentionBadge's dotForState uses for these states), with a tooltip naming the reason
// in the watch ping's own vocabulary (watchStateLabel) and quoting the triggering signal
// verbatim. A happily-working/idle watched chat shows the neutral Eye glyph (unchanged).
// Either way the control is the watch TOGGLE — clicking swaps back to unwatch.
//
// WCAG 1.4.1 (WARDEN-68): the needs-you signal is NOT color alone. The StatusDot (a dot)
// replaces the Eye ICON (a shape change), and the pulse-vs-solid variant further
// separates broken from waiting — so the binary "needs me / happy" never rests on hue
// alone. The specific reason is always in the tooltip + the control's accessible name.
// Built on the library primitives (StatusDot / Button / IconTooltip) — no raw <span>,
// no magic sizes, no inline visual styles.
function WatchToggle({ isWatched, watchState, onToggle }: {
  isWatched?: boolean;
  watchState?: AgentStateRow;
  onToggle: () => void;
}) {
  // Only a WATCHED chat with a known CURRENT state can need the human: an unwatched chat
  // has no row indicator, and a watched chat before the first poll / on a transient fetch
  // blip has no watchState (the rollup preserves, not blanks, on failure) → degrades to
  // the neutral Eye (the safe default, matching the catch-up's null-snapshot behavior).
  const need = isWatched && watchState ? currentWatchNeed(watchState) : null;
  if (need) {
    const broken = need === 'erroring' || need === 'stuck';
    const label = watchStateLabel(need, watchState?.signal);
    return (
      <IconTooltip label={label}>
        <Button
          variant="ghost"
          size="xs"
          className="px-0.5"
          onClick={(e) => { e.stopPropagation(); onToggle(); }}
          aria-label={label}
          aria-pressed={true}
        >
          <StatusDot tone={broken ? 'red' : 'yellow'} variant={broken ? 'pulse' : 'solid'} label={label} />
        </Button>
      </IconTooltip>
    );
  }
  // Neutral watch glyph (unchanged from WARDEN-378): blue Eye when watched (always
  // visible so a watched chat is recognizable), hover/focus-revealed toggle when not.
  return (
    <IconTooltip label={isWatched ? 'unwatch — stop pinging me about this chat' : 'watch — ping me when this chat needs you'}>
      <Button
        variant="ghost"
        size="xs"
        className={cn('px-0.5', isWatched ? 'text-blue-500' : 'text-muted-foreground hover:text-foreground opacity-0 group-hover:opacity-100 focus-visible:opacity-100')}
        onClick={(e) => { e.stopPropagation(); onToggle(); }}
        aria-label={isWatched ? 'unwatch this chat' : 'watch this chat'}
        aria-pressed={isWatched}
      >
        <Eye className="size-3" />
      </Button>
    </IconTooltip>
  );
}

export function ChatRow({ c, open, onOpen, onKill, onRename, dim, hostStatus, gitInfo, gitCommits, gitLogLoading, onFetchGitLog, incomingCommits, incomingLoading, onFetchIncoming, outgoingCommits, outgoingLoading, onFetchOutgoing, onOpenDiff, onOpenConflict, onOpenFile, showHostTags, showTypeBadges, showStatusIndicators, showProjectBadges, isPinned, onTogglePin, selected, onToggleSelect, selectionActive, note, onSetNote, isWatched, watchState, onToggleWatch }: {
  c: Chat; open: boolean; onOpen: () => void; onKill: () => void;
  onRename: (session: string, kind: string, name: string, host?: string) => void;
  dim?: boolean;
  // WARDEN-198: per-host reachability from the 30s /api/hosts/status poll.
  // 'offline' → the row renders a distinct "unreachable" state.
  hostStatus?: 'online' | 'offline' | 'unknown';
  gitInfo?: { branch: string | null; detached?: boolean; headSha?: string | null; clean: boolean | null; files?: GitFile[]; ahead?: number | null; behind?: number | null; upstream?: string | null; inProgress?: { operation: string | null; detail?: string | null }; stashCount?: number | null; diffstat?: DiffStat | null };
  gitCommits?: GitCommit[]; gitLogLoading?: boolean; onFetchGitLog?: () => void;
  // WARDEN-225: incoming (behind) commits + their own fetch/loader, threaded to
  // GitBranchBadge the same way the local gitLog trio is.
  incomingCommits?: GitCommit[]; incomingLoading?: boolean; onFetchIncoming?: () => void;
  // WARDEN-252: outgoing (ahead/unpushed) commits + their own fetch/loader.
  outgoingCommits?: GitCommit[]; outgoingLoading?: boolean; onFetchOutgoing?: () => void;
  onOpenDiff?: (path: string, staged?: boolean) => void;
  // WARDEN-428: opens the read-only ours-vs-theirs ConflictView for a conflicted
  // file (UU/AA/UD/…) instead of the staged diff.
  onOpenConflict?: (path: string) => void;
  // WARDEN-478: opens the file's full content in the FileViewer (read + blame +
  // history) from any file row in this agent's git panel — dirty files, the
  // catch-up popover, and committed files inside GitBranchBadge's commit lists.
  onOpenFile?: (path: string) => void;
  showHostTags?: boolean; showTypeBadges?: boolean; showStatusIndicators?: boolean; showProjectBadges?: boolean;
  isPinned?: boolean; onTogglePin?: () => void;
  // WARDEN-292: multi-select for broadcast. `selected` is this row's membership
  // in the sidebar's selection set; `onToggleSelect` flips it. `selectionActive`
  // (≥1 agent selected anywhere in the view) reveals every row's checkbox at full
  // opacity so the human can keep picking without per-row hover — otherwise the
  // checkbox is hover/focus-only (mirrors the pin/hide/kill hover-button pattern
  // at line ~1542) to keep the default fleet list uncluttered.
  selected?: boolean; onToggleSelect?: () => void; selectionActive?: boolean;
  // WARDEN-305: per-agent note (id-keyed, persists across restart via /api/agent-notes).
  note?: string; onSetNote?: (text: string) => void;
  // WARDEN-378: per-chat "watch" toggle state + handler. Optional so call sites that
  // don't surface watch (e.g. the full-page chat browser) render unchanged.
  isWatched?: boolean; onToggleWatch?: () => void;
  // WARDEN-514: the chat's CURRENT AgentStateRow (when watched) → state-aware indicator.
  watchState?: AgentStateRow;
}) {
  const isUser = c.kind === 'tmux';
  const canRename = isUser;
  const hostLabels = useHostLabels();
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(c.name || c.key || c.id);
  // WARDEN-305: inline note editor state (independent of rename's editing/val).
  const [noteEditing, setNoteEditing] = useState(false);
  const [noteVal, setNoteVal] = useState('');
  const commitNote = () => {
    setNoteEditing(false);
    const v = noteVal.trim();
    if (onSetNote && v !== (note || '')) onSetNote(v);
  };
  const type = chatType(c);
  const typeColor = TYPE_COLOR[type] || 'text-violet-400';
  const hostTag = isUser ? (hostLabelFor(c.host, hostLabels) || (c.host === '(local)' ? 'local' : (c.host || ''))) : null;
  // WARDEN-198: when this agent's managed host is offline, render a distinct
  // "unreachable" state instead of the ambiguous idle/undiscovered gray dot.
  // Driven by the shared 30s host-status poll, so it self-clears on recovery.
  const hostOffline = hostStatus === 'offline';
  // WARDEN-356: per-agent "What's new since your last visit" marker — computed
  // from the git-log + git-status this row already receives (+ App's lastSeen).
  const whatsNew = computeWhatsNew(c.key || c.id, gitCommits, gitInfo);
  const commit = () => {
    const v = val.trim();
    if (v && v !== (c.name || c.key)) {
      setEditing(false);
      onRename(c.key || c.id, c.kind || 'tmux', v, c.host);
    } else {
      setEditing(false);
    }
  };

  return (
    <div
      data-chat-key={c.key || c.id}
      role="button"
      tabIndex={0}
      aria-label={`open chat ${c.name || c.key || c.id}`}
      aria-current={open ? 'true' : undefined}
      onClick={onOpen}
      onKeyDown={(e) => { if (!editing && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onOpen(); } }}
      className={`group flex items-center gap-2 px-2 py-1.5 compact:py-1 rounded-md text-left text-xs hover:bg-accent cursor-pointer transition-all duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background ${open ? 'bg-accent' : ''} ${dim || hostOffline ? 'opacity-60' : ''}`}
    >
      {onToggleSelect && (
        // The selection checkbox sits leftmost, before the status dot. Click +
        // keydown stop propagation (mirrors the pin/hide/kill hover buttons
        // below) so toggling selection never also opens the chat. Subtle
        // (hover/focus-revealed) until selection is active somewhere in the view
        // or this row is itself selected — keeps the default fleet list quiet
        // while staying keyboard-accessible (focus-within reveals it).
        <span
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
          className={cn('flex shrink-0 items-center', selected || selectionActive ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 focus-within:opacity-100')}
        >
          <Checkbox
            checked={!!selected}
            onCheckedChange={() => onToggleSelect()}
            aria-label={`${selected ? 'deselect' : 'select'} ${c.name || c.key || c.id}`}
          />
        </span>
      )}
      {showStatusIndicators !== false && (
        // Four grayscale-legible states via shape, not hue:
        //   open         = solid filled circle (●)
        //   active       = half-filled glyph   (◐) — distinct from both open & idle
        //   idle         = hollow ring         (○)
        //   host offline = red square + WifiOff (▪ 📶̸) — unreachable (WARDEN-198).
        //                  Distinct from idle/undiscovered: shape + icon + tooltip +
        //                  dim, never the idle ring alone. Driven by the host-status
        //                  poll, so it self-clears when the host comes back online.
        hostOffline ? (
          <span className="inline-flex items-center gap-1" title="host offline — unreachable">
            <StatusDot tone="red" variant="square" label="host offline — unreachable" />
            <WifiOff className="size-3 text-red-500 shrink-0" aria-hidden="true" />
          </span>
        ) : open ? (
          <StatusDot tone="green" variant="solid" label="Open" />
        ) : c.active ? (
          <StatusDot tone="green" variant="glyph" glyph="◐" label="Active" />
        ) : (
          <StatusDot tone="muted" variant="ring" label="Idle" />
        )
      )}
      {editing ? (
        <Input autoFocus value={val} onClick={(e) => e.stopPropagation()} onChange={(e) => setVal(e.target.value)} onBlur={commit} onKeyDown={(e) => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') { setVal(c.name || c.key || c.id); setEditing(false); } }} className="h-5 text-[11px] px-1 flex-1" />
      ) : (
        <span className="truncate flex-1" onDoubleClick={(e) => { if (canRename) { e.stopPropagation(); setVal(c.name || c.key || c.id); setEditing(true); } }} title={canRename ? 'double-click to rename' : undefined}>
          {c.name || c.key || c.id}
          {(showTypeBadges !== false || showProjectBadges || gitInfo?.branch) && (
            <>
              {showTypeBadges !== false && <span className={`ml-1 text-[10px] ${typeColor}`}>{type}</span>}
              {c.role && !isUser && <span className="ml-1 text-[10px] text-muted-foreground">{c.role}</span>}
              {showProjectBadges && c.project && <span className="ml-1 text-[10px] text-muted-foreground">{c.project}</span>}
              {isUser && showHostTags !== false && hostTag && <span className="ml-1 text-[10px] text-muted-foreground">{hostTag}</span>}
              {(gitInfo?.branch || gitInfo?.detached) && (
                <GitBranchBadge
                  branch={gitInfo.branch ?? ''}
                  chatId={c.key || c.id}
                  clean={gitInfo.clean}
                  commits={gitCommits}
                  loading={gitLogLoading}
                  onFetch={onFetchGitLog}
                  ahead={gitInfo.ahead}
                  behind={gitInfo.behind}
                  inProgress={gitInfo.inProgress}
                  stashCount={gitInfo.stashCount}
                  diffstat={gitInfo.diffstat}
                  detached={gitInfo.detached}
                  headSha={gitInfo.headSha}
                  upstream={gitInfo.upstream}
                  incomingCommits={incomingCommits}
                  incomingLoading={incomingLoading}
                  onFetchIncoming={onFetchIncoming}
                  outgoingCommits={outgoingCommits}
                  outgoingLoading={outgoingLoading}
                  onFetchOutgoing={onFetchOutgoing}
                  onOpenFile={onOpenFile}
                  className="ml-1"
                />
              )}
              {whatsNew.show && (
                <WhatsNewMarker
                  summary={whatsNew.summary}
                  since={whatsNew.since}
                  files={gitInfo?.files}
                  diffstat={gitInfo?.diffstat}
                  onOpenDiff={onOpenDiff}
                  onOpenConflict={onOpenConflict}
                  onOpenFile={onOpenFile}
                />
              )}
            </>
          )}
          {gitInfo?.clean === false && gitInfo.files && gitInfo.files.length > 0 && (
            <div className="ml-1 mt-0.5 flex flex-col gap-0.5">
              {/* WARDEN-411: magnitude chip — how much WIP, not just which files.
                  Tracked-edits only (insertions+deletions > 0); an all-untracked
                  WIP renders no misleading +0−0 and speaks through the file list. */}
              {gitInfo.diffstat && gitInfo.diffstat.insertions + gitInfo.diffstat.deletions > 0 && (
                <div className="px-0.5"><DiffStatChip diffstat={gitInfo.diffstat} /></div>
              )}
              {gitInfo.files.map((file, i) => (
                <GitChangedFile key={file.path + '-' + i} file={file} onOpen={onOpenDiff} onOpenConflict={onOpenConflict} onOpenFile={onOpenFile} />
              ))}
            </div>
          )}
          {/* WARDEN-305: per-agent note — muted one-line subtext under the name,
              or an inline editor when noteEditing. Mirrors the files block above
              (a block child of the truncate span → renders on its own line). */}
          {noteEditing ? (
            <Input autoFocus value={noteVal} onClick={(e) => e.stopPropagation()} onChange={(e) => setNoteVal(e.target.value)} onBlur={commitNote} onKeyDown={(e) => { if (e.key === 'Enter') commitNote(); if (e.key === 'Escape') setNoteEditing(false); }} placeholder="add a note…" maxLength={200} className="block mt-0.5 h-5 w-full text-[10px] px-1 text-muted-foreground" />
          ) : note ? (
            <span className="block mt-0.5 truncate text-[10px] italic text-muted-foreground/80" title={note}>{note}</span>
          ) : null}
        </span>
      )}
      {/* WARDEN-378/514: per-chat "watch" toggle — opt this chat into a targeted ping
          when it newly needs the human. The watched state is always visible so a watched
          chat is recognizable at a glance; when it CURRENTLY needs the human (WARDEN-514)
          the static eye becomes a state-aware needs-you indicator (WatchToggle).
          Unwatched is hover/focus-revealed to keep the default fleet list quiet. */}
      {!editing && onToggleWatch && (
        <WatchToggle isWatched={isWatched} watchState={watchState} onToggle={onToggleWatch} />
      )}
      {!editing && onTogglePin && (
        <IconTooltip label={isPinned ? 'unpin' : 'pin'}>
          <button
            className={`px-0.5 ${isPinned ? 'text-yellow-500' : 'text-muted-foreground hover:text-foreground'} ${isUser ? 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100' : ''} active:scale-95 transition-all duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background rounded`}
            onClick={(e) => { e.stopPropagation(); onTogglePin(); }}
          >
            📌
          </button>
        </IconTooltip>
      )}
      {/* WARDEN-305: per-agent note affordance — mirrors the 📌 pin button, but built
          on shadcn <Button> per WARDEN-68 (Rule 1 + Rule 2): no raw <button>. */}
      {!editing && onSetNote && (
        <IconTooltip label={note ? 'edit note' : 'add note'}>
          <Button
            variant="ghost"
            size="xs"
            className={`px-0.5 ${note ? 'text-yellow-600' : 'text-muted-foreground hover:text-foreground'} ${isUser ? 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100' : ''}`}
            onClick={(e) => { e.stopPropagation(); setNoteVal(note || ''); setNoteEditing(true); }}
            aria-label={note ? 'edit note' : 'add note'}
          >
            🗒
          </Button>
        </IconTooltip>
      )}
      {isUser && !editing && (
          <IconTooltip label="kill + forget">
            <button
              className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 text-muted-foreground hover:text-red-500 px-0.5 active:scale-95 transition-all duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background rounded"
              onClick={(e) => { e.stopPropagation(); onKill(); }}
            >
              ×
            </button>
          </IconTooltip>
      )}
    </div>
  );
}

// Host tag for display: (local) → "local", else the host name.


// A row in the primary "open panes" list — the active workspace's openPanes,
// mirroring pane-grid order (WARDEN-372). Table-like columns: status indicator ·
// display name · last-activity time · type/host/project/git badges · rename ·
// close. Rename works directly on the row for manual/spawned chats via the ✎
// affordance only (single-click the row opens/focuses it; gating rename off
// double-click avoids the two-fires-before-dblclick open-then-edit jank); yatfa
// agents are not renameable. The old drag-reorder + hide affordances are gone:
// the list mirrors the pane grid (no sidebar reorder) and hide/unhide is
// abolished. Closing a row (× / "Close pane") is `onClose`, which removes the
// pane and records it in the workspace's recently-closed recovery list.
export function OpenPaneRow({ id, c, isOpen, onOpen, onClose, onRename, showHostTags, showTypeBadges, showStatusIndicators, showProjectBadges, gitInfo, gitCommits, gitLogLoading, onFetchGitLog, incomingCommits, incomingLoading, onFetchIncoming, outgoingCommits, outgoingLoading, onFetchOutgoing, onOpenDiff, onOpenConflict, onOpenFile, onKill, note, onSetNote, timestampFormat, isWatched, watchState, onToggleWatch }: {
  id: string;
  c?: Chat;
  isOpen: boolean;
  onOpen: () => void;
  onClose: () => void;
  onRename: (session: string, kind: string, name: string, host?: string) => void;
  showHostTags?: boolean; showTypeBadges?: boolean; showStatusIndicators?: boolean; showProjectBadges?: boolean;
  gitInfo?: { branch: string | null; detached?: boolean; headSha?: string | null; clean: boolean | null; files?: GitFile[]; ahead?: number | null; behind?: number | null; upstream?: string | null; inProgress?: { operation: string | null; detail?: string | null }; stashCount?: number | null; diffstat?: DiffStat | null };
  gitCommits?: GitCommit[]; gitLogLoading?: boolean; onFetchGitLog?: () => void;
  // WARDEN-225: incoming (behind) commits + their own fetch/loader.
  incomingCommits?: GitCommit[]; incomingLoading?: boolean; onFetchIncoming?: () => void;
  // WARDEN-252: outgoing (ahead/unpushed) commits + their own fetch/loader.
  outgoingCommits?: GitCommit[]; outgoingLoading?: boolean; onFetchOutgoing?: () => void;
  onOpenDiff?: (path: string, staged?: boolean) => void;
  // WARDEN-428: opens the read-only ours-vs-theirs ConflictView for a conflicted file.
  onOpenConflict?: (path: string) => void;
  // WARDEN-478: opens the file's full content in the FileViewer (mirrors ChatRow).
  onOpenFile?: (path: string) => void;
  onKill?: () => void;
  // WARDEN-305: per-agent note (mirrors pins; keyed by chat id).
  note?: string;
  onSetNote?: (text: string) => void;
  // Timestamp format pref (WARDEN-213): routes the last-activity time + its
  // hover tooltip through the shared formatTimestamp / formatAbsoluteFull helpers.
  timestampFormat: TimestampFormat;
  // WARDEN-378: per-chat "watch" toggle state + handler (mirrors ChatRow).
  isWatched?: boolean; onToggleWatch?: () => void;
  // WARDEN-514: the chat's CURRENT AgentStateRow (when watched) → state-aware indicator.
  watchState?: AgentStateRow;
}) {
  const type = c ? chatType(c) : '?';
  const hostLabels = useHostLabels();
  const hostTag = c ? hostTagOf(c.host, hostLabels) : '';
  const dead = !c || c.active === false;
  const canRename = !!c && c.kind === 'tmux';
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(() => (c ? displayName(c) : id));
  // WARDEN-305: inline note editor state (independent of rename).
  const [noteEditing, setNoteEditing] = useState(false);
  const [noteVal, setNoteVal] = useState('');
  const commitNote = () => {
    setNoteEditing(false);
    const v = noteVal.trim();
    if (onSetNote && v !== (note || '')) onSetNote(v);
  };

  const startEdit = () => { setVal(c ? displayName(c) : id); setEditing(true); };
  const commit = () => {
    const v = val.trim();
    setEditing(false);
    if (c && v && v !== displayName(c)) onRename(c.key || c.id, c.kind || 'tmux', v, c.host);
  };

  const hasFiles = !dead && gitInfo?.clean === false && gitInfo.files && gitInfo.files.length > 0;
  // WARDEN-356: per-agent "What's new since your last visit" marker — only
  // meaningful for a live chat (a dead tab has no live git state to advance).
  const whatsNew = !dead && c ? computeWhatsNew(c.key || c.id, gitCommits, gitInfo) : { since: null, summary: summarizeWhatsNew({ since: 0 }), show: false };

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
      <div
      role="button"
      tabIndex={0}
      aria-label={`open pane ${c ? displayName(c) : id}`}
      aria-current={isOpen ? 'true' : undefined}
      onClick={() => { if (!editing) onOpen(); }}
      onKeyDown={(e) => { if (!editing && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onOpen(); } }}
      className={`group flex flex-col gap-0.5 px-2 py-1.5 compact:py-1 rounded-md text-left text-xs hover:bg-accent cursor-pointer transition-all duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background ${dead ? 'opacity-50' : ''}`}
    >
      <div className="flex items-center gap-2">
        {showStatusIndicators !== false && (
          <StatusDot
            tone={dead ? 'red' : isOpen ? 'green' : 'muted'}
            variant={dead ? 'square' : isOpen ? 'solid' : 'ring'}
            label={dead ? 'Dead' : isOpen ? 'Open' : 'Idle'}
          />
        )}
        {editing ? (
          <Input autoFocus value={val} onClick={(e) => e.stopPropagation()} onChange={(e) => setVal(e.target.value)} onBlur={commit} onKeyDown={(e) => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') { setVal(c ? displayName(c) : id); setEditing(false); } }} className="h-5 text-[11px] px-1 flex-1" />
        ) : (
          <span className={`truncate flex-1 ${dead ? 'line-through text-muted-foreground' : ''}`}>
            {c ? displayName(c) : id}
          </span>
        )}
        {!dead && !editing && !!c?.lastActivity && (
          <span className="text-[10px] text-muted-foreground shrink-0" title={formatAbsoluteFull(c.lastActivity)}>{formatTimestamp(c.lastActivity, timestampFormat)}</span>
        )}
        {!dead && !editing && showTypeBadges !== false && <span className={`text-[10px] ${TYPE_COLOR[type] || ''}`}>{type}</span>}
        {!dead && !editing && showHostTags !== false && hostTag && <span className="text-[10px] text-muted-foreground">{hostTag}</span>}
        {!dead && !editing && showProjectBadges && c?.project && <span className="text-[10px] text-muted-foreground">{c.project}</span>}
        {!dead && !editing && (gitInfo?.branch || gitInfo?.detached) && (
          <GitBranchBadge branch={gitInfo.branch ?? ''} chatId={id} clean={gitInfo.clean} commits={gitCommits} loading={gitLogLoading} onFetch={onFetchGitLog} ahead={gitInfo.ahead} behind={gitInfo.behind} inProgress={gitInfo.inProgress} stashCount={gitInfo.stashCount} diffstat={gitInfo.diffstat} detached={gitInfo.detached} headSha={gitInfo.headSha} upstream={gitInfo.upstream} incomingCommits={incomingCommits} incomingLoading={incomingLoading} onFetchIncoming={onFetchIncoming} outgoingCommits={outgoingCommits} outgoingLoading={outgoingLoading} onFetchOutgoing={onFetchOutgoing} onOpenFile={onOpenFile} />
        )}
        {!dead && !editing && whatsNew.show && (
          <WhatsNewMarker summary={whatsNew.summary} since={whatsNew.since} files={gitInfo?.files} diffstat={gitInfo?.diffstat} onOpenDiff={onOpenDiff} onOpenConflict={onOpenConflict} onOpenFile={onOpenFile} />
        )}
        {/* WARDEN-378/514: per-chat "watch" toggle (mirrors ChatRow's). Shown even for a
            dead pane so a watched-but-dead chat can be unwatched; the row's own dead-dim
            mutes it. When the watched chat CURRENTLY needs the human (WARDEN-514) the eye
            becomes a state-aware needs-you indicator (WatchToggle). */}
        {!editing && onToggleWatch && (
          <WatchToggle isWatched={isWatched} watchState={watchState} onToggle={onToggleWatch} />
        )}
        {!editing && canRename && (
          <IconTooltip label="rename"><Button variant="ghost" size="xs" className="px-1 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 text-muted-foreground hover:text-foreground" onClick={(e) => { e.stopPropagation(); startEdit(); }} aria-label="rename">✎</Button></IconTooltip>
        )}
        <IconTooltip label={dead ? 'remove dead pane' : 'close pane'}><button className={`px-1 text-sm active:scale-95 transition-all duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background rounded ${dead ? 'text-red-500 font-bold' : 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100 text-muted-foreground hover:text-red-500'}`} onClick={(e) => { e.stopPropagation(); onClose(); }}>×</button></IconTooltip>
      </div>
      {hasFiles && gitInfo?.files && (
        <div className="ml-6 flex flex-col gap-0.5">
          {/* WARDEN-411: magnitude chip — how much WIP, not just which files. */}
          {gitInfo.diffstat && gitInfo.diffstat.insertions + gitInfo.diffstat.deletions > 0 && (
            <div className="px-0.5"><DiffStatChip diffstat={gitInfo.diffstat} /></div>
          )}
          {gitInfo.files.map((file, i) => (<GitChangedFile key={file.path + '-' + i} file={file} onOpen={onOpenDiff} onOpenConflict={onOpenConflict} onOpenFile={onOpenFile} />))}
        </div>
      )}
      {/* WARDEN-305: per-agent note — muted one-line subtext under the name, or an
          inline editor when noteEditing. Wrapping div is block-level so its
          auto-width accounts for ml-6 and the Input's w-full can't overflow. */}
      {(noteEditing || note) && (
        <div className="ml-6 min-w-0">
          {noteEditing ? (
            <Input autoFocus value={noteVal} onClick={(e) => e.stopPropagation()} onChange={(e) => setNoteVal(e.target.value)} onBlur={commitNote} onKeyDown={(e) => { if (e.key === 'Enter') commitNote(); if (e.key === 'Escape') setNoteEditing(false); }} placeholder="add a note…" maxLength={200} className="h-5 text-[10px] px-1 text-muted-foreground" />
          ) : (
            <span className="block truncate text-[10px] italic text-muted-foreground/80" title={note}>🗒 {note}</span>
          )}
        </div>
      )}
    </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={() => onOpen()}>Open</ContextMenuItem>
        {onSetNote && <ContextMenuItem onSelect={() => { setNoteVal(note || ''); setNoteEditing(true); }}>{note ? 'Edit note' : 'Add note'}</ContextMenuItem>}
        {!dead && onKill && (
          <ContextMenuItem onSelect={() => onKill()}>
            Kill session
          </ContextMenuItem>
        )}
        <ContextMenuSeparator />
        <ContextMenuItem variant="destructive" onSelect={() => onClose()}>Close pane</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
