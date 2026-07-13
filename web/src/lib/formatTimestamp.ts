// Shared timestamp formatting for every human-facing time display in the
// dashboard. Drives the client-side "Timestamp format" preference (Relative vs
// Absolute) and consolidates the per-component `ago()` copies that existed
// before (ChatSidebar, HealthDashboard). Pure: no React/DOM, no localStorage.
//
// This is a PURE CLIENT-SIDE localStorage pref (see storage.ts UiState). It is
// persisted by App's saveUi effect and must NEVER be added to the `config`
// state / PUT /api/config body.

/** How timestamps render across the dashboard. Pure client-side pref. */
export type TimestampFormat = 'relative' | 'absolute';

/**
 * Compact relative bucket ("2s"/"2m"/"3h"/"1d") for a millisecond-epoch
 * timestamp, mirroring the per-component `ago()` helpers this consolidates.
 * Returns the BARE bucket — " ago" is opt-in via `formatTimestamp`'s
 * `{ withSuffix: true }`, and only ever attaches in relative mode, so an
 * absolute time can never render as "2:13 PM ago".
 */
export function formatRelative(ms: number): string {
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

/**
 * Absolute clock time for a millisecond-epoch timestamp: time only (HH:MM) when
 * the timestamp is today, otherwise the date plus time — so older events stay
 * unambiguous in the sidebar width without a noisy full timestamp on every row.
 */
export function formatAbsolute(ms: number): string {
  const date = new Date(ms);
  const now = new Date();
  const isToday = date.toDateString() === now.toDateString();
  const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (isToday) return time;
  return `${date.toLocaleDateString()} ${time}`;
}

/**
 * Full-precision absolute timestamp (date + time WITH seconds) for hover
 * tooltips. A tooltip's whole purpose is exact, unambiguous time — more precise
 * than the always-visible row, which honors the pref. It is therefore
 * mode-independent: never relative, never truncated. Mirrors the pre-pref
 * `new Date(ms).toLocaleString()` the chat-row hover used before consolidation.
 */
export function formatAbsoluteFull(value: number | string | Date): string {
  return new Date(value).toLocaleString();
}

/** Options for {@link formatTimestamp}. */
export interface FormatTimestampOptions {
  /**
   * Append " ago" — ONLY in relative mode. A relative bucket like "2m" reads as
   * "2m ago"; an absolute time like "2:13 PM" must never take the suffix, so the
   * grammar stays correct whichever mode the user picks.
   */
  withSuffix?: boolean;
}

/**
 * Format a timestamp per the user's TimestampFormat preference. Accepts an epoch
 * number, an ISO string, or a Date so every call site (sidebar ms epochs, ISO
 * activity events, health timestamps) routes through one shared helper.
 */
export function formatTimestamp(
  value: number | string | Date,
  mode: TimestampFormat,
  options?: FormatTimestampOptions,
): string {
  const ms = new Date(value).getTime();
  const formatted = mode === 'absolute' ? formatAbsolute(ms) : formatRelative(ms);
  return options?.withSuffix && mode === 'relative' ? `${formatted} ago` : formatted;
}
