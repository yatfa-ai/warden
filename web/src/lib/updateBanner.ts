import type { UpdateState } from '@/lib/electron';

// WARDEN-1887 — the PURE decision of what the non-blocking update affordance
// shows for a given update state. null = show nothing (the overwhelmingly common
// case: idle / checking / up-to-date / disabled / a quiet error). Errors are
// deliberately invisible here — a failed check is logged in main and retried on
// schedule; it must never become UI noise. A manual check from the menu is the
// place that reports honestly, including failures.
export interface UpdateBannerView {
  kind: 'ready' | 'downloading' | 'available';
  text: string;
  // The one action, when there is one: 'install' restarts into the downloaded
  // update; 'download' opens the release download (the unsigned-macOS path).
  action: 'install' | 'download' | null;
  actionLabel: string | null;
}

export function updateBannerView(state: UpdateState | null | undefined): UpdateBannerView | null {
  if (!state) return null;
  switch (state.status) {
    case 'ready':
      return {
        kind: 'ready',
        text: `Update ${state.version ?? ''} ready — restart to apply`.replace('  ', ' '),
        action: 'install',
        actionLabel: 'Restart',
      };
    case 'downloading':
      return {
        kind: 'downloading',
        text: `Downloading update ${state.version ?? ''}${state.percent != null ? ` (${state.percent}%)` : ''}…`.replace('  ', ' '),
        action: null,
        actionLabel: null,
      };
    case 'available':
      return {
        kind: 'available',
        text: `Version ${state.version ?? ''} is available`.replace('  ', ' '),
        action: state.downloadUrl ? 'download' : null,
        actionLabel: state.downloadUrl ? 'Download' : null,
      };
    default:
      return null;
  }
}
