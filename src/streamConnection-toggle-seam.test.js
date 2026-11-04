// WARDEN-2121 — the two companion-toggle gates of wireStreamConnection are driven
// by the injected deps seam, never by env:
//
//   1. syncMonitorSubscription's gate (monitor frame → subscribePanes RPC)
//   2. the close handler's release grouping (close → unsubscribePanes RPC)
//
// Both gates read `(deps.isCompanionTransportEnabled ?? isCompanionTransportEnabled)()`
// — the seam form WARDEN-2119 landed in tmux.js/chats.js/agentStatePoll.js. This
// suite is the unit harness the streamConnection.js module header documents: a
// direct wireStreamConnection call with a minimal fake ws (ws.on / readyState /
// OPEN / send) drives the real frame flow — no server, no real socket.
//
// The channel path is SEEDED, not env-driven: getChannel(HOST, cfg, deps) primes
// companion.js's channel cache with a fake transport (the
// companion-totality.test.js discipline), so a subscribePanes / unsubscribePanes
// RPC is OBSERVABLE as a delta on a wire log. This file never writes
// WARDEN_COMPANION_TRANSPORT — the injected-true leg therefore proves injection
// (not env) drove the gate: in a process where the env var is unset, the module
// fallback alone would read false and refuse. The production-parity leg proves
// the seam falls back to the very same module toggle (its expectation is computed
// from the module predicate itself, so the leg stays truthful whichever way the
// ambient env points).
//
// Detector-control ordering (WARDEN-997): every refusal leg runs AFTER a leg on
// the same seeded channel has shown the RPC it refuses, so an absence is
// attributable to the gate, not to a dead harness.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pollUntil } from './testWait.js';

const HOST = 'seamhost.invalid';
const TEST_VER = 'a0b1c2d3e4f5';
const uniq = () => Math.random().toString(36).slice(2, 8);

// Every RPC that crossed the seeded channel. A raw-ssh fallback cannot write
// here — the fake channel is the only writer, and the gate sits BEFORE it.
const WIRE = [];
const wireCount = (method) => WIRE.filter((w) => w.method === method).length;

// Flush every pending microtask/continuation: enough for onFrame's single
// `await resolve(id)` hop to reach syncMonitorSubscription (whose gate is
// synchronous) and for the close handler (synchronous) to have run.
const settle = () => new Promise((r) => setImmediate(() => setImmediate(() => setImmediate(r))));

function fakeTransport(handler) {
  let lineCB = null;
  return {
    write(line) {
      let resp = null;
      try { resp = handler(JSON.parse(line)); } catch { /* swallow */ }
      if (resp) setImmediate(() => { if (lineCB) lineCB(JSON.stringify(resp)); });
    },
    onLine(cb) { lineCB = cb; },
    onExit() {},
    kill() {},
  };
}

// Only the methods the two gates need — a stricter seeded channel than
// companion-totality's, so an unexpected op fails loudly as 'unknown method'.
const CHANNEL_METHODS = ['ping', 'subscribePanes', 'unsubscribePanes'];

function seamHandler(req) {
  WIRE.push({ method: req.method, params: req.params || {} });
  if (req.method === 'ping') return { id: req.id, ok: true, result: { version: TEST_VER, methods: CHANNEL_METHODS } };
  return { id: req.id, ok: true, result: {} };
}

function seedingDeps() {
  return {
    manifest: { version: TEST_VER, binaries: { 'linux/amd64': 'warden-companion-linux-amd64' } },
    run: async () => ({ ok: true, stdout: 'OS=Linux\nARCH=x86_64\nHAVE=0\n' }),
    upload: async () => ({ ok: true }),
    spawnChannel: () => fakeTransport(seamHandler),
  };
}

// The minimal fake ws the module header documents: wireStreamConnection needs
// only ws.on / ws.readyState / ws.OPEN / ws.send.
function fakeWs() {
  const handlers = {};
  const sent = [];
  return {
    OPEN: 1,
    readyState: 1,
    sent,
    on(ev, fn) { (handlers[ev] ||= []).push(fn); },
    fire(ev, arg) { for (const fn of handlers[ev] || []) fn(arg); },
    send(s) { sent.push(JSON.parse(s)); },
  };
}

describe('wireStreamConnection companion-toggle gates: driven by the injected deps seam, never by env', () => {
  let savedEnv, tempHome;
  let wireStreamConnection, moduleToggle, getChannel, _resetChannelCacheForTests, _resetPaneDeltaStateForTests;
  const cfg = { hosts: [] };

  const mkChat = () => {
    const session = `seam-${process.pid}-${uniq()}`;
    return {
      id: `${HOST}:${session}`, key: session, kind: 'tmux', host: HOST, container: null, session,
      project: 'p', role: 'claude', name: `name-${session}`, cwd: '', cmd: 'cat', active: true,
    };
  };

  // Wire one connection against the fake ws. `toggleImpl` undefined = NO deps
  // passed at all (the production call shape); otherwise deps carries exactly the
  // injected toggle.
  const wire = (chat, toggleImpl) => {
    const chatCatalog = { snapshot: () => [chat], has: () => true, refreshHost: async () => {} };
    const resolve = async () => ({ chat });
    const ws = fakeWs();
    wireStreamConnection(
      { ws, cfg, resolve, chatCatalog, paneInputTelemetry: undefined, appendEventSafe: undefined, LOCAL: '(local)' },
      ...(toggleImpl === undefined ? [] : [{ isCompanionTransportEnabled: toggleImpl }]),
    );
    // The close handler runs once per real socket; mirror that so a test cannot
    // double-release.
    let closed = false;
    return {
      ws,
      monitor: (id) => ws.fire('message', Buffer.from(JSON.stringify({ type: 'monitor', id }))),
      close: () => { if (!closed) { closed = true; ws.fire('close'); } },
    };
  };

  before(async () => {
    savedEnv = process.env.HOME;
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-stream-seam-'));
    process.env.HOME = tempHome;
    fs.mkdirSync(path.join(tempHome, '.yatfa-warden', 'sessions'), { recursive: true });
    // Dynamic imports AFTER the HOME redirect (config.js pins homedir at import).
    ({ wireStreamConnection } = await import('./streamConnection.js'));
    ({ isCompanionTransportEnabled: moduleToggle, getChannel, _resetChannelCacheForTests, _resetPaneDeltaStateForTests } = await import('./companion.js'));
    // Seed THE one channel for HOST. NOTE: WARDEN_COMPANION_TRANSPORT is
    // deliberately left wherever the environment has it — seeding does not need
    // it (the WARDEN-1475 no-bootstrap gate checks host exclusion, not the
    // toggle), and this file's whole point is that the injected toggle, not env,
    // decides the gates.
    await getChannel(HOST, cfg, seedingDeps());
  });

  after(async () => {
    _resetChannelCacheForTests();
    _resetPaneDeltaStateForTests();
    if (savedEnv === undefined) delete process.env.HOME; else process.env.HOME = savedEnv;
    if (tempHome) { try { fs.rmSync(tempHome, { recursive: true, force: true }); } catch { /* best effort */ } }
  });

  it('injected toggle=true — a monitor frame takes the subscription arm (subscribePanes rides the seeded channel) and close releases it', async () => {
    const chat = mkChat();
    const c = wire(chat, () => true);
    try {
      const beforeSub = wireCount('subscribePanes');
      c.monitor(chat.key);
      await pollUntil(() => wireCount('subscribePanes') > beforeSub, { timeout: 10000, what: 'subscribePanes RPC' });
      const beforeUnsub = wireCount('unsubscribePanes');
      c.close();
      await pollUntil(() => wireCount('unsubscribePanes') > beforeUnsub, { timeout: 10000, what: 'unsubscribePanes RPC' });
    } finally { c.close(); }
  });

  it('injected toggle=false — the monitor frame issues NO subscribePanes and close releases nothing (both gates refuse through the seam)', async () => {
    _resetPaneDeltaStateForTests(); // drop the previous leg's refs; a clean release map
    const chat = mkChat();
    const c = wire(chat, () => false);
    try {
      const beforeSub = wireCount('subscribePanes');
      c.monitor(chat.key);
      await settle();
      assert.strictEqual(wireCount('subscribePanes'), beforeSub,
        'no subscribePanes crossed the seeded channel — the injected toggle refused the monitor gate (the previous leg proved this same harness shows the RPC when the gate passes)');
      const beforeUnsub = wireCount('unsubscribePanes');
      c.close();
      await settle();
      assert.strictEqual(wireCount('unsubscribePanes'), beforeUnsub,
        'close released nothing — the injected toggle refused the close-handler release grouping');
    } finally { c.close(); }
  });

  it('with NO deps the gate follows the module toggle exactly (the seam falls back to the same predicate production reads)', async () => {
    _resetPaneDeltaStateForTests();
    const chat = mkChat();
    const c = wire(chat); // production call shape: no second argument at all
    try {
      const expected = moduleToggle(); // the very predicate the seam's ?? arm reads
      const before = wireCount('subscribePanes');
      c.monitor(chat.key);
      await settle();
      if (expected) {
        await pollUntil(() => wireCount('subscribePanes') > before, { timeout: 10000, what: 'subscribePanes RPC (module toggle on)' });
      } else {
        assert.strictEqual(wireCount('subscribePanes'), before,
          'module toggle off + no injection must read exactly as pre-seam production: no subscribePanes');
      }
    } finally { c.close(); }
    await settle();
  });
});
