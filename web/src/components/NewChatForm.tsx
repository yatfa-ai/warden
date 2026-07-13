import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { IconTooltip } from '@/components/ui/icon-tooltip';
import { Input } from '@/components/ui/input';
import { postJson } from '@/lib/api';
import { loadUi } from '@/lib/storage';
import type { Chat } from '@/lib/types';

const THIS_MACHINE = '(local)';

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
  const [open, setOpen] = useState(false);
  const [sshHosts, setSshHosts] = useState<string[]>([]);
  const [claudePath, setClaudePath] = useState('claude');
  const [host, setHost] = useState(() => initialUi.defaultNewChatHost ?? THIS_MACHINE);
  // preset is a built-in name ('claude' | 'shell') or a custom preset name.
  // loadUi already validated the stored default against the custom list, so a
  // default naming a since-deleted preset has already fallen back to 'claude'.
  const [preset, setPreset] = useState<string>(() => initialUi.defaultNewChatPreset ?? 'claude');
  const [customPresets] = useState(() => initialUi.customPresets ?? []);
  const [session, setSession] = useState('');
  // cwd pre-fills from the persisted defaultNewChatCwd pref (WARDEN-311) so a
  // human who always spawns into the same project doesn't re-type the path on
  // every spawn. Lazy init runs loadUi() once on mount (matching the host/preset
  // lazy-inits above); the value is still editable per-spawn and submit trims it.
  const [cwd, setCwd] = useState(() => initialUi.defaultNewChatCwd ?? '');
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
        // dangling/empty option — drop back to local. Functional update keeps
        // `host` out of this effect's deps so it doesn't re-fetch on change.
        setHost((cur) => (cur !== THIS_MACHINE && !hosts.includes(cur) ? THIS_MACHINE : cur));
      })
      .catch((error) => console.error('[ssh-hosts] Failed:', error));
    fetch('/api/this-session').then((r) => r.json()).then((t) => { if (t.claudePath) setClaudePath(t.claudePath); }).catch((error) => console.error('[this-session] Failed:', error));
  }, [open]);

  useEffect(() => {
    if (!open) return;
    let def: string;
    if (preset === 'shell') {
      def = 'bash';
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
  }, [host, preset, open, claudePath, customPresets]);

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
      // Reset session (per-spawn) and re-seed cwd from the persisted default
      // (WARDEN-311). NewChatForm is always-mounted, so the lazy useState
      // initializer above runs only once per session — clearing cwd to '' here
      // would empty the field for every spawn after the first. Re-seed from the
      // default so the path pre-fills every open; a per-spawn edit correctly
      // does NOT persist (it's a default, not the last-used value).
      setOpen(false); setSession(''); setCwd(initialUi.defaultNewChatCwd ?? '');
      onSpawned(result.data!.chat);
    } catch (e: unknown) { setErr(e instanceof Error ? e.message : String(e)); }
    setBusy(false);
  };

  if (!open) {
    return <IconTooltip label="new chat"><button onClick={() => setOpen(true)} className="text-xs text-muted-foreground hover:text-foreground px-2 py-0.5 active:scale-95 transition-all duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background rounded">＋ new</button></IconTooltip>;
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-1 p-2 border-b bg-muted/40">
      <select value={host} onChange={(e) => setHost(e.target.value)} className="bg-background border rounded px-1.5 py-1 text-[11px]">
        <option value={THIS_MACHINE}>this machine (direct)</option>
        {sshHosts.map((h) => <option key={h} value={h}>{h} (tmux)</option>)}
      </select>
      <div className="flex flex-wrap gap-1">
        <Button size="sm" type="button" variant={preset === 'claude' ? 'default' : 'outline'} className="h-6 text-[11px] flex-1" onClick={() => setPreset('claude')}>claude</Button>
        <Button size="sm" type="button" variant={preset === 'shell' ? 'default' : 'outline'} className="h-6 text-[11px] flex-1" onClick={() => setPreset('shell')}>shell</Button>
        {customPresets.map((p, i) => (
          <Button key={`custom-${i}-${p.name}`} size="sm" type="button" variant={preset === p.name ? 'default' : 'outline'} className="h-6 text-[11px] flex-1" onClick={() => setPreset(p.name)}>{p.name}</Button>
        ))}
      </div>
      <Input value={session} onChange={(e) => setSession(e.target.value)} placeholder="session name" className="h-7 text-[11px]" />
      <Input value={cwd} onChange={(e) => setCwd(e.target.value)} placeholder="cwd (dir)" className="h-7 text-[11px]" />
      <Input value={cmd} onChange={(e) => setCmd(e.target.value)} placeholder="command" className="h-7 text-[11px]" />
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
