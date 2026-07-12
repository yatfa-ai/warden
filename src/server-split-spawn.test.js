import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

/**
 * ＋ split spawn — empty `cmd` launches the host's login shell (WARDEN-223).
 *
 * The split button spawns a scratch shell pane derived from the focused pane.
 * When the "Default split shell" setting is blank, the frontend sends `cmd: ''`
 * and the host must launch its OWN login shell — NOT claude (the historical
 * /api/spawn default). This file pins down that the empty-cmd path is honored
 * end-to-end: the spawn succeeds (a login shell stays alive), the returned chat
 * carries `cmd: ''` (proving it wasn't defaulted to claude), and the catalog
 * stores the empty cmd verbatim so a restart reattaches rather than respawning
 * as claude.
 *
 * The omitted-cmd → claude default is preserved by distinguishing `undefined`
 * from an explicit empty string in the handler; that path isn't exercised here
 * because claude IS installed in this sandbox and would launch a real session.
 * The empty-cmd test below is the meaningful regression guard: empty string
 * must NOT become claude.
 *
 * NOTE: like server-catalog.test.js, we dynamic-import ./server.js AFTER pointing
 * HOME at a throwaway dir so the catalog file is isolated. Cleanup kills tmux
 * sessions by EXACT name (never by command-line pattern — see the worker sandbox
 * rules). node --test runs each file in its own process.
 */
describe('＋ split spawn — empty cmd launches a host login shell (WARDEN-223)', () => {
  let sameCatalogEntry;
  let httpServer, baseUrl;
  let originalHome, tempHome, catPath;
  const EMPTY_SESSION = 'w223empty';   // empty-cmd login-shell spawn
  const BASH_SESSION = 'w223bash';     // explicit-shell spawn (cmd set)

  function readCatalog() {
    try { return JSON.parse(fs.readFileSync(catPath, 'utf8')); } catch { return []; }
  }
  const json = (body) => ({
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  before(async () => {
    originalHome = process.env.HOME;
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-split-'));
    process.env.HOME = tempHome;
    const wdir = path.join(tempHome, '.yatfa-warden');
    fs.mkdirSync(wdir, { recursive: true });
    fs.writeFileSync(path.join(wdir, 'config.json'), JSON.stringify({ hosts: [] }) + '\n');
    catPath = path.join(wdir, 'chats.json');
    fs.writeFileSync(catPath, '[]\n');

    const config = await import('./config.js');
    sameCatalogEntry = config.sameCatalogEntry;
    const { app } = await import('./server.js');
    httpServer = app.listen(0, '127.0.0.1');
    await new Promise((res, rej) => {
      httpServer.once('listening', res);
      httpServer.once('error', rej);
    });
    baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
  });

  after(async () => {
    // Kill any tmux sessions these tests spawned — by EXACT session name only.
    for (const s of [EMPTY_SESSION, BASH_SESSION]) {
      spawnSync('tmux', ['kill-session', '-t', s], { stdio: 'ignore' });
    }
    if (httpServer) await new Promise((r) => httpServer.close(r));
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    try { fs.rmSync(tempHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it('an explicit empty cmd spawns a LIVE session (the host login shell), not claude', async () => {
    const res = await fetch(`${baseUrl}/api/spawn`, json({ host: '(local)', session: EMPTY_SESSION, cwd: '', cmd: '' }));
    const body = await res.json();
    assert.equal(res.status, 200, `expected 200, got ${res.status}: ${body?.error || ''}`);
    // The empty cmd stayed empty — it was NOT defaulted to claude. This is the
    // core WARDEN-223 guarantee: blank setting → no explicit shell command.
    assert.equal(body.chat.cmd, '', 'empty cmd must stay empty (not defaulted to claude)');
    assert.equal(body.chat.kind, 'tmux');
    assert.equal(body.chat.host, '(local)');
    // A 200 means hasSession passed post-spawn — the session is alive. A live
    // session from an empty command can only be tmux's default shell (the host's
    // login shell): an empty command that "failed to start" would have 500'd.
  });

  it('the catalog stores the empty cmd verbatim (reattach on restart, not respawn-as-claude)', () => {
    const entry = readCatalog().find((c) => sameCatalogEntry(c, '(local)', EMPTY_SESSION));
    assert.ok(entry, 'split shell was added to the catalog');
    assert.equal(entry.cmd, '', 'catalog stored the empty cmd (durability: a restart reattaches, never respawns as claude)');
  });

  it('an explicit shell cmd (e.g. bash) is honored end-to-end', async () => {
    const res = await fetch(`${baseUrl}/api/spawn`, json({ host: '(local)', session: BASH_SESSION, cwd: '', cmd: 'bash' }));
    const body = await res.json();
    assert.equal(res.status, 200, `expected 200, got ${res.status}: ${body?.error || ''}`);
    assert.equal(body.chat.cmd, 'bash', 'a set shell cmd flows through unchanged');
  });
});
