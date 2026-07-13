import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * HTTP integration tests for per-agent notes (WARDEN-305).
 *
 * Notes mirror the proven /api/pins path: an id→note map persisted verbatim to
 * ~/.yatfa-warden/config.json via save(). They work for EVERY chat (including
 * un-renameable yatfa agents) because they're keyed by chat id, not identity.
 *
 * These tests pin the wire contract end-to-end against the REAL Express app from
 * src/server.js — exactly the pattern server-config.test.js uses:
 *   - GET returns the notes map (empty by default)
 *   - PUT {id, note} stores it and a subsequent GET reflects it
 *   - PUT persists to config.json (the "survives a warden restart" criterion)
 *   - PUT with a blank note deletes the key (clearing removes it)
 *   - WARDEN-89: PUT with malformed input returns 400, NEVER 500
 *   - PUT clamps an over-long note to the 200-char cap (mirrors rename/collection caps)
 */
describe('/api/agent-notes (real Express app from server.js)', () => {
  let httpServer;
  let baseUrl;
  let originalHome;
  let tempHome;
  let configPath;

  before(async () => {
    originalHome = process.env.HOME;
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-notes-'));
    process.env.HOME = tempHome;
    const wardenDir = path.join(tempHome, '.yatfa-warden');
    fs.mkdirSync(wardenDir, { recursive: true });
    configPath = path.join(wardenDir, 'config.json');
    // No agentNotes on disk — DEFAULTS merge must supply {}.
    fs.writeFileSync(configPath, JSON.stringify({ hosts: [] }));

    const { app } = await import('./server.js');
    httpServer = app.listen(0, '127.0.0.1');
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

  const put = (body) => fetch(`${baseUrl}/api/agent-notes`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  it('GET /api/agent-notes returns an empty notes map by default', async () => {
    const res = await fetch(`${baseUrl}/api/agent-notes`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.ok(body.notes, 'response must carry a notes map');
    assert.deepStrictEqual(body.notes, {});
  });

  it('PUT {id, note} stores the note so a subsequent GET returns it', async () => {
    const res = await put({ id: 'host-1:agent', note: 'debugging the auth refresh bug' });
    assert.strictEqual(res.status, 200);
    assert.strictEqual((await res.json()).ok, true);

    const after = await (await fetch(`${baseUrl}/api/agent-notes`)).json();
    assert.strictEqual(after.notes['host-1:agent'], 'debugging the auth refresh bug');
  });

  it('PUT persists the note to config.json (survives a warden restart)', async () => {
    await put({ id: 'persist:agent', note: 'long-running migration — do not kill' });
    // Read straight from disk — the "round-trips through config.json" criterion.
    const onDisk = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.strictEqual(onDisk.agentNotes?.['persist:agent'], 'long-running migration — do not kill');
  });

  it('PUT with a blank note deletes the key so a later GET no longer returns it', async () => {
    await put({ id: 'clear-me', note: 'temporary' });
    let after = await (await fetch(`${baseUrl}/api/agent-notes`)).json();
    assert.strictEqual(after.notes['clear-me'], 'temporary', 'precondition: note exists');

    // Clearing via an empty/blank note must remove the key entirely.
    const res = await put({ id: 'clear-me', note: '   ' });
    assert.strictEqual(res.status, 200);
    after = await (await fetch(`${baseUrl}/api/agent-notes`)).json();
    assert.ok(!('clear-me' in after.notes), 'key deleted, not left as an empty string');
  });

  it('PUT with a non-string note returns 400, not 500 (WARDEN-89)', async () => {
    const res = await put({ id: 'type-check', note: 12345 });
    assert.strictEqual(res.status, 400, 'malformed input is rejected, never a 500');
    // And it must not have mutated state.
    const after = await (await fetch(`${baseUrl}/api/agent-notes`)).json();
    assert.ok(!('type-check' in after.notes), 'rejected payload stored nothing');
  });

  it('PUT with a missing/empty id returns 400, not 500 (WARDEN-89)', async () => {
    const noId = await put({ note: 'orphan' });
    assert.strictEqual(noId.status, 400);
    const emptyId = await put({ id: '   ', note: 'still orphan' });
    assert.strictEqual(emptyId.status, 400);
  });

  it('PUT clamps an over-long note to the 200-char cap (mirrors rename/collection caps)', async () => {
    const longNote = 'a'.repeat(250);
    await put({ id: 'trunc:agent', note: longNote });
    const after = await (await fetch(`${baseUrl}/api/agent-notes`)).json();
    const stored = after.notes['trunc:agent'];
    assert.ok(stored, 'note was stored');
    assert.strictEqual(stored.length, 200, 'clamped to the cap, not stored at full length');
  });

  it('trims leading/trailing whitespace before storing (so a whitespace-only note clears)', async () => {
    await put({ id: 'trim:agent', note: '   padded note   ' });
    const after = await (await fetch(`${baseUrl}/api/agent-notes`)).json();
    assert.strictEqual(after.notes['trim:agent'], 'padded note');
  });
});
