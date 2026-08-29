// Tests for the pure seam behind WARDEN-1211 (the shared per-agent
// /api/git-status fact): gitStatusQueryKey (ONE cache key per agent — the
// identity that makes the sidebar's focused read and Fleet Health's fan read
// the SAME entry), fetchGitStatusPayload (the ONE fetcher carrying the STRICT
// WARDEN-89 gate — a non-ok HTTP status OR an HTTP-200-with-`error` body
// THROWS, so an unreachable / non-git agent is an error, NEVER a false
// clean/empty status), and toFleetSlice (the slice coercion lifted verbatim
// from useFleetGitStatus — every typeof-coerce keeps null as null, and the
// conflict count derives from porcelain `files[].conflict === true`).
//
// The React/TanStack glue (gitStatusHooks.ts / the useQueries fan) is NOT
// tested here — this repo has no React test stack (finding B) — the seam is
// the injectable-fetcher pure layer, driven the way gitStateSummary is.
//
// Run: node gitStatusQuery.test.mjs   (from web/)
import { transformWithOxc } from 'vite';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const srcPath = resolve(__dirname, 'src/lib/gitStatusQuery.ts');

// --- Load the REAL gitStatusQuery.ts (TS -> ESM via the OXC transform Vite bundles) ----
const src = readFileSync(srcPath, 'utf8');
// The seam's only import is @/lib/gitStateSummary — rewrite it to the relative
// path so the transformed module resolves from the temp dir.
const { code } = await transformWithOxc(src, srcPath, {});
const tmpDir = mkdtempSync(join(tmpdir(), 'warden-git-status-query-test-'));
const tmpFile = join(tmpDir, 'gitStatusQuery.mjs');
writeFileSync(tmpFile, code.replace(/from ['"]@\/lib\/gitStateSummary['"]/, "from './gitStateSummary.mjs'"));
// Also transform the dependency so the import resolves without a bundler.
const depSrc = readFileSync(resolve(__dirname, 'src/lib/gitStateSummary.ts'), 'utf8');
const dep = await transformWithOxc(depSrc, resolve(__dirname, 'src/lib/gitStateSummary.ts'), {});
writeFileSync(join(tmpDir, 'gitStateSummary.mjs'), dep.code.replace(/from ['"]@\/lib\/types['"]/g, "from './types.mjs'").replace(/from ['"]@\//g, "from './"));
const typesSrc = readFileSync(resolve(__dirname, 'src/lib/types.ts'), 'utf8');
const types = await transformWithOxc(typesSrc, resolve(__dirname, 'src/lib/types.ts'), {});
writeFileSync(join(tmpDir, 'types.mjs'), types.code.replace(/from '@\//g, "from './"));

const { gitStatusQueryKey, fetchGitStatusPayload, toFleetSlice } = await import(tmpFile);
rmSync(tmpDir, { recursive: true, force: true });

let passed = 0;
const test = (name, fn) => {
  fn();
  passed += 1;
  console.log('  ok -', name);
};

// --- fetch fakes ----------------------------------------------------------

/** A fake fetch returning `json` with HTTP `status`. */
const jsonResponse = (json, status = 200) => {
  const body = typeof json === 'string' ? json : JSON.stringify(json);
  return async () => ({ ok: status >= 200 && status < 300, status, json: async () => JSON.parse(body) });
};

// --- gitStatusQueryKey ----------------------------------------------------

test('one cache key per agent: the key is the fact\'s identity', () => {
  assert.deepEqual(gitStatusQueryKey('agent-1'), ['git-status', 'agent-1']);
  assert.deepEqual(gitStatusQueryKey('agent-1'), gitStatusQueryKey('agent-1'), 'same agent → same key (the sidebar and the fleet fan read ONE entry)');
  assert.notEqual(gitStatusQueryKey('agent-1').join(), gitStatusQueryKey('agent-2').join(), 'different agents → different keys');
});

test('a container/host key stays ONE argument (WARDEN-122 discipline survives the move)', async () => {
  let seenUrl = '';
  const fetcher = async (url) => { seenUrl = url; return { ok: true, status: 200, json: async () => ({ branch: 'main' }) }; };
  await fetchGitStatusPayload('host:container', fetcher);
  assert.equal(seenUrl, '/api/git-status?id=' + encodeURIComponent('host:container'), 'key encoded as one id param, never split');
});

// --- fetchGitStatusPayload: the STRICT WARDEN-89 gate ----------------------

test('a successful payload is returned whole (the sidebar reads branch/files/diffstat off it)', async () => {
  const j = await fetchGitStatusPayload('a', jsonResponse({ branch: 'main', clean: false, files: [] }));
  assert.equal(j.branch, 'main');
  assert.equal(j.clean, false);
});

test('a non-ok HTTP status THROWS (never a false clean/empty read)', async () => {
  await assert.rejects(fetchGitStatusPayload('a', jsonResponse({ clean: true }, 502)), /HTTP 502/);
});

test('an HTTP-200 with an error body THROWS (the transport/no-cwd shape gitRoutes serves)', async () => {
  await assert.rejects(fetchGitStatusPayload('a', jsonResponse({ error: 'no cwd' })), /no cwd/);
});

test('a network reject propagates as the agent\'s error', async () => {
  await assert.rejects(fetchGitStatusPayload('a', async () => { throw new Error('ECONNREFUSED'); }), /ECONNREFUSED/);
});

test('a SUCCESSFUL branch-less payload does NOT throw — branch-less is a consumer-side read, not an error (finding A)', async () => {
  const j = await fetchGitStatusPayload('a', jsonResponse({ branch: null, clean: null }));
  assert.equal(j.branch, null);
});

test('exactly ONE fetch per call (no hidden double-fetch in the owner)', async () => {
  let calls = 0;
  const fetcher = async () => { calls += 1; return { ok: true, status: 200, json: async () => ({ branch: 'main' }) }; };
  await fetchGitStatusPayload('a', fetcher);
  assert.equal(calls, 1);
});

// --- toFleetSlice: the coercion lifted verbatim from useFleetGitStatus -----

test('boolean/number/string coercions keep real values', () => {
  const s = toFleetSlice({ clean: true, ahead: 2, behind: 3, stashCount: 1, headDate: '2026-08-27T00:00:00Z', diffstat: { files: 2, insertions: 5, deletions: 1 } });
  assert.equal(s.clean, true);
  assert.equal(s.ahead, 2);
  assert.equal(s.behind, 3);
  assert.equal(s.stashCount, 1);
  assert.equal(s.headDate, '2026-08-27T00:00:00Z');
  assert.deepEqual(s.diffstat, { files: 2, insertions: 5, deletions: 1 });
});

test('null stays null (non-git / no-branch / no-upstream reads quiet, not 0)', () => {
  const s = toFleetSlice({ branch: null, clean: null, ahead: null, behind: null, stashCount: null, headDate: null, diffstat: null });
  assert.equal(s.clean, null);
  assert.equal(s.ahead, null);
  assert.equal(s.behind, null);
  assert.equal(s.stashCount, null);
  assert.equal(s.headDate, null);
  assert.equal(s.diffstat, null);
});

test('absent fields coerce to null, never undefined', () => {
  const s = toFleetSlice({});
  assert.equal(s.clean, null);
  assert.equal(s.ahead, null);
  assert.equal(s.behind, null);
  assert.equal(s.stashCount, null);
  assert.equal(s.headDate, null);
  assert.equal(s.diffstat, null);
});

test('conflictCount counts porcelain files tagged conflict === true (not truthy, not absent)', () => {
  const s = toFleetSlice({ files: [
    { path: 'a', conflict: true },
    { path: 'b', conflict: false },
    { path: 'c' },               // absent — not a conflict
    { path: 'd', conflict: 1 },  // truthy-but-not-true — malformed, not a conflict
    null,                        // malformed row — not a conflict
  ] });
  assert.equal(s.conflictCount, 1);
});

test('files: null (clean/non-git cwd default) → conflictCount 0', () => {
  assert.equal(toFleetSlice({ files: null }).conflictCount, 0);
  assert.equal(toFleetSlice({}).conflictCount, 0);
});

test('headAgeMs/stalled are provisional null/false (enriched by buildFleetGitStatus(now))', () => {
  const s = toFleetSlice({ branch: 'main' });
  assert.equal(s.headAgeMs, null);
  assert.equal(s.stalled, false);
});

console.log(`\n${passed} passed`);
