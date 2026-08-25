// The per-file git-diff READ seam (WARDEN-1187) — the response-reading step of
// `DiffInspectRow`'s lazy diff fetch, extracted so it is unit-testable without a
// React runner (mirroring web/src/lib/collectionsApi.ts, WARDEN-1181, which
// extracted the Collections read for exactly this reason).
//
// It lives in its OWN module rather than beside the component because it imports
// the shared reader from ./api, and because a pure `(Response) => Promise<string>`
// is the largest testable piece of that fetch — see web/gitDiffRead.test.mjs.
//
// WHY THIS EXISTS AT ALL: the pre-WARDEN-1187 read path in DiffInspectRow was
//
//     const r = await fetch(buildUrl());
//     const j = await r.json();                          // no r.ok gate, no j.error
//     setDiff(typeof j.diff === 'string' ? j.diff : null);
//     } catch { setDiff(null); }                          // every failure → null
//
// Both legs converged on `setDiff(null)`, which renders the row's definitive
// empty state: "no diff". That assertion is SELF-CONTRADICTORY — the row only
// exists for a file the UI has already listed as changed, so the product says
// "this file changed" and then, in its own confident voice and as a fact about
// the user's data, "no diff". The WARDEN-89 false-empty disease.
//
// It was also the last raw-read holdout in GitBadges.tsx: `useGitListFetcher`
// (:642), the git-log grep (:854), `fetchShow` (:911) and `fetchStashShow`
// (:1037) all honour the error contract. The holdout was the CHILD of the very
// rows whose parent (`fetchShow`) already captures `j.error`.

import { readListBody, readListResponse } from './api';

/**
 * Read a per-file git diff response (`GET /api/git-show` and
 * `GET /api/git-stash-show`, both with a `path`) the way warden's backend
 * actually answers, and FAIL LOUDLY when it did not answer with data.
 *
 * Delegates to the house reader pair (`readListBody` + `readListResponse`,
 * WARDEN-1014) for the two parts that genuinely transfer — the leg-gated body
 * parse and the status-over-body error precedence — so this path inherits the
 * legs those encode, and inherits any future fix to them.
 *
 * ⚠ `readListResponse` is a LIST reader and this payload key is a STRING, so its
 * `items` is deliberately DISCARDED here: `Array.isArray('diff text')` is false,
 * so `items` would be `[]` unconditionally. Only its ERROR leg is used, and the
 * diff is read off the body directly below. `readListResponse` itself is left
 * byte-identical (it is shared by 4 files and pinned by web/list-response.test.mjs)
 * rather than widened to handle scalars.
 *
 * The failure shapes this reaches, traced against src/gitRoutes.js — both routes
 * go through `withGitRepo` (:516-540) and NEITHER sets `notFoundEmpty`:
 *
 *  1. **unknown chat id** — 404 with a bare `{error}` and no `diff` key at all.
 *     Reported by STATUS.
 *  2. **`no cwd`** — 200 `{files: [], diff: null, error: 'no cwd'}` (:539). The
 *     200-with-`{error}` half of warden's convention, which an `r.ok` gate alone
 *     misses entirely.
 *  3. **malformed hash / ref / path**, and any **route-level throw** — 200
 *     `{...defaults, error: msg}` (:538). Same half.
 *  4. **a proxy/tunnel non-2xx carrying an HTML body** — `.json()` REJECTS on
 *     HTML. `readListBody` makes the body optional on the `!ok` leg precisely for
 *     this, so it degrades to `Failed to load diff (502)` instead of the silent
 *     `TypeError` the old bare `catch` swallowed.
 *  5. **a truncated 2xx body** — `fetch` resolves `ok: true` as soon as the
 *     HEADERS arrive, so a body cut mid-stream rejects at `.json()`. On the `ok`
 *     leg `readListBody` deliberately lets that rejection through, so it lands in
 *     the caller's `catch` rather than becoming a confident "no diff".
 *
 * ⛔ NOT reached, and deliberately not guessed at: a genuine **git** failure on
 * this leg never arrives as an error. `gitRoutes.js:1152` / `:1561` both do
 * `diff = capDiff(r.ok ? r.stdout : '')` and then answer `error: null` at HTTP
 * 200, so a broken repo is indistinguishable on the wire from a clean empty diff.
 * That is a SERVER-side masking defect and its own ticket. Here it reads as a
 * genuine emptiness — which is the only honest reading available to the client.
 *
 * @param res the Response (only `ok` / `status` / `json` are read, so a plain
 *            object stands in for one under test)
 * @returns the diff text on success — `''` for a genuinely empty diff, which the
 *          caller must keep rendering as "no diff" rather than as a failure.
 *          A non-string / absent `diff` on an otherwise-clean 200 also degrades
 *          to `''`, preserving the pre-fix reading of that shape.
 * @throws  Error whenever the response failed, by EITHER half of warden's error
 *          convention (non-2xx, or a 200 carrying a non-empty `{error}`); also
 *          propagates the `.json()` rejection of a truncated 2xx body
 */
export async function readFileDiff(
  res: Pick<Response, 'ok' | 'status'> & { json: () => Promise<unknown> },
): Promise<string> {
  // Tolerant on !ok (the status carries the message), STRICT on 2xx — a 2xx body
  // that fails to parse is a real failure and must reach the caller's catch
  // rather than becoming a confident "no diff" (WARDEN-1014 review).
  const body = await readListBody(res);
  // `items` discarded — see the note above. `field: 'diff'` is passed only so the
  // reader's signature is honoured; the label is what shapes the message.
  const { error } = readListResponse(res, body, 'diff', 'diff');
  if (error) throw new Error(error);
  const record = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  // A genuine emptiness stays empty. This is NOT an over-correction point: the
  // caller renders `''` as "no diff", exactly as before the fix.
  return typeof record.diff === 'string' ? record.diff : '';
}
