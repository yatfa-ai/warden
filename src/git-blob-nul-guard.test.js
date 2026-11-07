import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

// Pins the NUL-byte guard (isBinaryBlob) INSIDE /api/git-cat-file and /api/git-conflict
// (src/gitRoutes.js, createGitRouter), behind each route's extension check. Uses
// EXTENSION-LESS files so the extension check cannot answer first. Same harness as
// git-cat-file.test.js: HOME is redirected BEFORE the one-and-only import of server.js.

let httpServer, baseUrl, originalHome, tempHome, catRepo, conflictRepo, nulHash;

function git(args, cwd, allowFail = false) {
  const r = spawnSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  if (!allowFail && r.status !== 0) throw new Error(`git ${args.join(' ')} failed (status ${r.status}) in ${cwd}: ${r.stderr}`);
  return r;
}
function initRepo(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  git(['init', '-q', '-b', 'main'], dir);
  git(['config', 'user.email', 'test@example.com'], dir);
  git(['config', 'user.name', 'Tester'], dir);
  return dir;
}
const write = (dir, name, buf) => fs.writeFileSync(path.join(dir, name), buf);

before(async () => {
  originalHome = process.env.HOME;
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-gitnul-'));
  process.env.HOME = tempHome;
  const wardenDir = path.join(tempHome, '.yatfa-warden');
  fs.mkdirSync(wardenDir, { recursive: true });
  fs.writeFileSync(path.join(wardenDir, 'config.json'), JSON.stringify({ hosts: [] }));

  // cat-file repo: extension-less NUL blob + extension-less text control
  catRepo = initRepo('warden-gitnul-cat-');
  write(catRepo, 'blob', Buffer.from('head\0tail\n'));
  write(catRepo, 'notes', 'plain text, no extension\n');
  git(['add', '.'], catRepo);
  git(['commit', '-q', '-m', 'add blobs'], catRepo);
  nulHash = git(['rev-parse', '--short', 'HEAD'], catRepo).stdout.toString().trim();

  // conflict repo left mid-merge: both-bin / theirs-bin (ours text, theirs NUL) /
  // ours-bin (ours NUL, theirs text) / plain (text control)
  conflictRepo = initRepo('warden-gitnul-conflict-');
  for (const f of ['both-bin', 'theirs-bin', 'ours-bin', 'plain']) write(conflictRepo, f, 'base\n');
  git(['add', '.'], conflictRepo);
  git(['commit', '-q', '-m', 'base'], conflictRepo);
  git(['checkout', '-q', '-b', 'theirs'], conflictRepo);
  write(conflictRepo, 'both-bin', Buffer.from('theirs\0bin\n'));
  write(conflictRepo, 'theirs-bin', Buffer.from('theirs\0bin\n'));
  write(conflictRepo, 'ours-bin', 'theirs text\n');
  write(conflictRepo, 'plain', 'theirs plain\n');
  git(['add', '.'], conflictRepo);
  git(['commit', '-q', '-m', 'theirs'], conflictRepo);
  git(['checkout', '-q', 'main'], conflictRepo);
  write(conflictRepo, 'both-bin', Buffer.from('ours\0bin\n'));
  write(conflictRepo, 'theirs-bin', 'ours text\n');
  write(conflictRepo, 'ours-bin', Buffer.from('ours\0bin\n'));
  write(conflictRepo, 'plain', 'ours plain\n');
  git(['add', '.'], conflictRepo);
  git(['commit', '-q', '-m', 'ours'], conflictRepo);
  const merge = git(['merge', 'theirs'], conflictRepo, true);
  assert.notStrictEqual(merge.status, 0, 'the merge must stop on conflict');
  const st = git(['status', '--porcelain'], conflictRepo).stdout.toString();
  for (const f of ['both-bin', 'theirs-bin', 'ours-bin', 'plain']) {
    assert.match(st, new RegExp(`UU ${f}\\n`), `${f} must be a UU conflict`);
  }

  fs.writeFileSync(path.join(wardenDir, 'chats.json'), JSON.stringify([
    { host: '(local)', session: 'warden-gitnul-cat', cwd: catRepo, cmd: 'bash', name: 'warden-gitnul-cat' },
    { host: '(local)', session: 'warden-gitnul-conflict', cwd: conflictRepo, cmd: 'bash', name: 'warden-gitnul-conflict' },
  ]));

  const server = await import('./server.js');
  httpServer = server.app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => { httpServer.once('listening', resolve); httpServer.once('error', reject); });
  baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
});

after(async () => {
  if (httpServer) await new Promise((r) => httpServer.close(r));
  if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome;
  for (const d of [catRepo, conflictRepo, tempHome]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ } }
});

const getJson = async (route, params) => {
  const res = await fetch(`${baseUrl}${route}?${new URLSearchParams(params)}`);
  assert.strictEqual(res.status, 200, 'a binary refusal is a 200 with a populated error, never a 5xx');
  return res.json();
};

describe('/api/git-cat-file — NUL-byte guard behind the extension check', () => {
  it('refuses an extension-less blob whose committed bytes contain a NUL', async () => {
    const body = await getJson('/api/git-cat-file', { id: 'warden-gitnul-cat', hash: nulHash, path: 'blob' });
    assert.strictEqual(body.content, null);
    assert.strictEqual(body.error, 'cannot read binary files');
  });
  it('still returns an extension-less plain-text blob verbatim (no over-rejection)', async () => {
    const body = await getJson('/api/git-cat-file', { id: 'warden-gitnul-cat', hash: nulHash, path: 'notes' });
    assert.strictEqual(body.error, null);
    assert.strictEqual(body.content, 'plain text, no extension\n');
  });
});

describe('/api/git-conflict — NUL-byte guard behind the extension check', () => {
  it('refuses when both stage blobs are binary', async () => {
    const body = await getJson('/api/git-conflict', { id: 'warden-gitnul-conflict', path: 'both-bin' });
    assert.strictEqual(body.ours, null);
    assert.strictEqual(body.theirs, null);
    assert.strictEqual(body.path, 'both-bin');
    assert.strictEqual(body.error, 'cannot read binary files');
  });
  it('refuses when only THEIRS (stage 3, read second) is binary — the already-read text ours side is not leaked', async () => {
    const body = await getJson('/api/git-conflict', { id: 'warden-gitnul-conflict', path: 'theirs-bin' });
    assert.strictEqual(body.ours, null);
    assert.strictEqual(body.theirs, null);
    assert.strictEqual(body.error, 'cannot read binary files');
  });
  it('refuses when only OURS (stage 2, read first) is binary', async () => {
    const body = await getJson('/api/git-conflict', { id: 'warden-gitnul-conflict', path: 'ours-bin' });
    assert.strictEqual(body.ours, null);
    assert.strictEqual(body.theirs, null);
    assert.strictEqual(body.error, 'cannot read binary files');
  });
  it('still returns both sides of an extension-less text conflict (no over-rejection)', async () => {
    const body = await getJson('/api/git-conflict', { id: 'warden-gitnul-conflict', path: 'plain' });
    assert.strictEqual(body.error, null);
    assert.strictEqual(body.ours, 'ours plain\n');
    assert.strictEqual(body.theirs, 'theirs plain\n');
  });
});
