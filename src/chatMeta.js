// Shared chat-name metadata for warden's discovery paths.
//
// Both the default SSH discover path (src/chats.js) and the companion transport
// (src/companion.js) must derive project/role/isAgent IDENTICALLY from a yatfa
// container name, so the two paths produce byte-for-byte equal chat objects.
// Centralizing these helpers here (rather than duplicating or creating a circular
// chats<->companion import) guarantees that invariant with one definition.

// yatfa role suffixes on container names: "{project}-{role}".
export const ROLES = new Set(['planner', 'worker', 'reviewer', 'researcher']);

// Split a yatfa container name "myproject-worker" into { project, role } on the
// last hyphen. A name with no hyphen is a bare project with no role. Mirrors the
// original definition in chats.js verbatim (WARDEN-235).
export function parseContainerName(name) {
  const idx = name.lastIndexOf('-');
  if (idx < 0) return { project: name, role: '' };
  return { project: name.slice(0, idx), role: name.slice(idx + 1) };
}

// Build a yatfa chat object from the discovery primitives BOTH paths share: the
// host, container name, status string, cwd, alive flag, and tmux session name.
// The default SSH discover path (src/chats.js) and the companion transport
// (src/companion.js) MUST produce byte-identical chat objects from the same
// inputs, so the literal lives here ONCE and both call it — structural parity
// rather than two inline copies kept in sync by a test (WARDEN-272 review #5).
//
// `active` is normalized with `!!` (the default path already passes a boolean;
// the companion passes a possibly-truthy flag), and `cwd`/`status` are coerced
// so a missing/empty cwd -> undefined and a missing status -> '' exactly as
// both paths did inline. lastActivity is null: the default path may fill it in
// a follow-up activity-capture pass; the companion leaves it null in slice 1
// (the activity migration is a later slice).
export function buildChat(host, name, status, cwd, active, session) {
  const { project, role } = parseContainerName(name);
  return {
    id: `${host}:${name}`, key: name, kind: 'yatfa',
    host, container: name, session,
    project, role, isAgent: ROLES.has(role),
    active: !!active,
    status: status || '',
    cwd: (cwd || '').trim() || undefined,
    lastActivity: null,
  };
}

// Shared discovery ordering: active chats first, then by key. Both discovery
// paths sort with this exact comparator so their output order cannot diverge.
export function sortChats(chats) {
  return chats.sort((a, b) => (Number(b.active) - Number(a.active)) || a.key.localeCompare(b.key));
}
