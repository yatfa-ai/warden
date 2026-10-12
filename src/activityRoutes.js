import express from 'express';
import { readEvents, getStatsSince, getSeriesSince, getStateSeriesSince, NON_ACTIVITY_TYPES } from './activity.js';
import { readDirectives } from './observer.js';

// Activity timeline + directive-history read-only routes, extracted verbatim from
// server.js. The handlers close over no server state.
export function createActivityRouter() {
  const router = express.Router();

  // Activity timeline endpoints
  router.get('/api/activity', async (req, res) => {
    const after = req.query.after ? new Date(req.query.after).getTime() : undefined;
    const before = req.query.before ? new Date(req.query.before).getTime() : undefined;
    const limit = req.query.limit ? parseInt(String(req.query.limit), 10) : undefined;
    // Exclude non-activity events (state_changed — internal transition marker for
    // the state timeline, WARDEN-788) so the raw feed stays discrete
    // lifecycle/directive/error activity, matching getSeriesSince/getStatsSince.
    // Without this, a state_changed row renders in the Activity Timeline as a
    // header-only "STATE CHANGED" entry with an empty detail line (no icon/color/
    // case in ActivityTimeline.tsx), and the from:null baseline fires for every
    // agent on every warden restart — fleet-wide noise. The transition still flows
    // to /api/activity/series's stateSeries (its dedicated surface).
    //
    // WARDEN-1101: the limit MUST be applied AFTER the exclusion, so it is read
    // here rather than passed into readEvents. readEvents sorts newest-first and
    // slices internally, so `readEvents({ limit })` then `.filter()` subtracts every
    // state_changed in the newest N from the user's requested N instead of skipping
    // over it — and that restart baseline arrives as one newest-first burst of N
    // agents. On a fleet ≥50, "Last 50" rendered "Showing 0 of 0 events" with a full
    // store on disk. Filtering first and slicing after makes N mean "N activity
    // events", which is what the caller asked for.
    const activity = (await readEvents({ after, before }))
      .filter((e) => !NON_ACTIVITY_TYPES.has(e.type));
    // Guard the slice explicitly: `?limit=abc` → parseInt → NaN, and a bare
    // `.slice(0, NaN)` returns [] — trading one blanking bug for another. readEvents'
    // own `if (limit && …)` guard treats NaN/0 as "no limit" and returns the full
    // feed; this preserves that behaviour for every non-positive-integer value.
    const events = Number.isInteger(limit) && limit > 0 ? activity.slice(0, limit) : activity;
    res.json({ events });
  });

  router.get('/api/activity/stats', async (req, res) => {
    const after = req.query.after ? new Date(req.query.after).getTime() : Date.now() - (24 * 60 * 60 * 1000); // Default: last 24 hours
    const stats = await getStatsSince(after);
    res.json(stats);
  });

  // Per-agent activity series for the Fleet Health sparklines (WARDEN-299). Mirrors
  // the stats endpoint's default window (last 24h) and adds an hourly bucket grid a
  // sparkline can join by `container`. Deliberately a separate endpoint — the
  // dashboard fetches it on a slow ~60s cadence, never on the 10s /api/health poll.
  //
  // WARDEN-788: the SAME response now also carries `stateSeries` — the per-bucket
  // forward-filled agent-state timeline (sibling to `series`'s volume counts). It
  // rides the existing 60s useActivitySeries poll (no new fetch/poll/SSH) so the
  // Fleet state timeline panel consumes exactly what the heatmap already fetches.
  // `series` (volume) stays activity-only — `state_changed` events are excluded
  // from getSeriesSince (and getStatsSince's total) so the heatmap reverts to its
  // pre-feature volume-of-activity meaning; stateSeries is an additive sibling
  // field computed by getStateSeriesSince, the one reader of those transitions.
  // WARDEN-1618: getSeriesSince/getStateSeriesSince allocate one slot per bucket in
  // [after, now] synchronously on the single event loop, so an unbounded `bucket`
  // (e.g. 1) or a far-past `after` blocked it for seconds (and threw "Map maximum
  // size exceeded"). Clamp both: bucket >= 1 min, window <= the 7d store retention.
  // Worst case is 7d / 1min = 10,080 buckets.
  const SERIES_MIN_BUCKET_MS = 60_000;
  const SERIES_MAX_WINDOW_MS = 7 * 24 * 3_600_000;
  router.get('/api/activity/series', async (req, res) => {
    // Both series share one axis: derive the bucket grid from a SINGLE `now` so the
    // heatmap's volume columns and the timeline's state columns can never desync by a
    // bucket (the two functions would otherwise each call Date.now() and could straddle
    // a bucket boundary). Spread volume then add the additive stateSeries sibling field.
    const now = Date.now();
    const requestedAfter = req.query.after ? new Date(req.query.after).getTime() : now - (24 * 60 * 60 * 1000); // Default: last 24 hours
    // Math.max(NaN, x) is NaN, so an unparseable `after` still flows through to an
    // empty grid exactly as before; only finite far-past values are clamped.
    const after = Math.max(requestedAfter, now - SERIES_MAX_WINDOW_MS);
    const rawBucket = req.query.bucket ? parseInt(String(req.query.bucket), 10) : 3_600_000; // default 1h
    const bucket = Number.isFinite(rawBucket) && rawBucket > 0 ? Math.max(rawBucket, SERIES_MIN_BUCKET_MS) : 3_600_000;
    const volume = await getSeriesSince(after, { bucketMs: bucket, now });
    const state = await getStateSeriesSince(after, { bucketMs: bucket, now });
    res.json({ ...volume, stateSeries: state.series });
  });

  // Directive history — reads the append-only directives.md back as structured
  // records (the inverse of observer.js logDirective). Mirrors /api/activity's
  // graceful-empty contract: a missing/empty file yields { directives: [] } and
  // never a 500. `agent`/`limit` are optional filters (agent = container, the
  // same field ActivityTimeline's agent filter uses). Newest-first.
  router.get('/api/directives', async (req, res) => {
    try {
      const agent = req.query.agent ? String(req.query.agent) : undefined;
      const limit = req.query.limit ? parseInt(String(req.query.limit), 10) : undefined;
      const directives = await readDirectives({ agent, limit });
      res.json({ directives });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  return router;
}
