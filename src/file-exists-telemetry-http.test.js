import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * End-to-end HTTP tests for the WARDEN-1258 usage telemetry on /api/file-exists
 * — the operational-metrics producer exercised through the REAL route wiring.
 *
 * Same isolation discipline as file-exists-http.test.js: server.js evaluates
 * `const cfg = load()` at module load, so config/catalog must be written BEFORE
 * the single import (node --test runs each file in its own process, so the
 * telemetry-ON config here never leaks into the other suite's telemetry-OFF
 * boot).
 *
 * What this pins beyond the unit suite (src/fileExistsTelemetry.test.js):
 *   • the ROUTE actually folds observations through the module-level producer
 *     when the `operational-metrics` category is ON in the persisted config;
 *   • the cacheHits piggyback from the request body folds into the
 *     file-exists-cache-hit operation;
 *   • the local branch records kind 'local' with the endpoint's { exists }
 *     verdict as the ok/fail signal.
 */

let httpServer;
let baseUrl;
let originalHome;
let tempHome;
let cwdDir;
let fileExistsTelemetry;

before(async () => {
  originalHome = process.env.HOME;
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-fetel-home-'));
  process.env.HOME = tempHome;

  const wardenDir = path.join(tempHome, '.yatfa-warden');
  fs.mkdirSync(wardenDir, { recursive: true });
  // Telemetry operational-metrics ON — the consent gate under test. Everything
  // else stays at defaults.
  fs.writeFileSync(path.join(wardenDir, 'config.json'), JSON.stringify({
    hosts: [],
    telemetryOperationalMetricsEnabled: true,
  }));

  cwdDir = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-fetel-cwd-'));
  fs.writeFileSync(path.join(cwdDir, 'real.txt'), 'hello\n');

  // Catalog with one LOCAL manual chat, resolved by bare session id (no ':'
  // prefix) so no host/tmux discovery runs — same shape as
  // file-exists-http.test.js.
  fs.writeFileSync(
    path.join(wardenDir, 'chats.json'),
    JSON.stringify([
      { host: '(local)', session: 'warden-fetel', cwd: cwdDir, cmd: 'bash', name: 'warden-fetel' },
    ]),
  );

  // Import server.js ONCE — after HOME/config/catalog are in place.
  const mod = await import('./server.js');
  fileExistsTelemetry = mod.fileExistsTelemetry;
  httpServer = mod.app.listen(0, '127.0.0.1');
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
  for (const d of [cwdDir, tempHome]) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

async function probe(body) {
  const res = await fetch(`${baseUrl}/api/file-exists`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

describe('/api/file-exists usage telemetry (WARDEN-1258)', () => {
  it('folds local probes with their exists verdict once the category is on', async () => {
    const yes = await probe({ id: 'warden-fetel', path: 'real.txt' });
    assert.equal(yes.exists, true);
    const no = await probe({ id: 'warden-fetel', path: 'nope.txt' });
    assert.equal(no.exists, false);

    const snap = fileExistsTelemetry.flushNow();
    assert.ok(snap, 'a window with observations must flush');
    const local = snap.operations.find((o) => o.operation === 'file-exists-local');
    assert.ok(local, 'the local operation folded through the real route wiring');
    assert.equal(local.count, 2);
    assert.equal(local.okCount, 1);
    assert.equal(local.failCount, 1);
    assert.ok(local.max >= 0 && local.min >= 0, 'latency fields present');
    assert.equal(snap.operations.some((o) => o.operation === 'file-exists-remote'), false,
      'a local chat never records the remote operation');
  });

  it('folds the renderer-reported cacheHits piggyback into the cache-hit operation', async () => {
    const r = await probe({ id: 'warden-fetel', path: 'real.txt', cacheHits: 3 });
    assert.equal(r.exists, true);
    const snap = fileExistsTelemetry.flushNow();
    const cache = snap.operations.find((o) => o.operation === 'file-exists-cache-hit');
    assert.ok(cache, 'the piggybacked delta folded');
    assert.equal(cache.count, 3);
  });

  it('ignores a corrupt cacheHits value (no observation, endpoint still answers)', async () => {
    const r = await probe({ id: 'warden-fetel', path: 'real.txt', cacheHits: 'bogus' });
    assert.equal(r.exists, true);
    const snap = fileExistsTelemetry.flushNow();
    assert.equal(snap.operations.some((o) => o.operation === 'file-exists-cache-hit'), false,
      'a non-number delta never folds');
  });

  it('the flushed window carries only numbers and kebab-case keys (aggregates only)', async () => {
    await probe({ id: 'warden-fetel', path: 'real.txt', cacheHits: 1 });
    const snap = fileExistsTelemetry.flushNow();
    const json = JSON.stringify(snap);
    assert.equal(json.includes(cwdDir), false, 'no file path can survive into the window');
    assert.equal(json.includes('warden-fetel'), false, 'no chat id can survive into the window');
    for (const op of snap.operations) {
      assert.match(op.operation, /^[a-z0-9][a-z0-9-]{0,63}$/);
    }
  });
});
