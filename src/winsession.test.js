import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  isNativeLocal,
  Scrollback,
  quoteWinArg,
  buildLaunch,
  resolveShell,
  createSessionManager,
} from './winsession.js';
import { splitCmd, toMsysPath } from './ssh.js';

/**
 * WARDEN-922 — native local-Windows transport (ConPTY, no tmux/MSYS2/bash).
 *
 * These tests run on ANY platform: the session manager takes an injectable
 * `spawnPty` seam (the repo's standard alternative to module mocking — node:test's
 * mock.module is unavailable on Node 20, see ssh.test.js), so the Windows-only
 * behavior is fully assertable from a Linux CI runner. What they pin is the
 * contract the rest of Warden depends on: the same tmux argv in, the same
 * {ok, code, stdout, stderr} out, and an IPty-shaped attach handle.
 */

// A node-pty stand-in. `emit`/`exit` drive the callbacks node-pty would fire.
function fakePty() {
  const dataCbs = [];
  const exitCbs = [];
  const p = {
    pid: 4242,
    written: [],
    resized: [],
    killed: false,
    onData(cb) { dataCbs.push(cb); return { dispose() {} }; },
    onExit(cb) { exitCbs.push(cb); return { dispose() {} }; },
    write(d) { p.written.push(d); },
    resize(c, r) { p.resized.push([c, r]); },
    kill() { p.killed = true; },
    emit(d) { for (const cb of [...dataCbs]) cb(d); },
    exit(code) { for (const cb of [...exitCbs]) cb({ exitCode: code }); },
  };
  return p;
}

function harness(extra = {}) {
  const spawns = [];
  let last = null;
  const mgr = createSessionManager({
    spawnPty: (file, args, opts) => {
      last = fakePty();
      spawns.push({ file, args, opts, pty: last });
      return last;
    },
    env: { ComSpec: 'C:\\Windows\\system32\\cmd.exe' },
    comspec: 'C:\\Windows\\system32\\cmd.exe',
    shell: { file: 'powershell.exe', args: ['-NoLogo'] },
    ...extra,
  });
  return { mgr, spawns, pty: () => last };
}

const newSession = (name, ...tail) => ['new-session', '-d', '-s', name, '-x', '120', '-y', '32', ...tail];

const tick = () => new Promise((r) => setImmediate(r));

describe('isNativeLocal — which machines take the native path', () => {
  it('is true on win32 by default (that IS the change)', () => {
    assert.strictEqual(isNativeLocal({}, 'win32'), true);
  });

  it('is false on linux and darwin — they keep real tmux, untouched', () => {
    assert.strictEqual(isNativeLocal({}, 'linux'), false);
    assert.strictEqual(isNativeLocal({}, 'darwin'), false);
    // The escape hatch must not accidentally flip a non-Windows machine native.
    assert.strictEqual(isNativeLocal({ WARDEN_WIN_TMUX: '1' }, 'linux'), false);
  });

  it('WARDEN_WIN_TMUX=1 opts a Windows user back into the legacy MSYS2-tmux path', () => {
    assert.strictEqual(isNativeLocal({ WARDEN_WIN_TMUX: '1' }, 'win32'), false);
    // Only the exact "1" — a stray empty/other value must not silently disable
    // the native transport.
    assert.strictEqual(isNativeLocal({ WARDEN_WIN_TMUX: '0' }, 'win32'), true);
    assert.strictEqual(isNativeLocal({ WARDEN_WIN_TMUX: '' }, 'win32'), true);
  });
});

describe('Scrollback — the capture-pane model', () => {
  it('reports whether the current line is still open (capture() alone cannot say)', () => {
    // `capture()` joins with `\n` and drops the trailing empty element, so both a
    // stream ending on a newline and one parked mid-line render as text with no
    // trailing newline. The attach replay has to tell them apart to know whether
    // restoring a line ending is a repair or a fabrication.
    const s = new Scrollback();
    assert.strictEqual(s.openLine, false, 'a fresh scrollback has no open line');
    s.write('one\r\ntwo\r\n');
    assert.strictEqual(s.openLine, false, 'the stream ended on a newline');
    s.write('PROMPT> ');
    assert.strictEqual(s.openLine, true, 'the cursor sits after an unterminated prompt');
    assert.strictEqual(s.capture(), 'one\ntwo\nPROMPT> ');
  });

  it('splits on newlines and normalizes CRLF (Windows shells emit \\r\\n)', () => {
    const s = new Scrollback();
    s.write('one\r\ntwo\r\n');
    assert.strictEqual(s.capture(), 'one\ntwo');
  });

  it('a bare \\r restarts the line — a spinner reads as its LAST frame, not all of them', () => {
    const s = new Scrollback();
    s.write('working 10%\rworking 90%\rworking done\n');
    assert.strictEqual(s.capture(), 'working done');
  });

  it('\\b deletes the previous character (interactive line editing)', () => {
    const s = new Scrollback();
    s.write('cat\b\bar');
    assert.strictEqual(s.capture(), 'car');
  });

  it('keeps ANSI for -e and strips it otherwise', () => {
    const s = new Scrollback();
    s.write('\x1b[31mred\x1b[0m\n');
    assert.strictEqual(s.capture({ ansi: true }), '\x1b[31mred\x1b[0m');
    assert.strictEqual(s.capture({ ansi: false }), 'red');
  });

  it('honors a line depth (tmux -S -N) by returning the TAIL', () => {
    const s = new Scrollback();
    s.write('a\nb\nc\nd\n');
    assert.strictEqual(s.capture({ lines: 2 }), 'c\nd');
    assert.strictEqual(s.capture({ lines: null }), 'a\nb\nc\nd');
  });

  it('does not report the unterminated current line as a trailing blank', () => {
    const s = new Scrollback();
    s.write('a\n');
    assert.strictEqual(s.capture(), 'a', 'no phantom empty line after the newline');
  });

  it('is bounded — old lines are evicted rather than growing without limit', () => {
    const s = new Scrollback(3);
    s.write('1\n2\n3\n4\n5\n');
    assert.strictEqual(s.capture(), '3\n4\n5');
  });
});

describe('buildLaunch — how a command reaches ConPTY', () => {
  const shell = { file: 'powershell.exe', args: ['-NoLogo'] };
  const comspec = 'cmd.exe';

  it('no command → the native shell (this is what replaces bash)', () => {
    assert.deepStrictEqual(buildLaunch([], shell, comspec), { file: 'powershell.exe', args: ['-NoLogo'] });
  });

  it('a real .exe is spawned DIRECTLY — no shell layer in the process tree', () => {
    assert.deepStrictEqual(
      buildLaunch(['C:\\tools\\claude.exe', '--resume', 'abc'], shell, comspec),
      { file: 'C:\\tools\\claude.exe', args: ['--resume', 'abc'] },
    );
  });

  it('a .cmd shim goes through the command processor — CreateProcess cannot launch it', () => {
    // This is the concrete reason `claude --resume` could never work natively:
    // npm installs claude as claude.cmd, which is not an executable image.
    const r = buildLaunch(['C:\\npm\\claude.cmd', '--resume', 'abc'], shell, comspec);
    assert.strictEqual(r.file, 'cmd.exe');
    assert.strictEqual(r.args, '/d /s /c "C:\\npm\\claude.cmd --resume abc"');
  });

  it('quotes a path containing spaces so C:\\Program Files survives', () => {
    const r = buildLaunch(['C:\\Program Files\\npm\\claude.cmd', '--resume', 'abc'], shell, comspec);
    assert.strictEqual(
      r.args,
      '/d /s /c ""C:\\Program Files\\npm\\claude.cmd" --resume abc"',
      'inner quotes around the path; /s makes cmd strip exactly the outer pair',
    );
  });

  it('an extensionless command also routes through cmd (PATHEXT resolution is cmd\'s job)', () => {
    assert.strictEqual(buildLaunch(['claude'], shell, comspec).file, 'cmd.exe');
  });
});

describe('quoteWinArg', () => {
  it('leaves plain arguments untouched', () => {
    assert.strictEqual(quoteWinArg('--resume'), '--resume');
    assert.strictEqual(quoteWinArg('C:\\tools\\claude.exe'), 'C:\\tools\\claude.exe');
  });

  it('quotes anything cmd.exe would treat as syntax', () => {
    assert.strictEqual(quoteWinArg('C:\\Program Files\\x'), '"C:\\Program Files\\x"');
    assert.strictEqual(quoteWinArg('a&b'), '"a&b"');
    assert.strictEqual(quoteWinArg('a|b'), '"a|b"');
  });
});

describe('resolveShell — a Windows user gets a Windows shell', () => {
  it('prefers PowerShell when present', () => {
    const r = resolveShell({ SystemRoot: 'C:\\Windows' }, (p) => p.endsWith('powershell.exe'));
    assert.strictEqual(r.file, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  });

  it('falls back to %ComSpec% when PowerShell is absent — never to bash', () => {
    const r = resolveShell({ SystemRoot: 'C:\\Windows', ComSpec: 'C:\\Windows\\system32\\cmd.exe' }, () => false);
    assert.strictEqual(r.file, 'C:\\Windows\\system32\\cmd.exe');
  });

  it('WARDEN_WIN_SHELL overrides both', () => {
    const r = resolveShell({ WARDEN_WIN_SHELL: 'C:\\pwsh\\pwsh.exe' }, () => true);
    assert.deepStrictEqual(r, { file: 'C:\\pwsh\\pwsh.exe', args: [] });
  });
});

describe('session manager — the tmux argv subset, executed natively', () => {
  it('new-session spawns a pty with the requested cwd and geometry — no tmux, no MSYS', () => {
    const { mgr, spawns } = harness();
    return mgr.run(newSession('agent', '-c', 'C:\\work\\proj')).then((r) => {
      assert.strictEqual(r.ok, true);
      assert.strictEqual(spawns.length, 1);
      assert.strictEqual(spawns[0].file, 'powershell.exe', 'the native shell, not bash');
      assert.strictEqual(spawns[0].opts.cwd, 'C:\\work\\proj', 'the Windows path verbatim, not /c/work/proj');
      assert.strictEqual(spawns[0].opts.cols, 120);
      assert.strictEqual(spawns[0].opts.rows, 32);
      assert.strictEqual(spawns[0].opts.useConpty, true);
      assert.ok(!('MSYSTEM' in spawns[0].opts.env), 'no MSYS environment is injected');
    });
  });

  it('new-session runs an explicit command (the resume path) instead of the shell', async () => {
    const { mgr, spawns } = harness();
    await mgr.run(newSession('resume-abc', '-c', 'C:\\work', 'C:\\npm\\claude.cmd', '--resume', 'abc123'));
    assert.strictEqual(spawns[0].file, 'C:\\Windows\\system32\\cmd.exe');
    assert.strictEqual(spawns[0].args, '/d /s /c "C:\\npm\\claude.cmd --resume abc123"');
  });

  it('a duplicate session name is refused, like tmux', async () => {
    const { mgr } = harness();
    await mgr.run(newSession('agent'));
    const r = await mgr.run(newSession('agent'));
    assert.strictEqual(r.ok, false);
    assert.match(r.stderr, /duplicate session: agent/);
  });

  it('a pty that fails to spawn surfaces as a failed result, never a throw', async () => {
    const { mgr } = harness({ spawnPty: () => { throw new Error('boom'); } });
    const r = await mgr.run(newSession('agent'));
    assert.strictEqual(r.ok, false);
    assert.match(r.stderr, /failed to start session: boom/);
  });

  it('-V succeeds so the spawn/resume preflight passes with nothing installed', async () => {
    const { mgr } = harness();
    const r = await mgr.run(['-V']);
    assert.strictEqual(r.ok, true);
  });

  it('has-session / kill-session / list-sessions track the live registry', async () => {
    const { mgr, pty } = harness();
    assert.strictEqual((await mgr.run(['has-session', '-t', 'agent'])).ok, false);
    // No sessions → list-sessions is non-zero, which chats.js reads as "nothing
    // alive" (it returns an empty Set on !ok) — same as a tmux server that isn't running.
    assert.strictEqual((await mgr.run(['list-sessions', '-F', '#{session_name}'])).ok, false);

    await mgr.run(newSession('agent'));
    await mgr.run(newSession('other'));
    assert.strictEqual((await mgr.run(['has-session', '-t', 'agent'])).ok, true);
    const ls = await mgr.run(['list-sessions', '-F', '#{session_name}']);
    assert.deepStrictEqual(ls.stdout.split('\n').filter(Boolean), ['agent', 'other']);

    const live = pty();
    const k = await mgr.run(['kill-session', '-t', 'other']);
    assert.strictEqual(k.ok, true);
    assert.strictEqual(live.killed, true, 'the underlying pty is actually killed');
    assert.strictEqual((await mgr.run(['has-session', '-t', 'other'])).ok, false);
  });

  it('an op against an absent session fails with tmux\'s own wording', async () => {
    const { mgr } = harness();
    for (const args of [
      ['has-session', '-t', 'ghost'],
      ['kill-session', '-t', 'ghost'],
      ['capture-pane', '-t', 'ghost', '-p'],
      ['send-keys', '-t', 'ghost', '-l', 'hi'],
      ['display-message', '-p', '-t', 'ghost', '#{pane_current_path}'],
    ]) {
      const r = await mgr.run(args);
      assert.strictEqual(r.ok, false, `${args[0]} on a missing session fails`);
      assert.match(r.stderr, /can't find session: ghost/, `${args[0]} reports it the way tmux does`);
    }
  });

  it('capture-pane returns the pty output, ANSI only under -e', async () => {
    const { mgr, pty } = harness();
    await mgr.run(newSession('agent'));
    pty().emit('\x1b[32mhello\x1b[0m\r\nworld\r\n');

    const plain = await mgr.run(['capture-pane', '-t', 'agent', '-p', '-S', '-', '-E', '-']);
    assert.strictEqual(plain.stdout, 'hello\nworld');
    const colored = await mgr.run(['capture-pane', '-t', 'agent', '-p', '-e', '-S', '-500', '-E', '-']);
    assert.strictEqual(colored.stdout, '\x1b[32mhello\x1b[0m\nworld');
  });

  it('capture-pane -S -N returns only the last N lines', async () => {
    const { mgr, pty } = harness();
    await mgr.run(newSession('agent'));
    pty().emit('a\nb\nc\n');
    const r = await mgr.run(['capture-pane', '-t', 'agent', '-p', '-e', '-S', '-2', '-E', '-']);
    assert.strictEqual(r.stdout, 'b\nc');
  });

  it('send-keys -l writes literal text; a key name writes its bytes', async () => {
    const { mgr, pty } = harness();
    await mgr.run(newSession('agent'));
    await mgr.run(['send-keys', '-t', 'agent', '-l', 'hello world']);
    await mgr.run(['send-keys', '-t', 'agent', 'Enter']);
    await mgr.run(['send-keys', '-t', 'agent', 'C-c']);
    assert.deepStrictEqual(pty().written, ['hello world', '\r', '\x03']);
  });

  it('an unknown key is refused rather than written as raw text', async () => {
    const { mgr, pty } = harness();
    await mgr.run(newSession('agent'));
    const r = await mgr.run(['send-keys', '-t', 'agent', 'C-z']);
    assert.strictEqual(r.ok, false);
    assert.deepStrictEqual(pty().written, []);
  });

  it('multiline send: set-buffer → paste-buffer sends ONE block with \\r line endings', async () => {
    const { mgr, pty } = harness();
    await mgr.run(newSession('agent'));
    await mgr.run(['set-buffer', '-b', 'warden-send-1', '--', 'line1\nline2']);
    await mgr.run(['paste-buffer', '-p', '-d', '-b', 'warden-send-1', '-t', 'agent']);
    await mgr.run(['send-keys', '-t', 'agent', 'Enter']);
    assert.deepStrictEqual(pty().written, ['line1\rline2', '\r']);
  });

  it('paste is bracketed ONLY when the app enabled bracketed paste (DECSET 2004)', async () => {
    const { mgr, pty } = harness();
    await mgr.run(newSession('agent'));
    // The app announces bracketed-paste support on its own output stream.
    pty().emit('\x1b[?2004h');
    await mgr.run(['set-buffer', '-b', 'b1', '--', 'a\nb']);
    await mgr.run(['paste-buffer', '-p', '-d', '-b', 'b1', '-t', 'agent']);
    assert.deepStrictEqual(pty().written, ['\x1b[200~a\rb\x1b[201~']);

    // …and withdraws it. We must not "fix" an app that has opted out.
    pty().emit('\x1b[?2004l');
    await mgr.run(['set-buffer', '-b', 'b2', '--', 'c\nd']);
    await mgr.run(['paste-buffer', '-p', '-d', '-b', 'b2', '-t', 'agent']);
    assert.strictEqual(pty().written[1], 'c\rd');
  });

  it('paste-buffer -d reclaims the buffer; delete-buffer is the failure-path reclaim', async () => {
    const { mgr } = harness();
    await mgr.run(newSession('agent'));
    await mgr.run(['set-buffer', '-b', 'b1', '--', 'x']);
    await mgr.run(['paste-buffer', '-p', '-d', '-b', 'b1', '-t', 'agent']);
    assert.strictEqual(mgr._buffers.has('b1'), false, '-d deleted it on the happy path');

    await mgr.run(['set-buffer', '-b', 'b2', '--', 'y']);
    assert.strictEqual((await mgr.run(['delete-buffer', '-b', 'b2'])).ok, true);
    assert.strictEqual(mgr._buffers.has('b2'), false);
    // tmux.js swallows this error; it must be an error, not a silent success.
    assert.strictEqual((await mgr.run(['delete-buffer', '-b', 'b2'])).ok, false);
  });

  it('set-option window-size latest is a successful no-op (ConPTY has no window lock)', async () => {
    const { mgr } = harness();
    await mgr.run(newSession('agent'));
    assert.strictEqual((await mgr.run(['set-option', '-t', 'agent', 'window-size', 'latest'])).ok, true);
  });

  it('display-message reports the session cwd (chats.js pane_current_path)', async () => {
    const { mgr } = harness();
    await mgr.run(newSession('agent', '-c', 'C:\\work\\proj'));
    const r = await mgr.run(['display-message', '-p', '-t', 'agent', '#{pane_current_path}']);
    assert.strictEqual(r.stdout.trim(), 'C:\\work\\proj');
  });

  it('an unsupported tmux command fails loudly instead of pretending to succeed', async () => {
    const { mgr } = harness();
    const r = await mgr.run(['swap-window', '-s', '1', '-t', '2']);
    assert.strictEqual(r.ok, false);
    assert.match(r.stderr, /unknown command: swap-window/);
  });

  it('the session is dropped from the registry when its pty exits', async () => {
    const { mgr, pty } = harness();
    await mgr.run(newSession('agent'));
    pty().exit(0);
    assert.strictEqual((await mgr.run(['has-session', '-t', 'agent'])).ok, false);
  });
});

describe('attach — the live pane handle', () => {
  it('refuses to attach to a session that does not exist', async () => {
    const { mgr } = harness();
    assert.throws(() => mgr.attach(['attach', '-t', 'ghost']), /can't find session: ghost/);
  });

  it('streams live output and replays the existing scrollback on attach', async () => {
    const { mgr, pty } = harness();
    await mgr.run(newSession('agent'));
    pty().emit('already here\r\n');

    const client = mgr.attach(['attach', '-t', 'agent'], { cols: 80, rows: 24 });
    const seen = [];
    client.onData((d) => seen.push(d));
    await tick();
    assert.match(seen[0], /already here/, 'attach lands on existing content, not a blank pane');

    pty().emit('live output');
    assert.strictEqual(seen[seen.length - 1], 'live output');
  });

  it('replays multi-line history as CRLF, not bare LF (the pane would staircase)', async () => {
    // The pane's xterm is built with `convertEol: false` (PaneTile.tsx), so a bare
    // LF moves the cursor DOWN without returning it to column 0. The scrollback's
    // capture() is `\n`-joined by design (that IS what tmux capture-pane emits, and
    // its other consumers want it), so the conversion has to happen where the text
    // becomes a terminal BYTE STREAM. Asserted byte-for-byte: a regex match over a
    // single line cannot see a missing CR, which is how this passed before.
    const { mgr, pty } = harness();
    await mgr.run(newSession('agent'));
    pty().emit('PS C:\\Users\\me> dir\r\nfile1.txt\r\nfile2.txt\r\n');

    const client = mgr.attach(['attach', '-t', 'agent'], { cols: 80, rows: 24 });
    const seen = [];
    client.onData((d) => seen.push(d));
    await tick();
    assert.strictEqual(seen[0], 'PS C:\\Users\\me> dir\r\nfile1.txt\r\nfile2.txt\r\n');
  });

  it('does not append a line ending the terminal never emitted (the open-prompt case)', async () => {
    // What a shell looks like on essentially EVERY re-attach: the last thing the
    // pty printed is a prompt with no newline after it, and the cursor sits right
    // after it awaiting input. The replay's trailing `\r\n` exists only to restore
    // the ending `capture()` structurally drops when the stream DID end on a
    // newline (the line model's final '' element). Appending it here instead
    // fabricates a byte that was never in the stream, parking the pane's cursor at
    // column 0 of the row BELOW the shell's — so the first character typed renders
    // on the wrong row, and a TUI driving the screen with relative cursor motion
    // stays offset rather than self-correcting. Asserted byte-for-byte: no current
    // test used a payload lacking a trailing newline, which is why this passed.
    const { mgr, pty } = harness();
    await mgr.run(newSession('agent'));
    pty().emit('PS C:\\Users\\me> dir\r\nfile1.txt\r\nPS C:\\Users\\me> ');

    const client = mgr.attach(['attach', '-t', 'agent'], { cols: 80, rows: 24 });
    const seen = [];
    client.onData((d) => seen.push(d));
    await tick();
    assert.strictEqual(seen[0], 'PS C:\\Users\\me> dir\r\nfile1.txt\r\nPS C:\\Users\\me> ');
  });

  it('the replay is bounded to the client viewport, like tmux attach repainting the screen', async () => {
    // Our scrollback is a linear log of every line ever printed; a full-screen TUI
    // (Claude Code) redraws its whole frame continuously, so an unbounded replay
    // would push thousands of stale frames ahead of the live stream on EVERY attach.
    const { mgr, pty } = harness();
    await mgr.run(newSession('agent'));
    for (let i = 1; i <= 100; i++) pty().emit(`line ${i}\r\n`);

    const client = mgr.attach(['attach', '-t', 'agent'], { cols: 80, rows: 10 });
    const seen = [];
    client.onData((d) => seen.push(d));
    await tick();
    assert.strictEqual(seen[0], Array.from({ length: 10 }, (_, i) => `line ${91 + i}`).join('\r\n') + '\r\n');
  });

  it('output arriving during attach is queued BEHIND the replay, never ahead of it', async () => {
    // The replay is deferred one turn (so the caller can wire onExit first). Any
    // output the terminal produces in that window belongs AFTER the history it
    // follows — delivering it first would render the pane out of order.
    const { mgr, pty } = harness();
    await mgr.run(newSession('agent'));
    pty().emit('history line\r\n');

    const client = mgr.attach(['attach', '-t', 'agent']);
    const seen = [];
    client.onData((d) => seen.push(d));
    pty().emit('raced output'); // same tick as onData, before the deferred flush
    await tick();

    assert.match(seen[0], /history line/, 'the backlog is delivered first');
    assert.strictEqual(seen[1], 'raced output', 'the racing chunk follows it');
  });

  it('write and resize reach the real pty (resize IS the ConPTY SIGWINCH)', async () => {
    const { mgr, pty } = harness();
    await mgr.run(newSession('agent'));
    const client = mgr.attach(['attach', '-t', 'agent'], { cols: 80, rows: 24 });
    assert.deepStrictEqual(pty().resized, [[80, 24]], 'the attach geometry is applied immediately');

    client.write('ls\r');
    client.resize(140, 50);
    assert.deepStrictEqual(pty().written, ['ls\r']);
    assert.deepStrictEqual(pty().resized[1], [140, 50]);
  });

  it('kill() DETACHES the client — the session survives so re-attach works', async () => {
    const { mgr, pty } = harness();
    await mgr.run(newSession('agent'));
    const a = mgr.attach(['attach', '-t', 'agent']);
    const seen = [];
    a.onData((d) => seen.push(d));
    await tick();

    a.kill(); // server.js does exactly this on detach and on ws close
    assert.strictEqual(pty().killed, false, 'detaching a client must not kill the terminal');
    assert.strictEqual((await mgr.run(['has-session', '-t', 'agent'])).ok, true);

    const before = seen.length;
    pty().emit('after detach');
    assert.strictEqual(seen.length, before, 'a detached client receives nothing further');

    // Re-attach sees the terminal it left, including what happened while detached.
    const b = mgr.attach(['attach', '-t', 'agent']);
    const seenB = [];
    b.onData((d) => seenB.push(d));
    await tick();
    assert.match(seenB[0], /after detach/);
  });

  it('the session ending fires onExit on every attached client exactly once', async () => {
    const { mgr, pty } = harness();
    await mgr.run(newSession('agent'));
    const a = mgr.attach(['attach', '-t', 'agent']);
    const b = mgr.attach(['attach', '-t', 'agent']);
    const exits = [];
    a.onExit((e) => exits.push(['a', e.exitCode]));
    b.onExit((e) => exits.push(['b', e.exitCode]));

    pty().exit(3);
    assert.deepStrictEqual(exits, [['a', 3], ['b', 3]]);

    pty().exit(3); // a late duplicate must not double-report
    assert.strictEqual(exits.length, 2);
  });

  it('a client detached BEFORE the session ends gets no exit event', async () => {
    const { mgr, pty } = harness();
    await mgr.run(newSession('agent'));
    const a = mgr.attach(['attach', '-t', 'agent']);
    let exited = false;
    a.onExit(() => { exited = true; });
    a.kill();
    pty().exit(0);
    assert.strictEqual(exited, false, 'server.js already treats a killed pty\'s exit as stale (WARDEN-365)');
  });
});

describe('splitCmd — argv from a stored cmd string', () => {
  it('splits on whitespace exactly as before for unquoted input', () => {
    assert.deepStrictEqual(splitCmd('claude --resume abc'), ['claude', '--resume', 'abc']);
    assert.deepStrictEqual(splitCmd('  claude   --dangerously-skip-permissions '), ['claude', '--dangerously-skip-permissions']);
    assert.deepStrictEqual(splitCmd(''), []);
  });

  it('keeps a quoted path with spaces as ONE argument', () => {
    assert.deepStrictEqual(
      splitCmd('"C:\\Program Files\\npm\\claude.cmd" --resume abc'),
      ['C:\\Program Files\\npm\\claude.cmd', '--resume', 'abc'],
    );
  });

  it('preserves an explicitly empty quoted argument', () => {
    assert.deepStrictEqual(splitCmd('cmd "" x'), ['cmd', '', 'x']);
  });
});

describe('toMsysPath — MSYS translation is now legacy-only', () => {
  it('is identity on non-Windows (Linux/macOS behavior unchanged)', () => {
    assert.strictEqual(toMsysPath('/work/proj'), '/work/proj');
    assert.strictEqual(toMsysPath(''), '');
  });

  it('leaves a Windows path alone on a non-Windows runner', () => {
    // The win32-native branch (identity, so ConPTY gets a real Windows path)
    // cannot be exercised from Linux CI. What IS pinned cross-platform: the
    // manager suite asserts `-c C:\work\proj` reaches the pty's cwd untranslated,
    // which is the property that matters — no /c/work/proj ever reaches ConPTY.
    assert.strictEqual(toMsysPath('C:\\work\\proj'), 'C:\\work\\proj');
  });
});
