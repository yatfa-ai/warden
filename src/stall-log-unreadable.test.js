import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { readStalls, pruneStallLog, stallLogFile } from './stall-log.js';

/**
 * The UNREADABLE-log legs of stall-log.js: a stalls.jsonl that exists but cannot
 * be read (here: it is a DIRECTORY, so readFile rejects with EISDIR — deterministic
 * even as root, unlike a chmod). stall-log.test.js drives only the ENOENT
 * (healthy, silent) and malformed-line legs.
 *
 * The contract: readStalls NEVER throws — GET /api/diagnostics/stalls and the
 * Electron stall summary both await it bare, so a rejection would 500 the route
 * or abort the summary; it degrades to [] with one `[stall-log]` warning. The
 * boot-time pruneStallLog is the opposite: it RETHROWS a real I/O failure so
 * loopWiring's `.catch` can log `[warden:stall] prune failed`, and it must not
 * touch the unreadable path.
 */

let originalHome;
let tempHome;
let warn;

beforeEach(() => {
  originalHome = process.env.HOME;
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-stall-unreadable-'));
  process.env.HOME = tempHome;
  warn = mock.method(console, 'warn', () => {});
});

afterEach(() => {
  mock.restoreAll();
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  try { fs.rmSync(tempHome, { recursive: true, force: true }); } catch { /* best effort */ }
});

function makeLogUnreadable() {
  fs.mkdirSync(stallLogFile(), { recursive: true }); // stalls.jsonl as a directory → EISDIR
}

describe('readStalls — a log that exists but cannot be read', () => {
  it('resolves [] (never rejects) and warns once with the underlying error', async () => {
    makeLogUnreadable();
    const out = await readStalls();
    assert.deepStrictEqual(out, []);
    assert.strictEqual(warn.mock.callCount(), 1);
    const msg = String(warn.mock.calls[0].arguments[0]);
    assert.match(msg, /^\[stall-log\] unreadable stall log \(/);
    assert.match(msg, /EISDIR/);
  });

  it('still resolves [] when a limit is passed', async () => {
    makeLogUnreadable();
    assert.deepStrictEqual(await readStalls({ limit: 5 }), []);
  });

  it('control: a MISSING log is the silent healthy case — [] and NO warning', async () => {
    assert.deepStrictEqual(await readStalls(), []);
    assert.strictEqual(warn.mock.callCount(), 0);
  });
});

describe('pruneStallLog — a log that exists but cannot be read', () => {
  it('rejects with the underlying I/O error instead of reporting "0 removed"', async () => {
    makeLogUnreadable();
    await assert.rejects(() => pruneStallLog(), (err) => err.code === 'EISDIR');
  });

  it('leaves the unreadable path untouched (no rewrite over it)', async () => {
    makeLogUnreadable();
    await assert.rejects(() => pruneStallLog());
    assert.ok(fs.statSync(stallLogFile()).isDirectory(), 'the path is still the directory it was');
  });

  it('control: a MISSING log resolves 0 (the ENOENT leg is not an error)', async () => {
    assert.strictEqual(await pruneStallLog(), 0);
  });
});
