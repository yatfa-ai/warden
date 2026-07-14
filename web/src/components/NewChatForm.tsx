import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { IconTooltip } from '@/components/ui/icon-tooltip';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { postJson } from '@/lib/api';
import { loadUi } from '@/lib/storage';
import type { Chat } from '@/lib/types';
import { groupByHost, summarizeHostLoad, resourceTone, type HostLoadSummary } from '@/lib/healthUtils';

const THIS_MACHINE = '(local)';

// Per-host load annotation for the host picker (WARDEN-361). The picker already
// fetches /api/ssh-hosts (names only) when it opens; a companion fetch of the
// cache-derived /api/health (zero SSH) supplies the per-agent cpu/mem WARDEN-309
// captured, which we roll up per host (groupByHost + summarizeHostLoad) and suffix
// each option with the live agent count + mem% (cpu% when present) — so a human
// spawning their next agent can see which host is already loaded.
//
// NUANCE: this is a shadcn <Select>/<SelectItem> (NOT a native <select> as the
// original proposal assumed), so the suffix CAN carry real color. Radix clones the
// selected item's text into the collapsed trigger, so the selected host's load
// also shows inline when the picker is closed — a side benefit, not a regression.
// A ≥90% mem host is colored red AND given a ⚠ glyph (double-cue) via resourceTone.
// Stats-less hosts (no entry in hostLoad, or avgCpu/memPct both null) render
// EXACTLY as before — "host (tmux)" with no suffix.
function hostOptionChildren(label: string, load?: HostLoadSummary): ReactNode {
  if (!load || (load.avgCpu == null && load.memPct == null)) return label;
  const segs: string[] = [];
  segs.push(`${load.agentCount} agent${load.agentCount !== 1 ? 's' : ''}`);
  if (load.avgCpu != null) segs.push(`${Math.round(load.avgCpu)}% cpu`);
  if (load.memPct != null) segs.push(`${load.memPct >= 90 ? '⚠ ' : ''}${Math.round(load.memPct)}% mem`);
  return (
    <span className="flex items-center gap-1.5">
      <span>{label}</span>
      <span className={`text-[10px] tabular-nums ${resourceTone(load.avgCpu, load.memPct)}`}>
        · {segs.join(' · ')}
      </span>
    </span>
  );
}

// Inline (non-modal) spawn. The HOST decides the mechanism:
//   this machine → direct PTY (no tmux; Windows has none)
//   remote host  → host tmux (required) — durable + resumable
// A claude/shell preset — or any user-defined preset from Settings — pre-fills
// the command.
export function NewChatForm({ onSpawned }: { onSpawned: (chat: Chat) => void }) {
  // Pre-fill from the saved default-new-chat prefs (Settings → New Chats). These
  // are pure client-side localStorage values; if unset they fall back to the
  // prior hard-coded behavior (claude preset, this machine). Lazy initializers
  // so loadUi() runs once on mount — not on every render/keystroke — matching
  // App.tsx's lazy-init pattern for client prefs.
  const [initialUi] = useState(() => loadUi());
  // Resolve the default cwd for a given host: a per-host override
  // (defaultNewChatCwdByHost) wins, falling back to the global defaultNewChatCwd,
  // then blank (the host's home directory). A host with no override falls through
  // to today's exact behavior — WARDEN-336 extends WARDEN-311's single global
  // default to a per-host map. Used to (re-)seed the cwd field on mount, on host
  // change, and after submit. Memoized: it depends only on the mount-once
  // initialUi (stable), so it has a stable identity and is safe in effect deps.
  const cwdFor = useCallback(
    (h: string) => initialUi.defaultNewChatCwdByHost?.[h] ?? initialUi.defaultNewChatCwd ?? '',
    [initialUi],
  );
  // Resolve the default agent-type (preset) for a given host (WARDEN-352 — the
  // preset mirror of cwdFor from WARDEN-336): a per-host override
  // (defaultNewChatPresetByHost) wins, falling back to the global
  // defaultNewChatPreset, then 'claude'. loadUi already dropped any per-host
  // value naming a since-deleted preset (parsePresetByHost), so a host with no
  // valid override falls through to today's exact behavior. Used to (re-)seed
  // the preset field on mount, on host change, and after submit — so every
  // defaultable spawn field tracks the selected host. Memoized like cwdFor: it
  // depends only on the mount-once initialUi (stable), safe in effect deps.
  const presetFor = useCallback(
    (h: string) => initialUi.defaultNewChatPresetByHost?.[h] ?? initialUi.defaultNewChatPreset ?? 'claude',
    [initialUi],
  );
  // Resolve the default shell for a given host (WARDEN-429 — the shell mirror of
  // cwdFor/presetFor): a per-host override (defaultShellByHost) wins, falling
  // back to the global defaultShell, then blank. Blank is the meaningful
  // "host login shell" value — an empty cmd flows through to tmux as a bare login
  // shell per WARDEN-223, so a zsh-login host yields zsh with zero config.
  // loadUi already dropped any blank per-host entry (parseShellByHost), so a host
  // with no override falls through to the global default, then blank. Used to
  // (re-)seed the command field when the shell preset is selected — on mount, on
  // host change, and after submit — so the shell terminal opens the resolved
  // shell, not a hardcoded 'bash'. Memoized like cwdFor/presetFor: it depends
  // only on the mount-once initialUi (stable), safe in effect deps.
  const shellFor = useCallback(
    (h: string) => initialUi.defaultShellByHost?.[h] ?? initialUi.defaultShell ?? '',
    [initialUi],
  );
  const [open, setOpen] = useState(false);
  const [sshHosts, setSshHosts] = useState<string[]>([]);
  // Per-host rolled-up load (WARDEN-361): host -> {agentCount, avgCpu, memPct},
  // snapshot from /api/health fetched once when the picker opens (cache-derived,
  // zero SSH). An absent host, or one whose agents carry no docker stats, renders
  // the option with no suffix (graceful). Refreshed on every open so the snapshot
  // can't go stale across spawns.
  const [hostLoad, setHostLoad] = useState<Record<string, HostLoadSummary>>({});
  const [claudePath, setClaudePath] = useState('claude');
  const [host, setHost] = useState(() => initialUi.defaultNewChatHost ?? THIS_MACHINE);
  // preset is a built-in name ('claude' | 'shell') or a custom preset name.
  // Host-aware (WARDEN-352): pre-fill the agent type for the INITIAL host (the
  // saved defaultNewChatHost), resolved via presetFor so a per-host override
  // seeds the field immediately on first open — mirroring cwd's host-aware init
  // above. loadUi already dropped any per-host value naming a since-deleted
  // preset, so presetFor falls through to the global default, then 'claude'.
  const [preset, setPreset] = useState<string>(() => presetFor(initialUi.defaultNewChatHost ?? THIS_MACHINE));
  const [customPresets] = useState(() => initialUi.customPresets ?? []);
  const [session, setSession] = useState('');
  // cwd pre-fills HOST-AWARE (WARDEN-336): the default for the INITIAL host
  // (the saved defaultNewChatHost), resolved via cwdFor so a per-host override
  // seeds the field immediately on first open. Lazy init runs loadUi() once on
  // mount (matching the host/preset lazy-inits above); the value is still
  // editable per-spawn, submit trims it, and switching host re-seeds it (below).
  const [cwd, setCwd] = useState(() => cwdFor(initialUi.defaultNewChatHost ?? THIS_MACHINE));
  const [cmd, setCmd] = useState('claude --dangerously-skip-permissions');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    fetch('/api/ssh-hosts')
      .then((r) => r.json())
      .then((j) => {
        const hosts: string[] = j.hosts || [];
        setSshHosts(hosts);
        // Graceful fallback: a stored default host that's no longer configured
        // (removed from SSH hosts / no longer detected) must never leave a
        // dangling/empty option — drop back to local, and re-seed cwd to local's
        // default so the field never shows the removed host's path. Functional
        // update keeps `host` out of this effect's deps so it doesn't re-fetch on
        // change (cwdFor is stable, listed below, so it never triggers a refetch).
        // setCwd inside the updater is safe: cwdFor(THIS_MACHINE) is deterministic,
        // so a StrictMode double-invoke just re-sets the same value.
        setHost((cur) => {
          if (cur !== THIS_MACHINE && !hosts.includes(cur)) {
            setCwd(cwdFor(THIS_MACHINE));
            setPreset(presetFor(THIS_MACHINE));
            return THIS_MACHINE;
          }
          return cur;
        });
      })
      .catch((error) => console.error('[ssh-hosts] Failed:', error));
    fetch('/api/this-session').then((r) => r.json()).then((t) => { if (t.claudePath) setClaudePath(t.claudePath); }).catch((error) => console.error('[this-session] Failed:', error));
  }, [open, cwdFor, presetFor]);

  // Companion fetch (WARDEN-361): pull the cache-derived /api/health (zero SSH) and
  // roll per-agent cpu/mem up per host, so each picker option can be suffixed with
  // live load. Separate effect so the load snapshot doesn't refetch when cwd's
  // stable deps change — only when the popover opens. Reads the same endpoint the
  // Fleet Health dashboard polls, so a stats-less host here is stats-less there too.
  useEffect(() => {
    if (!open) return;
    fetch('/api/health')
      .then((r) => r.json())
      .then((j) => {
        const agents: Chat[] = Array.isArray(j?.agents) ? j.agents : [];
        const map: Record<string, HostLoadSummary> = {};
        for (const g of groupByHost(agents)) {
          map[g.host] = summarizeHostLoad(g.agents);
        }
        setHostLoad(map);
      })
      .catch((error) => console.error('[health] host load fetch failed:', error));
  }, [open]);

  useEffect(() => {
    if (!open) return;
    let def: string;
    if (preset === 'shell') {
      // WARDEN-429: resolve the shell through the single Default shell setting
      // (per-host override → global default → blank). Blank means "no explicit
      // shell" → the host launches its own login shell (an explicit empty cmd
      // flows through to tmux as a bare login shell per WARDEN-223), NOT a
      // hardcoded 'bash'. The resolved value (or empty) seeds the command field
      // and remains editable per-spawn.
      def = shellFor(host);
    } else if (preset === 'claude') {
      def = host === THIS_MACHINE ? `${claudePath} --dangerously-skip-permissions` : 'claude --dangerously-skip-permissions';
    } else {
      // Custom preset — fill from its saved command. If it's somehow missing
      // (e.g. deleted elsewhere this session), fall back to the claude default
      // so the command is never left empty.
      const found = customPresets.find((p) => p.name === preset);
      def = found ? found.cmd : 'claude --dangerously-skip-permissions';
    }
    setCmd(def);
  }, [host, preset, open, claudePath, customPresets, shellFor]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr('');
    setBusy(true);
    try {
      const sess = session.trim() || `chat-${Math.random().toString(36).slice(2, 8)}`;
      const result = await postJson<{ chat: Chat }>('/api/spawn', {
        host, session: sess, cwd: cwd.trim(), cmd: cmd.trim(),
      });
      if (!result.ok) { setErr(result.error || 'spawn failed'); setBusy(false); return; }
      // Reset session (per-spawn) and re-seed cwd host-aware (WARDEN-336): the
      // default for the CURRENTLY-SELECTED host, not just the global default.
      // NewChatForm is always-mounted, so the lazy useState initializer above
      // runs only once per session — clearing cwd to '' here would empty the
      // field for every spawn after the first. Re-seed via cwdFor so the path
      // pre-fills every open for the selected host; a per-spawn edit correctly
      // does NOT persist (it's a default, not the last-used value). The preset
      // field re-seeds host-aware too (WARDEN-352) so it never sticks on a
      // manually-selected agent type across spawns.
      setOpen(false); setSession(''); setCwd(cwdFor(host)); setPreset(presetFor(host));
      onSpawned(result.data!.chat);
    } catch (e: unknown) { setErr(e instanceof Error ? e.message : String(e)); }
    setBusy(false);
  };

  if (!open) {
    return <IconTooltip label="new chat"><button onClick={() => setOpen(true)} className="text-xs text-muted-foreground hover:text-foreground px-2 py-0.5 active:scale-95 transition-all duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background rounded">＋ new</button></IconTooltip>;
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-1 p-2 border-b bg-muted/40">
      <Select
        value={host}
        onValueChange={(h) => {
          setHost(h);
          // Re-seed BOTH host-aware spawn defaults when the host changes, so a
          // user who runs claude locally but codex on a remote box never has to
          // manually re-select — WARDEN-336 (cwd) + WARDEN-352 (preset).
          setCwd(cwdFor(h));
          setPreset(presetFor(h));
        }}
      >
        <SelectTrigger className="h-7 w-full text-[11px]">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={THIS_MACHINE}>{hostOptionChildren('this machine (direct)', hostLoad[THIS_MACHINE])}</SelectItem>
          {sshHosts.map((h) => (
            <SelectItem key={h} value={h}>
              {hostOptionChildren(`${h} (tmux)`, hostLoad[h])}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <div className="flex flex-wrap gap-1">
        <Button size="sm" type="button" variant={preset === 'claude' ? 'default' : 'outline'} className="h-6 text-[11px] flex-1" onClick={() => setPreset('claude')}>claude</Button>
        <Button size="sm" type="button" variant={preset === 'shell' ? 'default' : 'outline'} className="h-6 text-[11px] flex-1" onClick={() => setPreset('shell')}>shell</Button>
        {customPresets.map((p, i) => (
          <Button key={`custom-${i}-${p.name}`} size="sm" type="button" variant={preset === p.name ? 'default' : 'outline'} className="h-6 text-[11px] flex-1" onClick={() => setPreset(p.name)}>{p.name}</Button>
        ))}
      </div>
      <Input value={session} onChange={(e) => setSession(e.target.value)} placeholder="session name" className="h-7 text-[11px]" />
      <Input value={cwd} onChange={(e) => setCwd(e.target.value)} placeholder="cwd (dir)" className="h-7 text-[11px]" />
      <Input value={cmd} onChange={(e) => setCmd(e.target.value)} placeholder={preset === 'shell' ? 'auto (host login shell)' : 'command'} className="h-7 text-[11px]" />
      {host !== THIS_MACHINE && <span className="text-[10px] text-muted-foreground">needs tmux on {host} · survives warden restart</span>}
      {host === THIS_MACHINE && <span className="text-[10px] text-muted-foreground">direct · survives reload (not restart)</span>}
      {err && <div className="text-[10px] text-red-500">{err}</div>}
      <div className="flex gap-1">
        <Button size="sm" type="submit" disabled={busy} className="h-7 text-[11px] flex-1">{busy ? '…' : 'spawn'}</Button>
        <Button size="sm" type="button" variant="ghost" className="h-7 text-[11px]" onClick={() => setOpen(false)}>cancel</Button>
      </div>
    </form>
  );
}
