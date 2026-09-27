// Unit tests for the cross-host "All Sessions" READ seam `readAllSessionsPage`
// (WARDEN-1188).
//
// WHAT IS BEING PINNED. The pre-fix read paths in OpenChatBrowserPage.tsx were:
//
//     const r = await fetch(`/api/claude-sessions-all?…`);
//     const j = await r.json();            // no r.ok gate, no parse tolerance
//     setAllSessions(j.sessions || []);    // failure → the SAME empty list
//     setHasMoreSessions(!!j.hasMore);
//     } catch (error) { console.error(…); }   // sets NO state at all
//
// On any failure `j.sessions` is undefined, `|| []` seats an empty list, and the
// page renders its confident empty state:
//
//     "Nothing runnable on the selected hosts yet"
//
// A backend failure was reported to the user, in the product's own voice, as a
// FACT ABOUT THEIR MACHINES — the WARDEN-89 false-empty disease. The catch leg was
// worse: it set no state at all, so `allSessions` kept its initial `[]` and the
// same sentence rendered. And the page mounts fresh on every open
// (OpenChatBrowserPage.tsx:255-257), so there is no stale-data cushion: with a
// broken backend, EVERY visit showed "Nothing runnable".
//
// THE FAILURE SHAPES THAT ARE ACTUALLY LIVE on this route:
//   1. a route-level throw — Express 5 auto-forwards to the WARDEN-1105 error
//      handler (src/server.js:2301), which answers 500 {error}. `.json()`
//      SUCCEEDS, so `sessions` is simply undefined — the most direct false empty.
//   2. non-2xx carrying an HTML body — a 502/503/504 from the proxy or a dropped
//      SSH tunnel. `.json()` REJECTS on HTML, so the old bare catch left only a
//      console line.
//   3. a truncated 2xx body — `fetch` resolves ok:true as soon as the HEADERS
//      arrive, so a body cut mid-stream rejects at `.json()`. Same false empty.
// Each has a test below, and each FAILS against the pre-fix code (which produced
// `[]` with no error channel for all three).
//
// ⚠ THE SCALAR THE OBVIOUS FIX DROPS. This route answers
// `res.json({ sessions, hasMore, totals })` (src/server.js:1441) — a list AND a
// scalar. `readListResponse` returns only `{items, error}`, so adopting the shared
// pair RAW would silently discard `hasMore` and break Load-more pagination (the
// same list-vs-scalar mismatch corrected once in WARDEN-1187). The `hasMore`
// tests below exist to pin that it survives the read.
//
// ⚠ WHAT IS NOT CLAIMED. This route emits NO `error` key on any path (handler read
// first-hand at src/server.js:1423-1442), so `readListResponse`'s 2xx-`body.error`
// leg is INERT here. It is not tested as if it were a live channel — the one test
// that touches it says exactly that it is inherited-but-dead.
//
// This is a SEPARATE file from list-response.test.mjs on purpose: that file pins
// the SHARED reader's own contract, which this ticket leaves byte-for-byte
// unmodified. This file pins the All-Sessions ADOPTION of it.
//
// Loads the REAL web/src/lib/api.ts + web/src/lib/allSessionsApi.ts (transpiled
// TS -> ESM via Vite's OXC transform), same harness as collectionsRead.test.mjs
// and gitDiffRead.test.mjs. The reader touches only `ok`/`status`/`json`, so plain
// objects stand in for a Response — no DOM, no React, no fetch polyfill needed.
//
// Run: node --test allSessionsRead.test.mjs   (from web/)

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
const tmpDir = mkdtempSync(join(tmpdir(), 'warden-all-sessions-read-test-'));
for (const name of ['api', 'allSessionsApi']) {
  const path = join(libDir, `${name}.ts`);
  const { code } = await transformWithOxc(readFileSync(path, 'utf8'), path, {});
  // Node's ESM loader needs a real file extension on the relative specifier.
  // Quote-agnostic: the OXC transform is free to emit either quote style.
  const rewritten = code.replace(/(['"])\.\/api\1/g, "'./api.mjs'");
  writeFileSync(join(tmpDir, `${name}.mjs`), rewritten);
}
const { readAllSessionsPage } = await import(join(tmpDir, 'allSessionsApi.mjs'));
rmSync(tmpDir, { recursive: true, force: true });

// A stand-in Response. `json` is a thunk so each case controls whether the body
// RESOLVES (parsed) or REJECTS (unparseable / truncated) — the distinction the
// whole fix turns on.
const res = (ok, status, json) => ({ ok, status, json });
const resolves = (body) => () => Promise.resolve(body);
// What `Response.json()` actually does on a body that is not JSON: it REJECTS.
// (An HTML error page from a proxy, or a stream cut mid-object.)
const rejects = (message) => () => Promise.reject(new SyntaxError(message));

const SESSIONS = [
  { id: 'a1b2c3d4', host: 'local', cwd: '/srv/app', summary: 'refactor the poller', mtime: 1000 },
  { id: 'e5f6a7b8', host: 'box2', cwd: '/srv/api', summary: 'chase the flake', mtime: 900 },
];

// --- 1. The happy path still works, unchanged ---------------------------------

test('a clean 200 returns the sessions array verbatim', async () => {
  const page = await readAllSessionsPage(res(true, 200, resolves({ sessions: SESSIONS, hasMore: false })));
  assert.deepEqual(page.sessions, SESSIONS);
});

// --- 2. The pagination scalar the raw shared reader would DROP -----------------

test('`hasMore: true` SURVIVES the read — the load-more affordance is not lost', async () => {
  // The list-vs-scalar mismatch this seam exists to avoid: `readListResponse`
  // returns only {items, error}, so calling it raw would drop `hasMore` and
  // silently retire Load-more. Read off the body alongside the list instead.
  const page = await readAllSessionsPage(res(true, 200, resolves({ sessions: SESSIONS, hasMore: true })));
  assert.equal(page.hasMore, true);
  assert.deepEqual(page.sessions, SESSIONS);
});

test('`hasMore` is coerced exactly as the call sites did (`!!j.hasMore`)', async () => {
  // Omitted key, and a junk value: both read as "no further page", preserving the
  // pre-fix behaviour rather than inventing a new one.
  const omitted = await readAllSessionsPage(res(true, 200, resolves({ sessions: SESSIONS })));
  assert.equal(omitted.hasMore, false);
  const junk = await readAllSessionsPage(res(true, 200, resolves({ sessions: SESSIONS, hasMore: 'yes' })));
  assert.equal(junk.hasMore, true, 'a truthy non-boolean coerces to true, as `!!` always did');
});

test('`totals` is ignored rather than leaking into the page shape', async () => {
  // The component does not read `totals` (its only occurrence there is a comment),
  // so the seam deliberately does not return it.
  //
  // WARDEN-1200 added `unreachableHosts` to this key set — a deliberate, in-scope
  // widening, not a leak: unlike `totals` the component DOES read it, to render the
  // partial-fleet notice. The exhaustive key assertion is kept (rather than relaxed
  // to a `totals`-only check) precisely so any FUTURE field must come here and
  // justify itself the way this one is doing.
  const page = await readAllSessionsPage(
    res(true, 200, resolves({ sessions: SESSIONS, hasMore: false, totals: { local: 12 } })),
  );
  assert.deepEqual(Object.keys(page).sort(), ['hasMore', 'sessions', 'unreachableHosts']);
  assert.equal(page.totals, undefined, 'the field this test exists for is still not returned');
});

// --- 3. Non-2xx: the failure must be DISTINGUISHABLE from emptiness -----------

test('a 500 from the route THROWS rather than returning an empty list', async () => {
  // Failure shape #1, and success criterion 1. Express 5 auto-forwards a handler
  // throw to the WARDEN-1105 error handler (src/server.js:2301), which answers
  // 500 {error}. `.json()` SUCCEEDS here, so `j.sessions` is simply undefined —
  // the old `|| []` turned that into "Nothing runnable on the selected hosts yet".
  await assert.rejects(
    () => readAllSessionsPage(res(false, 500, resolves({ error: 'boom' }))),
    /Failed to load sessions \(500\)/,
  );
});

test('a 502 carrying an HTML error page throws a GRACEFUL message, not a TypeError', async () => {
  // Failure shape #2, and success criterion 2. `readListBody` makes the body
  // OPTIONAL on the !ok leg precisely for this, so the STATUS still produces a
  // readable message instead of an unguarded `.json()` TypeError.
  await assert.rejects(
    () => readAllSessionsPage(res(false, 502, rejects('Unexpected token < in JSON at position 0'))),
    (e) => {
      assert.ok(e instanceof Error);
      assert.match(e.message, /Failed to load sessions \(502\)/);
      // The user-visible harm: a raw parse error leaking to the UI, or worse, a
      // silent empty list.
      assert.doesNotMatch(e.message, /Unexpected token/);
      return true;
    },
  );
});

test('the message a 503 produces is fit for the UI line — no stack, no JSON noise', async () => {
  // This string is interpolated straight into the page's error line, so its shape
  // is part of the contract, not an implementation detail.
  await assert.rejects(
    () => readAllSessionsPage(res(false, 503, rejects('<!doctype html>'))),
    (e) => e.message === 'Failed to load sessions (503)',
  );
});

test('a 404 throws too — every non-2xx is a failure, not an emptiness', async () => {
  await assert.rejects(
    () => readAllSessionsPage(res(false, 404, resolves({}))),
    /Failed to load sessions \(404\)/,
  );
});

// --- 4. Truncated 2xx: `ok` is NOT proof the body arrived ---------------------

test('a TRUNCATED 2xx body is treated as a failure, NOT as an empty list', async () => {
  // Failure shape #3, and the subtlest one: `fetch` resolves ok:true as soon as
  // the HEADERS arrive, so a dropped SSH tunnel mid-stream lands here. Swallowing
  // this rejection would hand the reader an empty record it can only read as
  // "{items: [], error: null}" — a confident empty list for a network failure.
  await assert.rejects(
    () => readAllSessionsPage(res(true, 200, rejects('Unexpected end of JSON input'))),
    (e) => {
      assert.ok(e instanceof Error);
      // The parse rejection itself propagates — the caller's catch turns it into
      // the error line. What matters is that it is NOT an empty array.
      assert.match(e.message, /Unexpected end of JSON input/);
      return true;
    },
  );
});

// --- 5. Genuine emptiness must STILL be empty (the over-correction guard) -----

test('a genuinely empty 200 returns [] and does NOT throw — the empty state is preserved', async () => {
  // Success criterion 3. A user whose hosts really have no sessions must keep
  // seeing "Nothing runnable on the selected hosts yet", so the fix must not read
  // emptiness as failure.
  const page = await readAllSessionsPage(res(true, 200, resolves({ sessions: [], hasMore: false })));
  assert.deepEqual(page.sessions, []);
  assert.equal(page.hasMore, false);
});

test('a 200 whose body omits `sessions` entirely returns [] rather than throwing', async () => {
  const page = await readAllSessionsPage(res(true, 200, resolves({})));
  assert.deepEqual(page.sessions, []);
});

test('a 200 whose `sessions` key is not an array degrades to [] rather than leaking a non-list', async () => {
  // The caller does `allSessions.map(...)` and `.length`, so a non-array must
  // never reach it.
  const page = await readAllSessionsPage(res(true, 200, resolves({ sessions: 'nope' })));
  assert.deepEqual(page.sessions, []);
});

// --- 6. The inherited-but-INERT 200-with-{error} leg ---------------------------

test('the 2xx `{error}` leg is inherited from the shared reader but is DEAD on this route', async () => {
  // Documented, not celebrated. `GET /api/claude-sessions-all` emits no `error`
  // key on ANY path (handler read first-hand, src/server.js:1423-1442), so this
  // leg cannot fire in production. It is pinned only so that a future server
  // change which DID start emitting one would be honoured rather than ignored.
  await assert.rejects(
    () => readAllSessionsPage(res(true, 200, resolves({ sessions: [], error: 'no cwd' }))),
    /no cwd/,
  );
});

// --- 7. The distinction the whole ticket is about ----------------------------

test('failure and emptiness are DISTINGUISHABLE — the false-empty is closed', async () => {
  // Success criterion 6's core assertion, stating the defect directly: before this
  // fix, ALL FOUR of these produced the byte-identical result `[]`, so the UI
  // could not tell a broken backend from a user with no sessions — and rendered
  // "Nothing runnable on the selected hosts yet" for every one of them.
  const empty = await readAllSessionsPage(res(true, 200, resolves({ sessions: [], hasMore: false })));
  assert.deepEqual(empty.sessions, [], 'a real emptiness still reads as empty');

  for (const failure of [
    res(false, 500, resolves({ error: 'boom' })),             // route throw
    res(false, 502, rejects('<html>')),                        // proxy, HTML body
    res(true, 200, rejects('Unexpected end of JSON input')),   // truncated stream
  ]) {
    await assert.rejects(
      () => readAllSessionsPage(failure),
      (e) => e instanceof Error && e.message.length > 0,
      'every failure shape must throw, never return an empty list',
    );
  }
});

// --- 8. Component-side invariants --------------------------------------------
//
// WARDEN-1422 deleted OpenChatBrowserPage.tsx outright — the sidebar is the only
// session surface and unsaved sessions are never listed. The static source
// guards that pinned the page's catch/inflight invariants went with it. The
// read seam this file exists to pin (`readAllSessionsPage`) survives in
// lib/allSessionsApi.ts, and sections 1–7 above still pin every failure shape
// against it.
