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
//   - ok: false, no res → the fetch itself failed (network/abort); `error`
//                         is the exception message.
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
    // A non-JSON body (e.g. an empty or HTML error page) parses to undefined
    // rather than throwing, so a malformed failure response is reported via
    // ok:false instead of surfacing a JSON parse error.
    const body = await res.json().catch(() => undefined);
    if (!res.ok) return { ok: false, error: body?.error, res };
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
      // A non-JSON body (empty/HTML error page) parses to undefined rather than
      // throwing, so a malformed failure is reported via ok:false (parity with
      // requestJson) instead of surfacing a JSON parse error.
      const body = await res.json().catch(() => undefined);
      if (res.ok) return { ok: true, data: body as T, res };
      // 4xx is a hard client error — retrying will not help, so return at once.
      if (res.status >= 400 && res.status < 500) return { ok: false, error: body?.error, res };
      // 5xx is transient — record the error and fall through to a retry.
      lastError = body?.error || `Request failed with status ${res.status}`;
    } catch (e) {
      // AbortError (timeout fired) or a network failure — both are retryable.
      lastError = e instanceof Error ? e.message : String(e);
    } finally {
      clearTimeout(timer);
    }
  }
  return { ok: false, error: lastError };
}
