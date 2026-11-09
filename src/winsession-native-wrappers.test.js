import { describe, it, after } from 'node:test';
import assert from 'node:assert';
import { runNative, attachNative } from './winsession.js';

/**
 * runNative / attachNative are the thin wrappers over the process-wide shared
 * session manager that ssh.js routes native-Windows tmux argv through (behind
 * isNativeLocal(), false on Linux/macOS). winsession.test.js drives
 * createSessionManager with an injected spawnPty and never touches the shared
 * manager, so these pin the wrapper contract itself: ONE registry shared by
 * run and attach, argv passed through unchanged, {cols, rows} forwarded.
 *
 * WARDEN_WIN_SHELL=/bin/sh (read from process.env at spawn time) plus the real
 * node-pty makes this runnable on any platform with no module mocking.
 */

const NAME = `warden-native-wrappers-${process.pid}`;
const prevShell = process.env.WARDEN_WIN_SHELL;
process.env.WARDEN_WIN_SHELL = '/bin/sh';

after(async () => {
  try { await runNative(['kill-session', '-t', NAME]); } catch { /* best effort */ }
  if (prevShell === undefined) delete process.env.WARDEN_WIN_SHELL;
  else process.env.WARDEN_WIN_SHELL = prevShell;
});

describe('runNative / attachNative (shared session manager wrappers)', () => {
  it('runNative answers the preflight banner and an unknown has-session; opts are ignored', async () => {
    const v = await runNative(['-V'], { timeout: 1 });
    assert.strictEqual(v.ok, true);
    assert.match(v.stdout, /warden-native ConPTY/);

    const h = await runNative(['has-session', '-t', `${NAME}-unknown`], { timeout: 1 });
    assert.strictEqual(h.ok, false);
    assert.strictEqual(h.code, 1);
    assert.match(h.stderr, /can't find session/);
  });

  it('attachNative on an unknown session throws', () => {
    assert.throws(
      () => attachNative(['attach', '-t', `${NAME}-nope`], { cols: 80, rows: 24 }),
      new RegExp(`can't find session: ${NAME}-nope`),
    );
  });

  it('shares one registry across runNative and attachNative and forwards {cols, rows}', async () => {
    const created = await runNative(['new-session', '-d', '-s', NAME]);
    assert.strictEqual(created.ok, true, created.stderr);

    assert.strictEqual((await runNative(['has-session', '-t', NAME])).ok, true);
    const list = await runNative(['list-sessions', '-F', '#{session_name}']);
    assert.match(list.stdout, new RegExp(NAME));

    const client = attachNative(['attach', '-t', NAME], { cols: 91, rows: 23 });
    let out = '';
    const seen = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no "23 91" in output: ${JSON.stringify(out)}`)), 5000);
      client.onData((d) => {
        out += d;
        if (/\b23 91\b/.test(out)) { clearTimeout(timer); resolve(); }
      });
    });
    client.write('stty size\n');
    await seen;
    client.kill(); // detaches the client; the session survives
    assert.strictEqual((await runNative(['has-session', '-t', NAME])).ok, true);

    const killed = await runNative(['kill-session', '-t', NAME]);
    assert.strictEqual(killed.ok, true);
    assert.throws(() => attachNative(['attach', '-t', NAME], { cols: 91, rows: 23 }), /can't find session/);
  });
});
