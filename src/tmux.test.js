import { describe, it, mock } from 'node:test';
import assert from 'node:assert';
import { send, parseMouseState, spawn, kill } from './tmux.js';

// WARDEN-254: multiline send must deliver one bracketed paste (+ a single
// submit), not N line-by-line submits. These tests drive the actual argv
// `send()` builds — they fail if multiline regresses to `send-keys -l` (the bug),
// if the bracketed-paste flag (`-p`) is dropped, or if the `--` separator that
// protects leading-dash data is removed.
//
// We inject `runTmux` through the deps seam (mirrors ssh.js runWithPool) because
// node:test mock.module is unavailable on Node 20 and child_process exports are
// non-configurable — see ssh.test.js header. No real tmux is spawned.

// Recording mock: returns {ok:true} for every call and captures the (chat, argv)
// of each, so a test can assert the exact tmux argv sequence send() produced.
function recordingRun() {
  const calls = [];
  const fn = mock.fn(async (chat, args) => {
    calls.push({ chat, args });
    return { ok: true, code: 0, stdout: '', stderr: '' };
  });
  return { fn, calls };
}

describe('tmux send() — bracketed paste for multiline (WARDEN-254)', () => {
  const chat = { host: '(local)', session: 'agent' };
  const cfg = {};

  it('single-line text is unchanged: send-keys -l then Enter, no buffer', async () => {
    const { fn, calls } = recordingRun();
    await send(chat, cfg, 'just one line', { runTmux: fn });
    assert.strictEqual(fn.mock.callCount(), 2, 'exactly two tmux calls (text + Enter)');
    assert.deepStrictEqual(calls[0].args, ['send-keys', '-t', 'agent', '-l', 'just one line']);
    assert.deepStrictEqual(calls[1].args, ['send-keys', '-t', 'agent', 'Enter']);
  });

  it('multiline text: one bracketed paste then a single Enter — not N line-submits', async () => {
    const { fn, calls } = recordingRun();
    await send(chat, cfg, 'line1\nline2\nline3', { runTmux: fn });
    assert.strictEqual(fn.mock.callCount(), 3, 'set-buffer + paste-buffer + one Enter');

    // [0] set-buffer -b <name> -- <full multiline text>
    assert.strictEqual(calls[0].args[0], 'set-buffer', 'loads the text into a named buffer');
    assert.strictEqual(calls[0].args[1], '-b');
    const bufName = calls[0].args[2];
    assert.ok(typeof bufName === 'string' && bufName.length > 0, 'buffer has a name');
    assert.strictEqual(calls[0].args[3], '--', 'data separated from flags so a leading "-" survives');
    assert.strictEqual(calls[0].args[4], 'line1\nline2\nline3', 'the full block is passed intact');

    // [1] paste-buffer -p -d -b <same name> -t <session>
    assert.strictEqual(calls[1].args[0], 'paste-buffer');
    assert.ok(calls[1].args.includes('-p'), 'bracketed-paste flag present (respects app DECSET 2004)');
    assert.ok(calls[1].args.includes('-d'), 'buffer deleted after paste (-d cleanup)');
    const bIdx = calls[1].args.indexOf('-b');
    assert.strictEqual(calls[1].args[bIdx + 1], bufName, 'pastes the SAME buffer it just set');
    const tIdx = calls[1].args.indexOf('-t');
    assert.strictEqual(calls[1].args[tIdx + 1], 'agent', 'targets this chat session');

    // [2] a single trailing Enter submits the whole block as one message
    assert.deepStrictEqual(calls[2].args, ['send-keys', '-t', 'agent', 'Enter']);
  });

  it('multiline starting with "-" is protected by the -- separator', async () => {
    const { fn, calls } = recordingRun();
    await send(chat, cfg, '-flag start\nsecond line', { runTmux: fn });
    // find the set-buffer call regardless of position
    const set = calls.find((c) => c.args[0] === 'set-buffer');
    assert.ok(set, 'multiline goes through set-buffer');
    assert.strictEqual(set.args[3], '--');
    assert.strictEqual(set.args[4], '-flag start\nsecond line', 'leading-dash data preserved verbatim');
  });

  it('each send uses a unique buffer name (concurrent sends cannot clobber)', async () => {
    const a = recordingRun();
    const b = recordingRun();
    await send(chat, cfg, 'a\nb', { runTmux: a.fn });
    await send(chat, cfg, 'c\nd', { runTmux: b.fn });
    const nameA = a.calls[0].args[2];
    const nameB = b.calls[0].args[2];
    assert.notStrictEqual(nameA, nameB, 'two sends get distinct buffer names');
    // each paste-buffer references its own set-buffer name
    assert.strictEqual(a.calls[1].args[a.calls[1].args.indexOf('-b') + 1], nameA);
    assert.strictEqual(b.calls[1].args[b.calls[1].args.indexOf('-b') + 1], nameB);
  });

  it('text with a trailing newline takes the bracketed path', async () => {
    const { fn, calls } = recordingRun();
    await send(chat, cfg, 'hello\n', { runTmux: fn });
    assert.strictEqual(calls[0].args[0], 'set-buffer');
    assert.strictEqual(calls[0].args[4], 'hello\n');
  });
});

// Unit tests for the Seamless-copy tmux helpers (WARDEN-261).
// parseMouseState is a pure function over `tmux show-options -g mouse` stdout,
// so it is tested directly. detectMouse/disableMouse shell out via runTmux and
// are exercised end-to-end elsewhere; their argv is a trivial constant.
describe('parseMouseState (WARDEN-261)', () => {
  it('reads the default show-options form (`mouse on` / `mouse off`)', () => {
    assert.strictEqual(parseMouseState('mouse on'), true);
    assert.strictEqual(parseMouseState('mouse off'), false);
  });

  it('reads the -v form (bare `on` / `off`)', () => {
    assert.strictEqual(parseMouseState('on'), true);
    assert.strictEqual(parseMouseState('off'), false);
  });

  it('tolerates surrounding whitespace / CRLF from an SSH pty', () => {
    assert.strictEqual(parseMouseState('mouse on\r\n'), true);
    assert.strictEqual(parseMouseState('  mouse off  \n'), false);
  });

  it('returns null for an unreadable / unknown value (never a false "on")', () => {
    // A failed read (host down, tmux error, no server, unexpected output) must
    // be null so the frontend never shows the "copy impaired" hint on a failure.
    assert.strictEqual(parseMouseState(''), null);
    assert.strictEqual(parseMouseState('   '), null);
    assert.strictEqual(parseMouseState('unknown option: mouse'), null);
    assert.strictEqual(parseMouseState(undefined), null);
    assert.strictEqual(parseMouseState(null), null);
  });

  it('is tri-state: the value is the last token; trailing junk is null', () => {
    // Defensive: we take the LAST whitespace-separated token as the value, which
    // is correct for both real forms (`mouse on`, `on`). A trailing token that
    // isn't exactly on/off stays null (never a false "on") — safe for the hint.
    assert.strictEqual(parseMouseState('set mouse off'), false);
    assert.strictEqual(parseMouseState('mouse on # comment'), null);
  });
});

// WARDEN-386: spawn/kill argv + companion routing. The deps seam this slice
// introduces (deps.runTmux / deps.spawnSession / deps.killSession /
// deps.isCompanionTransportEnabled) is what makes the lifecycle ops unit-testable
// without real ssh — mirroring how send's tests assert argv via deps.runTmux. No
// real tmux is spawned; the recording mocks capture the exact argv/params.

// A runTmux that should never be reached on the path under test — fails loudly.
function neverRun() {
  return mock.fn(() => { throw new Error('runTmux should not be called on this path'); });
}

// Recording companion-client mock: captures (host, params, cfg) and returns a
// canned result so a test can assert the params spawn()/kill() built AND the
// companion-or-fail routing, without a real channel.
function recordingClient(result = { ok: true }) {
  const calls = [];
  const fn = mock.fn(async (host, params, cfg) => {
    calls.push({ host, params, cfg });
    return result;
  });
  return { fn, calls };
}

describe('tmux spawn() — exact new-session argv (WARDEN-386)', () => {
  it('builds new-session -d -s <session> -x 120 -y 32 -c <cwd> <cmd> for a remote chat', async () => {
    const { fn, calls } = recordingRun();
    const chat = { host: 'prod-1', session: 'mysess', cwd: '/work/proj', cmd: 'claude --resume abc' };
    await spawn(chat, {}, { runTmux: fn, isCompanionTransportEnabled: () => false });
    assert.strictEqual(fn.mock.callCount(), 1);
    // detached, fixed initial size, cwd, then the cmd argv (split on whitespace).
    assert.deepStrictEqual(calls[0].args, [
      'new-session', '-d', '-s', 'mysess', '-x', '120', '-y', '32',
      '-c', '/work/proj', 'claude', '--resume', 'abc',
    ]);
  });

  it('passes cwd VERBATIM for a remote chat (msys translation is local-only)', async () => {
    // The remote branch is `chat.host === '(local)' ? toMsysPath(cwd) : cwd` — a
    // remote chat must take the else branch and pass chat.cwd untouched. On win32
    // a Windows-style cwd would be mangled if the branch were reversed; this
    // locks the verbatim passthrough (the cross-platform suite catches a win32
    // regression; on other platforms toMsysPath is identity, but the verbatim
    // equality still pins the contract).
    const { fn, calls } = recordingRun();
    const chat = { host: 'prod-1', session: 's', cwd: 'C:\\work\\proj', cmd: 'bash' };
    await spawn(chat, {}, { runTmux: fn, isCompanionTransportEnabled: () => false });
    const cwdIdx = calls[0].args.indexOf('-c');
    assert.ok(cwdIdx > -1, '-c present (cwd was set)');
    assert.strictEqual(calls[0].args[cwdIdx + 1], 'C:\\work\\proj', 'cwd passed verbatim, not msys-translated');
  });

  it('omits -c when cwd is empty', async () => {
    const { fn, calls } = recordingRun();
    const chat = { host: 'prod-1', session: 's', cwd: '', cmd: 'claude' };
    await spawn(chat, {}, { runTmux: fn, isCompanionTransportEnabled: () => false });
    assert.strictEqual(calls[0].args.includes('-c'), false, 'no -c when cwd is empty');
  });

  it('an EMPTY cmd appends no trailing argv → tmux default shell (WARDEN-223)', async () => {
    const { fn, calls } = recordingRun();
    // cmd omitted entirely AND cmd explicitly '' both yield no trailing argv.
    for (const cmd of [undefined, '']) {
      await spawn({ host: 'prod-1', session: 's', cwd: '', cmd }, {}, { runTmux: fn, isCompanionTransportEnabled: () => false });
    }
    for (const c of calls) {
      assert.deepStrictEqual(c.args, ['new-session', '-d', '-s', 's', '-x', '120', '-y', '32'],
        `empty cmd must not append trailing argv (got ${JSON.stringify(c.args)})`);
    }
  });

  it('throws on a failed spawn (non-zero exit) so /api/spawn surfaces a 500', async () => {
    const fail = mock.fn(async () => ({ ok: false, code: 1, stdout: '', stderr: 'duplicate session: s' }));
    await assert.rejects(
      () => spawn({ host: 'prod-1', session: 's', cwd: '', cmd: '' }, {}, { runTmux: fail, isCompanionTransportEnabled: () => false }),
      (e) => { assert.ok(e.message.includes('duplicate session'), e.message); return true; },
    );
  });

  it('a LOCAL chat keeps the runTmux fast path even with companion enabled', async () => {
    const { fn, calls } = recordingRun();
    const spawnSession = neverRun(); // companion must NOT be used for a local chat
    const chat = { host: '(local)', session: 's', cwd: '/tmp/x', cmd: 'bash' };
    await spawn(chat, {}, { runTmux: fn, isCompanionTransportEnabled: () => true, spawnSession });
    assert.strictEqual(fn.mock.callCount(), 1, 'local chat used runTmux');
    assert.strictEqual(spawnSession.mock.callCount(), 0, 'local chat did NOT route through the companion');
    assert.deepStrictEqual(calls[0].args, ['new-session', '-d', '-s', 's', '-x', '120', '-y', '32', '-c', '/tmp/x', 'bash']);
  });
});

describe('tmux spawn() — companion routing (WARDEN-386)', () => {
  it('a remote chat with companion enabled routes through spawnSession, NOT runTmux', async () => {
    const { fn, calls } = recordingClient({ ok: true });
    const runTmux = neverRun();
    const chat = { host: 'prod-1', container: 'p-worker', session: 'agent', cwd: '/work/p', cmd: 'claude --resume xyz' };
    const r = await spawn(chat, {}, { runTmux, isCompanionTransportEnabled: () => true, spawnSession: fn });
    assert.strictEqual(r, true);
    assert.strictEqual(fn.mock.callCount(), 1, 'routed through spawnSession');
    assert.strictEqual(runTmux.mock.callCount(), 0, 'did NOT use runTmux');
    // The params carry the semantic fields the host-side RPC builds the argv from:
    // container (docker-exec prefix), session, cwd VERBATIM, and the split cmd argv.
    assert.strictEqual(calls[0].host, 'prod-1');
    assert.deepStrictEqual(calls[0].params, {
      container: 'p-worker', session: 'agent', cwd: '/work/p', cmd: ['claude', '--resume', 'xyz'],
    });
  });

  it('a bare-tmux (manual) chat passes container:null so the host uses bare tmux', async () => {
    const { fn, calls } = recordingClient({ ok: true });
    const chat = { host: 'prod-1', container: null, session: 'mysess', cwd: '', cmd: '' };
    await spawn(chat, {}, { isCompanionTransportEnabled: () => true, spawnSession: fn });
    assert.strictEqual(calls[0].params.container, null, 'manual chat → container null → bare tmux on the host');
    assert.deepStrictEqual(calls[0].params.cmd, [], 'empty cmd → empty argv → default shell');
  });

  it('throws on a companion spawn failure (companion-or-fail: no silent runTmux fallback)', async () => {
    const { fn } = recordingClient({ ok: false, error: 'spawnSession failed: duplicate session: agent' });
    const runTmux = neverRun();
    await assert.rejects(
      () => spawn({ host: 'prod-1', session: 'agent', cwd: '', cmd: 'claude' }, {},
        { runTmux, isCompanionTransportEnabled: () => true, spawnSession: fn }),
      (e) => { assert.ok(e.message.includes('duplicate session'), e.message); return true; },
    );
    assert.strictEqual(runTmux.mock.callCount(), 0, 'did NOT fall back to runTmux on companion failure');
  });

  it('a remote chat with companion DISABLED uses runTmux (the default path is unchanged)', async () => {
    const { fn, calls } = recordingRun();
    const spawnSession = neverRun();
    await spawn({ host: 'prod-1', session: 's', cwd: '', cmd: 'claude' }, {},
      { runTmux: fn, isCompanionTransportEnabled: () => false, spawnSession });
    assert.strictEqual(fn.mock.callCount(), 1);
    assert.strictEqual(spawnSession.mock.callCount(), 0);
    assert.deepStrictEqual(calls[0].args, ['new-session', '-d', '-s', 's', '-x', '120', '-y', '32', 'claude']);
  });
});

describe('tmux kill() — kill-session argv + best-effort (WARDEN-386)', () => {
  it('builds kill-session -t <session> (default path)', async () => {
    const { fn, calls } = recordingRun();
    await kill({ host: 'prod-1', session: 'mysess' }, {}, { runTmux: fn, isCompanionTransportEnabled: () => false });
    assert.strictEqual(fn.mock.callCount(), 1);
    assert.deepStrictEqual(calls[0].args, ['kill-session', '-t', 'mysess']);
  });

  it('a remote chat with companion enabled routes through killSession, NOT runTmux', async () => {
    const { fn, calls } = recordingClient({ ok: true });
    const runTmux = neverRun();
    const chat = { host: 'prod-1', container: 'p-worker', session: 'agent' };
    await kill(chat, {}, { runTmux, isCompanionTransportEnabled: () => true, killSession: fn });
    assert.strictEqual(fn.mock.callCount(), 1);
    assert.strictEqual(runTmux.mock.callCount(), 0);
    assert.deepStrictEqual(calls[0].params, { container: 'p-worker', session: 'agent' });
  });

  it('kill is BEST-EFFORT: a companion failure does NOT throw (mirrors runTmux resolve-not-throw)', async () => {
    // The default runTmux path never throws on a kill-session failure (runWithPool
    // catches HostConnectionError → run() resolves {ok:false}); the companion path
    // must match that so /api/kill's try/catch-noop best-effort semantics hold.
    const { fn } = recordingClient({ ok: false, error: 'killSession failed: tmux missing' });
    await assert.doesNotReject(
      () => kill({ host: 'prod-1', session: 's' }, {}, { isCompanionTransportEnabled: () => true, killSession: fn }),
    );
    assert.strictEqual(fn.mock.callCount(), 1, 'killSession was still invoked');
  });

  it('a LOCAL chat keeps the runTmux fast path even with companion enabled', async () => {
    const { fn, calls } = recordingRun();
    const killSession = neverRun();
    await kill({ host: '(local)', session: 's' }, {}, { runTmux: fn, isCompanionTransportEnabled: () => true, killSession });
    assert.strictEqual(fn.mock.callCount(), 1);
    assert.strictEqual(killSession.mock.callCount(), 0);
    assert.deepStrictEqual(calls[0].args, ['kill-session', '-t', 's']);
  });
});
