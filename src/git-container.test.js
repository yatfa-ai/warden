import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

/**
 * Locks the WARDEN-235 invariant the reviewer flagged as untested: a container
 * (yatfa) chat must resolve git against its OWN in-container repo — NEVER Warden's
 * process.cwd(). Two layers are exercised:
 *
 * 1. gitCwd (pure, exported from server.js) — the leaf guard. The dangerous input
 *    {container, host:LOCAL, cwd:undefined} must yield '' (→ the route's graceful
 *    `error: 'no cwd'`), NOT process.cwd(). A future refactor that "simplifies"
 *    gitCwd back to `chat.cwd || (host===LOCAL ? process.cwd() : '')` goes RED here
 *    — the exact regression this ticket exists to prevent (reviewer's blocker).
 *
 * 2. runGit (transport, exported from server.js) — proves a container chat is
 *    ROUTED through `docker exec <c> git -C <cwd>` and returns the CONTAINER's own
 *    repo state. CI can't run real docker, so a fake `docker` is installed on PATH:
 *    it rewrites the exec into `git -C <hostdir>` against a real host-side temp repo
 *    whose branch name + dirty file exist NOWHERE in Warden's own repo. runGit
 *    returning them PROVES the local-container branch did not fall back to the host
 *    fs / process.cwd() — closing the "nothing proves runGit routes container chats
 *    there" gap (the reviewer's "even better" bar).
 *
 * Why a function-level runGit test and not an HTTP /api/git-status test: container
 * chats only enter the system through REMOTE docker discovery (src/chats.js
 * discoverHost treats LOCAL as catalog-only — toCatalogChat forces container:null),
 * so driving one through resolve() would require faking SSH, not docker. runGit is
 * the exact seam the route calls; testing it directly with a stubbed docker proves
 * the routing claim with zero discovery/SSH machinery (and is deterministic, not
 * flaky). The route's `!cwd → error:'no cwd'` guard is already covered end-to-end by
 * src/git-status.test.js's warden-nongit case (same code path).
 *
 * HOME is frozen before the single server.js import (config.json hosts:[]), mirroring
 * the src/git-status.test.js isolation pattern — server.js evaluates `load()` at
 * module load.
 */

const LOCAL = '(local)';

let originalHome;
let originalPath;
let originalContainer;
let originalHostdir;
let tempHome;
let containerRepo;      // host-side repo the fake container resolves to
let fakeBinDir;         // holds the fake `docker` executable, prepended to PATH
let gitCwd;
let runGit;

function git(args, cwd) {
  const r = spawnSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'inherit'] });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed (status ${r.status}) in ${cwd}`);
  return r;
}

// Fake `docker` (bash, not node, so there's no ESM/CJS module-type ambiguity under
// the shebang). It rewrites `docker exec <container> git -C <cwd> <args>` into
// `git -C $WARDEN_FAKE_HOSTDIR <args>` — i.e. it runs REAL git against a REAL host
// repo, so the full parse pipeline sees genuine output. The script deliberately
// uses `$var` (never `${var}`) so it embeds cleanly in a JS template literal (which
// only interpolates `${...}`). Single container mapping via two env vars because
// container names contain '-' (illegal in env-var names), which rules out a
// per-container env-var scheme.
const FAKE_DOCKER = `#!/usr/bin/env bash
# Fake docker for WARDEN-235 container-transport tests (no real docker in CI).
[ "$1" = "exec" ] || exit 0
if [ "$2" != "$WARDEN_FAKE_CONTAINER" ]; then
  echo "fake-docker: unknown container '$2'" >&2
  exit 127
fi
shift 2
case "$1" in
  git)
    shift
    [ "$1" = "-C" ] && shift 2   # drop the in-container -C <cwd>; host dir wins
    exec git -C "$WARDEN_FAKE_HOSTDIR" "$@"
    ;;
  bash)
    shift
    [ "$1" = "-lc" ] && shift
    exec bash -lc "$1"
    ;;
esac
exit 0
`;

before(async () => {
  originalHome = process.env.HOME;
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-gitcontainer-'));
  process.env.HOME = tempHome;

  const wardenDir = path.join(tempHome, '.yatfa-warden');
  fs.mkdirSync(wardenDir, { recursive: true });
  fs.writeFileSync(path.join(wardenDir, 'config.json'), JSON.stringify({ hosts: [] }));

  // A host-side repo the fake container resolves to. Its branch name + dirty file
  // are UNIQUE and exist nowhere in Warden's own repo, so a runGit result matching
  // either PROVES the container repo (not process.cwd()) was read.
  containerRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-gitcontainer-repo-'));
  git(['init', '-q', '-b', 'yatfa-agent-branch'], containerRepo);
  git(['config', 'user.email', 'test@example.com'], containerRepo);
  git(['config', 'user.name', 'Tester'], containerRepo);
  fs.writeFileSync(path.join(containerRepo, 'baseline.txt'), 'baseline\n');
  git(['add', '.'], containerRepo);
  git(['commit', '-q', '-m', 'init'], containerRepo);
  // Untracked file → surfaces in `git status --porcelain` as `?? agent-dirty.txt`.
  fs.writeFileSync(path.join(containerRepo, 'agent-dirty.txt'), 'uncommitted\n');

  // Install the fake docker on PATH.
  fakeBinDir = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-gitcontainer-bin-'));
  const dockerPath = path.join(fakeBinDir, 'docker');
  fs.writeFileSync(dockerPath, FAKE_DOCKER, { mode: 0o755 });
  fs.chmodSync(dockerPath, 0o755);
  originalContainer = process.env.WARDEN_FAKE_CONTAINER;
  originalHostdir = process.env.WARDEN_FAKE_HOSTDIR;
  process.env.WARDEN_FAKE_CONTAINER = 'yatfa-test';
  process.env.WARDEN_FAKE_HOSTDIR = containerRepo;
  originalPath = process.env.PATH;
  process.env.PATH = `${fakeBinDir}:${process.env.PATH}`;

  const server = await import('./server.js');
  gitCwd = server.gitCwd;
  runGit = server.runGit;
});

after(async () => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  if (originalContainer === undefined) delete process.env.WARDEN_FAKE_CONTAINER;
  else process.env.WARDEN_FAKE_CONTAINER = originalContainer;
  if (originalHostdir === undefined) delete process.env.WARDEN_FAKE_HOSTDIR;
  else process.env.WARDEN_FAKE_HOSTDIR = originalHostdir;
  for (const d of [containerRepo, fakeBinDir, tempHome]) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

// The misleading-local bug this ticket fixes — the reviewer's blocker. gitCwd IS
// the whole fix; these drive the dangerous inputs through it so removing the
// container guard goes RED instead of silently resurrecting the bug.
describe('gitCwd — the container-vs-host guard (WARDEN-235)', () => {
  it('returns "" for a LOCAL container chat with no derivable cwd (NOT process.cwd())', () => {
    // The core invariant: a LOCAL yatfa agent whose cwd derivation failed must NOT
    // fall back to Warden's own repo. '' → the route emits graceful `error:'no cwd'`
    // (better no badge than a wrong one).
    assert.strictEqual(gitCwd({ container: 'yatfa-test', host: LOCAL, cwd: undefined }), '');
    // cwd entirely absent (same as undefined) — container guard still wins.
    assert.strictEqual(gitCwd({ container: 'yatfa-test', host: LOCAL }), '');
  });

  it('returns the in-container cwd when derivation succeeded', () => {
    assert.strictEqual(gitCwd({ container: 'yatfa-test', host: LOCAL, cwd: '/workspace' }), '/workspace');
    assert.strictEqual(gitCwd({ container: 'yatfa-test', host: 'ssh-host', cwd: '/app' }), '/app');
  });

  it('keeps the host-fs fallback for non-container (manual/tmux) LOCAL chats', () => {
    // Regression guard: a manual-LOCAL chat has always shown the host repo at
    // process.cwd(); the container guard must not change that.
    assert.strictEqual(gitCwd({ container: null, host: LOCAL, cwd: undefined }), process.cwd());
    assert.strictEqual(gitCwd({ host: LOCAL, cwd: undefined }), process.cwd());
  });

  it('returns "" for a non-container REMOTE chat with no cwd', () => {
    assert.strictEqual(gitCwd({ container: null, host: 'ssh-host', cwd: undefined }), '');
  });
});

// Proves runGit ROUTES a container chat through `docker exec … git -C <cwd>` and
// returns the CONTAINER's own repo state — not Warden's process.cwd() repo. The
// fake docker (on PATH) maps the container to a real temp repo, so the branch /
// dirty file runGit returns must match THAT repo; both are deliberately unique to
// it (Warden's own repo has neither), so a match can only mean the docker-exec
// branch ran.
describe('runGit — routes container chats through docker exec (WARDEN-235)', () => {
  it('runs git INSIDE the container and returns its OWN branch', async () => {
    const chat = { container: 'yatfa-test', host: LOCAL, cwd: '/workspace' };
    const r = await runGit(chat, ['rev-parse', '--abbrev-ref', 'HEAD'], '/workspace');
    assert.ok(r.ok, `runGit via fake docker should succeed: ${JSON.stringify(r)}`);
    // A branch name that exists only in the container repo — if runGit had fallen
    // back to host git (process.cwd() = Warden), this would be Warden's branch.
    assert.strictEqual(r.stdout.trim(), 'yatfa-agent-branch',
      `must read the CONTAINER repo branch, not Warden's: ${JSON.stringify(r)}`);
  });

  it('surfaces the container repo\'s own dirty file (not Warden\'s tree)', async () => {
    const chat = { container: 'yatfa-test', host: LOCAL, cwd: '/workspace' };
    const r = await runGit(chat, ['status', '--porcelain'], '/workspace');
    assert.ok(r.ok);
    // agent-dirty.txt exists ONLY in the mapped container repo. If runGit read the
    // host repo it would never appear here.
    assert.ok(r.stdout.includes('agent-dirty.txt'),
      `the container-only dirty file must surface: ${JSON.stringify(r.stdout)}`);
  });

  it('reports no stashes for the container repo (clean parse path)', async () => {
    const chat = { container: 'yatfa-test', host: LOCAL, cwd: '/workspace' };
    const r = await runGit(chat, ['stash', 'list'], '/workspace');
    assert.ok(r.ok);
    assert.strictEqual(r.stdout.trim(), '');
  });

  it('reads LIVE state: a new dirty file appears without re-importing server', async () => {
    // Proves the docker-exec path reads the repo fresh each call (not a cached
    // value captured at module load), so polling picks up changes.
    const chat = { container: 'yatfa-test', host: LOCAL, cwd: '/workspace' };
    const before = await runGit(chat, ['status', '--porcelain'], '/workspace');
    const beforeCount = before.stdout.split('\n').filter(Boolean).length;
    fs.writeFileSync(path.join(containerRepo, 'second-dirty.txt'), 'also uncommitted\n');
    try {
      const after = await runGit(chat, ['status', '--porcelain'], '/workspace');
      assert.ok(after.stdout.includes('second-dirty.txt'),
        `newly-added file must appear on the next runGit call: ${JSON.stringify(after.stdout)}`);
      const afterCount = after.stdout.split('\n').filter(Boolean).length;
      assert.strictEqual(afterCount, beforeCount + 1, 'exactly one new file should appear');
    } finally {
      fs.unlinkSync(path.join(containerRepo, 'second-dirty.txt'));
    }
  });
});
