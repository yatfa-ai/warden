// Shared JSON request helper for the warden frontend.
//
// Collapses the repeated
//   fetch(url, { method, headers: { 'content-type': 'application/json' },
//                body: JSON.stringify(data) })
// boilerplate into one typed call. It returns a result object instead of
// throwing so call sites can handle HTTP errors and network failures in one
// place:
//   - ok: true          → request succeeded; `data` is the parsed JSON body.
//   - ok: false + res   → server returned non-2xx; `error` is the body's
//                         `error` string when present, `res` is the raw
//                         Response (e.g. for res.status).
//   - ok: false, no res → the fetch itself failed (network/abort), or a 2xx
//                         body failed to parse (e.g. truncated mid-stream);
//                         `error` is the exception message.
// `error` carries no generic "request failed" wording of its own, so each call
// site applies its own fallback toast/copy and existing messages are preserved.

export interface ApiResult<T = unknown> {
  ok: boolean;
  data?: T;
  /** server-supplied error string from the JSON body, when present */
  error?: string;
  /** the raw Response (present whenever fetch resolved, even on !ok) */
  res?: Response;
}

async function requestJson<T>(
  method: 'POST' | 'PUT',
  url: string,
  data: unknown,
): Promise<ApiResult<T>> {
  try {
    const res = await fetch(url, {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(data),
    });
    // Leg-gated parse — the one rule lives in `readListBody` below.
    const body = await readListBody(res);
    if (!res.ok) return { ok: false, error: (body as { error?: string } | undefined)?.error, res };
    return { ok: true, data: body as T, res };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** POST `data` as JSON to `url`. See ApiResult for the result shape. */
export function postJson<T = unknown>(url: string, data: unknown): Promise<ApiResult<T>> {
  return requestJson<T>('POST', url, data);
}

/** PUT `data` as JSON to `url`. See ApiResult for the result shape. */
export function putJson<T = unknown>(url: string, data: unknown): Promise<ApiResult<T>> {
  return requestJson<T>('PUT', url, data);
}

// A bounded GET for responses that gate a UI surface (Settings load, etc.).
//
// `requestJson`/postJson/putJson above intentionally do NOT bound the wait —
// writes surface their own toast on failure and are user-initiated, so a slow
// response is acceptable. A mount-time GET is different: it holds a `loading`
// flag true until it settles, and the prior Settings load coupled config + hosts
// in a bare `Promise.all` with no timeout and no retry, so a transiently-slow
// backend (the single-threaded warden server briefly blocking the event loop)
// spun the loader indefinitely — the WARDEN-828 forever-spinner.
//
// `fetchJson` wraps fetch so a stall resolves to a BOUNDED failure instead:
//   - an AbortController deadline (`timeoutMs`) per attempt — a server that
//     stops answering is aborted rather than awaited forever;
//   - a small retry count (`retries`) with linear backoff (`backoffMs`) so a
//     sub-second blip self-heals into a success rather than surfacing an error;
//   - the same ApiResult error-state convention, so a timeout reads identically
//     to a 500 at the call site (ok:false + error string).
//
// Retry policy: network failures, timeouts (AbortError), and 5xx are retried —
// these are the transient shapes a momentarily-blocked server produces. A 4xx is
// returned immediately (retrying a hard client error just hammers). A 2xx is the
// success path. `fetchImpl`/`sleepImpl` are injection seams so the
// timeout/retry/terminal branches are unit-testable without real timers.
const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface FetchJsonOptions {
  /** Per-attempt deadline. A stalled backend is aborted after this and retried. */
  timeoutMs?: number;
  /** Retries AFTER the first attempt (0 = one attempt, no retry). */
  retries?: number;
  /** Linear backoff between retries: attempt k (1-based) waits k * backoffMs. */
  backoffMs?: number;
  /** Injection seam for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** Injection seam for tests; defaults to a setTimeout-based sleep. */
  sleepImpl?: (ms: number) => Promise<void>;
}

const FETCH_JSON_DEFAULTS = {
  timeoutMs: 8_000,
  retries: 2,
  backoffMs: 300,
} as const;

/**
 * GET `url` as JSON with a bounded timeout + retry. Returns an `ApiResult`:
 * `ok:true` + `data` on a 2xx JSON body; `ok:false` + `error` (+ `res` when the
 * fetch resolved) on a terminal failure (4xx, or transient failure that
 * exhausted every retry). Never throws — the caller renders the error state.
 */
export async function fetchJson<T = unknown>(
  url: string,
  {
    timeoutMs = FETCH_JSON_DEFAULTS.timeoutMs,
    retries = FETCH_JSON_DEFAULTS.retries,
    backoffMs = FETCH_JSON_DEFAULTS.backoffMs,
    fetchImpl = fetch,
    sleepImpl = defaultSleep,
  }: FetchJsonOptions = {},
): Promise<ApiResult<T>> {
  let lastError: string | undefined;
  // `retries` = additional attempts after the first → total attempts = retries + 1.
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleepImpl(attempt * backoffMs);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, { signal: controller.signal });
      clearTimeout(timer);
      // Leg-gated parse — the one rule lives in `readListBody` below. A 2xx that
      // fails to parse therefore rejects into the catch and joins the RETRYABLE
      // path, which is what `/api/config` (it gates the whole Settings render)
      // needs: a truncated 200 must surface Retry, never a defaults-populated
      // form with Save enabled.
      const body = await readListBody(res);
      if (res.ok) return { ok: true, data: body as T, res };
      const bodyError = (body as { error?: string } | undefined)?.error;
      // 4xx is a hard client error — retrying will not help, so return at once.
      if (res.status >= 400 && res.status < 500) return { ok: false, error: bodyError, res };
      // 5xx is transient — record the error and fall through to a retry.
      lastError = bodyError || `Request failed with status ${res.status}`;
    } catch (e) {
      // AbortError (timeout fired) or a network failure — both are retryable.
      lastError = e instanceof Error ? e.message : String(e);
    } finally {
      clearTimeout(timer);
    }
  }
  return { ok: false, error: lastError };
}

/** What `readListResponse` extracts: the list (never undefined) + a failure string, or null. */
export interface ListResponse<T> {
  /** `body[field]` when it is an array, else `[]`. Never undefined. */
  items: T[];
  /** Non-null whenever the response failed — by EITHER half of the convention. */
  error: string | null;
}

/**
 * Read a git list response the way warden's backend actually answers, honouring
 * BOTH halves of its error convention (WARDEN-1014).
 *
 * `withGitRepo` (src/gitRoutes.js:473, 15 routes) has TWO failure paths that answer
 * **HTTP 200** — the no-cwd guard (:490) and the catch-all (:494) — and both spread
 * `gitDefaults` into the body, so the empty array arrives *alongside* `error`:
 *
 *     200 { stashes: [], error: 'no cwd' }
 *
 * That is why the usual-looking `Array.isArray(j[field]) ? j[field] : []` guard is
 * the bug rather than the defence: it accepts the server's placeholder as data, and
 * an unreachable SSH host renders "no stashes" — indistinguishable from a clean repo
 * (the WARDEN-89 false-empty disease). Gating on `res.ok` alone is the *incomplete*
 * remedy: it catches the 404 half (:477) and misses the 200 half entirely.
 *
 * This reader is deliberately SEPARATE from `fetchJson` rather than a flag on it:
 * `fetchJson` returns `ok:true` for ANY 2xx (:135) and sits behind the Settings load,
 * so widening its 2xx contract would relocate this bug into a shared primitive and
 * churn its 12 existing specs. Additive here, nothing else moves.
 *
 * Error precedence — a non-2xx reports its STATUS, not the body string, preserving
 * FileViewer's existing `Failed to load blame (404)` copy verbatim:
 *   1. `!res.ok`                      → `Failed to load <label> (<status>)`
 *   2. 2xx + non-empty `body.error`   → that string
 *   3. otherwise                      → `null`
 *
 * `items` is populated on every leg (the caller decides whether to apply it — on a
 * hard HTTP failure it is the server's placeholder, not data).
 *
 * @param res   the Response (only `ok`/`status` are read, so a plain object works in tests)
 * @param body  the parsed JSON body, or `undefined` when it did not parse
 * @param field the response key holding the list (`stashes`, `commits`, `entries`, …)
 * @param label human-readable noun for the status message (`blame`, `stashes`, …)
 */
export function readListResponse<T = unknown>(
  res: Pick<Response, 'ok' | 'status'>,
  body: unknown,
  field: string,
  label: string,
): ListResponse<T> {
  // `body` is `unknown` (it may be undefined for a non-JSON response), so read the
  // two keys through one narrowed view rather than casting at each use.
  const record = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  const raw = record[field];
  const items = Array.isArray(raw) ? (raw as T[]) : [];
  if (!res.ok) return { items, error: `Failed to load ${label} (${res.status})` };
  // An empty string is not an error — only a non-empty one is, so a route that
  // spreads `error: ''` (or omits it) still reads as success.
  const bodyError = typeof record.error === 'string' && record.error ? record.error : null;
  return { items, error: bodyError };
}

/** What {@link readResponse} extracts: the body as a record + a failure string, or null. */
export interface ResponseRead {
  /**
   * `body` narrowed to a record — `{}` when it was `undefined` or not an object, so
   * the caller can read its own keys unguarded. This is the ONE home of that
   * narrowing: {@link readListResponse} keeps its own copy only because it predates
   * this sibling and is pinned byte-for-byte by web/list-response.test.mjs.
   */
  record: Record<string, unknown>;
  /** Non-null whenever the response failed — by EITHER half of the convention. */
  error: string | null;
}

/**
 * Apply warden's error convention to a response whose payload is NOT a list — a
 * scalar, or a list PLUS a scalar — and leave the body to the caller (WARDEN-1191).
 *
 * {@link readListResponse} answers `{items, error}`, so it can only serve a payload
 * whose whole answer IS the list. Two seams landed a day apart needing the other
 * shape, and both re-derived the same missing half by hand:
 *
 * - `gitDiffApi.ts` (WARDEN-1187) — the payload key is a STRING, so `items` was
 *   `[]` unconditionally and got DISCARDED; `field: 'diff'` was passed only so the
 *   reader's signature was honoured. A parameter that exists to be ignored is the
 *   clearest sign the abstraction was missing.
 * - `allSessionsApi.ts` (WARDEN-1188) — a real list PLUS `hasMore`, so the reader
 *   served half the payload and the scalar was re-read off the body by hand. Its
 *   own comment cites WARDEN-1187 by name.
 *
 * This is a SIBLING, not a flag on `readListResponse` — the same reasoning stated
 * for that reader above, one layer up. Widening the list reader to also answer
 * scalars would relocate the list contract's 19 specs into a conditional, and the
 * two shapes want different return types, not different arguments. `readListBody`
 * and `readErrorBody` are already exactly such siblings; the scalar/mixed case is
 * the one family member that was never given a home. Additive here, nothing moves.
 *
 * Error precedence is IDENTICAL to `readListResponse`'s — that identity is the
 * whole point, since a divergence is precisely the drift this removes:
 *   1. `!res.ok`                      → `Failed to load <label> (<status>)`
 *   2. 2xx + non-empty `body.error`   → that string
 *   3. otherwise                      → `null`
 *
 * Leg 1 never consults the body, which matters because it IS reachable: on a
 * non-2xx `readListBody` swallows a parse failure to `undefined` but a body that
 * DOES parse arrives live, and `withGitRepo` answers exactly that shape (a 404
 * carrying a bare `{error}`). The status wins there, deliberately.
 *
 * An empty-string `error` on a 2xx is NOT a failure, so a route that spreads
 * `error: ''` (or omits it) still reads as success.
 *
 * @param res   the Response (only `ok`/`status` are read, so a plain object works in tests)
 * @param body  the parsed JSON body, or `undefined` when it did not parse
 * @param label human-readable noun for the status message (`diff`, `sessions`, …)
 */
export function readResponse(
  res: Pick<Response, 'ok' | 'status'>,
  body: unknown,
  label: string,
): ResponseRead {
  // `body` is `unknown` (it may be undefined for a non-JSON response), so narrow it
  // once here and hand the caller a record it can read unguarded.
  const record = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  if (!res.ok) return { record, error: `Failed to load ${label} (${res.status})` };
  // An empty string is not an error — only a non-empty one is.
  const bodyError = typeof record.error === 'string' && record.error ? record.error : null;
  return { record, error: bodyError };
}

/**
 * Parse a git list response's body with the tolerance each leg actually deserves —
 * the caller-side companion to {@link readListResponse} (WARDEN-1014 review).
 *
 * The two legs are NOT symmetric, and collapsing them is how a refactor re-creates
 * the very false-empty this reader exists to remove:
 *
 * - **`!ok`** — the body is OPTIONAL. The STATUS carries the message, and the body
 *   is routinely an HTML error page that will never parse. Swallow the rejection to
 *   `undefined`; `readListResponse` still reports `Failed to load <label> (<status>)`.
 * - **`ok`** — the body IS the answer. A parse failure is a REAL failure, so let it
 *   reject and reach the caller's `catch`. `fetch` resolves `ok: true` as soon as the
 *   HEADERS arrive, so a body truncated mid-stream — a dropped SSH tunnel to a remote
 *   host, warden's normal deployment shape — rejects here rather than at `fetch`.
 *   Swallowing that would hand `readListResponse` an empty record, which it can only
 *   read as `{ items: [], error: null }` (it cannot know a parse failed), and the
 *   surface would render a confident empty list for a network failure.
 *
 * `readListResponse` itself stays deliberately PERMISSIVE about a junk body — it is a
 * pure reader over an already-obtained value with no way to distinguish "absent
 * because unparseable" from "absent because the route omitted it". The strictness
 * belongs HERE, at the seam that still knows a rejection happened.
 */
export async function readListBody(
  res: Pick<Response, 'ok'> & { json: () => Promise<unknown> },
): Promise<unknown> {
  if (res.ok) return res.json();
  return res.json().catch(() => undefined);
}

/**
 * The same leg-gated parse as {@link readListBody}, narrowed for a call site that
 * reads `body.error` UNGUARDED (the search/browse dialogs, whose endpoints answer
 * some failures at HTTP 200). `readListBody` deliberately returns `unknown`
 * because it feeds `readListResponse`, which handles `unknown`; this companion is
 * a typing convenience over the SAME decision — the `res.ok` gate is not
 * re-expressed here.
 *
 * The `?? {}` coalesce is deliberately gated to the FAILURE leg:
 * - **`!ok`** — a body that parsed to literal `null` becomes `{}`, so the
 *   unguarded `body.error` that follows cannot throw. The site's own `!res.ok`
 *   gate still produces its message.
 * - **`ok`** — the value is returned VERBATIM, `null` included. Coalescing here
 *   would turn a `null` 200 body from a throw (→ the site's error banner) into an
 *   empty record (→ "No results found") — a fresh WARDEN-89 false-empty, in
 *   exactly the direction this rule exists to prevent.
 */
export async function readErrorBody(
  res: Pick<Response, 'ok'> & { json: () => Promise<unknown> },
): Promise<{ error?: string } & Record<string, unknown>> {
  const body = await readListBody(res);
  return (res.ok ? body : (body ?? {})) as { error?: string } & Record<string, unknown>;
}
