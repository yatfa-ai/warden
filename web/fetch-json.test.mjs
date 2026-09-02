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
const { fetchJson, fetchBounded, pollerFetchOptions, postJson, putJson } = await import(tmpFile);
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


// === fetchBounded — the RAW-Response shell over the same deadline (WARDEN-1144) ==
//
// Most of warden's UI-gating reads read their body through the house readers
// (readListBody + readListResponse/readResponse/readErrorBody), whose contract
// fetchJson cannot express: a 200 carrying `{error}` is a FAILURE. Routing those
// sites through fetchJson would flatten that back into the WARDEN-89 false-empty
// it exists to remove — so they get the DEADLINE without the body contract.

await test('fetchBounded returns the raw Response, body untouched, on a 2xx', async () => {
  const res = ok({ commits: [{ hash: 'abc' }] });
  const fetchImpl = scriptableFetch([res]);
  const r = await fetchBounded('/api/git-log', { fetchImpl, sleepImpl: sleepZero });
  assert.equal(r, res, 'the caller owns the Response — nothing is parsed for it');
  assert.deepEqual(await r.json(), { commits: [{ hash: 'abc' }] }, 'the body stream is unread');
});

await test('fetchBounded hands back a 200-carrying-{error} UNTOUCHED (the house convention survives)', async () => {
  // This is the whole reason the sibling exists: fetchJson reports ANY 2xx as
  // ok:true, so this response would have read as a confident success. Here the
  // caller's readListResponse still gets to call it a failure.
  const fetchImpl = scriptableFetch([ok({ commits: [], error: 'no cwd' })]);
  const r = await fetchBounded('/api/git-log', { fetchImpl, sleepImpl: sleepZero });
  assert.equal(r.ok, true, 'the transport succeeded — the verdict is the caller\u2019s');
  assert.deepEqual(await r.json(), { commits: [], error: 'no cwd' });
});

await test('fetchBounded does NOT retry a 5xx — an HTTP status is a settled answer', async () => {
  // Deciding a 5xx is retryable requires reading the body, which would consume
  // the stream the caller owns. So the retry policy here is transport-only.
  const fetchImpl = scriptableFetch([jsonRes(503, { error: 'busy' })]);
  const r = await fetchBounded('/api/git-log', { retries: 2, fetchImpl, sleepImpl: sleepZero });
  assert.equal(r.status, 503, 'the status is handed back for the caller to read');
  assert.equal(fetchImpl.calls(), 1, 'an HTTP answer is settled, not retried');
});

await test('fetchBounded retries a transient TRANSPORT failure, then heals', async () => {
  const fetchImpl = scriptableFetch([
    () => Promise.reject(new Error('fetch failed')),
    () => Promise.resolve(ok({ healed: true })),
  ]);
  const r = await fetchBounded('/api/git-log', { retries: 2, fetchImpl, sleepImpl: sleepZero });
  assert.deepEqual(await r.json(), { healed: true });
  assert.equal(fetchImpl.calls(), 2);
});

await test('fetchBounded THROWS on exhaustion — the call site\u2019s existing catch is the error path', async () => {
  // Unlike fetchJson (which never throws), this replaces a raw `fetch` at sites
  // that already wrap it in try/catch, so a failure must land in that catch.
  const fetchImpl = scriptableFetch([
    () => Promise.reject(new Error('down')),
    () => Promise.reject(new Error('down')),
  ]);
  await assert.rejects(
    () => fetchBounded('/api/git-log', { retries: 1, fetchImpl, sleepImpl: sleepZero }),
    /down/,
  );
  assert.equal(fetchImpl.calls(), 2);
});

await test('fetchBounded aborts a STALLED backend rather than awaiting it forever', async () => {
  // The core guarantee, for the shell the 20+ adopted surfaces actually use: a
  // fake fetch that never resolves on its own settles ONLY because the deadline
  // fires. Without it the caller's `finally` (which clears the spinner) is never
  // reached — the forever-spinner this ticket closes.
  const hangingFetch = (url, { signal }) =>
    new Promise((_resolve, reject) => {
      const onAbort = () => reject(new Error('The operation was aborted.'));
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
    });
  const start = Date.now();
  await assert.rejects(
    () => fetchBounded('/api/health', { retries: 1, timeoutMs: 30, fetchImpl: hangingFetch, sleepImpl: sleepZero }),
    /abort/i,
  );
  assert.ok(Date.now() - start < 1000, 'the wait must be bounded, not infinite');
});

await test('fetchBounded passes `init` through so a READ expressed as a POST is bounded too', async () => {
  // The boundary is "does it gate a UI surface", not "is it a GET":
  // /api/read-file and /api/search-files are reads whose query rides the body.
  let seen = null;
  const fetchImpl = (url, opts) => { seen = opts; return Promise.resolve(ok({})); };
  await fetchBounded('/api/read-file', {
    fetchImpl,
    sleepImpl: sleepZero,
    init: { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"path":"x"}' },
  });
  assert.equal(seen.method, 'POST');
  assert.equal(seen.body, '{"path":"x"}');
  assert.ok(seen.signal, 'the deadline signal is still installed over the caller\u2019s init');
});

// === Cancellation composes with the deadline, it is not replaced by it ========
//
// FileViewer already holds a per-session AbortController (close / switch /
// unmount). The ticket's boundary: that behaviour SURVIVES — a deadline composes
// with a cancellation controller rather than replacing it.

await test('a caller signal aborted MID-FLIGHT rejects with the caller\u2019s own reason', async () => {
  const caller = new AbortController();
  const hangingFetch = (url, { signal }) =>
    new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('inner abort')), { once: true });
    });
  const p = fetchBounded('/api/read-file', {
    retries: 3,
    timeoutMs: 5_000,
    fetchImpl: hangingFetch,
    sleepImpl: sleepZero,
    signal: caller.signal,
  });
  caller.abort();
  const err = await p.then(() => null, (e) => e);
  assert.ok(err, 'a cancelled read rejects');
  assert.equal(err.name, 'AbortError',
    'the caller\u2019s AbortError surfaces verbatim, so existing `err.name === "AbortError"` guards still fire');
});

await test('a caller cancellation is TERMINAL — it is never retried', async () => {
  // A cancellation is not a transient failure: nobody is waiting for the result,
  // so burning the retry budget on it would be pure waste against a live server.
  const caller = new AbortController();
  const fetchImpl = scriptableFetch([
    () => { caller.abort(); return Promise.reject(new Error('aborted')); },
    () => Promise.resolve(ok({ shouldNeverHappen: true })),
  ]);
  await assert.rejects(
    () => fetchBounded('/api/read-file', { retries: 3, fetchImpl, sleepImpl: sleepZero, signal: caller.signal }),
    (e) => e.name === 'AbortError',
  );
  assert.equal(fetchImpl.calls(), 1, 'no retry after a cancellation');
});

await test('an ALREADY-aborted caller signal never issues a request at all', async () => {
  const caller = new AbortController();
  caller.abort();
  const fetchImpl = scriptableFetch([ok({})]);
  await assert.rejects(
    () => fetchBounded('/api/read-file', { fetchImpl, sleepImpl: sleepZero, signal: caller.signal }),
    (e) => e.name === 'AbortError',
  );
  assert.equal(fetchImpl.calls(), 0);
});

await test('the DEADLINE still fires for a caller that supplied a signal (both are live)', async () => {
  // The composition must not be one-or-the-other: a caller who passes a
  // cancellation controller still gets the deadline, or FileViewer would be the
  // one surface left unbounded.
  const caller = new AbortController(); // never aborted
  const hangingFetch = (url, { signal }) =>
    new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('The operation was aborted.')), { once: true });
    });
  await assert.rejects(
    () => fetchBounded('/api/read-file', {
      retries: 0, timeoutMs: 30, fetchImpl: hangingFetch, sleepImpl: sleepZero, signal: caller.signal,
    }),
    /abort/i,
  );
});

await test('fetchJson composes with a caller signal on the same terms', async () => {
  const caller = new AbortController();
  caller.abort();
  const fetchImpl = scriptableFetch([ok({})]);
  await assert.rejects(
    () => fetchJson('/api/config', { fetchImpl, sleepImpl: sleepZero, signal: caller.signal }),
    (e) => e.name === 'AbortError',
  );
  assert.equal(fetchImpl.calls(), 0);
});

// === pollerFetchOptions — the written-down poller policy ====================
//
// The one-shot defaults are WRONG for an interval poller and the policy is not
// for each hook to re-derive: the poller core calls its fetch on every tick
// unconditionally (no in-flight guard), so a stalled tick self-heals on the next
// one — THE NEXT TICK IS THE RETRY. What a stall does instead is STACK requests
// against a server that can block. The fix is a shorter leash, not a longer one.

await test('a poller never retries — the next tick is the retry', async () => {
  assert.equal(pollerFetchOptions(10_000).retries, 0);
  assert.equal(pollerFetchOptions(120_000).retries, 0);
});

await test('the deadline is STRICTLY shorter than the poll period, at every cadence', async () => {
  // The invariant the whole policy rests on: one tick's attempts can never
  // outlive the window they were issued in, so ticks cannot stack.
  for (const period of [10_000, 15_000, 30_000, 60_000, 90_000, 120_000]) {
    const { timeoutMs } = pollerFetchOptions(period);
    assert.ok(timeoutMs < period, `deadline ${timeoutMs}ms must be < period ${period}ms`);
  }
});

await test('half the period is the ceiling (the sharpest case: the 10s health poll)', async () => {
  // On the one-shot defaults this poll would spend 3 attempts x 8s ~= 24s of
  // attempts inside a 10s window — three ticks' worth of overlap from ONE tick.
  // That case is what set the bar for the policy.
  const { retries, timeoutMs } = pollerFetchOptions(10_000);
  assert.equal(timeoutMs, 5_000, 'half of 10s');
  assert.equal(retries, 0);
  const worstCase = timeoutMs * (retries + 1);
  assert.ok(worstCase < 10_000, `one tick must not outlive its window (${worstCase}ms)`);
});

await test('a SLOW cadence is capped at the one-shot default, not given a huge leash', async () => {
  // Half of a 120s budget poll would be a 60s deadline — bounded, but useless as
  // a deadline. The cap keeps a slow poller's leash sane.
  assert.equal(pollerFetchOptions(120_000).timeoutMs, 8_000);
  assert.equal(pollerFetchOptions(90_000).timeoutMs, 8_000);
});

await test('a FAST cadence still tolerates a real round-trip (the floor)', async () => {
  // Half of a 1s period is 500ms, which would fail a healthy SSH-backed request
  // on every tick and report a permanently-broken surface. The floor prevents a
  // deadline so tight it manufactures failures.
  assert.equal(pollerFetchOptions(1_000).timeoutMs, 1_000);
  assert.equal(pollerFetchOptions(500).timeoutMs, 1_000);
});

await test('the poller options actually BOUND a stalled tick when passed to fetchBounded', async () => {
  // End-to-end: the policy is only worth anything if a hook that spreads it gets
  // exactly one aborted attempt rather than a stacked retry storm.
  let attempts = 0;
  const hangingFetch = (url, { signal }) => {
    attempts += 1;
    return new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('The operation was aborted.')), { once: true });
    });
  };
  const opts = pollerFetchOptions(10_000);
  const start = Date.now();
  await assert.rejects(
    () => fetchBounded('/api/health', { ...opts, timeoutMs: 30, fetchImpl: hangingFetch, sleepImpl: sleepZero }),
    /abort/i,
  );
  assert.equal(attempts, 1, 'retries:0 means exactly ONE in-flight request per tick');
  assert.ok(Date.now() - start < 1000);
});

console.log(`\n# tests ${passed}`);
console.log('# pass', passed);
console.log('# fail 0');
