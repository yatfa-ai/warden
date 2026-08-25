// The Collections READ seam (WARDEN-1181) — the response-reading step of
// CollectionsSection's `fetchCollections`, extracted so it is unit-testable
// without a React runner (mirroring how the criteria matchers were extracted to
// src/lib/collections.ts for exactly this reason — see web/collectionsRead.test.mjs).
//
// It lives in its OWN module rather than in src/lib/collections.ts because that
// file is deliberately import-free (types only) so its harness can transpile it
// standalone; this one imports the shared reader from ./api.
//
// WHY THIS EXISTS AT ALL: the pre-WARDEN-1181 read path was
//
//     const r = await fetch('/api/collections');
//     const j = await r.json();          // no r.ok gate, no parse tolerance
//     setCollections(j.collections || []);
//     } catch { setCollections([]); }    // every failure → the SAME empty list
//
// Both legs converged on `[]`, which renders the section's definitive
// "no collections — create one to organize agents" empty state with a `0` badge.
// A failure was reported to the user, in the product's own confident voice, as a
// fact about their data (the WARDEN-89 false-empty disease). The refresh control
// calls this same path, so the one recovery affordance silently did nothing too.

import { readListBody, readListResponse } from './api';
import type { Collection } from '@/lib/types';

/**
 * Read `GET /api/collections` the way warden's backend actually answers, and
 * FAIL LOUDLY when it did not answer with data.
 *
 * Delegates to the house reader pair (`readListBody` + `readListResponse`,
 * WARDEN-1014) rather than hand-rolling an `if (!r.ok)` block, so this path
 * inherits the three legs those already encode — and inherits any future fix to
 * them. The three failure shapes that reach a real user, all of them from
 * warden's normal deployment shape (remote hosts over an SSH tunnel / reverse
 * proxy, WARDEN-1055):
 *
 *  1. **Non-2xx carrying an HTML body** — a 502/503/504 from the proxy, or a
 *     dropped tunnel. `readListBody` makes the body OPTIONAL on the `!ok` leg
 *     (an HTML error page will never parse), so this throws a clean
 *     `Failed to load collections (502)` instead of a `TypeError`.
 *  2. **A truncated 2xx body** — `fetch` resolves `ok: true` as soon as the
 *     HEADERS arrive, so a body cut mid-stream rejects at `.json()`. On the `ok`
 *     leg `readListBody` deliberately lets that rejection through, so it lands in
 *     the caller's `catch` rather than becoming a confident empty list.
 *  3. **A route-level throw** — `GET /api/collections` answers
 *     `500 {error}` (src/server.js:901-908), reported here by STATUS.
 *
 * Note the corrupt-`collections.json` case is NOT one of them: `loadCollections`
 * goes through `readJsonDefensive`, which catches the revive throw and returns
 * its fallback (src/persist.js:163-169), so a corrupt file legitimately answers
 * `200 {collections: []}` — a genuine emptiness, which must keep rendering the
 * empty state.
 *
 * Error precedence is `readListResponse`'s and is deliberately left alone: a
 * non-2xx reports its STATUS, not the body string (api.ts:181-184).
 *
 * @param res the Response (only `ok` / `status` / `json` are read, so a plain
 *            object stands in for one under test)
 * @returns the collections array on success — `[]` ONLY for a genuinely empty 200
 * @throws  Error whenever the response failed, by EITHER half of warden's error
 *          convention (non-2xx, or a 200 carrying a non-empty `{error}`); also
 *          propagates the `.json()` rejection of a truncated 2xx body
 */
export async function readCollectionsList(
  res: Pick<Response, 'ok' | 'status'> & { json: () => Promise<unknown> },
): Promise<Collection[]> {
  // Tolerant on !ok (the status carries the message), STRICT on 2xx — a 2xx body
  // that fails to parse is a real failure and must reach the caller's catch
  // rather than becoming a confident empty list (WARDEN-1014 review).
  const body = await readListBody(res);
  const { items, error } = readListResponse<Collection>(res, body, 'collections', 'collections');
  // On a hard HTTP failure `items` is the server's placeholder, not data — so the
  // error wins and the caller keeps whatever was already on screen.
  if (error) throw new Error(error);
  return items;
}
