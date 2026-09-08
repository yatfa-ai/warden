// HTTP tests for the WARDEN-1324 probe routing: the two poll/gesture paths —
// GET /api/hosts/status (the 30s poll) and GET /api/hosts/health — hand the
// companion-riding wrapper (probeHostReachability → companion pingProbe) to the
// probe seam, while the POST /api/companion/uninstall precheck keeps the raw-SSH
// validateHost.
//
// The discriminating fact this file is built on: **this sandbox has NO ssh
// binary**, so every raw-SSH probe fails fast (spawn ENOENT → {ok:false}) while
// a companion ping over a seeded live channel succeeds with no ssh at all.
// That makes "online via the poll" itself the proof that the raw path was NOT
// taken, with no mocking of the module boundary (node:test's mock.module is
// unavailable on this repo's Node 20 runtime).
//
// Pinned here, per the ticket's success criteria:
//   1. toggle ON + live channel → the poll reports the host ONLINE (rode the ping);
//   2. toggle ON + never-engaged host → the poll leaves it alone: no bootstrap
//      (its companion status stays 'inactive', not 'bootstrapping'/'error');
//   3. the uninstall precheck does NOT acquire a channel: with a live channel
//      seeded, it still fails fast over raw SSH (400 connectivity error) and the
//      seeded channel survives untouched;
//   4. toggle OFF → byte-for-byte today's raw behaviour (offline), flipped back
//      ON the same process rides the channel again (per-request toggle read).
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { applyCompanionToggle, getChannel, getCompanionStatus, _channelCacheHasForTests, _resetChannelCacheForTests } from './companion.js';

const TEST_VER = 'abc123def456';
const SEEDED_HOST = 'companion-probe-host';   // gets a LIVE channel seeded below
const RAW_HOST = 'companion-raw-host';        // never engaged — the poll must NOT bootstrap it

// Minimal copies of companion.test.js's transport fakes (test files are
// self-contained; node --test runs each in its own process).
function fakeTransport(handler) {
  let lineCB = null;
  return {
    write(line) {
      let resp = null;
      try { resp = handler(JSON.parse(line)); } catch { /* swallow */ }
      if (resp) setImmediate(() => { if (lineCB) lineCB(JSON.stringify(resp)); });
    },
    onLine(cb) { lineCB = cb; },
    onExit() {},
    kill() {},
  };
}

function seedingDeps() {
  return {
    manifest: {
      version: TEST_VER,
      binaries: { 'linux/amd64': 'warden-companion-linux-amd64' },
    },
    run: async () => ({ ok: true, stdout: 'OS=Linux\nARCH=x86_64\nHAVE=0\n' }),
    upload: async () => ({ ok: true }),
    spawnChannel: () => fakeTransport((req) => (
      req.method === 'ping'
        ? { id: req.id, ok: true, result: { version: TEST_VER, methods: ['ping', 'discover'] } }
        : { id: req.id, ok: false, error: 'unknown method' })),
  };
}

describe('WARDEN-1324 probe routing over HTTP (companion ping on the poll, raw ssh on uninstall)', () => {
  let httpServer, baseUrl;
  let originalHome, tempHome, originalToggle;

  before(async () => {
    originalHome = process.env.HOME;
    originalToggle = process.env.WARDEN_COMPANION_TRANSPORT;
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-companion-probe-'));
    process.env.HOME = tempHome;
    const wdir = path.join(tempHome, '.yatfa-warden');
    fs.mkdirSync(wdir, { recursive: true });
    fs.writeFileSync(path.join(wdir, 'config.json'),
      JSON.stringify({ hosts: [SEEDED_HOST, RAW_HOST] }) + '\n');

    // Dynamic import AFTER HOME is set → configPath resolves under tempHome.
    const { app } = await import('./server.js');
    httpServer = app.listen(0, '127.0.0.1');
    await new Promise((res, rej) => {
      httpServer.once('listening', res);
      httpServer.once('error', rej);
    });
    baseUrl = `http://127.0.0.1:${httpServer.address().port}`;

    applyCompanionToggle(true);
    _resetChannelCacheForTests();
    // Seed a LIVE channel for SEEDED_HOST (fake transport — no ssh involved):
    // getChannel writes the live channel into the module cache AND flips the
    // per-host status to 'active', which is exactly the "already live" state
    // the poll is allowed to ride.
    await getChannel(SEEDED_HOST, {}, seedingDeps());
    assert.strictEqual(getCompanionStatus(SEEDED_HOST).state, 'active', 'seed precondition');
  });

  after(async () => {
    _resetChannelCacheForTests();
    if (httpServer) await new Promise((r) => httpServer.close(r));
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalToggle === undefined) delete process.env.WARDEN_COMPANION_TRANSPORT;
    else process.env.WARDEN_COMPANION_TRANSPORT = originalToggle;
    try { fs.rmSync(tempHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it('poll rides the live channel: seeded host ONLINE (no ssh exists — the raw path could not say that), unseeded host left un-bootstrapped', async () => {
    const body = await (await fetch(`${baseUrl}/api/hosts/status`)).json();

    const seeded = body.hosts.find((h) => h.host === SEEDED_HOST);
    assert.ok(seeded, 'seeded host present');
    assert.strictEqual(seeded.status, 'online',
      'online with NO ssh binary in the sandbox proves the answer came from the companion ping');
    assert.strictEqual(seeded.companion?.state, 'active',
      'the same response still reports the companion status (WARDEN-878 shape unchanged)');

    // Success criterion 2: the poll must not bootstrap a host nobody engaged.
    const raw = body.hosts.find((h) => h.host === RAW_HOST);
    assert.ok(raw, 'unseeded host present');
    assert.notStrictEqual(raw.status, 'online',
      'an un-engaged host takes the raw path — which cannot succeed without ssh');
    assert.strictEqual(getCompanionStatus(RAW_HOST).state, 'inactive',
      'THE TRAP: the poll left the host inactive — no bootstrap was triggered (a bootstrap attempt would read bootstrapping/error)');
  });

  it('TRAP 1: the uninstall precheck keeps raw SSH — it fails fast over ssh (400) and does NOT touch the live channel', async () => {
    assert.strictEqual(_channelCacheHasForTests(SEEDED_HOST), true, 'precondition: channel is live');

    const t0 = Date.now();
    const r = await fetch(`${baseUrl}/api/companion/uninstall`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ host: SEEDED_HOST }),
    });
    const elapsed = Date.now() - t0;

    assert.strictEqual(r.status, 400,
      'raw-SSH validateHost fails without ssh → connectivity 400. A companion-routed precheck would have succeeded (ping) and fallen through to the uninstall run (500) instead');
    const body = await r.json();
    assert.ok(body.error, 'the connectivity error surfaces');
    assert.ok(elapsed < 30000, `fails fast (spawn ENOENT short-circuits): ${elapsed}ms`);
    assert.strictEqual(_channelCacheHasForTests(SEEDED_HOST), true,
      'the precheck neither rode nor tore down the seeded channel');
    assert.strictEqual(getCompanionStatus(SEEDED_HOST).state, 'active',
      'and the channel status is untouched — no uninstall ran');
  });

  it('toggle OFF is byte-for-byte today\'s raw behaviour; ON again rides the channel (per-request toggle read)', async () => {
    // /api/hosts/health probes LIVE on every request (no cache), so the toggle
    // flip is observable without waiting out the status cache's freshness window.
    applyCompanionToggle(false);
    let body = await (await fetch(`${baseUrl}/api/hosts/health`)).json();
    const off = body.hosts.find((h) => h.host === SEEDED_HOST);
    assert.strictEqual(off.ok, false,
      'toggle OFF: the seeded channel is ignored — the raw path runs and fails without ssh, exactly as before this ticket');

    applyCompanionToggle(true);
    body = await (await fetch(`${baseUrl}/api/hosts/health`)).json();
    const on = body.hosts.find((h) => h.host === SEEDED_HOST);
    assert.strictEqual(on.ok, true,
      'toggle ON: the same request rides the live channel again — the toggle is read per request');
  });
});
