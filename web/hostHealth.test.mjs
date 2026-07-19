// Tests for groupByHost + compareHostGroups — the pure host-bucketing behind the
// Fleet Health Dashboard's "Group by: Host" view (WARDEN-237) — and the parallel
// groupByProject + compareProjectGroups for "Group by: Project" (WARDEN-741).
//
// No front-end test runner in this repo, so (like attentionRollup.test.mjs) this
// loads the REAL src/lib/healthUtils.ts (transpiled TS -> ESM via Vite's OXC
// transform) and exercises it with plain objects. The `import type { Chat }` in
// that file is erased at transpile time, so the emitted module is import-free and
// loads standalone.
//
// groupByHost: buckets agents by host, tallies each health state per host,
// preserves input order within a host, and never throws on partial data.
// compareHostGroups: degraded-first ordering — offline hosts first, then
// critical-heavy, then by agent count, then host name (stable).
//
// Run: node hostHealth.test.mjs   (or: npm test, from web/)
import { transformWithOxc } from 'vite';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const helperPath = resolve(__dirname, 'src/lib/healthUtils.ts');

// --- Load the REAL healthUtils.ts (TS -> ESM via the OXC transform Vite bundles) ----
const src = readFileSync(helperPath, 'utf8');
const { code } = await transformWithOxc(src, helperPath, {});
const tmpDir = mkdtempSync(join(tmpdir(), 'warden-hostHealth-test-'));
const tmpFile = join(tmpDir, 'healthUtils.mjs');
writeFileSync(tmpFile, code);
const { groupByHost, compareHostGroups, groupByProject, compareProjectGroups, summarizeProjectHosts, summarizeHostLoad, resourceTone } = await import(tmpFile);
rmSync(tmpDir, { recursive: true, force: true });

let passed = 0;
const test = (name, fn) => {
  fn();
  passed += 1;
  console.log('  ok -', name);
};

// Builders so each case reads as "which agents" not a wall of literals.
const agent = (id, extra = {}) => ({ id, key: id, name: id, host: '(local)', ...extra });

console.log('\ngroupByHost: empty / single-host bucketing');
test('no agents -> no groups', () => {
  assert.deepEqual(groupByHost([]), []);
});
test('one host -> one group with a correct tally', () => {
  const groups = groupByHost([
    agent('a1', { healthState: 'healthy' }),
    agent('a2', { healthState: 'critical' }),
    agent('a3', { healthState: 'healthy' }),
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].host, '(local)');
  assert.equal(groups[0].agents.length, 3);
  // `closed` has been part of HostHealthCounts since WARDEN-245; the tally
  // always carries it (here 0). Asserted explicitly so a future state addition
  // doesn't silently drop out of the expected shape.
  assert.deepEqual(groups[0].counts, { healthy: 2, warning: 0, critical: 1, idle: 0, closed: 0, unknown: 0 });
});

console.log('\ngroupByHost: multi-host separation');
test('agents split by host, each with its own tally', () => {
  const groups = groupByHost([
    agent('a1', { host: 'build', healthState: 'healthy' }),
    agent('a2', { host: 'build', healthState: 'idle' }),
    agent('a3', { host: 'gpu-1', healthState: 'critical' }),
  ]);
  assert.equal(groups.length, 2);
  const build = groups.find((g) => g.host === 'build');
  const gpu = groups.find((g) => g.host === 'gpu-1');
  assert.equal(build.agents.length, 2);
  assert.equal(build.counts.healthy, 1);
  assert.equal(build.counts.idle, 1);
  assert.equal(gpu.counts.critical, 1);
});

console.log('\ngroupByHost: robust to missing / garbage health state');
test('undefined healthState counts as unknown', () => {
  const [g] = groupByHost([agent('a1')]);
  assert.equal(g.counts.unknown, 1);
  assert.equal(g.counts.healthy, 0);
});
test('garbage healthState counts as unknown, not crash', () => {
  const [g] = groupByHost([agent('a1', { healthState: 'on-fire' })]);
  assert.equal(g.counts.unknown, 1);
});
test('missing host falls back to (local)', () => {
  const [g] = groupByHost([{ id: 'a1', healthState: 'healthy' }]);
  assert.equal(g.host, '(local)');
});

console.log('\ngroupByHost: preserves input order within a host');
test('agent order within a host is insertion order', () => {
  const [g] = groupByHost([
    agent('first', { healthState: 'critical' }),
    agent('second', { healthState: 'healthy' }),
  ]);
  assert.deepEqual(g.agents.map((a) => a.id), ['first', 'second']);
});

// --- groupByProject: project bucketing (WARDEN-741) ---
// Mirrors the groupByHost block above on the project axis: bucket by project,
// tally per-health-state via normalizeHealthState, preserve input order, never
// throw on partial data. The project analog of groupByHost's '(local)' host
// fallback is '(no project)'.

console.log('\ngroupByProject: empty / single-project bucketing');
test('no agents -> no groups', () => {
  assert.deepEqual(groupByProject([]), []);
});
test('one project -> one group with a correct tally', () => {
  const groups = groupByProject([
    agent('a1', { project: 'warden', healthState: 'healthy' }),
    agent('a2', { project: 'warden', healthState: 'critical' }),
    agent('a3', { project: 'warden', healthState: 'healthy' }),
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].project, 'warden');
  assert.equal(groups[0].agents.length, 3);
  // Full counts shape asserted explicitly (mirrors the groupByHost case above) so
  // a future health-state addition never silently drops out of the expected shape.
  assert.deepEqual(groups[0].counts, { healthy: 2, warning: 0, critical: 1, idle: 0, closed: 0, unknown: 0 });
});

console.log('\ngroupByProject: multi-project separation');
test('agents split by project, each with its own tally', () => {
  const groups = groupByProject([
    agent('a1', { project: 'warden', healthState: 'healthy' }),
    agent('a2', { project: 'warden', healthState: 'idle' }),
    agent('a3', { project: 'warden-telemetry', healthState: 'critical' }),
  ]);
  assert.equal(groups.length, 2);
  const warden = groups.find((g) => g.project === 'warden');
  const telemetry = groups.find((g) => g.project === 'warden-telemetry');
  assert.equal(warden.agents.length, 2);
  assert.equal(warden.counts.healthy, 1);
  assert.equal(warden.counts.idle, 1);
  assert.equal(telemetry.counts.critical, 1);
});

console.log('\ngroupByProject: robust to missing / garbage health state');
test('undefined healthState counts as unknown', () => {
  const [g] = groupByProject([agent('a1', { project: 'warden' })]);
  assert.equal(g.counts.unknown, 1);
  assert.equal(g.counts.healthy, 0);
});
test('garbage healthState counts as unknown, not crash', () => {
  const [g] = groupByProject([agent('a1', { project: 'warden', healthState: 'on-fire' })]);
  assert.equal(g.counts.unknown, 1);
});
test('missing project falls back to (no project)', () => {
  const [g] = groupByProject([{ id: 'a1', healthState: 'healthy' }]);
  assert.equal(g.project, '(no project)');
});

console.log('\ngroupByProject: preserves input order within a project');
test('agent order within a project is insertion order', () => {
  const [g] = groupByProject([
    agent('first', { project: 'warden', healthState: 'critical' }),
    agent('second', { project: 'warden', healthState: 'healthy' }),
  ]);
  assert.deepEqual(g.agents.map((a) => a.id), ['first', 'second']);
});

// --- compareHostGroups: degraded-first ordering ---
const none = () => undefined;                              // no connectivity record
const offlineDown = (h) => (h === 'down' ? 'offline' : 'online');

console.log('\ncompareHostGroups: offline hosts surface first');
test('offline host ranks above online host', () => {
  const online = groupByHost([agent('a1', { host: 'up', healthState: 'healthy' })])[0];
  const down = groupByHost([agent('a2', { host: 'down', healthState: 'healthy' })])[0];
  const sorted = [online, down].sort((a, b) => compareHostGroups(a, b, offlineDown));
  assert.deepEqual(sorted.map((g) => g.host), ['down', 'up']);
});

console.log('\ncompareHostGroups: critical-heavy hosts next');
test('more critical agents ranks above fewer (both online)', () => {
  const light = groupByHost([agent('a1', { host: 'h1', healthState: 'healthy' })])[0];
  const heavy = groupByHost([
    agent('a2', { host: 'h2', healthState: 'critical' }),
    agent('a3', { host: 'h2', healthState: 'critical' }),
  ])[0];
  const sorted = [light, heavy].sort((a, b) => compareHostGroups(a, b, none));
  assert.deepEqual(sorted.map((g) => g.host), ['h2', 'h1']);
});

console.log('\ncompareHostGroups: agent count, then host name (stable tiebreak)');
test('bigger host ranks above smaller (no critical, both online)', () => {
  const big = groupByHost([
    agent('a1', { host: 'big', healthState: 'healthy' }),
    agent('a2', { host: 'big', healthState: 'healthy' }),
  ])[0];
  const small = groupByHost([agent('a3', { host: 'small', healthState: 'healthy' })])[0];
  const sorted = [small, big].sort((a, b) => compareHostGroups(a, b, none));
  assert.deepEqual(sorted.map((g) => g.host), ['big', 'small']);
});
test('identical priority falls back to host name (deterministic)', () => {
  const z = groupByHost([agent('a1', { host: 'zebra', healthState: 'healthy' })])[0];
  const a = groupByHost([agent('a2', { host: 'alpha', healthState: 'healthy' })])[0];
  const sorted = [z, a].sort((x, y) => compareHostGroups(x, y, none));
  assert.deepEqual(sorted.map((g) => g.host), ['alpha', 'zebra']);
});

console.log('\ncompareHostGroups: unknown connectivity is NOT prioritized as offline');
test('offline host outranks unknown-connectivity host even when the unknown one is critical-heavy', () => {
  // The decisive guard for "unknown is neutral, not offline". An OFFLINE host
  // with ZERO critical agents must still rank ABOVE an unknown-connectivity host
  // that HAS a critical agent — because offline (priority 0) precedes unknown
  // (priority 1). A buggy sort that treated `undefined` connectivity as offline
  // would TIE the two hosts on the offline axis and then promote the
  // critical-heavy unknown host first — so this assertion FLIPS under that bug
  // and only holds when unknown is genuinely neutral. (The earlier "more
  // critical agents ranks above fewer" case already covers critical-heavy
  // ordering among same-tier hosts; this one isolates the unknown-vs-offline
  // axis, which the prior version of this test could not — it seeded BOTH hosts
  // with unknown connectivity, so even the buggy sort produced the same order.)
  const offlineHost = groupByHost([agent('a1', { host: 'down', healthState: 'healthy' })])[0];
  const unknownHost = groupByHost([agent('a2', { host: 'mystery', healthState: 'critical' })])[0];
  const offlineOnly = (h) => (h === 'down' ? 'offline' : undefined);
  const sorted = [unknownHost, offlineHost].sort((a, b) => compareHostGroups(a, b, offlineOnly));
  assert.deepEqual(sorted.map((g) => g.host), ['down', 'mystery']);
});

// --- compareProjectGroups: degraded-first ordering (WARDEN-741, extended WARDEN-780) ---
// Same priority ladder as compareHostGroups, now INCLUDING the connectivity axis
// (WARDEN-780): a project with ANY agent on an offline host sorts first (a
// project spans hosts, so the signal is "any host offline" not a single status),
// then critical-heavy, then agent count, then project name (stable). The
// existing 2-arg cases below exercise the LOWER ladder via the default
// connectivityOf (always undefined -> no project has an offline host -> the
// offline axis is inert), so they keep asserting the pre-WARDEN-780 ordering
// unchanged.

console.log('\ncompareProjectGroups: critical-heavy projects first');
test('more critical agents ranks above fewer', () => {
  const light = groupByProject([agent('a1', { project: 'p1', healthState: 'healthy' })])[0];
  const heavy = groupByProject([
    agent('a2', { project: 'p2', healthState: 'critical' }),
    agent('a3', { project: 'p2', healthState: 'critical' }),
  ])[0];
  const sorted = [light, heavy].sort(compareProjectGroups);
  assert.deepEqual(sorted.map((g) => g.project), ['p2', 'p1']);
});

console.log('\ncompareProjectGroups: agent count, then project name (stable tiebreak)');
test('bigger project ranks above smaller (no critical)', () => {
  const big = groupByProject([
    agent('a1', { project: 'big', healthState: 'healthy' }),
    agent('a2', { project: 'big', healthState: 'healthy' }),
  ])[0];
  const small = groupByProject([agent('a3', { project: 'small', healthState: 'healthy' })])[0];
  const sorted = [small, big].sort(compareProjectGroups);
  assert.deepEqual(sorted.map((g) => g.project), ['big', 'small']);
});
test('identical priority falls back to project name (deterministic)', () => {
  const z = groupByProject([agent('a1', { project: 'zebra', healthState: 'healthy' })])[0];
  const a = groupByProject([agent('a2', { project: 'alpha', healthState: 'healthy' })])[0];
  const sorted = [z, a].sort(compareProjectGroups);
  assert.deepEqual(sorted.map((g) => g.project), ['alpha', 'zebra']);
});

// --- compareProjectGroups(a, b, connectivityOf): the offline-host axis (WARDEN-780) ---
// The new TOP priority: a project with ANY agent on an offline host sorts above
// an all-online project. connectivityOf returns a bare status string (the same
// shape compareHostGroups takes); 'unknown'/undefined is neutral, NOT offline.

console.log('\ncompareProjectGroups: a project with an agent on an offline host ranks first');
test('offline-spanning project ranks above an all-online project even when the online one is critical-heavy', () => {
  // The all-online project has TWO critical agents; the offline-spanning project
  // has NONE and only one agent. The offline axis is the TOP priority, so the
  // offline-spanning project must rank FIRST — a sort that put critical-heavy
  // above the offline axis would flip this.
  const allOnline = groupByProject([
    agent('a1', { project: 'online-proj', host: 'up', healthState: 'critical' }),
    agent('a2', { project: 'online-proj', host: 'up', healthState: 'critical' }),
  ])[0];
  const spansOffline = groupByProject([
    agent('a3', { project: 'offline-proj', host: 'down', healthState: 'healthy' }),
  ])[0];
  const offlineOnly = (h) => (h === 'down' ? 'offline' : 'online');
  const sorted = [allOnline, spansOffline].sort((a, b) => compareProjectGroups(a, b, offlineOnly));
  assert.deepEqual(sorted.map((g) => g.project), ['offline-proj', 'online-proj']);
});

console.log('\ncompareProjectGroups: both offline -> existing ladder decides (critical, count, name)');
test('both projects span an offline host -> falls through to critical-heavy', () => {
  // Both span a down host, so the offline axis TIES (both priority 0) and the
  // pre-existing ladder decides: more critical agents wins. Guards that the
  // offline rule is a strict prefix, not a replacement, of the ladder.
  const light = groupByProject([
    agent('a1', { project: 'light', host: 'down', healthState: 'healthy' }),
  ])[0];
  const heavy = groupByProject([
    agent('a2', { project: 'heavy', host: 'down', healthState: 'critical' }),
    agent('a3', { project: 'heavy', host: 'down', healthState: 'critical' }),
  ])[0];
  const allDown = () => 'offline';
  const sorted = [light, heavy].sort((a, b) => compareProjectGroups(a, b, allDown));
  assert.deepEqual(sorted.map((g) => g.project), ['heavy', 'light']);
});

console.log('\ncompareProjectGroups: unknown connectivity is NOT prioritized as offline');
test('offline outranks unknown even when the unknown project is critical-heavy', () => {
  // The clean isolation of the unknown-vs-offline axis (the project analog of
  // the compareHostGroups guard above). A project whose only host is OFFLINE
  // must rank above a project whose only host is UNKNOWN, EVEN when the unknown
  // one carries two critical agents and the offline one carries none. Two
  // failure modes flip this assertion:
  //   - if `undefined` were treated as offline, BOTH tie at priority 0 and the
  //     critical-heavy unknown project wins -> ['mystery', 'down-proj'];
  //   - if connectivity were ignored entirely, critical-heavy decides and the
  //     unknown project wins -> ['mystery', 'down-proj'].
  // Holds only when unknown is genuinely neutral AND the offline axis runs.
  const offlineProj = groupByProject([
    agent('a1', { project: 'down-proj', host: 'down', healthState: 'healthy' }),
  ])[0];
  const unknownHeavy = groupByProject([
    agent('a2', { project: 'mystery', host: 'mystery', healthState: 'critical' }),
    agent('a3', { project: 'mystery', host: 'mystery', healthState: 'critical' }),
  ])[0];
  const offlineOnly = (h) => (h === 'down' ? 'offline' : undefined);
  const sorted = [unknownHeavy, offlineProj].sort((a, b) => compareProjectGroups(a, b, offlineOnly));
  assert.deepEqual(sorted.map((g) => g.project), ['down-proj', 'mystery']);
});

console.log('\ncompareProjectGroups: backward-compat with no connectivity');
test('connectivityOf always undefined -> matches the old (a, b) ladder (critical, count, name)', () => {
  // With no connectivity info the offline axis is inert (no project has an
  // offline host), so ordering is the pre-WARDEN-780 ladder. Verified across the
  // critical rung, and that the 2-arg default call matches the explicit
  // always-undefined call.
  const light = groupByProject([agent('a1', { project: 'p1', healthState: 'healthy' })])[0];
  const heavy = groupByProject([
    agent('a2', { project: 'p2', healthState: 'critical' }),
    agent('a3', { project: 'p2', healthState: 'critical' }),
  ])[0];
  const none = () => undefined;
  assert.deepEqual([light, heavy].sort((a, b) => compareProjectGroups(a, b, none)).map((g) => g.project), ['p2', 'p1']);
  // 2-arg call uses the default connectivityOf (() => undefined) -> identical order.
  assert.deepEqual([light, heavy].sort(compareProjectGroups).map((g) => g.project), ['p2', 'p1']);
});

// --- summarizeProjectHosts: the SET of hosts a project's agents span (WARDEN-780) ---
// One ProjectHostSpan per distinct host (with the agent.host || '(local)' fallback),
// each carrying that host's connectivity + an agent count. Ordered offline-first,
// then agentCount desc, then host name. connectivityOf returns the FULL
// HostConnectivity ({ status, latency_ms }) — or undefined — so each span carries
// latency for the render's dot title (mirrors summarizeHostLoad's "return a
// complete summary" discipline).

console.log('\nsummarizeProjectHosts: one host -> single entry, status + latency passthrough');
test('one host -> single entry with correct agentCount + status/latency passthrough', () => {
  const map = { up: { status: 'online', latency_ms: 12 } };
  const spans = summarizeProjectHosts(
    [
      agent('a1', { host: 'up', healthState: 'healthy' }),
      agent('a2', { host: 'up', healthState: 'critical' }),
    ],
    (h) => map[h],
  );
  assert.equal(spans.length, 1);
  assert.equal(spans[0].host, 'up');
  assert.equal(spans[0].status, 'online');
  assert.equal(spans[0].latency_ms, 12);
  assert.equal(spans[0].agentCount, 2);
});

console.log('\nsummarizeProjectHosts: multi-host span, offline host surfaces first');
test('agents across 3 hosts -> 3 entries, offline host first even with fewer agents', () => {
  // The decisive ordering guard: a DOWN host with only 1 agent must surface
  // BEFORE online hosts holding 3 and 2 agents. Then online hosts order by
  // agentCount desc (busy before idle). A sort that ordered by agentCount alone
  // would bury the offline host at the bottom — exactly the miss WARDEN-780 fixes.
  const map = {
    busy: { status: 'online', latency_ms: 5 },
    down: { status: 'offline', latency_ms: null },
    idle: { status: 'online', latency_ms: 20 },
  };
  const spans = summarizeProjectHosts(
    [
      agent('a1', { host: 'busy' }),
      agent('a2', { host: 'busy' }),
      agent('a3', { host: 'busy' }),
      agent('a4', { host: 'down' }),
      agent('a5', { host: 'idle' }),
      agent('a6', { host: 'idle' }),
    ],
    (h) => map[h],
  );
  assert.equal(spans.length, 3);
  assert.deepEqual(spans.map((s) => s.host), ['down', 'busy', 'idle']);
  assert.equal(spans[0].status, 'offline');
  assert.equal(spans[0].agentCount, 1);
  assert.equal(spans[1].agentCount, 3);
  assert.equal(spans[2].agentCount, 2);
  assert.equal(spans[0].latency_ms, null);
});

console.log('\nsummarizeProjectHosts: no connectivity record -> unknown (NOT offline)');
test('host with no connectivity record -> status unknown (neutral, not offline)', () => {
  const spans = summarizeProjectHosts([agent('a1', { host: 'mystery' })], () => undefined);
  assert.equal(spans.length, 1);
  assert.equal(spans[0].status, 'unknown');
  assert.equal(spans[0].latency_ms, null);
  assert.equal(spans[0].agentCount, 1);
});

console.log('\nsummarizeProjectHosts: missing agent.host -> bucketed as (local)');
test('missing agent.host -> bucketed as (local)', () => {
  // Exercises the `agent.host || '(local)'` fallback (the same fallback
  // groupByHost uses) — a raw record with NO host field lands in the (local)
  // bucket, not a hole. (Using a raw object, not the agent() builder, so the
  // host field is genuinely absent rather than pre-set to '(local)'.)
  const spans = summarizeProjectHosts([{ id: 'a1', healthState: 'healthy' }], () => undefined);
  assert.equal(spans.length, 1);
  assert.equal(spans[0].host, '(local)');
  assert.equal(spans[0].agentCount, 1);
});

console.log('\nsummarizeProjectHosts: empty / robust to partial data');
test('no agents -> empty span list', () => {
  assert.deepEqual(summarizeProjectHosts([], () => undefined), []);
});
test('partial / garbage agent data does not throw (mirrors groupByHost robustness)', () => {
  // summarizeProjectHosts reads only agent.host (falling back to '(local)'); it
  // must not throw on records missing every other field, garbage shapes, or a
  // mix. {} and {id:'x'} both lack host -> (local) bucket (2 agents); {host:'up'}
  // -> up bucket (1 agent).
  const spans = summarizeProjectHosts([{}, { host: 'up' }, { id: 'x' }], () => undefined);
  assert.equal(spans.length, 2);
  const local = spans.find((s) => s.host === '(local)');
  const up = spans.find((s) => s.host === 'up');
  assert.equal(local.agentCount, 2);
  assert.equal(up.agentCount, 1);
});

// --- summarizeHostLoad: per-host CPU/mem roll-up (WARDEN-361) ---
// avgCpu = MEAN of present cpuPct; memPct = MAX of present memPct; both null when
// no agent carries docker-stats; agentCount is every agent (the denominator).

console.log('\nsummarizeHostLoad: empty / no-stats hosts degrade to null aggregates');
test('no agents -> zero count, null cpu/mem', () => {
  assert.deepEqual(summarizeHostLoad([]), { agentCount: 0, avgCpu: null, memPct: null });
});
test('agents present but none carry stats -> null cpu/mem, count still totals', () => {
  // Bare-tmux / non-yatfa / stats-failed agents: render nothing downstream.
  const out = summarizeHostLoad([agent('a1'), agent('a2'), agent('a3')]);
  assert.equal(out.agentCount, 3);
  assert.equal(out.avgCpu, null);
  assert.equal(out.memPct, null);
});

console.log('\nsummarizeHostLoad: cpu is the MEAN of present values');
test('cpu average across agents with stats', () => {
  const out = summarizeHostLoad([
    agent('a1', { cpuPct: 40 }),
    agent('a2', { cpuPct: 60 }),
    agent('a3', { cpuPct: 20 }),
  ]);
  assert.equal(out.agentCount, 3);
  assert.equal(out.avgCpu, 40); // (40 + 60 + 20) / 3
});
test('cpu average ignores agents without a cpuPct (denominator = agents WITH stats)', () => {
  // A host where only 2 of 5 agents report cpu: the mean is over the 2, not the 5.
  const out = summarizeHostLoad([
    agent('a1', { cpuPct: 50 }),
    agent('a2', { cpuPct: 70 }),
    agent('a3'),
    agent('a4'),
    agent('a5'),
  ]);
  assert.equal(out.agentCount, 5);
  assert.equal(out.avgCpu, 60); // (50 + 70) / 2 — the 3 stats-less agents do not drag the mean
});

console.log('\nsummarizeHostLoad: mem is the MAX (not mean) — a single hog must surface');
test('mem is the max across agents (a memory hog is not averaged away)', () => {
  // 8 agents each at ~11% would average to ~11% — masking the one at 95% that OOMs.
  const out = summarizeHostLoad([
    agent('a1', { memPct: 11 }),
    agent('a2', { memPct: 12 }),
    agent('a3', { memPct: 95 }), // the actionable hog
    agent('a4', { memPct: 10 }),
  ]);
  assert.equal(out.memPct, 95);
});
test('mem max ignores agents without memPct', () => {
  const out = summarizeHostLoad([
    agent('a1', { memPct: 30 }),
    agent('a2'), // no mem data
    agent('a3', { memPct: 88 }),
  ]);
  assert.equal(out.memPct, 88);
});
test('cpu mean + mem max computed independently from a mixed host', () => {
  const out = summarizeHostLoad([
    agent('a1', { cpuPct: 10, memPct: 20 }),
    agent('a2', { cpuPct: 30, memPct: 80 }),
    agent('a3', { cpuPct: 50, memPct: 40 }),
    agent('a4'), // bare-tmux — no stats at all
  ]);
  assert.equal(out.agentCount, 4);
  assert.equal(out.avgCpu, 30); // (10 + 30 + 50) / 3
  assert.equal(out.memPct, 80); // max(20, 80, 40)
});
test('only-cpu host: mem null, cpu averaged', () => {
  const out = summarizeHostLoad([agent('a1', { cpuPct: 25 }), agent('a2', { cpuPct: 75 })]);
  assert.equal(out.avgCpu, 50);
  assert.equal(out.memPct, null);
});
test('only-mem host: cpu null, mem maxed', () => {
  const out = summarizeHostLoad([agent('a1', { memPct: 33 }), agent('a2', { memPct: 77 })]);
  assert.equal(out.avgCpu, null);
  assert.equal(out.memPct, 77);
});

console.log('\nsummarizeHostLoad: rolls up via groupByHost (mirrors the picker / header path)');
test('groupByHost + summarizeHostLoad yields one summary per host', () => {
  // The exact composition NewChatForm + HealthDashboard use: group, then summarize.
  const groups = groupByHost([
    agent('a1', { host: 'gpu-1', cpuPct: 90, memPct: 95 }),
    agent('a2', { host: 'gpu-1', cpuPct: 10, memPct: 5 }),
    agent('a3', { host: 'build', cpuPct: 40, memPct: 40 }),
  ]);
  const byHost = Object.fromEntries(groups.map((g) => [g.host, summarizeHostLoad(g.agents)]));
  assert.equal(byHost['gpu-1'].avgCpu, 50);  // (90 + 10) / 2
  assert.equal(byHost['gpu-1'].memPct, 95);  // max — the hog
  assert.equal(byHost['build'].avgCpu, 40);
  assert.equal(byHost['build'].memPct, 40);
});

// --- resourceTone: shared bands (WARDEN-309 per-agent + WARDEN-361 per-host) ---
// CPU OR mem >= 90 -> red; >= 80 -> amber (yellow); else muted. Missing = treated 0.

console.log('\nresourceTone: shared band definition (per-agent + per-host)');
test('mem >= 90 is red even when cpu is low', () => {
  assert.equal(resourceTone(5, 92), 'text-red-500');
});
test('cpu >= 90 is red even when mem is low', () => {
  assert.equal(resourceTone(95, 5), 'text-red-500');
});
test('mem >= 80 (but < 90) is amber', () => {
  assert.equal(resourceTone(5, 85), 'text-yellow-500');
});
test('cpu >= 80 (but < 90) is amber', () => {
  assert.equal(resourceTone(82, 5), 'text-yellow-500');
});
test('both below 80 is muted', () => {
  assert.equal(resourceTone(40, 50), 'text-muted-foreground');
});
test('missing fields default to 0 — never trip a band on their own', () => {
  assert.equal(resourceTone(undefined, undefined), 'text-muted-foreground');
  assert.equal(resourceTone(undefined, 95), 'text-red-500');
  assert.equal(resourceTone(88, undefined), 'text-yellow-500');
});
test('90 is inclusive (red), 80 is inclusive (amber)', () => {
  assert.equal(resourceTone(90, 0), 'text-red-500');
  assert.equal(resourceTone(0, 80), 'text-yellow-500');
});

console.log(`\n${passed} passed`);
