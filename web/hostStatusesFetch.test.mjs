// Tests for web/src/lib/useHostStatuses.ts — the shared /api/hosts/status fetcher
// (`fetchHostStatuses`) and the query options (`HOST_STATUSES_QUERY_OPTIONS`) behind
// every host-connectivity dot. healthUtils.test.mjs pins normalizeCompanionStatus /
// shouldScheduleCheckingRetry, hostStatusesSubscriptionGuard.test.mjs pins WHO calls
// the hook, src/server-hosts-status.test.js pins the server cache vs POLL_MS — but the
// fetcher's own wire->map normalization and the options' cadence/background policy had
// no reference in any suite.
// HARNESS: the REAL module is transpiled with vite's transformWithOxc; `@tanstack/react-query`
// -> inert shim, `@/lib/api` -> fake fetchBounded/pollerFetchOptions, `@/lib/healthUtils` -> the
// REAL transpiled healthUtils. Every rewrite is ASSERTED.
// Run: node hostStatusesFetch.test.mjs   (or: npm test, from web/)
import { transformWithOxc } from 'vite';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const tmpDir = mkdtempSync(join(__dirname, '.host-statuses-fetch-test-'));

writeFileSync(join(tmpDir, 'tanstack-shim.mjs'), `
export const useQuery = () => { throw new Error('hook not exercised by this suite'); };
export const useQueryClient = () => { throw new Error('hook not exercised by this suite'); };
`);
writeFileSync(join(tmpDir, 'api-shim.mjs'), `
export const calls = { fetch: [], optionsFor: [] };
export const sentinel = { retries: 0, timeoutMs: 15000, tag: 'poller-options-sentinel' };
export const control = { impl: async () => { throw new Error('fetchBounded not configured'); } };
export function pollerFetchOptions(periodMs) { calls.optionsFor.push(periodMs); return sentinel; }
export function fetchBounded(url, opts) { calls.fetch.push([url, opts]); return control.impl(url, opts); }
`);

const emit = async (srcRel, outName, map) => {
  const p = resolve(__dirname, srcRel);
  const { code } = await transformWithOxc(readFileSync(p, 'utf8'), p, {});
  let out = code;
  for (const [from, to] of Object.entries(map)) {
    const before = out;
    out = out.replaceAll(`"${from}"`, `"${to}"`).replaceAll(`'${from}'`, `'${to}'`);
    if (before === out) assert.fail(`specifier rewrite ${from} -> ${to} did not land in ${srcRel}`);
  }
  assert.ok(!/from ['"]@/.test(out), `${srcRel} still has an unrewritten @ import`);
  writeFileSync(join(tmpDir, outName), out);
};
await emit('src/lib/healthUtils.ts', 'healthUtils.mjs', {});
await emit('src/lib/useHostStatuses.ts', 'useHostStatuses.mjs', {
  '@tanstack/react-query': './tanstack-shim.mjs',
  '@/lib/healthUtils': './healthUtils.mjs',
  '@/lib/api': './api-shim.mjs',
});
const { fetchHostStatuses, HOST_STATUSES_QUERY_OPTIONS, HOST_STATUSES_KEY } = await import(join(tmpDir, 'useHostStatuses.mjs'));
const { calls, sentinel, control } = await import(join(tmpDir, 'api-shim.mjs'));
const moduleLoadOptionsFor = [...calls.optionsFor]; // pollerFetchOptions runs once at module load
rmSync(tmpDir, { recursive: true, force: true });

const POLL_MS = 30_000;
const respond = (json, status = 200) => async () => ({ ok: status >= 200 && status < 300, status, json: async () => json });
const run = async (json, status) => { calls.fetch.length = 0; control.impl = respond(json, status); return fetchHostStatuses(); };

test('cache key and poller options derive from the 30s cadence', () => {
  assert.equal(HOST_STATUSES_KEY, 'host-statuses');
  assert.deepEqual(moduleLoadOptionsFor, [POLL_MS]);
});
test('GETs /api/hosts/status through fetchBounded with the poller options (by identity)', async () => {
  await run({ hosts: [] });
  assert.equal(calls.fetch.length, 1);
  assert.equal(calls.fetch[0][0], '/api/hosts/status');
  assert.equal(calls.fetch[0][1], sentinel);
});
test('a non-ok status throws `hosts/status <status>` and never parses the body', async () => {
  let parsed = false;
  control.impl = async () => ({ ok: false, status: 503, json: async () => { parsed = true; return {}; } });
  await assert.rejects(() => fetchHostStatuses(), /^Error: hosts\/status 503$/);
  assert.equal(parsed, false);
});
test('status normalization: only online/offline survive; checking, missing and garbage read unknown', async () => {
  const out = await run({ hosts: [
    { host: 'a', status: 'online' }, { host: 'b', status: 'offline' }, { host: 'c', status: 'checking' },
    { host: 'd' }, { host: 'e', status: 'ONLINE' }, { host: 'f', status: 42 } ] });
  assert.deepEqual(Object.fromEntries(Object.entries(out.statuses).map(([h, v]) => [h, v.status])),
    { a: 'online', b: 'offline', c: 'unknown', d: 'unknown', e: 'unknown', f: 'unknown' });
});
test('latency_ms is `?? null`: absent/null -> null, a measured 0 stays 0', async () => {
  const out = await run({ hosts: [
    { host: 'a', status: 'online', latency_ms: 0 }, { host: 'b', status: 'online', latency_ms: 37 },
    { host: 'c', status: 'online', latency_ms: null }, { host: 'd', status: 'online' } ] });
  assert.equal(out.statuses.a.latency_ms, 0); assert.equal(out.statuses.b.latency_ms, 37);
  assert.equal(out.statuses.c.latency_ms, null); assert.equal(out.statuses.d.latency_ms, null);
});
test('the companion key rides only when the wire row carried one, normalized (WARDEN-878)', async () => {
  const out = await run({ hosts: [
    { host: 'plain', status: 'online' },
    { host: 'live', status: 'online', companion: { state: 'active', version: '1.2.3' } },
    { host: 'junk', status: 'online', companion: { state: 'bogus', version: 7 } } ] });
  assert.equal('companion' in out.statuses.plain, false);
  assert.deepEqual(out.statuses.live.companion, { state: 'active', version: '1.2.3' });
  assert.deepEqual(out.statuses.junk.companion, { state: 'inactive' });
});
test('rows that are not objects or lack a string host are dropped from BOTH outputs', async () => {
  const good = { host: 'ok', status: 'online', checking: false };
  const out = await run({ hosts: [null, undefined, 'str', { status: 'online' }, { host: 12, status: 'online' }, good] });
  assert.deepEqual(Object.keys(out.statuses), ['ok']);
  assert.equal(out.hosts.length, 1);
});
test('hosts keeps the surviving wire rows losslessly (incl. checking/error/last_check)', async () => {
  const rows = [
    { host: 'a', status: 'unknown', latency_ms: null, checking: true },
    { host: 'b', status: 'offline', error: 'ssh timeout', last_check: '2026-10-31T00:00:00Z' } ];
  const out = await run({ hosts: rows });
  assert.deepEqual(out.hosts, rows);
  assert.equal(out.hosts[0], rows[0]);
  assert.equal('checking' in out.statuses.a, false);
});
test('a missing / non-array hosts field or a null body yields empty outputs, not a throw', async () => {
  for (const body of [{}, { hosts: null }, { hosts: { a: 1 } }, { hosts: 'x' }, null]) {
    assert.deepEqual(await run(body), { statuses: {}, hosts: [] }, JSON.stringify(body));
  }
});
test('refetchInterval: 1.2s follow-up only while a checking host is settled in the data; else 30s', () => {
  const ri = HOST_STATUSES_QUERY_OPTIONS.refetchInterval;
  const q = (hosts) => ({ state: { data: hosts === undefined ? undefined : { statuses: {}, hosts } } });
  assert.equal(ri(q([{ host: 'a', status: 'unknown', checking: true }])), 1_200);
  assert.equal(ri(q([{ host: 'a', status: 'online' }, { host: 'b', status: 'unknown', checking: true }])), 1_200);
  assert.equal(ri(q([{ host: 'a', status: 'online' }, { host: 'b', status: 'offline' }])), POLL_MS);
  assert.equal(ri(q([])), POLL_MS);
  assert.equal(ri(q(undefined)), POLL_MS);
});
test('query policy: no retry, no background polling, refocus refresh, gcTime at the poll cadence', () => {
  assert.equal(HOST_STATUSES_QUERY_OPTIONS.retry, false);
  assert.equal(HOST_STATUSES_QUERY_OPTIONS.refetchIntervalInBackground, false);
  assert.equal(HOST_STATUSES_QUERY_OPTIONS.refetchOnWindowFocus, true);
  assert.equal(HOST_STATUSES_QUERY_OPTIONS.gcTime, POLL_MS);
  assert.equal(HOST_STATUSES_QUERY_OPTIONS.staleTime, 5_000);
});
