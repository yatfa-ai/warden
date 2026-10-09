import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * WARDEN-1681 — Observer.step() must not write back the connect-time session name.
 * A PATCH /api/sessions/:id rename while the websocket/Observer stays open must
 * survive the next completed turn.
 *
 * Session paths are pinned from os.homedir() at module load, so HOME is redirected
 * BEFORE the dynamic imports. The LLM is stubbed via global fetch.
 */
describe('WARDEN-1681 — Observer.step() preserves a rename made after connect', () => {
  let savedHome, savedToken, savedFetch, tempHome, createSession, renameSession, getSessionAsync, Observer;

  before(async () => {
    savedHome = process.env.HOME;
    savedToken = process.env.ANTHROPIC_AUTH_TOKEN;
    savedFetch = globalThis.fetch;
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-step-rename-'));
    process.env.HOME = tempHome;
    process.env.ANTHROPIC_AUTH_TOKEN = 'test-token';
    globalThis.fetch = async () => {
      const body = JSON.stringify({ content: [{ type: 'text', text: 'ok' }] });
      return { ok: true, status: 200, text: async () => body };
    };
    ({ createSession, renameSession, getSessionAsync } = await import('./sessions.js'));
    ({ Observer } = await import('./observer.js'));
  });

  after(() => {
    globalThis.fetch = savedFetch;
    if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
    if (savedToken === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN; else process.env.ANTHROPIC_AUTH_TOKEN = savedToken;
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it('keeps the renamed name on disk after a completed turn', async () => {
    const c = await createSession('Original');
    const obs = new Observer({ hosts: [], llm: {} }, { sid: c.id });
    await renameSession(c.id, 'Renamed by user');
    await obs.step('hi');
    const s = await getSessionAsync(c.id);
    assert.strictEqual(s.name, 'Renamed by user');
    assert.strictEqual(s.messages.length, 2);
  });

  it('leaves the name unchanged after a turn when no rename happened', async () => {
    const c = await createSession('Untouched');
    const obs = new Observer({ hosts: [], llm: {} }, { sid: c.id });
    await obs.step('hi');
    const s = await getSessionAsync(c.id);
    assert.strictEqual(s.name, 'Untouched');
    assert.strictEqual(s.messages.length, 2);
  });
});
