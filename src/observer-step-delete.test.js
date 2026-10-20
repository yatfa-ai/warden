import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * WARDEN-1841 — Observer.step() must not re-create a session deleted mid-turn.
 * Closing an observer tab fires DELETE /api/sessions/:id while a turn may still be in
 * flight; the step tail's create-if-missing saveMessages/appendTranscript would otherwise
 * resurrect it as a ghost named by its raw id.
 *
 * WARDEN-1878 — deleteSession itself joined the shared per-sid chain, closing the
 * residual TOCTOU the 1841 existence guard only narrows: an unordered DELETE racing a
 * create-if-missing writer is undone by it (the turn-start append re-creates the .md,
 * the tail save resurrects the .json, renameSession writes a renamed ghost). The race
 * tests below issue the DELETE inside the exact windows the unordered unlink used to
 * lose, made deterministic by delaying the in-flight syscall the delete must overtake.
 *
 * HOME is redirected BEFORE the dynamic imports (session paths are pinned at module load).
 * The LLM is stubbed via global fetch with a delayed reply so the delete lands mid-turn.
 */
describe('WARDEN-1841/1878 — a mid-turn DELETE is never resurrected by the session-file writers', () => {
  let savedHome, savedToken, savedFetch, savedAppendFile, savedRename, tempHome, sessionsDir;
  let createSession, deleteSession, listSessions, getSessionAsync, renameSession, Observer, pendingWriteCount;

  before(async () => {
    savedHome = process.env.HOME;
    savedToken = process.env.ANTHROPIC_AUTH_TOKEN;
    savedFetch = globalThis.fetch;
    savedAppendFile = fs.promises.appendFile;
    savedRename = fs.promises.rename;
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-step-delete-'));
    process.env.HOME = tempHome;
    process.env.ANTHROPIC_AUTH_TOKEN = 'test-token';
    globalThis.fetch = async () => {
      await new Promise((r) => setTimeout(r, 300));
      const body = JSON.stringify({ content: [{ type: 'text', text: 'ok' }] });
      return { ok: true, status: 200, text: async () => body };
    };
    // Widen the completion window of the turn-start transcript append (WARDEN-1878
    // race test): appends to the one {sid}.md under test sleep this long inside
    // fs.promises.appendFile, so the DELETE can be issued while that write is
    // provably still in flight — the exact interleave WARDEN-1873 had to time around.
    fs.promises.appendFile = async (file, data, options) => {
      if (mdAppendDelayMs > 0 && file === mdAppendDelayPath) {
        mdAppendEntered = true;
        await new Promise((r) => setTimeout(r, mdAppendDelayMs));
      }
      return savedAppendFile(file, data, options);
    };
    // Widen the completion window of atomic writes to the one {sid}.json under test
    // (same technique as observer-step-rename-race.test.js): the final rename syscall
    // of every such write sleeps this long, so a DELETE can be enqueued while
    // renameSession's write is demonstrably mid-flight.
    fs.promises.rename = async (from, to) => {
      if (jsonRenameDelayMs > 0 && to === jsonRenameDelayPath) {
        await new Promise((r) => setTimeout(r, jsonRenameDelayMs));
      }
      return savedRename(from, to);
    };
    ({ createSession, deleteSession, listSessions, getSessionAsync, renameSession } = await import('./sessions.js'));
    ({ pendingWriteCount } = await import('./persist.js'));
    ({ Observer } = await import('./observer.js'));
    sessionsDir = tempHome;
  });

  after(() => {
    fs.promises.appendFile = savedAppendFile;
    fs.promises.rename = savedRename;
    globalThis.fetch = savedFetch;
    if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
    if (savedToken === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN; else process.env.ANTHROPIC_AUTH_TOKEN = savedToken;
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  // Mutated per test to arm/disarm the syscall-delay windows above (see before()).
  let mdAppendDelayMs = 0, mdAppendDelayPath = null, mdAppendEntered = false;
  let jsonRenameDelayMs = 0, jsonRenameDelayPath = null;

  const sessionDir = () => path.join(tempHome, '.yatfa-warden', 'sessions');
  const mdPathFor = (id) => path.join(sessionDir(), `${id}.md`);
  const jsonPathFor = (id) => path.join(sessionDir(), `${id}.json`);

  async function waitFor(predicate, timeoutMs = 2000) {
    const start = Date.now();
    while (!(await predicate())) {
      if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
      await new Promise((r) => setTimeout(r, 2));
    }
  }

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
    for (let i = 0; i < 400 && !mdFor(c.id).includes('🧑 user'); i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    assert.ok(mdFor(c.id).includes('🧑 user'), 'turn-start user transcript append landed');
    await deleteSession(c.id);
    const reply = await turn;
    assert.strictEqual(reply, 'ok', 'the reply is still returned');
    assert.deepStrictEqual(filesFor(c.id), []);
    const list = await listSessions();
    assert.ok(!list.some((s) => s.id === c.id), 'no ghost in listSessions()');
  });

  // WARDEN-1878 window A: the DELETE is issued while the turn-start transcript
  // append is STILL IN FLIGHT — the exact interleave WARDEN-1873 had to time the
  // old fixed 50ms sleep around (and the one its existence-poll workaround dodges
  // rather than fixes). The delayed appendFile pins the append mid-syscall, so the
  // unordered delete used to unlink between the append's existence check and its
  // appendFile, and atomicAppend re-created the .md after the unlink. On the fixed
  // build the delete queues behind the turn's chain link and unlinks only after the
  // turn's tail writes have all landed.
  it('a DELETE issued during the in-flight turn-start append leaves no {id}.json/{id}.md', async () => {
    const c = await createSession('Doomed Race A');
    const obs = new Observer({ hosts: [], llm: {} }, { sid: c.id });
    mdAppendDelayPath = mdPathFor(c.id);
    mdAppendDelayMs = 150;
    mdAppendEntered = false;
    const turn = obs.step('hi');
    await waitFor(() => mdAppendEntered);
    const deleting = deleteSession(c.id); // queues behind the turn on the shared chain
    mdAppendDelayMs = 0; // only the first (user) append needs widening
    const reply = await turn;
    await deleting;
    assert.strictEqual(reply, 'ok', 'the reply is still returned');
    assert.deepStrictEqual(filesFor(c.id), [], 'the resurrecting .md is gone — the delete was not undone by the in-flight append');
    const list = await listSessions();
    assert.ok(!list.some((s) => s.id === c.id), 'no ghost in listSessions()');
  });

  // WARDEN-1878 window C, delete-last ordering: the DELETE is enqueued while
  // renameSession holds the chain mid-write, so on the fixed build it unlinks only
  // AFTER the rename's .json+.md writes have landed (whichever lands second wins
  // coherently). The unordered delete used to unlink inside rename's write window,
  // and the rename's final rename syscall re-created the .json — a renamed ghost.
  it('a DELETE enqueued behind an in-flight renameSession write leaves no renamed ghost', async () => {
    const c = await createSession('Doomed Race C');
    jsonRenameDelayPath = jsonPathFor(c.id);
    jsonRenameDelayMs = 200;
    const renaming = renameSession(c.id, 'Renamed then deleted');
    await waitFor(async () => pendingWriteCount() > 0); // rename's .json write is mid-flight
    const deleting = deleteSession(c.id); // queues behind the rename on the shared chain
    const renamed = await renaming;
    jsonRenameDelayMs = 0;
    await deleting;
    assert.ok(renamed, 'the rename completed first and returned the session');
    assert.strictEqual(await getSessionAsync(c.id), null, 'the delete won coherently — no renamed ghost survives');
    assert.deepStrictEqual(filesFor(c.id), [], 'neither the renamed .json nor the .md survives');
    const list = await listSessions();
    assert.ok(!list.some((s) => s.id === c.id), 'no renamed ghost in listSessions()');
  });

  // WARDEN-1878 window C, delete-first ordering: the rename is issued while the
  // delete holds the chain, so renameSession's UNDER-LOCK read sees null and the
  // rename writes nothing (the same discipline the WARDEN-1874 rename fix landed).
  // Without the delete on the chain this interleave was a race: a rename whose read
  // won against the unlink wrote a full renamed ghost.
  it('a renameSession enqueued behind a DELETE reads null under the chain and writes nothing', async () => {
    const c = await createSession('Doomed Race C2');
    const deleting = deleteSession(c.id);
    const renamed = renameSession(c.id, 'Ghost'); // enqueued behind the delete on the shared chain
    assert.strictEqual(await renamed, null, 'the rename reads null inside the chain and returns null');
    assert.strictEqual(await getSessionAsync(c.id), null);
    assert.deepStrictEqual(filesFor(c.id), []);
  });
});
