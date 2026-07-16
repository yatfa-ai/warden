import type { Chat } from '@/lib/types';

// Canonical id of this machine's own tmux host (mirrors LOCAL in src/chats.js). Local
// agents are auto-discovered on mount so their dots are live without a click; remote
// SSH hosts stay on-demand per lazy mode. Shared by the sidebar and the Open Chat
// browser page, so both agree on which host is "this machine".
export const THIS_MACHINE = '(local)';

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

// A raw host string → optional friendly display label (WARDEN-490). Pure client-
// side UiState pref (hostLabels); never leaves the machine (no /api/config, no
// SSH/telemetry path). Keys are the raw host strings ('(local)' for this
// machine, the SSH host name for remote); values are the human's label. An
// absent or empty/whitespace entry for a host = no label → today's behavior.
// Threaded to each display surface via HostLabelsContext (useHostLabels in
// lib/hostLabels.ts) so the label reaches every surface without prop-drilling
// through intermediate components.
export type HostLabels = Record<string, string>;

// Resolve a host's optional friendly label (WARDEN-490). Returns the trimmed
// label, or '' (falsy) when the host has no label — so a caller falls through to
// its own per-surface local-host string ('local' or 'this machine') EXACTLY as it
// did before, preserving the intentional cross-surface difference for unlabeled
// hosts. Pure + dependency-free (no React) so it and hostTagOf stay standalone-
// testable, and so the deliberately import-free tokenBudget module can inline the
// same one-line lookup without importing here.
export function hostLabelFor(host: string, labels?: HostLabels): string {
  return (labels?.[host] ?? '').trim();
}

// Host display tag: this machine reads "local" (unchanged for an unlabeled host).
// With a label map (WARDEN-490), a host with a non-empty label shows that label
// instead of the raw SSH name/IP — including THIS_MACHINE, so the human can name
// "this machine" too. An absent/empty label is byte-identical to today: `labels`
// is optional, so unchanged call sites keep working, and a host whose label is
// blank/whitespace falls back to the raw host (or 'local' for this machine).
export function hostTagOf(host: string, labels?: HostLabels): string {
  const label = hostLabelFor(host, labels);
  if (label) return label;
  return host === THIS_MACHINE ? 'local' : host;
}
