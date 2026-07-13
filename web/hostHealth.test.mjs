// Tests for groupByHost + compareHostGroups — the pure host-bucketing behind the
// Fleet Health Dashboard's "Group by: Host" view (WARDEN-237).
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
const { groupByHost, compareHostGroups, summarizeHostLoad, resourceTone } = await import(tmpFile);
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
