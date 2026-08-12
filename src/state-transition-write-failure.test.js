import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * WARDEN-947 — a FAILING activity write must not crash the server.
 *
 * `appendStateEvent` (src/server.js) guards the `state_changed` append so "a disk
 * hiccough shouldn't 500 /api/agent-states or sink the attention rollup". It shipped
 * (WARDEN-788) as a SYNCHRONOUS try/catch around `appendEvent`, which WARDEN-831 had
 * made ASYNC:
 *
 *     try { appendEvent(event); } catch { }   // catches NOTHING — promise dropped
 *
 * A sync try/catch only sees a throw raised before the callee's first await; a
 * REJECTION escapes it entirely. The dropped promise then surfaces as an
 * `unhandledRejection`, which on Node >= 15 TERMINATES the process — the exact
 * outcome the guard exists to prevent. `appendStateEvent` fires from every genuine
 * transition on the 30s poll, the 90s hidden-fleet sweep and the 60s webhook sweep,
 * so any transient ENOSPC/EACCES/unmounted-home takes the backend down on a tick.
 *
 * NOTHING covered this path before. These tests drive it for real: the activity
 * JSONL path is seeded as a DIRECTORY, so `atomicAppend`'s `fs.promises.appendFile`
 * rejects with EISDIR on every write. That injection is deterministic and — unlike a
 * chmod-based read-only home — still fails when the suite runs as root.
 *
 * The FIRST test is the positive control (WARDEN-130's green-lie rule): it proves the
 * injected failure is real, so a later "no unhandledRejection" pass cannot be the
 * vacuous result of a write that quietly succeeded.
 *
 * HOME-isolation + seed-then-dynamic-import mirrors state-transition.test.js.
 */

const STUCK_LINE = 'stuck loop repeating the same output line over and over again';
const stuckPane = Array(7).fill(STUCK_LINE).join('\n'); // last3 === prev3, >50 chars → stuck

const yatfa = (key, container = key) => ({
  key, container, session: null, host: 'hostA', role: 'worker', project: 'p', name: key, active: true,
});

// capturePanes seam: serves `panesByKey`; an ABSENT key → capture_failed.
const capture = (panesByKey) => async (_chats, _cfg, _deps) => panesByKey;

// Let any escaped rejection reach the process-level handler before we assert.
const settle = () => new Promise((r) => setTimeout(r, 50));

describe('WARDEN-947 — a failing state_changed write never escapes as unhandledRejection', () => {
  let originalHome, tempHome;
  let pollAgentStates, appendStateEvent, __resetLastLoggedStateForTest, appendEvent;
  const rejections = [];
  const onRejection = (reason) => rejections.push(reason);

  before(async () => {
    originalHome = process.env.HOME;
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-write-fail-'));
    process.env.HOME = tempHome;
    const wdir = path.join(tempHome, '.yatfa-warden');
    fs.mkdirSync(wdir, { recursive: true });
    fs.writeFileSync(path.join(wdir, 'config.json'), JSON.stringify({ hosts: [] }) + '\n');
    // THE FAILURE INJECTION: activity.jsonl is a DIRECTORY, so appendFile → EISDIR.
    fs.mkdirSync(path.join(wdir, 'activity.jsonl'), { recursive: true });

    process.on('unhandledRejection', onRejection);

    const server = await import('./server.js');
    ({ pollAgentStates, appendStateEvent, __resetLastLoggedStateForTest } = server);
    ({ appendEvent } = await import('./activity.js'));
    __resetLastLoggedStateForTest();
  });

  after(() => {
    process.removeListener('unhandledRejection', onRejection);
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    try { fs.rmSync(tempHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it('POSITIVE CONTROL — the raw appendEvent really does reject under this injection', async () => {
    await assert.rejects(
      () => appendEvent({ type: 'state_changed', from: null, to: 'stuck', container: 'ctl' }),
      (err) => {
        assert.ok(err instanceof Error, 'a real write error');
        assert.strictEqual(err.code, 'EISDIR', `expected EISDIR, got ${err.code}`);
        return true;
      },
      'the injected failure must be REAL — otherwise the guard tests below prove nothing',
    );
  });

  it('appendStateEvent SWALLOWS the write failure — it resolves instead of rejecting', async () => {
    // The sync-try/catch shape returned undefined and left a live rejected promise
    // behind; the fixed shape awaits inside the try, so this resolves cleanly.
    await assert.doesNotReject(() => appendStateEvent({
      type: 'state_changed', from: null, to: 'stuck', container: 'w947-direct',
    }));
    await settle();
    assert.deepStrictEqual(rejections, [], 'no rejection escaped to the process');
  });

  it('pollAgentStates still classifies and returns normally when every write fails', async () => {
    const agents = await pollAgentStates(
      [yatfa('w947-a')], {}, { capturePanes: capture({ 'w947-a': stuckPane }) },
    );
    assert.strictEqual(agents.length, 1, 'the poll completed');
    assert.strictEqual(agents[0].state, 'stuck', 'classification is unaffected by the write failure');
    await settle();
    assert.deepStrictEqual(rejections, [], 'a dead activity store must not sink the poll');
  });

  it('the capture_failed logging site is guarded too (absent pane key)', async () => {
    const agents = await pollAgentStates(
      [yatfa('w947-b')], {}, { capturePanes: capture({}) },
    );
    assert.strictEqual(agents[0].state, 'capture_failed');
    await settle();
    assert.deepStrictEqual(rejections, [], 'the capture_failed append is guarded on the same path');
  });

  it('repeated ticks against a dead store keep the poll alive (hot path, not a one-off)', async () => {
    for (const state of ['stuck', '', 'stuck']) {
      const agents = await pollAgentStates(
        [yatfa('w947-c')], {}, { capturePanes: capture({ 'w947-c': state === 'stuck' ? stuckPane : '' }) },
      );
      assert.strictEqual(agents.length, 1);
    }
    await settle();
    assert.deepStrictEqual(rejections, [], 'every transition write failed, none escaped');
  });
});
