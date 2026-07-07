// Discover agent chats.
//   yatfa  → docker container with a tmux session `agent` (the agent-bridge TUI).
//   manual → user-spawned `claude` in a host tmux session (from the catalog).
// Both share one shape; tmux.js switches between docker-exec and bare tmux by
// whether `container` is set, and uses `session` for the tmux target.
import { run, runLocalTmux, shellQuote } from './ssh.js';
import { loadCatalog } from './config.js';

const ROLES = new Set(['planner', 'worker', 'reviewer', 'researcher']);
const NAME_RE = /^[A-Za-z0-9_.-]+$/;
const LOCAL = '(local)';

// One SSH round-trip: list containers AND test each for the `agent` tmux session.
const DISCOVER_SCRIPT = `
docker ps --format '{{.Names}}\\t{{.Status}}' 2>/dev/null | while IFS=$(printf '\\t') read -r name status; do
  [ -z "$name" ] && continue
  if docker exec "$name" tmux has-session -t agent >/dev/null 2>&1; then a=1; else a=0; fi
  printf '%s\\t%s\\t%s\\n' "$name" "$status" "$a"
done
`;

function parseContainerName(name) {
  const idx = name.lastIndexOf('-');
  if (idx < 0) return { project: name, role: '' };
  return { project: name.slice(0, idx), role: name.slice(idx + 1) };
}

export async function discover(host, cfg) {
  const timeout = (cfg.connectTimeout ?? 10) * 1000 + 25000;
  const res = await run(host, DISCOVER_SCRIPT, { timeout });
  if (!res.ok) {
    return { host, ok: false, error: (res.stderr || '').trim() || `ssh exited ${res.code}`, chats: [] };
  }
  const session = cfg.tmuxSession || 'agent';
  const chats = [];
  for (const line of res.stdout.split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    const name = parts[0];
    const status = parts.slice(1, -1).join('\t');
    const active = parts[parts.length - 1] === '1';
    const { project, role } = parseContainerName(name);
    chats.push({
      id: `${host}:${name}`, key: name, kind: 'yatfa',
      host, container: name, session,
      project, role, isAgent: ROLES.has(role), active, status,
    });
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
    const res = await run(host, script, { timeout: (cfg.connectTimeout ?? 10) * 1000 + 15000 });
    if (res.ok) for (const line of res.stdout.split('\n')) {
      const m = line.match(/^([01]) (\S+)$/);
      if (m) activeMap[m[2]] = m[1] === '1';
    }
  }
  return entries.map((e) => ({ ...e, active: !!activeMap[e.session] }));
}

export async function discoverAll(hosts, cfg) {
  const results = await Promise.all(hosts.map((h) => discover(h, cfg)));
  let all = [];
  const errors = results.filter((r) => !r.ok).map((r) => ({ host: r.host, error: r.error }));
  for (const r of results) if (r.ok) all = all.concat(r.chats);

  // catalog chats (all kind:'tmux' now): local host → local tmux; remote → ssh.
  const catalog = loadCatalog();
  if (catalog.length) {
    const byHost = {};
    for (const e of catalog) (byHost[e.host || LOCAL] ||= []).push(e);
    await Promise.all(Object.entries(byHost).map(async ([host, entries]) => {
      const actives = host === LOCAL
        ? entries.map((e) => ({ e, active: runLocalTmux(['has-session', '-t', e.session]).ok }))
        : (await discoverManual(host, entries, cfg)).map((e) => ({ e, active: e.active }));
      for (const { e, active } of actives) {
        all.push({
          id: `${host}:${e.session}`, key: e.session, kind: 'tmux',
          host, container: null, session: e.session,
          project: host === LOCAL ? 'local' : 'manual', role: 'claude', name: e.name || e.session,
          cwd: e.cwd, cmd: e.cmd,
          active, status: active ? 'running' : 'idle',
        });
      }
    }));
  }

  const pins = new Set(cfg.pins || []);
  all.sort((a, b) => {
    const pa = pins.has(a.id) ? 0 : 1;
    const pb = pins.has(b.id) ? 0 : 1;
    if (pa !== pb) return pa - pb;
    return (b.active - a.active) || a.id.localeCompare(b.id);
  });
  return { chats: all, errors };
}

// Capture tmux pane content from multiple chats concurrently.
// Groups by host to minimize SSH round-trips. Returns a map of chat key -> pane content.
export async function capturePanes(chats) {
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
    const res = await run(host, script, { timeout: 15000 });
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

  // Try matching again with fresh data (only substring/project/role matches after refresh)
  const matches = chats.filter((c) =>
    (c.container && c.container.includes(id)) ||
    (c.session && c.session.includes(id)) ||
    (c.id && c.id.includes(id)) ||
    c.project === id ||
    c.role === id
  );

  if (matches.length === 0) {
    return { error: `no chat matches "${id}"`, errors };
  }
  if (matches.length > 1) {
    return { error: `ambiguous "${id}" matches: ${matches.map((c) => c.id).join(', ')}`, errors };
  }

  return { chat: matches[0], errors };
}
