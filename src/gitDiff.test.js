import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Tests for /api/git-diff (WARDEN-151) — the per-file diff viewer's backend.
//
// Mirrors src/read-file.test.js's isolation discipline (the WARDEN-122 pitfall):
// redirect HOME to a temp dir BEFORE importing server.js so the module-load config
// read + activity-log rotation touches nothing real, and import server.js exactly
// ONCE (top-level await). The exported helpers (getLocalGitDiff, buildGitDiffScript,
// isPathWithinCwd) are exercised directly against a throwaway git repo — no HTTP.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(__dirname, 'server.js');

// Redirect HOME so importing server.js touches only a temp dir.
process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-gd-home-'));
const { getLocalGitDiff, buildGitDiffScript, isPathWithinCwd, capDiff } = await import('./server.js');

// --- Syntax guard (same regression shape read-file.test.js pins) -------------
describe('server.js compiles', () => {
  it('passes node --check', () => {
    const r = spawnSync(process.execPath, ['--check', SERVER], { encoding: 'utf8' });
    assert.equal(r.status, 0, `server.js failed to parse:\n${r.stderr}`);
  });
});

// --- Test git repo fixture ---------------------------------------------------
// A real repo (not a mock) so git diff / ls-files behave exactly as in production.
let repo;
let repoCleanup = [];

function git(args, cwd = repo) {
  return spawnSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

before(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-gd-repo-'));
  // Local repo config only — never touches the real ~/.gitconfig.
  assert.equal(git(['init', '-q'], repo).status, 0);
  assert.equal(git(['config', 'user.email', 't@t'], repo).status, 0);
  assert.equal(git(['config', 'user.name', 't'], repo).status, 0);
  assert.equal(git(['config', 'commit.gpgsign', 'false'], repo).status, 0);

  // tracked.txt — committed, then worktree-modified (the headline case: a diff exists).
  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'line1\n');
  // clean.txt — committed, unmodified (empty-diff-but-tracked case).
  fs.writeFileSync(path.join(repo, 'clean.txt'), 'unchanged\n');
  // sub/deep.txt — committed then modified, exercises a nested path + cwd containment.
  fs.mkdirSync(path.join(repo, 'sub'));
  fs.writeFileSync(path.join(repo, 'sub', 'deep.txt'), 'a\n');
  // toDelete.txt — committed, then removed from the worktree. A deleted file has NO
  // realpath (it no longer exists), so this guards the missing-path tolerance: the
  // deletion diff must still come back (not a 403, not "untracked").
  fs.writeFileSync(path.join(repo, 'toDelete.txt'), 'gone\n');
  assert.equal(git(['add', '-A'], repo).status, 0);
  assert.equal(git(['commit', '-q', '-m', 'init'], repo).status, 0);

  // Now make the dirty state the diff viewer is built to show.
  fs.appendFileSync(path.join(repo, 'tracked.txt'), 'line2\n');
  fs.appendFileSync(path.join(repo, 'sub', 'deep.txt'), 'b\n');
  fs.unlinkSync(path.join(repo, 'toDelete.txt'));
  // untracked.txt — never added; `git diff HEAD` shows nothing for it.
  fs.writeFileSync(path.join(repo, 'untracked.txt'), 'new\n');
});

after(() => {
  repoCleanup.forEach((p) => { try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* noop */ } });
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* noop */ }
});

// --- Local diff (getLocalGitDiff) --------------------------------------------
describe('getLocalGitDiff', () => {
  it('returns a non-empty diff for a worktree-modified tracked file', () => {
    const r = getLocalGitDiff(repo, 'tracked.txt');
    assert.equal(r.error, undefined);
    assert.equal(r.untracked, false);
    assert.ok(r.diff.length > 0, 'diff should be non-empty');
    assert.match(r.diff, /\+line2/);
    assert.match(r.diff, /diff --git a\/tracked\.txt b\/tracked\.txt/);
  });

  it('returns an empty diff (not untracked) for a clean tracked file', () => {
    const r = getLocalGitDiff(repo, 'clean.txt');
    assert.equal(r.error, undefined);
    assert.equal(r.untracked, false);
    assert.equal(r.diff, '');
  });

  it('returns { untracked: true, diff: null } for an untracked file', () => {
    const r = getLocalGitDiff(repo, 'untracked.txt');
    assert.equal(r.error, undefined);
    assert.equal(r.untracked, true);
    assert.equal(r.diff, null);
  });

  it('still diffs a DELETED file (missing-path realpath tolerance)', () => {
    // toDelete.txt no longer exists on disk → realpathSync throws. The guard must
    // fall back to lexical containment so the deletion diff is reachable.
    const r = getLocalGitDiff(repo, 'toDelete.txt');
    assert.equal(r.error, undefined, `deleted file must not error: ${JSON.stringify(r)}`);
    assert.equal(r.untracked, false);
    assert.ok(r.diff.length > 0, 'deletion diff should be non-empty');
    assert.match(r.diff, /-gone/);
  });

  it('diffs a nested path under cwd (subdir containment)', () => {
    const r = getLocalGitDiff(repo, 'sub/deep.txt');
    assert.equal(r.error, undefined);
    assert.equal(r.untracked, false);
    assert.ok(r.diff.length > 0);
    assert.match(r.diff, /\+b/);
  });

  it('returns 403 on a "../" path escape', () => {
    const r = getLocalGitDiff(repo, '../escape.txt');
    assert.equal(r.status, 403);
    assert.equal(r.error, 'path must be within working directory');
  });

  it('returns 403 on a deeper "../" escape that resolves outside cwd', () => {
    const r = getLocalGitDiff(repo, 'sub/../../escape.txt');
    assert.equal(r.status, 403);
  });
});

// --- Size cap (capDiff) ------------------------------------------------------
describe('capDiff', () => {
  it('passes a small diff through unchanged', () => {
    assert.equal(capDiff('hello\n'), 'hello\n');
  });
  it('caps a string larger than 1MB down to ≤1MB', () => {
    const big = 'x'.repeat(1024 * 1024 + 5000);
    const capped = capDiff(big);
    assert.ok(Buffer.byteLength(capped) <= 1024 * 1024, 'capped output must be ≤1MB');
    assert.ok(capped.length > 0);
  });
  it('does not emit a lone surrogate when truncating multi-byte content', () => {
    // A 4-byte emoji (U+1F600) right at the cap boundary: a naive string slice could
    // split a surrogate pair. Going through Buffer.toString('utf8') drops the
    // incomplete tail instead, so no lone surrogate survives into the JSON response.
    const emoji = '😀'; // U+1F600 — surrogate pair in UTF-16, 4 bytes in UTF-8
    const big = emoji.repeat(300000); // ~1.2MB of UTF-8, well over the cap
    const capped = capDiff(big);
    assert.ok(Buffer.byteLength(capped) <= 1024 * 1024);
    // No lone (unpaired) surrogate: every high surrogate is followed by a low one.
    for (let i = 0; i < capped.length; i++) {
      const code = capped.charCodeAt(i);
      if (code >= 0xD800 && code <= 0xDBFF) {
        const next = capped.charCodeAt(i + 1);
        assert.ok(next >= 0xDC00 && next <= 0xDFFF, `lone high surrogate at ${i}`);
      }
    }
  });
});

// --- Containment helper (isPathWithinCwd) ------------------------------------
describe('isPathWithinCwd', () => {
  it('accepts a file directly under cwd', () => {
    assert.equal(isPathWithinCwd(repo, 'tracked.txt'), true);
  });
  it('accepts a nested path under cwd', () => {
    assert.equal(isPathWithinCwd(repo, 'sub/deep.txt'), true);
  });
  it('accepts a path that climbs then returns inside cwd', () => {
    // sub/../sub/deep.txt → repo/sub/deep.txt (one .. cancels one sub: still inside).
    assert.equal(isPathWithinCwd(repo, 'sub/../sub/deep.txt'), true);
  });
  it('rejects a climb that escapes cwd (two .. past one subdir)', () => {
    // sub/../../sub/deep.txt → <parent>/sub/deep.txt (above cwd) — must reject.
    assert.equal(isPathWithinCwd(repo, 'sub/../../sub/deep.txt'), false);
  });
  it('rejects a "../" escape', () => {
    assert.equal(isPathWithinCwd(repo, '../escape.txt'), false);
  });
  it('rejects an absolute path outside cwd', () => {
    assert.equal(isPathWithinCwd(repo, '/etc/hosts'), false);
  });
});

// --- Remote diff script (buildGitDiffScript) ---------------------------------
// Run the generated script under a real bash in the fixture repo, the same way
// run(host, script) executes it over SSH.
function runScript(cwd, filePath) {
  const script = buildGitDiffScript(cwd, filePath);
  const r = spawnSync('bash', ['-lc', script], { cwd, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  return { ok: r.status === 0, stdout: r.stdout || '', stderr: r.stderr || '' };
}

describe('buildGitDiffScript (remote SSH script)', () => {
  it('splices shellQuoted tokens in bare (no double-wrap)', () => {
    const script = buildGitDiffScript('/a/b', 'c.txt');
    assert.match(script, /CWD='\/a\/b';/);
    assert.doesNotMatch(script, /CWD="'\/a\/b'"/);
  });

  it('quotes paths containing spaces', () => {
    const script = buildGitDiffScript('/a/b c', 'd e.txt');
    assert.ok(script.includes("'/a/b c'"), 'cwd with space is single-quoted');
    assert.ok(script.includes("'d e.txt'"), 'file with space is single-quoted');
  });

  it('emits a diff for a modified tracked file', () => {
    const r = runScript(repo, 'tracked.txt');
    assert.equal(r.ok, true, `expected ok, stderr=${r.stderr}`);
    assert.match(r.stdout, /\+line2/);
  });

  it('diffs a deleted file over the remote path too', () => {
    const r = runScript(repo, 'toDelete.txt');
    assert.equal(r.ok, true, `expected ok, stderr=${r.stderr}`);
    assert.match(r.stdout, /-gone/);
  });

  it('blocks a "../" path escape', () => {
    const r = runScript(repo, '../escape.txt');
    assert.equal(r.ok, false);
    assert.match(r.stdout, /ERROR path must be within working directory/);
  });

  it('blocks an absolute path outside cwd', () => {
    const r = runScript(repo, '/etc/hosts');
    assert.equal(r.ok, false);
    assert.match(r.stdout, /ERROR path must be within working directory/);
  });

  it('yields empty stdout (ok) for a clean tracked file', () => {
    // The remote script runs `git diff HEAD` only; untracked disambiguation is a
    // second round-trip the route makes. So a clean file → empty stdout, exit 0.
    const r = runScript(repo, 'clean.txt');
    assert.equal(r.ok, true);
    assert.equal(r.stdout, '');
  });
});
