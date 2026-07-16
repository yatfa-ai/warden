// TelemetryClient — slice 1 of roadmap WARDEN-446 (design WARDEN-443).
//
// The consent-gated SINK for telemetry events. This is the stable call site the
// later slices plug into: slice 4's instrumentation source
// (electron/telemetry-source.cjs) is wired today with `record: null` awaiting
// `client.record.bind(client)` (see electron/main.cjs WARDEN-463 seam); when the
// pipeline-assembly slice connects them, the source's already-redacted events
// flow into `record()` here. Pipeline assembly (schema → redact → consent-gate →
// transport, wired end-to-end with the source) is a later slice — per
// redact.ts's note — so THIS slice ships only the gate + the buffer, no transport.
//
// TWO INVARIANTS this client enforces by construction:
//   1. OFF = NOTHING. With consent off, `record()` is a guarded no-op that
//      records, buffers, and sends nothing (the first layer of "off = nothing";
//      the source's consent gate is the second). Nothing leaves the machine
//      until base consent is explicitly turned on.
//   2. EXTENDED REQUIRES BASE. The extended tier (chat/session names) CANNOT be
//      enabled unless base is on — enforced at EVERY setter, so no caller can
//      bypass it. The server PUT handler enforces the same clamp server-side
//      (src/server.js WARDEN-457); the UI disables the toggle when base is off.
//      Defense in depth: UI + client + server all refuse extended-without-base.
//
// NO TRANSPORT / NO NETWORK / NO ENDPOINT in this slice. `record()` validates
// the event against the schema and enqueues it to a bounded in-memory buffer; the
// send path is slotted in by a later slice (call `drain()` to hand the buffer to
// a transport) WITHOUT changing call sites.
//
// REDACTION SEAM (WARDEN-443 Principle #3 — nothing un-redacted retained). A
// later slice inserts a pre-collection `redact()` pass at the marked seam below
// (before the buffer). It is safe to defer here because (a) in THIS slice no real
// source is wired to `record()` — the buffer only holds synthetic/test events —
// and (b) when the source IS wired, slice 4 already redacts at the collection
// boundary (buildErrorEvent redacts the message; parseStackFrames drops paths),
// so events arriving at `record()` are already scrubbed. The seam makes the
// later defense-in-depth redact a one-line insertion with no call-site change.

import {
  validateEvent,
  type ConsentTier,
  type TelemetryEvent,
} from './schema';

/** The two consent flags as the Settings page stores them (telemetryBaseEnabled /
 *  telemetryExtendedEnabled). `extended` is meaningful only when `base` is on. */
export interface TelemetryConsent {
  base: boolean;
  extended: boolean;
}

export interface TelemetryClientOptions {
  /** Max events retained in the in-memory buffer; oldest are dropped past this so
   *  a burst (or a long-running app with no transport yet) cannot grow memory
   *  without bound. Defaults to 100. */
  maxBuffer?: number;
}

export interface TelemetryClient {
  /** Set consent flags. Any field may be omitted to leave it unchanged. Extended
   *  is CLAMPED to false unless base is on. Returns the effective (post-clamp)
   *  consent so the caller can confirm what was applied. */
  setConsent(consent: Partial<TelemetryConsent>): TelemetryConsent;
  /** Toggle base consent. Turning base OFF also forces extended OFF. */
  setBaseConsent(base: boolean): TelemetryConsent;
  /** Toggle extended consent — CLAMPED to false unless base is on. */
  setExtendedConsent(extended: boolean): TelemetryConsent;
  /** The effective (already-clamped) consent flags. */
  getConsent(): TelemetryConsent;
  /** The effective tier: 'off' (base off), 'base' (base on), or 'extended'
   *  (both on). */
  getTier(): ConsentTier;
  /** True iff base consent is on (i.e. `record()` will enqueue). */
  isConsentOn(): boolean;
  /** Record a telemetry event. A guarded NO-OP (records nothing) when consent is
   *  off. When base consent is on, validates the event against the schema and
   *  enqueues it to the in-memory buffer. Returns true iff an event was
   *  enqueued (consent on AND schema-valid). */
  record(event: unknown): boolean;
  /** Drain + return the buffered events, clearing the buffer. The transport a
   *  later slice slots in calls this on its send cadence. */
  drain(): TelemetryEvent[];
  /** Number of events currently buffered. */
  size(): number;
}

/** Construct a TelemetryClient. Consent defaults to OFF (both tiers false). */
export function createTelemetryClient(options: TelemetryClientOptions = {}): TelemetryClient {
  const maxBuffer = typeof options.maxBuffer === 'number' && options.maxBuffer > 0
    ? Math.floor(options.maxBuffer)
    : 100;

  let base = false;
  let extended = false;
  const buffer: TelemetryEvent[] = [];

  const clampExtended = () => {
    if (!base && extended) extended = false;
  };

  const effective = (): TelemetryConsent => ({ base, extended: base && extended });

  return {
    setConsent(consent) {
      if (typeof consent.base === 'boolean') base = consent.base;
      if (typeof consent.extended === 'boolean') extended = consent.extended;
      clampExtended();
      return effective();
    },
    setBaseConsent(value) {
      base = value;
      clampExtended();
      return effective();
    },
    setExtendedConsent(value) {
      // Extended is subordinate to base: enabling it is ignored (clamped to
      // false) unless base is already on. This is the extended-requires-base
      // invariant enforced at the setter.
      extended = value && base;
      return effective();
    },
    getConsent() {
      return effective();
    },
    getTier() {
      if (!base) return 'off';
      return extended ? 'extended' : 'base';
    },
    isConsentOn() {
      return base;
    },
    record(event) {
      // INVARIANT 1: OFF = NOTHING. Before anything else, the consent gate. With
      // base off this records/buffers/sends nothing — no allocation, no validation.
      if (!base) return false;
      // Schema conformance: only well-formed events are retained. An invalid
      // event is dropped (returns false), never buffered.
      if (!validateEvent(event)) return false;

      // REDACTION SEAM — a later slice inserts the pre-collection redact() pass
      // HERE, before the buffer, per WARDEN-443 Principle #3. See file header.
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
