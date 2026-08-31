import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

/**
 * Tests for the read-only git-blame / annotate feature (WARDEN-206).
 *
 * Three layers, sharing ONE file-level before() — same harness as git-show.test.js:
 *
 *  1. parseGitBlame — pure unit tests for the `--line-porcelain` parser: record
 *     boundaries (TAB-terminated content), author/author-time→ISO date, summary
 *     truncation, CRLF tolerance, and empty input.
 *
 *  2. buildGitBlameScript — the remote SSH command builder (shellQuote of cwd +
 *     filePath, mirroring buildGitDiffScript's coverage of the remote path).
 *
 *  3. /api/git-blame — HTTP integration tests against the REAL Express app from
 *     src/server.js. We seed a throwaway HOME + chats.json catalog entry whose
 *     `cwd` is a temp git repo with a known 2-commit history (add → modify line 2),
 *     using FIXED author/committer dates so blame's per-line `date` is deterministic.
 *     Covers the success criteria:
 *       - known file → [{line,hash,author,date,summary}] aligned to file lines
 *       - line 2's provenance points at the modifying commit (different author/date)
 *       - non-git cwd → { lines: [], error: null } (200, NOT a 500)
 *       - empty path → { lines: [], error: null } (200)
 *       - path traversal / absolute path → rejected (200, error 'invalid path')
 *       - unknown id → 404
 *       - deleted cwd / gone container → { lines: [], error: 'git blame failed' }
 *         (200, WARDEN-1255 — an unreachable repo reports its failure)
 *
 * NOTE on the single before(): src/server.js evaluates `const cfg = load()` at module
 * load, and load() reads config.js's module-level `dir` (= path.join(os.homedir(), …)).
 * So the FIRST import of server.js freezes the home dir for the whole process. We must
 * set process.env.HOME (and write config + catalog + repo) BEFORE that first import —
 * doing it once at the file level guarantees all three describe blocks see the temp HOME.
 */

let parseGitBlame;
let buildGitBlameScript;
let buildCwdReachableScript;
let capDiff;
let httpServer;
let baseUrl;
let originalHome;
let tempHome;
let gitRepo;
let nonGitDir;
let deletedDir;
let firstHash;  // hash of the initial commit (Alice, 2020-01-01)
let secondHash; // hash of the modify commit (Bob, 2021-01-01)

// Fixed commit dates (UTC) so blame's per-line `date` is deterministic:
const FIRST_DATE_ISO = '2020-01-01T00:00:00.000Z';  // epoch 1577836800
const SECOND_DATE_ISO = '2021-01-01T00:00:00.000Z'; // epoch 1609459200
const FIRST_DATE = '1577836800 +0000';
const SECOND_DATE = '1609459200 +0000';

// git with explicit author/committer dates (env-driven, so we don't depend on the
// machine clock). Mirrors the git() helper in git-show.test.js but threads env through.
function gitEnv(args, cwd, env) {
  const r = spawnSync('git', args, {
    cwd,
    stdio: ['ignore', 'pipe', 'inherit'],
    env: { ...process.env, ...env },
  });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed (status ${r.status}) in ${cwd}`);
  return r;
}

before(async () => {
  originalHome = process.env.HOME;
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-gitblame-'));
  process.env.HOME = tempHome;

  // config.json with no SSH hosts
  const wardenDir = path.join(tempHome, '.yatfa-warden');
  fs.mkdirSync(wardenDir, { recursive: true });
  fs.writeFileSync(path.join(wardenDir, 'config.json'), JSON.stringify({ hosts: [] }));

  // Build a real git repo with a known 2-commit history. Line 1 is unchanged across
  // both commits (provenance = Alice/commit1); line 2 is modified by commit2 (Bob).
  gitRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-gitblame-repo-'));
  spawnSync('git', ['init', '-q'], { cwd: gitRepo, stdio: ['ignore', 'pipe', 'inherit'] });
  gitEnv(['config', 'user.email', 'alice@example.com'], gitRepo, {});
  gitEnv(['config', 'user.name', 'Alice'], gitRepo, {});

  fs.writeFileSync(path.join(gitRepo, 'a.txt'), 'line one\nline two\n');
  gitEnv(['add', '.'], gitRepo, {});
  gitEnv(['commit', '-q', '-m', 'initial commit'], gitRepo, {
    GIT_AUTHOR_DATE: FIRST_DATE, GIT_COMMITTER_DATE: FIRST_DATE,
  });
  firstHash = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: gitRepo }).stdout.toString().trim();

  // Second commit: change line 2, authored by Bob on a later date.
  fs.writeFileSync(path.join(gitRepo, 'a.txt'), 'line one\nLINE TWO EDITED\n');
  gitEnv(['config', 'user.email', 'bob@example.com'], gitRepo, {});
  gitEnv(['config', 'user.name', 'Bob'], gitRepo, {});
  gitEnv(['commit', '-q', '-am', 'modify line two'], gitRepo, {
    GIT_AUTHOR_DATE: SECOND_DATE, GIT_COMMITTER_DATE: SECOND_DATE,
  });
  secondHash = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: gitRepo }).stdout.toString().trim();

  // A plain non-git directory
  nonGitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-gitblame-nongit-'));
  fs.writeFileSync(path.join(nonGitDir, 'readme.txt'), 'not a repo\n');

  // A chat whose working directory is DELETED (WARDEN-1255): the catalog keeps the
  // cwd, the fs no longer has it — the local-transport shape of "repository
  // unreachable". Created + registered below, then removed, so the chat resolves
  // but nothing lives at its cwd.
  deletedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-gitblame-deleted-'));

  // Catalog with LOCAL manual chats: one in the git repo, one in the non-git dir,
  // one whose cwd is about to be deleted. Resolved by bare session id (no ':'
  // prefix) → no host/tmux discovery runs. (A container chat CANNOT be fixtured
  // here: the disk catalog hardcodes container:null — container chats are born
  // only from live docker discovery — so the in-context transport leg of the
  // WARDEN-1255 gate is unit-tested via isCwdReachable below instead.)
  fs.writeFileSync(
    path.join(wardenDir, 'chats.json'),
    JSON.stringify([
      { host: '(local)', session: 'warden-gitblame', cwd: gitRepo, cmd: 'bash', name: 'warden-gitblame' },
      { host: '(local)', session: 'warden-nongit', cwd: nonGitDir, cmd: 'bash', name: 'warden-nongit' },
      { host: '(local)', session: 'warden-deleted', cwd: deletedDir, cmd: 'bash', name: 'warden-deleted' },
    ]),
  );

  // Delete the deleted chat's cwd AFTER the catalog references it.
  fs.rmSync(deletedDir, { recursive: true, force: true });

  // Import server.js ONCE — after HOME/config/catalog are in place.
  const server = await import('./server.js');
  ({ parseGitBlame, buildGitBlameScript, buildCwdReachableScript, capDiff } = await import('./git.js'));
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

// A realistic `git blame --line-porcelain` blob: two records, one per line, each
// terminated by a TAB-prefixed content line.
const PORCELAIN = [
  'abc123deadbeef0000000000000000000000ff 1 1 1',
  'author Alice',
  'author-mail <alice@example.com>',
  'author-time 1577836800',
  'author-tz +0000',
  'committer Alice',
  'committer-mail <alice@example.com>',
  'committer-time 1577836800',
  'committer-tz +0000',
  'summary initial commit',
  'boundary',
  'filename a.txt',
  '\tline one content',
  'def456beef000000000000000000000000abcd 2 2 1',
  'author Bob',
  'author-mail <bob@example.com>',
  'author-time 1609459200',
  'author-tz +0000',
  'committer Bob',
  'committer-mail <bob@example.com>',
  'committer-time 1609459200',
  'committer-tz +0000',
  'summary fix line two',
  'previous abc123deadbeef0000000000000000000000ff a.txt',
  'filename a.txt',
  '\tline two content',
].join('\n');

describe('parseGitBlame', () => {
  it('parses a two-line --line-porcelain blob into per-line provenance', () => {
    const out = parseGitBlame(PORCELAIN);
    assert.strictEqual(out.length, 2);
    assert.deepStrictEqual(out[0], {
      line: 1, hash: 'abc123deadbeef0000000000000000000000ff',
      author: 'Alice', date: FIRST_DATE_ISO, summary: 'initial commit',
    });
    assert.deepStrictEqual(out[1], {
      line: 2, hash: 'def456beef000000000000000000000000abcd',
      author: 'Bob', date: SECOND_DATE_ISO, summary: 'fix line two',
    });
  });

  it('uses resultline (the 3rd number) as the line number, not sourceline', () => {
    // A record whose result line differs from its source line (e.g. a line moved up).
    const moved = [
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 5 2 1',
      'author X',
      'author-mail <x@x.com>',
      'author-time 1577836800',
      'summary moved',
      'filename a.txt',
      '\tmoved content',
    ].join('\n');
    const out = parseGitBlame(moved);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].line, 2, 'line must be the result line (2), not source (5)');
  });

  it('emits the hash, author, date, summary but NOT author-mail (compact shape)', () => {
    const [rec] = parseGitBlame(PORCELAIN);
    assert.deepStrictEqual(Object.keys(rec).sort(), ['author', 'date', 'hash', 'line', 'summary']);
  });

  it('truncates a long summary to GIT_BLAME_SUMMARY_MAX with an ellipsis', () => {
    const longSubject = 'x'.repeat(120);
    const blob = [
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 1 1 1',
      'author A',
      'author-mail <a@a.com>',
      'author-time 1577836800',
      `summary ${longSubject}`,
      'filename a.txt',
      '\tc',
    ].join('\n');
    const [rec] = parseGitBlame(blob);
    assert.strictEqual(rec.summary.length, 80);
    assert.ok(rec.summary.endsWith('…'));
    assert.ok(rec.summary.startsWith('x'));
  });

  it('renders author-time as ISO 8601 (pure / deterministic for fixed epochs)', () => {
    const blob = [
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 1 1 1',
      'author A',
      'author-mail <a@a.com>',
      'author-time 1577836800',
      'author-tz +0000',
      'summary s',
      'filename a.txt',
      '\tc',
    ].join('\n');
    assert.strictEqual(parseGitBlame(blob)[0].date, FIRST_DATE_ISO);
  });

  it('tolerates CRLF line ends (output arriving over an SSH pty)', () => {
    const out = parseGitBlame(PORCELAIN.replace(/\n/g, '\r\n'));
    assert.strictEqual(out.length, 2);
    assert.strictEqual(out[0].author, 'Alice');
    assert.strictEqual(out[1].author, 'Bob');
  });

  it('returns [] for empty / undefined input', () => {
    assert.deepStrictEqual(parseGitBlame(''), []);
    assert.deepStrictEqual(parseGitBlame(undefined), []);
    assert.deepStrictEqual(parseGitBlame(null), []);
  });

  it('handles a record whose content line is empty (just the TAB)', () => {
    const blob = [
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 1 1 1',
      'author A',
      'author-mail <a@a.com>',
      'author-time 1577836800',
      'summary s',
      'filename a.txt',
      '\t',
    ].join('\n');
    const out = parseGitBlame(blob);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].line, 1);
  });

  it('parses a huge (>1MB) capped blob without throwing (large-output cap pipeline)', () => {
    // The route runs capDiff() THEN parseGitBlame(). A >1MB blame must not blow up:
    // capDiff truncates to GIT_DIFF_MAX_BYTES (possibly dropping the final partial
    // record), and the parser yields a bounded array. This mirrors the cap discipline.
    const record = [
      'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb 1 1 1',
      'author Big',
      'author-mail <big@x.com>',
      'author-time 1577836800',
      'summary s',
      'filename big.txt',
      '\t' + 'y'.repeat(200),
    ].join('\n') + '\n';
    // ~263 bytes/record → need ~4000 records to clear 1MB.
    let big = record.repeat(5000);
    assert.ok(Buffer.byteLength(big) > 1024 * 1024, 'fixture must exceed the 1MB cap');
    const capped = capDiff(big);
    assert.ok(Buffer.byteLength(capped) <= 1024 * 1024, 'capDiff must bound output to 1MB');
    const out = parseGitBlame(capped);
    assert.ok(out.length > 0 && out.length <= 5000);
    assert.strictEqual(out[0].author, 'Big');
  });
});

describe('buildGitBlameScript (remote SSH command)', () => {
  it('cds into cwd and runs blame --line-porcelain on the file with a `--` stop', () => {
    const script = buildGitBlameScript('/a/b', 'c.txt');
    assert.ok(script.startsWith('cd '), 'must cd into cwd');
    assert.ok(script.includes('git blame --line-porcelain'), 'must use --line-porcelain');
    assert.ok(script.includes(' -- '), 'must have a `--` option stop before the path');
    assert.ok(script.includes('2>/dev/null'), 'must silence git stderr (non-git → empty, not error)');
  });

  it('single-quotes a cwd and file with spaces (WARDEN-122 quoting discipline)', () => {
    const script = buildGitBlameScript('/a/b c', 'd e.txt');
    // shellQuote yields a single-quoted POSIX token: '/a/b c' and 'd e.txt'.
    // `cd` itself is unquoted; only its argument is quoted.
    assert.ok(script.startsWith("cd '/a/b c'"), 'cwd with space must be single-quoted');
    assert.ok(script.includes("'d e.txt'"), 'file with space must be single-quoted');
  });

  it('does not let a path that looks like a flag inject a git option', () => {
    const script = buildGitBlameScript('/repo', '--malicious');
    // The `--` before the path stops option parsing, and shellQuote keeps it a literal arg.
    assert.ok(script.includes("git blame --line-porcelain -- '--malicious'"));
  });
});

describe('buildCwdReachableScript (remote reachability probe, WARDEN-1255)', () => {
  it('is the bare directory predicate — no git, no repo-ness', () => {
    // The probe must consult ONLY whether the cwd is an enterable directory: a
    // present-but-non-repo cwd is REACHABLE (blame's benign empty), so any git
    // involvement here would re-fuse the cases the gate exists to separate.
    const script = buildCwdReachableScript('/a/b');
    assert.strictEqual(script, "test -d '/a/b'");
    assert.ok(!script.includes('git'), 'the probe must not consult git');
  });

  it('single-quotes a cwd with spaces (WARDEN-122 quoting discipline)', () => {
    assert.strictEqual(buildCwdReachableScript('/a/b c'), "test -d '/a/b c'");
  });
});

describe('isCwdReachable — the WARDEN-1255 failure-gate discriminator', () => {
  // The discriminator the blame gate keys on: is the working directory ENTERABLE
  // where it lives — NOT "is it a repository". The two axes the gate must split:
  //   reachable (repo or not)  → blame's own non-zero exit is benign (non-repo cwd,
  //                              untracked file) → empty result, no error
  //   unreachable              → deleted cwd / gone container / dead transport → error
  // Reachability is a property of the DIRECTORY + TRANSPORT, so these tests probe
  // it directly (the HTTP suite above covers the gate wiring end-to-end for the
  // LOCAL transport via the deleted-cwd fixture).
  let isCwdReachable;
  before(async () => {
    ({ isCwdReachable } = await import('./gitRoutes.js'));
  });

  it('true for a present directory (a non-repo cwd is REACHABLE — blame stays benign)', async () => {
    assert.strictEqual(await isCwdReachable({ host: '(local)' }, nonGitDir), true);
  });

  it('false for a deleted directory (the failure the gate reports)', async () => {
    const gone = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-gitblame-gone-'));
    fs.rmSync(gone, { recursive: true, force: true });
    assert.strictEqual(await isCwdReachable({ host: '(local)' }, gone), false);
  });

  it('false for a path that survives as a non-directory (cd would fail there too)', async () => {
    // statSync (not existsSync): a plain FILE at the cwd path is not enterable,
    // exactly as `test -d` / `cd` would judge it remotely.
    assert.strictEqual(await isCwdReachable({ host: '(local)' }, path.join(nonGitDir, 'readme.txt')), false);
  });

  it('false when the in-context (docker exec) transport cannot reach the repo — gone container', async () => {
    // A container that cannot exist: whatever this machine's docker state (absent
    // binary, down daemon, or unknown container name), the `test -d` probe fails
    // through docker exec the same way the blame script does — unreachable. The
    // pid-suffixed name makes a real collision implausible.
    const chat = { host: '(local)', container: `warden-gitblame-nosuch-${process.pid}`, cwd: '/tmp' };
    assert.strictEqual(await isCwdReachable(chat, '/tmp'), false);
  });
});

describe('/api/git-blame HTTP endpoint (real Express app from server.js)', () => {
  it('returns per-line provenance aligned to the file, line 1 from the initial commit', async () => {
    const res = await fetch(`${baseUrl}/api/git-blame?id=warden-gitblame&path=${encodeURIComponent('a.txt')}`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.error, null);
    assert.ok(Array.isArray(body.lines));
    assert.strictEqual(body.lines.length, 2, 'two-file-line history → two blame records');

    const [l1, l2] = body.lines;
    assert.strictEqual(l1.line, 1);
    assert.strictEqual(l1.hash, firstHash);
    assert.strictEqual(l1.author, 'Alice');
    assert.strictEqual(l1.date, FIRST_DATE_ISO);
    assert.strictEqual(l1.summary, 'initial commit');
  });

  it('attributes line 2 to the modifying commit (different author/date/hash)', async () => {
    const body = await (await fetch(`${baseUrl}/api/git-blame?id=warden-gitblame&path=${encodeURIComponent('a.txt')}`)).json();
    const l2 = body.lines[1];
    assert.strictEqual(l2.line, 2);
    assert.strictEqual(l2.hash, secondHash);
    assert.strictEqual(l2.author, 'Bob');
    assert.strictEqual(l2.date, SECOND_DATE_ISO);
    assert.strictEqual(l2.summary, 'modify line two');
  });

  it('returns { lines: [], error: null } (200, not 500) for a non-git cwd', async () => {
    const res = await fetch(`${baseUrl}/api/git-blame?id=warden-nongit&path=${encodeURIComponent('readme.txt')}`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.deepStrictEqual(body.lines, []);
    assert.strictEqual(body.error, null);
  });

  it('reports the failure (200, never 500) for a DELETED working directory (WARDEN-1255)', async () => {
    // The local-transport shape of "repository unreachable": the catalog still
    // resolves the chat, but nothing lives at its cwd — the spawn cannot even run
    // where the repo lived. Before WARDEN-1255 this answered a confident
    // { lines: [], error: null } — the file with a blank gutter — while the history
    // view of the SAME repository reported its failure. The error must be the
    // fixed non-empty literal (an empty string reads as "no error" to the client's
    // shared readListResponse).
    const res = await fetch(`${baseUrl}/api/git-blame?id=warden-deleted&path=${encodeURIComponent('a.txt')}`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.deepStrictEqual(body.lines, []);
    assert.strictEqual(body.error, 'git blame failed');
  });

  it('returns { lines: [], error: null } (200) for an empty path', async () => {
    const res = await fetch(`${baseUrl}/api/git-blame?id=warden-gitblame&path=`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.deepStrictEqual(body.lines, []);
    assert.strictEqual(body.error, null);
  });

  it('returns { lines: [], error: null } for a tracked file that does not exist yet', async () => {
    // git blame on a missing path exits non-zero → empty stdout → { lines: [], error: null }.
    const res = await fetch(`${baseUrl}/api/git-blame?id=warden-gitblame&path=${encodeURIComponent('nope.txt')}`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.deepStrictEqual(body.lines, []);
    assert.strictEqual(body.error, null);
  });

  it('rejects a path-traversal path= param (200, never 500)', async () => {
    const res = await fetch(`${baseUrl}/api/git-blame?id=warden-gitblame&path=${encodeURIComponent('../../etc/passwd')}`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.deepStrictEqual(body.lines, []);
    assert.strictEqual(body.error, 'invalid path');
  });

  it('rejects an absolute path= param (200, never 500)', async () => {
    const res = await fetch(`${baseUrl}/api/git-blame?id=warden-gitblame&path=${encodeURIComponent('/etc/passwd')}`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.error, 'invalid path');
  });

  it('returns 404 for an unknown chat id', async () => {
    const res = await fetch(`${baseUrl}/api/git-blame?id=does-not-exist&path=a.txt`);
    assert.strictEqual(res.status, 404);
  });
});
