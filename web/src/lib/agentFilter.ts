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
// findChat lookup.
//
// Import discipline: this module must stay loadable by agentFilter.test.mjs,
// which transpiles the TS with Vite's OXC transform and dynamically `import()`s
// the result from a temp dir — a context with no `@/`-alias resolver and no
// node_modules. So: a `@/`-alias import or any React/.tsx import is still
// FORBIDDEN. A RELATIVE SIBLING import is fine, provided the sibling is itself
// runtime-import-free and the test transpiles both files and rewrites the
// specifier to the temp-dir `.mjs` before transform — the pattern kill.test.mjs
// established (WARDEN-328) and this file's ./chatDisplay import uses (WARDEN-936;
// chatDisplay's only import is an erased `import type`). The Chat type from the
// React layer is NOT imported; instead a local minimal slice is defined below,
// which Chat structurally satisfies — so ChatSidebar passes Chat instances
// unchanged (zero behavior change).
//
// NOTE: this must remain the module's ONLY `./chatDisplay` import statement.
// agentFilter.test.mjs:48 rewrites the specifier with a NON-GLOBAL regex
// (first-match-only), so a second import line would go unrewritten and the spec
// would die with ERR_MODULE_NOT_FOUND. Add new names to this list, never a new
// line (WARDEN-1071 Principle 3b).
import { chatType, displayName } from './chatDisplay';

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

// Re-exported so the identifier stays available from this module (it is the same
// canonical function object — chatDisplay.ts is its sole definition).
export { chatType };

// Agent-list filter/sort controls (WARDEN-91). Shared across the root, host, and
// collection views so the option lists and matching logic can never drift.
// WARDEN-372: the 'active' and 'hidden' filter cases were abolished along with
// the tabs model — the root list is now literally the open panes, and hide/
// unhide no longer exists. The 'status' SORT (active-first) still uses c.active.
export type AgentFilter = 'all' | 'yatfa' | 'claude' | 'manual';
export type AgentSort = 'manual' | 'name' | 'host' | 'status' | 'activity';

export const FILTER_OPTIONS: { value: AgentFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'yatfa', label: 'Yatfa agents only' },
  { value: 'claude', label: 'Claude sessions only' },
  { value: 'manual', label: 'Manual/shell only' },
];

export const SORT_OPTIONS: { value: AgentSort; label: string }[] = [
  { value: 'manual', label: 'Manual order' },
  { value: 'name', label: 'Name (A-Z)' },
  { value: 'host', label: 'Host' },
  { value: 'status', label: 'Status (active first)' },
  { value: 'activity', label: 'Last activity' },
];

// Does `c` pass the active agent filter? WARDEN-372: the 'active' and 'hidden'
// cases are gone (the root list is the open panes; hide/unhide is abolished), so
// this predicate is now purely about the chat's type/kind — no tab membership.
export function matchesAgentFilter(c: AgentFilterChat, filter: AgentFilter): boolean {
  switch (filter) {
    case 'yatfa': return chatType(c) === 'yatfa';
    case 'claude': { const t = chatType(c); return t === 'claude' || t === 'resume'; }
    case 'manual': { const t = chatType(c); return t === 'shell' || t === 'manual'; }
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

// Display label for a fleet-action target id (WARDEN-1121). Falls back to the
// RAW ID rather than to undefined/'?' so an orphan target — an agent that died
// between selecting and acting on it — stays identifiable in the result toast
// instead of reading as the literal string 'undefined' (the contract pinned by
// fanout.test.mjs:240-248 and broadcast.test.mjs:115-120).
//
// This is the resolver the three ChatSidebar fleet fan-outs (broadcast
// WARDEN-292, batch kill WARDEN-328, batch interrupt WARDEN-492) each pass as
// their `nameOf` callback. It lived as three byte-identical inline copies until
// WARDEN-974's fan-out extraction left it as the last triplicated piece; it
// belongs here because it is a shared contract across lib/broadcast.ts,
// lib/kill.ts and lib/keysend.ts, and because findChat — its only dependency —
// is defined directly above.
export function displayNameFor<T extends AgentFilterChat>(chats: T[], id: string): string {
  const c = findChat(chats, id);
  return c ? displayName(c) : id;
}
