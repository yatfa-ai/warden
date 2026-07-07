import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { streamApi } from '@/lib/stream';

interface Props {
  id: string;
  label?: string;
  focused: boolean;
  maximized: boolean;
  hasNew: boolean;
  onClearNew: () => void;
  onFocus: () => void;
  onClose: () => void;
  onToggleMax: () => void;
  onKill: () => void;     // force-kill the tmux session
}

export function PaneTile({ id, label, focused, maximized, hasNew, onClearNew, onFocus, onClose, onToggleMax, onKill }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const searchRef = useRef<SearchAddon | null>(null);
  const [fontSize, setFontSize] = useState(12);
  const [showSearch, setShowSearch] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const term = new Terminal({
      fontFamily: '"Cascadia Code", "JetBrains Mono", "Fira Code", "Symbols Nerd Font", ui-monospace, Menlo, Consolas, monospace',
      fontSize, convertEol: false, scrollback: 10000, cursorBlink: true,
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    const search = new SearchAddon();
    const unicode11 = new Unicode11Addon();
    term.loadAddon(fit);
    term.loadAddon(search);
    term.loadAddon(unicode11);
    term.unicode.activeVersion = '11';
    term.open(wrapRef.current!);
    termRef.current = term; fitRef.current = fit; searchRef.current = search;
    term.onData((d) => streamApi.send({ type: 'input', id, data: d }));
    term.onResize(() => streamApi.send({ type: 'resize', id, cols: term.cols, rows: term.rows }));
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true;
      const ctrl = e.ctrlKey || e.metaKey;
      if (!ctrl) return true;
      if (e.code === 'KeyC') { const s = term.getSelection(); if (s) { navigator.clipboard?.writeText(s).catch(() => {}); return false; } return true; }
      if (e.code === 'KeyV') {
        e.preventDefault();
        navigator.clipboard?.readText().then((t) => { if (t) streamApi.send({ type: 'input', id, data: t }); }).catch(() => {});
        return false;
      }
      return true;
    });
    const doFit = () => { try { fit.fit(); } catch {} };
    const ro = new ResizeObserver(doFit);
    ro.observe(wrapRef.current!);
    const t = setTimeout(doFit, 50);
    return () => { clearTimeout(t); ro.disconnect(); term.dispose(); termRef.current = null; };
  }, [id]);

  useEffect(() => {
    return streamApi.on(id, (m) => {
      const term = termRef.current; if (!term) return;
      if (m.type === 'pty') { term.write(m.data); setConnected(true); }
      else if (m.type === 'attached') setConnected(true);
      else if (m.type === 'ended') setConnected(false);
      else if (m.type === 'attach_error') { term.write('\r\n[error: ' + m.error + ']\r\n'); setConnected(false); }
    });
  }, [id]);

  useEffect(() => {
    const term = termRef.current; if (!term) return;
    try { fitRef.current?.fit(); } catch {}
    streamApi.send({ type: 'attach', id, cols: term.cols, rows: term.rows });
    return () => { streamApi.send({ type: 'detach', id }); };
  }, [id]);

  // clear "new" badge on focus
  useEffect(() => { if (focused && hasNew) onClearNew(); }, [focused]);

  // font size
  useEffect(() => { if (termRef.current) { termRef.current.options.fontSize = fontSize; try { fitRef.current?.fit(); } catch {} } }, [fontSize]);

  // search
  const doSearch = (dir: 'next' | 'prev') => {
    if (!searchRef.current || !searchQuery) return;
    if (dir === 'next') searchRef.current.findNext(searchQuery);
    else searchRef.current.findPrevious(searchQuery);
  };

  const stop = (e: React.MouseEvent) => e.stopPropagation();
  const Btn = ({ children, onClick, title, active }: { children: React.ReactNode; onClick: () => void; title: string; active?: boolean }) => (
    <button onClick={(e) => { stop(e); onClick(); }} title={title}
      className={`px-1 py-0.5 text-[10px] rounded ${active ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground hover:bg-accent/50'}`}>{children}</button>
  );

  return (
    <div onClick={onFocus}
      className={`flex flex-col h-full w-full min-h-0 rounded-lg overflow-hidden border bg-black ${focused ? 'border-primary' : 'border-border'}`}>
      {/* header toolbar */}
      <div onDoubleClick={(e) => { stop(e); onToggleMax(); }}
        className="flex items-center gap-1 px-2 py-1 bg-muted text-xs shrink-0 select-none">
        <span className={`size-2 rounded-full shrink-0 ${connected ? 'bg-green-500' : 'bg-red-500'}`} />
        <span className="truncate flex-1 font-medium">{label || id}</span>
        {hasNew && <span className="text-[9px] text-cyan-400 bg-cyan-500/10 px-1 rounded animate-pulse">new</span>}
        <Btn title="search" active={showSearch} onClick={() => setShowSearch(!showSearch)}>⌕</Btn>
        <Btn title="clear" onClick={() => termRef.current?.clear()}>⊘</Btn>
        <Btn title="force-kill tmux session" onClick={onKill}>⏹</Btn>
        <Btn title="smaller font" onClick={() => setFontSize((f) => Math.max(8, f - 1))}>A−</Btn>
        <Btn title="bigger font" onClick={() => setFontSize((f) => Math.min(24, f + 1))}>A+</Btn>
        <Btn title={maximized ? 'restore' : 'maximize'} onClick={onToggleMax}>{maximized ? '⤡' : '⤢'}</Btn>
        <Btn title="close" onClick={onClose}>×</Btn>
      </div>
      {/* search bar */}
      {showSearch && (
        <div className="flex items-center gap-1 px-2 py-1 bg-muted/80 border-b border-border/30 shrink-0">
          <input autoFocus value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') doSearch('next'); if (e.key === 'Escape') setShowSearch(false); }}
            placeholder="search…" className="flex-1 bg-background border rounded px-1.5 py-0.5 text-[11px]" />
          <Btn title="prev" onClick={() => doSearch('prev')}>↑</Btn>
          <Btn title="next" onClick={() => doSearch('next')}>↓</Btn>
          <Btn title="close search" onClick={() => setShowSearch(false)}>×</Btn>
        </div>
      )}
      <div ref={wrapRef} className="flex-1 min-h-0 px-1 py-0.5 overflow-hidden" onClick={() => termRef.current?.focus()} />
    </div>
  );
}
