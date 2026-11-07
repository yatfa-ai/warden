import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { searchLocalRawResult, parseSearchOutput } from './workspaceSearch.js';

// searchLocalRawResult's NON-REPO leg: when cwd is not a git worktree it probes
// `rg --version` (hasBinary, ENOENT = absent) and picks ripgrep, else plain grep.
// search-files.test.js drives only the git-grep leg of this function (every tmp
// dir there is `git init`-ed) and exercises the rg/grep fallback only through the
// REMOTE buildSearchScript bash twin. PATH is swapped per test to a dir holding
// symlinks to the real git/grep plus optional fake `rg`/`grep` recorders, so the
// tool choice is observable without depending on what the machine has installed.

const which = (bin) => {
  const r = spawnSync('sh', ['-c', `command -v ${bin}`], { encoding: 'utf8' });
  return r.stdout.trim();
};
const REAL_GIT = which('git');
const REAL_GREP = which('grep');

describe('searchLocalRawResult non-repo fallback (rg → grep)', { skip: process.platform === 'win32' }, () => {
  let bin, plain, repo, savedPath, log;

  const writeTool = (name, body) => {
    const p = path.join(bin, name);
    fs.writeFileSync(p, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  };
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : []);

  beforeEach(() => {
    bin = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-nr-bin-'));
    plain = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-nr-plain-'));
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-nr-repo-'));
    log = path.join(bin, 'calls.log');
    fs.symlinkSync(REAL_GIT, path.join(bin, 'git'));
    fs.writeFileSync(path.join(plain, 'x.txt'), 'first\nthe needle is here\n');
    fs.writeFileSync(path.join(plain, 'axb.txt'), 'axb only\n');
    fs.writeFileSync(path.join(plain, 'pic.bin'), Buffer.from('needle\x00binary\n'));
    spawnSync(REAL_GIT, ['-c', 'init.defaultBranch=main', 'init', '-q', repo]);
    fs.writeFileSync(path.join(repo, 'r.txt'), 'needle in repo\n');
    spawnSync(REAL_GIT, ['-C', repo, 'add', 'r.txt']);
    savedPath = process.env.PATH;
    process.env.PATH = bin;
  });
  afterEach(() => {
    process.env.PATH = savedPath;
    for (const d of [bin, plain, repo]) fs.rmSync(d, { recursive: true, force: true });
  });

  it('uses rg (not grep) when rg is on PATH: exact argv, cwd, and its stdout is returned', async () => {
    writeTool('rg', `[ "$1" = "--version" ] && exit 0\necho "rg $PWD $*" >> ${log}\necho "./x.txt:2:via-rg"`);
    writeTool('grep', `echo "grep $*" >> ${log}; exit 0`);
    const r = await searchLocalRawResult(plain, 'needle');
    assert.equal(r.failed, false);
    assert.equal(r.raw, './x.txt:2:via-rg');
    assert.deepEqual(calls(), [`rg ${fs.realpathSync(plain)} --line-number --no-heading -F -- needle .`]);
  });

  it('falls back to plain grep when rg is absent (ENOENT probe): finds text, treats the query literally', async () => {
    fs.symlinkSync(REAL_GREP, path.join(bin, 'grep'));
    const r = await searchLocalRawResult(plain, 'needle');
    assert.equal(r.failed, false);
    const files = parseSearchOutput(r.raw).map((p) => p.file);
    assert.deepEqual(files, ['./x.txt']);
    assert.equal(r.raw, './x.txt:2:the needle is here', 'only the text hit comes back (pic.bin never surfaces as a result line)');
    const lit = await searchLocalRawResult(plain, 'a.b');
    assert.equal(lit.raw, '', '-F: "." must not match "x"');
    assert.equal(lit.failed, false);
  });

  it('rg no-match (exit 1) is a clean empty result — it does NOT fall through to grep', async () => {
    writeTool('rg', `[ "$1" = "--version" ] && exit 0\nexit 1`);
    writeTool('grep', `echo "grep $*" >> ${log}; echo "./x.txt:2:via-grep"`);
    const r = await searchLocalRawResult(plain, 'needle');
    assert.deepEqual({ raw: r.raw, failed: r.failed }, { raw: '', failed: false });
    assert.deepEqual(calls(), []);
  });

  it('rg that fails with zero lines (exit 2) surfaces failed:true reason "exit 2"', async () => {
    writeTool('rg', `[ "$1" = "--version" ] && exit 0\nexit 2`);
    const r = await searchLocalRawResult(plain, 'needle');
    assert.equal(r.failed, true);
    assert.equal(r.reason, 'exit 2');
    assert.equal(r.raw, '');
  });

  it('an rg whose --version probe exits non-zero is still "present" (only ENOENT means absent)', async () => {
    writeTool('rg', `[ "$1" = "--version" ] && exit 3\necho "./x.txt:2:via-rg"`);
    writeTool('grep', `echo "grep $*" >> ${log}; exit 0`);
    const r = await searchLocalRawResult(plain, 'needle');
    assert.equal(r.raw, './x.txt:2:via-rg');
    assert.deepEqual(calls(), []);
  });

  it('never probes or runs rg/grep when cwd IS a git worktree (git grep wins)', async () => {
    writeTool('rg', `echo "rg $*" >> ${log}`);
    writeTool('grep', `echo "grep $*" >> ${log}`);
    const r = await searchLocalRawResult(repo, 'needle');
    assert.equal(r.failed, false);
    assert.deepEqual(parseSearchOutput(r.raw).map((p) => p.file), ['r.txt']);
    assert.deepEqual(calls(), []);
  });
});
