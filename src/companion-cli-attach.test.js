// Tests for the companion CLI attach surfaces — WARDEN-1364 (roadmap WARDEN-270,
// the thrice-deferred named follow-up to WARDEN-1283/1295/1329).
//
// Two raw-SSH legs move onto the shipped companion channel, and one real crash
// is fixed in passing:
//
//   `warden attach`  — attachInteractive (tmux.js) is gated onto the attachSession
//                      PTY family (the CLI mirror of attachStream's WARDEN-1295
//                      gate), with a terminal bridge (rawMode stdin → attachInput,
//                      attachData → stdout, SIGWINCH → attachResize, attachExit →
//                      exit code) where the streaming sibling has server.js.
//   `warden dash`    — preflight rides the shared deliverRemoteScript router
//                      (→ exec; the WARDEN-1283 preflightTmux mirror) and the
//                      attach leg rides the same interactive bridge. And on the
//                      DEFAULT path, `attach` is finally imported from ssh.js —
//                      before this slice every non-dry-run remote `warden dash`
//                      died with `ReferenceError: attach is not defined` right
//                      after the preflight.
//
// Four contracts, each a distinct failure mode (the companion-exec-legs.test.js
// discipline, applied to the interactive family):
//
//   PARITY             the delivered host-side commands are BYTE-FOR-BYTE today's
//                      — attach (composed `tmux attach …; <shell>` incl. the
//                      docker-exec -it prefix and WARDEN-140 quoting), dash attach
//                      (the multi-window script), preflight (`command -v tmux …`).
//                      Pinned by delivered-string tests, not by reading literals
//                      side by side.
//   DELEGATION         under the flag a REMOTE call issues ZERO ssh spawns —
//                      every seam that would spawn (run / attach /
//                      attachInteractiveTmux) is a recorder that fails the test
//                      if touched.
//   COMPANION-OR-FAIL  a dead channel or stale binary surfaces the actionable
//                      error (stderr + non-zero exit) and NEVER consults the raw
//                      path as a fallback. The promise still resolves (WARDEN-464).
//   FLAG-OFF / LOCAL   the default path and LOCAL hosts are byte-for-byte
//                      unchanged — and the flag-off dash now REACHES the real
//                      attach instead of crashing on the dangling reference.
//
// Everything runs through injected seams / fake sessions — no real ssh, no real
// terminal.
import { describe, it, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

// cli.js runs main() at import (argv is empty under the test runner → it prints
// help and returns), and config.js reads HOME — redirect HOME before the single
// import (the companion-exec-legs.test.js discipline).
const TEMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-1364-home-'));
process.env.HOME = TEMP_HOME;

const { attachInteractive, attachInteractiveCompanion } = await import('./tmux.js');
const { buildAttachInteractiveCommand, buildAttachRemoteScript, shellQuote } = await import('./ssh.js');
const { cmdDash, buildDashScript } = await import('./cli.js');

const REMOTE = 'prod-1';
const LOCAL = '(local)';

after(() => {
  try { fs.rmSync(TEMP_HOME, { recursive: true, force: true }); } catch { /* best-effort */ }
});

// A fake stdin/stdout/stderr triple: real-enough TTY semantics (isTTY, isRaw,
// setRawMode, pause/resume) with recorded calls, and zero real streams touched.
function fakeStdio({ tty = true, cols = 120, rows = 40 } = {}) {
  const calls = { setRawMode: [], pause: 0, writes: [], errs: [] };
  const stdin = new EventEmitter();
  stdin.isTTY = tty;
  stdin.isRaw = false;
  stdin.setRawMode = (v) => { calls.setRawMode.push(v); stdin.isRaw = v; };
  stdin.pause = () => { calls.pause++; };
  stdin.resume = () => {};
  const stdout = { columns: cols, rows, write: (d) => { calls.writes.push(d); } };
  const stderr = { write: (d) => { calls.errs.push(d); } };
  return { stdin, stdout, stderr, calls };
}

// A fake CompanionAttachSession: the five IPty members the bridge drives, each
// recorded; the test fires onData/onExit by hand. `failSync` models
// attachPreflight's sync verdicts (stale binary / no PTY), which THROW out of
// attachSession before any handle exists; `exitError` models an async startup
// failure, which settles as onExit({exitCode:-1}) carrying the message.
function fakeSession({ failSync = null, exitError = null } = {}) {
  const rec = { writes: [], resizes: [], dataCbs: [], exitCbs: [], killed: 0 };
  if (failSync) {
    return { rec, session: null, factory: () => { throw new Error(failSync); } };
  }
  const session = {
    _exitError: exitError,
    onData(cb) { rec.dataCbs.push(cb); },
    onExit(cb) { rec.exitCbs.push(cb); },
    write(d) { rec.writes.push(d); },
    resize(c, r) { rec.resizes.push([c, r]); },
    kill() { rec.killed++; },
  };
  return { rec, session, factory: () => session };
}

// ------------------- parity: the composed attach command ---------------------

describe('buildAttachInteractiveCommand — the composed `tmux attach; <shell>` string (WARDEN-1364 parity)', () => {
  it('docker chat: -it prefix on BOTH the tmux leg and the post-detach shell, WARDEN-140 quoting — byte-for-byte', () => {
    const chat = { host: 'prod', container: 'p-worker', session: 'agent' };
    const delivered = buildAttachInteractiveCommand(chat, ['attach', '-t', 'agent']);
    // Pinned literally — the exact string attachInteractiveTmux composed inline
    // before this slice (ssh.js, pre-1364 remote branch).
    assert.strictEqual(delivered, `docker exec -it 'p-worker' tmux 'attach' '-t' 'agent'; docker exec -it 'p-worker' bash`);
  });

  it('bare-host chat, no cwd: bare tmux + bare bash — no docker anywhere', () => {
    const delivered = buildAttachInteractiveCommand({ host: 'prod', container: null, session: 'agent' }, ['attach', '-t', 'agent']);
    assert.strictEqual(delivered, `tmux 'attach' '-t' 'agent'; bash`);
    assert.ok(!delivered.includes('docker'));
  });

  it('bare-host chat with cwd: the WARDEN-81 cd && exec bash tail, quoted', () => {
    const delivered = buildAttachInteractiveCommand({ host: 'prod', container: null, session: 'agent', cwd: '/srv/app' }, ['attach', '-t', 'agent']);
    assert.strictEqual(delivered, `tmux 'attach' '-t' 'agent'; bash -lc 'cd '\\''/srv/app'\\'' && exec bash'`);
  });

  it('a session name needing quoting survives verbatim (the quoting is the parity)', () => {
    const delivered = buildAttachInteractiveCommand({ host: 'prod', container: null, session: "we're" }, ['attach', '-t', "we're"]);
    assert.ok(delivered.includes(`'\\''`), `embedded quotes are escaped: ${delivered}`);
  });

  it('the CLI gate delivers buildAttachRemoteScript(<that exact string>) — the web-pane wrapper', () => {
    const chat = { host: 'prod', container: 'p-worker', session: 'agent' };
    let script = null;
    attachInteractive(chat, {}, {
      isCompanionTransportEnabled: () => true,
      attachInteractiveCompanion: (_host, s) => { script = s; return Promise.resolve(0); },
    });
    const inner = buildAttachInteractiveCommand(chat, ['attach', '-t', 'agent']);
    assert.strictEqual(script, buildAttachRemoteScript(inner));
    // And the inner command rides VERBATIM inside the wrapper — byte-for-byte
    // today's composed string, not a rebuilt one.
    assert.ok(script.endsWith(shellQuote(inner)), 'the composed attach command is carried verbatim');
    assert.ok(script.startsWith('export LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8; '),
      'the UTF-8 locale export rides along (tmux box-drawing renders correctly)');
  });
});

// ------------------------- the attachInteractive gate ------------------------

describe('attachInteractive routing (WARDEN-1364)', () => {
  const remoteChat = { host: REMOTE, container: 'p-worker', session: 'agent' };
  const localChat = { host: LOCAL, container: null, session: 'agent' };

  it('REMOTE + enabled → the companion bridge; ZERO default-path calls', async () => {
    let bridgeCalls = 0; let tmuxCalls = 0;
    let seenHost = null; let seenCfg = null;
    const code = await attachInteractive(remoteChat, { tmuxSession: 'agent' }, {
      isCompanionTransportEnabled: () => true,
      attachInteractiveCompanion: (host, _script, cfg) => { bridgeCalls++; seenHost = host; seenCfg = cfg; return Promise.resolve(0); },
      attachInteractiveTmux: () => { tmuxCalls++; return Promise.resolve(0); },
    });
    assert.strictEqual(bridgeCalls, 1, 'the interactive session went over the channel');
    assert.strictEqual(tmuxCalls, 0, 'attachInteractiveTmux (the fresh-ssh-per-attach path) was never touched');
    assert.strictEqual(seenHost, REMOTE);
    assert.deepStrictEqual(seenCfg, { tmuxSession: 'agent' }, 'cfg threads through to the bridge');
    assert.strictEqual(code, 0, 'the bridge exit code is returned to the CLI');
  });

  it('LOCAL never routes through the companion, even with the toggle on', async () => {
    let bridgeCalls = 0; let tmuxCalls = 0; let seenArgs = null;
    await attachInteractive(localChat, {}, {
      isCompanionTransportEnabled: () => true,
      attachInteractiveCompanion: () => { bridgeCalls++; return Promise.resolve(0); },
      attachInteractiveTmux: (_chat, args) => { tmuxCalls++; seenArgs = args; return Promise.resolve(0); },
    });
    assert.strictEqual(bridgeCalls, 0, 'LOCAL is served by attachInteractiveTmux, never the companion');
    assert.strictEqual(tmuxCalls, 1);
    assert.deepStrictEqual(seenArgs, ['attach', '-t', 'agent'], 'the default argv is unchanged');
  });

  it('toggle OFF keeps the default path byte-for-byte (the companion is never consulted)', async () => {
    let bridgeCalls = 0; let seen = null;
    await attachInteractive(remoteChat, {}, {
      isCompanionTransportEnabled: () => false,
      attachInteractiveCompanion: () => { bridgeCalls++; return Promise.resolve(0); },
      attachInteractiveTmux: (c, args) => { seen = { chat: c, args }; return Promise.resolve(0); },
    });
    assert.strictEqual(bridgeCalls, 0, 'toggle off must not reach the companion at all');
    assert.deepStrictEqual(seen.args, ['attach', '-t', 'agent']);
    assert.strictEqual(seen.chat, remoteChat);
  });
});

// --------------------------- the terminal bridge -----------------------------

describe('attachInteractiveCompanion — the CLI terminal bridge (WARDEN-1364)', () => {
  it('wires the four bridges: stdin→write, attachData→stdout, resize, exit code', async () => {
    const { rec, factory } = fakeSession();
    const stdio = fakeStdio();
    const winchBefore = process.listenerCount('SIGWINCH');
    const p = attachInteractiveCompanion(REMOTE, 'SCRIPT', {}, {
      ...stdio, companionAttachSession: factory,
    });
    assert.strictEqual(rec.resizes.length, 1, 'one sizing call up front (host PTY sized to the terminal)');
    assert.deepStrictEqual(rec.resizes[0], [120, 40]);

    // keystrokes: rawMode stdin 'data' → session.write
    stdio.stdin.emit('data', 'hello');
    assert.deepStrictEqual(rec.writes, ['hello']);
    // rendering: attachData → stdout
    rec.dataCbs.forEach((cb) => cb('\x1b[31mRED'));
    assert.deepStrictEqual(stdio.calls.writes, ['\x1b[31mRED']);
    // resize: SIGWINCH → attachResize with the CURRENT terminal size
    stdio.stdout.columns = 200; stdio.stdout.rows = 50;
    process.emit('SIGWINCH');
    assert.deepStrictEqual(rec.resizes[1], [200, 50]);
    // exit: attachExit → resolve(code), terminal restored, listener removed
    rec.exitCbs.forEach((cb) => cb({ exitCode: 0 }));
    assert.strictEqual(await p, 0);
    assert.strictEqual(stdio.calls.pause, 1, 'stdin paused on exit');
    assert.deepStrictEqual(stdio.calls.setRawMode, [true, false], 'raw mode set for the session, restored after');
    assert.strictEqual(process.listenerCount('SIGWINCH'), winchBefore, 'the SIGWINCH listener is removed on exit');
    // and a keystroke after exit is not forwarded
    stdio.stdin.emit('data', 'x');
    assert.deepStrictEqual(rec.writes, ['hello']);
  });

  it('non-TTY stdin is driven without raw mode (piped/CI), still resolving cleanly', async () => {
    const { rec, factory } = fakeSession();
    const stdio = fakeStdio({ tty: false });
    const p = attachInteractiveCompanion(REMOTE, 'SCRIPT', {}, { ...stdio, companionAttachSession: factory });
    rec.exitCbs.forEach((cb) => cb({ exitCode: 0 }));
    assert.strictEqual(await p, 0);
    assert.deepStrictEqual(stdio.calls.setRawMode, [], 'no raw mode without a TTY');
  });

  it('a NON-ZERO attachExit resolves that code (never rejects — WARDEN-464)', async () => {
    const { rec, factory } = fakeSession();
    const stdio = fakeStdio();
    const p = attachInteractiveCompanion(REMOTE, 'SCRIPT', {}, { ...stdio, companionAttachSession: factory });
    rec.exitCbs.forEach((cb) => cb({ exitCode: 3 }));
    assert.strictEqual(await p, 3);
  });

  it('a startup failure settles as exit -1 WITH the actionable message on stderr', async () => {
    const { rec, factory } = fakeSession({ exitError: new Error('companion binary on prod-1 is too old: it does not advertise attachStart') });
    const stdio = fakeStdio();
    const p = attachInteractiveCompanion(REMOTE, 'SCRIPT', {}, { ...stdio, companionAttachSession: factory });
    rec.exitCbs.forEach((cb) => cb({ exitCode: -1 }));
    assert.strictEqual(await p, -1, 'the async failure resolves non-zero — never a raw-SSH fallback');
    assert.strictEqual(stdio.calls.errs.length, 1);
    assert.ok(stdio.calls.errs[0].includes('too old'), `the actionable message is surfaced: ${stdio.calls.errs[0]}`);
  });

  it('a channel death mid-session (exit -1, no stored error) still tells the user what happened', async () => {
    const { rec, factory } = fakeSession();
    const stdio = fakeStdio();
    const p = attachInteractiveCompanion(REMOTE, 'SCRIPT', {}, { ...stdio, companionAttachSession: factory });
    rec.exitCbs.forEach((cb) => cb({ exitCode: -1 }));
    assert.strictEqual(await p, -1);
    assert.strictEqual(stdio.calls.errs.length, 1);
    assert.ok(stdio.calls.errs[0].includes('WARDEN_COMPANION_TRANSPORT=0'), stdio.calls.errs[0]);
  });

  it('a sync-visible failure (stale binary / no PTY) resolves 1 with the actionable error on stderr — no session, no fallback', async () => {
    const { factory } = fakeSession({ failSync: 'companion binary on prod-1 is too old (ping methods: ping)' });
    const stdio = fakeStdio();
    const winchBefore = process.listenerCount('SIGWINCH');
    const code = await attachInteractiveCompanion(REMOTE, 'SCRIPT', {}, { ...stdio, companionAttachSession: factory });
    assert.strictEqual(code, 1);
    assert.strictEqual(stdio.calls.errs.length, 1);
    assert.ok(stdio.calls.errs[0].includes('companion attach on prod-1 failed'), stdio.calls.errs[0]);
    assert.ok(stdio.calls.errs[0].includes('too old'), stdio.calls.errs[0]);
    assert.strictEqual(stdio.calls.setRawMode.length, 0, 'the terminal is never captured on a failed start');
    assert.strictEqual(process.listenerCount('SIGWINCH'), winchBefore, 'no SIGWINCH listener leaked');
  });

  it('script, geometry and cfg are handed to attachSession verbatim', async () => {
    const stdio = fakeStdio();
    let params = null;
    const p = attachInteractiveCompanion(REMOTE, 'SCRIPT', { cfgKey: 1 }, {
      ...stdio,
      companionAttachSession: (host, opts, cfg) => {
        params = { host, opts, cfg };
        // The bridge registers onExit right after the factory returns, so the
        // exit must fire on a later tick to be observed.
        const { rec, session } = fakeSession();
        queueMicrotask(() => rec.exitCbs.forEach((cb) => cb({ exitCode: 0 })));
        return session;
      },
    });
    assert.strictEqual(await p, 0);
    assert.strictEqual(params.host, REMOTE);
    assert.strictEqual(params.opts.script, 'SCRIPT');
    assert.strictEqual(params.opts.cols, 120);
    assert.strictEqual(params.opts.rows, 40);
    assert.deepStrictEqual(params.cfg, { cfgKey: 1 });
  });
});

// ------------------------------- dash: the script ----------------------------

describe('buildDashScript — the multi-window host script (WARDEN-1364 parity)', () => {
  it('one active chat: kill-session, new-session, foreground attach — byte-for-byte', () => {
    const script = buildDashScript('warden', ['p-worker']);
    assert.strictEqual(script,
      'tmux kill-session -t warden 2>/dev/null || true\n' +
      'tmux new-session -d -s warden -n p-worker "docker exec -it p-worker tmux attach -t agent"\n' +
      'tmux attach -t warden');
  });

  it('N active chats: window 1 is new-session, the rest are new-window, in order', () => {
    const script = buildDashScript('dash', ['a', 'b', 'c']);
    assert.strictEqual(script,
      'tmux kill-session -t dash 2>/dev/null || true\n' +
      'tmux new-session -d -s dash -n a "docker exec -it a tmux attach -t agent"\n' +
      'tmux new-window -t dash -n b "docker exec -it b tmux attach -t agent"\n' +
      'tmux new-window -t dash -n c "docker exec -it c tmux attach -t agent"\n' +
      'tmux attach -t dash');
  });
});

// ------------------------------ dash: routing --------------------------------

const activeChats = (names) => names.map((c) => ({ container: c, active: true, host: REMOTE, session: 'agent' }));

// The deps block for cmdDash: discovery injected (zero real ssh), every
// transport a recorder that FAILS the test if a forbidden path is touched.
// `fakeRouter` arms the deliverRemoteScript seam as a tripwire (flag-off tests:
// the router must never be consulted); flag-on tests deliberately leave it
// UNSET so the REAL deliverRemoteScript routes into the execInContext recorder.
function dashDeps({ on = false, chats = ['p-worker'], fakeRouter = false } = {}) {
  const d = {
    on, chats,
    discoverCalls: 0,
    runCalls: [],            // the raw preflight path (flag-off)
    attachCalls: [],         // the raw attach path (flag-off)
    execCalls: [],           // execInContext under the flag
    bridgeCalls: [],         // the companion attach leg under the flag
    exits: [],
    dies: [],
  };
  const deps = {
    isCompanionTransportEnabled: () => d.on,
    discover: async () => { d.discoverCalls++; return { ok: true, chats: activeChats(chats) }; },
    run: async (host, cmd, opts) => { d.runCalls.push({ host, cmd, opts }); return { ok: true, code: 0, stdout: 'OK', stderr: '' }; },
    attach: async (host, cmd) => { d.attachCalls.push({ host, cmd }); return 7; },
    execInContext: async (host, script, opts, cfg) => { d.execCalls.push({ host, script, opts, cfg }); return { ok: true, code: 0, stdout: 'OK', stderr: '' }; },
    attachInteractiveCompanion: (host, script, cfg) => { d.bridgeCalls.push({ host, script, cfg }); return Promise.resolve(0); },
    die: (msg) => { d.dies.push(msg); },
    exit: (code) => { d.exits.push(code); },
  };
  if (fakeRouter) deps.deliverRemoteScript = () => { throw new Error('the companion router must not be consulted'); };
  return { deps, d };
}

describe('cmdDash companion routing (WARDEN-1364)', () => {
  it('flag ON: preflight via the shared router → exec; attach via the bridge; ZERO ssh legs', async () => {
    const { deps, d } = dashDeps({ on: true, chats: ['p-worker', 'p-planner'] });
    await cmdDash(['--host', REMOTE], {}, deps);
    assert.strictEqual(d.execCalls.length, 1, 'the preflight rode exec once (through the REAL deliverRemoteScript)');
    assert.strictEqual(d.execCalls[0].host, REMOTE);
    assert.strictEqual(d.execCalls[0].script, 'command -v tmux >/dev/null 2>&1 && echo OK || echo MISSING',
      'the preflight script is byte-for-byte the raw-SSH string');
    assert.strictEqual(d.execCalls[0].opts.timeout, 8000, 'the preflight keeps its deadline');
    assert.strictEqual(d.runCalls.length, 0, 'DELEGATION: the raw preflight never ran');
    assert.strictEqual(d.attachCalls.length, 0, 'DELEGATION: the raw attach never ran');
    assert.strictEqual(d.bridgeCalls.length, 1, 'the attach leg rode the companion bridge');
    assert.strictEqual(d.bridgeCalls[0].host, REMOTE);
    assert.strictEqual(
      d.bridgeCalls[0].script,
      buildAttachRemoteScript(buildDashScript('warden', ['p-worker', 'p-planner'])),
      'the multi-window script rides under the same buildAttachRemoteScript wrapper the web pane uses',
    );
    assert.ok(d.bridgeCalls[0].script.includes('tmux new-window -t warden -n p-planner'),
      'both windows are inside the delivered script');
    assert.deepStrictEqual(d.exits, [0]);
    assert.strictEqual(d.dies.length, 0);
  });

  it('flag ON + dead channel: the preflight dies with the actionable error — companion-or-fail, no raw fallback', async () => {
    const { deps, d } = dashDeps({ on: true });
    deps.execInContext = async () => ({
      host: REMOTE, ok: false, code: -1, stdout: '',
      stderr: `companion transport error for ${REMOTE}: channel died. Set WARDEN_COMPANION_TRANSPORT=0 to use the default SSH path.`,
    });
    await cmdDash(['--host', REMOTE], {}, deps);
    assert.strictEqual(d.dies.length, 1, 'the failure is actionable, not a silent "no tmux"');
    assert.ok(d.dies[0].includes('companion preflight on prod-1 failed'), d.dies[0]);
    assert.ok(d.dies[0].includes('channel died'), 'the underlying stderr rides the message');
    assert.ok(d.dies[0].includes('WARDEN_COMPANION_TRANSPORT=0'), 'the recovery hint is named');
    assert.strictEqual(d.runCalls.length, 0, 'NO raw-SSH fallback');
    assert.strictEqual(d.attachCalls.length, 0);
    assert.strictEqual(d.bridgeCalls.length, 0, 'the attach leg is never reached');
    assert.strictEqual(d.exits.length, 0);
  });

  it('flag ON + stale binary: the too-old error surfaces verbatim', async () => {
    const { deps, d } = dashDeps({ on: true });
    deps.execInContext = async () => ({
      host: REMOTE, ok: false, code: -1, stdout: '',
      stderr: `companion binary on ${REMOTE} is too old: it does not advertise the 'exec' RPC (ping methods: ping).`,
    });
    await cmdDash(['--host', REMOTE], {}, deps);
    assert.strictEqual(d.dies.length, 1);
    assert.ok(d.dies[0].includes('too old'), d.dies[0]);
    assert.strictEqual(d.attachCalls.length, 0);
  });

  it('flag OFF: raw preflight + raw attach, byte-for-byte the pre-1364 command — and the attach REACHES attach', async () => {
    const { deps, d } = dashDeps({ on: false, fakeRouter: true });
    deps.attachInteractiveCompanion = () => { throw new Error('flag OFF must not touch the companion bridge'); };
    await cmdDash(['--host', REMOTE], {}, deps);
    assert.strictEqual(d.runCalls.length, 1);
    assert.strictEqual(d.runCalls[0].host, REMOTE);
    assert.strictEqual(d.runCalls[0].cmd, 'command -v tmux >/dev/null 2>&1 && echo OK || echo MISSING');
    assert.deepStrictEqual(d.runCalls[0].opts, { timeout: 8000 });
    assert.strictEqual(d.attachCalls.length, 1);
    assert.strictEqual(d.attachCalls[0].host, REMOTE);
    assert.strictEqual(d.attachCalls[0].cmd, buildDashScript('warden', ['p-worker']),
      'the multi-window script is byte-identical on the default path');
    assert.deepStrictEqual(d.exits, [7], 'the raw attach exit code is what the process exits with');
    // THE REGRESSION: before WARDEN-1364 `attach` was neither defined nor
    // imported in cli.js — this call was `ReferenceError: attach is not defined`
    // for every non-dry-run remote dash. Reaching the recorder proves the
    // dangling reference is gone on the default path.
  });

  it('LOCAL host never routes through the companion, even with the flag on', async () => {
    const { deps, d } = dashDeps({ on: true, fakeRouter: true });
    deps.attachInteractiveCompanion = () => { throw new Error('LOCAL must not touch the companion bridge'); };
    await cmdDash(['--host', LOCAL], {}, deps);
    assert.strictEqual(d.runCalls.length, 1, 'the preflight ran raw');
    assert.strictEqual(d.attachCalls.length, 1, 'the attach ran raw');
    assert.strictEqual(d.execCalls.length, 0);
    assert.strictEqual(d.bridgeCalls.length, 0);
  });

  it('flag OFF + no host tmux: the unchanged MISSING message, attach never reached', async () => {
    const { deps, d } = dashDeps({ on: false, fakeRouter: true });
    deps.run = async () => ({ ok: true, code: 0, stdout: 'MISSING', stderr: '' });
    await cmdDash(['--host', REMOTE], {}, deps);
    assert.strictEqual(d.dies.length, 1);
    assert.ok(d.dies[0].includes('has no tmux (dash runs tmux there)'), d.dies[0]);
    assert.ok(d.dies[0].includes('brew install tmux'), 'the install hints are unchanged');
    assert.strictEqual(d.attachCalls.length, 0);
  });

  it('flag ON + host tmux genuinely MISSING: the unchanged message (a real answer, not a transport failure)', async () => {
    const { deps, d } = dashDeps({ on: true });
    deps.execInContext = async () => ({ ok: true, code: 0, stdout: 'MISSING', stderr: '' });
    await cmdDash(['--host', REMOTE], {}, deps);
    assert.strictEqual(d.dies.length, 1);
    assert.ok(d.dies[0].includes('has no tmux'), d.dies[0]);
    assert.strictEqual(d.bridgeCalls.length, 0);
  });

  it('--dry-run: prints the exact script and touches NEITHER transport (discovery still happens)', async () => {
    const { deps, d } = dashDeps({ on: true, chats: ['p-worker'], fakeRouter: true });
    deps.run = () => { throw new Error('dry-run must not touch run'); };
    deps.attach = () => { throw new Error('dry-run must not touch attach'); };
    deps.attachInteractiveCompanion = () => { throw new Error('dry-run must not touch the companion'); };
    const origLog = console.log;
    let printed = null;
    console.log = (s) => { printed = s; };
    try {
      await cmdDash(['--host', REMOTE, '--dry-run'], {}, deps);
    } finally {
      console.log = origLog;
    }
    assert.strictEqual(d.discoverCalls, 1);
    assert.strictEqual(printed, buildDashScript('warden', ['p-worker']));
    assert.strictEqual(d.exits.length, 0);
    assert.strictEqual(d.dies.length, 0);
  });

  it('a custom --session names the dash session in the delivered script', async () => {
    const { deps, d } = dashDeps({ on: false, fakeRouter: true });
    await cmdDash(['--host', REMOTE, '--session', 'mysess'], {}, deps);
    assert.ok(d.attachCalls[0].cmd.startsWith('tmux kill-session -t mysess'), d.attachCalls[0].cmd);
    assert.ok(d.attachCalls[0].cmd.endsWith('tmux attach -t mysess'));
  });
});
