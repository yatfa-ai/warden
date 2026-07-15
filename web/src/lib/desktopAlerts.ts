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
 * the watch is opt-in per chat and has no always-on in-app surface, so suppressing
 * while Warden is visible would lose the signal entirely. The near-zero-false-signal
 * bar is met by the transition detector (fires once on entering a needs-you state,
 * never on persistent state), not by a visibility filter.
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

// --- In-app attention ping (WARDEN-402) --------------------------------------
//
// The crafted, themed IN-APP complement to fireAttentionNotification above. Where
// the OS toast says only "N items need attention" (lumped, count-based) AND is
// hard-gated to fire ONLY while Warden is unfocused, this fills the at-Warden gap:
// while the human IS looking at Warden, a watched chat / agent that NEWLY needs
// them gets a crafted sonner toast — themed (WARDEN-68), transient (auto-dismiss),
// reason-SPECIFIC, and one-click deep-linkable to the pane — instead of only the
// header badge count silently ticking up.
//
// shouldFireAlert (above) decides WHETHER to ping by comparing only totals, so it
// cannot say WHICH agent/bucket is newly needy. diffNewAttention fills that gap for
// the in-app path: it diffs the six per-agent array buckets by identity and returns
// the entrants present in `next` but not `prev`, each carrying its name + concrete
// reason (+ signal for pane states). The aggregate count buckets (directives/errors)
// have no per-agent identity, so a genuine increase there surfaces as a single
// labeled summary entry with no deep-link.
//
// As with the fleet + watch channels above, the PURE pieces (diffNewAttention,
// formatInAppEntry) live here — import-free, unit-tested directly — while the
// sonner `toast(...)` delivery (which imports the runtime 'sonner' module) lives in
// useAttentionRollup.ts alongside the visibility branch that calls it. Mirrors the
// "pure decision/format here, browser delivery in the hook" discipline this file
// already follows for fireAttentionNotification.

/**
 * A single newly-needy item the in-app toast surfaces (WARDEN-402). Where the OS
 * aggregate toast says only "N items need attention", this carries the SPECIFIC
 * entrant — its name, the concrete reason (bucket label, plus the signal for pane
 * states), the deep-link key, and a severity tone — so the at-Warden ping is
 * crafted and reason-specific, not lumped.
 *
 * `key` is '' for the aggregate directives/errors summary entries (no per-agent
 * identity → no deep-link); the formatter renders those as a bare-reason title.
 */
export interface NewAttentionEntry {
  /** Deep-link key (a.key || a.id) for named agents; '' for aggregate count entries. */
  key: string;
  /** Display name for named agents (a.name || key); '' for aggregate entries. */
  name: string;
  /** Human-readable reason — the bucket label, e.g. "Stuck (repeating output)". */
  reason: string;
  /** The triggering signal line (pane states only); omitted when the row has none. */
  signal?: string;
  /** Severity tone for the toast: red (broken) vs amber (warning/waiting). */
  tone: 'critical' | 'warning';
}

// Reason labels per bucket (WARDEN-402). Phrased to match the in-app badge's own
// section language + the watch ping's wording so the product speaks with one voice:
// the pane-state reasons read as the action the human must take; the health reasons
// read as the bucket label (a Chat has no `signal` field, so the label IS the reason).
const INAPP_REASON: Record<'critical' | 'warning' | 'stuck' | 'erroring' | 'waiting' | 'blocked', string> = {
  critical: 'Critical — no recent activity',
  warning: 'Warning — slowing down',
  stuck: 'Stuck (repeating output)',
  erroring: 'Erroring',
  waiting: 'Waiting for your input',
  blocked: 'Blocked on a dependency',
};

// Minimal structural shape diffNewAttention reads off either a health Chat or a
// pane-state AgentStateRow. Both satisfy it (a Chat simply omits the optional
// `signal`), so one helper handles all six array buckets uniformly.
type NamedAttentionItem = { id?: string; key?: string; name?: string; signal?: string | null };

/**
 * Pure: the NEWLY-needy items present in `next` but absent from `prev` (WARDEN-402).
 *
 * shouldFireAlert decides WHETHER to ping by comparing only totals, so it cannot
 * say WHICH agent/bucket is newly needy. This diffs the six per-agent array buckets
 * (critical/warning/stuck/erroring/waiting/blocked) by identity key and returns
 * only the entrants present in `next` but not `prev`, each carrying its name +
 * concrete reason (+ signal for pane states) + deep-link key + severity tone.
 *
 *  - Identity is the SAME `a.key || a.id` the badge rows + alertAgentKey use, so an
 *    agent MOVING bucket (e.g. waiting → erroring) is NOT a new entrant (same key
 *    in both) and does not surface — only a genuinely NEW key does.
 *  - Net-zero churn (one agent recovers while another newly errors) surfaces ONLY
 *    the newly-needy key, never the recovering one (its key is absent from `next`).
 *  - One entry PER KEY: an agent that newly enters two buckets at once (e.g.
 *    critical-health AND erroring) surfaces once, in severity order — one ping per
 *    agent, never two toasts for one chat (the noise the roadmap rejects). The
 *    badge remains the exhaustive list; this is the transient ping.
 *  - The aggregate count buckets (directives/errors) carry no per-agent identity,
 *    so a genuine increase there surfaces as a single labeled summary entry
 *    (`key: ''`, no deep-link) — the Activity tab is its resolution path. Their
 *    delta is clamped at 0 so a DECREASE (recovery) never produces a phantom entry.
 *  - Entries are returned in severity order (red buckets first, then amber),
 *    mirroring the badge's own section order, so a burst reads most-urgent-first.
 *
 * Operates on the ROUTABLE sub-rollup (severity prefs + per-agent mute applied) the
 * alert effect passes in, so a muted agent — filtered out of both prev and next —
 * never surfaces here, matching the OS-toast channel. Pure + dependency-free (reads
 * only the rollup shape) so it is unit-tested directly alongside shouldFireAlert.
 */
export function diffNewAttention(
  prev: AttentionRollup | null,
  next: AttentionRollup | null,
): NewAttentionEntry[] {
  if (!prev || !next) return [];
  // Every key present in ANY of prev's six array buckets is "already known" → not new.
  const prevKeys = new Set<string>();
  for (const a of prev.critical) prevKeys.add(alertAgentKey(a));
  for (const a of prev.warning) prevKeys.add(alertAgentKey(a));
  for (const a of prev.stuck) prevKeys.add(alertAgentKey(a));
  for (const a of prev.erroring) prevKeys.add(alertAgentKey(a));
  for (const a of prev.waiting) prevKeys.add(alertAgentKey(a));
  for (const a of prev.blocked) prevKeys.add(alertAgentKey(a));

  const entries: NewAttentionEntry[] = [];
  const seen = new Set<string>(); // one entry per key: a key newly in two buckets surfaces once
  const addNamed = (a: NamedAttentionItem, reason: string, tone: 'critical' | 'warning'): void => {
    const key = alertAgentKey(a);
    // A blank key (neither key nor id) can't be deep-linked and can't be tracked
    // across polls, so it can never be a meaningful "new" entrant — skip it rather
    // than surface an un-actionable row.
    if (!key) return;
    if (prevKeys.has(key) || seen.has(key)) return;
    seen.add(key);
    entries.push({ key, name: a.name || key, reason, signal: a.signal || undefined, tone });
  };

  // Red tone first (critical health, then stuck/erroring pane states) — badge order.
  for (const a of next.critical) addNamed(a, INAPP_REASON.critical, 'critical');
  for (const a of next.stuck) addNamed(a, INAPP_REASON.stuck, 'critical');
  for (const a of next.erroring) addNamed(a, INAPP_REASON.erroring, 'critical');
  // Amber tone (warning health, then waiting/blocked pane states).
  for (const a of next.warning) addNamed(a, INAPP_REASON.warning, 'warning');
  for (const a of next.waiting) addNamed(a, INAPP_REASON.waiting, 'warning');
  for (const a of next.blocked) addNamed(a, INAPP_REASON.blocked, 'warning');

  // Aggregate count deltas: no per-agent identity → a labeled summary entry, no
  // deep-link. Clamped at 0 so a recovery (count down) never invents an entry; the
  // increase-only shouldFireAlert gate already guaranteed a net rise somewhere, but
  // this stays correct standalone if ever called outside that gate.
  const newDirectives = Math.max(0, (next.directives ?? 0) - (prev.directives ?? 0));
  const newErrors = Math.max(0, (next.errors ?? 0) - (prev.errors ?? 0));
  if (newDirectives > 0) {
    entries.push({ key: '', name: '', reason: `${newDirectives} pending directive${newDirectives !== 1 ? 's' : ''}`, tone: 'warning' });
  }
  if (newErrors > 0) {
    entries.push({ key: '', name: '', reason: `${newErrors} recent error${newErrors !== 1 ? 's' : ''}`, tone: 'critical' });
  }
  return entries;
}

/**
 * Pure: format a diffed entrant into the sonner toast's title + description
 * (WARDEN-402). Sibling of formatAlertMessage / formatWatchMessage for the in-app
 * channel: kept pure (separate from the `toast(...)` call) so the wording is
 * unit-tested directly.
 *
 * A NAMED entrant leads with its name as the title (which agent) and carries the
 * concrete reason — plus, when the row has a `signal`, quotes it verbatim — as the
 * description (why it needs you). An AGGREGATE entrant (directives/errors delta, no
 * identity) renders its reason as the title with no description.
 */
export function formatInAppEntry(entry: NewAttentionEntry): { title: string; description?: string } {
  if (!entry.name) return { title: entry.reason };
  const description = entry.signal ? `${entry.reason} — '${entry.signal}'` : entry.reason;
  return { title: entry.name, description };
}

// --- Token-spend budget alert (WARDEN-415) -----------------------------------
//
// The "while the founder is away" alarm that completes the meter WARDEN-367
// shipped. Sibling of fireAttentionNotification / fireWatchNotification: same
// Web Notifications channel + the same notificationsSupported / permission
// guards. Takes PRE-FORMATTED title + body (computed by tokenBudget.ts's
// formatBudgetMessageWith) rather than the BudgetState itself, so THIS module
// stays runtime-import-free (the `import type` discipline above) and the
// standalone desktopAlerts.test.mjs can still load it via the OXC transform.
//
// Uses a DISTINCT stable tag (`warden-budget`) so the budget alert never
// replaces — and is never replaced by — an attention/watch ping; a repeat
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
