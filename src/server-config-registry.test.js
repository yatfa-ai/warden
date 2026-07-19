import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * Characterization contract test for the /api/config registry refactor (WARDEN-773).
 *
 * PURPOSE: pin the CURRENT wire contract of GET + PUT /api/config so the
 * registry consolidation (DEFAULTS + GET + PUT derived from one CONFIG_FIELDS
 * source of truth) is provably behavior-preserving. These assertions are written
 * against the PRE-refactor hand-maintained handlers and must pass UNCHANGED
 * post-refactor — that is the refactor's definition of "byte-identical."
 *
 * This file is ADDITIVE to the per-field coverage in server-config.test.js /
 * -llm / -telemetry / -webhook (which already pin connectTimeout clamps,
 * tokenBudget null-asymmetry, health ordering, telemetry consent, watchPatterns
 * sanitization, and per-secret masking/no-clobber). It fills the gaps those
 * leave: the EXACT GET key set + order, unified secret-masking across all three
 * secrets, GET default-resolution rules (!==false / ===true / ?? '' / Array),
 * and the post-save side-effects (the IPC telemetry forward incl. cleartext
 * authToken that a naive registry would silently drop).
 *
 * POLL-SAFETY: the budget + attention polls arm via restartBudgetPoll /
 * restartAttentionPoll inside the PUT handler when their gates are true
 * (tokenBudgetEnabled; webhookEnabled && webhookUrl && an alert routing). The
 * tests use app.listen() (not startServer), so NO poll runs at boot; and every
 * PUT here keeps both gates OFF, so no setInterval is ever armed and the process
 * exits cleanly (a armed poll would both SSH-discover and keep the loop alive).
 *
 * Same isolated-server pattern as the sibling files: each node --test file runs
 * in its own process, so the eager `cfg = load()` at server.js import reads OUR
 * config.json and never cross-talks.
 */

// The EXACT top-level key order GET /api/config emits today (captured from the
// pre-refactor handler 2026-07-19). Byte-identity of the GET shape requires the
// registry-derived response to reproduce this order, not just this key SET — a
// renderer snapshot or shallow-equality check could break on a re-order even
// though no test reads order via property access. The registry assigns each
// GET-visible field a getOrder and emits in that order specifically to satisfy
// this pin.
const GET_TOP_LEVEL_KEYS = [
  'hosts',
  'pollIntervalMs',
  'tmuxSession',
  'connectTimeout',
  'observerConfirmMode',
  'observerAutoStart',
  'observerSessionTimeout',
  'llm',
  'healthWarningThresholdMin',
  'healthCriticalThresholdMin',
  'tokenBudgetEnabled',
  'tokenBudgetThresholdTokens',
  'tokenBudgetWindowHours',
  'tokenBudgetPerSessionThresholdTokens',
  'companionTransportEnabled',
  'companionTransportOverridden',
  'telemetryEndpoint',
  'telemetryAuthTokenSet',
  'telemetryAuthTokenTail',
  'webhookUrl',
  'webhookEnabled',
  'webhookSecretSet',
  'webhookSecretTail',
  'webhookAlertAttention',
  'webhookAlertBudget',
  'webhookAlertDone',
  'confirmDestructiveActions',
  'notifyChatOps',
  'notifyErrors',
  'notifySuccess',
  'notifyObserver',
  'showHostTags',
  'showTypeBadges',
  'showStatusIndicators',
  'showProjectBadges',
  'hideOfflineHosts',
  'watchPatterns',
  'telemetryBaseEnabled',
  'telemetryExtendedEnabled',
];

// The EXACT nested llm key order GET emits today.
const GET_LLM_KEYS = ['model', 'baseUrl', 'maxTokens', 'authTokenSet', 'authTokenTail'];

// Three planted cleartext secrets — used to prove GET masks ALL of them and PUT
// no-clobbers ALL of them in one shot (the unified secret contract).
const LLM_SECRET = 'sk-llm-cleartext-AAAA';
const TELEMETRY_SECRET = 'tok-telemetry-cleartext-BBBB';
const WEBHOOK_SECRET = 'sec-webhook-cleartext-CCCC';

let httpServer;
let baseUrl;
let originalHome;
let tempHome;
let configPath;
let originalCompanionEnv;

async function put(body) {
  const res = await fetch(`${baseUrl}/api/config`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { res, json: await res.json() };
}
async function get() {
  return (await (await fetch(`${baseUrl}/api/config`)).json());
}

before(async () => {
  // WARDEN-439: capture the ambient companion env BEFORE importing server.js
  // (server.js snapshots the override flag at import). Force it UNset so the
  // toggle is live-driven (override=false) and a PUT can flip the env var —
  // that is what makes applyCompanionToggle observable here.
  originalCompanionEnv = process.env.WARDEN_COMPANION_TRANSPORT;
  delete process.env.WARDEN_COMPANION_TRANSPORT;

  originalHome = process.env.HOME;
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-cfg-registry-'));
  process.env.HOME = tempHome;
  const wardenDir = path.join(tempHome, '.yatfa-warden');
  fs.mkdirSync(wardenDir, { recursive: true });
  configPath = path.join(wardenDir, 'config.json');
  // No config on disk → load() returns pure DEFAULTS. The default-resolution
  // block (run first) relies on this pristine state; later blocks seed values.

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
  try { fs.rmSync(tempHome, { recursive: true, force: true }); } catch { /* best-effort */ }
});

// RUN FIRST: the live cfg is pristine DEFAULTS (PUT is a patch and cannot reset
// a field, so the default-resolution assertions must run before any seed).
describe('/api/config GET default-resolution — the asymmetric rules (WARDEN-773)', () => {
  // A near-empty PUT (only hosts + watchPatterns, both already default) leaves
  // every other field at DEFAULTS, exercising every GET coercion: the !== false
  // default-true toggles, the === true strict toggle, the ?? '' string fallbacks,
  // the typeof-number-or-null maxTokens, and the Array.isArray-or-[] watch list.
  // These rules are non-uniform BY DESIGN (mirrors the PUT guards) and must
  // survive the registry derivation verbatim.
  it('resolves !== false toggles to true, === true to false, ?? "" to empty, maxTokens to null, watchPatterns to []', async () => {
    await put({ hosts: [], watchPatterns: [] });
    const body = await get();
    // !== false → default true (the three webhook category routings)
    assert.strictEqual(body.webhookAlertAttention, true, 'webhookAlertAttention defaults true via !== false');
    assert.strictEqual(body.webhookAlertBudget, true, 'webhookAlertBudget defaults true via !== false');
    assert.strictEqual(body.webhookAlertDone, true, 'webhookAlertDone defaults true via !== false');
    // === true → strict (webhookEnabled defaults false when not literally true)
    assert.strictEqual(body.webhookEnabled, false, 'webhookEnabled is === true (strict)');
    // ?? '' → empty string fallbacks
    assert.strictEqual(body.telemetryEndpoint, '', 'telemetryEndpoint ?? ""');
    assert.strictEqual(body.webhookUrl, '', 'webhookUrl ?? ""');
    assert.strictEqual(body.llm.model, '', 'llm.model ?? ""');
    assert.strictEqual(body.llm.baseUrl, '', 'llm.baseUrl ?? ""');
    // typeof number ? value : null
    assert.strictEqual(body.llm.maxTokens, null, 'llm.maxTokens is null when not a number');
    assert.strictEqual(body.llm.authTokenSet, false, 'authTokenSet false when unset');
    assert.strictEqual(body.llm.authTokenTail, null, 'authTokenTail null when unset');
    // Array.isArray ? value : []
    assert.ok(Array.isArray(body.watchPatterns), 'watchPatterns coerced to array');
    assert.strictEqual(body.watchPatterns.length, 0, 'watchPatterns empty');
  });
});

describe('/api/config GET shape — byte-identical key set + order (WARDEN-773)', () => {
  // Seed a poll-safe but distinctive cfg (secrets planted for the masking
  // assertions; tokenBudgetEnabled + webhookEnabled both OFF so no poll arms).
  it('emits exactly the current top-level keys in the current order for a seeded cfg', async () => {
    await put({
      hosts: [],
      pollIntervalMs: 2000,
      tmuxSession: 'sess',
      connectTimeout: 12,
      observerConfirmMode: 'auto-safe',
      observerAutoStart: true,
      observerSessionTimeout: 45,
      llm: { model: 'm', baseUrl: 'http://x', maxTokens: 1024, authToken: LLM_SECRET },
      healthWarningThresholdMin: 7,
      healthCriticalThresholdMin: 90,
      tokenBudgetEnabled: false,
      tokenBudgetThresholdTokens: 500000,
      tokenBudgetWindowHours: 12,
      tokenBudgetPerSessionThresholdTokens: 250000,
      companionTransportEnabled: false,
      telemetryEndpoint: 'http://endpoint',
      telemetryAuthToken: TELEMETRY_SECRET,
      webhookUrl: 'http://wh',
      webhookEnabled: false,
      webhookSecret: WEBHOOK_SECRET,
      webhookAlertAttention: false,
      webhookAlertBudget: false,
      webhookAlertDone: false,
      confirmDestructiveActions: false,
      notifyChatOps: false,
      notifyErrors: false,
      notifySuccess: false,
      notifyObserver: false,
      showHostTags: false,
      showTypeBadges: false,
      showStatusIndicators: false,
      showProjectBadges: true,
      hideOfflineHosts: true,
      watchPatterns: [{ id: 'w1', name: 'W', expression: 'x', mode: 'string', enabled: true }],
      telemetryBaseEnabled: false,
      telemetryExtendedEnabled: false,
    });
    const body = await get();
    assert.deepStrictEqual(Object.keys(body), GET_TOP_LEVEL_KEYS,
      'GET top-level key SET and ORDER must be byte-identical pre/post refactor');
  });

  it('emits exactly the current nested llm keys in the current order', async () => {
    const body = await get();
    assert.deepStrictEqual(Object.keys(body.llm), GET_LLM_KEYS,
      'llm nested key set and order must be byte-identical');
  });

  it('NEVER returns any of the three cleartext secrets anywhere in the GET body', async () => {
    // The three secrets are planted on disk (via the PUT above). GET must mask
    // every one: only {field}Set + {field}Tail appear, never the cleartext. This
    // is the unified security boundary — a registry that emits a secret as
    // `public` leaks it to every renderer fetch (WARDEN-773 regression #1).
    const text = await (await fetch(`${baseUrl}/api/config`)).text();
    assert.ok(!text.includes(LLM_SECRET), 'llm.authToken cleartext must never be on the wire');
    assert.ok(!text.includes(TELEMETRY_SECRET), 'telemetryAuthToken cleartext must never be on the wire');
    assert.ok(!text.includes(WEBHOOK_SECRET), 'webhookSecret cleartext must never be on the wire');
  });

  it('masks each secret as {field}Set (bool) + {field}Tail (last-4 or null)', async () => {
    const body = await get();
    // llm.authToken → nested
    assert.strictEqual(body.llm.authTokenSet, true);
    assert.strictEqual(body.llm.authTokenTail, LLM_SECRET.slice(-4));
    assert.ok(!('authToken' in body.llm), 'no cleartext authToken key on llm');
    // telemetryAuthToken → telemetryAuthTokenSet/Tail
    assert.strictEqual(body.telemetryAuthTokenSet, true);
    assert.strictEqual(body.telemetryAuthTokenTail, TELEMETRY_SECRET.slice(-4));
    assert.ok(!('telemetryAuthToken' in body), 'no cleartext telemetryAuthToken key');
    // webhookSecret → webhookSecretSet/Tail
    assert.strictEqual(body.webhookSecretSet, true);
    assert.strictEqual(body.webhookSecretTail, WEBHOOK_SECRET.slice(-4));
    assert.ok(!('webhookSecret' in body), 'no cleartext webhookSecret key');
  });
});

describe('/api/config PUT no-clobber — one save preserves all three stored secrets (WARDEN-773)', () => {
  // The unified no-clobber contract: a single PUT that touches other fields but
  // sends no cleartext secret must leave ALL THREE stored secrets intact (the UI
  // never seeds password fields, so every unchanged save depends on this).
  it('a PUT omitting all three secrets preserves every stored secret', async () => {
    await put({
      llm: { authToken: LLM_SECRET },
      telemetryAuthToken: TELEMETRY_SECRET,
      webhookSecret: WEBHOOK_SECRET,
    });
    // A save that changes unrelated fields and sends NO secret fields.
    await put({ hosts: ['x'], notifyErrors: false, telemetryBaseEnabled: false });
    const onDisk = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.strictEqual(onDisk.llm.authToken, LLM_SECRET, 'llm.authToken survived the save');
    assert.strictEqual(onDisk.telemetryAuthToken, TELEMETRY_SECRET, 'telemetryAuthToken survived the save');
    assert.strictEqual(onDisk.webhookSecret, WEBHOOK_SECRET, 'webhookSecret survived the save');
  });
});

describe('/api/config PUT post-save side-effects — the four afterSave steps (WARDEN-773, Correction 2)', () => {
  // The proposal modeled only per-field guards + crossField + derived and
  // omitted the four post-save side-effects. A registry refactor that drops
  // afterSave silently breaks: telemetry changes need a restart, the companion
  // toggle needs a restart, budget/attention config is delayed up to 120s/60s.
  // These pin the two most security/live-critical ones end-to-end here (the
  // telemetry IPC forward incl. cleartext authToken, and the live companion
  // toggle); the full "all four fire" structural guarantee is pinned in the
  // registry unit test (config-schema.test.js → afterSave invokes every dep).

  it('forwards telemetry config to the Electron main process via process.send (incl. cleartext authToken)', async () => {
    // process.send exists only when the server is forked by electron/main.cjs.
    // Standalone node --test has no parent, so install a mock for the PUT and
    // assert it is called with the telemetry-config IPC payload carrying the
    // CLEARTEXT token (this internal main↔child channel is the one path the
    // cleartext travels — GET masks it from the renderer, but the transport
    // needs it; WARDEN-524/569).
    assert.ok(typeof process.send !== 'function', 'precondition: no parent IPC in test process');
    const sent = [];
    const originalSend = process.send;
    process.send = (msg) => sent.push(msg);
    try {
      await put({
        telemetryBaseEnabled: false,
        telemetryExtendedEnabled: false,
        telemetryEndpoint: 'https://recv.example/ingest',
        telemetryAuthToken: TELEMETRY_SECRET,
      });
    } finally {
      if (originalSend === undefined) delete process.send;
      else process.send = originalSend;
    }
    const forward = sent.find((m) => m && m.type === 'telemetry-config');
    assert.ok(forward, 'process.send was called with a telemetry-config message');
    assert.strictEqual(forward.base, false, 'forwarded base flag');
    assert.strictEqual(forward.extended, false, 'forwarded extended flag (latched off without base)');
    assert.strictEqual(forward.endpoint, 'https://recv.example/ingest', 'forwarded endpoint');
    assert.strictEqual(forward.authToken, TELEMETRY_SECRET,
      'the CLEARTEXT auth token is forwarded over the internal IPC channel (NOT masked here)');
  });

  it('does NOT call process.send when the server is standalone (no parent IPC)', async () => {
    // The forward is guarded by `typeof process.send === 'function'`. With no
    // mock installed, a standalone server must skip the IPC forward (no crash).
    assert.ok(typeof process.send !== 'function', 'precondition: no parent IPC');
    const res = await put({ telemetryBaseEnabled: false });
    assert.strictEqual(res.res.status, 200, 'PUT succeeds without parent IPC');
  });

  it('applies the companion transport toggle LIVE (env-var gate flips without a restart)', async () => {
    // applyCompanionToggle runs after save so a flip takes effect on the next op.
    // With the env NOT operator-overridden at boot (before() deletes it), the
    // toggle drives WARDEN_COMPANION_TRANSPORT directly — observable here.
    // (server.js primes '0' at import from the default-OFF cfg, so flip to ON.)
    await put({ companionTransportEnabled: true });
    assert.strictEqual(process.env.WARDEN_COMPANION_TRANSPORT, '1',
      'applyCompanionToggle fired: live gate flipped ON');
    await put({ companionTransportEnabled: false });
    assert.strictEqual(process.env.WARDEN_COMPANION_TRANSPORT, '0',
      'applyCompanionToggle fired: live gate flipped OFF');
  });
});
