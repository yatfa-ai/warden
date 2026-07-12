// Opt-in OS desktop notification that fires when agents need attention AND the
// human is away from Warden (WARDEN-259). Consumes the always-on attention rollup
// from attentionRollup.ts (WARDEN-228) as its trigger.
//
// This module is the delivery CHANNEL, not the signal: the rollup already exists
// and is polled by useAttentionRollup. Here we (a) decide WHEN to fire (pure, so
// it is unit-tested directly), (b) format WHAT to show (pure, likewise testable),
// and (c) talk to the browser via the renderer-side Web Notifications API — which
// needs no IPC and works in both the Electron shell and a plain browser host.
//
// The pure helpers (shouldFireAlert, formatAlertMessage) are the only ones the
// unit test exercises; requestAlertPermission / fireAttentionNotification touch
// browser globals (no Notification API in the Node test runner) and are kept
// defensive so they can never throw inside the 10s poll.
//
// `import type` is fully erased at transpile time, so the emitted module has no
// runtime imports — the unit test can import it standalone (mirrors
// attentionRollup.ts's testability discipline).
import type { AttentionRollup } from '@/lib/attentionRollup';

// Whether the Web Notifications API exists at all. Some embedded webviews lack
// `Notification` entirely; everywhere else it is a global. Guarded (not
// feature-detected once and cached) so a polyfill/lazy global still works.
function notificationsSupported(): boolean {
  return typeof window !== 'undefined' && typeof Notification !== 'undefined';
}

/**
 * Request OS permission to show desktop notifications. Graceful no-op (returns
 * `false`) where the API is unsupported or the human previously denied; returns
 * `true` if already granted. Never throws — call it fire-and-forget from the
 * Settings toggle. Only a granted/denied outcome is terminal; 'default' prompts.
 */
export async function requestAlertPermission(): Promise<boolean> {
  if (!notificationsSupported()) return false;
  if (Notification.permission === 'granted') return true;
  if (Notification.permission === 'denied') return false;
  try {
    const result = await Notification.requestPermission();
    return result === 'granted';
  } catch {
    return false;
  }
}

/**
 * Pure: should a desktop alert fire for this rollup transition? Returns `true`
 * ONLY on a genuine total increase (a new critical/warning agent, or a new
 * directive/error entering the recent window) — never on a decrease (recovery)
 * or no-change (so a persistent condition never spams). Either input missing
 * (e.g. the very first poll) does not fire: the "While you were away" banner
 * already covers the startup case. Pure so it is unit-tested directly.
 */
export function shouldFireAlert(
  prev: AttentionRollup | null,
  next: AttentionRollup | null,
): boolean {
  if (!prev || !next) return false;
  return next.total > prev.total;
}

/**
 * Pure: build the notification title + body from the rollup buckets. Kept pure
 * (separate from the browser-touching `new Notification` call) so the wording is
 * unit-tested directly. "items" (not "agents") because the total includes
 * directives + errors, not just agents — matches the in-app AttentionBadge's own
 * "N items need attention" wording. The body lists only the non-zero buckets.
 */
export function formatAlertMessage(rollup: AttentionRollup): { title: string; body: string } {
  const { critical, warning, directives, errors, total } = rollup;
  const plural = (n: number, noun: string) => `${n} ${noun}${n !== 1 ? 's' : ''}`;
  const parts: string[] = [];
  // critical/warning read as labels (no plural-s); directive/error pluralize.
  if (critical.length > 0) parts.push(`${critical.length} critical`);
  if (warning.length > 0) parts.push(`${warning.length} warning`);
  if (directives > 0) parts.push(plural(directives, 'directive'));
  if (errors > 0) parts.push(plural(errors, 'error'));
  const title = `Warden: ${total} ${total === 1 ? 'item needs' : 'items need'} attention`;
  const body = parts.length > 0 ? parts.join(' · ') : title;
  return { title, body };
}

/**
 * Show the attention desktop notification. No-op where the API is unsupported or
 * permission is not granted (e.g. the human opted in but the OS prompt is still
 * pending/denied). Uses a stable `tag` so a rapid sequence of increases replaces
 * the prior notification instead of stacking (a guardrail against notification
 * spam on a fast-moving incident). Clicking focuses/raises the Warden window.
 * Never throws — some embedded webviews reject `new Notification`.
 */
export function fireAttentionNotification(rollup: AttentionRollup): void {
  if (!notificationsSupported()) return;
  if (Notification.permission !== 'granted') return;
  try {
    const { title, body } = formatAlertMessage(rollup);
    const n = new Notification(title, { body, tag: 'warden-attention' });
    n.onclick = () => {
      window.focus();
      n.close();
    };
  } catch {
    // A construction failure (e.g. a restrictive webview) must never crash the
    // 10s poll; the badge still covers the in-app case.
  }
}
