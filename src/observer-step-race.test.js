import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * WARDEN-1867 — two Observers on one sid race the whole-array {sid}.json tail save.
 *
 * The ws layer builds ONE Observer per connection and each `user` frame calls
 * obs.step(), so a page reload mid-turn (the old socket's Observer keeps running its
 * turn server-side while the fresh connection builds a new Observer from disk) or two
 * tabs on the same saved session yield two concurrent turns whose tail saves race:
 * saveMessages rewrites the WHOLE file last-writer-wins, so whichever turn finishes
 * last replaces it with a stale in-memory array — the other connection's completed
 * turn is silently erased from the session (the append-only .md transcript keeps it,
 * so the transcript viewer and chat history visibly disagree).
 *
 * The fix has two load-bearing halves: a cross-instance per-sid turn chain
 * (serialization) AND a re-sync of this.messages from disk under that chain before
 * running the turn (the second Observer's array is stale even running second).
 *
 * HOME is redirected BEFORE the dynamic imports (session paths are pinned at module
 * load). The LLM is stubbed via global fetch with per-turn delays to force both
 * orderings; each turn issues exactly one fetch (plain text reply, no tool_use).
 */
describe('WARDEN-1867 — concurrent turns on one sid keep every completed turn', () => {
  let savedHome, savedToken, savedFetch, tempHome;
  let createSession, getSessionAsync, Observer;

  // Mutated between turns to sequence the orderings; read synchronously at the start
  // of each stubbed fetch call, so a delay change never affects an in-flight turn.
  let fetchDelayMs = 0;
  let fetchCalls = 0;

  before(async () => {
    savedHome = process.env.HOME;
    savedToken = process.env.ANTHROPIC_AUTH_TOKEN;
    savedFetch = globalThis.fetch;
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-step-race-'));
    process.env.HOME = tempHome;
    process.env.ANTHROPIC_AUTH_TOKEN = 'test-token';
    globalThis.fetch = async () => {
      const delay = fetchDelayMs;
      await new Promise((r) => setTimeout(r, delay));
      fetchCalls++;
      const body = JSON.stringify({ content: [{ type: 'text', text: `reply-${fetchCalls}` }] });
      return { ok: true, status: 200, text: async () => body };
    };
    ({ createSession, getSessionAsync } = await import('./sessions.js'));
    ({ Observer } = await import('./observer.js'));
  });

  after(() => {
    globalThis.fetch = savedFetch;
    if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
    if (savedToken === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN; else process.env.ANTHROPIC_AUTH_TOKEN = savedToken;
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  function userTexts(messages) {
    return messages.filter((m) => m.role === 'user' && typeof m.content === 'string').map((m) => m.content);
  }

  async function assertBothTurnsSurvive(sid, firstUser, secondUser) {
    const s = await getSessionAsync(sid);
    assert.ok(s, 'session is still on disk');
    assert.strictEqual(s.messages.length, 4, 'two completed turns persist 4 messages');
    assert.deepStrictEqual(userTexts(s.messages), [firstUser, secondUser], 'both user texts survive in order');
  }

  it('control: sequential turns on one Observer persist both turns', async () => {
    fetchDelayMs = 20;
    fetchCalls = 0;
    const c = await createSession('Race control');
    const obs = new Observer({ hosts: [], llm: {} }, { sid: c.id });
    await obs.step('Q1-sequential');
    await obs.step('Q2-sequential');
    await assertBothTurnsSurvive(c.id, 'Q1-sequential', 'Q2-sequential');
  });

  it('reload mid-turn: the stale pre-reload turn finishing last keeps the fresh turn', async () => {
    fetchDelayMs = 300;
    fetchCalls = 0;
    const c = await createSession('Reload race');
    // Tab A's turn starts; its Observer keeps running after the reload.
    const stale = new Observer({ hosts: [], llm: {} }, { sid: c.id });
    const staleTurn = stale.step('Q1-from-tab-A');
    // The reload lands mid-turn: the fresh connection builds a new Observer from disk,
    // which does NOT include tab A's in-flight turn.
    await new Promise((r) => setTimeout(r, 50));
    const fresh = new Observer({ hosts: [], llm: {} }, { sid: c.id });
    fetchDelayMs = 100;
    await fresh.step('Q2-after-reload');
    await staleTurn;
    await assertBothTurnsSurvive(c.id, 'Q1-from-tab-A', 'Q2-after-reload');
  });

  it('two tabs: a tab that loaded before the other tab saved keeps that completed turn', async () => {
    fetchDelayMs = 100;
    fetchCalls = 0;
    const c = await createSession('Two tabs');
    const tabA = new Observer({ hosts: [], llm: {} }, { sid: c.id });
    // Tab B is constructed before A's turn saves, so its in-memory array is stale.
    const tabB = new Observer({ hosts: [], llm: {} }, { sid: c.id });
    await tabA.step('Q1-first-tab'); // completes and saves
    await tabB.step('Q2-second-tab'); // runs after, from a stale array
    await assertBothTurnsSurvive(c.id, 'Q1-first-tab', 'Q2-second-tab');
  });

  it('an Observer with no sid keeps the inline path and returns the reply', async () => {
    fetchDelayMs = 20;
    fetchCalls = 0;
    const obs = new Observer({ hosts: [], llm: {} }, {});
    assert.strictEqual(obs.sid, null);
    const reply = await obs.step('Q1-no-session');
    assert.strictEqual(reply, 'reply-1');
  });
});
