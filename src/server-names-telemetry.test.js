import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * Integration test for the WORKSPACE-NAMES telemetry channel (WARDEN-1416),
 * driven through the REAL server wiring: the real chat catalog (seeded on disk
 * and warmed through the real GET /api/chats), the real `cfg` consent object
 * that PUT /api/config mutates in place, and the real producer server.js
 * constructs at module load.
 *
 * The unit suite (web/workspaceNamesTelemetry.test.mjs) proves the bounded
 * snapshot and the consent gate in isolation. What can only be proven HERE,
 * against the real wiring, is what the slice is riskiest on:
 *
 *   1. NAMES-ONLY CONSENT ACTUALLY PRODUCES. The whole slice exists because
 *      that checkbox produced nothing. A test that drives a fixture catalog
 *      cannot show the LIVE catalog reaches the producer at all.
 *   2. THE CATALOG IS READ, NEVER WRITTEN. The producer must be observation
 *      only: /api/chats must answer identically before and after a flush, and
 *      the on-disk catalog file must be byte-unchanged.
 *   3. ONLY NAMES CROSS THE BOUNDARY. The real catalog row carries a cwd, a
 *      host, a session id and a command line. None may appear in the snapshot.
 *
 * HOME is redirected to a temp dir BEFORE importing server.js (server.js reads
 * config eagerly at module load), following src/server-stall-telemetry.test.js.
 */

let httpServer;
let baseUrl;
let originalHome;
let tempHome;
let wardenDir;
let catalogPath;
let workspaceNamesTelemetry;
let cfg;

const CATALOG = [
  { host: '(local)', session: 'demo', name: 'demo', cwd: '/tmp/probe-repo', cmd: 'bash', kind: 'tmux' },
  { host: '(local)', session: 'refactor', name: 'Refactor auth module', cwd: '/tmp/probe-repo', cmd: 'claude --resume 7b3a2f1', kind: 'tmux' },
  { host: '(local)', session: 'gen', name: 'chat-4nh15o', cwd: '/tmp/probe-repo', cmd: 'bash', kind: 'tmux' },
];

before(async () => {
  originalHome = process.env.HOME;
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-names-telemetry-'));
  process.env.HOME = tempHome;
  wardenDir = path.join(tempHome, '.yatfa-warden');
  fs.mkdirSync(wardenDir, { recursive: true });
  catalogPath = path.join(wardenDir, 'chats.json');
  fs.writeFileSync(catalogPath, JSON.stringify(CATALOG));
  // names ON and NOTHING ELSE — the exact consent state the slice is about.
  // `hosts: []` keeps the bare-id resolver local-only (no ssh from a test).
  fs.writeFileSync(path.join(wardenDir, 'config.json'), JSON.stringify({
    hosts: [], telemetryNamesEnabled: true,
  }));

  const server = await import('./server.js');
  workspaceNamesTelemetry = server.workspaceNamesTelemetry;
  cfg = server.cfg;
  httpServer = server.app.listen(0, '127.0.0.1');
  await new Promise((r) => httpServer.once('listening', r));
  baseUrl = `http://127.0.0.1:${httpServer.address().port}`;

  // Warm the in-memory catalog through the REAL route — catalogChats() re-reads
  // the file and seeds the cache the producer's snapshot() reads.
  await fetch(`${baseUrl}/api/chats`);
});

after(async () => {
  if (httpServer) await new Promise((r) => httpServer.close(r));
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  try { fs.rmSync(tempHome, { recursive: true, force: true }); } catch { /* best-effort */ }
});

describe('workspace-names telemetry through the REAL chat catalog (WARDEN-1416)', () => {
  it('names consent ON, ALONE: the LIVE catalog yields ONE bounded window, not one row per chat', async () => {
    cfg.telemetryNamesEnabled = true;
    const window = workspaceNamesTelemetry.flushNow();
    assert.ok(window, 'the window closed with content — the dead switch is closed');
    assert.equal(window.chatCount, CATALOG.length, 'every seeded chat is counted');
    assert.deepEqual(
      [...window.chats].sort(),
      CATALOG.map((c) => c.name).sort(),
      'the sidebar names arrive — and only the names',
    );
    assert.equal(window.truncated, false, 'nothing was cut at this size');
    // ONE window. The shape itself is the proof: a single object with a single
    // list, never an array of per-chat records.
    assert.ok(Array.isArray(window.chats) && typeof window.chatCount === 'number');
  });

  it('ONLY names cross the boundary — no cwd, host, session id, or command line', () => {
    cfg.telemetryNamesEnabled = true;
    const window = workspaceNamesTelemetry.flushNow();
    assert.deepEqual(
      Object.keys(window).sort(),
      ['chatCount', 'chats', 'endedAt', 'startedAt', 'truncated'],
    );
    const serialized = JSON.stringify(window);
    for (const forbidden of ['/tmp/probe-repo', '(local)', 'claude --resume', '7b3a2f1', 'tmux', 'bash']) {
      assert.ok(
        !serialized.includes(forbidden),
        `no catalog field may ride the window: ${JSON.stringify(forbidden)}`,
      );
    }
  });

  it('consent OFF — the window is dropped, and re-enabling resurrects nothing', () => {
    cfg.telemetryNamesEnabled = false;
    assert.equal(workspaceNamesTelemetry.flushNow(), null, 'nothing was collected');
    cfg.telemetryNamesEnabled = true;
    const after = workspaceNamesTelemetry.flushNow();
    // The next window reads the LIVE catalog fresh — it is not a replay of the
    // dropped one, and it carries nothing observed while consent was off.
    assert.ok(after, 're-enabled, the live catalog is read again');
    assert.equal(after.chatCount, CATALOG.length);
  });

  it('the producer READS the catalog, never writes it — /api/chats and the file are unchanged', async () => {
    cfg.telemetryNamesEnabled = true;
    const beforeBody = await (await fetch(`${baseUrl}/api/chats`)).json();
    const beforeFile = fs.readFileSync(catalogPath, 'utf8');

    workspaceNamesTelemetry.flushNow();
    workspaceNamesTelemetry.flushNow();

    const afterBody = await (await fetch(`${baseUrl}/api/chats`)).json();
    const afterFile = fs.readFileSync(catalogPath, 'utf8');
    assert.equal(afterFile, beforeFile, 'the on-disk catalog is byte-unchanged');
    assert.deepEqual(
      afterBody.chats.map((c) => c.id).sort(),
      beforeBody.chats.map((c) => c.id).sort(),
      '/api/chats answers identically after a flush',
    );
  });
});
