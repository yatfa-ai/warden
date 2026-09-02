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
// WARDEN-1144 generalized this from ONE call site to the whole tree: EVERY read
// that gates a loading/pending/busy flag is bounded here. Two shells sit on the
// one `runBounded` deadline core, and which one a site wants is decided by how
// it reads its BODY, not by its HTTP method:
//   - `fetchJson`    — this helper parses the body and reports an ApiResult.
//   - `fetchBounded` — hands back the RAW Response for the many sites that read
//                      it through the house readers (readListBody +
//                      readListResponse / readResponse / readErrorBody), whose
//                      200-carrying-{error} convention fetchJson cannot express.
// Interval pollers do NOT take the defaults below — see `pollerFetchOptions`.
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
  /**
   * The CALLER's own cancellation signal (close / switch / unmount), COMPOSED
   * with the per-attempt deadline rather than replaced by it (WARDEN-1144).
   *
   * The two are different questions and both must be answerable: the deadline
   * says "this server stopped answering", the caller's signal says "nobody is
   * waiting for this any more". A caller abort is TERMINAL — it rejects at once
   * with the caller's own reason (an `AbortError`, so existing
   * `err.name === 'AbortError'` / `ac.signal.aborted` guards keep working) and
   * is never retried, because a cancellation is not a transient failure.
   */
  signal?: AbortSignal;
  /**
   * Request init passed through to `fetch` (method/headers/body). Present so a
   * READ expressed as a POST — `/api/read-file`, `/api/search-files` — can be
   * bounded too: the boundary this helper draws is "does it gate a UI surface",
   * not "is it a GET". `signal` is owned by this helper and is overwritten.
   */
  init?: RequestInit;
}

const FETCH_JSON_DEFAULTS = {
  timeoutMs: 8_000,
  retries: 2,
  backoffMs: 300,
} as const;

// ---------------------------------------------------------------------------
// Poller policy (WARDEN-1144). The defaults above suit a ONE-SHOT or
// manual-refresh read: nothing fires again, so a stall holds the spinner with
// nothing left to clear it, and a retry is the only thing that can recover it.
//
// An INTERVAL POLLER is the opposite problem and must NOT inherit them:
//
//   - the poller core calls its fetch on every tick UNCONDITIONALLY (there is no
//     in-flight guard — see lib/visiblePoller.ts), so a stalled tick does not
//     freeze the surface: a later tick clears the flag and the UI self-heals.
//     THE NEXT TICK *IS* THE RETRY.
//   - what a stall does instead is STACK in-flight requests against a server
//     that can block (dozens of synchronous fs calls sit on request-serving
//     paths in a single-threaded process). Retry piled on retry makes that
//     worse, not better.
//
// So the policy for a poller is a SHORTER LEASH, not a longer one:
//   **no retries, and a deadline strictly shorter than the poll period.**
// Half the period is the ceiling. The sharpest case sets the bar: the 10s
// /api/health poll run on the defaults above would spend 3 attempts x 8s ~= 24s
// of attempts inside a 10s window — three ticks' worth of overlap from one tick.
//
// Use `pollerFetchOptions(periodMs)` rather than re-deriving this per hook.
const POLLER_FETCH = {
  /** A poller never retries — the next tick is the retry. */
  retries: 0,
  /** The deadline is at most this FRACTION of the poll period. */
  timeoutFraction: 0.5,
  /** Never shorter than this, so a very fast poll still tolerates a real RTT. */
  minTimeoutMs: 1_000,
} as const;

/**
 * The bounded-fetch options an INTERVAL POLLER should use for a read that gates
 * a loading/pending/busy flag: `retries: 0` and a deadline of half the poll
 * period, capped at the one-shot default so a slow-cadence poll does not get a
 * uselessly long leash. See the POLLER_FETCH note above for why this differs
 * from the one-shot defaults.
 *
 * @param periodMs the poller's own tick cadence.
 */
export function pollerFetchOptions(periodMs: number): { retries: number; timeoutMs: number } {
  const half = Math.floor(periodMs * POLLER_FETCH.timeoutFraction);
  const capped = Math.min(half, FETCH_JSON_DEFAULTS.timeoutMs);
  return {
    retries: POLLER_FETCH.retries,
    timeoutMs: Math.max(capped, POLLER_FETCH.minTimeoutMs),
  };
}

/**
 * One attempt's verdict, as `onResponse` reports it and as `runBounded`
 * answers: `settled` means the loop is over (a terminal answer, success OR
 * failure — a 4xx is settled), `settled: false` means "retryable, try again".
 */
type BoundedOutcome<T> = { settled: true; value: T } | { settled: false; error?: string };

/**
 * Run one bounded attempt loop and hand each settled `Response` to `onResponse`,
 * which decides whether it is a terminal answer or a retryable failure. This is
 * THE one home of the deadline: `fetchJson` and `fetchBounded` are both thin
 * shells over it, so there is exactly one AbortController-deadline
 * implementation in the tree and a new surface adopts it rather than
 * hand-rolling a third one.
 *
 * A throw out of `onResponse` (a 2xx whose body will not parse) is retryable —
 * same class as a 5xx.
 */
async function runBounded<T>(
  url: string,
  {
    timeoutMs = FETCH_JSON_DEFAULTS.timeoutMs,
    retries = FETCH_JSON_DEFAULTS.retries,
    backoffMs = FETCH_JSON_DEFAULTS.backoffMs,
    fetchImpl = fetch,
    sleepImpl = defaultSleep,
    signal,
    init,
  }: FetchJsonOptions,
  onResponse: (res: Response) => Promise<BoundedOutcome<T>>,
): Promise<BoundedOutcome<T>> {
  let lastError: string | undefined;
  // `retries` = additional attempts after the first → total attempts = retries + 1.
  for (let attempt = 0; attempt <= retries; attempt++) {
    // A caller abort between attempts is terminal — do not burn the backoff.
    if (signal?.aborted) throw abortReason(signal);
    if (attempt > 0) await sleepImpl(attempt * backoffMs);
    if (signal?.aborted) throw abortReason(signal);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    // Compose the caller's cancellation with our deadline: EITHER aborts the
    // attempt, and the caller's one is re-raised untouched below.
    const onCallerAbort = () => controller.abort();
    signal?.addEventListener('abort', onCallerAbort, { once: true });
    try {
      const res = await fetchImpl(url, { ...init, signal: controller.signal });
      clearTimeout(timer);
      const outcome = await onResponse(res);
      if (outcome.settled) return outcome;
      lastError = outcome.error;
    } catch (e) {
      // A CALLER cancellation is terminal, never retried, and surfaces as the
      // caller's own reason so `err.name === 'AbortError'` guards still fire.
      if (signal?.aborted) throw abortReason(signal);
      // Our deadline fired, or the network failed — both are retryable.
      lastError = e instanceof Error ? e.message : String(e);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onCallerAbort);
    }
  }
  return { settled: false, error: lastError };
}

/** The caller's abort reason, or a standard AbortError when it supplied none. */
function abortReason(signal: AbortSignal): unknown {
  const reason = (signal as AbortSignal & { reason?: unknown }).reason;
  if (reason !== undefined) return reason;
  return typeof DOMException === 'function'
    ? new DOMException('The operation was aborted.', 'AbortError')
    : Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' });
}

/**
 * GET `url` as JSON with a bounded timeout + retry. Returns an `ApiResult`:
 * `ok:true` + `data` on a 2xx JSON body; `ok:false` + `error` (+ `res` when the
 * fetch resolved) on a terminal failure (4xx, or transient failure that
 * exhausted every retry). Never throws — the caller renders the error state.
 *
 * (The one exception is a CALLER `signal` abort, which rejects with the
 * caller's own reason: a cancelled read has no error state to render, and the
 * call site's existing abort guard is what should handle it.)
 */
export async function fetchJson<T = unknown>(
  url: string,
  options: FetchJsonOptions = {},
): Promise<ApiResult<T>> {
  const outcome = await runBounded<ApiResult<T>>(url, options, async (res) => {
    // Leg-gated parse — the one rule lives in `readListBody` below. A 2xx that
    // fails to parse therefore rejects into runBounded's catch and joins the
    // RETRYABLE path, which is what `/api/config` (it gates the whole Settings
    // render) needs: a truncated 200 must surface Retry, never a
    // defaults-populated form with Save enabled.
    const body = await readListBody(res);
    if (res.ok) return { settled: true, value: { ok: true, data: body as T, res } };
    const bodyError = (body as { error?: string } | undefined)?.error;
    // 4xx is a hard client error — retrying will not help, so return at once.
    if (res.status >= 400 && res.status < 500) {
      return { settled: true, value: { ok: false, error: bodyError, res } };
    }
    // 5xx is transient — record the error and fall through to a retry.
    return { settled: false, error: bodyError || `Request failed with status ${res.status}` };
  });
  return outcome.settled ? outcome.value : { ok: false, error: outcome.error };
}

/**
 * The SAME bounded deadline as {@link fetchJson}, handing back the RAW
 * `Response` (WARDEN-1144).
 *
 * Most of warden's UI-gating reads cannot use `fetchJson`, because they read
 * their body through the house readers (`readListBody` + `readListResponse` /
 * `readResponse` / `readErrorBody`) that honour BOTH halves of the backend's
 * error convention — a 200 carrying `{error}` is a failure. `fetchJson` parses
 * the body itself and reports any 2xx as `ok:true`, so routing those sites
 * through it would flatten that convention back into the WARDEN-89 false-empty
 * it was written to remove. This sibling gives them the deadline WITHOUT the
 * body contract: the response is theirs to read, exactly as a raw `fetch`'s was.
 *
 * Retry policy is deliberately TRANSPORT-ONLY: a network failure or a fired
 * deadline is retried, and any HTTP status is a settled answer returned at
 * once. It cannot retry a 5xx the way `fetchJson` does, because deciding that
 * requires reading the body — which would consume the stream the caller owns.
 *
 * THROWS on exhaustion (like the raw `fetch` it replaces, so the call site's
 * existing `catch` is the error path) and on a caller `signal` abort.
 */
export async function fetchBounded(
  url: string,
  options: FetchJsonOptions = {},
): Promise<Response> {
  const outcome = await runBounded<Response>(url, options, async (res) => ({
    settled: true,
    value: res,
  }));
  if (outcome.settled) return outcome.value;
  throw new Error(outcome.error || `Request to ${url} failed`);
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
