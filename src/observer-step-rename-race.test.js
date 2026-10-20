import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pollUntil } from './testWait.js';

/**
 * WARDEN-1874 — renameSession's whole-file {sid}.json read-modify-write races
 * Observer.step's tail save.
 *
 * renameSession reads the WHOLE session object, mutates name/updatedAt, and writes
 * the WHOLE object back. It never joined the per-sid serialization Observer.step
 * uses, so a PATCH /api/sessions/:id rename whose write lands after a turn's tail
 * save rewrites the file with the rename's read-time `messages` array — silently
 * erasing the turn completed mid-window (the append-only .md transcript keeps it,
 * so chat history and the transcript viewer visibly disagree). The fix routes BOTH
 * writers through ONE shared per-sid chain (exported by sessions.js — two private
 * per-module chains would never serialize each other, and the dangerous pair here
 * is cross-module) and re-reads the session INSIDE the lock before applying the
 * name (serialization alone is not enough — a stale snapshot still overwrites).
 *
 * Determinism: persist.js already serializes same-path writes in ISSUE order, so
 * the losing interleave is "rename's read resolves while a step save's write is in
 * flight, rename's write queues behind it carrying the stale snapshot". The tests
 * widen exactly that window by delaying the final rename syscall of atomic writes
 * to the one {sid}.json under test (fs.promises.rename patched, restored in
 * `after`), and use persist.js's pendingWriteCount() to issue the rename only once
 * the turn's save is demonstrably in flight. HOME is redirected BEFORE the dynamic
 * imports (session paths are pinned at module load). The LLM is stubbed via global
 * fetch with per-turn delays.
 */
describe('WARDEN-1874 — a rename racing an observer turn loses neither the turn nor the name', () => {
  let savedHome, savedToken, savedFetch, savedRename, tempHome;
  let createSession, renameSession, deleteSession, getSessionAsync, Observer, pendingWriteCount;
  const sessionsDir = () => path.join(tempHome, '.yatfa-warden', 'sessions');
  const jsonPathFor = (sid) => path.join(sessionsDir(), `${sid}.json`);

  // Mutated between turns to sequence the orderings; read synchronously at the start
  // of each stubbed fetch call, so a delay change never affects an in-flight turn.
  let fetchDelayMs = 0;
  let fetchCalls = 0;
  // Widen the atomic-write completion window of ONE session json (see header):
  // the final rename syscall of every write to this path sleeps this long.
  let jsonRenameDelayMs = 0;
  let jsonRenameDelayPath = null;

  before(async () => {
    savedHome = process.env.HOME;
    savedToken = process.env.ANTHROPIC_AUTH_TOKEN;
    savedFetch = globalThis.fetch;
    savedRename = fs.promises.rename;
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-rename-race-'));
    process.env.HOME = tempHome;
    process.env.ANTHROPIC_AUTH_TOKEN = 'test-token';
    globalThis.fetch = async () => {
      const delay = fetchDelayMs;
      await new Promise((r) => setTimeout(r, delay));
      fetchCalls++;
      const body = JSON.stringify({ content: [{ type: 'text', text: `reply-${fetchCalls}` }] });
      return { ok: true, status: 200, text: async () => body };
    };
    fs.promises.rename = async (from, to) => {
      if (jsonRenameDelayMs > 0 && to === jsonRenameDelayPath) {
        await new Promise((r) => setTimeout(r, jsonRenameDelayMs));
      }
      return savedRename(from, to);
    };
    ({ createSession, renameSession, deleteSession, getSessionAsync } = await import('./sessions.js'));
    ({ pendingWriteCount } = await import('./persist.js'));
    ({ Observer } = await import('./observer.js'));
  });

  after(() => {
    fs.promises.rename = savedRename;
    globalThis.fetch = savedFetch;
    if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
    if (savedToken === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN; else process.env.ANTHROPIC_AUTH_TOKEN = savedToken;
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  function userTexts(messages) {
    return messages.filter((m) => m.role === 'user' && typeof m.content === 'string').map((m) => m.content);
  }

  // Complete one turn so the on-disk session carries messages worth losing.
  async function completeFirstTurn(sid) {
    fetchDelayMs = 20;
    const obs = new Observer({ hosts: [], llm: {} }, { sid });
    await obs.step('Q1-first-turn');
    const s = await getSessionAsync(sid);
    assert.strictEqual(s.messages.length, 2, 'first turn completed before the race starts');
  }

  it('a rename issued while a turn save is in flight keeps the completed turn AND applies the name', async () => {
    fetchCalls = 0;
    const c = await createSession('Race A');
    await completeFirstTurn(c.id);
    // Turn 2 runs; widen its tail save's completion window.
    fetchDelayMs = 50;
    jsonRenameDelayPath = jsonPathFor(c.id);
    jsonRenameDelayMs = 200;
    const turn = new Observer({ hosts: [], llm: {} }, { sid: c.id }).step('Q2-second-turn');
    // Issue the rename only once turn 2's tail save has entered the write queue —
    // its read then resolves against the PRE-turn-2 file while the save's write is
    // still in flight, and its write queues behind the save (issue order).
    await pollUntil(async () => pendingWriteCount() > 0,
      { what: "turn 2's tail save to enter the write queue", timeout: 2000, interval: 2 });
    const renamed = await renameSession(c.id, 'Renamed mid-save');
    await turn;
    jsonRenameDelayMs = 0;
    const s = await getSessionAsync(c.id);
    assert.strictEqual(s.name, 'Renamed mid-save', 'the rename survives');
    assert.strictEqual(s.messages.length, 4, 'both completed turns persist');
    assert.deepStrictEqual(userTexts(s.messages), ['Q1-first-turn', 'Q2-second-turn'], 'turn 2 is not erased by the rename');
    assert.ok(renamed && renamed.messages.length === 4, 'the rename wrote the fresh in-lock object, not a stale snapshot');
    const md = fs.readFileSync(path.join(sessionsDir(), `${c.id}.md`), 'utf8');
    assert.ok(md.includes('Q2-second-turn'), 'the append-only transcript carries the turn');
  });

  it('a turn issued while a rename write is in flight keeps the rename (step re-syncs under the lock)', async () => {
    fetchCalls = 0;
    const c = await createSession('Race B');
    await completeFirstTurn(c.id);
    // Widen the RENAME's write window, then start a turn inside it.
    jsonRenameDelayPath = jsonPathFor(c.id);
    jsonRenameDelayMs = 200;
    const renaming = renameSession(c.id, 'Renamed mid-write');
    await new Promise((r) => setTimeout(r, 30)); // rename's write is now in flight
    fetchDelayMs = 50;
    await new Observer({ hosts: [], llm: {} }, { sid: c.id }).step('Q2-second-turn');
    await renaming;
    jsonRenameDelayMs = 0;
    const s = await getSessionAsync(c.id);
    assert.strictEqual(s.name, 'Renamed mid-write', 'the concurrent turn does not overwrite the rename');
    assert.strictEqual(s.messages.length, 4, 'both completed turns persist');
    assert.deepStrictEqual(userTexts(s.messages), ['Q1-first-turn', 'Q2-second-turn'], 'both turns survive in order');
  });

  it('a rename issued mid-turn waits for the chain and returns the fresh object (no fs delay needed)', async () => {
    fetchCalls = 0;
    const c = await createSession('Race C');
    await completeFirstTurn(c.id);
    fetchDelayMs = 300;
    const turn = new Observer({ hosts: [], llm: {} }, { sid: c.id }).step('Q2-second-turn');
    await new Promise((r) => setTimeout(r, 50)); // turn 2 is mid-flight
    const renamed = await renameSession(c.id, 'Renamed mid-turn');
    await turn;
    const s = await getSessionAsync(c.id);
    assert.strictEqual(s.name, 'Renamed mid-turn');
    assert.strictEqual(s.messages.length, 4, 'both completed turns persist');
    assert.strictEqual(renamed.messages.length, 4, 'renameSession returns the on-disk-fresh object it wrote');
  });

  it('renaming a deleted session returns null, writes nothing, and resurrects no ghost', async () => {
    fetchCalls = 0;
    const c = await createSession('Doomed');
    await deleteSession(c.id);
    const renamed = await renameSession(c.id, 'Ghost');
    assert.strictEqual(renamed, null, 'a missing session renames to null');
    assert.strictEqual(await getSessionAsync(c.id), null, 'no ghost session is resurrected by the rename');
  });
});
