import express from 'express';
import { readStalls, stallLogFile } from './stall-log.js';
import { resolveBudgetConfig } from './budget.js';

// Diagnostics / status read-only routes (/api/diagnostics/stalls,
// /api/diagnostics/pane-latency, /api/this-session, /api/budget), extracted
// verbatim from server.js. Injected: the loop monitor, the pane-input telemetry
// recorder, the shared `cfg`, and a `getBudgetState` thunk (the budget tick is
// constructed after these routes are mounted, so it must be read lazily —
// passing the value would hit the TDZ).
export function createStatusRouter({ loopMonitor, paneInputTelemetry, cfg, getBudgetState }) {
  const router = express.Router();

  // Recorded server stalls — the owner-facing read surface for the durable log.
  // Reads the FILE (not just the in-process ring) so the evidence survives a
  // restart; `session` additionally exposes this process's ring, which is the
  // fallback when the home dir is unwritable. Zero SSH, one async file read.
  router.get('/api/diagnostics/stalls', async (req, res) => {
    try {
      const limitRaw = parseInt(String(req.query.limit ?? ''), 10);
      const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 500) : 50;
      const stalls = await readStalls({ limit });
      res.json({
        logFile: stallLogFile(),
        config: loopMonitor.config,
        stats: loopMonitor.stats(),
        stalls,
        session: loopMonitor.stalls().slice(-limit).reverse(),
        timestamp: Date.now(),
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // WARDEN-1385 — pane-input latency, the owner's on-demand read surface: the
  // per-PANE round-trip ledger (which pane, how slow, how stale) plus the
  // current aggregate window for the two server-side hops (pane-input-write,
  // pane-input-roundtrip). This is the local half of the attribution story —
  // pane KEYS may appear here because this surface is the owner's, exactly like
  // stalls.jsonl + /api/diagnostics/stalls; the TELEMETRY channel still carries
  // only the closed-set hop histograms, never a pane key (WARDEN-443).
  // Read-only: it snapshots the live window without flushing it, so curling this
  // endpoint mid-window never perturbs or splits the telemetry window.
  router.get('/api/diagnostics/pane-latency', (req, res) => {
    try {
      res.json({
        recording: paneInputTelemetry.isEnabled(),
        ledger: paneInputTelemetry.ledgerSnapshot(),
        window: paneInputTelemetry.windowSnapshot(),
        pending: paneInputTelemetry.pendingCount(),
        timestamp: Date.now(),
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.get('/api/this-session', (_req, res) => res.json({
    sessionId: process.env.CLAUDE_CODE_SESSION_ID || null,
    claudePath: process.env.CLAUDE_CODE_EXECPATH || null,
    cwd: process.cwd(),
  }));

  // GET /api/budget — the cached token-spend budget snapshot (WARDEN-415). Cheap
  // by design: the slow-cadence accumulator (tickBudget) computes this every
  // ~120s by reusing the existing per-session token fetch, so this handler only
  // reads the cache — no transcript reads, no SSH. Returns `enabled:false` with
  // zeroed fields when the budget is off (or before the first sweep lands) so the
  // frontend can render the progress surface + run the debounce check uniformly.
  // `windowHours` is derived from the cached windowMs so the UI speaks hours.
  router.get('/api/budget', (_req, res) => {
    const b = getBudgetState();
    if (!cfg.tokenBudgetEnabled || !b) {
      const { threshold, perSessionThreshold, windowHours } = resolveBudgetConfig(cfg);
      return res.json({
        enabled: !!cfg.tokenBudgetEnabled,
        threshold,
        perSessionThreshold,
        windowHours,
        fleetSpent: 0,
        sessionCount: 0,
        fleetBreached: false,
        perSessionBreached: false,
        topOffender: null,
        // Empty until the first sweep lands (WARDEN-466) — no sessions to join yet.
        sessionUsage: [],
        alerted: false,
        evaluatedAt: null,
      });
    }
    res.json({
      enabled: true,
      threshold: b.threshold,
      perSessionThreshold: b.perSessionThreshold,
      windowHours: b.windowMs / 3_600_000,
      fleetSpent: b.fleetSpent,
      sessionCount: b.sessionCount,
      fleetBreached: b.fleetBreached,
      perSessionBreached: b.perSessionBreached,
      topOffender: b.topOffender,
      // Per-session usage distribution (WARDEN-466) — the map /api/health joins on.
      sessionUsage: Array.isArray(b.sessionUsage) ? b.sessionUsage : [],
      alerted: b.alerted,
      evaluatedAt: b.evaluatedAt,
    });
  });

  return router;
}
