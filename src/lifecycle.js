// Cross-host agent lifecycle diffing for the Activity Timeline.
//
// Problem: appendEvent() (src/activity.js) is only reached from the local
// attach/observe path — panes the user actively opened. A remote agent that
// starts, stops, or errors overnight (no Warden pane open on that host) leaves
// ZERO trace. src/server.js runs a periodic discoverAll() over every configured
// host and feeds two snapshots into the pure functions below to emit
// host-attributed, host-filterable lifecycle events on state TRANSITIONS only
// (not every tick — that is what keeps event volume negligible).
//
// Both functions are PURE (no I/O, no SSH, no clocks) so they can be unit-tested
// in isolation, mirroring the resolveChat convention in src/chats.js.

// Snapshot row shape (a Map keyed by chat id):
//   { id, host, container, role, project, active, ok }
//
// `active` mirrors src/chats.js: whether the `agent` tmux session is alive
// inside the container (docker exec ... tmux has-session -t agent) — NOT output
// recency. So a quiet-but-running agent is still active:true. Output staleness
// lives in src/health.js and is intentionally NOT modeled here.
//
// `ok` = did THIS chat's host discovery succeed in this snapshot?
//   true  → row reflects real, live state.
//   false → host discovery FAILED this tick; the row is a stale carry-forward
//           from the previous snapshot (see buildSnapshot) so a transient SSH
//           blip isn't misread as a fleet of agent_ended events.

/**
 * Build a `next` snapshot from a discoverAll() result.
 *
 * Discovered chats get ok:true. Chats on hosts whose discovery FAILED are
 * carried forward from `prev` with ok:false and their last-known `active` — so
 * they stay present in the snapshot (never reading as "disappeared") while their
 * host is unreachable. When the host recovers they're rediscovered fresh.
 *
 * @param {Map} prev - previous snapshot (id → row), used only for carry-forward.
 * @param {Array} chats - chat objects from discoverAll() ({id,host,container,role,project,active}).
 * @param {Set<string>} failingHosts - hosts whose discovery failed this tick.
 * @returns {Map} next snapshot (id → row).
 */
export function buildSnapshot(prev, chats, failingHosts = new Set()) {
  const next = new Map();
  for (const c of chats) {
    next.set(c.id, {
      id: c.id,
      host: c.host,
      container: c.container ?? null,
      role: c.role ?? null,
      project: c.project ?? null,
      active: !!c.active,
      ok: true,
    });
  }
  // Carry forward previously-known chats on currently-failing hosts so a
  // transient SSH failure is NOT recorded as a burst of agent_ended events
  // (nuance: every container on a failing host is absent from `chats`).
  for (const [id, row] of prev) {
    if (failingHosts.has(row.host) && !next.has(id)) {
      next.set(id, { ...row, ok: false });
    }
  }
  return next;
}

function agentEvent(type, row) {
  return {
    type,
    id: row.id,
    host: row.host,
    container: row.container ?? null,
    role: row.role ?? null,
    project: row.project ?? null,
  };
}

/**
 * Diff two snapshots and return the lifecycle events for the transitions
 * between them. Emits AT MOST one event per (chat, transition) — never per tick.
 *
 * Transitions:
 *   - agent_started       chat appeared (new container/agent discovered)
 *   - agent_ended         chat disappeared AND its host is reachable
 *                          (failing-host chats are carried forward by
 *                          buildSnapshot, so a real disappearance here means
 *                          the container genuinely went away)
 *   - agent_session_up    existing chat's tmux `agent` session came alive
 *                          (active: false → true)
 *   - agent_session_down  existing chat's tmux `agent` session stopped
 *                          (active: true → false) — container still running
 *   - host_error          a host's discovery started failing (ok: true → false)
 *   - host_ok             a host's discovery recovered (ok: false → true)
 *
 * host_error/host_ok are emitted ONCE per host per transition (not once per
 * agent on that host). They carry only { type, host } — host-level, no agent.
 *
 * @param {Map} prev - previous snapshot (id → row).
 * @param {Map} next - current snapshot (id → row), from buildSnapshot().
 * @returns {Array<object>} activity events to append.
 */
export function diffLifecycles(prev, next) {
  const events = [];
  const hostErrorSeen = new Set(); // hosts already emitted host_error for this diff
  const hostOkSeen = new Set();    // hosts already emitted host_ok for this diff

  for (const [id, n] of next) {
    const p = prev.get(id);

    if (!p) {
      // Appeared. Carry-forwards are always in prev too, so a missing prev row
      // with ok:false should not happen — guard anyway: only real discoveries start.
      if (n.ok) events.push(agentEvent('agent_started', n));
      continue;
    }

    // Host reachability transition (once per host).
    if (p.ok && !n.ok) {
      if (!hostErrorSeen.has(n.host)) {
        events.push({ type: 'host_error', host: n.host });
        hostErrorSeen.add(n.host);
      }
    } else if (!p.ok && n.ok) {
      if (!hostOkSeen.has(n.host)) {
        events.push({ type: 'host_ok', host: n.host });
        hostOkSeen.add(n.host);
      }
    }

    // tmux-session up/down flip. Only meaningful when current state is known
    // (ok:true). On a carry-forward (ok:false) we keep the prior `active`, so no
    // spurious flip fires during an outage.
    if (n.ok && !!p.active !== !!n.active) {
      events.push(agentEvent(n.active ? 'agent_session_up' : 'agent_session_down', n));
    }
  }

  // Disappeared. buildSnapshot carries failing-host chats forward into `next`,
  // so any id present in prev but absent from next is a REAL disappearance
  // (host was reachable, container genuinely gone) — safe to record agent_ended.
  for (const [id, p] of prev) {
    if (!next.has(id)) {
      events.push(agentEvent('agent_ended', p));
    }
  }

  return events;
}
