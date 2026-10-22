import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import express from 'express';

/**
 * Router-level spec for createStatusRouter (src/statusRoutes.js, moved out of server.js
 * by WARDEN-1904). Routes: GET /api/diagnostics/stalls, /api/diagnostics/pane-latency,
 * /api/this-session and /api/budget. The suites that reach these through the real server
 * (server-diagnostics-stalls, server-diagnostics-pane-latency, server-budget, ...) leave
 * the session-ring tail/ordering, the ?limit clamp, the 500 channels, the env echo and the
 * budget off / pre-sweep / cached field mapping unasserted; this file pins them directly.
 *
 * Harness: the REAL router on a bare express app (never server.js — module-freeze hazard,
 * WARDEN-130). HOME is frozen to a temp dir BEFORE the dynamic import (stall-log reads
 * os.homedir()). Injected collaborators are STABLE objects mutated in place (the router
 * closes over them at mount): fake loopMonitor / paneInputTelemetry, a Proxy `cfg`, and a
 * `getBudgetState` thunk reading a mutable variable.
 */

describe('createStatusRouter (bare express app)', () => {
  let originalHome, tempDir, server, baseUrl;

  let cfgState, budgetState;
  let monitor, telemetry;
  const envKeys = ['CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_EXECPATH'];
  const savedEnv = {};

  const get = async (p) => {
    const res = await fetch(`${baseUrl}${p}`);
    return { status: res.status, body: await res.json() };
  };

  // Newest-last ring, as LoopMonitor.stalls() returns it.
  const ring = (n) => Array.from({ length: n }, (_, i) => ({ id: i + 1 }));

  before(async () => {
    originalHome = process.env.HOME;
    for (const k of envKeys) savedEnv[k] = process.env[k];
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-statusroutes-'));
    process.env.HOME = tempDir;

    const { createStatusRouter } = await import('./statusRoutes.js');

    const cfg = new Proxy({}, { get: (_t, k) => cfgState[k] });
    const loopMonitor = {
      get config() { return monitor.config; },
      stats() { if (monitor.throws) throw new Error(monitor.throws); return monitor.stats; },
      stalls() { return monitor.ring; },
    };
    const paneInputTelemetry = {
      isEnabled: () => { if (telemetry.throws) throw new Error(telemetry.throws); return telemetry.enabled; },
      ledgerSnapshot: () => telemetry.ledger,
      windowSnapshot: () => telemetry.window,
      pendingCount: () => telemetry.pending,
    };
    const getBudgetState = () => budgetState;

    const app = express();
    app.use(createStatusRouter({ loopMonitor, paneInputTelemetry, cfg, getBudgetState }));
    await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome;
    for (const k of envKeys) {
      if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k];
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    cfgState = {};
    budgetState = undefined;
    monitor = { config: { thresholdMs: 250 }, stats: { count: 3 }, ring: [], throws: null };
    telemetry = { enabled: true, ledger: [{ pane: 'a' }], window: { n: 2 }, pending: 7, throws: null };
    for (const k of envKeys) delete process.env[k];
  });

  describe('GET /api/diagnostics/stalls', () => {
    it('serves the newest-`limit` tail of the session ring, newest first, with config/stats from the monitor', async () => {
      monitor.ring = ring(10);
      const { status, body } = await get('/api/diagnostics/stalls?limit=3');
      assert.strictEqual(status, 200);
      assert.deepStrictEqual(body.session.map((s) => s.id), [10, 9, 8]);
      assert.deepStrictEqual(body.config, { thresholdMs: 250 });
      assert.deepStrictEqual(body.stats, { count: 3 });
      assert.ok(Array.isArray(body.stalls));
      assert.strictEqual(typeof body.logFile, 'string');
      assert.strictEqual(typeof body.timestamp, 'number');
    });

    it('caps the session ring at 500 and falls back to 50 for 0 / negative / junk limits', async () => {
      monitor.ring = ring(700);
      const capped = await get('/api/diagnostics/stalls?limit=5000');
      assert.strictEqual(capped.body.session.length, 500);
      assert.strictEqual(capped.body.session[0].id, 700);
      const exact = await get('/api/diagnostics/stalls?limit=1');
      assert.strictEqual(exact.body.session.length, 1);
      for (const bad of ['0', '-5', 'abc', '']) {
        const { body } = await get(`/api/diagnostics/stalls?limit=${bad}`);
        assert.strictEqual(body.session.length, 50, `limit=${JSON.stringify(bad)}`);
        assert.strictEqual(body.session[0].id, 700);
      }
      assert.strictEqual((await get('/api/diagnostics/stalls')).body.session.length, 50);
    });

    it('answers 500 {error: message} when the monitor throws', async () => {
      monitor.throws = 'monitor boom';
      const { status, body } = await get('/api/diagnostics/stalls');
      assert.strictEqual(status, 500);
      assert.deepStrictEqual(body, { error: 'monitor boom' });
    });
  });

  describe('GET /api/diagnostics/pane-latency', () => {
    it('maps each telemetry accessor to its own key', async () => {
      const { status, body } = await get('/api/diagnostics/pane-latency');
      assert.strictEqual(status, 200);
      assert.strictEqual(body.recording, true);
      assert.deepStrictEqual(body.ledger, [{ pane: 'a' }]);
      assert.deepStrictEqual(body.window, { n: 2 });
      assert.strictEqual(body.pending, 7);
      assert.strictEqual(typeof body.timestamp, 'number');
      telemetry.enabled = false;
      telemetry.pending = 0;
      const off = await get('/api/diagnostics/pane-latency');
      assert.strictEqual(off.body.recording, false);
      assert.strictEqual(off.body.pending, 0);
    });

    it('answers 500 {error: message} when the telemetry throws', async () => {
      telemetry.throws = 'telemetry boom';
      const { status, body } = await get('/api/diagnostics/pane-latency');
      assert.strictEqual(status, 500);
      assert.deepStrictEqual(body, { error: 'telemetry boom' });
    });
  });

  describe('GET /api/this-session', () => {
    it('echoes the env ids and process.cwd(); unset and empty-string both become null', async () => {
      process.env.CLAUDE_CODE_SESSION_ID = 'sess-123';
      process.env.CLAUDE_CODE_EXECPATH = '/usr/bin/claude';
      const set = await get('/api/this-session');
      assert.strictEqual(set.status, 200);
      assert.deepStrictEqual(set.body, {
        sessionId: 'sess-123', claudePath: '/usr/bin/claude', cwd: process.cwd(),
      });

      delete process.env.CLAUDE_CODE_SESSION_ID;
      delete process.env.CLAUDE_CODE_EXECPATH;
      const unset = await get('/api/this-session');
      assert.strictEqual(unset.body.sessionId, null);
      assert.strictEqual(unset.body.claudePath, null);

      process.env.CLAUDE_CODE_SESSION_ID = '';
      process.env.CLAUDE_CODE_EXECPATH = '';
      const empty = await get('/api/this-session');
      assert.strictEqual(empty.body.sessionId, null);
      assert.strictEqual(empty.body.claudePath, null);
    });
  });

  describe('GET /api/budget', () => {
    const zeroed = {
      fleetSpent: 0, sessionCount: 0, fleetBreached: false, perSessionBreached: false,
      topOffender: null, sessionUsage: [], alerted: false, evaluatedAt: null,
    };

    it('budget OFF with a cached state present: zeroed snapshot using the configured thresholds/windowHours', async () => {
      cfgState = {
        tokenBudgetEnabled: false,
        tokenBudgetThresholdTokens: 1234,
        tokenBudgetPerSessionThresholdTokens: 56,
        tokenBudgetWindowHours: 3,
      };
      budgetState = { threshold: 9, perSessionThreshold: 9, windowMs: 1, fleetSpent: 99, sessionCount: 4 };
      const { status, body } = await get('/api/budget');
      assert.strictEqual(status, 200);
      assert.deepStrictEqual(body, {
        enabled: false, threshold: 1234, perSessionThreshold: 56, windowHours: 3, ...zeroed,
      });
    });

    it('budget OFF with no cfg flag at all: `enabled` is coerced to false', async () => {
      cfgState = {};
      const { body } = await get('/api/budget');
      assert.strictEqual(body.enabled, false);
      assert.strictEqual(body.fleetSpent, 0);
    });

    it('budget ON before the first sweep: enabled:true, zeroed, configured thresholds', async () => {
      cfgState = {
        tokenBudgetEnabled: true,
        tokenBudgetThresholdTokens: 5000,
        tokenBudgetPerSessionThresholdTokens: 700,
        tokenBudgetWindowHours: 2,
      };
      budgetState = null;
      const { body } = await get('/api/budget');
      assert.deepStrictEqual(body, {
        enabled: true, threshold: 5000, perSessionThreshold: 700, windowHours: 2, ...zeroed,
      });
    });

    it('budget ON with a cached state: exact field mapping, windowHours = windowMs / 3.6e6', async () => {
      cfgState = { tokenBudgetEnabled: true, tokenBudgetThresholdTokens: 1, tokenBudgetWindowHours: 24 };
      const usage = [{ id: 'h:s', tokens: 10 }];
      budgetState = {
        threshold: 1000,
        perSessionThreshold: 300,
        windowMs: 90 * 60_000,
        fleetSpent: 1500,
        sessionCount: 6,
        fleetBreached: true,
        perSessionBreached: true,
        topOffender: { id: 'h:s', tokens: 400 },
        sessionUsage: usage,
        alerted: true,
        evaluatedAt: 1700000000000,
      };
      const { body } = await get('/api/budget');
      assert.deepStrictEqual(body, {
        enabled: true,
        threshold: 1000,
        perSessionThreshold: 300,
        windowHours: 1.5,
        fleetSpent: 1500,
        sessionCount: 6,
        fleetBreached: true,
        perSessionBreached: true,
        topOffender: { id: 'h:s', tokens: 400 },
        sessionUsage: usage,
        alerted: true,
        evaluatedAt: 1700000000000,
      });
    });

    it('serves a non-array / undefined sessionUsage as []', async () => {
      cfgState = { tokenBudgetEnabled: true };
      const base = { threshold: 1, perSessionThreshold: 0, windowMs: 3_600_000, fleetSpent: 0, sessionCount: 0 };
      budgetState = { ...base, sessionUsage: { not: 'an array' } };
      assert.deepStrictEqual((await get('/api/budget')).body.sessionUsage, []);
      budgetState = { ...base };
      assert.deepStrictEqual((await get('/api/budget')).body.sessionUsage, []);
    });

    it('reads getBudgetState per request (lazy thunk, not captured at mount)', async () => {
      cfgState = { tokenBudgetEnabled: true, tokenBudgetThresholdTokens: 1 };
      budgetState = null;
      assert.strictEqual((await get('/api/budget')).body.fleetSpent, 0);
      budgetState = { threshold: 1, perSessionThreshold: 0, windowMs: 3_600_000, fleetSpent: 42, sessionCount: 1 };
      assert.strictEqual((await get('/api/budget')).body.fleetSpent, 42);
      budgetState = { ...budgetState, fleetSpent: 43 };
      assert.strictEqual((await get('/api/budget')).body.fleetSpent, 43);
    });
  });
});
