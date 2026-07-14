// HTTP-level integration test for the token-spend budget (WARDEN-415).
//
// src/budget.test.js covers the PURE logic (computeBudgetState,
// shouldFireBudgetAlert, resolveBudgetConfig) with plain objects. This file
// covers the INTEGRATION GLUE that pure suite cannot reach: tickBudget's wiring
// of localClaudeSessions → computeBudgetState → the module-level budgetState
// cache → the /api/budget response shape — including the '(local)' host tag and
// the window filter as they actually run over a planted transcript. This is the
// regression guard for the field mapping / host tagging / cache write that the
// export-only comment previously claimed but no test exercised.
//
// Pattern mirrors src/server-hosts-status.test.js: an isolated HOME whose config
// has no remote hosts (so only '(local)' is probed — no SSH, fast, deterministic)
// and a planted ~/.claude/projects/*/*.jsonl transcript. The budget is enabled
// via the config FILE (not PUT /api/config) so restartBudgetPoll never creates a
// 120s setInterval; the test drives a single sweep with the exported tickBudget()
// directly — exactly the deterministic, timer-free entry point it is exported to
// provide.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('/api/budget + tickBudget integration (real server.js)', () => {
  let httpServer;
  let baseUrl;
  let originalHome;
  let tempHome;
  let tickBudget;

  // A transcript whose lifetime usage breaches BOTH the default fleet (2M) and
  // per-session (1M) thresholds, so a single sweep flips alerted → true.
  const BREACH_ID = 'breach-session-415';
  const BREACH_TOTAL = 2_100_000;

  // Plant a ~/.claude/projects/p415/<id>.jsonl transcript. One cwd line (so
  // localClaudeSessions keeps the row — it filters out sessions with no cwd) +
  // one assistant turn carrying the usage; parseJsonlTokenUsage sums every
  // message.usage line. `ageMs` pushes mtime outside the 24h window to exercise
  // the window filter end-to-end.
  function writeTranscript(id, total, opts = {}) {
    const projDir = path.join(tempHome, '.claude', 'projects', 'p415');
    fs.mkdirSync(projDir, { recursive: true });
    const file = path.join(projDir, `${id}.jsonl`);
    fs.writeFileSync(file, [
      JSON.stringify({ cwd: `/tmp/${id}`, type: 'user', message: { content: `work on ${id}` } }),
      JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: total, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } }),
    ].join('\n') + '\n');
    if (opts.ageMs) {
      const t = (Date.now() - opts.ageMs) / 1000;
      fs.utimesSync(file, t, t);
    }
    return file;
  }

  before(async () => {
    originalHome = process.env.HOME;
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-budget-'));
    process.env.HOME = tempHome;
    const wardenDir = path.join(tempHome, '.yatfa-warden');
    fs.mkdirSync(wardenDir, { recursive: true });
    // Enabled up front so tickBudget runs a real sweep (no PUT → no 120s timer).
    // Thresholds stated explicitly so the breach math is obvious regardless of
    // config.js DEFAULTS (they match the defaults, but the test shouldn't depend
    // on a default constant to know what "breached" means).
    fs.writeFileSync(path.join(wardenDir, 'config.json'), JSON.stringify({
      hosts: [],
      tokenBudgetEnabled: true,
      tokenBudgetThresholdTokens: 2_000_000,
      tokenBudgetPerSessionThresholdTokens: 1_000_000,
      tokenBudgetWindowHours: 24,
    }));

    writeTranscript(BREACH_ID, BREACH_TOTAL);

    const server = await import('./server.js');
    tickBudget = server.tickBudget;
    httpServer = server.app.listen(0, '127.0.0.1');
    await new Promise((resolve, reject) => {
      httpServer.once('listening', resolve);
      httpServer.once('error', reject);
    });
    baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
  });

  after(async () => {
    if (httpServer) await new Promise((r) => httpServer.close(r));
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    try { fs.rmSync(tempHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it('reports an empty cache (enabled, zeroed, not alerted) before the first sweep', async () => {
    // budgetState is null until tickBudget runs; the handler's !b branch returns
    // enabled (config is on) but zeroed fields + evaluatedAt:null.
    const body = await (await fetch(`${baseUrl}/api/budget`)).json();
    assert.strictEqual(body.enabled, true);
    assert.strictEqual(body.fleetSpent, 0);
    assert.strictEqual(body.alerted, false);
    assert.strictEqual(body.evaluatedAt, null);
  });

  it('tickBudget sweeps local transcripts into the cache and breaches', async () => {
    await tickBudget(); // the exported single-sweep entry point
    const body = await (await fetch(`${baseUrl}/api/budget`)).json();
    assert.strictEqual(body.enabled, true);
    assert.strictEqual(body.fleetSpent, BREACH_TOTAL);
    assert.strictEqual(body.sessionCount, 1);
    assert.strictEqual(body.fleetBreached, true);
    assert.strictEqual(body.perSessionBreached, true);
    assert.strictEqual(body.alerted, true);
    assert.strictEqual(typeof body.evaluatedAt, 'number');
    // Integration glue: the '(local)' host tag + offender identity flow through
    // from localClaudeSessions → computeBudgetState → the /api/budget response.
    assert.ok(body.topOffender, 'topOffender must be set on a breach');
    assert.strictEqual(body.topOffender.id, BREACH_ID);
    assert.strictEqual(body.topOffender.host, '(local)');
    assert.strictEqual(body.topOffender.total, BREACH_TOTAL);
  });

  it('excludes sessions whose mtime is outside the window (window filter end-to-end)', async () => {
    // An old, huge session (out of 24h) must NOT count toward fleetSpent even
    // though its lifetime total dwarfs the in-window offender — this is exactly
    // the window-agnostic vs. in-window distinction WARDEN-415 relies on.
    writeTranscript('old-huge', 9_000_000, { ageMs: 48 * 3_600_000 });
    await tickBudget();
    const body = await (await fetch(`${baseUrl}/api/budget`)).json();
    assert.strictEqual(body.fleetSpent, BREACH_TOTAL); // 9M old one excluded
    assert.strictEqual(body.sessionCount, 1);
    assert.strictEqual(body.topOffender.id, BREACH_ID);
  });
});
