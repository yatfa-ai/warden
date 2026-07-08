import { useEffect, useState } from 'react';
import { PaneTile } from './PaneTile';
import { FileViewer } from './FileViewer';
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
}

function colsFor(n: number) { return n <= 1 ? 1 : Math.ceil(Math.sqrt(n)); }

export function PaneGrid({ tiles, focused, maximized, newActivity, chats, paneHost, onFocus, onClose, onToggleMax, onClearNew, onOpenChat, onForceKill, externalSearchQuery }: Props) {
  const [splitOpen, setSplitOpen] = useState(false);
  const [fileOpen, setFileOpen] = useState(false);
  const [filePath, setFilePath] = useState('');
  const [fileInput, setFileInput] = useState('');
  const [fileInputError, setFileInputError] = useState('');
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
    setFileInput(''); // Clear file input to prevent both dialogs from showing
  };

  const handleFilePrompt = () => {
    if (!focusedChat) return;
    // Auto-fill with common files if cwd exists
    const cwd = focusedChat.cwd || '.';
    setFileInput(`${cwd}/`);
    setFileInputError(''); // Clear any previous error
    setFileOpen(false);
    setSplitOpen(false); // Close split menu if open
    // Focus on the file input (will be rendered in the dialog)
    (document.querySelector('[data-file-input]') as HTMLInputElement)?.focus();
  };

  // keyboard shortcuts: Alt+←/→ switch panes, Ctrl+W close
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.altKey && (e.code === 'ArrowLeft' || e.code === 'ArrowRight')) {
        if (!tiles.length) return;
        e.preventDefault();
        const ids = tiles.map((t) => t.id);
        const idx = focused ? ids.indexOf(focused) : -1;
        const dir = e.code === 'ArrowRight' ? 1 : -1;
        const next = ids[(idx + dir + ids.length) % ids.length];
        if (next) onFocus(next);
      }
      if (e.ctrlKey && e.code === 'KeyW' && focused) {
        e.preventDefault();
        onClose(focused);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [tiles, focused, onFocus, onClose]);

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
          <button onClick={handleFilePrompt} className="text-muted-foreground hover:text-foreground px-1.5 py-0.5 rounded hover:bg-accent/50 transition-all duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background" title="open file from chat directory">📄 file</button>
        )}
        <button onClick={() => setSplitOpen(!splitOpen)} className="text-muted-foreground hover:text-foreground px-1.5 py-0.5 rounded hover:bg-accent/50 transition-all duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background" title="split — open another chat as a pane">＋ split</button>
        {splitOpen && (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setSplitOpen(false)} />
            <div className="absolute right-2 top-full mt-1 z-50 w-72 max-h-80 overflow-auto bg-popover border rounded-md shadow-lg p-1">
              {chats.filter((c) => c.active !== false).map((c) => (
                <button key={c.id} onClick={() => { onOpenChat(c.key || c.id); setSplitOpen(false); }}
                  className={`flex items-center gap-2 w-full text-left px-2 py-1.5 rounded text-xs hover:bg-accent transition-all duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background ${tiles.some(t => t.id === (c.key||c.id)) ? 'opacity-50' : ''}`}>
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

      {/* File Path Input Dialog */}
      {fileInput && !fileOpen && focusedChat && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/10" onClick={() => setFileInput('')}>
          <div className="bg-popover border rounded-lg shadow-lg p-4 w-96" onClick={(e) => e.stopPropagation()}>
            <div className="text-sm font-medium mb-2">Open file from chat directory</div>
            <div className="text-xs text-muted-foreground mb-3">Working directory: {focusedChat.cwd || '.'}</div>
            <input
              data-file-input
              type="text"
              value={fileInput}
              onChange={(e) => { setFileInput(e.target.value); setFileInputError(''); }}
              onKeyDown={(e) => { if (e.key === 'Enter') handleOpenFile(); if (e.key === 'Escape') setFileInput(''); }}
              placeholder="relative/path/to/file.txt"
              className="w-full px-3 py-2 text-sm bg-muted border rounded-md focus:outline-none focus:ring-2 focus:ring-primary"
              autoFocus
            />
            {fileInputError && (
              <div className="text-xs text-red-400 mt-1">{fileInputError}</div>
            )}
            <div className="flex gap-2 mt-3 justify-end">
              <button onClick={() => setFileInput('')} className="px-3 py-1.5 text-sm rounded-md hover:bg-accent">Cancel</button>
              <button onClick={handleOpenFile} className="px-3 py-1.5 text-sm bg-primary text-primary-foreground rounded-md hover:bg-primary/90">Open</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
