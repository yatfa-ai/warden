import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Tests for the WARDEN-227 in-terminal file linkifier's backend:
//   - buildFileExistsScript: the remote (SSH) existence probe — the lightweight
//     twin of buildReadFileScript (same realpath + cwd-containment + is-file
//     guards, no size/binary/cat).
//   - resolveLocalFile: the factored LOCAL resolution now shared by /api/read-file
//     and /api/file-exists (realpath + cwd-containment + is-file).
// The security must-haves are pinned here exactly as read-file.test.js pins
// buildReadFileScript: the cwd-containment `case` glob MUST include the separator
// (else the prefix-sibling traversal hole reopens), and the script must never move
// file bytes (existence-only).

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(__dirname, 'server.js');

// Redirect HOME so importing server.js (which reads config/catalog and rotates
// activity logs at module load) touches only a temp dir, never the real
// ~/.yatfa-warden. Top-level await lets us import AFTER setting HOME.
process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-fe-home-'));
const { buildFileExistsScript, resolveLocalFile } = await import('./server.js');

// --- Syntax guard: server.js MUST compile ---------------------------------
// Mirrors read-file.test.js: `node --check` parses without executing, a clean
// regression guard for any template-literal interpolation slip in buildFileExistsScript.
describe('server.js compiles', () => {
  it('passes node --check (no template-literal interpolation error)', () => {
    const r = spawnSync(process.execPath, ['--check', SERVER], { encoding: 'utf8' });
    assert.equal(r.status, 0, `server.js failed to parse:\n${r.stderr}`);
  });
});

// Run the generated remote script under a real bash in a temp cwd and return
// { ok, stdout }. Mirrors what `run(host, script)` would execute over SSH.
function runScript(cwd, filePath) {
  const script = buildFileExistsScript(cwd, filePath);
  const r = spawnSync('bash', ['-lc', script], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  return { ok: r.status === 0, stdout: r.stdout || '', stderr: r.stderr || '' };
}

describe('buildFileExistsScript (remote SSH existence probe)', () => {
  let tmp;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-fe-cwd-'));
    fs.writeFileSync(path.join(tmp, 'hello.txt'), 'hello world\n');
    fs.mkdirSync(path.join(tmp, 'sub'));
    fs.writeFileSync(path.join(tmp, 'pic.png'), 'not really png');
  });

  it('does not double-wrap shellQuote output (regression carried from buildReadFileScript)', () => {
    const script = buildFileExistsScript('/a/b', 'c.txt');
    assert.match(script, /CWD='\/a\/b';/);
    assert.doesNotMatch(script, /CWD="'\/a\/b'"/);
  });

  it('never reads or transfers file content (existence-only)', () => {
    // The probe must NOT cat the file — its stdout is just the EXISTS marker, not
    // the file's bytes. This is what makes it cheap enough to run per candidate.
    const r = runScript(tmp, 'hello.txt');
    assert.equal(r.ok, true, `expected ok, stderr=${r.stderr}`);
    assert.equal(r.stdout, 'EXISTS\n');
    assert.equal(r.stdout.includes('hello world'), false, 'must not leak file content');
  });

  it('reports EXISTS for a real file under cwd', () => {
    const r = runScript(tmp, 'hello.txt');
    assert.equal(r.ok, true);
    assert.match(r.stdout, /EXISTS/);
  });

  it('errors on a missing file (no false EXISTS)', () => {
    const r = runScript(tmp, 'nope.txt');
    assert.equal(r.ok, false);
    assert.match(r.stdout, /ERROR file not found/);
    assert.equal(r.stdout.includes('EXISTS'), false);
  });

  it('blocks path traversal outside cwd', () => {
    const r = runScript(tmp, '../../etc/hostname');
    assert.equal(r.ok, false);
    assert.match(r.stdout, /ERROR path must be within working directory/);
  });

  it('blocks prefix-sibling traversal (regression: cwd glob had no separator)', () => {
    // The same security hole read-file.test.js pins: a cwd-containment glob with
    // no separator accepts a sibling whose name merely extends the cwd. The fixed
    // "$RESOLVED_CWD"/* glob must reject it here too.
    const base = path.basename(tmp);
    const sibling = `${tmp}-secret.txt`;
    fs.writeFileSync(sibling, 'TOPSECRET\n');
    const r = runScript(tmp, `../${base}-secret.txt`);
    assert.equal(r.ok, false, 'sibling extending the cwd name must be rejected');
    assert.match(r.stdout, /ERROR path must be within working directory/);
  });

  it('rejects a directory (only regular files are clickable)', () => {
    const r = runScript(tmp, 'sub');
    assert.equal(r.ok, false);
    assert.match(r.stdout, /ERROR path is a directory/);
    assert.equal(r.stdout.includes('EXISTS'), false);
  });

  it('accepts a file whose name looks binary by extension (existence ≠ readable)', () => {
    // Unlike read-file (which refuses to cat binaries), existence is about whether
    // the path resolves to a file at all — a .png on disk IS a real file, so the
    // linkifier should offer it even though opening it would later 400 in read-file.
    const r = runScript(tmp, 'pic.png');
    assert.equal(r.ok, true);
    assert.match(r.stdout, /EXISTS/);
  });
});

describe('resolveLocalFile (shared local resolution)', () => {
  let tmp;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-fe-resolve-'));
    fs.writeFileSync(path.join(tmp, 'real.txt'), 'data\n');
    fs.mkdirSync(path.join(tmp, 'adir'));
  });

  it('resolves an existing file under cwd (ok + resolvedPath)', () => {
    const r = resolveLocalFile(tmp, 'real.txt');
    assert.equal(r.ok, true);
    assert.equal(typeof r.resolvedPath, 'string');
    assert.equal(fs.realpathSync.native(path.join(tmp, 'real.txt')), r.resolvedPath);
  });

  it('returns 404 for a missing file', () => {
    const r = resolveLocalFile(tmp, 'missing.txt');
    assert.equal(r.ok, false);
    assert.equal(r.status, 404);
  });

  it('returns 403 for a path outside cwd (containment guard)', () => {
    const r = resolveLocalFile(tmp, '../../etc/hostname');
    assert.equal(r.ok, false);
    assert.equal(r.status, 403);
  });

  it('blocks prefix-sibling traversal (the local twin of the remote guard)', () => {
    const base = path.basename(tmp);
    const sibling = `${tmp}-secret.txt`;
    fs.writeFileSync(sibling, 'TOPSECRET\n');
    const r = resolveLocalFile(tmp, `../${base}-secret.txt`);
    assert.equal(r.ok, false);
    assert.equal(r.status, 403);
  });

  it('rejects a directory (only regular files resolve)', () => {
    const r = resolveLocalFile(tmp, 'adir');
    assert.equal(r.ok, false);
    assert.equal(r.status, 400);
    assert.match(r.error, /directory/);
  });

  it('follows symlinks and rejects one that escapes cwd', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-fe-outside-'));
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'nope\n');
    // Symlink inside cwd pointing outside cwd → containment guard must reject it
    // after realpath resolves the target (mirrors /api/read-file's symlink defense).
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(tmp, 'escape.txt'));
    const r = resolveLocalFile(tmp, 'escape.txt');
    assert.equal(r.ok, false);
    assert.equal(r.status, 403);
  });
});
