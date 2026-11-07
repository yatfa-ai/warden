import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * server.js resolve() — ambiguous-id re-shape (WARDEN-2177).
 *
 * resolve(id) wraps resolveChatWithRefresh and turns chats.js's prose error
 *   ambiguous "<id>" matches: a, b
 * into `{ error: 'ambiguous', matches: ['a', 'b'] }`; routes answer 404 with that
 * object. chats.test.js pins the string producer; route-level suites inject a fake
 * `resolve`. This file runs the REAL app so the server.js re-shape is asserted.
 *
 * HOME is redirected to a throwaway dir BEFORE the dynamic import of server.js
 * (config paths are computed from os.homedir() at module load).
 */
describe('server.js resolve() ambiguous-id re-shape (WARDEN-2177)', () => {
  let httpServer, baseUrl, originalHome, tempHome, catPath;

  const seedCatalog = (entries) =>
    fs.writeFileSync(catPath, JSON.stringify(entries, null, 2) + '\n');
  const chat = (host, session) => ({
    kind: 'tmux', host, session, name: session, cwd: '/tmp', cmd: 'claude',
  });

  before(async () => {
    originalHome = process.env.HOME;
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-ambig-'));
    process.env.HOME = tempHome;
    const wdir = path.join(tempHome, '.yatfa-warden');
    fs.mkdirSync(wdir, { recursive: true });
    fs.writeFileSync(path.join(wdir, 'config.json'), JSON.stringify({ hosts: [] }) + '\n');
    catPath = path.join(wdir, 'chats.json');
    seedCatalog([]);

    const { app } = await import('./server.js');
    httpServer = app.listen(0, '127.0.0.1');
    await new Promise((res, rej) => {
      httpServer.once('listening', res);
      httpServer.once('error', rej);
    });
    baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
  });

  after(async () => {
    if (httpServer) await new Promise((res) => httpServer.close(res));
    process.env.HOME = originalHome;
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it('answers 404 { error: "ambiguous", matches: [ids] } when a bare session exists on two hosts', async () => {
    seedCatalog([chat('host-a', 'ambigsess'), chat('host-b', 'ambigsess')]);
    const res = await fetch(`${baseUrl}/api/pane?id=ambigsess`);
    assert.strictEqual(res.status, 404);
    const body = await res.json();
    assert.strictEqual(body.error, 'ambiguous');
    assert.deepStrictEqual([...body.matches].sort(), ['host-a:ambigsess', 'host-b:ambigsess']);
  });

  it('control: the host-qualified unique id passes the ambiguity branch', async () => {
    seedCatalog([chat('host-a', 'ambigsess'), chat('host-b', 'ambigsess')]);
    const res = await fetch(`${baseUrl}/api/pane?id=host-a:ambigsess`);
    // Resolution succeeded, so the route went on to read the pane (which may
    // fail with 500 here — no real host); it must NOT be the resolve 404.
    const body = await res.json();
    assert.notStrictEqual(body.error, 'ambiguous');
    assert.ok(!/^no chat matches/.test(String(body.error || '')), `unexpected: ${JSON.stringify(body)}`);
  });

  it('a non-ambiguous miss keeps the prose "no chat matches" error and carries no matches key', async () => {
    seedCatalog([]);
    const res = await fetch(`${baseUrl}/api/pane?id=nothere`);
    assert.strictEqual(res.status, 404);
    const body = await res.json();
    assert.match(body.error, /^no chat matches "nothere"/);
    assert.ok(!('matches' in body));
  });
});
