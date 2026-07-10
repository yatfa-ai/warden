import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

/**
 * Tests for the commit-detail (git show) feature (WARDEN-180).
 *
 * Two layers, sharing ONE file-level before() — same harness as git-log.test.js:
 *
 *  1. parseGitShowNameStatus — pure unit tests for the `--name-status` output
 *     parser, including the rename/copy two-path form ("R100\told\tnew").
 *
 *  2. /api/git-show — HTTP integration tests against the REAL Express app from
 *     src/server.js. We seed a throwaway HOME + a chats.json catalog entry whose
 *     `cwd` is a temp git repo with a known history (add → modify/add →
 *     rename/add), then resolve by bare session id so no host/tmux discovery runs.
 *     Covers the success criteria:
 *       - known hash → touched files [{path,status}] (+ rename reported as new path)
 *       - per-file diff (?path=) → non-empty patch string
 *       - non-git cwd → { files: [], diff: null, error: null } (200, NOT a 500)
 *       - valid-format unknown hash → empty files, 200
 *       - malformed hash → { files: [], error: 'invalid hash' } (200)
 *       - path traversal / absolute path= → rejected (200, error 'invalid path')
 *       - unknown id → 404
 *
 * NOTE on the single before(): src/server.js evaluates `const cfg = load()` at module
 * load, and load() reads config.js's module-level `dir` (= path.join(os.homedir(), …)).
 * So the FIRST import of server.js freezes the home dir for the whole process. We must
 * set process.env.HOME (and write config + catalog + repo) BEFORE that first import —
 * doing it once at the file level guarantees both describe blocks see the temp HOME.
 */

let parseGitShowNameStatus;
let httpServer;
let baseUrl;
let originalHome;
let tempHome;
let gitRepo;
let nonGitDir;
let headHash; // hash of the most recent commit (rename b, add c)
let addHash;  // hash of the initial commit (add a)

function git(args, cwd) {
  const r = spawnSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'inherit'] });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed (status ${r.status}) in ${cwd}`);
  return r;
}

before(async () => {
  originalHome = process.env.HOME;
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-gitshow-'));
  process.env.HOME = tempHome;

  // config.json with no SSH hosts
  const wardenDir = path.join(tempHome, '.yatfa-warden');
  fs.mkdirSync(wardenDir, { recursive: true });
  fs.writeFileSync(path.join(wardenDir, 'config.json'), JSON.stringify({ hosts: [] }));

  // Build a real git repo with a known 3-commit history so we can reference exact
  // commit hashes. Order: add a → modify a + add b → rename b + add c.
  gitRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-gitshow-repo-'));
  git(['init', '-q'], gitRepo);
  git(['config', 'user.email', 'test@example.com'], gitRepo);
  git(['config', 'user.name', 'Tester'], gitRepo);

  fs.writeFileSync(path.join(gitRepo, 'a.txt'), 'a content\n');
  git(['add', '.'], gitRepo);
  git(['commit', '-q', '-m', 'add a'], gitRepo);
  addHash = git(['rev-parse', '--short', 'HEAD'], gitRepo).stdout.toString().trim();

  fs.writeFileSync(path.join(gitRepo, 'a.txt'), 'a content\nsecond line\n');
  fs.writeFileSync(path.join(gitRepo, 'b.txt'), 'b\n');
  git(['add', '.'], gitRepo);
  git(['commit', '-q', '-m', 'modify a, add b'], gitRepo);

  git(['mv', 'b.txt', 'b_renamed.txt'], gitRepo);
  fs.writeFileSync(path.join(gitRepo, 'c.txt'), 'c1\nc2\n');
  git(['add', '.'], gitRepo);
  git(['commit', '-q', '-m', 'rename b, add c'], gitRepo);
  headHash = git(['rev-parse', '--short', 'HEAD'], gitRepo).stdout.toString().trim();

  // A plain non-git directory
  nonGitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-gitshow-nongit-'));
  fs.writeFileSync(path.join(nonGitDir, 'readme.txt'), 'not a repo\n');

  // Catalog with two LOCAL manual chats: one in the git repo, one in the non-git dir.
  // Resolved by bare session id (no ':' prefix) → no host/tmux discovery runs.
  fs.writeFileSync(
    path.join(wardenDir, 'chats.json'),
    JSON.stringify([
      { host: '(local)', session: 'warden-gitshow', cwd: gitRepo, cmd: 'bash', name: 'warden-gitshow' },
      { host: '(local)', session: 'warden-nongit', cwd: nonGitDir, cmd: 'bash', name: 'warden-nongit' },
    ]),
  );

  // Import server.js ONCE — after HOME/config/catalog are in place.
  const server = await import('./server.js');
  parseGitShowNameStatus = server.parseGitShowNameStatus;
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
  for (const d of [gitRepo, nonGitDir, tempHome]) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

describe('parseGitShowNameStatus', () => {
  it('parses add/modify/delete lines into { path, status }', () => {
    const out = parseGitShowNameStatus('A\ta.txt\nM\tsrc/b.js\nD\told/c.txt\n');
    assert.deepStrictEqual(out, [
      { status: 'A', path: 'a.txt' },
      { status: 'M', path: 'src/b.js' },
      { status: 'D', path: 'old/c.txt' },
    ]);
  });

  it('parses a rename (R<score>\\told\\tnew) into the NEW path with status R', () => {
    assert.deepStrictEqual(parseGitShowNameStatus('R100\tb.txt\tb_renamed.txt\n'), [
      { status: 'R', path: 'b_renamed.txt' },
    ]);
  });

  it('parses a copy (C<score>\\torig\\tcopy) into the copy path with status C', () => {
    assert.deepStrictEqual(parseGitShowNameStatus('C75\torig.txt\tcopy.txt\n'), [
      { status: 'C', path: 'copy.txt' },
    ]);
  });

  it('keeps a path that legitimately contains a tab-free space', () => {
    assert.deepStrictEqual(parseGitShowNameStatus('M\tmy file.txt\n'), [
      { status: 'M', path: 'my file.txt' },
    ]);
  });

  it('tolerates CRLF and blank lines (e.g. output arriving over SSH)', () => {
    assert.deepStrictEqual(parseGitShowNameStatus('\r\nA\tx.txt\r\n\r\n'), [
      { status: 'A', path: 'x.txt' },
    ]);
  });

  it('returns [] for empty / undefined input', () => {
    assert.deepStrictEqual(parseGitShowNameStatus(''), []);
    assert.deepStrictEqual(parseGitShowNameStatus(undefined), []);
  });
});

describe('/api/git-show HTTP endpoint (real Express app from server.js)', () => {
  it('returns the touched files for a known commit hash (add)', async () => {
    const res = await fetch(`${baseUrl}/api/git-show?id=warden-gitshow&hash=${addHash}`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.error, null);
    assert.ok(Array.isArray(body.files));
    assert.deepStrictEqual(body.files, [{ status: 'A', path: 'a.txt' }]);
    assert.strictEqual(body.diff, null); // no path requested → no diff
  });

  it('surfaces the new path of a renamed file end-to-end', async () => {
    const body = await (await fetch(`${baseUrl}/api/git-show?id=warden-gitshow&hash=${headHash}`)).json();
    // HEAD renamed b.txt→b_renamed.txt and added c.txt. Rename parsing itself is
    // covered by the unit tests above; here we confirm the new path surfaces. (Modern
    // git detects the rename as R100 by default → status 'R'.)
    assert.ok(body.files.some((f) => f.path === 'b_renamed.txt'), `got ${JSON.stringify(body.files)}`);
    assert.ok(body.files.some((f) => f.path === 'c.txt' && f.status === 'A'), `got ${JSON.stringify(body.files)}`);
  });

  it('returns a per-file diff when path= is given', async () => {
    const body = await (await fetch(`${baseUrl}/api/git-show?id=warden-gitshow&hash=${headHash}&path=${encodeURIComponent('c.txt')}`)).json();
    assert.strictEqual(body.error, null);
    assert.ok(typeof body.diff === 'string' && body.diff.length > 0, 'diff must be a non-empty string');
    assert.ok(body.diff.includes('+c1'), 'diff should show the added line(s)');
  });

  it('returns { files: [], diff: null, error: null } (200, not 500) for a non-git cwd', async () => {
    const res = await fetch(`${baseUrl}/api/git-show?id=warden-nongit&hash=${addHash}`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.deepStrictEqual(body.files, []);
    assert.strictEqual(body.diff, null);
    assert.strictEqual(body.error, null);
  });

  it('returns empty files (200) for a valid-format but unknown hash', async () => {
    const res = await fetch(`${baseUrl}/api/git-show?id=warden-gitshow&hash=deadbeef`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.deepStrictEqual(body.files, []);
    assert.strictEqual(body.error, null);
  });

  it('rejects a malformed (non-hex) hash with 200 + invalid hash', async () => {
    // 'g1234' starts with a non-hex char; also guards against option injection like '--version'.
    const res = await fetch(`${baseUrl}/api/git-show?id=warden-gitshow&hash=g1234`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.deepStrictEqual(body.files, []);
    assert.strictEqual(body.diff, null);
    assert.strictEqual(body.error, 'invalid hash');
  });

  it('rejects a too-short hash (fewer than 4 hex chars)', async () => {
    const res = await fetch(`${baseUrl}/api/git-show?id=warden-gitshow&hash=abc`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.error, 'invalid hash');
  });

  it('rejects a path-traversal path= param (200, never 500)', async () => {
    const res = await fetch(`${baseUrl}/api/git-show?id=warden-gitshow&hash=${addHash}&path=${encodeURIComponent('../../etc/passwd')}`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.deepStrictEqual(body.files, []);
    assert.strictEqual(body.diff, null);
    assert.strictEqual(body.error, 'invalid path');
  });

  it('rejects an absolute path= param (200, never 500)', async () => {
    const res = await fetch(`${baseUrl}/api/git-show?id=warden-gitshow&hash=${addHash}&path=${encodeURIComponent('/etc/passwd')}`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.error, 'invalid path');
  });

  it('returns 404 for an unknown chat id', async () => {
    const res = await fetch(`${baseUrl}/api/git-show?id=does-not-exist&hash=${addHash}`);
    assert.strictEqual(res.status, 404);
  });
});
