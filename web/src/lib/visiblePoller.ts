// visiblePoller — the pure, React-free core of the Page-Visibility poller gate
// (WARDEN-753). The idiom this captures was hand-copied across 7 effects in 5
// files (useActivitySeries, HealthDashboard, the App.tsx catalog poll,
// useAttentionRollup x3, TelemetryTransmissionLog) and was forgotten 3x
// (WARDEN-609 / WARDEN-661 / WARDEN-668) precisely because there was no shared
// abstraction and no regression spec. This module IS that abstraction;
// useVisiblePoller.ts is the thin React wrapper, and visiblePoller.test.mjs pins
// the contract (the first test ever to do so — its prior absence is exactly why
// nothing failed when half the gate was dropped three times).
//
// Split out from the hook — mirroring src/lib/timelinePacing.ts vs
// useLiveTimeline.ts — so the gate is unit-testable without a DOM/React
// renderer. This repo's web/ test harness is `node --test` with no jsdom
// (WARDEN-130), so the pure core is transpiled via Vite's OXC transform and
// exercised with a mocked env. The hook delegates to createVisiblePoller with
// the real browser env.

/**
 * Options shared by {@link createVisiblePoller} and useVisiblePoller.
 */
export interface UseVisiblePollerOptions {
  /**
   * If set, the interval tick also fires while the tab is HIDDEN whenever this
   * returns true. Models the WARDEN-259 away-alert case: a poller that must keep
   * running while the human is away so an "increase-while-hidden" alert has a
   * trigger (useAttentionRollup's health / agent-states / fleet polls).
   *
   * Applies ONLY to the interval tick. The visibilitychange handler still fires
   * exclusively on a transition INTO visible, because that handler is by
   * definition reacting to becoming visible — `runWhileHidden` must not (and does
   * not) relax it. All 7 originals gate that handler on `=== 'visible'`
   * unconditionally; that is preserved verbatim.
   */
  runWhileHidden?: () => boolean;
  /**
   * Call `fn` once on setup/mount (default `true`). The App.tsx catalog poll is
   * the one site that historically had NO unconditional mount-poll (it self-gated
   * via an early return and was interval-only); passing `{ mountPoll: false }`
   * there keeps this refactor literally behavior-preserving (WARDEN-753 Finding
   * #2). Every other site mount-polls and uses the default.
   */
  mountPoll?: boolean;
}

/**
 * The side-effectful surface a visible-poller drives, injected so the gate
 * contract is unit-testable with a mocked env (see visiblePoller.test.mjs). The
 * React hook passes the real browser APIs; the test passes fakes it controls.
 */
export interface VisiblePollerEnv {
  setInterval: (handler: () => void, ms: number) => number;
  clearInterval: (id: number) => void;
  addEventListener: (type: 'visibilitychange', handler: () => void) => void;
  removeEventListener: (type: 'visibilitychange', handler: () => void) => void;
  /** Read the CURRENT visibility so the tick + handler gate on live state. */
  visibilityState: () => DocumentVisibilityState;
}

/**
 * Set up a Page-Visibility-gated poller and return its cleanup function. This is
 * the tested core; useVisiblePoller is a thin React wrapper over it.
 *
 * Contract (the idiom hand-copied across 7 effects — WARDEN-753):
 *   - mount-poll: call `fn()` once on setup unless `opts.mountPoll === false`;
 *   - interval tick: every `ms`, call `fn()` only when the tab is visible OR
 *     `opts.runWhileHidden?.()` returns true;
 *   - visibilitychange: on a transition INTO visible, call `fn()` immediately
 *     (state may be stale while hidden) — `runWhileHidden` does NOT relax this;
 *   - cleanup (the returned function): clear the interval + remove the listener.
 *
 * No `cancelled` flag is carried. The originals (useActivitySeries,
 * TelemetryTransmissionLog) used one solely to suppress the legacy "setState on
 * unmounted component" warning, which React 18+ removed; this app ships React
 * 19, where a setState after unmount is a documented silent no-op. An async `fn`
 * that resolves post-unmount therefore behaves identically (no crash, no warning,
 * no state update) — equivalent semantics without the flag. The other five sites
 * already relied on that no-op (they never carried a cancelled guard), so this
 * also makes the two outliers consistent with the rest of the fleet.
 */
export function createVisiblePoller(
  fn: () => void,
  ms: number,
  opts: UseVisiblePollerOptions | undefined,
  env: VisiblePollerEnv,
): () => void {
  const runWhileHidden = opts?.runWhileHidden;
  // Mount-poll: unconditional on setup. The originals called fn() on mount
  // regardless of visibility; App.tsx is the sole exception, via mountPoll:false.
  if (opts?.mountPoll !== false) fn();
  const tick = () => {
    if (env.visibilityState() === 'visible' || runWhileHidden?.() === true) fn();
  };
  // visibilitychange fires on ANY transition; we react only to becoming visible
  // (state may be stale while hidden). runWhileHidden does not relax this — see
  // UseVisiblePollerOptions.runWhileHidden. All 7 originals gate this handler on
  // === 'visible' unconditionally; that is preserved verbatim.
  const onVisibility = () => {
    if (env.visibilityState() === 'visible') fn();
  };
  const intervalId = env.setInterval(tick, ms);
  env.addEventListener('visibilitychange', onVisibility);
  return () => {
    env.clearInterval(intervalId);
    env.removeEventListener('visibilitychange', onVisibility);
  };
}
