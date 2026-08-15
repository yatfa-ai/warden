// Unit tests for the shared git list-response reader `readListResponse` (WARDEN-1014).
//
// WHAT IS BEING PINNED, and why it is not obvious:
//
// warden's `withGitRepo` (src/gitRoutes.js:473 — 15 routes) has TWO failure paths
// that answer **HTTP 200**: the no-cwd guard (:490) and the catch-all (:494). Both
// spread `gitDefaults` into the body, so the EMPTY ARRAY arrives alongside `error`:
//
//     200 { stashes: [], error: 'no cwd' }
//
// That is what makes the ordinary-looking front-end guard
// `Array.isArray(j[field]) ? j[field] : []` the *bug* rather than the defence — it
// accepts the server's placeholder as data. An unreachable SSH host or a cwd-less
// chat then renders "no stashes" / "no branches" / "no commits", indistinguishable
// from a genuinely clean repo (the WARDEN-89 false-empty disease).
//
// A 404 from the same wrapper (:477) ALSO carries `{error}` in its body, so the two
// halves need reading together: gating on `res.ok` alone — which knowledge article
// WARDEN-89 currently prescribes — catches the 404 half and misses the 200 half
// entirely. `readListResponse` is the one place that encodes BOTH.
//
// THE THREE LEGS each of the three adopting hooks now rides on
// (ChatSidebar's useGitLogFetcher, FileViewer's useGatedFetch, GitBadges'
// useGitListFetcher):
//   1. non-2xx                  → error
//   2. 2xx WITH a body `error`  → error   ← the leg every prior extraction dropped
//   3. clean 2xx                → items, error === null
//
// The leg-2 tests are the ones that can actually fail against the pre-WARDEN-1014
// code: the old inline readers returned no error channel at all for a 200.
//
// This is a SEPARATE file from fetch-json.test.mjs on purpose. `fetchJson`'s 2xx
// contract ("any 2xx → ok:true + data", api.ts:135) is deliberately UNCHANGED by
// this work — the reader is additive, so all 12 of that file's tests still pass
// unmodified. The final test below asserts that non-interference directly.
//
// Loads the REAL web/src/lib/api.ts, transpiled TS -> ESM via Vite's OXC transform
// (same harness as fetch-json.test.mjs). The module has only `import type`
// (erased) and globals, so it loads standalone.
//
// Run: node list-response.test.mjs   (from web/)

import { transformWithOxc } from 'vite';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const modPath = resolve(__dirname, 'src/lib/api.ts');

const src = readFileSync(modPath, 'utf8');
const { code } = await transformWithOxc(src, modPath, {});
const tmpDir = mkdtempSync(join(tmpdir(), 'warden-list-response-'));
const tmpFile = join(tmpDir, 'api.mjs');
writeFileSync(tmpFile, code);
const { readListResponse, fetchJson } = await import(tmpFile);
rmSync(tmpDir, { recursive: true, force: true });

// `readListResponse` reads only `ok` and `status`, so a plain object stands in for a
// Response — the same shape fetch-json.test.mjs uses.
const res = (status) => ({ ok: status >= 200 && status < 300, status });

let passed = 0;
const test = async (name, fn) => {
  await fn();
  passed += 1;
  console.log('  ok -', name);
};

// === Leg 3: a clean 2xx ====================================================

await test('LEG 3 — clean 2xx returns the items and a null error', async () => {
  const body = { stashes: [{ ref: 'stash@{0}', subject: 'WIP' }] };
  const r = readListResponse(res(200), body, 'stashes', 'stashes');
  assert.deepEqual(r.items, [{ ref: 'stash@{0}', subject: 'WIP' }]);
  assert.equal(r.error, null, 'a healthy response must NOT report an error');
});

await test('LEG 3 — a genuinely empty 2xx list is success, not a failure', async () => {
  // The case that MUST stay distinguishable from leg 2: a clean repo with no
  // stashes. Same empty array, but no `error` — so the UI renders "no stashes".
  const r = readListResponse(res(200), { stashes: [] }, 'stashes', 'stashes');
  assert.deepEqual(r.items, []);
  assert.equal(r.error, null, 'an honestly-empty list must not be reported as an error');
});

// === Leg 2: a 2xx whose body carries `error` (the blind spot) ==============

await test('LEG 2 — 200 + { stashes: [], error: "no cwd" } reports the error', async () => {
  // Byte-for-byte the src/gitRoutes.js:490 no-cwd response for /api/git-stash.
  // Pre-WARDEN-1014 this read as a successful empty list.
  const r = readListResponse(res(200), { stashes: [], error: 'no cwd' }, 'stashes', 'stashes');
  assert.equal(r.error, 'no cwd', 'the 200-with-{error} convention must surface');
  assert.deepEqual(r.items, [], 'the placeholder array is still returned');
});

await test('LEG 2 — the catch-all 200 body reports its message across every list route', async () => {
  // src/gitRoutes.js:494 — the catch-all spreads gitDefaults + the thrown message.
  // Exercised for each of the four response keys the adopting hooks pass, so the
  // reader is pinned per-field rather than only for `stashes`.
  const cases = [
    ['stashes', 'stashes', 'ssh: connect to host box port 22: No route to host'],
    ['entries', 'recent operations', 'fatal: not a git repository'],
    ['remotes', 'remotes', 'ls failed'],
    ['branches', 'branches', 'fatal: bad revision'],
    ['commits', 'commits', 'fatal: your current branch has no commits yet'],
  ];
  for (const [field, label, msg] of cases) {
    const r = readListResponse(res(200), { [field]: [], error: msg }, field, label);
    assert.equal(r.error, msg, `${field}: the catch-all message must surface verbatim`);
    assert.deepEqual(r.items, [], `${field}: items is the placeholder`);
  }
});

await test('LEG 2 — a 200 carrying BOTH data and an error reports the error and keeps the data', async () => {
  // A partial result (some rows resolved, something still failed). The error must
  // not be swallowed just because the array is non-empty.
  const body = { commits: [{ hash: 'abc1234', subject: 'x' }], error: 'upstream unreachable' };
  const r = readListResponse(res(200), body, 'commits', 'commits');
  assert.equal(r.error, 'upstream unreachable');
  assert.equal(r.items.length, 1, 'the rows that DID resolve are still returned');
});

await test('LEG 2 — an empty-string `error` on a 2xx is NOT a failure', async () => {
  // A route that spreads `error: ''` must not flip every healthy load into an
  // error state. Only a non-empty string counts.
  const r = readListResponse(res(200), { branches: [{ name: 'main' }], error: '' }, 'branches', 'branches');
  assert.equal(r.error, null);
  assert.equal(r.items.length, 1);
});

// === Leg 1: a non-2xx ======================================================

await test('LEG 1 — a 404 reports "Failed to load <label> (<status>)"', async () => {
  // withGitRepo's unknown-chat 404 (:477). The exact copy FileViewer rendered
  // before this refactor — pinned so its behaviour cannot regress (its blame /
  // history views show this string verbatim).
  const r = readListResponse(res(404), { error: 'chat not found' }, 'blame', 'blame');
  assert.equal(r.error, 'Failed to load blame (404)');
});

await test('LEG 1 — a non-2xx reports its STATUS even when the body carries an error string', async () => {
  // Precedence matters: FileViewer's pre-refactor code never even parsed the body
  // on !ok, so the status message must win over the body string.
  const r = readListResponse(res(500), { commits: [], error: 'boom' }, 'commits', 'history');
  assert.equal(r.error, 'Failed to load history (500)');
});

await test('LEG 1 — a non-2xx with an unparseable (undefined) body still reports the status', async () => {
  // An HTML error page → `r.json()` rejects → the caller passes undefined.
  const r = readListResponse(res(502), undefined, 'entries', 'recent operations');
  assert.equal(r.error, 'Failed to load recent operations (502)');
  assert.deepEqual(r.items, [], 'items is always an array, never undefined');
});

// === `items` is total ======================================================

await test('items is [] when the field is absent, null, or not an array', async () => {
  // The callers index straight into `.items`, so it must never be undefined —
  // this is the one property the old inline guard DID get right, kept intact.
  for (const body of [{}, { stashes: null }, { stashes: 'nope' }, { stashes: 42 }, undefined, null]) {
    const r = readListResponse(res(200), body, 'stashes', 'stashes');
    assert.deepEqual(r.items, [], `body ${JSON.stringify(body)} must yield []`);
  }
});

await test('a non-object body (string/number) is tolerated rather than throwing', async () => {
  const r = readListResponse(res(200), 'not json at all', 'commits', 'commits');
  assert.deepEqual(r.items, []);
  assert.equal(r.error, null);
});

// === Non-interference with fetchJson ======================================

await test('fetchJson STILL returns ok:true for a 200 carrying {error} — contract untouched', async () => {
  // The reason this reader is standalone rather than a flag on fetchJson: widening
  // fetchJson's 2xx contract would relocate this bug into the primitive behind the
  // Settings load and churn its 12 specs. This asserts the boundary holds — and
  // simultaneously documents why "just adopt fetchJson everywhere" is NOT the fix.
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ stashes: [], error: 'no cwd' }),
  });
  const r = await fetchJson('/api/git-stash?id=x', { fetchImpl, sleepImpl: async () => {} });
  assert.equal(r.ok, true, 'fetchJson is deliberately still blind to the 200-with-{error} half');
  assert.deepEqual(r.data, { stashes: [], error: 'no cwd' });
  // …and the reader over that SAME body is what catches it.
  assert.equal(readListResponse(res(200), r.data, 'stashes', 'stashes').error, 'no cwd');
});

console.log(`\n# tests ${passed}`);
console.log('# pass', passed);
console.log('# fail 0');
