// Workspace-names telemetry (WARDEN-1416) — the FIRST producer gated ONLY on
// the `names` consent category, and the event that closes that category's dead
// switch. Until now the category could only DECORATE events other producers
// built (chat/session names on incidents events), so a user who checked
// "Chat & session names" and nothing else consented to a flow that never
// happened. WARDEN-443 names that shape a defect outright: "A category that
// sends nothing is not consent, it is a dead switch."
//
// WHAT IT SENDS: ONE bounded `workspace-names` schema event per 5-minute
// window — the chat catalog's sidebar-rendered names (chatCatalog.snapshot()'s
// `.name`), de-duplicated, capped at NAMES_MAX, with `chatCount` (the TRUE
// catalog size) and `truncated` making the cap loud. An empty catalog sends
// nothing at all (hasAnything). No pane/workspace-shape counts, no session
// sweep, no content: the raw `summary` field of a Claude session is
// content-derived and stays out of telemetry entirely; the catalog's `.name`
// is where the product already folds a resumed session's summary into its
// sidebar-visible name, so this one leg covers BOTH identifiers the design
// permits (chat names + resumed-session names) with zero new SSH and zero new
// polls — the snapshot is already in server memory.
//
// WHAT IT MAY NEVER CARRY (WARDEN-443 hard exclusions): file paths, hostnames,
// chat content, credentials. The snapshot builder keeps ONLY the `.name`
// strings — every other catalog field (cwd, host, session id, cmd, status,
// timestamps) is dropped at the boundary, so nothing else on the catalog row
// can reach the event. The name strings are then scrubbed by the pipeline's
// redactor exactly like any retained string, so a name that happens to be
// path/host-shaped is redacted before the wire.
//
// CONSENT: recording here is per-category LIVE on `names` alone (never folded
// into metrics — identifying data stays behind its own conscious opt-in).
// When the category is off (the default), the window is DISCARDED at flush
// (nothing out-of-consent is even retained in memory). The snapshot is
// forwarded to the Electron main process over the fork's IPC channel (main
// re-checks consent at receipt, then builds the schema event and records it
// through the standard pipeline); when the server runs standalone (no
// process.send), the flush is a no-op and the module is inert on the wire.
//
// The consent gate, the IPC forward, the flushNow control flow and the unref'd
// start() are the shared scaffold in src/telemetryProducer.js (WARDEN-1352).
// This module contributes only the names-specific parts: the snapshot builder
// (read-only over the live catalog), the cap constants, and hasAnything.

import { createConsentGatedWindow } from './telemetryProducer.js';

// Default flush cadence — the SAME 5-minute window every other producer on
// this channel uses, so all of them close on one rhythm.
export const NAMES_FLUSH_MS = 5 * 60_000;

// The list cap. 200 names is generous headroom above a real one-person
// workspace (the design article's own example of a defect signal is
// "twenty-five chats") while keeping the worst-case event small; the schema
// validator's own footprint bound (400) sits above this so a future cap raise
// never needs a schema bump.
export const NAMES_MAX = 200;

/**
 * Project the live chat catalog onto the bounded name list.
 *
 * READ-ONLY over the snapshot: the only thing taken from each row is `.name`
 * (non-empty strings, de-duplicated in first-seen order). Every other field —
 * cwd, host, session id, cmd, status, timestamps — is dropped HERE, at the
 * collection boundary, so the snapshot can never grow a carrier for one.
 * `chatCount` is the TRUE number of named chats (before the cap) and
 * `truncated` says whether the cap bit — a capped list is loud, never silent.
 *
 * @param {Array<{name?: unknown}>} chats the catalog rows (chatCatalog.snapshot())
 * @param {number} [max] the list cap (tests inject a small one)
 * @returns {{ chats: string[], chatCount: number, truncated: boolean }}
 */
export function buildNamesSnapshot(chats, max = NAMES_MAX) {
  const list = Array.isArray(chats) ? chats : [];
  const names = [];
  const seen = new Set();
  let named = 0;
  for (const chat of list) {
    const name = chat && typeof chat === 'object' ? chat.name : undefined;
    if (typeof name !== 'string' || name.length === 0) continue;
    named += 1;
    if (seen.has(name)) continue;
    seen.add(name);
    if (names.length < max) names.push(name);
  }
  return {
    chats: names,
    chatCount: named,
    truncated: named > names.length,
  };
}

/**
 * Build the workspace-names producer.
 *
 * All collaborators are injectable so the unit tests run with a togglable
 * consent, a captured `send`, a fake clock, and a fake catalog — no timers, no
 * IPC, no real waiting.
 *
 * @param {object} opts
 * @param {() => boolean} [opts.consent] live resolver: is the `names` category
 *   enabled? Only an exact `=== true` enables (the shared scaffold's
 *   fail-closed posture).
 * @param {() => Array<{name?: unknown}>} [opts.catalog] the live catalog
 *   reader. server.js passes `() => chatCatalog.snapshot()`; tests inject a
 *   fixture. A missing/non-function reader degrades to an empty snapshot.
 * @param {(snapshot: { chats: string[], chatCount: number, truncated: boolean }) => void} [opts.send]
 *   the IPC forward (server.js wires process.send).
 * @param {number} [opts.intervalMs] flush cadence (default NAMES_FLUSH_MS).
 * @param {typeof setInterval} [opts.setIntervalImpl] injectable timer.
 * @returns {{ flushNow: () => object|null, start: () => * }}
 */
export function createWorkspaceNamesTelemetry({
  consent,
  catalog,
  send,
  intervalMs = NAMES_FLUSH_MS,
  setIntervalImpl = setInterval,
  now = () => Date.now(),
} = {}) {
  // The aggregator shape the shared scaffold wants: flush() closes the window
  // and returns its snapshot. For this producer the "window" IS the live
  // catalog read — a chat catalog is already a bounded in-memory set, not an
  // accumulating stream, so there is nothing to fold and nothing to drop at
  // consent-off except the read itself (which happens below, inside flush).
  // The window stamps describe the CADENCE interval the snapshot covers:
  // [previous flush, this flush] — the first window opens one interval back so
  // an event never claims a zero-length or future window.
  let lastFlushAt = null;
  const aggregator = {
    flush: () => {
      const read = typeof catalog === 'function' ? catalog : () => [];
      const endedAt = now();
      const startedAt = lastFlushAt === null ? endedAt - intervalMs : lastFlushAt;
      lastFlushAt = endedAt;
      return { startedAt, endedAt, ...buildNamesSnapshot(read()) };
    },
  };
  // A window is worth sending when the catalog has at least one named chat.
  // An empty workspace ships nothing — the majority case for a quiet session,
  // and the same "idle window is not sent" posture every producer here takes.
  const gated = createConsentGatedWindow({
    consent,
    send,
    intervalMs,
    setIntervalImpl,
    aggregator,
    hasAnything: (snapshot) => snapshot.chatCount > 0,
  });
  return { flushNow: gated.flushNow, start: gated.start };
}
