// Discover agent chats.
//   yatfa  → docker container with a tmux session `agent` (the agent-bridge TUI).
//   manual → user-spawned `claude` in a host tmux session (from the catalog).
// Both share one shape; tmux.js switches between docker-exec and bare tmux by
// whether `container` is set, and uses `session` for the tmux target.
import { run, runLocalTmux } from './ssh.js';
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
