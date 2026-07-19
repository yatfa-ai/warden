// Tests for the pure aggregation behind WARDEN-766's Fleet Health git-status fan:
// buildFleetGitStatus (turn N per-agent /api/git-status outcomes into a per-agent
// { clean, diffstat } map + a fleet dirty count + an honest error count) +
// buildFleetGitStatusUrl (the /api/git-status?id= fetch URL).
//
// These are the working-tree-STATE counterparts to mergeFleetCommitsByEpoch /
// buildFleetRecentCommitsUrl (the commit-HISTORY fan) in the same module. The hook
// itself (useFleetGitStatus) is React — not testable without a front-end runner, of
// which this repo has none — so these tests cover ONLY the pure seam: how N
// per-agent statuses fold into the Fleet Health view, that the dirty signal keys on
// `clean === false` (not the diffstat magnitude), that a clean:null non-git agent is
// neither dirty nor an error, and that a per-agent failure is counted honestly
// without blanking the rest (the WARDEN-89 false-empty contract).
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

// Tiny builders so each case reads as "which agents are clean/dirty/unreachable".
// `slice` mirrors FleetGitStatusSlice ({ clean, diffstat }) — the two fields the UI
// reads off /api/git-status. clean === false ⇒ dirty; diffstat is { files, insertions,
// deletions } | null (null for a clean / non-git / all-untracked tree).
const slice = (clean, insertions = null, deletions = null, files = 0) => ({
  clean,
  diffstat: insertions === null ? null : { files, insertions, deletions },
});
// A fulfilled per-agent outcome: that agent's status slice. clean === false is the
// dirty signal (mirrors summarizeProjectGitState's `dirty = status.clean === false`).
const ok = (key, status) => ({ ok: true, key, status });
// A rejected/unreachable per-agent outcome.
const bad = (key) => ({ ok: false, key });

console.log('\nbuildFleetGitStatus — fold N per-agent statuses into a map + dirty/error counts');
test('empty input is safe (no agents → empty map, zero counts)', () => {
  assert.deepEqual(buildFleetGitStatus([]), { statusByKey: {}, dirtyCount: 0, errorCount: 0 });
});
test('one CLEAN agent: map gets an entry, dirtyCount stays 0, errorCount 0', () => {
  const r = buildFleetGitStatus([ok('a1', slice(true))]);
  assert.deepEqual(r.statusByKey, { a1: { clean: true, diffstat: null } });
  assert.equal(r.dirtyCount, 0);
  assert.equal(r.errorCount, 0);
});
test('one DIRTY agent with a magnitude: dirtyCount 1, slice carried verbatim', () => {
  const r = buildFleetGitStatus([ok('a1', slice(false, 12, 3, 2))]);
  assert.deepEqual(r.statusByKey.a1, { clean: false, diffstat: { files: 2, insertions: 12, deletions: 3 } });
  assert.equal(r.dirtyCount, 1);
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
test('a clean:null (non-git / no-branch) agent is NEITHER dirty NOR an error', () => {
  // The server gates `clean: branch ? clean : null` — a non-git cwd serves clean:null.
  // null !== false ⇒ not dirty; the agent is a resolved ok outcome ⇒ not an error.
  // It gets a map entry (clean:null) so the React layer could distinguish "fetched but
  // non-git" from "still loading"; today both render no chip.
  const r = buildFleetGitStatus([ok('a1', slice(null))]);
  assert.deepEqual(r.statusByKey, { a1: { clean: null, diffstat: null } });
  assert.equal(r.dirtyCount, 0);
  assert.equal(r.errorCount, 0);
});
test('a failed agent (ok:false) is counted as an error, NEVER as dirty, and gets no map entry', () => {
  // The WARDEN-89 contract: an unreachable / non-git-error agent must never masquerade
  // as a clean/empty status. It is counted into errorCount and ABSENT from the map (so
  // statusByKey[id] is undefined → the React layer renders the graceful-N/A nothing,
  // NOT a false clean chip).
  const r = buildFleetGitStatus([bad('a1')]);
  assert.deepEqual(r.statusByKey, {});
  assert.equal(r.dirtyCount, 0);
  assert.equal(r.errorCount, 1);
});
test('a failed agent does NOT blank the successful agents (partial-failure tolerance)', () => {
  // The Promise.allSettled fleet contract: one unreachable agent must not reject the
  // whole. ok-dirty + failed + ok-clean → the two ok agents' statuses in the map, 1
  // dirty, 1 error.
  const r = buildFleetGitStatus([
    ok('a1', slice(false, 5, 1, 1)),
    bad('a2'),
    ok('a3', slice(true)),
  ]);
  assert.deepEqual(Object.keys(r.statusByKey), ['a1', 'a3']);
  assert.equal(r.dirtyCount, 1);
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
    a1: { clean: true, diffstat: null },
    a2: { clean: false, diffstat: { files: 1, insertions: 2, deletions: 2 } },
  });
  assert.equal(r.dirtyCount, 1);
});
test('full fleet shape — mixed clean/dirty/non-git/unreachable with honest counts', () => {
  const r = buildFleetGitStatus([
    ok('a1', slice(false, 847, 203, 12)),  // dirty, heavy
    ok('b1', slice(true)),                  // clean
    ok('c1', slice(false, null)),           // dirty, all-untracked (still counts)
    ok('d1', slice(null)),                  // non-git (neither)
    bad('e1'),                              // unreachable (error)
    ok('f1', slice(false, 0, 0, 0)),        // dirty, +0−0 (still counts)
  ]);
  assert.equal(r.dirtyCount, 3);            // a1 + c1 + f1 (clean === false)
  assert.equal(r.errorCount, 1);            // e1
  assert.deepEqual(Object.keys(r.statusByKey), ['a1', 'b1', 'c1', 'd1', 'f1']); // e1 absent
  assert.equal(r.statusByKey.a1.diffstat.insertions, 847);
  assert.equal(r.statusByKey.d1.clean, null);
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
