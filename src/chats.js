// Discover agent chats.
//   yatfa  → docker container with a tmux session `agent` (the agent-bridge TUI).
//   manual → user-spawned `claude` in a host tmux session (from the catalog).
// Both share one shape; tmux.js switches between docker-exec and bare tmux by
// whether `container` is set, and uses `session` for the tmux target.
import { run, runWithPool, runLocalTmux, shellQuote } from './ssh.js';
import { loadCatalog, stampCatalogActivity } from './config.js';
import { ROLES, parseContainerName, buildChat, sortChats, parseActivityTimestamp } from './chatMeta.js';
// Re-export for any external consumer; the canonical home is now ./chatMeta.js.
export { ROLES, parseContainerName };
import { isCompanionTransportEnabled, discover as discoverViaCompanion, capturePanes as capturePanesViaCompanion, hasFreshPaneDelta, readPaneDeltas } from './companion.js';

const NAME_RE = /^[A-Za-z0-9_.-]+$/;
const LOCAL = '(local)';

// Sentinel that opens the per-container docker-stats block appended to
// DISCOVER_SCRIPT (WARDEN-309). Picked to (a) never collide with a container
// name: docker names must START with [a-zA-Z0-9] (regex `/?[a-zA-Z0-9][a-zA-Z0-9_.-]+`),
// so a LEADING underscore — `___WARDEN_STATS___` — is an illegal container name,
// even though underscores are legal later in a name. (The leading `_` is the
// guard, not an underscore-run per se.) And (b) it is unlike any discover row,
// so a stray sentinel line is harmlessly skipped by parseDiscoverRow (single
// column → null). Defined once so the script emitter and the splitter cannot drift.
const STATS_SENTINEL = '___WARDEN_STATS___';

// One SSH round-trip: list containers AND test each for the `agent` tmux session,
// then ONE `docker stats --no-stream` pass for per-container CPU/memory.
// Emits a TSV row per container:  name \t status \t cwd \t active
// followed by a sentinel-opened docker-stats block (see STATS_SENTINEL).
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
# Per-container resource usage (WARDEN-309): ONE \`docker stats --no-stream\`
# collection for every container on this host, appended so it rides the SAME SSH
# round-trip as the discover loop above (no extra round-trip on the click-to-
# discover path). \`--no-stream\` takes a single sample (~1-2s per host — added to
# every discover incl. the 60s engaged-host refresh; acceptable per WARDEN-309)
# and exits rather than streaming. The block is opened by a sentinel and parsed
# by splitDiscoverOutput/parseDockerStats into a separate name→{cpuPct,memPct,
# memUsage} map, so the tested 4-column parseDiscoverRow above is untouched.
# \`2>/dev/null\` swallows the stderr MESSAGE of a missing/unavailable
# \`docker stats\` (older host, no permission, daemon hiccup) — but it does NOT
# touch its EXIT code, and since this is the LAST command in the script, a non-
# zero exit would become the script's exit code → run() ok:false (ssh.js:356) →
# discover() returns chats:[] → EVERY agent on the host vanishes. The trailing
# \`|| true\` is what neutralizes that exit code, so a stats failure yields an
# EMPTY stats block → parseDockerStats returns {} → chats simply omit the
# fields → the UI renders nothing (graceful N/A, success criterion #3).
# Resource capture belongs to the SSH discover path ONLY — never the 10s
# /api/health poll, which stays cache-derived (WARDEN-147), and never buildChat
# (shared with the companion transport, WARDEN-272).
printf '%s\\n' '${STATS_SENTINEL}'
docker stats --no-stream --format '{{.Name}}\\t{{.CPUPerc}}\\t{{.MemPerc}}\\t{{.MemUsage}}' 2>/dev/null || true
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

// Split DISCOVER_SCRIPT stdout into the discover-row region and the docker-stats
// region (WARDEN-309). The stats block is everything AFTER the STATS_SENTINEL
// line; it is parsed separately by parseDockerStats so the tested 4-column
// parseDiscoverRow never sees a stats row (which would otherwise masquerade as a
// chat: `name\t42.30%\t15.70%\t310MiB / 2GiB` has 4 columns). The sentinel is
// printed BEFORE `docker stats` runs, so even when `docker stats` fails the
// sentinel is present and the block after it is simply empty → empty map → chats
// omit the fields → UI renders nothing (graceful N/A). (The trailing `|| true` on
// `docker stats` keeps that failure from aborting the whole script — see
// DISCOVER_SCRIPT.) If the sentinel is ABSENT entirely (companion path, or a
// pre-stats script failure that already made discover() return ok:false), the
// whole stdout is treated as rows. Pure (no docker, no ssh) so it is unit-
// testable alongside parseDockerStats. See WARDEN-309.
export function splitDiscoverOutput(stdout) {
  const s = stdout == null ? '' : String(stdout);
  const idx = s.indexOf(STATS_SENTINEL);
  if (idx === -1) return { rows: s, statsBlock: '' };
  const rows = s.slice(0, idx);
  // Drop the remainder of the sentinel's own line (up to and including its
  // trailing newline) so the stats block starts cleanly at the first docker-stats
  // row rather than with a leading empty/junk line.
  let rest = s.slice(idx + STATS_SENTINEL.length);
  const nl = rest.indexOf('\n');
  if (nl !== -1) rest = rest.slice(nl + 1);
  return { rows, statsBlock: rest };
}

// Parse a single `42.30%` / `15.70%` percent field into a number (42.3), or null
// when blank / non-numeric. Trims whitespace and strips a trailing '%'. Pure.
function parsePercent(s) {
  if (s == null) return null;
  const m = String(s).trim().replace(/%$/, '').trim();
  if (m === '') return null;
  const n = Number(m);
  return Number.isFinite(n) ? n : null;
}

// Parse the stdout of `docker stats --no-stream --format
// '{{.Name}}\t{{.CPUPerc}}\t{{.MemPerc}}\t{{.MemUsage}}'` into a
// name → { cpuPct?, memPct?, memUsage? } map (WARDEN-309). Each line is e.g.:
//   myproject-worker\t42.30%\t15.70%\t310.2MiB / 2GiB
// The trailing '%' on the percent fields is stripped; non-numeric/empty values
// are omitted from the entry. `docker stats` on older daemons prefixed names with
// '/' (e.g. `/myproject-worker`); that leading slash is stripped here so the key
// matches the `docker ps` name parseDiscoverRow yields. `{{.MemUsage}}` itself
// contains ' / ' (not a tab) so it stays one field. Pure (no docker, no ssh) so
// the parse is unit-testable in CI, which cannot run real containers — mirroring
// parseDiscoverRow's testability. See WARDEN-309.
export function parseDockerStats(stdout) {
  const out = {};
  for (const line of (stdout == null ? '' : String(stdout)).split('\n')) {
    if (!line || !line.trim()) continue;
    const parts = line.split('\t');
    if (parts.length < 2) continue;
    const name = (parts[0] || '').replace(/^\//, '').trim();
    if (!name) continue;
    const cpuPct = parsePercent(parts[1]);
    const memPct = parsePercent(parts[2]);
    const memUsage = parts.slice(3).join('\t').trim();
    const entry = {};
    if (cpuPct != null) entry.cpuPct = cpuPct;
    if (memPct != null) entry.memPct = memPct;
    if (memUsage) entry.memUsage = memUsage;
    if (Object.keys(entry).length) out[name] = entry;
  }
  return out;
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

export async function discover(host, cfg, opts = {}, deps = {}) {
  // Experimental companion transport (WARDEN-272): for REMOTE hosts only, when
  // WARDEN_COMPANION_TRANSPORT=1 is set, route discover through the bootstrapped
  // host companion (one persistent stdio RPC channel, zero per-op ssh handshakes).
  // The default SSH path below is byte-for-byte unchanged and remains the default.
  // companion.discover() is companion-or-fail: it returns {ok:false} with an
  // actionable error and never silently falls back here.
  //
  // `deps` is a test seam for the routing guard (the wiring that decides default
  // vs companion is otherwise untested): isCompanionTransportEnabled /
  // discoverViaCompanion / runWithPool are injectable so a test can assert
  // delegation AND non-fallthrough to the default path without real ssh.
  const isEnabled = deps.isCompanionTransportEnabled ?? isCompanionTransportEnabled;
  if (host !== LOCAL && isEnabled()) {
    return (deps.discoverViaCompanion ?? discoverViaCompanion)(host, cfg, opts);
  }

  const runWithPoolFn = deps.runWithPool ?? runWithPool;
  // The second-pass activity capture uses the raw `run` (one fresh ssh per
  // active agent). Injectable via deps.run so the capture path — which every
  // existing discover test skips with { activity: false } — can be exercised
  // end-to-end and the shared-helper refactor locked as a no-op. Defaults to
  // the real run, so production behavior is unchanged. (WARDEN-376)
  const runFn = deps.run ?? run;
  const timeout = (cfg.connectTimeout ?? 10) * 1000 + 25000;
  const res = await runWithPoolFn(host, DISCOVER_SCRIPT, { timeout }, cfg);
  if (!res.ok) {
    return { host, ok: false, error: (res.stderr || '').trim() || `ssh exited ${res.code}`, chats: [] };
  }
  const session = cfg.tmuxSession || 'agent';
  const chats = [];
  const activeAgents = [];

  // Split the docker-stats block (WARDEN-309) off the discover rows. The stats
  // ride the SAME SSH round-trip as the discover loop but are parsed into a
  // separate name→stats map so the tested 4-column parseDiscoverRow is never fed
  // a stats row. An absent block (older host / `docker stats` unavailable) yields
  // an empty map → chats simply omit cpuPct/memPct/memUsage → UI renders nothing.
  const { rows, statsBlock } = splitDiscoverOutput(res.stdout);
  const stats = parseDockerStats(statsBlock);

  // First pass: parse all agents and collect active ones (parseDiscoverRow
  // handles the name \t status \t cwd \t active layout + legacy 3-column rows).
  for (const line of rows.split('\n')) {
    const row = parseDiscoverRow(line);
    if (!row) continue;
    const { name, status, cwd, active } = row;

    // The chat literal is shared with the companion path via buildChat(), so the
    // two discovery paths cannot drift on shape (WARDEN-272 review #5).
    const chat = buildChat(host, name, status, cwd, active, session);

    // Attach per-container CPU/memory from the docker-stats block (WARDEN-309).
    // Attached HERE in discover() ONLY — NEVER in buildChat, whose literal is
    // shared byte-for-byte with the unmerged companion transport (WARDEN-272);
    // perturbing it breaks that shared contract. A container with no stats row
    // (stats unavailable, or a non-yatfa container) simply omits the fields.
    const s = stats[name];
    if (s) {
      if (s.cpuPct != null) chat.cpuPct = s.cpuPct;
      if (s.memPct != null) chat.memPct = s.memPct;
      if (s.memUsage) chat.memUsage = s.memUsage;
    }

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
        runFn(host, `docker exec ${chat.container} tmux capture-pane -t ${session} -p -S - -E - 2>/dev/null | head -1`, { timeout: 1000 })
          .then(activityRes => {
            if (activityRes.ok) {
              // Shared timestamp parse (chatMeta.parseActivityTimestamp) — the
              // SAME helper the companion path uses, so lastActivity is parsed
              // identically by both discovery paths. (WARDEN-376)
              const ts = parseActivityTimestamp(activityRes.stdout);
              if (ts != null) {
                chat.lastActivity = ts;
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

  sortChats(chats);
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

  // First pass: create result objects and identify active sessions.
  // Inactive sessions hydrate lastActivity from the persisted catalog entry so a
  // chat that just went dead still carries a usable last-known-activity for
  // recency ordering in Fleet Health (WARDEN-245).
  const result = entries.map(e => ({ ...e, active: !!activeMap[e.session], lastActivity: e.lastActivity ?? null }));
  const activeEntries = result.filter(e => e.active);

  // Second pass: capture activity timestamps concurrently for all active sessions
  if (activeEntries.length > 0) {
    await Promise.all(
      activeEntries.map(entry =>
        run(host, `tmux capture-pane -t ${entry.session} -p -S - -E - 2>/dev/null | head -1`, { timeout: 1000 })
          .then(activityRes => {
            if (activityRes.ok) {
              // Shared timestamp parse — same helper the companion + yatfa path
              // use (WARDEN-376).
              const ts = parseActivityTimestamp(activityRes.stdout);
              if (ts != null) {
                entry.lastActivity = ts;
                // Persist while alive so the value survives the chat later going
                // inactive AND a warden restart (WARDEN-245).
                stampCatalogActivity(host, entry.session, entry.lastActivity);
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

      // Create result objects first. Inactive catalog chats hydrate lastActivity
      // from the persisted entry so a just-dead chat keeps a usable last-known
      // activity for Fleet Health recency ordering (WARDEN-245).
      const resultObjects = actives.map(({ e, active }) => ({
        id: `${host}:${e.session}`, key: e.session, kind: 'tmux',
        host, container: null, session: e.session,
        project: host === LOCAL ? 'local' : 'manual', role: 'claude', name: e.name || e.session,
        cwd: e.cwd, cmd: e.cmd,
        active, status: active ? 'running' : 'idle',
        lastActivity: e.lastActivity ?? null,
      }));

      // Capture activity timestamps concurrently for active local sessions.
      // Skipped in the lean path (lifecycle poll) — that diff needs only alive/dead.
      const activeLocalSessions = resultObjects.filter(obj => obj.active && host === LOCAL);
      if (opts.activity !== false && activeLocalSessions.length > 0) {
        await Promise.all(
          activeLocalSessions.map(obj =>
            Promise.resolve(runLocalTmux(['capture-pane', '-t', obj.session, '-p', '-S', '-', '-E', '-']))
              .then(activityRes => {
                if (activityRes.ok) {
                  // Shared timestamp parse — same helper the companion + remote
                  // manual path use (WARDEN-376).
                  const ts = parseActivityTimestamp(activityRes.stdout);
                  if (ts != null) {
                    obj.lastActivity = ts;
                    // Persist while alive so lastActivity survives the chat going
                    // inactive and a warden restart (WARDEN-245).
                    stampCatalogActivity(host, obj.session, obj.lastActivity);
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
// (mirrors the inline build in discoverAll above). `lastActivity` is the LIVE-captured
// value (null for inactive/undiscovered chats); when it is null we fall back to the
// entry's persisted last-known activity so a dead chat still orders by recency in
// Fleet Health and survives a warden restart (WARDEN-245).
function toCatalogChat(host, entry, active, lastActivity) {
  return {
    id: `${host}:${entry.session}`, key: entry.session, kind: 'tmux',
    host, container: null, session: entry.session,
    project: host === LOCAL ? 'local' : 'manual', role: 'claude',
    name: entry.name || entry.session, cwd: entry.cwd, cmd: entry.cmd,
    active,
    status: active == null ? 'unknown' : (active ? 'running' : 'idle'),
    lastActivity: lastActivity ?? entry.lastActivity ?? null,
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
          if (r.ok) {
            // Shared timestamp parse — same helper every discovery path uses
            // (WARDEN-376).
            const ts = parseActivityTimestamp(r.stdout);
            if (ts != null) {
              o.lastActivity = ts;
              // Persist while alive so lastActivity survives the chat going
              // inactive and a warden restart (WARDEN-245).
              stampCatalogActivity(LOCAL, o.session, o.lastActivity);
            }
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

// Build the batched, sentinel-framed capture script for one host's panes. Each
// pane is bracketed by ___B_<key>___ / ___E_<key>___ sentinels; the tmux
// invocation is `docker exec <container> tmux` when a container is set, else
// bare `tmux` (so bare-tmux / manual chats still work). This is the canonical
// framing BOTH the default runWithPool path and the Go companion
// (companion/main.go buildCaptureScript) reproduce — extracted so the contract
// is unit-testable in one place.
export function buildCaptureScript(list) {
  return list.map((c) => {
    const t = c.container ? `docker exec ${shellQuote(c.container)} tmux` : 'tmux';
    const s = shellQuote(c.session || c.container || 'agent');
    return `printf '___B_${c.key}___\\n'; ${t} capture-pane -t ${s} -p -e -S -60 -E - 2>/dev/null; printf '\\n___E_${c.key}___\\n'`;
  }).join('; ');
}

// Parse the stdout of the batched capture script into a key->content map. A
// ___B_<key>___ line opens a pane (resetting the buffer), ___E_<key>___ closes
// it (committing the buffered lines joined by '\n'); lines outside a block are
// ignored. This is the SAME contract the Go companion's parseCaptureSentinels
// implements — extracted so the host-side framing can be tested against it.
export function parseCaptureSentinels(stdout) {
  const out = {};
  let cur = null;
  const buf = [];
  for (const ln of (stdout || '').split('\n')) {
    const b = ln.match(/^___B_(.+)___$/);
    if (b) { cur = b[1]; buf.length = 0; continue; }
    const e = ln.match(/^___E_(.+)___$/);
    if (e) { if (cur) out[cur] = buf.join('\n'); cur = null; continue; }
    if (cur != null) buf.push(ln);
  }
  return out;
}

// Capture tmux pane content from multiple chats concurrently.
// Groups by host to minimize SSH round-trips. Returns a map of chat key -> pane content.
// `deps` is a test seam (defaults to {} in production, where capturePanesViaCompanion
// bootstraps the real SSH channel) forwarded to the companion transport so the
// WARDEN-413 skip path is drivable end-to-end with a fake channel. (WARDEN-413)
export async function capturePanes(chats, cfg = {}, deps = {}) {
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
    // Experimental companion transport (WARDEN-276): for REMOTE hosts, when
    // WARDEN_COMPANION_TRANSPORT=1 is set, route capture-pane through the
    // persistent companion channel (zero per-op ssh handshakes across the
    // polling cadence). The default runWithPool path below is byte-for-byte
    // unchanged and remains the default. companion-or-fail: on failure we DO
    // NOT fall back to raw SSH — the error is surfaced and the panes map is
    // simply empty for this host (opt out via the env var).
    if (isCompanionTransportEnabled()) {
      // WARDEN-413: if a live subscription is pushing fresh deltas for this host,
      // render from the in-memory delta cache and SKIP the capturePanes RPC — the
      // success gate (idle companion host -> ZERO capturePanes RPCs per monitor
      // tick). Freshness is the liveness backstop: a stalled/dead push ages out
      // within PANE_DELTA_FRESH_MS and capturePanes resumes polling, so a frozen
      // push can never freeze the UI. The cache is in-memory only.
      if (hasFreshPaneDelta(host)) {
        Object.assign(out, readPaneDeltas(host, list.map((c) => c.key)));
        return;
      }
      const r = await capturePanesViaCompanion(host, list, cfg, {}, deps);
      if (r.ok) Object.assign(out, r.panes);
      return;
    }
    const script = buildCaptureScript(list);
    const res = await runWithPool(host, script, { timeout: 15000 }, cfg);
    if (!res.ok) return;
    Object.assign(out, parseCaptureSentinels(res.stdout));
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
