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
const { groupByHost, compareHostGroups } = await import(tmpFile);
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
  assert.deepEqual(groups[0].counts, { healthy: 2, warning: 0, critical: 1, idle: 0, unknown: 0 });
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

console.log(`\n${passed} passed`);
