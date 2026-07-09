// Tests for the observer write_file tool / writeReportFile core (WARDEN-168).
// writeReportFile is the pure, dependency-injected core: it takes the data dir
// as a parameter (no os.homedir() inside, no SSH/tmux/node-pty), so it is tested
// directly with a throwaway dir — free of the HOME-freezes-at-first-import
// caveat (WARDEN-130). A couple of integration tests drive the real tool handler
// (Observer._execTool) against the module-level DATA_DIR, so we set a throwaway
// HOME BEFORE importing observer.js (top-level await, like read-file.test.js).
//
// Security tests (WARDEN-96) are shaped to drive the DANGEROUS input that would
// break the guarded property if the check were removed — not the safe class the
// code already handles (WARDEN-111): an in-bounds-looking symlink that points
// OUTSIDE the data dir passes the lexical containment check, so only the
// symlink-aware realpath resolution catches it.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Throwaway HOME, set before the one and only observer.js import so the
// module-level DATA_DIR (and DIRECTIVES_LOG) never touch the real ~/.yatfa-warden.
process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-wf-home-'));
const { writeReportFile, Observer, DATA_DIR } = await import('./observer.js');

// Per-test data dir (passed straight to the pure core) + an "outside" scratch
// dir that is NOT under the data dir (stands in for /etc/… in the escape tests).
let dataDir;
let outside;

function freshDirs() {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-wf-data-'));
  outside = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-wf-out-'));
}

describe('writeReportFile — happy path', () => {
  beforeEach(freshDirs);

  it('writes text to a new file and reads it back (overwrite mode)', () => {
    const r = writeReportFile(dataDir, 'reports/summary.md', '# Hello\n');
    assert.equal(r.ok, true);
    assert.equal(r.appended, false);
    assert.equal(r.bytes, '# Hello\n'.length);
    assert.equal(
      fs.readFileSync(path.join(dataDir, 'reports/summary.md'), 'utf8'),
      '# Hello\n',
    );
  });

  it('creates nested directories as needed', () => {
    writeReportFile(dataDir, 'a/b/c/deep.md', 'deep');
    assert.equal(
      fs.readFileSync(path.join(dataDir, 'a/b/c/deep.md'), 'utf8'),
      'deep',
    );
  });

  it('returns a data-dir-relative path in the result', () => {
    const r = writeReportFile(dataDir, 'reports/x.md', 'hi');
    assert.equal(r.path, 'reports/x.md');
  });

  it('coerces non-string content to a UTF-8 string', () => {
    const r = writeReportFile(dataDir, 'n.txt', 42);
    assert.equal(r.ok, true);
    assert.equal(fs.readFileSync(path.join(dataDir, 'n.txt'), 'utf8'), '42');
  });
});

describe('writeReportFile — append vs overwrite', () => {
  beforeEach(freshDirs);

  it('append mode adds to an existing file', () => {
    writeReportFile(dataDir, 'log.md', 'line1\n');
    const r = writeReportFile(dataDir, 'log.md', 'line2\n', { append: true });
    assert.equal(r.appended, true);
    assert.equal(
      fs.readFileSync(path.join(dataDir, 'log.md'), 'utf8'),
      'line1\nline2\n',
    );
  });

  it('append mode creates the file when it does not exist yet', () => {
    const r = writeReportFile(dataDir, 'fresh.md', 'first\n', { append: true });
    assert.equal(r.appended, true);
    assert.equal(fs.readFileSync(path.join(dataDir, 'fresh.md'), 'utf8'), 'first\n');
  });

  it('overwrite (default) replaces existing content', () => {
    writeReportFile(dataDir, 'f.md', 'old-content');
    writeReportFile(dataDir, 'f.md', 'new');
    assert.equal(fs.readFileSync(path.join(dataDir, 'f.md'), 'utf8'), 'new');
  });
});

describe('writeReportFile — traversal rejection (WARDEN-96 lexical)', () => {
  beforeEach(freshDirs);

  it('rejects ../ traversal that escapes the data dir', () => {
    assert.throws(
      () => writeReportFile(dataDir, '../evil.txt', 'x'),
      /outside/i,
    );
    assert.equal(fs.existsSync(path.join(outside, 'evil.txt')), false);
  });

  it('rejects an absolute path', () => {
    assert.throws(
      () => writeReportFile(dataDir, '/etc/passwd', 'x'),
      /relative/i,
    );
  });

  it('rejects prefix-sibling traversal (a name that merely extends the data dir)', () => {
    // Regression for the cwd-glob-without-separator hole: a path whose string
    // STARTS WITH the data dir name but is a sibling outside it must be refused.
    const base = path.basename(dataDir);
    assert.throws(
      () => writeReportFile(dataDir, `../${base}-secret.txt`, 'TOPSECRET'),
      /outside/i,
    );
    // No file materialized anywhere by that name.
    assert.equal(
      fs.existsSync(`${dataDir}-secret.txt`),
      false,
    );
  });

  it('rejects an empty or whitespace-only path', () => {
    assert.throws(() => writeReportFile(dataDir, '', 'x'), /required/i);
    assert.throws(() => writeReportFile(dataDir, '   ', 'x'), /required/i);
  });
});

describe('writeReportFile — symlink escapes (WARDEN-96 realpath)', () => {
  beforeEach(freshDirs);

  it('rejects a target symlink inside the data dir pointing outside', () => {
    // WARDEN-96 recipe: link INSIDE dataDir → a file OUTSIDE it. This passes the
    // lexical startsWith check (the link path is in-bounds), so it can only be
    // caught by resolving the symlink with realpathSync.native first. If that
    // resolution is missing, writeFileSync follows the link and creates the
    // outside file — which this test asserts does NOT happen.
    const target = path.join(outside, 'stolen.txt');
    fs.symlinkSync(target, path.join(dataDir, 'escape.md'));

    assert.throws(
      () => writeReportFile(dataDir, 'escape.md', 'evil'),
      /symlink|outside/i,
    );
    assert.equal(fs.existsSync(target), false, 'must not write through the symlink');
  });

  it('rejects a symlink whose outside TARGET already exists (overwrite escape)', () => {
    // The literal WARDEN-96 recipe (ln -s <existing-outside-file> link): the link
    // target exists, so without symlink resolution the write would OVERWRITE the
    // outside file. realpathSync.native resolves the existing target and the
    // bounds check rejects it.
    const target = path.join(outside, 'secret.md');
    fs.writeFileSync(target, 'KEEP ME\n');
    fs.symlinkSync(target, path.join(dataDir, 'steal.md'));

    assert.throws(
      () => writeReportFile(dataDir, 'steal.md', 'evil'),
      /symlink|outside/i,
    );
    // The outside file must be untouched.
    assert.equal(fs.readFileSync(target, 'utf8'), 'KEEP ME\n');
  });

  it('rejects a symlinked DIRECTORY inside the data dir that points outside', () => {
    // Mid-path escape: dataDir/reports-link → an outside dir. The requested path
    // dataDir/reports-link/x.md looks in-bounds lexically; only realpath of the
    // existing ancestor (reports-link) reveals it lands outside.
    const outsideDir = path.join(outside, 'out-dir');
    fs.mkdirSync(outsideDir);
    fs.symlinkSync(outsideDir, path.join(dataDir, 'reports-link'));

    assert.throws(
      () => writeReportFile(dataDir, 'reports-link/x.md', 'evil'),
      /symlink|outside/i,
    );
    assert.equal(
      fs.existsSync(path.join(outsideDir, 'x.md')),
      false,
      'must not write into the escaped directory',
    );
  });

  it('still ALLOWS an in-bounds symlink (does not over-reject)', () => {
    // A symlink whose target is itself within the data dir is legitimate and
    // must work — proves the resolver follows symlinks and re-checks bounds,
    // rather than blindly refusing all symlinks.
    const realSub = path.join(dataDir, 'real-reports');
    fs.mkdirSync(realSub);
    fs.symlinkSync(realSub, path.join(dataDir, 'reports'));

    const r = writeReportFile(dataDir, 'reports/a.md', 'hi');
    assert.equal(r.ok, true);
    assert.equal(fs.readFileSync(path.join(realSub, 'a.md'), 'utf8'), 'hi');
  });
});

describe('Observer._execTool write_file (integration via handler)', () => {
  let obs;
  beforeEach(() => {
    // DATA_DIR points at the throwaway HOME set before import.
    fs.mkdirSync(DATA_DIR, { recursive: true });
    obs = new Observer({ hosts: [] }, {});
  });

  it('writes through the tool handler using the module DATA_DIR', async () => {
    const out = await obs._execTool('write_file', {
      path: 'reports/via-handler.md',
      content: 'handled',
    });
    assert.equal(out.ok, true);
    assert.equal(
      fs.readFileSync(path.join(DATA_DIR, 'reports/via-handler.md'), 'utf8'),
      'handled',
    );
  });

  it('surfaces a rejected path as { error } (no silent failure — WARDEN-89)', async () => {
    const out = await obs._execTool('write_file', {
      path: '../escape.md',
      content: 'x',
    });
    assert.equal(out.ok, undefined, 'must not report ok on a rejected write');
    assert.match(out.error, /outside/i);
  });

  it('appends when append: true is passed through the handler', async () => {
    await obs._execTool('write_file', { path: 'h.md', content: 'a' });
    const out = await obs._execTool('write_file', { path: 'h.md', content: 'b', append: true });
    assert.equal(out.appended, true);
    assert.equal(fs.readFileSync(path.join(DATA_DIR, 'h.md'), 'utf8'), 'ab');
  });
});

// Clean up the throwaway HOME so repeated runs / the full suite don't accumulate
// temp dirs. (Best-effort; test-runner process exit handles the rest.)
afterEach(() => {
  for (const d of [dataDir, outside]) {
    if (d) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  }
});
