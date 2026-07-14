// Health classification for the agent fleet.
//
// Two behavioral contracts are locked here:
//  - WARDEN-245: a chat whose tmux session is no longer alive (active === false)
//    is CLOSED, not CRITICAL — for both kind:'tmux' and kind:'yatfa', with no
//    kind-based special-casing. CRITICAL is reserved for an ALIVE-but-silent
//    agent (no output in 30+ min). Covers classification, the closed group
//    bucket, the summary count/label, and the display/color helpers.
//  - WARDEN-317: the healthy→WARNING and warning→CRITICAL boundaries are
//    user-configurable via getHealthState's optional `thresholds` arg; defaults
//    stay at 5/30 min so existing behavior is unchanged unless a human opts in.
//    The IDLE branch for manual tmux sessions consumes the SAME configured
//    warning boundary as the agent classifications (the subtle coupling flagged
//    in the ticket — all three call sites share one configured value).
//
// Exact-boundary assertions (e.g. "exactly 5 min → HEALTHY via <=") mock
// Date.now() to a FIXED instant so sub-millisecond scheduling jitter cannot flip
// an inclusive-cutoff result. Coarse-grained tests (well inside a band) use a
// real Date.now() and are robust without mocking.
import { describe, it, before, after, mock } from 'node:test';
import assert from 'node:assert';
import {
  HealthState,
  getHealthState,
  getHealthColor,
  getHealthBgColor,
  formatHealthState,
  groupByHealth,
  getHealthSummary,
} from './health.js';

const MIN = 60 * 1000;

// --- mocked-time helpers (for exact-boundary assertions) ---
const NOW = Date.UTC(2026, 6, 12, 12, 0, 0); // 2026-07-12T12:00:00Z
// lastActivity N minutes before the mocked NOW
const agoMin = (m) => NOW - m * MIN;

// --- real-time helper (coarse, well inside a band — no mock needed) ---
const ago = (ms) => Date.now() - ms;

// A live yatfa agent (auto-discovered): active tmux session running an agent.
const yatfaAgent = () => ({ active: true, kind: 'yatfa', isAgent: true });
// A manual tmux session (no agent process behind it): the IDLE-branch path.
const manualTmux = () => ({ active: true, kind: 'tmux', isAgent: false });

// =====================================================================
// WARDEN-245: dead sessions are CLOSED, not CRITICAL
// =====================================================================

describe('getHealthState — dead sessions are CLOSED, not CRITICAL (WARDEN-245)', () => {
  it('classifies a dead tmux (manual) session as CLOSED', () => {
    const agent = { active: false, kind: 'tmux', isAgent: false };
    assert.strictEqual(getHealthState(agent, null), HealthState.CLOSED);
  });

  it('classifies a dead yatfa session as CLOSED', () => {
    const agent = { active: false, kind: 'yatfa', isAgent: true };
    assert.strictEqual(getHealthState(agent, null), HealthState.CLOSED);
  });

  it('does NOT special-case by kind — a dead session is CLOSED with either kind', () => {
    // Same input shape, different kind → same CLOSED result.
    const tmux = getHealthState({ active: false, kind: 'tmux' }, null);
    const yatfa = getHealthState({ active: false, kind: 'yatfa' }, null);
    assert.strictEqual(tmux, HealthState.CLOSED);
    assert.strictEqual(yatfa, HealthState.CLOSED);
    assert.strictEqual(tmux, yatfa);
  });

  it('a dead session is NEVER critical, even with a stale lastActivity', () => {
    // A 10-day-old lastActivity on a dead session must still be CLOSED, not
    // fall through to the time-based CRITICAL rule.
    const state = getHealthState({ active: false, kind: 'yatfa' }, ago(10 * 24 * 60 * MIN));
    assert.strictEqual(state, HealthState.CLOSED);
    assert.notStrictEqual(state, HealthState.CRITICAL);
  });

  it('treats active == null (undiscovered / lazy) as UNKNOWN — not dead', () => {
    assert.strictEqual(getHealthState({ active: null }, null), HealthState.UNKNOWN);
    assert.strictEqual(getHealthState({ active: undefined }, null), HealthState.UNKNOWN);
  });
});

describe('getHealthState — live agents keep the time-based rules', () => {
  it('a yatfa agent with output in the last 5 min is HEALTHY', () => {
    const agent = { active: true, kind: 'yatfa', isAgent: true };
    assert.strictEqual(getHealthState(agent, ago(1 * MIN)), HealthState.HEALTHY);
  });

  it('a yatfa agent silent 5–30 min is WARNING', () => {
    const agent = { active: true, kind: 'yatfa', isAgent: true };
    assert.strictEqual(getHealthState(agent, ago(10 * MIN)), HealthState.WARNING);
  });

  it('a yatfa agent silent 30+ min (but ALIVE) is CRITICAL', () => {
    const agent = { active: true, kind: 'yatfa', isAgent: true };
    assert.strictEqual(getHealthState(agent, ago(31 * MIN)), HealthState.CRITICAL);
  });

  it('a live agent with no lastActivity is UNKNOWN', () => {
    const agent = { active: true, kind: 'yatfa', isAgent: true };
    assert.strictEqual(getHealthState(agent, null), HealthState.UNKNOWN);
    assert.strictEqual(getHealthState(agent, undefined), HealthState.UNKNOWN);
  });
});

// =====================================================================
// WARDEN-374: an inverted pair (warning > critical) must NOT lie. The
// classifier clamps the healthy boundary to the smaller critical value so a
// silently-failing agent can never read HEALTHY (and suppress the CRITICAL
// desktop alert) when the thresholds are mis-ordered. Errs toward alerting.
// =====================================================================

describe('getHealthState — an inverted pair (warning > critical) cannot lie (WARDEN-374)', () => {
  // The exact acceptance-criteria inversion: healthy=60min, critical=30min.
  // Without the clamp, the first branch (t <= 60min) swallows everything up to
  // 60 min and a 40-min-silent agent reads HEALTHY (a lying state).
  const inverted = { healthyMin: 60, warningMin: 30 };

  before(() => mock.method(Date, 'now', () => NOW));
  after(() => mock.restoreAll());

  it('classifies a 40-min-silent agent as CRITICAL (not HEALTHY) under the 60/30 inversion', () => {
    // Acceptance criterion: idle 40 min at warning=60/critical=30 must read
    // CRITICAL — the smaller (critical) value governs, never the inverted 60.
    assert.strictEqual(getHealthState(yatfaAgent(), agoMin(40), inverted), HealthState.CRITICAL);
  });

  it('never returns HEALTHY for a live agent past the smaller (critical) boundary when inverted', () => {
    // 40 min is well past the 30-min critical boundary → must NOT be healthy.
    const state = getHealthState(yatfaAgent(), agoMin(40), inverted);
    assert.notStrictEqual(state, HealthState.HEALTHY);
  });

  it('uses the smaller value as the healthy boundary under inversion (25 min still HEALTHY)', () => {
    // 25 min is within the clamped 30-min healthy band → HEALTHY. Pins that the
    // clamp drops the healthy boundary to 30 (not the inverted 60), keeping the
    // band finite rather than collapsing the whole ladder to CRITICAL.
    assert.strictEqual(getHealthState(yatfaAgent(), agoMin(25), inverted), HealthState.HEALTHY);
  });

  it('errs toward alerting past the smaller boundary under inversion (31 min → CRITICAL)', () => {
    // With the pair inverted the WARNING band is unreachable (the two boundaries
    // coincide at 30); 31 min falls past it → CRITICAL, never a silent HEALTHY.
    assert.strictEqual(getHealthState(yatfaAgent(), agoMin(31), inverted), HealthState.CRITICAL);
  });
});

describe('getHealthState — manual (tmux, non-agent) sessions are IDLE when stale', () => {
  it('a manual session silent 30+ min is IDLE, not WARNING/CRITICAL', () => {
    const agent = { active: true, kind: 'tmux', isAgent: false };
    assert.strictEqual(getHealthState(agent, ago(31 * MIN)), HealthState.IDLE);
  });

  it('a manual session with no lastActivity is IDLE', () => {
    const agent = { active: true, kind: 'tmux', isAgent: false };
    assert.strictEqual(getHealthState(agent, null), HealthState.IDLE);
  });

  it('a manual session with recent activity still classifies by time (HEALTHY/WARNING)', () => {
    const agent = { active: true, kind: 'tmux', isAgent: false };
    assert.strictEqual(getHealthState(agent, ago(1 * MIN)), HealthState.HEALTHY);
    assert.strictEqual(getHealthState(agent, ago(10 * MIN)), HealthState.WARNING);
  });
});

describe('formatHealthState / colors — CLOSED helper mappings', () => {
  it('formats CLOSED as "Closed"', () => {
    assert.strictEqual(formatHealthState(HealthState.CLOSED), 'Closed');
  });

  it('maps CLOSED to a gray text color (distinct from critical red)', () => {
    const closedColor = getHealthColor(HealthState.CLOSED);
    assert.match(closedColor, /^text-gray-/);
    assert.notStrictEqual(closedColor, getHealthColor(HealthState.CRITICAL));
  });

  it('maps CLOSED to a gray background color', () => {
    assert.match(getHealthBgColor(HealthState.CLOSED), /^bg-gray-/);
  });
});

describe('groupByHealth — CLOSED has its own bucket', () => {
  it('places a closed agent in groups.closed, separate from critical', () => {
    const agents = [
      { id: 'dead', healthState: HealthState.CLOSED },
      { id: 'alive-stale', healthState: HealthState.CRITICAL },
      { id: 'fine', healthState: HealthState.HEALTHY },
    ];
    const groups = groupByHealth(agents);
    assert.deepStrictEqual(groups.closed.map((a) => a.id), ['dead']);
    assert.deepStrictEqual(groups.critical.map((a) => a.id), ['alive-stale']);
    assert.deepStrictEqual(groups.healthy.map((a) => a.id), ['fine']);
  });

  it('initializes an empty closed bucket even with no agents', () => {
    const groups = groupByHealth([]);
    assert.deepStrictEqual(groups.closed, []);
    assert.ok(Array.isArray(groups.closed));
  });
});

describe('getHealthSummary — closed is counted and labelled', () => {
  it('counts closed chats in the summary and includes them in the total', () => {
    const groups = groupByHealth([
      { id: 'a', healthState: HealthState.HEALTHY },
      { id: 'b', healthState: HealthState.CLOSED },
      { id: 'c', healthState: HealthState.CLOSED },
      { id: 'd', healthState: HealthState.UNKNOWN }, // excluded from total
    ]);
    const summary = getHealthSummary(groups);
    assert.strictEqual(summary.closed, 2);
    assert.strictEqual(summary.healthy, 1);
    assert.strictEqual(summary.total, 3); // healthy(1) + closed(2); unknown excluded
  });

  it('includes "N closed" in the label', () => {
    const groups = groupByHealth([
      { id: 'b', healthState: HealthState.CLOSED },
      { id: 'b2', healthState: HealthState.CLOSED },
    ]);
    const summary = getHealthSummary(groups);
    assert.match(summary.label, /2 closed/);
  });

  it('reports zero closed when none are present', () => {
    const summary = getHealthSummary(groupByHealth([]));
    assert.strictEqual(summary.closed, 0);
    assert.match(summary.label, /0 closed/);
  });
});

// =====================================================================
// WARDEN-317: configurable attention thresholds (healthy/critical cutoffs)
// =====================================================================

describe('getHealthState (default thresholds: healthy=5min, critical=30min)', () => {
  before(() => mock.method(Date, 'now', () => NOW));
  after(() => mock.restoreAll());

  it('classifies an agent active within the healthy window as HEALTHY', () => {
    assert.strictEqual(getHealthState(yatfaAgent(), agoMin(4)), HealthState.HEALTHY);
  });

  it('treats exactly the healthy boundary (5 min) as HEALTHY (inclusive <=)', () => {
    assert.strictEqual(getHealthState(yatfaAgent(), agoMin(5)), HealthState.HEALTHY);
  });

  it('classifies an agent inactive between the two boundaries as WARNING', () => {
    assert.strictEqual(getHealthState(yatfaAgent(), agoMin(20)), HealthState.WARNING);
  });

  it('treats exactly the critical boundary (30 min) as WARNING (inclusive <=)', () => {
    assert.strictEqual(getHealthState(yatfaAgent(), agoMin(30)), HealthState.WARNING);
  });

  it('classifies an agent inactive past the critical boundary as CRITICAL', () => {
    assert.strictEqual(getHealthState(yatfaAgent(), agoMin(31)), HealthState.CRITICAL);
  });
});

describe('getHealthState (custom thresholds: healthy=15min, critical=120min)', () => {
  // The 120-min critical boundary is the acceptance-criteria scenario: a human
  // who checks hourly raises the critical cutoff so the 30-min mark no longer
  // spams them with critical desktop alerts.
  const thresholds = { healthyMin: 15, warningMin: 120 };

  before(() => mock.method(Date, 'now', () => NOW));
  after(() => mock.restoreAll());

  it('keeps a recently-active agent HEALTHY (10 min < raised healthy boundary)', () => {
    assert.strictEqual(getHealthState(yatfaAgent(), agoMin(10), thresholds), HealthState.HEALTHY);
  });

  it('shows WARNING, not CRITICAL, for an agent idle 45 min under a 120-min critical boundary', () => {
    // Acceptance criterion: idle 45 min must read WARNING (not critical).
    assert.strictEqual(getHealthState(yatfaAgent(), agoMin(45), thresholds), HealthState.WARNING);
  });

  it('treats exactly the raised critical boundary (120 min) as WARNING (inclusive <=)', () => {
    assert.strictEqual(getHealthState(yatfaAgent(), agoMin(120), thresholds), HealthState.WARNING);
  });

  it('shows CRITICAL for an agent idle 3h under a 120-min critical boundary', () => {
    // Acceptance criterion: idle 3h (180 min) must read CRITICAL and alert.
    assert.strictEqual(getHealthState(yatfaAgent(), agoMin(180), thresholds), HealthState.CRITICAL);
  });
});

describe('getHealthState IDLE branch consumes the configured critical threshold', () => {
  // Subtle: manual tmux sessions go IDLE past the WARNING/critical boundary.
  // This branch must use the SAME configured warningMin as the agent path — if a
  // worker raises the boundary in the agent classifications but leaves the IDLE
  // branch on the old default, manual sessions go IDLE at 30 min while agents
  // stay WARNING until the new boundary (inconsistent). These pin the coupling.

  before(() => mock.method(Date, 'now', () => NOW));
  after(() => mock.restoreAll());

  it('classifies a manual tmux session idle past the DEFAULT boundary (45 min) as IDLE', () => {
    assert.strictEqual(getHealthState(manualTmux(), agoMin(45)), HealthState.IDLE);
  });

  it('classifies a manual tmux session as WARNING (not IDLE) when idle 45 min under a RAISED 120-min boundary', () => {
    // 45 min is past the default boundary but under the raised one → not IDLE,
    // falls through to normal classification → WARNING. Proves the IDLE branch
    // honors warningMin instead of a hardcoded 30-min constant.
    assert.strictEqual(
      getHealthState(manualTmux(), agoMin(45), { healthyMin: 15, warningMin: 120 }),
      HealthState.WARNING,
    );
  });

  it('classifies a manual tmux session IDLE once past the RAISED boundary (180 > 120)', () => {
    assert.strictEqual(
      getHealthState(manualTmux(), agoMin(180), { healthyMin: 15, warningMin: 120 }),
      HealthState.IDLE,
    );
  });
});

describe('getHealthState dead/unknown paths are threshold-independent', () => {
  // WARDEN-245 made dead → CLOSED; WARDEN-317 adds the guarantee that passing
  // configured thresholds does NOT change that (or the unknown path) — the
  // dead/unknown branches are decided before any threshold matters.
  before(() => mock.method(Date, 'now', () => NOW));
  after(() => mock.restoreAll());

  it('classifies a dead session as CLOSED regardless of the configured thresholds', () => {
    assert.strictEqual(
      getHealthState({ active: false, kind: 'yatfa', isAgent: true }, agoMin(1)),
      HealthState.CLOSED,
    );
    // even with a wildly raised boundary, dead is dead (CLOSED, never critical).
    assert.strictEqual(
      getHealthState(
        { active: false, kind: 'yatfa', isAgent: true },
        agoMin(1),
        { healthyMin: 15, warningMin: 120 },
      ),
      HealthState.CLOSED,
    );
  });

  it('classifies an undiscovered lazy chat (active: null) as UNKNOWN', () => {
    assert.strictEqual(getHealthState({ active: null, kind: 'yatfa', isAgent: true }, null), HealthState.UNKNOWN);
    assert.strictEqual(
      getHealthState({ active: null, kind: 'yatfa', isAgent: true }, agoMin(999), { healthyMin: 15, warningMin: 120 }),
      HealthState.UNKNOWN,
    );
  });

  it('classifies a live agent with no activity timestamp as UNKNOWN', () => {
    assert.strictEqual(getHealthState(yatfaAgent(), null), HealthState.UNKNOWN);
  });
});
