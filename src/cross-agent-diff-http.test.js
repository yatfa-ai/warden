import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * End-to-end HTTP tests for /api/cross-agent-diff (WARDEN-593) — the direct A↔B
 * working-tree compare that answers the one question a same-file collision raises:
 * do two agents' edits collide on the same lines, or are they disjoint?
 *
 * Boots the REAL Express app (server.app) against a temp HOME with a catalog of two
 * LOCAL manual chats (A and B, each its own repo cwd), then GETs
 * `/api/cross-agent-diff?idA=&idB=&path=` and asserts the contract for every case
 * the collision dialog can hit. This is the LOCAL code path end-to-end
 * (readWorkingTreeFile → resolveLocalFile + size/binary guards → diffNoIndex →
 * `git diff --no-index`); the REMOTE (SSH) read path is buildReadFileScript, exercised
 * in read-file.test.js — driving a real SSH host here is out of scope (none in CI).
 *
 * Mirrors src/git-range-diff.test.js / src/read-file-http.test.js's HOME-freezing
 * isolation: server.js evaluates `const cfg = load()` at module load, so config +
 * catalog must be written BEFORE the single import. Do NOT re-import server.js under
 * a second HOME.
 *
 * Covered acceptance criteria (the ticket's test plan):
 *   - differing working trees  → non-empty diff (exit 1 is SUCCESS, surfaced as a diff)
 *   - identical working trees  → empty diff '' + no error (exit 0; "no conflict")
 *   - one side missing         → { diff: null, error: 'B: file not found' }, never 500
 *   - one/both sides binary    → { diff: null, error: /binary/ }, never 500
 *   - >1MB diff                → capped to ≤1MB via capDiff (200, no error)
 *   - path-containment reject  → { diff: null, error: 'A: path must be within ...' }
 *   - missing params           → 400
 *   - unknown chat id          → 404
 */

let httpServer;
let baseUrl;
let originalHome;
let tempHome;
let repoA;
let repoB;

before(async () => {
  originalHome = process.env.HOME;
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-crossagent-'));
  process.env.HOME = tempHome;

  const wardenDir = path.join(tempHome, '.yatfa-warden');
  fs.mkdirSync(wardenDir, { recursive: true });
  fs.writeFileSync(path.join(wardenDir, 'config.json'), JSON.stringify({ hosts: [] }));

  // Two repo cwds representing two agents racing on the same paths.
  repoA = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-crossagent-A-'));
  repoB = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-crossagent-B-'));

  // collide.js — DIFFERENT content on each side (the true-conflict / overlap case).
  // `git diff --no-index` exits 1 here; the route must treat that as success.
  fs.writeFileSync(path.join(repoA, 'collide.js'), 'a\nb\nc\n');
  fs.writeFileSync(path.join(repoB, 'collide.js'), 'a\nB\nc\n');

  // same.txt — IDENTICAL content (the false-alarm case). exit 0 → empty diff →
  // the genuine "both made the same change, no conflict" signal.
  fs.writeFileSync(path.join(repoA, 'same.txt'), 'shared line\n');
  fs.writeFileSync(path.join(repoB, 'same.txt'), 'shared line\n');

  // onlyA.js — exists ONLY on side A. B's read fails (ENOENT) → never a 500.
  fs.writeFileSync(path.join(repoA, 'onlyA.js'), 'export const x = 1;\n');

  // pic.png — a binary-by-extension file on BOTH sides. The extension guard
  // rejects before read → 'binary file' (A is checked first).
  fs.writeFileSync(path.join(repoA, 'pic.png'), 'not really png A');
  fs.writeFileSync(path.join(repoB, 'pic.png'), 'not really png B');

  // big.txt — two ≤1MB files (under the per-file read cap) whose diff is >1MB so
  // capDiff's 1MB output guard is exercised. 90000 × 11-byte lines = 990000 bytes
  // per side; the diff (90000 deletions + 90000 additions) is ~2MB → capped.
  const bigLine = (ch) => `${ch.repeat(10)}\n`;
  fs.writeFileSync(path.join(repoA, 'big.txt'), bigLine('a').repeat(90000));
  fs.writeFileSync(path.join(repoB, 'big.txt'), bigLine('z').repeat(90000));

  // Catalog with two LOCAL manual chats, resolved by bare session id (no ':'
  // prefix) so no host/tmux discovery runs.
  fs.writeFileSync(
    path.join(wardenDir, 'chats.json'),
    JSON.stringify([
      { host: '(local)', session: 'warden-a', cwd: repoA, cmd: 'bash', name: 'warden-a' },
      { host: '(local)', session: 'warden-b', cwd: repoB, cmd: 'bash', name: 'warden-b' },
    ]),
  );

  // Import server.js ONCE — after HOME/config/catalog/repos are in place.
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
  for (const d of [repoA, repoB, tempHome]) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

async function diff(idA, idB, filePath) {
  const url = `${baseUrl}/api/cross-agent-diff?idA=${encodeURIComponent(idA)}&idB=${encodeURIComponent(idB)}&path=${encodeURIComponent(filePath)}`;
  const res = await fetch(url);
  return { status: res.status, body: await res.json() };
}

describe('/api/cross-agent-diff — differing working trees (exit 1 → diff)', () => {
  it('returns a non-empty unified diff of the two sides (200, no error)', async () => {
    const { status, body } = await diff('warden-a', 'warden-b', 'collide.js');
    assert.strictEqual(status, 200);
    assert.strictEqual(body.error, null);
    assert.ok(typeof body.diff === 'string' && body.diff.length > 0, 'diff must be non-empty text');
    // The changed line surfaces on both sides: the removal (side A) and the
    // addition (side B). Proves `git diff --no-index` exit 1 was treated as success.
    assert.match(body.diff, /^-b$/m, 'diff must include the removed line from A');
    assert.match(body.diff, /^\+B$/m, 'diff must include the added line from B');
    // The temp-file sides are labeled A-/B- in the diff header.
    assert.match(body.diff, /A-collide\.js/, 'header must label side A');
    assert.match(body.diff, /B-collide\.js/, 'header must label side B');
  });
});

describe('/api/cross-agent-diff — identical working trees (exit 0 → empty diff)', () => {
  it('returns an empty diff "" (200, no error) — the no-conflict signal', async () => {
    const { status, body } = await diff('warden-a', 'warden-b', 'same.txt');
    assert.strictEqual(status, 200);
    assert.strictEqual(body.error, null);
    // Identical content → `git diff --no-index` exits 0 with empty stdout. An empty
    // diff (NOT null) is the genuine signal the frontend renders as "no conflict".
    assert.strictEqual(body.diff, '');
  });
});

describe('/api/cross-agent-diff — never a 500 (read failures surface as error strings)', () => {
  it('returns { diff: null, error: "B: file not found" } when side B is missing (200)', async () => {
    // onlyA.js exists only in repoA → B's read fails ENOENT. The side prefix tells
    // the human WHICH agent's read failed.
    const { status, body } = await diff('warden-a', 'warden-b', 'onlyA.js');
    assert.strictEqual(status, 200);
    assert.strictEqual(body.diff, null);
    assert.strictEqual(body.error, 'B: file not found');
  });

  it('returns { diff: null, error: /binary/ } for a binary-by-extension file (200)', async () => {
    // pic.png on both sides → the extension guard rejects before read. A is checked
    // first, so the error names side A.
    const { status, body } = await diff('warden-a', 'warden-b', 'pic.png');
    assert.strictEqual(status, 200);
    assert.strictEqual(body.diff, null);
    assert.match(body.error, /binary/);
    assert.match(body.error, /^A:/, 'binary error must be prefixed with the failing side A');
  });

  it('returns { diff: null, error: "A: path must be within working directory" } for traversal (200)', async () => {
    // A path that escapes cwd → resolveLocalFile's containment guard rejects it.
    // Never a 500; the side prefix names A (the first side checked).
    const { status, body } = await diff('warden-a', 'warden-b', '../../etc/passwd');
    assert.strictEqual(status, 200);
    assert.strictEqual(body.diff, null);
    assert.strictEqual(body.error, 'A: path must be within working directory');
  });
});

describe('/api/cross-agent-diff — size cap (capDiff bounds a >1MB diff to ≤1MB)', () => {
  it('caps a >1MB A↔B diff down to ≤1MB (200, no error)', async () => {
    // big.txt: two ≤1MB files whose diff is ~2MB → capDiff (GIT_DIFF_MAX_BYTES, 1MB)
    // bounds the response. Byte-accurate so it never splits a multi-byte sequence.
    const { status, body } = await diff('warden-a', 'warden-b', 'big.txt');
    assert.strictEqual(status, 200);
    assert.strictEqual(body.error, null);
    assert.ok(typeof body.diff === 'string' && body.diff.length > 0, 'capped diff must be non-empty');
    assert.ok(Buffer.byteLength(body.diff) <= 1024 * 1024, 'capped diff must be ≤1MB');
  });
});

describe('/api/cross-agent-diff — request-shape errors', () => {
  it('returns 400 when path is missing', async () => {
    const { status, body } = await diff('warden-a', 'warden-b', '');
    assert.strictEqual(status, 400);
    assert.strictEqual(body.diff, null);
    assert.ok(typeof body.error === 'string' && body.error.length > 0);
  });

  it('returns 400 when idA is missing', async () => {
    const res = await fetch(`${baseUrl}/api/cross-agent-diff?idA=&idB=warden-b&path=collide.js`);
    assert.strictEqual(res.status, 400);
  });

  it('returns 400 when idB is missing', async () => {
    const res = await fetch(`${baseUrl}/api/cross-agent-diff?idA=warden-a&idB=&path=collide.js`);
    assert.strictEqual(res.status, 400);
  });

  it('returns 404 for an unknown chat id (resolve failure)', async () => {
    const { status } = await diff('does-not-exist', 'warden-b', 'collide.js');
    assert.strictEqual(status, 404);
  });

  it('returns 404 (with the failing side prefixed) when idB is unknown', async () => {
    const { status, body } = await diff('warden-a', 'does-not-exist', 'collide.js');
    assert.strictEqual(status, 404);
    assert.strictEqual(body.diff, null);
    assert.match(body.error, /^B:/, 'resolve failure must be prefixed with the failing side B');
  });
});
