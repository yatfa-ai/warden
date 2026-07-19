// Config + paths for warden. All user data lives under ~/.yatfa-warden/.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { deriveDefaults } from './config-schema.js';

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

export function load() {
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch {
    // first run — defaults are fine, don't force-create
  }
  return { ...DEFAULTS, ...raw };
}

export function save(cfg) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2) + '\n');
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

export function loadCatalog() {
  try {
    const v = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
    if (!Array.isArray(v)) return [];
    return v.map((e) => {
      // migrate legacy kind:'local' (direct PTY) → kind:'tmux' (local tmux, host '(local)')
      if (e.kind === 'local') { e.kind = 'tmux'; e.host = e.host || '(local)'; }
      // fold legacy cmd+args into a single cmd line (tmux spawn takes a command line)
      if (Array.isArray(e.args)) { e.cmd = [e.cmd, ...e.args].filter(Boolean).join(' '); delete e.args; }
      return e;
    });
  } catch { return []; }
}
export function saveCatalog(list) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(catalogPath, JSON.stringify(list, null, 2) + '\n');
}

// Stamp a catalog entry's last-known activity timestamp (WARDEN-245). A closed
// chat keeps a usable lastActivity for recency ordering only if the value
// survives the chat going inactive; lastActivity is captured for LIVE sessions
// alone, so we persist it on the catalog entry while the chat is alive. Only
// writes when the new value is FRESHER than the stored one (so a 60s re-discover
// of an unchanged pane does not thrash disk), and only for an entry that exists.
// `lastActivity` is ms-since-epoch. Returns true iff the catalog was updated.
export function stampCatalogActivity(host, session, lastActivity) {
  if (lastActivity == null || !Number.isFinite(lastActivity)) return false;
  const catalog = loadCatalog();
  const entry = catalog.find((c) => sameCatalogEntry(c, host, session));
  if (!entry) return false;
  if (!entry.lastActivity || entry.lastActivity < lastActivity) {
    entry.lastActivity = lastActivity;
    saveCatalog(catalog);
    return true;
  }
  return false;
}

// Parse ~/.ssh/config Host aliases (best-effort, no dep). Used for completion /
// validation — discovery only scans cfg.hosts.
export function allSshHosts() {
  const cfgPath = path.join(os.homedir(), '.ssh', 'config');
  const hosts = [];
  try {
    const text = fs.readFileSync(cfgPath, 'utf8');
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
