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
