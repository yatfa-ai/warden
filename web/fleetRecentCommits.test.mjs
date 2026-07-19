// Tests for the pure aggregation behind WARDEN-597's fleet-wide RECENT-commits
// feed: mergeFleetCommitsByEpoch (the flat, time-sorted cross-fleet merge) +
// buildFleetRecentCommitsUrl (the no-query /api/git-log?limit=N fetch URL). These
// are the no-query "what the fleet just shipped" counterparts to
// buildFleetCommitGroups (the query-driven, grouped-by-agent view) in the same
// module.
//
// There is no front-end test runner in this repo, so (like fleetCommitSearch.test.mjs)
// this loads the REAL src/lib/gitStateSummary.ts (transpiled TS -> ESM via Vite's
// OXC transform) and exercises it directly with plain objects. The fan-out (the
// actual fetches) is NOT pure and lives in the React component; these tests cover
// only the testable seam — how N per-agent recent-commit lists merge into ONE
// flat, epoch-desc list, that null-epoch degraded lines sort last, and that a
// per-agent failure never blanks the rest.
//
// Run: node fleetRecentCommits.test.mjs   (from web/)
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
const tmpDir = mkdtempSync(join(tmpdir(), 'warden-fleet-recent-test-'));
const tmpFile = join(tmpDir, 'gitStateSummary.mjs');
writeFileSync(tmpFile, code);
const { mergeFleetCommitsByEpoch, buildFleetRecentCommitsUrl } = await import(tmpFile);
rmSync(tmpDir, { recursive: true, force: true });

let passed = 0;
const test = (name, fn) => {
  fn();
  passed += 1;
  console.log('  ok -', name);
};

// Tiny builders so each case reads as "which agents shipped what". `commit` mirrors
// the FleetCommitLike shape (a /api/git-log row: hash + subject + epoch, etc.).
const commit = (hash, epoch, subject = `fix ${hash}`) => ({ hash, subject, author: 'ann', date: '2 days ago', epoch });
// A fulfilled per-agent outcome: that agent's recent commits + the set of hashes its
// outgoing (@{u}..HEAD) fetch returned — the join key for ↑unpushed (WARDEN-723,
// mirroring fleetCommitSearch.test.mjs' okAgent). An empty outgoing set = the agent
// pushed everything (or its outgoing fetch failed gracefully → no false ↑ marks).
const okAgent = (key, project, commits, outgoing = []) => ({ ok: true, key, project, commits, outgoingHashes: new Set(outgoing) });
// A rejected/unreachable per-agent outcome.
const badAgent = (key, project) => ({ ok: false, key, project });
// Pull just the (key, hash) sequence out of a merged result — the cross-fleet order
// the feed renders, independent of the subject/author/date each commit also carries.
const order = (r) => r.rows.map((row) => `${row.key}:${row.commit.hash}`);

console.log('\nmergeFleetCommitsByEpoch — flatten + epoch-desc merge (the cross-fleet feed)');
test('one agent: its commits pass through flattened, in epoch-desc order', () => {
  // /api/git-log already returns newest first, but the merge must not assume that —
  // it sorts by epoch itself so a misordered source still renders newest-first.
  const r = mergeFleetCommitsByEpoch([
    okAgent('a1', 'warden', [commit('h1', 1000), commit('h2', 3000), commit('h3', 2000)]),
  ]);
  assert.deepEqual(order(r), ['a1:h2', 'a1:h3', 'a1:h1']);
  assert.equal(r.errorCount, 0);
});
test('multiple agents: commits merge into ONE list sorted by epoch across the whole fleet', () => {
  // The core WARDEN-597 contract: a1's h2 (epoch 3000) is the newest ANYWHERE, so it
  // is on top — even though it belongs to a1, not b1. Cross-fleet time-merge, not
  // grouped-by-agent.
  const r = mergeFleetCommitsByEpoch([
    okAgent('a1', 'warden', [commit('a-low', 100), commit('a-high', 3000)]),
    okAgent('b1', 'tinker', [commit('b-mid', 2000)]),
  ]);
  assert.deepEqual(order(r), ['a1:a-high', 'b1:b-mid', 'a1:a-low']);
});
test('an agent with NO commits contributes nothing (no empty rows)', () => {
  const r = mergeFleetCommitsByEpoch([
    okAgent('a1', 'warden', [commit('h1', 1000)]),
    okAgent('a2', 'warden', []),  // barren repo — contributes nothing, not an error
  ]);
  assert.deepEqual(order(r), ['a1:h1']);
  assert.equal(r.errorCount, 0);
});
test('a failed agent (ok:false) is counted as an error, not rendered as rows', () => {
  const r = mergeFleetCommitsByEpoch([badAgent('a1', 'warden')]);
  assert.deepEqual(r.rows, []);
  assert.equal(r.errorCount, 1);
});
test('a failed agent does NOT blank the successful agents (partial-failure tolerance)', () => {
  // The WARDEN-89 fleet contract: one unreachable agent must not reject the whole.
  // ok-with-commits + failed + ok-with-commits → the two agents' commits merged, 1 error.
  const r = mergeFleetCommitsByEpoch([
    okAgent('a1', 'warden', [commit('h1', 1000)]),
    badAgent('a2', 'warden'),
    okAgent('a3', 'tinker', [commit('h2', 2000)]),
  ]);
  assert.equal(r.errorCount, 1);
  assert.deepEqual(order(r), ['a3:h2', 'a1:h1']);
});
test('rows carry key + project + unpushed so the React layer can resolve the agent name + ↑ mark without a lookup', () => {
  const r = mergeFleetCommitsByEpoch([okAgent('a1', 'warden', [commit('h1', 1000)])]);
  assert.deepEqual(r.rows.map((row) => ({ key: row.key, project: row.project, unpushed: row.unpushed })), [{ key: 'a1', project: 'warden', unpushed: false }]);
});
test('the full FleetCommitLike rides on each row (hash/subject/author/date/epoch)', () => {
  const c = commit('h1', 1000, 'fix login');
  const r = mergeFleetCommitsByEpoch([okAgent('a1', 'warden', [c])]);
  assert.deepEqual(r.rows[0].commit, c);
  // The row also carries the ↑unpushed mark (false here — h1 is not in the outgoing set).
  assert.equal(r.rows[0].unpushed, false);
});
test('empty input is safe', () => {
  assert.deepEqual(mergeFleetCommitsByEpoch([]), { rows: [], errorCount: 0 });
});

console.log('\nepoch == null — degraded lines sort LAST, stably (parseGitLogLine null path)');
test('a null-epoch commit sorts after every epoch-bearing commit, across agents', () => {
  // h-degraded (epoch null) must NOT leap-frog a-low (epoch 100) to the top — it lands last.
  const r = mergeFleetCommitsByEpoch([
    okAgent('a1', 'warden', [commit('h-degraded', null), commit('a-low', 100)]),
    okAgent('b1', 'tinker', [commit('b-mid', 2000)]),
  ]);
  assert.deepEqual(order(r), ['b1:b-mid', 'a1:a-low', 'a1:h-degraded']);
});
test('two null-epoch commits keep their input (chats) order among themselves', () => {
  // Stable placement: the degraded lines preserve the order they were flattened in
  // (agent a1's before b1's), rather than being arbitrarily reordered at the tail.
  const r = mergeFleetCommitsByEpoch([
    okAgent('a1', 'warden', [commit('a-deg', null)]),
    okAgent('b1', 'tinker', [commit('b-deg', null)]),
  ]);
  assert.deepEqual(order(r), ['a1:a-deg', 'b1:b-deg']);
});
test('a null epoch next to a real epoch within one agent still sorts last', () => {
  const r = mergeFleetCommitsByEpoch([
    okAgent('a1', 'warden', [commit('real', 5000), commit('deg', null)]),
  ]);
  assert.deepEqual(order(r), ['a1:real', 'a1:deg']);
});
test('undefined epoch is treated the same as null (both → last, stably)', () => {
  // FleetCommitLike.epoch is optional; a row missing the field entirely must not
  // break the comparator (it must place last, identical to an explicit null).
  const r = mergeFleetCommitsByEpoch([
    okAgent('a1', 'warden', [{ hash: 'missing', subject: 'x', author: 'a', date: 'd' }, commit('real', 5000)]),
  ]);
  assert.deepEqual(order(r), ['a1:real', 'a1:missing']);
});

console.log('\ntie-break — equal epochs keep input (chats) order (deterministic stable sort)');
test('two commits with the SAME epoch keep the order they were flattened in', () => {
  // epoch 1000 for both → a1:h1 before a1:h2 (same agent, input order) before b1:h3
  // (different agent, but flattened later). Deterministic so tests/screenshots are stable.
  const r = mergeFleetCommitsByEpoch([
    okAgent('a1', 'warden', [commit('h1', 1000), commit('h2', 1000)]),
    okAgent('b1', 'tinker', [commit('h3', 1000)]),
  ]);
  assert.deepEqual(order(r), ['a1:h1', 'a1:h2', 'b1:h3']);
});
test('outcomes are flattened in chats order before sorting (agent order drives ties)', () => {
  // Even when b1 is passed first, equal-epoch ties still break by flatten order
  // (which mirrors chats iteration order at the call site).
  const r = mergeFleetCommitsByEpoch([
    okAgent('b1', 'tinker', [commit('h3', 1000)]),
    okAgent('a1', 'warden', [commit('h1', 1000)]),
  ]);
  assert.deepEqual(order(r), ['b1:h3', 'a1:h1']);
});

console.log('\n↑unpushed join — a commit in BOTH the recent list and the outgoing set is unpushed');
test('a commit whose hash is in outgoingHashes is marked ↑unpushed', () => {
  // h1 is in both the recent list AND the outgoing (@{u}..HEAD) set → unpushed.
  const r = mergeFleetCommitsByEpoch([okAgent('a1', 'warden', [commit('h1', 1000)], ['h1'])]);
  assert.equal(r.rows[0].unpushed, true);
});
test('a commit whose hash is NOT in outgoingHashes is pushed (unpushed:false)', () => {
  // h1 is recent but absent from outgoing → already pushed.
  const r = mergeFleetCommitsByEpoch([okAgent('a1', 'warden', [commit('h1', 1000)], ['h9'])]);
  assert.equal(r.rows[0].unpushed, false);
});
test('within one agent, only the commits also in outgoing are unpushed (precise per-hash join)', () => {
  // The join must be per-HASH, not per-agent: h1+h3 are unpushed, h2 is pushed,
  // even though the agent has SOME unpushed work. A coarse aheadCount>0 signal
  // would mark ALL three — this asserts the precise join does not. Mirrors
  // fleetCommitSearch.test.mjs' per-commit join case.
  const r = mergeFleetCommitsByEpoch([
    okAgent('a1', 'warden', [commit('h1', 3000), commit('h2', 2000), commit('h3', 1000)], ['h1', 'h3']),
  ]);
  assert.deepEqual(r.rows.map((row) => [row.commit.hash, row.unpushed]), [
    ['h1', true],
    ['h2', false],
    ['h3', true],
  ]);
});
test('a failed/empty outgoing set marks NOTHING unpushed (graceful degradation — no false ↑)', () => {
  // The critical correctness point (WARDEN-723): an ok agent whose outgoing fetch
  // failed (empty outgoingHashes) must NEVER wrongly mark a commit unpushed — every
  // row reads unpushed:false. The no-false-positive contract ported verbatim from
  // FleetCommitSearch: a missing outgoing set yields no marks, not all-marks.
  const r = mergeFleetCommitsByEpoch([okAgent('a1', 'warden', [commit('h1', 1000), commit('h2', 2000)], [])]);
  assert.deepEqual(r.rows.map((row) => row.unpushed), [false, false]);
});
test('two agents: each is joined against its OWN outgoing set, never the other agent\'s', () => {
  // h1 is unpushed for a1 but pushed for a2 (its outgoing set differs). The join
  // must not leak one agent's outgoing hashes into another's recent commits.
  const r = mergeFleetCommitsByEpoch([
    okAgent('a1', 'warden', [commit('h1', 1000)], ['h1']),
    okAgent('a2', 'warden', [commit('h1', 2000)], []),
  ]);
  // epoch desc → a2:h1 (2000) first, a1:h1 (1000) second.
  assert.deepEqual(order(r), ['a2:h1', 'a1:h1']);
  assert.equal(r.rows[0].unpushed, false);  // a2's outgoing is empty → pushed
  assert.equal(r.rows[1].unpushed, true);   // a1's outgoing has h1 → unpushed
});

console.log('\nfull fleet shape — the flat, time-sorted feed the panel renders');
test('a mixed fleet flattens to one epoch-desc list with errors counted honestly', () => {
  const r = mergeFleetCommitsByEpoch([
    okAgent('a1', 'warden', [commit('a1', 4000), commit('a2', 1000)]),
    okAgent('b1', 'tinker', [commit('b1', 3000)]),
    okAgent('a2', 'warden', []),          // barren → contributes nothing
    badAgent('c1', 'nova'),                // unreachable → error
    okAgent('d1', 'warden', [commit('d1', null)]),  // degraded epoch → last
  ]);
  assert.deepEqual(order(r), ['a1:a1', 'b1:b1', 'a1:a2', 'd1:d1']);
  assert.equal(r.errorCount, 1);
});

console.log('\nbuildFleetRecentCommitsUrl — the no-query /api/git-log?limit=N fetch URL');
test('builds an id + limit URL with NO query param (the unfiltered recent view)', () => {
  const url = buildFleetRecentCommitsUrl('a1', 25);
  assert.equal(url, '/api/git-log?id=a1&limit=25');
  // The defining difference from buildFleetSearchBaseUrl: no grep= / pickaxe=.
  assert.ok(!url.includes('grep='), 'recent view must NOT splice a grep query');
  assert.ok(!url.includes('pickaxe='), 'recent view must NOT splice a pickaxe query');
});
test('limit is passed verbatim (the backend clamps to [1,50])', () => {
  assert.equal(buildFleetRecentCommitsUrl('a1', 1), '/api/git-log?id=a1&limit=1');
  assert.equal(buildFleetRecentCommitsUrl('a1', 50), '/api/git-log?id=a1&limit=50');
});
test('id is URL-encoded (a key with special chars stays one param value)', () => {
  // Mirrors the WARDEN-122 argv discipline on the backend: the key reaches git as ONE
  // argument. A container/host key with a colon must be encoded so it can't split.
  assert.equal(buildFleetRecentCommitsUrl('host:container', 25), '/api/git-log?id=host%3Acontainer&limit=25');
});
test('the URL has no range= so the component can append &range=outgoing for the ↑unpushed join', () => {
  // The ↑unpushed join (WARDEN-723) fires a SECOND fetch with &range=outgoing
  // appended to this base IN THE COMPONENT — mirroring how FleetCommitSearch
  // appends it to the range-free buildFleetSearchBaseUrl. Asserting range= is
  // absent here proves the pure URL builder stays single-purpose and the
  // component's `${base}&range=outgoing` concatenation yields a clean URL, not a
  // double range=.
  const url = buildFleetRecentCommitsUrl('a1', 25);
  assert.ok(!url.includes('range='), 'recent view base must leave no range= (component appends it)');
  assert.equal(`${url}&range=outgoing`, '/api/git-log?id=a1&limit=25&range=outgoing');
});

console.log(`\n✓ FLEET RECENT COMMITS TESTS PASS (${passed})`);
