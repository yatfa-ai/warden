// Tests for CompanionAttachSession._bind's EARLY-EXIT drain — an `attachExit`
// that arrives coalesced into the attachStart ACK chunk (the F2 race of
// WARDEN-1295, exit half).
//
// companion-attach.test.js pins the DATA half of that race (attachData riding
// the ACK). Every attachExit example there injects the exit AFTER the ACK,
// through the live listener, never through the `_early` buffer. The Go host
// pushes attachExit exactly once, so a fast-exiting command (bad container,
// `docker exec` failure, `bash -lc 'exit 1'`) ends in the same read as the ACK;
// if _bind's attachExit arm regressed, the pane would never learn the session
// ended and nothing else would tell it.
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import {
  CompanionChannel, attachSession,
  _primeChannelForTests, _resetChannelCacheForTests, _resetPaneDeltaStateForTests,
} from './companion.js';

// In-process transport; a handler returning an ARRAY delivers consecutive lines
// in ONE synchronous pass (a real transport handing _onLine a multi-line chunk).
function fakeTransport(handler) {
  let lineCB = null;
  return {
    write(line) {
      let resp = null;
      try { resp = handler(JSON.parse(line)); } catch { /* swallow */ }
      if (resp) {
        const lines = Array.isArray(resp) ? resp : [resp];
        setImmediate(() => { if (lineCB) for (const l of lines) lineCB(JSON.stringify(l)); });
      }
    },
    onLine(cb) { lineCB = cb; },
    onExit() {},
    kill() {},
    _inject(obj) { if (lineCB) lineCB(JSON.stringify(obj)); },
  };
}

const METHODS = ['ping', 'attachStart', 'attachInput', 'attachResize', 'attachKill'];
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const settle = () => new Promise((r) => setImmediate(() => setImmediate(r)));

// Primes a 'prod' channel whose attachStart answers [ACK{sid:'a1'}, ...after].
function setup(after, sent = []) {
  const t = fakeTransport((req) => {
    sent.push(req.method);
    if (req.method === 'ping') return { id: req.id, ok: true, result: { version: 'v', methods: METHODS } };
    if (req.method === 'attachStart') return [{ id: req.id, ok: true, result: { sid: 'a1' } }, ...after];
    return { id: req.id, ok: true, result: {} };
  });
  const ch = new CompanionChannel('prod', t);
  ch._methods = METHODS;
  _primeChannelForTests('prod', ch);
  const s = attachSession('prod', { script: 'true', cols: 80, rows: 24 }, {}, {}, { manifest: { version: 'v' } });
  return { s, t, sent };
}

describe('attachExit COALESCED into the ACK chunk settles the session once (_bind early-exit drain)', () => {
  beforeEach(() => { _resetChannelCacheForTests(); _resetPaneDeltaStateForTests(); });
  afterEach(() => { _resetPaneDeltaStateForTests(); });

  it('delivers exactly one onExit carrying the exit code', async () => {
    const { s } = setup([{ event: 'attachExit', sid: 'a1', code: 7 }]);
    const exits = [];
    s.onExit((e) => exits.push(e));
    await settle();
    assert.deepStrictEqual(exits, [{ exitCode: 7, signal: undefined }]);
  });

  it('coerces a non-numeric code to -1, never undefined', async () => {
    const { s } = setup([{ event: 'attachExit', sid: 'a1', code: 'oops' }]);
    const exits = [];
    s.onExit((e) => exits.push(e));
    await settle();
    assert.strictEqual(exits.length, 1);
    assert.strictEqual(exits[0].exitCode, -1);
  });

  it('delivers data before the exit in order and nothing after it', async () => {
    const { s } = setup([
      { event: 'attachData', sid: 'a1', data: b64('bye\n') },
      { event: 'attachExit', sid: 'a1', code: 0 },
      { event: 'attachData', sid: 'a1', data: b64('LATE') },
    ]);
    const chunks = [];
    const exits = [];
    s.onData((d) => chunks.push(d));
    s.onExit((e) => exits.push(e));
    await settle();
    assert.strictEqual(chunks.join(''), 'bye\n', 'data after the exit must not be delivered');
    assert.strictEqual(exits.length, 1);
    assert.strictEqual(exits[0].exitCode, 0);
  });

  it("ignores another session's coalesced attachExit and stays live", async () => {
    const { s, t } = setup([{ event: 'attachExit', sid: 'zz', code: 3 }]);
    const chunks = [];
    const exits = [];
    s.onData((d) => chunks.push(d));
    s.onExit((e) => exits.push(e));
    await settle();
    assert.deepStrictEqual(exits, [], 'a foreign sid must not end our session');
    assert.strictEqual(s._exited, false);
    t._inject({ event: 'attachData', sid: 'a1', data: b64('still alive') });
    assert.strictEqual(chunks.join(''), 'still alive');
    assert.strictEqual(s._exited, false);
  });

  it('never sends the write/resize issued before the ACK once the early exit lands', async () => {
    const { s, sent } = setup([{ event: 'attachExit', sid: 'a1', code: 1 }]);
    const exits = [];
    s.onExit((e) => exits.push(e));
    s.write('echo hi\n');
    s.resize(120, 40);
    await settle();
    assert.strictEqual(exits.length, 1);
    assert.ok(sent.includes('attachStart'), 'the session was started');
    assert.ok(!sent.includes('attachInput'), 'queued input is moot after an early exit');
    assert.ok(!sent.includes('attachResize'), 'queued resize is moot after an early exit');
  });
});
