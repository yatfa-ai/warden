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
const { summarizeProjectGitState, detectProjectFileCollisions, detectProjectImpendingCollisions } = await import(tmpFile);
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
// the implementation treats an absent behind exactly the same.
const status = (clean, ahead, behind = 0) => ({ clean, ahead, behind });
// The expected shape of a contributing-agent entry (WARDEN-268 + WARDEN-297).
// behind defaults to 0 to mirror status(): a pre-297 expected agent is not behind.
const ag = (key, dirty, ahead, behind = 0) => ({ key, dirty, ahead, behind });

const sum = (chats, gitStatus) => summarizeProjectGitState(chats, gitStatus);

console.log('\nclean project → no counts (badges hidden)');
test('a clean, pushed, up-to-date agent yields no per-project entry and zero totals', () => {
  const r = sum([agent('a1', 'warden')], { a1: status(true, 0) });
  assert.deepEqual(r.perProject, {});
  assert.deepEqual(r.total, { dirty: 0, unpushed: 0, behind: 0, agents: [] });
});

console.log('\ndirty-only → counts toward dirty, not unpushed/behind');
test('clean===false with ahead 0 → dirty:1, unpushed:0', () => {
  const r = sum([agent('a1', 'warden')], { a1: status(false, 0) });
  assert.deepEqual(r.perProject, { warden: { dirty: 1, unpushed: 0, behind: 0, agents: [ag('a1', true, 0)] } });
  assert.deepEqual(r.total, { dirty: 1, unpushed: 0, behind: 0, agents: [ag('a1', true, 0)] });
});

console.log('\nunpushed-only → counts toward unpushed, not dirty/behind');
test('clean repo with ahead 3 → dirty:0, unpushed:1', () => {
  const r = sum([agent('a1', 'warden')], { a1: status(true, 3) });
  assert.deepEqual(r.perProject, { warden: { dirty: 0, unpushed: 1, behind: 0, agents: [ag('a1', false, 3)] } });
  assert.deepEqual(r.total, { dirty: 0, unpushed: 1, behind: 0, agents: [ag('a1', false, 3)] });
});

console.log('\nboth → one agent contributes once to each counter (not doubled)');
test('clean===false AND ahead 2 → dirty:1, unpushed:1', () => {
  const r = sum([agent('a1', 'warden')], { a1: status(false, 2) });
  assert.deepEqual(r.perProject, { warden: { dirty: 1, unpushed: 1, behind: 0, agents: [ag('a1', true, 2)] } });
  assert.deepEqual(r.total, { dirty: 1, unpushed: 1, behind: 0, agents: [ag('a1', true, 2)] });
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
    warden: { dirty: 2, unpushed: 1, behind: 0, agents: [ag('a1', true, 0), ag('a2', true, 2)] },
    tinker: { dirty: 0, unpushed: 1, behind: 0, agents: [ag('b1', false, 5)] },
  });
  assert.deepEqual(r.total, { dirty: 2, unpushed: 2, behind: 0, agents: [ag('a1', true, 0), ag('a2', true, 2), ag('b1', false, 5)] });
});

console.log('\nunknown status (missing from gitStatus) counts as NEITHER, never clean');
test('an active project agent absent from the map → no entry, no totals', () => {
  const r = sum([agent('a1', 'warden')], {});
  assert.deepEqual(r.perProject, {});
  assert.deepEqual(r.total, { dirty: 0, unpushed: 0, behind: 0, agents: [] });
});
test('a still-loading agent never masks a dirty sibling in the same project', () => {
  // a1 dirty & known, a2 unknown: a2 must NOT be treated as clean and must not
  // dilute a1's dirty count (the false-clean trap this slice guards against).
  const r = sum([agent('a1', 'warden'), agent('a2', 'warden')], { a1: status(false, 0) });
  assert.deepEqual(r.perProject, { warden: { dirty: 1, unpushed: 0, behind: 0, agents: [ag('a1', true, 0)] } });
  assert.deepEqual(r.total, { dirty: 1, unpushed: 0, behind: 0, agents: [ag('a1', true, 0)] });
});

console.log('\nnull/unknown field values are quiet, not counted');
test('clean:null is not dirty (only explicit clean===false is)', () => {
  const r = sum([agent('a1', 'warden')], { a1: status(null, 1) });
  assert.deepEqual(r.perProject, { warden: { dirty: 0, unpushed: 1, behind: 0, agents: [ag('a1', false, 1)] } });
});
test('ahead:null is not unpushed (only a number > 0 is)', () => {
  const r = sum([agent('a1', 'warden')], { a1: status(false, null) });
  assert.deepEqual(r.perProject, { warden: { dirty: 1, unpushed: 0, behind: 0, agents: [ag('a1', true, 0)] } });
});
test('behind:null is not behind (only a number > 0 is) — a non-tracking agent (detached / no upstream) stays quiet', () => {
  // Mirrors ahead:null ⇒ not unpushed. behind:null means there is no @{u} to
  // compare against, so the agent must NOT surface as behind.
  const r = sum([agent('a1', 'warden')], { a1: status(false, 0, null) });
  assert.deepEqual(r.perProject, { warden: { dirty: 1, unpushed: 0, behind: 0, agents: [ag('a1', true, 0, 0)] } });
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
  assert.deepEqual(r.total, { dirty: 0, unpushed: 0, behind: 0, agents: [] });
});
test('active agent without a project is ignored (chips are project-scoped)', () => {
  const r = sum([{ id: 'a1', active: true }], { a1: status(false, 5) });
  assert.deepEqual(r.perProject, {});
  assert.deepEqual(r.total, { dirty: 0, unpushed: 0, behind: 0, agents: [] });
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
  assert.deepEqual(r.total, { dirty: 0, unpushed: 0, behind: 0, agents: [] });
});
test('when no key, the status is read from gitStatus[id]', () => {
  const chats = [{ id: 'chat-1', project: 'warden', active: true }];
  const r = sum(chats, { 'chat-1': status(false, 0) });
  assert.deepEqual(r.perProject, { warden: { dirty: 1, unpushed: 0, behind: 0, agents: [ag('chat-1', true, 0)] } });
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
  assert.deepEqual(r.total, { dirty: 0, unpushed: 0, behind: 0, agents: [] });
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
  assert.deepEqual(r.perProject, { warden: { dirty: 0, unpushed: 0, behind: 1, agents: [ag('a1', false, 0, 4)] } });
  assert.deepEqual(r.total, { dirty: 0, unpushed: 0, behind: 1, agents: [ag('a1', false, 0, 4)] });
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
      dirty: 2, unpushed: 1, behind: 2,
      agents: [ag('a1', true, 0, 0), ag('a2', false, 0, 7), ag('a3', true, 2, 3)],
    },
  });
  assert.deepEqual(r.total, {
    dirty: 2, unpushed: 1, behind: 2,
    agents: [ag('a1', true, 0, 0), ag('a2', false, 0, 7), ag('a3', true, 2, 3)],
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
  assert.deepEqual(r.perProject, { warden: { dirty: 0, unpushed: 0, behind: 1, agents: [ag('a1', false, 0, 9)] } });
  assert.equal('tinker' in r.perProject, false);
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
