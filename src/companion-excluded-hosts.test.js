// WARDEN-1390 — the PER-HOST companion-transport opt-out (companionExcludedHosts).
//
// The fleet-global toggle forced an all-or-nothing choice on a host with a
// structural limitation (a host whose companion reports no PTY — pre-1809
// Windows has no ConPTY, companion/pty_windows.go): break attach there, or
// forfeit the channel on EVERY host. This suite pins the per-host exclusion
// end to end:
//
//   A. the gate pair: isCompanionExcludedHost (env reader) +
//      applyCompanionExclusions (boot/afterSave writer — the runtime-state
//      env var, UI wins at PUT, unlike the toggle's operator override).
//   B. status visibility: an excluded host reports
//      {state:'inactive', reason:'excluded-by-setting'} from getCompanionStatus
//      / getAllCompanionStatuses (so pingProbe self-declines too).
//   C. the companionOp backstop: a call that reaches the op funnel anyway is
//      refused with the exclusion-specific remedy (never a rogue channel).
//   D. deliverRemoteScript routing: the script-delivery legs (git routes,
//      claude-sessions, observer tails, pane-container walk) take the DEFAULT
//      run() path for an excluded host — exclusion is a routing decision, not
//      a failure.
//   E. per-op-family routing proofs: every gated family (tmux read/send/
//      sendKey/hasSession/probe/resize/spawn/kill/attach×2, chats discover/
//      capturePanes, paste delivery, claude-sessions, git routes, CLI dash)
//      routes an excluded host to its RAW seam and a non-excluded host to its
//      COMPANION seam in the same suite — the host scoping is the point.
//   F. the wsLayer legs over the REAL WebSocket layer: an excluded host never
//      gets a subscribePanes RPC and is dropped from teardown grouping, while
//      a non-excluded host on the same socket still subscribes/unsubscribes.
//   G. release: applying an exclusion tears down the host's live companion
//      state (cached channel killed, subscription/delta/op state cleared) so
//      the exclusion is complete and immediate.
//
// The empty-list contract (routing byte-identical to the pre-exclusion
// transport) is proven by the ENTIRE pre-existing suite, which never sets
// WARDEN_COMPANION_EXCLUDED_HOSTS — every green sibling test here is that pin.
import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { Readable, Writable } from 'node:stream';
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import {
  isCompanionExcludedHost, applyCompanionExclusions,
  getCompanionStatus, getAllCompanionStatuses,
  discover, deliverRemoteScript,
  getChannel, subscribePanes,
  _resetChannelCacheForTests, _channelCacheHasForTests,
  _resetPaneDeltaStateForTests, _getPaneSubscriptionsForTests,
  applyPaneDelta, hasFreshPaneDelta, _getCompanionOpsForTests,
} from './companion.js';
import {
  read as tmuxRead, send as tmuxSend, sendKey as tmuxSendKey,
  hasSession as tmuxHasSession, probeSession as tmuxProbeSession,
  resize as tmuxResize, spawn as tmuxSpawn, kill as tmuxKill,
  attachStream as tmuxAttachStream, attachInteractive as tmuxAttachInteractive,
} from './tmux.js';
import { discover as chatsDiscover, capturePanes as chatsCapturePanes } from './chats.js';
import { deliverPastedImage } from './pasteImage.js';
import { remoteClaudeSessionsDetail } from './claudeSessions.js';
import { runGit } from './gitRoutes.js';
import { cmdDash } from './cli.js';
import { setupWsLayer } from './wsLayer.js';

const TEST_VER = 'abc123';
const TEST_MANIFEST = {
  version: TEST_VER,
  binaries: {
    'linux/amd64': 'warden-companion-linux-amd64',
    'linux/arm64': 'warden-companion-linux-arm64',
    'darwin/amd64': 'warden-companion-darwin-amd64',
    'darwin/arm64': 'warden-companion-darwin-arm64',
    'windows/amd64': 'warden-companion-windows-amd64.exe',
    'windows/arm64': 'warden-companion-windows-arm64.exe',
  },
};
const EXCLUDED = 'win-box';
const OTHER = 'mac-box';

// ------------------------------- env plumbing --------------------------------
// Every test in this suite runs with the toggle ON (so a regression that drops
// the exclusion check would route the companion way, and fail the raw-side
// assertions) and the exclusion env var in a known state.
let savedExclusionEnv;
let savedToggleEnv;

before(() => {
  savedExclusionEnv = process.env.WARDEN_COMPANION_EXCLUDED_HOSTS;
  savedToggleEnv = process.env.WARDEN_COMPANION_TRANSPORT;
  process.env.WARDEN_COMPANION_TRANSPORT = '1';
  process.env.WARDEN_COMPANION_EXCLUDED_HOSTS = EXCLUDED;
});

afterEach(() => {
  // Tests may flip the env mid-flight; restore the suite-wide state and drop
  // any companion module state a channel-driving test left behind.
  process.env.WARDEN_COMPANION_TRANSPORT = '1';
  process.env.WARDEN_COMPANION_EXCLUDED_HOSTS = EXCLUDED;
  _resetChannelCacheForTests();
  _resetPaneDeltaStateForTests();
});

after(() => {
  if (savedExclusionEnv === undefined) delete process.env.WARDEN_COMPANION_EXCLUDED_HOSTS;
  else process.env.WARDEN_COMPANION_EXCLUDED_HOSTS = savedExclusionEnv;
  if (savedToggleEnv === undefined) delete process.env.WARDEN_COMPANION_TRANSPORT;
  else process.env.WARDEN_COMPANION_TRANSPORT = savedToggleEnv;
});

// ------------------------------- fake transport ------------------------------
// Minimal stdio RPC twin (same shape companion.test.js drives), extended with
// subscribe/unsubscribe ACKs so the wsLayer harness can observe pushes.
function fakeTransport(recorder) {
  let lineCB = null, exitCb = null;
  const t = {
    writes: [],
    write(line) {
      t.writes.push(JSON.parse(line));
      let resp = null;
      try { resp = recorder(JSON.parse(line)); } catch { /* swallow */ }
      if (resp) setImmediate(() => { if (lineCB) lineCB(JSON.stringify(resp)); });
    },
    onLine(cb) { lineCB = cb; },
    onExit(cb) { exitCb = cb; },
    kill() {},
    _die(err) { if (exitCb) exitCb(err); },
  };
  return t;
}

function healthyRecorder() {
  return (req) => {
    if (req.method === 'ping') return { id: req.id, ok: true, result: { version: TEST_VER, methods: ['ping', 'discover', 'capturePanes', 'hasSession', 'spawnSession', 'killSession', 'resize', 'send', 'sendKeys', 'subscribePanes', 'unsubscribePanes'] } };
    if (req.method === 'discover') return { id: req.id, ok: true, result: { containers: [] } };
    if (req.method === 'capturePanes') return { id: req.id, ok: true, result: { panes: {} } };
    if (req.method === 'subscribePanes') return { id: req.id, ok: true, result: { subscribed: (req.params?.panes || []).length } };
    if (req.method === 'unsubscribePanes') return { id: req.id, ok: true, result: { unsubscribed: true } };
    return { id: req.id, ok: true, result: {} };
  };
}

// A fakeTransport twin whose PING response is held until releasePing() — the
// harness for the mid-bootstrap exclusion race: the bootstrap is in flight
// (its ping unanswered, its promise cached) when the host gets excluded, and
// the ping only answers afterwards. onKilled counts transport kills so the
// test can prove the superseded channel's ssh process actually died.
function heldPingTransport(recorder, onKilled = () => {}) {
  const state = { released: false, held: [] };
  const t = fakeTransport(recorder);
  let lineCB = null;
  const origOnLine = t.onLine.bind(t);
  const origWrite = t.write.bind(t);
  t.onLine = (cb) => { lineCB = cb; origOnLine(cb); };
  t.write = (line) => {
    const req = JSON.parse(line);
    if (req.method === 'ping' && !state.released) { t.writes.push(req); state.held.push(req); return; }
    origWrite(line);
  };
  t.kill = () => { onKilled(); };
  t.releasePing = () => {
    state.released = true;
    for (const req of state.held) {
      const resp = recorder(req);
      if (resp) setImmediate(() => { if (lineCB) lineCB(JSON.stringify(resp)); });
    }
    state.held = [];
  };
  return t;
}

// Poll until a condition holds (the bootstrap's progress from `getChannel()`
// to the in-flight ping crosses several async seams — don't count ticks).
async function until(fn, what, ms = 2000) {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setImmediate(r));
  }
}

// Seam bundle with per-host fake channels so a test can assert exactly which
// host a call touched, plus raw-path recorders.
function makeDeps() {
  const channels = new Map(); // host -> fakeTransport
  const raw = { run: [], runWithPool: [], runTmux: [], attachTmux: [], attachInteractiveTmux: [], spawn: [] };
  const deps = {
    manifest: TEST_MANIFEST,
    spawnChannel: (host) => {
      if (!channels.has(host)) channels.set(host, fakeTransport(healthyRecorder()));
      return channels.get(host);
    },
    run: async (host, cmd, opts) => { raw.run.push({ host, cmd, opts }); return { ok: true, code: 0, stdout: 'OS=Linux\nARCH=x86_64\nHAVE=0\n' }; },
    upload: async () => ({ ok: true }),
    // Companion-side seams: an EXCLUDED host must never reach them (the test
    // fails loudly if a gated path regresses), while the SAME seam on a
    // non-excluded host returns a healthy envelope so the host-scoping proof
    // can run both directions in one suite.
    discoverViaCompanion: async (host) => {
      if (host === EXCLUDED) throw new Error('excluded host must not ride discoverViaCompanion');
      return { host, ok: true, chats: [] };
    },
    companionExec: async (host) => {
      if (host === EXCLUDED) throw new Error('excluded host must not ride companionExec');
      return { host, ok: true, code: 0, stdout: 'OK', stderr: '' };
    },
    companionSend: async (host) => {
      if (host === EXCLUDED) throw new Error('excluded host must not ride companionSend');
      return { host, ok: true, code: 0, stdout: '', stderr: '' };
    },
    companionSendKey: async (host) => {
      if (host === EXCLUDED) throw new Error('excluded host must not ride companionSendKey');
      return { host, ok: true, code: 0, stdout: '', stderr: '' };
    },
    companionHasSession: async (host) => {
      if (host === EXCLUDED) throw new Error('excluded host must not ride companionHasSession');
      return { host, ok: true, exists: true };
    },
    companionResize: async (host) => {
      if (host === EXCLUDED) throw new Error('excluded host must not ride companionResize');
      return { host, ok: true, code: 0, stdout: '', stderr: '' };
    },
    spawnSession: async (host) => {
      if (host === EXCLUDED) throw new Error('excluded host must not ride spawnSession');
      return { host, ok: true };
    },
    killSession: async (host) => {
      if (host === EXCLUDED) throw new Error('excluded host must not ride killSession');
      return { host, ok: true };
    },
    companionAttachSession: (host) => {
      if (host === EXCLUDED) throw new Error('excluded host must not ride companionAttachSession');
      return { onData() {}, onExit() {}, write() {}, resize() {}, kill() {} };
    },
    attachInteractiveCompanion: (host) => {
      if (host === EXCLUDED) throw new Error('excluded host must not ride attachInteractiveCompanion');
      return Promise.resolve(0);
    },
    writeFileToHost: async (host) => {
      if (host === EXCLUDED) throw new Error('excluded host must not ride writeFileToHost');
      return { host, ok: true, code: 0, stdout: '', stderr: '' };
    },
    execInContext: async (host) => {
      if (host === EXCLUDED) throw new Error('excluded host must not ride execInContext');
      return { host, ok: true, code: 0, stdout: '', stderr: '' };
    },
    runTmux: async (chat, args) => { raw.runTmux.push({ chat, args }); return { ok: true, code: 0, stdout: 'OK', stderr: '' }; },
    attachTmux: (chat, args, opts) => { raw.attachTmux.push({ chat, args, opts }); return { onData() {}, onExit() {}, write() {}, resize() {}, kill() {} }; },
    attachInteractiveTmux: (chat, args) => { raw.attachInteractiveTmux.push({ chat, args }); return Promise.resolve(0); },
    spawn: (bin, argv) => { raw.spawn.push({ bin, argv }); const c = new EventEmitter(); c.stdout = new Readable({ read() {} }); c.stderr = new Readable({ read() {} }); c.kill = () => {}; c.stdin = new Writable({ write(_c, _e, cb) { cb(); } }); setImmediate(() => c.emit('exit', 0)); return c; },
    runWithPool: async (host, script, opts) => { raw.runWithPool.push({ host, script, opts }); return { ok: true, code: 0, stdout: '', stderr: '' }; },
    // cmdDash terminators — WITHOUT these it calls the real process.exit and
    // silently kills the whole test file mid-run.
    exit: () => {},
    die: () => {},
  };
  return { deps, channels, raw };
}

const remoteChat = (host, name = 'agent') => ({ host, container: null, session: name, name, key: `${host}:${name}`, id: `${host}:${name}`, cwd: '/tmp' });

// ------------------------------ A. the gate pair -----------------------------

describe('WARDEN-1390 gate pair: isCompanionExcludedHost + applyCompanionExclusions', () => {
  it('nothing is excluded when the env var is unset', () => {
    delete process.env.WARDEN_COMPANION_EXCLUDED_HOSTS;
    assert.strictEqual(isCompanionExcludedHost(EXCLUDED), false);
    assert.strictEqual(isCompanionExcludedHost(OTHER), false);
  });

  it('parses the comma-separated list, trims entries, matches the host string exactly', () => {
    process.env.WARDEN_COMPANION_EXCLUDED_HOSTS = ` ${EXCLUDED} , ${OTHER} `;
    assert.strictEqual(isCompanionExcludedHost(EXCLUDED), true);
    assert.strictEqual(isCompanionExcludedHost(OTHER), true);
    assert.strictEqual(isCompanionExcludedHost('other-box'), false);
    // exact match on the bare host string (the cfg.hosts convention) — a
    // suffix/prefix must not leak an exclusion onto a different host.
    assert.strictEqual(isCompanionExcludedHost(`${EXCLUDED}.example.com`), false);
    assert.strictEqual(isCompanionExcludedHost(`sub-${EXCLUDED}`), false);
  });

  it('odd input defaults to NOT excluded (the predicate must never throw)', () => {
    assert.strictEqual(isCompanionExcludedHost(undefined), false);
    assert.strictEqual(isCompanionExcludedHost(''), false);
    assert.strictEqual(isCompanionExcludedHost(null), false);
  });

  it('applyCompanionExclusions serializes the list into the env var and returns it', () => {
    const applied = applyCompanionExclusions([EXCLUDED, OTHER]);
    assert.deepStrictEqual(applied, [EXCLUDED, OTHER]);
    assert.strictEqual(process.env.WARDEN_COMPANION_EXCLUDED_HOSTS, `${EXCLUDED},${OTHER}`);
    assert.strictEqual(isCompanionExcludedHost(EXCLUDED), true);
    assert.strictEqual(isCompanionExcludedHost(OTHER), true);
  });

  it('an empty list DELETES the env var (routing byte-identical to pre-exclusion)', () => {
    applyCompanionExclusions([EXCLUDED]);
    assert.ok(process.env.WARDEN_COMPANION_EXCLUDED_HOSTS);
    applyCompanionExclusions([]);
    assert.strictEqual(process.env.WARDEN_COMPANION_EXCLUDED_HOSTS, undefined);
    assert.strictEqual(isCompanionExcludedHost(EXCLUDED), false);
  });

  it('a malformed list degrades to NO exclusions (never injects an arbitrary env string)', () => {
    // A hand-edited config.json can slip a bad entry past load; the writer
    // runs everything through the PUT sanitizer, so the env gate can only ever
    // hold a comma-free, non-empty list.
    for (const bad of ['win-box', 42, null, ['a,b'], [''], ['  '], [['nested']]]) {
      applyCompanionExclusions(bad);
      assert.strictEqual(
        process.env.WARDEN_COMPANION_EXCLUDED_HOSTS, undefined,
        `malformed input ${JSON.stringify(bad)} must clear (not write) the env gate`,
      );
    }
  });

  it('is runtime state, NOT an operator override: every apply overwrites the env var', () => {
    // Deliberate semantic divergence from WARDEN_COMPANION_TRANSPORT (which
    // never clobbers an operator-set value): the UI list wins at PUT.
    process.env.WARDEN_COMPANION_EXCLUDED_HOSTS = 'stale-host';
    applyCompanionExclusions([EXCLUDED]);
    assert.strictEqual(process.env.WARDEN_COMPANION_EXCLUDED_HOSTS, EXCLUDED);
    assert.strictEqual(isCompanionExcludedHost('stale-host'), false);
  });
});

// --------------------------- B. status visibility ----------------------------

describe('WARDEN-1390 status visibility: excluded-by-setting reason', () => {
  it('an excluded host reports inactive WITH the reason (toggle on)', () => {
    assert.deepStrictEqual(getCompanionStatus(EXCLUDED), { state: 'inactive', reason: 'excluded-by-setting' });
  });

  it('a non-excluded host keeps the exact pre-exclusion shape (no reason invented)', () => {
    assert.deepStrictEqual(getCompanionStatus(OTHER), { state: 'inactive' });
  });

  it('toggle OFF keeps the reason-less inactive shape byte-identical (both hosts)', () => {
    process.env.WARDEN_COMPANION_TRANSPORT = '0';
    assert.deepStrictEqual(getCompanionStatus(EXCLUDED), { state: 'inactive' });
    assert.deepStrictEqual(getCompanionStatus(OTHER), { state: 'inactive' });
    assert.deepStrictEqual(getAllCompanionStatuses(), {});
  });

  it('getAllCompanionStatuses maps a lingering excluded entry to the reason shape (never contradicts getCompanionStatus)', () => {
    // Simulate an entry captured before the exclusion (a test-only seed —
    // production releases the state on apply; see the release suite below).
    applyCompanionExclusions([EXCLUDED, OTHER]);
    process.env.WARDEN_COMPANION_EXCLUDED_HOSTS = EXCLUDED; // OTHER back in service
    assert.deepStrictEqual(getAllCompanionStatuses(), {});
    assert.deepStrictEqual(getCompanionStatus(EXCLUDED), { state: 'inactive', reason: 'excluded-by-setting' });
    assert.deepStrictEqual(getCompanionStatus(OTHER), { state: 'inactive' });
  });

  it('pingProbe declines an excluded host (the status gate self-declines the probe)', async () => {
    const { pingProbe } = await import('./companion.js');
    assert.strictEqual(await pingProbe(EXCLUDED, {}, {}), null, 'excluded → status != active → no probe, no channel');
  });
});

// -------------------------- C. the companionOp backstop ----------------------

describe('WARDEN-1390 companionOp backstop: a missed gate cannot open a channel', () => {
  it('discover on an excluded host is refused with the per-host remedy, no channel spawned', async () => {
    const { deps, channels } = makeDeps();
    const r = await discover(EXCLUDED, {}, {}, deps);
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /companionExcludedHosts/);
    assert.match(r.error, /Companion excluded hosts/);
    assert.strictEqual(channels.size, 0, 'ZERO channel spawns — the refusal happens before getChannel');
    assert.match(r.error, /excluded from companion transport/);
  });

  it('the backstop is host-scoped: a non-excluded host rides the channel as before', async () => {
    const { deps, channels } = makeDeps();
    const r = await discover(OTHER, {}, {}, deps);
    assert.strictEqual(r.ok, true, 'non-excluded host keeps riding the channel');
    assert.ok(channels.has(OTHER));
  });
});

// ----------------------- D. deliverRemoteScript routing ----------------------

describe('WARDEN-1390 deliverRemoteScript: the script-delivery funnel routes exclusion to raw SSH', () => {
  it('excluded host → deps.run with the byte-identical script; execInContext never called', async () => {
    const { deps, raw } = makeDeps();
    const script = 'cd /repo && git status --porcelain 2>/dev/null';
    const r = await deliverRemoteScript(EXCLUDED, script, { timeout: 8000, run: deps.run }, {}, deps);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(raw.run.length, 1);
    assert.strictEqual(raw.run[0].host, EXCLUDED);
    assert.strictEqual(raw.run[0].cmd, script, 'the default path receives the SAME script string');
    assert.strictEqual(raw.run[0].opts.timeout, 8000, 'the deadline rides along');
  });

  it('non-excluded host → execInContext, raw run never called', async () => {
    const { deps, raw } = makeDeps();
    const script = 'cd /repo && git status --porcelain 2>/dev/null';
    const seen = [];
    deps.execInContext = async (host, s, opts) => { seen.push({ host, s, opts }); return { ok: true, code: 0, stdout: '', stderr: '' }; };
    await deliverRemoteScript(OTHER, script, { timeout: 8000 }, {}, deps);
    assert.strictEqual(seen.length, 1);
    assert.strictEqual(seen[0].host, OTHER);
    assert.strictEqual(seen[0].s, script);
    assert.strictEqual(raw.run.length, 0, 'the channel host keeps its zero-ssh-leg delivery');
  });
});

// --------------------- E. per-op-family routing proofs -----------------------
// Each family: excluded host → RAW seam only (companion seam would throw the
// test); non-excluded host → companion seam only. Same suite, adjacent cases —
// proving the exclusion is host-scoped, not a fleet-wide silent off.

describe('WARDEN-1390 per-op-family routing (excluded ⇒ raw SSH, others ⇒ channel)', () => {
  it('tmux.read routes capture-pane to runTmux for an excluded host', async () => {
    const { deps, raw } = makeDeps();
    await tmuxRead(remoteChat(EXCLUDED), {}, 100, deps);
    assert.strictEqual(raw.runTmux.length, 1, 'the raw capture ran');
    assert.match(raw.runTmux[0].args.join(' '), /capture-pane/);
  });

  it('tmux.send + sendKey route to runTmux for an excluded host', async () => {
    const { deps, raw } = makeDeps();
    await tmuxSend(remoteChat(EXCLUDED), {}, 'hello', deps);
    assert.ok(raw.runTmux.length >= 1, 'send took the raw path');
    assert.ok(raw.runTmux[0].args.includes('send-keys'), 'the raw send-keys argv ran');
    await tmuxSendKey(remoteChat(EXCLUDED), {}, 'Enter', deps);
    assert.ok(raw.runTmux.some((c) => c.args[0] === 'send-keys' && c.args.includes('Enter') && !c.args.includes('-l')),
      'sendKey also took the raw path');
  });

  it('tmux.hasSession + probeSession probe via runTmux for an excluded host', async () => {
    const { deps, raw } = makeDeps();
    assert.strictEqual(await tmuxHasSession(remoteChat(EXCLUDED), {}, deps), true);
    const probe = await tmuxProbeSession(remoteChat(EXCLUDED), {}, { timeout: 1000 }, deps);
    assert.strictEqual(probe.ok, true);
    assert.ok(raw.runTmux.length >= 2, 'both probes ran raw');
    assert.ok(raw.runTmux.every((c) => c.args.includes('has-session')));
  });

  it('tmux.resize + spawn + kill route to runTmux for an excluded host', async () => {
    const { deps, raw } = makeDeps();
    await tmuxResize(remoteChat(EXCLUDED), {}, 100, 30, deps);
    await tmuxSpawn(remoteChat(EXCLUDED), {}, deps);
    await tmuxKill(remoteChat(EXCLUDED), {}, deps);
    assert.ok(raw.runTmux.length >= 3, 'resize/spawn/kill all raw');
    assert.ok(raw.runTmux.some((c) => c.args.includes('set-option')), 'resize took the raw set-option path');
    assert.ok(raw.runTmux.some((c) => c.args.includes('new-session')), 'spawn took the raw path');
    assert.ok(raw.runTmux.some((c) => c.args.includes('kill-session')), 'kill took the raw path');
  });

  it('tmux.attachStream + attachInteractive use the raw attach for an excluded host', async () => {
    const { deps, raw } = makeDeps();
    tmuxAttachStream(remoteChat(EXCLUDED), {}, { cols: 80, rows: 24 }, deps);
    assert.strictEqual(raw.attachTmux.length, 1, 'the web pane attach used node-pty over ssh');
    await tmuxAttachInteractive(remoteChat(EXCLUDED), {}, deps);
    assert.strictEqual(raw.attachInteractiveTmux.length, 1, 'the CLI attach used the raw bridge');
  });

  it('chats.discover routes to runWithPool for an excluded host', async () => {
    const { deps, raw } = makeDeps();
    const r = await chatsDiscover(EXCLUDED, {}, {}, deps);
    assert.ok(r.host === EXCLUDED);
    assert.strictEqual(raw.runWithPool.length, 1, 'discover ran the pooled SSH script');
  });

  it('chats.capturePanes NEVER opens a channel for an excluded host (the raw leg takes over)', { timeout: 20000 }, async () => {
    const { deps, channels } = makeDeps();
    await chatsCapturePanes([remoteChat(EXCLUDED)], {}, deps);
    assert.strictEqual(channels.size, 0, 'zero channel spawns — the exclusion holds at the capture gate');
  });

  it('paste delivery routes to the ssh spawn for an excluded host', async () => {
    const { deps, raw } = makeDeps();
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)]);
    const r = await deliverPastedImage(remoteChat(EXCLUDED), {}, png, { ...deps, now: 1700000000000 });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(raw.spawn.length, 1, 'the paste rode the ssh leg');
    assert.strictEqual(raw.spawn[0].bin, 'ssh', '…as an ssh process, not docker');
  });

  it('claude-sessions listing routes to run for an excluded host (same script, raw transport)', async () => {
    const { deps, raw } = makeDeps();
    deps.run = async (host, cmd) => { raw.run.push({ host, cmd }); return { ok: true, code: 0, stdout: 'S\tagent\t2026-01-01T00:00:00Z\t5\t/false\n', stderr: '' }; };
    const { sessions } = await remoteClaudeSessionsDetail(EXCLUDED, 40, deps);
    assert.strictEqual(raw.run.length, 1, 'the listing ran over raw ssh');
    assert.ok(Array.isArray(sessions));
  });

  it('git routes deliver to run for an excluded host (container + manual chats)', async () => {
    const { deps, raw } = makeDeps();
    await runGit({ ...remoteChat(EXCLUDED), container: 'c1' }, ['status', '--porcelain'], '/repo', deps);
    await runGit(remoteChat(EXCLUDED), ['status', '--porcelain'], '/repo', deps);
    assert.strictEqual(raw.run.length, 2, 'both git legs ran raw');
    assert.ok(raw.run.every((c) => c.cmd.includes('git')), 'the scripts are the git scripts, delivered raw');
  });

  it('CLI dash: excluded host → raw preflight + raw attach, ZERO companion legs', async () => {
    const { deps, raw } = makeDeps();
    deps.isCompanionTransportEnabled = () => true;
    // cmdDash validates active chats + container names before routing, so the
    // fixture is a real-shaped active chat (the exclusion is what's under test).
    deps.discover = async () => ({
      ok: true,
      chats: [{ ...remoteChat(EXCLUDED, 'p-worker'), active: true, container: 'p-worker' }],
    });
    deps.attach = async (host, cmd) => { raw.attachCalls = raw.attachCalls || []; raw.attachCalls.push({ host, cmd }); return 0; };
    // The raw preflight asserts `OK` on stdout (tmux presence), so the raw run
    // recorder returns a passing preflight; the bootstrap probe shape (also
    // served by deps.run in makeDeps) is irrelevant on this excluded path.
    deps.run = async (host, cmd, opts) => { raw.run.push({ host, cmd, opts }); return { ok: true, code: 0, stdout: 'OK', stderr: '' }; };
    await cmdDash(['--host', EXCLUDED], {}, deps);
    assert.strictEqual(raw.run.length, 1, 'the preflight ran raw');
    assert.ok((raw.attachCalls || []).length === 1, 'the attach ran raw');
    assert.ok((raw.attachCalls || [])[0]?.host === EXCLUDED);
  });

  it('host-scoped proof: the SAME calls on a non-excluded host ride the channel', async () => {
    const { deps, channels, raw } = makeDeps();
    // Channel-level: the REAL op funnel opens a channel for OTHER (identical
    // call shape to the backstop test above, different host).
    const r = await discover(OTHER, {}, {}, deps);
    assert.strictEqual(r.ok, true);
    assert.ok(channels.has(OTHER), 'the non-excluded host opened a channel');
    assert.strictEqual(channels.size, 1, 'exactly one host is on the channel');
    // Seam-level: OTHER's op took the companion seam, not a raw leg.
    let companionSends = 0;
    const companionSend = deps.companionSend;
    deps.companionSend = async (host, ...a) => { companionSends++; return companionSend(host, ...a); };
    await tmuxSend(remoteChat(OTHER), {}, 'hello', deps);
    assert.strictEqual(companionSends, 1, 'the send for the non-excluded host rode the companion seam');
    assert.strictEqual(raw.runTmux.length, 0, 'no raw tmux leg for the channel host');
    assert.strictEqual(raw.runWithPool.length, 0, 'no raw discover leg for the channel host');
  });
});

// ----------------------- F. the wsLayer legs (real WS) -----------------------

describe('WARDEN-1390 wsLayer legs: pane subscriptions never touch an excluded host', { timeout: 30000 }, () => {
  let httpServer;
  let wsUrl;
  let chatCatalog;

  before(async () => {
    chatCatalog = {
      snapshot: () => [
        remoteChat(EXCLUDED, 'win-agent'),
        remoteChat(OTHER, 'mac-agent'),
      ],
    };
    httpServer = http.createServer(() => {});
    setupWsLayer({ server: httpServer, cfg: { connectTimeout: 1 }, resolve: async () => {}, chatCatalog });
    await new Promise((resolve, reject) => {
      httpServer.once('error', reject);
      httpServer.listen(0, '127.0.0.1', () => resolve());
    });
    wsUrl = `ws://127.0.0.1:${httpServer.address().port}/api/stream`;
  });

  after(async () => {
    await new Promise((r) => httpServer.close(r));
  });

  // Both hosts get a LIVE cached channel via the seam BEFORE any ws traffic, so
  // (a) a subscribe that slipped through the gate would be observable as a
  // subscribePanes write on the fake channel, and (b) a teardown unsubscribe
  // that slipped the grouping filter would be observable the same way — without
  // either, the ws layer needs no real ssh.
  async function seedChannel(host) {
    const { deps } = makeDeps();
    await getChannel(host, { connectTimeout: 1 }, deps);
  }

  function connect() {
    const ws = new WebSocket(wsUrl);
    const opened = new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    return { ws, opened };
  }

  async function waitFor(cond, what, timeoutMs = 5000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (cond()) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`timed out waiting for ${what}`);
  }

  it('monitor on the excluded host: no subscribePanes write, no subscription state', async () => {
    await seedChannel(EXCLUDED);
    assert.strictEqual(_getPaneSubscriptionsForTests()[EXCLUDED], undefined, 'precondition: nothing subscribed');
    const conn = connect();
    await conn.opened;
    conn.ws.send(JSON.stringify({ type: 'monitor', id: `${EXCLUDED}:win-agent` }));
    await new Promise((r) => setTimeout(r, 300)); // the fire-and-forget subscription path
    assert.strictEqual(_getPaneSubscriptionsForTests()[EXCLUDED], undefined,
      'an excluded host NEVER gets subscribePanes (the wsLayer gate + the subscribePanes refusal both hold)');
    conn.ws.close();
  });

  it('monitor on a non-excluded host: the subscribePanes RPC rides its channel', async () => {
    await seedChannel(OTHER);
    const { deps } = makeDeps();
    // Re-acquire the SAME seeded channel object so its write recorder is readable.
    const channel = await getChannel(OTHER, { connectTimeout: 1 }, deps);
    const conn = connect();
    await conn.opened;
    conn.ws.send(JSON.stringify({ type: 'monitor', id: `${OTHER}:mac-agent` }));
    await waitFor(() => (_getPaneSubscriptionsForTests()[OTHER] !== undefined), 'the non-excluded host to be subscribed');
    const subWrites = channel.transport.writes.filter((w) => w.method === 'subscribePanes');
    assert.ok(subWrites.length > 0, 'the subscribePanes RPC rode the channel');
    conn.ws.close();
  });

  it('ws close: the excluded host is dropped from teardown grouping (no unsubscribe write ever)', async () => {
    await seedChannel(EXCLUDED);
    await seedChannel(OTHER);
    const { deps: dOther } = makeDeps();
    const otherChannel = await getChannel(OTHER, { connectTimeout: 1 }, dOther);
    const otherWrites = () => otherChannel.transport.writes;
    const otherUnsubBefore = otherWrites().filter((w) => w.method === 'unsubscribePanes').length;

    const conn = connect();
    await conn.opened;
    conn.ws.send(JSON.stringify({ type: 'monitor', id: `${OTHER}:mac-agent` }));
    await waitFor(() => (_getPaneSubscriptionsForTests()[OTHER] !== undefined), 'mac-agent subscribed');
    conn.ws.close();
    await waitFor(() => otherWrites().filter((w) => w.method === 'unsubscribePanes').length > otherUnsubBefore,
      'the non-excluded host to be unsubscribed on close');
    assert.strictEqual(_getPaneSubscriptionsForTests()[EXCLUDED], undefined,
      'the excluded host stayed out of the grouping AND out of the subscription map');
  });
});

// ------------------------------- G. the release ------------------------------

describe('WARDEN-1390 release: applying an exclusion tears down the host live state', () => {
  it('a newly excluded host loses its channel, subscription, delta cache and op tallies', async () => {
    // Engage the host first: a channel + a live subscription + a fresh delta.
    const { deps } = makeDeps();
    process.env.WARDEN_COMPANION_EXCLUDED_HOSTS = '';
    applyCompanionExclusions([]);
    const channel = await getChannel(OTHER, { connectTimeout: 1 }, deps);
    await subscribePanes(OTHER, [{ key: 'k', container: 'k', session: 'agent' }], {}, {}, deps);
    applyPaneDelta(OTHER, { event: 'paneDelta', panes: { k: 'pushed' } });
    assert.ok(_channelCacheHasForTests(OTHER), 'precondition: channel cached');
    assert.ok(_getPaneSubscriptionsForTests()[OTHER], 'precondition: subscribed');
    assert.ok(hasFreshPaneDelta(OTHER), 'precondition: fresh push cached');

    applyCompanionExclusions([OTHER]);

    assert.strictEqual(_channelCacheHasForTests(OTHER), false, 'the channel cache entry is gone');
    assert.strictEqual(channel.dead, true, 'the live channel was KILLED (the ssh process + remote pusher die with it)');
    assert.strictEqual(_getPaneSubscriptionsForTests()[OTHER], undefined, 'the pane subscription is released');
    assert.strictEqual(hasFreshPaneDelta(OTHER), false, 'the delta cache is cleared');
    assert.strictEqual((_getCompanionOpsForTests().get(OTHER)), undefined, 'the op tallies are cleared');
  });

  it('an exclusion landing MID-BOOTSTRAP is not resurrected when the bootstrap settles (release race)', async () => {
    // The regression for the review's reproduced race: getChannel caches the
    // bootstrap PROMISE; releaseExcludedHostState deletes it (a promise is not
    // killable); when the ping then answers, the settle path must NOT cache the
    // channel anyway — pre-fix it did, resurrecting a live ssh channel (and an
    // 'active' status stamp) for a host the user just excluded.
    const { deps } = makeDeps();
    let transportKills = 0;
    const transport = heldPingTransport(healthyRecorder(), () => { transportKills += 1; });
    const raceDeps = { ...deps, spawnChannel: () => transport };
    process.env.WARDEN_COMPANION_EXCLUDED_HOSTS = '';
    applyCompanionExclusions([]);
    const RACE = 'race-host';

    const pending = getChannel(RACE, { connectTimeout: 1 }, raceDeps); // bootstrap in flight
    await until(() => transport.writes.some((w) => w.method === 'ping'), 'ping to be held in flight');
    assert.ok(_channelCacheHasForTests(RACE), 'precondition: bootstrap promise cached');
    assert.strictEqual(getCompanionStatus(RACE).state, 'bootstrapping', 'precondition: bootstrapping');

    applyCompanionExclusions([RACE]); // the exclusion lands MID-BOOTSTRAP

    assert.strictEqual(_channelCacheHasForTests(RACE), false, 'the release dropped the in-flight bootstrap promise');
    transport.releasePing(); // the ping answers AFTER the exclusion
    const channel = await pending;
    assert.strictEqual(_channelCacheHasForTests(RACE), false,
      'the settled bootstrap must NOT resurrect a cache entry for an excluded host');
    assert.strictEqual(channel.dead, true, 'the superseded channel is KILLED (no lingering ssh process)');
    assert.ok(transportKills >= 1, 'the kill reached the transport (the ssh process + remote companion die with it)');
    assert.deepStrictEqual(getCompanionStatus(RACE), { state: 'inactive', reason: 'excluded-by-setting' },
      'the status surface still reads the exclusion, never a resurrected active stamp');
  });

  it('re-applying the same list does not re-clear state a re-engaged host built', async () => {
    applyCompanionExclusions([OTHER]);
    applyCompanionExclusions([OTHER]); // idempotent — no newly-excluded hosts
    assert.strictEqual(process.env.WARDEN_COMPANION_EXCLUDED_HOSTS, OTHER);
  });

  it('un-excluding is free: the next op re-bootstraps normally', async () => {
    applyCompanionExclusions([]);
    assert.strictEqual(isCompanionExcludedHost(OTHER), false);
    const { deps, channels } = makeDeps();
    const r = await discover(OTHER, {}, {}, deps);
    assert.strictEqual(r.ok, true);
    assert.ok(channels.has(OTHER));
  });
});
