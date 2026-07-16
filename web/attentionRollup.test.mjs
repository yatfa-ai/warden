// Tests for buildAttentionRollup — the pure aggregator behind the header
// AttentionBadge's count (WARDEN-228).
//
// No front-end test runner in this repo, so (like gitStateSummary.test.mjs) this
// loads the REAL src/lib/attentionRollup.ts (transpiled TS -> ESM via Vite's OXC
// transform) and exercises it with plain objects. The `import type` in that file
// is erased at transpile time, so the emitted module is import-free and loads
// standalone.
//
// Formula under test: total = critical + warning agents + pending directives +
// recent errors. The caller (useAttentionRollup) already windowed the activity
// counts via the `after=` query param, so here we only verify aggregation — that
// each bucket contributes to the count, zero aggregates to nothing (badge hidden),
// and null/partial/missing inputs degrade gracefully instead of crashing.
//
// Run: node attentionRollup.test.mjs   (from web/)
import { transformWithOxc } from 'vite';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const helperPath = resolve(__dirname, 'src/lib/attentionRollup.ts');

// --- Load the REAL attentionRollup.ts (TS -> ESM via the OXC transform Vite bundles) ----
const src = readFileSync(helperPath, 'utf8');
const { code } = await transformWithOxc(src, helperPath, {});
const tmpDir = mkdtempSync(join(tmpdir(), 'warden-attention-test-'));
const tmpFile = join(tmpDir, 'attentionRollup.mjs');
writeFileSync(tmpFile, code);
const { buildAttentionRollup, EMPTY_ATTENTION_ROLLUP, rankAttention, pickCalloutTop, attentionReason, hasReturnContent } = await import(tmpFile);
rmSync(tmpDir, { recursive: true, force: true });

let passed = 0;
const test = (name, fn) => {
  fn();
  passed += 1;
  console.log('  ok -', name);
};

// Builders so each case reads as "which agents / counts" not a wall of literals.
const agent = (id, extra = {}) => ({ id, key: id, name: id, ...extra });
const health = (groups) => ({ groups: { healthy: [], warning: [], critical: [], idle: [], unknown: [], ...groups } });
const stats = (s) => ({ total: 0, directive_proposed: 0, attached: 0, ended: 0, error: 0, ...s });
// A pane-state row as /api/agent-states returns it.
const stateRow = (id, state, extra = {}) => ({ id, key: id, name: id, state, ...extra });
// agentStates defaults to null (the pre-WARDEN-344 two-arg call shape still works).
const roll = (h, s, a, opts) => buildAttentionRollup(h ?? null, s ?? null, a ?? null, opts);

console.log('\nzero state → hidden (total 0, empty buckets)');
test('all-healthy fleet + no activity → total 0', () => {
  const r = roll(health({ healthy: [agent('a1'), agent('a2')] }), stats());
  assert.equal(r.total, 0);
  assert.deepEqual(r.critical, []);
  assert.deepEqual(r.warning, []);
  assert.equal(r.directives, 0);
  assert.equal(r.errors, 0);
});

console.log('\neach bucket contributes to the total');
test('a critical agent → total 1', () => {
  const r = roll(health({ critical: [agent('a1')] }), stats());
  assert.equal(r.total, 1);
});
test('a warning agent → total 1', () => {
  const r = roll(health({ warning: [agent('a1')] }), stats());
  assert.equal(r.total, 1);
});
test('3 pending directives → total 3', () => {
  const r = roll(health(), stats({ directive_proposed: 3 }));
  assert.equal(r.total, 3);
  assert.equal(r.directives, 3);
});
test('2 recent errors → total 2', () => {
  const r = roll(health(), stats({ error: 2 }));
  assert.equal(r.total, 2);
  assert.equal(r.errors, 2);
});

console.log('\nfull formula: critical + warning + directives + errors');
test('mixed buckets sum exactly', () => {
  const r = roll(
    health({ critical: [agent('c1'), agent('c2')], warning: [agent('w1')] }),
    stats({ directive_proposed: 4, error: 5 }),
  );
  assert.equal(r.total, 2 + 1 + 4 + 5);
  assert.equal(r.critical.length, 2);
  assert.equal(r.warning.length, 1);
  assert.equal(r.directives, 4);
  assert.equal(r.errors, 5);
});

console.log('\ncritical/warning expose the GROUP ARRAYS (for deep-link rows), not just counts');
test('critical agents are returned in order for row rendering', () => {
  const c = [agent('c1'), agent('c2')];
  const r = roll(health({ critical: c }), stats());
  assert.deepEqual(r.critical, c);
});

console.log('\nhealthy/idle/unknown agents never count (only critical + warning are attention)');
test('a healthy agent contributes nothing even with errors elsewhere', () => {
  const r = roll(health({ healthy: [agent('h1')], idle: [agent('i1')], unknown: [agent('u1')] }), stats());
  assert.equal(r.total, 0);
});

console.log('\nnull / partial inputs degrade gracefully (no crash — AC: error/empty/loading states)');
test('null health + null stats → empty rollup', () => {
  const r = roll(null, null);
  assert.equal(r.total, 0);
  assert.deepEqual(r.critical, []);
});
test('health present, stats null → only health buckets counted', () => {
  const r = roll(health({ critical: [agent('c1')] }), null);
  assert.equal(r.total, 1);
  assert.equal(r.directives, 0);
  assert.equal(r.errors, 0);
});
test('stats present, health null → only activity counted', () => {
  const r = roll(null, stats({ directive_proposed: 2, error: 1 }));
  assert.equal(r.total, 3);
});
test('health missing the groups object entirely → empty buckets, no throw', () => {
  const r = buildAttentionRollup({}, stats({ error: 1 }));
  assert.equal(r.total, 1);
  assert.deepEqual(r.critical, []);
});
test('health with groups but no critical/warning keys → empty buckets, no throw', () => {
  const r = buildAttentionRollup({ groups: { healthy: [agent('h1')] } }, stats());
  assert.equal(r.total, 0);
});

console.log('\nmissing/non-numeric activity counts are quiet, never NaN');
test('stats missing directive_proposed/error keys → treated as 0', () => {
  const r = buildAttentionRollup(health(), {});
  assert.equal(r.directives, 0);
  assert.equal(r.errors, 0);
  assert.equal(r.total, 0);
});
test('NaN / string counts cannot reach the total', () => {
  const r = buildAttentionRollup(health(), { directive_proposed: NaN, error: 'oops' });
  assert.equal(r.directives, 0);
  assert.equal(r.errors, 0);
  assert.equal(r.total, 0);
});
test('numeric strings ARE coerced (defensive, matches Number(x) || 0)', () => {
  const r = buildAttentionRollup(health(), { directive_proposed: '3', error: 0 });
  assert.equal(r.directives, 3);
  assert.equal(r.total, 3);
});

console.log('\nEMPTY_ATTENTION_ROLLUP constant is a valid hidden zero state');
test('EMPTY_ATTENTION_ROLLUP has total 0 and empty arrays', () => {
  assert.equal(EMPTY_ATTENTION_ROLLUP.total, 0);
  assert.deepEqual(EMPTY_ATTENTION_ROLLUP.critical, []);
  assert.deepEqual(EMPTY_ATTENTION_ROLLUP.warning, []);
  assert.deepEqual(EMPTY_ATTENTION_ROLLUP.stuck, []);
  assert.deepEqual(EMPTY_ATTENTION_ROLLUP.waiting, []);
});

console.log('\npane-state buckets (WARDEN-344): stuck/erroring/waiting/blocked fold into the rollup');
test('the two-arg call shape still works (no agentStates) — backward compatible', () => {
  const r = buildAttentionRollup(health({ critical: [agent('c1')] }), stats());
  assert.equal(r.total, 1);
  assert.deepEqual(r.stuck, []);
  assert.deepEqual(r.waiting, []);
});
test('a stuck agent → total 1 and a stuck bucket row', () => {
  const r = roll(health(), stats(), [stateRow('s1', 'stuck')]);
  assert.equal(r.total, 1);
  assert.equal(r.stuck.length, 1);
  assert.equal(r.stuck[0].id, 's1');
});
test('each pane state lands in its own bucket', () => {
  const r = roll(health(), stats(), [
    stateRow('s1', 'stuck'), stateRow('e1', 'erroring'),
    stateRow('w1', 'waiting'), stateRow('b1', 'blocked'),
  ]);
  assert.equal(r.stuck.length, 1);
  assert.equal(r.erroring.length, 1);
  assert.equal(r.waiting.length, 1);
  assert.equal(r.blocked.length, 1);
  assert.equal(r.total, 4);
});
test('capture_failed rows are NOT counted (already surfaced as CRITICAL/CLOSED by /api/health)', () => {
  const r = roll(health(), stats(), [stateRow('d1', 'capture_failed')]);
  assert.equal(r.total, 0, 'capture_failed is not an attention bucket');
  assert.deepEqual(r.stuck, []);
});
test('sweep_skipped rows are NOT counted (WARDEN-571: hidden host the cost gate never probed)', () => {
  // The fleet sweep returns sweep_skipped for non-companion / LOCAL hosts it must not
  // SSH-probe. It must NEVER surface as needs-attention (the honest "didn't look here"
  // signal), even alongside a real stuck agent — only the real attention row counts.
  const r = roll(health(), stats(), [
    stateRow('skip1', 'sweep_skipped', { sweepSkipped: true }),
    stateRow('stuck1', 'stuck'),
  ]);
  assert.equal(r.total, 1, 'only the stuck agent counts; sweep_skipped is not a bucket');
  assert.deepEqual(r.stuck.map((a) => a.id), ['stuck1']);
  // A sweep_skipped row folded in by itself contributes nothing.
  assert.equal(roll(health(), stats(), [stateRow('skip1', 'sweep_skipped')]).total, 0);
});
test('active/idle rows are NOT counted (no attention needed)', () => {
  const r = roll(health(), stats(), [stateRow('a1', 'active'), stateRow('i1', 'idle')]);
  assert.equal(r.total, 0);
});
test('stuck/erroring contribute to total ALONGSIDE critical/warning/directives/errors', () => {
  const r = roll(
    health({ critical: [agent('c1')], warning: [agent('w1')] }),
    stats({ directive_proposed: 2, error: 1 }),
    [stateRow('s1', 'stuck'), stateRow('e1', 'erroring')],
  );
  assert.equal(r.total, 1 + 1 + 2 + 1 + 1 + 1);
});
test('null agentStates degrades to empty buckets (no crash)', () => {
  const r = roll(health({ critical: [agent('c1')] }), stats(), null);
  assert.equal(r.total, 1);
  assert.deepEqual(r.stuck, []);
});
test('stuck/erroring rows carry their signal for the badge detail row', () => {
  const r = roll(health(), stats(), [stateRow('s1', 'stuck', { signal: 'repeating line' })]);
  assert.equal(r.stuck[0].signal, 'repeating line');
});

console.log('\nper-state toggle (WARDEN-344): a silenced state contributes neither rows nor total');
test('silencing "waiting" drops it from the bucket and the total', () => {
  const r = roll(health(), stats(),
    [stateRow('w1', 'waiting'), stateRow('e1', 'erroring')],
    { enabledStates: { waiting: false } });
  assert.equal(r.waiting.length, 0, 'waiting silenced → empty bucket');
  assert.equal(r.erroring.length, 1, 'erroring still surfaces');
  assert.equal(r.total, 1, 'only erroring counts');
});
test('silencing "waiting" keeps "erroring" (a noisy waiting does not mask errors)', () => {
  const r = roll(health(), stats(),
    [stateRow('w1', 'waiting'), stateRow('e1', 'erroring')],
    { enabledStates: { waiting: false, erroring: true } });
  assert.equal(r.total, 1);
});
test('omitting enabledStates surfaces every state (default ON)', () => {
  const r = roll(health(), stats(), [stateRow('w1', 'waiting')]);
  assert.equal(r.waiting.length, 1);
  assert.equal(r.total, 1);
});
test('enabledStates does not touch the inactivity buckets (critical/warning unaffected)', () => {
  const r = roll(health({ critical: [agent('c1')] }), stats(), [],
    { enabledStates: { stuck: false, erroring: false, waiting: false, blocked: false } });
  assert.equal(r.critical.length, 1);
  assert.equal(r.total, 1);
});

console.log('\nrankAttention (WARDEN-384): flatten the rollup into ONE directed "you\'re needed HERE, because X" answer');
test('top is the highest-urgency pane, ranked follows urgency', () => {
  const r = roll(health(), stats(), [
    stateRow('w1', 'waiting', { signal: 'press enter' }),
    stateRow('s1', 'stuck', { signal: 'repeating line' }),
  ]);
  const { top, ranked } = rankAttention(r);
  assert.equal(top.id, 'w1', 'waiting is highest urgency → top');
  assert.equal(top.state, 'waiting');
  assert.equal(top.signal, 'press enter', 'the concrete "because X" is carried through');
  assert.deepEqual(ranked.map((x) => x.id), ['w1', 's1']);
});
test('a waiting-on-you pane ranks above a merely stuck one (even when stuck is listed first)', () => {
  const r = roll(health(), stats(), [
    stateRow('s1', 'stuck', { signal: 'repeating line' }),
    stateRow('w1', 'waiting', { signal: 'please respond' }),
  ]);
  const { top } = rankAttention(r);
  assert.equal(top.id, 'w1', 'waiting outranks stuck');
  assert.notEqual(top.state, 'stuck');
});
test('an empty rollup (total 0) has no directed top', () => {
  const { top, ranked } = rankAttention(roll(health(), stats()));
  assert.equal(top, null);
  assert.deepEqual(ranked, []);
});
test('EMPTY_ATTENTION_ROLLUP has no directed top', () => {
  const { top } = rankAttention(EMPTY_ATTENTION_ROLLUP);
  assert.equal(top, null);
});
test('a silenced state can never become top (silenced waiting → next-highest wins)', () => {
  // waiting would normally win, but buildAttentionRollup silences it upstream (empty
  // bucket), so the next-highest pane becomes the directed answer.
  const r = roll(health(), stats(),
    [stateRow('w1', 'waiting'), stateRow('s1', 'stuck')],
    { enabledStates: { waiting: false } });
  const { top } = rankAttention(r);
  assert.equal(r.waiting.length, 0, 'waiting silenced upstream → empty bucket');
  assert.notEqual(top.state, 'waiting');
  assert.equal(top.id, 's1');
});
test('ties (same urgency tier) resolve in input order, deterministically', () => {
  const r = roll(health(), stats(), [stateRow('w1', 'waiting'), stateRow('w2', 'waiting'), stateRow('w3', 'waiting')]);
  const a = rankAttention(r);
  const b = rankAttention(r);
  assert.deepEqual(a.ranked.map((x) => x.id), ['w1', 'w2', 'w3'], 'same-tier order preserved');
  assert.deepEqual(a.ranked, b.ranked, 'stable across calls');
  assert.equal(a.top.id, 'w1');
});
test('below the waiting bias, the encoded precedence holds (erroring > stuck > blocked)', () => {
  const r = roll(health(), stats(), [
    stateRow('b1', 'blocked'), stateRow('s1', 'stuck'), stateRow('e1', 'erroring'),
  ]);
  const { ranked } = rankAttention(r);
  assert.deepEqual(ranked.map((x) => x.state), ['erroring', 'stuck', 'blocked']);
});
test('health agents rank alongside pane states (stuck > critical > blocked > warning)', () => {
  const r = roll(
    health({ critical: [agent('c1')], warning: [agent('warn1')] }),
    stats(),
    [stateRow('b1', 'blocked'), stateRow('s1', 'stuck')],
  );
  const { ranked } = rankAttention(r);
  assert.deepEqual(ranked.map((x) => x.id), ['s1', 'c1', 'b1', 'warn1']);
});
test('only directives/errors counts (no pane) → no directed top (counts have no pane to deep-link)', () => {
  const r = roll(health(), stats({ directive_proposed: 3, error: 2 }));
  assert.equal(r.total, 5);
  const { top, ranked } = rankAttention(r);
  assert.equal(top, null);
  assert.deepEqual(ranked, []);
});
test('top identity uses key || id so the deep-link opens the correct pane', () => {
  const r = roll(health(), stats(), [
    stateRow('raw-id', 'waiting', { key: 'pane-key', name: 'My Agent', signal: 'hi' }),
  ]);
  const { top } = rankAttention(r);
  assert.equal(top.id, 'pane-key', 'id is the key when present (matches the badge row keying)');
  assert.equal(top.name, 'My Agent');
});

console.log('\npickCalloutTop (WARDEN-482): the directed callout never promotes the pane the human is reading');
// The popover's "you're needed HERE" callout is focus-EXCLUDED: the entrant matching
// focusedPaneKey is skipped, so the callout promotes the NEXT needful pane. The rundown
// (`ranked`) still lists the focused pane — only the PROMOTED answer changes. Applied
// locally here (NOT in shared rankAttention, which also feeds the ungated return banner).
test('focusedPaneKey null → returns ranked[0] (bit-for-bit the old `top`)', () => {
  const r = roll(health(), stats(), [stateRow('w1', 'waiting'), stateRow('s1', 'stuck')]);
  const { ranked } = rankAttention(r);
  assert.deepEqual(ranked.map((x) => x.id), ['w1', 's1']);
  assert.equal(pickCalloutTop(ranked, null)?.id, 'w1', 'no focus → promote the top');
  assert.equal(pickCalloutTop(ranked, undefined)?.id, 'w1', 'undefined focus → promote the top');
});
test('focused on the TOP-ranked pane → callout promotes the NEXT needful pane (not the one being read)', () => {
  const r = roll(health(), stats(), [stateRow('w1', 'waiting'), stateRow('s1', 'stuck')]);
  const { ranked } = rankAttention(r);
  assert.equal(pickCalloutTop(ranked, 'w1')?.id, 's1', 'w1 is focused → promote s1');
});
test('focused on a NON-top ranked pane → the top is still promoted (focus elsewhere does not demote it)', () => {
  const r = roll(health(), stats(), [stateRow('w1', 'waiting'), stateRow('s1', 'stuck')]);
  const { ranked } = rankAttention(r);
  assert.equal(pickCalloutTop(ranked, 's1')?.id, 'w1', 's1 focused but w1 is top → still w1');
});
test('focused on a pane NOT in the ranked list → returns ranked[0] (nothing to exclude)', () => {
  const r = roll(health(), stats(), [stateRow('w1', 'waiting'), stateRow('s1', 'stuck')]);
  const { ranked } = rankAttention(r);
  assert.equal(pickCalloutTop(ranked, 'some-other-pane')?.id, 'w1');
});
test('an empty ranked list → null (no eligible callout target)', () => {
  assert.equal(pickCalloutTop([], null), null);
  assert.equal(pickCalloutTop([], 'w1'), null);
});
test('only ONE ranked item and it is the focused pane → null (callout hides; rundown-only)', () => {
  // In the badge this is also gated by `ranked.length >= 2`, so the callout hides either
  // way — but pickCalloutTop alone correctly yields null when exclusion empties the list.
  const r = roll(health(), stats(), [stateRow('w1', 'waiting')]);
  const { ranked } = rankAttention(r);
  assert.equal(ranked.length, 1);
  assert.equal(pickCalloutTop(ranked, 'w1'), null);
});
test('the rundown is UNCHANGED by pickCalloutTop (the focused pane still lists; no information loss)', () => {
  const r = roll(health(), stats(), [stateRow('w1', 'waiting'), stateRow('s1', 'stuck'), stateRow('e1', 'erroring')]);
  const { ranked } = rankAttention(r);
  const snapshot = ranked.map((x) => x.id);
  pickCalloutTop(ranked, 'w1'); // focus on the top
  assert.deepEqual(ranked.map((x) => x.id), snapshot, 'ranked array is not mutated/filtered');
  assert.ok(snapshot.includes('w1'), 'the focused pane is still listed in the rundown');
});
test('identity is the SAME key || id space as rankAttention (a keyed row is excluded by its key)', () => {
  const r = roll(health(), stats(), [
    stateRow('raw-id', 'waiting', { key: 'pane-key', name: 'My Agent' }),
    stateRow('s1', 'stuck'),
  ]);
  const { ranked } = rankAttention(r);
  assert.equal(ranked[0].id, 'pane-key', 'id is the key when present');
  assert.equal(pickCalloutTop(ranked, 'pane-key')?.id, 's1', 'excluded by key, not raw id');
  assert.equal(pickCalloutTop(ranked, 'raw-id')?.id, 'pane-key', 'raw-id does not match → top stays');
});

console.log('\nattentionReason (WARDEN-436): the "because X" line, shared by the popover + return-banner callouts');
// Minimal AttentionItem builder — attentionReason only reads id/state/signal, so the
// name is irrelevant to these cases.
const item = (state, extra = {}) => ({ id: 'x', state, ...extra });
test('a concrete signal is the reason (the triggering line / matched prompt)', () => {
  assert.equal(attentionReason(item('waiting', { signal: 'press enter to continue' })), 'press enter to continue');
});
test('no signal → state-keyed fallback phrased as "why it needs you"', () => {
  assert.equal(attentionReason(item('waiting')), 'waiting for your input');
  assert.equal(attentionReason(item('erroring')), 'emitting errors');
  assert.equal(attentionReason(item('stuck')), 'stuck in a loop');
  assert.equal(attentionReason(item('blocked')), 'blocked on another agent');
});
test('health-group agents (critical/warning, no signal of their own) get their fallback', () => {
  assert.equal(attentionReason(item('critical')), 'critical health');
  assert.equal(attentionReason(item('warning')), 'needs attention');
});
test('an empty-string signal is treated as absent (not a useful reason) → fallback', () => {
  assert.equal(attentionReason(item('stuck', { signal: '' })), 'stuck in a loop');
});
test('unknown state + no signal → generic default', () => {
  assert.equal(attentionReason(item('mystery')), 'needs attention');
});
test('a real ranked top carries its signal through attentionReason (integration)', () => {
  const r = roll(health(), stats(), [stateRow('w1', 'waiting', { signal: 'awaiting your decision' })]);
  const { top } = rankAttention(r);
  assert.equal(attentionReason(top), 'awaiting your decision');
});

console.log('\nhasReturnContent (WARDEN-436): the return banner fires on activity OR a ranked top');
test('no activity and no ranked top → nothing to surface (banner hidden)', () => {
  assert.equal(hasReturnContent(0, null), false);
});
test('activity events since close → surface (the original total>0 gate)', () => {
  assert.equal(hasReturnContent(5, null), true);
});
test('no activity but a ranked top → surface (the broadened gate — agent needs you NOW)', () => {
  assert.equal(hasReturnContent(0, item('waiting')), true);
});
test('both activity and a ranked top → surface', () => {
  assert.equal(hasReturnContent(3, item('stuck')), true);
});
test('the broadened gate is what unblocks the stuck-with-zero-events case', () => {
  // An agent that became stuck/waiting/critical AFTER close with ZERO directives or
  // errors since close: total 0, but top != null. The OLD gate (total>0 only) hid
  // the banner entirely; hasReturnContent surfaces it.
  const r = roll(health(), stats(), [stateRow('s1', 'stuck', { signal: 'repeating line' })]);
  assert.equal(r.total, 1, 'rollup total reflects the stuck pane');
  const { top } = rankAttention(r);
  assert.notEqual(top, null);
  assert.equal(hasReturnContent(0, top), true, 'zero activity events, but ranked top → still surface');
});

// ─── user-authored output-pattern alerts (WARDEN-540) ─────────────────────────
const cm = (pattern, line) => ({ pattern, line });

console.log('\nbuildAttentionRollup: a customMatch row is its own bucket, excluded from state buckets (no double-count)');
test('a row with customMatch lands in the custom bucket', () => {
  const r = roll(health(), stats(), [stateRow('d1', 'idle', { customMatch: cm('Deploy', 'deploy failed') })]);
  assert.equal(r.custom.length, 1);
  assert.equal(r.custom[0].id, 'd1');
});
test('a customMatch row is EXCLUDED from the state buckets (each pane counted once)', () => {
  // This pane is BOTH erroring AND matches a custom pattern. It must appear in the
  // custom bucket ONLY — not also in erroring — so total and ranked stay correct.
  const r = roll(health(), stats(), [stateRow('d1', 'erroring', { signal: 'err', customMatch: cm('Deploy', 'deploy failed') })]);
  assert.equal(r.custom.length, 1);
  assert.equal(r.erroring.length, 0, 'the custom-matched pane is not also counted as erroring');
  assert.equal(r.total, 1, 'total counts the pane exactly once');
});
test('a non-custom erroring pane is unaffected (still in erroring)', () => {
  // Regression guard: the custom exclusion must not bleed into ordinary state rows.
  const r = roll(health(), stats(), [stateRow('e1', 'erroring', { signal: 'boom' })]);
  assert.equal(r.erroring.length, 1);
  assert.equal(r.custom.length, 0);
});
test('no customMatch anywhere → custom bucket empty (identical to today)', () => {
  const r = roll(health(), stats(), [stateRow('s1', 'stuck'), stateRow('e1', 'erroring')]);
  assert.equal(r.custom.length, 0);
  assert.equal(r.total, 2);
});

console.log('\nrankAttention: a custom row is a directed "because X" item carrying the matching line + pattern');
test('a custom row → AttentionItem state "custom" with line + pattern in the signal', () => {
  const r = roll(health(), stats(), [stateRow('d1', 'idle', { customMatch: cm('Deploy', 'deploy failed') })]);
  const { ranked } = rankAttention(r);
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0].state, 'custom', 'state is "custom", NOT the pane\'s underlying "idle"');
  assert.match(ranked[0].signal, /deploy failed/);
  assert.match(ranked[0].signal, /Deploy/);
});
test('a custom match (88) outranks a stuck pane (80) in the directed callout', () => {
  const r = roll(health(), stats(), [
    stateRow('s1', 'stuck', { signal: 'looping' }),
    stateRow('d1', 'idle', { customMatch: cm('Deploy', 'deploy failed') }),
  ]);
  const { top } = rankAttention(r);
  assert.equal(top.state, 'custom', 'the user-authored signal is the directed answer over a generic stuck pane');
});
test('attentionReason phrases a custom item (fallback when no signal)', () => {
  // A custom item with a null signal (defensive) still reads as a complete reason.
  assert.equal(attentionReason({ id: 'd1', name: 'd1', state: 'custom', signal: null }), 'matched a watch pattern');
});

console.log(`\n✓ ATTENTION ROLLUP TESTS PASS (${passed})`);
