import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * WARDEN-2110: parseFlags(argv, bools) in src/cli.js is the single argv parser
 * behind `warden scan|tail|send|key|attach|dash|ui` — and no other test drives
 * it. It has four distinct branches plus a shape gate:
 *
 *   1. the `--` terminator: the rest of argv becomes positional, parsing stops;
 *   2. a long flag `--k` that is bool-declared sets a boolean, otherwise it
 *      swallows the next token as its value (`--lines 5`);
 *   3. a short cluster `-ff` where EVERY char is a declared bool sets each and
 *      swallows nothing;
 *   4. a short flag/cluster with a non-bool char (`-n 5`, `-fx`) is one
 *      value-taking flag and swallows the next token;
 *   the `/^-[A-Za-z]+$/` shape gate keeps digit-led tokens (`-5`) positional.
 *
 * The parser is private (not exported), but it is observable through two
 * hermetic exits of the REAL CLI process, both reached before any transport:
 *   - `warden: usage: …`               → the command saw too few positionals;
 *   - `warden: no chat matches "<id>"` → the command saw `<id>` as its first
 *     positional (resolveChat finds nothing in an empty temp HOME, so id
 *     resolution dies without touching ssh/tmux).
 * Which exit appears names what parseFlags did with each token. Each case
 * spawns one short-lived process (~60 ms), the same pattern as
 * cli-scan-cache-write-failure.test.js.
 *
 * One-token mutants of parseFlags these tests catch that every existing
 * cli/companion-cli test misses: dropping the `--` terminator, a long flag not
 * consuming its value, `every`→`some` in the bool-cluster check, a short
 * non-bool flag not consuming its value, and both regex-gate mutations. (The
 * `break` after `--` and the cluster's stored value are not observable through
 * these exits; the "long flags always bool" mutant already fails existing
 * tests.)
 */
describe('cli parseFlags — observed through the warden process (usage vs resolved-id exits) (WARDEN-2110)', () => {
  const cli = path.join(import.meta.dirname, 'cli.js');
  let home;
  before(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-cliflags-')); });
  after(() => { fs.rmSync(home, { recursive: true, force: true }); });

  // Run the real `warden` process against an empty temp HOME: no config, no
  // chat cache, no hosts — id resolution always dies hermetically with
  // `warden: no chat matches "<id>"`, never reaching a transport.
  const run = (...args) => {
    const r = spawnSync(process.execPath, [cli, ...args], {
      env: { ...process.env, HOME: home, USERPROFILE: home },
      encoding: 'utf8',
      timeout: 60_000,
    });
    return { status: r.status, err: r.stderr };
  };
  const noMatch = (id) => new RegExp(`^warden: no chat matches "${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`, 'm');
  const USAGE_TAIL = /^warden: usage: warden tail /m;
  const USAGE_SEND = /^warden: usage: warden send /m;

  it('positive control: a bare first positional reaches id resolution', () => {
    const r = run('tail', 'zz-flags-a');
    assert.strictEqual(r.status, 1);
    assert.match(r.err, noMatch('zz-flags-a'));
  });

  it('a long flag NOT declared bool swallows the next token (`--lines 5` leaves no id)', () => {
    const r = run('tail', '--lines', '5');
    assert.strictEqual(r.status, 1);
    assert.match(r.err, USAGE_TAIL);
    assert.doesNotMatch(r.err, /no chat matches/);
  });

  it('a declared-bool short flag swallows nothing (`-f <id>` still resolves <id>)', () => {
    const r = run('tail', '-f', 'zz-flags-b');
    assert.strictEqual(r.status, 1);
    assert.match(r.err, noMatch('zz-flags-b'));
  });

  it('a cluster of bool short flags (`-ff <id>`) sets each and swallows nothing', () => {
    const r = run('tail', '-ff', 'zz-flags-c');
    assert.strictEqual(r.status, 1);
    assert.match(r.err, noMatch('zz-flags-c'));
  });

  it('a cluster with a non-bool char (`-fx <id>`) is one value-taking flag and swallows the next token', () => {
    const r = run('tail', '-fx', 'zz-flags-d');
    assert.strictEqual(r.status, 1);
    assert.match(r.err, USAGE_TAIL);
    assert.doesNotMatch(r.err, /no chat matches/);
  });

  it('a non-bool short flag (`-n 5 <id>`) swallows only its own value', () => {
    const r = run('tail', '-n', '5', 'zz-flags-e');
    assert.strictEqual(r.status, 1);
    assert.match(r.err, noMatch('zz-flags-e'));
  });

  it('`--` ends flag parsing: a later `-f` is the id, not a flag', () => {
    const r = run('tail', '--', '-f');
    assert.strictEqual(r.status, 1);
    assert.match(r.err, noMatch('-f'));
    assert.doesNotMatch(r.err, USAGE_TAIL);
  });

  it('a dash-led message after `--` survives as the send message (`send <id> -- --not-a-flag`)', () => {
    const r = run('send', 'zz-flags-f', '--', '--not-a-flag');
    assert.strictEqual(r.status, 1);
    assert.match(r.err, noMatch('zz-flags-f'));
    assert.doesNotMatch(r.err, USAGE_SEND);
  });

  it('without `--`, a dash-led word is a flag and eats the message (`send <id> --not-a-flag` → usage)', () => {
    const r = run('send', 'zz-flags-g', '--not-a-flag');
    assert.strictEqual(r.status, 1);
    assert.match(r.err, USAGE_SEND);
  });

  it('a digit-led dash token is positional, not a short flag (`tail -5` → id "-5")', () => {
    const r = run('tail', '-5');
    assert.strictEqual(r.status, 1);
    assert.match(r.err, noMatch('-5'));
  });
});
