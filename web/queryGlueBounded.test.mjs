// Tests for the React/TanStack glue exports of web/src/lib/gitStatusHooks.ts
// (`boundedGitStatusFetcher`, `GIT_STATUS_QUERY_OPTIONS`) and web/src/lib/appConfigHooks.ts
// (`boundedAppConfigFetcher`, `appConfigQueryFn`, `APP_CONFIG_QUERY_OPTIONS`).
// gitStatusQuery.test.mjs / appConfigQuery.test.mjs pin the pure fetch functions through an
// INJECTED fetcher and fetch-json.test.mjs pins `fetchBounded` itself, but nothing pinned that
// production wires the BOUNDED fetcher in (WARDEN-1144: a stalled agent otherwise holds the whole
// Fleet Health spinner) nor the "no auto-poll / no SSH hammering" query options.
// HARNESS (same as hostStatusesFetch.test.mjs): the REAL modules are transpiled with vite's
// transformWithOxc; `react` / `@tanstack/react-query` -> inert shims, `@/lib/api` -> a recording fake
// `fetchBounded`, and the pure seams (gitStatusQuery, gitStateSummary, appConfigQuery, issue-links,
// pollInterval) are the REAL transpiled modules. Every specifier rewrite is ASSERTED.
// Run: node queryGlueBounded.test.mjs   (or: npm test, from web/)
import { transformWithOxc } from 'vite';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const tmpDir = mkdtempSync(join(__dirname, '.query-glue-bounded-test-'));

writeFileSync(join(tmpDir, 'react-shim.mjs'), `
export const useEffect = () => { throw new Error('hook not exercised by this suite'); };
export const useMemo = () => { throw new Error('hook not exercised by this suite'); };
export const useCallback = () => { throw new Error('hook not exercised by this suite'); };
`);
writeFileSync(join(tmpDir, 'tanstack-shim.mjs'), `
export const useQuery = () => { throw new Error('hook not exercised by this suite'); };
export const useQueryClient = () => { throw new Error('hook not exercised by this suite'); };
`);
writeFileSync(join(tmpDir, 'api-shim.mjs'), `
export const calls = { fetch: [] };
export const control = { impl: async () => { throw new Error('fetchBounded not configured'); } };
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
await emit('src/lib/gitStateSummary.ts', 'gitStateSummary.mjs', {});
await emit('src/lib/gitStatusQuery.ts', 'gitStatusQuery.mjs', { '@/lib/gitStateSummary': './gitStateSummary.mjs' });
await emit('src/lib/appConfigQuery.ts', 'appConfigQuery.mjs', {});
await emit('src/lib/issue-links.ts', 'issue-links.mjs', {});
await emit('src/lib/pollInterval.ts', 'pollInterval.mjs', {});
await emit('src/lib/gitStatusHooks.ts', 'gitStatusHooks.mjs', {
  'react': './react-shim.mjs',
  '@tanstack/react-query': './tanstack-shim.mjs',
  '@/lib/gitStatusQuery': './gitStatusQuery.mjs',
  '@/lib/api': './api-shim.mjs',
});
await emit('src/lib/appConfigHooks.ts', 'appConfigHooks.mjs', {
  'react': './react-shim.mjs',
  '@tanstack/react-query': './tanstack-shim.mjs',
  '@/lib/appConfigQuery': './appConfigQuery.mjs',
  '@/lib/issue-links': './issue-links.mjs',
  '@/lib/api': './api-shim.mjs',
  '@/lib/pollInterval': './pollInterval.mjs',
});
const git = await import(join(tmpDir, 'gitStatusHooks.mjs'));
const cfg = await import(join(tmpDir, 'appConfigHooks.mjs'));
const gitQuery = await import(join(tmpDir, 'gitStatusQuery.mjs'));
const { calls, control } = await import(join(tmpDir, 'api-shim.mjs'));
rmSync(tmpDir, { recursive: true, force: true });

const { boundedGitStatusFetcher, GIT_STATUS_QUERY_OPTIONS } = git;
const { boundedAppConfigFetcher, appConfigQueryFn, APP_CONFIG_QUERY_OPTIONS } = cfg;

const respond = (json, status = 200) => async () => ({ ok: status >= 200 && status < 300, status, json: async () => json });
const reset = (impl) => { calls.fetch.length = 0; control.impl = impl; };

for (const [name, fetcher] of [['boundedGitStatusFetcher', boundedGitStatusFetcher], ['boundedAppConfigFetcher', boundedAppConfigFetcher]]) {
  test(`${name} routes through fetchBounded with ONLY {init} (primitive defaults stay in force), init by identity, raw Response returned`, async () => {
    const response = { ok: true, status: 200, tag: 'raw-response' };
    reset(async () => response);
    const init = { method: 'GET', headers: { a: 'b' } };
    const out = await fetcher('/api/x', init);
    assert.equal(out, response);
    assert.equal(calls.fetch.length, 1);
    assert.equal(calls.fetch[0][0], '/api/x');
    assert.deepEqual(Object.keys(calls.fetch[0][1]), ['init']);
    assert.equal(calls.fetch[0][1].init, init);
  });
  test(`${name} stringifies a URL-object input and tolerates an absent init`, async () => {
    reset(async () => ({ ok: true }));
    await fetcher(new URL('http://h.test/p?q=1'));
    assert.equal(calls.fetch[0][0], 'http://h.test/p?q=1');
    assert.equal(typeof calls.fetch[0][0], 'string');
    assert.equal(calls.fetch[0][1].init, undefined);
  });
}
test('boundedGitStatusFetcher rejects on a transport failure', async () => {
  reset(async () => { throw new Error('deadline exceeded'); });
  await assert.rejects(() => boundedGitStatusFetcher('/api/git-status?id=a'), /deadline exceeded/);
});
test('fetchGitStatusPayload(key, boundedGitStatusFetcher) GETs /api/git-status?id=<encoded> via fetchBounded and returns the ok body whole', async () => {
  const body = { branch: 'main', clean: true, ahead: 0 };
  reset(respond(body));
  const out = await gitQuery.fetchGitStatusPayload('a b/c', boundedGitStatusFetcher);
  assert.deepEqual(out, body);
  assert.equal(calls.fetch.length, 1);
  assert.equal(calls.fetch[0][0], '/api/git-status?id=a%20b%2Fc');
});
test('fetchGitStatusPayload over the bounded fetcher: a 5xx throws `git-status HTTP 503`', async () => {
  reset(respond({}, 503));
  await assert.rejects(() => gitQuery.fetchGitStatusPayload('a', boundedGitStatusFetcher), /^Error: git-status HTTP 503$/);
});
test('GIT_STATUS_QUERY_OPTIONS: no auto-poll, no retry, no refetch triggers, 5 min gcTime', () => {
  assert.deepEqual(GIT_STATUS_QUERY_OPTIONS, {
    staleTime: Infinity, gcTime: 300_000, retry: false,
    refetchOnMount: false, refetchOnWindowFocus: false, refetchOnReconnect: false,
  });
  assert.equal('refetchInterval' in GIT_STATUS_QUERY_OPTIONS, false);
});

test('appConfigQueryFn GETs /api/config through fetchBounded exactly once and returns the parsed body', async () => {
  const body = { companionTransportEnabled: false, pollIntervalMs: 1500 };
  reset(respond(body));
  const out = await appConfigQueryFn();
  assert.deepEqual(out, body);
  assert.equal(calls.fetch.length, 1);
  assert.equal(calls.fetch[0][0], '/api/config');
  assert.deepEqual(Object.keys(calls.fetch[0][1]), ['init']);
  assert.equal(calls.fetch[0][1].init, undefined);
});
test('appConfigQueryFn: a non-ok status throws `config HTTP 500`', async () => {
  reset(respond({}, 500));
  await assert.rejects(() => appConfigQueryFn(), /^Error: config HTTP 500$/);
});
test('appConfigQueryFn rejects on a transport failure', async () => {
  reset(async () => { throw new Error('network down'); });
  await assert.rejects(() => appConfigQueryFn(), /network down/);
});
test('APP_CONFIG_QUERY_OPTIONS: no auto-poll and no refetch triggers', () => {
  assert.deepEqual(APP_CONFIG_QUERY_OPTIONS, {
    staleTime: Infinity, refetchOnMount: false, refetchOnWindowFocus: false, refetchOnReconnect: false,
  });
  assert.equal('refetchInterval' in APP_CONFIG_QUERY_OPTIONS, false);
});
