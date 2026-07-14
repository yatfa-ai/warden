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
import type { AgentStateRow } from '@/lib/types';
import type { WatchReason } from '@/lib/chatWatch';

// Per-severity routing for the desktop-alert channel (WARDEN-364). These layer ON
// TOP of the master `attentionDesktopAlerts` boolean: the master gates the whole
// channel; these route WHICH of the four legacy attention buckets are allowed to
// escalate to an OS notification. Each maps 1:1 to a rollup bucket that existed
// before WARDEN-344's pane-state expansion:
//   alertCritical  → critical-health agents
//   alertWarning   → warning-health agents
//   alertDirective → pending directives (aggregate count)
//   alertError     → recent errors (aggregate count)
// The WARDEN-344 pane-state buckets (stuck/erroring/waiting/blocked) are NOT gated
// here — they pass through `applySeverityPrefs` unchanged so they still escalate to
// the desktop channel exactly as WARDEN-344 intends; a pane state is silenced via
// WARDEN-344's own `enabledStates` toggle (rollup-build level, badge + desktop).
// Defaults all-`true` so the routing layer is behavior-preserving: master on +
// every bucket on + no mutes → alerts fire bit-for-bit as before WARDEN-364.
export interface AttentionSeverityPrefs {
  alertCritical: boolean;
  alertWarning: boolean;
  alertDirective: boolean;
  alertError: boolean;
}

export const ATTENTION_SEVERITY_DEFAULTS: AttentionSeverityPrefs = {
  alertCritical: true,
  alertWarning: true,
  alertDirective: true,
  alertError: true,
};

// The agent identity key for desktop-alert routing — the SAME `a.key || a.id` the
// AttentionBadge rows key on. Centralized so the per-agent mute set and the row
// renderer agree on identity (a stale/blank key falls back to id, matching the
// badge; an agent with neither is untouchable by mute and simply routes normally).
export function alertAgentKey(a: { key?: string; id?: string }): string {
  return a.key || a.id || '';
}

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
 * Pure: project a rollup through the desktop-alert severity prefs + per-agent
 * mute set into a ROUTABLE sub-rollup — the view the alert effect actually
 * decides on and formats (WARDEN-364).
 *
 *  - A bucket whose severity toggle is OFF is zeroed (its agents/counts survive
 *    in the raw rollup / in-app badge; only the desktop channel drops them).
 *  - A muted agent is dropped from the critical/warning HEALTH buckets only.
 *    directives/errors are aggregate windowed counts with NO per-agent identity,
 *    so per-agent mute cannot apply to them — only the severity toggle does.
 *  - `total` is recomputed over the survivors so `shouldFireAlert`'s
 *    "fire on total increase" semantics compare apples to apples on the filtered
 *    view (an increase in ONLY a disabled/muted bucket leaves the routable total
 *    unchanged → no fire).
 *
 * Pure + dependency-free (only reads the rollup shape) so it is unit-tested
 * directly alongside `shouldFireAlert` / `formatAlertMessage`. With all toggles
 * on + an empty mute set the output is content-identical to the input (same
 * lengths, same total) → behavior-preserving.
 */
export function applySeverityPrefs(
  rollup: AttentionRollup,
  prefs: AttentionSeverityPrefs,
  mutedKeys: ReadonlySet<string> = new Set(),
): AttentionRollup {
  const critical = prefs.alertCritical
    ? rollup.critical.filter((a) => !mutedKeys.has(alertAgentKey(a)))
    : [];
  const warning = prefs.alertWarning
    ? rollup.warning.filter((a) => !mutedKeys.has(alertAgentKey(a)))
    : [];
  // The WARDEN-344 pane-state buckets (stuck/erroring/waiting/blocked) pass through
  // UNCHANGED — neither muted nor gated by the four severity toggles above. Those
  // toggles map 1:1 to the legacy health/directive/error buckets this ticket routes;
  // a pane state is silenced via WARDEN-344's `enabledStates` (which drops it at the
  // rollup-build level, so it never reaches here with content). Passing them through
  // keeps the routable `total` consistent with the raw rollup under defaults, so a
  // pane-state increase still escalates to the desktop channel exactly as WARDEN-344
  // intends (behavior-preserving across the two tickets).
  const stuck = rollup.stuck;
  const erroring = rollup.erroring;
  const waiting = rollup.waiting;
  const blocked = rollup.blocked;
  const directives = prefs.alertDirective ? rollup.directives : 0;
  const errors = prefs.alertError ? rollup.errors : 0;
  const total =
    critical.length + warning.length + directives + errors +
    stuck.length + erroring.length + waiting.length + blocked.length;
  return { critical, warning, stuck, erroring, waiting, blocked, directives, errors, total };
}

/**
 * Pure: build the notification title + body from the rollup buckets. Kept pure
 * (separate from the browser-touching `new Notification` call) so the wording is
 * unit-tested directly. "items" (not "agents") because the total includes
 * directives + errors, not just agents — matches the in-app AttentionBadge's own
 * "N items need attention" wording. The body lists only the non-zero buckets.
 */
export function formatAlertMessage(rollup: AttentionRollup): { title: string; body: string } {
  const { critical, warning, stuck, erroring, waiting, blocked, directives, errors, total } = rollup;
  const plural = (n: number, noun: string) => `${n} ${noun}${n !== 1 ? 's' : ''}`;
  const parts: string[] = [];
  // Red-tone buckets first (critical + the red pane states stuck/erroring), then
  // amber (warning + the amber pane states waiting/blocked), then event counts. Each
  // label reads as a bare noun (no plural-s); directives/errors pluralize. Only the
  // non-zero buckets are listed. (WARDEN-344: stuck/erroring/waiting/blocked added.)
  if (critical.length > 0) parts.push(`${critical.length} critical`);
  if (stuck.length > 0) parts.push(`${stuck.length} stuck`);
  if (erroring.length > 0) parts.push(`${erroring.length} erroring`);
  if (warning.length > 0) parts.push(`${warning.length} warning`);
  if (waiting.length > 0) parts.push(`${waiting.length} waiting`);
  if (blocked.length > 0) parts.push(`${blocked.length} blocked`);
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

// --- Per-chat "watch" ping (WARDEN-378) -------------------------------------
//
// The targeted, reason-specific complement to the fleet-wide fireAttentionNotification
// above. Where the fleet alert says "N items need attention" (lumped, count-based),
// this fires ONCE per watched chat that newly needs the human and NAMES the agent +
// quotes the concrete triggering signal. The transition detection (which chat, which
// reason, fire-once) lives in chatWatch.ts (pure, unit-tested); this module is only
// the formatting + browser delivery channel — the same discipline as the fleet alert.
//
// `import type { WatchReason }` is erased at transpile, so this module stays
// runtime-import-free and the existing desktopAlerts.test.mjs can still load it
// standalone via the OXC transform.

// Reason → human phrasing for the watch body. Conveys the concrete "why" so the
// human knows what kind of attention the chat needs, not just that it needs some.
const WATCH_REASON_LABEL: Record<WatchReason, string> = {
  waiting: 'waiting for your input',
  erroring: 'erroring',
  stuck: 'stuck (repeating output)',
  completed: 'finished a task',
};

/**
 * Pure: build the per-chat watch notification title + body. Sibling of
 * formatAlertMessage (above) for the targeted, per-chat channel (WARDEN-378).
 *
 * The BODY names the agent and conveys the reason, and — when the row carries a
 * `signal` — quotes it verbatim (e.g. "press enter to continue"), so the human
 * knows exactly WHICH chat needs them and WHY without opening Warden. Pure so the
 * wording is unit-tested directly (mirrors formatAlertMessage's testability).
 */
export function formatWatchMessage(row: AgentStateRow, reason: WatchReason): { title: string; body: string } {
  const name = row.name || row.key || row.id;
  const label = WATCH_REASON_LABEL[reason] || reason;
  const title = `Warden: ${label}`;
  const body = `${name} · ${label}${row.signal ? ` — '${row.signal}'` : ''}`;
  return { title, body };
}

/**
 * Show the per-chat watch desktop notification (WARDEN-378). Sibling of
 * fireAttentionNotification: same Web Notifications channel + the same
 * `notificationsSupported` / permission guards. Uses a DISTINCT `tag` per chat key
 * (`warden-watch:<key>`) so two watched chats never replace each other's ping, while
 * a repeat transition on the SAME chat replaces its prior ping (no stacking).
 *
 * Clicking deep-links to + focuses the watched pane via the open-chat-by-key
 * callback (reuses App's openChat), so a click lands the human straight on the chat
 * that needs them. Never throws — some embedded webviews reject `new Notification`.
 *
 * Deliberately NOT gated on document visibility (unlike fireAttentionNotification):
 * the watch is opt-in per chat and has no always-on in-app surface in this slice, so
 * suppressing while Warden is visible would lose the signal entirely. The
 * near-zero-false-signal bar is met by the transition detector (fires once on
 * entering a needs-you state, never on persistent state), not by a visibility filter.
 */
export function fireWatchNotification(row: AgentStateRow, reason: WatchReason, onOpenChat?: (id: string) => void): void {
  if (!notificationsSupported()) return;
  if (Notification.permission !== 'granted') return;
  try {
    const { title, body } = formatWatchMessage(row, reason);
    const key = row.key || row.id;
    const n = new Notification(title, { body, tag: `warden-watch:${key}` });
    n.onclick = () => {
      if (onOpenChat) onOpenChat(key);
      window.focus();
      n.close();
    };
  } catch {
    // A construction failure must never crash the poll.
  }
}
