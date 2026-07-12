// Tests for summarizeProjectGitState — the pure aggregator behind the project
// filter chips' uncommitted/unpushed WIP badges (WARDEN-201), now with the
// per-project contributing-agent breakdown that makes those badges explorable
// (WARDEN-268).
//
// There is no front-end test runner in this repo, so (like diff.test.mjs) this
// loads the REAL src/lib/gitStateSummary.ts (transpiled TS -> ESM via Vite's OXC
// transform) and exercises it directly with plain objects. The helper must be a
// faithful, sparse mirror of the per-row GitBranchBadge vocabulary: clean===false
// ⇒ dirty (yellow ±), ahead > 0 ⇒ unpushed (amber ↑N) — and a chat with unknown
// status (missing from the cached gitStatus map) must count as NEITHER, never as
// clean, so a still-loading agent can't masquerade as a clean repo.
//
// The WARDEN-268 additions assert the `agents` breakdown: each contributing agent
// (dirty and/or unpushed) appears once with { key, dirty, ahead }, in chats
// iteration order, so the chip's ±N / ↑N popovers can list exactly who is dirty
// vs. unpushed and jump to them. The helper stays display-field-free (no title,
// no branch) — the React layer joins key → displayName/branch.
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
const { summarizeProjectGitState, detectProjectFileCollisions } = await import(tmpFile);
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
const status = (clean, ahead) => ({ clean, ahead });
// The expected shape of a contributing-agent entry (WARDEN-268).
const ag = (key, dirty, ahead) => ({ key, dirty, ahead });

const sum = (chats, gitStatus) => summarizeProjectGitState(chats, gitStatus);

console.log('\nclean project → no counts (badges hidden)');
test('a clean, pushed agent yields no per-project entry and zero totals', () => {
  const r = sum([agent('a1', 'warden')], { a1: status(true, 0) });
  assert.deepEqual(r.perProject, {});
  assert.deepEqual(r.total, { dirty: 0, unpushed: 0, agents: [] });
});

console.log('\ndirty-only → counts toward dirty, not unpushed');
test('clean===false with ahead 0 → dirty:1, unpushed:0', () => {
  const r = sum([agent('a1', 'warden')], { a1: status(false, 0) });
  assert.deepEqual(r.perProject, { warden: { dirty: 1, unpushed: 0, agents: [ag('a1', true, 0)] } });
  assert.deepEqual(r.total, { dirty: 1, unpushed: 0, agents: [ag('a1', true, 0)] });
});

console.log('\nunpushed-only → counts toward unpushed, not dirty');
test('clean repo with ahead 3 → dirty:0, unpushed:1', () => {
  const r = sum([agent('a1', 'warden')], { a1: status(true, 3) });
  assert.deepEqual(r.perProject, { warden: { dirty: 0, unpushed: 1, agents: [ag('a1', false, 3)] } });
  assert.deepEqual(r.total, { dirty: 0, unpushed: 1, agents: [ag('a1', false, 3)] });
});

console.log('\nboth → one agent contributes once to each counter (not doubled)');
test('clean===false AND ahead 2 → dirty:1, unpushed:1', () => {
  const r = sum([agent('a1', 'warden')], { a1: status(false, 2) });
  assert.deepEqual(r.perProject, { warden: { dirty: 1, unpushed: 1, agents: [ag('a1', true, 2)] } });
  assert.deepEqual(r.total, { dirty: 1, unpushed: 1, agents: [ag('a1', true, 2)] });
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
    warden: { dirty: 2, unpushed: 1, agents: [ag('a1', true, 0), ag('a2', true, 2)] },
    tinker: { dirty: 0, unpushed: 1, agents: [ag('b1', false, 5)] },
  });
  assert.deepEqual(r.total, { dirty: 2, unpushed: 2, agents: [ag('a1', true, 0), ag('a2', true, 2), ag('b1', false, 5)] });
});

console.log('\nunknown status (missing from gitStatus) counts as NEITHER, never clean');
test('an active project agent absent from the map → no entry, no totals', () => {
  const r = sum([agent('a1', 'warden')], {});
  assert.deepEqual(r.perProject, {});
  assert.deepEqual(r.total, { dirty: 0, unpushed: 0, agents: [] });
});
test('a still-loading agent never masks a dirty sibling in the same project', () => {
  // a1 dirty & known, a2 unknown: a2 must NOT be treated as clean and must not
  // dilute a1's dirty count (the false-clean trap this slice guards against).
  const r = sum([agent('a1', 'warden'), agent('a2', 'warden')], { a1: status(false, 0) });
  assert.deepEqual(r.perProject, { warden: { dirty: 1, unpushed: 0, agents: [ag('a1', true, 0)] } });
  assert.deepEqual(r.total, { dirty: 1, unpushed: 0, agents: [ag('a1', true, 0)] });
});

console.log('\nnull/unknown field values are quiet, not counted');
test('clean:null is not dirty (only explicit clean===false is)', () => {
  const r = sum([agent('a1', 'warden')], { a1: status(null, 1) });
  assert.deepEqual(r.perProject, { warden: { dirty: 0, unpushed: 1, agents: [ag('a1', false, 1)] } });
});
test('ahead:null is not unpushed (only a number > 0 is)', () => {
  const r = sum([agent('a1', 'warden')], { a1: status(false, null) });
  assert.deepEqual(r.perProject, { warden: { dirty: 1, unpushed: 0, agents: [ag('a1', true, 0)] } });
});
test('ahead:0 is not unpushed', () => {
  const r = sum([agent('a1', 'warden')], { a1: status(false, 0) });
  assert.equal(r.perProject.warden.unpushed, 0);
});

console.log('\npopulation matches projectCounts: inactive / project-less chats are skipped');
test('inactive agent (active:false) is ignored even when dirty', () => {
  const r = sum([{ id: 'a1', project: 'warden', active: false }], { a1: status(false, 5) });
  assert.deepEqual(r.perProject, {});
  assert.deepEqual(r.total, { dirty: 0, unpushed: 0, agents: [] });
});
test('active agent without a project is ignored (chips are project-scoped)', () => {
  const r = sum([{ id: 'a1', active: true }], { a1: status(false, 5) });
  assert.deepEqual(r.perProject, {});
  assert.deepEqual(r.total, { dirty: 0, unpushed: 0, agents: [] });
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
  assert.deepEqual(r.total, { dirty: 0, unpushed: 0, agents: [] });
});
test('when no key, the status is read from gitStatus[id]', () => {
  const chats = [{ id: 'chat-1', project: 'warden', active: true }];
  const r = sum(chats, { 'chat-1': status(false, 0) });
  assert.deepEqual(r.perProject, { warden: { dirty: 1, unpushed: 0, agents: [ag('chat-1', true, 0)] } });
});

console.log('\ntotal always equals the sum across projects');
test('total.dirty and total.unpushed equal the per-project sums', () => {
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
  assert.equal(r.total.dirty, sumDirty);
  assert.equal(r.total.unpushed, sumUnpushed);
  // c1 is clean → 'nova' is absent from the sparse map.
  assert.equal('nova' in r.perProject, false);
});

console.log('\nempty inputs are safe');
test('no chats → empty per-project, zero totals', () => {
  const r = sum([], { x: status(false, 5) });
  assert.deepEqual(r.perProject, {});
  assert.deepEqual(r.total, { dirty: 0, unpushed: 0, agents: [] });
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
