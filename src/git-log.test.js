import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

/**
 * Tests for the recent-commit-history (git log) feature (WARDEN-122).
 *
 * Two layers, sharing ONE file-level before():
 *
 *  1. parseGitLogLine — pure unit tests for the `%h|%s|%an|%ar` line parser. The
 *     separator is '|' which is also legal inside a commit subject ("merge a | b"),
 *     so this is the trickiest logic and where bugs hide. Covers: normal line,
 *     pipe-in-subject, multiple pipes in subject, empty subject, missing author/date.
 *
 *  2. /api/git-log — HTTP integration tests against the REAL Express app from
 *     src/server.js. We seed a throwaway HOME + a chats.json catalog entry whose
 *     `cwd` is a temp git repo (with one subject containing a '|'), and resolve it
 *     by bare session id so no host/tmux discovery runs. Covers the success criteria:
 *       - local git repo → parsed commits [{hash, subject, author, date}]
 *       - non-git cwd → { commits: [], error: null } (200, NOT a 500)
 *       - limit clamped to [1, 50] (limit=999 and limit=abc both behave)
 *       - unknown id → 404
 *
 * NOTE on the single before(): src/server.js evaluates `const cfg = load()` at module
 * load, and load() reads config.js's module-level `dir` (= path.join(os.homedir(), …)).
 * So the FIRST import of server.js freezes the home dir for the whole process. We must
 * set process.env.HOME (and write config + catalog + repo) BEFORE that first import —
 * doing it once at the file level guarantees both describe blocks see the temp HOME.
 */

// The three commits in gitRepo (newest first when listed). The middle one has a
// literal '|' in its subject to exercise the parser end-to-end over the wire.
const SUBJECTS = ['third commit', 'fix: handle the | pipe in subject', 'first commit'];

let parseGitLogLine;
let httpServer;
let baseUrl;
let originalHome;
let tempHome;
let gitRepo;
let nonGitDir;

function git(args, cwd) {
  const r = spawnSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'inherit'] });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed (status ${r.status}) in ${cwd}`);
  return r;
}

before(async () => {
  originalHome = process.env.HOME;
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-gitlog-'));
  process.env.HOME = tempHome;

  // config.json with no SSH hosts
  const wardenDir = path.join(tempHome, '.yatfa-warden');
  fs.mkdirSync(wardenDir, { recursive: true });
  fs.writeFileSync(path.join(wardenDir, 'config.json'), JSON.stringify({ hosts: [] }));

  // Build a real git repo with 3 commits (oldest first so SUBJECTS order == newest-first)
  gitRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-gitlog-repo-'));
  git(['init', '-q'], gitRepo);
  git(['config', 'user.email', 'test@example.com'], gitRepo);
  git(['config', 'user.name', 'Tester'], gitRepo);
  SUBJECTS.slice().reverse().forEach((subject, i) => {
    fs.writeFileSync(path.join(gitRepo, `f${i}.txt`), `${i}\n`);
    git(['add', '.'], gitRepo);
    git(['commit', '-q', '-m', subject], gitRepo);
  });

  // A plain non-git directory
  nonGitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-gitlog-nongit-'));
  fs.writeFileSync(path.join(nonGitDir, 'readme.txt'), 'not a repo\n');

  // Catalog with two LOCAL manual chats: one in the git repo, one in the non-git dir.
  // Resolved by bare session id (no ':' prefix) → no host/tmux discovery runs.
  fs.writeFileSync(
    path.join(wardenDir, 'chats.json'),
    JSON.stringify([
      { host: '(local)', session: 'warden-gitlog', cwd: gitRepo, cmd: 'bash', name: 'warden-gitlog' },
      { host: '(local)', session: 'warden-nongit', cwd: nonGitDir, cmd: 'bash', name: 'warden-nongit' },
    ]),
  );

  // Import server.js ONCE — after HOME/config/catalog are in place.
  const server = await import('./server.js');
  parseGitLogLine = server.parseGitLogLine;
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

describe('parseGitLogLine', () => {
  it('parses a normal %h|%s|%an|%ar line', () => {
    assert.deepStrictEqual(parseGitLogLine('abc1234|fix: thing|John Doe|2 days ago'), {
      hash: 'abc1234', subject: 'fix: thing', author: 'John Doe', date: '2 days ago',
    });
  });

  it('keeps a literal "|" inside the subject', () => {
    const out = parseGitLogLine('def5678|fix: handle a | b in subject|Jane|3 hours ago');
    assert.strictEqual(out.hash, 'def5678');
    assert.strictEqual(out.subject, 'fix: handle a | b in subject');
    assert.strictEqual(out.author, 'Jane');
    assert.strictEqual(out.date, '3 hours ago');
  });

  it('handles multiple "|" inside the subject', () => {
    const out = parseGitLogLine('bbb2222|merge feat | fix | docs|Sam|5 minutes ago');
    assert.strictEqual(out.subject, 'merge feat | fix | docs');
    assert.strictEqual(out.author, 'Sam');
    assert.strictEqual(out.date, '5 minutes ago');
  });

  it('handles an empty subject (%s is empty)', () => {
    assert.deepStrictEqual(parseGitLogLine('aaa1111||Bob|1 day ago'), {
      hash: 'aaa1111', subject: '', author: 'Bob', date: '1 day ago',
    });
  });

  it('handles a malformed line with no author/date separators', () => {
    assert.deepStrictEqual(parseGitLogLine('xyz9999|just a subject no author/date'), {
      hash: 'xyz9999', subject: 'just a subject no author/date', author: '', date: '',
    });
  });

  it('handles a line with no separators at all', () => {
    assert.deepStrictEqual(parseGitLogLine('lonelyhash'), {
      hash: 'lonelyhash', subject: '', author: '', date: '',
    });
  });
});

describe('/api/git-log HTTP endpoint (real Express app from server.js)', () => {
  it('returns parsed commits for a local git repo (newest first)', async () => {
    const res = await fetch(`${baseUrl}/api/git-log?id=warden-gitlog`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.error, null);
    assert.ok(Array.isArray(body.commits));
    assert.strictEqual(body.commits.length, 3);
    assert.strictEqual(body.commits[0].subject, 'third commit');
    assert.strictEqual(body.commits[2].subject, 'first commit');
    for (const c of body.commits) {
      assert.match(c.hash, /^[0-9a-f]{4,}$/);
      assert.ok(typeof c.date === 'string' && c.date.length > 0, 'relative date must be non-empty');
      assert.strictEqual(c.author, 'Tester');
    }
  });

  it('preserves a literal "|" inside a commit subject over the wire', async () => {
    const body = await (await fetch(`${baseUrl}/api/git-log?id=warden-gitlog`)).json();
    const pipeCommit = body.commits.find((c) => c.subject.includes('|'));
    assert.ok(pipeCommit, 'expected a commit whose subject contains "|"');
    assert.strictEqual(pipeCommit.subject, 'fix: handle the | pipe in subject');
    assert.strictEqual(pipeCommit.author, 'Tester');
  });

  it('honors limit (returns only the N newest)', async () => {
    const body = await (await fetch(`${baseUrl}/api/git-log?id=warden-gitlog&limit=1`)).json();
    assert.strictEqual(body.commits.length, 1);
    assert.strictEqual(body.commits[0].subject, 'third commit');
  });

  it('clamps an oversized limit to 50 and returns all available commits', async () => {
    const body = await (await fetch(`${baseUrl}/api/git-log?id=warden-gitlog&limit=999`)).json();
    assert.strictEqual(body.commits.length, 3); // repo only has 3, no error
  });

  it('falls back to the default limit on a non-numeric limit', async () => {
    const body = await (await fetch(`${baseUrl}/api/git-log?id=warden-gitlog&limit=abc`)).json();
    assert.strictEqual(body.commits.length, 3);
  });

  it('returns { commits: [], error: null } (200, not 500) for a non-git cwd', async () => {
    const res = await fetch(`${baseUrl}/api/git-log?id=warden-nongit`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.deepStrictEqual(body.commits, []);
    assert.strictEqual(body.error, null);
  });

  it('returns 404 for an unknown chat id', async () => {
    const res = await fetch(`${baseUrl}/api/git-log?id=does-not-exist`);
    assert.strictEqual(res.status, 404);
  });
});
