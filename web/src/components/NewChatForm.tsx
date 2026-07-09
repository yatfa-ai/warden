import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { IconTooltip } from '@/components/ui/icon-tooltip';
import { Input } from '@/components/ui/input';
import type { Chat } from '@/lib/types';

const THIS_MACHINE = '(local)';

// Inline (non-modal) spawn. The HOST decides the mechanism:
//   this machine → direct PTY (no tmux; Windows has none)
//   remote host  → host tmux (required) — durable + resumable
// A claude/shell preset pre-fills the command.
export function NewChatForm({ onSpawned }: { onSpawned: (chat: Chat) => void }) {
  const [open, setOpen] = useState(false);
  const [sshHosts, setSshHosts] = useState<string[]>([]);
  const [claudePath, setClaudePath] = useState('claude');
  const [host, setHost] = useState(THIS_MACHINE);
  const [preset, setPreset] = useState<'claude' | 'shell'>('claude');
  const [session, setSession] = useState('');
  const [cwd, setCwd] = useState('');
  const [cmd, setCmd] = useState('claude --dangerously-skip-permissions');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    fetch('/api/ssh-hosts').then((r) => r.json()).then((j) => setSshHosts(j.hosts || [])).catch(() => {});
    fetch('/api/this-session').then((r) => r.json()).then((t) => { if (t.claudePath) setClaudePath(t.claudePath); }).catch(() => {});
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const def = preset === 'shell'
      ? 'bash'
      : (host === THIS_MACHINE ? `${claudePath} --dangerously-skip-permissions` : 'claude --dangerously-skip-permissions');
    setCmd(def);
  }, [host, preset, open, claudePath]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr('');
    setBusy(true);
    try {
      const sess = session.trim() || `chat-${Math.random().toString(36).slice(2, 8)}`;
      const r = await fetch('/api/spawn', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ host, session: sess, cwd: cwd.trim(), cmd: cmd.trim() }),
      });
      const j = await r.json();
      if (!r.ok) { setErr(j.error || 'spawn failed'); setBusy(false); return; }
      setOpen(false); setSession(''); setCwd('');
      onSpawned(j.chat);
    } catch (e: unknown) { setErr(e instanceof Error ? e.message : String(e)); }
    setBusy(false);
  };

  if (!open) {
    return <IconTooltip label="new chat"><button onClick={() => setOpen(true)} className="text-xs text-muted-foreground hover:text-foreground px-2 py-0.5 active:scale-95 transition-all duration-150 ease-out">＋ new</button></IconTooltip>;
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-1 p-2 border-b bg-muted/40">
      <select value={host} onChange={(e) => setHost(e.target.value)} className="bg-background border rounded px-1.5 py-1 text-[11px]">
        <option value={THIS_MACHINE}>this machine (direct)</option>
        {sshHosts.map((h) => <option key={h} value={h}>{h} (tmux)</option>)}
      </select>
      <div className="flex gap-1">
        <Button size="sm" type="button" variant={preset === 'claude' ? 'default' : 'outline'} className="h-6 text-[11px] flex-1" onClick={() => setPreset('claude')}>claude</Button>
        <Button size="sm" type="button" variant={preset === 'shell' ? 'default' : 'outline'} className="h-6 text-[11px] flex-1" onClick={() => setPreset('shell')}>shell</Button>
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
