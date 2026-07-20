// Tests for the pure aggregation behind WARDEN-766's Fleet Health git-status fan:
// buildFleetGitStatus (turn N per-agent /api/git-status outcomes into a per-agent
// { clean, diffstat, ahead, conflictCount, behind, headDate, headAgeMs, stalled } map +
// a fleet dirty count + a fleet unpushed count + a fleet conflict count + a fleet behind
// count + a fleet stalled count + an honest error count) +
// buildFleetGitStatusUrl (the /api/git-status?id= fetch URL).
//
// These are the working-tree-STATE counterparts to mergeFleetCommitsByEpoch /
// buildFleetRecentCommitsUrl (the commit-HISTORY fan) in the same module. The hook
// itself (useFleetGitStatus) is React — not testable without a front-end runner, of
// which this repo has none — so these tests cover ONLY the pure seam: how N
// per-agent statuses fold into the Fleet Health view, that the dirty signal keys on
// `clean === false` (not the diffstat magnitude), that the conflict signal keys on
// `conflictCount > 0` (the agent-level count of unmerged PATHS, WARDEN-796 — the
// mirror of dirtyCount's agent-level dirty signal), that the unpushed signal keys on
// `ahead > 0` (the agent-level count of stranded-work AGENTS, WARDEN-822 — the mirror
// of dirtyCount/conflictCount, surfacing the blind spot clean cannot speak to), that
// the behind signal keys on `behind > 0` (the agent-level staleness count, WARDEN-815
// — the same mirror again), that the stalled signal keys on `headDate` parsing to an
// age >7d against the threaded `now` (the agent-level recency count, WARDEN-847 — the
// sole non-state axis, mirroring dirtyCount to surface the canonical blind spot: a
// clean/pushed/in-sync/routine agent whose HEAD is >7d old), that the headAgeMs +
// stalled derivation is byte-identical to summarizeProjectGitState:356-363 and stays
// deterministic under a fixed `now`, that a clean:null non-git agent is neither dirty
// nor unpushed nor conflict nor behind nor stalled nor an error, and that a per-agent
// failure is counted honestly without blanking the rest (the WARDEN-89 false-empty
// contract).
//
// Run: node fleetGitStatus.test.mjs   (from web/)
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
const tmpDir = mkdtempSync(join(tmpdir(), 'warden-fleet-git-status-test-'));
const tmpFile = join(tmpDir, 'gitStateSummary.mjs');
writeFileSync(tmpFile, code);
const { buildFleetGitStatus, buildFleetGitStatusUrl } = await import(tmpFile);
rmSync(tmpDir, { recursive: true, force: true });

let passed = 0;
const test = (name, fn) => {
  fn();
  passed += 1;
  console.log('  ok -', name);
};

// Tiny builders so each case reads as "which agents are clean/dirty/conflict/behind/ahead/stalled/unreachable".
// `slice` mirrors FleetGitStatusSlice ({ clean, diffstat, ahead, conflictCount, behind, headDate, headAgeMs,
// stalled }) — the eight fields the UI reads off /api/git-status. clean === false ⇒ dirty; diffstat is
// { files, insertions, deletions } | null (null for a clean / non-git / all-untracked tree); ahead
// (WARDEN-822) is the # of unpushed commits (> 0 ⇒ stranded locally — the ahead axis clean cannot speak
// to; null for non-git / detached / no-upstream, 0 for in-sync); conflictCount (WARDEN-796) is the # of
// unmerged paths for that agent (> 0 ⇒ a mid-merge/rebase/cherry-pick block — the conflict axis); behind
// (WARDEN-815) is the # of commits that agent's HEAD is behind its upstream (> 0 ⇒ stale — the staleness
// axis; null for a non-git / no-branch / no-upstream cwd, the same null-is-quiet discipline `clean`
// follows); headDate (WARDEN-847) is the strict ISO-8601 last-commit time (the raw recency input —
// buildFleetGitStatus(now) derives headAgeMs + stalled from it, mirroring summarizeProjectGitState). NOTE
// the positional order is (clean, insertions, deletions, files, conflictCount, behind, ahead, headDate)
// — conflictCount before behind/ahead so the older conflict-only call sites (5 args) keep working; behind
// at pos 6, ahead at pos 7 so a call exercising ONE axis passes null for the other; headDate at pos 8
// (default null) so non-stalled call sites stay short. headAgeMs/stalled are set to PROVISIONAL null/false
// here (this helper mirrors the FETCH-SEAM slice, which has no clock); buildFleetGitStatus(now) enriches
// them — the enriched values are what the per-row 💤 chip reads, and what stalled assertions check.
const slice = (clean, insertions = null, deletions = null, files = 0, conflictCount = 0, behind = null, ahead = 0, headDate = null) => ({
  clean,
  diffstat: insertions === null ? null : { files, insertions, deletions },
  ahead,
  conflictCount,
  behind,
  headDate,
  headAgeMs: null,
  stalled: false,
});
// A fulfilled per-agent outcome: that agent's status slice. clean === false is the
// dirty signal (mirrors summarizeProjectGitState's `dirty = status.clean === false`).
const ok = (key, status) => ({ ok: true, key, status });
// A rejected/unreachable per-agent outcome.
const bad = (key) => ({ ok: false, key });

console.log('\nbuildFleetGitStatus — fold N per-agent statuses into a map + dirty/conflict/behind/ahead/error counts');
test('empty input is safe (no agents → empty map, zero counts)', () => {
  assert.deepEqual(buildFleetGitStatus([]), { statusByKey: {}, dirtyCount: 0, errorCount: 0, conflictCount: 0, behindCount: 0, aheadCount: 0, stalledCount: 0 });
});
test('one CLEAN agent: map gets an entry, dirtyCount stays 0, conflictCount 0, behindCount 0, aheadCount 0, stalledCount 0, errorCount 0', () => {
  const r = buildFleetGitStatus([ok('a1', slice(true))]);
  assert.deepEqual(r.statusByKey, { a1: slice(true) });
  assert.equal(r.dirtyCount, 0);
  assert.equal(r.conflictCount, 0);
  assert.equal(r.behindCount, 0);
  assert.equal(r.aheadCount, 0);
  assert.equal(r.stalledCount, 0);
  assert.equal(r.errorCount, 0);
});
test('one DIRTY agent with a magnitude: dirtyCount 1, conflictCount 0, behindCount 0, aheadCount 0, stalledCount 0, slice carried verbatim', () => {
  const r = buildFleetGitStatus([ok('a1', slice(false, 12, 3, 2))]);
  assert.deepEqual(r.statusByKey.a1, slice(false, 12, 3, 2));
  assert.equal(r.dirtyCount, 1);
  assert.equal(r.conflictCount, 0);
  assert.equal(r.behindCount, 0);
  assert.equal(r.aheadCount, 0);
  assert.equal(r.stalledCount, 0);
  assert.equal(r.errorCount, 0);
});
test('dirty keys on clean === false, NOT on the diffstat magnitude (all-untracked still counts)', () => {
  // A dirty agent whose WIP is purely untracked serves diffstat:null (git diff HEAD
  // counts tracked edits only). clean === false drives dirtyCount — the agent is
  // counted at the fleet level even though its row will show no +N −M magnitude
  // (DiffStatChip's own +0−0/null guard). This is the load-bearing assertion: the
  // summary-bar count stays honest for an all-untracked dirty agent.
  const r = buildFleetGitStatus([ok('a1', slice(false, null))]);
  assert.equal(r.statusByKey.a1.clean, false);
  assert.equal(r.statusByKey.a1.diffstat, null);
  assert.equal(r.dirtyCount, 1);
});
test('a dirty agent with a +0−0 diffstat (tracked but zero-net) still counts as dirty', () => {
  // clean === false is the signal; a +0−0 magnitude does not un-dirty the agent.
  const r = buildFleetGitStatus([ok('a1', slice(false, 0, 0, 0))]);
  assert.equal(r.dirtyCount, 1);
  assert.deepEqual(r.statusByKey.a1.diffstat, { files: 0, insertions: 0, deletions: 0 });
});
test('a clean:null (non-git / no-branch) agent is NEITHER dirty NOR unpushed NOR conflict NOR behind NOR stalled NOR an error', () => {
  // The server gates `clean: branch ? clean : null` — a non-git cwd serves clean:null.
  // null !== false ⇒ not dirty; conflictCount 0 ⇒ not a conflict; ahead 0 ⇒ not
  // unpushed; behind null (the server gates `behind: branch ? behind : null` too, and
  // parseAheadBehind returns `{ behind: null }` for no-upstream) ⇒ not behind; headDate
  // null (the server gates `headDate: branch ? headDate : null`, and a repo with no
  // commits serves null) ⇒ Date.parse → NaN → headAgeMs null ⇒ not stalled; the agent
  // is a resolved ok outcome ⇒ not an error. It gets a map entry (clean:null) so the
  // React layer could distinguish "fetched but non-git" from "still loading"; today both
  // render no chip.
  const r = buildFleetGitStatus([ok('a1', slice(null))]);
  assert.deepEqual(r.statusByKey, { a1: slice(null) });
  assert.equal(r.dirtyCount, 0);
  assert.equal(r.conflictCount, 0);
  assert.equal(r.aheadCount, 0);
  assert.equal(r.behindCount, 0);
  assert.equal(r.stalledCount, 0);
  assert.equal(r.errorCount, 0);
});
test('a failed agent (ok:false) is counted as an error, NEVER as dirty OR conflict OR behind OR unpushed, and gets no map entry', () => {
  // The WARDEN-89 contract: an unreachable / non-git-error agent must never masquerade
  // as a clean/empty status. It is counted into errorCount and ABSENT from the map (so
  // statusByKey[id] is undefined → the React layer renders the graceful-N/A nothing,
  // NOT a false clean chip) — and it is NOT counted as a conflict, behind, OR unpushed
  // (a transiently-unreachable agent is never misread as blocked, stale, or stranded).
  const r = buildFleetGitStatus([bad('a1')]);
  assert.deepEqual(r.statusByKey, {});
  assert.equal(r.dirtyCount, 0);
  assert.equal(r.conflictCount, 0);
  assert.equal(r.behindCount, 0);
  assert.equal(r.aheadCount, 0);
  assert.equal(r.stalledCount, 0);
  assert.equal(r.errorCount, 1);
});
test('a failed agent does NOT blank the successful agents (partial-failure tolerance)', () => {
  // The Promise.allSettled fleet contract: one unreachable agent must not reject the
  // whole. ok-dirty + failed + ok-clean → the two ok agents' statuses in the map, 1
  // dirty, 1 error, 0 conflict.
  const r = buildFleetGitStatus([
    ok('a1', slice(false, 5, 1, 1)),
    bad('a2'),
    ok('a3', slice(true)),
  ]);
  assert.deepEqual(Object.keys(r.statusByKey), ['a1', 'a3']);
  assert.equal(r.dirtyCount, 1);
  assert.equal(r.conflictCount, 0);
  assert.equal(r.errorCount, 1);
});
test('outcomes fold in input (chats) order — the map key order is deterministic', () => {
  // Map key insertion order = input order, so the React layer iterating statusByKey
  // (if it ever does) is deterministic. Tests assert deep equality on the key list.
  const r = buildFleetGitStatus([
    ok('b1', slice(true)),
    ok('a1', slice(false, 1, 1, 1)),
    ok('c1', slice(true)),
  ]);
  assert.deepEqual(Object.keys(r.statusByKey), ['b1', 'a1', 'c1']);
});
test('a clean ok agent gets a map entry too (fetched-vs-loading stays distinguishable)', () => {
  // Including clean agents is honest, not noise: the per-row chip gates on
  // clean === false so a clean entry renders nothing, but statusByKey[id] being
  // defined lets a future surface tell "fetched + clean" apart from "still loading."
  const r = buildFleetGitStatus([ok('a1', slice(true)), ok('a2', slice(false, 2, 2, 1))]);
  assert.deepEqual(r.statusByKey, {
    a1: slice(true),
    a2: slice(false, 2, 2, 1),
  });
  assert.equal(r.dirtyCount, 1);
  assert.equal(r.conflictCount, 0);
  assert.equal(r.aheadCount, 0);
});

console.log('\nbuildFleetGitStatus — the conflict axis (WARDEN-796: conflictCount > 0 ⇒ blocked agent)');
test('one CONFLICT agent (conflictCount > 0) increments the fleet conflictCount, slice carried verbatim', () => {
  // The conflict signal keys on conflictCount > 0 — the mirror of how dirty keys on
  // clean === false. The per-agent PATH count is carried on the slice (drives the
  // per-row ⚑'s "N unmerged"); the fleet AGENT count is incremented here. A
  // mid-merge repo is dirty by definition (clean === false) so this agent is BOTH
  // dirty AND a conflict — the two orthogonal axes both fire.
  const r = buildFleetGitStatus([ok('a1', slice(false, 40, 12, 3, 3))]);
  assert.deepEqual(r.statusByKey.a1, slice(false, 40, 12, 3, 3));
  assert.equal(r.conflictCount, 1);
  assert.equal(r.dirtyCount, 1);
  assert.equal(r.behindCount, 0);
  assert.equal(r.aheadCount, 0);
  assert.equal(r.stalledCount, 0);
  assert.equal(r.errorCount, 0);
});
test('a CONFLICT-but-clean agent still counts as a conflict (conflictCount is independent of clean)', () => {
  // conflictCount keys on the unmerged-path count, NOT on clean === false. The two
  // axes are orthogonal: a conflict-blocked agent is usually dirty, but the count
  // must not REQUIRE dirty — conflictCount > 0 alone is the signal (so a hypothetical
  // agent serving clean:true alongside unmerged paths — e.g. a freshly-staged
  // conflict resolution not yet reflected in `git status`'s clean computation — is
  // still surfaced as blocked).
  const r = buildFleetGitStatus([ok('a1', slice(true, null, null, 0, 2))]);
  assert.equal(r.statusByKey.a1.conflictCount, 2);
  assert.equal(r.statusByKey.a1.clean, true);
  assert.equal(r.conflictCount, 1);
  assert.equal(r.dirtyCount, 0);
});
test('a clean ok agent with conflictCount 0 does NOT increment the fleet conflictCount', () => {
  // The negative case: conflictCount === 0 (no unmerged paths) ⇒ not a blocked agent.
  // Mirrors "a clean agent does not increment dirtyCount."
  const r = buildFleetGitStatus([ok('a1', slice(true)), ok('a2', slice(false, 1, 1, 1))]);
  assert.equal(r.conflictCount, 0);
  assert.equal(r.dirtyCount, 1);
});
test('conflictCount counts blocked AGENTS, not total unmerged files (the mirror of dirtyCount)', () => {
  // dirtyCount counts dirty AGENTS (not total dirty files); conflictCount is its
  // direct mirror — it counts blocked AGENTS, not the sum of their unmerged paths.
  // Two blocked agents (3 + 5 unmerged paths) ⇒ conflictCount 2, NOT 8. This is the
  // load-bearing assertion for the summary-bar "N conflict" tally's honesty.
  const r = buildFleetGitStatus([
    ok('a1', slice(false, 40, 12, 3, 3)),  // blocked, 3 unmerged
    ok('a2', slice(false, 0, 0, 5, 5)),    // blocked, 5 unmerged (+0−0 diffstat)
    ok('a3', slice(true)),                 // clean
  ]);
  assert.equal(r.conflictCount, 2);        // a1 + a2 (agents), NOT 8 (paths)
  assert.equal(r.dirtyCount, 2);           // a1 + a2 (both clean === false)
});
test('a failed agent is NOT counted as a conflict (a transient miss is never a block)', () => {
  // The WARDEN-89 contract extended to the conflict axis: an unreachable agent is
  // counted into errorCount and absent from the map — it must NEVER be read as a
  // blocked agent (which would inflate the "needs attention" tally on a transient
  // miss). A blocked agent + a failed agent ⇒ 1 conflict, 1 error.
  const r = buildFleetGitStatus([
    ok('a1', slice(false, 40, 12, 3, 3)),  // blocked
    bad('a2'),                             // unreachable
  ]);
  assert.equal(r.conflictCount, 1);        // only a1
  assert.equal(r.errorCount, 1);           // a2, NOT a conflict
  assert.deepEqual(Object.keys(r.statusByKey), ['a1']); // a2 absent
});

console.log('\nbuildFleetGitStatus — the behind axis (WARDEN-815: behind > 0 ⇒ stale agent)');
test('one BEHIND agent (behind > 0) increments the fleet behindCount, slice carried verbatim', () => {
  // The behind signal keys on behind > 0 — the same mirror dirty (clean === false) and
  // conflict (conflictCount > 0) follow. The per-agent COMMITS-behind count is carried
  // on the slice (drives the per-row ↓'s "N"); the fleet AGENT count is incremented
  // here. This agent is clean (clean === true) — a behind agent is often clean
  // (upstream-synced local work that's simply out-of-date), so behind is INDEPENDENT of
  // dirty: behindCount fires, dirtyCount does NOT.
  const r = buildFleetGitStatus([ok('a1', slice(true, null, null, 0, 0, 4))]);
  assert.deepEqual(r.statusByKey.a1, slice(true, null, null, 0, 0, 4));
  assert.equal(r.behindCount, 1);
  assert.equal(r.dirtyCount, 0);
  assert.equal(r.conflictCount, 0);
  assert.equal(r.errorCount, 0);
});
test('a fresh agent (behind 0) or a non-git/no-upstream agent (behind null) does NOT increment behindCount', () => {
  // The negative cases — mirror "a clean agent does not increment dirtyCount." behind
  // === 0 (up-to-date with upstream) is not stale; behind === null (non-git / no-branch
  // / no-upstream cwd — the same null-is-quiet discipline `clean` follows) is not stale
  // either. Both stay out of behindCount. (behind 0 still gets a map entry so the React
  // layer could distinguish "fetched + fresh" from "still loading"; today both render
  // no ↓ chip.)
  const r = buildFleetGitStatus([
    ok('a1', slice(true, null, null, 0, 0, 0)),   // fresh (0 behind)
    ok('a2', slice(null, null, null, 0, 0, null)), // non-git (behind null)
  ]);
  assert.equal(r.behindCount, 0);
  assert.equal(r.statusByKey.a1.behind, 0);
  assert.equal(r.statusByKey.a2.behind, null);
});
test('behindCount is ORTHOGONAL to dirtyCount/conflictCount (a behind-and-dirty agent increments ALL applicable axes)', () => {
  // The four axes are orthogonal agent-level counts over the same ok fleet, mirroring
  // how dirty + conflict are orthogonal (a mid-merge repo is dirty too). A behind agent
  // that is ALSO dirty (uncommitted WIP on an out-of-date base — the dangerous case:
  // further commits diverge) increments BOTH behindCount and dirtyCount; add a conflict
  // and it increments all three. The counts are agent tallies, never summed magnitudes.
  const r = buildFleetGitStatus([
    ok('a1', slice(false, 5, 2, 1, 0, 7)),  // dirty AND behind (no conflict)
    ok('a2', slice(false, 40, 12, 3, 3, 2)), // dirty AND conflict AND behind
    ok('a3', slice(true)),                    // clean, fresh
  ]);
  assert.equal(r.dirtyCount, 2);     // a1 + a2
  assert.equal(r.conflictCount, 1);  // a2 only
  assert.equal(r.behindCount, 2);    // a1 + a2
});
test('behindCount counts stale AGENTS, not total behind-commits (the mirror of dirtyCount/conflictCount)', () => {
  // dirtyCount counts dirty AGENTS (not total dirty files); conflictCount counts blocked
  // AGENTS (not total unmerged paths); behindCount is the same mirror — it counts stale
  // AGENTS, not the sum of their behind-commits. Two behind agents (4 + 9 commits
  // behind) ⇒ behindCount 2, NOT 13. This is the load-bearing assertion for the
  // summary-bar "N behind" tally's honesty.
  const r = buildFleetGitStatus([
    ok('a1', slice(true, null, null, 0, 0, 4)),   // stale, 4 behind
    ok('a2', slice(true, null, null, 0, 0, 9)),   // stale, 9 behind
    ok('a3', slice(true)),                         // fresh
  ]);
  assert.equal(r.behindCount, 2);        // a1 + a2 (agents), NOT 13 (commits)
  assert.equal(r.dirtyCount, 0);
});
test('a failed agent is NOT counted as behind (a transient miss is never stale)', () => {
  // The WARDEN-89 contract extended to the behind axis: an unreachable agent is counted
  // into errorCount and absent from the map — it must NEVER be read as a stale agent
  // (which would inflate the "running on outdated code" tally on a transient miss). A
  // behind agent + a failed agent ⇒ 1 behind, 1 error.
  const r = buildFleetGitStatus([
    ok('a1', slice(true, null, null, 0, 0, 5)),  // stale
    bad('a2'),                                   // unreachable
  ]);
  assert.equal(r.behindCount, 1);        // only a1
  assert.equal(r.errorCount, 1);         // a2, NOT behind
  assert.deepEqual(Object.keys(r.statusByKey), ['a1']); // a2 absent
});

console.log('\nbuildFleetGitStatus — the unpushed axis (WARDEN-822: ahead > 0 ⇒ stranded-work agent)');
test('one UNPUSHED agent (ahead > 0) increments the fleet aheadCount, slice carried verbatim', () => {
  // The unpushed signal keys on ahead > 0 — the mirror of how dirty keys on
  // clean === false and conflict keys on conflictCount > 0. The per-agent COMMIT count
  // is carried on the slice (drives the per-row ↑N's magnitude); the fleet AGENT count
  // is incremented here. This is THE case the axis exists for: an agent that committed
  // 5 times and never pushed has clean === true, so WITHOUT this axis it reads
  // identically to an agent fully in sync with upstream — its finished work is stranded
  // locally and invisible to the rest of the fleet. The trailing null in the slice call
  // holds the behind position so ahead lands at pos 7.
  const r = buildFleetGitStatus([ok('a1', slice(true, null, null, 0, 0, null, 5))]);
  assert.deepEqual(r.statusByKey.a1, slice(true, null, null, 0, 0, null, 5));
  assert.equal(r.aheadCount, 1);
  assert.equal(r.dirtyCount, 0);          // clean === true ⇒ NOT dirty (the blind spot)
  assert.equal(r.conflictCount, 0);
  assert.equal(r.errorCount, 0);
});
test('ahead: 0 (in-sync) does NOT increment the fleet aheadCount', () => {
  // The negative case: ahead === 0 (a branch fully in sync with its upstream) ⇒ not a
  // stranded agent. Mirrors "a clean agent does not increment dirtyCount."
  const r = buildFleetGitStatus([ok('a1', slice(true, null, null, 0, 0, null, 0))]);
  assert.equal(r.statusByKey.a1.ahead, 0);
  assert.equal(r.aheadCount, 0);
});
test('ahead: null (non-git / detached / no-upstream) does NOT increment the fleet aheadCount', () => {
  // The null-is-quiet discipline: the server serves ahead:null for a non-git cwd, a
  // detached HEAD, or a named branch with no upstream (all gated on `branch`). null is
  // neither > 0 nor an error — the agent is NOT stranded (it simply has no upstream to
  // be ahead of). This is the guard that keeps a no-upstream / non-git agent from being
  // misread as having unpushed work. The slice carries the null verbatim so the React
  // layer's chip guard (!status.ahead || <= 0) renders nothing.
  const r = buildFleetGitStatus([ok('a1', { clean: true, diffstat: null, ahead: null, conflictCount: 0, behind: null, headDate: null, headAgeMs: null, stalled: false })]);
  assert.equal(r.statusByKey.a1.ahead, null);
  assert.equal(r.aheadCount, 0);
});
test('aheadCount is ORTHOGONAL to dirtyCount/conflictCount — an unpushed-and-dirty agent increments BOTH', () => {
  // The four axes (dirty / conflict / behind / ahead) are independent counts over the
  // same ok fleet. An agent that is dirty (clean === false) AND unpushed (ahead > 0)
  // increments BOTH dirtyCount and aheadCount: a clean === false tree says nothing
  // about whether the committed work is pushed. An agent that is dirty + unpushed +
  // blocked increments dirtyCount, aheadCount, AND conflictCount. This is the
  // load-bearing orthogonality assertion — the counts must not gate on one another.
  const r = buildFleetGitStatus([
    ok('a1', slice(false, 12, 3, 2, 4, null, 5)),  // dirty + conflict + unpushed (three axes)
    ok('a2', slice(false, 1, 1, 1, 0, null, 2)),   // dirty + unpushed
    ok('a3', slice(true, null, null, 0, 0, null, 7)), // unpushed only (clean tree — the blind spot)
  ]);
  assert.equal(r.aheadCount, 3);            // a1 + a2 + a3
  assert.equal(r.dirtyCount, 2);            // a1 + a2 (a3 is clean === true)
  assert.equal(r.conflictCount, 1);         // a1 only
  assert.equal(r.errorCount, 0);
});
test('aheadCount counts stranded AGENTS, not total unpushed commits (the mirror of dirtyCount)', () => {
  // dirtyCount counts dirty AGENTS (not total dirty files); conflictCount counts blocked
  // agents (not total unmerged paths); aheadCount is their direct mirror — it counts
  // stranded AGENTS, not the sum of their unpushed commits. Two unpushed agents (5 + 7
  // commits) ⇒ aheadCount 2, NOT 12. This is the load-bearing assertion for the
  // summary-bar "N unpushed" tally's honesty.
  const r = buildFleetGitStatus([
    ok('a1', slice(true, null, null, 0, 0, null, 5)),  // 5 unpushed, clean tree
    ok('a2', slice(true, null, null, 0, 0, null, 7)),  // 7 unpushed, clean tree
    ok('a3', slice(true)),                        // in-sync (ahead 0)
  ]);
  assert.equal(r.aheadCount, 2);            // a1 + a2 (agents), NOT 12 (commits)
  assert.equal(r.dirtyCount, 0);            // all clean === true
});
test('a failed agent is NOT counted as unpushed (a transient miss is never stranded work)', () => {
  // The WARDEN-89 contract extended to the ahead axis: an unreachable agent is counted
  // into errorCount and absent from the map — it must NEVER be read as a stranded agent
  // (which would inflate the "needs attention" tally on a transient miss). An unpushed
  // agent + a failed agent ⇒ 1 unpushed, 1 error.
  const r = buildFleetGitStatus([
    ok('a1', slice(true, null, null, 0, 0, null, 5)),  // unpushed
    bad('a2'),                                   // unreachable
  ]);
  assert.equal(r.aheadCount, 1);            // only a1
  assert.equal(r.errorCount, 1);            // a2, NOT unpushed
  assert.deepEqual(Object.keys(r.statusByKey), ['a1']); // a2 absent
});

console.log('\nbuildFleetGitStatus — the stalled axis (WARDEN-847: headDate age >7d ⇒ stalled agent, derived against the threaded now)');
// A fixed staleness reference so the headAgeMs derivation is deterministic and assertions
// are exact — the SAME purity discipline summarizeProjectGitState(now) follows. 7d in ms
// (STALE_HEAD_AGE_MS in gitStateSummary.ts) is the threshold; a headDate 10d old ⇒ stalled,
// 3d old ⇒ not. `now` is passed as the 2nd arg to buildFleetGitStatus; the slice() helper
// sets headAgeMs/stalled to provisional null/false (it mirrors the clock-free fetch seam),
// and buildFleetGitStatus enriches them — the enriched values are what these assertions read.
const NOW = Date.parse('2026-07-20T00:00:00Z');
const DAY = 86400_000;
const OVER_A_WEEK_AGO = new Date(NOW - 10 * DAY).toISOString();   // 10d old ⇒ stalled
const UNDER_A_WEEK_AGO = new Date(NOW - 3 * DAY).toISOString();   // 3d old ⇒ fresh
test('one STALLED agent (headDate 10d old) increments stalledCount, headAgeMs derived, slice enriched with stalled:true', () => {
  // THE case the axis exists for: a clean, pushed, in-sync, routine agent whose HEAD is
  // >7d old reads ZERO across every existing axis — this 5th axis surfaces it. The stalled
  // signal keys on headDate parsing to a finite age > STALE_HEAD_AGE_MS (7d) against the
  // threaded now. buildFleetGitStatus derives headAgeMs (= now - Date.parse(headDate)) and
  // stalled HERE — the verbatim mirror of summarizeProjectGitState:356-363 — so the pure
  // module owns the clock and this test passes a fixed now. The slice's provisional
  // headAgeMs:null/stalled:false (from slice()) are OVERWRITTEN with the real derived
  // values before the slice reaches statusByKey (the enrichment the per-row 💤 chip reads).
  const r = buildFleetGitStatus([ok('a1', slice(true, null, null, 0, 0, null, 0, OVER_A_WEEK_AGO))], NOW);
  assert.equal(r.stalledCount, 1);
  assert.equal(r.statusByKey.a1.stalled, true);
  assert.equal(r.statusByKey.a1.headAgeMs, 10 * DAY);            // now - headMs = 10d
  assert.equal(r.statusByKey.a1.headDate, OVER_A_WEEK_AGO);      // raw pass-through carried
  assert.equal(r.dirtyCount, 0);                                 // clean tree — the blind spot
  assert.equal(r.conflictCount, 0);
  assert.equal(r.behindCount, 0);
  assert.equal(r.aheadCount, 0);
  assert.equal(r.errorCount, 0);
});
test('a FRESH agent (headDate 3d old) does NOT increment stalledCount (the age is under the 7d threshold)', () => {
  // The negative case for a real headDate: 3d old is under STALE_HEAD_AGE_MS (7d), so the
  // agent is NOT stalled even though headDate parsed to a finite age. headAgeMs is still
  // derived (3d) — the age is honest, it just hasn't crossed the threshold.
  const r = buildFleetGitStatus([ok('a1', slice(true, null, null, 0, 0, null, 0, UNDER_A_WEEK_AGO))], NOW);
  assert.equal(r.stalledCount, 0);
  assert.equal(r.statusByKey.a1.stalled, false);
  assert.equal(r.statusByKey.a1.headAgeMs, 3 * DAY);
});
test('a null-headDate agent (non-git / no-branch / no-commits cwd) is NOT stalled (Date.parse NaN ⇒ headAgeMs null)', () => {
  // The null-is-quiet discipline: the server serves headDate:null for a non-git cwd, a
  // detached/no-branch cwd, or a repo with no commits (all gated on `branch`). Date.parse
  // of a missing/empty/non-string headDate → NaN → headAgeMs null ⇒ NOT stalled — the SAME
  // discipline `clean` follows. This is the guard that keeps a non-git / no-commits agent
  // from being misread as stalled. A default slice() (headDate null) under a fixed now is
  // the canonical not-stalled case.
  const r = buildFleetGitStatus([ok('a1', slice(true))], NOW);
  assert.equal(r.stalledCount, 0);
  assert.equal(r.statusByKey.a1.stalled, false);
  assert.equal(r.statusByKey.a1.headAgeMs, null);
});
test('an INVALID headDate (unparseable string) is NOT stalled (Date.parse NaN ⇒ headAgeMs null, the defensive guard)', () => {
  // A malformed headDate the server should never send but a defensive read must survive:
  // Date.parse('not-a-date') → NaN → headAgeMs null ⇒ NOT stalled. The typeof-string gate
  // passes (it IS a string), but Number.isFinite(NaN) is false, so headAgeMs stays null —
  // the same NaN-quiet path summarizeProjectGitState follows. A garbage headDate never
  // inflates the stalled tally.
  const r = buildFleetGitStatus([ok('a1', slice(true, null, null, 0, 0, null, 0, 'not-a-date'))], NOW);
  assert.equal(r.stalledCount, 0);
  assert.equal(r.statusByKey.a1.stalled, false);
  assert.equal(r.statusByKey.a1.headAgeMs, null);
});
test('stalledCount is ORTHOGONAL to dirtyCount/conflictCount/behindCount/aheadCount — a stalled-and-otherwise-clean agent increments ONLY stalledCount', () => {
  // The five axes are independent agent-level counts over the same ok fleet. The CANONICAL
  // stalled case is an agent that is clean (no WIP), conflict-free, in sync (behind 0), AND
  // fully pushed (ahead 0) — so it reads ZERO on every state axis and ONLY stalledCount
  // fires. Add a stalled-and-dirty agent and it increments BOTH stalledCount and dirtyCount
  // (a stale tree with uncommitted WIP). The counts must not gate on one another.
  const r = buildFleetGitStatus([
    ok('a1', slice(true, null, null, 0, 0, null, 0, OVER_A_WEEK_AGO)),    // stalled ONLY (the blind spot)
    ok('a2', slice(false, 5, 2, 1, 0, null, 0, OVER_A_WEEK_AGO)),         // stalled AND dirty
    ok('a3', slice(true, null, null, 0, 0, null, 0, UNDER_A_WEEK_AGO)),   // fresh (not stalled)
  ], NOW);
  assert.equal(r.stalledCount, 2);     // a1 + a2
  assert.equal(r.dirtyCount, 1);       // a2 only (a1 + a3 are clean)
});
test('stalledCount counts AGENTS, not a sum (the mirror of dirtyCount — stalled is a per-agent boolean)', () => {
  // dirtyCount counts dirty AGENTS (not total dirty files); stalledCount is the same mirror
  // — it counts stalled AGENTS. stalled is a per-agent boolean (headDate >7d), so two stalled
  // agents ⇒ stalledCount 2 regardless of HOW stale each is (a 10d-stalled and a 30d-stalled
  // agent both count as 1). This is the load-bearing assertion for the summary-bar "N
  // stalled" tally's honesty.
  const r = buildFleetGitStatus([
    ok('a1', slice(true, null, null, 0, 0, null, 0, new Date(NOW - 10 * DAY).toISOString())),  // 10d stalled
    ok('a2', slice(true, null, null, 0, 0, null, 0, new Date(NOW - 30 * DAY).toISOString())),  // 30d stalled
    ok('a3', slice(true, null, null, 0, 0, null, 0, UNDER_A_WEEK_AGO)),                        // fresh
  ], NOW);
  assert.equal(r.stalledCount, 2);     // a1 + a2 (agents), each counted once
  assert.equal(r.statusByKey.a1.headAgeMs, 10 * DAY);
  assert.equal(r.statusByKey.a2.headAgeMs, 30 * DAY);
});
test('a failed agent is NOT counted as stalled (a transient miss is never rotting work)', () => {
  // The WARDEN-89 contract extended to the stalled axis: an unreachable agent is counted
  // into errorCount and absent from the map — it must NEVER be read as stalled (which would
  // inflate the "who has gone quiet?" tally on a transient miss). A stalled agent + a failed
  // agent ⇒ 1 stalled, 1 error.
  const r = buildFleetGitStatus([
    ok('a1', slice(true, null, null, 0, 0, null, 0, OVER_A_WEEK_AGO)),  // stalled
    bad('a2'),                                                          // unreachable
  ], NOW);
  assert.equal(r.stalledCount, 1);      // only a1
  assert.equal(r.errorCount, 1);        // a2, NOT stalled
  assert.deepEqual(Object.keys(r.statusByKey), ['a1']); // a2 absent
});
test('the headAgeMs + stalled derivation is deterministic under a fixed now (the purity discipline — same input ⇒ same output)', () => {
  // buildFleetGitStatus reads `now` from its arg, NOT Date.now(), so two calls with the same
  // outcomes + the same now yield byte-identical headAgeMs/stalled — the property that lets
  // these assertions be exact (and the property summarizeProjectGitState(now) shares). A
  // different now shifts headAgeMs by exactly the delta; stalled flips only when the age
  // crosses the 7d boundary. This is the load-bearing purity assertion: the chip's membership
  // is a pure function of (headDate, now), never of wall-clock-at-evaluation.
  const outcomes = [ok('a1', slice(true, null, null, 0, 0, null, 0, new Date(NOW - 7 * DAY - 1).toISOString()))]; // ~7d+1ms old
  const r1 = buildFleetGitStatus(outcomes, NOW);
  const r2 = buildFleetGitStatus(outcomes, NOW);
  assert.deepEqual(r1, r2);                                  // deterministic under the same now
  assert.equal(r1.stalledCount, 1);                          // just over 7d ⇒ stalled
  assert.equal(r1.statusByKey.a1.headAgeMs, 7 * DAY + 1);    // exact age (the delta is preserved)
  // One day later, the same headDate is 8d old — still stalled, age grew by exactly 1d:
  const r3 = buildFleetGitStatus(outcomes, NOW + DAY);
  assert.equal(r3.statusByKey.a1.headAgeMs, 8 * DAY + 1);
  assert.equal(r3.stalledCount, 1);
});

test('full fleet shape — mixed clean/dirty/conflict/behind/ahead/stalled/non-git/unreachable with honest counts', () => {
  // The integration test: every axis fires on a realistic mixed fleet, the five
  // orthogonal counts (dirty / conflict / behind / ahead / stalled) are all honest agent
  // tallies, and an ok:false agent is absent + counted only as an error. behind lives at
  // pos 6, ahead at pos 7, headDate at pos 8 of the slice() helper — a call exercising
  // one axis passes null for the others so a single agent can be dirty+ahead (a1),
  // dirty+behind (j1), behind-only clean (i1), ahead-only clean (k1), or stalled-only
  // clean (l1 — the canonical blind spot). NOW threads a fixed clock so the stalled
  // agent's headAgeMs derivation is deterministic.
  const r = buildFleetGitStatus([
    ok('a1', slice(false, 847, 203, 12, 0, null, 2)),  // dirty, heavy, 2 unpushed (dirty AND ahead)
    ok('b1', slice(true)),                              // clean, in-sync
    ok('c1', slice(false, null)),                       // dirty, all-untracked (still counts)
    ok('d1', slice(null)),                              // non-git (neither)
    bad('e1'),                                          // unreachable (error)
    ok('f1', slice(false, 0, 0, 0)),                    // dirty, +0−0 (still counts)
    ok('g1', slice(false, 40, 12, 3, 3)),               // blocked mid-merge, 3 unmerged (WARDEN-796)
    ok('h1', slice(false, 0, 0, 5, 5)),                 // blocked mid-merge, 5 unmerged, +0−0 magnitude
    ok('i1', slice(true, null, null, 0, 0, 6)),         // stale, 6 behind, clean (WARDEN-815)
    ok('j1', slice(false, 5, 2, 1, 0, 3)),              // dirty AND behind (the diverge case)
    ok('k1', slice(true, null, null, 0, 0, null, 7)),   // CLEAN tree, 7 unpushed — the blind spot (WARDEN-822)
    ok('l1', slice(true, null, null, 0, 0, null, 0, OVER_A_WEEK_AGO)), // CLEAN/in-sync/pushed, HEAD >7d — the stalled blind spot (WARDEN-847)
  ], NOW);
  assert.equal(r.dirtyCount, 6);                  // a1 + c1 + f1 + g1 + h1 + j1 (clean === false)
  assert.equal(r.conflictCount, 2);               // g1 + h1 (conflictCount > 0) — agents, not 8 paths
  assert.equal(r.behindCount, 2);                  // i1 + j1 (behind > 0) — agents, not 9 commits
  assert.equal(r.aheadCount, 2);                  // a1 + k1 (ahead > 0) — agents, not 9 commits
  assert.equal(r.stalledCount, 1);                // l1 only (headDate >7d) — the canonical otherwise-clean agent
  assert.equal(r.errorCount, 1);                  // e1
  assert.deepEqual(Object.keys(r.statusByKey), ['a1', 'b1', 'c1', 'd1', 'f1', 'g1', 'h1', 'i1', 'j1', 'k1', 'l1']); // e1 absent
  assert.equal(r.statusByKey.a1.diffstat.insertions, 847);
  assert.equal(r.statusByKey.a1.ahead, 2);        // dirty agent can ALSO be unpushed (orthogonal axes)
  assert.equal(r.statusByKey.d1.clean, null);
  assert.equal(r.statusByKey.g1.conflictCount, 3); // per-agent path count carried verbatim
  assert.equal(r.statusByKey.h1.conflictCount, 5);
  assert.equal(r.statusByKey.i1.behind, 6);        // per-agent behind count carried verbatim
  assert.equal(r.statusByKey.j1.behind, 3);
  assert.equal(r.statusByKey.k1.clean, true);      // the stranded agent's tree is clean — clean alone can't surface it
  assert.equal(r.statusByKey.k1.ahead, 7);         // …but its 7 committed commits ARE unpushed
  assert.equal(r.statusByKey.l1.clean, true);      // the stalled agent reads ZERO on every state axis…
  assert.equal(r.statusByKey.l1.ahead, 0);         // …fully pushed…
  assert.equal(r.statusByKey.l1.behind, null);     // …in sync / no-upstream…
  assert.equal(r.statusByKey.l1.stalled, true);    // …yet its HEAD is >7d old — stalled surfaces where every axis is 0
  assert.equal(r.statusByKey.l1.headAgeMs, 10 * DAY); // derived headAgeMs (now - headMs)
});

console.log('\nbuildFleetGitStatusUrl — the /api/git-status?id= fetch URL');
test('builds an id-only URL (single-shot per-chat probe, no query/limit)', () => {
  assert.equal(buildFleetGitStatusUrl('a1'), '/api/git-status?id=a1');
  // The defining difference from buildFleetRecentCommitsUrl: no &limit= (git-status
  // is not a list), and a different route (git-status, not git-log).
  assert.ok(!buildFleetGitStatusUrl('a1').includes('limit='), 'git-status URL must carry no limit');
});
test('id is URL-encoded (a key with special chars stays one param value)', () => {
  // Mirrors the WARDEN-122 argv discipline on the backend: the key reaches git as ONE
  // argument. A container/host key with a colon must be encoded so it cannot split.
  assert.equal(buildFleetGitStatusUrl('host:container'), '/api/git-status?id=host%3Acontainer');
});
test('a key needing multiple encoded chars encodes all of them', () => {
  // A path-ish / shell-ish key: every reserved char is percent-encoded, keeping the
  // id a single param value (no param smuggling via & or =).
  const url = buildFleetGitStatusUrl('a&b=c d');
  assert.equal(url, '/api/git-status?id=a%26b%3Dc%20d');
  assert.ok(!url.includes('&id='), 'an encoded & must not open a second param');
});

console.log(`\n✓ FLEET GIT STATUS TESTS PASS (${passed})`);
