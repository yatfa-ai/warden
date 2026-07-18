// Tests for summarizeProjectGitState — the pure aggregator behind the project
// filter chips' uncommitted/unpushed/behind WIP badges (WARDEN-201), now with the
// per-project contributing-agent breakdown that makes those badges explorable
// (WARDEN-268) and the third divergence axis, behind-upstream ↓N (WARDEN-297).
//
// There is no front-end test runner in this repo, so (like diff.test.mjs) this
// loads the REAL src/lib/gitStateSummary.ts (transpiled TS -> ESM via Vite's OXC
// transform) and exercises it directly with plain objects. The helper must be a
// faithful, sparse mirror of the per-row GitBranchBadge vocabulary: clean===false
// ⇒ dirty (yellow ±), ahead > 0 ⇒ unpushed (amber ↑N), behind > 0 ⇒ behind
// (blue ↓N) — and a chat with unknown status (missing from the cached gitStatus
// map) must count as NEITHER, never as clean, so a still-loading agent can't
// masquerade as a clean repo.
//
// The WARDEN-268 additions assert the `agents` breakdown: each contributing agent
// (dirty and/or unpushed and/or behind) appears once with { key, dirty, ahead,
// behind }, in chats iteration order, so the chip's ±N / ↑N / ↓N popovers can
// list exactly who is dirty vs. unpushed vs. behind and jump to them. The helper
// stays display-field-free (no title, no branch) — the React layer joins
// key → displayName/branch.
//
// Run: node gitStateSummary.test.mjs   (from web/)
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
const tmpDir = mkdtempSync(join(tmpdir(), 'warden-gitstate-test-'));
const tmpFile = join(tmpDir, 'gitStateSummary.mjs');
writeFileSync(tmpFile, code);
const { summarizeProjectGitState, sortByHeadAgeDesc, sortByStashCountDesc, detectProjectFileCollisions, detectProjectImpendingCollisions, detectProjectOutgoingCollisions, sortGitAgentsByMagnitudeDesc, sortGitAgentsByConflictFirst } = await import(tmpFile);
rmSync(tmpDir, { recursive: true, force: true });

let passed = 0;
const test = (name, fn) => {
  fn();
  passed += 1;
  console.log('  ok -', name);
};

// A tiny builder so each case reads as "which agents have which status" rather
// than a wall of {key,id,project,active} literals.
const agent = (id, project, key) => ({ id, project, active: true, key });
// behind defaults to 0 so every pre-WARDEN-297 case (which never specified a
// behind count) still reads as "not behind" without touching each call site —
// the implementation treats an absent behind exactly the same. The trailing
// `extra` object (WARDEN-635 / WARDEN-667) lets an at-risk case add the new
// status fields ({ detached: true }, { branch, upstream }, { inProgress:
// { operation } }) OR a stash case add { stashCount: N } without a positional
// explosion; existing 3-arg calls spread nothing and stay non-at-risk and
// non-stashed (detached absent ⇒ falsy; branch absent ⇒ the !!branch gate is
// false ⇒ not noUpstream; stashCount absent ⇒ 0 ⇒ not stashed), mirroring how the
// behind default kept older cases green.
const status = (clean, ahead, behind = 0, extra = {}) => ({ clean, ahead, behind, ...extra });
// The expected shape of a contributing-agent entry (WARDEN-268 + WARDEN-297 +
// WARDEN-635 + WARDEN-667 + WARDEN-669 + WARDEN-670 + WARDEN-682 + WARDEN-689 +
// WARDEN-701). behind defaults to 0 to mirror status(); atRisk defaults to false +
// atRiskReason to null so a pre-635 expected agent reads as not-at-risk without
// touching each call site; stashed defaults to false so a pre-667 expected agent
// reads as not-stashed the same way; stashCount (WARDEN-689, 8th arg — right after
// the `stashed` boolean it magnifies, mirroring how `ahead`/`behind` carry their
// counts alongside their > 0 booleans) defaults to 0 so any pre-689 expected agent
// reads as stash-free the same way (absent stashCount on the status ⇒ 0 ⇒ stashed:
// false ⇒ consistent); headAgeMs defaults to null (WARDEN-669) so a pre-669 fixture
// (no headDate) reads as age-unknown; diffstat (WARDEN-670) defaults to null so EVERY
// pre-670 expected agent carries the field (the implementation reads `status.diffstat
// ?? null`) -- absent fields are treated the same by the implementation, so old cases
// stay green exactly as the behind/atRisk/stashed/stashCount/headAgeMs defaults kept
// their predecessors green; stalled (WARDEN-682) defaults to false so a pre-682
// expected agent reads as not-stalled the same way; conflictCount (WARDEN-701) defaults
// to 0 so EVERY pre-701 expected agent carries the field (the implementation counts
// status.files conflict flags, 0 when none) -- absent fields are treated the same by
// the implementation, so old cases stay green exactly as the earlier defaults kept
// their predecessors green. A WARDEN-669 case passes a finite headAgeMs as the 9th arg
// (after a 0 stashCount); a WARDEN-670 case passes the inline { files, insertions,
// deletions } magnitude as the 10th (after a 0 stashCount + null headAgeMs
// placeholder), mirroring how status()'s `extra` object carries diffstat on the input
// side; a WARDEN-682 stalled case passes headAgeMs (9th, the >7d age), a null diffstat
// placeholder (10th), and stalled:true (11th). A stashed:true case MUST pass its
// explicit count as the 8th arg (its input stashCount), since stashed:true ⇔
// stashCount > 0 and deep-equality checks the magnitude. A WARDEN-701 conflict case
// passes the atRiskReason 'conflict' (6th) and conflictCount N (12th, after the
// stalled placeholder) for a merge-conflict-blocked agent.
const ag = (key, dirty, ahead, behind = 0, atRisk = false, atRiskReason = null, stashed = false, stashCount = 0, headAgeMs = null, diffstat = null, stalled = false, conflictCount = 0) => ({ key, dirty, ahead, behind, atRisk, atRiskReason, stashed, stashCount, headAgeMs, diffstat, stalled, conflictCount });

// WARDEN-682: a fixed `now` so the stalled (>7d) assertions are deterministic — the
// module's `now` arg defaults to Date.now() in production (ChatSidebar); stalled-axis
// tests pass NOW explicitly so a headDate = NOW−9d yields a stable headAgeMs = 9d.
// `sum` forwards an OPTIONAL now: WARDEN-669's headAgeMs bound-check tests call
// `sum(chats, gitStatus)` (no now) so they keep the Date.now() default and their
// before/after bounds hold; stalled tests pass NOW as the 3rd arg for determinism.
const NOW = 1_700_000_000_000;
const sum = (chats, gitStatus, now) => summarizeProjectGitState(chats, gitStatus, now);

console.log('\nclean project → no counts (badges hidden)');
test('a clean, pushed, up-to-date agent yields no per-project entry and zero totals', () => {
  const r = sum([agent('a1', 'warden')], { a1: status(true, 0) });
  assert.deepEqual(r.perProject, {});
  assert.deepEqual(r.total, { dirty: 0, unpushed: 0, behind: 0, atRisk: 0, stashed: 0, stalled: 0, agents: [] });
});

console.log('\ndirty-only → counts toward dirty, not unpushed/behind');
test('clean===false with ahead 0 → dirty:1, unpushed:0', () => {
  const r = sum([agent('a1', 'warden')], { a1: status(false, 0) });
  assert.deepEqual(r.perProject, { warden: { dirty: 1, unpushed: 0, behind: 0, atRisk: 0, stashed: 0, stalled: 0, agents: [ag('a1', true, 0)] } });
  assert.deepEqual(r.total, { dirty: 1, unpushed: 0, behind: 0, atRisk: 0, stashed: 0, stalled: 0, agents: [ag('a1', true, 0)] });
});

console.log('\nunpushed-only → counts toward unpushed, not dirty/behind');
test('clean repo with ahead 3 → dirty:0, unpushed:1', () => {
  const r = sum([agent('a1', 'warden')], { a1: status(true, 3) });
  assert.deepEqual(r.perProject, { warden: { dirty: 0, unpushed: 1, behind: 0, atRisk: 0, stashed: 0, stalled: 0, agents: [ag('a1', false, 3)] } });
  assert.deepEqual(r.total, { dirty: 0, unpushed: 1, behind: 0, atRisk: 0, stashed: 0, stalled: 0, agents: [ag('a1', false, 3)] });
});

console.log('\nboth → one agent contributes once to each counter (not doubled)');
test('clean===false AND ahead 2 → dirty:1, unpushed:1', () => {
  const r = sum([agent('a1', 'warden')], { a1: status(false, 2) });
  assert.deepEqual(r.perProject, { warden: { dirty: 1, unpushed: 1, behind: 0, atRisk: 0, stashed: 0, stalled: 0, agents: [ag('a1', true, 2)] } });
  assert.deepEqual(r.total, { dirty: 1, unpushed: 1, behind: 0, atRisk: 0, stashed: 0, stalled: 0, agents: [ag('a1', true, 2)] });
});

console.log('\nmulti-project aggregation');
test('counts accumulate per project and across projects independently', () => {
  const chats = [
    agent('a1', 'warden'),
    agent('a2', 'warden'),
    agent('a3', 'warden'),
    agent('b1', 'tinker'),
  ];
  // warden: 2 dirty (a1,a2) + 1 also unpushed (a2); a3 clean.
  // tinker: 1 unpushed only (b1).
  const gitStatus = {
    a1: status(false, 0), // dirty only
    a2: status(false, 2), // dirty + unpushed
    a3: status(true, 0),  // clean → contributes nothing
    b1: status(true, 5),  // unpushed only
  };
  const r = sum(chats, gitStatus);
  assert.deepEqual(r.perProject, {
    warden: { dirty: 2, unpushed: 1, behind: 0, atRisk: 0, stashed: 0, stalled: 0, agents: [ag('a1', true, 0), ag('a2', true, 2)] },
    tinker: { dirty: 0, unpushed: 1, behind: 0, atRisk: 0, stashed: 0, stalled: 0, agents: [ag('b1', false, 5)] },
  });
  assert.deepEqual(r.total, { dirty: 2, unpushed: 2, behind: 0, atRisk: 0, stashed: 0, stalled: 0, agents: [ag('a1', true, 0), ag('a2', true, 2), ag('b1', false, 5)] });
});

console.log('\nunknown status (missing from gitStatus) counts as NEITHER, never clean');
test('an active project agent absent from the map → no entry, no totals', () => {
  const r = sum([agent('a1', 'warden')], {});
  assert.deepEqual(r.perProject, {});
  assert.deepEqual(r.total, { dirty: 0, unpushed: 0, behind: 0, atRisk: 0, stashed: 0, stalled: 0, agents: [] });
});
test('a still-loading agent never masks a dirty sibling in the same project', () => {
  // a1 dirty & known, a2 unknown: a2 must NOT be treated as clean and must not
  // dilute a1's dirty count (the false-clean trap this slice guards against).
  const r = sum([agent('a1', 'warden'), agent('a2', 'warden')], { a1: status(false, 0) });
  assert.deepEqual(r.perProject, { warden: { dirty: 1, unpushed: 0, behind: 0, atRisk: 0, stashed: 0, stalled: 0, agents: [ag('a1', true, 0)] } });
  assert.deepEqual(r.total, { dirty: 1, unpushed: 0, behind: 0, atRisk: 0, stashed: 0, stalled: 0, agents: [ag('a1', true, 0)] });
});

console.log('\nnull/unknown field values are quiet, not counted');
test('clean:null is not dirty (only explicit clean===false is)', () => {
  const r = sum([agent('a1', 'warden')], { a1: status(null, 1) });
  assert.deepEqual(r.perProject, { warden: { dirty: 0, unpushed: 1, behind: 0, atRisk: 0, stashed: 0, stalled: 0, agents: [ag('a1', false, 1)] } });
});
test('ahead:null is not unpushed (only a number > 0 is)', () => {
  const r = sum([agent('a1', 'warden')], { a1: status(false, null) });
  assert.deepEqual(r.perProject, { warden: { dirty: 1, unpushed: 0, behind: 0, atRisk: 0, stashed: 0, stalled: 0, agents: [ag('a1', true, 0)] } });
});
test('behind:null is not behind (only a number > 0 is) — a non-tracking agent (detached / no upstream) stays quiet', () => {
  // Mirrors ahead:null ⇒ not unpushed. behind:null means there is no @{u} to
  // compare against, so the agent must NOT surface as behind.
  const r = sum([agent('a1', 'warden')], { a1: status(false, 0, null) });
  assert.deepEqual(r.perProject, { warden: { dirty: 1, unpushed: 0, behind: 0, atRisk: 0, stashed: 0, stalled: 0, agents: [ag('a1', true, 0, 0)] } });
});
test('ahead:0 is not unpushed', () => {
  const r = sum([agent('a1', 'warden')], { a1: status(false, 0) });
  assert.equal(r.perProject.warden.unpushed, 0);
});
test('behind:0 is not behind', () => {
  const r = sum([agent('a1', 'warden')], { a1: status(false, 0, 0) });
  assert.equal(r.perProject.warden.behind, 0);
});

console.log('\npopulation matches projectCounts: inactive / project-less chats are skipped');
test('inactive agent (active:false) is ignored even when dirty', () => {
  const r = sum([{ id: 'a1', project: 'warden', active: false }], { a1: status(false, 5) });
  assert.deepEqual(r.perProject, {});
  assert.deepEqual(r.total, { dirty: 0, unpushed: 0, behind: 0, atRisk: 0, stashed: 0, stalled: 0, agents: [] });
});
test('active agent without a project is ignored (chips are project-scoped)', () => {
  const r = sum([{ id: 'a1', active: true }], { a1: status(false, 5) });
  assert.deepEqual(r.perProject, {});
  assert.deepEqual(r.total, { dirty: 0, unpushed: 0, behind: 0, atRisk: 0, stashed: 0, stalled: 0, agents: [] });
});

console.log('\nkey resolution: status is looked up by key || id (matches per-row lookups)');
test('when key is set, the status is read from gitStatus[key], not gitStatus[id]', () => {
  // container key 'warden-worker' set; status keyed by key. An entry keyed by the
  // bare id must be IGNORED so a yatfa agent isn't misread from a stale id-keyed row.
  const chats = [agent('raw-id', 'warden', 'warden-worker')];
  const gitStatus = {
    'raw-id': status(false, 5),      // must be ignored (wrong key)
    'warden-worker': status(true, 0), // clean → no counts
  };
  const r = sum(chats, gitStatus);
  assert.deepEqual(r.perProject, {});
  assert.deepEqual(r.total, { dirty: 0, unpushed: 0, behind: 0, atRisk: 0, stashed: 0, stalled: 0, agents: [] });
});
test('when no key, the status is read from gitStatus[id]', () => {
  const chats = [{ id: 'chat-1', project: 'warden', active: true }];
  const r = sum(chats, { 'chat-1': status(false, 0) });
  assert.deepEqual(r.perProject, { warden: { dirty: 1, unpushed: 0, behind: 0, atRisk: 0, stashed: 0, stalled: 0, agents: [ag('chat-1', true, 0)] } });
});

console.log('\ntotal always equals the sum across projects');
test('total.dirty/unpushed/behind equal the per-project sums', () => {
  const chats = [
    agent('a1', 'warden'), agent('a2', 'warden'),
    agent('b1', 'tinker'), agent('c1', 'nova'),
  ];
  const gitStatus = {
    a1: status(false, 0), a2: status(true, 4),
    b1: status(false, 1), c1: status(true, 0),
  };
  const r = sum(chats, gitStatus);
  const sumDirty = Object.values(r.perProject).reduce((n, p) => n + p.dirty, 0);
  const sumUnpushed = Object.values(r.perProject).reduce((n, p) => n + p.unpushed, 0);
  const sumBehind = Object.values(r.perProject).reduce((n, p) => n + p.behind, 0);
  assert.equal(r.total.dirty, sumDirty);
  assert.equal(r.total.unpushed, sumUnpushed);
  assert.equal(r.total.behind, sumBehind);
  // c1 is clean → 'nova' is absent from the sparse map.
  assert.equal('nova' in r.perProject, false);
});

console.log('\nempty inputs are safe');
test('no chats → empty per-project, zero totals', () => {
  const r = sum([], { x: status(false, 5) });
  assert.deepEqual(r.perProject, {});
  assert.deepEqual(r.total, { dirty: 0, unpushed: 0, behind: 0, atRisk: 0, stashed: 0, stalled: 0, agents: [] });
});

console.log('\nagents breakdown: which agents have uncommitted/unpushed work (WARDEN-268)');
test('a dirty agent appears in agents with dirty:true; a clean agent does not appear', () => {
  const chats = [agent('a1', 'warden'), agent('a2', 'warden')];
  const r = sum(chats, { a1: status(false, 0), a2: status(true, 0) });
  assert.deepEqual(r.perProject.warden.agents, [ag('a1', true, 0)]);
  // a2 is clean → absent from the contributing list entirely (not a false-clean entry).
  assert.ok(!r.perProject.warden.agents.some((a) => a.key === 'a2'));
});

test('an unpushed agent appears with ahead > 0; an ahead-0/clean one does not', () => {
  const chats = [agent('a1', 'warden'), agent('a2', 'warden')];
  const r = sum(chats, { a1: status(true, 4), a2: status(true, 0) });
  assert.deepEqual(r.perProject.warden.agents, [ag('a1', false, 4)]);
  assert.ok(!r.perProject.warden.agents.some((a) => a.key === 'a2'));
});

test('an agent both dirty AND unpushed appears ONCE with both signals', () => {
  const r = sum([agent('a1', 'warden')], { a1: status(false, 3) });
  // One entry, not two: the ±N list and the ↑N list filter this SAME entry rather
  // than the agent being duplicated across two lists.
  assert.equal(r.perProject.warden.agents.length, 1);
  assert.deepEqual(r.perProject.warden.agents, [ag('a1', true, 3)]);
});

test('an active project agent absent from gitStatus does NOT appear (false-clean trap)', () => {
  // a1 dirty & known, a2 unknown: a2 must not surface in agents any more than it
  // counts toward dirty — a still-loading agent can't masquerade as a clean repo.
  const r = sum([agent('a1', 'warden'), agent('a2', 'warden')], { a1: status(false, 0) });
  assert.deepEqual(r.perProject.warden.agents, [ag('a1', true, 0)]);
});

test('key || id resolution carries through to the entry key', () => {
  // container key 'warden-worker' set: the contributing entry is keyed by it, so
  // the React layer's findChat(chats, key) lands on the right chat row.
  const chats = [agent('raw-id', 'warden', 'warden-worker')];
  const r = sum(chats, { 'warden-worker': status(false, 0) });
  assert.deepEqual(r.perProject.warden.agents, [ag('warden-worker', true, 0)]);
  assert.equal(r.perProject.warden.agents[0].key, 'warden-worker');
});

test('total.agents is the union across projects; order is stable (iteration order)', () => {
  const chats = [
    agent('a1', 'warden'), agent('a2', 'warden'),
    agent('b1', 'tinker'), agent('c1', 'nova'),
  ];
  const gitStatus = {
    a1: status(false, 0), a2: status(true, 4),
    b1: status(false, 1), c1: status(true, 2),
  };
  const r = sum(chats, gitStatus);
  // Iteration order is preserved across the union: a1, a2 (warden), then b1
  // (tinker), then c1 (nova) — deterministic so tests assert deep equality.
  assert.deepEqual(r.total.agents, [
    ag('a1', true, 0), ag('a2', false, 4),
    ag('b1', true, 1), ag('c1', false, 2),
  ]);
  // Each project's own list is its contiguous slice, in the same order.
  assert.deepEqual(r.perProject.warden.agents, [ag('a1', true, 0), ag('a2', false, 4)]);
  assert.deepEqual(r.perProject.tinker.agents, [ag('b1', true, 1)]);
  assert.deepEqual(r.perProject.nova.agents, [ag('c1', false, 2)]);
});

test('the dirty filter matches ±N and the ahead>0 filter matches ↑N (the popover contract)', () => {
  // This is the exact contract the two chip popovers rely on: ±N lists
  // agents.filter(a => a.dirty); ↑N lists agents.filter(a => a.ahead > 0). The
  // filtered lengths must equal the chip's count fields.
  const chats = [agent('a1', 'warden'), agent('a2', 'warden'), agent('a3', 'warden')];
  const gitStatus = {
    a1: status(false, 0), // dirty only
    a2: status(false, 2), // both dirty and unpushed
    a3: status(true, 5),  // unpushed only
  };
  const r = sum(chats, gitStatus);
  const agents = r.perProject.warden.agents;
  assert.deepEqual(agents.filter((a) => a.dirty), [ag('a1', true, 0), ag('a2', true, 2)]);
  assert.deepEqual(agents.filter((a) => a.ahead > 0), [ag('a2', true, 2), ag('a3', false, 5)]);
  assert.equal(r.perProject.warden.dirty, agents.filter((a) => a.dirty).length);
  assert.equal(r.perProject.warden.unpushed, agents.filter((a) => a.ahead > 0).length);
});

console.log('\nbehind axis (WARDEN-297): ↓N is the symmetric counterpart to ↑N');
test('a behind-only agent now surfaces (behind:1, no dirty/unpushed) — the key behavioral change', () => {
  // Before WARDEN-297 the skip-clean guard dropped a behind-only agent entirely
  // (it was neither dirty nor unpushed). Now it must appear so the chip can show ↓N.
  const r = sum([agent('a1', 'warden')], { a1: status(true, 0, 4) });
  assert.deepEqual(r.perProject, { warden: { dirty: 0, unpushed: 0, behind: 1, atRisk: 0, stashed: 0, stalled: 0, agents: [ag('a1', false, 0, 4)] } });
  assert.deepEqual(r.total, { dirty: 0, unpushed: 0, behind: 1, atRisk: 0, stashed: 0, stalled: 0, agents: [ag('a1', false, 0, 4)] });
});

test('an agent both dirty AND behind appears ONCE with both signals', () => {
  // clean===false AND behind 2: one entry, dirty + behind, counted in each.
  const r = sum([agent('a1', 'warden')], { a1: status(false, 0, 2) });
  assert.equal(r.perProject.warden.agents.length, 1);
  assert.deepEqual(r.perProject.warden.agents, [ag('a1', true, 0, 2)]);
  assert.equal(r.perProject.warden.dirty, 1);
  assert.equal(r.perProject.warden.behind, 1);
  assert.equal(r.perProject.warden.unpushed, 0);
});

test('an agent both ahead AND behind (diverged both ways) appears ONCE with both signals', () => {
  // A repo can be ahead AND behind simultaneously — local commits origin lacks AND
  // origin commits local lacks. It must count toward both unpushed and behind,
  // once, and the entry carries both counts.
  const r = sum([agent('a1', 'warden')], { a1: status(true, 3, 5) });
  assert.equal(r.perProject.warden.agents.length, 1);
  assert.deepEqual(r.perProject.warden.agents, [ag('a1', false, 3, 5)]);
  assert.equal(r.perProject.warden.unpushed, 1);
  assert.equal(r.perProject.warden.behind, 1);
});

test('a behind agent mixes with dirty/unpushed siblings across the same project', () => {
  const chats = [agent('a1', 'warden'), agent('a2', 'warden'), agent('a3', 'warden')];
  const gitStatus = {
    a1: status(false, 0, 0), // dirty only
    a2: status(true, 0, 7),  // behind only
    a3: status(false, 2, 3), // dirty + unpushed + behind (all three)
  };
  const r = sum(chats, gitStatus);
  assert.deepEqual(r.perProject, {
    warden: {
      dirty: 2, unpushed: 1, behind: 2, atRisk: 0,
      stashed: 0, stalled: 0, agents: [ag('a1', true, 0, 0), ag('a2', false, 0, 7), ag('a3', true, 2, 3)],
    },
  });
  assert.deepEqual(r.total, {
    dirty: 2, unpushed: 1, behind: 2, atRisk: 0,
    stashed: 0, stalled: 0, agents: [ag('a1', true, 0, 0), ag('a2', false, 0, 7), ag('a3', true, 2, 3)],
  });
});

test('the behind>0 filter matches ↓N (the popover contract), mirroring ±N / ↑N', () => {
  // The ↓N chip popover lists agents.filter(a => a.behind > 0); that filtered
  // length must equal the chip's behind count field — exact parity with the
  // ±N/↑N contract above.
  const chats = [agent('a1', 'warden'), agent('a2', 'warden'), agent('a3', 'warden')];
  const gitStatus = {
    a1: status(true, 0, 6),  // behind only
    a2: status(false, 2, 1), // dirty + unpushed + behind
    a3: status(false, 0, 0), // dirty only (not behind)
  };
  const r = sum(chats, gitStatus);
  const agents = r.perProject.warden.agents;
  // Iteration order is preserved: a1 (behind only) then a2 (all three); a3 is
  // not behind so it is filtered out.
  assert.deepEqual(agents.filter((a) => a.behind > 0), [ag('a1', false, 0, 6), ag('a2', true, 2, 1)]);
  assert.equal(r.perProject.warden.behind, agents.filter((a) => a.behind > 0).length);
});

test('a behind-only project gets a sparse-map entry (it would have been absent pre-WARDEN-297)', () => {
  // The sparse "needs attention" map now keys on behind too: a project whose only
  // active agent is behind (clean tree, pushed, but stale) must NOT be dropped.
  const r = sum([agent('a1', 'warden'), agent('b1', 'tinker')], {
    a1: status(true, 0, 9), // behind only
    b1: status(true, 0, 0), // clean → tinker absent
  });
  assert.deepEqual(r.perProject, { warden: { dirty: 0, unpushed: 0, behind: 1, atRisk: 0, stashed: 0, stalled: 0, agents: [ag('a1', false, 0, 9)] } });
  assert.equal('tinker' in r.perProject, false);
});

console.log('\nat-risk axis (WARDEN-635): ⚑N folds detached HEAD / no-upstream / mid-merge into one fleet chip');
test('a detached-only agent now surfaces (atRisk:1) where it was previously dropped — the key behavioral change', () => {
  // Before WARDEN-635 the skip-clean guard dropped a detached agent with a clean
  // tree entirely (it was neither dirty nor unpushed nor behind — ahead/behind are
  // null on detached). Now it must appear so the chip can show ⚑N · detached HEAD.
  const r = sum([agent('a1', 'warden')], { a1: status(true, 0, 0, { detached: true, branch: 'HEAD' }) });
  assert.deepEqual(r.perProject, { warden: { dirty: 0, unpushed: 0, behind: 0, atRisk: 1, stashed: 0, stalled: 0, agents: [ag('a1', false, 0, 0, true, 'detached')] } });
  assert.deepEqual(r.total, { dirty: 0, unpushed: 0, behind: 0, atRisk: 1, stashed: 0, stalled: 0, agents: [ag('a1', false, 0, 0, true, 'detached')] });
});

test('detached:true wins over a mid-merge op (a detached HEAD surfaces via the detached reason, not op)', () => {
  // server.js gates inProgress.operation on `branch` (null for detached), but the
  // fleet discriminator must classify a detached agent as 'detached' regardless —
  // folded into one axis either way. detached === true ⇒ 'detached', first branch.
  const r = sum([agent('a1', 'warden')], { a1: status(true, 0, 0, { detached: true, branch: 'HEAD', inProgress: { operation: 'rebase' } }) });
  assert.deepEqual(r.perProject.warden.agents, [ag('a1', false, 0, 0, true, 'detached')]);
});

test('a no-upstream agent (named branch, upstream:null) surfaces with reason "noUpstream"', () => {
  // A branch never `push -u`'d: local-only, unbacked work — ahead/behind are null
  // (no @{u}), so this is invisible to the ±N/↑N/↓N chips without the 4th axis.
  const r = sum([agent('a1', 'warden')], { a1: status(true, 0, 0, { branch: 'feature/x', upstream: null }) });
  assert.deepEqual(r.perProject, { warden: { dirty: 0, unpushed: 0, behind: 0, atRisk: 1, stashed: 0, stalled: 0, agents: [ag('a1', false, 0, 0, true, 'noUpstream')] } });
});

test('a tracking branch (upstream set) is NOT at-risk — the noUpstream gate', () => {
  // Two dirty named branches: identical except upstream. With an upstream the work
  // is backed up remotely ⇒ not at-risk; without it the work is local-only ⇒ at-risk.
  // Both are made dirty so each surfaces (otherwise a clean tracking agent is skipped
  // by the guard) — isolating upstream as the SOLE at-risk discriminator here.
  const r = sum([agent('a1', 'warden'), agent('a2', 'warden')], {
    a1: status(false, 0, 0, { branch: 'feature/x', upstream: 'origin/feature/x' }), // tracking → dirty, not at-risk
    a2: status(false, 0, 0, { branch: 'feature/y', upstream: null }),               // no upstream → dirty, at-risk
  });
  assert.deepEqual(r.perProject, { warden: { dirty: 2, unpushed: 0, behind: 0, atRisk: 1, stashed: 0, stalled: 0, agents: [ag('a1', true, 0, 0, false, null), ag('a2', true, 0, 0, true, 'noUpstream')] } });
  assert.equal(r.total.atRisk, 1);
});

test('branch:null + upstream:null is NOT noUpstream (the !!branch gate disambiguates non-git/unborn)', () => {
  // Without the branch gate, upstream:null alone would be ambiguous across detached
  // / no-upstream / non-git-unborn. A null branch means there is no branch at all
  // (unborn HEAD / non-git), so it must NOT read as a no-upstream RISK. Surfaced via
  // a dirty tree so the agent isn't skipped — isolating the discriminator.
  const r = sum([agent('a1', 'warden')], { a1: status(false, 0, 0, { branch: null, upstream: null }) });
  assert.deepEqual(r.perProject, { warden: { dirty: 1, unpushed: 0, behind: 0, atRisk: 0, stashed: 0, stalled: 0, agents: [ag('a1', true, 0, 0, false, null)] } });
});

test('branch:"HEAD" literal is NOT noUpstream (detached owns it; a literal HEAD is not a named branch)', () => {
  // The per-row discriminator excludes branch === 'HEAD' from noUpstream (a detached
  // HEAD has no @{u} by definition). A non-detached agent reporting branch:'HEAD'
  // without detached:true must not misread as noUpstream — and not as detached either.
  const r = sum([agent('a1', 'warden')], { a1: status(false, 0, 0, { branch: 'HEAD', upstream: null }) });
  assert.deepEqual(r.perProject.warden.agents, [ag('a1', true, 0, 0, false, null)]);
});

test('a mid-merge agent surfaces with reason "op"; operation:null does not', () => {
  // inProgress.operation truthy ⇒ mid merge/rebase/cherry-pick/revert/bisect. A
  // tracking branch (upstream set) so the ONLY at-risk signal is the in-progress op.
  const r = sum([agent('a1', 'warden')], { a1: status(true, 0, 0, { branch: 'main', upstream: 'origin/main', inProgress: { operation: 'merge' } }) });
  assert.deepEqual(r.perProject, { warden: { dirty: 0, unpushed: 0, behind: 0, atRisk: 1, stashed: 0, stalled: 0, agents: [ag('a1', false, 0, 0, true, 'op')] } });
  // operation:null (or absent) ⇒ the op is over / unknown ⇒ not at-risk (clean → skipped).
  const r2 = sum([agent('a2', 'warden')], { a2: status(true, 0, 0, { branch: 'main', upstream: 'origin/main', inProgress: { operation: null } }) });
  assert.deepEqual(r2.perProject, {});
});

test('an agent both dirty AND at-risk appears ONCE with both signals (single-entry contract)', () => {
  // dirty tree + detached: one entry, dirty + at-risk, counted in each. Never two
  // entries — the ±N list and the ⚑N list filter this SAME entry.
  const r = sum([agent('a1', 'warden')], { a1: status(false, 0, 0, { detached: true, branch: 'HEAD' }) });
  assert.equal(r.perProject.warden.agents.length, 1);
  assert.deepEqual(r.perProject.warden.agents, [ag('a1', true, 0, 0, true, 'detached')]);
  assert.equal(r.perProject.warden.dirty, 1);
  assert.equal(r.perProject.warden.atRisk, 1);
});

test('the atRisk filter matches ⚑N (the popover contract), mirroring ±N / ↑N / ↓N', () => {
  // The ⚑N chip popover lists agents.filter(a => a.atRisk); that filtered length
  // must equal the chip's atRisk count field — exact parity with the other axes.
  const chats = [agent('a1', 'warden'), agent('a2', 'warden'), agent('a3', 'warden'), agent('a4', 'warden')];
  const gitStatus = {
    a1: status(true, 0, 0, { detached: true, branch: 'HEAD' }),                          // at-risk (detached)
    a2: status(true, 0, 0, { branch: 'feature', upstream: null }),                        // at-risk (noUpstream)
    a3: status(true, 0, 0, { branch: 'main', upstream: 'origin/main', inProgress: { operation: 'rebase' } }), // at-risk (op)
    a4: status(true, 0, 0, { branch: 'main', upstream: 'origin/main' }),                  // tracking, clean → not at-risk, skipped
  };
  const r = sum(chats, gitStatus);
  const agents = r.perProject.warden.agents;
  assert.deepEqual(agents.filter((a) => a.atRisk), [
    ag('a1', false, 0, 0, true, 'detached'),
    ag('a2', false, 0, 0, true, 'noUpstream'),
    ag('a3', false, 0, 0, true, 'op'),
  ]);
  assert.equal(r.perProject.warden.atRisk, agents.filter((a) => a.atRisk).length);
  assert.equal(r.perProject.warden.atRisk, 3);
});

test('an at-risk-only project gets a sparse-map entry (clean tree, no dirty/unpushed/behind)', () => {
  // The sparse "needs attention" map now keys on at-risk too: a project whose only
  // active agent is at-risk (clean tree, pushed-upstream-aside) must NOT be dropped —
  // the exact mirror of the WARDEN-297 behind-only sparse-entry change.
  const r = sum([agent('a1', 'warden'), agent('b1', 'tinker')], {
    a1: status(true, 0, 0, { detached: true, branch: 'HEAD' }), // at-risk only
    b1: status(true, 0, 0, { branch: 'main', upstream: 'origin/main' }), // clean → tinker absent
  });
  assert.deepEqual(r.perProject, { warden: { dirty: 0, unpushed: 0, behind: 0, atRisk: 1, stashed: 0, stalled: 0, agents: [ag('a1', false, 0, 0, true, 'detached')] } });
  assert.equal('tinker' in r.perProject, false);
});

test('at-risk totals accumulate per project and across projects independently', () => {
  const chats = [agent('a1', 'warden'), agent('a2', 'warden'), agent('b1', 'tinker')];
  const gitStatus = {
    a1: status(true, 0, 0, { detached: true, branch: 'HEAD' }),             // warden at-risk (detached)
    a2: status(true, 0, 0, { branch: 'feat', upstream: null }),             // warden at-risk (noUpstream)
    b1: status(true, 0, 0, { branch: 'main', upstream: 'origin/main', inProgress: { operation: 'cherry-pick' } }), // tinker at-risk (op)
  };
  const r = sum(chats, gitStatus);
  assert.equal(r.perProject.warden.atRisk, 2);
  assert.equal(r.perProject.tinker.atRisk, 1);
  assert.equal(r.total.atRisk, 3);
});

console.log('\nstashed axis (WARDEN-667): 🗄N surfaces parked `git stash` WIP — the lone current-state git signal with no fleet chip');
test('a stash-only agent now surfaces (stashed:1, clean tree) — the key behavioral change', () => {
  // Before WARDEN-667 the skip-clean guard dropped a stash-only agent entirely (a
  // clean, pushed, up-to-date, routine-state tree with parked WIP was neither dirty
  // nor unpushed nor behind nor at-risk). Now it must appear so the chip can show
  // 🗄N — the canonical `git stash` case the other four axes are all blind to.
  const r = sum([agent('a1', 'warden')], { a1: status(true, 0, 0, { stashCount: 2 }) });
  assert.deepEqual(r.perProject, { warden: { dirty: 0, unpushed: 0, behind: 0, atRisk: 0, stashed: 1, stalled: 0, agents: [ag('a1', false, 0, 0, false, null, true, 2)] } });
  assert.deepEqual(r.total, { dirty: 0, unpushed: 0, behind: 0, atRisk: 0, stashed: 1, stalled: 0, agents: [ag('a1', false, 0, 0, false, null, true, 2)] });
});

test('stashCount:null is not stashed (only a number > 0 is) — a detached / non-git agent stays quiet', () => {
  // Mirrors ahead:null ⇒ not unpushed and behind:null ⇒ not behind. stashCount is
  // null when there is no branch / non-git (server.js gates it on `branch`), so the
  // agent must NOT surface as stashed. Made dirty so the agent isn't skipped —
  // isolating stashCount as the SOLE discriminator (it must read stashed:0).
  const r = sum([agent('a1', 'warden')], { a1: status(false, 0, 0, { stashCount: null }) });
  assert.deepEqual(r.perProject, { warden: { dirty: 1, unpushed: 0, behind: 0, atRisk: 0, stashed: 0, stalled: 0, agents: [ag('a1', true, 0, 0, false, null, false)] } });
});

test('stashCount:0 is not stashed', () => {
  const r = sum([agent('a1', 'warden')], { a1: status(false, 0, 0, { stashCount: 0 }) });
  assert.equal(r.perProject.warden.stashed, 0);
});

test('an omitted stashCount is not stashed (absent ⇒ unknown ⇒ 0, never noise)', () => {
  const r = sum([agent('a1', 'warden')], { a1: status(false, 0, 0) });
  assert.equal(r.perProject.warden.stashed, 0);
});

test('an agent both dirty AND stashed appears ONCE with both signals (single-entry contract)', () => {
  // dirty tree + parked WIP: one entry, dirty + stashed, counted in each. Never two
  // entries — the ±N list and the 🗄N list filter this SAME entry.
  const r = sum([agent('a1', 'warden')], { a1: status(false, 0, 0, { stashCount: 3 }) });
  assert.equal(r.perProject.warden.agents.length, 1);
  assert.deepEqual(r.perProject.warden.agents, [ag('a1', true, 0, 0, false, null, true, 3)]);
  assert.equal(r.perProject.warden.dirty, 1);
  assert.equal(r.perProject.warden.stashed, 1);
});

test('the stashed filter matches 🗄N (the popover contract), mirroring ±N / ↑N / ↓N / ⚑N', () => {
  // The 🗄N chip popover lists agents.filter(a => a.stashed); that filtered length
  // must equal the chip's stashed count field — exact parity with the other axes.
  const chats = [agent('a1', 'warden'), agent('a2', 'warden'), agent('a3', 'warden')];
  const gitStatus = {
    a1: status(true, 0, 0, { stashCount: 2 }), // stashed only (clean tree)
    a2: status(false, 0, 0, { stashCount: 1 }), // dirty + stashed
    a3: status(false, 0, 0),                    // dirty only (not stashed)
  };
  const r = sum(chats, gitStatus);
  const agents = r.perProject.warden.agents;
  // Iteration order is preserved: a1 (stashed only) then a2 (dirty + stashed); a3
  // is not stashed so it is filtered out.
  assert.deepEqual(agents.filter((a) => a.stashed), [ag('a1', false, 0, 0, false, null, true, 2), ag('a2', true, 0, 0, false, null, true, 1)]);
  assert.equal(r.perProject.warden.stashed, agents.filter((a) => a.stashed).length);
});

test('a stashed-only project gets a sparse-map entry (clean tree, no dirty/unpushed/behind/at-risk)', () => {
  // The sparse "needs attention" map now keys on stashed too: a project whose only
  // active agent is stashed (clean tree, parked WIP) must NOT be dropped — the exact
  // mirror of the WARDEN-297 behind-only and WARDEN-635 at-risk-only sparse-entry
  // changes.
  const r = sum([agent('a1', 'warden'), agent('b1', 'tinker')], {
    a1: status(true, 0, 0, { stashCount: 1 }), // stashed only
    b1: status(true, 0, 0),                    // clean → tinker absent
  });
  assert.deepEqual(r.perProject, { warden: { dirty: 0, unpushed: 0, behind: 0, atRisk: 0, stashed: 1, stalled: 0, agents: [ag('a1', false, 0, 0, false, null, true, 1)] } });
  assert.equal('tinker' in r.perProject, false);
});

test('stashed totals accumulate per project and across projects independently', () => {
  const chats = [agent('a1', 'warden'), agent('a2', 'warden'), agent('b1', 'tinker')];
  const gitStatus = {
    a1: status(true, 0, 0, { stashCount: 2 }), // warden stashed
    a2: status(true, 0, 0, { stashCount: 1 }), // warden stashed
    b1: status(true, 0, 0, { stashCount: 4 }), // tinker stashed
  };
  const r = sum(chats, gitStatus);
  assert.equal(r.perProject.warden.stashed, 2);
  assert.equal(r.perProject.tinker.stashed, 1);
  assert.equal(r.total.stashed, 3);
});

console.log('\nheadAgeMs axis (WARDEN-669): headDate-derived age reaches ProjectGitAgent for the unpushed popover');
test('a valid ISO headDate derives a finite headAgeMs ≈ Date.now() - epoch, on perProject AND total agents', () => {
  // headDate already ships on /api/git-status; this asserts the summarizer now CARRIES
  // it through (previously dropped) as a derived AGE on ProjectGitAgent. The age is
  // dynamic (Date.now()-based), so assert it is a finite number bounded by the test's
  // own before/after Date.now() — NOT a hand-shaped constant. This fails if headAgeMs
  // were the raw EPOCH (off by ~1.7e12), null (guard wrong), or negative.
  const headDate = '2024-01-01T00:00:00+00:00';
  const epoch = Date.parse(headDate);
  const before = Date.now();
  const r = sum([agent('a1', 'warden')], { a1: status(true, 3, 0, { headDate }) });
  const after = Date.now();
  const perProjectAge = r.perProject.warden.agents[0].headAgeMs;
  const totalAge = r.total.agents[0].headAgeMs;
  assert.equal(typeof perProjectAge, 'number');
  assert.equal(typeof totalAge, 'number');
  assert.ok(Number.isFinite(perProjectAge) && perProjectAge > 0, 'perProject headAgeMs is finite + positive');
  assert.ok(Number.isFinite(totalAge) && totalAge > 0, 'total headAgeMs is finite + positive');
  // The summarizer's internal Date.now() landed in [before, after], so the age is
  // bounded by those (±1000ms slack for jitter). Catches an epoch-vs-age bug.
  assert.ok(perProjectAge >= before - epoch - 1000 && perProjectAge <= after - epoch + 1000, 'perProject headAgeMs ≈ Date.now() - Date.parse(headDate)');
  assert.equal(perProjectAge, totalAge, 'the SAME agent entry is shared by perProject and total (not rederived)');
});

test('a missing headDate derives headAgeMs:null (a not-yet-fetched / non-git cwd adds no age)', () => {
  // No headDate field at all — the pre-WARDEN-669 shape every existing fixture uses.
  // headAgeMs must be null so the popover renders no age label and sorts the row last.
  const r = sum([agent('a1', 'warden')], { a1: status(true, 3) });
  assert.equal(r.perProject.warden.agents[0].headAgeMs, null);
  assert.equal(r.total.agents[0].headAgeMs, null);
});

test('headDate:null derives headAgeMs:null (explicit null, e.g. a detached-with-no-commits cwd)', () => {
  const r = sum([agent('a1', 'warden')], { a1: status(true, 3, 0, { headDate: null }) });
  assert.equal(r.perProject.warden.agents[0].headAgeMs, null);
});

test('an INVALID headDate derives headAgeMs:null (Date.parse → NaN is guarded, never an age)', () => {
  // A malformed string must not leak NaN through as a "finite" age — the
  // Number.isFinite guard mirrors the per-row GitBranchBadge headFresh derivation.
  const r = sum([agent('a1', 'warden')], { a1: status(true, 3, 0, { headDate: 'not-a-date' }) });
  assert.equal(r.perProject.warden.agents[0].headAgeMs, null);
});

test('an EMPTY-string headDate derives headAgeMs:null (the empty-string guard, not just falsy)', () => {
  // An empty string is falsy AND Date.parse('') is NaN; the implementation guards on
  // BOTH (a truthy string check + Number.isFinite). Asserted separately so a future
  // refactor that drops the truthy-string short-circuit (relying only on isFinite)
  // still passes, but documents the empty-string contract explicitly.
  const r = sum([agent('a1', 'warden')], { a1: status(true, 3, 0, { headDate: '' }) });
  assert.equal(r.perProject.warden.agents[0].headAgeMs, null);
});

test('headAgeMs carries through key || id resolution (the agent entry is keyed correctly)', () => {
  // The age is derived from gitStatus[key], not gitStatus[id] — mirrors every other
  // field's key||id resolution. A headDate under the bare id must be IGNORED.
  const chats = [agent('raw-id', 'warden', 'warden-worker')];
  const r = sum(chats, {
    'raw-id': status(true, 3, 0, { headDate: '2024-01-01T00:00:00+00:00' }), // wrong key → ignored
    'warden-worker': status(true, 3),                                         // no headDate → null age
  });
  assert.equal(r.perProject.warden.agents[0].key, 'warden-worker');
  assert.equal(r.perProject.warden.agents[0].headAgeMs, null);
});

console.log('\nsortByHeadAgeDesc (WARDEN-669): oldest-HEAD-first for the unpushed popover, null-age last + stable');
test('largest headAgeMs first (oldest WIP on top); null-age rows last', () => {
  // 3-agent fixture spanning oldest → newest → null: the popover surfaces the
  // longest-sitting WIP first, and a no-commits/non-git agent (null age) sinks to
  // the bottom — the exact rank the ticket specifies.
  const agents = [
    ag('newest', true, 1, 0, false, null, false, 0, 1_000),         // 1s old
    ag('oldest', true, 1, 0, false, null, false, 0, 10_000_000),    // ~115d old
    ag('nullAge', true, 1, 0, false, null, false, 0, null),          // no age
  ];
  assert.deepEqual(sortByHeadAgeDesc(agents).map((a) => a.key), ['oldest', 'newest', 'nullAge']);
});

test('stability: equal ages preserve input order; multiple nulls preserve input order among themselves', () => {
  // Array.prototype.sort is stable on Node ≥12 / V8; this asserts the helper relies
  // on that (no comparator tiebreak that would scramble equal/null rows). Two equal
  // ages (a,b) keep order; two nulls (c,d) keep order; the non-null pair precedes
  // the null pair.
  const tied = [
    ag('a', true, 1, 0, false, null, false, 0, 5000),
    ag('b', true, 1, 0, false, null, false, 0, 5000),
    ag('c', true, 1, 0, false, null, false, 0, null),
    ag('d', true, 1, 0, false, null, false, 0, null),
  ];
  assert.deepEqual(sortByHeadAgeDesc(tied).map((x) => x.key), ['a', 'b', 'c', 'd']);
});

test('all-null input is a stable no-op order (no age → all tied at null)', () => {
  assert.deepEqual(sortByHeadAgeDesc([ag('x', true, 1), ag('y', true, 1)]).map((a) => a.key), ['x', 'y']);
});

test('sortByHeadAgeDesc returns a NEW array and does NOT mutate its input', () => {
  // Load-bearing: the summarizer's `agents` array is shared by the dirty/behind/atRisk
  // popovers in chats-iteration order. If the helper mutated its input in place, the
  // unpushed sort would scramble the other three popovers' determinism. The helper
  // MUST copy ([...agents].sort) so the shared array is untouched.
  const original = [ag('a', true, 1, 0, false, null, false, 0, 1), ag('b', true, 1, 0, false, null, false, 0, 100)];
  const inputOrder = original.map((a) => a.key);
  const sorted = sortByHeadAgeDesc(original);
  assert.notEqual(sorted, original, 'returns a new array, not the same reference');
  assert.deepEqual(original.map((a) => a.key), inputOrder, 'input array is unchanged (not mutated)');
  assert.deepEqual(sorted.map((a) => a.key), ['b', 'a'], 'the new array IS sorted (oldest first)');
});

console.log('\nsummarizer agents STILL in chats iteration order (WARDEN-669 guard: the sort lives in the helper, NOT the summarizer)');
test('summarizeProjectGitState does NOT reorder agents by headAge — chats order is preserved across perProject and total', () => {
  // Guard against an accidental reorder inside the summarizer: its `agents` array
  // MUST stay in chats iteration order (the deterministic-order invariant asserted
  // throughout this suite and shared by the dirty/behind/atRisk popovers). The
  // headDates here would sort a2 (oldest) first if the summarizer reordered — assert
  // they DON'T (chats order a1, a2, a3 stands), so the per-kind sort stays isolated
  // in sortByHeadAgeDesc (applied only to the unpushed popover at render time).
  const chats = [agent('a1', 'warden'), agent('a2', 'warden'), agent('a3', 'warden')];
  const gitStatus = {
    a1: status(true, 1, 0, { headDate: '2024-03-01T00:00:00+00:00' }), // middle age
    a2: status(true, 1, 0, { headDate: '2020-01-01T00:00:00+00:00' }), // OLDEST — would sort first if reordered
    a3: status(true, 1, 0, { headDate: '2026-01-01T00:00:00+00:00' }), // newest
  };
  const r = sum(chats, gitStatus);
  assert.deepEqual(r.total.agents.map((a) => a.key), ['a1', 'a2', 'a3'], 'total.agents in chats order, NOT headAge order');
  assert.deepEqual(r.perProject.warden.agents.map((a) => a.key), ['a1', 'a2', 'a3'], 'perProject agents in chats order too');
  // Sanity: the ages ARE derived (so a reorder would have had data to act on) — a2 oldest.
  const ages = r.total.agents.reduce((m, a) => ({ ...m, [a.key]: a.headAgeMs }), {});
  assert.ok(ages.a2 > ages.a1 && ages.a1 > ages.a3, 'a2 is the oldest, a3 the newest — yet chats order is preserved');
});

test('the unpushed-popover slice, when sorted by the helper, DOES go oldest-first (the render-time contract)', () => {
  // End-to-end: the summarizer keeps chats order, then the RENDER layer sorts the
  // unpushed slice via the helper. This simulates that two-step pipeline and asserts
  // the popover a human sees is oldest-first — the whole point of WARDEN-669.
  const chats = [agent('a1', 'warden'), agent('a2', 'warden'), agent('a3', 'warden'), agent('a4', 'warden')];
  const gitStatus = {
    a1: status(true, 1, 0, { headDate: '2024-03-01T00:00:00+00:00' }), // middle age (unpushed)
    a2: status(true, 1, 0, { headDate: '2020-01-01T00:00:00+00:00' }), // OLDEST (unpushed)
    a3: status(false, 0, 0),                                           // dirty only — NOT in the unpushed slice
    a4: status(true, 1, 0, { headDate: '2026-01-01T00:00:00+00:00' }), // newest (unpushed)
  };
  const r = sum(chats, gitStatus);
  // Summarizer: chats order, all four agents (a3 is dirty so it appears).
  assert.deepEqual(r.total.agents.map((a) => a.key), ['a1', 'a2', 'a3', 'a4']);
  // Render: the unpushed popover filters ahead>0 (drops a3) then sorts oldest-first.
  const unpushed = r.total.agents.filter((a) => a.ahead > 0);
  assert.deepEqual(sortByHeadAgeDesc(unpushed).map((a) => a.key), ['a2', 'a1', 'a4']);
});

console.log('\nstalled axis (WARDEN-682): 💤N surfaces last-commit freshness — a clean/pushed/in-sync agent >7d old, the lone per-row signal with no fleet chip');
test('a stalled-only agent now surfaces (stalled:1, clean tree) — the key behavioral change', () => {
  // Before WARDEN-682 the skip-clean guard dropped a stalled-only agent entirely (a
  // clean, pushed, up-to-date, routine-state, stash-free tree whose last commit was
  // >7d old was neither dirty nor unpushed nor behind nor at-risk nor stashed). Now
  // it must appear so the chip can show 💤N — the exact mirror of WARDEN-667's
  // stash-only case, applied to the last per-row GitBranchBadge signal with no rollup.
  // sum(..., NOW) pins the staleness reference so headDate = NOW−9d ⇒ headAgeMs = 9d
  // deterministically (the reconciled headAgeMs field is an AGE, asserted as 9d).
  const stale9d = new Date(NOW - 9 * 86400_000).toISOString();
  const r = sum([agent('a1', 'warden')], { a1: status(true, 0, 0, { headDate: stale9d }) }, NOW);
  assert.deepEqual(r.perProject, { warden: { dirty: 0, unpushed: 0, behind: 0, atRisk: 0, stashed: 0, stalled: 1, agents: [ag('a1', false, 0, 0, false, null, false, 0, 9 * 86400_000, null, true)] } });
  assert.deepEqual(r.total, { dirty: 0, unpushed: 0, behind: 0, atRisk: 0, stashed: 0, stalled: 1, agents: [ag('a1', false, 0, 0, false, null, false, 0, 9 * 86400_000, null, true)] });
});

test('a fresh agent (headDate <7d) does NOT appear in stalled — and reads ZERO across every chip', () => {
  // The negative case: a 1d-old HEAD is fresh, so the agent is NOT stalled. Made
  // clean/pushed/in-sync/routine/stash-free so it has NO other axis — it must read
  // ZERO across every chip (absent from the sparse map entirely), proving the 7d
  // threshold gates membership rather than any-headDate-counting. Pinned to NOW so a
  // 1d-old HEAD reads headAgeMs = 1d (< 7d) regardless of wall-clock time.
  const fresh1d = new Date(NOW - 86400_000).toISOString();
  const r = sum([agent('a1', 'warden')], { a1: status(true, 0, 0, { headDate: fresh1d }) }, NOW);
  assert.deepEqual(r.perProject, {});
  assert.deepEqual(r.total, { dirty: 0, unpushed: 0, behind: 0, atRisk: 0, stashed: 0, stalled: 0, agents: [] });
});

test('headDate:null is not stalled (only a finite >7d date is) — a no-commit / non-git agent stays quiet', () => {
  // Mirrors ahead:null ⇒ not unpushed and stashCount:null ⇒ not stashed. headDate is
  // null when there is no commit / non-git (server.js gates it on `branch`), so the
  // agent must NOT surface as stalled. Made dirty so the agent isn't skipped —
  // isolating headDate as the SOLE discriminator (it must read stalled:0, headAgeMs:null).
  const r = sum([agent('a1', 'warden')], { a1: status(false, 0, 0, { headDate: null }) }, NOW);
  assert.deepEqual(r.perProject, { warden: { dirty: 1, unpushed: 0, behind: 0, atRisk: 0, stashed: 0, stalled: 0, agents: [ag('a1', true, 0, 0, false, null, false, 0, null, null, false)] } });
});

test('an invalid headDate string is not stalled (Date.parse → null on the agent, never NaN)', () => {
  // A malformed headDate must not crash Date.parse nor leak NaN onto the agent.
  // Normalized to headAgeMs:null ⇒ not stalled (the ticket's "null when missing/
  // invalid" contract). Made dirty to surface the agent and isolate the discriminator.
  const r = sum([agent('a1', 'warden')], { a1: status(false, 0, 0, { headDate: 'not-a-date' }) }, NOW);
  assert.deepEqual(r.perProject.warden.agents, [ag('a1', true, 0, 0, false, null, false, 0, null, null, false)]);
  assert.equal(r.perProject.warden.stalled, 0);
});

test('an agent both dirty AND stalled appears ONCE with both signals (single-entry contract)', () => {
  // dirty tree + stale HEAD: one entry, dirty + stalled, counted in each. Never two
  // entries — the ±N list and the 💤N list filter this SAME entry.
  const stale9d = new Date(NOW - 9 * 86400_000).toISOString();
  const r = sum([agent('a1', 'warden')], { a1: status(false, 0, 0, { headDate: stale9d }) }, NOW);
  assert.equal(r.perProject.warden.agents.length, 1);
  assert.deepEqual(r.perProject.warden.agents, [ag('a1', true, 0, 0, false, null, false, 0, 9 * 86400_000, null, true)]);
  assert.equal(r.perProject.warden.dirty, 1);
  assert.equal(r.perProject.warden.stalled, 1);
});

test('the stalled filter matches 💤N (the popover contract), mirroring ±N / ↑N / ↓N / ⚑N / 🗄N', () => {
  // The 💤N chip popover lists agents.filter(a => a.stalled); that filtered length
  // must equal the chip's stalled count field — exact parity with the other axes.
  const stale9d = new Date(NOW - 9 * 86400_000).toISOString();
  const chats = [agent('a1', 'warden'), agent('a2', 'warden'), agent('a3', 'warden')];
  const gitStatus = {
    a1: status(true, 0, 0, { headDate: stale9d }),  // stalled only (clean tree)
    a2: status(false, 0, 0, { headDate: stale9d }), // dirty + stalled
    a3: status(false, 0, 0),                        // dirty only (no headDate → not stalled)
  };
  const r = sum(chats, gitStatus, NOW);
  const agents = r.perProject.warden.agents;
  // Iteration order is preserved: a1 (stalled only) then a2 (dirty + stalled); a3
  // has no headDate so it is not stalled and is filtered out.
  assert.deepEqual(agents.filter((a) => a.stalled), [ag('a1', false, 0, 0, false, null, false, 0, 9 * 86400_000, null, true), ag('a2', true, 0, 0, false, null, false, 0, 9 * 86400_000, null, true)]);
  assert.equal(r.perProject.warden.stalled, agents.filter((a) => a.stalled).length);
});

test('a stalled-only project gets a sparse-map entry (clean tree, no dirty/unpushed/behind/at-risk/stashed)', () => {
  // The sparse "needs attention" map now keys on stalled too: a project whose only
  // active agent is stalled (clean tree, HEAD >7d old) must NOT be dropped — the
  // exact mirror of the WARDEN-297 behind-only, WARDEN-635 at-risk-only, and
  // WARDEN-667 stashed-only sparse-entry changes.
  const stale9d = new Date(NOW - 9 * 86400_000).toISOString();
  const r = sum([agent('a1', 'warden'), agent('b1', 'tinker')], {
    a1: status(true, 0, 0, { headDate: stale9d }), // stalled only
    b1: status(true, 0, 0),                        // clean → tinker absent
  }, NOW);
  assert.deepEqual(r.perProject, { warden: { dirty: 0, unpushed: 0, behind: 0, atRisk: 0, stashed: 0, stalled: 1, agents: [ag('a1', false, 0, 0, false, null, false, 0, 9 * 86400_000, null, true)] } });
  assert.equal('tinker' in r.perProject, false);
});

test('stalled totals accumulate per project and across projects independently', () => {
  const stale9d = new Date(NOW - 9 * 86400_000).toISOString();
  const chats = [agent('a1', 'warden'), agent('a2', 'warden'), agent('b1', 'tinker')];
  const gitStatus = {
    a1: status(true, 0, 0, { headDate: stale9d }), // warden stalled
    a2: status(true, 0, 0, { headDate: stale9d }), // warden stalled
    b1: status(true, 0, 0, { headDate: stale9d }), // tinker stalled
  };
  const r = sum(chats, gitStatus, NOW);
  assert.equal(r.perProject.warden.stalled, 2);
  assert.equal(r.perProject.tinker.stalled, 1);
  assert.equal(r.total.stalled, 3);
});

test('the stalled-popover slice, when sorted by the helper, DOES go oldest-first (the render-time contract)', () => {
  // End-to-end: the summarizer keeps chats order, then the RENDER layer sorts the
  // stalled slice via the helper (GitStateBadge's `sort: sortByHeadAgeDesc`,
  // WARDEN-710). This simulates that two-step pipeline and asserts the popover a human
  // sees is oldest-HEAD-first — the whole point of WARDEN-710: a 30-day-stalled agent
  // surfaces ABOVE one 8 days stale, so rotting/abandoned work is triaged first (chats
  // iteration order alone would bury the 30d repo under the 8d one, defeating the chip).
  // NOW-pinned so the >7d-stalled membership AND the age rank are both deterministic.
  const chats = [agent('a1', 'warden'), agent('a2', 'warden'), agent('a3', 'warden'), agent('a4', 'warden')];
  const gitStatus = {
    a1: status(true, 0, 0, { headDate: new Date(NOW - 9 * 86400_000).toISOString() }),  // 9d — stalled (middle)
    a2: status(true, 0, 0, { headDate: new Date(NOW - 30 * 86400_000).toISOString() }), // 30d — stalled (OLDEST)
    a3: status(false, 0, 0),                                                            // dirty only — NOT stalled
    a4: status(true, 0, 0, { headDate: new Date(NOW - 8 * 86400_000).toISOString() }),  // 8d — stalled (newest stalled)
  };
  const r = sum(chats, gitStatus, NOW);
  // Summarizer: chats order, all four agents (a3 is dirty so it appears).
  assert.deepEqual(r.total.agents.map((a) => a.key), ['a1', 'a2', 'a3', 'a4']);
  // Render: the stalled popover filters a.stalled (drops a3) then sorts oldest-first.
  const stalled = r.total.agents.filter((a) => a.stalled);
  assert.deepEqual(sortByHeadAgeDesc(stalled).map((a) => a.key), ['a2', 'a1', 'a4']);
});

console.log('\ndirty magnitude (WARDEN-670): the ±N popover carries each dirty agent\'s +N −M');
test('a dirty agent carries diffstat from status.diffstat onto ProjectGitAgent', () => {
  const r = sum([agent('a1', 'warden')], { a1: status(false, 0, 0, { diffstat: { files: 3, insertions: 10, deletions: 2 } }) });
  assert.deepEqual(r.perProject, { warden: { dirty: 1, unpushed: 0, behind: 0, atRisk: 0, stashed: 0, stalled: 0, agents: [ag('a1', true, 0, 0, false, null, false, 0, null, { files: 3, insertions: 10, deletions: 2 })] } });
});

test('a dirty agent whose status carries no diffstat gets diffstat: null (quiet — no false magnitude)', () => {
  // Mirrors a pre-670 status map (no diffstat field) or an all-untracked agent the
  // server hadn't magnitude-tagged: absent → null on the agent, so DiffStatChip's
  // guard renders nothing (no misleading +0−0). The magnitude is carried as null,
  // never invented from the file count.
  const r = sum([agent('a1', 'warden')], { a1: status(false, 0) });
  assert.deepEqual(r.perProject.warden.agents, [ag('a1', true, 0)]); // ag() default → diffstat: null
  assert.equal(r.perProject.warden.agents[0].diffstat, null);
});

test('an all-untracked dirty agent (diffstat +0−0) carries the +0−0 object verbatim — the field is honest, the chip stays quiet', () => {
  // The server serves { files, insertions: 0, deletions: 0 } for an all-untracked WIP
  // (shortstat counts tracked edits only). The summarizer carries it as-is; DiffStatChip's
  // own +0−0 guard then renders nothing. Asserting the object (not null) proves the field
  // is the server's value, not a guess.
  const r = sum([agent('a1', 'warden')], { a1: status(false, 0, 0, { diffstat: { files: 2, insertions: 0, deletions: 0 } }) });
  assert.deepEqual(r.perProject.warden.agents, [ag('a1', true, 0, 0, false, null, false, 0, null, { files: 2, insertions: 0, deletions: 0 })]);
});

test('a non-dirty agent (at-risk only) also carries diffstat: null — the field rides on every ProjectGitAgent', () => {
  // The shape contract: EVERY agent carries diffstat (the deep-equality invariant this
  // suite asserts), not just dirty ones — so the React layer can read a.diffstat on any
  // popover row without a present check changing per axis.
  const r = sum([agent('a1', 'warden')], { a1: status(true, 0, 0, { detached: true, branch: 'HEAD' }) });
  assert.deepEqual(r.perProject.warden.agents, [ag('a1', false, 0, 0, true, 'detached')]); // diffstat: null default
  assert.equal(r.perProject.warden.agents[0].diffstat, null);
});

console.log('\ndirty popover sort (WARDEN-670): render-time heaviest-first, scoped to the dirty kind');
test('summarizeProjectGitState does NOT reorder by magnitude — chats order is preserved (sort is render-time only)', () => {
  // The load-bearing invariant: summarizeProjectGitState emits agents in chats order so
  // its deep-equality holds AND the unpushed/behind/atRisk popovers stay deterministic.
  // The heaviest-first sort is a per-kind RENDER-TIME concern (GIT_STATE_KIND.dirty.sort
  // in GitStateBadge), NEVER inside the summarizer. This case puts a light agent FIRST
  // in chats order and a heavy one second and asserts the summarizer leaves them there.
  const r = sum([agent('light', 'warden'), agent('heavy', 'warden')], {
    light: status(false, 0, 0, { diffstat: { files: 1, insertions: 1, deletions: 1 } }),    // mag 2
    heavy: status(false, 0, 0, { diffstat: { files: 1, insertions: 500, deletions: 500 } }), // mag 1000
  });
  assert.deepEqual(r.perProject.warden.agents.map((a) => a.key), ['light', 'heavy']); // chats order, NOT sorted
});

test('sortGitAgentsByMagnitudeDesc ranks largest +N −M WIP first', () => {
  const a = ag('a', true, 0, 0, false, null, false, 0, null, { files: 1, insertions: 10, deletions: 2 });    // mag 12
  const b = ag('b', true, 0, 0, false, null, false, 0, null, { files: 1, insertions: 847, deletions: 203 }); // mag 1050 (heaviest)
  const c = ag('c', true, 0, 0, false, null, false, 0, null, { files: 1, insertions: 5, deletions: 0 });     // mag 5
  assert.deepEqual(sortGitAgentsByMagnitudeDesc([a, b, c]).map((x) => x.key), ['b', 'a', 'c']);
});

test('magnitude-0 (all-untracked) and null-diffstat (detached) rows sort LAST, stably', () => {
  const heavy = ag('heavy', true, 0, 0, false, null, false, 0, null, { files: 1, insertions: 100, deletions: 0 }); // mag 100
  const zero = ag('zero', true, 0, 0, false, null, false, 0, null, { files: 2, insertions: 0, deletions: 0 });     // mag 0 (all-untracked)
  const nul = ag('nul', true, 0, 0, false, null, false, 0, null);                                            // null (detached)
  // 0 and null both have magnitude 0 → tie → preserve input order (zero before nul);
  // both land after every real WIP (heavy).
  assert.deepEqual(sortGitAgentsByMagnitudeDesc([zero, heavy, nul]).map((x) => x.key), ['heavy', 'zero', 'nul']);
});

test('equal-magnitude ties preserve input order (stable); the helper does NOT mutate its input', () => {
  const a = ag('a', true, 0, 0, false, null, false, 0, null, { files: 1, insertions: 5, deletions: 5 }); // mag 10
  const b = ag('b', true, 0, 0, false, null, false, 0, null, { files: 1, insertions: 8, deletions: 2 }); // mag 10 (tie)
  const input = [a, b];
  const out = sortGitAgentsByMagnitudeDesc(input);
  assert.deepEqual(out.map((x) => x.key), ['a', 'b']); // tie → input order preserved (stable)
  assert.deepEqual(input.map((x) => x.key), ['a', 'b']); // input NOT mutated
  assert.notEqual(out, input);                           // returns a NEW array
});

console.log('\nstashCount magnitude (WARDEN-689): the parked-WIP COUNT reaches ProjectGitAgent + the 🗄N popover ranks heaviest-parker-first');
test('stashCount is carried onto ProjectGitAgent.stashCount (the magnitude the popover renders · 🗄 N)', () => {
  // The summarizer already READ status.stashCount (the WARDEN-667 local) but previously
  // DISCARDED it to the `stashed` boolean. WARDEN-689 carries the magnitude through so
  // the 🗄N popover can render it per agent. A 12-stash agent must read distinctly from
  // a 1-stash one — the whole point of the slice.
  const r = sum([agent('a1', 'warden')], { a1: status(true, 0, 0, { stashCount: 12 }) });
  assert.equal(r.perProject.warden.agents[0].stashCount, 12);
  assert.equal(r.total.agents[0].stashCount, 12);
  const r2 = sum([agent('a2', 'warden')], { a2: status(true, 0, 0, { stashCount: 1 }) });
  assert.equal(r2.perProject.warden.agents[0].stashCount, 1);
});

test('a stash-only agent carries its EXACT stashCount via deep-equal (magnitude on the entry)', () => {
  const r = sum([agent('a1', 'warden')], { a1: status(true, 0, 0, { stashCount: 7 }) });
  assert.deepEqual(r.perProject.warden.agents, [ag('a1', false, 0, 0, false, null, true, 7)]);
  assert.deepEqual(r.total.agents, [ag('a1', false, 0, 0, false, null, true, 7)]);
});

test('stashCount carries through key || id resolution (the magnitude is read from gitStatus[key], not [id])', () => {
  // Mirrors every other field's key||id resolution: a stashCount under the bare id is
  // IGNORED, so the entry reads the key's count (2 here), NOT the id's (9) — a yatfa
  // agent is never misread from a stale id-keyed row.
  const chats = [agent('raw-id', 'warden', 'warden-worker')];
  const r = sum(chats, {
    'raw-id': status(true, 0, 0, { stashCount: 9 }),       // wrong key → ignored
    'warden-worker': status(true, 0, 0, { stashCount: 2 }), // correct key → 2
  });
  assert.equal(r.perProject.warden.agents[0].key, 'warden-worker');
  assert.equal(r.perProject.warden.agents[0].stashCount, 2);
});

test('an absent stashCount ⇒ stashCount:0 on the agent (null-safe, no crash) — renders no suffix', () => {
  // No stashCount field at all (the pre-WARDEN-211 shape, or a status that omits it):
  // the agent gains stashCount:0, so the popover suffix guard `a.stashCount > 0` is
  // false → no ` · 🗄 N` renders. Made dirty so the agent surfaces, proving the
  // 0-default rather than undefined/noise.
  const r = sum([agent('a1', 'warden')], { a1: status(false, 0, 0) });
  assert.equal(r.perProject.warden.agents[0].stashCount, 0);
});

test('stashCount:null ⇒ stashCount:0 (null ⇒ unknown ⇒ 0, never noise)', () => {
  const r = sum([agent('a1', 'warden')], { a1: status(false, 0, 0, { stashCount: null }) });
  assert.equal(r.perProject.warden.agents[0].stashCount, 0);
});

test('stashCount:0 ⇒ stashCount:0 and stashed:false (a zero count is not parked WIP)', () => {
  const r = sum([agent('a1', 'warden')], { a1: status(false, 0, 0, { stashCount: 0 }) });
  // dirty so the agent surfaces; its stashCount is 0 and stashed false.
  assert.equal(r.perProject.warden.agents[0].stashCount, 0);
  assert.equal(r.perProject.warden.agents[0].stashed, false);
});

console.log('\nsortByStashCountDesc (WARDEN-689): heaviest-parker-first for the stash popover, 0-count last + stable');
test('largest stashCount first (heaviest parker on top); smaller counts after', () => {
  // 3-agent fixture spanning heavy → light: the popover surfaces the biggest stash
  // first — the exact rank the ticket specifies (a 12-stash agent holds far more
  // parked, easily-forgotten work than a 1-stash one).
  const agents = [
    ag('light', false, 0, 0, false, null, true, 1),
    ag('heavy', false, 0, 0, false, null, true, 12),
    ag('mid', false, 0, 0, false, null, true, 3),
  ];
  assert.deepEqual(sortByStashCountDesc(agents).map((a) => a.key), ['heavy', 'mid', 'light']);
});

test('stability: equal stashCounts preserve input order (ties keep chats order)', () => {
  // Array.prototype.sort is stable on Node ≥12 / V8; this asserts the helper relies on
  // that (no comparator tiebreak that would scramble equal-count rows). Two equal
  // counts (a,b) keep their input order.
  const tied = [
    ag('a', false, 0, 0, false, null, true, 2),
    ag('b', false, 0, 0, false, null, true, 2),
  ];
  assert.deepEqual(sortByStashCountDesc(tied).map((x) => x.key), ['a', 'b']);
});

test('all-zero input is a stable no-op order (no stash → all tied at 0)', () => {
  assert.deepEqual(sortByStashCountDesc([ag('x', true, 1), ag('y', true, 1)]).map((a) => a.key), ['x', 'y']);
});

test('sortByStashCountDesc returns a NEW array and does NOT mutate its input', () => {
  // Load-bearing: the summarizer's `agents` array is shared by the dirty/behind/atRisk/
  // stalled popovers in chats-iteration order. If the helper mutated its input in place,
  // the stash sort would scramble the other popovers' determinism. The helper MUST copy
  // ([...agents].sort) so the shared array is untouched — mirroring sortByHeadAgeDesc.
  const original = [ag('a', false, 0, 0, false, null, true, 1), ag('b', false, 0, 0, false, null, true, 5)];
  const inputOrder = original.map((a) => a.key);
  const sorted = sortByStashCountDesc(original);
  assert.notEqual(sorted, original, 'returns a new array, not the same reference');
  assert.deepEqual(original.map((a) => a.key), inputOrder, 'input array is unchanged (not mutated)');
  assert.deepEqual(sorted.map((a) => a.key), ['b', 'a'], 'the new array IS sorted (heaviest first)');
});

test('summarizeProjectGitState does NOT reorder agents by stashCount — chats order is preserved', () => {
  // Guard against an accidental reorder inside the summarizer: its `agents` array MUST
  // stay in chats iteration order (the deterministic-order invariant shared by the
  // dirty/behind/atRisk/stalled popovers). The stashCounts here would sort a2 (heaviest)
  // first if the summarizer reordered — assert they DON'T (chats order a1, a2, a3
  // stands), so the per-kind sort stays isolated in sortByStashCountDesc (render-time
  // only).
  const chats = [agent('a1', 'warden'), agent('a2', 'warden'), agent('a3', 'warden')];
  const gitStatus = {
    a1: status(true, 0, 0, { stashCount: 1 }),
    a2: status(true, 0, 0, { stashCount: 12 }), // HEAVIEST — would sort first if reordered
    a3: status(true, 0, 0, { stashCount: 3 }),
  };
  const r = sum(chats, gitStatus);
  assert.deepEqual(r.total.agents.map((a) => a.key), ['a1', 'a2', 'a3'], 'total.agents in chats order, NOT stashCount order');
  assert.deepEqual(r.perProject.warden.agents.map((a) => a.key), ['a1', 'a2', 'a3'], 'perProject agents in chats order too');
  // Sanity: the counts ARE carried (so a reorder would have had data to act on) — a2 heaviest.
  const counts = r.total.agents.reduce((m, a) => ({ ...m, [a.key]: a.stashCount }), {});
  assert.ok(counts.a2 > counts.a3 && counts.a3 > counts.a1, 'a2 is heaviest, a3 mid, a1 light — yet chats order is preserved');
});

test('the stash-popover slice, when sorted by the helper, DOES go heaviest-first (the render-time contract)', () => {
  // End-to-end: the summarizer keeps chats order, then the RENDER layer sorts the stash
  // slice via the helper (GitStateBadge's `sort: sortByStashCountDesc`). This simulates
  // that two-step pipeline and asserts the popover a human sees is heaviest-parker-first
  // — the whole point of WARDEN-689.
  const chats = [agent('a1', 'warden'), agent('a2', 'warden'), agent('a3', 'warden'), agent('a4', 'warden')];
  const gitStatus = {
    a1: status(true, 0, 0, { stashCount: 1 }),
    a2: status(true, 0, 0, { stashCount: 12 }), // heaviest
    a3: status(false, 0, 0),                    // dirty only — NOT in the stash slice
    a4: status(true, 0, 0, { stashCount: 3 }),
  };
  const r = sum(chats, gitStatus);
  // Summarizer: chats order, all four agents (a3 is dirty so it appears).
  assert.deepEqual(r.total.agents.map((a) => a.key), ['a1', 'a2', 'a3', 'a4']);
  // Render: the stash popover filters stashed (drops a3) then sorts heaviest-first.
  const stashed = r.total.agents.filter((a) => a.stashed);
  assert.deepEqual(sortByStashCountDesc(stashed).map((a) => a.key), ['a2', 'a4', 'a1']);
});

console.log('\nconflict axis (WARDEN-701): ⚑ surfaces a merge-conflict-BLOCKED agent distinctly as a 4th atRiskReason');
test('a conflicted agent (unmerged paths) derives atRiskReason:"conflict", NOT "op", even with inProgress.operation set — precedence over op', () => {
  // A blocked merge ships BOTH inProgress.operation (the running merge) AND conflicted
  // porcelain paths (UU/AA/…). conflict ⟹ op, but a blocked merge cannot self-resolve,
  // so 'conflict' is the MORE specific/urgent reason and MUST win the precedence over
  // the generic 'op' — the whole point of WARDEN-701 (otherwise it reads identically to
  // a clean, auto-completing rebase under ⚑'s "operation in progress" label).
  const r = sum([agent('a1', 'warden')], { a1: status(false, 0, 0, {
    branch: 'feature', upstream: 'origin/feature',
    inProgress: { operation: 'merge' },
    files: [{ path: 'a.ts', conflict: true }, { path: 'b.ts', conflict: true }, { path: 'c.ts' }],
  }) });
  assert.deepEqual(r.perProject, { warden: { dirty: 1, unpushed: 0, behind: 0, atRisk: 1, stashed: 0, stalled: 0, agents: [ag('a1', true, 0, 0, true, 'conflict', false, 0, null, null, false, 2)] } });
});

test('conflictCount counts ONLY conflicted files (a single unmerged path → 1)', () => {
  // The count behind the ⚑ suffix "merge conflict · N unmerged" — only files carrying
  // the porcelain `conflict` flag count; ordinary staged/unstaged paths alongside do not.
  const r = sum([agent('a1', 'warden')], { a1: status(false, 0, 0, {
    branch: 'feature', upstream: 'origin/feature',
    inProgress: { operation: 'merge' },
    files: [{ path: 'only.ts', conflict: true }],
  }) });
  assert.equal(r.perProject.warden.agents[0].conflictCount, 1);
  assert.equal(r.perProject.warden.agents[0].atRiskReason, 'conflict');
});

test('a conflicted agent with NO inProgress.operation still derives "conflict" — conflicted paths are at-risk regardless', () => {
  // Defensive: porcelain conflict markers without a recorded inProgress.operation (an
  // unusual but possible state) must STILL surface as 'conflict', never fall through to
  // null — a conflicted tree needs a human regardless of whether the op is recorded.
  const r = sum([agent('a1', 'warden')], { a1: status(false, 0, 0, {
    branch: 'feature', upstream: 'origin/feature',
    files: [{ path: 'a.ts', conflict: true }],
  }) });
  assert.deepEqual(r.perProject.warden.agents, [ag('a1', true, 0, 0, true, 'conflict', false, 0, null, null, false, 1)]);
});

test('precedence chain: detached > noUpstream > conflict > op — a noUpstream agent WITH conflicted files reads "noUpstream"', () => {
  // Locks the full ternary order the ticket specifies. The conflict-vs-op precedence is
  // the primary fix; this asserts the rest of the chain so the ordering is explicit and
  // reviewed. A no-upstream branch mid a local merge with conflicts is an edge case, but
  // the noUpstream branch precedes the conflict branch, so it wins.
  const chats = [agent('det', 'warden'), agent('noUp', 'warden'), agent('conf', 'warden'), agent('opA', 'warden')];
  const gitStatus = {
    det: status(false, 0, 0, { detached: true, branch: 'HEAD', files: [{ path: 'd.ts', conflict: true }] }),           // detached wins over conflict
    noUp: status(false, 0, 0, { branch: 'feature', upstream: null, files: [{ path: 'n.ts', conflict: true }] }),         // noUpstream wins over conflict
    conf: status(false, 0, 0, { branch: 'feature', upstream: 'origin/feature', inProgress: { operation: 'merge' }, files: [{ path: 'c.ts', conflict: true }] }), // conflict (op present but conflict wins)
    opA: status(false, 0, 0, { branch: 'feature', upstream: 'origin/feature', inProgress: { operation: 'rebase' } }),   // op only
  };
  const r = sum(chats, gitStatus);
  const reasons = r.total.agents.reduce((m, a) => ({ ...m, [a.key]: a.atRiskReason }), {});
  assert.equal(reasons.det, 'detached');
  assert.equal(reasons.noUp, 'noUpstream');
  assert.equal(reasons.conf, 'conflict');
  assert.equal(reasons.opA, 'op');
});

test('a conflict-only agent is retained even when otherwise clean — the atRisk-only retain, mirrored for the 4th reason', () => {
  // Mirrors the at-risk-only retain (the detached case at the WARDEN-635 section): a
  // project whose only agent is at-risk MUST NOT be dropped from the sparse map. Here
  // the sole at-risk driver is the conflict; clean:true isolates atRisk as the ONLY
  // retain reason (in reality a conflicted tree is also dirty, but this asserts the
  // conflict-derived atRisk retains the agent independent of the dirty axis).
  const r = sum([agent('a1', 'warden'), agent('b1', 'tinker')], {
    a1: status(true, 0, 0, { branch: 'feature', upstream: 'origin/feature', files: [{ path: 'x.ts', conflict: true }] }), // conflict only (clean tree asserted)
    b1: status(true, 0, 0), // clean → tinker absent
  });
  assert.deepEqual(r.perProject, { warden: { dirty: 0, unpushed: 0, behind: 0, atRisk: 1, stashed: 0, stalled: 0, agents: [ag('a1', false, 0, 0, true, 'conflict', false, 0, null, null, false, 1)] } });
  assert.equal('tinker' in r.perProject, false);
});

test('every non-conflict agent carries conflictCount:0 (the field rides on every ProjectGitAgent, mirroring diffstat/stashCount)', () => {
  // The deep-equality shape contract: EVERY agent carries conflictCount, not just
  // conflict ones — so the React layer can read a.conflictCount on any atRisk row
  // without a present check. A detached agent (no conflicted files) reads conflictCount:0.
  const r = sum([agent('a1', 'warden')], { a1: status(true, 0, 0, { detached: true, branch: 'HEAD' }) });
  assert.deepEqual(r.perProject.warden.agents, [ag('a1', false, 0, 0, true, 'detached')]); // conflictCount:0 default
  assert.equal(r.perProject.warden.agents[0].conflictCount, 0);
});

test('the atRisk filter still matches ⚑N with the conflict agent folded in (the popover contract holds)', () => {
  // The ⚑N chip popover lists agents.filter(a => a.atRisk); that filtered length must
  // still equal the chip's atRisk count field now that conflict is a 4th reason class —
  // a conflict agent is at-risk (atRiskReason !== null ⇒ atRisk true), counted once.
  const chats = [agent('a1', 'warden'), agent('a2', 'warden'), agent('a3', 'warden')];
  const gitStatus = {
    a1: status(true, 0, 0, { detached: true, branch: 'HEAD' }),                                                                     // at-risk (detached)
    a2: status(true, 0, 0, { branch: 'main', upstream: 'origin/main', inProgress: { operation: 'merge' }, files: [{ path: 'm.ts', conflict: true }] }), // at-risk (conflict)
    a3: status(true, 0, 0, { branch: 'main', upstream: 'origin/main' }),                                                            // tracking, clean → not at-risk, skipped
  };
  const r = sum(chats, gitStatus);
  const agents = r.perProject.warden.agents;
  assert.deepEqual(agents.filter((a) => a.atRisk), [
    ag('a1', false, 0, 0, true, 'detached'),
    ag('a2', false, 0, 0, true, 'conflict', false, 0, null, null, false, 1),
  ]);
  assert.equal(r.perProject.warden.atRisk, agents.filter((a) => a.atRisk).length);
  assert.equal(r.perProject.warden.atRisk, 2);
});

console.log('\natRisk popover sort (WARDEN-701): render-time conflict-first, scoped to the atRisk kind');
test('summarizeProjectGitState does NOT reorder atRisk agents conflict-first — chats order is preserved (sort is render-time only)', () => {
  // The load-bearing invariant: summarizeProjectGitState emits agents in chats order so
  // its deep-equality holds AND the dirty/behind/stash/stalled popovers stay deterministic.
  // The conflict-first sort is a per-kind RENDER-TIME concern (GIT_STATE_KIND.atRisk.sort
  // in GitStateBadge), NEVER inside the summarizer. This case puts an op agent FIRST in
  // chats order and a conflict agent second and asserts the summarizer leaves them there.
  const chats = [agent('a1', 'warden'), agent('a2', 'warden'), agent('a3', 'warden')];
  const gitStatus = {
    a1: status(false, 0, 0, { branch: 'feature', upstream: 'origin/feature', inProgress: { operation: 'rebase' } }),                                  // op
    a2: status(false, 0, 0, { branch: 'feature', upstream: 'origin/feature', inProgress: { operation: 'merge' }, files: [{ path: 'x.ts', conflict: true }] }), // conflict
    a3: status(false, 0, 0, { detached: true, branch: 'HEAD' }),                                                                                       // detached
  };
  const r = sum(chats, gitStatus);
  assert.deepEqual(r.total.agents.map((a) => a.key), ['a1', 'a2', 'a3'], 'total.agents in chats order, NOT conflict-first');
  assert.deepEqual(r.perProject.warden.agents.map((a) => a.key), ['a1', 'a2', 'a3'], 'perProject agents in chats order too');
  // End-to-end: the render layer filters atRisk then sorts conflict-first → a2 on top.
  const atRisk = r.total.agents.filter((a) => a.atRisk);
  assert.deepEqual(sortGitAgentsByConflictFirst(atRisk).map((a) => a.key), ['a2', 'a1', 'a3']);
});

test('sortGitAgentsByConflictFirst ranks a conflict agent above op/noUpstream/detached agents', () => {
  // A 4-agent atRisk slice spanning every reason class, in an order no sort would
  // produce by accident (op, noUpstream, conflict, detached): the blocked merge
  // (conflict) MUST bubble to the top — the one repo state that cannot self-resolve.
  const agents = [
    ag('opA', false, 0, 0, true, 'op'),
    ag('noUpA', false, 0, 0, true, 'noUpstream'),
    ag('confA', false, 0, 0, true, 'conflict', false, 0, null, null, false, 3),
    ag('detA', false, 0, 0, true, 'detached'),
  ];
  assert.deepEqual(sortGitAgentsByConflictFirst(agents).map((a) => a.key), ['confA', 'opA', 'noUpA', 'detA']);
});

test('sortGitAgentsByConflictFirst: multiple conflicts keep input order, non-conflicts keep input order, stable', () => {
  // Array.prototype.sort is stable on Node ≥12 / V8; this asserts the helper relies on
  // that (no comparator tiebreak that would scramble equal rows). Two conflicts (conf1,
  // conf2) keep order and lead; two non-conflicts (op1, op2) keep order and trail.
  const input = [
    ag('op1', false, 0, 0, true, 'op'),
    ag('conf1', false, 0, 0, true, 'conflict', false, 0, null, null, false, 1),
    ag('conf2', false, 0, 0, true, 'conflict', false, 0, null, null, false, 5),
    ag('op2', false, 0, 0, true, 'op'),
  ];
  assert.deepEqual(sortGitAgentsByConflictFirst(input).map((a) => a.key), ['conf1', 'conf2', 'op1', 'op2']);
});

test('sortGitAgentsByConflictFirst returns a NEW array and does NOT mutate its input', () => {
  // Load-bearing: the summarizer's `agents` array is shared by the dirty/behind/stash/
  // stalled popovers in chats-iteration order. If the helper mutated its input in place,
  // the atRisk sort would scramble the other popovers' determinism. The helper MUST copy.
  const original = [ag('opA', false, 0, 0, true, 'op'), ag('confA', false, 0, 0, true, 'conflict', false, 0, null, null, false, 2)];
  const inputOrder = original.map((a) => a.key);
  const sorted = sortGitAgentsByConflictFirst(original);
  assert.notEqual(sorted, original, 'returns a new array, not the same reference');
  assert.deepEqual(original.map((a) => a.key), inputOrder, 'input array is unchanged (not mutated)');
  assert.deepEqual(sorted.map((a) => a.key), ['confA', 'opA'], 'the new array IS sorted (conflict first)');
});

test('all-non-conflict input is a stable no-op order (no conflict → all tied at 0)', () => {
  assert.deepEqual(sortGitAgentsByConflictFirst([ag('x', false, 0, 0, true, 'op'), ag('y', false, 0, 0, true, 'detached')]).map((a) => a.key), ['x', 'y']);
});

console.log(`\n✓ GIT STATE SUMMARY TESTS PASS (${passed})`);

// ---------------------------------------------------------------------------
// detectProjectFileCollisions (WARDEN-288) — the proactive cross-agent
// file-edit collision detector behind the project chips' ⚠ badge. A collision
// is a changed-file path that ≥2 DISTINCT active agents in the SAME project both
// have in their uncommitted working tree. Mirrors summarizeProjectGitState's
// population (active && project, status by key||id) and its sparse perProject +
// union total shape. Join key is `path` only (status/conflict ignored; untracked
// `??` paths count); a path listed twice in ONE agent's files never self-collides.
//
// Tiny builders so each case reads as "which agents touch which path" — `fstatus`
// adds a changed-files list (clean defaults to false so the agent has WIP, ahead
// to 0). `col` is the expected collision shape (path + its ordered agent keys).
const fstatus = (files, clean = false, ahead = 0) => ({ clean, ahead, files });
const file = (path, status = 'M') => ({ path, status });
const ca = (key) => ({ key });
const col = (path, keys) => ({ path, agents: keys.map(ca) });
const detect = (chats, gitStatus) => detectProjectFileCollisions(chats, gitStatus);

console.log('\nfile collisions (WARDEN-288): ≥2 agents editing the same path in a project');
test('two agents both with src/auth.js → one colliding path carrying both agent keys', () => {
  const r = detect(
    [agent('a1', 'warden'), agent('a2', 'warden')],
    { a1: fstatus([file('src/auth.js')]), a2: fstatus([file('src/auth.js')]) },
  );
  assert.deepEqual(r.perProject, { warden: { paths: [col('src/auth.js', ['a1', 'a2'])] } });
  assert.deepEqual(r.total, { paths: [col('src/auth.js', ['a1', 'a2'])] });
});

test('agents appear in chats iteration order; three agents on one path', () => {
  const r = detect(
    [agent('a1', 'warden'), agent('a2', 'warden'), agent('a3', 'warden')],
    { a1: fstatus([file('README.md')]), a2: fstatus([file('README.md')]), a3: fstatus([file('README.md')]) },
  );
  assert.deepEqual(r.perProject.warden.paths, [col('README.md', ['a1', 'a2', 'a3'])]);
});

test('disjoint files across agents → no collision (sparse, empty total)', () => {
  const r = detect(
    [agent('a1', 'warden'), agent('a2', 'warden')],
    { a1: fstatus([file('src/a.js')]), a2: fstatus([file('src/b.js')]) },
  );
  assert.deepEqual(r.perProject, {});
  assert.deepEqual(r.total, { paths: [] });
});

test('the same path across two DIFFERENT projects does NOT cross-trigger', () => {
  // warden: a1 + a2 collide on src/auth.js. tinker: b1 ALONE has src/auth.js.
  // Collisions are project-scoped, so tinker (1 agent) has none and the total
  // carries only warden's collision.
  const r = detect(
    [agent('a1', 'warden'), agent('a2', 'warden'), agent('b1', 'tinker')],
    { a1: fstatus([file('src/auth.js')]), a2: fstatus([file('src/auth.js')]), b1: fstatus([file('src/auth.js')]) },
  );
  assert.deepEqual(r.perProject, { warden: { paths: [col('src/auth.js', ['a1', 'a2'])] } });
  assert.ok(!('tinker' in r.perProject));
  assert.deepEqual(r.total, { paths: [col('src/auth.js', ['a1', 'a2'])] });
});

test('a single agent editing a file never collides (needs ≥2 distinct agents)', () => {
  const r = detect([agent('a1', 'warden')], { a1: fstatus([file('src/auth.js')]) });
  assert.deepEqual(r.perProject, {});
  assert.deepEqual(r.total, { paths: [] });
});

test('files: null (detached/no-branch) is ignored — never a false collision', () => {
  // a2 is detached/no-branch (files: null) → contributes nothing → only 1 agent
  // on src/auth.js → no collision, even though a1 has it.
  const r = detect(
    [agent('a1', 'warden'), agent('a2', 'warden')],
    { a1: fstatus([file('src/auth.js')]), a2: { clean: false, ahead: 0, files: null } },
  );
  assert.deepEqual(r.perProject, {});
});

test('a chat missing from gitStatus (still loading) is ignored', () => {
  const r = detect([agent('a1', 'warden'), agent('a2', 'warden')], { a1: fstatus([file('src/auth.js')]) });
  assert.deepEqual(r.perProject, {});
});

test('untracked (??) paths count — two agents creating the same new file collide', () => {
  const r = detect(
    [agent('a1', 'warden'), agent('a2', 'warden')],
    { a1: fstatus([file('src/new.js', '??')]), a2: fstatus([file('src/new.js', '??')]) },
  );
  assert.deepEqual(r.perProject, { warden: { paths: [col('src/new.js', ['a1', 'a2'])] } });
});

test('a path listed twice in ONE agent\'s files does not self-collide', () => {
  // a1 defensively has src/auth.js twice; a2 does not have it. The dedupe-by-agent
  // rule means a1 counts once, so src/auth.js still has only 1 agent → no collision.
  const r = detect(
    [agent('a1', 'warden'), agent('a2', 'warden')],
    { a1: fstatus([file('src/auth.js'), file('src/auth.js')]), a2: fstatus([file('src/other.js')]) },
  );
  assert.deepEqual(r.perProject, {});
});

test('multiple colliding paths in one project are all listed, in first-appearance order', () => {
  // a1 sees auth then config; a2 sees config then auth. Path order follows FIRST
  // appearance across chats → auth (a1) before config (a1). Both carry [a1, a2].
  const r = detect(
    [agent('a1', 'warden'), agent('a2', 'warden')],
    {
      a1: fstatus([file('src/auth.js'), file('src/config.js')]),
      a2: fstatus([file('src/config.js'), file('src/auth.js')]),
    },
  );
  assert.deepEqual(r.perProject.warden.paths, [
    col('src/auth.js', ['a1', 'a2']),
    col('src/config.js', ['a1', 'a2']),
  ]);
});

test('total.paths is the union of colliding paths across projects', () => {
  const r = detect(
    [agent('a1', 'warden'), agent('a2', 'warden'), agent('b1', 'tinker'), agent('b2', 'tinker')],
    {
      a1: fstatus([file('lib/a.js')]), a2: fstatus([file('lib/a.js')]),
      b1: fstatus([file('lib/b.js')]), b2: fstatus([file('lib/b.js')]),
    },
  );
  assert.deepEqual(r.perProject.warden.paths, [col('lib/a.js', ['a1', 'a2'])]);
  assert.deepEqual(r.perProject.tinker.paths, [col('lib/b.js', ['b1', 'b2'])]);
  assert.deepEqual(r.total.paths, [col('lib/a.js', ['a1', 'a2']), col('lib/b.js', ['b1', 'b2'])]);
});

test('inactive / project-less chats are skipped (population matches the chips)', () => {
  // a2 is inactive → even though it "has" the same file, only active a1 counts →
  // 1 agent → no collision. A project-less agent is skipped the same way.
  const r = detect(
    [agent('a1', 'warden'), { id: 'a2', project: 'warden', active: false }, { id: 'a3', active: true }],
    { a1: fstatus([file('src/auth.js')]), a2: fstatus([file('src/auth.js')]), a3: fstatus([file('src/auth.js')]) },
  );
  assert.deepEqual(r.perProject, {});
});

test('key || id resolution carries through to the collision agent keys', () => {
  // container keys set: the contributing agents are keyed by key, not bare id,
  // so the React layer's findChat(chats, key) lands on the right chat row.
  const r = detect(
    [agent('raw-1', 'warden', 'warden-worker'), agent('raw-2', 'warden', 'warden-reviewer')],
    { 'warden-worker': fstatus([file('src/auth.js')]), 'warden-reviewer': fstatus([file('src/auth.js')]) },
  );
  assert.deepEqual(r.perProject.warden.paths, [col('src/auth.js', ['warden-worker', 'warden-reviewer'])]);
});

test('empty inputs are safe', () => {
  assert.deepEqual(detect([], { a1: fstatus([file('x')]) }), { perProject: {}, total: { paths: [] } });
});

console.log(`\n✓ FILE COLLISION TESTS PASS (${passed} cumulative)`);

// ---------------------------------------------------------------------------
// detectProjectImpendingCollisions (WARDEN-601) — the IMPENDING cross-agent
// file-conflict detector: a path one agent has in its UNPUSHED commits
// (outgoingFiles) while ANOTHER agent in the same project has dirty in its working
// tree (files). The collision class the WARDEN-288 working-tree×working-tree
// detector is blind to (agent A committed F with a clean tree → A contributes
// nothing to the WIP join), yet B's next pull collides on F. Mirrors the live
// detector's population (active && project, status by key||id), sparse perProject +
// union total shape, and deterministic chats-iteration ordering.
//
// Builders: `ostatus` carries a working-tree files list + an outgoingFiles list
// (the new /api/git-status field). `agsrc` is an expected agent tagged with its
// side ('outgoing' committer / 'wip' editor); `icol` is the expected impending
// collision shape (path + kind:'impending' + tagged agents, committers first).
const ostatus = (files, outgoing) => ({ clean: false, ahead: 0, files, outgoingFiles: outgoing });
const agsrc = (key, source) => ({ key, source });
const icol = (path, agents) => ({ path, kind: 'impending', agents });
const detectImp = (chats, gitStatus) => detectProjectImpendingCollisions(chats, gitStatus);

console.log('\nimpending collisions (WARDEN-601): committed-outgoing × working-tree-WIP');
test('A committed F (clean tree) + B editing F → one impending path, committer then editor', () => {
  const r = detectImp(
    [agent('a1', 'warden'), agent('a2', 'warden')],
    {
      a1: ostatus([], ['src/auth.js']),        // committed F, clean tree → the live join is blind to a1
      a2: ostatus([file('src/auth.js')], []),  // editing F (working-tree WIP)
    },
  );
  assert.deepEqual(r.perProject, { warden: { paths: [icol('src/auth.js', [agsrc('a1', 'outgoing'), agsrc('a2', 'wip')])] } });
  assert.deepEqual(r.total, { paths: [icol('src/auth.js', [agsrc('a1', 'outgoing'), agsrc('a2', 'wip')])] });
});

test('impending entries are tagged kind:"impending" with per-agent source (the dialog reads source)', () => {
  // The compare dialog fetches the OUTGOING diff for a source:'outgoing' agent and
  // the working-tree diff otherwise — so the source tag is load-bearing, not cosmetic.
  const r = detectImp(
    [agent('a1', 'warden'), agent('a2', 'warden')],
    { a1: ostatus([], ['F']), a2: ostatus([file('F')], []) },
  );
  assert.equal(r.perProject.warden.paths[0].kind, 'impending');
  assert.deepEqual(r.perProject.warden.paths[0].agents, [agsrc('a1', 'outgoing'), agsrc('a2', 'wip')]);
});

test('no outgoing×WIP overlap (A outgoing F, B editing G) → no signal (zero noise)', () => {
  const r = detectImp(
    [agent('a1', 'warden'), agent('a2', 'warden')],
    { a1: ostatus([], ['F']), a2: ostatus([file('G')], []) },
  );
  assert.deepEqual(r.perProject, {});
  assert.deepEqual(r.total, { paths: [] });
});

test('the same path across two DIFFERENT projects does NOT cross-trigger (cross-project isolation)', () => {
  // warden: a1 has F outgoing. tinker: b1 has F dirty. Different projects → no join.
  const r = detectImp(
    [agent('a1', 'warden'), agent('b1', 'tinker')],
    { a1: ostatus([], ['F']), b1: ostatus([file('F')], []) },
  );
  assert.deepEqual(r.perProject, {});
  assert.deepEqual(r.total, { paths: [] });
});

test('a single agent with F outgoing (no editor) never impending (needs ≥1 committer AND ≥1 editor)', () => {
  const r = detectImp([agent('a1', 'warden')], { a1: ostatus([], ['F']) });
  assert.deepEqual(r.perProject, {});
  assert.deepEqual(r.total, { paths: [] });
});

test('committer-clean rule: A has F BOTH outgoing AND dirty → NOT flagged impending (the live detector owns it)', () => {
  // a1 committed F AND is still editing F (F ∈ a1.files), a2 is editing F. This is a
  // LIVE WIP-vs-WIP collision (a1,a2 both dirty) already surfaced by the ⚠. The
  // impending detector must NOT re-flag it: a1 is excluded as a committer (F ∈ its
  // wip), leaving committers=[] → nothing emitted. This is the no-noise guarantee.
  const r = detectImp(
    [agent('a1', 'warden'), agent('a2', 'warden')],
    { a1: ostatus([file('F')], ['F']), a2: ostatus([file('F')], []) },
  );
  assert.deepEqual(r.perProject, {});
  // Sanity: the LIVE detector DOES flag this same setup (orthogonal, not a gap).
  const live = detect([agent('a1', 'warden'), agent('a2', 'warden')], { a1: fstatus([file('F')]), a2: fstatus([file('F')]) });
  assert.deepEqual(live.total.paths, [col('F', ['a1', 'a2'])]);
});

test('multiple editors: one committer + two editors all listed, committer first', () => {
  const r = detectImp(
    [agent('a1', 'warden'), agent('a2', 'warden'), agent('a3', 'warden')],
    {
      a1: ostatus([], ['F']),
      a2: ostatus([file('F')], []),
      a3: ostatus([file('F')], []),
    },
  );
  assert.deepEqual(r.perProject.warden.paths, [icol('F', [agsrc('a1', 'outgoing'), agsrc('a2', 'wip'), agsrc('a3', 'wip')])]);
});

test('multiple committers: two committers + one editor all listed, committers first', () => {
  const r = detectImp(
    [agent('a1', 'warden'), agent('a2', 'warden'), agent('b1', 'warden')],
    {
      a1: ostatus([], ['F']),
      a2: ostatus([], ['F']),
      b1: ostatus([file('F')], []),
    },
  );
  assert.deepEqual(r.perProject.warden.paths, [icol('F', [agsrc('a1', 'outgoing'), agsrc('a2', 'outgoing'), agsrc('b1', 'wip')])]);
});

test('multiple impending paths are listed in first-appearance (outgoing) order, deterministically', () => {
  // a1 committed auth then config (outgoing order); a2 is editing both. Path order
  // follows a1's outgoing iteration → auth before config. Both carry [a1 outgoing, a2 wip].
  const r = detectImp(
    [agent('a1', 'warden'), agent('a2', 'warden')],
    {
      a1: ostatus([], ['src/auth.js', 'src/config.js']),
      a2: ostatus([file('src/config.js'), file('src/auth.js')], []),
    },
  );
  assert.deepEqual(r.perProject.warden.paths, [
    icol('src/auth.js', [agsrc('a1', 'outgoing'), agsrc('a2', 'wip')]),
    icol('src/config.js', [agsrc('a1', 'outgoing'), agsrc('a2', 'wip')]),
  ]);
});

test('missing outgoingFiles field contributes no committer (a wip-only agent never impending alone)', () => {
  // Two wip-only agents with no outgoingFiles field at all → no committer → nothing.
  const r = detectImp(
    [agent('a1', 'warden'), agent('a2', 'warden')],
    { a1: { files: [file('F')] }, a2: { files: [file('F')] } },
  );
  assert.deepEqual(r.perProject, {});
});

test('outgoingFiles:null is quiet (an in-sync agent contributes no committer)', () => {
  const r = detectImp(
    [agent('a1', 'warden'), agent('a2', 'warden')],
    { a1: { files: [], outgoingFiles: null }, a2: ostatus([file('F')], []) },
  );
  assert.deepEqual(r.perProject, {});
});

test('files:null is tolerated — the agent can still be a committer via outgoing', () => {
  // a1 committed F and reports files:null (no WIP set at all); a2 is editing F. The
  // detector must not crash on files:null and must still flag the impending pair
  // (a1's wipPaths is empty, so F is not skipped as a committer).
  const r = detectImp(
    [agent('a1', 'warden'), agent('a2', 'warden')],
    { a1: { files: null, outgoingFiles: ['F'] }, a2: ostatus([file('F')], []) },
  );
  assert.deepEqual(r.perProject.warden.paths, [icol('F', [agsrc('a1', 'outgoing'), agsrc('a2', 'wip')])]);
});

test('a path with a committer but no editor, AND a path with an editor but no committer, are both skipped', () => {
  // F: only a1 outgoing (no editor). G: only a2 wip (no committer). Neither crosses → none.
  const r = detectImp(
    [agent('a1', 'warden'), agent('a2', 'warden')],
    { a1: ostatus([], ['F']), a2: ostatus([file('G')], []) },
  );
  assert.deepEqual(r.perProject, {});
});

test('inactive / project-less chats are skipped (population matches the chips)', () => {
  // a2 is inactive → even though it is the only editor, only active a1 counts → no
  // editor → no impending. A project-less agent is skipped the same way.
  const r = detectImp(
    [agent('a1', 'warden'), { id: 'a2', project: 'warden', active: false }, { id: 'a3', active: true }],
    { a1: ostatus([], ['F']), a2: ostatus([file('F')], []), a3: ostatus([file('F')], []) },
  );
  assert.deepEqual(r.perProject, {});
});

test('key || id resolution carries through to the impending agent keys', () => {
  const r = detectImp(
    [agent('raw-1', 'warden', 'warden-worker'), agent('raw-2', 'warden', 'warden-reviewer')],
    { 'warden-worker': ostatus([], ['src/auth.js']), 'warden-reviewer': ostatus([file('src/auth.js')], []) },
  );
  assert.deepEqual(r.perProject.warden.paths, [icol('src/auth.js', [agsrc('warden-worker', 'outgoing'), agsrc('warden-reviewer', 'wip')])]);
});

test('total.paths is the union of impending paths across projects', () => {
  const r = detectImp(
    [agent('a1', 'warden'), agent('a2', 'warden'), agent('b1', 'tinker'), agent('b2', 'tinker')],
    {
      a1: ostatus([], ['lib/a.js']), a2: ostatus([file('lib/a.js')], []),
      b1: ostatus([], ['lib/b.js']), b2: ostatus([file('lib/b.js')], []),
    },
  );
  assert.deepEqual(r.perProject.warden.paths, [icol('lib/a.js', [agsrc('a1', 'outgoing'), agsrc('a2', 'wip')])]);
  assert.deepEqual(r.perProject.tinker.paths, [icol('lib/b.js', [agsrc('b1', 'outgoing'), agsrc('b2', 'wip')])]);
  assert.deepEqual(r.total.paths, [
    icol('lib/a.js', [agsrc('a1', 'outgoing'), agsrc('a2', 'wip')]),
    icol('lib/b.js', [agsrc('b1', 'outgoing'), agsrc('b2', 'wip')]),
  ]);
});

test('orthogonal to the live detector: a pure WIP-vs-WIP case flags live, not impending', () => {
  // Both agents dirty on F, no outgoing at all. Live ⚠ flags it; impending stays empty.
  const chats = [agent('a1', 'warden'), agent('a2', 'warden')];
  const gs = { a1: fstatus([file('F')]), a2: fstatus([file('F')]) };
  assert.deepEqual(detectImp(chats, gs).total, { paths: [] });
  assert.deepEqual(detect(chats, gs).total.paths, [col('F', ['a1', 'a2'])]);
});

test('empty inputs are safe', () => {
  assert.deepEqual(detectImp([], { a1: ostatus([], ['x']) }), { perProject: {}, total: { paths: [] } });
});

console.log(`\n✓ IMPENDING COLLISION TESTS PASS (${passed} cumulative)`);

// ---------------------------------------------------------------------------
// detectProjectOutgoingCollisions (WARDEN-639) — the OUTGOING×OUTGOING cross-agent
// collision detector: a path that ≥2 DISTINCT active agents in the SAME project EACH
// have in their unpushed commits (outgoingFiles) with CLEAN working trees for that
// path. The matrix cell BOTH other detectors are blind to (both agents committed,
// neither dirty → invisible to the live WIP join AND the impending editor side); it
// surfaces only at push/merge/CI. Mirrors the other detectors' population (active &&
// project, status by key||id), sparse perProject + union total shape, committer-clean
// rule (reused from impending so a path already surfaced by live/impending is NOT
// re-surfaced here), and deterministic chats-iteration ordering.
//
// Builders reuse the impending suite's `ostatus` (files + outgoingFiles) and `agsrc`
// (key + source); `ocol` is the expected outgoing collision shape (path +
// kind:'outgoing' + agents all source:'outgoing'); `detectOut` wraps the detector.
const ocol = (path, agents) => ({ path, kind: 'outgoing', agents });
const detectOut = (chats, gitStatus) => detectProjectOutgoingCollisions(chats, gitStatus);

console.log('\noutgoing×outgoing collisions (WARDEN-639): committed-outgoing × committed-outgoing');
test('two clean agents both committed src/auth.js → one outgoing path carrying both agent keys', () => {
  const r = detectOut(
    [agent('a1', 'warden'), agent('a2', 'warden')],
    {
      a1: ostatus([], ['src/auth.js']),  // committed auth.js, clean tree
      a2: ostatus([], ['src/auth.js']),  // committed auth.js, clean tree
    },
  );
  assert.deepEqual(r.perProject, { warden: { paths: [ocol('src/auth.js', [agsrc('a1', 'outgoing'), agsrc('a2', 'outgoing')])] } });
  assert.deepEqual(r.total, { paths: [ocol('src/auth.js', [agsrc('a1', 'outgoing'), agsrc('a2', 'outgoing')])] });
});

test('outgoing entries are tagged kind:"outgoing" with every agent source:"outgoing" (the dialog reads source for the range)', () => {
  // The compare dialog fetches the OUTGOING (@{u}..HEAD) diff for a source:'outgoing'
  // agent — so the source tag is load-bearing, not cosmetic: BOTH panels must source
  // from the outgoing range, not an empty working-tree diff that would misclassify as
  // 'already resolved'.
  const r = detectOut(
    [agent('a1', 'warden'), agent('a2', 'warden')],
    { a1: ostatus([], ['F']), a2: ostatus([], ['F']) },
  );
  assert.equal(r.perProject.warden.paths[0].kind, 'outgoing');
  assert.deepEqual(r.perProject.warden.paths[0].agents, [agsrc('a1', 'outgoing'), agsrc('a2', 'outgoing')]);
});

test('agents appear in chats iteration order; three committers on one path', () => {
  const r = detectOut(
    [agent('a1', 'warden'), agent('a2', 'warden'), agent('a3', 'warden')],
    { a1: ostatus([], ['README.md']), a2: ostatus([], ['README.md']), a3: ostatus([], ['README.md']) },
  );
  assert.deepEqual(r.perProject.warden.paths, [ocol('README.md', [agsrc('a1', 'outgoing'), agsrc('a2', 'outgoing'), agsrc('a3', 'outgoing')])]);
});

test('a single committer (no second agent) never outgoing-collides (needs ≥2 distinct committers)', () => {
  const r = detectOut([agent('a1', 'warden')], { a1: ostatus([], ['src/auth.js']) });
  assert.deepEqual(r.perProject, {});
  assert.deepEqual(r.total, { paths: [] });
});

test('two paths each with a single (different) committer → neither collides (needs ≥2 on the SAME path)', () => {
  // a1 committed F; a2 committed G. Different paths, 1 committer each → no collision.
  const r = detectOut(
    [agent('a1', 'warden'), agent('a2', 'warden')],
    { a1: ostatus([], ['F']), a2: ostatus([], ['G']) },
  );
  assert.deepEqual(r.perProject, {});
  assert.deepEqual(r.total, { paths: [] });
});

test('committer-clean rule: A has F BOTH outgoing AND dirty → NOT counted as a committer (the live/impending detectors own the dirty side)', () => {
  // a1 committed F cleanly (outgoing, clean tree); a2 committed F AND is still editing
  // F (F ∈ a2.files). a2 is excluded as a committer, leaving only a1 → 1 committer → no
  // outgoing×outgoing collision. a2's dirty copy is already a live/impending signal.
  const r = detectOut(
    [agent('a1', 'warden'), agent('a2', 'warden')],
    { a1: ostatus([], ['F']), a2: ostatus([file('F')], ['F']) },
  );
  assert.deepEqual(r.perProject, {});
  // Sanity: this same setup IS an impending collision (a1 committed, a2 editing) —
  // orthogonal, not a gap. The outgoing detector's silence is correct, not a miss.
  const chats = [agent('a1', 'warden'), agent('a2', 'warden')];
  assert.deepEqual(detectImp(chats, { a1: ostatus([], ['F']), a2: ostatus([file('F')], ['F']) }).total.paths, [
    icol('F', [agsrc('a1', 'outgoing'), agsrc('a2', 'wip')]),
  ]);
});

test('outgoingFiles:null is quiet (an in-sync agent contributes no committer)', () => {
  const r = detectOut(
    [agent('a1', 'warden'), agent('a2', 'warden')],
    { a1: { files: [], outgoingFiles: null }, a2: ostatus([], ['F']) },
  );
  assert.deepEqual(r.perProject, {});
  assert.deepEqual(r.total, { paths: [] });
});

test('the same path across two DIFFERENT projects does NOT cross-trigger (cross-project isolation)', () => {
  // warden: a1 committed F. tinker: b1 committed F. Different projects → each has 1
  // committer → no join.
  const r = detectOut(
    [agent('a1', 'warden'), agent('b1', 'tinker')],
    { a1: ostatus([], ['F']), b1: ostatus([], ['F']) },
  );
  assert.deepEqual(r.perProject, {});
  assert.deepEqual(r.total, { paths: [] });
});

test('multiple outgoing×outgoing paths are listed in first-appearance (outgoing) order, deterministically', () => {
  // a1 committed auth then config (outgoing order); a2 committed both too. Path order
  // follows a1's outgoing iteration → auth before config. Both carry [a1, a2] outgoing.
  const r = detectOut(
    [agent('a1', 'warden'), agent('a2', 'warden')],
    {
      a1: ostatus([], ['src/auth.js', 'src/config.js']),
      a2: ostatus([], ['src/config.js', 'src/auth.js']),
    },
  );
  assert.deepEqual(r.perProject.warden.paths, [
    ocol('src/auth.js', [agsrc('a1', 'outgoing'), agsrc('a2', 'outgoing')]),
    ocol('src/config.js', [agsrc('a1', 'outgoing'), agsrc('a2', 'outgoing')]),
  ]);
});

test('missing outgoingFiles field contributes no committer', () => {
  // Two clean-tree agents with no outgoingFiles field at all → no committer → nothing.
  const r = detectOut(
    [agent('a1', 'warden'), agent('a2', 'warden')],
    { a1: { files: [] }, a2: { files: [] } },
  );
  assert.deepEqual(r.perProject, {});
});

test('files:null is tolerated — the agent can still be a committer via outgoing', () => {
  // a1 committed F and reports files:null (no WIP set at all); a2 committed F cleanly.
  // The detector must not crash on files:null and must still flag the outgoing pair
  // (a1's wipPaths is empty, so F is not skipped as a committer).
  const r = detectOut(
    [agent('a1', 'warden'), agent('a2', 'warden')],
    { a1: { files: null, outgoingFiles: ['F'] }, a2: ostatus([], ['F']) },
  );
  assert.deepEqual(r.perProject.warden.paths, [ocol('F', [agsrc('a1', 'outgoing'), agsrc('a2', 'outgoing')])]);
});

test('inactive / project-less chats are skipped (population matches the chips)', () => {
  // a2 is inactive → even though it committed F, only active a1 counts → 1 committer →
  // no collision. A project-less agent is skipped the same way.
  const r = detectOut(
    [agent('a1', 'warden'), { id: 'a2', project: 'warden', active: false }, { id: 'a3', active: true }],
    { a1: ostatus([], ['F']), a2: ostatus([], ['F']), a3: ostatus([], ['F']) },
  );
  assert.deepEqual(r.perProject, {});
});

test('key || id resolution carries through to the outgoing agent keys', () => {
  const r = detectOut(
    [agent('raw-1', 'warden', 'warden-worker'), agent('raw-2', 'warden', 'warden-reviewer')],
    { 'warden-worker': ostatus([], ['src/auth.js']), 'warden-reviewer': ostatus([], ['src/auth.js']) },
  );
  assert.deepEqual(r.perProject.warden.paths, [ocol('src/auth.js', [agsrc('warden-worker', 'outgoing'), agsrc('warden-reviewer', 'outgoing')])]);
});

test('total.paths is the union of outgoing paths across projects', () => {
  const r = detectOut(
    [agent('a1', 'warden'), agent('a2', 'warden'), agent('b1', 'tinker'), agent('b2', 'tinker')],
    {
      a1: ostatus([], ['lib/a.js']), a2: ostatus([], ['lib/a.js']),
      b1: ostatus([], ['lib/b.js']), b2: ostatus([], ['lib/b.js']),
    },
  );
  assert.deepEqual(r.perProject.warden.paths, [ocol('lib/a.js', [agsrc('a1', 'outgoing'), agsrc('a2', 'outgoing')])]);
  assert.deepEqual(r.perProject.tinker.paths, [ocol('lib/b.js', [agsrc('b1', 'outgoing'), agsrc('b2', 'outgoing')])]);
  assert.deepEqual(r.total.paths, [
    ocol('lib/a.js', [agsrc('a1', 'outgoing'), agsrc('a2', 'outgoing')]),
    ocol('lib/b.js', [agsrc('b1', 'outgoing'), agsrc('b2', 'outgoing')]),
  ]);
});

test('orthogonal to live AND impending: A+B both clean committers, C editing → outgoing flags A+B, impending flags A+C, on the SAME path', () => {
  // a1 + a2 each committed F cleanly (both unpushed, both clean) → outgoing×outgoing.
  // a3 is editing F (dirty, no outgoing). The SAME path is ALSO an impending collision
  // (a1/a2 committed, a3 editing) — two distinct risks, both correctly surfaced by
  // their own detectors. No dedupe across classes (the detectors are independent).
  const chats = [agent('a1', 'warden'), agent('a2', 'warden'), agent('a3', 'warden')];
  const gs = {
    a1: ostatus([], ['F']),
    a2: ostatus([], ['F']),
    a3: ostatus([file('F')], []),
  };
  // outgoing: a1 + a2 only (a3 is not a committer — F ∈ its wip).
  assert.deepEqual(detectOut(chats, gs).total.paths, [ocol('F', [agsrc('a1', 'outgoing'), agsrc('a2', 'outgoing')])]);
  // impending: a1/a2 committers + a3 editor.
  assert.deepEqual(detectImp(chats, gs).total.paths, [
    icol('F', [agsrc('a1', 'outgoing'), agsrc('a2', 'outgoing'), agsrc('a3', 'wip')]),
  ]);
});

test('orthogonal to the live detector: a pure WIP-vs-WIP case flags live, not outgoing', () => {
  // Both agents dirty on F, no outgoing at all. Live ⚠ flags it; outgoing stays empty.
  const chats = [agent('a1', 'warden'), agent('a2', 'warden')];
  const gs = { a1: fstatus([file('F')]), a2: fstatus([file('F')]) };
  assert.deepEqual(detectOut(chats, gs).total, { paths: [] });
  assert.deepEqual(detect(chats, gs).total.paths, [col('F', ['a1', 'a2'])]);
});

test('empty inputs are safe', () => {
  assert.deepEqual(detectOut([], { a1: ostatus([], ['x']) }), { perProject: {}, total: { paths: [] } });
});

console.log(`\n✓ OUTGOING COLLISION TESTS PASS (${passed} cumulative)`);
