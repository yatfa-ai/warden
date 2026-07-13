// Health classification for the agent fleet (WARDEN-245).
//
// The single behavioral change in this ticket: a chat whose tmux session is no
// longer alive (active === false) is CLOSED, not CRITICAL — for both kind:'tmux'
// and kind:'yatfa', with no kind-based special-casing. CRITICAL is reserved for
// an ALIVE-but-silent agent (no output in 30+ min). These tests lock that
// contract end-to-end: classification, the closed group bucket, the summary
// count/label, and the display/color helpers.
import { describe, it } from 'node:test';
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
const ago = (ms) => Date.now() - ms;

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
