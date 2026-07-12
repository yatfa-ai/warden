// Discover agent chats.
//   yatfa  → docker container with a tmux session `agent` (the agent-bridge TUI).
//   manual → user-spawned `claude` in a host tmux session (from the catalog).
// Both share one shape; tmux.js switches between docker-exec and bare tmux by
// whether `container` is set, and uses `session` for the tmux target.
import { run, runWithPool, runLocalTmux, shellQuote } from './ssh.js';
import { loadCatalog } from './config.js';
import { ROLES, parseContainerName } from './chatMeta.js';
// Re-export for any external consumer; the canonical home is now ./chatMeta.js.
export { ROLES, parseContainerName };
import { isCompanionTransportEnabled, discover as discoverViaCompanion } from './companion.js';

const NAME_RE = /^[A-Za-z0-9_.-]+$/;
const LOCAL = '(local)';

// One SSH round-trip: list containers AND test each for the `agent` tmux session.
// Emits a TSV row per container:  name \t status \t cwd \t active
//
// `cwd` is derived per-container INSIDE this same loop (no extra round-trip —
// the loop already `docker exec`s each container for has-session). When the
// `agent` session is live we capture the pane's current path (the dir the
// agent's shell is actually in) via `tmux display-message -p '#{pane_current_path}'`;
// otherwise (and as a fallback when display-message yields nothing) we read the
// image's WorkingDir via `docker inspect`. Both resolve to an in-container path
// the host can't reach directly — the git routes wrap git in `docker exec` for
// these chats (WARDEN-235). `active` stays the LAST column so the existing
// `parts.at(-1) === '1'` parse is unchanged; `cwd` is the second-to-last.
//
// `tr -d '\r'` on the pane path tolerates a CRLF that can sneak in over an SSH
// pty; any residual whitespace is trimmed in JS.
export const DISCOVER_SCRIPT = `
docker ps --format '{{.Names}}\\t{{.Status}}' 2>/dev/null | while IFS=$(printf '\\t') read -r name status; do
  [ -z "$name" ] && continue
  cwd=''
  if docker exec "$name" tmux has-session -t agent >/dev/null 2>&1; then
    a=1
    cwd=$(docker exec "$name" tmux display-message -p -t agent '#{pane_current_path}' 2>/dev/null | tr -d '\\r')
  else
    a=0
  fi
  [ -z "$cwd" ] && cwd=$(docker inspect "$name" --format '{{.Config.WorkingDir}}' 2>/dev/null | tr -d '\\r')
  printf '%s\\t%s\\t%s\\t%s\\n' "$name" "$status" "$cwd" "$a"
done
`;

// Parse one TSV row emitted by DISCOVER_SCRIPT into the fields discover() needs.
// Row layout:  name \t status \t cwd \t active
// `active` is the LAST column (parsing it last means reordering the middle never
// shifts it); `cwd` is the second-to-last. Tolerates a legacy 3-column row (no
// cwd) — cwd then reads ''. `status` is everything between `name` and `cwd`,
// rejoined on `\t` in case docker's Status field ever contains a tab. Returns
// null for a blank or too-short row. Pure (no docker, no ssh) so the 4-column
// parse + cwd extraction are unit-testable in CI, which cannot run real
// containers. See WARDEN-235.
export function parseDiscoverRow(line) {
  if (!line || !line.trim()) return null;
  const parts = line.split('\t');
  if (parts.length < 3) return null;
  const name = parts[0];
  const active = parts[parts.length - 1] === '1';
  const cwd = parts.length >= 4 ? parts[parts.length - 2] : '';
  const status = parts.slice(1, parts.length >= 4 ? -2 : -1).join('\t');
  return { name, status, cwd, active };
}

// Pin-first ordering shared by every discovery sort. Returns <0 if `a` is pinned
// and `b` is not, >0 if `b` is pinned and `a` is not, 0 if they tie on pinned
// status — in which case the caller applies its own (active/name) tiebreaker.
//
// Pin membership is matched on the host-prefixed chat `id` (e.g. "(local):agent"),
// NOT the bare `key`/session name: bare names collide across hosts. This is the
// contract the frontend PUT /api/pins must honor.
export function comparePinned(a, b, pins) {
  const pa = pins.has(a.id) ? 0 : 1;
  const pb = pins.has(b.id) ? 0 : 1;
  return pa - pb;
}

// Resolve ALL alive local tmux session names in ONE spawnSync — a single
// `list-sessions` — instead of one `has-session` spawnSync per catalog chat.
// The per-chat loop ran synchronously inside a `.map`, so it blocked the Node
// event loop for ~N × (process-spawn cost) on every discovery; on Windows/MSYS2
// each spawnSync is a heavy tmux.exe fork, and with the 60s lifecycle poll
// (WARDEN-147) PLUS the frontend's own 60s local re-discover, that froze the
// whole server whenever a tick landed — every HTTP request (open settings, etc.)
// queued behind it. One call regardless of N; membership tested in JS. Returns
// an empty Set when no tmux server is running (list-sessions exits non-zero) so
// every catalog chat correctly reads inactive.
function localAliveSessions() {
  const res = runLocalTmux(['list-sessions', '-F', '#{session_name}']);
  if (!res.ok) return new Set();
  return new Set((res.stdout || '').split('\n').map((s) => s.replace(/\r$/, '').trim()).filter(Boolean));
}

export async function discover(host, cfg, opts = {}) {
  // Experimental companion transport (WARDEN-272): for REMOTE hosts only, when
  // WARDEN_COMPANION_TRANSPORT=1 is set, route discover through the bootstrapped
  // host companion (one persistent stdio RPC channel, zero per-op ssh handshakes).
  // The default SSH path below is byte-for-byte unchanged and remains the default.
  // companion.discover() is companion-or-fail: it returns {ok:false} with an
  // actionable error and never silently falls back here.
  if (host !== LOCAL && isCompanionTransportEnabled()) {
    return discoverViaCompanion(host, cfg, opts);
  }

  const timeout = (cfg.connectTimeout ?? 10) * 1000 + 25000;
  const res = await runWithPool(host, DISCOVER_SCRIPT, { timeout }, cfg);
  if (!res.ok) {
    return { host, ok: false, error: (res.stderr || '').trim() || `ssh exited ${res.code}`, chats: [] };
  }
  const session = cfg.tmuxSession || 'agent';
  const chats = [];
  const activeAgents = [];

  // First pass: parse all agents and collect active ones (parseDiscoverRow
  // handles the name \t status \t cwd \t active layout + legacy 3-column rows).
  for (const line of res.stdout.split('\n')) {
    const row = parseDiscoverRow(line);
    if (!row) continue;
    const { name, status, cwd, active } = row;
    const { project, role } = parseContainerName(name);

    const chat = {
      id: `${host}:${name}`, key: name, kind: 'yatfa',
      host, container: name, session,
      project, role, isAgent: ROLES.has(role), active, status,
      // In-container working dir (pane path, else image WorkingDir — resolved in
      // the discover script). Empty when neither could be derived → the git routes
      // treat that as "no cwd" rather than falling back to Warden's own repo.
      // See WARDEN-235.
      cwd: cwd.trim() || undefined,
      lastActivity: null,
    };

    chats.push(chat);
    if (active) {
      activeAgents.push(chat);
    }
  }

  // Second pass: capture activity timestamps concurrently for all active agents.
  // Skipped in the "lean" path (opts.activity === false, used by the lifecycle
  // poll): that diff needs only alive/dead transitions, and this block spawns one
  // fresh ssh per active agent — on Windows (no SSH ControlMaster multiplexing)
  // the bulk of the unconditional 60s fleet sweep's cost. WARDEN-147 regression.
  if (opts.activity !== false && activeAgents.length > 0) {
    const activityResults = await Promise.all(
      activeAgents.map(chat =>
        run(host, `docker exec ${chat.container} tmux capture-pane -t ${session} -p -S - -E - 2>/dev/null | head -1`, { timeout: 1000 })
          .then(activityRes => {
            if (activityRes.ok && activityRes.stdout.trim()) {
              const timestampMatch = activityRes.stdout.match(/\[?(\d{4}-\d{2}-\d{2}[\sT]\d{2}:\d{2}:\d{2})\]?/);
              if (timestampMatch) {
                const date = new Date(timestampMatch[1]);
                if (!isNaN(date.getTime())) {
                  chat.lastActivity = date.getTime();
                }
              }
            }
            return chat;
          })
          .catch(err => {
            console.warn(`Failed to capture activity for ${chat.container}:`, err instanceof Error ? err.message : String(err));
            return chat;
          })
      )
    );
  }

  chats.sort((a, b) => (b.active - a.active) || a.key.localeCompare(b.key));
  return { host, ok: true, chats };
}

// Check which catalog sessions are alive on a host (one ssh round-trip).
async function discoverManual(host, entries, cfg) {
  const sessions = entries.map((e) => e.session).filter((s) => NAME_RE.test(s));
  const activeMap = {};
  if (sessions.length) {
    const script = `for s in ${sessions.join(' ')}; do if tmux has-session -t "$s" >/dev/null 2>&1; then printf '1 %s\\n' "$s"; else printf '0 %s\\n' "$s"; fi; done`;
    const res = await runWithPool(host, script, { timeout: (cfg.connectTimeout ?? 10) * 1000 + 15000 }, cfg);
    if (res.ok) for (const line of res.stdout.split('\n')) {
      const m = line.match(/^([01]) (\S+)$/);
      if (m) activeMap[m[2]] = m[1] === '1';
    }
  }

  // First pass: create result objects and identify active sessions
  const result = entries.map(e => ({ ...e, active: !!activeMap[e.session], lastActivity: null }));
  const activeEntries = result.filter(e => e.active);

  // Second pass: capture activity timestamps concurrently for all active sessions
  if (activeEntries.length > 0) {
    await Promise.all(
      activeEntries.map(entry =>
        run(host, `tmux capture-pane -t ${entry.session} -p -S - -E - 2>/dev/null | head -1`, { timeout: 1000 })
          .then(activityRes => {
            if (activityRes.ok && activityRes.stdout.trim()) {
              const timestampMatch = activityRes.stdout.match(/\[?(\d{4}-\d{2}-\d{2}[\sT]\d{2}:\d{2}:\d{2})\]?/);
              if (timestampMatch) {
                const date = new Date(timestampMatch[1]);
                if (!isNaN(date.getTime())) {
                  entry.lastActivity = date.getTime();
                }
              }
            }
          })
          .catch(err => {
            console.warn(`Failed to capture activity for ${entry.session}:`, err instanceof Error ? err.message : String(err));
          })
      )
    );
  }

  return result;
}

export async function discoverAll(hosts, cfg, opts = {}) {
  const results = await Promise.all(hosts.map((h) => discover(h, cfg, { activity: opts.activity })));
  let all = [];
  const errors = results.filter((r) => !r.ok).map((r) => ({ host: r.host, error: r.error }));
  for (const r of results) if (r.ok) all = all.concat(r.chats);

  // catalog chats (all kind:'tmux' now): local host → local tmux; remote → ssh.
  const catalog = loadCatalog();
  if (catalog.length) {
    const byHost = {};
    for (const e of catalog) (byHost[e.host || LOCAL] ||= []).push(e);
    await Promise.all(Object.entries(byHost).map(async ([host, entries]) => {
      // Local: ONE spawnSync (list-sessions) resolves every catalog chat's
      // alive/dead state via Set membership — not N blocking has-session calls.
      let actives;
      if (host === LOCAL) {
        const alive = localAliveSessions();
        actives = entries.map((e) => ({ e, active: alive.has(e.session) }));
      } else {
        actives = (await discoverManual(host, entries, cfg)).map((e) => ({ e, active: e.active }));
      }

      // Create result objects first
      const resultObjects = actives.map(({ e, active }) => ({
        id: `${host}:${e.session}`, key: e.session, kind: 'tmux',
        host, container: null, session: e.session,
        project: host === LOCAL ? 'local' : 'manual', role: 'claude', name: e.name || e.session,
        cwd: e.cwd, cmd: e.cmd,
        active, status: active ? 'running' : 'idle',
        lastActivity: null,
      }));

      // Capture activity timestamps concurrently for active local sessions.
      // Skipped in the lean path (lifecycle poll) — that diff needs only alive/dead.
      const activeLocalSessions = resultObjects.filter(obj => obj.active && host === LOCAL);
      if (opts.activity !== false && activeLocalSessions.length > 0) {
        await Promise.all(
          activeLocalSessions.map(obj =>
            Promise.resolve(runLocalTmux(['capture-pane', '-t', obj.session, '-p', '-S', '-', '-E', '-']))
              .then(activityRes => {
                if (activityRes.ok && activityRes.stdout.trim()) {
                  const timestampMatch = activityRes.stdout.match(/\[?(\d{4}-\d{2}-\d{2}[\sT]\d{2}:\d{2}:\d{2})\]?/);
                  if (timestampMatch) {
                    const date = new Date(timestampMatch[1]);
                    if (!isNaN(date.getTime())) {
                      obj.lastActivity = date.getTime();
                    }
                  }
                }
              })
              .catch(err => {
                console.warn(`Failed to capture activity for local session ${obj.session}:`, err instanceof Error ? err.message : String(err));
              })
          )
        );
      }

      all.push(...resultObjects);
    }));
  }

  const pins = new Set(cfg.pins || []);
  all.sort((a, b) => {
    const pc = comparePinned(a, b, pins);
    if (pc !== 0) return pc;
    return (b.active - a.active) || a.id.localeCompare(b.id);
  });
  return { chats: all, errors };
}

// ---------------- lazy discovery ----------------

// Build the chat object for a catalog/manual entry. `active` may be true | false | null
// (null = undiscovered, in lazy mode). Single source of truth for the tmux-catalog shape
// (mirrors the inline build in discoverAll above).
function toCatalogChat(host, entry, active, lastActivity) {
  return {
    id: `${host}:${entry.session}`, key: entry.session, kind: 'tmux',
    host, container: null, session: entry.session,
    project: host === LOCAL ? 'local' : 'manual', role: 'claude',
    name: entry.name || entry.session, cwd: entry.cwd, cmd: entry.cmd,
    active,
    status: active == null ? 'unknown' : (active ? 'running' : 'idle'),
    lastActivity: lastActivity ?? null,
  };
}

// Disk-only catalog list — ZERO ssh. Used for the instant initial /api/chats in lazy mode.
export function catalogChats(cfg) {
  const pins = new Set(cfg.pins || []);
  const chats = loadCatalog().map((e) => toCatalogChat(e.host || LOCAL, e, null, null));
  chats.sort((a, b) => {
    const pc = comparePinned(a, b, pins);
    if (pc !== 0) return pc;
    return a.id.localeCompare(b.id);
  });
  return { chats, errors: [] };
}

// Discover ONE host on demand: yatfa docker containers + that host's catalog chats, with
// live active/lastActivity. Called when the user clicks a host. SSH cost is bounded to the
// single host. Returns { host, chats }.
export async function discoverHost(host, cfg) {
  const pins = new Set(cfg.pins || []);
  const chats = [];

  if (host === LOCAL) {
    const entries = loadCatalog().filter((e) => (e.host || LOCAL) === LOCAL);
    // ONE spawnSync (list-sessions) resolves every local catalog chat's
    // alive/dead state — not N blocking has-session calls (this runs on the
    // frontend's 60s /api/discover refresh for THIS_MACHINE too).
    const alive = localAliveSessions();
    const objs = entries.map((e) => ({
      e, o: toCatalogChat(LOCAL, e, alive.has(e.session), null),
    })).map((x) => x.o);
    await Promise.all(objs.filter((o) => o.active).map((o) =>
      Promise.resolve(runLocalTmux(['capture-pane', '-t', o.session, '-p', '-S', '-', '-E', '-']))
        .then((r) => {
          if (r.ok && r.stdout.trim()) {
            const m = r.stdout.match(/\[?(\d{4}-\d{2}-\d{2}[\sT]\d{2}:\d{2}:\d{2})\]?/);
            if (m) { const d = new Date(m[1]); if (!isNaN(d.getTime())) o.lastActivity = d.getTime(); }
          }
        }).catch(() => {})
    ));
    chats.push(...objs);
  } else {
    const yatfa = await discover(host, cfg); // already in chat shape
    if (yatfa.ok) chats.push(...yatfa.chats);
    const entries = loadCatalog().filter((e) => (e.host || LOCAL) === host);
    if (entries.length) {
      const manual = await discoverManual(host, entries, cfg); // sets .active + .lastActivity
      chats.push(...manual.map((m) => toCatalogChat(host, m, m.active, m.lastActivity)));
    }
  }

  chats.sort((a, b) => {
    const pc = comparePinned(a, b, pins);
    if (pc !== 0) return pc;
    const aa = a.active ? 1 : 0, ab = b.active ? 1 : 0;
    if (aa !== ab) return ab - aa;
    return a.id.localeCompare(b.id);
  });
  return { host, chats };
}

// Capture tmux pane content from multiple chats concurrently.
// Groups by host to minimize SSH round-trips. Returns a map of chat key -> pane content.
export async function capturePanes(chats, cfg = {}) {
  const byHost = {};
  for (const c of chats) (byHost[c.host] ||= []).push(c);
  const out = {};
  await Promise.all(Object.entries(byHost).map(async ([host, list]) => {
    if (host === LOCAL) {
      for (const c of list) {
        const r = runLocalTmux(['capture-pane', '-t', c.session || c.container, '-p', '-e', '-S', '-60', '-E', '-']);
        if (r.ok) out[c.key] = r.stdout;
      }
      return;
    }
    const script = list.map((c) => {
      const t = c.container ? `docker exec ${shellQuote(c.container)} tmux` : 'tmux';
      const s = shellQuote(c.session || c.container || 'agent');
      return `printf '___B_${c.key}___\\n'; ${t} capture-pane -t ${s} -p -e -S -60 -E - 2>/dev/null; printf '\\n___E_${c.key}___\\n'`;
    }).join('; ');
    const res = await runWithPool(host, script, { timeout: 15000 }, cfg);
    if (!res.ok) return;
    let cur = null;
    const buf = [];
    for (const ln of res.stdout.split('\n')) {
      const b = ln.match(/^___B_(.+)___$/);
      if (b) { cur = b[1]; buf.length = 0; continue; }
      const e = ln.match(/^___E_(.+)___$/);
      if (e) { if (cur) out[cur] = buf.join('\n'); cur = null; continue; }
      if (cur != null) buf.push(ln);
    }
  }));
  return out;
}

/**
 * Resolve a chat ID substring to a single chat object.
 * @param {string} id - User-provided ID substring
 * @param {Array} cachedChats - Current cached chat list
 * @param {Function} refreshFn - Async function that returns {chats, errors}
 * @returns {{chat?: object, error?: string}} Returns {chat} on success, {error} on failure
 */
export function resolveChat(id, cachedChats, refreshFn) {
  // First pass: exact matches (highest priority)
  const exactMatches = cachedChats.filter((c) =>
    c.id === id ||
    (c.key && c.key === id) ||
    c.container === id ||
    (c.session && c.session === id)
  );

  if (exactMatches.length === 1) return { chat: exactMatches[0] };
  if (exactMatches.length > 1) {
    return { error: `ambiguous "${id}" matches: ${exactMatches.map((c) => c.id).join(', ')}` };
  }

  // Second pass: substring matches (lower priority)
  const substringMatches = cachedChats.filter((c) =>
    (c.id && c.id.endsWith(':' + id)) ||
    (c.container && c.container.includes(id)) ||
    (c.session && c.session.includes(id)) ||
    (c.id && c.id.includes(id)) ||
    c.project === id ||
    c.role === id
  );

  if (substringMatches.length === 1) return { chat: substringMatches[0] };
  if (substringMatches.length > 1) {
    return { error: `ambiguous "${id}" matches: ${substringMatches.map((c) => c.id).join(', ')}` };
  }

  // No match found - signal that refresh is needed (caller will invoke refreshFn)
  return { needsRefresh: true };
}

/**
 * Resolve a chat with automatic refresh on no match.
 * This is a convenience wrapper that handles the refresh logic inline.
 * @param {string} id - User-provided ID substring
 * @param {Array} cachedChats - Current cached chat list (will be updated if refresh happens)
 * @param {Function} refreshFn - Async function that returns {chats, errors}
 * @returns {{chat?: object, error?: string, errors?: Array}} Returns {chat} on success, {error} on failure
 */
export async function resolveChatWithRefresh(id, cachedChats, refreshFn) {
  const result = resolveChat(id, cachedChats, refreshFn);

  // If we got a definitive result or error, return it
  if (!result.needsRefresh) {
    return result;
  }

  // No match in cache - trigger refresh
  const { chats, errors } = await refreshFn();

  // Try matching again with fresh data (FULL matching logic via resolveChat)
  const result2 = resolveChat(id, chats, null);

  if (result2.chat) return { chat: result2.chat, errors };
  if (result2.error) return { error: result2.error, errors };

  return { error: `no chat matches "${id}"`, errors };
}
