// Config + paths for warden. All user data lives under ~/.yatfa-warden/.
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { deriveDefaults } from './config-schema.js';
import { atomicWriteJson, readJsonDefensive, readJsonDefensiveSync } from './persist.js';

export const dir = path.join(os.homedir(), '.yatfa-warden');
export const configPath = path.join(dir, 'config.json');
export const cachePath = path.join(dir, 'cache.json');
export const catalogPath = path.join(dir, 'chats.json'); // user-defined manual chats

// DEFAULTS is derived from the single CONFIG_FIELDS registry in config-schema.js
// (WARDEN-773). Each preference's default + type + exposure + GET/PUT guard is
// declared ONCE there; this object is the materialized default map that load()
// spreads with the on-disk config.json. The array order of CONFIG_FIELDS IS the
// persisted config.json key order (byte-pinned to the pre-refactor literal) —
// the per-field documentation comments that used to live on this literal now
// live on the registry descriptors (the single source of truth).
const DEFAULTS = deriveDefaults();

// load() runs at server boot (module load — server.js:45) BEFORE any request is
// served, so it stays SYNC (boot reads are exempt from the no-runtime-sync bar,
// per the persistence architecture decision WARDEN-832). The defensive read
// backs up a corrupt config.json instead of silently defaulting (WARDEN-831).
function reviveConfig(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('config.json root is not a JSON object');
  }
  return raw;
}

export function load() {
  const raw = readJsonDefensiveSync(configPath, { fallback: {}, revive: reviveConfig });
  return { ...DEFAULTS, ...raw };
}

// Persist config atomically (WARDEN-831): temp + fsync + rename, async so a
// PUT /api/config never blocks the event loop. A crash mid-write leaves the
// previous complete config.json in place instead of a truncated file.
export async function save(cfg) {
  await atomicWriteJson(configPath, cfg);
}

// Manual chat catalog — user-spawned chats (claude in a host tmux session).
// Each entry: { host, session, cwd, cmd, name? }. `session` is unique per host,
// NOT globally — the same session name may exist on different hosts (each host's
// tmux server is independent), so identity is the host+session composite below.
const LOCAL = '(local)';

// Catalog identity is a host+session composite. Every site that matches, filters,
// or de-dupes catalog entries must compare BOTH host and session: a bare session
// match would either falsely collide (spawn 409) or silently delete the wrong
// host's entry (kill/resume) once names may repeat across hosts. Legacy entries
// written before host-scoping lack `host` — treat them as local.
//
// `catalogKey` is the single source of truth for that composite shape — the same
// `${host}:${session}` form the runtime chat id uses (buildAndSpawn / resume in
// server.js) — and `sameCatalogEntry` is just key equality, so catalog identity
// and live chat identity can never drift apart.
export function catalogKey(c) {
  return `${c.host || LOCAL}:${c.session}`;
}

export function sameCatalogEntry(c, host, session) {
  return catalogKey(c) === catalogKey({ host, session });
}

// Defensive read + legacy migration of the catalog. The revive hook enforces the
// array shape (a syntactically-valid-but-wrong-type file is recovered, not
// propagated) and folds legacy entries forward. Async (WARDEN-831): reads on the
// request path use the async defensive helper so the event loop is never blocked.
function reviveCatalog(v) {
  if (!Array.isArray(v)) throw new Error('chats.json root is not a JSON array');
  return v.map((e) => {
    // migrate legacy kind:'local' (direct PTY) → kind:'tmux' (local tmux, host '(local)')
    if (e.kind === 'local') { e.kind = 'tmux'; e.host = e.host || '(local)'; }
    // fold legacy cmd+args into a single cmd line (tmux spawn takes a command line)
    if (Array.isArray(e.args)) { e.cmd = [e.cmd, ...e.args].filter(Boolean).join(' '); delete e.args; }
    return e;
  });
}

export async function loadCatalog() {
  return readJsonDefensive(catalogPath, { fallback: [], revive: reviveCatalog });
}
export async function saveCatalog(list) {
  await atomicWriteJson(catalogPath, list);
}

// THE serialization point for catalog mutations (WARDEN-991).
//
// chats.json is a WHOLE-FILE document: saveCatalog → atomicWriteJson does a full
// stringify + temp + fsync + rename. That makes each write torn-free, but it gives
// no ISOLATION — every mutation is a read-modify-write, so two that overlap in the
// async gap clobber one another last-write-wins. Measured on the unfixed code:
// 5 concurrent /api/kill left 4 ghost entries, 3 concurrent /api/spawn persisted 1,
// and a discovery activity-stamp racing a kill resurrected the killed chat in
// 35/60 trials. The /api/spawn window is the widest — it awaits a real tmux/ssh
// spawn between its load and its save.
//
// Every mutation runs through one promise chain, and the read happens INSIDE the
// critical section so each mutation observes the previous one's result. Passing a
// pre-read snapshot in would preserve the bug — that is exactly what /api/spawn
// used to do. Return a falsy value from `fn` to skip the write (e.g. the
// "entry not found" and "already fresh" branches).
//
// LIMITATION — this is IN-PROCESS ONLY. src/cli.js imports the discovery path and
// runs in a SEPARATE process, so a `warden` CLI invocation running alongside the
// server is NOT ordered by this queue. All five server-side writers are serialized
// here (the dominant, reproduced case); closing the cross-process race needs a
// file lock and is deliberately out of scope.
let catalogChain = Promise.resolve();
export function mutateCatalog(fn) {
  const run = catalogChain.then(async () => {
    const next = await fn(await loadCatalog());
    if (next) await saveCatalog(next);
    return next;
  });
  // A rejecting mutation must not poison the queue for everyone behind it: the
  // chain swallows the failure while `run` still rejects for THIS caller.
  catalogChain = run.catch(() => {});
  return run;
}

// Stamp a catalog entry's last-known activity timestamp (WARDEN-245). A closed
// chat keeps a usable lastActivity for recency ordering only if the value
// survives the chat going inactive; lastActivity is captured for LIVE sessions
// alone, so we persist it on the catalog entry while the chat is alive. Only
// writes when the new value is FRESHER than the stored one (so a 60s re-discover
// of an unchanged pane does not thrash disk), and only for an entry that exists.
// `lastActivity` is ms-since-epoch. Returns true iff the catalog was updated.
export async function stampCatalogActivity(host, session, lastActivity) {
  if (lastActivity == null || !Number.isFinite(lastActivity)) return false;
  // Serialized (WARDEN-991): this is the BACKGROUND writer — reached from the 60s
  // lifecycle sweep and from /api/discover on user navigation — so it overlaps a
  // user's /api/kill or /api/spawn routinely. Unserialized it lost one of the two
  // writes in 60/60 trials. The "only write when fresher" short-circuit is kept
  // (it is what stops disk thrash on the 60s re-discover) and now re-reads inside
  // the critical section, so it tests freshness against the CURRENT catalog.
  return !!(await mutateCatalog((catalog) => {
    const entry = catalog.find((c) => sameCatalogEntry(c, host, session));
    if (!entry) return undefined;
    if (entry.lastActivity && entry.lastActivity >= lastActivity) return undefined;
    entry.lastActivity = lastActivity;
    return catalog;
  }));
}

// Parse ~/.ssh/config Host aliases (best-effort, no dep). Used for completion /
// validation — discovery only scans cfg.hosts. Async (WARDEN-831): served on the
// GET /api/ssh-hosts request path, so the read yields the event loop.
export async function allSshHosts() {
  const cfgPath = path.join(os.homedir(), '.ssh', 'config');
  const hosts = [];
  try {
    const text = await fs.promises.readFile(cfgPath, 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^\s*Host\s+(.+)$/i);
      if (!m) continue;
      for (const h of m[1].trim().split(/\s+/)) {
        if (!h.includes('*') && !h.includes('?') && !hosts.includes(h)) hosts.push(h);
      }
    }
  } catch {
    /* no ssh config */
  }
  return hosts;
}
