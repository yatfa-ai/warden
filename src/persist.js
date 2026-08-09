// Durable, corruption-safe local-persistence primitives (WARDEN-831).
//
// One shared, dependency-free module for every piece of small local state warden
// persists to ~/.yatfa-warden/. Implements the local-persistence architecture
// decision of record (knowledge article WARDEN-832): atomic writes + defensive
// reads with backup-on-corrupt, async on every runtime/request path (no sync
// `fs` on any path that serves a request), no new `spawnSync`. No new deps —
// node:fs only. (A no-dependency helper was chosen over `conf`/electron-store so
// the existing config-schema.js stays the single schema source, every write is
// async — no `conf` sync carve-out is needed at all — and warden's deliberately
// minimal dep tree is preserved.)
//
// WHY ATOMIC WRITES: a direct writeFileSync/writeFile to the target file can be
// torn by a crash / power loss / disk-full mid-write, leaving a truncated JSON
// document. The old load() then silently caught the parse error and returned
// DEFAULTS — silent data loss (settings/state vanish, no trace, no backup).
// atomicWrite stages to a temp sibling, fsyncs it, then renames over the target,
// so the target is never observed in a partially-written state: a crash mid-write
// leaves the previous (complete) file in place.
//
// WHY DEFENSIVE READS WITH BACKUP: if a file is ever unparseable — external edit,
// filesystem corruption, a pre-atomic-write file written by an older warden, or a
// torn write from a crash our atomic-write couldn't prevent on a non-journaled FS
// — we back it up to `<file>.corrupt-<ts><ext>` and surface it (console.warn with
// the backup path) before returning the caller's fallback, so the user can recover
// instead of losing their data silently.
//
// SYNC vs ASYNC: the async exports (atomicWrite / atomicAppend / readJsonDefensive)
// are for runtime/request paths — they yield the event loop during I/O so no single
// persistence op can re-stall the server (this is the WARDEN-828 spinner fix made
// structural). The single sync export (readJsonDefensiveSync) is BOOT-ONLY — used
// by the module-load config read where a sync value is required before the first
// request is served; do not call it from a request handler.

import fs from 'node:fs';
import path from 'node:path';

const fsp = fs.promises;

// Per-process write counter so two atomic writes in the same millisecond still
// get distinct temp paths (bounded by pid + counter + ms).
let writeCounter = 0;
function tempPath(file) {
  const counter = (writeCounter++).toString(36);
  return `${file}.${process.pid}.${Date.now().toString(36)}.${counter}.tmp`;
}

// Backup path for a corrupt file: <base>.corrupt-<iso-safe-ts><ext>. Filesystem-
// safe timestamp (no colons, which Windows forbids in paths).
export function corruptBackupPath(file) {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const ext = path.extname(file);
  const base = ext ? file.slice(0, -ext.length) : file;
  return `${base}.corrupt-${ts}${ext || '.json'}`;
}

/**
 * Atomically write `data` (a string) to `file`. Stages to a temp sibling,
 * fsyncs it, then renames over the target, so the target is never observed in a
 * partially-written state (a crash mid-write leaves the prior complete file).
 * Creates parent directories. Async — safe on the request path.
 */
export async function atomicWrite(file, data) {
  const dir = path.dirname(file);
  await fsp.mkdir(dir, { recursive: true });
  const tmp = tempPath(file);
  try {
    const fh = await fsp.open(tmp, 'w');
    try {
      await fh.writeFile(data);
      await fh.sync(); // fsync the temp's data to disk before the rename
    } finally {
      await fh.close();
    }
    await fsp.rename(tmp, file);
  } catch (err) {
    // Never leak the temp file: if open/write/sync/rename failed, remove it.
    await fsp.unlink(tmp).catch(() => {});
    throw err;
  }
}

/**
 * Convenience: atomicWrite of a JSON-serialized value (pretty-printed, with a
 * trailing newline — byte-identical to the pre-refactor writeFileSync output).
 */
export async function atomicWriteJson(file, value) {
  return atomicWrite(file, JSON.stringify(value, null, 2) + '\n');
}

/**
 * Append `data` (string) to `file`, creating it and parent dirs if absent. Async.
 * For append-only logs (one line per event): a torn write costs at most the final
 * line, never the whole file.
 */
export async function atomicAppend(file, data) {
  const dir = path.dirname(file);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.appendFile(file, data);
}

/**
 * Async file deletion that tolerates a missing file (ENOENT). For clear/reset.
 */
export async function removeFile(file) {
  try {
    await fsp.unlink(file);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

/**
 * Defensive JSON read (async, for request paths). A missing file returns
 * `fallback`. An unparseable file is backed up to `<file>.corrupt-<ts><ext>`
 * (best-effort), logged with the backup path, and returns `fallback` — never
 * silently swallows corruption into defaults.
 *
 * `opts.revive` (optional) validates/normalizes a successfully-parsed value; if
 * it throws, the file is treated as corrupt (backed up + fallback). Used to
 * enforce array/object shape so a syntactically-valid-but-wrong-type file (e.g.
 * `{}` where an array is expected) is recovered rather than propagated.
 */
export async function readJsonDefensive(file, { fallback = null, revive } = {}) {
  let text;
  try {
    text = await fsp.readFile(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return fallback; // first run / missing — normal
    // Unreadable (permissions, I/O error): surface, but don't crash the caller.
    console.warn(`[persist] unreadable ${file} (${err.message}); using fallback`);
    return fallback;
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (parseErr) {
    await backupCorrupt(file, text, parseErr);
    return fallback;
  }
  if (typeof revive === 'function') {
    try {
      return revive(parsed);
    } catch (reviveErr) {
      await backupCorrupt(file, text, reviveErr);
      return fallback;
    }
  }
  return parsed;
}

/**
 * Defensive JSON read (SYNC — BOOT PATHS ONLY). Same backup-on-corrupt semantics
 * as readJsonDefensive. Do NOT call from a request handler (it blocks the event
 * loop); the only sanctioned caller is the module-load config read. The sync
 * backup write inside is itself boot-time/rare-recovery only.
 */
export function readJsonDefensiveSync(file, { fallback = null, revive } = {}) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return fallback; // first run / missing — normal
    console.warn(`[persist] unreadable ${file} (${err.message}); using fallback`);
    return fallback;
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (parseErr) {
    backupCorruptSync(file, text, parseErr);
    return fallback;
  }
  if (typeof revive === 'function') {
    try {
      return revive(parsed);
    } catch (reviveErr) {
      backupCorruptSync(file, text, reviveErr);
      return fallback;
    }
  }
  return parsed;
}

// Back up a corrupt file (async). Best-effort: even if the backup write fails we
// still surface the corruption upstream (the fallback is returned regardless).
async function backupCorrupt(file, text, err) {
  const backup = corruptBackupPath(file);
  console.warn(`[persist] corrupt JSON at ${file} (${err.message}); backing up to ${backup}`);
  try {
    await fsp.writeFile(backup, text);
  } catch (backupErr) {
    console.warn(`[persist] could not write corruption backup ${backup}: ${backupErr.message}`);
  }
}

// Sync twin of backupCorrupt — used only by the boot-only readJsonDefensiveSync.
// The single legitimate writeFileSync outside config.js's boot load; see the
// SYNC vs ASYNC note at the top of this file.
function backupCorruptSync(file, text, err) {
  const backup = corruptBackupPath(file);
  console.warn(`[persist] corrupt JSON at ${file} (${err.message}); backing up to ${backup}`);
  try {
    fs.writeFileSync(backup, text);
  } catch (backupErr) {
    console.warn(`[persist] could not write corruption backup ${backup}: ${backupErr.message}`);
  }
}
