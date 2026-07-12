// Pure agent filter/sort helpers for the ChatSidebar agent list (WARDEN-249).
// Lifted out of the ChatSidebar component so the logic is unit-testable directly
// via node — the same "extract pure logic to web/src/lib/*.ts so it's testable
// without a React runner" discipline as diff.ts (WARDEN-151) and
// gitStateSummary.ts (WARDEN-201).
//
// Scope note: the DISPLAY helpers that originally lived next to this cluster
// (basename, chatType, processCwdLabel, displayName, ago, hostTagOf) were
// extracted into lib/chatDisplay.ts by WARDEN-216. This module keeps only the
// FILTER/SORT cluster: the AgentFilter/AgentSort option types + metadata, the
// matchesAgentFilter predicate, the compareChats/sortChats comparators, and the
// findChat lookup. (chatType is duplicated locally below — see its comment.)
//
// Self-contained by design: NO imports (neither `@/`-alias nor relative). The
// repo has no front-end test runner, so agentFilter.test.mjs loads this file by
// transpiling the TS with Vite's OXC transform and dynamically `import()`ing the
// result from a temp dir — a context where module resolvers are not available,
// so any import here would break the test harness. (diff.ts and
// gitStateSummary.ts follow the same zero-import rule.) The Chat type from the
// React layer is NOT imported; instead a local minimal slice is defined below,
// which Chat structurally satisfies — so ChatSidebar passes Chat instances
// unchanged (zero behavior change).

// Minimal slice of Chat these helpers read. Defined locally rather than imported
// from the React-layer types so the helpers stay decoupled and are testable with
// plain objects — the same decoupling gitStateSummary.ts relies on.
export interface AgentFilterChat {
  id: string;
  key?: string;             // host-prefixed id; preferred over `id` for hide/lookup
  kind?: string;            // 'yatfa' | 'tmux' | 'live' | ...
  cmd?: string;             // spawn command; first token's basename classifies the proc
  name?: string;            // user rename OR resumed-claude description
  host?: string;
  cwd?: string;
  active?: boolean | null;  // null = undiscovered
  lastActivity?: number;
}

// Short process/type label for a chat (yatfa | claude | resume | shell | <bin>).
// This is a LOCAL copy of the canonical chatType in lib/chatDisplay.ts. It is
// duplicated here (rather than imported) deliberately: matchesAgentFilter below
// needs it, and importing from chatDisplay would break this module's
// zero-import / testable-with-node invariant (see header). The two are kept in
// sync; chatDisplay.ts remains the canonical home (and is exercised by
// chatDisplay.test.mjs). Logic-identical to the original inline ChatSidebar fn.
export function chatType(c?: AgentFilterChat): string {
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

// Agent-list filter/sort controls (WARDEN-91). Shared across the root, host, and
// collection views so the option lists and matching logic can never drift.
export type AgentFilter = 'all' | 'yatfa' | 'claude' | 'manual' | 'active' | 'hidden';
export type AgentSort = 'manual' | 'name' | 'host' | 'status' | 'activity';

export const FILTER_OPTIONS: { value: AgentFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'yatfa', label: 'Yatfa agents only' },
  { value: 'claude', label: 'Claude sessions only' },
  { value: 'manual', label: 'Manual/shell only' },
  { value: 'active', label: 'Active only' },
  { value: 'hidden', label: 'Hidden only' },
];

export const SORT_OPTIONS: { value: AgentSort; label: string }[] = [
  { value: 'manual', label: 'Manual order' },
  { value: 'name', label: 'Name (A-Z)' },
  { value: 'host', label: 'Host' },
  { value: 'status', label: 'Status (active first)' },
  { value: 'activity', label: 'Last activity' },
];

// Does `c` pass the active agent filter? Hidden membership matches on the
// host-prefixed id (`key || id`) so it lines up with hideTab()/activeTabs.
export function matchesAgentFilter(c: AgentFilterChat, filter: AgentFilter, hiddenTabs: string[]): boolean {
  switch (filter) {
    case 'yatfa': return chatType(c) === 'yatfa';
    case 'claude': { const t = chatType(c); return t === 'claude' || t === 'resume'; }
    case 'manual': { const t = chatType(c); return t === 'shell' || t === 'manual'; }
    case 'active': return c.active === true;
    case 'hidden': return hiddenTabs.includes(c.key || c.id);
    case 'all':
    default: return true;
  }
}

// Comparator for non-manual sorts. `manual` is handled by the caller (it
// preserves drag order and must not touch the array).
export function compareChats(a: AgentFilterChat, b: AgentFilterChat, sort: AgentSort): number {
  switch (sort) {
    case 'name': return (a.name || a.id).localeCompare(b.name || b.id);
    case 'host': return (a.host || '').localeCompare(b.host || '');
    case 'status': {
      const sa = a.active === true ? 1 : 0;
      const sb = b.active === true ? 1 : 0;
      return sa !== sb ? sb - sa : a.id.localeCompare(b.id);
    }
    case 'activity': return (b.lastActivity || 0) - (a.lastActivity || 0);
    case 'manual':
    default: return 0;
  }
}

// Sort a chat list by the selected criterion. Manual sort is a no-op that
// returns the input unchanged so drag-to-reorder order is preserved. Generic so
// the element type flows through (a Chat[] in yields a Chat[] out).
export function sortChats<T extends AgentFilterChat>(chats: T[], sort: AgentSort): T[] {
  return sort === 'manual' ? chats : [...chats].sort((a, b) => compareChats(a, b, sort));
}

// Lookup by the host-prefixed id (`key || id`). Generic so the element type
// flows through (a Chat[] in yields a Chat | undefined out).
export function findChat<T extends AgentFilterChat>(chats: T[], id: string): T | undefined {
  return chats.find((c) => (c.key || c.id) === id);
}
