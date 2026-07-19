// useVisiblePoller — the React hook form of the Page-Visibility poller gate
// (WARDEN-753). A thin wrapper over the pure, tested createVisiblePoller core
// (src/lib/visiblePoller.ts) that passes the real browser env. See that module
// for the full contract and the rationale for splitting the pure core out.
//
// This consolidates the idiom that was hand-copied across 7 effects in 5 files
// (useActivitySeries, HealthDashboard, the App.tsx catalog poll, useAttentionRollup
// x3, TelemetryTransmissionLog) and forgotten 3x (WARDEN-609/661/668). Folding
// those sites onto this hook + visiblePoller.test.mjs is the root-cause fix: the
// next poller adds a one-liner, not a fresh chance to forget half the gate.
import { useEffect } from 'react';
import type { DependencyList } from 'react';
import {
  createVisiblePoller,
  type UseVisiblePollerOptions,
  type VisiblePollerEnv,
} from '@/lib/visiblePoller';

// The browser side-effect surface. The pure core takes this as a parameter so
// the test harness can pass fakes; the hook always passes these real bindings.
const browserEnv: VisiblePollerEnv = {
  setInterval: (handler, ms) => window.setInterval(handler, ms),
  clearInterval: (id) => window.clearInterval(id),
  addEventListener: (type, handler) => document.addEventListener(type, handler),
  removeEventListener: (type, handler) => document.removeEventListener(type, handler),
  visibilityState: () => document.visibilityState,
};

/**
 * Page-Visibility-gated poller. Calls `fn` on mount (unless `opts.mountPoll` is
 * false), on each interval tick while the tab is visible (or while
 * `opts.runWhileHidden` returns true), and once on regaining focus. Cleans up
 * its interval + listener on unmount or when `deps` change.
 *
 * Mirrors `useEffect(setup, deps)`: the THIRD argument is the dependency list
 * (not opts), so each call site controls exactly when the poller tears down and
 * rebuilds. That is load-bearing for useAttentionRollup's agent-states poll,
 * whose deps include `openPanes` / `watchedChats` specifically so opening or
 * watching a pane re-fires immediately ("within a poll, not after 30s") — that
 * documented responsiveness would be lost under an internal `[]`-deps + refs
 * design, because the hook would have no signal that those values changed.
 *
 * @param fn   called on mount (unless mountPoll:false), each visible tick, and
 *             on focus regain.
 * @param ms   tick cadence in ms. Put it in `deps` when it is variable (e.g.
 *             App.tsx's `pollIntervalMs`); module constants need not list it.
 * @param deps dependency list — when any value changes the poller tears down and
 *             rebuilds (fresh mount-poll + rebound gate closures), identical to
 *             `useEffect`. Pass the same deps the original inline effect used.
 * @param opts `runWhileHidden` (tick relaxation for away-alert pollers) and
 *             `mountPoll` (default true; false for App.tsx's interval-only poll).
 */
export function useVisiblePoller(
  fn: () => void,
  ms: number,
  deps: DependencyList,
  opts?: UseVisiblePollerOptions,
): void {
  // `deps` is the caller's contract — fn/ms/opts are intentionally read from the
  // closure of the render that last satisfied `deps`, mirroring raw useEffect.
  // (Same shape + disable as the sibling poller hook useTokenBudget.ts.)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => createVisiblePoller(fn, ms, opts, browserEnv), deps);
}
