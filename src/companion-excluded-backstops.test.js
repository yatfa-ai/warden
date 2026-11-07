// WARDEN-2183 — pins the two WARDEN-1390 *backstops* that
// companion-excluded-hosts.test.js never executes: the guarantee that a caller
// which MISSED its routing gate still cannot open a channel / put pushes on a
// host the user excluded (companionExcludedHosts).
//
//   1. attachPreflight — the one synchronous throw point every companion attach
//      passes through. tmux's own gate routes an excluded host to the raw
//      attach before it ever gets here, so the route-level suite never reaches
//      this line.
//   2. subscribePanes — its own early refusal. The wsLayer gate and
//      reconcilePaneSubscriptions' grouping filter excluded hosts BEFORE this
//      function, so only a direct call exercises the refusal.
//
// Each test primes a fake LIVE channel that would otherwise make the call
// succeed, so a dropped guard shows up as a success (or an RPC on the wire)
// rather than being masked by an unrelated failure. No ssh, ports or timers.
import { describe, it, before, after, afterEach } from 'node:test';
import assert from 'node:assert';
import {
  attachPreflight, attachSession, subscribePanes, CompanionChannel,
  _primeChannelForTests, _resetChannelCacheForTests,
  _resetPaneDeltaStateForTests, _getPaneSubscriptionsForTests,
} from './companion.js';

const EXCLUDED = 'win-box';
const OTHER = 'mac-box';
const ATTACH_METHODS = ['ping', 'attachStart', 'attachInput', 'attachResize', 'attachKill', 'subscribePanes', 'unsubscribePanes'];

let savedExclusionEnv;
let savedToggleEnv;

before(() => {
  savedExclusionEnv = process.env.WARDEN_COMPANION_EXCLUDED_HOSTS;
  savedToggleEnv = process.env.WARDEN_COMPANION_TRANSPORT;
  process.env.WARDEN_COMPANION_TRANSPORT = '1';
  process.env.WARDEN_COMPANION_EXCLUDED_HOSTS = EXCLUDED;
});

afterEach(() => {
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

// A live, attach/subscribe-capable channel for `host` whose transport records
// every RPC that crosses the wire.
function liveChannel(host) {
  const writes = [];
  let lineCB = null;
  const transport = {
    writes,
    write(line) {
      const req = JSON.parse(line);
      writes.push(req);
      let result = {};
      if (req.method === 'ping') result = { version: 'v', methods: ATTACH_METHODS };
      else if (req.method === 'subscribePanes') result = { subscribed: (req.params?.panes || []).length };
      setImmediate(() => { if (lineCB) lineCB(JSON.stringify({ id: req.id, ok: true, result })); });
    },
    onLine(cb) { lineCB = cb; },
    onExit() {},
    kill() {},
  };
  const channel = new CompanionChannel(host, transport);
  channel._methods = ATTACH_METHODS;
  return { channel, transport };
}

const PANES = [{ key: 'k1', container: 'c1', session: 'agent' }];

describe('WARDEN-2183 attachPreflight excluded-host backstop', () => {
  it('throws synchronously with the per-host remedy even when a live attach-capable channel is cached', () => {
    _primeChannelForTests(EXCLUDED, liveChannel(EXCLUDED).channel);
    assert.throws(
      () => attachPreflight(EXCLUDED, { manifest: { version: 'abc123' } }),
      (e) => /companion attach is excluded for win-box by the companionExcludedHosts setting/.test(e.message)
        && /Companion excluded hosts/.test(e.message)
        && !/WARDEN_COMPANION_TRANSPORT/.test(e.message),
    );
  });

  it('throws with no channel at all (the refusal does not depend on cache state)', () => {
    assert.throws(
      () => attachPreflight(EXCLUDED, { manifest: { version: 'abc123' } }),
      /companion attach is excluded for win-box by the companionExcludedHosts setting/,
    );
  });

  it('is host-scoped: the same primed channel on a non-excluded host passes', () => {
    _primeChannelForTests(OTHER, liveChannel(OTHER).channel);
    assert.doesNotThrow(() => attachPreflight(OTHER, { manifest: { version: 'abc123' } }));
  });

  it('attachSession on an excluded host throws synchronously and never spawns a channel', () => {
    let spawned = 0;
    const deps = { manifest: { version: 'abc123' }, spawnChannel: () => { spawned++; throw new Error('must not spawn'); } };
    assert.throws(
      () => attachSession(EXCLUDED, { script: 'x', cols: 80, rows: 24 }, {}, {}, deps),
      /companion attach is excluded for win-box/,
    );
    assert.strictEqual(spawned, 0, 'no channel may be spawned for an excluded host');
  });
});

describe('WARDEN-2183 subscribePanes excluded-host backstop', () => {
  it('refuses with ok:false / subscribed:false and the per-host remedy, spawning no channel', async () => {
    let spawned = 0;
    const deps = { manifest: { version: 'abc123' }, spawnChannel: () => { spawned++; throw new Error('must not spawn'); } };
    const r = await subscribePanes(EXCLUDED, PANES, {}, {}, deps);
    assert.strictEqual(r.host, EXCLUDED);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.subscribed, false);
    assert.match(r.error, /companion transport is excluded for win-box/);
    assert.match(r.error, /Companion excluded hosts/);
    assert.match(r.error, /default SSH path/);
    assert.strictEqual(spawned, 0);
  });

  it('writes no subscribePanes RPC onto a live cached channel and records no pane refs', async () => {
    const { channel, transport } = liveChannel(EXCLUDED);
    _primeChannelForTests(EXCLUDED, channel);
    const r = await subscribePanes(EXCLUDED, PANES);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(transport.writes.filter((w) => w.method === 'subscribePanes').length, 0);
    assert.strictEqual(transport.writes.length, 0, 'nothing at all crosses the wire for an excluded host');
    assert.strictEqual(_getPaneSubscriptionsForTests()[EXCLUDED], undefined);
  });

  it('is host-scoped: the same call on a non-excluded host subscribes, writes the RPC and records the panes', async () => {
    const { channel, transport } = liveChannel(OTHER);
    _primeChannelForTests(OTHER, channel);
    const r = await subscribePanes(OTHER, PANES);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.subscribed, true);
    assert.strictEqual(transport.writes.filter((w) => w.method === 'subscribePanes').length, 1);
    assert.deepStrictEqual(_getPaneSubscriptionsForTests()[OTHER], { k1: 1 });
  });
});
