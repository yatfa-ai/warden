import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pollUntil } from './testWait.js';

/**
 * WARDEN-1841 — Observer.step() must not re-create a session deleted mid-turn.
 * Closing an observer tab fires DELETE /api/sessions/:id while a turn may still be in
 * flight; the step tail's create-if-missing saveMessages/appendTranscript would otherwise
 * resurrect it as a ghost named by its raw id.
 *
 * HOME is redirected BEFORE the dynamic imports (session paths are pinned at module load).
 * The LLM is stubbed via global fetch with a delayed reply so the delete lands mid-turn.
 */
describe('WARDEN-1841 — Observer.step() does not resurrect a session deleted mid-turn', () => {
  let savedHome, savedToken, savedFetch, tempHome, sessionsDir;
  let createSession, deleteSession, listSessions, getSessionAsync, Observer;

  before(async () => {
    savedHome = process.env.HOME;
    savedToken = process.env.ANTHROPIC_AUTH_TOKEN;
    savedFetch = globalThis.fetch;
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-step-delete-'));
    process.env.HOME = tempHome;
    process.env.ANTHROPIC_AUTH_TOKEN = 'test-token';
    globalThis.fetch = async () => {
      await new Promise((r) => setTimeout(r, 300));
      const body = JSON.stringify({ content: [{ type: 'text', text: 'ok' }] });
      return { ok: true, status: 200, text: async () => body };
    };
    ({ createSession, deleteSession, listSessions, getSessionAsync } = await import('./sessions.js'));
    ({ Observer } = await import('./observer.js'));
    sessionsDir = tempHome;
  });

  after(() => {
    globalThis.fetch = savedFetch;
    if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
    if (savedToken === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN; else process.env.ANTHROPIC_AUTH_TOKEN = savedToken;
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  function filesFor(id) {
    const found = [];
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name === `${id}.json` || e.name === `${id}.md`) found.push(p);
      }
    };
    walk(sessionsDir);
    return found;
  }

  // Content of the session's .md transcript ('' when absent or unreadable — e.g.
  // mid-append), for polling on a transcript block having landed.
  function mdFor(id) {
    const md = filesFor(id).find((f) => f.endsWith('.md'));
    try { return md ? fs.readFileSync(md, 'utf8') : ''; } catch { return ''; }
  }

  it('control: without a delete the turn persists both files and 2 messages', async () => {
    const c = await createSession('Control');
    const obs = new Observer({ hosts: [], llm: {} }, { sid: c.id });
    await obs.step('hi');
    const files = filesFor(c.id).map((f) => path.extname(f)).sort();
    assert.deepStrictEqual(files, ['.json', '.md']);
    const s = await getSessionAsync(c.id);
    assert.strictEqual(s.messages.length, 2);
  });

  it('a session deleted mid-turn leaves no {id}.json/{id}.md and no listSessions entry', async () => {
    const c = await createSession('Doomed');
    const obs = new Observer({ hosts: [], llm: {} }, { sid: c.id });
    const turn = obs.step('hi');
    // Wait until the turn's START write landed before deleting: _runTurn's first await
    // is the create-if-missing user-transcript append (observer.js). If the delete
    // races that in-flight write, atomicAppend re-creates the .md after deleteSession's
    // unlinks — observed twice on clean main under full-suite load with the old fixed
    // 50ms sleep (WARDEN-1873). NOTE: the .md already EXISTS from createSession (a
    // `# <name>` stub), so the append's completion signal is the user transcript BLOCK
    // in its content, not the file's existence. Once the block has landed, a later
    // unlink cannot be resurrected by that same write, and the only remaining write in
    // the turn is the tail pair, gated by the WARDEN-1841 existence check. The delete
    // still lands ~250ms before the stubbed LLM answers, so the turn is still
    // genuinely mid-flight.
    await pollUntil(() => mdFor(c.id).includes('🧑 user'),
      { what: 'the turn-start user transcript append to land', timeout: 2000, interval: 5 });
    assert.ok(mdFor(c.id).includes('🧑 user'), 'turn-start user transcript append landed');
    await deleteSession(c.id);
    const reply = await turn;
    assert.strictEqual(reply, 'ok', 'the reply is still returned');
    assert.deepStrictEqual(filesFor(c.id), []);
    const list = await listSessions();
    assert.ok(!list.some((s) => s.id === c.id), 'no ghost in listSessions()');
  });
});
