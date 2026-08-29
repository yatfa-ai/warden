// Unit tests for the Collections READ seam `readCollectionsList` (WARDEN-1181).
//
// WHAT IS BEING PINNED, and why the obvious test would never go red:
//
// The pre-fix read path in CollectionsSection.tsx was:
//
//     const r = await fetch('/api/collections');
//     const j = await r.json();          // no r.ok gate, no parse tolerance
//     setCollections(j.collections || []);
//     } catch { setCollections([]); }    // EVERY failure → the same empty list
//
// Both legs converged on `[]`, which renders the section's definitive empty state
// ("no collections — create one to organize agents") with a `0` badge. A failure
// was reported to the user as a FACT ABOUT THEIR DATA — the WARDEN-89 false-empty
// disease, and the whole point of this ticket.
//
// ⚠ THE PREMISE TRAP. The originating proposal's failure story was that a corrupt
// `collections.json` makes `loadCollections` throw → HTTP 500. That chain DOES NOT
// EXIST: `loadCollections` (src/collections.js:18-21) delegates to
// `readJsonDefensive`, which is defensive on every leg — ENOENT (persist.js:151),
// unreadable (:153-154), parse error (:159-162) and revive error (:166-169, which
// catches the very throw the proposal relied on) — and returns the caller's
// fallback. So a corrupt file answers **200 {collections: []}**, which is CORRECT
// behaviour and must keep rendering the empty state. A test that corrupts the file
// and asserts a 500 returns 200 and passes vacuously. The last test below pins
// that 200-empty case explicitly so the fix cannot over-correct into treating a
// genuine emptiness as a failure.
//
// THE FAILURE SHAPES THAT ARE ACTUALLY LIVE, all from warden's normal deployment
// shape (remote hosts over an SSH tunnel / reverse proxy, WARDEN-1055):
//   1. non-2xx carrying an HTML body — a 502/503/504 from the proxy or a dropped
//      tunnel. `r.json()` REJECTS on HTML, so the old bare `catch` seated `[]`.
//   2. a truncated 2xx body — `fetch` resolves `ok: true` as soon as the HEADERS
//      arrive, so a body cut mid-stream rejects at `.json()`. Same false empty.
//   3. a route-level throw — src/server.js:901-908 answers 500 {error}.
// Each has a test below, and each FAILS against the pre-fix code (which returned
// `[]` with no error channel for all three).
//
// This is a SEPARATE file from list-response.test.mjs on purpose: that file pins
// the SHARED reader's own contract, which this ticket leaves byte-for-byte
// unmodified. This file pins the Collections ADOPTION of it.
//
// Loads the REAL web/src/lib/api.ts + web/src/lib/collectionsApi.ts (transpiled
// TS -> ESM via Vite's OXC transform), same harness as list-response.test.mjs and
// sectionLoadGate.test.mjs. `readListResponse` reads only `ok`/`status`, so plain
// objects stand in for a Response — no DOM, no React, no fetch polyfill needed.
//
// Run: node --test collectionsRead.test.mjs   (from web/)

import { transformWithOxc } from 'vite';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const libDir = resolve(__dirname, 'src/lib');

// --- Load the REAL modules (TS -> ESM via the OXC transform) ---
const tmpDir = mkdtempSync(join(tmpdir(), 'warden-collections-read-test-'));
for (const name of ['api', 'collectionsApi']) {
  const path = join(libDir, `${name}.ts`);
  const { code } = await transformWithOxc(readFileSync(path, 'utf8'), path, {});
  // Node's ESM loader needs a real file extension on the relative specifier.
  // Quote-agnostic: the OXC transform is free to emit either quote style.
  const rewritten = code.replace(/(['"])\.\/api\1/g, "'./api.mjs'");
  writeFileSync(join(tmpDir, `${name}.mjs`), rewritten);
}
const { readCollectionsList } = await import(join(tmpDir, 'collectionsApi.mjs'));
rmSync(tmpDir, { recursive: true, force: true });

// A stand-in Response. `json` is a thunk so each case controls whether the body
// RESOLVES (parsed) or REJECTS (unparseable / truncated) — the distinction the
// whole fix turns on.
const res = (ok, status, json) => ({ ok, status, json });
const resolves = (body) => () => Promise.resolve(body);
// What `Response.json()` actually does on a body that is not JSON: it REJECTS.
// (An HTML error page from a proxy, or a stream cut mid-object.)
const rejects = (message) => () => Promise.reject(new SyntaxError(message));

const COLLECTIONS = [
  { id: 'c1', name: 'backend', criteria: { role: 'worker' } },
  { id: 'c2', name: 'frontend', criteria: {} },
];

// --- 1. The happy path still works, unchanged ---------------------------------

test('a clean 200 returns the collections array verbatim', async () => {
  const items = await readCollectionsList(res(true, 200, resolves({ collections: COLLECTIONS })));
  assert.deepEqual(items, COLLECTIONS);
});

// --- 2. Non-2xx: the failure must be DISTINGUISHABLE from emptiness -----------

test('a 500 from the route THROWS rather than returning an empty list', async () => {
  // src/server.js:901-908 answers 500 {error: e.message}. The old code discarded
  // it and rendered "no collections".
  await assert.rejects(
    () => readCollectionsList(res(false, 500, resolves({ error: 'boom' }))),
    /Failed to load collections \(500\)/,
  );
});

test('a 502 carrying an HTML error page throws a GRACEFUL message, not a TypeError', async () => {
  // Failure shape #1: a proxy/tunnel 502 whose body is HTML. `.json()` rejects.
  // `readListBody` makes the body optional on the !ok leg precisely for this, so
  // the STATUS still produces a readable message.
  await assert.rejects(
    () => readCollectionsList(res(false, 502, rejects('Unexpected token < in JSON at position 0'))),
    (e) => {
      assert.ok(e instanceof Error);
      assert.match(e.message, /Failed to load collections \(502\)/);
      // The user-visible harm this ticket exists to prevent: a raw parse error
      // leaking to the toast, or worse, a silent empty list.
      assert.doesNotMatch(e.message, /Unexpected token/);
      return true;
    },
  );
});

test('the message a 503 produces is fit for a toast — no stack, no JSON noise', async () => {
  // This string goes straight into `toast.error` at the call site, so its shape
  // is part of the contract, not an implementation detail.
  await assert.rejects(
    () => readCollectionsList(res(false, 503, rejects('<!doctype html>'))),
    (e) => e.message === 'Failed to load collections (503)',
  );
});

// --- 3. Truncated 2xx: `ok` is NOT proof the body arrived ---------------------

test('a TRUNCATED 2xx body is treated as a failure, NOT as an empty list', async () => {
  // Failure shape #2, and the subtlest one: `fetch` resolves ok:true as soon as
  // the HEADERS arrive, so a dropped SSH tunnel mid-stream lands here. Swallowing
  // this rejection would hand the reader an empty record it can only read as
  // "{items: [], error: null}" — a confident empty list for a network failure.
  // `readListBody` deliberately lets the 2xx leg reject for exactly this reason.
  await assert.rejects(
    () => readCollectionsList(res(true, 200, rejects('Unexpected end of JSON input'))),
    (e) => {
      assert.ok(e instanceof Error);
      // The parse rejection itself propagates here — the caller's catch turns it
      // into a toast. What matters is that it is NOT an empty array.
      assert.match(e.message, /Unexpected end of JSON input/);
      return true;
    },
  );
});

// --- 4. The 200-with-{error} half of warden's error convention ----------------

test('a 200 carrying a non-empty {error} throws — the half an r.ok gate alone misses', async () => {
  await assert.rejects(
    () => readCollectionsList(res(true, 200, resolves({ collections: [], error: 'no cwd' }))),
    /no cwd/,
  );
});

test("a 200 spreading an EMPTY error string is success, not a failure", async () => {
  // `readListResponse` treats only a NON-EMPTY error as an error, so a route that
  // spreads `error: ''` still reads as clean. Pinned so the adoption inherits it.
  const items = await readCollectionsList(res(true, 200, resolves({ collections: COLLECTIONS, error: '' })));
  assert.deepEqual(items, COLLECTIONS);
});

// --- 5. Genuine emptiness must STILL be empty (the over-correction guard) -----

test('a genuinely empty 200 returns [] and does NOT throw — the empty state is preserved', async () => {
  // Success criterion 4. This is also the corrupt-collections.json case: because
  // readJsonDefensive swallows the revive throw and returns its fallback, a
  // corrupt file legitimately answers 200 {collections: []}. It must keep
  // rendering "no collections", so the fix must not read emptiness as failure.
  const items = await readCollectionsList(res(true, 200, resolves({ collections: [] })));
  assert.deepEqual(items, []);
});

test('a 200 whose body omits `collections` entirely returns [] rather than throwing', async () => {
  const items = await readCollectionsList(res(true, 200, resolves({})));
  assert.deepEqual(items, []);
});

test('a 200 whose `collections` key is not an array degrades to [] rather than leaking a non-list', async () => {
  // The caller does `collections.map(...)`, so a non-array must never reach it.
  const items = await readCollectionsList(res(true, 200, resolves({ collections: 'nope' })));
  assert.deepEqual(items, []);
});

// --- 6. The distinction the whole ticket is about ----------------------------

test('failure and emptiness are DISTINGUISHABLE — the false-empty is closed', async () => {
  // The one assertion that states the defect directly: before this fix, all four
  // of these produced the byte-identical result `[]`, so the UI could not tell a
  // broken backend from a user with no collections.
  const empty = await readCollectionsList(res(true, 200, resolves({ collections: [] })));
  assert.deepEqual(empty, [], 'a real emptiness still reads as empty');

  for (const failure of [
    res(false, 500, resolves({ error: 'boom' })),      // route throw
    res(false, 502, rejects('<html>')),                 // proxy, HTML body
    res(true, 200, rejects('Unexpected end of JSON input')), // truncated stream
  ]) {
    await assert.rejects(
      () => readCollectionsList(failure),
      (e) => e instanceof Error && e.message.length > 0,
      'every failure shape must throw, never return an empty list',
    );
  }
});
