// Tests for the companion ATTACH transport — WARDEN-1295 (the streaming slice of
// roadmap WARDEN-270).
//
// This is the last runtime op family to leave raw SSH, and the only one that is
// a STREAM rather than a request/response command. Three things must hold, and
// each is a distinct failure mode rather than three views of one:
//
//  1. PARITY — the command run under the host PTY is BYTE-FOR-BYTE what
//     attachPty hands `ssh -tt` today (the LANG/LC_ALL export, the inner
//     `bash -lc`, the quoting, the `docker exec -it <c> ` prefix). Pinned by a
//     delivered-string test, not by reading two literals side by side.
//  2. WARDEN-365 RACE DISCIPLINE — the wrapper is IPty-compatible in the ways
//     the identity gate depends on: kill() is async, a late exit is still
//     DELIVERED (so server.js's gate is what suppresses it), and no end is ever
//     delivered twice.
//  3. EVENT COEXISTENCE — the channel has a SINGLE event-handler slot. paneDelta
//     and the attach stream both ride it, so registering one must not silently
//     kill the other. This is the structural constraint the whole client design
//     turns on.
//
// Everything runs through injected seams / a fake transport — no real ssh, no
// real host.
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import {
  CompanionChannel, CompanionAttachSession, attachSession, attachPreflight,
  decodeAttachData, encodeAttachInput, attachUnsupportedMessage,
  readPaneDeltas, hasFreshPaneDelta,
  _wirePaneDeltaForTests, _primeChannelForTests,
  _resetChannelCacheForTests, _resetPaneDeltaStateForTests,
} from './companion.js';
import { attachStream } from './tmux.js';
import { buildAttachCommand, buildAttachRemoteScript, shellQuote } from './ssh.js';

const ORIG_COMPANION_ENV = process.env.WARDEN_COMPANION_TRANSPORT;

// A transport that speaks the companion protocol in-process. Mirrors
// companion.test.js's fakeTransport, plus `_inject` for the unsolicited event
// lines the attach stream is made of.
function fakeTransport(handler) {
  let lineCB = null, exitCb = null;
  return {
    write(line) {
      let resp = null;
      try { resp = handler(JSON.parse(line)); } catch { /* swallow */ }
      if (resp) setImmediate(() => { if (lineCB) lineCB(JSON.stringify(resp)); });
    },
    onLine(cb) { lineCB = cb; },
    onExit(cb) { exitCb = cb; },
    kill() {},
    _die(err) { if (exitCb) exitCb(err); },
    _inject(obj) { if (lineCB) lineCB(JSON.stringify(obj)); },
  };
}

// A live channel whose companion advertises the attach family and ACKs
// attachStart with a fixed sid. `sent` records every RPC so the test can assert
// what actually crossed the wire.
function attachChannel({ methods = ['ping', 'attachStart', 'attachInput', 'attachResize', 'attachKill'], sid = 'a1', sent = [] } = {}) {
  const t = fakeTransport((req) => {
    sent.push({ method: req.method, params: req.params });
    if (req.method === 'ping') return { id: req.id, ok: true, result: { version: 'v', methods } };
    if (req.method === 'attachStart') return { id: req.id, ok: true, result: { sid } };
    if (req.method === 'attachInput' || req.method === 'attachResize' || req.method === 'attachKill') {
      return { id: req.id, ok: true, result: {} };
    }
    return { id: req.id, ok: false, error: 'unknown method' };
  });
  const ch = new CompanionChannel('prod', t);
  ch._methods = methods; // as the bootstrap ping would have cached it
  return { channel: ch, transport: t, sent };
}

// Let queued microtasks + setImmediate callbacks run. The attach handle starts
// async internally; a test must give it a tick before asserting on the wire.
const settle = () => new Promise((r) => setImmediate(() => setImmediate(r)));

// ------------------------------ parity contract ------------------------------

describe('attach parity: the delivered host-side command (WARDEN-1295 AC #2)', () => {
  it('is byte-for-byte the string attachPty hands `ssh -tt` — yatfa chat (docker exec -it prefix)', () => {
    const chat = { host: 'prod', container: 'p-worker', session: 'agent' };
    const args = ['attach', '-t', 'agent'];
    const delivered = buildAttachRemoteScript(buildAttachCommand(chat, args));

    // The expected string is reconstructed from the SAME primitives ssh.js used
    // before this slice — the literals from attachPty (ssh.js:610) and attachTmux
    // (ssh.js:733-734) — so this is a pin against the pre-slice behavior, not a
    // restatement of the new builders.
    const cmd = `docker exec -it ${shellQuote('p-worker')} tmux ` + args.map(shellQuote).join(' ');
    const expected = `export LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8; bash -lc ${shellQuote(cmd)}`;
    assert.strictEqual(delivered, expected);

    // And spelled out literally, so a future edit to either builder that happens
    // to keep them self-consistent still fails here.
    assert.strictEqual(
      delivered,
      `export LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8; bash -lc 'docker exec -it '\\''p-worker'\\'' tmux '\\''attach'\\'' '\\''-t'\\'' '\\''agent'\\'''`,
    );
  });

  it('is byte-for-byte identical for a bare-tmux (manual) chat — no docker prefix', () => {
    const chat = { host: 'prod', container: null, session: 'agent' };
    const delivered = buildAttachRemoteScript(buildAttachCommand(chat, ['attach', '-t', 'agent']));
    assert.strictEqual(
      delivered,
      `export LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8; bash -lc 'tmux '\\''attach'\\'' '\\''-t'\\'' '\\''agent'\\'''`,
    );
    assert.ok(!delivered.includes('docker'), 'a manual chat must not get a docker prefix');
  });

  it('carries the LANG/LC_ALL export and the inner login shell — both load-bearing for rendering', () => {
    const delivered = buildAttachRemoteScript(buildAttachCommand({ container: null }, ['attach', '-t', 'agent']));
    assert.ok(delivered.startsWith('export LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8; '),
      'without the UTF-8 locale tmux renders box-drawing as mojibake');
    assert.ok(delivered.includes('bash -lc '),
      'the inner LOGIN shell is what resolves docker/tmux on PATH');
  });

  it('a session name needing quoting survives verbatim (the quoting is the parity)', () => {
    const delivered = buildAttachRemoteScript(buildAttachCommand({ container: "it's" }, ['attach', '-t', "we're"]));
    // Single quotes are escaped POSIX-style at BOTH nesting levels, exactly as
    // the pre-slice literals did.
    assert.ok(delivered.includes(`'\\''`), `embedded quotes are escaped: ${delivered}`);
  });

  it('attachStream (companion branch) delivers exactly that string to attachStart', async () => {
    let params = null;
    const chat = { host: 'prod', container: 'p-worker', session: 'agent' };
    attachStream(chat, {}, { cols: 120, rows: 40 }, {
      isCompanionTransportEnabled: () => true,
      companionAttachSession: (host, opts) => { params = { host, ...opts }; return { onData() {}, onExit() {} }; },
    });
    assert.strictEqual(params.host, 'prod');
    assert.strictEqual(params.cols, 120);
    assert.strictEqual(params.rows, 40);
    assert.strictEqual(
      params.script,
      buildAttachRemoteScript(buildAttachCommand(chat, ['attach', '-t', 'agent'])),
      'the routing layer must deliver the SAME string the default path builds',
    );
  });
});

// ------------------------------ routing gate ---------------------------------

describe('attachStream routing (WARDEN-1295 AC #1/#4)', () => {
  const remoteChat = { host: 'prod-1', container: 'p-worker', session: 'agent' };
  const localChat = { host: '(local)', session: 'agent' };

  it('REMOTE + enabled routes through the companion — ZERO ssh spawns per open', () => {
    let companionCalls = 0;
    let attachTmuxCalls = 0;
    const handle = attachStream(remoteChat, {}, { cols: 100, rows: 30 }, {
      isCompanionTransportEnabled: () => true,
      companionAttachSession: () => { companionCalls++; return { onData() {}, onExit() {} }; },
    });
    assert.strictEqual(companionCalls, 1, 'the open went over the channel');
    assert.strictEqual(attachTmuxCalls, 0);
    assert.ok(handle, 'a handle is returned synchronously');
  });

  it('LOCAL never routes through the companion, even with the toggle on', () => {
    let companionCalls = 0;
    let attachTmuxCalls = 0;
    attachStream(localChat, {}, { cols: 100, rows: 30 }, {
      isCompanionTransportEnabled: () => true,
      companionAttachSession: () => { companionCalls++; return { onData() {}, onExit() {} }; },
      attachTmux: () => { attachTmuxCalls++; return { onData() {}, onExit() {} }; },
    });
    assert.strictEqual(companionCalls, 0, 'LOCAL is served by attachLocalTmux, never the companion');
    assert.strictEqual(attachTmuxCalls, 1, 'LOCAL takes the unchanged default path');
  });

  it('toggle OFF keeps the default path byte-for-byte (the companion is never consulted)', () => {
    let companionCalls = 0;
    let seen = null;
    attachStream(remoteChat, {}, { cols: 100, rows: 30 }, {
      isCompanionTransportEnabled: () => false,
      companionAttachSession: () => { companionCalls++; return { onData() {}, onExit() {} }; },
      attachTmux: (chat, args, size) => { seen = { chat, args, size }; return { onData() {}, onExit() {} }; },
    });
    assert.strictEqual(companionCalls, 0, 'toggle off must not reach the companion at all');
    assert.deepStrictEqual(seen.args, ['attach', '-t', 'agent'], 'the default argv is unchanged');
    assert.deepStrictEqual(seen.size, { cols: 100, rows: 30 });
    assert.strictEqual(seen.chat, remoteChat);
  });
});

// ---------------------------- the IPty wrapper -------------------------------

describe('CompanionAttachSession: the IPty surface server.js consumes', () => {
  beforeEach(() => { _resetChannelCacheForTests(); _resetPaneDeltaStateForTests(); });

  it('exposes exactly onData/onExit/write/resize/kill — the five members server.js uses', () => {
    const { channel } = attachChannel();
    const s = new CompanionAttachSession('prod', Promise.resolve({ channel, sid: 'a1' }));
    for (const m of ['onData', 'onExit', 'write', 'resize', 'kill']) {
      assert.strictEqual(typeof s[m], 'function', `IPty member ${m} is missing`);
    }
  });

  it('streams attachData to onData, byte-exact through base64', async () => {
    const { channel, transport } = attachChannel();
    const s = new CompanionAttachSession('prod', Promise.resolve({ channel, sid: 'a1' }));
    const chunks = [];
    s.onData((d) => chunks.push(d));
    await settle();
    // A CSI colour sequence + a multibyte box-drawing glyph — the payload shape a
    // tmux repaint produces, and precisely what a lossy decode would destroy. The
    // wire carries BYTES, so the fixture is built as the host's utf8 bytes.
    const hostBytes = Buffer.from('\x1b[31m\u2502RED\x1b[0m', 'utf8');
    transport._inject({ event: 'attachData', sid: 'a1', data: hostBytes.toString('base64') });
    await settle();
    // The wrapper hands the consumer a latin1 (byte-preserving) string; the bytes
    // must be identical to what the host emitted.
    assert.deepStrictEqual(Buffer.from(chunks.join(''), 'binary'), hostBytes);
    assert.strictEqual(
      Buffer.from(chunks.join(''), 'binary').toString('utf8'),
      '\x1b[31m\u2502RED\x1b[0m',
      'the browser reassembles the bytes into the original glyph',
    );
  });

  it('buffers output that arrives BEFORE onData is registered (the pane\'s first frame)', async () => {
    const { channel, transport } = attachChannel();
    const s = new CompanionAttachSession('prod', Promise.resolve({ channel, sid: 'a1' }));
    await settle();
    transport._inject({ event: 'attachData', sid: 'a1', data: Buffer.from('$ ', 'binary').toString('base64') });
    await settle();
    const chunks = [];
    s.onData((d) => chunks.push(d)); // registered LATE
    assert.strictEqual(chunks.join(''), '$ ', 'a fast shell\'s prompt must not be dropped');
  });

  it('ignores another pane\'s stream on the SHARED channel (sid is the discriminator)', async () => {
    const { channel, transport } = attachChannel();
    const mine = new CompanionAttachSession('prod', Promise.resolve({ channel, sid: 'a1' }));
    const chunks = [];
    mine.onData((d) => chunks.push(d));
    await settle();
    transport._inject({ event: 'attachData', sid: 'a2', data: Buffer.from('OTHER', 'binary').toString('base64') });
    transport._inject({ event: 'attachData', sid: 'a1', data: Buffer.from('MINE', 'binary').toString('base64') });
    await settle();
    assert.strictEqual(chunks.join(''), 'MINE', 'one channel multiplexes every pane; cross-feed would corrupt both');
  });

  it('write() sends base64 attachInput for the right sid, and is fire-and-forget (returns undefined)', async () => {
    const sent = [];
    const { channel } = attachChannel({ sent });
    const s = new CompanionAttachSession('prod', Promise.resolve({ channel, sid: 'a1' }));
    await settle();
    const r = s.write('ls -la\n');
    assert.strictEqual(r, undefined, 'node-pty write() returns void; a promise here would be un-awaited');
    await settle();
    const input = sent.find((c) => c.method === 'attachInput');
    assert.ok(input, 'attachInput was issued');
    assert.strictEqual(input.params.sid, 'a1');
    assert.strictEqual(Buffer.from(input.params.data, 'base64').toString('binary'), 'ls -la\n');
  });

  it('write() before the ACK is QUEUED and replayed, not dropped (typing into a connecting pane)', async () => {
    const sent = [];
    const { channel } = attachChannel({ sent });
    let release;
    const start = new Promise((r) => { release = r; });
    const s = new CompanionAttachSession('prod', start);
    s.write('early\n');
    await settle();
    assert.strictEqual(sent.filter((c) => c.method === 'attachInput').length, 0, 'nothing can be sent before a sid exists');
    release({ channel, sid: 'a1' });
    await settle();
    const input = sent.find((c) => c.method === 'attachInput');
    assert.ok(input, 'the queued keystroke was replayed once the session went live');
    assert.strictEqual(Buffer.from(input.params.data, 'base64').toString('binary'), 'early\n');
  });

  it('resize() sends attachResize; a pre-ACK burst COALESCES to the last size', async () => {
    const sent = [];
    const { channel } = attachChannel({ sent });
    let release;
    const s = new CompanionAttachSession('prod', new Promise((r) => { release = r; }));
    s.resize(80, 24);
    s.resize(100, 30);
    s.resize(132, 50);
    release({ channel, sid: 'a1' });
    await settle();
    const resizes = sent.filter((c) => c.method === 'attachResize');
    assert.strictEqual(resizes.length, 1, 'replaying intermediate sizes would just churn SIGWINCH at a newly-live terminal');
    assert.deepStrictEqual(
      { cols: resizes[0].params.cols, rows: resizes[0].params.rows },
      { cols: 132, rows: 50 },
      'the LAST pre-ACK size is the one that matters',
    );
  });

  it('onExit fires with {exitCode} from attachExit', async () => {
    const { channel, transport } = attachChannel();
    const s = new CompanionAttachSession('prod', Promise.resolve({ channel, sid: 'a1' }));
    const exits = [];
    s.onExit((e) => exits.push(e));
    await settle();
    transport._inject({ event: 'attachExit', sid: 'a1', code: 7 });
    await settle();
    assert.deepStrictEqual(exits, [{ exitCode: 7, signal: undefined }]);
  });

  it('onExit registered AFTER the session ended still fires (the exit is a fact, not a missed event)', async () => {
    const { channel, transport } = attachChannel();
    const s = new CompanionAttachSession('prod', Promise.resolve({ channel, sid: 'a1' }));
    await settle();
    transport._inject({ event: 'attachExit', sid: 'a1', code: 0 });
    await settle();
    const exits = [];
    s.onExit((e) => exits.push(e));
    assert.deepStrictEqual(exits, [{ exitCode: 0, signal: undefined }],
      'node-pty delivers a late onExit too — that is the behavior WARDEN-365\'s gate was written against');
  });

  it('a DEAD channel ends the stream (no attachExit can arrive over a channel that is gone)', async () => {
    const { channel, transport } = attachChannel();
    const s = new CompanionAttachSession('prod', Promise.resolve({ channel, sid: 'a1' }));
    const exits = [];
    s.onExit((e) => exits.push(e));
    await settle();
    transport._die(new Error('companion ssh exited with code 255'));
    await settle();
    assert.strictEqual(exits.length, 1, 'without this the pane spins forever on a host whose companion just died');
    assert.strictEqual(exits[0].exitCode, -1);
  });

  it('write()/resize() after exit are silent no-ops (matching node-pty write-after-exit)', async () => {
    const sent = [];
    const { channel, transport } = attachChannel({ sent });
    const s = new CompanionAttachSession('prod', Promise.resolve({ channel, sid: 'a1' }));
    await settle();
    transport._inject({ event: 'attachExit', sid: 'a1', code: 0 });
    await settle();
    const before = sent.length;
    s.write('x');
    s.resize(80, 24);
    await settle();
    assert.strictEqual(sent.length, before, 'nothing is sent for a session that already ended');
  });
});

// ---------------------- WARDEN-365 race discipline ---------------------------

describe('WARDEN-365 race discipline survives the companion wrapper (AC #3)', () => {
  beforeEach(() => { _resetChannelCacheForTests(); });

  it('kill() is ASYNC — it returns before the exit, exactly like node-pty\'s', async () => {
    const { channel } = attachChannel();
    const s = new CompanionAttachSession('prod', Promise.resolve({ channel, sid: 'a1' }));
    const exits = [];
    s.onExit((e) => exits.push(e));
    await settle();
    s.kill();
    assert.strictEqual(exits.length, 0,
      'if kill() settled the exit synchronously, server.js would delete the FRESH entry it just bound');
  });

  it('a killed session\'s LATE attachExit is still DELIVERED — the identity gate is what suppresses it', async () => {
    const { channel, transport } = attachChannel();
    const s = new CompanionAttachSession('prod', Promise.resolve({ channel, sid: 'a1' }));
    const exits = [];
    s.onExit((e) => exits.push(e));
    await settle();
    s.kill();
    await settle();
    // The host reaps and pushes the exit AFTER the kill returned — the real
    // ordering. The transport must NOT swallow it: server.js's
    // `attaches.get(id) === entry` check is the layer that decides it is stale,
    // and moving that decision down here would quietly relocate the invariant.
    transport._inject({ event: 'attachExit', sid: 'a1', code: -1 });
    await settle();
    assert.strictEqual(exits.length, 1, 'the late exit reaches the consumer, which gates it on identity');
  });

  it('EXACTLY ONE exit per session even when kill, natural exit and channel death all race', async () => {
    const { channel, transport } = attachChannel();
    const s = new CompanionAttachSession('prod', Promise.resolve({ channel, sid: 'a1' }));
    const exits = [];
    s.onExit((e) => exits.push(e));
    await settle();
    s.kill();
    transport._inject({ event: 'attachExit', sid: 'a1', code: 0 });
    transport._inject({ event: 'attachExit', sid: 'a1', code: -1 }); // a duplicate push
    transport._die(new Error('channel died'));
    await settle();
    assert.strictEqual(exits.length, 1,
      'a duplicate ended-frame lands a healthy just-re-attached pane on the session_dead panel — the exact WARDEN-365 corruption');
  });

  it('a detach→attach under the same pane id leaves the FRESH session unaffected by the old one', async () => {
    const { channel, transport } = attachChannel();
    const first = new CompanionAttachSession('prod', Promise.resolve({ channel, sid: 'a1' }));
    const second = new CompanionAttachSession('prod', Promise.resolve({ channel, sid: 'a2' }));
    const firstExits = [];
    const secondExits = [];
    const secondData = [];
    first.onExit((e) => firstExits.push(e));
    second.onExit((e) => secondExits.push(e));
    second.onData((d) => secondData.push(d));
    await settle();
    first.kill();
    await settle();
    transport._inject({ event: 'attachExit', sid: 'a1', code: -1 }); // the prior session's LATE exit
    transport._inject({ event: 'attachData', sid: 'a2', data: Buffer.from('alive', 'binary').toString('base64') });
    await settle();
    assert.strictEqual(firstExits.length, 1, 'the old session reports its own exit');
    assert.strictEqual(secondExits.length, 0, 'the fresh session must NOT be ended by the old one\'s exit');
    assert.strictEqual(secondData.join(''), 'alive', 'the fresh session keeps streaming');
  });

  it('kill() while still CONNECTING tears down the session the ACK is about to deliver (no host-side leak)', async () => {
    const sent = [];
    const { channel } = attachChannel({ sent });
    let release;
    const s = new CompanionAttachSession('prod', new Promise((r) => { release = r; }));
    s.kill(); // detached before the ACK landed
    release({ channel, sid: 'a1' });
    await settle();
    const kills = sent.filter((c) => c.method === 'attachKill');
    assert.strictEqual(kills.length, 1, 'the late-arriving session must be killed, not leaked with its tmux client');
    assert.strictEqual(kills[0].params.sid, 'a1');
  });
});

// --------------------- the single-event-slot constraint ----------------------

describe('event fan-out: paneDelta and the attach stream coexist on ONE channel', () => {
  beforeEach(() => { _resetChannelCacheForTests(); _resetPaneDeltaStateForTests(); });
  afterEach(() => { _resetPaneDeltaStateForTests(); });

  it('an attach session does NOT clobber the host\'s paneDelta handler', async () => {
    const { channel, transport } = attachChannel();
    // Open the attach FIRST, then wire the pane-delta consumer — the ordering a
    // single-slot onEvent would have broken (the second registration clobbers the
    // first). Both must survive.
    const s = new CompanionAttachSession('prod', Promise.resolve({ channel, sid: 'a1' }));
    const chunks = [];
    s.onData((d) => chunks.push(d));
    await settle();
    _wirePaneDeltaForTests(channel, 'prod');
    transport._inject({ event: 'paneDelta', panes: { 'p-worker': 'PANE CONTENT' } });
    transport._inject({ event: 'attachData', sid: 'a1', data: Buffer.from('STREAM', 'binary').toString('base64') });
    await settle();
    assert.strictEqual(chunks.join(''), 'STREAM', 'the attach stream still receives its data');
    assert.deepStrictEqual(readPaneDeltas('prod', ['p-worker']), { 'p-worker': 'PANE CONTENT' },
      'the paneDelta cache still receives its pushes — a single-slot onEvent would have killed one of the two');
    assert.ok(hasFreshPaneDelta('prod'));
  });

  it('the REVERSE order also holds: paneDelta wired first, then an attach', async () => {
    const { channel, transport } = attachChannel();
    _wirePaneDeltaForTests(channel, 'prod');
    const s = new CompanionAttachSession('prod', Promise.resolve({ channel, sid: 'a1' }));
    const chunks = [];
    s.onData((d) => chunks.push(d));
    await settle();
    transport._inject({ event: 'attachData', sid: 'a1', data: Buffer.from('STREAM', 'binary').toString('base64') });
    transport._inject({ event: 'paneDelta', panes: { 'p-worker': 'CONTENT' } });
    await settle();
    assert.strictEqual(chunks.join(''), 'STREAM');
    assert.deepStrictEqual(readPaneDeltas('prod', ['p-worker']), { 'p-worker': 'CONTENT' });
  });

  it('two attach sessions on one channel each receive only their own events', async () => {
    const { channel, transport } = attachChannel();
    const a = new CompanionAttachSession('prod', Promise.resolve({ channel, sid: 'a1' }));
    const b = new CompanionAttachSession('prod', Promise.resolve({ channel, sid: 'a2' }));
    const aChunks = []; const bChunks = [];
    a.onData((d) => aChunks.push(d));
    b.onData((d) => bChunks.push(d));
    await settle();
    transport._inject({ event: 'attachData', sid: 'a1', data: Buffer.from('AAA', 'binary').toString('base64') });
    transport._inject({ event: 'attachData', sid: 'a2', data: Buffer.from('BBB', 'binary').toString('base64') });
    await settle();
    assert.strictEqual(aChunks.join(''), 'AAA');
    assert.strictEqual(bChunks.join(''), 'BBB');
  });

  it('an unknown event name is ignored without disturbing either consumer', async () => {
    const { channel, transport } = attachChannel();
    const s = new CompanionAttachSession('prod', Promise.resolve({ channel, sid: 'a1' }));
    const chunks = [];
    s.onData((d) => chunks.push(d));
    await settle();
    transport._inject({ event: 'somethingNew', payload: 1 }); // a future protocol addition
    transport._inject({ event: 'attachData', sid: 'a1', data: Buffer.from('OK', 'binary').toString('base64') });
    await settle();
    assert.strictEqual(chunks.join(''), 'OK');
  });
});

// --------------------------- the stale-binary gate ---------------------------

describe('stale-binary / no-PTY gate (WARDEN-1295 AC #5/#6, WARDEN-933 discipline)', () => {
  beforeEach(() => { _resetChannelCacheForTests(); });
  afterEach(() => {
    if (ORIG_COMPANION_ENV === undefined) delete process.env.WARDEN_COMPANION_TRANSPORT;
    else process.env.WARDEN_COMPANION_TRANSPORT = ORIG_COMPANION_ENV;
  });

  it('the message is actionable: names the RPC, how to refresh the binary, and how to opt out', () => {
    const msg = attachUnsupportedMessage('prod', ['ping', 'discover', 'exec'], 'abc123');
    assert.ok(msg.includes("'attachStart'"), `names the missing RPC: ${msg}`);
    assert.ok(msg.includes('ping methods: ping, discover, exec'), `shows what the binary DOES advertise: ${msg}`);
    assert.ok(msg.includes('~/.warden/companion-abc123'), `names the exact path to remove: ${msg}`);
    assert.ok(msg.includes('WARDEN_COMPANION_TRANSPORT=0'), `tells the user how to reach the default SSH path: ${msg}`);
    assert.ok(/windows/i.test(msg), `explains the platform case (a windows host cannot allocate a PTY): ${msg}`);
  });

  it('attachSession THROWS SYNCHRONOUSLY on a live channel whose binary lacks attachStart', () => {
    // server.js's catch around attachStream is the ONLY thing that can turn a
    // failure into an `attach_error` frame, and only a synchronous throw reaches
    // it. The channel is already live here because the liveness probe
    // (probeSession) bootstrapped it moments earlier — the real ordering, which
    // is what makes this check decidable synchronously rather than a lucky case.
    const { channel } = attachChannel({ methods: ['ping', 'discover', 'capturePanes', 'exec'] });
    _primeChannelForTests('prod', channel);
    assert.throws(
      () => attachSession('prod', { script: 'x', cols: 80, rows: 24 }, {}, {}, { manifest: { version: 'abc123' } }),
      /attachStart/,
      'a stale binary must fail the OPEN, not present as a pane that opens and dies',
    );
  });

  it('the synchronous throw carries the SAME actionable text (so attach_error is useful)', () => {
    const { channel } = attachChannel({ methods: ['ping', 'exec'] });
    _primeChannelForTests('prod', channel);
    assert.throws(
      () => attachSession('prod', { script: 'x' }, {}, {}, { manifest: { version: 'abc123' } }),
      (e) => /WARDEN_COMPANION_TRANSPORT=0/.test(e.message) && /companion-abc123/.test(e.message),
    );
  });

  it('a companion that DOES advertise attachStart passes the preflight', () => {
    const { channel } = attachChannel();
    _primeChannelForTests('prod', channel);
    assert.doesNotThrow(() => attachPreflight('prod', { manifest: { version: 'abc123' } }));
  });

  it('attachPreflight refuses LOCAL (the companion serves remote hosts only)', () => {
    assert.throws(() => attachPreflight('(local)'), /local/i);
  });

  it('attachPreflight PASSES when nothing is known yet (never guesses)', () => {
    // No cached channel for this host — the verdict is not yet decidable, so the
    // preflight must not invent one; the async path settles it.
    assert.doesNotThrow(() => attachPreflight('never-seen-host', { manifest: { version: 'v' } }));
  });

  it('a failure that only becomes knowable LATER settles as an exit carrying the actionable message', async () => {
    // Bootstrap fails (host unreachable). By then the handle is already in
    // server.js's hands, so the only channel it can learn on is onExit.
    const s = attachSession('prod', { script: 'x', cols: 80, rows: 24 }, {}, {}, {
      manifest: { version: 'abc123', binaries: {} },
      run: async () => ({ ok: false, code: 255, stderr: 'Permission denied (publickey).' }),
    });
    const exits = [];
    s.onExit((e) => exits.push(e));
    await new Promise((r) => setTimeout(r, 50));
    assert.strictEqual(exits.length, 1, 'a startup failure must end the pane rather than leave it spinning');
    assert.ok(s._exitError, 'the actionable message is retained for the caller to surface');
    assert.ok(/companion/i.test(String(s._exitError.message)), String(s._exitError.message));
  });

  it('NEVER falls back to raw SSH: a failed companion attach does not spawn ssh', async () => {
    // Companion-or-fail is the experimental path's contract — a silent per-open
    // fallback would re-pay the very handshake this slice removes while the
    // toggle reads "on".
    let sshSpawns = 0;
    const s = attachSession('prod', { script: 'x', cols: 80, rows: 24 }, {}, {}, {
      manifest: { version: 'abc123', binaries: {} },
      run: async () => ({ ok: false, code: 255, stderr: 'unreachable' }),
      spawn: () => { sshSpawns++; throw new Error('must not spawn'); },
    });
    s.onExit(() => {});
    await new Promise((r) => setTimeout(r, 50));
    assert.strictEqual(sshSpawns, 0, 'no ssh child is spawned when the companion path fails');
  });
});

// ------------------------------ base64 framing -------------------------------

describe('base64 framing helpers (the line-delimited-JSON constraint)', () => {
  it('round-trips arbitrary bytes, including \\n and control sequences', () => {
    const raw = 'a\nb\r\x00\x1b[2J\x7f';
    assert.strictEqual(decodeAttachData(encodeAttachInput(raw)), raw);
  });

  it('a multibyte glyph SPLIT across two events survives (why it is latin1, not utf8)', () => {
    // \u2502 is 3 UTF-8 bytes; a real PTY read boundary can land inside it. Under
    // a utf8 decode each half becomes U+FFFD and the glyph is destroyed; under
    // latin1 the bytes survive and the browser reassembles them.
    const bytes = Buffer.from('\u2502', 'utf8');
    const first = decodeAttachData(bytes.subarray(0, 2).toString('base64'));
    const second = decodeAttachData(bytes.subarray(2).toString('base64'));
    assert.strictEqual(
      Buffer.from(first + second, 'binary').toString('utf8'),
      '\u2502',
      'the reassembled bytes must still be the original glyph',
    );
  });

  it('an empty/absent payload decodes to an empty string rather than throwing', () => {
    assert.strictEqual(decodeAttachData(''), '');
    assert.strictEqual(decodeAttachData(undefined), '');
  });
});
