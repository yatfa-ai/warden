// Unit tests for the bounded GET helper `fetchJson` (WARDEN-828).
//
// The Settings load forever-spinner was caused by a bare `Promise.all` of two
// fetches with no timeout and no retry: a transiently-slow backend spun
// `loading` indefinitely. `fetchJson` (web/src/lib/api.ts) wraps fetch with a
// per-attempt AbortController timeout + a bounded retry, returning the existing
// ApiResult error-state shape so a timeout reads identically to a 500.
//
// These tests prove the THREE behaviors the worker-container bar requires
// (since the installed-app Chromium case can't be reproduced here): a transient
// blip self-heals via retry, a terminal failure resolves to a bounded ok:false
// (never an unending promise), and a stalled backend is aborted by the timeout
// rather than awaited forever. `fetchImpl`/`sleepImpl` injection seams make the
// timeout/retry/terminal branches deterministic WITHOUT real timers — backoff
// is zero-delay, and a hanging fake fetch is aborted by a tiny real timeoutMs.
//
// Loads the REAL web/src/lib/api.ts, transpiled TS -> ESM via Vite's OXC
// transform (same harness as telemetry-test-connection.test.mjs). The module has
// only `import type` (erased) and globals, so it loads standalone.
//
// Run: node fetch-json.test.mjs   (from web/)

import { transformWithOxc } from 'vite';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const modPath = resolve(__dirname, 'src/lib/api.ts');

// --- Load the REAL api.ts (TS -> ESM via the OXC transform Vite uses) ---
const src = readFileSync(modPath, 'utf8');
const { code } = await transformWithOxc(src, modPath, {});
const tmpDir = mkdtempSync(join(tmpdir(), 'warden-fetch-json-'));
const tmpFile = join(tmpDir, 'api.mjs');
writeFileSync(tmpFile, code);
const { fetchJson } = await import(tmpFile);
rmSync(tmpDir, { recursive: true, force: true });

// --- Fake fetch + response builders ---------------------------------------
//
// The real `fetch` is replaced by a scripted fake so the retry/timeout logic is
// exercised deterministically. `Response`-shaped objects carry just the fields
// `fetchJson` reads: `ok`, `status`, and an async `json()`.

const jsonRes = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});
const ok = (body) => jsonRes(200, body);

let passed = 0;
const test = async (name, fn) => {
  await fn();
  passed += 1;
  console.log('  ok -', name);
};

// Track how many attempts each scripted fetch saw — asserts the retry COUNT.
const scriptableFetch = (responses) => {
  let calls = 0;
  const fn = () => {
    const i = calls;
    calls += 1;
    const next = responses[i];
    if (typeof next === 'function') return next();
    return Promise.resolve(next);
  };
  fn.calls = () => calls;
  return fn;
};

const sleepZero = async () => {}; // zero-delay backoff → fast + deterministic

// === Success / retry / terminal ===========================================

await test('2xx on the first attempt returns ok:true + data and does not retry', async () => {
  const fetchImpl = scriptableFetch([ok({ hosts: ['h1', 'h2'] })]);
  const r = await fetchJson('/api/ssh-hosts', { fetchImpl, sleepImpl: sleepZero });
  assert.equal(r.ok, true);
  assert.deepEqual(r.data, { hosts: ['h1', 'h2'] });
  assert.equal(fetchImpl.calls(), 1, 'a success must not be retried');
});

await test('a transient network failure self-heals via retry → ok:true', async () => {
  // Attempt 1 throws (network blip), attempt 2 succeeds. retries=2 allows it.
  const fetchImpl = scriptableFetch([
    () => Promise.reject(new Error('fetch failed')),
    () => Promise.resolve(ok({ recovered: true })),
  ]);
  const r = await fetchJson('/api/config', { retries: 2, fetchImpl, sleepImpl: sleepZero });
  assert.equal(r.ok, true);
  assert.equal(r.data.recovered, true);
  assert.equal(fetchImpl.calls(), 2, 'the blip is retried exactly once before success');
});

await test('retries exhausted on permanent network failure → ok:false, never resolves forever', async () => {
  const fetchImpl = scriptableFetch([
    () => Promise.reject(new Error('down')),
    () => Promise.reject(new Error('down')),
    () => Promise.reject(new Error('down')),
  ]);
  const r = await fetchJson('/api/config', { retries: 2, fetchImpl, sleepImpl: sleepZero });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'down');
  assert.equal(fetchImpl.calls(), 3, '1 initial + 2 retries = 3 total attempts');
});

await test('retries=0 means a single attempt — a failure is terminal immediately', async () => {
  const fetchImpl = scriptableFetch([() => Promise.reject(new Error('nope'))]);
  const r = await fetchJson('/api/config', { retries: 0, fetchImpl, sleepImpl: sleepZero });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'nope');
  assert.equal(fetchImpl.calls(), 1);
});

// === HTTP status retry policy =============================================

await test('5xx is transient — retried, and after exhaustion returns ok:false', async () => {
  const fetchImpl = scriptableFetch([
    jsonRes(503, { error: 'busy' }),
    jsonRes(503, { error: 'busy' }),
    jsonRes(503, { error: 'busy' }),
  ]);
  const r = await fetchJson('/api/config', { retries: 2, fetchImpl, sleepImpl: sleepZero });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'busy');
  assert.equal(fetchImpl.calls(), 3, '5xx is retried up to the retry budget');
});

await test('5xx then recovery → ok:true (a transient server error heals)', async () => {
  const fetchImpl = scriptableFetch([
    jsonRes(500, {}),
    ok({ back: true }),
  ]);
  const r = await fetchJson('/api/config', { retries: 2, fetchImpl, sleepImpl: sleepZero });
  assert.equal(r.ok, true);
  assert.equal(r.data.back, true);
  assert.equal(fetchImpl.calls(), 2);
});

await test('4xx is a hard client error — returned at once, NOT retried', async () => {
  const fetchImpl = scriptableFetch([jsonRes(404, { error: 'not found' })]);
  const r = await fetchJson('/api/config', { retries: 2, fetchImpl, sleepImpl: sleepZero });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'not found');
  assert.equal(fetchImpl.calls(), 1, 'a 4xx must not be retried — retrying a client error hammers');
});

await test('a non-JSON 2xx body degrades to ok:true with undefined data (parity with requestJson)', async () => {
  const fetchImpl = scriptableFetch([{ ok: true, status: 200, json: async () => { throw new Error('bad json'); } }]);
  const r = await fetchJson('/api/config', { fetchImpl, sleepImpl: sleepZero });
  assert.equal(r.ok, true);
  assert.equal(r.data, undefined);
});

// === Timeout — the core "never spin forever" guarantee =====================

await test('a stalled backend is aborted by the timeout and counted as a retryable failure', async () => {
  // The fake fetch HANGS — it never resolves on its own. The only way it settles
  // is the AbortController timeout firing and rejecting via the abort signal.
  // This is the WARDEN-828 forever-spinner scenario: with no timeout this promise
  // would never settle. A tiny real timeoutMs keeps the test fast (~tens of ms).
  const hangingFetch = (url, { signal }) =>
    new Promise((_resolve, reject) => {
      const onAbort = () => reject(new Error('The operation was aborted.'));
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
    });
  const start = Date.now();
  const r = await fetchJson('/api/config', {
    retries: 1,
    timeoutMs: 30,
    fetchImpl: hangingFetch,
    sleepImpl: sleepZero,
  });
  const elapsed = Date.now() - start;
  assert.equal(r.ok, false, 'an unreachable backend resolves to a bounded failure');
  assert.ok(/abort/i.test(r.error), `error should mention abort, got: ${r.error}`);
  // Bounded: 2 attempts × 30ms timeout ≈ 60ms + a little slack. Proves it did
  // NOT spin forever (would be seconds-to-infinity pre-fix).
  assert.ok(elapsed < 1000, `load must be bounded, took ${elapsed}ms`);
});

await test('the timeout passes an AbortSignal to fetch (the deadline is wired through)', async () => {
  let sawSignal = null;
  const fetchImpl = (url, opts) => {
    sawSignal = opts?.signal;
    return Promise.resolve(ok({ wired: true }));
  };
  await fetchJson('/api/config', { fetchImpl, sleepImpl: sleepZero });
  assert.ok(sawSignal, 'fetch must receive an options object');
  assert.ok(typeof sawSignal.addEventListener === 'function', 'an AbortSignal must be passed');
});

// === Error-message surface ================================================

await test('a 5xx with no error field surfaces a status-derived message', async () => {
  const fetchImpl = scriptableFetch([jsonRes(502, {})]);
  const r = await fetchJson('/api/config', { retries: 0, fetchImpl, sleepImpl: sleepZero });
  assert.equal(r.ok, false);
  assert.match(r.error, /502/, 'falls back to a status string when the body has no error');
});

console.log(`\n# tests ${passed}`);
console.log('# pass', passed);
console.log('# fail 0');
