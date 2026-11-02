// Pins startConnectionPoolCleanup (src/ssh.js): the 60s timer that tears down
// IDLE pooled ssh ControlMasters. No test starts it (it is only called from
// startServer), so a regression that leaks masters, or tears down one a request
// is using, ships green.
//
// The pool is module-private, so it is populated the production way: runWithPool
// -> getConnection -> ensureControlMaster, against a fake `ssh` on PATH that logs
// its argv and exits 0 (`-O check` => 0, so the master "already exists"). A remote
// command containing HOLDME makes the fake block until a release file appears, which
// keeps a connection's `refs` at 1. Date + setInterval are mocked; real child
// processes and real setTimeouts are untouched.
//
// Two hang guards in the fixture (neither touches a pinned assertion): the fake's
// HOLDME loop is bounded (~10s) and after() re-writes the release file and gives a
// short real-time grace BEFORE removing the temp dir — rmSync alone would delete
// the release file out from under a child that had not polled yet, leaving it
// looping forever with its stdio pipes holding the test process open.
import { describe, it, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MIN = 60 * 1000;
const skip = process.platform === 'win32' ? 'getConnection skips pooling on win32' : false;

describe('startConnectionPoolCleanup — idle ControlMaster teardown', { skip }, () => {
  let dir, log, release, origPath, ssh, logSpy;

  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-pool-cleanup-'));
    log = path.join(dir, 'argv.log');
    release = path.join(dir, 'release');
    fs.writeFileSync(log, '');
    const bin = path.join(dir, 'ssh');
    fs.writeFileSync(bin, [
      '#!/bin/sh',
      `echo "$*" >> "${log}"`,
      'case "$*" in',
      // Bounded block: release normally arrives in well under a second of real
      // time; the counter only stops a race-lost child (release file deleted
      // before its next poll) from spinning forever with open pipes.
      `  *HOLDME*) n=0; while [ ! -e "${release}" ] && [ "$n" -lt 500 ]; do sleep 0.02; n=$((n+1)); done;;`,
      'esac',
      'exit 0',
      '',
    ].join('\n'), { mode: 0o755 });
    origPath = process.env.PATH;
    process.env.PATH = `${dir}${path.delimiter}${origPath}`;
    ssh = await import('./ssh.js');
    logSpy = mock.method(console, 'log', () => {});
  });

  after(async () => {
    mock.timers.reset();
    // Re-create the release file (a failed assertion's finally may have raced the
    // dir removal) and let a still-looping child see it before the dir is gone.
    if (dir) {
      try { fs.writeFileSync(release, ''); } catch { /* dir already gone */ }
      await new Promise((r) => setTimeout(r, 60));
    }
    logSpy?.mock.restore();
    process.env.PATH = origPath;
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  const lines = () => fs.readFileSync(log, 'utf8').split('\n').filter(Boolean);
  const exits = () => lines().filter((l) => l.includes('-O exit'));
  const closedMsgs = () => logSpy.mock.calls.map((c) => String(c.arguments[0])).filter((m) => m.includes('[SSH pool] Closed idle connection'));
  async function until(fn, what) {
    for (let i = 0; i < 200; i++) { if (fn()) return; await new Promise((r) => setTimeout(r, 10)); }
    assert.fail(`timed out waiting for ${what}`);
  }
  const exitFor = (host) => exits().filter((l) => l.includes(`-- ${host}`));

  it('closes only connections that are unreferenced AND idle for strictly more than 5 minutes', async () => {
    mock.timers.enable({ apis: ['setInterval', 'Date'], now: 1_000_000 });
    ssh.startConnectionPoolCleanup();
    try {
    // T0: one host used and released; one host with a request still in flight.
    await ssh.runWithPool('idle-host', 'echo ok');
    const busy = ssh.runWithPool('busy-host', 'HOLDME');
    await until(() => lines().some((l) => l.includes('HOLDME')), 'busy-host request to reach the fake ssh');

    // 4 minutes: nothing is past the 5-minute idle bar yet.
    mock.timers.tick(4 * MIN);
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(exits(), [], 'no teardown before the idle timeout');

    // A third host last used at T0+4m.
    await ssh.runWithPool('fresh-host', 'echo ok');

    // T0+6m: idle-host is 6m idle with refs 0 -> closed. busy-host is 6m old but
    // still referenced -> kept. fresh-host is only 2m idle -> kept.
    mock.timers.tick(2 * MIN);
    await until(() => exitFor('idle-host').length === 1, 'idle-host ssh -O exit');
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(exitFor('idle-host').length, 1, 'idle-host torn down exactly once');
    assert.match(exitFor('idle-host')[0], /-O exit -S \S*ssh-ctrl-\d+-idle_host -- idle-host/, 'exit targets idle-host\'s own control socket');
    assert.deepEqual(exitFor('busy-host'), [], 'a referenced connection is never torn down, however old');
    assert.deepEqual(exitFor('fresh-host'), []);
    assert.deepEqual(closedMsgs(), ['[SSH pool] Closed idle connection to idle-host']);

    // The entry was evicted: another sweep does not tear idle-host down again.
    mock.timers.tick(MIN);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(exitFor('idle-host').length, 1, 'evicted entry is not closed twice');

    // Release busy-host. Its lastUsed is still T0 (release does not refresh it), so
    // the next sweep closes it — gated on refs, not on age alone.
    fs.writeFileSync(release, '');
    await busy;
    mock.timers.tick(MIN); // T0+8m
    await until(() => exitFor('busy-host').length === 1, 'busy-host ssh -O exit after release');

    // fresh-host: last used T0+4m. At T0+9m it is idle exactly 5m -> NOT closed
    // (strictly greater-than); at T0+10m it is 6m -> closed.
    mock.timers.tick(MIN); // T0+9m
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(exitFor('fresh-host'), [], 'idle exactly 5 minutes is not past the timeout');
    mock.timers.tick(MIN); // T0+10m
    await until(() => exitFor('fresh-host').length === 1, 'fresh-host ssh -O exit');
    assert.equal(exitFor('idle-host').length, 1);
    assert.equal(exitFor('busy-host').length, 1);
    } finally {
      fs.writeFileSync(release, ''); // never leave the fake ssh blocked if an assertion fails
    }
  });
});
