// TelemetryClient — the consent-gated SINK for telemetry events (roadmap
// WARDEN-446 / design WARDEN-443), reworked onto INDEPENDENT PER-CATEGORY consent
// by WARDEN-1116.
//
// TWO INVARIANTS this client enforces by construction:
//   1. NOTHING COLLECTED = NOTHING RECORDED. `record()` is a guarded no-op unless
//      at least one COLLECTING category is enabled. Everything is off by default,
//      so out of the box this records, buffers, and sends nothing.
//   2. CATEGORIES ARE INDEPENDENT. Enabling one NEVER enables another, and none
//      is subordinate to another. The old "extended requires base" clamp is gone:
//      `names` is a DECORATING category that adds fields to events other
//      categories produce, so on its own it is naturally inert — with nothing
//      collecting, `record()` still enqueues nothing. Safety comes from that
//      inertness, not from a clamp.
//
// The consent decision itself is NOT made here — it is delegated to `./consent`,
// the single authority. This client only asks it questions.
//
// NO TRANSPORT / NO NETWORK / NO ENDPOINT. `record()` validates the event against
// the schema and enqueues it to a bounded in-memory buffer; the live send path is
// the main-process pipeline (electron/telemetry-pipeline.cjs).

import {
  validateEvent,
  type TelemetryEvent,
} from './schema';
import {
  NO_CONSENT,
  collectsEvents,
  isCategoryEnabled,
  normalizeConsent,
  type TelemetryCategory,
  type TelemetryConsent,
} from './consent';

export interface TelemetryClientOptions {
  /** Max events retained in the in-memory buffer; oldest are dropped past this so
   *  a burst (or a long-running app with no transport yet) cannot grow memory
   *  without bound. Defaults to 100. */
  maxBuffer?: number;
}

export interface TelemetryClient {
  /** Set consent for one or more categories. Any category omitted is left
   *  unchanged. NO clamping and NO coupling — setting one category never changes
   *  another. Returns the effective consent so the caller can confirm what was
   *  applied. */
  setConsent(consent: Partial<Record<TelemetryCategory, boolean>>): TelemetryConsent;
  /** Toggle ONE category. Independent of every other category. */
  setCategory(category: TelemetryCategory, enabled: boolean): TelemetryConsent;
  /** Replace the whole consent state (anything unrecognized resolves to off). */
  replaceConsent(consent: unknown): TelemetryConsent;
  /** The effective per-category consent. */
  getConsent(): TelemetryConsent;
  /** Is this one category enabled? */
  isCategoryOn(category: TelemetryCategory): boolean;
  /** True iff a COLLECTING category is on (i.e. `record()` will enqueue). A
   *  decorating-only consent is false: nothing is collected, so nothing is sent. */
  isCollecting(): boolean;
  /** Record a telemetry event. A guarded NO-OP (records nothing) while nothing is
   *  being collected. Otherwise validates the event against the schema and
   *  enqueues it to the in-memory buffer. Returns true iff an event was enqueued
   *  (collecting AND schema-valid). */
  record(event: unknown): boolean;
  /** Drain + return the buffered events, clearing the buffer. */
  drain(): TelemetryEvent[];
  /** Number of events currently buffered. */
  size(): number;
}

/** Construct a TelemetryClient. Consent defaults to OFF for every category. */
export function createTelemetryClient(options: TelemetryClientOptions = {}): TelemetryClient {
  const maxBuffer = typeof options.maxBuffer === 'number' && options.maxBuffer > 0
    ? Math.floor(options.maxBuffer)
    : 100;

  let consent: TelemetryConsent = NO_CONSENT;
  const buffer: TelemetryEvent[] = [];

  return {
    setConsent(partial) {
      const next: Record<string, boolean> = { ...consent };
      if (partial && typeof partial === 'object') {
        for (const [k, v] of Object.entries(partial)) {
          // Only a real boolean changes a category; anything else leaves it as
          // it was (a garbage value must never flip a consent switch).
          if (typeof v === 'boolean') next[k] = v;
        }
      }
      consent = normalizeConsent(next);
      return consent;
    },
    setCategory(category, enabled) {
      consent = normalizeConsent({ ...consent, [category]: enabled === true });
      return consent;
    },
    replaceConsent(value) {
      consent = normalizeConsent(value);
      return consent;
    },
    getConsent() {
      return consent;
    },
    isCategoryOn(category) {
      return isCategoryEnabled(consent, category);
    },
    isCollecting() {
      return collectsEvents(consent);
    },
    record(event) {
      // INVARIANT 1: nothing collected = nothing recorded. Before anything else,
      // the consent gate. With no collecting category on this records/buffers/
      // sends nothing — no allocation, no validation.
      if (!collectsEvents(consent)) return false;
      // Schema conformance: only well-formed events are retained. An invalid
      // event is dropped (returns false), never buffered.
      if (!validateEvent(event)) return false;

      const safe = event as TelemetryEvent;

      // Bounded buffer (ring): drop oldest past maxBuffer so a burst or a
      // long-lived app with no transport yet cannot grow memory unbounded.
      buffer.push(safe);
      if (buffer.length > maxBuffer) buffer.shift();
      return true;
    },
    drain() {
      const out = buffer.splice(0, buffer.length);
      return out;
    },
    size() {
      return buffer.length;
    },
  };
}
