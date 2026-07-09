import { useEffect, useRef, useState } from 'react';
import { PaneTile } from './PaneTile';
import { FileViewer } from './FileViewer';
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
  onOpenChat: (id: string) => void;
  onForceKill: (id: string) => void;
  externalSearchQuery?: { paneId: string; query: string } | null;
  onToggleSidebar?: () => void;
  onToggleObserver?: () => void;
}

function colsFor(n: number) { return n <= 1 ? 1 : Math.ceil(Math.sqrt(n)); }

export function PaneGrid({ tiles, focused, maximized, newActivity, chats, paneHost, onFocus, onClose, onToggleMax, onClearNew, onOpenChat, onForceKill, externalSearchQuery, onToggleSidebar, onToggleObserver }: Props) {
  const [splitOpen, setSplitOpen] = useState(false);
  const [fileOpen, setFileOpen] = useState(false);
  const [filePath, setFilePath] = useState('');
  const [fileInput, setFileInput] = useState('');
  const [fileInputError, setFileInputError] = useState('');
  const [filePromptOpen, setFilePromptOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const nameOf = (id: string) => chats.find((c) => (c.key || c.id) === id)?.name || id;

  const focusedChat = focused ? chats.find((c) => (c.key || c.id) === focused) : null;

  const handleOpenFile = () => {
    if (!focusedChat) return;

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
    setFileOpen(true);
    setFilePromptOpen(false); // Close the path-entry Dialog
    setFileInput(''); // Clear file input to prevent both dialogs from showing
  };

  const handleFilePrompt = () => {
    if (!focusedChat) return;
    // Auto-fill with the chat's working directory if known
    const cwd = focusedChat.cwd || '.';
    setFileInput(`${cwd}/`);
    setFileInputError(''); // Clear any previous error
    setFileOpen(false);
    setSplitOpen(false); // Close split menu if open
    setFilePromptOpen(true); // Open the path-entry Dialog
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

  const visible = maximized ? tiles.filter((t) => t.id === maximized) : tiles;
  const n = visible.length;
  const cols = colsFor(n);
  const rows = n > 0 ? Math.ceil(n / cols) : 0;

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center px-3 py-2 border-b text-xs text-muted-foreground gap-2 shrink-0 relative">
        <span className="truncate">{focused ? nameOf(focused) : 'open a chat →'}</span>
        <span className="flex-1" />
        {focusedChat && (
          <Button variant="ghost" size="xs" onClick={handleFilePrompt} title="open file from chat directory">📄 file</Button>
        )}
        <Button variant="ghost" size="xs" onClick={() => setSplitOpen(!splitOpen)} title="split — open another chat as a pane">＋ split</Button>
        {splitOpen && (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setSplitOpen(false)} />
            <div className="absolute right-2 top-full mt-1 z-50 w-72 max-h-80 overflow-auto bg-popover border rounded-md shadow-lg p-1">
              {chats.filter((c) => c.active !== false).map((c) => (
                <button key={c.id} onClick={() => { onOpenChat(c.key || c.id); setSplitOpen(false); }}
                  className={`flex items-center gap-2 w-full text-left px-2 py-1.5 rounded text-xs hover:bg-accent active:bg-accent/80 transition-all duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background ${tiles.some(t => t.id === (c.key||c.id)) ? 'opacity-50' : ''}`}>
                  <span className="truncate flex-1">{c.name || c.key || c.id}</span>
                  <span className="text-[10px] text-muted-foreground">{c.host === '(local)' ? 'local' : c.host}</span>
                  {tiles.some(t => t.id === (c.key||c.id)) && <span className="text-[10px] text-green-500">open</span>}
                </button>
              ))}
              {chats.filter((c) => c.active !== false).length === 0 && <div className="text-xs text-muted-foreground p-2 text-center">no chats available</div>}
            </div>
          </>
        )}
      </div>
      <div className="flex-1 min-h-0 p-1">
        {n === 0 ? (
          <div className="text-xs text-muted-foreground p-8 text-center">click a chat to open a live pane</div>
        ) : (
          <div data-pane-grid className="grid gap-2 h-full min-h-0 transition-all duration-200 ease-in-out"
            style={{ gridTemplateColumns: `repeat(${maximized ? 1 : cols}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${maximized ? 1 : rows}, minmax(0, 1fr))` }}>
            {visible.map((t) => {
              const chat = chats.find((c) => (c.key || c.id) === t.id);
              return (
                <div key={t.id} data-pane-id={t.id} className="min-h-0 min-w-0">
                  <PaneTile id={t.id} label={nameOf(t.id)} focused={focused === t.id} maximized={maximized === t.id}
                    hasNew={newActivity.has(t.id)} onClearNew={() => onClearNew(t.id)}
                    onFocus={() => onFocus(t.id)} onClose={() => onClose(t.id)} onToggleMax={() => onToggleMax(t.id)}
                    onKill={() => onForceKill(t.id)} chat={chat} host={paneHost[t.id]}
                    externalSearchQuery={externalSearchQuery?.paneId === t.id ? externalSearchQuery.query : undefined}
                  />
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* File Viewer Dialog */}
      {focusedChat && filePath && (
        <FileViewer
          chatId={focusedChat.id}
          filePath={filePath}
          open={fileOpen}
          onOpenChange={(open) => {
            setFileOpen(open);
            if (!open) setFilePath(''); // Clear file path when dialog closes
          }}
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
            <DialogDescription>Working directory: {focusedChat?.cwd || '.'}</DialogDescription>
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
