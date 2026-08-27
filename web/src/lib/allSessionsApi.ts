// The cross-host "All Sessions" READ seam (WARDEN-1188) — the response-reading
// step of OpenChatBrowserPage's `fetchAllSessions` / `loadMoreSessions`, extracted
// so it is unit-testable without a React runner (mirroring `collectionsApi.ts`
// from WARDEN-1181 and `gitDiffApi.ts` from WARDEN-1187 — see
// web/allSessionsRead.test.mjs).
//
// WHY THIS EXISTS AT ALL: both pre-WARDEN-1188 read paths were
//
//     const r = await fetch(`/api/claude-sessions-all?…`);
//     const j = await r.json();           // no r.ok gate, no parse tolerance
//     setAllSessions(j.sessions || []);   // failure → the SAME empty list
//     } catch (error) { console.error(…); }  // sets NO state at all
//
// On any failure `j.sessions` is undefined, `|| []` seats an empty list, and the
// page renders its confident empty state:
//
//     "Nothing runnable on the selected hosts yet"
//
// A backend failure was reported to the user, in the product's own voice, as a
// FACT ABOUT THEIR MACHINES — the WARDEN-89 false-empty disease. The catch leg
// was worse: it set no state, so `allSessions` kept its initial `[]` and the same
// sentence rendered. And because the page mounts fresh on every open
// (OpenChatBrowserPage.tsx:255-257), there is no stale-data cushion: with a broken
// backend, EVERY visit shows "Nothing runnable".

import { readListBody, readListResponse, readResponse } from './api';
import type { ClaudeSession } from '@/components/sidebar/types';

/** One page of the cross-host session timeline: the list plus the pagination scalar. */
export interface AllSessionsPage {
  /** `body.sessions` when it is an array, else `[]`. Never undefined. */
  sessions: (ClaudeSession & { host: string })[];
  /** The server's `hasMore` for this window — whether a further page exists. */
  hasMore: boolean;
  /**
   * Hosts the server could not REACH while assembling this page (WARDEN-1200).
   * `[]` — never undefined — when the fleet was fully reachable, so the caller
   * reads one shape on every path.
   *
   * ⚠ This is a PARTIAL-SUCCESS channel and must never be conflated with `error`.
   * The page it rides on is real data from the hosts that DID answer; the caller
   * renders it as a notice ALONGSIDE those rows, never instead of them. Routing it
   * through the throw below would blank a working list because one machine of many
   * was down — swapping a false-empty for a false-total-failure.
   */
  unreachableHosts: string[];
}

/**
 * Read `GET /api/claude-sessions-all` the way warden's backend actually answers,
 * and FAIL LOUDLY when it did not answer with data.
 *
 * Delegates to the house reader pair (`readListBody` + `readListResponse`,
 * WARDEN-1014) rather than hand-rolling an `if (!r.ok)` block, so this path
 * inherits the leg-gated parse those already encode — and inherits any future fix
 * to them. The three failure shapes that reach a real user, all of them from
 * warden's normal deployment shape (remote hosts over an SSH tunnel / reverse
 * proxy, WARDEN-1055):
 *
 *  1. **A route-level throw** — Express 5 auto-forwards to the WARDEN-1105 error
 *     handler (src/server.js:2301), which answers `500 {error}`. `.json()`
 *     SUCCEEDS there, so `sessions` is simply undefined: the shape that produced
 *     the false empty most directly. Reported here by STATUS.
 *  2. **Non-2xx carrying an HTML body** — a 502/503/504 from the proxy, or a
 *     dropped tunnel. `readListBody` makes the body OPTIONAL on the `!ok` leg
 *     (an HTML error page will never parse), so this throws a clean
 *     `Failed to load sessions (502)` instead of a `TypeError`.
 *  3. **A truncated 2xx body** — `fetch` resolves `ok: true` as soon as the
 *     HEADERS arrive, so a body cut mid-stream rejects at `.json()`. On the `ok`
 *     leg `readListBody` deliberately lets that rejection through, so it lands in
 *     the caller's `catch` rather than becoming a confident empty list.
 *
 * ⚠ WHY TWO READERS RATHER THAN ONE. `readListResponse` returns only
 * `{items, error}`, but THIS payload carries a list AND a scalar: the route
 * answers `res.json({ sessions, hasMore, totals })` (src/server.js:1441). Calling
 * the list reader alone would silently DROP `hasMore` and break Load-more
 * pagination — the same list-vs-scalar mismatch corrected once in WARDEN-1187.
 * So the list rides `readListResponse` (it IS a real list) and the scalar rides
 * `readResponse`, the scalar/mixed sibling added in WARDEN-1191. Before that
 * sibling existed this seam re-derived the body-narrowing line by hand, which is
 * the duplication that motivated the extraction; the narrowing now has one owner
 * in `web/src/lib/api.ts`.
 *
 * Note the 2xx-`body.error` leg inside `readListResponse` is INERT on this route:
 * the handler (src/server.js:1461-1512) emits no `error` key on any path. It is
 * harmless — and it is NOT described here as a live failure channel, because it
 * is not one. Only the STATUS leg and the parse legs do real work for this route.
 *
 * ⚠ AND IT MUST STAY INERT — that is a load-bearing property, not an accident
 * (WARDEN-1200). A partial fleet (some hosts answered, one was unreachable) is
 * reported by the server as `unreachableHosts`, a SEPARATE key, precisely because
 * `error` throws here and the caller's `catch` deliberately never seats a list
 * (OpenChatBrowserPage.tsx `fetchAllSessions`). Had the server signalled a downed
 * host with `error`, a first load with one host of many down would render
 * "Could not load sessions" INSTEAD of the rows the reachable hosts returned —
 * trading a false-empty for a false-total-failure. `error` means the WHOLE read
 * failed; `unreachableHosts` means it partly succeeded, and the two travel on
 * different rails on purpose.
 *
 * `totals` is deliberately not returned: the component does not read it (its only
 * occurrence there is a comment). Note it — and `hasMore` — are computed by the
 * server over the SURVIVING hosts only, so when `unreachableHosts` is non-empty
 * both are knowably partial; that is exactly what the caller's notice discloses.
 *
 * @param res the Response (only `ok` / `status` / `json` are read, so a plain
 *            object stands in for one under test)
 * @returns the page's sessions + `hasMore` + `unreachableHosts` on success —
 *          `sessions: []` ONLY for a genuinely empty 200
 * @throws  Error whenever the response failed (non-2xx); also propagates the
 *          `.json()` rejection of a truncated 2xx body. NEVER for a merely
 *          partial fleet.
 */
export async function readAllSessionsPage(
  res: Pick<Response, 'ok' | 'status'> & { json: () => Promise<unknown> },
): Promise<AllSessionsPage> {
  // Tolerant on !ok (the status carries the message), STRICT on 2xx — a 2xx body
  // that fails to parse is a real failure and must reach the caller's catch
  // rather than becoming a confident empty list (WARDEN-1014 review).
  const body = await readListBody(res);
  const { items, error } = readListResponse<ClaudeSession & { host: string }>(
    res,
    body,
    'sessions',
    'sessions',
  );
  // On a hard HTTP failure `items` is the reader's placeholder, not data — so the
  // error wins and the caller keeps whatever was already on screen.
  if (error) throw new Error(error);
  // Read the pagination scalar off the SAME body the list came from, through the
  // scalar sibling (WARDEN-1191) so the narrowing line has ONE owner. Only its
  // `record` is taken: its error leg is the same precedence `readListResponse`
  // just applied above, so re-reading it here would assert nothing new.
  // Coerced the way the call sites did (`!!j.hasMore`), so an omitted or junk
  // value reads as "no further page" exactly as before.
  const { record } = readResponse(res, body, 'sessions');
  // The partial-fleet channel (WARDEN-1200), read off the SAME body and narrowed
  // the same defensive way the list is: anything that is not an array of strings
  // degrades to `[]` rather than reaching the caller, which renders these as host
  // names. An omitted key (the healthy fleet — the server omits it entirely) is
  // therefore `[]`, so the caller has one shape to read and no `undefined` guard.
  const unreachableHosts = Array.isArray(record.unreachableHosts)
    ? record.unreachableHosts.filter((h): h is string => typeof h === 'string' && !!h)
    : [];
  return { sessions: items, hasMore: !!record.hasMore, unreachableHosts };
}
