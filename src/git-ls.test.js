import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Tests for /api/git-ls (WARDEN-573) — the structural twin of /api/search-files.
// Where the grep dialog finds a file by content, this route finds it by position
// (browse dirs → filenames). The endpoint backs `git ls-files --cached --others
// --exclude-standard` via runGit (so it honors .gitignore, stays cwd-bounded, and
// works for local/SSH/yatfa-container alike). These tests pin the two pure halves
// — the containment guard (isSafeRelativePath) and the immediate-children parser
// (parseGitLsEntries) — plus the REAL git behavior (gitignore exclusion, nesting,
// subdir scoping) the endpoint consumes, exactly mirroring search-files.test.js.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(__dirname, 'server.js');

// Redirect HOME so importing server.js (which reads config/catalog and rotates
// activity logs at module load) touches only a temp dir, never the real
// ~/.yatfa-warden. Top-level await lets us import AFTER setting HOME.
process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-ls-home-'));
const { parseGitLsEntries, runGit } = await import('./server.js');
const { isSafeRelativePath } = await import('./git.js');
const LOCAL = '(local)';

// --- Syntax guard: server.js MUST compile ---------------------------------
describe('server.js compiles', () => {
  it('passes node --check', () => {
    const r = spawnSync(process.execPath, ['--check', SERVER], { encoding: 'utf8' });
    assert.equal(r.status, 0, `server.js failed to parse:\n${r.stderr}`);
  });
});

describe('isSafeRelativePath (dir containment guard)', () => {
  it('accepts simple relative paths and nested ones', () => {
    assert.equal(isSafeRelativePath('src'), true);
    assert.equal(isSafeRelativePath('src/components'), true);
    assert.equal(isSafeRelativePath('a/b/c'), true);
    assert.equal(isSafeRelativePath('file with spaces.ts'), true);
  });

  it('rejects parent-directory traversal in any position', () => {
    assert.equal(isSafeRelativePath('..'), false);
    assert.equal(isSafeRelativePath('../secret'), false);
    assert.equal(isSafeRelativePath('a/../../c'), false);
    assert.equal(isSafeRelativePath('src/..'), false);
    assert.equal(isSafeRelativePath('a/../b'), false); // even a no-op .. is rejected
  });

  it('rejects absolute paths (POSIX + Windows drive)', () => {
    assert.equal(isSafeRelativePath('/etc/passwd'), false);
    assert.equal(isSafeRelativePath('/'), false);
    assert.equal(isSafeRelativePath('C:\\Windows\\system32'), false);
    assert.equal(isSafeRelativePath('C:/Users/x'), false);
  });

  it('rejects ~ home-relative and null bytes', () => {
    assert.equal(isSafeRelativePath('~/.ssh/id_rsa'), false);
    assert.equal(isSafeRelativePath('~'), false);
    assert.equal(isSafeRelativePath('a\0b'), false);
  });

  it('treats non-strings as invalid', () => {
    assert.equal(isSafeRelativePath(null), false);
    assert.equal(isSafeRelativePath(undefined), false);
    assert.equal(isSafeRelativePath(123), false);
  });
});

describe('parseGitLsEntries (immediate-children parser)', () => {
  it('derives root files + subdirs from a flat recursive list', () => {
    // A typical `git ls-files` root dump: top-level files + paths nested in dirs.
    const raw = [
      'README.md',
      'package.json',
      'src/server.js',
      'src/util.js',
      'web/index.html',
      'web/src/App.tsx',
    ].join('\n');
    const entries = parseGitLsEntries(raw, '');
    const names = entries.map((e) => e.name);
    // case-insensitive sort: package.json before README.md ('package' < 'readme').
    assert.deepEqual(names, ['src', 'web', 'package.json', 'README.md']);
    assert.deepEqual(entries.find((e) => e.name === 'src'), { name: 'src', type: 'dir' });
    assert.deepEqual(entries.find((e) => e.name === 'README.md'), { name: 'README.md', type: 'file' });
  });

  it('sorts dirs-first then case-insensitive alphabetical', () => {
    const raw = ['zeta.js', 'alpha.js', 'mid/x', 'aaa/y', 'Beta.js'].join('\n');
    const entries = parseGitLsEntries(raw, '');
    assert.deepEqual(
      entries.map((e) => `${e.type}:${e.name}`),
      ['dir:aaa', 'dir:mid', 'file:alpha.js', 'file:Beta.js', 'file:zeta.js'],
    );
  });

  it('collapses a subdir holding many files into ONE dir entry', () => {
    // node_modules-style: one dir with hundreds of files → a single 'dir' entry,
    // not hundreds. (Payload-bounding: we return one dir's children, not a tree.)
    const raw = Array.from({ length: 300 }, (_, i) => `node_modules/pkg/file${i}.js`).join('\n');
    const entries = parseGitLsEntries(raw, '');
    assert.deepEqual(entries, [{ name: 'node_modules', type: 'dir' }]);
  });

  it('strips the requested dir prefix and lists only its immediate children', () => {
    // Expanding 'src': paths arrive as src/a, src/sub/b — strip 'src/' → a (file),
    // sub (dir). The lazy per-directory expansion model.
    const raw = ['src/server.js', 'src/util.js', 'src/components/Pane.tsx', 'src/components/Other.tsx'].join('\n');
    const entries = parseGitLsEntries(raw, 'src');
    assert.deepEqual(
      entries.map((e) => `${e.type}:${e.name}`),
      ['dir:components', 'file:server.js', 'file:util.js'],
    );
  });

  it('normalizes a trailing slash on the dir prefix', () => {
    const a = parseGitLsEntries('src/a.js\nsrc/b.js', 'src');
    const b = parseGitLsEntries('src/a.js\nsrc/b.js', 'src/');
    assert.deepEqual(b, a);
  });

  it('ignores blank / CRLF lines without producing phantom entries', () => {
    // Top-level files (not nested) so they list as files, not collapsed dirs.
    const raw = '\r\na.js\r\n\r\nb.js\r\n';
    const entries = parseGitLsEntries(raw, '');
    assert.deepEqual(entries.map((e) => e.name).sort(), ['a.js', 'b.js']);
  });

  it('skips lines outside the requested prefix (defensive)', () => {
    // Shouldn't happen with a pathspec, but a stray top-level path must not leak
    // into a subdir listing as a weird truncated name.
    const entries = parseGitLsEntries('src/a.js\nother/b.js', 'src');
    assert.deepEqual(entries, [{ name: 'a.js', type: 'file' }]);
  });

  it('returns [] for empty / whitespace-only output', () => {
    assert.deepEqual(parseGitLsEntries('', ''), []);
    assert.deepEqual(parseGitLsEntries('\n  \n', ''), []);
    assert.deepEqual(parseGitLsEntries(null, ''), []);
  });

  // C-quoted paths (WARDEN-676). `git ls-files` C-quotes any path containing a
  // backslash, double-quote, control char, or non-ASCII byte (core.quotePath=true
  // default), and it quotes the ENTIRE path — dir prefix included — as one
  // C-string. parseGitLsEntries must unescape BEFORE the prefix startsWith/slice,
  // or a non-ASCII subdir lists EMPTY and root names come back mangled with
  // literal quotes + octal escapes. These mirror gitStatus.test.js's
  // unescapeGitPath block, but against the parser that consumes ls-files output.

  it('decodes a C-quoted non-ASCII file name at root (no literal quotes/escapes)', () => {
    // 'é' = U+00E9 = UTF-8 0xC3 0xA9 = octal \303 \251 → café.js
    assert.deepEqual(parseGitLsEntries('"caf\\303\\251.js"', ''), [
      { name: 'café.js', type: 'file' },
    ]);
  });

  it('decodes C-quoted backslash and embedded-quote paths at root', () => {
    assert.deepEqual(parseGitLsEntries('"back\\\\slash.js"', ''), [
      { name: 'back\\slash.js', type: 'file' },
    ]);
    assert.deepEqual(parseGitLsEntries('"quote\\"in.js"', ''), [
      { name: 'quote"in.js', type: 'file' },
    ]);
  });

  it('unescapes the whole quoted line so a non-ASCII dir prefix strips correctly', () => {
    // The killer case: git quotes the ENTIRE "süb/café.js" as ONE C-string
    // ("s\303\274b/caf\303\251.js"), so the 'süb/' prefix lives INSIDE the
    // quotes. Unescape first → 'süb/café.js' → startsWith('süb/') is true →
    // 'café.js'. Before the fix this listed EMPTY (startsWith saw a leading ").
    // 'ü' = U+00FC = UTF-8 0xC3 0xBC = octal \303 \274.
    assert.deepEqual(parseGitLsEntries('"s\\303\\274b/caf\\303\\251.js"', 'süb'), [
      { name: 'café.js', type: 'file' },
    ]);
  });

  it('leaves a plain-space path unchanged (ls-files does not quote spaces)', () => {
    // `git ls-files` does NOT C-quote a plain space, so the line is unquoted →
    // unescapeGitPath is a no-op → 'spa ce.js' survives verbatim. (Contrast
    // `git status --porcelain`, which DOES quote spaces — different parser.)
    assert.deepEqual(parseGitLsEntries('spa ce.js', ''), [
      { name: 'spa ce.js', type: 'file' },
    ]);
  });
});

// Run the EXACT command the endpoint runs for a LOCAL chat — `git ls-files
// --cached --others --exclude-standard [-- dir]` — against a real temp repo and
// feed the stdout to parseGitLsEntries. This proves the parser matches git's real
// output shape (the way search-files.test.js proves parseSearchOutput against a
// real `git grep`), including the gitignore exclusion that is the whole point of
// using `--exclude-standard` over raw fs.readdirSync.
function runLsFiles(cwd, dir) {
  const args = ['ls-files', '--cached', '--others', '--exclude-standard'];
  if (dir) args.push('--', dir);
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  return { ok: r.status === 0, stdout: r.stdout || '', stderr: r.stderr || '' };
}

describe('git ls-files → parseGitLsEntries (real git repo)', () => {
  let tmp;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-ls-cwd-'));
    spawnSync('git', ['-c', 'init.defaultBranch=main', 'init', '-q', tmp]);
    // Tracked files: a top-level file, a nested file under src/, and a file in a
    // deeper nest (src/components/).
    fs.writeFileSync(path.join(tmp, 'README.md'), '# project\n');
    fs.mkdirSync(path.join(tmp, 'src', 'components'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'src', 'server.js'), 'console.log()\n');
    fs.writeFileSync(path.join(tmp, 'src', 'components', 'Pane.tsx'), '<div/>\n');
    spawnSync('git', ['-C', tmp, 'add', 'README.md', 'src/server.js', 'src/components/Pane.tsx']);
    spawnSync('git', ['-C', tmp, 'commit', '-q', '-m', 'init']);
    // An UNTRACKED work-in-progress file — must appear (--others surfaces WIP).
    fs.writeFileSync(path.join(tmp, 'src', 'new.js'), 'new\n');
    // A gitignored file/dir — must NOT appear (--exclude-standard).
    fs.writeFileSync(path.join(tmp, '.gitignore'), 'ignored.log\nbuild/\n');
    fs.writeFileSync(path.join(tmp, 'ignored.log'), 'secret\n');
    fs.mkdirSync(path.join(tmp, 'build'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'build', 'out.js'), 'bundled\n');
  });

  it('lists root immediate children: src (dir) + README.md (file)', () => {
    const r = runLsFiles(tmp, '');
    assert.equal(r.ok, true, `stderr=${r.stderr}`);
    const entries = parseGitLsEntries(r.stdout, '');
    assert.deepEqual(
      entries.map((e) => `${e.type}:${e.name}`),
      ['dir:src', 'file:.gitignore', 'file:README.md'],
    );
  });

  it('honors .gitignore: ignored.log and build/ never appear at root', () => {
    const r = runLsFiles(tmp, '');
    const names = parseGitLsEntries(r.stdout, '').map((e) => e.name);
    assert.ok(!names.includes('ignored.log'), 'gitignored file must be excluded');
    assert.ok(!names.includes('build'), 'gitignored build/ dir must be excluded');
  });

  it('expands src/ lazily: server.js + new.js (files) + components (dir)', () => {
    const r = runLsFiles(tmp, 'src');
    assert.equal(r.ok, true, `stderr=${r.stderr}`);
    const entries = parseGitLsEntries(r.stdout, 'src');
    assert.deepEqual(
      entries.map((e) => `${e.type}:${e.name}`),
      ['dir:components', 'file:new.js', 'file:server.js'],
    );
    // The untracked WIP file is surfaced (--others), the nested file stays a dir.
  });

  it('expands src/components/: only the one nested file', () => {
    const r = runLsFiles(tmp, 'src/components');
    assert.equal(r.ok, true, `stderr=${r.stderr}`);
    assert.deepEqual(parseGitLsEntries(r.stdout, 'src/components'), [
      { name: 'Pane.tsx', type: 'file' },
    ]);
  });

  it('scopes a pathspec to the subtree: root listing does not include src/* names', () => {
    // Without the per-dir pathspec the root dump would be recursive; WITH it the
    // parser collapses to immediate children only — src/server.js never appears
    // as a root file. This is the lazy, non-recursive payload contract.
    const r = runLsFiles(tmp, '');
    const rootNames = parseGitLsEntries(r.stdout, '').map((e) => e.name);
    assert.ok(!rootNames.includes('server.js'), 'nested file must collapse into its parent dir');
    assert.ok(!rootNames.some((n) => n.includes('/')), 'no returned name may contain a slash');
  });

  it('returns ok + [] for an empty (but git) directory with no files', () => {
    const emptyDir = path.join(tmp, 'empty-dir');
    fs.mkdirSync(emptyDir);
    const r = runLsFiles(tmp, 'empty-dir');
    assert.equal(r.ok, true);
    assert.deepEqual(parseGitLsEntries(r.stdout, 'empty-dir'), []);
  });

  it('end-to-end transport: the endpoint\'s real runGit() produces parseable output', async () => {
    // Exercise the EXACT function the endpoint calls — runGit(chat, args, cwd) on
    // a manual-LOCAL chat — rather than an equivalent spawnSync. A fake chat with
    // container:null + host:LOCAL routes through runLocalGit (the manual-local
    // transport), proving the endpoint's resolve→gitCwd→runGit→parse chain yields
    // a correct directory listing against a real repo. (Remote/container transports
    // share the same git command via runGit's docker-exec/ssh branches, WARDEN-235.)
    const chat = { host: LOCAL, container: null, cwd: tmp };
    const r = await runGit(chat, ['ls-files', '--cached', '--others', '--exclude-standard'], tmp);
    assert.equal(r.ok, true, `runGit failed: ${r.stderr}`);
    const entries = parseGitLsEntries(r.stdout, '');
    assert.deepEqual(
      entries.map((e) => `${e.type}:${e.name}`),
      ['dir:src', 'file:.gitignore', 'file:README.md'],
    );
  });
});
