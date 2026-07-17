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
// A fulfilled per-agent outcome: that agent's recent commits (recent-only — NO
// outgoing join, per WARDEN-597 decision #2).
const okAgent = (key, project, commits) => ({ ok: true, key, project, commits });
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
test('rows carry key + project so the React layer can resolve the agent name without a lookup', () => {
  const r = mergeFleetCommitsByEpoch([okAgent('a1', 'warden', [commit('h1', 1000)])]);
  assert.deepEqual(r.rows.map((row) => ({ key: row.key, project: row.project })), [{ key: 'a1', project: 'warden' }]);
});
test('the full FleetCommitLike rides on each row (hash/subject/author/date/epoch)', () => {
  const c = commit('h1', 1000, 'fix login');
  const r = mergeFleetCommitsByEpoch([okAgent('a1', 'warden', [c])]);
  assert.deepEqual(r.rows[0].commit, c);
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
test('the URL has no range= (recent-only — no outgoing join for the MVP)', () => {
  // Decision #2: the recent feed fires ONE fetch per agent (N), NOT the second
  // &range=outgoing fetch the query-driven search appends for its ↑unpushed join.
  const url = buildFleetRecentCommitsUrl('a1', 25);
  assert.ok(!url.includes('range='), 'recent view must leave no range= (no outgoing join)');
});

console.log(`\n✓ FLEET RECENT COMMITS TESTS PASS (${passed})`);
