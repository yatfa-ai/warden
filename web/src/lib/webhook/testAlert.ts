/**
 * WARDEN-970 — pure derivation of the "Send test alert" probe's in-section
 * VERDICT from the raw transport result POST /api/webhook-test returns.
 *
 * Divergence from the telemetry sibling (web/src/lib/telemetry/testConnection.ts):
 * there the BACKEND already interprets the probe (mapCapabilitiesVerdict returns
 * { kind, message }) and the frontend module only picks a tone + label. The
 * webhook route returns the RAW transport result — `{ ok, dropped, attempts,
 * status }` straight off notify.sendWebhook (src/notify.js:107-112) — so this
 * module derives BOTH the kind and the user-facing copy client-side. That keeps
 * the interpretation frontend-only (no backend verdict endpoint) while giving
 * the user the same precise, plain-language read of the failure mode instead of
 * a raw HTTP code.
 *
 * Kept here, separate from the React component, so the mapping is plain,
 * side-effect-free and verifiable without a DOM (web/webhook-test-verdict.test.mjs).
 *
 * The verdict is NEVER persisted — a cached "Delivered" goes stale the moment
 * the receiver goes down or the shared secret is rotated, and would then read as
 * a false trust signal. It is recomputed on every click.
 */

/** The raw transport result returned by POST /api/webhook-test — sendWebhook's
 *  contract. Every field is optional here because this module is the boundary
 *  that has to survive a surprise/legacy/error body without throwing. */
export type WebhookTestResult = {
  /** true iff the POST reached the receiver and it answered 2xx. */
  ok?: boolean;
  /** true iff the alert was dropped (non-retryable 4xx, or attempts exhausted). */
  dropped?: boolean;
  /** number of POSTs actually made — 0 only for the gated NOOP_RESULT. */
  attempts?: number;
  /** last HTTP status observed; null when no response was ever produced. */
  status?: number | null;
};

/** Discriminates the outcomes a human has to act on differently. Distinct from
 *  the telemetry kinds because the failure modes differ (there is no schema
 *  handshake on a webhook — just reachability, auth and receiver health). */
export type WebhookTestVerdictKind =
  | 'delivered'
  | 'auth-rejected'
  | 'no-receiver'
  | 'receiver-error'
  | 'unreachable'
  | 'not-configured'
  | 'request-failed'
  | 'unknown';

export type WebhookTestVerdictTone = 'positive' | 'warning';

export type WebhookTestVerdict = {
  kind: WebhookTestVerdictKind;
  /** 'positive' ONLY for the unambiguously-delivered state — never paint a green
   *  success tone for anything the user still has to fix. */
  tone: WebhookTestVerdictTone;
  /** Short title line, legible at a glance before the message is read. */
  label: string;
  /** The honest, plain-language explanation — names the likely cause and the
   *  next action, and carries the exact HTTP status when there was one. */
  message: string;
};

/** " (status 401)" / "" — the exact status is never dropped, it is just moved
 *  out of the title line and into the explanation where it has context. */
function statusSuffix(status: number | null | undefined): string {
  return typeof status === 'number' ? ` (status ${status})` : '';
}

/**
 * Map a raw webhook-test result to its display verdict. Pure: same result →
 * same verdict, no DOM, no state, no I/O.
 *
 * Branch order matters and mirrors the transport's own contract:
 *   1. ok            → delivered (the only affirmative state)
 *   2. attempts === 0 → the gate no-op (NOOP_RESULT, src/notify.js:59): nothing
 *      was attempted at all. Near-unreachable now that the button is gated on a
 *      non-empty URL, but the backend can still return it, so it stays mapped
 *      rather than falling through to the generic fallback.
 *   3. dropped, by status class → auth / no-receiver / throttled-or-erroring /
 *      never-answered.
 *   4. anything else → a neutral warning fallback, so a shape this module has
 *      never seen renders instead of throwing (same discipline as
 *      describeTelemetryTestVerdict's `??` fallback).
 */
export function describeWebhookTestVerdict(result: WebhookTestResult | null | undefined): WebhookTestVerdict {
  const status = result?.status;

  if (result?.ok === true) {
    return {
      kind: 'delivered',
      tone: 'positive',
      label: 'Delivered',
      message: 'Your receiver accepted the test alert. Check your topic — the message should be there.',
    };
  }

  // The gate no-op: no URL resolved, so nothing was ever sent.
  if (result?.attempts === 0) {
    return {
      kind: 'not-configured',
      tone: 'warning',
      label: 'No URL configured',
      message: 'Nothing was sent — no webhook URL resolved. Enter a URL above and try again.',
    };
  }

  if (result?.dropped === true) {
    if (status === 401 || status === 403) {
      return {
        kind: 'auth-rejected',
        tone: 'warning',
        label: 'Auth rejected',
        message: `The receiver refused the shared secret${statusSuffix(status)}. Check it matches what your receiver expects.`,
      };
    }
    if (status === 404 || status === 410) {
      return {
        kind: 'no-receiver',
        tone: 'warning',
        label: 'No receiver',
        message: `Nothing is listening at that URL or topic${statusSuffix(status)}. Check both the URL and the topic name.`,
      };
    }
    if (status === 429 || (typeof status === 'number' && status >= 500)) {
      return {
        kind: 'receiver-error',
        tone: 'warning',
        label: 'Receiver throttled or erroring',
        message: `Reachable, but not accepting the alert right now${statusSuffix(status)}. Try again in a moment.`,
      };
    }
    if (status == null) {
      return {
        kind: 'unreachable',
        tone: 'warning',
        label: 'Could not reach',
        message: 'The request never got a response. Check the URL and your network connection.',
      };
    }
  }

  // Fallback — an unrecognized shape, or a dropped alert with a status outside
  // the classes above (e.g. a 400 from a receiver that dislikes the payload).
  // Neutral, never green, and still carries the status when there is one.
  return {
    kind: 'unknown',
    tone: 'warning',
    label: 'Could not deliver',
    message: `The alert was not delivered${statusSuffix(status)}. Check the URL and the shared secret, then try again.`,
  };
}

/**
 * The verdict for a probe that never reached OUR OWN backend (the /api/webhook-test
 * fetch itself threw). Distinct from every receiver-side outcome above: nothing is
 * known about the user's webhook, so the copy must not blame it. Lives here so the
 * hook never hand-builds a verdict object.
 */
export function webhookTestRequestFailedVerdict(detail: string): WebhookTestVerdict {
  return {
    kind: 'request-failed',
    tone: 'warning',
    label: 'Could not run the test',
    message: `Warden could not run the test${detail ? `: ${detail}` : '.'}`,
  };
}
