import { useEffect, useRef, useState } from 'react';
import { PaneTile } from './PaneTile';
import { FileViewer } from './FileViewer';
import { WorkspaceSearchDialog } from './WorkspaceSearchDialog';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogClose,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import type { Chat } from '@/lib/types';
import type { PaneLayout, TerminalCursorStyle, OnExitBehavior, Snippet } from '@/lib/storage';
import { resolveVisibleTiles } from '@/lib/paneGrid';
import { resolveActingChat } from '@/lib/actingChat';
import type { ThemeId } from '@/lib/theme';
import type { TimestampFormat } from '@/lib/formatTimestamp';

export interface OpenTile { id: string }

interface Props {
  tiles: OpenTile[];
  focused: string | null;
  maximized: string | null;
  newActivity: Set<string>;
  chats: Chat[];
  paneHost: Record<string, string>;
  onFocus: (id: string) => void;
  onClose: (id: string) => void;
  onToggleMax: (id: string) => void;
  onClearNew: (id: string) => void;
  onForceKill: (id: string) => void;
  // ＋ split (WARDEN-223 → WARDEN-543): spawn a host shell pane derived from a
  // source pane (same host + cwd). WARDEN-543 moved this off the grid-toolbar
  // ＋split button onto each pane's own context menu, so the split acts on the
  // right-clicked pane, not the focused one. App owns the spawn; PaneGrid binds
  // this per-pane (onSplitShell?.(t.id)) when handing it to each PaneTile.
  onSplitShell?: (id?: string) => void;
  onSpawned: (chat: Chat) => void;
  externalSearchQuery?: { paneId: string; query: string } | null;
  onToggleSidebar?: () => void;
  onToggleObserver?: () => void;
  fontSize: number;
  onFontSizeChange: (n: number) => void;
  scrollback: number;
  // Global, persisted terminal font family (UiState). Pure pass-through to
  // PaneTile — App owns the value (and the empty → default fallback).
  fontFamily: string;
  paneLayout: PaneLayout;
  // Resolved terminal theme id (App resolves terminalColorScheme + the active
  // theme down to a concrete named-theme id here). Pure pass-through to PaneTile
  // — App owns the resolution so an OS theme flip can re-theme open panes live
  // without PaneGrid knowing about the scheme pref.
  terminalThemeId: ThemeId;
  // Terminal cursor shape × blink (blink/steady × block/underline/bar). Pure
  // pass-through to PaneTile; App owns the state so a Settings change live-
  // updates every open pane.
  terminalCursorStyle: TerminalCursorStyle;
  // "Copy on select" (WARDEN-285): when ON, completing a selection in a pane
  // copies it to the clipboard immediately. Pure pass-through to PaneTile —
  // App owns the persisted pref; PaneTile registers the xterm selection event
  // and reads the latest value from a ref, so a toggle applies LIVE to already-
  // open panes (better than the scrollback posture).
  copyOnSelect: boolean;
  // "Pane on agent exit" behavior (keep | dim | auto-close). Pure pass-through to
  // PaneTile — App owns the persisted pref; PaneTile reacts to its own chat's
  // live→exited transition. See WARDEN-248.
  onExitBehavior: OnExitBehavior;
  // Show the host tag in each pane header (WARDEN-290). Pure pass-through to
  // PaneTile — App owns the persisted showHostTags pref (displaySettings) so a
  // Settings toggle live-updates already-open pane headers, mirroring the
  // sidebar's live update.
  showHostTags?: boolean;
  // Saved instruction snippets (WARDEN-323): pure pass-through to PaneTile —
  // App owns the persisted list. PaneTile renders a "Snippets" submenu in each
  // pane's context menu for one-click send to that pane's agent.
  snippets: Snippet[];
  // "Timestamp format" pref (WARDEN-422): pure pass-through to PaneTile and to
  // this grid's own FileViewer — App owns the persisted pref; the FileViewer's
  // blame view formats author-dates per the pref, mirroring every other surface.
  timestampFormat: TimestampFormat;
  // File Viewer markdown view mode (WARDEN-480): pure pass-through to PaneTile
  // and to this grid's own FileViewer — App owns the persisted pref (one global
  // remembered choice) so toggling Rendered⇄Source once sticks across opens.
  fileViewerViewMode: 'rendered' | 'source';
  onFileViewerViewModeChange: (mode: 'rendered' | 'source') => void;
}

function colsFor(n: number) { return n <= 1 ? 1 : Math.ceil(Math.sqrt(n)); }

export function PaneGrid({ tiles, focused, maximized, newActivity, chats, paneHost, onFocus, onClose, onToggleMax, onClearNew, onForceKill, onSplitShell, onSpawned, externalSearchQuery, onToggleSidebar, onToggleObserver, fontSize, onFontSizeChange, scrollback, fontFamily, paneLayout, terminalThemeId, terminalCursorStyle, copyOnSelect, onExitBehavior, showHostTags, snippets, timestampFormat, fileViewerViewMode, onFileViewerViewModeChange }: Props) {
  const [fileOpen, setFileOpen] = useState(false);
  const [filePath, setFilePath] = useState('');
  // WARDEN-334: the 1-based line a grep result selected, fed to FileViewer's
  // existing `line` prop (WARDEN-227) so the viewer scrolls to + highlights that
  // row. `undefined` (manual path-entry open) ⇒ the viewer opens at the top
  // (its line-jump effect early-returns on typeof line !== 'number').
  const [fileLine, setFileLine] = useState<number | undefined>(undefined);
  const [fileInput, setFileInput] = useState('');
  const [fileInputError, setFileInputError] = useState('');
  const [filePromptOpen, setFilePromptOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  // WARDEN-563: the pane whose context menu last opened a workspace dialog
  // (search / file). The dialogs resolve `actingChat` from this — NOT
  // `focusedChat` — so right-clicking a NON-focused pane searches/opens in THAT
  // pane's repo. Seeded by openSearchFor / openFilePromptFor (bound per-tile),
  // mirroring how onSplitShell threads a pane id. Stays set after a dialog
  // closes (harmless: the next menu action re-seeds it); resolves to focusedChat
  // when unset, and falls back to focusedChat if the acting pane's chat has
  // since vanished (keeps an open dialog mounted rather than blanking it).
  const [actingPaneId, setActingPaneId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const nameOf = (id: string) => chats.find((c) => (c.key || c.id) === id)?.name || id;

  const focusedChat = focused ? chats.find((c) => (c.key || c.id) === focused) : null;

  // WARDEN-563: the chat the workspace dialogs (search / file-prompt /
  // FileViewer) act on — the right-clicked pane's chat, not the focused one.
  // Pure resolution lives in resolveActingChat (src/lib) so it's unit-tested.
  const actingChat = resolveActingChat(actingPaneId, focusedChat, chats);

  const handleOpenFile = () => {
    if (!actingChat) return;

    const trimmedInput = fileInput.trim();
    if (!trimmedInput) {
      setFileInputError('Please enter a file path');
      return;
    }

    // Check for obvious path traversal attempts
    if (trimmedInput.includes('..') || trimmedInput.includes('~')) {
      setFileInputError('Path traversal not allowed');
      return;
    }

    // Clear error and open the file
    setFileInputError('');
    setFilePath(trimmedInput);
    setFileLine(undefined); // manual path-entry has no line → open at top (WARDEN-334)
    setFileOpen(true);
    setFilePromptOpen(false); // Close the path-entry Dialog
    setFileInput(''); // Clear file input to prevent both dialogs from showing
  };

  // WARDEN-563: per-pane "open file from directory" trigger — seeds the acting
  // pane (so the path-entry dialog + FileViewer resolve THIS pane's cwd, not the
  // focused pane's), prefills the input with the pane's cwd, and opens the
  // path-entry Dialog. Replaces the old handleFilePrompt, which keyed off
  // focusedChat and is what made the grid-toolbar 📄 button act on the wrong pane.
  const openFilePromptFor = (id: string) => {
    const chat = chats.find((c) => (c.key || c.id) === id);
    if (!chat) return;
    setActingPaneId(id);
    // Auto-fill with the chat's working directory if known
    const cwd = chat.cwd || '.';
    setFileInput(`${cwd}/`);
    setFileInputError(''); // Clear any previous error
    setFileOpen(false);
    setFilePromptOpen(true); // Open the path-entry Dialog
  };

  // WARDEN-563: per-pane workspace content-search trigger — seeds the acting pane
  // so WorkspaceSearchDialog scopes its query to THIS pane's repo. Mirrors
  // openFilePromptFor's id-seeding shape.
  const openSearchFor = (id: string) => {
    setActingPaneId(id);
    setSearchOpen(true);
  };

  // keyboard shortcuts: pane navigation, actions, and panel toggles
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Panel toggles first — they don't depend on tiles, so they must run before
      // the zero-panes guard below. PaneGrid is always mounted (even with 0 open
      // panes), and these shortcuts are advertised in PRODUCT.md unconditionally.
      if (e.altKey && e.code === 'KeyS') {
        e.preventDefault();
        onToggleSidebar?.();
      }
      if (e.altKey && e.code === 'KeyO') {
        e.preventDefault();
        onToggleObserver?.();
      }

      if (!tiles.length) return;
      const ids = tiles.map((t) => t.id);
      const idx = focused ? ids.indexOf(focused) : -1;

      // Pane navigation: Alt+←/→ or Ctrl+Tab/Shift+Tab
      if (e.altKey && (e.code === 'ArrowLeft' || e.code === 'ArrowRight')) {
        e.preventDefault();
        const dir = e.code === 'ArrowRight' ? 1 : -1;
        const next = ids[(idx + dir + ids.length) % ids.length];
        if (next) onFocus(next);
      }

      // Pane navigation: Ctrl+Tab/Shift+Tab cycle forward/backward
      if (e.ctrlKey && e.code === 'Tab' && !e.shiftKey) {
        e.preventDefault();
        const next = ids[(idx + 1) % ids.length];
        if (next) onFocus(next);
      }
      if (e.ctrlKey && e.code === 'Tab' && e.shiftKey) {
        e.preventDefault();
        const next = ids[(idx - 1 + ids.length) % ids.length];
        if (next) onFocus(next);
      }

      // Direct pane jumping: Alt+1-9 for indexed, Alt+0 for last
      if (e.altKey && e.code >= 'Digit1' && e.code <= 'Digit9') {
        e.preventDefault();
        const num = parseInt(e.code.slice(5), 10); // Extract number from 'DigitN'
        if (num <= ids.length) onFocus(ids[num - 1]);
      }
      if (e.altKey && e.code === 'Digit0') {
        e.preventDefault();
        onFocus(ids[ids.length - 1]); // Jump to last pane
      }

      // Pane actions: Ctrl+W close, Alt+Enter maximize, Alt+Escape restore
      if (e.ctrlKey && e.code === 'KeyW' && focused) {
        e.preventDefault();
        onClose(focused);
      }
      if (e.altKey && e.code === 'Enter' && focused) {
        e.preventDefault();
        onToggleMax(focused);
      }
      if (e.altKey && e.code === 'Escape') {
        e.preventDefault();
        if (maximized) onToggleMax(maximized); // Exit maximize mode
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [tiles, focused, maximized, onFocus, onClose, onToggleMax, onToggleSidebar, onToggleObserver]);

  // Focus the path input when the entry Dialog opens — React-controlled via ref,
  // not a DOM query (WARDEN-68 Rule 4). Radix's own open-auto-focus is disabled
  // (see onOpenAutoFocus on DialogContent) so it doesn't race this.
  useEffect(() => {
    if (filePromptOpen) fileInputRef.current?.focus();
  }, [filePromptOpen]);

  // Resolve the visible tiles through the stale-maximized guard (WARDEN-521): a
  // maximized id whose tile is no longer in the grid (closed/killed/moved away)
  // behaves as "not maximized" so the grid falls back to every open tile instead
  // of blanking. effectiveMax also drives the grid template and per-tile flag, so
  // a stale id can never pin the layout to a single column either.
  const { effectiveMax, visible } = resolveVisibleTiles(maximized, tiles);
  const n = visible.length;
  // Pane layout preference controls cols/rows. 'auto' reproduces today's exact
  // grid (cols = colsFor(n), rows = ceil(n/cols)); 'stacked' forces a single
  // column (cols=1, rows=n); 'side-by-side' forces a single row (cols=n, rows=1).
  // The n===0 case never renders the grid (the empty-state message is shown
  // instead), and maximize already forces a 1×1 grid via the style below
  // (visible is also filtered to the maximized tile), so both are unaffected
  // regardless of layout.
  let cols: number;
  let rows: number;
  if (paneLayout === 'stacked') {
    cols = 1;
    rows = n;
  } else if (paneLayout === 'side-by-side') {
    cols = n;
    rows = n > 0 ? 1 : 0;
  } else {
    cols = colsFor(n);
    rows = n > 0 ? Math.ceil(n / cols) : 0;
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center px-3 py-2 compact:py-1.5 border-b text-xs text-muted-foreground gap-2 shrink-0 relative">
        <span className="truncate">{focused ? nameOf(focused) : 'open a chat →'}</span>
        <span className="flex-1" />
        {/* WARDEN-563: the grid-toolbar 🔍 search / 📄 file buttons lived here,
            operating on the focused pane. Retired — both affordances now live
            on each pane's own context menu (right-click → Search workspace
            files / Open file from directory) and act on the right-clicked pane. */}
      </div>
      <div className="flex-1 min-h-0 p-1">
        {n === 0 ? (
          <div className="text-xs text-muted-foreground p-8 text-center">click a chat to open a live pane</div>
        ) : (
          <div data-pane-grid className="grid gap-2 compact:gap-1 h-full min-h-0 overflow-x-auto transition-all duration-200 ease-in-out"
            style={{ gridTemplateColumns: `repeat(${effectiveMax ? 1 : cols}, minmax(9rem, 1fr))`, gridTemplateRows: `repeat(${effectiveMax ? 1 : rows}, minmax(0, 1fr))` }}>
            {visible.map((t) => {
              const chat = chats.find((c) => (c.key || c.id) === t.id);
              return (
                <div key={t.id} data-pane-id={t.id} className="min-h-0 min-w-0">
                  <PaneTile id={t.id} label={nameOf(t.id)} focused={focused === t.id} maximized={effectiveMax === t.id}
                    hasNew={newActivity.has(t.id)} onClearNew={() => onClearNew(t.id)}
                    onFocus={() => onFocus(t.id)} onClose={() => onClose(t.id)} onToggleMax={() => onToggleMax(t.id)}
                    onKill={() => onForceKill(t.id)} onSplitShell={() => onSplitShell?.(t.id)} onSearchWorkspace={() => openSearchFor(t.id)} onOpenFileFromDir={() => openFilePromptFor(t.id)} chat={chat} host={paneHost[t.id]}
                    externalSearchQuery={externalSearchQuery?.paneId === t.id ? externalSearchQuery.query : undefined}
                    fontSize={fontSize} onFontSizeChange={onFontSizeChange}
                    scrollback={scrollback}
                    fontFamily={fontFamily}
                    terminalThemeId={terminalThemeId}
                    terminalCursorStyle={terminalCursorStyle}
                    copyOnSelect={copyOnSelect}
                    onExitBehavior={onExitBehavior}
                    showHostTags={showHostTags}
                    onSpawned={onSpawned}
                    snippets={snippets}
                    timestampFormat={timestampFormat}
                    fileViewerViewMode={fileViewerViewMode}
                    onFileViewerViewModeChange={onFileViewerViewModeChange}
                  />
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* File Viewer Dialog */}
      {actingChat && filePath && (
        <FileViewer
          chatId={actingChat.id}
          filePath={filePath}
          line={fileLine}
          open={fileOpen}
          timestampFormat={timestampFormat}
          viewMode={fileViewerViewMode}
          onViewModeChange={onFileViewerViewModeChange}
          onOpenChange={(open) => {
            setFileOpen(open);
            if (!open) {
              setFilePath(''); // Clear file path when dialog closes
              setFileLine(undefined); // and the grep-selected line (WARDEN-334)
            }
          }}
        />
      )}

      {/* Workspace content-search Dialog (WARDEN-145): locate a file by content,
          then hand its path to the FileViewer above to open. WARDEN-563: scoped
          to the right-clicked pane's chat (actingChat), not the focused pane. */}
      {actingChat && (
        <WorkspaceSearchDialog
          chatId={actingChat.id}
          cwd={actingChat.cwd}
          open={searchOpen}
          onOpenChange={setSearchOpen}
          onSelectFile={(file, line) => { setFilePath(file); setFileLine(line); setFileOpen(true); }}
        />
      )}

      {/* File Path Entry Dialog — shadcn Dialog + Input + Button (WARDEN-68) */}
      <Dialog
        open={filePromptOpen}
        onOpenChange={(open) => {
          if (!open) {
            setFilePromptOpen(false);
            setFileInput('');
            setFileInputError('');
          }
        }}
      >
        <DialogContent className="sm:max-w-md" onOpenAutoFocus={(e) => e.preventDefault()}>
          <DialogHeader>
            <DialogTitle>Open file from chat directory</DialogTitle>
            <DialogDescription>Working directory: {actingChat?.cwd || '.'}</DialogDescription>
          </DialogHeader>
          <Input
            ref={fileInputRef}
            value={fileInput}
            onChange={(e) => { setFileInput(e.target.value); setFileInputError(''); }}
            onKeyDown={(e) => { if (e.key === 'Enter') handleOpenFile(); }}
            placeholder="relative/path/to/file.txt"
          />
          {fileInputError && (
            <p className="text-xs text-destructive">{fileInputError}</p>
          )}
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Cancel</Button>
            </DialogClose>
            <Button onClick={handleOpenFile}>Open</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
