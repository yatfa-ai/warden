import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

/**
 * Tests for the in-progress-operation + conflict detection in /api/git-status
 * (WARDEN-186).
 *
 * Mirrors src/git-log.test.js's HOME-freezing isolation: src/server.js evaluates
 * `const cfg = load()` at module load, and load() reads config.js's module-level
 * `dir` (= path.join(os.homedir(), …)). So the FIRST import of server.js freezes
 * the home dir for the whole process — we set process.env.HOME (and write config
 * + catalog + repos) BEFORE that single import. Do NOT re-import server.js with a
 * second HOME.
 *
 * Covers the acceptance criteria for the LOCAL host:
 *   - clean repo          → inProgress.operation === null
 *   - repo mid-`git merge` → inProgress.operation === 'merge' + a conflicted file
 *                            flagged conflict:true; after `git merge --abort` the
 *                            operation clears to null
 *   - non-git / no-cwd    → inProgress.operation === null (200, NOT a 500)
 *   - unknown id          → 404
 *
 * The remote (SSH) path uses the same marker set via a combined `test` command;
 * its logic is covered indirectly by the shared marker list. Driving a real SSH
 * host in CI is out of scope.
 */

let httpServer;
let baseUrl;
let originalHome;
let tempHome;
let cleanRepo;
let mergeRepo;
let nonGitDir;
let detachedRepo;
let detachedShortSha;
let noUpstreamRepo;
let trackingRepo;
let bareRemote;
let buildInProgressScript;
let parseInProgressDetail;
let rebaseRepo;
let rebaseMsgnum;
let rebaseEnd;
let rebaseOntoShort;
let rebaseStoppedShort;
let mergeHeadShort;

function git(args, cwd) {
  const r = spawnSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'inherit'] });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed (status ${r.status}) in ${cwd}`);
  return r;
}

before(async () => {
  originalHome = process.env.HOME;
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-gitstatus-'));
  process.env.HOME = tempHome;

  // config.json with no SSH hosts
  const wardenDir = path.join(tempHome, '.yatfa-warden');
  fs.mkdirSync(wardenDir, { recursive: true });
  fs.writeFileSync(path.join(wardenDir, 'config.json'), JSON.stringify({ hosts: [] }));

  // ---- cleanRepo: one commit, nothing in progress ----
  cleanRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-gitstatus-clean-'));
  git(['init', '-q'], cleanRepo);
  git(['config', 'user.email', 'test@example.com'], cleanRepo);
  git(['config', 'user.name', 'Tester'], cleanRepo);
  fs.writeFileSync(path.join(cleanRepo, 'a.txt'), 'a\n');
  git(['add', '.'], cleanRepo);
  git(['commit', '-q', '-m', 'init'], cleanRepo);

  // ---- mergeRepo: left mid-conflict-merge (MERGE_HEAD present, f.txt in UU) ----
  // Pin the base branch name so the checkout-back step is deterministic (git's
  // default initial-branch name varies by config/version).
  mergeRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-gitstatus-merge-'));
  git(['init', '-q'], mergeRepo);
  git(['config', 'user.email', 'test@example.com'], mergeRepo);
  git(['config', 'user.name', 'Tester'], mergeRepo);
  git(['checkout', '-q', '-b', 'base'], mergeRepo);
  fs.writeFileSync(path.join(mergeRepo, 'f.txt'), 'base\n');
  git(['add', '.'], mergeRepo);
  git(['commit', '-q', '-m', 'base'], mergeRepo);
  // divergent branch: change f.txt
  git(['checkout', '-q', '-b', 'feature'], mergeRepo);
  fs.writeFileSync(path.join(mergeRepo, 'f.txt'), 'feature side\n');
  git(['commit', '-q', '-am', 'feature change'], mergeRepo);
  // back to base, change f.txt the OTHER way → guaranteed content conflict
  git(['checkout', '-q', 'base'], mergeRepo);
  fs.writeFileSync(path.join(mergeRepo, 'f.txt'), 'base side\n');
  git(['commit', '-q', '-am', 'base change'], mergeRepo);
  // merge → conflict. Exits non-zero (status 1) by design; MERGE_HEAD is written
  // and f.txt lands in the UU (both-modified) state. Run raw — our git() helper
  // throws on non-zero, but a conflict IS the success case here.
  const m = spawnSync('git', ['merge', '--no-edit', 'feature'], {
    cwd: mergeRepo, stdio: ['ignore', 'pipe', 'inherit'],
  });
  assert.notStrictEqual(m.status, 0, 'expected the merge to conflict (non-zero exit)');
  assert.ok(fs.existsSync(path.join(mergeRepo, '.git', 'MERGE_HEAD')), 'MERGE_HEAD must exist mid-merge');
  // WARDEN-511: capture the MERGE_HEAD short SHA so the merge-detail assertion
  // locks the exact value the badge must surface (not just "some sha").
  mergeHeadShort = fs.readFileSync(path.join(mergeRepo, '.git', 'MERGE_HEAD'), 'utf8').trim().slice(0, 7);

  // ---- rebaseRepo: left mid-conflicting INTERACTIVE rebase (rebase-merge dir
  // present, halted at step 1/3) so the badge can surface step N/M + onto +
  // stopped-sha (WARDEN-511). Only the merge backend (rebase-merge) carries the
  // step files, so we force it with `git rebase -i` + a no-op sequence editor;
  // the first replayed commit conflicts and halts the rebase. Built on explicit
  // branch names ('onto'/'topic') so it never depends on git's default initial
  // branch name (master/main) — mirroring mergeRepo's 'base' pin.
  rebaseRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-gitstatus-rebase-'));
  git(['init', '-q'], rebaseRepo);
  git(['config', 'user.email', 'test@example.com'], rebaseRepo);
  git(['config', 'user.name', 'Tester'], rebaseRepo);
  git(['checkout', '-q', '-b', 'onto'], rebaseRepo);
  fs.writeFileSync(path.join(rebaseRepo, 'f.txt'), 'root\n');
  git(['add', '.'], rebaseRepo);
  git(['commit', '-q', '-m', 'root'], rebaseRepo);
  // topic: 3 commits each rewriting f.txt (so end === 3); capture the FIRST as
  // the commit that will fail to apply (= stopped-sha at the halt).
  git(['checkout', '-q', '-b', 'topic'], rebaseRepo);
  fs.writeFileSync(path.join(rebaseRepo, 'f.txt'), 'topic-A\n');
  git(['add', '.'], rebaseRepo);
  git(['commit', '-q', '-m', 'topic-A'], rebaseRepo);
  const rebaseStoppedFull = git(['rev-parse', 'HEAD'], rebaseRepo).stdout.toString().trim();
  fs.writeFileSync(path.join(rebaseRepo, 'f.txt'), 'topic-B\n');
  git(['add', '.'], rebaseRepo);
  git(['commit', '-q', '-m', 'topic-B'], rebaseRepo);
  fs.writeFileSync(path.join(rebaseRepo, 'f.txt'), 'topic-C\n');
  git(['add', '.'], rebaseRepo);
  git(['commit', '-q', '-m', 'topic-C'], rebaseRepo);
  // onto branch diverges with a conflicting f.txt change.
  git(['checkout', '-q', 'onto'], rebaseRepo);
  fs.writeFileSync(path.join(rebaseRepo, 'f.txt'), 'onto-change\n');
  git(['add', '.'], rebaseRepo);
  git(['commit', '-q', '-m', 'onto-change'], rebaseRepo);
  git(['checkout', '-q', 'topic'], rebaseRepo);
  // Conflicting interactive rebase of topic onto 'onto'. GIT_SEQUENCE_EDITOR=true
  // accepts the todo as-is; topic-A (rewrite root→topic-A) conflicts with onto's
  // onto-change → the rebase halts at step 1/3. Exits non-zero by design; run
  // raw — our git() helper throws on non-zero, but the halt IS the success case
  // here (same discipline as the merge conflict above).
  const rb = spawnSync('git', ['rebase', '-i', 'onto'], {
    cwd: rebaseRepo, stdio: ['ignore', 'pipe', 'inherit'],
    env: { ...process.env, GIT_SEQUENCE_EDITOR: 'true', GIT_EDITOR: 'true' },
  });
  assert.notStrictEqual(rb.status, 0, 'expected the rebase to conflict (non-zero exit)');
  assert.ok(fs.existsSync(path.join(rebaseRepo, '.git', 'rebase-merge')), 'rebase-merge dir must exist mid-rebase');
  // Read the actual marker state git wrote so the integration assertions lock the
  // endpoint's echo of it (not a hardcoded guess at git's internal values).
  rebaseMsgnum = fs.readFileSync(path.join(rebaseRepo, '.git', 'rebase-merge', 'msgnum'), 'utf8').trim();
  rebaseEnd = fs.readFileSync(path.join(rebaseRepo, '.git', 'rebase-merge', 'end'), 'utf8').trim();
  rebaseOntoShort = fs.readFileSync(path.join(rebaseRepo, '.git', 'rebase-merge', 'onto'), 'utf8').trim().slice(0, 7);
  const stoppedFile = path.join(rebaseRepo, '.git', 'rebase-merge', 'stopped-sha');
  rebaseStoppedShort = (fs.existsSync(stoppedFile) ? fs.readFileSync(stoppedFile, 'utf8') : rebaseStoppedFull).trim().slice(0, 7);

  // ---- nonGitDir: a plain directory with no .git ----
  nonGitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-gitstatus-nongit-'));
  fs.writeFileSync(path.join(nonGitDir, 'readme.txt'), 'not a repo\n');

  // ---- detachedRepo: one commit, then `git checkout --detach` so HEAD is not
  // on any branch — the state an agent lands in after `git checkout <sha>`. The
  // badge must surface this distinctly (detached:true + a short SHA) instead of
  // the misleading literal "HEAD" label (WARDEN-239).
  detachedRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-gitstatus-detached-'));
  git(['init', '-q'], detachedRepo);
  git(['config', 'user.email', 'test@example.com'], detachedRepo);
  git(['config', 'user.name', 'Tester'], detachedRepo);
  fs.writeFileSync(path.join(detachedRepo, 'd.txt'), 'd\n');
  git(['add', '.'], detachedRepo);
  git(['commit', '-q', '-m', 'init'], detachedRepo);
  const detachedSha = git(['rev-parse', 'HEAD'], detachedRepo).stdout.toString().trim();
  git(['checkout', '-q', '--detach', detachedSha], detachedRepo);
  // Sanity: HEAD must genuinely be detached (symbolic-ref non-zero). The git()
  // helper throws on non-zero, so probe with a raw spawnSync.
  const symProbe = spawnSync('git', ['symbolic-ref', '-q', 'HEAD'], {
    cwd: detachedRepo, stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.notStrictEqual(symProbe.status, 0, 'detachedRepo HEAD must be detached');
  detachedShortSha = git(['rev-parse', '--short', 'HEAD'], detachedRepo).stdout.toString().trim();
  assert.ok(detachedShortSha, 'expected a short SHA for the detached repo');

  // ---- noUpstreamRepo: a named branch with NO upstream (never `push -u`'d) —
  // the exact gap WARDEN-243 closes. ahead/behind are null (no @{u}), and
  // without the `upstream` field this branch would render as a bare cyan label
  // indistinguishable from a synced 0/0 branch. `git checkout -b feature` with
  // NO `-u` and NO push leaves 'feature' untracked.
  noUpstreamRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-gitstatus-noupstream-'));
  git(['init', '-q'], noUpstreamRepo);
  git(['config', 'user.email', 'test@example.com'], noUpstreamRepo);
  git(['config', 'user.name', 'Tester'], noUpstreamRepo);
  fs.writeFileSync(path.join(noUpstreamRepo, 'n.txt'), 'n\n');
  git(['add', '.'], noUpstreamRepo);
  git(['commit', '-q', '-m', 'init'], noUpstreamRepo);
  git(['checkout', '-q', '-b', 'feature'], noUpstreamRepo); // NO -u, NO push
  // Sanity: @{u} must genuinely be unset (rev-parse non-zero). The git() helper
  // throws on non-zero, so probe with a raw spawnSync.
  const noUpProbe = spawnSync('git', ['rev-parse', '--abbrev-ref', '@{u}'], {
    cwd: noUpstreamRepo, stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.notStrictEqual(noUpProbe.status, 0, 'noUpstreamRepo must have no upstream');

  // ---- trackingRepo: a named branch WITH an upstream (a bare remote + `git
  // push -u origin feature`) so 'feature' tracks origin/feature — the control
  // case proving a synced 0/0 branch reports the short upstream name (and is
  // NOT misread as no-upstream).
  trackingRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-gitstatus-tracking-'));
  git(['init', '-q'], trackingRepo);
  git(['config', 'user.email', 'test@example.com'], trackingRepo);
  git(['config', 'user.name', 'Tester'], trackingRepo);
  fs.writeFileSync(path.join(trackingRepo, 't.txt'), 't\n');
  git(['add', '.'], trackingRepo);
  git(['commit', '-q', '-m', 'init'], trackingRepo);
  git(['checkout', '-q', '-b', 'feature'], trackingRepo);
  bareRemote = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-gitstatus-remote-'));
  git(['init', '--bare', '-q', bareRemote], bareRemote);
  git(['remote', 'add', 'origin', bareRemote], trackingRepo);
  git(['push', '-q', '-u', 'origin', 'feature'], trackingRepo);
  // Sanity: @{u} must resolve to origin/feature.
  assert.strictEqual(
    git(['rev-parse', '--abbrev-ref', '@{u}'], trackingRepo).stdout.toString().trim(),
    'origin/feature',
    'trackingRepo feature must track origin/feature',
  );

  // Catalog with LOCAL manual chats, resolved by bare session id (no ':'
  // prefix) so no host/tmux discovery runs.
  fs.writeFileSync(
    path.join(wardenDir, 'chats.json'),
    JSON.stringify([
      { host: '(local)', session: 'warden-clean', cwd: cleanRepo, cmd: 'bash', name: 'warden-clean' },
      { host: '(local)', session: 'warden-merge', cwd: mergeRepo, cmd: 'bash', name: 'warden-merge' },
      { host: '(local)', session: 'warden-rebase', cwd: rebaseRepo, cmd: 'bash', name: 'warden-rebase' },
      { host: '(local)', session: 'warden-nongit', cwd: nonGitDir, cmd: 'bash', name: 'warden-nongit' },
      { host: '(local)', session: 'warden-detached', cwd: detachedRepo, cmd: 'bash', name: 'warden-detached' },
      { host: '(local)', session: 'warden-noupstream', cwd: noUpstreamRepo, cmd: 'bash', name: 'warden-noupstream' },
      { host: '(local)', session: 'warden-tracking', cwd: trackingRepo, cmd: 'bash', name: 'warden-tracking' },
    ]),
  );

  // Import server.js ONCE — after HOME/config/catalog/repos are in place.
  const server = await import('./server.js');
  buildInProgressScript = server.buildInProgressScript;
  parseInProgressDetail = server.parseInProgressDetail;
  httpServer = server.app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    httpServer.once('listening', resolve);
    httpServer.once('error', reject);
  });
  baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
});

after(async () => {
  if (httpServer) await new Promise((r) => httpServer.close(r));
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  for (const d of [cleanRepo, mergeRepo, rebaseRepo, nonGitDir, detachedRepo, noUpstreamRepo, trackingRepo, bareRemote, tempHome]) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

describe('/api/git-status in-progress + conflict detection (real Express app)', () => {
  it('returns inProgress.operation null for a clean repo', async () => {
    const res = await fetch(`${baseUrl}/api/git-status?id=warden-clean`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.error, null);
    assert.ok(body.branch, 'clean repo must report a branch');
    assert.strictEqual(body.clean, true);
    assert.ok(body.inProgress, 'response must include inProgress');
    assert.strictEqual(body.inProgress.operation, null);
    assert.strictEqual(body.inProgress.detail, null);
    // No regression: a normal branch is NOT detached and reports no short SHA.
    assert.strictEqual(body.detached, false);
    assert.strictEqual(body.headSha, null);
  });

  it('detects an in-progress merge and flags the conflicted file', async () => {
    const res = await fetch(`${baseUrl}/api/git-status?id=warden-merge`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.error, null);
    // The headline assertion: a blocked agent is visible without opening the chat.
    assert.strictEqual(body.inProgress.operation, 'merge');
    // WARDEN-511: the MERGE_HEAD short SHA must surface in the detail so a human
    // can see WHICH commit is being merged without opening the chat.
    assert.strictEqual(body.inProgress.detail, mergeHeadShort, 'detail must be the short MERGE_HEAD sha');
    assert.strictEqual(body.clean, false);
    // The conflicted path (UU) must be tagged conflict:true — not the gray fallback.
    const conflicted = (body.files || []).filter((f) => f.conflict);
    assert.ok(conflicted.length >= 1, 'expected at least one conflict:true file');
    assert.ok(conflicted.some((f) => f.path === 'f.txt'), 'f.txt should be the conflicted path');
  });

  it('surfaces rebase step N/M + onto + stopped-sha for a repo halted mid-rebase', async () => {
    const res = await fetch(`${baseUrl}/api/git-status?id=warden-rebase`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.error, null);
    // WARDEN-511 headline: WHERE the rebase halted, not just that one is in
    // progress. step, onto, and the stopped commit must all surface in detail.
    assert.strictEqual(body.inProgress.operation, 'rebase');
    assert.ok(body.inProgress.detail, 'a halted rebase must carry progress detail');
    assert.ok(body.inProgress.detail.includes(`${rebaseMsgnum}/${rebaseEnd}`),
      `detail "${body.inProgress.detail}" must include step ${rebaseMsgnum}/${rebaseEnd}`);
    assert.ok(body.inProgress.detail.includes(`onto ${rebaseOntoShort}`),
      `detail "${body.inProgress.detail}" must include the onto short sha`);
    assert.ok(body.inProgress.detail.includes(`stopped at ${rebaseStoppedShort}`),
      `detail "${body.inProgress.detail}" must include the stopped-at short sha`);
  });

  it('clears the operation after `git merge --abort`', async () => {
    // Abort the merge (mutates mergeRepo) then re-query — must read clean/null.
    git(['merge', '--abort'], mergeRepo);
    const body = await (await fetch(`${baseUrl}/api/git-status?id=warden-merge`)).json();
    assert.strictEqual(body.inProgress.operation, null);
    assert.strictEqual(body.inProgress.detail, null);
  });

  it('returns inProgress.operation null (200, not 500) for a non-git cwd', async () => {
    const res = await fetch(`${baseUrl}/api/git-status?id=warden-nongit`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.branch, null);
    assert.strictEqual(body.inProgress.operation, null);
    assert.strictEqual(body.inProgress.detail, null);
    // A non-git cwd must NOT be misread as detached (symbolic-ref fails here too,
    // but the inGitRepo guard — branch truthy — keeps it false).
    assert.strictEqual(body.detached, false);
    assert.strictEqual(body.headSha, null);
  });

  it('returns 404 for an unknown chat id', async () => {
    const res = await fetch(`${baseUrl}/api/git-status?id=does-not-exist`);
    assert.strictEqual(res.status, 404);
  });
});

describe('/api/git-status detached-HEAD detection (real Express app)', () => {
  // Covers WARDEN-239 acceptance criteria for the LOCAL spawnSync path:
  //   - a detached repo → detached:true + a visible short SHA (NOT the literal
  //     "HEAD" string and NOT silent on ahead/behind)
  //   - the branch ? gate is kept so uncommitted files still surface on detached
  // The remote (SSH) path uses the same symbolic-ref test via a chained command;
  // driving a real SSH host in CI is out of scope.

  it('reports detached:true with a short SHA for a detached-HEAD repo', async () => {
    const res = await fetch(`${baseUrl}/api/git-status?id=warden-detached`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.error, null);
    // The headline assertions: the state is surfaced distinctly.
    assert.strictEqual(body.detached, true);
    assert.ok(body.headSha, 'a detached repo must report a short SHA');
    assert.strictEqual(body.headSha, detachedShortSha, 'headSha must equal git rev-parse --short HEAD');
    // The short SHA is what the badge shows INSTEAD of the misleading "HEAD".
    assert.notStrictEqual(body.headSha, 'HEAD');
  });

  it('keeps the branch gate so files/clean/inProgress still surface on detached', async () => {
    // A detached HEAD can still have uncommitted changes / an in-progress op —
    // the branch ? gate must NOT null them out just because we're detached.
    const body = await (await fetch(`${baseUrl}/api/git-status?id=warden-detached`)).json();
    assert.strictEqual(body.detached, true);
    assert.strictEqual(body.clean, true);          // gate passes (truthy branch)
    assert.strictEqual(body.inProgress.operation, null);
    assert.strictEqual(body.inProgress.detail, null);
    assert.ok(body.files !== null, 'files must still surface (not nulled) on detached');
    // ahead/behind are null on detached (no @{u}) — by design.
    assert.strictEqual(body.ahead, null);
    assert.strictEqual(body.behind, null);
  });

  it('flags a detached repo with uncommitted changes as not-clean', async () => {
    // Mutate the detached repo, then re-query: detached stays true AND the
    // uncommitted file surfaces (clean:false) through the kept branch gate.
    fs.writeFileSync(path.join(detachedRepo, 'd.txt'), 'changed\n');
    const body = await (await fetch(`${baseUrl}/api/git-status?id=warden-detached`)).json();
    assert.strictEqual(body.detached, true);
    assert.strictEqual(body.clean, false);
    assert.ok((body.files || []).some((f) => f.path === 'd.txt'), 'd.txt must surface as a changed file');
    // Restore so sibling tests aren't affected.
    git(['checkout', '-q', '--', 'd.txt'], detachedRepo);
  });
});

describe('/api/git-status upstream tracking (real Express app)', () => {
  // Covers WARDEN-243 acceptance criteria for the LOCAL spawnSync path:
  //   - a named branch with NO upstream (never `push -u`'d) → upstream === null
  //     — distinct from a synced 0/0 branch, which HAS an upstream. ahead/behind
  //     are null in BOTH cases, so `upstream` is the only signal that separates
  //     "local-only, not backed up" from "in sync".
  //   - a named branch WITH upstream → upstream === 'origin/feature'.
  //   - the branch ? gate keeps non-git / detached HEAD at upstream === null.
  // The remote (SSH) path uses the same `git rev-parse --abbrev-ref @{u}` via
  // runGit; driving a real SSH host in CI is out of scope.

  it('reports upstream null for a named branch with no upstream (never push -u)', async () => {
    const res = await fetch(`${baseUrl}/api/git-status?id=warden-noupstream`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.error, null);
    assert.strictEqual(body.branch, 'feature');
    // The headline assertion: no upstream → null (NOT undefined, NOT a string).
    assert.strictEqual(body.upstream, null);
    // ahead/behind are null too (no @{u}) — the exact collision that makes
    // `upstream` necessary: without it this branch is indistinguishable from a
    // synced 0/0 branch.
    assert.strictEqual(body.ahead, null);
    assert.strictEqual(body.behind, null);
    // A normal named branch is NOT detached.
    assert.strictEqual(body.detached, false);
  });

  it('reports upstream "origin/feature" for a tracking branch (push -u)', async () => {
    const res = await fetch(`${baseUrl}/api/git-status?id=warden-tracking`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.error, null);
    assert.strictEqual(body.branch, 'feature');
    // The headline assertion: the short upstream name is surfaced (NOT null).
    assert.strictEqual(body.upstream, 'origin/feature');
    // A tracking branch with nothing to push/pull → 0/0 (NOT null) — proving
    // this is the "synced" state a non-tracking branch must NOT be confused with.
    assert.strictEqual(body.ahead, 0);
    assert.strictEqual(body.behind, 0);
    assert.strictEqual(body.detached, false);
  });

  it('keeps the branch gate so a non-git cwd reports upstream null', async () => {
    const body = await (await fetch(`${baseUrl}/api/git-status?id=warden-nongit`)).json();
    assert.strictEqual(body.branch, null);
    // The catch-fallback / no-cwd / non-git shape always carries upstream:null
    // so the response contract is consistent (no undefined leaking to the UI).
    assert.strictEqual(body.upstream, null);
  });

  it('keeps the branch gate so a detached HEAD reports upstream null', async () => {
    // A detached HEAD has no @{u} by definition → upstream null. This slice
    // gates its marker on `branch !== 'HEAD'`, leaving detached rendering to
    // WARDEN-239; the two states stay disjoint regardless.
    const body = await (await fetch(`${baseUrl}/api/git-status?id=warden-detached`)).json();
    assert.strictEqual(body.detached, true);
    assert.strictEqual(body.upstream, null);
  });
});

// buildInProgressScript builds the shell `test` that detects an in-progress git
// operation (WARDEN-235). It is the unit-testable seam for the marker detection
// on transports whose git dir is off the host fs (yatfa containers, remote
// hosts) — detectInProgress delivers it via runInContext. The exact marker set
// + priority order + cwd quoting are what we lock here (a regression in any
// silently flips an in-progress op to null).
describe('buildInProgressScript', () => {
  it('cd’s into the cwd and resolves the git dir before testing markers', () => {
    const s = buildInProgressScript('/workspace');
    assert.ok(s.startsWith("cd '/workspace'"), 'must cd into the cwd: ' + s);
    assert.ok(s.includes('gd=$(git rev-parse --git-dir'), 'must resolve the git dir');
  });

  it('tests all five marker groups in priority order (merge > cherry-pick > revert > rebase > bisect)', () => {
    const s = buildInProgressScript('/w');
    const merge = s.indexOf('MERGE_HEAD');
    const cherry = s.indexOf('CHERRY_PICK_HEAD');
    const revert = s.indexOf('REVERT_HEAD');
    const rebase = s.indexOf('rebase-merge');
    const bisect = s.indexOf('BISECT_LOG');
    assert.ok(merge > -1 && cherry > -1 && revert > -1 && rebase > -1 && bisect > -1, 'all markers present');
    assert.ok(merge < cherry, 'merge must be tested before cherry-pick');
    assert.ok(cherry < revert, 'cherry-pick before revert');
    assert.ok(revert < rebase, 'revert before rebase');
    assert.ok(rebase < bisect, 'rebase before bisect');
  });

  it('echoes each op as a pipe-delimited op|detail record (rebase-apply + bisect stay bare)', () => {
    const s = buildInProgressScript('/w');
    // WARDEN-511: the SHA ops carry their marker-file contents after the op,
    // pipe-delimited, so detectInProgress parses operation + detail in one pass.
    assert.ok(s.includes('echo "merge|$(cat "$gd/MERGE_HEAD"'), 'merge must emit a merge|<sha> record');
    assert.ok(s.includes('echo "cherry-pick|$(cat "$gd/CHERRY_PICK_HEAD"'), 'cherry-pick must emit a delimited record');
    assert.ok(s.includes('echo "revert|$(cat "$gd/REVERT_HEAD"'), 'revert must emit a delimited record');
    // rebase-merge carries step N/M + onto + stopped-sha (all four step files).
    assert.ok(s.includes('echo "rebase|$(cat "$gd/rebase-merge/msgnum"'), 'rebase-merge must open with msgnum');
    for (const f of ['msgnum', 'end', 'onto', 'stopped-sha']) {
      assert.ok(s.includes(`rebase-merge/${f}`), `rebase-merge step file ${f} must be read`);
    }
    // rebase-apply (no step files) and bisect (no detail) emit a BARE operation
    // name — no pipe — so they degrade to detail: null, not a misleading "0/0".
    assert.ok(s.includes('] && echo rebase;'), 'rebase-apply must emit bare rebase (no detail)');
    assert.ok(s.includes('] && echo bisect;'), 'bisect must emit a bare operation (no detail)');
  });

  it('shellQuotes a cwd containing spaces/quotes (no shell injection)', () => {
    // A cwd with a space and a single-quote must be single-quote-escaped, not
    // spliced raw — otherwise the `cd` / `git rev-parse` would break or inject.
    const s = buildInProgressScript("/path with space and a 'quote");
    assert.ok(s.includes("'cd'") === false, 'raw unquoted tokens must not appear');
    // shellQuote wraps in single quotes and escapes embedded quotes via '\''.
    assert.ok(s.includes("'/path with space and a '\\''quote'"), 'cwd must be POSIX single-quoted: ' + s);
  });
});

// parseInProgressDetail parses ONE in-progress-operation record (the line
// buildInProgressScript echoes, or the identical record detectInProgress's
// host-fs path builds from readMarker) into { operation, detail } (WARDEN-511).
// It is the shared, unit-testable seam both detection paths feed, so its output
// for a given on-disk state is transport-independent. Each operation's detail
// shape, the null/absent → null degradation, the short-SHA normalization, the
// rebase-apply (step-less) graceful-null, and the subset rendering (only the
// marker files git actually wrote) are all locked here.
describe('parseInProgressDetail', () => {
  it('returns { operation: null, detail: null } for a blank record', () => {
    assert.deepEqual(parseInProgressDetail(''), { operation: null, detail: null });
    assert.deepEqual(parseInProgressDetail('   '), { operation: null, detail: null });
    assert.deepEqual(parseInProgressDetail(null), { operation: null, detail: null });
    assert.deepEqual(parseInProgressDetail(undefined), { operation: null, detail: null });
  });

  it('shortens the *_HEAD SHA for merge / cherry-pick / revert', () => {
    // Full 40-char SHA → 7-char display form (mirrors rev-parse --short).
    assert.deepEqual(parseInProgressDetail('merge|abc1234deadbeef0000000000000000000000000'), { operation: 'merge', detail: 'abc1234' });
    assert.deepEqual(parseInProgressDetail('cherry-pick|abcdef1234567890abcdef1234567890abcdef12'), { operation: 'cherry-pick', detail: 'abcdef1' });
    assert.deepEqual(parseInProgressDetail('revert|9876543210fedcba000000000000000000000000'), { operation: 'revert', detail: '9876543' });
  });

  it('nulls the detail when the *_HEAD SHA is empty', () => {
    // MERGE_HEAD present but empty/unreadable → operation still reported, no sha.
    assert.deepEqual(parseInProgressDetail('merge|'), { operation: 'merge', detail: null });
    assert.deepEqual(parseInProgressDetail('cherry-pick|'), { operation: 'cherry-pick', detail: null });
  });

  it('renders rebase step N/M + onto + stopped-sha from a full record', () => {
    assert.deepEqual(
      parseInProgressDetail('rebase|3|7|2b755b9e4ffa005ec9053c0c3d2b79cee3c8952a|c5766c442b36017b177359ad639752ab079f0fe4'),
      { operation: 'rebase', detail: '3/7 · onto 2b755b9 · stopped at c5766c4' },
    );
  });

  it('renders only the subset of step files git actually wrote', () => {
    // step present, onto/stopped absent.
    assert.deepEqual(parseInProgressDetail('rebase|1|3||'), { operation: 'rebase', detail: '1/3' });
    // only stopped-sha present (step nums + onto absent).
    assert.deepEqual(
      parseInProgressDetail('rebase||||c5766c442b36017b177359ad639752ab079f0fe4'),
      { operation: 'rebase', detail: 'stopped at c5766c4' },
    );
  });

  it('shows onto verbatim when it is NOT a hex object name (defensive)', () => {
    // git's onto marker always holds a SHA in practice; if it ever held a ref
    // name it must be shown as-is, never mis-truncated to 7 chars.
    assert.deepEqual(
      parseInProgressDetail('rebase|1|3|origin/main|c5766c442b36017b177359ad639752ab079f0fe4'),
      { operation: 'rebase', detail: '1/3 · onto origin/main · stopped at c5766c4' },
    );
  });

  it('nulls the detail for a bare rebase (rebase-apply: no step files)', () => {
    // The older rebase backend carries no step files → graceful null, NOT a
    // misleading "step 0/0". operation is still reported.
    assert.deepEqual(parseInProgressDetail('rebase'), { operation: 'rebase', detail: null });
    assert.deepEqual(parseInProgressDetail('rebase||||'), { operation: 'rebase', detail: null });
  });

  it('nulls the detail for bisect (no progress info to surface)', () => {
    assert.deepEqual(parseInProgressDetail('bisect'), { operation: 'bisect', detail: null });
  });
});
