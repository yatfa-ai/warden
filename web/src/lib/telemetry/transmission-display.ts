// Pure display helpers for the transmission log of ACTUAL send outcomes
// (WARDEN-668 — verifiability's third leg: promise → preview → ACTUAL). The
// component (web/src/components/TelemetryTransmissionLog.tsx) maps each ring
// entry through `describeTransmissionEntry` to render a row; this module holds
// the entry → row mapping so the null-handling is unit-testable without a
// browser (this repo has no React/RTL runner, and browser QA is sandbox-blocked
// — see WARDEN-130/WARDEN-68).
//
// WHY THIS IS PURE + SEPARATE FROM THE COMPONENT: an entry crosses a process
// boundary (the Electron contextBridge clone). The CJS module normalizes the
// shape on the WRITE side, but the renderer should not TRUST that across the
// clone — a single malformed entry (a future schema drift, a partial payload)
// must never blank the whole verifiability panel. So every field is read
// defensively here: a missing/null field degrades to a display placeholder, not
// a render throw. Keeping it out of the .tsx also lets the OXC-transform test
// harness import it standalone (only a TYPE is imported, which transpile strips
// — see web/storage.test.mjs for the precedent).
import type { TransmissionLogEntry } from '@/lib/electron';

/** The display tone for a single outcome — drives icon + color in the row. */
export type TransmissionOutcomeTone = 'ok' | 'dropped' | 'unknown';

/** A single ring entry mapped to the values a row renders. All strings are
 *  display-safe: null/missing source fields become a placeholder, never a crash. */
export interface TransmissionRowDescriptor {
  /** Stable key + sort basis (newest-first). 0 only for a malformed timestamp. */
  timestamp: number;
  /** The user-visible row label — 'Delivered' | 'Dropped' | 'Unknown'. This is
   *  the SINGLE source of truth for the rendered label string: the component
   *  reads `d.outcomeLabel` directly (it does NOT hardcode the strings), so the
   *  outcomeLabel assertions below are genuine coverage of what the user sees —
   *  change the label here and both the row text and the tests move together. */
  outcomeLabel: string;
  /** Drives the row's icon + color. 'unknown' covers a null outcome. */
  outcomeTone: TransmissionOutcomeTone;
  /** HTTP status as a string, or DASH when null (no response / network error). */
  statusLabel: string;
  /** Destination host, or DASH when null/empty (absent or malformed endpoint). */
  hostLabel: string;
  /** Events in the batch (always a number; 0 if the field was malformed). */
  eventCount: number;
  /** Transport attempts for this batch (always a number). */
  attempts: number;
}

/** Placeholder shown when a metadata field is null/missing — never empty, so a
 *  column never collapses to a blank that reads as "the value failed to load". */
export const TRANSMISSION_DASH = '—';

/**
 * Map one ring entry to its row descriptor. Reads every field defensively: a
 * null/missing outcome becomes 'Unknown', a null status/host becomes DASH, and
 * numeric fields coerce to 0 when malformed. Never throws — a bad entry degrades
 * to a (still-renderable) row rather than breaking the panel.
 */
export function describeTransmissionEntry(
  entry: TransmissionLogEntry | null | undefined,
): TransmissionRowDescriptor {
  const e = entry ?? ({} as Partial<TransmissionLogEntry>);
  let outcomeLabel: string;
  let outcomeTone: TransmissionOutcomeTone;
  if (e.outcome === 'ok') {
    outcomeLabel = 'Delivered';
    outcomeTone = 'ok';
  } else if (e.outcome === 'dropped') {
    outcomeLabel = 'Dropped';
    outcomeTone = 'dropped';
  } else {
    outcomeLabel = 'Unknown';
    outcomeTone = 'unknown';
  }
  return {
    timestamp: typeof e.timestamp === 'number' && Number.isFinite(e.timestamp) ? e.timestamp : 0,
    outcomeLabel,
    outcomeTone,
    statusLabel:
      typeof e.status === 'number' && Number.isFinite(e.status) ? String(e.status) : TRANSMISSION_DASH,
    hostLabel:
      typeof e.endpointHost === 'string' && e.endpointHost.length > 0 ? e.endpointHost : TRANSMISSION_DASH,
    eventCount: typeof e.eventCount === 'number' && Number.isFinite(e.eventCount) ? e.eventCount : 0,
    attempts: typeof e.attempts === 'number' && Number.isFinite(e.attempts) ? e.attempts : 0,
  };
}

/** Aggregate counts for the section header (e.g. "3 delivered · 1 dropped").
 *  Null/unknown outcomes count toward neither bucket but ARE included in total. */
export interface TransmissionSummary {
  total: number;
  delivered: number;
  dropped: number;
}

/**
 * Tally the delivered/dropped/total counts for the section header. Iterates the
 * snapshot once; null outcomes (a malformed entry) count only toward `total`.
 */
export function summarizeTransmission(
  entries: ReadonlyArray<TransmissionLogEntry | null | undefined>,
): TransmissionSummary {
  let delivered = 0;
  let dropped = 0;
  for (const entry of entries) {
    const o = entry?.outcome;
    if (o === 'ok') delivered += 1;
    else if (o === 'dropped') dropped += 1;
  }
  return { total: entries.length, delivered, dropped };
}
