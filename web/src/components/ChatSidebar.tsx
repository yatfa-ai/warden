import { useState } from 'react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { NewChatForm } from './NewChatForm';
import type { Chat } from '@/lib/types';

export interface ClaudeSession { id: string; cwd: string; summary: string; mtime: number }

interface Props {
  chats: Chat[];
  sshHosts: string[];
  activeTabs: string[];
  hiddenTabs: string[];
  openPanes: Set<string>;
  onOpenChat: (id: string) => void;
  onClosePane: (id: string) => void;
  onRemoveActive: (id: string) => void;
  onHideTab: (id: string) => void;
  onUnhideTab: (id: string) => void;
  onKill: (id: string) => void;
  onRename: (session: string, kind: string, name: string) => void;
  onResume: (id: string, description: string, cwd: string, host: string) => void;
  onRefresh: () => void;
  loading: boolean;
}

const THIS_MACHINE = '(local)';
const LABEL: Record<string, string> = { '(local)': 'this machine' };
function ago(ms: number) {
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}
function basename(p: string) { return (p || '').replace(/[\\/]+/g, '/').replace(/\/$/, '').split('/').pop() || p; }
function chatType(c?: Chat): string {
  if (!c) return '?';
  if (c.kind === 'yatfa') return 'yatfa';
  const bin = (c.cmd || '').split(/\s+/)[0].replace(/^.*[/\\]/, '');
  if (bin === 'claude' || bin === 'claude.exe') return (c.cmd || '').includes('--resume') ? 'resume' : 'claude';
  if (['bash', 'sh', 'zsh', 'fish', 'pwsh', 'powershell', 'cmd.exe'].includes(bin)) return 'shell';
  return bin || 'manual';
}
const TYPE_COLOR: Record<string, string> = {
  resume: 'text-cyan-400', claude: 'text-green-400', shell: 'text-yellow-400',
  yatfa: 'text-blue-400', manual: 'text-violet-400', '?': 'text-muted-foreground',
};

function findChat(chats: Chat[], id: string) { return chats.find((c) => (c.key || c.id) === id); }

export function ChatSidebar({ chats, sshHosts, activeTabs, hiddenTabs, openPanes, onOpenChat, onRemoveActive, onHideTab, onUnhideTab, onKill, onRename, onResume, onRefresh, loading }: Props) {
  const [view, setView] = useState<{ kind: 'root' } | { kind: 'host'; host: string }>({ kind: 'root' });
  const [hiddenExpanded, setHiddenExpanded] = useState(false);
  const [hostSessions, setHostSessions] = useState<Record<string, { sessions: ClaudeSession[]; claudeAvailable?: boolean }>>({});
  const [loadingHost, setLoadingHost] = useState<string | null>(null);

  const fetchHostSessions = async (host: string) => {
    setLoadingHost(host);
    try {
      const r = await fetch(`/api/claude-sessions?host=${encodeURIComponent(host)}`);
      const j = await r.json();
      setHostSessions((p) => ({ ...p, [host]: { sessions: j.sessions || [], claudeAvailable: j.claudeAvailable } }));
    } catch { /* noop */ }
    setLoadingHost(null);
  };
  const enterHost = (host: string) => { setView({ kind: 'host', host }); fetchHostSessions(host); };

  const handleSpawned = (chat: Chat) => { onRefresh(); onOpenChat(chat.key || chat.id); setView({ kind: 'root' }); };
  const hosts = [THIS_MACHINE, ...sshHosts];

  if (view.kind === 'host') {
    const H = view.host;
    const hostChats = chats.filter((c) => c.host === H);
    const active = hostChats.filter((c) => c.active);
    const idle = hostChats.filter((c) => !c.active);
    const visibleActive = active.filter((c) => !hiddenTabs.includes(c.key || c.id));
    const hiddenActive = active.filter((c) => hiddenTabs.includes(c.key || c.id));
    const info = hostSessions[H] || {};
    const sessions = info.sessions || [];
    const openFromHost = (key: string) => { onOpenChat(key); setView({ kind: 'root' }); };
    return (
      <div className="flex flex-col h-full min-h-0 animate-in slide-in-from-right-2 duration-150">
        <div className="flex items-center gap-2 px-2 py-2 border-b shrink-0">
          <button className="text-xs text-muted-foreground hover:text-foreground px-1" onClick={() => setView({ kind: 'root' })} title="back">‹</button>
          <span className="text-xs font-medium flex-1 truncate">{LABEL[H] || H}</span>
          <button className="text-xs text-muted-foreground hover:text-foreground" onClick={() => fetchHostSessions(H)} disabled={loadingHost === H} title="rescan">{loadingHost === H ? '…' : '↻'}</button>
        </div>
        <ScrollArea className="flex-1 min-h-0">
          <div className="p-1.5 flex flex-col gap-0.5">
            {(visibleActive.length > 0 || idle.length > 0 || hiddenActive.length > 0) && (
              <div className="px-2 pt-1 pb-1 text-[10px] uppercase tracking-wider text-green-500/80 font-semibold">● live (tmux)</div>
            )}
            {visibleActive.map((c) => <ChatRow key={c.id} c={c} open={openPanes.has(c.key || c.id)} onOpen={() => openFromHost(c.key || c.id)} onKill={() => onKill(c.key || c.id)} onRename={onRename} onHide={() => onHideTab(c.key || c.id)} />)}
            {hiddenActive.length > 0 && (
              <>
                <button onClick={() => setHiddenExpanded(!hiddenExpanded)} className="flex items-center gap-1 px-2 pt-2 pb-1 text-[10px] uppercase tracking-wider text-muted-foreground/60 hover:text-foreground w-full">
                  <span>{hiddenExpanded ? '▾' : '▸'}</span>
                  <span>hidden ({hiddenActive.length})</span>
                </button>
                {hiddenExpanded && hiddenActive.map((c) => (
                  <ChatRow key={c.id} c={c} open={openPanes.has(c.key || c.id)} onOpen={() => openFromHost(c.key || c.id)} onKill={() => onKill(c.key || c.id)} onRename={onRename} onUnhide={() => onUnhideTab(c.key || c.id)} dim />
                ))}
              </>
            )}
            {idle.length > 0 && (
              <>
                <div className="px-2 pt-2 pb-1 text-[10px] uppercase tracking-wider text-muted-foreground/60">idle</div>
                {idle.map((c) => <ChatRow key={c.id} c={c} open={openPanes.has(c.key || c.id)} onOpen={() => openFromHost(c.key || c.id)} onKill={() => onKill(c.key || c.id)} onRename={onRename} dim />)}
              </>
            )}
            <div className="mt-3 mb-1 border-t border-border/50" />
            {H !== THIS_MACHINE && loadingHost === H && !sessions.length && (
              <div className="text-xs text-muted-foreground p-3 text-center">scanning sessions…</div>
            )}
            {info.claudeAvailable === false && (
              <div className="mx-1 my-2 px-2 py-2 text-[11px] text-yellow-400 bg-yellow-500/10 border border-yellow-500/30 rounded-md">
                ⚠ claude not found on {LABEL[H] || H} — install it to resume sessions here.
              </div>
            )}
            <div className="px-2 pt-1 pb-1 text-[10px] uppercase tracking-wider text-cyan-500/80 font-semibold">☁ sessions (history — click to resume)</div>
            {sessions.slice(0, 12).map((s) => {
              const running = hostChats.some((c) => c.key === `resume-${s.id.slice(0, 8)}`);
              return (
                <button key={s.id} onClick={() => { onResume(s.id, s.summary, s.cwd, H); setView({ kind: 'root' }); }} className="flex flex-col gap-0.5 px-2 py-1.5 rounded-md text-left text-xs hover:bg-accent" title={`resume ${s.id}\n${s.cwd}`}>
                  <span className="truncate">{s.summary || <span className="text-muted-foreground">(no summary)</span>}{running && <span className="ml-1 text-green-400">● live</span>}</span>
                  <span className="text-[10px] text-muted-foreground truncate">{ago(s.mtime)} · {basename(s.cwd)}</span>
                </button>
              );
            })}
            {hostChats.length === 0 && sessions.length === 0 && loadingHost !== H && (
              <div className="text-xs text-muted-foreground p-3 text-center">nothing here</div>
            )}
          </div>
        </ScrollArea>
      </div>
    );
  }

  // ROOT VIEW — persistent active tabs + hosts
  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center gap-2 px-3 py-2 border-b shrink-0">
        <span className="text-xs text-muted-foreground flex-1">active</span>
        <Badge variant="secondary" className="text-xs">{activeTabs.length}</Badge>
        <button className="text-xs text-muted-foreground hover:text-foreground" onClick={onRefresh} disabled={loading}>{loading ? '…' : '↻'}</button>
      </div>
      <NewChatForm onSpawned={handleSpawned} />
      <ScrollArea className="flex-1 min-h-0">
        <div className="p-1.5 flex flex-col gap-0.5">
          {activeTabs.length > 0 && (
            <div className="px-2 pt-1 pb-1 text-[10px] uppercase tracking-wider text-green-500/80 font-semibold">tabs</div>
          )}
          {activeTabs.map((id) => {
            const c = findChat(chats, id);
            const type = chatType(c);
            const isOpen = openPanes.has(id);
            const hostTag = c ? (c.host === THIS_MACHINE ? 'local' : c.host) : '';
            return (
              <div key={id} onClick={() => onOpenChat(id)} className="group flex items-center gap-2 px-2 py-1.5 rounded-md text-left text-xs hover:bg-accent cursor-pointer">
                <span className={`size-2 rounded-full shrink-0 ${isOpen ? 'bg-green-500' : 'bg-muted-foreground/40'}`} title={isOpen ? 'pane open' : 'click to open pane'} />
                <span className="truncate flex-1">{c?.name || id}</span>
                <span className={`text-[10px] ${TYPE_COLOR[type] || ''}`}>{type}</span>
                {hostTag && <span className="text-[10px] text-muted-foreground">{hostTag}</span>}
                <button className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-red-500 px-0.5" title="remove from active" onClick={(e) => { e.stopPropagation(); onRemoveActive(id); }}>×</button>
              </div>
            );
          })}
          {activeTabs.length === 0 && (
            <div className="text-xs text-muted-foreground p-3 text-center">no tabs — browse hosts below</div>
          )}
          <div className="mt-3 mb-1 border-t border-border/50" />
          <div className="px-2 pt-1 pb-1 text-[10px] uppercase tracking-wider text-muted-foreground/60">hosts</div>
          {hosts.map((h) => {
            const n = chats.filter((c) => c.host === h && c.active).length;
            return (
              <button key={h} onClick={() => enterHost(h)} className="flex items-center gap-2 px-2 py-1.5 rounded-md text-left text-xs hover:bg-accent w-full">
                <span className={`size-2 rounded-full ${n ? 'bg-green-500' : 'bg-muted-foreground/40'}`} />
                <span className="flex-1 truncate">{LABEL[h] || h}</span>
                {h === THIS_MACHINE && <span className="text-[10px] text-cyan-400">local</span>}
                {n > 0 && <span className="text-[10px] text-muted-foreground">{n}</span>}
                <span className="text-muted-foreground/60">›</span>
              </button>
            );
          })}
        </div>
      </ScrollArea>
    </div>
  );
}

function ChatRow({ c, open, onOpen, onKill, onRename, onHide, onUnhide, dim }: {
  c: Chat; open: boolean; onOpen: () => void; onKill: () => void;
  onRename: (session: string, kind: string, name: string) => void;
  onHide?: () => void; onUnhide?: () => void; dim?: boolean;
}) {
  const isUser = c.kind === 'tmux';
  const canRename = isUser;
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(c.name || c.key || c.id);
  const type = chatType(c);
  const typeColor = TYPE_COLOR[type] || 'text-violet-400';
  const hostTag = isUser ? (c.host === '(local)' ? 'local' : (c.host || '')) : null;
  const commit = () => { setEditing(false); const v = val.trim(); if (v && v !== (c.name || c.key)) onRename(c.key || c.id, c.kind || 'tmux', v); };

  return (
    <div
      data-chat-key={c.key || c.id}
      onClick={onOpen}
      className={`group flex items-center gap-2 px-2 py-1.5 rounded-md text-left text-xs hover:bg-accent cursor-pointer ${open ? 'bg-accent' : ''} ${dim ? 'opacity-60' : ''}`}
    >
      <span className={`size-2 rounded-full shrink-0 ${open ? 'bg-green-500' : c.active ? 'bg-green-500/50' : 'bg-muted-foreground/40'}`} />
      {editing ? (
        <Input autoFocus value={val} onClick={(e) => e.stopPropagation()} onChange={(e) => setVal(e.target.value)} onBlur={commit} onKeyDown={(e) => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') { setVal(c.name || c.key || c.id); setEditing(false); } }} className="h-5 text-[11px] px-1 flex-1" />
      ) : (
        <span className="truncate flex-1" onDoubleClick={(e) => { if (canRename) { e.stopPropagation(); setVal(c.name || c.key || c.id); setEditing(true); } }} title={canRename ? 'double-click to rename' : undefined}>
          {c.name || c.key || c.id}
          <span className={`ml-1 text-[10px] ${typeColor}`}>{type}</span>
          {c.role && !isUser && <span className="ml-1 text-[10px] text-muted-foreground">{c.role}</span>}
          {isUser && hostTag && <span className="ml-1 text-[10px] text-muted-foreground">{hostTag}</span>}
        </span>
      )}
      {isUser && !editing && (
        <>
          {onHide && <button className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-foreground px-0.5" title="hide" onClick={(e) => { e.stopPropagation(); onHide(); }}>▾</button>}
          {onUnhide && <button className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-foreground px-0.5" title="unhide" onClick={(e) => { e.stopPropagation(); onUnhide(); }}>▴</button>}
          <button className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-red-500 px-0.5" title="kill + forget" onClick={(e) => { e.stopPropagation(); onKill(); }}>×</button>
        </>
      )}
    </div>
  );
}
