import { describe, it, mock } from 'node:test';
import assert from 'node:assert';
import { isTransportFailure, runWithPool, detectClaude, buildSshArgv, SSH_BASE_OPTS } from './ssh.js';

/**
 * Tests for the SSH connection-pool self-healing layer (WARDEN-129):
 *   1. `isTransportFailure` — the pure classifier that decides whether a `run()`
 *      failure is an SSH transport failure (command never ran remotely → safe to
 *      retry) or a command-level result (ran, even if non-zero → never retry).
 *   2. `runWithPool` — the retry + eviction sequence, driven through an optional
 *      `deps` seam (run / getConnection / markConnectionUnhealthy) so the retry
 *      sequence is deterministic with no real ssh processes spawned.
 *
 * Why the `deps` seam instead of mocking `child_process.spawn`: this repo runs on
 * Node 20, where `node:test`'s `mock.module` is unavailable and the built-in
 * `node:child_process` exports are non-configurable (mock.method throws
 * "Cannot redefine property: spawn"). The injectable-deps seam is the
 * runtime-appropriate equivalent of the ticket's suggested spawn mock.
 */

// Build a mock that returns each value in `results` in call order, throwing when
// a value is an Error. Use .mock.callCount() to assert invocation counts.
function sequencer(results) {
  let i = 0;
  return mock.fn(() => {
    const v = results[i++];
    if (v instanceof Error) throw v;
    return v;
  });
}

describe('isTransportFailure (classifier)', () => {
  describe('transport failures → true (safe to retry)', () => {
    const cases = [
      ['Control socket connect failed (wedged/absent master)', { ok: false, code: 255, stdout: '', stderr: 'Control socket connect(/tmp/ssh-ctrl-x): No such file or directory\n' }],
      ['Connection timed out (connect-time)', { ok: false, code: 255, stdout: '', stderr: 'ssh: connect to host 10.0.0.5 port 22: Connection timed out\n' }],
      ['ssh: connection refused (connect-time)', { ok: false, code: 255, stdout: '', stderr: 'ssh: connect to host 10.0.0.5 port 22: Connection refused\n' }],
      ['ssh: could not resolve hostname (connect-time)', { ok: false, code: 255, stdout: '', stderr: 'ssh: Could not resolve hostname foo: Name or service not known\n' }],
      ['ssh: no route to host (connect-time)', { ok: false, code: 255, stdout: '', stderr: 'ssh: connect to host foo port 22: No route to host\n' }],
      ['timeout SIGKILL (code -1, no output)', { ok: false, code: -1, stdout: '', stderr: '' }],
      ['spawn error (code -1)', { ok: false, code: -1, stdout: '', stderr: 'Error: spawn ssh ENOENT' }],
      ['whitespace-only stdout still transport', { ok: false, code: -1, stdout: '   \n\t', stderr: '' }],
    ];
    for (const [name, result] of cases) {
      it(`classifies "${name}" as transport`, () => {
        assert.strictEqual(isTransportFailure(result), true, JSON.stringify(result));
      });
    }
  });

  describe('command-level results → false (NEVER retried)', () => {
    const cases = [
      ['has-session miss (non-zero, real remote result)', { ok: false, code: 1, stdout: '', stderr: "can't find session: agent\n" }],
      ['no tmux server', { ok: false, code: 1, stdout: '', stderr: 'no server running on /tmp/tmux-1000/default\n' }],
      ['auth failure (not transient)', { ok: false, code: 255, stdout: '', stderr: 'user@host: Permission denied (publickey).\n' }],
      ['host key verification failure', { ok: false, code: 255, stdout: '', stderr: 'Host key verification failed.\n' }],
      ['command non-zero WITH stdout (provably ran)', { ok: false, code: 1, stdout: 'partial output\n', stderr: 'grep wrote nothing\n' }],
      ['remote command killed by signal (128+sig, not -1)', { ok: false, code: 137, stdout: '', stderr: 'Terminated\n' }],
      // Mid-stream transport signals: deliberately NOT classified as transport.
      // They are ambiguous — the same stderr can mean the channel died BEFORE the
      // command ran (safe to retry) OR AFTER a side-effecting command already ran
      // (retrying would double-execute, e.g. send-keys). The safe default is to
      // never retry. See the isTransportFailure doc comment.
      ['mid-stream: Connection closed (ambiguous, never retried)', { ok: false, code: 255, stdout: '', stderr: 'Connection closed by 10.0.0.5 port 22\n' }],
      ['mid-stream: Connection reset (ambiguous, never retried)', { ok: false, code: 255, stdout: '', stderr: 'Connection reset by 1.2.3.4 port 22\n' }],
      ['mid-stream: Broken pipe (ambiguous, never retried)', { ok: false, code: 255, stdout: '', stderr: 'client_loop: send disconnect: Broken pipe\n' }],
      ['remote "killed by signal" log (loose substring, never retried)', { ok: false, code: 255, stdout: '', stderr: 'killed by signal 15\n' }],
      ['successful result', { ok: true, code: 0, stdout: 'OK\n', stderr: '' }],
    ];
    for (const [name, result] of cases) {
      it(`does NOT classify "${name}" as transport`, () => {
        assert.strictEqual(isTransportFailure(result), false, JSON.stringify(result));
      });
    }
  });

  it('handles null/undefined/empty input defensively', () => {
    assert.strictEqual(isTransportFailure(null), false);
    assert.strictEqual(isTransportFailure(undefined), false);
    assert.strictEqual(isTransportFailure({}), false);
  });
});

describe('runWithPool (self-healing retry + eviction)', () => {
  describe('transport failure → single retry on a fresh connection', () => {
    it('retries once and succeeds; evicts the wedged socket', async () => {
      const runMock = sequencer([
        { ok: false, code: 255, stdout: '', stderr: 'Control socket connect(/tmp/x): No such file or directory\n' },
        { ok: true, code: 0, stdout: 'OK\n', stderr: '' },
      ]);
      const getConn = mock.fn(async () => ({ socketPath: '/tmp/fresh-sock' }));
      const markUnhealthy = mock.fn(() => {});

      const result = await runWithPool(
        'remote-A', 'echo OK', { timeout: 5000 }, {},
        { run: runMock, getConnection: getConn, markConnectionUnhealthy: markUnhealthy },
      );

      assert.strictEqual(result.ok, true, 'retry result should be returned to caller');
      assert.strictEqual(result.stdout, 'OK\n');
      assert.strictEqual(runMock.mock.callCount(), 2, 'run called twice (initial + one retry)');
      assert.strictEqual(getConn.mock.callCount(), 2, 'getConnection called for initial + fresh retry');
      assert.strictEqual(markUnhealthy.mock.callCount(), 1, 'wedged socket evicted exactly once');
      assert.strictEqual(markUnhealthy.mock.calls[0].arguments[0], 'remote-A', 'evicted the right host');
    });

    it('does NOT retry a second time if the retry also fails (retry once, not a loop)', async () => {
      const runMock = sequencer([
        { ok: false, code: -1, stdout: '', stderr: '' },                              // initial: transport (timeout)
        { ok: false, code: 255, stdout: '', stderr: 'ssh: connect to host x: Connection refused\n' }, // retry: also transport
      ]);
      const getConn = mock.fn(async () => ({ socketPath: '/tmp/sock' }));
      const markUnhealthy = mock.fn(() => {});

      const result = await runWithPool('remote-B', 'echo OK', {}, {},
        { run: runMock, getConnection: getConn, markConnectionUnhealthy: markUnhealthy });

      assert.strictEqual(result.ok, false, 'final failure returned to caller');
      assert.strictEqual(runMock.mock.callCount(), 2, 'exactly one retry — never a loop');
      assert.strictEqual(markUnhealthy.mock.callCount(), 1, 'evicted once, before the retry');
    });

    it('falls back to a direct run if the fresh connection cannot be established', async () => {
      const runMock = sequencer([
        { ok: false, code: 255, stdout: '', stderr: 'Control socket connect(/tmp/sock): No such file or directory\n' }, // pooled: channel-establishment transport
        { ok: false, code: 255, stdout: '', stderr: 'direct ssh: host down\n' },    // fallback direct run
      ]);
      const getConn = sequencer([
        { socketPath: '/tmp/sock' },                              // initial getConnection ok
        new Error('HostConnectionError: Cannot connect to remote-C'), // fresh getConnection throws
      ]);
      const markUnhealthy = mock.fn(() => {});

      const result = await runWithPool('remote-C', 'echo OK', {}, {},
        { run: runMock, getConnection: getConn, markConnectionUnhealthy: markUnhealthy });

      assert.strictEqual(result.ok, false, 'fallback direct run result returned');
      assert.strictEqual(runMock.mock.callCount(), 2, 'initial pooled run + fallback direct run');
      assert.strictEqual(markUnhealthy.mock.callCount(), 1, 'evicted before attempting a fresh conn');
    });
  });

  describe('command-level failure → NEVER retried (double-execution guard)', () => {
    it('does not retry a has-session miss (genuine non-zero exit)', async () => {
      const runMock = sequencer([
        { ok: false, code: 1, stdout: '', stderr: "can't find session: agent\n" },
      ]);
      const getConn = mock.fn(async () => ({ socketPath: '/tmp/sock' }));
      const markUnhealthy = mock.fn(() => {});

      const result = await runWithPool('remote-D', 'tmux has-session -t agent', {}, {},
        { run: runMock, getConnection: getConn, markConnectionUnhealthy: markUnhealthy });

      assert.strictEqual(result.ok, false, 'command failure passed through');
      assert.strictEqual(result.code, 1);
      assert.strictEqual(runMock.mock.callCount(), 1, 'side-effecting command must NOT be double-invoked');
      assert.strictEqual(markUnhealthy.mock.callCount(), 0, 'no eviction for a command-level result');
      assert.strictEqual(getConn.mock.callCount(), 1, 'no fresh connection attempted');
    });

    it('does not retry a command that produced stdout (provably ran)', async () => {
      const runMock = sequencer([
        { ok: false, code: 1, stdout: 'partial output\n', stderr: 'remote error\n' },
      ]);
      const getConn = mock.fn(async () => ({ socketPath: '/tmp/sock' }));
      const markUnhealthy = mock.fn(() => {});

      const result = await runWithPool('remote-E', 'some-cmd', {}, {},
        { run: runMock, getConnection: getConn, markConnectionUnhealthy: markUnhealthy });

      assert.strictEqual(runMock.mock.callCount(), 1, 'command with output must not be retried');
      assert.strictEqual(markUnhealthy.mock.callCount(), 0);
      assert.strictEqual(result.stdout, 'partial output\n');
    });

    it('does not retry an auth failure (not transient)', async () => {
      const runMock = sequencer([
        { ok: false, code: 255, stdout: '', stderr: 'user@host: Permission denied (publickey).\n' },
      ]);
      const getConn = mock.fn(async () => ({ socketPath: '/tmp/sock' }));
      const markUnhealthy = mock.fn(() => {});

      await runWithPool('remote-F', 'echo OK', {}, {},
        { run: runMock, getConnection: getConn, markConnectionUnhealthy: markUnhealthy });

      assert.strictEqual(runMock.mock.callCount(), 1, 'auth failure is not transport — no retry');
      assert.strictEqual(markUnhealthy.mock.callCount(), 0);
    });

    it('does NOT retry a no-stdout side-effect after a mid-stream break (the real double-exec surface)', async () => {
      // This is the actual failure mode the safety invariant must hold against: a
      // side-effecting command (send-keys) already ran on the remote, but the
      // channel broke mid-stream before ssh returned the exit status. The result
      // is a no-stdout, transport-y error. Retrying would deliver the keys AGAIN.
      // Under the narrowed classifier these mid-stream signals are NOT transport,
      // so the command must be invoked exactly once. (The has-session test above
      // is a command-non-zero-exit proxy; this drives the genuine double-exec
      // surface the reviewer flagged.)
      const midStreamStderrs = [
        'client_loop: send disconnect: Broken pipe\n',
        'Connection closed by 10.0.0.5 port 22\n',
        'Connection reset by 1.2.3.4 port 22\n',
      ];
      for (const stderr of midStreamStderrs) {
        const runMock = sequencer([{ ok: false, code: 255, stdout: '', stderr }]);
        const getConn = mock.fn(async () => ({ socketPath: '/tmp/sock' }));
        const markUnhealthy = mock.fn(() => {});

        const result = await runWithPool('remote-SE', "tmux send-keys -t agent 'do thing' Enter", {}, {},
          { run: runMock, getConnection: getConn, markConnectionUnhealthy: markUnhealthy });

        assert.strictEqual(runMock.mock.callCount(), 1,
          `send-keys must NOT be retried on a mid-stream break (${JSON.stringify(stderr)}) — that is the double-exec surface`);
        assert.strictEqual(markUnhealthy.mock.callCount(), 0, 'no eviction for a non-transport result');
        assert.strictEqual(getConn.mock.callCount(), 1, 'no fresh connection attempted');
        assert.strictEqual(result.ok, false);
      }
    });
  });

  describe('local host bypass', () => {
    it('(local) delegates to run directly — no pool, no retry, no eviction', async () => {
      const runMock = sequencer([{ ok: true, code: 0, stdout: 'hi\n', stderr: '' }]);
      const getConn = mock.fn(async () => ({ socketPath: '/tmp/sock' }));
      const markUnhealthy = mock.fn(() => {});

      const result = await runWithPool('(local)', 'echo hi', {}, {},
        { run: runMock, getConnection: getConn, markConnectionUnhealthy: markUnhealthy });

      assert.strictEqual(result.ok, true);
      assert.strictEqual(runMock.mock.callCount(), 1);
      assert.strictEqual(getConn.mock.callCount(), 0, 'local must not touch the pool');
      assert.strictEqual(markUnhealthy.mock.callCount(), 0, 'local must not evict');
    });

    it('(local) does not retry even on what would be a transport failure', async () => {
      // The local path returns run() directly with no eviction/retry, so a local
      // failure is handed straight back to the caller.
      const runMock = sequencer([{ ok: false, code: -1, stdout: '', stderr: 'boom' }]);
      const getConn = mock.fn(async () => ({ socketPath: '/tmp/sock' }));
      const markUnhealthy = mock.fn(() => {});

      const result = await runWithPool('(local)', 'false', {}, {},
        { run: runMock, getConnection: getConn, markConnectionUnhealthy: markUnhealthy });

      assert.strictEqual(result.ok, false);
      assert.strictEqual(runMock.mock.callCount(), 1, 'local never retries');
      assert.strictEqual(getConn.mock.callCount(), 0);
      assert.strictEqual(markUnhealthy.mock.callCount(), 0);
    });
  });
});

// WARDEN-440: remote claude-binary detection must run its candidate SSH probes
// CONCURRENTLY (≈ one 8s timeout) instead of serially (up to 3 × 8s ≈ 24s on a
// slow/wedged host), while preserving the zsh > bash > path-search priority. The
// `deps.runWithPool` seam (mirrors runWithPool's own deps seam) makes the probe
// ordering deterministic without spawning real ssh.
describe('detectClaude (remote) — concurrent, priority-preserving (WARDEN-440)', () => {
  const cmds = (calls) => calls.map((c) => c.arguments[1]);

  it('runs ALL candidate probes concurrently, not serially', async () => {
    // Each probe resolves on the NEXT tick (setImmediate). If the probes were
    // serial, the first would resolve before the second is even called. Under
    // Promise.all all three are INVOKED in the same tick, so by the time any one
    // resolves all three have already started — that is the concurrency proof.
    let started = 0;
    let startedAtFirstResolve = null;
    const runWithPool = mock.fn(() => {
      started++;
      return new Promise((resolve) => setImmediate(() => {
        if (startedAtFirstResolve === null) startedAtFirstResolve = started;
        resolve({ ok: true, code: 0, stdout: '', stderr: '' }); // no `/` → not found
      }));
    });

    const result = await detectClaude('remote-host', { runWithPool });

    assert.strictEqual(result, null, 'no probe found a `/`-prefixed path → null');
    assert.strictEqual(runWithPool.mock.callCount(), 3, 'all three candidate commands are issued');
    assert.strictEqual(startedAtFirstResolve, 3,
      `all 3 probes started BEFORE the first resolved (concurrent); got ${startedAtFirstResolve} — would be 1 if serial`);
  });

  it('returns the highest-priority hit (zsh login) even when lower-priority probes also find claude', async () => {
    // All three probes find a path concurrently; priority order (zsh first in the
    // cmds array) must win — this is the preference the old serial short-circuit
    // expressed, now preserved over a concurrent fan-out.
    const outputs = new Map([
      ['zsh -lic "command -v claude" 2>/dev/null', '/home/u/.local/bin/claude'],
      ['bash -lc "command -v claude" 2>/dev/null', '/usr/bin/claude'],
      ['for p in ~/.local/bin/claude /opt/homebrew/bin/claude /usr/local/bin/claude ~/bin/claude ~/n/bin/claude; do [ -x "$p" ] && { echo "$p"; break; }; done', '/opt/homebrew/bin/claude'],
    ]);
    const runWithPool = mock.fn((_host, cmd) =>
      Promise.resolve({ ok: true, code: 0, stdout: (outputs.get(cmd) || '') + '\n', stderr: '' }));

    const result = await detectClaude('remote-host', { runWithPool });

    assert.strictEqual(result, '/home/u/.local/bin/claude', 'zsh-login result wins by priority');
    assert.deepStrictEqual(cmds(runWithPool.mock.calls), [...outputs.keys()], 'probes are the 3 candidates, once each');
  });

  it('falls through zsh/bash to the explicit path-search when the login shells find nothing', async () => {
    const outputs = new Map([
      ['zsh -lic "command -v claude" 2>/dev/null', ''],
      ['bash -lc "command -v claude" 2>/dev/null', ''],
      ['for p in ~/.local/bin/claude /opt/homebrew/bin/claude /usr/local/bin/claude ~/bin/claude ~/n/bin/claude; do [ -x "$p" ] && { echo "$p"; break; }; done', '/opt/homebrew/bin/claude'],
    ]);
    const runWithPool = mock.fn((_host, cmd) =>
      Promise.resolve({ ok: true, code: 0, stdout: (outputs.get(cmd) || ''), stderr: '' }));

    const result = await detectClaude('remote-host', { runWithPool });

    assert.strictEqual(result, '/opt/homebrew/bin/claude', 'path-search hit returned when login shells miss');
  });

  it('returns null when no candidate finds a `/`-prefixed path', async () => {
    const runWithPool = mock.fn(() =>
      Promise.resolve({ ok: false, code: 1, stdout: '', stderr: 'command not found\n' }));

    const result = await detectClaude('remote-host', { runWithPool });

    assert.strictEqual(result, null);
    assert.strictEqual(runWithPool.mock.callCount(), 3);
  });

  it('a transport error on one probe does not reject the whole search (belt-and-suspenders)', async () => {
    // runWithPool resolves (never throws) in production, but detectClaude's per-
    // probe .catch guarantees a thrown probe can't abort the Promise.all. The
    // remaining probes still decide the result.
    const runWithPool = mock.fn((_host, cmd) =>
      cmd.startsWith('zsh')
        ? Promise.reject(new Error('ssh transport boom'))
        : Promise.resolve({ ok: true, code: 0, stdout: '/usr/bin/claude\n', stderr: '' }));

    const result = await detectClaude('remote-host', { runWithPool });

    assert.strictEqual(result, '/usr/bin/claude', 'survived the rejecting zsh probe via the fallback bash/path probe');
  });
});

/**
 * buildSshArgv — the ONE place the ssh `--` option-terminator invariant lives
 * (WARDEN-989).
 *
 * Before this builder, ssh argv was hand-assembled at 7 sites across ssh.js and
 * companion.js, each re-typing `'--', host` from memory. That leaked in exactly
 * the way a per-call-site invariant always does: WARDEN-969 shipped "`--` at all
 * 5 ssh argv builders", and WARDEN-979 then had to ship the SAME commit subject
 * again for the 2 companion.js sites the first fix could not reach.
 *
 * The existing locking specs (sshRun.test.js:148-209, companion.test.js:1477-1520)
 * assert the separator through recording fake spawns at the PUBLIC seam — they
 * are unchanged by this extraction and now transitively cover all 7 sites through
 * one function. These tests assert the builder DIRECTLY: it is pure, so the whole
 * invariant is checkable with no ssh process, no spawn seam and no stub
 * archaeology (the same argument as buildDockerGitArgv in gitStatus.js).
 */
describe('buildSshArgv — the `--` separator invariant, in one place', () => {
  // The attack shape: a "host" that is really a local-command-executing ssh
  // option. After `--`, ssh must read it as a (bogus) hostname instead.
  const EVIL_HOST = '-oProxyCommand=touch /tmp/pwned';

  const sepIndex = (argv) => argv.indexOf('--');

  // The property every case below must hold: `--` is present exactly once, and
  // the host is the element IMMEDIATELY after it. Adjacency, not mere ordering —
  // during WARDEN-969's review a mutation inserting `'--', '-o', 'X=1', host`
  // went red only because the adjacency form was used.
  const assertSeparatorGuardsHost = (argv, host) => {
    const i = sepIndex(argv);
    assert.notStrictEqual(i, -1, '`--` present');
    assert.strictEqual(argv.filter((a) => a === '--').length, 1, '`--` appears exactly once');
    assert.strictEqual(argv[i + 1], host, 'host is ADJACENT to `--`, not merely after it');
  };

  it('emits `--` immediately before the host for the bare default', () => {
    const argv = buildSshArgv('example.com');

    assert.deepStrictEqual(argv, [...SSH_BASE_OPTS, '--', 'example.com']);
    assertSeparatorGuardsHost(argv, 'example.com');
  });

  it('a `-`-leading host lands AFTER the separator, so ssh cannot read it as an option', () => {
    const argv = buildSshArgv(EVIL_HOST);

    assertSeparatorGuardsHost(argv, EVIL_HOST);
    assert.ok(sepIndex(argv) < argv.indexOf(EVIL_HOST), 'attack string sits after the terminator');
  });

  it('holds the invariant for every option combination', () => {
    // The cartesian product of the flags, including the `-`-leading host, so no
    // future flag combination can quietly drop the separator or unglue it from
    // the host.
    for (const host of ['example.com', EVIL_HOST]) {
      for (const tty of [true, false]) {
        for (const baseOpts of [true, false]) {
          for (const opts of [[], ['-o', 'ConnectTimeout=10'], ['-N']]) {
            for (const command of [undefined, 'bash -lc true']) {
              const argv = buildSshArgv(host, { tty, baseOpts, opts, command });
              assertSeparatorGuardsHost(argv, host);
            }
          }
        }
      }
    }
  });

  it('`tty` prepends `-tt` BEFORE the base opts', () => {
    const argv = buildSshArgv('example.com', { tty: true });

    assert.strictEqual(argv[0], '-tt', '-tt is the first element');
    assert.deepStrictEqual(argv, ['-tt', ...SSH_BASE_OPTS, '--', 'example.com']);
  });

  it('omits `-tt` by default', () => {
    assert.ok(!buildSshArgv('example.com').includes('-tt'));
  });

  it('`baseOpts: false` emits no SSH_BASE_OPTS at all', () => {
    const argv = buildSshArgv('example.com', { baseOpts: false, opts: ['-N'] });

    assert.deepStrictEqual(argv, ['-N', '--', 'example.com']);
    for (const opt of SSH_BASE_OPTS) {
      // BatchMode / StrictHostKeyChecking / ServerAlive* must be absent — this is
      // what preserves sshControl's and ensureControlMaster's existing argv
      // exactly. (That divergence is deliberately NOT fixed here; the builder
      // only makes it a named, greppable decision instead of silent drift.)
      assert.ok(!argv.includes(opt), `${opt} absent under baseOpts:false`);
    }
  });

  it('`opts` land after the base opts and before the separator', () => {
    const argv = buildSshArgv('example.com', { opts: ['-o', 'ConnectTimeout=10'] });

    assert.deepStrictEqual(argv, [...SSH_BASE_OPTS, '-o', 'ConnectTimeout=10', '--', 'example.com']);
  });

  it('with no `command`, the host is the LAST element', () => {
    const argv = buildSshArgv('example.com', { opts: ['-N'] });

    assert.strictEqual(argv[argv.length - 1], 'example.com', 'nothing trails the host');
  });

  it('`command` is appended last, immediately after the host', () => {
    const argv = buildSshArgv('example.com', { command: 'bash -lc true' });

    assert.deepStrictEqual(argv.slice(-3), ['--', 'example.com', 'bash -lc true']);
  });

  it('an empty-string command is still appended (only `undefined` omits it)', () => {
    // `command: ''` must not be swallowed by a truthiness check — an empty remote
    // command is a different argv from no remote command at all (ssh opens a
    // login shell for the latter).
    assert.deepStrictEqual(buildSshArgv('h', { baseOpts: false, command: '' }), ['--', 'h', '']);
    assert.deepStrictEqual(buildSshArgv('h', { baseOpts: false }), ['--', 'h']);
  });

  it('is pure: repeated calls do not accumulate, and SSH_BASE_OPTS is not mutated', () => {
    const before = [...SSH_BASE_OPTS];
    const first = buildSshArgv('example.com', { opts: ['-N'] });
    const second = buildSshArgv('example.com', { opts: ['-N'] });

    assert.deepStrictEqual(first, second, 'same input → same argv');
    assert.notStrictEqual(first, second, 'a fresh array each call');
    assert.deepStrictEqual(SSH_BASE_OPTS, before, 'the shared base-opts array is never spread-into');
  });

  it('reproduces each of the 7 call sites element-for-element', () => {
    // Byte-identity guard for the WARDEN-989 extraction: if a future edit to the
    // builder changes any site's argv, this goes red naming the site.
    const H = EVIL_HOST;
    const SOCK = '/tmp/ssh-ctrl-1-host';
    const REMOTE = "bash -lc 'echo hi'";

    assert.deepStrictEqual(
      buildSshArgv(H, { baseOpts: false, opts: ['-O', 'check', '-S', SOCK] }),
      ['-O', 'check', '-S', SOCK, '--', H],
      'site 1/7 — sshControl');

    assert.deepStrictEqual(
      buildSshArgv(H, { baseOpts: false, opts: ['-o', 'ControlMaster=yes', '-o', 'ControlPath=' + SOCK, '-o', 'ControlPersist=10m', '-o', 'ConnectTimeout=10', '-N'] }),
      ['-o', 'ControlMaster=yes', '-o', 'ControlPath=' + SOCK, '-o', 'ControlPersist=10m', '-o', 'ConnectTimeout=10', '-N', '--', H],
      'site 2/7 — ensureControlMaster (still NO SSH_BASE_OPTS)');

    assert.deepStrictEqual(
      buildSshArgv(H, { opts: ['-o', 'ConnectTimeout=20', '-o', 'ControlPath=' + SOCK], command: REMOTE }),
      [...SSH_BASE_OPTS, '-o', 'ConnectTimeout=20', '-o', 'ControlPath=' + SOCK, '--', H, REMOTE],
      'site 3/7 — run(), pooled branch');

    assert.deepStrictEqual(
      buildSshArgv(H, { opts: ['-o', 'ConnectTimeout=20'], command: REMOTE }),
      [...SSH_BASE_OPTS, '-o', 'ConnectTimeout=20', '--', H, REMOTE],
      'site 3/7 — run(), unpooled branch');

    assert.deepStrictEqual(
      buildSshArgv(H, { tty: true, command: REMOTE }),
      ['-tt', ...SSH_BASE_OPTS, '--', H, REMOTE],
      'sites 4+5/7 — attach / attachPty (identical argv literal)');

    assert.deepStrictEqual(
      buildSshArgv(H, { opts: ['-o', 'ConnectTimeout=10'], command: '/tmp/companion' }),
      [...SSH_BASE_OPTS, '-o', 'ConnectTimeout=10', '--', H, '/tmp/companion'],
      'site 6/7 — spawnPersistentChannel');

    assert.deepStrictEqual(
      buildSshArgv(H, { opts: ['-o', 'ConnectTimeout=10'], command: REMOTE }),
      [...SSH_BASE_OPTS, '-o', 'ConnectTimeout=10', '--', H, REMOTE],
      'site 7/7 — streamFileToHost');
  });
});
