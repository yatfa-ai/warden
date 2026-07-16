// Tests for the pure aggregation behind WARDEN-534's fleet-wide commit search:
// fleetCommitSearchEligible (the population gate) + buildFleetCommitGroups (the
// grouping + ↑unpushed join). These are the cross-agent HISTORY counterparts to
// summarizeProjectGitState (STATUS) and detectProjectFileCollisions (COLLISIONS)
// in the same module.
//
// There is no front-end test runner in this repo, so (like gitStateSummary.test.mjs)
// this loads the REAL src/lib/gitStateSummary.ts (transpiled TS -> ESM via Vite's
// OXC transform) and exercises it directly with plain objects. The fan-out (the
// actual fetches) is NOT pure and lives in the React component; these tests cover
// only the testable seam — who is searched, how the per-agent results join into
// grouped-by-agent output, and that a per-agent failure never blanks the rest.
//
// Run: node fleetCommitSearch.test.mjs   (from web/)
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
const tmpDir = mkdtempSync(join(tmpdir(), 'warden-fleet-search-test-'));
const tmpFile = join(tmpDir, 'gitStateSummary.mjs');
writeFileSync(tmpFile, code);
const { fleetCommitSearchEligible, buildFleetCommitGroups } = await import(tmpFile);
rmSync(tmpDir, { recursive: true, force: true });

let passed = 0;
const test = (name, fn) => {
  fn();
  passed += 1;
  console.log('  ok -', name);
};

// Tiny builders so each case reads as "which agents are eligible / matched".
// `chat` mirrors the FleetSearchChat slice (id + optional key/project/active).
const chat = (id, project, opts = {}) => ({ id, project, active: true, ...opts });
// A /api/git-log commit row (the GIT_LOG_PRETTY shape): hash is the join key.
const commit = (hash, subject = `fix ${hash}`) => ({ hash, subject, author: 'ann', date: '2 days ago', epoch: 1700000000 });
// A fulfilled per-agent outcome: matches + the set of hashes its outgoing grep returned.
const okAgent = (key, project, matches, outgoing = []) => ({ ok: true, key, project, matches, outgoingHashes: new Set(outgoing) });
// A rejected/unreachable per-agent outcome.
const badAgent = (key, project) => ({ ok: false, key, project });

console.log('\nfleetCommitSearchEligible — population gate (active && project, keyed, deduped)');
test('an active chat with a project is searchable, keyed by key when present', () => {
  const e = fleetCommitSearchEligible([chat('raw-1', 'warden', { key: 'warden-worker' })]);
  assert.deepEqual(e, [{ key: 'warden-worker', project: 'warden' }]);
});
test('an active chat with a project but no key falls back to id', () => {
  const e = fleetCommitSearchEligible([chat('chat-1', 'warden')]);
  assert.deepEqual(e, [{ key: 'chat-1', project: 'warden' }]);
});
test('an inactive agent is skipped (never grepped — would just error)', () => {
  const e = fleetCommitSearchEligible([chat('a1', 'warden', { active: false })]);
  assert.deepEqual(e, []);
});
test('active:null (undiscovered) is skipped — only known-active chats are searched', () => {
  const e = fleetCommitSearchEligible([chat('a1', 'warden', { active: null })]);
  assert.deepEqual(e, []);
});
test('an active agent without a project is skipped (mirrors summarizeProjectGitState)', () => {
  const e = fleetCommitSearchEligible([chat('a1', undefined)]);
  assert.deepEqual(e, []);
});
test('two chats sharing a resolved key are deduped — the same repo is grepped once', () => {
  // A yatfa agent (key set) and a stray entry collapsing to the same key must not
  // double-fetch: the fleet fan-out fires one grep per distinct key.
  const e = fleetCommitSearchEligible([
    chat('raw-1', 'warden', { key: 'warden-worker' }),
    chat('raw-2', 'warden', { key: 'warden-worker' }),
  ]);
  assert.deepEqual(e, [{ key: 'warden-worker', project: 'warden' }]);
});
test('eligibility is emitted in chats iteration order (deterministic grouping)', () => {
  const e = fleetCommitSearchEligible([
    chat('a1', 'warden'), chat('b1', 'tinker'), chat('c1', 'nova'),
  ]);
  assert.deepEqual(e.map((x) => x.key), ['a1', 'b1', 'c1']);
  assert.deepEqual(e.map((x) => x.project), ['warden', 'tinker', 'nova']);
});
test('mixed fleet: only active project chats survive, in order', () => {
  const e = fleetCommitSearchEligible([
    chat('a1', 'warden'),                       // eligible
    chat('a2', 'warden', { active: false }),    // inactive → skip
    chat('a3'),                                  // no project → skip
    chat('a4', 'tinker', { key: 't-w' }),        // eligible (keyed)
  ]);
  assert.deepEqual(e, [
    { key: 'a1', project: 'warden' },
    { key: 't-w', project: 'tinker' },
  ]);
});
test('empty input is safe', () => {
  assert.deepEqual(fleetCommitSearchEligible([]), []);
});

console.log('\nbuildFleetCommitGroups — grouping, empty-dropping, error counting');
test('one agent with matches yields one group carrying those commits', () => {
  const r = buildFleetCommitGroups([okAgent('a1', 'warden', [commit('h1'), commit('h2')])]);
  assert.deepEqual(r, { groups: [{ key: 'a1', project: 'warden', commits: [{ ...commit('h1'), unpushed: false }, { ...commit('h2'), unpushed: false }] }], errorCount: 0 });
});
test('an agent with NO matches is dropped (no empty group)', () => {
  const r = buildFleetCommitGroups([okAgent('a1', 'warden', [])]);
  assert.deepEqual(r, { groups: [], errorCount: 0 });
});
test('a failed agent (ok:false) is counted as an error, not rendered as a group', () => {
  const r = buildFleetCommitGroups([badAgent('a1', 'warden')]);
  assert.deepEqual(r, { groups: [], errorCount: 1 });
});
test('a failed agent does NOT blank the successful agents (partial-failure tolerance)', () => {
  // The core WARDEN-534 fleet contract: one unreachable agent must not reject the
  // whole. ok-with-matches + failed + ok-with-matches → 2 groups, 1 error.
  const r = buildFleetCommitGroups([
    okAgent('a1', 'warden', [commit('h1')]),
    badAgent('a2', 'warden'),
    okAgent('a3', 'tinker', [commit('h2')]),
  ]);
  assert.equal(r.errorCount, 1);
  assert.deepEqual(r.groups.map((g) => g.key), ['a1', 'a3']);
});
test('groups stay in chats iteration order regardless of how errors interleave', () => {
  const r = buildFleetCommitGroups([
    badAgent('a1', 'warden'),
    okAgent('a2', 'warden', [commit('h2')]),
    okAgent('a3', 'tinker', [commit('h3')]),
    badAgent('a4', 'nova'),
  ]);
  assert.deepEqual(r.groups.map((g) => g.key), ['a2', 'a3']);
  assert.equal(r.errorCount, 2);
});
test('empty input is safe', () => {
  assert.deepEqual(buildFleetCommitGroups([]), { groups: [], errorCount: 0 });
});

console.log('\n↑unpushed join — a match in BOTH the recent grep and the outgoing set is unpushed');
test('a match whose hash is in outgoingHashes is marked ↑unpushed', () => {
  // h1 is in both the recent matches AND the outgoing (@{u}..HEAD) set → unpushed.
  const r = buildFleetCommitGroups([okAgent('a1', 'warden', [commit('h1')], ['h1'])]);
  assert.equal(r.groups[0].commits[0].unpushed, true);
});
test('a match whose hash is NOT in outgoingHashes is pushed (unpushed:false)', () => {
  // h1 matched the recent grep but is absent from outgoing → already pushed.
  const r = buildFleetCommitGroups([okAgent('a1', 'warden', [commit('h1')], ['h9'])]);
  assert.equal(r.groups[0].commits[0].unpushed, false);
});
test('within one agent, only the commits also in outgoing are unpushed (precise per-commit join)', () => {
  // The join must be per-HASH, not per-agent: h1+h3 are unpushed, h2 is pushed,
  // even though the agent has SOME unpushed work. A coarse aheadCount>0 signal
  // would mark ALL three — this asserts the precise join does not.
  const r = buildFleetCommitGroups([
    okAgent('a1', 'warden', [commit('h1'), commit('h2'), commit('h3')], ['h1', 'h3']),
  ]);
  assert.deepEqual(r.groups[0].commits.map((c) => [c.hash, c.unpushed]), [
    ['h1', true],
    ['h2', false],
    ['h3', true],
  ]);
});
test('an empty outgoing set marks nothing unpushed (agent pushed / no upstream)', () => {
  const r = buildFleetCommitGroups([okAgent('a1', 'warden', [commit('h1'), commit('h2')], [])]);
  assert.deepEqual(r.groups[0].commits.map((c) => c.unpushed), [false, false]);
});
test('two agents: each is joined against its OWN outgoing set, never the other agent\'s', () => {
  // h1 is unpushed for a1 but pushed for a2 (its outgoing set differs). The join
  // must not leak one agent's outgoing hashes into another's matches.
  const r = buildFleetCommitGroups([
    okAgent('a1', 'warden', [commit('h1')], ['h1']),
    okAgent('a2', 'warden', [commit('h1')], []),
  ]);
  assert.equal(r.groups[0].commits[0].unpushed, true);
  assert.equal(r.groups[1].commits[0].unpushed, false);
});

console.log('\nfull fleet shape — the grouped-by-agent view the popover renders');
test('matches across multiple agents + projects group by agent with per-group unpushed counts derivable', () => {
  const r = buildFleetCommitGroups([
    okAgent('a1', 'warden', [commit('h1'), commit('h2')], ['h2']),
    okAgent('b1', 'tinker', [commit('h3')], ['h3']),
    okAgent('a2', 'warden', []),                 // no matches → dropped
    badAgent('c1', 'nova'),                       // unreachable → error
  ]);
  assert.deepEqual(r.groups, [
    { key: 'a1', project: 'warden', commits: [{ ...commit('h1'), unpushed: false }, { ...commit('h2'), unpushed: true }] },
    { key: 'b1', project: 'tinker', commits: [{ ...commit('h3'), unpushed: true }] },
  ]);
  assert.equal(r.errorCount, 1);
  // The popover's "↑N" per-group header = commits.filter(unpushed).length.
  assert.equal(r.groups[0].commits.filter((c) => c.unpushed).length, 1);
  assert.equal(r.groups[1].commits.filter((c) => c.unpushed).length, 1);
});

console.log(`\n✓ FLEET COMMIT SEARCH TESTS PASS (${passed})`);
