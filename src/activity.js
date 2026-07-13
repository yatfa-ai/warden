// Activity event persistence: JSONL log of key events for "while you were away" timeline.
// One JSON line per event, rotated after 7 days to prevent unbounded growth.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const DIR = path.join(os.homedir(), '.yatfa-warden');
const FILE = path.join(DIR, 'activity.jsonl');
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

// Ensure directory and file exist
function ensure() {
  fs.mkdirSync(DIR, { recursive: true });
  if (!fs.existsSync(FILE)) {
    fs.writeFileSync(FILE, '', 'utf8');
  }
}

// Append an event to the activity log
export function appendEvent(event) {
  ensure();
  const line = JSON.stringify({
    timestamp: new Date().toISOString(),
    ...event,
  }) + '\n';
  fs.appendFileSync(FILE, line, 'utf8');
}

// Read all events from the log, optionally filtered by timestamp range
export function readEvents({ after, before, limit } = {}) {
  ensure();
  if (!fs.existsSync(FILE)) return [];

  const content = fs.readFileSync(FILE, 'utf8');
  if (!content.trim()) return [];

  const lines = content.trim().split('\n');
  const events = [];

  for (const line of lines) {
    try {
      const event = JSON.parse(line);
      const ts = new Date(event.timestamp).getTime();

      // Filter by time range
      if (after && ts < after) continue;
      if (before && ts > before) continue;

      events.push(event);
    } catch (e) {
      // Log malformed lines for debugging
      console.warn(`[activity] Malformed line skipped: ${e.message}`);
    }
  }

  // Sort by timestamp descending (newest first)
  events.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

  // Apply limit if specified
  if (limit && events.length > limit) {
    return events.slice(0, limit);
  }

  return events;
}

// Remove events older than 7 days (called on startup and periodically)
export function rotateEvents() {
  ensure();
  if (!fs.existsSync(FILE)) return 0;

  const cutoff = Date.now() - SEVEN_DAYS_MS;
  const content = fs.readFileSync(FILE, 'utf8');
  if (!content.trim()) return 0;

  const lines = content.trim().split('\n');
  const kept = [];
  let removed = 0;

  for (const line of lines) {
    try {
      const event = JSON.parse(line);
      const ts = new Date(event.timestamp).getTime();
      if (ts >= cutoff) {
        kept.push(line);
      } else {
        removed++;
      }
    } catch {
      // Keep malformed lines for inspection
      kept.push(line);
    }
  }

  // Rewrite the file with only recent events
  fs.writeFileSync(FILE, kept.join('\n') + '\n', 'utf8');
  return removed;
}

// Clear all events (useful for testing or manual reset)
export function clearEvents() {
  ensure();
  fs.writeFileSync(FILE, '', 'utf8');
}

// Get activity statistics since a given timestamp
export function getStatsSince(after) {
  const events = readEvents({ after });
  const stats = {
    total: events.length,
    directive_proposed: 0,
    directive_sent: 0,
    directive_rejected: 0,
    attached: 0,
    ended: 0,
    error: 0,
  };

  for (const event of events) {
    const type = event.type;
    if (stats.hasOwnProperty(type)) {
      stats[type]++;
    }
  }

  return stats;
}

// Event types that count as "something went wrong" for the per-agent activity
// sparkline's error overlay (WARDEN-299). `getStatsSince` above — and therefore
// the attention rollup (buildAttentionRollup via /api/activity/stats) — counts
// ONLY `type === 'error'` toward its error tally. The sparkline's job is to make
// an error-bursting agent read at a glance, so this set widens to the per-agent
// FAILURE signals an operator scanning the fleet wants to spot:
//   - 'error'              canonical error (attach/observer failure) — matches the rollup.
//   - 'agent_session_down' the agent's tmux `agent` session died (container still
//                          up) — a crash/stop signal that never produces an 'error' event.
//   - 'host_error'         host discovery started failing — host-level (no container),
//                          so the per-container grouping below drops it regardless;
//                          included for semantic correctness (a future per-host
//                          rollup, out of scope here, will need it).
// 'agent_ended' is deliberately EXCLUDED: per src/lifecycle.js it fires whenever a
// container genuinely disappears, which is routine teardown (agent finished →
// container recycled). Tinting it red would make every cleanly-finished agent read
// as a failure — the opposite of "reads at a glance".
const ERROR_TYPES = new Set(['error', 'agent_session_down', 'host_error']);

/**
 * Build a per-agent, per-time-bucket activity series for the Fleet Health
 * sparklines (WARDEN-299). Sibling to `getStatsSince`: it scans the same JSONL
 * activity log via `readEvents`, but instead of a flat global tally it returns a
 * shape an SVG sparkline can join client-side by `container`.
 *
 * One pass over the events (O(events)); a 24h window is cheap and well within
 * the 7-day rotation.
 *
 * @param {number} after - epoch ms; caller passes last-24h (mirrors the stats
 *   endpoint default). Events with `timestamp < after` are excluded by readEvents.
 * @param {{ bucketMs?: number, by?: string }} [opts]
 *   - bucketMs: bucket size in ms (default 1h). Each event lands in the bucket
 *     `floor(ts / bucketMs) * bucketMs`.
 *   - by: event key to group series by (default 'container'). Events with a
 *     null/empty value for that key are dropped — manual/tmux chats (no
 *     container) and host-level events (`host_error`/`host_ok`, no container) do
 *     not contribute to any per-agent sparkline.
 * @returns {{ bucketMs: number, buckets: number[], series: Record<string, { total: number[], error: number[] }> }}
 *   `buckets` is the full epoch-aligned bucket-start range across [after, now]
 *   (ascending), so idle periods read as zero buckets rather than gaps. Each
 *   series entry's `total`/`error` arrays are parallel to `buckets` (same length,
 *   index i ↔ buckets[i]); `error` counts events whose type is in ERROR_TYPES.
 */
export function getSeriesSince(after, { bucketMs = 3_600_000, by = 'container' } = {}) {
  const events = readEvents({ after });
  const now = Date.now();

  // Epoch-aligned bucket range spanning the whole window. Filling every bucket
  // in [after, now] (not just the ones that got events) means a quiet-but-alive
  // agent renders a flat line of zeros, not a ragged/blank strip.
  const firstBucket = Math.floor(after / bucketMs) * bucketMs;
  const lastBucket = Math.floor(now / bucketMs) * bucketMs;
  const buckets = [];
  const indexByBucket = new Map();
  for (let b = firstBucket; b <= lastBucket; b += bucketMs) {
    indexByBucket.set(b, buckets.length);
    buckets.push(b);
  }
  const n = buckets.length;

  // Lazily-initialized per-key total/error arrays, parallel to `buckets`. A key
  // with zero events in the window is never created, so it renders no sparkline
  // (graceful sparsity — rows with no events stay clean).
  const series = Object.create(null);
  const ensure = (key) => {
    let entry = series[key];
    if (!entry) {
      entry = { total: new Array(n).fill(0), error: new Array(n).fill(0) };
      series[key] = entry;
    }
    return entry;
  };

  for (const event of events) {
    const key = by === 'container' ? event.container : event[by];
    // Drop host-level events (no container) and manual/tmux chats — they have
    // no per-agent sparkline to contribute to.
    if (key === undefined || key === null || key === '') continue;

    const ts = new Date(event.timestamp).getTime();
    if (!Number.isFinite(ts)) continue; // malformed timestamp (readEvents already warned)
    const b = Math.floor(ts / bucketMs) * bucketMs;
    const idx = indexByBucket.get(b);
    if (idx === undefined) continue; // outside [after, now] (clock skew / pre-window)

    const entry = ensure(key);
    entry.total[idx] += 1;
    if (ERROR_TYPES.has(event.type)) entry.error[idx] += 1;
  }

  return { bucketMs, buckets, series };
}
