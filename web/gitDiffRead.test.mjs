// Unit tests for the per-file git-diff READ seam `readFileDiff` (WARDEN-1187),
// plus a static guard for the sticky-failure half of the same defect.
//
// WHAT IS BEING PINNED. The pre-fix read path in DiffInspectRow
// (web/src/components/sidebar/GitBadges.tsx:253-267) was:
//
//     const r = await fetch(buildUrl());
//     const j = await r.json();                          // no r.ok gate, no j.error
//     setDiff(typeof j.diff === 'string' ? j.diff : null);
//     } catch { setDiff(null); }                          // EVERY failure → null
//     } finally { setLoading(false); setFetched(true); }  // cached on failure TOO
//
// Both legs converged on `setDiff(null)`, which renders the row's definitive
// empty state at :298 — "no diff". That assertion is SELF-CONTRADICTORY: the row
// only exists for a file the UI has ALREADY listed as changed, so the product
// says "this file changed" and then, in its own confident voice and as a fact
// about the user's data, "no diff". The WARDEN-89 false-empty disease.
//
// THE TWO DEFECTS ARE COUPLED, which is why they are one ticket and why this file
// has two halves: fixing the message without fixing the cache leaves an error the
// user CANNOT CLEAR. `setFetched(true)` sat in `finally`, so it fired on the error
// path; the guard is `if (!open && !fetched)`, so once a fetch failed, collapsing
// and re-expanding — the user's only recovery affordance — silently did nothing
// until the component remounted.
//
// THE FAILURE SHAPES THAT ARE ACTUALLY LIVE, traced against src/gitRoutes.js.
// Both routes go through `withGitRepo` (:516-540) and NEITHER /api/git-show
// (:1126) nor /api/git-stash-show (:1526) sets `notFoundEmpty`:
//   1. unknown chat id  → 404 bare {error}, no `diff` key at all (via status)
//   2. `no cwd`         → 200 {files: [], diff: null, error: 'no cwd'} (:539)
//   3. malformed hash / ref / path, and any route throw → 200 {...defaults, error}
//   4. proxy/tunnel non-2xx with an HTML body → .json() REJECTS (today: a silent
//      TypeError swallowed by the bare catch)
//   5. a truncated 2xx body → .json() rejects after ok:true (headers arrived)
// Each has a test below, and each FAILS against the pre-fix code, which had no
// error channel at all for any of them.
//
// ⛔→✅ RETRACTED (WARDEN-1194). This block used to read: "DELIBERATELY NOT TESTED
// AS A FAILURE: a genuine **git** failure on this leg. gitRoutes.js:1152 / :1561
// both do `diff = capDiff(r.ok ? r.stdout : '')` and then answer `error: null` at
// HTTP 200, so a broken repo is indistinguishable on the wire from a clean empty
// diff. That is a SERVER-side masking defect and its own ticket — asserting
// anything about it here would be asserting a behaviour the client cannot
// observe."
//
// That ticket was WARDEN-1192 and it LANDED: both per-file legs now gate on the
// exit status and answer 200 `{files: [], diff: null, error: 'git show failed'}` /
// `'git stash diff failed'` (gitRoutes.js:1167 / :1590). So shape 6 below is now
// observable by the client, and IS tested — a deleted cwd, a non-git cwd, a
// stopped container or a dropped tunnel arrives as the 200-with-{error} half and
// throws. The retraction is recorded rather than deleted because the reasoning
// above is why the gap existed, and the same reasoning is what closed it. (The
// sibling retraction lives in gitDiffApi.ts's doc block, shape 6.)
//   6. a genuine git failure → 200 {files: [], diff: null, error: 'git show failed'}
//
// This is a SEPARATE file from list-response.test.mjs on purpose: that file pins
// the SHARED reader's own contract, which this ticket leaves byte-for-byte
// unmodified. This file pins the per-file-diff ADOPTION of it.
//
// Loads the REAL web/src/lib/api.ts + web/src/lib/gitDiffApi.ts (transpiled
// TS -> ESM via Vite's OXC transform), same harness as collectionsRead.test.mjs.
// `readListResponse` reads only `ok`/`status`, so plain objects stand in for a
// Response — no DOM, no React, no fetch polyfill needed.
//
// Run: node --test gitDiffRead.test.mjs   (from web/)

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
const tmpDir = mkdtempSync(join(tmpdir(), 'warden-git-diff-read-test-'));
for (const name of ['api', 'gitDiffApi']) {
  const path = join(libDir, `${name}.ts`);
  const { code } = await transformWithOxc(readFileSync(path, 'utf8'), path, {});
  // Node's ESM loader needs a real file extension on the relative specifier.
  // Quote-agnostic: the OXC transform is free to emit either quote style.
  const rewritten = code.replace(/(['"])\.\/api\1/g, "'./api.mjs'");
  writeFileSync(join(tmpDir, `${name}.mjs`), rewritten);
}
const { readFileDiff, readFileDiffDetail } = await import(join(tmpDir, 'gitDiffApi.mjs'));
rmSync(tmpDir, { recursive: true, force: true });

// A stand-in Response. `json` is a thunk so each case controls whether the body
// RESOLVES (parsed) or REJECTS (unparseable / truncated) — the distinction the
// whole fix turns on.
const res = (ok, status, json) => ({ ok, status, json });
const resolves = (body) => () => Promise.resolve(body);
// What `Response.json()` actually does on a body that is not JSON: it REJECTS.
// (An HTML error page from a proxy, or a stream cut mid-object.)
const rejects = (message) => () => Promise.reject(new SyntaxError(message));

const DIFF = [
  'diff --git a/src/server.js b/src/server.js',
  '@@ -1,3 +1,4 @@',
  '+const express = require("express");',
].join('\n');

// --- 1. The happy path still works, unchanged ---------------------------------

test('a clean 200 returns the diff text verbatim', async () => {
  const diff = await readFileDiff(res(true, 200, resolves({ files: [], diff: DIFF, error: null })));
  assert.equal(diff, DIFF);
});

test('the diff is returned as a STRING, not coerced through a list reader', async () => {
  // The correction this ticket turns on: `readListResponse` is a LIST reader and
  // `diff` is a STRING, so its `items` is `[]` unconditionally here. Adopting the
  // pair raw with `field: 'diff'` would silently discard every diff. This asserts
  // the value actually survives.
  const diff = await readFileDiff(res(true, 200, resolves({ diff: DIFF })));
  assert.equal(typeof diff, 'string');
  assert.ok(diff.includes('diff --git'), 'the diff body must survive the reader');
  assert.notDeepEqual(diff, []);
});

// --- 2. Non-2xx: the failure must be DISTINGUISHABLE from emptiness -----------

test('a 404 for an unknown chat id THROWS rather than reading as an empty diff', async () => {
  // Neither route sets `notFoundEmpty`, so this arrives as a bare {error} with no
  // `diff` key at all. The old code read `typeof undefined === 'string'` → false
  // → setDiff(null) → "no diff".
  await assert.rejects(
    () => readFileDiff(res(false, 404, resolves({ error: 'chat not found' }))),
    /Failed to load diff \(404\)/,
  );
});

test('a 502 carrying an HTML error page throws a GRACEFUL message, not a TypeError', async () => {
  // Failure shape #4, and success criterion 2. `.json()` rejects on HTML, so the
  // old bare `catch` swallowed a TypeError and seated "no diff". `readListBody`
  // makes the body optional on the !ok leg precisely for this, so the STATUS
  // still produces a readable message.
  await assert.rejects(
    () => readFileDiff(res(false, 502, rejects('Unexpected token < in JSON at position 0'))),
    (e) => {
      assert.ok(e instanceof Error);
      assert.match(e.message, /Failed to load diff \(502\)/);
      // The user-visible harm: a raw parse error leaking into the row, or worse,
      // a silent "no diff".
      assert.doesNotMatch(e.message, /Unexpected token/);
      return true;
    },
  );
});

test('the message a 503 produces is fit for an inline row — no stack, no JSON noise', async () => {
  // This string is interpolated straight into the row's error line, so its shape
  // is part of the contract, not an implementation detail.
  await assert.rejects(
    () => readFileDiff(res(false, 503, rejects('<!doctype html>'))),
    (e) => e.message === 'Failed to load diff (503)',
  );
});

// --- 3. Truncated 2xx: `ok` is NOT proof the body arrived ---------------------

test('a TRUNCATED 2xx body is treated as a failure, NOT as an empty diff', async () => {
  // Failure shape #5, and the subtlest one: `fetch` resolves ok:true as soon as
  // the HEADERS arrive, so a dropped SSH tunnel mid-stream lands here. Swallowing
  // this rejection would hand the reader an empty record it can only read as a
  // clean 200 with no diff — a confident "no diff" for a network failure.
  await assert.rejects(
    () => readFileDiff(res(true, 200, rejects('Unexpected end of JSON input'))),
    (e) => {
      assert.ok(e instanceof Error);
      assert.match(e.message, /Unexpected end of JSON input/);
      return true;
    },
  );
});

// --- 4. The 200-with-{error} half of warden's error convention ----------------

test("a 200 carrying 'no cwd' throws — the half an r.ok gate alone misses entirely", async () => {
  // withGitRepo's no-cwd guard answers HTTP 200 with the defaults spread in, so
  // `diff: null` arrives ALONGSIDE the error (gitRoutes.js:539). Gating on
  // `res.ok` alone would read this as a clean empty diff.
  await assert.rejects(
    () => readFileDiff(res(true, 200, resolves({ files: [], diff: null, error: 'no cwd' }))),
    /no cwd/,
  );
});

test('a 200 carrying an invalid-ref error throws rather than rendering "no diff"', async () => {
  await assert.rejects(
    () => readFileDiff(res(true, 200, resolves({ files: [], diff: null, error: 'invalid ref' }))),
    /invalid ref/,
  );
});

test('a route-level throw at 200 surfaces its message', async () => {
  // withGitRepo's catch-all answers 200 {...defaults, error: msg} (:538).
  await assert.rejects(
    () => readFileDiff(res(true, 200, resolves({ files: [], diff: null, error: 'spawn ENOENT' }))),
    /spawn ENOENT/,
  );
});

test('a 200 spreading an EMPTY error string is success, not a failure', async () => {
  // `readListResponse` treats only a NON-EMPTY error as an error, so a route that
  // spreads `error: ''` still reads as clean. Pinned so the adoption inherits it.
  const diff = await readFileDiff(res(true, 200, resolves({ diff: DIFF, error: '' })));
  assert.equal(diff, DIFF);
});

test('a non-2xx that ALSO carries a body error reports the STATUS, not the body string', async () => {
  // Error precedence is `readListResponse`'s and is deliberately inherited
  // unchanged (api.ts:181-184), so this message matches every sibling git surface.
  await assert.rejects(
    () => readFileDiff(res(false, 500, resolves({ error: 'boom' }))),
    (e) => e.message === 'Failed to load diff (500)',
  );
});

// --- 5. Genuine emptiness must STILL be empty (the over-correction guard) -----

test('a genuinely empty 200 returns "" and does NOT throw — "no diff" is preserved', async () => {
  // Success criterion 3, and the most important guard in this file. A 200 with
  // `diff: ''` and `error: null` is a LEGITIMATE empty and must keep rendering
  // the row's "no diff" state. (Per the ticket's out-of-scope note this is ALSO
  // what a server-masked git failure looks like today — that is the server's bug,
  // and guessing at it here would invent an error the client cannot observe.)
  const diff = await readFileDiff(res(true, 200, resolves({ files: [], diff: '', error: null })));
  assert.equal(diff, '');
});

test('a 200 whose body omits `diff` entirely returns "" rather than throwing', async () => {
  const diff = await readFileDiff(res(true, 200, resolves({})));
  assert.equal(diff, '');
});

test('a 200 whose `diff` key is not a string degrades to "" rather than leaking a non-string', async () => {
  // The caller renders `diff` into <DiffBlock>, so a non-string must never reach
  // it. This preserves the pre-fix reading of that shape verbatim.
  const diff = await readFileDiff(res(true, 200, resolves({ diff: { oops: true } })));
  assert.equal(diff, '');
});

// --- 6. The distinction the whole ticket is about ----------------------------

test('failure and emptiness are DISTINGUISHABLE — the false-empty is closed', async () => {
  // The one assertion that states the defect directly: before this fix, ALL of
  // these produced the byte-identical result `setDiff(null)` → "no diff", so the
  // UI could not tell a broken backend from a file with no changes.
  const empty = await readFileDiff(res(true, 200, resolves({ diff: '', error: null })));
  assert.equal(empty, '', 'a real emptiness still reads as empty');

  for (const failure of [
    res(false, 404, resolves({ error: 'chat not found' })),   // unknown chat id
    res(true, 200, resolves({ diff: null, error: 'no cwd' })), // the 200-error half
    res(false, 502, rejects('<html>')),                        // proxy, HTML body
    res(true, 200, rejects('Unexpected end of JSON input')),   // truncated stream
  ]) {
    await assert.rejects(
      () => readFileDiff(failure),
      (e) => e instanceof Error && e.message.length > 0,
      'every failure shape must throw, never return an empty diff',
    );
  }
});

// --- 7. STATIC GUARD: the failure must NOT be cached (success criterion 4) ----
//
// WHY A SOURCE GUARD HERE. The retry behaviour is the OTHER HALF of this defect
// and it lives in DiffInspectRow's own `toggle`, not in the reader above — the
// reader cannot see it. This repo has no front-end DOM test runner (see the same
// reasoning in dialogMaxWidth.test.mjs, WARDEN-1001), so a React state guard
// `if (!open && !fetched)` is invisible to a unit test. What IS checkable is the
// structural invariant the bug was: `setFetched(true)` sitting in the `finally`
// block, where it fires on the error path too.
//
// This pins the INVARIANT (the failure path must not seat the cache), not the
// component's spelling — it stays green under rename or reformat of everything
// around it, and fails only when someone puts the cache back on a path that runs
// after a throw.

const GIT_BADGES = readFileSync(
  resolve(__dirname, 'src/components/sidebar/GitBadges.tsx'),
  'utf8',
);

/** The body of DiffInspectRow's `toggle`, from its declaration to the setOpen tail. */
function toggleBody() {
  const start = GIT_BADGES.indexOf('const toggle = async () => {');
  assert.notEqual(start, -1, 'DiffInspectRow.toggle not found — has it been renamed?');
  const end = GIT_BADGES.indexOf('setOpen((o) => !o);', start);
  assert.notEqual(end, -1, 'toggle tail not found');
  return GIT_BADGES.slice(start, end);
}

test('the diff fetch caches on the SUCCESS path only — a failed expand can be retried', () => {
  const body = toggleBody();
  assert.ok(body.includes('setFetched(true)'), 'a successful fetch must still be cached');

  // The defect shape: `finally { ... setFetched(true) }`. Extract the finally
  // block and assert the cache is not seated there — `finally` runs after a throw,
  // so a cache set there pins the row to its error until the component remounts.
  const fin = body.indexOf('} finally {');
  assert.notEqual(fin, -1, 'toggle should still have a finally block for setLoading');
  const finallyBlock = body.slice(fin);
  assert.ok(
    !finallyBlock.includes('setFetched(true)'),
    'setFetched must NOT be in `finally` — that runs on the error path too, which is ' +
      'exactly the WARDEN-1187 sticky-failure bug: collapse/re-expand then never retries',
  );
  // And it must not be seated in the catch either.
  const catchStart = body.indexOf('} catch');
  assert.notEqual(catchStart, -1, 'toggle should still catch failures');
  assert.ok(
    !body.slice(catchStart, fin).includes('setFetched(true)'),
    'setFetched must NOT be in the catch block — the failure path must stay retryable',
  );
});

test('a backend failure reaches the row as an error, not as the "no diff" empty state', () => {
  // The rendering half of criterion 1: the row must have an error channel that is
  // DISTINCT from its empty state, and it must go through the checked reader
  // rather than a raw `r.json()`.
  const body = toggleBody();
  assert.ok(
    body.includes('readFileDiff('),
    'the fetch must go through the checked reader, not a raw r.json()',
  );
  assert.ok(
    !/const\s+j\s*=\s*await\s+r\.json\(\)/.test(body),
    'the raw unchecked `const j = await r.json()` read must be gone from this site',
  );
  assert.ok(
    /setError\(/.test(body),
    'the row needs an error channel distinct from its "no diff" empty state',
  );
});

// --- 8. The DETAIL reader (WARDEN-1194) --------------------------------------
//
// `readFileDiffDetail` is the sibling `readFileDiff` now rests on: the same read,
// keeping the SECOND field the per-file /api/git-show response carries — `message`,
// the commit body (WARDEN-388). It exists because FileViewer's BlameHash popover
// renders BOTH fields off one response, so routing that site through the narrow
// `readFileDiff` would have closed its error hole and silently dropped the body.
//
// The failure legs are not re-derived here — they are `readFileDiff`'s, asserted
// above, and section 9 pins that the two genuinely share one implementation. What
// IS this reader's own contract, and is pinned here, is the `message` field.

test('the detail reader returns the diff AND the commit body from one response', async () => {
  const { diff, message } = await readFileDiffDetail(
    res(true, 200, resolves({ files: [], diff: DIFF, message: 'why the change was made', error: null })),
  );
  assert.equal(diff, DIFF);
  assert.equal(message, 'why the change was made', 'the WARDEN-388 commit body must survive the reader');
});

test('a subject-only commit yields an EMPTY body, not a failure', async () => {
  // git returns '' for a commit with no body beyond its subject. The caller maps
  // '' -> null and renders nothing above the diff; it must never read as an error.
  const { diff, message } = await readFileDiffDetail(
    res(true, 200, resolves({ diff: DIFF, message: '', error: null })),
  );
  assert.equal(message, '');
  assert.equal(diff, DIFF);
});

test('an absent or non-string `message` degrades to "" rather than leaking a non-string', async () => {
  // The caller renders `message` into a text node, so a non-string must never
  // reach it — mirroring the same guard `diff` carries.
  const absent = await readFileDiffDetail(res(true, 200, resolves({ diff: DIFF })));
  assert.equal(absent.message, '');
  const junk = await readFileDiffDetail(res(true, 200, resolves({ diff: DIFF, message: { oops: true } })));
  assert.equal(junk.message, '');
});

test('the detail reader THROWS on the 200-with-{error} half — the body is not salvaged', async () => {
  // The trap this reader must not spring: keeping a second field must not tempt a
  // reading that returns a partial record on a failed response. A `git show failed`
  // (WARDEN-1192, shape 6) is a failure whether or not a `message` came with it.
  await assert.rejects(
    () => readFileDiffDetail(res(true, 200, resolves({ files: [], diff: null, message: 'a body', error: 'git show failed' }))),
    /git show failed/,
  );
});

test('a genuinely empty diff is STILL empty through the detail reader (over-correction guard)', async () => {
  // Success criterion 3 at the reader level: a file untouched by the commit answers
  // 200 {diff: '', error: null} and must keep rendering "no diff for this file at
  // this commit". A healthy repo must not start reporting failures.
  const { diff, message } = await readFileDiffDetail(
    res(true, 200, resolves({ files: [], diff: '', message: '', error: null })),
  );
  assert.equal(diff, '');
  assert.equal(message, '');
});

test('every failure shape reaches the detail reader as a throw, exactly as the narrow one', async () => {
  for (const failure of [
    res(false, 404, resolves({ error: 'chat not found' })),        // unknown chat id
    res(true, 200, resolves({ diff: null, error: 'no cwd' })),      // the 200-error half
    res(true, 200, resolves({ diff: null, error: 'git show failed' })), // shape 6 (WARDEN-1192)
    res(false, 502, rejects('<html>')),                             // proxy, HTML body
    res(true, 200, rejects('Unexpected end of JSON input')),        // truncated stream
  ]) {
    await assert.rejects(
      () => readFileDiffDetail(failure),
      (e) => e instanceof Error && e.message.length > 0,
      'every failure shape must throw, never return an empty diff',
    );
  }
});

// --- 9. `readFileDiff`'s contract is UNCHANGED (success criterion 5) ----------

test('the narrow reader still resolves to a bare STRING after being re-seated on the detail reader', async () => {
  // DiffInspectRow destructures nothing — it awaits a string. Widening the return
  // (the alternative to the sibling) would have broken it silently at runtime while
  // still type-checking under `any`. This pins the shape, not just the value.
  const diff = await readFileDiff(res(true, 200, resolves({ diff: DIFF, message: 'body', error: null })));
  assert.equal(typeof diff, 'string');
  assert.equal(diff, DIFF);
});

test('the two readers agree on the diff for every shape — one implementation, not two', async () => {
  // The risk a sibling reader introduces is DRIFT: two copies of the precedence that
  // diverge on the next fix. This asserts they answer identically wherever both
  // answer, so a future edit to one that does not reach the other fails here.
  for (const body of [
    { diff: DIFF, error: null },
    { diff: '', error: null },
    { diff: null, error: null },
    { diff: { oops: true } },
    {},
  ]) {
    const narrow = await readFileDiff(res(true, 200, resolves(body)));
    const detail = await readFileDiffDetail(res(true, 200, resolves(body)));
    assert.equal(narrow, detail.diff, `readers disagreed on ${JSON.stringify(body)}`);
  }
});

// --- 10. STATIC GUARD: the BlameHash popover (WARDEN-1194) --------------------
//
// The same reasoning as section 7, at the site this ticket is about. `BlameHash`
// (FileViewer.tsx) is the popover behind EVERY hash in both the Blame and the
// History view, and it was the sole remaining raw path-bearing read of these
// routes: an `r.ok` gate and then `j.diff` straight off an unchecked body, so the
// 200-with-{error} half fell through to the popover's definitive empty state,
// "no diff for this file at this commit" — a confident factual claim about the
// user's data made when the truth is "we could not read the repository".
//
// It carried the WARDEN-1187 sticky-failure coupling too: `setFetched(true)` in a
// `finally`, against a `if (!next || fetched) return;` guard, so a failed popover
// could not be cleared by closing and re-opening it — the user's only recovery
// affordance — until the component remounted. Both halves are pinned below,
// because fixing the message without the cache leaves an error the user CANNOT
// CLEAR.
//
// This repo has no front-end DOM test runner, so React state is invisible to a
// unit test; what IS checkable is the structural invariant each bug WAS.

const FILE_VIEWER = readFileSync(
  resolve(__dirname, 'src/components/FileViewer.tsx'),
  'utf8',
);

/** The body of BlameHash's `handleOpenChange`, from its declaration to its tail. */
function handleOpenChangeBody() {
  const start = FILE_VIEWER.indexOf('const handleOpenChange = async (next: boolean) => {');
  assert.notEqual(start, -1, 'BlameHash.handleOpenChange not found — has it been renamed?');
  const end = FILE_VIEWER.indexOf('const shortHash =', start);
  assert.notEqual(end, -1, 'handleOpenChange tail not found');
  return FILE_VIEWER.slice(start, end);
}

test('the popover diff fetch goes through the checked reader, not a raw r.json()', () => {
  const body = handleOpenChangeBody();
  assert.ok(
    body.includes('readFileDiffDetail('),
    'the fetch must go through the checked DETAIL reader (it needs the commit body too)',
  );
  assert.ok(
    !/const\s+j\s*=\s*await\s+r\.json\(\)/.test(body),
    'the raw unchecked `const j = await r.json()` read must be gone from this site',
  );
  assert.ok(
    !/if\s*\(!r\.ok\)/.test(body),
    'the `r.ok`-only gate must be gone — it misses the 200-with-{error} half entirely',
  );
});

test('the popover has an error channel distinct from "no diff for this file at this commit"', () => {
  // The rendering half of criterion 1. The empty state's exact string must survive
  // (criterion 3 — a genuine empty diff still says it), and a SEPARATE branch must
  // carry the failure, announced to AT.
  assert.ok(
    /setError\(/.test(handleOpenChangeBody()),
    'the popover needs an error channel distinct from its empty state',
  );
  assert.ok(
    FILE_VIEWER.includes('no diff for this file at this commit'),
    'the genuine-empty state must survive — a healthy repo must not report failures',
  );
  assert.ok(
    /could not load diff — \{error\}/.test(FILE_VIEWER),
    'the failure must render its own line, visually distinct from the empty state',
  );
  const errorBranch = FILE_VIEWER.indexOf('could not load diff');
  assert.ok(
    FILE_VIEWER.slice(errorBranch - 400, errorBranch).includes('role="status"'),
    'the error line needs role="status" so assistive tech announces it',
  );
});

test('the popover caches on the SUCCESS path only — a failed open can be retried', () => {
  // Success criterion 4 (Defect B). The guard is `if (!next || fetched) return;`, so
  // a cache seated anywhere that runs after a throw pins the popover to its wrong
  // state until the component remounts.
  const body = handleOpenChangeBody();
  assert.ok(body.includes('setFetched(true)'), 'a successful fetch must still be cached');

  const fin = body.indexOf('} finally {');
  assert.notEqual(fin, -1, 'handleOpenChange should still have a finally block for setLoading');
  assert.ok(
    !body.slice(fin).includes('setFetched(true)'),
    'setFetched must NOT be in `finally` — that runs on the error path too, which is ' +
      'exactly the sticky-failure bug: close/re-open then never retries',
  );
  const catchStart = body.indexOf('} catch');
  assert.notEqual(catchStart, -1, 'handleOpenChange should still catch failures');
  assert.ok(
    !body.slice(catchStart, fin).includes('setFetched(true)'),
    'setFetched must NOT be in the catch block — the failure path must stay retryable',
  );
});

test('the commit body still renders on the success path — no WARDEN-388 regression', () => {
  // Success criterion 2. The whole reason this site takes the DETAIL reader rather
  // than `readFileDiff`: the popover renders `message` above the diff, and a naive
  // swap to the narrow reader would have dropped it silently.
  const body = handleOpenChangeBody();
  assert.ok(/setMessage\(/.test(body), 'the commit body must still be read from the response');
  assert.ok(
    /message:\s*body/.test(body) || /\.message/.test(body),
    'the body must come off the SAME response as the diff (no extra round-trip)',
  );
  assert.ok(
    FILE_VIEWER.includes('whitespace-pre-wrap break-words px-0.5 text-[10px] text-muted-foreground'),
    'the commit body must still be rendered above the diff',
  );
});

// --- 11. CENSUS GUARD: no raw path-bearing read of these routes survives ------

test('no path-bearing /api/git-show read bypasses the seam (success criterion 6)', () => {
  // The census this ticket closes: three path-bearing consumers of these routes,
  // two already through the seam, this one the sole bypass. The `files` LEGS (no
  // `&path=`) are deliberately excluded — WARDEN-1192's carve-out at
  // gitRoutes.js:857-858: a list says "empty" precisely by being empty, a diff has
  // no such vocabulary — so this guard matches only the path-bearing form.
  //
  // A path-bearing fetch is EXPECTED to remain — the seam takes a Response, so the
  // call site still performs the fetch. What must not remain is a fetch whose RESULT
  // is read RAW. So the invariant asserted is on what FOLLOWS the URL: no unchecked
  // `r.json()` / `.ok` gate reading it, and the URL must sit within a construct that
  // hands it to the seam (a `readFileDiff*(...)` call, or a `buildUrl` thunk for
  // DiffInspectRow, which reads through the seam on the site's behalf).
  for (const [name, source] of [
    ['FileViewer.tsx', FILE_VIEWER],
    ['GitBadges.tsx', GIT_BADGES],
  ]) {
    for (const m of source.matchAll(/\/api\/git-(?:show|stash-show)\?/g)) {
      const line = source.slice(source.lastIndexOf('\n', m.index) + 1, source.indexOf('\n', m.index));
      if (!line.includes('&path=')) continue; // the files leg — out of scope, correct as-is

      const before = source.slice(Math.max(0, m.index - 200), m.index);
      assert.ok(
        /readFileDiff(?:Detail)?\(/.test(before) || /buildUrl/.test(before),
        `${name}: a path-bearing diff URL must be handed to the seam (readFileDiff* or a ` +
          `buildUrl thunk), not fetched and read on its own: ${line.trim()}`,
      );

      const after = source.slice(m.index, m.index + 400);
      assert.ok(
        !/await\s+r\.json\(\)/.test(after),
        `${name}: a raw \`await r.json()\` still reads a path-bearing diff fetch: ${line.trim()}`,
      );
      assert.ok(
        !/if\s*\(!r\.ok\)/.test(after),
        `${name}: an \`r.ok\`-only gate still guards a path-bearing diff fetch — it misses ` +
          `the 200-with-{error} half entirely: ${line.trim()}`,
      );
    }
  }
});
