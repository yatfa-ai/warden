// Config + paths for warden. All user data lives under ~/.yatfa-warden/.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const dir = path.join(os.homedir(), '.yatfa-warden');
export const configPath = path.join(dir, 'config.json');
export const cachePath = path.join(dir, 'cache.json');
export const catalogPath = path.join(dir, 'chats.json'); // user-defined manual chats

const DEFAULTS = {
  hosts: [],            // SSH host aliases to scan (from ~/.ssh/config). Add yours in ~/.yatfa-warden/config.json
  tmuxSession: 'agent', // tmux session name yatfa creates inside each container
  connectTimeout: 10,
  pollIntervalMs: 1500,
  pins: [],             // chat ids to surface first in listings / UI
};

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
// Each entry: { host, session, cwd, cmd, name? }. `session` is unique per host.
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
