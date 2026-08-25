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
  const page = await readAllSessionsPage(
    res(true, 200, resolves({ sessions: SESSIONS, hasMore: false, totals: { local: 12 } })),
  );
  assert.deepEqual(Object.keys(page).sort(), ['hasMore', 'sessions']);
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

// --- 8. Static guards on the COMPONENT-side invariants ------------------------
//
// The remaining success criteria live in React state inside the .tsx, and this
// repo has no DOM runner, so they are pinned by static source guards on the
// INVARIANT — the same approach as dialogMaxWidth.test.mjs (WARDEN-1001) and
// gitDiffRead.test.mjs (WARDEN-1187). These pin the rule, not the spelling: they
// stay green under rename/reformat and go red only when the behaviour returns.

const page = readFileSync(resolve(__dirname, 'src/components/OpenChatBrowserPage.tsx'), 'utf8');

/**
 * Strip `//` line comments so these guards pin CODE, not prose.
 *
 * Load-bearing, not cosmetic: the catch blocks below deliberately DOCUMENT the
 * calls they must not make ("Deliberately NOT `setHasMoreSessions(false)` here"),
 * so a naive source match fires on the very comment that explains the invariant —
 * the guard would go red precisely because the code is right.
 */
const stripComments = (s) => s.replace(/\/\/[^\n]*/g, '');

/** Extract the executable body of the `catch` block that follows the given marker. */
const catchBlockAfter = (marker) => {
  const start = page.indexOf(marker);
  assert.ok(start > 0, `marker not found: ${marker}`);
  const catchAt = page.indexOf('} catch', start);
  assert.ok(catchAt > 0, `no catch block after: ${marker}`);
  // Up to the end of that catch block (the next line that closes at 4-space depth).
  const end = page.indexOf('\n    }', catchAt);
  return stripComments(page.slice(catchAt, end > 0 ? end : catchAt + 1200));
};

/** The executable body of a named function, marker to its closing 2-space brace. */
const functionBody = (marker) => {
  const start = page.indexOf(marker);
  assert.ok(start > 0, `marker not found: ${marker}`);
  const end = page.indexOf('\n  };', start);
  return stripComments(page.slice(start, end > 0 ? end : start + 2000));
};

test('the refresh catch does NOT blank the loaded rows (criterion 4, half one)', () => {
  // WARDEN-1181's discipline: blanking real data on a transient failure is the
  // same false-empty in miniature. On a failed REFRESH of an already-populated
  // list the rows must stay on screen.
  const body = catchBlockAfter('const fetchAllSessions');
  assert.doesNotMatch(
    body,
    /setAllSessions\(\s*\[\s*\]\s*\)/,
    'the failure path must not seat an empty list over already-loaded rows',
  );
});

test('the load-more catch does NOT retire the load-more affordance (criterion 4, half two)', () => {
  // The long tail still exists; the REQUEST failed. Clearing `hasMoreSessions`
  // would remove the button that is the user's only retry.
  const body = catchBlockAfter('const loadMoreSessions');
  assert.doesNotMatch(
    body,
    /setHasMoreSessions\(\s*(false|!!?[^)]*)\s*\)/,
    'the failure path must leave hasMoreSessions untouched',
  );
  assert.doesNotMatch(body, /setAllSessions\(\s*\[\s*\]\s*\)/);
});

test('both fetch paths read through the seam — no raw ungated `.json()` remains', () => {
  // The defect in one line. Both IN-SCOPE call sites must go through
  // readAllSessionsPage, which gates on r.ok; a reintroduced raw read is the bug
  // returning.
  //
  // Scoped to the two functions deliberately. The file holds a THIRD raw
  // `await r.json()` at the `/api/claude-sessions-search` effect, and it is
  // explicitly OUT OF SCOPE for this ticket: it feeds the 'No matches across
  // selected hosts' copy from a different endpoint, and it already carries its own
  // `if (!r.ok) throw` gate one line above. A whole-file assertion would fail on
  // that correct, unrelated code — so it is not made.
  for (const marker of ['const fetchAllSessions', 'const loadMoreSessions']) {
    const body = functionBody(marker);
    assert.doesNotMatch(
      body,
      /await r\.json\(\)/,
      `${marker}: a raw ungated .json() read is exactly the defect this ticket closed`,
    );
    assert.match(body, /readAllSessionsPage\(/, `${marker} must read through the seam`);
  }
  const calls = page.match(/readAllSessionsPage\(/g) || [];
  assert.equal(calls.length, 2, 'both fetchAllSessions and loadMoreSessions must use the seam');
});

test('the confident empty state is GATED on there being no error (criterion 1)', () => {
  // The sentence must still exist (criterion 3 — a genuine emptiness still says
  // it), but it must no longer be the fallback for a failed request.
  assert.match(page, /Nothing runnable on the selected hosts yet/, 'the genuine empty state is preserved');
  assert.match(
    page,
    /sessionsError[\s\S]{0,200}Nothing runnable on the selected hosts yet/,
    'the error branch must be consulted BEFORE the confident empty sentence',
  );
});

test("the two sibling empty messages are preserved verbatim (criterion 5)", () => {
  assert.match(page, /'No matches across selected hosts'/);
  assert.match(page, /'Select at least one host'/);
});

// --- 6. The error must be REACHABLE on BOTH paths, not just the empty one -----
//
// The defect the first attempt at this ticket shipped, and why a "does the state
// get set?" guard is not enough. `sessionsError` was set correctly by both catch
// legs, but it had exactly ONE render site — inside the `filtered.length === 0`
// leg. The load-more button only exists under `filtered.length > 0`. Those two
// conditions are MUTUALLY EXCLUSIVE BY CONSTRUCTION, so the whole load-more
// failure path set an error channel that could never reach the screen: the click
// did nothing at all, visibly. That is the WARDEN-89 silent failure reproduced on
// the second of the two paths this ticket exists to fix.
//
// So the guards below pin REACHABILITY, not assignment.

/**
 * Strip BOTH `//` line comments and `{/* … *\/}` JSX comments.
 *
 * Load-bearing for the same reason `stripComments` is: the render site added
 * below documents the very conditions it must satisfy, so a naive source match
 * would go green on the PROSE explaining the invariant while the code violated
 * it — the exact failure mode of a guard that proves nothing.
 */
const stripAllComments = (s) => s.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/\/\/[^\n]*/g, '');

test('`sessionsError` has a render site OUTSIDE the empty-list leg (the load-more path)', () => {
  const src = stripAllComments(page);

  // `filtered.map(` opens the else-branch of the `filtered.length === 0` ternary,
  // so everything after it is provably NOT inside the empty-only leg.
  const elseBranch = src.indexOf('filtered.map(');
  assert.ok(elseBranch > 0, 'the list branch marker moved — this guard needs updating');
  const emptyLeg = src.indexOf('filtered.length === 0');
  assert.ok(emptyLeg > 0 && emptyLeg < elseBranch, 'the empty-list leg must precede the list branch');

  const outside = src.slice(elseBranch);
  assert.match(
    outside,
    /sessionsError/,
    'sessionsError is rendered ONLY inside the filtered.length === 0 leg, which the '
      + 'load-more button (filtered.length > 0) can never coexist with — a failed '
      + 'load-more would set an error that cannot reach the screen',
  );
  assert.match(
    outside,
    /sessionsError\s*&&\s*filtered\.length\s*>\s*0/,
    'the rows-present render site must be gated on there BEING rows',
  );
});

test('the rows-present error line is announced (role="status")', () => {
  // A screen-reader user triggers this failure by an explicit click, so it is the
  // one failure that most needs a live region — and it is served by a render site
  // the empty-leg role gate does not cover.
  const src = stripAllComments(page);
  const at = src.search(/sessionsError\s*&&\s*filtered\.length\s*>\s*0/);
  assert.ok(at > 0, 'the rows-present render site is missing');
  assert.match(
    src.slice(at, at + 400),
    /role="status"/,
    'the rows-present error line must carry role="status"',
  );
});

test('changing the host selection CLEARS a stale error (no false-ERROR)', () => {
  // The mirror of the false-empty. `fetchAllSessions` runs only on mount, so a
  // failed load-more leaves `sessionsError` set indefinitely. If the user then
  // narrows to a selection that is GENUINELY empty, `filtered.length` drops to 0
  // and the page would render "Could not load sessions — …" over a truthful
  // emptiness — lying about the user's machines in the opposite direction.
  const body = functionBody('const toggleHost');
  assert.match(
    body,
    /setSessionsError\(\s*null\s*\)/,
    'toggleHost must clear a stale sessionsError, or a resolved failure outlives the request',
  );
});
