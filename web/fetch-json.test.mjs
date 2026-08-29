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
const { fetchJson, postJson, putJson } = await import(tmpFile);
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

// A response whose HEADERS arrived (so `ok`/`status` are set) but whose BODY
// fails to parse — the truncated-mid-stream shape a dropped SSH tunnel produces.
// `fetch` resolves on headers, so this is `res.ok === true` with a rejecting
// `json()`; it is the WARDEN-1023 scenario at both defect sites.
const unparseableStatus = (status) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => { throw new Error('bad json'); },
});
const unparseable2xx = () => unparseableStatus(200);

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

// A 2xx whose body fails to parse is a REAL failure (WARDEN-1023).
//
// This test previously asserted the OPPOSITE (`ok:true` + `data: undefined`,
// "parity with requestJson") and so actively pinned the bug in — the right
// scenario with the wrong expectation, exactly the shape WARDEN-89 names.
// The convention it now matches is `readListBody` (WARDEN-1014, api.ts): the
// `.catch(() => undefined)` tolerance belongs to the NON-2xx leg only, because
// `fetch` resolves as soon as the HEADERS arrive — a body truncated mid-stream
// (a dropped SSH tunnel) is `res.ok === true` with a rejecting `json()`.
// Reported as ok:true, that rendered Settings as confident DEFAULTS with Save
// enabled, one click from overwriting the user's real backend config.
await test('a non-JSON 2xx body is a REAL failure → ok:false (not ok:true + undefined data)', async () => {
  const fetchImpl = scriptableFetch([unparseable2xx(), unparseable2xx(), unparseable2xx()]);
  const r = await fetchJson('/api/config', { retries: 2, fetchImpl, sleepImpl: sleepZero });
  assert.equal(r.ok, false, 'a truncated 200 must NOT be reported as a success');
  assert.equal(r.data, undefined);
  assert.ok(r.error, 'the parse failure must surface a non-empty error for the Retry state');
  assert.match(r.error, /bad json/);
});

await test('a truncated 2xx is retryable — it joins the transient path, then goes terminal', async () => {
  // A mid-stream truncation is the same transient class as a 5xx, so it is
  // retried rather than failed at once...
  const fetchImpl = scriptableFetch([unparseable2xx(), unparseable2xx(), unparseable2xx()]);
  const r = await fetchJson('/api/config', { retries: 2, fetchImpl, sleepImpl: sleepZero });
  assert.equal(r.ok, false);
  assert.equal(fetchImpl.calls(), 3, '1 initial + 2 retries — a truncated 2xx is retried');
});

await test('a truncated 2xx that heals on retry → ok:true with the real data', async () => {
  // ...and a blip that self-heals must still deliver the body, not an error.
  const fetchImpl = scriptableFetch([unparseable2xx(), ok({ tmuxSession: 'agent' })]);
  const r = await fetchJson('/api/config', { retries: 2, fetchImpl, sleepImpl: sleepZero });
  assert.equal(r.ok, true);
  assert.deepEqual(r.data, { tmuxSession: 'agent' });
});

await test('the non-2xx tolerance is PRESERVED — an HTML 500 body still reads as ok:false', async () => {
  // The gate must narrow the tolerance to the failure leg, not remove it: a
  // 5xx serving an HTML error page must never surface a raw JSON parse error.
  const fetchImpl = scriptableFetch([
    unparseableStatus(500), unparseableStatus(500), unparseableStatus(500),
  ]);
  const r = await fetchJson('/api/config', { retries: 2, fetchImpl, sleepImpl: sleepZero });
  assert.equal(r.ok, false);
  assert.match(r.error, /500/, 'the STATUS carries the message when the body will not parse');
  assert.doesNotMatch(r.error, /bad json/, 'a failure body must not leak a JSON parse error');
});

await test('an HTML 4xx body still returns at once without retrying', async () => {
  const fetchImpl = scriptableFetch([unparseableStatus(404)]);
  const r = await fetchJson('/api/config', { retries: 2, fetchImpl, sleepImpl: sleepZero });
  assert.equal(r.ok, false);
  assert.equal(r.error, undefined, 'no error field in an unparseable body → undefined, not a throw');
  assert.equal(fetchImpl.calls(), 1, 'a 4xx must not be retried even when its body is junk');
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

// === requestJson (postJson / putJson) — the SECOND defect site =============
//
// `requestJson` had the identical ungated `.catch(() => undefined)` and was the
// stated precedent the `fetchJson` bug was written for ("parity with
// requestJson"), yet this file never exercised it. It has no `fetchImpl` seam,
// so these tests swap `globalThis.fetch` for the duration.

const withFetch = async (impl, fn) => {
  const real = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    return await fn();
  } finally {
    globalThis.fetch = real;
  }
};

await test('postJson: a non-JSON 2xx body is a REAL failure → ok:false + error', async () => {
  const r = await withFetch(async () => unparseable2xx(), () => postJson('/api/send', { t: 'hi' }));
  assert.equal(r.ok, false, 'a truncated 200 must NOT be reported as a success');
  assert.equal(r.data, undefined);
  assert.match(r.error, /bad json/);
});

await test('putJson: a truncated 200 on /api/config surfaces ok:false, not a silent success', async () => {
  const r = await withFetch(async () => unparseable2xx(), () => putJson('/api/config', { hosts: [] }));
  assert.equal(r.ok, false);
  assert.match(r.error, /bad json/);
});

await test('postJson: a well-formed 2xx still returns ok:true + parsed data', async () => {
  const r = await withFetch(async () => ok({ saved: true }), () => postJson('/api/send', {}));
  assert.equal(r.ok, true);
  assert.deepEqual(r.data, { saved: true });
});

await test('postJson: the non-2xx tolerance is PRESERVED — an HTML 500 reads as ok:false', async () => {
  const r = await withFetch(async () => unparseableStatus(500), () => postJson('/api/send', {}));
  assert.equal(r.ok, false, 'the status still drives the failure');
  assert.equal(r.error, undefined, 'an unparseable failure body degrades to undefined, never throws');
  assert.equal(r.res.status, 500, 'the raw Response is still handed to the caller');
});

await test('postJson: a 4xx with a JSON error body still surfaces that error', async () => {
  const r = await withFetch(async () => jsonRes(400, { error: 'bad request' }), () =>
    postJson('/api/send', {}),
  );
  assert.equal(r.ok, false);
  assert.equal(r.error, 'bad request');
});

console.log(`\n# tests ${passed}`);
console.log('# pass', passed);
console.log('# fail 0');
