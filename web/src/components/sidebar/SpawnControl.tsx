// Spawn control — job A of the rebuilt sidebar (WARDEN-1422): start a session,
// a plain shell, like opening a terminal in VS Code. host ▾ + directory +
// optional name + Start shell. No toggle, no prompt field, no launch mode.
//
// THE COLLAPSED CONTROL MUST NOT LIE: it shows exactly what it opens —
// `host ▾ | ~/dir | + shell` — and nothing it cannot deliver (the old collapsed
// form advertised a prompt field the expanded form did not have; that
// affordance died with the Claude launch mode).
//
// The optional name is the temporary/persistent decision: unnamed shells are
// temporary (they run as a pane and are never listed); a named shell is saved
// under its host and comes back in the saved list. The helper copy states that
// model in words, because nothing else in the UI explains it.

import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronDown, Plus, Server } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { IconTooltip } from '@/components/ui/icon-tooltip';
import { hostLabelFor, THIS_MACHINE } from '@/lib/chatDisplay';
import { useHostLabels, useDefaultNewChatCwd, useDefaultNewChatCwdByHost } from '@/lib/uiStore';
import { cn } from '@/lib/utils';

export interface SpawnControlProps {
  hosts: string[];
  // Host preselected (the host view pins its own host; the root remembers the
  // last-spawned host). Falls through to THIS_MACHINE.
  host?: string;
  // Called with (host, cwd, name?) — name undefined/empty means TEMPORARY.
  onSpawn: (host: string, cwd: string, name?: string) => Promise<boolean>;
  disabled?: boolean;
}

export function SpawnControl({ hosts, host, onSpawn, disabled }: SpawnControlProps) {
  const hostLabels = useHostLabels();
  // Settings → New Chats per-host default directory still pre-fills the field
  // (the same prefs the retired NewChatForm read), so a configured default
  // survives the rebuild; a host with none falls back to blank = home.
  const defaultCwd = useDefaultNewChatCwd();
  const defaultCwdByHost = useDefaultNewChatCwdByHost();
  const cwdFor = useCallback((h: string) => defaultCwdByHost?.[h] ?? defaultCwd ?? '', [defaultCwdByHost, defaultCwd]);
  const [expanded, setExpanded] = useState(false);
  const [selectedHost, setSelectedHost] = useState(host && hosts.includes(host) ? host : hosts[0] || THIS_MACHINE);
  const [cwd, setCwd] = useState(() => cwdFor(host && hosts.includes(host) ? host : hosts[0] || THIS_MACHINE));
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const firstFieldRef = useRef<HTMLSelectElement | null>(null);

  // Follow the parent's host hint when it changes (host view navigation) unless
  // the user has already picked a different one in this session; the directory
  // re-seeds from the chosen host's default like the old form did.
  useEffect(() => {
    if (host && hosts.includes(host) && host !== selectedHost) {
      setSelectedHost(host);
      setCwd(cwdFor(host));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [host, hosts]);

  useEffect(() => {
    if (expanded) firstFieldRef.current?.focus();
  }, [expanded]);

  const label = hostLabelFor(selectedHost, hostLabels) || (selectedHost === THIS_MACHINE ? 'this machine' : selectedHost);

  const spawn = async () => {
    if (busy || disabled) return;
    setBusy(true);
    const n = name.trim();
    const ok = await onSpawn(selectedHost, cwd.trim(), n || undefined);
    setBusy(false);
    // A named shell that spawned is saved and listed; an unnamed one opened as
    // a pane. Either way collapse back to the quiet one-liner.
    if (ok) { setName(''); setExpanded(false); }
  };

  return expanded ? (
    <div className="flex-none border-b border-border/50 px-2 py-2" data-testid="spawn-expanded">
      <div className="mb-1.5 flex items-center gap-2">
        {/* native <select>: the sidebar's narrow tier must never squeeze a
            Radix portal-triggered Select into nothing — a real element wraps. */}
        <select
          ref={firstFieldRef}
          value={selectedHost}
          onChange={(e) => { setSelectedHost(e.target.value); setCwd(cwdFor(e.target.value)); }}
          aria-label="host"
          className="h-6 min-w-0 max-w-[55%] flex-1 rounded-md border border-border bg-background px-1.5 text-[10.5px] text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
          {hosts.map((h) => (
            <option key={h} value={h}>
              {hostLabelFor(h, hostLabels) || (h === THIS_MACHINE ? 'this machine' : h)}
            </option>
          ))}
        </select>
        <button
          className="rounded px-1 text-[10px] text-muted-foreground hover:text-foreground"
          onClick={() => setExpanded(false)}
          aria-label="collapse spawn control"
        >
          ▴
        </button>
      </div>
      <div className="mb-1.5 flex items-center gap-2">
        <Input
          value={cwd}
          onChange={(e) => setCwd(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void spawn(); }}
          placeholder="~/directory (home if empty)"
          aria-label="directory"
          className="h-6 min-w-0 flex-1 px-1.5 text-[10.5px]"
        />
      </div>
      <div className="mb-1.5 flex items-center gap-2">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void spawn(); }}
          placeholder="optional — name it to save it"
          aria-label="session name (optional)"
          maxLength={60}
          className="h-6 min-w-0 flex-1 px-1.5 text-[10.5px]"
        />
      </div>
      <button
        className="flex h-6 w-full items-center justify-center gap-1 rounded-md border border-border bg-accent text-[10.5px] text-foreground hover:border-green-600 disabled:opacity-50"
        onClick={() => void spawn()}
        disabled={busy || disabled}
        title="start a shell"
      >
        <Plus aria-hidden="true" className="size-3" />
        {busy ? 'Starting…' : 'Start shell'}
      </button>
      <div className="mt-1.5 wrap-anywhere text-[10px] leading-snug text-muted-foreground">
        Unnamed shells are temporary: they run as a pane and are not listed here. Give one a name and it is saved — it appears under the host and you can come back to it.
      </div>
    </div>
  ) : (
    <div className="flex flex-none flex-wrap items-center gap-[5px] border-b border-border/50 px-2 py-1.5">
      <button
        className="flex h-6 min-w-0 max-w-[48%] flex-none items-center gap-1 overflow-hidden whitespace-nowrap rounded-md border border-border bg-background px-1.5 text-[10.5px] text-foreground hover:border-foreground/40"
        onClick={() => setExpanded(true)}
        aria-label={`spawn host: ${label} — open spawn options`}
        data-testid="spawn-collapsed-host"
      >
        <Server aria-hidden="true" className="size-2.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 truncate">{label}</span>
        <ChevronDown aria-hidden="true" className="size-3 shrink-0 text-muted-foreground" />
      </button>
      <div className="flex h-6 min-w-[5.25rem] flex-1 items-center overflow-hidden whitespace-nowrap rounded-md border border-border bg-background px-1.5 text-[10.5px] text-muted-foreground" title={cwd || 'home directory'}>
        <button
          className="min-w-0 flex-1 truncate text-left hover:text-foreground"
          onClick={() => setExpanded(true)}
          aria-label="directory — open spawn options"
        >
          {cwd || '~'}
        </button>
      </div>
      <IconTooltip label="start a shell here">
        <button
          className={cn(
            'flex h-6 flex-none items-center gap-1 rounded-md border border-border bg-accent px-[7px] text-[10.5px] text-foreground hover:border-green-600 disabled:opacity-50',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background',
          )}
          onClick={() => void spawn()}
          disabled={busy || disabled}
        >
          <Plus aria-hidden="true" className="size-3" />
          {busy ? '…' : 'shell'}
        </button>
      </IconTooltip>
    </div>
  );
}
