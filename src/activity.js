// Activity event persistence: JSONL log of key events for "while you were away" timeline.
// One JSON line per event, rotated after 7 days to prevent unbounded growth.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// fs.promises alias — the read path (readEvents → getStatsSince → getSeriesSince)
// is async (WARDEN-828) so serving GET /api/activity* yields the event loop during
// the JSONL read instead of blocking /api/config behind a synchronous readFileSync.
// The write path (appendEvent/rotateEvents/clearEvents) stays sync — those are
// tiny line appends / a one-shot startup rotation, not the hot GET-blocking reads.
const fsp = fs.promises;

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

// Read all events from the log, optionally filtered by timestamp range.
//
// Async (WARDEN-828): the JSONL read uses fs.promises so a GET /api/activity*
// request yields the event loop during the read (a missing/unreadable file
// resolves to '' via the catch, preserving the prior existsSync + empty → []
// contract) instead of blocking /api/config behind a synchronous readFileSync.
export async function readEvents({ after, before, limit } = {}) {
  ensure();
  const content = await fsp.readFile(FILE, 'utf8').catch(() => '');
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
export async function getStatsSince(after) {
  // Exclude non-activity events (state_changed — internal transition marker for
  // the state timeline, WARDEN-788) so `total` stays a count of genuine
  // lifecycle/directive/error activity, not observation-boundary noise.
  const events = (await readEvents({ after })).filter((e) => !NON_ACTIVITY_TYPES.has(e.type));
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

// Event types that ride this store but are NOT activity — they feed a different
// surface and must NOT count toward the heatmap's per-bucket volume totals
// (getSeriesSince) or /api/activity/stats's global `total` (getStatsSince). Both
// of those represent the discrete lifecycle/directive/error event volume WARDEN-299
// established; without this exclusion, the state-transition logging WARDEN-788
// added would inflate them with observation-boundary noise — a `from:null`
// baseline fires for every agent on every warden restart, and oscillating agents
// (the feature's focus) would get +N volume counts that duplicate the timeline's
// signal. `state_changed` is an internal transition marker for the Fleet state
// timeline (getStateSeriesSince reads it directly), not an activity event — it
// is excluded from EVERY activity-facing reader of this store: getSeriesSince
// (the heatmap's volume buckets), getStatsSince (the rollup's `total`), and the
// raw GET /api/activity feed (the Activity Timeline). Exported so the raw feed's
// handler shares this single source of truth — a future internal-marker type
// added here then drops out of all three readers at once.
export const NON_ACTIVITY_TYPES = new Set(['state_changed']);

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
 *     not contribute to any per-agent sparkline. Non-activity events
 *     (`state_changed`, the state-timeline's transition marker — WARDEN-788) are
 *     also dropped, so this stays a volume-of-activity surface, not
 *     volume-of-observations; a state_changed-only container renders no row.
 * @returns {{ bucketMs: number, buckets: number[], series: Record<string, { total: number[], error: number[] }> }}
 *   `buckets` is the full epoch-aligned bucket-start range across [after, now]
 *   (ascending), so idle periods read as zero buckets rather than gaps. Each
 *   series entry's `total`/`error` arrays are parallel to `buckets` (same length,
 *   index i ↔ buckets[i]); `error` counts events whose type is in ERROR_TYPES.
 */
export async function getSeriesSince(after, { bucketMs = 3_600_000, by = 'container', now: nowOpt } = {}) {
  const events = await readEvents({ after });
  const now = nowOpt ?? Date.now();

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
    // Drop non-activity events (state_changed — internal transition marker for
    // the state timeline, WARDEN-788) so the heatmap stays a volume-of-activity
    // surface, not a volume-of-observations surface. A state_changed-only
    // container therefore renders NO heatmap row (case-3 zero-fill), identical
    // to before the feature; the transition still flows to getStateSeriesSince.
    if (NON_ACTIVITY_TYPES.has(event.type)) continue;

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

/**
 * Build a per-agent, per-bucket STATE series for the Fleet state timeline
 * (WARDEN-788) — the orthogonal complement of `getSeriesSince` above. Where that
 * buckets event VOLUME (the heatmap), this buckets the agent's classified STATE
 * (`active`/`idle`/`stuck`/`erroring`/`blocked`/`waiting`, plus `capture_failed`),
 * forward-filled between `state_changed` transitions so a HELD state reads as a
 * continuous segment, not a single tick. That is the one signal no current surface
 * can show: an agent oscillating `stuck → active → stuck` renders visibly distinct
 * repeating segments, where the volume heatmap shows only "some events" and the
 * snapshot shows only the current state + time-in-state.
 *
 * `state_changed` events are logged by `pollAgentStates` (src/server.js) on every
 * genuine transition (prev !== state), keyed by agent `key`, grouped here by
 * `container` (default — mirrors getSeriesSince/the heatmap, so a manual/tmux chat
 * with no container contributes no row, identical to the heatmap's case 1).
 *
 * Carry-forward: reads the FULL 7-day-bounded store (not just [after, now]) so a
 * state established BEFORE the window — the common case for a steady agent whose
 * only baseline/transition logged before the window — carries forward into the
 * window's first bucket. Without this, an agent steady in one state for 24h would
 * render blank. readEvents reads the whole file regardless (its `after` arg only
 * filters the returned array), so the disk cost matches getSeriesSince.
 *
 * One pass over the events (O(events)); a 24h window over the 7-day store is cheap.
 *
 * @param {number} after - epoch ms; caller passes last-24h (mirrors the series
 *   endpoint default). The grid spans [floor(after), floor(now)].
 * @param {{ bucketMs?: number, by?: string }} [opts] - same shape as getSeriesSince.
 * @returns {{ bucketMs: number, buckets: number[], series: Record<string, { states: (string|null)[] }> }}
 *   `buckets` is the epoch-aligned range across [after, now] (ascending) — identical
 *   grid to getSeriesSince so the two panels share one axis. Each series entry's
 *   `states` array is parallel to `buckets` (index i ↔ buckets[i]); a bucket the
 *   agent was never observed in (before its first transition) reads `null`.
 */
export async function getStateSeriesSince(after, { bucketMs = 3_600_000, by = 'container', now: nowOpt } = {}) {
  // Read the whole store (not just [after, now]) for the pre-window carry-forward.
  const events = await readEvents();
  const now = nowOpt ?? Date.now();

  const firstBucket = Math.floor(after / bucketMs) * bucketMs;
  const lastBucket = Math.floor(now / bucketMs) * bucketMs;
  const buckets = [];
  for (let b = firstBucket; b <= lastBucket; b += bucketMs) buckets.push(b);
  const n = buckets.length;
  if (n === 0) return { bucketMs, buckets, series: {} };

  // Collect state_changed transitions per key. readEvents returns newest-first; we
  // sort ascending per key below so the forward-fill walk applies them in time order.
  const transitionsByKey = Object.create(null);
  for (const event of events) {
    if (event.type !== 'state_changed') continue;
    const key = by === 'container' ? event.container : event[by];
    // Drop host-level / manual events (no container) — same graceful-sparsity rule
    // as getSeriesSince: only container-bearing chats get a timeline row.
    if (key === undefined || key === null || key === '') continue;
    const ts = new Date(event.timestamp).getTime();
    if (!Number.isFinite(ts)) continue; // malformed timestamp (readEvents already warned)
    (transitionsByKey[key] ??= []).push({ ts, to: event.to ?? null });
  }

  const series = Object.create(null);
  for (const key of Object.keys(transitionsByKey)) {
    const transitions = transitionsByKey[key].sort((a, b) => a.ts - b.ts);
    const states = new Array(n).fill(null);
    // Forward-fill: walk buckets left → right, advancing through every transition
    // whose ts falls before the bucket's END (transitions[ti].ts < buckets[i] +
    // bucketMs). The LAST transition applied wins (`current` is overwritten in
    // ascending order), so two transitions in one bucket collapse to the later
    // state — the documented last-known-state-per-bucket aliasing at 1h. `current`
    // persists across buckets (held state → continuous segment) and is seeded null
    // so the carry-forward from a pre-window transition lands in bucket 0 while a
    // never-observed prefix reads null (honest "unknown", not a false segment).
    let current = null;
    let ti = 0;
    for (let i = 0; i < n; i++) {
      const bucketEnd = buckets[i] + bucketMs; // exclusive upper bound for bucket i
      while (ti < transitions.length && transitions[ti].ts < bucketEnd) {
        current = transitions[ti].to;
        ti++;
      }
      states[i] = current;
    }
    series[key] = { states };
  }

  return { bucketMs, buckets, series };
}
