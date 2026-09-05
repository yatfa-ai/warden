// OS desktop notification delivery for the TWO alert channels that rest on an
// observed fact rather than an inference: the user-authored WATCH ping (a literal
// the human themselves taught Warden to look for, matched in captured text) and
// the token-BUDGET breach (a counted number crossing a threshold the human set).
//
// This module is the delivery CHANNEL, not the signal. Here we (a) decide WHEN to
// fire (pure, so it is unit-tested directly), (b) format WHAT to show (pure,
// likewise testable), and (c) talk to the browser via the renderer-side Web
// Notifications API — which needs no IPC and works in both the Electron shell and
// a plain browser host.
//
// WARDEN-1274 — WHAT THIS FILE NO LONGER DOES, and why it must not come back. It
// also used to own the fleet ATTENTION alert: shouldFireAlert / diffNewAttention /
// applySeverityPrefs / fireAttentionNotification, fired off the fixed nine-regex
// pane classifier in src/agentState.js. That classifier GUESSES — `SUMM_ERROR_RE`
// matches the substring "error", so "✓ 42 tests passed, 0 errors" raised an alert
// while a real `npm ERR! code ELIFECYCLE` did not. An interruption channel built on
// a guess trains the human to ignore it, so the whole channel is retired rather
// than re-tuned. The per-agent mute/snooze silencers went with it (they existed
// only to quiet it). Do NOT re-add a rollup-diff alert here: the passive badge
// readout is the surviving surface for that signal, and it interrupts nobody.
//
// The pure helpers are the ones the unit test exercises; requestAlertPermission /
// fireWatchNotification / fireBudgetNotification touch browser globals (no
// Notification API in the Node test runner) and are kept defensive so they can
// never throw inside a poll.
//
// This module has NO runtime imports — everything below is `import type`, fully
// erased at transpile time — so web/desktopAlerts.test.mjs can transpile and load
// it standalone. (It briefly had one, `finalizeRollup`, used solely by
// applySeverityPrefs; that went with the alert chain.) Keep it that way: a value
// import here breaks the standalone loader.
import type { AgentStateRow } from '@/lib/types';
import type { WatchReason } from '@/lib/chatWatch';

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

// --- Per-chat "watch" ping (WARDEN-378) -------------------------------------
//
// The targeted, reason-specific ping for a chat the human explicitly opted to WATCH:
// it fires ONCE per watched chat that newly needs the human and NAMES the agent +
// quotes the concrete triggering signal. The transition detection (which chat, which
// reason, fire-once) lives in chatWatch.ts (pure, unit-tested); this module is only
// the formatting + browser delivery channel.
//
// WARDEN-1274 — why this survived the alert retirement while the fleet channel did
// not: a watch pattern is a literal the USER authored, matched against text Warden
// actually captured. Finding it is an observed fact. The retired fleet alert inferred
// a state from a fixed regex ladder nobody asked for, which is a guess.
//
// `import type { WatchReason }` is erased at transpile, so it adds nothing to this
// module's runtime imports — which are now zero (see the file header).

// Reason → human phrasing for the watch body. Conveys the concrete "why" so the
// human knows what kind of attention the chat needs, not just that it needs some.
// `blocked` (WARDEN-514) is never produced by the transition ping (diffWatchAlerts
// doesn't fire on blocked), but the persistent CURRENT-state row indicator
// (currentWatchNeed) DOES surface blocked, so its label lives in the SAME vocabulary
// the ping uses — the row tooltip and the OS toast phrase a blocked chat identically.
const WATCH_REASON_LABEL: Record<WatchReason, string> = {
  waiting: 'waiting for your input',
  erroring: 'erroring',
  stuck: 'stuck (repeating output)',
  completed: 'finished a task',
  blocked: 'blocked — waiting on a dependency',
  custom: 'matched a watch pattern',
};

/**
 * Pure: should the per-chat watch ping fire, given which pane the human is
 * currently focused on AND whether Warden is visible? (WARDEN-426.) Suppresses
 * the ping for the ONE pane the human is already reading — they can see it (a
 * focused pane is, by definition, open, so it already appears in the OPEN-only
 * AttentionBadge with its "because X" signal). Removing that single redundant
 * ping is the PRECISE per-pane-focus gate that `fireWatchNotification`'s
 * "deliberately NOT gated on document visibility" comment pointed at: the coarse
 * window-visibility filter was rejected because it would lose signal while away;
 * this gate loses no signal because it only suppresses when the human is BOTH
 * focused on the pane AND present to see the in-app badge.
 *
 * CRITICAL — focus is STICKY, not a presence signal. `focused` is React workspace
 * state set on pane open/click and NEVER cleared when Warden is hidden (the
 * visibilitychange handler only refreshes the catalog). A human who focused a
 * watched pane and then stepped away still has `focused === paneKey` while Warden
 * is hidden and the watch poll keeps ticking. So the gate MUST consult
 * `visibilityState`: when Warden is `hidden` the human is AWAY and the ping
 * ALWAYS fires regardless of focus — that is the watch feature's whole purpose
 * (watch this chat, step away, get pinged), and away the in-app badge is not
 * visible to carry the signal. Suppressing on `focused === paneKey` ALONE would
 * turn a false-positive suppression into a false-NEGATIVE (a missed ping) in
 * precisely the watch feature's primary scenario.
 *
 * Fires unchanged when the human is away (`visibilityState === 'hidden'`),
 * focused elsewhere, on a DIFFERENT pane, or has no focus context
 * (`focusedPaneKey == null` — the loose check covers both `null` and the
 * `undefined` an un-passed optional param yields) — those are exactly the cases
 * where the ping is the only signal. Identity is the SAME `row.key ?? row.id`
 * space the watch subsystem keys on (`indexByWatchKey`) and the ping deep-links
 * to, so the comparison is apples-to-apples. Pure + dependency-free so it is
 * unit-tested directly. `visibilityState` is the live
 * `document.visibilityState` the caller passes in (kept out of the module so the
 * helper stays pure + dependency-free).
 */
export function shouldFireWatch(
  focusedPaneKey: string | null | undefined,
  row: AgentStateRow,
  visibilityState: string,
): boolean {
  // Away → always fire. The watch ping exists to REACH the human when Warden is
  // hidden; the sticky `focused` key is not a presence signal, so it cannot be
  // allowed to suppress a ping the human will otherwise never see.
  if (visibilityState === 'hidden') return true;
  if (focusedPaneKey == null) return true;
  const paneKey = row.key ?? row.id;
  return paneKey !== focusedPaneKey;
}

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
  // WARDEN-540: a custom-pattern ping names the pattern + quotes the matching line
  // (row.signal is the classifyPane signal, NOT the match — the match lives in
  // row.customMatch). The title carries the generic label; the body conveys the
  // specific pattern name + line so the human knows exactly what tripped.
  if (reason === 'custom' && row.customMatch) {
    const body = `${name} · matched pattern '${row.customMatch.pattern}' — '${row.customMatch.line}'`;
    return { title, body };
  }
  const body = `${name} · ${label}${row.signal ? ` — '${row.signal}'` : ''}`;
  return { title, body };
}

/**
 * Pure: the reason line for a watched chat's CURRENT needs-you state — the
 * WATCH_REASON_LABEL phrasing plus, when the row carries a signal, the signal quoted
 * verbatim (e.g. "waiting for your input — 'press enter to continue'"). (WARDEN-514.)
 *
 * Sibling of formatWatchMessage's body, MINUS the agent name: the row already shows the
 * chat's name, so the row indicator's tooltip needs only the reason + signal. The row
 * indicator (ChatRow/OpenPaneRow) calls this with the currentWatchNeed reason + the
 * AgentStateRow's signal, so the in-row wording uses the SAME vocabulary the watch ping
 * does — the product speaks with one voice across the transient OS toast and the
 * persistent row indicator. Pure + dependency-free so it is unit-tested directly
 * alongside formatWatchMessage.
 */
export function watchStateLabel(reason: WatchReason, signal?: string | null): string {
  const label = WATCH_REASON_LABEL[reason] || reason;
  return signal ? `${label} — '${signal}'` : label;
}

/**
 * Pure: the severity TONE for a watch reason's crafted in-app toast (WARDEN-530).
 * Mirrors the badge's own red/amber severity split for the broken/slowing reasons
 * and adds a THIRD tone, success (green), for the watch-only `completed` reason —
 * a POSITIVE state ("finished a task") a red/amber split has no analog for:
 *   - erroring / stuck → 'critical'  (broken agent — red)
 *   - waiting / blocked → 'warning'  (needs your input / mild — amber)
 *   - completed        → 'success'   (positive — green)
 *
 * `blocked` (WARDEN-514) is never produced by the transition ping (diffWatchAlerts
 * doesn't fire on blocked), so the fire-loop never reaches this with `blocked` — but the
 * pure function is written to be TOTAL over WatchReason: blocked is a mild state ("waiting
 * on a dependency"), so it shares `warning` (amber) with waiting, matching the row
 * indicator's amber treatment of the milder waiting/blocked pair.
 *
 * `completed` is consciously mapped to success rather than forced into red/amber: the OS
 * channel already fires it (this is parity with the existing channel, not new noise), and
 * a green "finished a task" reads as crafted signal (WARDEN-68), not an alarm. Extracted
 * PURE + dependency-free so the reason→tone mapping — incl. the completed→success call —
 * is unit-tested directly (same discipline as formatWatchMessage). Returns 'critical'
 * (not 'error') so the badge's severity vocabulary is shared; the delivery side maps
 * 'critical' → sonner's `error` variant (see fireWatchInApp).
 */
export function watchReasonTone(reason: WatchReason): 'critical' | 'warning' | 'success' {
  if (reason === 'completed') return 'success';
  if (reason === 'waiting' || reason === 'blocked') return 'warning';
  return 'critical'; // erroring + stuck — broken agent
}

/**
 * Pure: format a watched-chat alert into the crafted in-app sonner toast's title +
 * description (WARDEN-530). The agent's NAME leads as the title (WHICH chat needs you)
 * and the reason — quoting the triggering signal verbatim when present — is the
 * description (WHY), so the at-Warden ping is crafted and reason-specific rather than
 * a lumped count. Pure so
 * the wording is unit-tested directly (mirrors formatWatchMessage's testability); the
 * sonner `toast(...)` delivery itself lives in useAttentionRollup.ts.
 */
export function formatWatchInApp(row: AgentStateRow, reason: WatchReason): { title: string; description?: string } {
  const name = row.name || row.key || row.id;
  const label = WATCH_REASON_LABEL[reason] || reason;
  const description = row.signal ? `${label} — '${row.signal}'` : label;
  return { title: name, description };
}

/**
 * Show the per-chat watch desktop notification (WARDEN-378). Sibling of
 * fireBudgetNotification: same Web Notifications channel + the same
 * `notificationsSupported` / permission guards. Uses a DISTINCT `tag` per chat key
 * (`warden-watch:<key>`) so two watched chats never replace each other's ping, while
 * a repeat transition on the SAME chat replaces its prior ping (no stacking).
 *
 * Clicking deep-links to + focuses the watched pane via the open-chat-by-key
 * callback (reuses App's openChat), so a click lands the human straight on the chat
 * that needs them. Never throws — some embedded webviews reject `new Notification`.
 *
 * Deliberately NOT gated on document visibility ITSELF: the watch is opt-in per
 * chat, so suppressing while Warden is visible would lose the
 * signal entirely. The near-zero-false-signal bar is met by the transition detector
 * (fires once on entering a needs-you state, never on persistent state), not by a
 * visibility filter. WARDEN-530 adds the crafted in-app sibling fireWatchInApp for the
 * AT-WARDEN (visible) case, and the caller now BRANCHES on visibility: visible → the
 * in-app sonner ping, hidden → THIS OS toast (the away channel) + the catch-up net. So
 * this function is now the HIDDEN-branch delivery; it is still not visibility-gated
 * internally (the branch lives at the call site) so it stays the faithful away channel.
 *
 * Returns whether the OS channel DELIVERED the ping (WARDEN-417): `true` only when a
 * Notification was actually constructed (the OS accepted it); `false` on each of the
 * three silent no-op cases — `!notificationsSupported()` (embedded webview lacks
 * `Notification`), `permission !== 'granted'` (never granted / denied), and the
 * `catch` (a restrictive webview rejects `new Notification`). The caller uses this to
 * decide whether to ALSO record the ping durably for the in-app catch-up
 * (watchCatchup.shouldRecordMiss): a ping the OS channel LOST is recorded so it can be
 * recovered on return; a ping the OS delivered is recorded only when the human is away
 * (it may yet be cleared / DND'd — see shouldRecordMiss). This return contract is the
 * recoverable-vs-delivered signal that makes the catch-up a recovery net, not a second
 * channel: it can never duplicate a ping the OS definitively delivered to a present
 * human. Pure-ish (touches the Notification global) but contract-unit-tested directly
 * alongside the pure helpers via a Notification shim (desktopAlerts.test.mjs).
 */
export function fireWatchNotification(row: AgentStateRow, reason: WatchReason, onOpenChat?: (id: string) => void): boolean {
  if (!notificationsSupported()) return false;
  if (Notification.permission !== 'granted') return false;
  try {
    const { title, body } = formatWatchMessage(row, reason);
    const key = row.key || row.id;
    const n = new Notification(title, { body, tag: `warden-watch:${key}` });
    n.onclick = () => {
      if (onOpenChat) onOpenChat(key);
      window.focus();
      n.close();
    };
    return true;
  } catch {
    // A construction failure (e.g. a restrictive webview) must never crash the poll,
    // and signals the OS channel did NOT deliver → the caller records a catch-up miss.
    return false;
  }
}

// --- Token-spend budget alert (WARDEN-415) -----------------------------------
//
// The "while the founder is away" alarm that completes the meter WARDEN-367
// shipped. Sibling of fireWatchNotification: same Web Notifications channel + the
// same notificationsSupported / permission guards. Takes PRE-FORMATTED title +
// body (computed by tokenBudget.ts's formatBudgetMessageWith) rather than the
// BudgetState itself. Keep it that way: the watch formatters live HERE, this one's
// lives in tokenBudget.ts, and the strings keep that cross-module dependency out
// of the loader (see the header).
//
// WARDEN-1274 — why this survived the alert retirement: a budget breach is a
// COUNTED number crossing a threshold the human set. Nothing about it is inferred
// from pane text, so it cannot cry wolf the way the retired regex-driven fleet
// attention alert did.
//
// Uses a DISTINCT stable tag (`warden-budget`) so the budget alert never
// replaces — and is never replaced by — a watch ping; a repeat
// crossing on the SAME breach replaces its prior ping (no stacking). The
// debounce (one fire per crossing) lives in useTokenBudget, so in practice this
// fires once per breach. Clicking deep-links to the All Sessions usage view
// (via onOpenSessions) so the human lands on the offending session.
export function fireBudgetNotification(
  title: string,
  body: string,
  onOpenSessions?: () => void,
): void {
  if (!notificationsSupported()) return;
  if (Notification.permission !== 'granted') return;
  try {
    const n = new Notification(title, { body, tag: 'warden-budget' });
    n.onclick = () => {
      if (onOpenSessions) onOpenSessions();
      window.focus();
      n.close();
    };
  } catch {
    // A construction failure (e.g. a restrictive webview) must never crash the
    // budget poll; the in-app toast + progress surface still cover the case.
  }
}
