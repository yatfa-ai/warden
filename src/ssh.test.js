import { describe, it, mock } from 'node:test';
import assert from 'node:assert';
import { isTransportFailure, runWithPool, detectClaude } from './ssh.js';

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
