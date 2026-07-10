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
  // Each entry is [maxSeconds, unit, unitSizeSeconds]: pick the first unit whose
  // threshold covers |sec|, then divide by THAT unit's own magnitude. Using the
  // unit's own size — not the previous threshold — is what keeps month/year
  // correct: the day threshold (604800) is a *week*, not a month (2629800), so
  // the old "divisor = previous threshold" trick over-counted month ~4.3x and
  // year ~12x (a 2020 commit rendered "78 years ago" instead of "7 years ago").
  const steps: Array<[number, 'second' | 'minute' | 'hour' | 'day' | 'month' | 'year', number]> = [
    [60, 'second', 1],
    [3600, 'minute', 60],
    [86400, 'hour', 3600],
    [604800, 'day', 86400],
    [2629800, 'month', 2629800],
    [Infinity, 'year', 31557600],
  ];
  const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  for (const [max, unit, size] of steps) {
    if (Math.abs(sec) < max) return rtf.format(Math.round(sec / size), unit);
  }
  return rtf.format(Math.round(sec / 31557600), 'year');
}
