import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * End-to-end HTTP tests for /api/file-exists (WARDEN-227) — the existence probe
 * the in-terminal file linkifier calls per visible candidate.
 *
 * Boots the REAL Express app (server.app) against a temp HOME with a catalog of
 * LOCAL manual chats, then POSTs candidate paths and asserts the { exists }
 * verdict. Mirrors src/git-status.test.js's HOME-freezing isolation: server.js
 * evaluates `const cfg = load()` at module load, so config/catalog must be written
 * BEFORE the single import. Do NOT re-import server.js under a second HOME.
 *
 * Covers the LOCAL acceptance criteria through the actual route wiring:
 *   - a real file under cwd                    → exists:true
 *   - a missing file                           → exists:false (not linkified)
 *   - a path outside cwd (traversal)           → exists:false (containment guard)
 *   - a directory                              → exists:false (only files)
 *   - a binary-by-extension file              → exists:true (existence ≠ readable)
 *   - an unknown chat id                       → exists:false (probe, not a 404)
 *
 * The remote (SSH) path is exercised directly via buildFileExistsScript in
 * file-exists.test.js; driving a real SSH host here is out of scope.
 */

let httpServer;
let baseUrl;
let originalHome;
let tempHome;
let cwdDir;

before(async () => {
  originalHome = process.env.HOME;
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-fehttp-home-'));
  process.env.HOME = tempHome;

  const wardenDir = path.join(tempHome, '.yatfa-warden');
  fs.mkdirSync(wardenDir, { recursive: true });
  fs.writeFileSync(path.join(wardenDir, 'config.json'), JSON.stringify({ hosts: [] }));

  // cwd for the test chat: a real file, a subdirectory, and a binary-by-ext file.
  cwdDir = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-fehttp-cwd-'));
  fs.writeFileSync(path.join(cwdDir, 'real.txt'), 'hello\n');
  fs.mkdirSync(path.join(cwdDir, 'sub'));
  fs.writeFileSync(path.join(cwdDir, 'pic.png'), 'not really png');

  // Catalog with one LOCAL manual chat, resolved by bare session id (no ':'
  // prefix) so no host/tmux discovery runs.
  fs.writeFileSync(
    path.join(wardenDir, 'chats.json'),
    JSON.stringify([
      { host: '(local)', session: 'warden-files', cwd: cwdDir, cmd: 'bash', name: 'warden-files' },
    ]),
  );

  // Import server.js ONCE — after HOME/config/catalog are in place.
  const server = await import('./server.js');
  httpServer = server.app.listen(0, '127.0.0.1');
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
  for (const d of [cwdDir, tempHome]) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

async function probe(body) {
  const res = await fetch(`${baseUrl}/api/file-exists`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

describe('/api/file-exists (real Express app, LOCAL chat)', () => {
  it('reports exists:true for a real file under the chat cwd', async () => {
    const { status, body } = await probe({ id: 'warden-files', path: 'real.txt' });
    assert.strictEqual(status, 200);
    assert.strictEqual(body.exists, true);
  });

  it('reports exists:false for a missing file', async () => {
    const { body } = await probe({ id: 'warden-files', path: 'nope.txt' });
    assert.strictEqual(body.exists, false);
  });

  it('rejects a path outside cwd (containment guard → exists:false)', async () => {
    const { body } = await probe({ id: 'warden-files', path: '../../etc/hostname' });
    assert.strictEqual(body.exists, false);
  });

  it('rejects a directory (only regular files → exists:false)', async () => {
    const { body } = await probe({ id: 'warden-files', path: 'sub' });
    assert.strictEqual(body.exists, false);
  });

  it('reports exists:true for a binary-by-extension file (existence ≠ readable)', async () => {
    // The linkifier offers any real file; whether read-file later refuses to cat
    // a binary is a separate concern. pic.png IS a real file → exists:true.
    const { body } = await probe({ id: 'warden-files', path: 'pic.png' });
    assert.strictEqual(body.exists, true);
  });

  it('reports exists:false (not a 404) for an unknown chat id', async () => {
    // A probe collapses resolution failures to exists:false — the linkifier only
    // needs yes/no, and a 404 would complicate the caller.
    const { status, body } = await probe({ id: 'does-not-exist', path: 'real.txt' });
    assert.strictEqual(status, 200);
    assert.strictEqual(body.exists, false);
  });

  it('reports exists:false for an empty path', async () => {
    const { body } = await probe({ id: 'warden-files', path: '' });
    assert.strictEqual(body.exists, false);
  });

  it('prefix-sibling traversal is rejected (regression guard for the containment rule)', async () => {
    // The same hole read-file.test.js / file-exists.test.js pin: a sibling whose
    // name merely extends the cwd must not pass. cwd = .../<base>; request
    // ../<base>-secret.txt (a file OUTSIDE cwd).
    const base = path.basename(cwdDir);
    const sibling = `${cwdDir}-secret.txt`;
    fs.writeFileSync(sibling, 'TOPSECRET\n');
    const { body } = await probe({ id: 'warden-files', path: `../${base}-secret.txt` });
    assert.strictEqual(body.exists, false);
    fs.rmSync(sibling, { force: true });
  });
});
