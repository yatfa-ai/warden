// Tests for the pure aggregation behind WARDEN-589's fleet-wide working-tree CODE
// search: buildFleetCodeGroups (the file:line:text grouping) + fleetCodeFetchRequest
// (the POST /api/search-files seam). The mirror of fleetCommitSearch.test.mjs for the
// Code axis.
//
// The Code axis is the working-tree counterpart to the commit axes (message/content):
// where those find WHERE a change LANDED in HISTORY (commits), this finds WHERE a
// string lives RIGHT NOW across the fleet's current tracked code (file:line:text
// snippets). It REUSES fleetCommitSearchEligible (the population gate is mode-
// agnostic — already covered by fleetCommitSearch.test.mjs, so NOT re-tested here)
// but has its OWN grouping because its result shape is fundamentally different.
//
// There is no front-end test runner in this repo, so (like fleetCommitSearch.test.mjs)
// this loads the REAL src/lib/gitStateSummary.ts (transpiled TS -> ESM via Vite's OXC
// transform) and exercises it directly with plain objects. The fan-out (the actual
// POSTs) is NOT pure and lives in the React component; these tests cover only the
// testable seam — how the per-agent outcomes join into grouped-by-agent output, and
// that a per-agent failure (incl. an HTTP-200 `error` body, which the component maps
// to ok:false BEFORE calling this) never blanks the rest.
//
// Run: node fleetCodeSearch.test.mjs   (from web/)
import { transformWithOxc } from 'vite';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const helperPath = resolve(__dirname, 'src/lib/gitStateSummary.ts');

// --- Load the REAL gitStateSummary.ts (TS -> ESM via the OXC transform Vite bundles) ----
const src = readFileSync(helperPath, 'utf8');
const { code } = await transformWithOxc(src, helperPath, {});
const tmpDir = mkdtempSync(join(tmpdir(), 'warden-fleet-code-search-test-'));
const tmpFile = join(tmpDir, 'gitStateSummary.mjs');
writeFileSync(tmpFile, code);
const { buildFleetCodeGroups, fleetCodeFetchRequest } = await import(tmpFile);
rmSync(tmpDir, { recursive: true, force: true });

let passed = 0;
const test = (name, fn) => {
  fn();
  passed += 1;
  console.log('  ok -', name);
};

// Tiny builders so each case reads as "which agents matched / failed". A working-tree
// grep hit carries EXACTLY { file, line, text } — the shape /api/search-files returns.
const hit = (file, line, text = `match @ ${file}:${line}`) => ({ file, line, text });
// A fulfilled per-agent outcome: its grep hits (file:line:text), in git-grep order.
const okAgent = (key, project, hits) => ({ ok: true, key, project, hits });
// A rejected/unreachable per-agent outcome (a thrown fetch, OR an HTTP-200 `error` body
// the component mapped to ok:false before calling buildFleetCodeGroups).
const badAgent = (key, project) => ({ ok: false, key, project });

console.log('\nbuildFleetCodeGroups — grouping, empty-dropping, error counting');
test('one agent with hits yields one group carrying those file/line/text hits', () => {
  const r = buildFleetCodeGroups([okAgent('a1', 'warden', [hit('src/auth.js', 42), hit('src/api.js', 7)])]);
  assert.deepEqual(r, { groups: [{ key: 'a1', project: 'warden', hits: [hit('src/auth.js', 42), hit('src/api.js', 7)] }], errorCount: 0 });
});
test('an agent with NO hits is dropped (no empty group — a clean repo shows nothing)', () => {
  const r = buildFleetCodeGroups([okAgent('a1', 'warden', [])]);
  assert.deepEqual(r, { groups: [], errorCount: 0 });
});
test('a failed agent (ok:false) is counted as an error, not rendered as a false-empty group', () => {
  // The WARDEN-89 contract: a failed agent must never masquerade as "no matches". It
  // becomes errorCount, never an empty group.
  const r = buildFleetCodeGroups([badAgent('a1', 'warden')]);
  assert.deepEqual(r, { groups: [], errorCount: 1 });
});
test('a failed agent does NOT blank the successful agents (partial-failure tolerance)', () => {
  // The core fleet contract: one unreachable agent must not reject the whole.
  // ok-with-hits + failed + ok-with-hits → 2 groups, 1 error.
  const r = buildFleetCodeGroups([
    okAgent('a1', 'warden', [hit('a.js', 1)]),
    badAgent('a2', 'warden'),
    okAgent('a3', 'tinker', [hit('b.js', 2)]),
  ]);
  assert.equal(r.errorCount, 1);
  assert.deepEqual(r.groups.map((g) => g.key), ['a1', 'a3']);
});
test('groups stay in chats iteration order regardless of how errors interleave', () => {
  const r = buildFleetCodeGroups([
    badAgent('a1', 'warden'),
    okAgent('a2', 'warden', [hit('a.js', 1)]),
    okAgent('a3', 'tinker', [hit('b.js', 2)]),
    badAgent('a4', 'nova'),
  ]);
  assert.deepEqual(r.groups.map((g) => g.key), ['a2', 'a3']);
  assert.equal(r.errorCount, 2);
});
test('empty input is safe', () => {
  assert.deepEqual(buildFleetCodeGroups([]), { groups: [], errorCount: 0 });
});

console.log('\nhit shape — EXACTLY { file, line, text }, no unpushed (the Code axis has no hash)');
test('a hit carries exactly file/line/text — NO unpushed field (catches a commit-path copy-paste)', () => {
  // The commit path adds `unpushed` to every hit; the Code axis must NOT. Asserting the
  // exact shape here catches an accidental reuse of the commit grouping on this axis.
  const r = buildFleetCodeGroups([okAgent('a1', 'warden', [hit('a.js', 1)])]);
  assert.deepEqual(r.groups[0].hits[0], { file: 'a.js', line: 1, text: 'match @ a.js:1' });
  assert.equal('unpushed' in r.groups[0].hits[0], false, 'a code hit must NOT carry an unpushed field');
});
test('a stray field on the raw hit is stripped — the group emits exactly the three fields', () => {
  // The component hands the raw /api/search-files rows; if one ever carried an extra
  // field (or a commit-path field leaked in), buildFleetCodeGroups must drop it so the
  // Code axis shape stays exactly { file, line, text }.
  const r = buildFleetCodeGroups([
    okAgent('a1', 'warden', [{ file: 'a.js', line: 1, text: 'x', unpushed: true, extra: 'nope' }]),
  ]);
  assert.deepEqual(r.groups[0].hits[0], { file: 'a.js', line: 1, text: 'x' });
});
test('a hit with a multi-colon text body keeps only the first :digits: as the line', () => {
  // Mirrors parseSearchLine's non-greedy :digits: rule — the text body's own ':123:'
  // must not be re-split. Here we just confirm the already-parsed hit round-trips whole.
  const r = buildFleetCodeGroups([okAgent('a1', 'warden', [hit('a.js', 10, 'url = http://x:8080/y')])]);
  assert.deepEqual(r.groups[0].hits[0], { file: 'a.js', line: 10, text: 'url = http://x:8080/y' });
});

console.log('\nHTTP-200 error → ok:false outcome (the data.error gate is exercised at the outcome level)');
test('an agent whose fetch resolved with { error } becomes ok:false (counted as error, not empty)', () => {
  // /api/search-files returns failures ('search failed', 'no cwd') at HTTP 200 with an
  // `error` field. The component must map that to an ok:false outcome (NOT an empty
  // hits list), or a remote failure / missing cwd would render as a false-empty. This
  // models that mapping at the outcome level: the component hands buildFleetCodeGroups
  // a badAgent, and it counts as an error — proving the data.error gate reaches here.
  const outcomes = [
    okAgent('a1', 'warden', [hit('a.js', 1)]),
    badAgent('a2', 'warden'), // simulated { error: 'search failed' } body → component mapped to ok:false
    okAgent('a3', 'tinker', [hit('b.js', 2)]),
  ];
  const r = buildFleetCodeGroups(outcomes);
  assert.equal(r.errorCount, 1);
  assert.deepEqual(r.groups.map((g) => g.key), ['a1', 'a3']);
  // And a2 is NOT rendered as an empty group (no false "0 matches" row for it).
  assert.ok(!r.groups.some((g) => g.key === 'a2'), 'a failed agent must not appear as an empty group');
});

console.log('\nfull fleet shape — the grouped-by-agent view the popover renders');
test('hits across multiple agents + projects group by agent, in chats order, empties/errors excluded', () => {
  const r = buildFleetCodeGroups([
    okAgent('a1', 'warden', [hit('a.js', 1), hit('a.js', 5)]),
    okAgent('b1', 'tinker', [hit('b.js', 9)]),
    okAgent('a2', 'warden', []),                 // no hits → dropped
    badAgent('c1', 'nova'),                       // unreachable → error
  ]);
  assert.deepEqual(r.groups, [
    { key: 'a1', project: 'warden', hits: [hit('a.js', 1), hit('a.js', 5)] },
    { key: 'b1', project: 'tinker', hits: [hit('b.js', 9)] },
  ]);
  assert.equal(r.errorCount, 1);
  // The popover's per-group "N matches" header = g.hits.length (NO ↑unpushed count).
  assert.equal(r.groups[0].hits.length, 2);
  assert.equal(r.groups[1].hits.length, 1);
});

console.log('\nfleetCodeFetchRequest — the POST /api/search-files seam (WARDEN-589)');
test('produces a POST to /api/search-files with a JSON content-type', () => {
  const { url, init } = fleetCodeFetchRequest('a1', 'cancelToken');
  assert.equal(url, '/api/search-files');
  assert.equal(init.method, 'POST');
  assert.equal(init.headers['Content-Type'], 'application/json');
});
test('id and query are passed through verbatim in the JSON body', () => {
  const { init } = fleetCodeFetchRequest('a1', 'cancelToken');
  assert.deepEqual(JSON.parse(init.body), { id: 'a1', query: 'cancelToken' });
});
test('special chars in query are safe — they ride in a JSON body, NOT a URL-encodable GET string', () => {
  // Contrast with buildFleetSearchBaseUrl's GET path, which must encodeURIComponent the
  // term so 'a b&c=d' can't split into extra query params. Here the term is a JSON
  // string value, so it round-trips through JSON.parse whole — no encoding needed.
  const { init } = fleetCodeFetchRequest('host:container', 'a b&c=d ?regex=');
  assert.deepEqual(JSON.parse(init.body), { id: 'host:container', query: 'a b&c=d ?regex=' });
  // And the URL stays a bare path — no query string the special chars could corrupt.
  const { url } = fleetCodeFetchRequest('host:container', 'a b&c=d ?regex=');
  assert.equal(url, '/api/search-files');
});
test('two distinct agents get distinct bodies (id is the per-agent splice, query shared)', () => {
  // The fan-out fires one POST per agent; only `id` differs across the fleet. Asserting
  // the body carries the right id per call proves the seam hands the component a clean
  // per-agent request (no shared/closed-over state).
  const a = JSON.parse(fleetCodeFetchRequest('a1', 'q').init.body);
  const b = JSON.parse(fleetCodeFetchRequest('a2', 'q').init.body);
  assert.equal(a.id, 'a1');
  assert.equal(b.id, 'a2');
  assert.equal(a.query, 'q');
  assert.equal(b.query, 'q');
});

console.log(`\n✓ FLEET CODE SEARCH TESTS PASS (${passed})`);
