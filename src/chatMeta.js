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
// both paths did inline. lastActivity starts at null: the discovery paths fill
// it in AFTER this literal is built — the default SSH path from the discover
// row's #{window_activity} column (windowActivityToMs, WARDEN-1340), the
// companion transport by parsing the host-side-captured leading pane line with
// parseActivityTimestamp() below until its Go side moves to window_activity too
// (WARDEN-376 closed the companion's read-parity gap — it now captures that
// line host-side too, where slice 1 had left it null).
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
// carries no parseable timestamp. This is the timestamp regex the COMPANION
// transport path uses (src/companion.js mapCompanionContainers): until the Go
// side (companion/main.go) is widened to supply #{window_activity} too, the
// companion's `Pane` field is still the host-side-captured leading pane line, and
// this helper parses it. The default SSH path (src/chats.js) NO LONGER parses
// pane text at all — every one of its legs derives lastActivity from
// #{window_activity} via windowActivityToMs() below (WARDEN-1340: the leading
// line of a full-scrollback capture is the OLDEST line of the pane, a frozen
// clock). Kept for the companion leg only — removing it would break the
// (unchanged) Go binary's contract, whose dist/ binaries cannot be rebuilt in
// this sandbox (no Go toolchain; WARDEN-376 lesson). Mirrors the regex the
// default path accepted inline: an optional `[`/`]` around a
// `YYYY-MM-DD[space|T]HH:MM:SS` timestamp. Returns null for empty/non-matching
// input OR a syntactically-matching but invalid calendar date so callers leave
// lastActivity null rather than stamping NaN. (WARDEN-376)
export function parseActivityTimestamp(line) {
  const s = line == null ? '' : String(line);
  if (!s.trim()) return null;
  const m = s.match(/\[?(\d{4}-\d{2}-\d{2}[\sT]\d{2}:\d{2}:\d{2})\]?/);
  if (!m) return null;
  const ms = new Date(m[1]).getTime();
  return Number.isNaN(ms) ? null : ms;
}

// WARDEN-1340: the ONLY reader of tmux's `#{window_activity}` for lastActivity.
// window_activity is epoch SECONDS (tmux's own record of the window's last
// OUTPUT — output, not input; stable while quiet; unperturbed by observation);
// lastActivity is ms-since-epoch everywhere downstream — getHealthState's bands
// and stampCatalogActivity's only-when-fresher guard both assume ms, and a raw
// seconds value would read as ~1970 and be REJECTED by that guard forever (every
// real update would look older than the stored 1970-era stamp). One shared
// definition for all four JS legs (the discover row in chats.js discover(),
// discoverManual, and the two local-tmux legs) so none can drift onto seconds.
// Accepts the raw display-message stdout (trailing newline tolerated). Returns
// null for empty/garbage/non-positive input so callers leave lastActivity null
// rather than stamping a bogus value.
export function windowActivityToMs(stdout) {
  // Strict: the WHOLE trimmed payload must be digits — display-message's
  // window_activity readout is exactly that, and anything else is a failed read,
  // not an activity time to truncate to.
  const m = String(stdout == null ? '' : stdout).trim().match(/^(\d+)$/);
  if (!m) return null;
  const secs = Number(m[1]);
  return Number.isFinite(secs) && secs > 0 ? secs * 1000 : null;
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

// The tmux TARGET for a chat: an explicit session wins; a yatfa chat with no
// session targets its container; nothing set means the default 'agent' session.
// ONE definition shared by the default SSH path (chats.js buildCaptureScript)
// and the companion transport (companion.js), so the two produce byte-equal
// targets — the invariant this module exists to hold.
//
// NOT to be confused with agentTarget() above, which builds the DISPLAY identity
// (container -> key -> session -> 'local', plus @host) for the CLI and directives
// log. Different chain, different purpose; keep them separate.
//
// `||` (not `??`) is load-bearing: an EMPTY session string must fall through to
// the container, exactly as every hand-written copy did.
//
// Deliberately NOT the home for the `cfg.tmuxSession || 'agent'` ladder
// (companion.js discover, chats.js discover, tmux.js sess()) — that chain has no
// container leg and resolves a config-level session.
export function paneTarget(session, container) {
  return session || container || 'agent';
}
