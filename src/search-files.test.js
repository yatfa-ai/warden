import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Regression tests for /api/search-files (WARDEN-145), parallel to
// read-file.test.js. The `query` is user input that runs in a remote shell, so
// the security must-haves are: shellQuote (no command injection), `--` before
// the pattern (no option injection), cwd scoping, and a bounded result set.
// These tests pin all of that plus the parser's correctness.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(__dirname, 'server.js');

// Redirect HOME so importing server.js (which reads config/catalog and rotates
// activity logs at module load) touches only a temp dir, never the real
// ~/.yatfa-warden. Top-level await lets us import AFTER setting HOME.
process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-sf-home-'));
const { buildSearchScript, parseSearchOutput } = await import('./server.js');

// --- Syntax guard: server.js MUST compile ---------------------------------
// Mirrors read-file.test.js: `node --check` parses without executing, a clean
// regression guard for any template-literal interpolation slip in buildSearchScript.
describe('server.js compiles', () => {
  it('passes node --check', () => {
    const r = spawnSync(process.execPath, ['--check', SERVER], { encoding: 'utf8' });
    assert.equal(r.status, 0, `server.js failed to parse:\n${r.stderr}`);
  });
});

describe('buildSearchScript (remote SSH script) — security must-haves', () => {
  it('shellQuotes the query (single-quoted, no double-wrap)', () => {
    const script = buildSearchScript('/a/b', 'needle');
    // shellQuote yields 'needle'; it must be spliced in bare, NOT wrapped again.
    assert.match(script, /git grep -n -I -F -- 'needle'/);
    assert.doesNotMatch(script, /"'needle'"/);
  });

  it('precedes the pattern with `--` in every tool (option-injection stop)', () => {
    // An option-like query must sit after `--` so it's a literal pattern in all
    // three tools (git grep, rg, grep), never parsed as a flag.
    const script = buildSearchScript('/a/b', '-l');
    assert.match(script, /git grep -n -I -F -- '-l'/);
    assert.match(script, /rg --line-number --no-heading -F -- '-l'/);
    assert.match(script, /grep -rnI -F -- '-l'/);
  });

  it('neutralizes shell metacharacters in the query (command-injection guard)', () => {
    // `; echo PWNED` must end up entirely inside single quotes — if quoting
    // failed, the echo would run remotely and PWNED would reach stdout. The
    // bash-level test below proves it can't break out; here we just confirm the
    // payload is spliced in as one single-quoted token.
    const script = buildSearchScript('/a/b', 'foo; echo PWNED');
    assert.ok(script.includes("'foo; echo PWNED'"), 'query must be single-quoted whole');
  });

  it('quotes a query containing single quotes safely', () => {
    // shellQuote turns don't → 'don'\''t' (close-quote, escaped quote, reopen).
    const script = buildSearchScript('/a/b', "don't");
    assert.ok(script.includes(`'don'\\''t'`));
  });

  it('uses -F / --fixed-strings (literal substring, not regex)', () => {
    // Literal search is the use case (error strings, function names) and stops
    // `.` matching every line + avoids invalid-regex empty results.
    const script = buildSearchScript('/a/b', 'needle');
    assert.match(script, /git grep -n -I -F -- /);
    assert.match(script, /rg --line-number --no-heading -F -- /);
    assert.match(script, /grep -rnI -F -- /);
  });

  it('disables pipefail (set +o pipefail) so head SIGPIPE does not drop results', () => {
    const script = buildSearchScript('/a/b', 'needle');
    assert.match(script, /set \+o pipefail/);
  });

  it('bounds per-line transfer with cut -c1-1000 (before head bounds count)', () => {
    const script = buildSearchScript('/a/b', 'needle');
    assert.match(script, /cut -c1-1000/);
    assert.match(script, /cut -c1-1000 \| head -n 30/);
  });

  it('presence-gates rg (command -v rg), not rg-no-match fallback', () => {
    const script = buildSearchScript('/a/b', 'needle');
    assert.match(script, /elif command -v rg/);
  });

  it('caps output with head -n 30', () => {
    const script = buildSearchScript('/a/b', 'needle');
    assert.match(script, /\| head -n 30/);
  });

  it('scopes the search to cwd via cd <quoted cwd>', () => {
    const script = buildSearchScript('/a/b', 'needle');
    assert.match(script, /cd '\/a\/b'/);
  });
});

// Run the generated remote script under a real bash (`bash -lc`, exactly like
// ssh.js does for remote hosts) and return { ok, stdout }.
function runScript(cwd, query) {
  const script = buildSearchScript(cwd, query);
  const r = spawnSync('bash', ['-lc', script], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  return { ok: r.status === 0, stdout: r.stdout || '', stderr: r.stderr || '' };
}

describe('buildSearchScript under bash (real git repo)', () => {
  let tmp;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-sf-cwd-'));
    // Minimal git repo with a couple of tracked files.
    spawnSync('git', ['-c', 'init.defaultBranch=main', 'init', '-q', tmp]);
    fs.writeFileSync(path.join(tmp, 'app.js'), 'function hello() {\n  return "needle";\n}\n');
    fs.writeFileSync(path.join(tmp, 'README.md'), '# project\nneedle here\n');
    // A tracked BINARY file containing the needle — must be skipped by -I.
    // Real binary = a NUL byte (git grep -I detects binary by NUL in the head).
    fs.writeFileSync(path.join(tmp, 'pic.png'), Buffer.from('needle\x00binary\xff\xfe\n'));
    // An untracked text file containing the needle — must be skipped (tracked-only).
    fs.writeFileSync(path.join(tmp, 'untracked.log'), 'needle untracked\n');
    spawnSync('git', ['-C', tmp, 'add', 'app.js', 'README.md', 'pic.png']);
    spawnSync('git', ['-C', tmp, 'commit', '-q', '-m', 'init']);
  });

  it('finds tracked-text-file matches scoped to cwd', () => {
    const r = runScript(tmp, 'needle');
    assert.equal(r.ok, true, `stderr=${r.stderr}`);
    const files = parseSearchOutput(r.stdout).map((p) => p.file).sort();
    assert.ok(files.includes('app.js'), `expected app.js in ${JSON.stringify(files)}`);
    assert.ok(files.includes('README.md'), `expected README.md in ${JSON.stringify(files)}`);
  });

  it('excludes untracked files (git grep = tracked only)', () => {
    const r = runScript(tmp, 'needle');
    const files = parseSearchOutput(r.stdout).map((p) => p.file);
    assert.ok(!files.includes('untracked.log'), 'untracked file must not appear');
  });

  it('skips binary files (-I)', () => {
    const r = runScript(tmp, 'needle');
    const files = parseSearchOutput(r.stdout).map((p) => p.file);
    assert.ok(!files.includes('pic.png'), 'tracked binary file must be skipped by -I');
  });

  it('reports the correct line number and text', () => {
    const r = runScript(tmp, 'hello');
    const hit = parseSearchOutput(r.stdout).find((p) => p.file === 'app.js');
    assert.ok(hit, 'expected an app.js match');
    assert.equal(hit.line, 1);
    assert.match(hit.text, /function hello/);
  });

  it('does not execute shell injection in the query', () => {
    // If quoting failed, `; echo PWNED` would run and PWNED would appear in stdout.
    const r = runScript(tmp, 'needle; echo PWNED');
    assert.equal(r.ok, true, `stderr=${r.stderr}`);
    assert.ok(!r.stdout.includes('PWNED'), 'injection payload must NOT execute');
  });

  it('treats an option-like query as a literal pattern (-- guard)', () => {
    // `-n` must be searched as text, not swallowed as a flag. No crash, ok.
    const r = runScript(tmp, '-n');
    assert.equal(r.ok, true, `stderr=${r.stderr}`);
  });

  it('returns empty (ok) for no matches, not an error', () => {
    const r = runScript(tmp, 'zzz_no_such_token_zzz');
    assert.equal(r.ok, true);
    assert.equal(parseSearchOutput(r.stdout).length, 0);
  });

  it('caps results at the head -n 30 boundary', () => {
    // 100 tracked files each with one match → at most 30 lines returned.
    for (let i = 0; i < 100; i++) {
      fs.writeFileSync(path.join(tmp, `f${i}.js`), 'CAPTOKEN\n');
      spawnSync('git', ['-C', tmp, 'add', `f${i}.js`]);
    }
    const r = runScript(tmp, 'CAPTOKEN');
    assert.equal(r.ok, true);
    // head -n 30 → at most 30 lines; one match per file → ≤30 results.
    assert.ok(parseSearchOutput(r.stdout).length <= 30);
  });

  it('survives a user-profile `set -o pipefail` (>30 matches, no results dropped)', () => {
    // Regression: bash -lc sources ~/.bash_profile, which may enable pipefail.
    // Under pipefail, `git grep | head` exits 141 (SIGPIPE) once head closes
    // after 30 lines → run() would read failure and drop ALL 30 real results.
    // buildSearchScript emits `set +o pipefail` to neutralize that. Simulate the
    // hostile profile by prepending `set -o pipefail` to the outer shell.
    for (let i = 0; i < 60; i++) {
      fs.writeFileSync(path.join(tmp, `p${i}.js`), 'PIPETOKEN\n');
      spawnSync('git', ['-C', tmp, 'add', `p${i}.js`]);
    }
    const script = `set -o pipefail; ${buildSearchScript(tmp, 'PIPETOKEN')}`;
    const r = spawnSync('bash', ['-lc', script], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
    assert.equal(r.status, 0, `outer pipefail must not fail the script: ${r.stderr}`);
    const out = parseSearchOutput(r.stdout || '');
    assert.ok(out.length > 0, 'results must NOT be silently dropped under pipefail');
    assert.ok(out.length <= 30);
  });

  it('treats the query as a LITERAL substring (-F), not a regex', () => {
    // `a.b` must match the literal "a.b", NOT "aXb"/"aYb" (regex `.` = any char).
    fs.writeFileSync(path.join(tmp, 'lit.js'), 'const a.b = 1;\nconst aXb = 2;\n');
    spawnSync('git', ['-C', tmp, 'add', 'lit.js']);
    const r = runScript(tmp, 'a.b');
    const hits = parseSearchOutput(r.stdout).map((p) => p.text);
    assert.ok(hits.some((t) => t.includes('a.b')), 'literal a.b must match');
    assert.ok(!hits.some((t) => t.includes('aXb')), 'regex-style aXb must NOT match under -F');
  });

  it('bounds each matched line to 1000 chars (cut -c1-1000)', () => {
    // A single huge matched line (e.g. a minified bundle) must be truncated
    // server-side by cut so it isn't shipped whole over SSH.
    const long = 'TOKEN' + 'x'.repeat(5000);
    fs.writeFileSync(path.join(tmp, 'big.js'), `${long}\n`);
    spawnSync('git', ['-C', tmp, 'add', 'big.js']);
    const r = runScript(tmp, 'TOKEN');
    const hit = parseSearchOutput(r.stdout).find((p) => p.file === 'big.js');
    assert.ok(hit, 'expected a big.js match');
    // The whole `file:line:text` line is capped at 1000 by cut, so text <= ~990.
    assert.ok(hit.text.length <= 1000, `line not truncated: ${hit.text.length}`);
  });
});

describe('parseSearchOutput', () => {
  it('parses path:line:text rows', () => {
    const raw = 'src/a.js:10:const x = 1;\nsrc/b.ts:42:export function y() {}\n';
    const out = parseSearchOutput(raw);
    assert.equal(out.length, 2);
    assert.deepEqual(out[0], { file: 'src/a.js', line: 10, text: 'const x = 1;' });
    assert.equal(out[1].file, 'src/b.ts');
    assert.equal(out[1].line, 42);
  });

  it('ignores blank and malformed lines', () => {
    const out = parseSearchOutput('\njust some text\nsrc/a.js:10:ok\n');
    assert.equal(out.length, 1);
    assert.equal(out[0].file, 'src/a.js');
  });

  it('does not misread a :digits: in the text body as the line number', () => {
    const out = parseSearchOutput('a.js:5:see ticket :123: for details\n');
    assert.equal(out[0].line, 5);
    assert.match(out[0].text, /see ticket :123: for details/);
  });

  it('strips a leading ./ (grep -rn format)', () => {
    const out = parseSearchOutput('./src/a.js:10:ok\n');
    assert.equal(out[0].file, './src/a.js'); // path preserved verbatim; read-file handles ./
    assert.equal(out[0].line, 10);
  });

  it('caps results at maxResults and truncates long lines', () => {
    const long = 'x'.repeat(1000);
    let raw = '';
    for (let i = 1; i <= 100; i++) raw += `f.js:${i}:${long}\n`;
    const out = parseSearchOutput(raw, 30, 50);
    assert.equal(out.length, 30);
    assert.ok(out.every((r) => r.text.length <= 50), 'every line must be truncated to maxLineLen');
  });
});
