// HTTP integration tests for the WARDEN-1390 per-host companion exclusion
// (companionExcludedHosts) — the config surface end to end against the REAL
// Express app from src/server.js, mirroring the harness in server-config.test.js.
//
// Pins the success criteria the unit suites cannot reach:
//   • GET /api/config emits `companionExcludedHosts: []` on a fresh install
//     (the schema+web lockstep default, at its byte-pinned GET position).
//   • PUT of a valid list persists to config.json AND live-applies to the
//     WARDEN_COMPANION_EXCLUDED_HOSTS env gate the routing predicates read —
//     no restart (the afterSave contract, riding the same pipeline as the
//     toggle).
//   • PUT of a MALFORMED list (non-string entry, comma-bearing entry — the env
//     serialization separator — empty-after-trim entry) is REFUSED: reported in
//     the response's `refused` map, the prior value stays on disk and in force.
//   • PUT of an empty list clears the persisted value AND deletes the env key.
//   • POST /api/config/reset restores the default (empty) and live-applies it.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

let httpServer;
let baseUrl;
let originalHome;
let tempHome;
let configPath;
let originalCompanionEnv;
let originalExclusionEnv;

before(async () => {
  // Same env hygiene server-config.test.js practices: capture the ambient
  // companion env BEFORE importing server.js (the boot apply writes both keys),
  // and restore both in after().
  originalCompanionEnv = process.env.WARDEN_COMPANION_TRANSPORT;
  originalExclusionEnv = process.env.WARDEN_COMPANION_EXCLUDED_HOSTS;

  originalHome = process.env.HOME;
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-config-excl-'));
  process.env.HOME = tempHome;
  const wardenDir = path.join(tempHome, '.yatfa-warden');
  fs.mkdirSync(wardenDir, { recursive: true });
  configPath = path.join(wardenDir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ hosts: ['win-box', 'mac-box'] }));

  const { app } = await import('./server.js');
  httpServer = app.listen(0, '127.0.0.1');
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
  if (originalCompanionEnv === undefined) delete process.env.WARDEN_COMPANION_TRANSPORT;
  else process.env.WARDEN_COMPANION_TRANSPORT = originalCompanionEnv;
  if (originalExclusionEnv === undefined) delete process.env.WARDEN_COMPANION_EXCLUDED_HOSTS;
  else process.env.WARDEN_COMPANION_EXCLUDED_HOSTS = originalExclusionEnv;
  try { fs.rmSync(tempHome, { recursive: true, force: true }); } catch { /* best-effort */ }
});

const get = async () => (await (await fetch(`${baseUrl}/api/config`)).json());
const put = async (body) => {
  const res = await fetch(`${baseUrl}/api/config`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, ...(await res.json()) };
};

describe('companionExcludedHosts — the per-host opt-out config surface (WARDEN-1390)', () => {
  it('GET emits companionExcludedHosts: [] on a fresh install (between the webhook and token fields)', async () => {
    const body = await get();
    assert.ok('companionExcludedHosts' in body, 'the field must be present in GET');
    assert.deepStrictEqual(body.companionExcludedHosts, [], 'default is the empty list');
    // The byte-pinned position (order 19): right after the masked telemetry
    // token fields, before webhookUrl — pinned by server-config-registry.test.js
    // too; this assert keeps the HTTP surface honest if the registry moves.
    const keys = Object.keys(body);
    assert.ok(keys.indexOf('companionExcludedHosts') < keys.indexOf('webhookUrl'));
  });

  it('PUT of a valid list persists AND live-applies the env gate (no restart)', async () => {
    const { ok, refused } = await put({ companionExcludedHosts: ['win-box', ' mac-box '] });
    assert.strictEqual(ok, true);
    assert.deepStrictEqual(refused, {}, 'a clean PUT refuses nothing');

    const body = await get();
    assert.deepStrictEqual(body.companionExcludedHosts, ['win-box', 'mac-box'], 'entries are trimmed');

    const onDisk = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.deepStrictEqual(onDisk.companionExcludedHosts, ['win-box', 'mac-box'],
      'the exclusion persists to config.json (survives a restart)');

    assert.strictEqual(process.env.WARDEN_COMPANION_EXCLUDED_HOSTS, 'win-box,mac-box',
      'afterSave live-applied the list to the env gate the routing predicates read');
  });

  it('PUT of a MALFORMED list is refused and changes nothing (no silently-dropped exclusion)', async () => {
    for (const [label, bad] of [
      ['non-string entry', ['win-box', 42]],
      ['comma-bearing entry (the env separator)', ['win,box']],
      ['empty-after-trim entry', ['  ']],
      ['control-character entry', ['win\nbox']],
      ['not an array', 'win-box'],
    ]) {
      const { ok, refused } = await put({ companionExcludedHosts: bad });
      assert.strictEqual(ok, true, `${label}: the PUT itself still succeeds`);
      assert.ok(refused.companionExcludedHosts !== undefined, `${label}: the field is reported in refused`);
      const body = await get();
      assert.deepStrictEqual(body.companionExcludedHosts, ['win-box', 'mac-box'],
        `${label}: the prior list stays in force — a dropped exclusion is invisible breakage`);
      assert.strictEqual(process.env.WARDEN_COMPANION_EXCLUDED_HOSTS, 'win-box,mac-box',
        `${label}: the live env gate is untouched`);
    }
  });

  it('PUT of an empty list clears disk AND deletes the env key (byte-identical routing)', async () => {
    const { ok } = await put({ companionExcludedHosts: [] });
    assert.strictEqual(ok, true);
    const body = await get();
    assert.deepStrictEqual(body.companionExcludedHosts, []);
    const onDisk = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.deepStrictEqual(onDisk.companionExcludedHosts, []);
    assert.strictEqual(process.env.WARDEN_COMPANION_EXCLUDED_HOSTS, undefined,
      'an empty exclusion list deletes the env key outright');
  });

  it('/api/config/reset restores the default and live-applies the cleared gate', async () => {
    await put({ companionExcludedHosts: ['win-box'] });
    assert.strictEqual(process.env.WARDEN_COMPANION_EXCLUDED_HOSTS, 'win-box');

    const res = await fetch(`${baseUrl}/api/config/reset`, { method: 'POST' });
    assert.strictEqual(res.status, 200);
    const body = await get();
    assert.deepStrictEqual(body.companionExcludedHosts, [], 'reset restored the default');
    assert.strictEqual(process.env.WARDEN_COMPANION_EXCLUDED_HOSTS, undefined,
      'reset live-applied the cleared list');
  });
});
