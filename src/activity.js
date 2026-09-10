// Activity event persistence: JSONL log of key events for "while you were away" timeline.
// One JSON line per event, rotated after 7 days to prevent unbounded growth.
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { atomicWrite, atomicAppend } from './persist.js';

// fs.promises alias — every I/O here is async (WARDEN-828 made the reads async;
// WARDEN-831 makes the writes async too) so serving /api/activity* OR appending an
// event yields the event loop during disk I/O instead of blocking /api/config.
const fsp = fs.promises;

const DIR = path.join(os.homedir(), '.yatfa-warden');
const FILE = path.join(DIR, 'activity.jsonl');
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

// Ensure the data directory exists (async). The activity file itself is created
// on demand by atomicAppend (append creates if missing) and reads tolerate a
// missing file (ENOENT → ''), so we only need the directory.
async function ensureDir() {
  await fsp.mkdir(DIR, { recursive: true });
}

// Append an event to the activity log (append-only — WARDEN-831). A torn write
// costs at most the final line, never the whole file.
export async function appendEvent(event) {
  await ensureDir();
  const line = JSON.stringify({
    timestamp: new Date().toISOString(),
    ...event,
  }) + '\n';
  await atomicAppend(FILE, line);
}

// Read all events from the log, optionally filtered by timestamp range.
//
// Async (WARDEN-828): the JSONL read uses fs.promises so a GET /api/activity*
// request yields the event loop during the read (a missing/unreadable file
// resolves to '' via the catch, preserving the prior existsSync + empty → []
// contract) instead of blocking /api/config behind a synchronous readFileSync.
export async function readEvents({ after, before, limit } = {}) {
  await ensureDir();
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

// Remove events older than 7 days (called on startup and periodically). The
// compaction rewrites the whole file ATOMICALLY (temp + fsync + rename) — it is a
// periodic rotation, NOT a per-append rewrite, so the append path stays O(1) and a
// crash mid-rotation leaves the previous complete file (WARDEN-831).
export async function rotateEvents() {
  await ensureDir();
  let content;
  try {
    content = await fsp.readFile(FILE, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return 0;
    throw err;
  }
  if (!content.trim()) return 0;

  const lines = content.trim().split('\n');
  const kept = [];
  let removed = 0;

  const cutoff = Date.now() - SEVEN_DAYS_MS;
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

  // Atomic rewrite with only recent events
  await atomicWrite(FILE, kept.join('\n') + '\n');
  return removed;
}

// Clear all events (useful for testing or manual reset). Atomic truncate.
export async function clearEvents() {
  await ensureDir();
  await atomicWrite(FILE, '');
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
 * How long a logged `state_changed` observation substantiates the state it
 * reports (WARDEN-1318). Past this, `getStateSeriesSince` renders `null`
 * ("unknown / not yet observed") instead of forward-filling the held state.
 *
 * WHY A BOUND EXISTS AT ALL. `state_changed` logging is CLIENT-driven: since
 * WARDEN-1274 retired the 60s server-side attention sweep, NOTHING classifies
 * agents while the dashboard window is closed (see the block comment above
 * pollAgentStates in server.js — re-introducing a backend sweep is explicitly
 * forbidden). An unbounded forward-fill therefore painted a confident colored
 * stripe across hours nobody watched: one `state_changed(active)` 20h before now
 * rendered as 21 solid `active` buckets. The fix is to stop claiming to know.
 *
 * WHY 15 MINUTES. The observers that can log a transition run at
 * AGENT_STATE_POLL_MS = 30s (the open ∪ watched poll) and FLEET_SWEEP_POLL_MS =
 * 90s (the hidden-fleet sweep) — both in web/src/lib/useAttentionRollup.ts. 90s is
 * the worst-case interval between two consecutive observations of a live agent, so
 * 15 minutes is 10 consecutive missed sweeps: comfortably past any single slow SSH
 * round-trip, fetch-deadline miss or transient host failure, and far below the 1h
 * default bucket so a wholly unobserved hour can never be painted.
 *
 * THE ACCEPTED RESIDUAL — READ THIS BEFORE "FIXING" A STEADY AGENT THAT READS
 * UNKNOWN. The journal records TRANSITIONS ONLY: `logStateTransition` writes
 * nothing on an unchanged tick and no heartbeat/`observed_at` event type exists
 * (that is deliberate — see the NON_ACTIVITY_TYPES rationale above: per-observation
 * rows would be observation-boundary noise). So a genuinely-observed, genuinely-
 * STEADY agent is byte-for-byte INDISTINGUISHABLE from an unobserved one — both are
 * "one transition, then silence". No bound derived from this data alone can tell
 * them apart, so a long-steady watched agent WILL read unknown past this threshold,
 * including in the rightmost ("now") column. That is the deliberate trade: the
 * roadmap bar is "nothing that stays may report a state it cannot substantiate", and
 * under-claiming is the correct direction of error — `countStateSegments` skips
 * nulls, so extra nulls can never manufacture a false oscillation signal, whereas
 * the old fill manufactured false held state.
 *
 * ALTERNATIVE CONSIDERED AND NOT TAKEN (deliberately, not by oversight): observation
 * liveness is a property of the OBSERVER, not of one agent — a transition logged for
 * ANY agent at time T proves warden was open at T, and could substantiate a steady
 * agent's held state across that same instant. That would recover most of the
 * residual above, but it couples every row's truth to unrelated agents' churn (a
 * single-agent fleet gains nothing; one oscillating neighbour would keep every other
 * row lit). It is a separate design decision with its own failure modes — left to a
 * follow-up rather than smuggled in here.
 */
export const STATE_STALE_AFTER_MS = 15 * 60 * 1000;

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
    // `from` is carried through (WARDEN-1318): `from === null` is the
    // first-observation baseline marker logStateTransition writes when its
    // in-memory diff map has no prior entry for the agent (server.js:~574). The
    // map is module-level, so it is cleared on every warden restart — a `from:
    // null` therefore fires for every agent on the first poll after warden
    // reopens, and is the one piece of positive EVIDENCE in this store that
    // observation was interrupted. The forward-fill walk below uses it as a hard
    // discontinuity.
    (transitionsByKey[key] ??= []).push({ ts, to: event.to ?? null, from: event.from ?? null });
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
    //
    // WARDEN-1318 — THE FILL IS BOUNDED. `current` no longer persists forever: each
    // transition substantiates its state only over [ts, currentUntil), and a bucket
    // that interval does not reach reads `null` ("unknown / not yet observed", which
    // the renderer already draws as a transparent outlined cell). Two independent
    // bounds, because the store offers two different kinds of evidence:
    //
    //   1. ELAPSED TIME (STATE_STALE_AFTER_MS, see its comment above) — the general
    //      case. Observation is client-driven, so a clean window close leaves NO
    //      marker at all; only the silence itself says nobody was watching.
    //   2. A `from: null` RE-BASELINE on the NEXT transition — positive evidence that
    //      observation restarted, so the previously-held state is not carried up to
    //      it. Note what this marker does and does not prove: it says the gap ENDED
    //      here, and says nothing about when it BEGAN — so it necessarily nulls some
    //      genuinely-observed steady hours preceding the restart. Under-claiming is
    //      the accepted direction (see STATE_STALE_AFTER_MS).
    //
    // A bucket renders the last-known state iff that state's coverage interval
    // INTERSECTS the bucket. So the bucket a transition lands in always renders it
    // (even a 15-min coverage inside a 1h bucket — the same last-known-per-bucket
    // aliasing the fill has always had), while a bucket the coverage never reaches
    // reads null. An agent observed at least once per bound therefore still renders
    // ONE continuous segment: each transition's interval reaches the next. A
    // following re-baseline collapses the preceding coverage to the observation
    // INSTANT — the marker proves observation was interrupted somewhere in that
    // stretch without saying where, so none of the stretch can be claimed.
    let current = null;
    let currentUntil = -Infinity; // epoch ms at which `current` stops being substantiated
    let ti = 0;
    for (let i = 0; i < n; i++) {
      const bucketStart = buckets[i];
      const bucketEnd = bucketStart + bucketMs; // exclusive upper bound for bucket i
      while (ti < transitions.length && transitions[ti].ts < bucketEnd) {
        const t = transitions[ti];
        const next = transitions[ti + 1];
        current = t.to;
        currentUntil = next && next.from === null ? t.ts : t.ts + STATE_STALE_AFTER_MS;
        ti++;
      }
      // `>=` (not `>`) so a transition's OWN bucket always renders even when its
      // coverage collapses to the observation instant (a re-baseline landing exactly
      // on a bucket boundary) — the observed bucket is never nulled by its own event.
      states[i] = current !== null && currentUntil >= bucketStart ? current : null;
    }
    series[key] = { states };
  }

  return { bucketMs, buckets, series };
}
