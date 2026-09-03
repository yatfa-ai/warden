// Pure summary of the server stall journal (WARDEN-1280).
//
// WHY THIS FILE IS SPLIT OUT OF main.cjs (same reasoning as window-state.cjs):
// main.cjs `require('electron')`, so it can only run under Electron itself and
// cannot be exercised by `node --test`. The Help > "Stall Diagnostics…" menu
// item has to turn the raw `~/.yatfa-warden/stalls.jsonl` records into three
// facts a person can act on — how many stalls are retained, when the last one
// happened, and which labelled work was most often blocking the loop — and that
// reduction is exactly the part that must be CORRECT. So it lives here as pure
// functions with no electron/Node dependency, unit-tested in
// web/stall-summary.test.mjs. main.cjs reads the journal (via the REAL
// `readStalls` from src/stall-log.js, dynamically imported across the ESM/CJS
// boundary) and hands the records to these functions.
//
// The record shape is the one src/loop-monitor.js `buildStallRecord` writes:
//   { type, runtime, source, timestamp: ISO string, lagMs, heartbeatMs,
//     thresholdMs, attribution: [{ label, overlapMs, open, durationMs }],
//     syncTotals: [{ label, calls, totalMs }], uptimeMs?, pid? }
// Records arrive NEWEST FIRST (readStalls reverses), but nothing here depends on
// that ordering — `lastAt` is derived from the max timestamp, so a differently
// ordered (or hand-edited) file still summarizes correctly.
//
// DEFENSIVE BY CONSTRUCTION: the journal is an append-only file on the owner's
// disk that anything may have truncated or hand-edited, so every field is
// treated as untrusted. A non-array input, a non-object record, a missing or
// unparseable timestamp, or a malformed attribution entry is SKIPPED — never
// thrown on. The healthy case (no stalls ever recorded) is an empty array.

/** Coerce an ISO/epoch timestamp to epoch ms, or null when unusable. */
function toEpochMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string' || !value) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Reduce stall records to the three facts the diagnostics dialog reports.
 *
 * `topCulprit` is the label that spent the most measured milliseconds blocking
 * the loop across the retained records. Both evidence tracks the journal carries
 * are folded in, because they answer the same question from two sides:
 *   • `attribution[].overlapMs` — labelled work that was OPEN across the block
 *     (one long operation).
 *   • `syncTotals[].totalMs`    — synchronous time spent per label in the window
 *     (death by a thousand statSyncs, which attribution alone under-reports).
 * Ties break on stall count, then alphabetically, so the answer is deterministic.
 *
 * @param {unknown} records records as read from stalls.jsonl (newest first)
 * @returns {{count: number, lastAt: string|null, topCulprit: {label: string, totalMs: number, stalls: number}|null, worstLagMs: number|null}}
 */
function summarizeStalls(records) {
  const list = Array.isArray(records) ? records : [];
  let count = 0;
  let lastMs = null;
  let worstLagMs = null;
  // label -> { totalMs, stalls } (stalls = distinct records naming the label)
  const culprits = new Map();

  for (const rec of list) {
    if (!rec || typeof rec !== 'object') continue;
    count++;

    const ts = toEpochMs(rec.timestamp);
    if (ts !== null && (lastMs === null || ts > lastMs)) lastMs = ts;

    if (typeof rec.lagMs === 'number' && Number.isFinite(rec.lagMs)) {
      if (worstLagMs === null || rec.lagMs > worstLagMs) worstLagMs = Math.round(rec.lagMs);
    }

    const seenInRecord = new Set();
    const fold = (entries, msField) => {
      if (!Array.isArray(entries)) return;
      for (const entry of entries) {
        if (!entry || typeof entry !== 'object') continue;
        const label = typeof entry.label === 'string' && entry.label ? entry.label : null;
        if (!label) continue;
        const ms = typeof entry[msField] === 'number' && Number.isFinite(entry[msField])
          ? Math.max(0, entry[msField])
          : 0;
        let bucket = culprits.get(label);
        if (!bucket) {
          bucket = { totalMs: 0, stalls: 0 };
          culprits.set(label, bucket);
        }
        bucket.totalMs += ms;
        if (!seenInRecord.has(label)) {
          seenInRecord.add(label);
          bucket.stalls++;
        }
      }
    };
    fold(rec.attribution, 'overlapMs');
    fold(rec.syncTotals, 'totalMs');
  }

  let topCulprit = null;
  for (const [label, bucket] of culprits) {
    const candidate = { label, totalMs: Math.round(bucket.totalMs), stalls: bucket.stalls };
    if (
      topCulprit === null ||
      candidate.totalMs > topCulprit.totalMs ||
      (candidate.totalMs === topCulprit.totalMs && candidate.stalls > topCulprit.stalls) ||
      (candidate.totalMs === topCulprit.totalMs &&
        candidate.stalls === topCulprit.stalls &&
        candidate.label < topCulprit.label)
    ) {
      topCulprit = candidate;
    }
  }

  return {
    count,
    lastAt: lastMs === null ? null : new Date(lastMs).toISOString(),
    topCulprit,
    worstLagMs,
  };
}

/**
 * The human-readable body of the diagnostics dialog. Kept here (not in main.cjs)
 * so the exact sentences an owner reads are asserted by the test suite — the
 * "no stalls recorded" wording in particular, because that is the HEALTHY case
 * and it must not read like a failure to open the file.
 *
 * `now` is injected so the relative age is deterministic under test.
 *
 * @param {ReturnType<typeof summarizeStalls>} summary
 * @param {{logFile?: string, now?: number}} [opts]
 */
function formatStallSummary(summary, { logFile, now = Date.now() } = {}) {
  const s = summary && typeof summary === 'object' ? summary : { count: 0 };
  const lines = [];
  if (!s.count) {
    lines.push('No stalls recorded — the server event loop has not blocked long enough to be logged.');
  } else {
    lines.push(`${s.count} stall${s.count === 1 ? '' : 's'} recorded in the retained journal.`);
    if (s.lastAt) {
      const ms = new Date(s.lastAt).getTime();
      const age = Number.isFinite(ms) ? formatAge(now - ms) : null;
      lines.push(`Last stall: ${s.lastAt}${age ? ` (${age} ago)` : ''}`);
    }
    if (typeof s.worstLagMs === 'number') {
      lines.push(`Longest block: ${s.worstLagMs}ms`);
    }
    lines.push(
      s.topCulprit
        ? `Top culprit: ${s.topCulprit.label} (${s.topCulprit.totalMs}ms across ${s.topCulprit.stalls} stall${s.topCulprit.stalls === 1 ? '' : 's'})`
        : 'Top culprit: nothing instrumented was running during these stalls.',
    );
  }
  if (logFile) lines.push('', `Journal: ${logFile}`);
  return lines.join('\n');
}

/** Coarse "3m" / "2h" / "4d" age label. Sub-minute reads as "less than a minute". */
function formatAge(deltaMs) {
  if (typeof deltaMs !== 'number' || !Number.isFinite(deltaMs) || deltaMs < 0) return null;
  const minutes = Math.floor(deltaMs / 60000);
  if (minutes < 1) return 'less than a minute';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

module.exports = { summarizeStalls, formatStallSummary, formatAge };
