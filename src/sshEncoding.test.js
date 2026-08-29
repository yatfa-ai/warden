import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn, execFileSync } from 'node:child_process';
import { run, runLocalTmux } from './ssh.js';

/**
 * Locks the UTF-8 decoder discipline of ssh.js's two capture primitives —
 * `run()` (remote transport) and `runLocalTmux()` (local tmux transport) —
 * against WARDEN-1045.
 *
 * The bug: both accumulated child output with `stdout += d` where `d` is a
 * Buffer. Every `+=` calls Buffer#toString on that chunk IN ISOLATION, with no
 * decoder state carried across chunks. Output that fits in one read cannot
 * corrupt; output that EXCEEDS THE 64KB PIPE BUFFER arrives in several chunks,
 * and any multibyte character straddling a chunk boundary is decoded as two
 * invalid fragments — both replaced with U+FFFD. The character is destroyed
 * irrecoverably. `setEncoding('utf8')` installs a StringDecoder that holds an
 * incomplete trailing sequence back and prepends it to the next chunk.
 *
 * Why this went unnoticed and why these tests are shaped the way they are: the
 * safe and dangerous inputs differ ONLY BY SIZE. A small-output test passes
 * against the defective code by construction, so every gate below drives more
 * than 64KB of genuinely multibyte content and asserts byte-identity against
 * the source. `assert.equal(r.stdout, expected)` is the load-bearing assertion
 * in all three; the U+FFFD counts are diagnostics that make a failure readable.
 *
 * Reach of the defect (no serialization boundary repairs it): runLocalTmux →
 * runTmux → tmux.js read() returns r.stdout VERBATIM → /api/pane (200 lines),
 * /api/pane-export (5000 lines — the transcript the user downloads), observer.js
 * read_chat, and cli.js. `res.json` passes the string through unchanged and
 * U+FFFD is valid JSON, so the corruption is silent all the way to the user.
 *
 * Run: node --test src/sshEncoding.test.js   (or `node --test src`)
 */

// A `capture-pane -e`-like payload: box-drawing borders (3-byte), a 4-byte
// emoji, and accented Latin (2-byte), interleaved with ASCII and SGR escapes.
// Same profile as the WARDEN-1045 measurement, where >50% of the bytes of a
// realistic 200-column pane are multibyte continuation bytes.
function paneLike(lines) {
  let s = '';
  for (let i = 0; i < lines; i++) {
    s += `\x1b[36m╭${'─'.repeat(60)}╮\x1b[0m ⎿ ✓ 🚀 │ café — line ${i}\n`;
  }
  return s;
}

const PIPE_BUFFER = 65536; // the read size at which the corruption starts

// Split `buf` INSIDE a multibyte sequence at or after the 64KB pipe boundary:
// walk forward to the first UTF-8 continuation byte (10xxxxxx). Splitting there
// is exactly what a real pipe read does when the boundary lands mid-character.
function splitMidCharacter(buf) {
  let cut = PIPE_BUFFER;
  while (cut < buf.length && (buf[cut] & 0xc0) !== 0x80) cut++;
  assert.ok(cut < buf.length, 'fixture must contain a multibyte char past 64KB');
  return cut;
}

const countFFFD = (s) => (s.match(/�/g) || []).length;
const tick = () => new Promise((r) => setImmediate(r));

// Materialize `content` in a throwaway dir for the duration of `fn`. Both
// empirical gates need the payload on disk: it is far too large to pass through
// argv (~700KB → spawn E2BIG).
async function withFixtureFile(content, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-1045-'));
  try {
    const file = path.join(dir, 'pane.txt');
    fs.writeFileSync(file, content, 'utf8');
    return await fn(file);
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

describe('run() — utf8 decoder state across chunk boundaries (WARDEN-1045)', () => {
  it('gate 1 (deterministic): a multibyte char split across two chunks survives intact', async () => {
    // The DETERMINISTIC gate. A real pipe only splits a character when a read
    // boundary happens to land mid-sequence, which is probabilistic; here we
    // inject the adversarial split directly, so this test is red against the
    // defective code on every machine, every run.
    const expected = paneLike(400);
    const buf = Buffer.from(expected, 'utf8');
    assert.ok(buf.length > PIPE_BUFFER, 'payload must exceed the 64KB pipe buffer');
    const cut = splitMidCharacter(buf);
    const [head, tail] = [buf.subarray(0, cut), buf.subarray(cut)];

    // Self-check that the fixture is genuinely adversarial: decoding the first
    // chunk ALONE — which is precisely what `stdout += d` did — must corrupt.
    // If a future edit makes the split character-aligned this assertion fires
    // rather than letting the test go quietly vacuous.
    assert.ok(head.toString('utf8').includes('�'), 'the split must land inside a multibyte sequence');

    // Real Readable streams (not bare EventEmitters) so `setEncoding` is the
    // production StringDecoder, not a test double: the decode under test is
    // node's own, and without the fix these emit raw Buffers exactly as a real
    // child's pipe does.
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: () => {},
    });
    const p = run('host', 'tmux capture-pane -p -e', { spawn: () => child, timeout: 60000 });

    // One write per tick: each arrives as its own 'data' event, reproducing the
    // two-chunk delivery. (A single write of the whole buffer cannot corrupt —
    // that is the sub-64KB case, which is green against the broken code too.)
    child.stdout.write(head);
    await tick();
    child.stdout.write(tail);
    await tick();
    child.emit('close', 0);

    const r = await p;
    assert.equal(r.ok, true);
    assert.equal(countFFFD(r.stdout), 0, 'no character may be replaced with U+FFFD');
    assert.equal(r.stdout, expected, 'stdout must be byte-identical to the child output — setEncoding must carry decoder state across chunks');
  });

  it('gate 1b (deterministic): stderr carries decoder state across chunks too', async () => {
    const expected = paneLike(400);
    const buf = Buffer.from(expected, 'utf8');
    const cut = splitMidCharacter(buf);
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: () => {},
    });
    const p = run('host', 'some-failing-cmd', { spawn: () => child, timeout: 60000 });
    child.stderr.write(buf.subarray(0, cut));
    await tick();
    child.stderr.write(buf.subarray(cut));
    await tick();
    child.emit('close', 1);
    const r = await p;
    assert.equal(r.ok, false);
    assert.equal(countFFFD(r.stderr), 0);
    assert.equal(r.stderr, expected, 'stderr must be byte-identical too');
  });

  it('gate 2 (empirical): ~700KB of multibyte through a REAL pipe survives intact', async () => {
    // End-to-end over an actual OS pipe, with node's own chunking rather than a
    // hand-placed split. The child binary is irrelevant to the decode (this is
    // libuv pipe reads, not anything about ssh), so we inject a real `spawn` of
    // node itself — ssh is not available in every sandbox and would tell us
    // nothing extra. Payload is large enough (~700KB → ~11 pipe reads) that a
    // character-aligned boundary at EVERY read is vanishingly unlikely: the
    // content is dominated by 3-byte characters, so 2 of every 3 offsets split
    // one. This is the gate that would have caught the /api/pane-export bug in
    // the wild; gate 1 is the one that cannot flake.
    const expected = paneLike(3000);
    assert.ok(Buffer.byteLength(expected) > 10 * PIPE_BUFFER, 'payload must span many pipe reads');
    // The payload goes via a file, not argv — 700KB of argv is spawn E2BIG. The
    // child writes RAW BYTES (readFileSync with no encoding), so the pipe carries
    // the same byte stream a real `tmux capture-pane` would produce.
    const script = 'process.stdout.write(require("fs").readFileSync(process.argv[1]))';
    const r = await withFixtureFile(expected, (file) => {
      const fakeSpawn = () => spawn(
        process.execPath,
        ['-e', script, file],
        { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
      );
      return run('host', 'tmux capture-pane -p -e -S -5000', { spawn: fakeSpawn, timeout: 60000 });
    });

    assert.equal(r.ok, true);
    assert.equal(countFFFD(r.stdout), 0, `real-pipe capture corrupted ${countFFFD(r.stdout)} character(s)`);
    assert.equal(r.stdout.length, expected.length);
    assert.equal(r.stdout, expected, 'stdout must be byte-identical to the child output');
  });
});

// runLocalTmux uses the module-level `spawn` (no injection seam), so its gate is
// against REAL tmux. Skipped automatically where tmux is absent, matching
// src/session-recovery.test.js and src/server-stream-reattach.test.js.
const tmuxPresent = (() => {
  try { execFileSync('tmux', ['-V'], { stdio: ['ignore', 'ignore', 'ignore'] }); return true; } catch { return false; }
})();

describe('runLocalTmux() — utf8 decoder state across chunk boundaries (WARDEN-1045)', { skip: !tmuxPresent && 'tmux not installed' }, () => {
  // `load-buffer` + `show-buffer` is a byte-exact round trip through the very
  // stdout path `capture-pane` uses, without needing a live pane of a known
  // geometry (no wrapping, no scrollback trimming, no waiting for a child to
  // paint). It is the same transport, the same >64KB read, and — unlike a pane
  // capture — the expected bytes are exactly the bytes we supplied, which is
  // what criterion 3 asks us to assert. A paste buffer is server-global, so the
  // name is unique per process and deleted in `after`.
  const bufferName = `warden-enc-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const expected = paneLike(3000);

  // `load-buffer` does NOT auto-start a tmux server — the tmux client only
  // spawns one for commands that create sessions. On a fresh runner (or any
  // host where no session has been created yet and the server has exited after
  // its last session died) a bare `load-buffer` fails with "no server running
  // on /tmp/tmux-<uid>/default" — which is exactly what CI on ubuntu-latest
  // showed: the suite's other tmux tests had torn their sessions down first.
  // A detached throwaway session pins the server open for this suite's
  // duration, and is killed in `after` alongside the buffer cleanup.
  const sessionName = `warden-enc-server-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;

  before(async () => {
    const start = await runLocalTmux(['new-session', '-d', '-s', sessionName], { timeout: 15000 });
    assert.equal(start.ok, true, `could not start a tmux server (new-session failed): ${start.stderr}`);
  });

  after(async () => {
    try { await runLocalTmux(['delete-buffer', '-b', bufferName]); } catch { /* best effort */ }
    try { await runLocalTmux(['kill-session', '-t', sessionName]); } catch { /* best effort */ }
  });

  it('a >64KB multibyte capture comes back byte-identical', async () => {
    assert.ok(Buffer.byteLength(expected) > 10 * PIPE_BUFFER, 'payload must span many pipe reads');
    await withFixtureFile(expected, async (file) => {
      const load = await runLocalTmux(['load-buffer', '-b', bufferName, file], { timeout: 15000 });
      assert.equal(load.ok, true, `load-buffer failed: ${load.stderr}`);
    });

    const r = await runLocalTmux(['show-buffer', '-b', bufferName], { timeout: 15000 });
    assert.equal(r.ok, true, `show-buffer failed: ${r.stderr}`);
    assert.equal(countFFFD(r.stdout), 0, `capture corrupted ${countFFFD(r.stdout)} character(s) — decoder state was not carried across chunks`);
    assert.equal(r.stdout.length, expected.length);
    assert.equal(r.stdout, expected, 'stdout must be byte-identical to what tmux held');
    // The box-drawing count is the user-visible symptom from the ticket: the
    // corruption landed inside a border, mangling the pane the user reads.
    assert.equal((r.stdout.match(/─/g) || []).length, (expected.match(/─/g) || []).length, 'every box-drawing character must survive');
  });
});
