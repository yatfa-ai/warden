import { useEffect, useRef, useState } from 'react';
import { Terminal, type ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { streamApi } from '@/lib/stream';
import type { Chat } from '@/lib/types';
import { findPathCandidates } from '@/lib/path-links';
import type { TerminalCursorStyle } from '@/lib/storage';
import { IconTooltip } from '@/components/ui/icon-tooltip';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from '@/components/ui/context-menu';
import { StatusDot } from '@/components/StatusDot';
import { FileViewer } from './FileViewer';
import { toast } from 'sonner';

// Two explicit xterm theme objects with hex values derived from the app's design
// tokens (web/src/index.css). xterm.js does not reliably parse oklch(), so we
// pass concrete hex rather than the raw token strings (nuance #2):
//   light : --background oklch(1 0 0) #ffffff  /  --foreground oklch(0.145 0 0) #0a0a0a
//   dark  : pure black (preserves the shipped dark terminal look + matches the
//           bg-black container so there is no seam in the padding gap)  /
//           --foreground oklch(0.985 0 0) #fafafa.
// The ANSI 16-color palette is left at xterm defaults so colored program output
// (red errors, green success, …) is unchanged; only the surface bg/fg/cursor +
// a subtle selection highlight are themed to match.
const TERMINAL_THEMES: Record<'light' | 'dark', ITheme> = {
  light: { background: '#ffffff', foreground: '#0a0a0a', cursor: '#0a0a0a', cursorAccent: '#ffffff', selectionBackground: 'rgba(10, 10, 10, 0.15)' },
  dark: { background: '#000000', foreground: '#fafafa', cursor: '#fafafa', cursorAccent: '#000000', selectionBackground: 'rgba(250, 250, 250, 0.20)' },
};

// Container background that wraps the xterm canvas. Must match the canvas
// background above so the px-1/py-0.5 padding gap around the terminal never shows
// a different color.
const TERMINAL_BG_CLASS: Record<'light' | 'dark', string> = { light: 'bg-white', dark: 'bg-black' };

// The open-on-click modifier matches VSCode: Cmd on macOS, Ctrl everywhere else.
const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPod|Pad/i.test(navigator.platform || navigator.userAgent || '');

// Map the persisted cursor-style pref to xterm's `cursorStyle` + `cursorBlink`
// options. A Record keyed by the full union makes this exhaustive — add a union
// member and TypeScript errors here until it's mapped. 'blink-block' is the
// default and reproduces today's exact cursor (block + blink) so an upgrade is a
// no-op visually. Read in both the constructor (mount) and the live-updating
// effect below so a mid-session change applies to already-open panes.
const CURSOR_OPTIONS: Record<TerminalCursorStyle, { cursorStyle: 'block' | 'underline' | 'bar'; cursorBlink: boolean }> = {
  'blink-block': { cursorStyle: 'block', cursorBlink: true },
  'steady-block': { cursorStyle: 'block', cursorBlink: false },
  'blink-underline': { cursorStyle: 'underline', cursorBlink: true },
  'steady-underline': { cursorStyle: 'underline', cursorBlink: false },
  'blink-bar': { cursorStyle: 'bar', cursorBlink: true },
  'steady-bar': { cursorStyle: 'bar', cursorBlink: false },
};

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
  chat?: Chat | null;     // chat metadata for export
  host?: string;          // host hint for restore (which host to discover)
  externalSearchQuery?: string;  // external search trigger from global search
  fontSize: number;       // global, persisted terminal font size (UiState)
  onFontSizeChange: (n: number) => void;  // bump the shared global preference
  scrollback: number;     // global, persisted terminal scrollback depth (UiState)
  // Resolved terminal surface color (App resolves the terminalColorScheme pref +
  // the effective app theme down to a concrete value here). Drives the xterm
  // `theme` option + the container background, and re-themes already-open panes
  // live via the [terminalTheme] effect below.
  terminalTheme: 'light' | 'dark';
  // Terminal cursor shape × blink (blink/steady × block/underline/bar). Drives
  // the xterm `cursorStyle` + `cursorBlink` options. A 'steady-*' value stops the
  // blink — the accessibility payoff vs WARDEN-190 — and applies live to already-
  // open panes via the [terminalCursorStyle] effect below.
  terminalCursorStyle: TerminalCursorStyle;
}

export function PaneTile({ id, label, focused, maximized, hasNew, onClearNew, onFocus, onClose, onToggleMax, onKill, chat, host, externalSearchQuery, fontSize, onFontSizeChange, scrollback, terminalTheme, terminalCursorStyle }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const searchRef = useRef<SearchAddon | null>(null);
  const [showSearch, setShowSearch] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [connected, setConnected] = useState(false);
  const [errored, setErrored] = useState(false);
  const [downloading, setDownloading] = useState(false);

  // WARDEN-227: in-terminal clickable file paths.
  // Existence is probed once per resolved path (cached) so scrolling back over the
  // same output never re-probes. Per-pane so each pane resolves against its OWN
  // chat's cwd (the `id` resolves to this pane's chat on the backend).
  const existsCacheRef = useRef<Map<string, boolean>>(new Map());
  const existsPendingRef = useRef<Map<string, Promise<boolean>>>(new Map());
  const tooltipElRef = useRef<HTMLDivElement | null>(null);
  const hoveredPathRef = useRef<string | null>(null);
  // Per-pane FileViewer bound to THIS pane's chat — a Ctrl/Cmd+clicked path opens
  // here, never assuming the focused pane (AC: correct id/cwd per pane).
  const [viewerOpen, setViewerOpen] = useState(false);
  const [viewerPath, setViewerPath] = useState('');
  const [viewerLine, setViewerLine] = useState<number | undefined>(undefined);

  // Defensive clamp: the global font size can briefly fall outside 8–24 while a
  // user types into the Settings field (coerced on blur). xterm must never receive
  // an out-of-range size, so bound it at the use site — both the constructor
  // (mount) and the live [fontSize] effect read this clamped value.
  const safeFontSize = Math.max(8, Math.min(24, Math.round(fontSize)));

  // Defensive clamp mirroring safeFontSize: a value typed into Settings can
  // briefly fall outside the 100–100000 bounds before the blur coercion runs.
  // xterm must never receive an out-of-range scrollback, so bound it here too.
  const safeScrollback = Math.max(100, Math.min(100000, Math.round(scrollback)));

  useEffect(() => {
    const term = new Terminal({
      fontFamily: '"Cascadia Code", "JetBrains Mono", "Fira Code", "Symbols Nerd Font", ui-monospace, Menlo, Consolas, monospace',
      fontSize: safeFontSize, convertEol: false, scrollback: safeScrollback,
      cursorBlink: CURSOR_OPTIONS[terminalCursorStyle].cursorBlink,
      cursorStyle: CURSOR_OPTIONS[terminalCursorStyle].cursorStyle,
      allowProposedApi: true,
      theme: TERMINAL_THEMES[terminalTheme],
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
      if (e.code === 'KeyC') {
        const s = term.getSelection();
        if (s) {
          // Use execCommand fallback (navigator.clipboard fails silently in Electron)
          const ta = document.createElement('textarea');
          ta.value = s; ta.style.position = 'fixed'; ta.style.opacity = '0';
          document.body.appendChild(ta); ta.select();
          try { document.execCommand('copy'); } catch {}
          document.body.removeChild(ta);
          return false;
        }
        return true;
      }
      if (e.code === 'KeyV') {
        e.preventDefault();
        navigator.clipboard?.readText().then((t) => { if (t) streamApi.send({ type: 'input', id, data: t }); }).catch(() => {
          // Electron fallback: read from a paste event
          const ta = document.createElement('textarea');
          ta.style.position = 'fixed'; ta.style.opacity = '0';
          document.body.appendChild(ta); ta.focus();
          document.execCommand('paste');
          setTimeout(() => { if (ta.value) streamApi.send({ type: 'input', id, data: ta.value }); document.body.removeChild(ta); }, 100);
        });
        return false;
      }
      return true;
    });

    // --- WARDEN-227: Ctrl/Cmd-clickable file paths in the live terminal --------
    // Reset the per-chat existence cache for this term instance — a different `id`
    // means a different cwd, so prior results must not carry over.
    existsCacheRef.current.clear();
    existsPendingRef.current.clear();

    // Confirm a candidate path resolves to a real file under THIS pane's chat cwd
    // (id resolves to this pane's chat on the backend). Cached per path so the same
    // output never re-probes as you scroll; in-flight probes are deduped.
    const checkExists = (path: string): Promise<boolean> => {
      const cache = existsCacheRef.current;
      const pending = existsPendingRef.current;
      if (cache.has(path)) return Promise.resolve(cache.get(path) === true);
      if (pending.has(path)) return pending.get(path)!;
      const p = (async () => {
        try {
          const res = await fetch('/api/file-exists', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id, path }),
          });
          if (!res.ok) { cache.set(path, false); return false; }
          const data = await res.json();
          const ok = !!data.exists;
          cache.set(path, ok);
          return ok;
        } catch {
          cache.set(path, false);
          return false;
        }
      })();
      pending.set(path, p);
      p.finally(() => pending.delete(path));
      return p;
    };

    const showTooltip = (event: MouseEvent) => {
      let el = tooltipElRef.current;
      if (!el) {
        el = document.createElement('div');
        // pointer-events-none so the cursor passes straight through to xterm —
        // the link's hover/leave then fire normally instead of flickering on/off
        // as the cursor crosses the tooltip.
        el.className = 'fixed z-[9999] pointer-events-none px-2 py-1 rounded-md border bg-popover text-popover-foreground text-[11px] shadow-md';
        el.textContent = isMac ? '⌘+Click to open file' : 'Ctrl+Click to open file';
        tooltipElRef.current = el;
      }
      el.style.left = `${event.clientX + 12}px`;
      el.style.top = `${event.clientY + 12}px`;
      if (!el.isConnected) document.body.appendChild(el);
    };
    const hideTooltip = () => {
      const el = tooltipElRef.current;
      if (el && el.isConnected) el.remove();
    };

    // xterm calls provideLinks only for visible viewport lines (lazy), so existence
    // probes are inherently limited to what's on screen. Each candidate starts with
    // NO decorations and the (mutable, tracked) decorations object flips to
    // underline+pointer once the async check confirms a real file — non-blocking.
    const linkProvider = term.registerLinkProvider({
      provideLinks(bufferLineNumber: number, callback) {
        // bufferLineNumber is 1-based (matches the range `y`); buffer line indexing
        // is 0-based, so fetch line (bufferLineNumber - 1). (Mirrors xterm's own
        // WebLinks addon: lines.get(e - 1).)
        const lineObj = term.buffer.active.getLine(bufferLineNumber - 1);
        if (!lineObj) { callback(undefined); return; }
        const text = lineObj.translateToString(true);
        const candidates = findPathCandidates(text);
        if (!candidates.length) { callback(undefined); return; }
        const links = candidates.map((c) => {
          const decorations = { underline: false, pointerCursor: false };
          const cached = existsCacheRef.current.get(c.path);
          if (cached === true) { decorations.underline = true; decorations.pointerCursor = true; }
          else if (cached === undefined) {
            // Probe; flip the tracked decorations on success. If the link was
            // disposed first (scrolled away) the mutation is a harmless no-op and
            // the cache is now warm for when it scrolls back into view.
            checkExists(c.path).then((ok) => {
              if (ok) { decorations.underline = true; decorations.pointerCursor = true; }
            });
          }
          return {
            range: {
              start: { x: c.start + 1, y: bufferLineNumber },
              end: { x: c.start + c.length, y: bufferLineNumber },
            },
            text: text.slice(c.start, c.start + c.length),
            decorations,
            activate(event: MouseEvent) {
              // Only the modifier-click opens. A plain click is left to fall through
              // to xterm's own handling (a click without a drag selects nothing).
              if (!(event.metaKey || event.ctrlKey)) return;
              checkExists(c.path).then((ok) => {
                if (!ok) return;
                setViewerPath(c.path);
                setViewerLine(c.line);
                setViewerOpen(true);
              });
            },
            hover(event: MouseEvent) {
              hoveredPathRef.current = c.path;
              checkExists(c.path).then((ok) => {
                // Only show the affordance+tooltip for confirmed files, and only if
                // the cursor is still over this path (guard against a slow probe
                // resolving after the cursor already left).
                if (ok && hoveredPathRef.current === c.path) showTooltip(event);
              });
            },
            leave() {
              if (hoveredPathRef.current === c.path) hoveredPathRef.current = null;
              hideTooltip();
            },
          };
        });
        callback(links);
      },
    });

    const doFit = () => { try { fit.fit(); } catch {} };
    const ro = new ResizeObserver(doFit);
    ro.observe(wrapRef.current!);
    const t = setTimeout(doFit, 50);
    return () => {
      clearTimeout(t); ro.disconnect();
      linkProvider.dispose(); hideTooltip();
      if (tooltipElRef.current) tooltipElRef.current = null;
      term.dispose(); termRef.current = null;
    };
  }, [id]);

  useEffect(() => {
    return streamApi.on(id, (m) => {
      const term = termRef.current; if (!term) return;
      if (m.type === 'pty') { term.write(m.data); setConnected(true); setErrored(false); }
      else if (m.type === 'attached') { setConnected(true); setErrored(false); }
      else if (m.type === 'ended') setConnected(false);
      else if (m.type === 'attach_error') { term.write('\r\n[error: ' + m.error + ']\r\n'); setConnected(false); setErrored(true); }
    });
  }, [id]);

  useEffect(() => {
    const term = termRef.current; if (!term) return;
    setConnected(false); setErrored(false);
    try { fitRef.current?.fit(); } catch {}
    streamApi.send({ type: 'attach', id, host, cols: term.cols, rows: term.rows });
    return () => { streamApi.send({ type: 'detach', id }); };
  }, [id, host]);

  // clear "new" badge on focus
  useEffect(() => { if (focused && hasNew) onClearNew(); }, [focused]);

  // font size — and best-effort live scrollback update. xterm v6 reliably honors
  // a scrollback change on (re)construction but often ignores it on an already-
  // buffered terminal; new panes always pick up the new value, existing open
  // panes pick it up on reopen. Setting options.scrollback here is harmless and
  // covers the cases where xterm does accept the live change.
  useEffect(() => { if (termRef.current) { termRef.current.options.fontSize = safeFontSize; termRef.current.options.scrollback = safeScrollback; try { fitRef.current?.fit(); } catch {} } }, [safeFontSize, safeScrollback]);

  // terminal theme (App-resolved terminalColorScheme + effective theme) — re-theme
  // already-open panes live without a reopen, mirroring the font-size/scrollback
  // live effect. Fires on mount (initial paint already happened via the ctor, but
  // this also covers the first render) and whenever the resolved color changes —
  // including a manual Color Scheme toggle, the Terminal color scheme pref, or an
  // OS theme flip while Color Scheme = "Match app theme" (App tracks an
  // effectiveTheme React state so the prop actually changes here).
  useEffect(() => { if (termRef.current) { termRef.current.options.theme = TERMINAL_THEMES[terminalTheme]; try { fitRef.current?.fit(); } catch {} } }, [terminalTheme]);

  // cursor style + blink — live-update already-open panes so a `steady-*`
  // selection stops the blink immediately. This is the accessibility payoff vs
  // WARDEN-190, whose reduced-motion work was CSS + scroll only and never reached
  // xterm's independently-timed cursor blink. The constructor seeds the value at
  // mount; this effect mirrors the [terminalTheme] live option update above so a
  // mid-session change applies without a reopen (and newly-opened panes honor it
  // from the constructor).
  useEffect(() => {
    if (termRef.current) {
      const o = CURSOR_OPTIONS[terminalCursorStyle];
      termRef.current.options.cursorStyle = o.cursorStyle;
      termRef.current.options.cursorBlink = o.cursorBlink;
    }
  }, [terminalCursorStyle]);

  // external search trigger from global search
  useEffect(() => {
    if (externalSearchQuery && searchRef.current) {
      setSearchQuery(externalSearchQuery);
      setShowSearch(true);
      setTimeout(() => searchRef.current?.findNext(externalSearchQuery), 100);
    }
  }, [externalSearchQuery]);

  // search
  const doSearch = (dir: 'next' | 'prev') => {
    if (!searchRef.current || !searchQuery) return;
    if (dir === 'next') searchRef.current.findNext(searchQuery);
    else searchRef.current.findPrevious(searchQuery);
  };

  // download pane content as text file with metadata
  const downloadPane = async () => {
    if (!chat || downloading) return;
    setDownloading(true);
    try {
      const res = await fetch(`/api/pane-export?id=${encodeURIComponent(chat.id)}`);
      if (!res.ok) throw new Error('Failed to fetch pane content');
      const data = await res.json();

      // Build metadata header
      const header = [
        `Chat: ${data.meta.name}`,
        `Host: ${data.meta.host}`,
        `Container: ${data.meta.container || 'N/A'}`,
        `Session: ${data.meta.session || 'N/A'}`,
        `Project: ${data.meta.project || 'N/A'}`,
        `Role: ${data.meta.role || 'N/A'}`,
        `Type: ${data.meta.kind || 'N/A'}`,
        `Timestamp: ${data.meta.timestamp}`,
        '---',
        '',
      ].join('\n');

      // Sanitize filename
      const sanitizedName = (data.meta.name || chat.id).replace(/[^a-zA-Z0-9_.-]/g, '_');
      const ts = new Date().toISOString().replace(/[:.]/g, '').split('T')[0] + '_' +
                 new Date().toTimeString().split(' ')[0].replace(/:/g, '');
      const filename = `${sanitizedName}_${ts}.txt`;

      // Create download
      const blob = new Blob([header + data.pane], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error('Download failed:', err);
      toast.error('Failed to download pane content');
    } finally {
      setDownloading(false);
    }
  };

  const stop = (e: React.MouseEvent) => e.stopPropagation();
  const Btn = ({ children, onClick, title, active, disabled }: { children: React.ReactNode; onClick: () => void; title: string; active?: boolean; disabled?: boolean }) => (
    <IconTooltip label={title} side="bottom" disabled={disabled}>
      <button onClick={(e) => { if (!disabled) { stop(e); onClick(); } }} disabled={disabled}
        className={`px-1 py-0.5 text-[10px] rounded active:scale-95 transition-all duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background ${disabled ? 'text-muted-foreground opacity-30 cursor-not-allowed' : (active ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground hover:bg-accent/50')}`}>{children}</button>
    </IconTooltip>
  );

  return (
    <>
    <ContextMenu>
      <ContextMenuTrigger asChild>
    <div onClick={onFocus}
      className={`flex flex-col h-full w-full min-h-0 rounded-lg overflow-hidden border ${TERMINAL_BG_CLASS[terminalTheme]} transition-all duration-200 ease-in-out ${focused ? 'border-primary shadow-lg shadow-primary/20' : 'border-border'}`}>
      {/* header toolbar */}
      <div onDoubleClick={(e) => { stop(e); onToggleMax(); }}
        className="flex items-center gap-1 px-2 py-1 compact:py-0.5 bg-muted text-xs shrink-0 select-none">
        <StatusDot
          tone={connected ? 'green' : errored ? 'red' : 'yellow'}
          variant={connected ? 'solid' : errored ? 'square' : 'pulse'}
          label={connected ? 'Connected' : errored ? 'Error' : 'Connecting'}
        />
        <span className="truncate flex-1 font-medium">{label || id}</span>
        {hasNew && <span className="text-[9px] text-cyan-400 bg-cyan-500/10 px-1 rounded animate-pulse">new</span>}
        <Btn title="search" active={showSearch} onClick={() => setShowSearch(!showSearch)}>⌕</Btn>
        <Btn title="clear" onClick={() => termRef.current?.clear()}>⊘</Btn>
        <Btn title="download as text file" onClick={downloadPane} disabled={downloading || !chat}>
          {downloading ? '⋯' : '⬇'}
        </Btn>
        <Btn title="force-kill tmux session" onClick={onKill}>⏹</Btn>
        <Btn title="smaller font" onClick={() => onFontSizeChange(Math.max(8, safeFontSize - 1))}>A−</Btn>
        <Btn title="bigger font" onClick={() => onFontSizeChange(Math.min(24, safeFontSize + 1))}>A+</Btn>
        <Btn title={maximized ? 'restore' : 'maximize'} onClick={onToggleMax}>{maximized ? '⤡' : '⤢'}</Btn>
        <Btn title="close" onClick={onClose}>×</Btn>
      </div>
      {/* search bar */}
      {showSearch && (
        <div className="flex items-center gap-1 px-2 py-1 compact:py-0.5 bg-muted/80 border-b border-border/30 shrink-0">
          <input autoFocus value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') doSearch('next'); if (e.key === 'Escape') setShowSearch(false); }}
            placeholder="search…" className="flex-1 bg-background border rounded px-1.5 py-0.5 text-[11px]" />
          <Btn title="prev" onClick={() => doSearch('prev')}>↑</Btn>
          <Btn title="next" onClick={() => doSearch('next')}>↓</Btn>
          <Btn title="close search" onClick={() => setShowSearch(false)}>×</Btn>
        </div>
      )}
      {/* terminal surface — stop the contextmenu event so right-clicks here keep the xterm
          native paste menu instead of opening the themed pane menu (see Done criterion). */}
      <div ref={wrapRef} className="flex-1 min-h-0 px-1 py-0.5 overflow-hidden relative" onContextMenu={(e) => e.stopPropagation()} onClick={() => termRef.current?.focus()}>
        {!connected && !errored && (
          <div className="absolute inset-0 flex items-center justify-center gap-2 text-[11px] text-muted-foreground pointer-events-none select-none">
            <span className="size-3 rounded-full border-2 border-muted-foreground/30 border-t-muted-foreground animate-spin" />
            connecting…
          </div>
        )}
      </div>
    </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={() => setShowSearch(!showSearch)}>Search</ContextMenuItem>
        <ContextMenuItem onSelect={() => termRef.current?.clear()}>Clear</ContextMenuItem>
        <ContextMenuItem disabled={downloading || !chat} onSelect={() => downloadPane()}>Download</ContextMenuItem>
        <ContextMenuItem variant="destructive" onSelect={() => onKill()}>Force-kill</ContextMenuItem>
        <ContextMenuItem onSelect={() => onFontSizeChange(Math.max(8, safeFontSize - 1))}>Smaller font</ContextMenuItem>
        <ContextMenuItem onSelect={() => onFontSizeChange(Math.min(24, safeFontSize + 1))}>Bigger font</ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => onToggleMax()}>{maximized ? 'Restore' : 'Maximize'}</ContextMenuItem>
        <ContextMenuItem variant="destructive" onSelect={() => onClose()}>Close</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
      {/* WARDEN-227: per-pane file viewer opened by Ctrl/Cmd+clicking a path in
          this pane's own terminal. Bound to THIS pane's chat so the file resolves
          against this pane's cwd, not necessarily the focused pane. */}
      {chat && (
        <FileViewer
          chatId={chat.id}
          filePath={viewerPath}
          line={viewerLine}
          open={viewerOpen}
          onOpenChange={(o) => { setViewerOpen(o); if (!o) { setViewerPath(''); setViewerLine(undefined); } }}
        />
      )}
    </>
  );
}
