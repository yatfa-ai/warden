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
