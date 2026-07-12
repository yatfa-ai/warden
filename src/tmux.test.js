import { describe, it, mock } from 'node:test';
import assert from 'node:assert';
import { send, parseMouseState } from './tmux.js';

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
    assert.strictEqual(parseMouseState(''), null);
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
