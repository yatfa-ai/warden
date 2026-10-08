// Agent-state poll core (WARDEN-1647): the /api/agent-states + /api/agent-states/fleet
// classification core (pollAgentStates / pollFleetStates) and its state_changed
// transition logging. Moved verbatim out of server.js; the routes stay there and
// import these. Leaf-sibling imports only — never server.js (no cycle).
import { appendEvent } from './activity.js';
import { classifyPane, stripAnsi, matchWatchPatterns } from './agentState.js';
import { capturePanes } from './chats.js';
import { reconcilePaneSubscriptions, isCompanionTransportEnabled, isCompanionExcludedHost } from './companion.js';

const LOCAL = '(local)';

// WARDEN-788 — Fleet state timeline: per-agent state-transition logging.
//
// Warden surfaces every agent's state as a POINT IN TIME (the /api/agent-states
// snapshot + time-in-state stamp), never a SEQUENCE over time — so a human cannot
// tell a one-off stall from a looping agent. pollAgentStates (below) now also
// persists a `state_changed` event on every genuine transition into the SAME
// rotated JSONL store the heatmap reads (no new persistence subsystem), and
// getStateSeriesSince (src/activity.js) forward-fills those into the per-bucket
// state series the Fleet state timeline renders.
//
// `lastLoggedState` is the module-level transition-diff baseline — keyed by agent
// `key` (NOT per-poller), because an agent can shift between the 30s open∪watched
// poll, the 90s hidden-fleet sweep, and the 60s webhook sweep via excludeKeys, and
// a transition observed by one caller must NOT re-log when a sibling sees the same
// state next tick. In-memory only (rides the existing store; no new persistence).
let lastLoggedState = new Map(); // key → state (the transition-diff baseline)

// A failed state-changed write must NEVER break the poll (a disk hiccough shouldn't
// 500 /api/agent-states or sink the attention rollup). Genuinely mirrors
// appendLifecycleEvent's discipline (server.js:~2418): `appendEvent` is ASYNC, so the
// guard must be `await` + `catch` — a SYNCHRONOUS try/catch around an async call
// catches NOTHING (it only sees a throw before the first await inside the callee), the
// returned promise is dropped, and a rejection escapes as an `unhandledRejection`
// which terminates the process on Node >= 15 — the exact crash this guard exists to
// prevent (WARDEN-947; the sync shape shipped with WARDEN-788 before WARDEN-831 made
// the append async).
//
// AWAITING (not fire-and-forget `.catch()`) also preserves the ordering guarantee
// appendLifecycleEvent spells out: the event is on disk before the tick continues, so a
// concurrent /api/activity reader (or a test) never observes the tick's state change
// before the event lands. This is async I/O — it orders the tick behind its own append,
// it does not block the event loop.
//
// Exported so a test can drive the real appendEvent write path.
export async function appendStateEvent(event) {
  try { await appendEvent(event); } catch { /* ignore single-event write failures */ }
}

/**
 * Log a `state_changed` event when an agent's classified state genuinely
 * transitions (`prev !== state`), updating the diff baseline. Returns true iff an
 * event was appended. Mirrors the proven prev!==state dedup at
 * useAttentionRollup.ts:550, INCLUDING the first-observation baseline: when `prev`
 * is undefined (the agent's first classification this process — or the first poll
 * after a warden restart), it logs `from: null` so a steady agent renders a FULL
 * timeline row from its first observation, not a blank. (Restart re-baselines once
 * per agent — honest data marking when observation began; the store is rotated.)
 *
 * Pure aside from `map` mutation + `appendFn` (both injected) so the dedup is
 * unit-testable WITHOUT SSH / capture / the activity store: a test passes its own
 * Map + recording appendFn and asserts exactly which transitions survive.
 *
 * ASYNC (WARDEN-947): the production `appendFn` (appendStateEvent) is async, so the
 * append is AWAITED here and the awaited chain is threaded all the way out to
 * pollAgentStates. Dropping the promise here would re-open the
 * escaping-rejection crash and the write-after-teardown race. A synchronous test
 * appendFn still works unchanged (`await` on a non-promise is a no-op) — callers just
 * have to await the returned boolean.
 *
 * @param {Map<string, string>} map   The diff-baseline map (module-level lastLoggedState in prod).
 * @param {string} key               The agent key (stable across pollers).
 * @param {string} state             The newly-classified state.
 * @param {object} meta              Identity carried onto the event (id/host/container/role/…).
 * @param {(e: object) => void|Promise<void>} appendFn  The store writer (appendStateEvent in prod).
 * @returns {Promise<boolean>}
 */
export async function logStateTransition(map, key, state, meta, appendFn) {
  const prev = map.get(key);
  if (prev === state) return false; // unchanged tick → NO event (the dedup)
  map.set(key, state);
  await appendFn({
    type: 'state_changed',
    from: prev ?? null, // null marks the first-observation baseline segment start
    to: state,
    ...meta,
  });
  return true;
}

// Thin wrapper pollAgentStates calls per classified chat: skips manual/tmux chats
// (no container — their high-churn flapping would write events the container-keyed
// reader drops, mirroring the heatmap's case-1 scope) and threads the module map +
// the guarded writer onto logStateTransition. Exported for the test reset.
//
// ASYNC (WARDEN-947): returns the awaited append so every call site can order the tick
// behind its own write. appendStateEvent swallows write failures, so this never
// rejects — but it MUST still be awaited, or the promise is dropped again.
async function logAgentState(c, state) {
  if (!c.container) return; // manual/tmux chats carry no timeline row (heatmap case 1)
  // WARDEN-1223: the transition-diff baseline is keyed by the HOST-QUALIFIED id —
  // the bare key names two different agents when two hosts run a same-named
  // session, and a per-name baseline attributes one agent's transition to the other.
  return logStateTransition(lastLoggedState, c.id, state, {
    id: c.container || c.session,
    host: c.host,
    container: c.container ?? null,
    role: c.role,
    project: c.project,
    name: c.name || c.key || (c.container || c.session),
  }, appendStateEvent);
}

// Test seam: reset the module-level diff baseline so a test's poller-A-then-poller-B
// assertions start from a clean map. node --test runs each file in its own process,
// so this never leaks across files; within a file it isolates each case.
export function __resetLastLoggedStateForTest() {
  lastLoggedState = new Map();
}

// The 6 identity keys every classified agent row carries, regardless of which
// classifier produced it (pollAgentStates, or the sweep_skipped rows
// pollFleetStates synthesizes without ever probing). Pure projection of a chat —
// no I/O, no state.
function agentRowBase(c) {
  return {
    // WARDEN-1223: `id` is the HOST-QUALIFIED chat id, NOT the bare
    // container/session name — rebinding it to the bare name collapses two
    // same-named sessions on different hosts into one agent row.
    id: c.id,
    key: c.key,
    host: c.host,
    project: c.project,
    role: c.role,
    name: c.name || c.key || (c.container || c.session),
  };
}

// The shared classify→log loop (WARDEN-1010). Takes chats plus their ALREADY-captured
// panes and returns the classified rows; it deliberately does NOT capture, so a caller
// keeps ownership of its own capture policy (pollAgentStates reconciles the companion
// subscription first and passes `deps`). Only the loop body — which drifted for a month
// and cost a fail_audit — is shared. WARDEN-1274: the 60s server-side webhook sweep was
// the second caller; it is retired, leaving pollAgentStates as the sole one.
//
// WARDEN-947: a sequential for-of (not `chats.map`) because logAgentState is AWAITED —
// the state_changed write must land before the caller returns, so a concurrent
// /api/activity reader (or a test) never sees the returned state before its event.
// Sequential rather than Promise.all keeps the per-tick event order deterministic. The
// cost is ~0 in steady state: the dedup means an unchanged tick writes NOTHING, so only
// genuine transitions pay an append.
async function classifyCapturedPanes(chats, panes, cfg = {}) {
  const out = [];
  for (const c of chats) {
    const base = agentRowBase(c);
    // A MISSING key means capturePanes silently dropped this chat (host SSH
    // failed → `if (!res.ok) return;` per host). Surface it as capture_failed so
    // the badge can still name the agent instead of omitting it (WARDEN-89).
    if (!Object.prototype.hasOwnProperty.call(panes, c.id)) {
      // WARDEN-788: capture_failed is a genuine state change (reachable →
      // unreachable) with historical value ("when was this host down?"), logged
      // for container-bearing yatfa agents so the timeline can render an
      // "unreachable" segment. The dedup map prevents flapping from spamming.
      await logAgentState(c, 'capture_failed');
      out.push({ ...base, state: 'capture_failed', captureError: true, signal: null });
      continue;
    }
    const clean = stripAnsi(panes[c.id] || '');
    const { state, signal } = classifyPane(clean, c);
    // WARDEN-540: user-authored output-pattern alerts. Run the matcher over the SAME
    // already-cleaned text classifyPane read (a sibling pure function — zero new SSH
    // capture; rides the caller's existing capturePanes). When a watched chat's output
    // matches an enabled pattern, attach customMatch { pattern, line } — an ADDITIVE
    // signal independent of `state` (an agent can be both erroring AND match a custom
    // pattern). The frontend's watch diff fires a 'custom' ping on the new-match
    // transition; the attention rollup surfaces it as its own row. Null/absent when no
    // pattern matches → identical to today.
    const customMatch = matchWatchPatterns(clean, cfg.watchPatterns);
    // WARDEN-788: persist the transition (no-op on an unchanged tick). capture_failed
    // above and the classifyPane states here are the only states this loop produces —
    // sweep_skipped lives in pollFleetStates (never reaches here), so it correctly
    // produces no state_changed event, consistent with the heatmap/attention.
    await logAgentState(c, state);
    out.push({ ...base, state, signal, captureError: false, ...(customMatch ? { customMatch } : {}) });
  }
  return out;
}

// pollAgentStates is the /api/agent-states poll core: it reconciles the companion
// pane-push subscriptions for the polled hosts, captures their pane content, and
// classifies each. Exported (and deps-injected) so the WARDEN-413 success gate is
// drivable end-to-end: reconcile establishes the subscription → the companion
// pushes paneDelta events over the channel → capturePanes (chats.js) renders from
// the in-memory delta cache and SKIPS the per-host capturePanes RPC, so an idle
// companion host receives ZERO capturePanes RPCs per poll. The reconcile is
// awaited (not fire-and-forget like the WS monitor path) because /api/agent-states
// is a request/response HTTP call whose caller awaits the result anyway — sending
// subscribe before capture gives clean ordering, and on steady-state polls
// reconcile issues NO RPC (the pane set is unchanged), so the cost is ~0. The
// first poll after a host enters the set still polls once (the push hasn't arrived
// yet) — the graceful bootstrap. LOCAL + flag-off hosts are unchanged.
// `deps` is a test seam (defaults to {} in production). (WARDEN-413)
//
// WARDEN-788: pollAgentStates persists `state_changed` transitions into the activity
// log (via logStateTransition below) — the data source for the Fleet state timeline.
// pollFleetStates delegates the companion-eligible classification to THIS function
// (`pollAgentStates(...)` below), so the 30s open∪watched poll AND the 90s hidden-fleet
// sweep both log here. The dedup map is keyed by agent `key` (NOT per-poller) so a
// transition observed by one caller does not re-log when a sibling caller sees the same
// state on its next tick.
//
// WARDEN-1274: a THIRD call site used to exist — the 60s server-side attention webhook
// sweep, the only classifier that kept running with the dashboard closed to tray. It is
// retired with the alert machinery it fed, so state_changed logging is now CLIENT-driven
// only: nothing is recorded while the window is closed. That loss is an accepted
// consequence of the retirement (the state-history family is a later slice) — do NOT
// re-introduce a backend sweep to paper over it.
export async function pollAgentStates(chats, cfg = {}, deps = {}) {
  await reconcilePaneSubscriptions(chats, cfg, {}, deps);
  // `deps.capturePanes` is a test seam (defaults to the real capturePanes) so the
  // WARDEN-788 transition-logging is drivable end-to-end with canned pane content
  // and ZERO SSH — mirroring the existing deps philosophy. Production callers pass
  // nothing → the real capturePanes (unchanged behavior, the WARDEN-413 gate still
  // earns its zero-RPC steady state because the real fn is what the gate tests).
  const capture = deps.capturePanes ?? capturePanes;
  const panes = await capture(chats, cfg, deps);
  // WARDEN-1010: the classify→log loop lives in classifyCapturedPanes above.
  return classifyCapturedPanes(chats, panes, cfg);
}

// pollFleetStates is the slow "fleet sweep" classification mode (WARDEN-571). The 30s
// /api/agent-states poll above classifies ONLY the open ∪ watched panes, so an agent the
// human has HIDDEN — or simply never opened/watched on a busy fleet — is NEVER
// classified. Because a stuck-looping, error-spamming, or "press enter"-prompting agent
// is still PRODUCING output, /api/health's inactivity classifier reads it HEALTHY and
// Warden stays silently green. This fills that gap by classifying the REST of the fleet
// — every active chat NOT already in the caller's open ∪ watched set — on a dedicated
// slow cadence (the frontend's ~90s beat), folded into the SAME Attention rollup so a
// hidden agent needing attention surfaces in the badge + fires the opt-in alert.
//
// Hard cost gate — the sweep NEVER opens an SSH connection to the fleet. It classifies
// ONLY via the companion path (the shipped WARDEN-413 read/delta path — NOT the
// rejected WARDEN-279/283 companion write/send-keys paths; those rejections do not bear
// on this). Companion-connected REMOTE hosts reuse pollAgentStates' reconcile → capture
// → classify: a steady-state sweep issues ONE batched capturePanesViaCompanion per hidden
// HOST per ~90s sweep. The subscription's 30s TTL (tuned for the 30s open-pane poll — see
// AGENT_STATE_TTL_MS) evicts a hidden pane between sweeps, because the hidden pane is
// owned ONLY by this 90s sweep and the 30s poll never requests it, so nothing refreshes
// its TTL; each sweep therefore re-subscribes and captures once over the persistent
// channel. That single batched RPC per host is NOT an SSH sweep. (Contrast pollAgentStates
// above: the 30s poll's cadence equals its TTL, so its subscriptions stay live and it
// earns ZERO capturePanes RPCs steady-state; the 90s sweep's cadence is 3× its TTL, so it
// does not — the cost-gate test asserts the real 1/host/sweep steady state, driving the
// production background TTL eviction between iterations.) Hosts WITHOUT the companion
// transport (flag off, or LOCAL) are returned `state: 'sweep_skipped'` and NEVER probed —
// preserving the "no full SSH sweep" invariant at the /api/agent-states header.
// `sweep_skipped` is a NEW state, distinct from `capture_failed` (tried + failed): it is
// the honest "intentionally not probed (cost gate)" signal, the opposite of the silence
// this fixes.
//
// `chats` is the full active fleet (the endpoint passes the catalog `cache`).
// `opts.excludeKeys` is the caller's open ∪ watched pane keys, so the sweep does NOT
// re-classify what the 30s poll already covers (the sweep set = active chats − open ∪
// watched). `deps` is the same test seam pollAgentStates takes, so the WARDEN-413
// cost-gate test is drivable end-to-end. The sweep uses the SAME classifyPane +
// stripAnsi path so classification semantics are identical to the open-pane poll — no
// divergent heuristics. Exported (and deps-injected) for the cost-gate test. (WARDEN-571)
export async function pollFleetStates(chats, cfg = {}, deps = {}, opts = {}) {
  // The caller's open ∪ watched pane keys may be BARE keys or host-qualified ids
  // (the client sends what it stored; WARDEN-1223: a bare key can name a session
  // on more than one host, so exclude on EITHER identity to avoid re-classifying
  // a pane the 30s poll already owns).
  const exclude = new Set((opts.excludeKeys || []));
  const fleet = (Array.isArray(chats) ? chats : []).filter((c) => c && c.key && !exclude.has(c.key) && !exclude.has(c.id));
  // Partition the fleet: companion-eligible (REMOTE + companion transport on) vs the
  // rest. The companion path is the ONLY capture path the sweep is allowed to use, so
  // anything that would require a raw SSH capture (LOCAL tmux, or the companion flag
  // off) is intentionally NOT classified and surfaced as sweep_skipped — never probed.
  const companionEligible = [];
  const skipped = [];
  for (const c of fleet) {
    // WARDEN-1390: the per-host exclusion is part of eligibility — an excluded
    // host's panes must ride raw SSH, and the sweep is only ever allowed to
    // capture via the channel, so an excluded host lands in `skipped`
    // (surfaced as sweep_skipped, never probed over the channel).
    if (isCompanionTransportEnabled() && c.host !== LOCAL && !isCompanionExcludedHost(c.host)) companionEligible.push(c);
    else skipped.push(c);
  }
  // Reconcile establishes the pane-push subscription → the companion pushes paneDelta
  // events → capturePanes renders from hasFreshPaneDelta cache and SKIPS the RPC. The
  // companion-eligible subset is classified by the EXACT pollAgentStates path, so a
  // hidden agent's classification (stuck / erroring / waiting / blocked / custom) is
  // byte-for-byte what the open-pane poll would have produced.
  const classified = companionEligible.length
    ? await pollAgentStates(companionEligible, cfg, deps)
    : [];
  // sweep_skipped rows are NAMED (so the badge can list "not swept" if it ever wants
  // to) but carry state 'sweep_skipped', which matches none of buildAttentionRollup's
  // four attention buckets — so a sweep_skipped row is NEVER a needs-attention row and
  // never inflates the count or fires an alert. Honors WARDEN-89's "flagged, not
  // dropped" spirit: it is the explicit "didn't look here" state, kept distinct from
  // capture_failed (tried + failed via the companion path).
  const skippedRows = skipped.map((c) => ({
    ...agentRowBase(c),
    state: 'sweep_skipped',
    sweepSkipped: true,
    signal: null,
  }));
  return [...classified, ...skippedRows];
}
