import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

/**
 * Tests for the file-blob-at-a-commit feature (WARDEN-354) — the snapshot leg
 * of the FileViewer's temporal trio (blame = per-line provenance, history =
 * commit sequence + diff, this = full file content at a commit via
 * `git show <hash>:<path>`).
 *
 * Two layers, sharing ONE file-level before() — same harness as git-show.test.js:
 *
 *  1. isBinaryBlob — pure unit tests for the content-based binary detector (a
 *     NUL byte in the decoded blob means git emitted raw, non-text bytes).
 *
 *  2. /api/git-cat-file — HTTP integration tests against the REAL Express app
 *     from src/server.js. We seed a throwaway HOME + a chats.json catalog entry
 *     whose `cwd` is a temp git repo with a known multi-commit history (add →
 *     modify + delete → add), then resolve by bare session id so no host/tmux
 *     discovery runs. Covers the success criteria:
 *       - known hash+path → the file's FULL content as it existed at that commit
 *         (temporal: a.txt differs between addHash and headHash)
 *       - deleted-at-commit path → { content: null, error: 'not found at commit' }
 *       - binary path (by extension) → { content: null, error: 'cannot read binary files' }
 *       - non-git cwd → { content: null, error: null } (200, NOT a 500)
 *       - malformed / too-short hash → { content: null, error: 'invalid hash' }
 *       - path traversal / absolute path= → rejected (200, error 'invalid path')
 *       - 1MB+ blob → { content: null, error: 'file too large (max 1MB)' }
 *       - unknown id → 404
 *
 * NOTE on the single before(): src/server.js evaluates `const cfg = load()` at module
 * load, and load() reads config.js's module-level `dir` (= path.join(os.homedir(), …)).
 * So the FIRST import of server.js freezes the home dir for the whole process. We must
 * set process.env.HOME (and write config + catalog + repo) BEFORE that first import —
 * doing it once at the file level guarantees both describe blocks see the temp HOME.
 */

let isBinaryBlob;
let httpServer;
let baseUrl;
let originalHome;
let tempHome;
let gitRepo;
let nonGitDir;
let addHash;  // hash of the initial commit (add a, b, pic.png)
let delHash;  // hash of the second commit (modify a, delete b)
let headHash; // hash of the most recent commit (add c, add big.txt)

function git(args, cwd) {
  const r = spawnSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'inherit'] });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed (status ${r.status}) in ${cwd}`);
  return r;
}

before(async () => {
  originalHome = process.env.HOME;
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-gitcatfile-'));
  process.env.HOME = tempHome;

  // config.json with no SSH hosts
  const wardenDir = path.join(tempHome, '.yatfa-warden');
  fs.mkdirSync(wardenDir, { recursive: true });
  fs.writeFileSync(path.join(wardenDir, 'config.json'), JSON.stringify({ hosts: [] }));

  // Build a real git repo with a known 3-commit history so we can reference exact
  // commit hashes. Order: add a/b/pic.png → modify a + delete b → add c + big.txt.
  gitRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-gitcatfile-repo-'));
  git(['init', '-q'], gitRepo);
  git(['config', 'user.email', 'test@example.com'], gitRepo);
  git(['config', 'user.name', 'Tester'], gitRepo);

  fs.writeFileSync(path.join(gitRepo, 'a.txt'), 'a content\n');
  fs.writeFileSync(path.join(gitRepo, 'b.txt'), 'b content\n');
  fs.writeFileSync(path.join(gitRepo, 'pic.png'), 'not really png\n');
  git(['add', '.'], gitRepo);
  git(['commit', '-q', '-m', 'add a, b, pic'], gitRepo);
  addHash = git(['rev-parse', '--short', 'HEAD'], gitRepo).stdout.toString().trim();

  fs.writeFileSync(path.join(gitRepo, 'a.txt'), 'a content\nsecond line\n');
  git(['rm', '-q', 'b.txt'], gitRepo);
  git(['add', '.'], gitRepo);
  git(['commit', '-q', '-m', 'modify a, delete b'], gitRepo);
  delHash = git(['rev-parse', '--short', 'HEAD'], gitRepo).stdout.toString().trim();

  fs.writeFileSync(path.join(gitRepo, 'c.txt'), 'c1\nc2\n');
  // A >1MB text blob so the size guard is exercisable end-to-end (cat-file -s
  // reports > GIT_DIFF_MAX_BYTES before we transfer the bytes).
  fs.writeFileSync(path.join(gitRepo, 'big.txt'), 'x'.repeat(1100000));
  git(['add', '.'], gitRepo);
  git(['commit', '-q', '-m', 'add c, add big'], gitRepo);
  headHash = git(['rev-parse', '--short', 'HEAD'], gitRepo).stdout.toString().trim();

  // A plain non-git directory
  nonGitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-gitcatfile-nongit-'));
  fs.writeFileSync(path.join(nonGitDir, 'readme.txt'), 'not a repo\n');

  // Catalog with two LOCAL manual chats: one in the git repo, one in the non-git dir.
  // Resolved by bare session id (no ':' prefix) → no host/tmux discovery runs.
  fs.writeFileSync(
    path.join(wardenDir, 'chats.json'),
    JSON.stringify([
      { host: '(local)', session: 'warden-gitcatfile', cwd: gitRepo, cmd: 'bash', name: 'warden-gitcatfile' },
      { host: '(local)', session: 'warden-nongit', cwd: nonGitDir, cmd: 'bash', name: 'warden-nongit' },
    ]),
  );

  // Import server.js ONCE — after HOME/config/catalog are in place.
  const server = await import('./server.js');
  isBinaryBlob = server.isBinaryBlob;
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

describe('isBinaryBlob', () => {
  it('returns false for empty / null / undefined input', () => {
    assert.equal(isBinaryBlob(''), false);
    assert.equal(isBinaryBlob(null), false);
    assert.equal(isBinaryBlob(undefined), false);
  });

  it('returns false for plain text (incl. multi-line and multi-byte UTF-8)', () => {
    assert.equal(isBinaryBlob('plain text'), false);
    assert.equal(isBinaryBlob('line one\nline two\n'), false);
    assert.equal(isBinaryBlob('hello 🌍 world — emoji + em dash'), false);
    // A representative source snippet has no NUL byte.
    assert.equal(isBinaryBlob('const x = require("fs");\nmodule.exports = x;\n'), false);
  });

  it('returns true when a NUL byte is present anywhere in the content', () => {
    assert.equal(isBinaryBlob('\0'), true);
    assert.equal(isBinaryBlob('text\0more'), true);
    // A NUL at the END of a long string is still detected (no leading-bytes cap).
    assert.equal(isBinaryBlob('a'.repeat(50000) + '\0'), true);
  });
});

describe('/api/git-cat-file HTTP endpoint (real Express app from server.js)', () => {
  it('returns the full file content at a known commit (initial add)', async () => {
    const res = await fetch(`${baseUrl}/api/git-cat-file?id=warden-gitcatfile&hash=${addHash}&path=${encodeURIComponent('a.txt')}`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.error, null);
    assert.strictEqual(body.content, 'a content\n');
  });

  it('returns the file content at the commit that introduced a different file', async () => {
    const body = await (await fetch(`${baseUrl}/api/git-cat-file?id=warden-gitcatfile&hash=${headHash}&path=${encodeURIComponent('c.txt')}`)).json();
    assert.strictEqual(body.error, null);
    assert.strictEqual(body.content, 'c1\nc2\n');
  });

  it('returns the HISTORICAL content (temporal: a.txt differs across commits)', async () => {
    // a.txt at addHash is the 1-line original; at headHash it gained a second line.
    const atAdd = await (await fetch(`${baseUrl}/api/git-cat-file?id=warden-gitcatfile&hash=${addHash}&path=${encodeURIComponent('a.txt')}`)).json();
    const atHead = await (await fetch(`${baseUrl}/api/git-cat-file?id=warden-gitcatfile&hash=${headHash}&path=${encodeURIComponent('a.txt')}`)).json();
    assert.strictEqual(atAdd.content, 'a content\n');
    assert.strictEqual(atHead.content, 'a content\nsecond line\n');
    assert.notStrictEqual(atAdd.content, atHead.content, 'a.txt must differ between commits');
  });

  it('returns the content for a file that existed at an earlier commit', async () => {
    // b.txt existed at addHash (deleted later) — the blob is still retrievable there.
    const body = await (await fetch(`${baseUrl}/api/git-cat-file?id=warden-gitcatfile&hash=${addHash}&path=${encodeURIComponent('b.txt')}`)).json();
    assert.strictEqual(body.error, null);
    assert.strictEqual(body.content, 'b content\n');
  });

  it('returns a clean error for a path deleted at the requested commit', async () => {
    // b.txt was deleted in delHash → it does not exist at delHash (nor at headHash).
    const res = await fetch(`${baseUrl}/api/git-cat-file?id=warden-gitcatfile&hash=${delHash}&path=${encodeURIComponent('b.txt')}`);
    assert.strictEqual(res.status, 200); // never a 500
    const body = await res.json();
    assert.strictEqual(body.content, null);
    assert.strictEqual(body.error, 'not found at commit');
  });

  it('returns a clean error for a path deleted before the requested commit', async () => {
    const body = await (await fetch(`${baseUrl}/api/git-cat-file?id=warden-gitcatfile&hash=${headHash}&path=${encodeURIComponent('b.txt')}`)).json();
    assert.strictEqual(body.content, null);
    assert.strictEqual(body.error, 'not found at commit');
  });

  it('rejects a binary path (by extension) with a clean error (200)', async () => {
    const res = await fetch(`${baseUrl}/api/git-cat-file?id=warden-gitcatfile&hash=${addHash}&path=${encodeURIComponent('pic.png')}`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.content, null);
    assert.strictEqual(body.error, 'cannot read binary files');
  });

  it('returns { content: null, error: null } (200, not 500) for a non-git cwd', async () => {
    const res = await fetch(`${baseUrl}/api/git-cat-file?id=warden-nongit&hash=${addHash}&path=${encodeURIComponent('a.txt')}`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.content, null);
    assert.strictEqual(body.error, null);
  });

  it('rejects a malformed (non-hex) hash with 200 + invalid hash', async () => {
    // 'g1234' starts with a non-hex char; also guards against option injection like '--version'.
    const res = await fetch(`${baseUrl}/api/git-cat-file?id=warden-gitcatfile&hash=g1234&path=${encodeURIComponent('a.txt')}`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.content, null);
    assert.strictEqual(body.error, 'invalid hash');
  });

  it('rejects a too-short hash (fewer than 4 hex chars)', async () => {
    const res = await fetch(`${baseUrl}/api/git-cat-file?id=warden-gitcatfile&hash=abc&path=${encodeURIComponent('a.txt')}`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.error, 'invalid hash');
  });

  it('requires a path (200 + path is required, never 500)', async () => {
    const res = await fetch(`${baseUrl}/api/git-cat-file?id=warden-gitcatfile&hash=${addHash}`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.content, null);
    assert.strictEqual(body.error, 'path is required');
  });

  it('rejects a path-traversal path= param (200, never 500)', async () => {
    const res = await fetch(`${baseUrl}/api/git-cat-file?id=warden-gitcatfile&hash=${addHash}&path=${encodeURIComponent('../../etc/passwd')}`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.content, null);
    assert.strictEqual(body.error, 'invalid path');
  });

  it('rejects an absolute path= param (200, never 500)', async () => {
    const res = await fetch(`${baseUrl}/api/git-cat-file?id=warden-gitcatfile&hash=${addHash}&path=${encodeURIComponent('/etc/passwd')}`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.error, 'invalid path');
  });

  it('returns a size error for a 1MB+ blob (200, never 500)', async () => {
    const res = await fetch(`${baseUrl}/api/git-cat-file?id=warden-gitcatfile&hash=${headHash}&path=${encodeURIComponent('big.txt')}`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.content, null);
    assert.strictEqual(body.error, 'file too large (max 1MB)');
  });

  it('returns 404 for an unknown chat id', async () => {
    const res = await fetch(`${baseUrl}/api/git-cat-file?id=does-not-exist&hash=${addHash}&path=${encodeURIComponent('a.txt')}`);
    assert.strictEqual(res.status, 404);
  });
});
