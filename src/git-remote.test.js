import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
// Pure parsers live in gitStatus.js (the side-effect-free pure-helpers module) so
// the unit-test layer imports them STATICALLY at the top — independent of the
// HOME/server bootstrap the HTTP layer needs below. Mirrors how parseAheadBehind /
// parseGitStatusPorcelain are unit-tested in isolation (WARDEN-107).
import { parseRemoteUrl, parseGitRemotes } from './gitStatus.js';

/**
 * Tests for the remote-identity feature (WARDEN-528): surfacing which repo host a
 * checkout maps to + deep-linkable web URLs.
 *
 * Two layers, sharing ONE file-level before():
 *
 *  1. parseRemoteUrl / parseGitRemotes — pure unit tests for the URL→
 *     {host,owner,repo,web} parser and the `git remote -v` dedup parser. Covers
 *     https, git@ ssh (scp), ssh:// (explicit + port), .git suffix, GitLab
 *     self-hosted (nested groups), Bitbucket, the git:// protocol, and the null-web
 *     cases (bare/file/single-segment remotes).
 *
 *  2. /api/git-remote — HTTP integration tests against the REAL Express app from
 *     src/server.js. We seed a throwaway HOME + a chats.json catalog whose entries'
 *     `cwd` are temp git repos with known remotes (and a non-git dir), then resolve
 *     by bare session id so no host/tmux discovery runs. Covers:
 *       - happy path → parsed remotes with web URLs
 *       - a file-path remote → host/owner/repo/web all null (kept in the list)
 *       - a git repo with NO remotes → { remotes: [] } (200, not 500)
 *       - non-git cwd → { remotes: [] } (200, not 500)
 *       - unknown id → 404
 *
 * NOTE on the single before(): src/server.js evaluates `const cfg = load()` at module
 * load, and load() reads config.js's module-level `dir` (= path.join(os.homedir(), …)).
 * So the FIRST import of server.js freezes the home dir for the whole process. We set
 * process.env.HOME (and write config + catalog + repo) BEFORE that first import —
 * doing it once at the file level guarantees both describe blocks see the temp HOME.
 */

let httpServer;
let baseUrl;
let originalHome;
let tempHome;
let remoteRepo;   // git repo with origin (https) + fork (ssh) remotes
let fileRemoteRepo; // git repo whose only remote is a bare /path (web null)
let noRemotesRepo;  // git repo with NO remotes
let nonGitDir;

function git(args, cwd) {
  const r = spawnSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'inherit'] });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed (status ${r.status}) in ${cwd}`);
  return r;
}

before(async () => {
  originalHome = process.env.HOME;
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-gitremote-'));
  process.env.HOME = tempHome;

  // config.json with no SSH hosts
  const wardenDir = path.join(tempHome, '.yatfa-warden');
  fs.mkdirSync(wardenDir, { recursive: true });
  fs.writeFileSync(path.join(wardenDir, 'config.json'), JSON.stringify({ hosts: [] }));

  // ---- remoteRepo: a repo with TWO remotes — origin (https, with .git) and fork
  // (scp ssh) — so we can assert both parse, dedup their fetch/push lines, and that
  // the upstream-named remote is findable by name.
  remoteRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-gitremote-repo-'));
  git(['init', '-q'], remoteRepo);
  git(['config', 'user.email', 'test@example.com'], remoteRepo);
  git(['config', 'user.name', 'Tester'], remoteRepo);
  fs.writeFileSync(path.join(remoteRepo, 'a.txt'), 'a\n');
  git(['add', '.'], remoteRepo);
  git(['commit', '-q', '-m', 'init'], remoteRepo);
  // `git remote add` only records the URL in .git/config — no network needed.
  git(['remote', 'add', 'origin', 'https://github.com/yatfa-ai/warden.git'], remoteRepo);
  git(['remote', 'add', 'fork', 'git@github.com:someone/warden-fork.git'], remoteRepo);

  // ---- fileRemoteRepo: a repo whose only remote is a bare LOCAL path — the
  // web-null case. A bare /path remote has no host/owner/repo, so the entry stays
  // in the list (name + url) but host/owner/repo/web are all null.
  fileRemoteRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-gitremote-file-'));
  git(['init', '-q'], fileRemoteRepo);
  git(['config', 'user.email', 'test@example.com'], fileRemoteRepo);
  git(['config', 'user.name', 'Tester'], fileRemoteRepo);
  fs.writeFileSync(path.join(fileRemoteRepo, 'b.txt'), 'b\n');
  git(['add', '.'], fileRemoteRepo);
  git(['commit', '-q', '-m', 'init'], fileRemoteRepo);
  // `git remote add` only records the URL in .git/config — `git remote -v` reads
  // that config verbatim and never verifies the path exists, so a literal bare
  // path is a genuine web-null remote without creating (and having to clean up)
  // a real bare repo on disk.
  git(['remote', 'add', 'origin', '/srv/git/warden-bare.git'], fileRemoteRepo);

  // ---- noRemotesRepo: a real git repo with NO remotes configured. `git remote -v`
  // prints nothing (exit 0) → the route must return { remotes: [] }, never a 500.
  noRemotesRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-gitremote-noremotes-'));
  git(['init', '-q'], noRemotesRepo);
  git(['config', 'user.email', 'test@example.com'], noRemotesRepo);
  git(['config', 'user.name', 'Tester'], noRemotesRepo);
  fs.writeFileSync(path.join(noRemotesRepo, 'c.txt'), 'c\n');
  git(['add', '.'], noRemotesRepo);
  git(['commit', '-q', '-m', 'init'], noRemotesRepo);

  // ---- nonGitDir: a plain directory with no .git
  nonGitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-gitremote-nongit-'));
  fs.writeFileSync(path.join(nonGitDir, 'readme.txt'), 'not a repo\n');

  // Catalog with LOCAL manual chats, resolved by bare session id (no ':'
  // prefix) so no host/tmux discovery runs.
  fs.writeFileSync(
    path.join(wardenDir, 'chats.json'),
    JSON.stringify([
      { host: '(local)', session: 'warden-remote', cwd: remoteRepo, cmd: 'bash', name: 'warden-remote' },
      { host: '(local)', session: 'warden-fileremote', cwd: fileRemoteRepo, cmd: 'bash', name: 'warden-fileremote' },
      { host: '(local)', session: 'warden-noremotes', cwd: noRemotesRepo, cmd: 'bash', name: 'warden-noremotes' },
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
  for (const d of [remoteRepo, fileRemoteRepo, noRemotesRepo, nonGitDir, tempHome]) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

describe('parseRemoteUrl', () => {
  it('parses an https URL into { host, owner, repo, web }', () => {
    assert.deepStrictEqual(parseRemoteUrl('https://github.com/yatfa-ai/warden'), {
      host: 'github.com', owner: 'yatfa-ai', repo: 'warden', web: 'https://github.com/yatfa-ai/warden',
    });
  });

  it('strips a trailing .git suffix from the repo + web URL', () => {
    assert.deepStrictEqual(parseRemoteUrl('https://github.com/yatfa-ai/warden.git'), {
      host: 'github.com', owner: 'yatfa-ai', repo: 'warden', web: 'https://github.com/yatfa-ai/warden',
    });
  });

  it('parses a git@ scp ssh URL (host stripped of the user@)', () => {
    assert.deepStrictEqual(parseRemoteUrl('git@github.com:yatfa-ai/warden.git'), {
      host: 'github.com', owner: 'yatfa-ai', repo: 'warden', web: 'https://github.com/yatfa-ai/warden',
    });
  });

  it('parses an explicit ssh:// URL with a user + port', () => {
    assert.deepStrictEqual(parseRemoteUrl('ssh://git@github.com:22/yatfa-ai/warden.git'), {
      host: 'github.com', owner: 'yatfa-ai', repo: 'warden', web: 'https://github.com/yatfa-ai/warden',
    });
  });

  it('parses a self-hosted GitLab URL and preserves nested-group path in web', () => {
    // owner = first segment (group), repo = last segment, but web keeps the FULL
    // group/subgroup/project path so the deep link resolves on GitLab.
    assert.deepStrictEqual(parseRemoteUrl('ssh://git@gitlab.example.com:2222/group/sub/project.git'), {
      host: 'gitlab.example.com',
      owner: 'group',
      repo: 'project',
      web: 'https://gitlab.example.com/group/sub/project',
    });
  });

  it('parses https with userinfo (user@) preceding the host', () => {
    assert.deepStrictEqual(parseRemoteUrl('https://user@gitlab.com/team/proj.git'), {
      host: 'gitlab.com', owner: 'team', repo: 'proj', web: 'https://gitlab.com/team/proj',
    });
  });

  it('parses a Bitbucket URL', () => {
    assert.deepStrictEqual(parseRemoteUrl('https://bitbucket.org/owner/repo.git'), {
      host: 'bitbucket.org', owner: 'owner', repo: 'repo', web: 'https://bitbucket.org/owner/repo',
    });
  });

  it('parses the git:// protocol into an https web URL', () => {
    // The web UI is served over https regardless of the clone protocol.
    assert.deepStrictEqual(parseRemoteUrl('git://github.com/owner/repo.git'), {
      host: 'github.com', owner: 'owner', repo: 'repo', web: 'https://github.com/owner/repo',
    });
  });

  it('tolerates a trailing slash on the path', () => {
    assert.deepStrictEqual(parseRemoteUrl('https://github.com/owner/repo/'), {
      host: 'github.com', owner: 'owner', repo: 'repo', web: 'https://github.com/owner/repo',
    });
  });

  it('returns all-null for a bare local path (no host, no web)', () => {
    assert.deepStrictEqual(parseRemoteUrl('/path/to/repo'), {
      host: null, owner: null, repo: null, web: null,
    });
  });

  it('returns all-null for a file:// remote (local clone, no web equivalent)', () => {
    assert.deepStrictEqual(parseRemoteUrl('file:///path/to/repo'), {
      host: null, owner: null, repo: null, web: null,
    });
  });

  it('returns web null for a single-segment ssh path (bare server, no owner/repo)', () => {
    // A gitolite-style `ssh://host/myrepo` has a host but no owner/repo structure →
    // repo captured, but web/owner null (nothing to deep-link on a web host).
    assert.deepStrictEqual(parseRemoteUrl('ssh://git@gitolite.io/myrepo'), {
      host: 'gitolite.io', owner: null, repo: 'myrepo', web: null,
    });
  });

  it('returns all-null for empty / undefined input', () => {
    assert.deepStrictEqual(parseRemoteUrl(''), { host: null, owner: null, repo: null, web: null });
    assert.deepStrictEqual(parseRemoteUrl(undefined), { host: null, owner: null, repo: null, web: null });
  });
});

describe('parseGitRemotes', () => {
  it('dedupes the fetch/push duplicate per remote (first/fetch wins)', () => {
    const out = parseGitRemotes([
      'origin\tgit@github.com:yatfa-ai/warden.git (fetch)',
      'origin\tgit@github.com:yatfa-ai/warden.git (push)',
    ].join('\n'));
    assert.strictEqual(out.length, 1, 'fetch+push must collapse to one entry');
    assert.strictEqual(out[0].name, 'origin');
    assert.strictEqual(out[0].url, 'git@github.com:yatfa-ai/warden.git');
    assert.strictEqual(out[0].web, 'https://github.com/yatfa-ai/warden');
  });

  it('parses multiple remotes and parses each URL', () => {
    const out = parseGitRemotes([
      'origin\thttps://github.com/yatfa-ai/warden.git (fetch)',
      'origin\thttps://github.com/yatfa-ai/warden.git (push)',
      'upstream\tgit@github.com:someone/upstream.git (fetch)',
      'upstream\tgit@github.com:someone/upstream.git (push)',
    ].join('\n'));
    assert.strictEqual(out.length, 2);
    assert.deepStrictEqual(out[0], {
      name: 'origin', url: 'https://github.com/yatfa-ai/warden.git',
      host: 'github.com', owner: 'yatfa-ai', repo: 'warden', web: 'https://github.com/yatfa-ai/warden',
    });
    assert.deepStrictEqual(out[1], {
      name: 'upstream', url: 'git@github.com:someone/upstream.git',
      host: 'github.com', owner: 'someone', repo: 'upstream', web: 'https://github.com/someone/upstream',
    });
  });

  it('keeps a non-web remote (bare path) in the list with null host/owner/repo/web', () => {
    const out = parseGitRemotes([
      'origin\t/srv/git/repo.git (fetch)',
      'origin\t/srv/git/repo.git (push)',
    ].join('\n'));
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].name, 'origin');
    assert.strictEqual(out[0].url, '/srv/git/repo.git');
    assert.strictEqual(out[0].host, null);
    assert.strictEqual(out[0].web, null);
  });

  it('tolerates CRLF + blank lines (output arriving over SSH)', () => {
    const out = parseGitRemotes('\r\norigin\tgit@github.com:o/r.git (fetch)\r\n\r\n');
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].name, 'origin');
  });

  it('returns [] for empty / undefined input', () => {
    assert.deepStrictEqual(parseGitRemotes(''), []);
    assert.deepStrictEqual(parseGitRemotes(undefined), []);
  });
});

describe('/api/git-remote HTTP endpoint (real Express app from server.js)', () => {
  it('returns the parsed remotes with web URLs for a repo with remotes', async () => {
    const res = await fetch(`${baseUrl}/api/git-remote?id=warden-remote`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.error, null);
    assert.ok(Array.isArray(body.remotes));
    assert.strictEqual(body.remotes.length, 2, `got ${JSON.stringify(body.remotes)}`);
    const origin = body.remotes.find((r) => r.name === 'origin');
    assert.ok(origin, 'origin remote must be present');
    assert.strictEqual(origin.url, 'https://github.com/yatfa-ai/warden.git');
    assert.strictEqual(origin.host, 'github.com');
    assert.strictEqual(origin.owner, 'yatfa-ai');
    assert.strictEqual(origin.repo, 'warden');
    // The headline assertion: the web URL is surfaced (deep-linkable to the host).
    assert.strictEqual(origin.web, 'https://github.com/yatfa-ai/warden');
    const fork = body.remotes.find((r) => r.name === 'fork');
    assert.ok(fork, 'fork remote must be present');
    assert.strictEqual(fork.web, 'https://github.com/someone/warden-fork');
  });

  it('keeps a file-path remote in the list with null web (200, not 500)', async () => {
    const res = await fetch(`${baseUrl}/api/git-remote?id=warden-fileremote`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.error, null);
    assert.ok(Array.isArray(body.remotes));
    assert.strictEqual(body.remotes.length, 1);
    // A bare-path remote: name + url present, but host/owner/repo/web all null
    // (no web equivalent) — the entry survives so the UI can show the raw URL.
    assert.strictEqual(body.remotes[0].name, 'origin');
    assert.ok(body.remotes[0].url, 'the raw path url must be present');
    assert.strictEqual(body.remotes[0].host, null);
    assert.strictEqual(body.remotes[0].owner, null);
    assert.strictEqual(body.remotes[0].repo, null);
    assert.strictEqual(body.remotes[0].web, null);
  });

  it('returns { remotes: [] } (200, not 500) for a git repo with no remotes', async () => {
    const res = await fetch(`${baseUrl}/api/git-remote?id=warden-noremotes`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.deepStrictEqual(body.remotes, []);
  });

  it('returns { remotes: [] } (200, not 500) for a non-git cwd', async () => {
    const res = await fetch(`${baseUrl}/api/git-remote?id=warden-nongit`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.deepStrictEqual(body.remotes, []);
  });

  it('returns 404 for an unknown chat id', async () => {
    const res = await fetch(`${baseUrl}/api/git-remote?id=does-not-exist`);
    assert.strictEqual(res.status, 404);
  });
});
