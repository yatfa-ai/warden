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
const { buildFileExistsScript, resolveLocalFile, expandChatFilePath } = await import('./server.js');

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
// `env` (optional) REPLACES the environment for the child — the WARDEN-1258
// tilde tests drive a controlled $HOME so `~` expansion is observable without
// touching the real home directory of whoever runs the suite.
function runScript(cwd, filePath, env) {
  const script = buildFileExistsScript(cwd, filePath);
  const r = spawnSync('bash', ['-lc', script], {
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
    ...(env ? { env } : {}),
  });
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

  // --- WARDEN-1258 — absolute and `~` paths resolve correctly, then pass the
  // UNCHANGED cwd-containment guard ------------------------------------------
  // The remote branch used to fail these two shapes with the same visible
  // outcome (probe answers no, link never gains its affordance): a `~` never
  // expanded because the path traveled inside single quotes. The fix expands
  // `~` to the REMOTE $HOME via bash parameter expansion on the $FILE variable
  // (TILDE_PREFIX_CASE) — the quoting around the user-supplied value is NOT
  // removed, so the injection hardening survives. These tests run the script
  // with a controlled HOME so the remote expansion is observable.
  describe('absolute and ~ paths (WARDEN-1258)', () => {
    let home;
    let ops;
    let env;
    beforeEach(() => {
      home = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-fe-home1258-'));
      ops = path.join(home, 'ops');
      fs.mkdirSync(path.join(ops, 'infra'), { recursive: true });
      fs.writeFileSync(path.join(ops, 'infra', 'configmap.yaml'), 'apiVersion: v1\n');
      fs.writeFileSync(path.join(home, 'secret-key.pem'), 'TOPSECRET\n');
      fs.writeFileSync(`${ops}-secret.txt`, 'TOPSECRET\n');
      env = { ...process.env, HOME: home };
    });

    it('expands ~/… to $HOME and reports EXISTS when it lands inside cwd', () => {
      const r = runScript(ops, '~/ops/infra/configmap.yaml', env);
      assert.equal(r.ok, true, `expected ok, stdout=${r.stdout} stderr=${r.stderr}`);
      assert.match(r.stdout, /EXISTS/);
    });

    it('reports EXISTS for an absolute path inside cwd', () => {
      const r = runScript(ops, path.join(ops, 'infra', 'configmap.yaml'), env);
      assert.equal(r.ok, true, `expected ok, stdout=${r.stdout}`);
      assert.match(r.stdout, /EXISTS/);
    });

    it('still rejects a ~ path leading OUTSIDE cwd (containment after expansion)', () => {
      // ~/secret-key.pem under a cwd of ~/ops: expansion happens FIRST, the
      // unchanged separator-bearing containment clause rejects the result —
      // the exact `~/.ssh/id_rsa` escape the ticket pins as still-blocked.
      const r = runScript(ops, '~/secret-key.pem', env);
      assert.equal(r.ok, false, 'a ~ leading outside cwd must not exist');
      assert.match(r.stdout, /ERROR path must be within working directory/);
      assert.equal(r.stdout.includes('EXISTS'), false);
    });

    it('still rejects an absolute path outside cwd', () => {
      const r = runScript(ops, path.join(home, 'secret-key.pem'), env);
      assert.equal(r.ok, false);
      assert.match(r.stdout, /ERROR path must be within working directory/);
    });

    it('still blocks a prefix-sibling reached via ~ (separator-bearing guard)', () => {
      // ~/ops-secret.txt vs cwd ~/ops — the sibling whose name merely extends
      // the cwd. The guard's `/*` arm must refuse it exactly as the relative
      // form does.
      const r = runScript(ops, '~/ops-secret.txt', env);
      assert.equal(r.ok, false);
      assert.match(r.stdout, /ERROR path must be within working directory/);
    });

    it('still rejects a symlink inside cwd that escapes via ~ resolution', () => {
      const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-fe-out1258-'));
      fs.writeFileSync(path.join(outside, 'secret.txt'), 'nope\n');
      fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(ops, 'escape.txt'));
      const r = runScript(ops, '~/ops/escape.txt', env);
      assert.equal(r.ok, false, 'symlink escaping cwd must be rejected after resolution');
      assert.match(r.stdout, /ERROR path must be within working directory/);
    });

    it('does NOT expand a ~user prefix (stays literal, probe answers no)', () => {
      // `~alice/ops/infra/configmap.yaml` must NOT become `$HOME`alice/… — bash
      // cannot expand a tilde-USER prefix here by design, and the local branch
      // refuses it too (expandChatFilePath), so the two branches agree.
      const r = runScript(ops, '~alice/ops/infra/configmap.yaml', env);
      assert.equal(r.ok, false);
      assert.match(r.stdout, /ERROR file not found/);
    });

    it('keeps the injection hardening: a hostile ~ payload stays a literal string', () => {
      // The quoting around the user-supplied value is NOT removed to achieve
      // expansion — the case statement expands the VARIABLE, so metacharacters
      // in the payload never reach a parsing context. The script text must keep
      // the single-quoted assignment, and running the payload must fail cleanly
      // (file not found) rather than execute anything.
      const marker = path.join(os.tmpdir(), 'warden-fe-pwned-marker');
      const payload = `~/$(touch ${marker})/x.txt`;
      const script = buildFileExistsScript('/a/b', payload);
      const quoted = payload.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      assert.match(script, new RegExp(`FILE='${quoted}'`),
        'payload must remain single-quoted in the assignment');
      const r = runScript(ops, payload, env);
      assert.equal(r.ok, false);
      assert.match(r.stdout, /ERROR file not found/);
      assert.equal(fs.existsSync(marker), false,
        'command substitution in the payload must never execute');
    });
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

// --- WARDEN-1258: the LOCAL twin of the remote block above. Identical
// observable behaviour across the two branches is pinned by mirroring the
// same positive/negative matrix here. The local branch used to JOIN every
// candidate onto cwd: an absolute path was silently relocated INSIDE cwd and
// a `~` stayed a literal filename character, so both shapes always missed.
describe('resolveLocalFile — absolute and ~ paths (WARDEN-1258)', () => {
  let home;
  let ops;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-fe-home1258l-'));
    ops = path.join(home, 'ops');
    fs.mkdirSync(path.join(ops, 'infra'), { recursive: true });
    fs.writeFileSync(path.join(ops, 'infra', 'configmap.yaml'), 'apiVersion: v1\n');
    fs.writeFileSync(path.join(home, 'secret-key.pem'), 'TOPSECRET\n');
    fs.writeFileSync(`${ops}-secret.txt`, 'TOPSECRET\n');
  });

  // resolveLocalFile expands `~` via os.homedir(), which reads $HOME at call
  // time on POSIX — point it at the fake home for the duration of each call.
  // (The outer suite's HOME is already a temp dir, so restore-then-return is
  // enough; nothing real is ever touched.)
  const withFakeHome = (fn) => {
    const prev = process.env.HOME;
    process.env.HOME = home;
    try { return fn(); } finally { process.env.HOME = prev; }
  };

  it('expands ~/… via os.homedir() and resolves when it lands inside cwd', () => {
    const r = withFakeHome(() => resolveLocalFile(ops, '~/ops/infra/configmap.yaml'));
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.resolvedPath, path.join(ops, 'infra', 'configmap.yaml'));
  });

  it('resolves an absolute path inside cwd (never joined onto cwd)', () => {
    const r = resolveLocalFile(ops, path.join(ops, 'infra', 'configmap.yaml'));
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.resolvedPath, path.join(ops, 'infra', 'configmap.yaml'));
  });

  it('rejects a ~ path leading OUTSIDE cwd with 403 (containment after expansion)', () => {
    const r = withFakeHome(() => resolveLocalFile(ops, '~/secret-key.pem'));
    assert.equal(r.ok, false);
    assert.equal(r.status, 403);
  });

  it('rejects an absolute path outside cwd with 403 even though the file exists', () => {
    // The file is REAL and outside cwd — before WARDEN-1258 the join onto cwd
    // relocated it to a nonexistent <cwd>/… and 404'd; now it resolves to its
    // true location and the unchanged containment clause rejects it.
    const r = resolveLocalFile(ops, path.join(home, 'secret-key.pem'));
    assert.equal(r.ok, false);
    assert.equal(r.status, 403);
  });

  it('blocks a prefix-sibling reached via ~ (separator-bearing guard)', () => {
    const r = withFakeHome(() => resolveLocalFile(ops, '~/ops-secret.txt'));
    assert.equal(r.ok, false);
    assert.equal(r.status, 403);
  });

  it('rejects a symlink inside cwd that escapes via ~ resolution', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-fe-out1258l-'));
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'nope\n');
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(ops, 'escape.txt'));
    const r = withFakeHome(() => resolveLocalFile(ops, '~/ops/escape.txt'));
    assert.equal(r.ok, false);
    assert.equal(r.status, 403);
  });

  it('does NOT resolve a ~user prefix (stays literal → 404)', () => {
    const r = resolveLocalFile(ops, '~alice/ops/infra/configmap.yaml');
    assert.equal(r.ok, false);
    assert.equal(r.status, 404);
  });
});

describe('expandChatFilePath (pure pre-resolution expansion, WARDEN-1258)', () => {
  it('~ alone expands to the home directory', () => {
    assert.equal(expandChatFilePath('/x/cwd', '~', '/home/u'), '/home/u');
  });

  it('~/rest joins onto the home directory', () => {
    assert.equal(expandChatFilePath('/x/cwd', '~/ops/a.yaml', '/home/u'), path.join('/home/u', 'ops/a.yaml'));
  });

  it('an absolute path is returned AS-IS (never joined onto cwd)', () => {
    assert.equal(expandChatFilePath('/x/cwd', '/etc/hosts'), '/etc/hosts');
  });

  it('a relative path joins onto cwd (unchanged behaviour)', () => {
    assert.equal(expandChatFilePath('/x/cwd', 'a/b.yaml'), path.join('/x/cwd', 'a/b.yaml'));
  });

  it('a ~user prefix is NOT expanded (stays literal and joins onto cwd)', () => {
    assert.equal(expandChatFilePath('/x/cwd', '~alice/a.yaml', '/home/u'), path.join('/x/cwd', '~alice/a.yaml'));
  });

  it('falls back to os.homedir() when homeDir is omitted', () => {
    assert.equal(expandChatFilePath('/x/cwd', '~'), os.homedir());
  });
});
