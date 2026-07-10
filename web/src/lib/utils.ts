import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/** Format an ISO 8601 timestamp as a short relative string ("2 days ago", "just now").
 *  Used by FileViewer's annotate view (WARDEN-206) to render blame author-dates
 *  relative to now. The backend returns author-time as ISO (a pure function of the
 *  epoch, so the parser is deterministic); relative formatting is a DISPLAY concern,
 *  so it lives client-side and stays fresh without re-blaming. Returns '' for
 *  missing/invalid input. */
export function timeAgo(iso: string): string {
  if (!iso) return '';
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  const sec = Math.round((ms - Date.now()) / 1000);
  // Ordered thresholds; the running `divisor` is the previous threshold (the unit's
  // size in seconds), so each branch divides sec into the right magnitude.
  const steps: Array<[number, 'second' | 'minute' | 'hour' | 'day' | 'month' | 'year']> = [
    [60, 'second'],
    [3600, 'minute'],
    [86400, 'hour'],
    [604800, 'day'],
    [2629800, 'month'],
    [Infinity, 'year'],
  ];
  const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  let divisor = 1;
  for (const [max, unit] of steps) {
    if (Math.abs(sec) < max) return rtf.format(Math.round(sec / divisor), unit);
    divisor = max;
  }
  return rtf.format(Math.round(sec / divisor), 'year');
}
