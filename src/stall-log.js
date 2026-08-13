// Durable delivery channel for server event-loop stalls (WARDEN-977).
//
// The stall DETECTOR (src/loop-monitor.js) is pure and in-memory. This module is
// where a stall becomes evidence the OWNER can read on their own machine:
//
//   ~/.yatfa-warden/stalls.jsonl   — one JSON line per stall, append-only
//
// WHY A FILE AND NOT TELEMETRY: telemetry is opt-in and OFF by default
// (config-schema.js `telemetryBaseEnabled`), so it cannot be the channel for a
// signal the owner needs to read on demand. A JSONL file in the warden data dir
// — beside config.json and activity.jsonl, the established home for local state
// (WARDEN-831/832) — needs no consent, no rebuild, no debugger and no
// re-instrumentation: `cat ~/.yatfa-warden/stalls.jsonl` after the next slow
// Settings open names the culprit. GET /api/diagnostics/stalls serves the same
// file for a browser, and each stall also prints one `[warden:stall]` line to
// stderr, which the Electron main process already relays as `[server] …`.
//
// WHY APPEND-ONLY + ASYNC: the same reasons as activity.jsonl — a torn write
// costs at most the final line (never the whole file), and every write is async
// so recording a stall can never itself block the loop it is reporting on.
// Rotation is periodic (once at boot), not per-append, so the append path stays
// O(1).

import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { atomicWrite, atomicAppend } from './persist.js';

const fsp = fs.promises;

export const STALL_LOG_BASENAME = 'stalls.jsonl';
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

// Cap on retained lines, applied by pruneStallLog() — which runs ONCE AT BOOT,
// not on append. So this bounds the file at each start, not continuously: a
// long-running session on a persistently stalling machine can grow past it until
// the next restart. That is deliberate — enforcing the cap on append would make
// the append path O(n) in the file, on the very path that must never block — and
// it is bounded in practice by the >=1s stall threshold, which rate-limits
// writes to at most one line per heartbeat.
const MAX_RETAINED_STALLS = 2000;

// Resolved LAZILY (not at module load) so a test that sets HOME after importing
// still gets its temp dir, and so a home-dir change never leaves a stale path.
export function stallLogDir() {
  return path.join(os.homedir(), '.yatfa-warden');
}
export function stallLogFile() {
  return path.join(stallLogDir(), STALL_LOG_BASENAME);
}

/**
 * Append one stall record as a JSON line. Async, atomic-append, creates the
 * directory on demand. Rejects only on a real I/O failure — callers treat a
 * failure as "the in-memory ring and the stderr line are still there".
 */
export async function appendStall(record) {
  const file = stallLogFile();
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await atomicAppend(file, JSON.stringify(record) + '\n');
  return file;
}

/**
 * Read recorded stalls, newest first.
 *
 * Async and defensive: a missing file is the normal healthy case (no stalls ever
 * recorded) and returns []. A malformed line is SKIPPED with a warning rather
 * than failing the read — a half-written final line must not hide the twenty
 * good records before it.
 *
 * @param {{limit?: number}} [opts]
 */
export async function readStalls({ limit } = {}) {
  const file = stallLogFile();
  let content;
  try {
    content = await fsp.readFile(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    console.warn(`[stall-log] unreadable stall log (${err.message})`);
    return [];
  }
  if (!content.trim()) return [];
  const records = [];
  for (const line of content.trim().split('\n')) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      console.warn('[stall-log] malformed line skipped');
    }
  }
  records.reverse(); // newest first
  if (limit != null && limit >= 0 && records.length > limit) return records.slice(0, limit);
  return records;
}

/**
 * Drop stalls older than `maxAgeMs` (default 7 days) and any excess beyond
 * MAX_RETAINED_STALLS, rewriting the file atomically. Called once at server
 * start; returns the number of removed lines.
 */
export async function pruneStallLog(maxAgeMs = SEVEN_DAYS_MS) {
  const file = stallLogFile();
  let content;
  try {
    content = await fsp.readFile(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return 0;
    throw err;
  }
  if (!content.trim()) return 0;
  const lines = content.trim().split('\n').filter((l) => l.trim());
  const cutoff = Date.now() - maxAgeMs;
  let kept = [];
  let removed = 0;
  for (const line of lines) {
    let ts = NaN;
    try {
      ts = new Date(JSON.parse(line).timestamp).getTime();
    } catch {
      kept.push(line); // keep malformed lines for inspection (same as activity.js)
      continue;
    }
    if (!Number.isFinite(ts) || ts >= cutoff) kept.push(line);
    else removed++;
  }
  if (kept.length > MAX_RETAINED_STALLS) {
    removed += kept.length - MAX_RETAINED_STALLS;
    kept = kept.slice(-MAX_RETAINED_STALLS); // keep the newest
  }
  if (removed === 0) return 0;
  await atomicWrite(file, kept.length ? kept.join('\n') + '\n' : '');
  return removed;
}

/** Test/reset helper: truncate the stall log atomically. */
export async function clearStallLog() {
  await atomicWrite(stallLogFile(), '');
}
