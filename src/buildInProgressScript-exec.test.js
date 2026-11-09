// Executes buildInProgressScript (src/git.js) under a real `sh` against real
// halted git repos. This is the script the container/remote arm of
// detectInProgress (src/gitRoutes.js) runs; git-status.test.js only asserts it
// as text. Expected details are read FROM the marker files git wrote, and each
// fixture sanity-asserts its marker so a git-version change fails at setup.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { buildInProgressScript } from './git.js';
import { parseInProgressDetail } from './gitRoutes.js';

const tmpRoots = [];

function git(args, cwd) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed (${r.status}): ${r.stderr}`);
  return r.stdout.trim();
}

function gitHalts(args, cwd, why) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_EDITOR: 'true' } });
  assert.notStrictEqual(r.status, 0, why);
}

function mkRepo(label, dirName) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `warden-ipscript-${label}-`));
  tmpRoots.push(root);
  const dir = dirName ? path.join(root, dirName) : root;
  fs.mkdirSync(dir, { recursive: true });
  git(['init', '-q', '-b', 'main'], dir);
  git(['config', 'user.email', 'test@example.com'], dir);
  git(['config', 'user.name', 'Tester'], dir);
  return dir;
}

function commitFile(dir, content, msg) {
  fs.writeFileSync(path.join(dir, 'f.txt'), content);
  git(['add', '.'], dir);
  git(['commit', '-q', '-m', msg], dir);
  return git(['rev-parse', 'HEAD'], dir);
}

function divergedRepo(label, dirName) {
  const dir = mkRepo(label, dirName);
  commitFile(dir, 'root\n', 'root');
  git(['checkout', '-q', '-b', 'feature'], dir);
  const featureSha = commitFile(dir, 'feature side\n', 'feature change');
  git(['checkout', '-q', 'main'], dir);
  commitFile(dir, 'main side\n', 'main change');
  return { dir, featureSha };
}

// Mirrors detectInProgress: first non-empty stdout line feeds parseInProgressDetail.
function runScript(cwd) {
  const r = spawnSync('sh', ['-c', buildInProgressScript(cwd)], { encoding: 'utf8' });
  const lines = r.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  return { lines, parsed: parseInProgressDetail(lines[0] || '') };
}

const short = (s) => s.trim().slice(0, 7);
const NONE = { operation: null, detail: null };

let merge, cherry, revert, rebaseMerge, rebaseApply, bisect;

before(() => {
  merge = divergedRepo('merge');
  gitHalts(['merge', 'feature'], merge.dir, 'expected the merge to conflict');
  assert.ok(fs.existsSync(path.join(merge.dir, '.git', 'MERGE_HEAD')));

  cherry = divergedRepo('cherry');
  gitHalts(['cherry-pick', cherry.featureSha], cherry.dir, 'expected the cherry-pick to conflict');
  assert.ok(fs.existsSync(path.join(cherry.dir, '.git', 'CHERRY_PICK_HEAD')));

  revert = mkRepo('revert');
  commitFile(revert, 'one\n', 'one');
  const middle = commitFile(revert, 'two\n', 'two');
  commitFile(revert, 'three\n', 'three');
  gitHalts(['revert', '--no-edit', middle], revert, 'expected the revert to conflict');
  assert.ok(fs.existsSync(path.join(revert, '.git', 'REVERT_HEAD')));

  rebaseMerge = divergedRepo('rebasemerge');
  git(['checkout', '-q', 'feature'], rebaseMerge.dir);
  gitHalts(['rebase', '--merge', 'main'], rebaseMerge.dir, 'expected the rebase to conflict');
  assert.ok(fs.existsSync(path.join(rebaseMerge.dir, '.git', 'rebase-merge', 'msgnum')));

  rebaseApply = divergedRepo('rebaseapply');
  git(['checkout', '-q', 'feature'], rebaseApply.dir);
  gitHalts(['rebase', '--apply', 'main'], rebaseApply.dir, 'expected the rebase to conflict');
  assert.ok(fs.existsSync(path.join(rebaseApply.dir, '.git', 'rebase-apply')));

  bisect = mkRepo('bisect');
  commitFile(bisect, 'one\n', 'one');
  commitFile(bisect, 'two\n', 'two');
  git(['bisect', 'start'], bisect);
  assert.ok(fs.existsSync(path.join(bisect, '.git', 'BISECT_LOG')));
});

after(() => {
  for (const r of tmpRoots) fs.rmSync(r, { recursive: true, force: true });
});

describe('buildInProgressScript executed in a real shell', () => {
  it('merge: emits merge + short MERGE_HEAD', () => {
    const head = fs.readFileSync(path.join(merge.dir, '.git', 'MERGE_HEAD'), 'utf8');
    assert.deepStrictEqual(runScript(merge.dir).parsed, { operation: 'merge', detail: short(head) });
  });

  it('cherry-pick: emits cherry-pick + short CHERRY_PICK_HEAD', () => {
    assert.deepStrictEqual(runScript(cherry.dir).parsed, { operation: 'cherry-pick', detail: short(cherry.featureSha) });
  });

  it('revert: emits revert + short REVERT_HEAD', () => {
    const head = fs.readFileSync(path.join(revert, '.git', 'REVERT_HEAD'), 'utf8');
    assert.deepStrictEqual(runScript(revert).parsed, { operation: 'revert', detail: short(head) });
  });

  it('rebase --merge: step N/M, onto and stopped-at read from rebase-merge files', () => {
    const rm = path.join(rebaseMerge.dir, '.git', 'rebase-merge');
    const rd = (f) => fs.readFileSync(path.join(rm, f), 'utf8').trim();
    assert.deepStrictEqual(runScript(rebaseMerge.dir).parsed, {
      operation: 'rebase',
      detail: `${rd('msgnum')}/${rd('end')} · onto ${short(rd('onto'))} · stopped at ${short(rd('stopped-sha'))}`,
    });
  });

  it('rebase --apply: first line is exactly `rebase`, detail null', () => {
    const { lines, parsed } = runScript(rebaseApply.dir);
    assert.strictEqual(lines[0], 'rebase');
    assert.deepStrictEqual(parsed, { operation: 'rebase', detail: null });
  });

  it('bisect: first line is exactly `bisect`, detail null', () => {
    const { lines, parsed } = runScript(bisect);
    assert.strictEqual(lines[0], 'bisect');
    assert.deepStrictEqual(parsed, { operation: 'bisect', detail: null });
  });

  it('precedence: merge leads when a BISECT_LOG coexists', () => {
    const f = path.join(merge.dir, '.git', 'BISECT_LOG');
    fs.writeFileSync(f, '');
    try {
      const { lines, parsed } = runScript(merge.dir);
      assert.deepStrictEqual(lines.map((l) => l.split('|')[0]), ['merge', 'bisect']);
      assert.strictEqual(parsed.operation, 'merge');
    } finally {
      fs.rmSync(f, { force: true });
    }
  });

  it('a subdirectory cwd resolves the git dir', () => {
    const sub = path.join(cherry.dir, 'sub');
    fs.mkdirSync(sub, { recursive: true });
    assert.deepStrictEqual(runScript(sub).parsed, { operation: 'cherry-pick', detail: short(cherry.featureSha) });
  });

  it('a clean repo and a non-git cwd print nothing', () => {
    const clean = mkRepo('clean');
    commitFile(clean, 'x\n', 'x');
    assert.deepStrictEqual(runScript(clean), { lines: [], parsed: NONE });
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-ipscript-plain-'));
    tmpRoots.push(plain);
    assert.deepStrictEqual(runScript(plain), { lines: [], parsed: NONE });
  });

  it("a cwd containing a space and a single quote is handled", () => {
    const { dir, featureSha } = divergedRepo('quote', "my repo's dir");
    gitHalts(['cherry-pick', featureSha], dir, 'expected the cherry-pick to conflict');
    assert.deepStrictEqual(runScript(dir).parsed, { operation: 'cherry-pick', detail: short(featureSha) });
  });
});
