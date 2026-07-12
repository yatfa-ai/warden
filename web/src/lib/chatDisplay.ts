import type { Chat } from '@/lib/types';

// Canonical id of this machine's own tmux host (mirrors LOCAL in src/chats.js). Local
// agents are auto-discovered on mount so their dots are live without a click; remote
// SSH hosts stay on-demand per lazy mode. Shared by the sidebar and the Open Chat
// browser page, so both agree on which host is "this machine".
export const THIS_MACHINE = '(local)';

// Relative time formatter (e.g. "3m", "2h", "5d").
export function ago(ms: number) {
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

// Basename of a path, normalizing both POSIX and Windows separators.
export function basename(p: string) { return (p || '').replace(/[\\/]+/g, '/').replace(/\/$/, '').split('/').pop() || p; }

// Short process/type label for a chat (yatfa | claude | resume | shell | <bin> | manual).
export function chatType(c?: Chat): string {
  if (!c) return '?';
  if (c.kind === 'yatfa') return 'yatfa';
  const bin = (c.cmd || '').split(/\s+/)[0].replace(/^.*[/\\]/, '');
  if (bin === 'claude' || bin === 'claude.exe') return (c.cmd || '').includes('--resume') ? 'resume' : 'claude';
  if (['bash', 'sh', 'zsh', 'fish', 'pwsh', 'powershell', 'cmd.exe'].includes(bin)) return 'shell';
  // An empty cmd is a tmux session launched with no explicit command — i.e. the
  // host's login shell (the ＋ split "no explicit shell" case, WARDEN-223) — so
  // it reads as 'shell', not the generic 'manual'.
  return bin || 'shell';
}

// "process · cwd-basename" label, used as the fallback display name.
export function processCwdLabel(c: Chat): string {
  const proc = chatType(c);
  const dir = basename(c.cwd || '');
  return dir ? `${proc} · ${dir}` : proc;
}

// Display-name precedence (WARDEN-163):
//   yatfa agents     → project-role (the container/key name; not user-renameable)
//   manual/spawned   → user rename > Claude description (carried as `name` on resume)
//                      > process+cwd basename > internal key
// The raw chat-xxxxx id is NEVER shown: a fresh spawn has name === key, so it falls
// through to processCwdLabel. A user rename or a resumed session sets name ≠ key.
// Shared so the sidebar and the Open Chat browser render identical labels.
export function displayName(c?: Chat): string {
  if (!c) return '?';
  if (c.kind === 'yatfa') return c.key || c.id;
  if (c.name && c.name !== c.key) return c.name;
  return processCwdLabel(c);
}

// Host display tag: this machine reads "local".
export function hostTagOf(host: string) { return host === THIS_MACHINE ? 'local' : host; }
