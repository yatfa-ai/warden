import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Regression tests for /api/read-file (WARDEN-39). The original PR failed QA
// because the server could not even start: the remote shell script was a JS
// template literal containing a bash `${RESOLVED##*.}` parameter expansion,
// which collides with JS `${...}` interpolation. Three more latent bugs hid
// behind that parse error: (1) the already-quoted shellQuote() output was
// wrapped in double quotes so the literal single-quotes landed inside the
// variable value, breaking realpath; (2) error diagnostics are echoed to
// stdout while the handler read stderr; (3) `isBinaryFile(path)` shadowed the
// `path` node module, throwing on every local read. These tests pin all four.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(__dirname, 'server.js');

// Redirect HOME so importing server.js (which reads config/catalog and rotates
// activity logs at module load) touches only a temp dir, never the real
// ~/.yatfa-warden. Top-level await lets us import AFTER setting HOME.
process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-rf-home-'));
const { isBinaryFile, buildReadFileScript } = await import('./server.js');

// --- Syntax guard: server.js MUST compile ---------------------------------
// This is the exact failure QA reported ("Missing } in template expression").
// `node --check` parses without executing, so it's a clean, side-effect-free
// regression guard for the template-literal interpolation bug.
describe('server.js compiles', () => {
  it('passes node --check (no template-literal interpolation error)', () => {
    const r = spawnSync(process.execPath, ['--check', SERVER], { encoding: 'utf8' });
    assert.equal(r.status, 0, `server.js failed to parse:\n${r.stderr}`);
  });
});

describe('isBinaryFile', () => {
  it('treats source/text extensions as non-binary', () => {
    for (const f of ['a.js', 'b.ts', 'c.md', 'd.txt', 'e.json', 'noext', 'README']) {
      assert.equal(isBinaryFile(f), false, `${f} should not be binary`);
    }
  });

  it('treats known binary extensions as binary', () => {
    for (const f of ['a.png', 'b.JPG', 'c.EXE', 'd.zip', 'e.pdf', 'f.woff2', 'g.so']) {
      assert.equal(isBinaryFile(f), true, `${f} should be binary`);
    }
  });

  it('does not throw (regression: the `path` param shadowed the node module)', () => {
    assert.doesNotThrow(() => isBinaryFile('/anything/here.txt'));
  });
});

// Run the generated remote script under a real bash in a temp cwd and return
// { ok, stdout }. Mirrors what `run(host, script)` would execute over SSH.
function runScript(cwd, filePath) {
  const script = buildReadFileScript(cwd, filePath);
  // Run through `bash -lc` exactly like ssh.js does for remote hosts.
  const r = spawnSync('bash', ['-lc', script], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  return { ok: r.status === 0, stdout: r.stdout || '', stderr: r.stderr || '' };
}

describe('buildReadFileScript (remote SSH script)', () => {
  let tmp;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-rf-cwd-'));
    fs.writeFileSync(path.join(tmp, 'hello.txt'), 'hello world\n');
    fs.mkdirSync(path.join(tmp, 'sub'));
    fs.writeFileSync(path.join(tmp, 'pic.png'), 'not really png');
  });

  it('does not double-wrap shellQuote output (regression: CWD="\'...\'")', () => {
    const script = buildReadFileScript('/a/b', 'c.txt');
    // shellQuote yields '/a/b' — the assignment must be CWD='/a/b', NOT CWD="'/a/b'"
    assert.match(script, /CWD='\/a\/b';/);
    assert.doesNotMatch(script, /CWD="'\/a\/b'"/);
  });

  it('emits the bash extension expansion literally (regression: `${RESOLVED##*.}`)', () => {
    const script = buildReadFileScript('/a/b', 'c.txt');
    // The `\${...}` escape must produce a literal `${RESOLVED##*.}` for bash,
    // not be evaluated as a JS template expression.
    assert.ok(script.includes('${RESOLVED##*.}'), 'script must contain bash ${RESOLVED##*.}');
  });

  it('safely quotes paths containing spaces', () => {
    const script = buildReadFileScript('/a/b c', 'd e.txt');
    // spaces survive single-quoting; no double-wrap
    assert.ok(script.includes("/a/b c'"));
  });

  it('reads an existing file under cwd', () => {
    const r = runScript(tmp, 'hello.txt');
    assert.equal(r.ok, true, `expected ok, stderr=${r.stderr}`);
    assert.equal(r.stdout, 'hello world\n');
  });

  it('errors on a missing file', () => {
    const r = runScript(tmp, 'nope.txt');
    assert.equal(r.ok, false);
    assert.match(r.stdout, /ERROR file not found/);
  });

  it('blocks path traversal outside cwd', () => {
    const r = runScript(tmp, '../../etc/hostname');
    assert.equal(r.ok, false);
    assert.match(r.stdout, /ERROR path must be within working directory/);
  });

  it('blocks prefix-sibling traversal (regression: cwd glob had no separator)', () => {
    // Regression for a security hole the prior review caught: the cwd-containment
    // `case` glob was "$RESOLVED_CWD"* with NO path separator, so it matched any
    // path whose string STARTS WITH the cwd — including a sibling whose name
    // merely extends the cwd name. cwd = .../<base>; create .../<base>-secret.txt
    // (a file OUTSIDE cwd) and request it via ../<base>-secret.txt. The buggy
    // glob read it (ok:true); the fixed "$RESOLVED_CWD"/* glob must reject it.
    const base = path.basename(tmp);
    const sibling = `${tmp}-secret.txt`;
    fs.writeFileSync(sibling, 'TOPSECRET\n');
    const r = runScript(tmp, `../${base}-secret.txt`);
    assert.equal(r.ok, false, 'sibling extending the cwd name must be rejected');
    assert.match(r.stdout, /ERROR path must be within working directory/);
  });

  it('rejects a directory', () => {
    const r = runScript(tmp, 'sub');
    assert.equal(r.ok, false);
    assert.match(r.stdout, /ERROR path is a directory/);
  });

  it('rejects a binary file by extension', () => {
    const r = runScript(tmp, 'pic.png');
    assert.equal(r.ok, false);
    assert.match(r.stdout, /ERROR cannot read binary files/);
  });
});
