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
// both paths did inline. lastActivity starts at null: both discovery paths may
// fill it in via a follow-up activity-capture pass that parses the leading pane
// line's timestamp with the shared parseActivityTimestamp() below (WARDEN-376
// closed the companion's read-parity gap — it now captures that line host-side
// too, where slice 1 had left it null).
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

// Parse a leading pane line's timestamp into epoch ms, or null when the line
// carries no parseable timestamp. This is the SINGLE timestamp regex BOTH
// discovery paths use: the default SSH path (src/chats.js) captures the leading
// pane line per active agent and calls this, and the companion transport
// (src/companion.js) captures the same leading line host-side and calls this
// SAME helper on it — so lastActivity is parsed identically by construction
// (the same single-source-of-truth philosophy that motivated centralizing
// buildChat). Mirrors the regex the default path accepted inline: an optional
// `[`/`]` around a `YYYY-MM-DD[space|T]HH:MM:SS` timestamp. Returns null for
// empty/non-matching input OR a syntactically-matching but invalid calendar
// date so callers leave lastActivity null rather than stamping NaN. (WARDEN-376)
export function parseActivityTimestamp(line) {
  const s = line == null ? '' : String(line);
  if (!s.trim()) return null;
  const m = s.match(/\[?(\d{4}-\d{2}-\d{2}[\sT]\d{2}:\d{2}:\d{2})\]?/);
  if (!m) return null;
  const ms = new Date(m[1]).getTime();
  return Number.isNaN(ms) ? null : ms;
}

// Shared discovery ordering: active chats first, then by key. Both discovery
// paths sort with this exact comparator so their output order cannot diverge.
export function sortChats(chats) {
  return chats.sort((a, b) => (Number(b.active) - Number(a.active)) || a.key.localeCompare(b.key));
}

// Render a chat's agent-target identity as `<container-or-session>@<host>` —
// the single string shown in the CLI (`warden send`/`tail`/`key`/`observe`) and
// written into directives.md by the observer's `logDirective` writer (which the
// DirectiveHistory tab's target badge + "Copy agent@host" payload read back).
//
// `container` is null for local/tmux chats (the manual kind: server.js's
// buildAndSpawn / resume factories and chats.js's local discovery both set
// `container: null, key: session`), and a bare `${chat.container}` stringifies
// that null to the literal "null" — so directives.md would record `null@host`
// and every CLI surface would print `null@(local)` (WARDEN-642). Fall back to
// the session key (the tmux session name, always set for local chats), then the
// session, then a literal "local" — matching the `chatKey || container || host`
// lineage in observer.js's resume path and ObserverPanel.tsx's container-fallback
// rendering. Docker/yatfa chats keep their container name unchanged.
//
// The fallback MUST carry no `@`, `(`, `)`, or space: directives.md's header is
// parsed back by readDirectives' regex (`## <ts> → (.+)@([^ ]+) \(([^)]+)\)`),
// and a value with any of those chars breaks the match and silently drops the
// block. tmux session names satisfy this in practice (NAME_RE: letters/digits/
// _-.) — the same constraint docker container names already impose on the writer.
export function agentTarget(chat) {
  return `${chat.container || chat.key || chat.session || 'local'}@${chat.host}`;
}
