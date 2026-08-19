import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildRemoteSessionScript, parseJsonlTokenUsage } from './claudeSessions.js';

/**
 * Tests for the REMOTE (on-host) token extractor (WARDEN-1088).
 *
 * `server-session-tokens.test.js` covers the LOCAL extractor
 * (`parseJsonlTokenUsage`). This file covers its on-host twin: the grep+awk
 * pipeline inside `buildRemoteSessionScript()`, which computes the same four
 * totals without jq/node because remote hosts are assumed to run only
 * docker+tmux+claude.
 *
 * WHY THESE TESTS EXIST. Claude Code writes each assistant turn's usage as a
 * rollup PLUS a nested `iterations[]` decomposition OF THAT SAME ROLLUP. The
 * original pipeline text-scanned for the four field NAMES, so it matched the
 * rollup *and* every `iterations[]` entry and added them together — reporting
 * ~2.00x every remote host's real spend. Measured over this machine's corpus
 * before the fix: 78/78 transcripts diverged, every one at exactly 2.0000x.
 * That inflation fed the session token badge AND the WARDEN-414/415 budget, so
 * a remote host effectively breached at half its configured threshold.
 *
 * Nothing pinned the behavior in either direction, which is how the drift
 * shipped. The load-bearing assertion is `contributes an iterations[] rollup
 * exactly once` below.
 *
 * WARDEN-1092 then found that per-line first-occurrence-wins needs more than
 * "the rollup precedes its own iterations[]": ANY same-named key earlier on the
 * line wins, including one from an unrelated JSON path. Measured once in 407
 * transcripts, where it suppressed a true rollup — so the pipeline now gates on
 * `"usage":{`. `ignores a same-named token key nested BEFORE the rollup` pins
 * that, and `still counts a rollup whose usage object is the only thing on the
 * line` pins the gate against over-tightening.
 *
 * WHY IT RUNS THE REAL SCRIPT. These tests execute the string
 * `remoteClaudeSessions` actually ships, against a fixture HOME, rather than a
 * re-typed copy of the awk. Pinning a copy would re-create the very
 * two-copies-must-agree failure that caused this bug.
 */

// The pipeline is bash+grep+awk. Skip (don't fail) where that isn't available,
// so the suite stays green on a Windows dev box.
const HAVE_SH = (() => {
  try { execFileSync('bash', ['-lc', 'grep --version >/dev/null 2>&1 && awk "BEGIN{}"'], { stdio: 'ignore' }); return true; }
  catch { return false; }
})();

let tmp;
before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-remote-tok-')); });
after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ } });

/**
 * Write `lines` as a transcript into a throwaway HOME, run the REAL on-host
 * script there, and return the parsed `___S` token ints (or null when the
 * script emitted no token group — the no-usage contract).
 */
function runRemote(name, lines) {
  const home = fs.mkdtempSync(path.join(tmp, 'home-'));
  const proj = path.join(home, '.claude', 'projects', 'proj');
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(path.join(proj, `${name}.jsonl`), lines.join('\n') + '\n');
  const stdout = execFileSync('bash', ['-lc', buildRemoteSessionScript()], {
    encoding: 'utf8', env: { ...process.env, HOME: home }, maxBuffer: 1 << 24,
  });
  // Same marker parse `remoteClaudeSessions` uses on the SSH stdout.
  const m = stdout.split('\n').map((l) => l.match(/^___S\t(\S+)\t(\d+)(?:\t(\d+)\t(\d+)\t(\d+)\t(\d+))?/)).find(Boolean);
  assert.ok(m, 'the script must emit an ___S marker for the fixture transcript');
  if (m[3] == null) return null;
  const [i, o, cc, cr] = [+m[3], +m[4], +m[5], +m[6]];
  return { input: i, output: o, cacheCreation: cc, cacheRead: cr, total: i + o + cc + cr };
}

const j = (o) => JSON.stringify(o);

/** An assistant turn whose usage rollup is decomposed into `iterations[]`. */
function turnWithIterations(rollup, parts) {
  return j({ type: 'assistant', message: { role: 'assistant', usage: { ...rollup, iterations: parts } } });
}

describe('remote on-host token extractor', { skip: HAVE_SH ? false : 'bash/grep/awk unavailable' }, () => {
  it('contributes an iterations[] rollup exactly once (WARDEN-1088 double-count)', () => {
    // The regression shape: a rollup sitting beside a breakdown of ITSELF.
    // 40+60=100 input, 6+4=10 output, 1+1=2 cacheCreation, 500+500=1000 cacheRead.
    const line = turnWithIterations(
      { input_tokens: 100, output_tokens: 10, cache_creation_input_tokens: 2, cache_read_input_tokens: 1000 },
      [
        { input_tokens: 40, output_tokens: 6, cache_creation_input_tokens: 1, cache_read_input_tokens: 500 },
        { input_tokens: 60, output_tokens: 4, cache_creation_input_tokens: 1, cache_read_input_tokens: 500 },
      ],
    );
    const got = runRemote('iter', [line]);
    // The rollup, ONCE. Pre-fix this returned exactly double every field.
    assert.deepStrictEqual(got, { input: 100, output: 10, cacheCreation: 2, cacheRead: 1000, total: 1112 });
  });

  it('agrees with the local extractor on a multi-turn iterations[] transcript', () => {
    // The real contract: the two extractors are the same number. Asserting
    // against `parseJsonlTokenUsage` rather than a literal is what makes the
    // parity claim in claudeSessions.js checkable instead of aspirational.
    const lines = [
      j({ cwd: '/repo', type: 'user', message: { role: 'user', content: 'go' } }),
      turnWithIterations(
        { input_tokens: 7, output_tokens: 3, cache_creation_input_tokens: 0, cache_read_input_tokens: 900 },
        [{ input_tokens: 7, output_tokens: 3, cache_creation_input_tokens: 0, cache_read_input_tokens: 900 }],
      ),
      turnWithIterations(
        { input_tokens: 50, output_tokens: 20, cache_creation_input_tokens: 5, cache_read_input_tokens: 0 },
        [
          { input_tokens: 20, output_tokens: 12, cache_creation_input_tokens: 5, cache_read_input_tokens: 0 },
          { input_tokens: 30, output_tokens: 8, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        ],
      ),
    ];
    const remote = runRemote('parity', lines);
    const local = parseJsonlTokenUsage(lines.join('\n') + '\n');
    assert.deepStrictEqual(remote, local, 'remote and local extractors must report identical totals');
    assert.strictEqual(remote.total, 985); // 57 in + 23 out + 5 cc + 900 cr
  });

  it('sums plain turns that carry no iterations[] (no behavior change)', () => {
    const lines = [
      j({ type: 'assistant', message: { role: 'assistant', usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 2, cache_read_input_tokens: 3 } } }),
      j({ type: 'assistant', message: { role: 'assistant', usage: { input_tokens: 100, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } }),
    ];
    const remote = runRemote('plain', lines);
    assert.deepStrictEqual(remote, parseJsonlTokenUsage(lines.join('\n') + '\n'));
    assert.deepStrictEqual(remote, { input: 110, output: 5, cacheCreation: 2, cacheRead: 3, total: 120 });
  });

  it('dedups per LINE, not per file — each turn still contributes its own rollup', () => {
    // The dedup resets on every JSONL record. If it leaked across lines it
    // would under-count instead (the opposite failure), so pin both turns.
    const mk = (n) => turnWithIterations(
      { input_tokens: n, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      [{ input_tokens: n, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }],
    );
    assert.strictEqual(runRemote('perline', [mk(11), mk(22), mk(33)]).input, 66);
  });

  it('ignores a same-named token key nested BEFORE the rollup (WARDEN-1092)', () => {
    // The counter-example to naked first-occurrence-wins, measured on a real
    // transcript: a tool ARGUMENT at
    // `.message.content[].input.metadata.frozen_window_measured.output_tokens`
    // sits earlier in the line than `message.usage`, so "first match on the
    // line" took 85502 and DISCARDED the true rollup 3362 — under-counting,
    // the opposite direction from the WARDEN-1088 double-count. The `"usage":{`
    // gate is what makes the earlier key unreachable. Field values mirror the
    // measured line so the numbers stay traceable to it.
    const line = j({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', input: { metadata: { frozen_window_measured: { by_ticket_entries: 0, output_tokens: 85502, credits_delta: 22 } } } }],
        usage: {
          input_tokens: 2,
          cache_creation_input_tokens: 3325,
          cache_read_input_tokens: 150126,
          output_tokens: 3362,
          iterations: [{ input_tokens: 2, output_tokens: 3362, cache_creation_input_tokens: 3325, cache_read_input_tokens: 150126 }],
        },
      },
    });
    const remote = runRemote('nested-before', [line]);
    // The rollup, not the tool argument. Pre-WARDEN-1092 output was 85502.
    assert.deepStrictEqual(remote, parseJsonlTokenUsage(line + '\n'));
    assert.strictEqual(remote.output, 3362);
    assert.deepStrictEqual(remote, { input: 2, output: 3362, cacheCreation: 3325, cacheRead: 150126, total: 156815 });
  });

  it('still counts a rollup whose usage object is the only thing on the line', () => {
    // Guards the gate from the opposite failure: `"usage":{` must ARM counting,
    // never be required to appear twice or in some richer context. A bare turn
    // has exactly one opener and must still contribute in full.
    const line = j({ type: 'assistant', message: { role: 'assistant', usage: { input_tokens: 9, output_tokens: 4, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } });
    assert.deepStrictEqual(runRemote('bare-usage', [line]), parseJsonlTokenUsage(line + '\n'));
  });

  it('emits no token group for a no-usage or all-zero transcript (null-for-zero contract)', () => {
    // Shared with the local path: a row with no real spend renders no badge
    // rather than a misleading "0 tok". The awk's if(inp||out||cc||cr) guard.
    assert.strictEqual(runRemote('nousage', [
      j({ cwd: '/repo', type: 'user', message: { role: 'user', content: 'hello' } }),
      j({ type: 'summary', summary: 'no usage anywhere' }),
    ]), null);
    assert.strictEqual(runRemote('zeros', [
      j({ type: 'assistant', message: { role: 'assistant', usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } }),
    ]), null);
  });

  it('skips malformed lines without throwing, like the local path', () => {
    const lines = [
      'this is not json at all',
      turnWithIterations(
        { input_tokens: 7, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        [{ input_tokens: 7, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }],
      ),
      '{ "broken": ',
    ];
    assert.deepStrictEqual(runRemote('malformed', lines), { input: 7, output: 1, cacheCreation: 0, cacheRead: 0, total: 8 });
  });
});
