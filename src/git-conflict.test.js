import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

/**
 * Tests for the read-only ours-vs-theirs conflict view (WARDEN-428) — the
 * conflict-CONTENT leg that completes WARDEN-186's conflict-STATE visibility
 * (the red `!XY` badge). When an agent is stuck mid-merge, clicking a
 * conflicted file opens /api/git-conflict, which reads git's stage blobs
 * `:2:` (ours/HEAD) and `:3:` (theirs/MERGE_HEAD) — NOT `git diff --cached`.
 *
 * Mirrors git-cat-file.test.js's harness: ONE file-level before() seeds a
 * throwaway HOME + a chats.json catalog entry whose `cwd` is a temp git repo,
 * then resolves by bare session id so no host/tmux discovery runs. The repo is
 * left MID-MERGE so the index carries real conflict stages. Covers:
 *   - UU (both modified) → both sides present, ours ≠ theirs
 *   - AA (both added)    → both sides present
 *   - UD (modify/delete) → ours present, theirs null (one side absent)
 *   - >1MB stage blob     → { ours:null, theirs:null, error:'file too large (max 1MB)' }
 *   - binary path (ext)   → { ours:null, theirs:null, error:'cannot read binary files' }
 *   - both stages absent in a repo (the DD code path) → error 'no conflict content'
 *   - non-git cwd         → { ours:null, theirs:null, error:null } (200, NOT a 500)
 *   - path traversal / absolute path → 'invalid path' (200, never 500)
 *   - empty path → 'path is required'
 *   - unknown id → 404
 *
 * NOTE on the single before(): src/server.js evaluates `const cfg = load()` at module
 * load, and load() reads config.js's module-level `dir` (= path.join(os.homedir(), …)).
 * So the FIRST import of server.js freezes the home dir for the whole process. We set
 * process.env.HOME (and write config + catalog + repo) BEFORE that first import —
 * doing it once at the file level guarantees the whole process sees the temp HOME.
 */

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

// Run git allowing a non-zero exit (the conflict merge exits 1). Used only for the
// `git merge` that is EXPECTED to stop on conflict; every other git call uses `git()`.
function gitAllowFail(args, cwd) {
  return spawnSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'inherit'] });
}

before(async () => {
  originalHome = process.env.HOME;
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-gitconflict-'));
  process.env.HOME = tempHome;

  // config.json with no SSH hosts
  const wardenDir = path.join(tempHome, '.yatfa-warden');
  fs.mkdirSync(wardenDir, { recursive: true });
  fs.writeFileSync(path.join(wardenDir, 'config.json'), JSON.stringify({ hosts: [] }));

  // Build a real git repo and leave it MID-MERGE so the index carries conflict
  // stages. `git init -b main` so the default branch is predictably `main`.
  gitRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-gitconflict-repo-'));
  git(['init', '-q', '-b', 'main'], gitRepo);
  git(['config', 'user.email', 'test@example.com'], gitRepo);
  git(['config', 'user.name', 'Tester'], gitRepo);

  // Base commit (the common ancestor both sides diverge from):
  //   conflict.txt → UU (both modified differently)
  //   moddel.txt   → UD  (ours modifies, theirs deletes → one side absent)
  //   added.txt    → AA  (both add, not in base)
  //   big.txt      → UU  with a >1MB stage blob (exercises the size guard)
  //   keep.txt     → untouched (no stage blobs → both-absent-in-repo / DD path)
  //   pic.png      → untouched (binary-by-extension guard, before any git call)
  fs.writeFileSync(path.join(gitRepo, 'conflict.txt'), 'base line\n');
  fs.writeFileSync(path.join(gitRepo, 'moddel.txt'), 'original\n');
  fs.writeFileSync(path.join(gitRepo, 'keep.txt'), 'unchanged\n');
  fs.writeFileSync(path.join(gitRepo, 'pic.png'), 'not really png\n');
  fs.writeFileSync(path.join(gitRepo, 'big.txt'), 'x'.repeat(1100000));
  git(['add', '.'], gitRepo);
  git(['commit', '-q', '-m', 'base'], gitRepo);

  // theirs branch: modify conflict.txt, delete moddel.txt, add added.txt, grow big.txt.
  git(['checkout', '-q', '-b', 'theirs'], gitRepo);
  fs.writeFileSync(path.join(gitRepo, 'conflict.txt'), 'theirs line\n');
  git(['rm', '-q', 'moddel.txt'], gitRepo);
  fs.writeFileSync(path.join(gitRepo, 'added.txt'), 'theirs added\n');
  fs.writeFileSync(path.join(gitRepo, 'big.txt'), `${'x'.repeat(1100000)}theirs\n`);
  git(['add', '.'], gitRepo);
  git(['commit', '-q', '-m', 'theirs'], gitRepo);

  // ours (main): modify conflict.txt differently, modify moddel.txt, add added.txt
  // differently, grow big.txt differently. Divergence from theirs → conflicts.
  git(['checkout', '-q', 'main'], gitRepo);
  fs.writeFileSync(path.join(gitRepo, 'conflict.txt'), 'ours line\n');
  fs.writeFileSync(path.join(gitRepo, 'moddel.txt'), 'ours modified\n');
  fs.writeFileSync(path.join(gitRepo, 'added.txt'), 'ours added\n');
  fs.writeFileSync(path.join(gitRepo, 'big.txt'), `${'x'.repeat(1100000)}ours\n`);
  git(['add', '.'], gitRepo);
  git(['commit', '-q', '-m', 'ours'], gitRepo);

  // Merge theirs into main — stops on conflict (exit 1). The repo is now mid-merge
  // with stages 1/2/3 populated for the conflicted paths. We do NOT resolve them.
  const merge = gitAllowFail(['merge', 'theirs'], gitRepo);
  if (merge.status === 0) throw new Error('expected the merge to stop on conflict, but it succeeded');
  // Sanity: confirm the porcelain shows the conflict codes we built the cases around.
  const st = git(['status', '--porcelain'], gitRepo).stdout.toString();
  assert.match(st, /UU conflict\.txt/, 'conflict.txt must be a UU conflict');
  assert.match(st, /UD moddel\.txt/, 'moddel.txt must be a modify/delete (UD) conflict');
  assert.match(st, /AA added\.txt/, 'added.txt must be an add/add (AA) conflict');

  // A plain non-git directory
  nonGitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-gitconflict-nongit-'));
  fs.writeFileSync(path.join(nonGitDir, 'readme.txt'), 'not a repo\n');

  // Catalog with two LOCAL manual chats: one in the conflicted repo, one non-git.
  // Resolved by bare session id (no ':' prefix) → no host/tmux discovery runs.
  fs.writeFileSync(
    path.join(wardenDir, 'chats.json'),
    JSON.stringify([
      { host: '(local)', session: 'warden-gitconflict', cwd: gitRepo, cmd: 'bash', name: 'warden-gitconflict' },
      { host: '(local)', session: 'warden-nongit', cwd: nonGitDir, cmd: 'bash', name: 'warden-nongit' },
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
  for (const d of [gitRepo, nonGitDir, tempHome]) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

describe('/api/git-conflict HTTP endpoint (real Express app from server.js)', () => {
  it('returns ours and theirs for a UU (both-modified) conflict', async () => {
    const res = await fetch(`${baseUrl}/api/git-conflict?id=warden-gitconflict&path=${encodeURIComponent('conflict.txt')}`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.error, null);
    assert.strictEqual(body.path, 'conflict.txt');
    assert.strictEqual(body.ours, 'ours line\n');
    assert.strictEqual(body.theirs, 'theirs line\n');
    assert.notStrictEqual(body.ours, body.theirs, 'ours and theirs must differ for a real conflict');
  });

  it('returns ours and theirs for an AA (both-added) conflict', async () => {
    const body = await (await fetch(`${baseUrl}/api/git-conflict?id=warden-gitconflict&path=${encodeURIComponent('added.txt')}`)).json();
    assert.strictEqual(body.error, null);
    assert.strictEqual(body.ours, 'ours added\n');
    assert.strictEqual(body.theirs, 'theirs added\n');
  });

  it('returns ours present and theirs null for a modify/delete (UD) conflict — one side absent', async () => {
    // moddel.txt: ours modified it, theirs deleted it → stage :2: present, :3: absent.
    const res = await fetch(`${baseUrl}/api/git-conflict?id=warden-gitconflict&path=${encodeURIComponent('moddel.txt')}`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.error, null);
    assert.strictEqual(body.ours, 'ours modified\n');
    assert.strictEqual(body.theirs, null);
  });

  it('returns a size error for a >1MB stage blob (200, never 500)', async () => {
    // big.txt is a UU conflict whose stage blobs exceed GIT_DIFF_MAX_BYTES (1 MiB).
    const res = await fetch(`${baseUrl}/api/git-conflict?id=warden-gitconflict&path=${encodeURIComponent('big.txt')}`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.ours, null);
    assert.strictEqual(body.theirs, null);
    assert.strictEqual(body.error, 'file too large (max 1MB)');
  });

  it('rejects a binary path (by extension) with a clean error (200)', async () => {
    const res = await fetch(`${baseUrl}/api/git-conflict?id=warden-gitconflict&path=${encodeURIComponent('pic.png')}`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.ours, null);
    assert.strictEqual(body.theirs, null);
    assert.strictEqual(body.error, 'cannot read binary files');
  });

  it('returns a clean "no conflict content" error when both stages are absent in a real repo (the DD code path)', async () => {
    // keep.txt is tracked but NOT conflicted → neither :2: nor :3: exists. This is
    // the same code path as a both-deleted (DD) conflict: both stage blobs absent
    // inside a real repo → rev-parse probe says repo → a helpful error (NOT the
    // null-error soft-fail a non-git cwd produces).
    const res = await fetch(`${baseUrl}/api/git-conflict?id=warden-gitconflict&path=${encodeURIComponent('keep.txt')}`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.ours, null);
    assert.strictEqual(body.theirs, null);
    assert.strictEqual(body.error, 'no conflict content');
  });

  it('returns { ours:null, theirs:null, error:null } (200, not 500) for a non-git cwd', async () => {
    const res = await fetch(`${baseUrl}/api/git-conflict?id=warden-nongit&path=${encodeURIComponent('conflict.txt')}`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.ours, null);
    assert.strictEqual(body.theirs, null);
    assert.strictEqual(body.error, null);
  });

  it('requires a path (200 + path is required, never 500)', async () => {
    const res = await fetch(`${baseUrl}/api/git-conflict?id=warden-gitconflict`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.ours, null);
    assert.strictEqual(body.theirs, null);
    assert.strictEqual(body.error, 'path is required');
  });

  it('rejects a path-traversal path= param (200, never 500)', async () => {
    const res = await fetch(`${baseUrl}/api/git-conflict?id=warden-gitconflict&path=${encodeURIComponent('../../etc/passwd')}`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.ours, null);
    assert.strictEqual(body.theirs, null);
    assert.strictEqual(body.error, 'invalid path');
  });

  it('rejects an absolute path= param (200, never 500)', async () => {
    const res = await fetch(`${baseUrl}/api/git-conflict?id=warden-gitconflict&path=${encodeURIComponent('/etc/passwd')}`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.error, 'invalid path');
  });

  it('returns 404 for an unknown chat id', async () => {
    const res = await fetch(`${baseUrl}/api/git-conflict?id=does-not-exist&path=${encodeURIComponent('conflict.txt')}`);
    assert.strictEqual(res.status, 404);
  });
});
