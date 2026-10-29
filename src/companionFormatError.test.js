// Pins formatCompanionError (src/companionTransport.js) — WARDEN-2020.
//
// formatCompanionError is the single place every companion op builds its
// user-facing {error}/stderr text (and the per-host status `lastError` tooltip).
// It has three branches: CompanionTransportError (message + ' ' + recovery),
// CompanionRpcError (bare message) and a generic fallback
// `companion ${op} failed on ${host}: ${message}`. The existing op tests only
// assert `includes(...)` fragments, so the exact fallback / RPC / transport text
// was unpinned. This file asserts exact equality, driving the REAL op functions
// (no real ssh, no binary) through the deps seam.
//
// The bootstrap binaries use the REAL companion/dist filenames: a fake name makes
// bootstrap fail first with 'bundled companion binary not found' (itself a
// CompanionTransportError) and would mask the plain-Error fallback under test.
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import {
  CompanionTransportError, getChannel, getCompanionStatus,
  discover, capturePanes, hasSession, spawnSession, killSession, subscribePanes,
  resize, send, sendKey,
  _resetChannelCacheForTests, _resetPaneDeltaStateForTests,
} from './companion.js';

const HOST = 'prod';
const VERSION = 'abc123def456';
const MANIFEST = {
  version: VERSION,
  binaries: {
    'linux/amd64': 'warden-companion-linux-amd64',
    'linux/arm64': 'warden-companion-linux-arm64',
    'darwin/amd64': 'warden-companion-darwin-amd64',
    'darwin/arm64': 'warden-companion-darwin-arm64',
  },
};

// Bootstrap deps whose first remote step throws `err`.
function throwingDeps(err = new Error('boom')) {
  return {
    manifest: MANIFEST,
    run: async () => { throw err; },
    upload: async () => ({ ok: true }),
    spawnChannel: () => { throw new Error('unreached'); },
  };
}

let savedTransport;
beforeEach(() => {
  savedTransport = process.env.WARDEN_COMPANION_TRANSPORT;
  process.env.WARDEN_COMPANION_TRANSPORT = '1';
  _resetChannelCacheForTests();
  _resetPaneDeltaStateForTests();
});
afterEach(() => {
  if (savedTransport === undefined) delete process.env.WARDEN_COMPANION_TRANSPORT;
  else process.env.WARDEN_COMPANION_TRANSPORT = savedTransport;
  _resetChannelCacheForTests();
  _resetPaneDeltaStateForTests();
});

describe('formatCompanionError generic fallback — named-op {error} family', () => {
  const pane = { key: 'k1', container: 'c1', session: 's1' };
  const ops = [
    ['discover', (d) => discover(HOST, {}, {}, d)],
    ['capturePanes', (d) => capturePanes(HOST, [], {}, {}, d)],
    ['hasSession', (d) => hasSession(HOST, { container: 'c1', session: 's1' }, {}, {}, d)],
    ['spawnSession', (d) => spawnSession(HOST, { container: 'c1', session: 's1' }, {}, {}, d)],
    ['killSession', (d) => killSession(HOST, { container: 'c1', session: 's1' }, {}, {}, d)],
    ['subscribePanes', (d) => subscribePanes(HOST, [pane], {}, {}, d)],
  ];
  for (const [op, call] of ops) {
    it(`${op} renders exactly "companion ${op} failed on prod: boom"`, async () => {
      const res = await call(throwingDeps());
      assert.strictEqual(res.ok, false);
      assert.strictEqual(res.error, `companion ${op} failed on ${HOST}: boom`);
    });
  }
});

describe('formatCompanionError generic fallback — raw-shape stderr family (default op name)', () => {
  const ops = [
    ['resize', (d) => resize(HOST, { container: 'c1', session: 's1' }, {}, {}, d)],
    ['send', (d) => send(HOST, { container: 'c1', session: 's1', text: 'hi' }, {}, {}, d)],
    ['sendKey', (d) => sendKey(HOST, { container: 'c1', session: 's1', key: 'Enter' }, {}, {}, d)],
  ];
  for (const [name, call] of ops) {
    it(`${name} renders exactly "companion op failed on prod: boom" on stderr`, async () => {
      const res = await call(throwingDeps());
      assert.strictEqual(res.ok, false);
      assert.strictEqual(res.stderr, `companion op failed on ${HOST}: boom`);
    });
  }
});

describe('formatCompanionError generic fallback — thrown value shapes', () => {
  it('a thrown bare string renders as the value itself', async () => {
    const res = await discover(HOST, {}, {}, throwingDeps('bare string'));
    assert.strictEqual(res.error, 'companion discover failed on prod: bare string');
  });

  it('an Error with an empty message keeps the trailing separator and an empty tail', async () => {
    const res = await discover(HOST, {}, {}, throwingDeps(new Error('')));
    assert.strictEqual(res.error, 'companion discover failed on prod: ');
  });
});

describe('formatCompanionError via the per-host status surface', () => {
  it('getChannel failure stamps lastError with the default-op text', async () => {
    await assert.rejects(() => getChannel(HOST, {}, throwingDeps()), /boom/);
    assert.strictEqual(getCompanionStatus(HOST).lastError, 'companion op failed on prod: boom');
  });
});

describe('formatCompanionError CompanionTransportError branch', () => {
  it('is the error message, one space, then the recovery hint — exactly', async () => {
    const e = new CompanionTransportError(HOST, 'nope');
    const res = await discover(HOST, {}, {}, throwingDeps(e));
    assert.strictEqual(res.error, `${e.message} ${e.recovery}`);
    assert.ok(res.error.startsWith('companion transport error for prod: nope '));
  });
});

describe('formatCompanionError CompanionRpcError branch', () => {
  // A hand-rolled transport: answers ping with a version + methods, and every
  // other request with {ok:false, error:'docker ps failed'}.
  function rpcFailTransport() {
    let lineCB = null;
    return {
      write(line) {
        const req = JSON.parse(line);
        const resp = req.method === 'ping'
          ? { id: req.id, ok: true, result: { version: VERSION, methods: ['ping', 'discover'] } }
          : { id: req.id, ok: false, error: 'docker ps failed' };
        setImmediate(() => { if (lineCB) lineCB(JSON.stringify(resp)); });
      },
      onLine(cb) { lineCB = cb; },
      onExit() {},
      kill() {},
    };
  }

  it('is the bare RPC message with no op prefix and no recovery hint — exactly', async () => {
    const deps = {
      manifest: MANIFEST,
      run: async () => ({ ok: true, stdout: 'OS=Linux\nARCH=x86_64\nHAVE=0\n' }),
      upload: async () => ({ ok: true }),
      spawnChannel: () => rpcFailTransport(),
    };
    const res = await discover(HOST, {}, {}, deps);
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.error, 'companion RPC error on prod: docker ps failed');
  });
});
