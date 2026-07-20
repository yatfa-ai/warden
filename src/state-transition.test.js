import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * Tests for the WARDEN-788 state-transition logging:
 *
 *   1. `logStateTransition` (server.js) — the pure dedup helper. Drives the
 *      guarded property directly with a local Map + recording appendFn: exactly
 *      one state_changed per genuine transition, NONE on an unchanged tick, the
 *      first-observation baseline (from:null), and the map keyed by agent key so
 *      a transition seen by "poller A" then "poller B" does not double-log.
 *   2. `pollAgentStates` (server.js) — the WIRING. Drives the REAL poll core with
 *      `deps.capturePanes` injected (the new test seam) so it runs ZERO SSH,
 *      classifies canned pane content with the REAL classifyPane, and writes
 *      REAL state_changed events into the REAL activity store (read back via
 *      readEvents). Proves the single logging site covers transitions, unchanged
 *      ticks, capture_failed, and the manual-chat (no-container) skip.
 *
 * HOME-isolation + seed-then-dynamic-import mirrors activity-series.test.js:
 * server.js imports activity.js, which evaluates `os.homedir()` at module load, so
 * HOME is swapped BEFORE the import and the activity.jsonl path resolves under the
 * temp dir. node --test runs each file in its own process, so the swap never leaks.
 */
const STUCK_LINE = 'stuck loop repeating the same output line over and over again';
const stuckPane = Array(7).fill(STUCK_LINE).join('\n'); // last3 === prev3, >50 chars → stuck
const idlePane = '';                                       // no signal → idle
const activePane = 'running npm build step\n';            // active keyword (+ c.active)

// A chat shaped like a yatfa agent (container set) vs a manual/tmux chat (none).
const yatfa = (key, container = key) => ({
  key, container, session: null, host: 'hostA', role: 'worker', project: 'p', name: key, active: true,
});
const manual = (key) => ({
  key, container: null, session: key, host: '(local)', role: null, name: key, active: true,
});

describe('WARDEN-788 — state-transition logging', () => {
  let originalHome, tempHome, activityPath;
  let pollAgentStates, logStateTransition, __resetLastLoggedStateForTest, readEvents, clearEvents;

  before(async () => {
    originalHome = process.env.HOME;
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-state-transition-'));
    process.env.HOME = tempHome;
    const wdir = path.join(tempHome, '.yatfa-warden');
    fs.mkdirSync(wdir, { recursive: true });
    // server.js reads config at import; a minimal hosts:[] config avoids discovery.
    fs.writeFileSync(path.join(wdir, 'config.json'), JSON.stringify({ hosts: [] }) + '\n');
    activityPath = path.join(wdir, 'activity.jsonl');
    fs.writeFileSync(activityPath, '', 'utf8');

    const server = await import('./server.js');
    ({ pollAgentStates, logStateTransition, __resetLastLoggedStateForTest } = server);
    ({ readEvents, clearEvents } = await import('./activity.js'));
  });

  after(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    try { fs.rmSync(tempHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  // Pure-helper tests don't touch the store, but reset both for isolation.
  beforeEach(() => {
    __resetLastLoggedStateForTest();
    clearEvents();
  });

  // state_changed events currently in the store.
  const stateEvents = async () => (await readEvents()).filter((e) => e.type === 'state_changed');

  // ------------------------------------------------- logStateTransition ---
  describe('logStateTransition — pure dedup', () => {
    it('first observation logs a baseline (from:null) and returns true', () => {
      const map = new Map();
      const logged = [];
      const out = logStateTransition(map, 'k', 'active', { id: 'c1' }, (e) => logged.push(e));
      assert.strictEqual(out, true);
      assert.strictEqual(logged.length, 1);
      assert.strictEqual(logged[0].from, null, 'first observation is from:null (baseline)');
      assert.strictEqual(logged[0].to, 'active');
      assert.strictEqual(logged[0].type, 'state_changed');
      assert.strictEqual(map.get('k'), 'active', 'baseline stored in the map');
    });

    it('a genuine transition logs exactly one event with correct from/to', () => {
      const map = new Map([['k', 'active']]);
      const logged = [];
      const out = logStateTransition(map, 'k', 'stuck', { id: 'c1' }, (e) => logged.push(e));
      assert.strictEqual(out, true);
      assert.strictEqual(logged.length, 1);
      assert.strictEqual(logged[0].from, 'active');
      assert.strictEqual(logged[0].to, 'stuck');
    });

    it('an unchanged tick (prev === state) logs NOTHING and returns false', () => {
      const map = new Map([['k', 'active']]);
      const logged = [];
      const out = logStateTransition(map, 'k', 'active', { id: 'c1' }, (e) => logged.push(e));
      assert.strictEqual(out, false);
      assert.strictEqual(logged.length, 0, 'no event on an unchanged tick (the dedup)');
    });

    it('the map is keyed by agent key — a transition seen by "poller A" then "poller B" does not double-log', () => {
      // Poller A observes k→stuck (a real transition from the active baseline).
      const map = new Map([['k', 'active']]);
      const logged = [];
      logStateTransition(map, 'k', 'stuck', { id: 'c1' }, (e) => logged.push(e));
      assert.strictEqual(logged.length, 1, 'poller A logs the transition once');
      // Poller B sees the SAME agent (same key) in the SAME state on its next tick.
      logStateTransition(map, 'k', 'stuck', { id: 'c1' }, (e) => logged.push(e));
      assert.strictEqual(logged.length, 1, 'poller B does NOT double-log (prev === state)');
    });

    it('distinct agent keys are independent (same state on two keys both log)', () => {
      const map = new Map();
      const logged = [];
      logStateTransition(map, 'k1', 'active', { id: 'c1' }, (e) => logged.push(e));
      logStateTransition(map, 'k2', 'active', { id: 'c2' }, (e) => logged.push(e));
      assert.strictEqual(logged.length, 2, 'two distinct keys each establish their baseline');
    });
  });

  // ------------------------------------------- pollAgentStates (wiring) ----
  describe('pollAgentStates — writes REAL state_changed events into the store', () => {
    // Inject a capturePanes that serves `panesByKey` (key → pane content). A key
    // ABSENT from the map → capture_failed (mirrors the real capturePanes drop).
    const capture = (panesByKey) => async (_chats, _cfg, _deps) => panesByKey;

    it('first observation writes a from:null baseline into the activity log', async () => {
      await pollAgentStates([yatfa('w788-a')], {}, { capturePanes: capture({ 'w788-a': stuckPane }) });
      const ev = await stateEvents();
      assert.strictEqual(ev.length, 1);
      assert.strictEqual(ev[0].from, null);
      assert.strictEqual(ev[0].to, 'stuck');
      assert.strictEqual(ev[0].container, 'w788-a');
    });

    it('a genuine transition across two polls appends EXACTLY one state_changed', async () => {
      // Poll 1: stuck (baseline).
      await pollAgentStates([yatfa('w788-b')], {}, { capturePanes: capture({ 'w788-b': stuckPane }) });
      // Poll 2: idle (transition stuck→idle).
      await pollAgentStates([yatfa('w788-b')], {}, { capturePanes: capture({ 'w788-b': idlePane }) });
      const ev = await stateEvents();
      assert.strictEqual(ev.length, 2, 'baseline + one transition');
      // The two writes land in the same millisecond (back-to-back), so readEvents's
      // desc sort is stable on the tie and preserves insertion order — ASSERT BY
      // VALUE, not array position, so the assertion is robust to that ordering.
      const baseline = ev.find((e) => e.from === null && e.to === 'stuck');
      const transition = ev.find((e) => e.from === 'stuck' && e.to === 'idle');
      assert.ok(baseline, 'first poll logged a from:null stuck baseline');
      assert.ok(transition, 'second poll logged exactly one stuck→idle transition');
    });

    it('a repeated same-state tick appends NOTHING', async () => {
      await pollAgentStates([yatfa('w788-c')], {}, { capturePanes: capture({ 'w788-c': stuckPane }) });
      await pollAgentStates([yatfa('w788-c')], {}, { capturePanes: capture({ 'w788-c': stuckPane }) });
      await pollAgentStates([yatfa('w788-c')], {}, { capturePanes: capture({ 'w788-c': stuckPane }) });
      const ev = await stateEvents();
      assert.strictEqual(ev.length, 1, 'three stuck ticks → only the baseline (no per-tick spam)');
    });

    it('capture_failed is logged as a genuine state change (reachable → unreachable)', async () => {
      // Pane key absent from the capture result → capture_failed.
      await pollAgentStates([yatfa('w788-d')], {}, { capturePanes: capture({}) });
      const ev = await stateEvents();
      assert.strictEqual(ev.length, 1);
      assert.strictEqual(ev[0].to, 'capture_failed', 'capture_failed is a logged state');
      assert.strictEqual(ev[0].from, null);
    });

    it('a manual/tmux chat (no container) writes NO state_changed event', async () => {
      await pollAgentStates([manual('w788-m')], {}, { capturePanes: capture({ 'w788-m': stuckPane }) });
      assert.strictEqual((await stateEvents()).length, 0, 'manual chats carry no timeline row → not logged');
    });

    it('the single logging site covers both callers: a transition seen once is not re-logged by a second poller', async () => {
      // Simulate poller A (open-pane poll) and poller B (fleet sweep) both polling
      // the SAME agent key within one tick window. The shared module map dedups.
      await pollAgentStates([yatfa('w788-e')], {}, { capturePanes: capture({ 'w788-e': stuckPane }) });
      await pollAgentStates([yatfa('w788-e')], {}, { capturePanes: capture({ 'w788-e': stuckPane }) });
      const ev = await stateEvents();
      assert.strictEqual(ev.length, 1, 'two pollers, same state → one baseline, no double-log');
    });
  });
});
