import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * End-to-end HTTP tests for /api/read-file — the data source the FileViewer's
 * main content fetch renders (WARDEN-561: prove the surface's data layer ALIVE,
 * not just "works in code").
 *
 * Boots the REAL Express app (server.app) against a temp HOME with a catalog of
 * one LOCAL manual chat, then POSTs `{ id, path }` and asserts BOTH the HTTP
 * status and the error string for every case the FileViewer can hit. This is the
 * LOCAL code path (`resolveLocalFile` → 1MB cap → isBinaryFile → readFileSync);
 * the REMOTE (SSH) path is exercised directly via buildReadFileScript in
 * read-file.test.js — driving a real SSH host here is out of scope (none in CI).
 *
 * Mirrors src/file-exists-http.test.js's HOME-freezing isolation: server.js
 * evaluates `const cfg = load()` at module load, so config/catalog must be
 * written BEFORE the single import. Do NOT re-import server.js under a second
 * HOME.
 *
 * Covered acceptance criteria (status + error per case):
 *   - a markdown file under cwd               → 200 + real content
 *   - a source file under cwd                 → 200 + real content
 *   - a missing file                          → 404 'file not found'
 *   - a directory                             → 400 'path is a directory'
 *   - a path outside cwd (traversal)          → 403 'path must be within working directory'
 *   - a binary-by-extension file              → 400 'cannot read binary files'
 *   - a >1MB file                             → 413 'file too large (max 1MB)'
 *   - an empty path                           → 400 'path is required'
 *   - an unknown chat id                      → 404 (resolve failure)
 *   - prefix-sibling traversal                → 403 (containment regression guard)
 */

let httpServer;
let baseUrl;
let originalHome;
let tempHome;
let cwdDir;

before(async () => {
  originalHome = process.env.HOME;
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-rfhttp-home-'));
  process.env.HOME = tempHome;

  const wardenDir = path.join(tempHome, '.yatfa-warden');
  fs.mkdirSync(wardenDir, { recursive: true });
  fs.writeFileSync(path.join(wardenDir, 'config.json'), JSON.stringify({ hosts: [] }));

  // cwd for the test chat: markdown, source, a subdir, a binary-by-ext, and a >1MB file.
  cwdDir = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-rfhttp-cwd-'));
  fs.writeFileSync(path.join(cwdDir, 'README.md'), '# Title\n\nsome **markdown** docs\n');
  fs.writeFileSync(path.join(cwdDir, 'app.ts'), 'export const x: number = 42;\n');
  fs.mkdirSync(path.join(cwdDir, 'sub'));
  fs.writeFileSync(path.join(cwdDir, 'pic.png'), 'not really png');
  // >1MB text file (size guard is stats.size > 1024*1024 = 1048576). Plain .txt so
  // the size check fires unambiguously (it runs BEFORE the binary-extension check).
  fs.writeFileSync(path.join(cwdDir, 'big.txt'), 'x'.repeat(1_300_000));

  // Catalog with one LOCAL manual chat, resolved by bare session id (no ':'
  // prefix) so no host/tmux discovery runs.
  fs.writeFileSync(
    path.join(wardenDir, 'chats.json'),
    JSON.stringify([
      { host: '(local)', session: 'warden-rf', cwd: cwdDir, cmd: 'bash', name: 'warden-rf' },
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

async function read(body) {
  const res = await fetch(`${baseUrl}/api/read-file`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

describe('/api/read-file (real Express app, LOCAL chat)', () => {
  it('returns 200 + real content for a markdown file', async () => {
    const { status, body } = await read({ id: 'warden-rf', path: 'README.md' });
    assert.strictEqual(status, 200);
    assert.ok(typeof body.content === 'string' && body.content.includes('# Title'));
    assert.strictEqual(body.error, undefined);
  });

  it('returns 200 + real content for a source file', async () => {
    const { status, body } = await read({ id: 'warden-rf', path: 'app.ts' });
    assert.strictEqual(status, 200);
    assert.ok(typeof body.content === 'string' && body.content.includes('export const x'));
    assert.strictEqual(body.error, undefined);
  });

  it('returns 404 "file not found" for a missing file', async () => {
    const { status, body } = await read({ id: 'warden-rf', path: 'nope.txt' });
    assert.strictEqual(status, 404);
    assert.strictEqual(body.error, 'file not found');
  });

  it('returns 400 "path is a directory" for a directory', async () => {
    const { status, body } = await read({ id: 'warden-rf', path: 'sub' });
    assert.strictEqual(status, 400);
    assert.strictEqual(body.error, 'path is a directory');
  });

  it('returns 403 "path must be within working directory" for traversal', async () => {
    const { status, body } = await read({ id: 'warden-rf', path: '../../etc/passwd' });
    assert.strictEqual(status, 403);
    assert.strictEqual(body.error, 'path must be within working directory');
  });

  it('returns 400 "cannot read binary files" for a binary-by-extension file', async () => {
    const { status, body } = await read({ id: 'warden-rf', path: 'pic.png' });
    assert.strictEqual(status, 400);
    assert.strictEqual(body.error, 'cannot read binary files');
  });

  it('returns 413 "file too large (max 1MB)" for a >1MB file', async () => {
    const { status, body } = await read({ id: 'warden-rf', path: 'big.txt' });
    assert.strictEqual(status, 413);
    assert.strictEqual(body.error, 'file too large (max 1MB)');
  });

  it('returns 400 "path is required" for an empty path', async () => {
    const { status, body } = await read({ id: 'warden-rf', path: '' });
    assert.strictEqual(status, 400);
    assert.strictEqual(body.error, 'path is required');
  });

  it('returns 404 for an unknown chat id', async () => {
    // resolve() fails → the handler re-returns the resolution error as a 404.
    const { status } = await read({ id: 'does-not-exist', path: 'README.md' });
    assert.strictEqual(status, 404);
  });

  it('prefix-sibling traversal is rejected (regression guard for the containment rule)', async () => {
    // The same hole read-file.test.js / file-exists-http.test.js pin: a sibling
    // whose name merely extends the cwd must not pass. cwd = .../<base>; request
    // ../<base>-secret.txt (a file OUTSIDE cwd).
    const base = path.basename(cwdDir);
    const sibling = `${cwdDir}-secret.txt`;
    fs.writeFileSync(sibling, 'TOPSECRET\n');
    const { status, body } = await read({ id: 'warden-rf', path: `../${base}-secret.txt` });
    assert.strictEqual(status, 403);
    assert.strictEqual(body.error, 'path must be within working directory');
    fs.rmSync(sibling, { force: true });
  });
});
