import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  appendStall, readStalls, pruneStallLog, clearStallLog,
  stallLogFile, stallLogDir, STALL_LOG_BASENAME,
} from './stall-log.js';

/**
 * The DURABLE half of the server stall signal (WARDEN-977).
 *
 * The point of this file is not "does append work" — it is that the evidence
 * SURVIVES: a stall recorded during the owner's slow Settings open is still
 * readable after warden restarts, without telemetry consent, a rebuild or a
 * debugger. So the tests cover the read path's failure directions too: a missing
 * file (the healthy case) must read as "no stalls", and a torn final line must
 * not hide the good records before it.
 *
 * HOME is redirected to a temp dir per test; the module resolves the path lazily
 * on every call precisely so this works.
 */

let originalHome;
let tempHome;

beforeEach(() => {
  originalHome = process.env.HOME;
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-stall-log-'));
  process.env.HOME = tempHome;
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  try { fs.rmSync(tempHome, { recursive: true, force: true }); } catch { /* best effort */ }
});

function record(overrides = {}) {
  return {
    type: 'performance-stall',
    runtime: 'server',
    source: 'event-loop',
    timestamp: new Date().toISOString(),
    lagMs: 4200,
    attribution: [{ label: 'sweep:lifecycle', overlapMs: 4100, open: true, durationMs: 4300 }],
    ...overrides,
  };
}

describe('stall log location', () => {
  it('lives beside the rest of warden local state, and resolves LAZILY', () => {
    // Lazy resolution is what makes the durable channel correct after a HOME
    // change (and what makes these tests possible at all).
    assert.equal(stallLogDir(), path.join(tempHome, '.yatfa-warden'));
    assert.equal(stallLogFile(), path.join(tempHome, '.yatfa-warden', STALL_LOG_BASENAME));
    assert.equal(STALL_LOG_BASENAME, 'stalls.jsonl');
  });
});

describe('appendStall / readStalls', () => {
  it('creates the data dir on demand and round-trips a record', async () => {
    assert.equal(fs.existsSync(stallLogDir()), false, 'the dir does not exist yet');
    const r = record({ lagMs: 8433 });
    await appendStall(r);
    const back = await readStalls();
    assert.equal(back.length, 1);
    assert.deepEqual(back[0], r, 'the record survives the round trip byte-for-byte');
  });

  it('is append-only and returns records NEWEST FIRST', async () => {
    for (const lagMs of [1000, 2000, 3000]) {
      await appendStall(record({ lagMs, timestamp: new Date(Date.now() - lagMs).toISOString() }));
    }
    const back = await readStalls();
    assert.deepEqual(back.map((r) => r.lagMs), [3000, 2000, 1000]);
    // One line per record — a torn write can cost at most the final line.
    const raw = fs.readFileSync(stallLogFile(), 'utf8');
    assert.equal(raw.trim().split('\n').length, 3);
    assert.ok(raw.endsWith('\n'), 'every line is newline-terminated');
  });

  it('honors a limit (newest kept)', async () => {
    for (let i = 0; i < 10; i++) await appendStall(record({ lagMs: 1000 + i }));
    const back = await readStalls({ limit: 3 });
    assert.deepEqual(back.map((r) => r.lagMs), [1009, 1008, 1007]);
  });

  it('reads a MISSING log as "no stalls" — the healthy case is not an error', async () => {
    assert.deepEqual(await readStalls(), []);
  });

  it('reads an empty log as "no stalls"', async () => {
    await appendStall(record());
    await clearStallLog();
    assert.deepEqual(await readStalls(), []);
  });

  it('skips a torn/malformed line instead of losing the good records around it', async () => {
    // The failure direction that matters: a crash mid-append leaves a partial
    // final line. If that made the whole read fail, the evidence this ticket
    // exists to produce would be lost at exactly the moment it mattered.
    await appendStall(record({ lagMs: 1111 }));
    fs.appendFileSync(stallLogFile(), '{"type":"performance-stall","lagM\n');
    await appendStall(record({ lagMs: 3333 }));
    const back = await readStalls();
    assert.deepEqual(back.map((r) => r.lagMs), [3333, 1111]);
  });
});

describe('pruneStallLog', () => {
  it('drops records older than the window and keeps the recent ones', async () => {
    const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const fresh = new Date().toISOString();
    await appendStall(record({ lagMs: 1, timestamp: old }));
    await appendStall(record({ lagMs: 2, timestamp: fresh }));
    const removed = await pruneStallLog();
    assert.equal(removed, 1);
    const back = await readStalls();
    assert.deepEqual(back.map((r) => r.lagMs), [2]);
  });

  it('rewrites nothing when every record is inside the window', async () => {
    await appendStall(record());
    const mtimeBefore = fs.statSync(stallLogFile()).mtimeMs;
    assert.equal(await pruneStallLog(), 0);
    assert.equal(fs.statSync(stallLogFile()).mtimeMs, mtimeBefore, 'a no-op prune does not touch the file');
  });

  it('keeps an undated or malformed line rather than silently discarding evidence', async () => {
    fs.mkdirSync(stallLogDir(), { recursive: true });
    fs.writeFileSync(stallLogFile(), 'not json at all\n{"type":"performance-stall","lagMs":5}\n');
    assert.equal(await pruneStallLog(), 0);
    const raw = fs.readFileSync(stallLogFile(), 'utf8');
    assert.match(raw, /not json at all/);
    assert.match(raw, /"lagMs":5/);
  });

  it('tolerates a missing file', async () => {
    assert.equal(await pruneStallLog(), 0);
  });

  it('caps retention so a pathologically stalling machine cannot grow the file forever', async () => {
    // 2100 lines, all fresh: age-based pruning keeps them all, the hard cap must
    // still bound the file (newest kept).
    fs.mkdirSync(stallLogDir(), { recursive: true });
    const now = Date.now();
    const lines = Array.from({ length: 2100 }, (_, i) => JSON.stringify(
      record({ lagMs: i, timestamp: new Date(now - (2100 - i)).toISOString() }),
    ));
    fs.writeFileSync(stallLogFile(), lines.join('\n') + '\n');
    const removed = await pruneStallLog();
    assert.equal(removed, 100);
    const back = await readStalls({ limit: 5000 });
    assert.equal(back.length, 2000);
    assert.equal(back[0].lagMs, 2099, 'the newest record is retained');
  });
});
