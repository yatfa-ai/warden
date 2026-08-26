// Unit tests for `readResponse` (WARDEN-1191) — the scalar/mixed sibling of
// `readListResponse` in web/src/lib/api.ts.
//
// WHY THIS READER EXISTS. `readListResponse` answers `{items, error}`, so it can
// only serve a payload whose whole answer IS a list. Two seams landed a day apart
// needing the other shape, and each re-derived the missing half by hand:
//
//   - gitDiffApi.ts   (WARDEN-1187) — payload key is a STRING. `items` was `[]`
//                     unconditionally and got discarded; `field: 'diff'` was passed
//                     only so the reader's signature was honoured.
//   - allSessionsApi.ts (WARDEN-1188) — a real list PLUS `hasMore`, so the scalar
//                     was re-read off the body by hand. Its own source comment
//                     cites WARDEN-1187 by name.
//
// Both hand-rolled the SAME body-narrowing line. This file pins the reader that
// gives that line — and the precedence around it — one home.
//
// WHAT IS AND IS NOT PINNED HERE. This file pins the NEW sibling's own contract.
// `readListResponse`'s contract is pinned by list-response.test.mjs and is left
// byte-for-byte unmodified by this ticket; the ADOPTIONS are pinned by
// gitDiffRead.test.mjs (17) and allSessionsRead.test.mjs (23), also unmodified.
//
// THE LEG THAT MATTERS MOST is LEG 1 with a PARSEABLE body. It is not a hypothetical:
// `readListBody`'s `!ok` leg is `res.json().catch(() => undefined)`, so a non-2xx
// whose body DOES parse hands a live `{error}` to this reader — and `withGitRepo`
// answers exactly that shape (a 404 with a bare `{error}`). The status must win
// there, because that is what `readListResponse` does, and a divergence between the
// two readers would re-create the very drift this extraction removes.
//
// Loads the REAL web/src/lib/api.ts (transpiled TS -> ESM via Vite's OXC
// transform), same harness as list-response.test.mjs. `readResponse` reads only
// `ok`/`status`, so plain objects stand in for a Response — no DOM, no fetch.
//
// Run: node --test responseRead.test.mjs   (from web/)

import { transformWithOxc } from 'vite';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const modPath = resolve(__dirname, 'src/lib/api.ts');

const { code } = await transformWithOxc(readFileSync(modPath, 'utf8'), modPath, {});
const tmpDir = mkdtempSync(join(tmpdir(), 'warden-response-read-'));
const tmpFile = join(tmpDir, 'api.mjs');
writeFileSync(tmpFile, code);
const { readResponse, readListResponse } = await import(tmpFile);
rmSync(tmpDir, { recursive: true, force: true });

// A stand-in Response: only `ok`/`status` are ever read.
const res = (status) => ({ ok: status >= 200 && status < 300, status });

// === LEG 1: a non-2xx reports its STATUS, and never consults the body ========

test('LEG 1 — a non-2xx reports "Failed to load <label> (<status>)"', () => {
  assert.equal(readResponse(res(404), { diff: 'x' }, 'diff').error, 'Failed to load diff (404)');
});

test('LEG 1 — a non-2xx reports its STATUS even when the body carries an error string', () => {
  // THE DRIFT LEG. The body here is live and parseable — exactly what
  // `readListBody` hands over for a JSON-bodied 404 from `withGitRepo`. The status
  // must win, matching list-response.test.mjs:144 for the list reader.
  const r = readResponse(res(404), { error: 'chat not found' }, 'file at commit');
  assert.equal(r.error, 'Failed to load file at commit (404)');
  assert.notEqual(r.error, 'chat not found', 'the body string must NOT win on a non-2xx');
});

test('LEG 1 — a 500 whose body parsed still reports the status, not the body', () => {
  assert.equal(
    readResponse(res(500), { error: 'boom', sessions: [] }, 'sessions').error,
    'Failed to load sessions (500)',
  );
});

test('LEG 1 — a non-2xx with an unparseable (undefined) body still reports the status', () => {
  // `readListBody` swallows the parse rejection to `undefined` on this leg (an HTML
  // error page from a proxy will never parse), so this is the shape that arrives.
  const r = readResponse(res(502), undefined, 'diff');
  assert.equal(r.error, 'Failed to load diff (502)');
  assert.deepEqual(r.record, {}, 'record is always a readable object, never undefined');
});

// === LEG 2: a 2xx carrying a non-empty {error} ==============================

test('LEG 2 — 200 + a non-empty `error` reports that string verbatim', () => {
  // warden's 200-with-{error} half: `withGitRepo`'s no-cwd guard and catch-all both
  // answer HTTP 200 with the defaults spread alongside `error`.
  assert.equal(readResponse(res(200), { diff: null, error: 'no cwd' }, 'diff').error, 'no cwd');
});

test('LEG 2 — a 2xx carrying BOTH data and an error reports the error and keeps the body', () => {
  const r = readResponse(res(200), { diff: 'partial', error: 'upstream unreachable' }, 'diff');
  assert.equal(r.error, 'upstream unreachable');
  assert.equal(r.record.diff, 'partial', 'the caller still gets whatever DID arrive');
});

test('LEG 2 — an empty-string `error` on a 2xx is NOT a failure', () => {
  // Matches the list reader: a route that spreads `error: ''` still reads as success.
  const r = readResponse(res(200), { diff: 'text', error: '' }, 'diff');
  assert.equal(r.error, null);
  assert.equal(r.record.diff, 'text');
});

test('LEG 2 — a non-string `error` on a 2xx is not a failure', () => {
  assert.equal(readResponse(res(200), { error: 0 }, 'diff').error, null);
  assert.equal(readResponse(res(200), { error: null }, 'diff').error, null);
  assert.equal(readResponse(res(200), { error: { message: 'x' } }, 'diff').error, null);
});

// === LEG 3: a clean 2xx =====================================================

test('LEG 3 — a clean 2xx returns a null error and the body as a record', () => {
  const r = readResponse(res(200), { diff: 'text', error: null }, 'diff');
  assert.equal(r.error, null, 'a healthy response must NOT report an error');
  assert.equal(r.record.diff, 'text');
});

test('LEG 3 — a genuinely empty scalar is success, not a failure', () => {
  // The over-correction guard: an empty diff is a real answer about a real file,
  // and must stay distinguishable from a failure (the WARDEN-89 direction).
  const r = readResponse(res(200), { diff: '' }, 'diff');
  assert.equal(r.error, null, 'an honestly-empty value must not be reported as an error');
  assert.equal(r.record.diff, '');
});

test('LEG 3 — a mixed list+scalar 2xx body is handed back whole', () => {
  // The allSessionsApi shape: the list rides `readListResponse`, the scalar rides
  // this reader, and BOTH read the same body.
  const body = { sessions: [{ id: 'a' }], hasMore: true, totals: { x: 1 } };
  const r = readResponse(res(200), body, 'sessions');
  assert.equal(r.error, null);
  assert.equal(r.record.hasMore, true, 'the scalar the list reader would have dropped');
  assert.deepEqual(r.record.sessions, [{ id: 'a' }]);
});

// === The narrowing: a junk body must never throw ============================

test('a non-object body (string/number/boolean) is tolerated rather than throwing', () => {
  for (const body of ['not json', 42, true]) {
    const r = readResponse(res(200), body, 'diff');
    assert.deepEqual(r.record, {}, `body ${JSON.stringify(body)} must narrow to {}`);
    assert.equal(r.error, null);
  }
});

test('a null / undefined body narrows to {} on a 2xx without throwing', () => {
  for (const body of [null, undefined]) {
    const r = readResponse(res(200), body, 'diff');
    assert.deepEqual(r.record, {});
    assert.equal(r.error, null);
    // The point of the narrowing: the caller reads its own key UNGUARDED.
    assert.equal(r.record.diff, undefined, 'reading a key off the record must not throw');
  }
});

test('an array body narrows to a readable object rather than throwing', () => {
  // `typeof [] === 'object'`, so an array passes the narrowing — it must still be
  // safe to read a missing key off it.
  const r = readResponse(res(200), [1, 2], 'diff');
  assert.equal(r.error, null);
  assert.equal(r.record.diff, undefined);
});

// === The identity that is the whole point ===================================

test('PRECEDENCE PARITY — readResponse agrees with readListResponse on every leg', () => {
  // If these two ever diverge, the extraction has FAILED at its stated purpose:
  // one convention, one precedence, expressed by two readers for two payload shapes.
  const cases = [
    [res(404), { error: 'chat not found' }, 'the drift leg: status must win'],
    [res(502), undefined, 'unparseable non-2xx'],
    [res(200), { error: 'no cwd' }, '200-with-error'],
    [res(200), { error: '' }, 'empty-string error is success'],
    [res(200), { items: [] }, 'clean 2xx'],
    [res(200), 'junk', 'non-object body'],
    [res(200), undefined, 'undefined body'],
  ];
  for (const [r, body, why] of cases) {
    assert.equal(
      readResponse(r, body, 'thing').error,
      readListResponse(r, body, 'someField', 'thing').error,
      `precedence must match the list reader — ${why}`,
    );
  }
});
