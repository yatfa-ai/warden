// Tests for web/src/lib/stream.ts — the singleton WebSocket transport every
// terminal pane's I/O flows through (attach/detach, keystrokes, resize, all PTY
// output). It had zero coverage (WARDEN-1059) while owning four stateful
// branches nothing else guards:
//
//  1. THE PENDING QUEUE IS LOAD-BEARING ON EVERY COLD START. PaneTile.tsx:592
//     sends {type:'attach'} from a mount effect; App.tsx:517 calls connect() on
//     its own mount. The socket cannot be open yet, so that attach is BUFFERED
//     (stream.ts:41) and only reaches the server via the onopen flush
//     (stream.ts:21). If that flush regresses, restored panes silently never
//     attach — they sit on the connecting spinner with no error at all.
//  2. splice(0) DRAINS EXACTLY ONCE. onclose schedules a reconnect
//     (stream.ts:24), so a non-draining read would re-send every buffered
//     message on the SECOND open — a duplicate `attach` for a live PTY.
//  3. MALFORMED-FRAME ISOLATION (stream.ts:27) — one non-JSON frame must be
//     swallowed and the socket must keep serving every later valid frame.
//  4. DISPATCH ITERATES A COPY (stream.ts:30, `[...set]`) and on()'s cleanup
//     DELETES THE MAP KEY when the set empties (stream.ts:48-51). PaneTile.tsx:548
//     returns that unsubscribe as effect cleanup keyed [id], so pane open/close
//     churn exercises exactly this path — a leak here grows the handler map for
//     the life of the session.
//
// No FE test runner in this repo, so (like theme.test.mjs / storage.test.mjs)
// this loads the REAL stream.ts, transpiled TS -> ESM via Vite's OXC transform.
// stream.ts's only import is `import type { StreamMsg, StreamReq }` — erased by
// the transform, so the emitted module has ZERO runtime imports and loads
// standalone. WebSocket / location / setTimeout are installed as globals inside
// withEnv() and ALWAYS restored in a finally (a failing assertion must not leak
// a fake WebSocket into later files), with a leak assertion at the bottom.
//
// Because the module exports a SINGLETON, each test builds a fresh instance from
// the real class (`new (streamApi.constructor)()`) rather than re-importing —
// same code, no cross-test state bleed, no module-cache tricks.
//
// This file is auto-discovered by `npm test` (`node --test` runs every *.test.mjs
// in web/), so it runs in CI with no package.json wiring.
//
// NOT FIXED HERE (flagged, out of scope per the ticket): `pending` is unbounded,
// so a long disconnect grows it without limit. That is a source change; this diff
// is test-only.
//
// Run: node stream.test.mjs   (or: npm test, from web/)
import { transformWithOxc } from 'vite';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const streamPath = resolve(__dirname, 'src/lib/stream.ts');

// --- Load the REAL stream.ts (TS -> ESM via the OXC transform Vite bundles) ---
const { code } = await transformWithOxc(readFileSync(streamPath, 'utf8'), streamPath, {});
const tmpDir = mkdtempSync(join(tmpdir(), 'warden-stream-test-'));
const tmpFile = join(tmpDir, 'stream.mjs');
writeFileSync(tmpFile, code);
const { streamApi } = await import(tmpFile);
rmSync(tmpDir, { recursive: true, force: true });

// The real class, reached through the real exported singleton — so every test
// below drives the same constructor App.tsx and PaneTile.tsx drive.
const StreamApi = streamApi.constructor;
const newApi = () => new StreamApi();

let passed = 0;
const test = (name, fn) => {
  fn();
  passed += 1;
  console.log('  ok -', name);
};

// --- Environment stubs -------------------------------------------------------
// A fake WebSocket that records the url it was constructed with and every frame
// sent, plus explicit driver methods so a test states exactly when the socket
// opens, delivers a frame, or drops. readyState follows the real numeric
// contract (0 CONNECTING / 1 OPEN / 3 CLOSED) because stream.ts gates both
// _raw() and `ready` on `readyState === 1`.
const savedWebSocket = globalThis.WebSocket;
const savedLocation = globalThis.location;
const savedSetTimeout = globalThis.setTimeout;

const withEnv = ({ protocol = 'http:', host = 'localhost:7420' } = {}, fn) => {
  const sockets = [];
  const timers = [];

  class FakeWebSocket {
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.sent = [];
      this.onopen = null;
      this.onclose = null;
      this.onmessage = null;
      sockets.push(this);
    }
    send(data) { this.sent.push(data); }
    // --- drivers (not part of the WebSocket API; the test plays the network) ---
    open() { this.readyState = 1; this.onopen?.(); }
    emit(data) { this.onmessage?.({ data }); }
    drop() { this.readyState = 3; this.onclose?.(); }
  }

  globalThis.WebSocket = FakeWebSocket;
  globalThis.location = { protocol, host };
  // Capture timers instead of running them: the 1500ms reconnect delay is
  // asserted as a value, and the reconnect is stepped explicitly.
  globalThis.setTimeout = (cb, ms) => { timers.push({ cb, ms }); return timers.length; };

  const runTimers = () => { for (const t of timers.splice(0)) t.cb(); };

  try {
    return fn({ sockets, timers, runTimers });
  } finally {
    globalThis.WebSocket = savedWebSocket;
    globalThis.location = savedLocation;
    globalThis.setTimeout = savedSetTimeout;
  }
};

// Frames arrive as strings off the wire, so tests emit strings — the JSON.parse
// under test is the real one, never bypassed.
const frame = (o) => JSON.stringify(o);

console.log('\nconnect() — one socket per app, correct url');
test('two connect() calls construct exactly ONE WebSocket', () => {
  withEnv({}, ({ sockets }) => {
    const api = newApi();
    api.connect();
    api.connect();
    assert.equal(sockets.length, 1, 'the re-entrancy guard must collapse the second connect()');
  });
});
test('connect() targets ws://<host>/api/stream over http', () => {
  withEnv({ protocol: 'http:', host: 'localhost:7420' }, ({ sockets }) => {
    const api = newApi();
    api.connect();
    assert.equal(sockets[0].url, 'ws://localhost:7420/api/stream');
  });
});
test('connect() upgrades to wss:// when the page is https', () => {
  withEnv({ protocol: 'https:', host: 'warden.example.com' }, ({ sockets }) => {
    const api = newApi();
    api.connect();
    assert.equal(sockets[0].url, 'wss://warden.example.com/api/stream');
  });
});
test('the exported streamApi is a live instance of that same class', () => {
  assert.ok(streamApi instanceof StreamApi);
  assert.equal(streamApi.ws, null, 'the singleton starts unconnected');
});

console.log('\nthe pending queue — the cold-start attach path (PaneTile.tsx:592)');
test('send() before the socket opens BUFFERS instead of dropping', () => {
  withEnv({}, ({ sockets }) => {
    const api = newApi();
    api.connect(); // App.tsx:517 — socket is CONNECTING, not open
    api.send({ type: 'attach', id: 'pane-1', host: 'h', cols: 100, rows: 30 });
    assert.equal(sockets[0].sent.length, 0, 'nothing may reach a CONNECTING socket');
    assert.equal(api.pending.length, 1, 'the attach must be queued, not discarded');
  });
});
test('onopen flushes the whole queue, in FIFO order', () => {
  withEnv({}, ({ sockets }) => {
    const api = newApi();
    api.connect();
    const msgs = [
      { type: 'attach', id: 'pane-1', host: 'h', cols: 100, rows: 30 },
      { type: 'input', id: 'pane-1', data: 'ls\r' },
      { type: 'resize', id: 'pane-1', cols: 120, rows: 40 },
    ];
    for (const m of msgs) api.send(m);
    sockets[0].open();
    assert.deepEqual(sockets[0].sent, msgs.map(frame), 'flushed in send order — an attach must precede its input');
    assert.equal(api.pending.length, 0, 'the queue is drained by the flush');
  });
});
test('send() after open goes straight out, bypassing the queue', () => {
  withEnv({}, ({ sockets }) => {
    const api = newApi();
    api.connect();
    sockets[0].open();
    api.send({ type: 'input', id: 'pane-1', data: 'x' });
    assert.deepEqual(sockets[0].sent, [frame({ type: 'input', id: 'pane-1', data: 'x' })]);
    assert.equal(api.pending.length, 0);
  });
});
test('the queue drains EXACTLY ONCE — a reconnect does not re-send it', () => {
  withEnv({}, ({ sockets, runTimers }) => {
    const api = newApi();
    api.connect();
    api.send({ type: 'attach', id: 'pane-1', host: 'h', cols: 100, rows: 30 });
    sockets[0].open();
    assert.equal(sockets[0].sent.length, 1, 'precondition: the first open flushed it');

    sockets[0].drop();      // onclose → nulls ws, schedules the reconnect
    runTimers();            // the 1500ms reconnect fires
    assert.equal(sockets.length, 2, 'precondition: the reconnect built a second socket');
    sockets[1].open();
    assert.deepEqual(sockets[1].sent, [], 'a drained queue must not re-attach a live PTY');
  });
});
test('a send while disconnected is buffered and flushed by the RECONNECT open', () => {
  withEnv({}, ({ sockets, runTimers }) => {
    const api = newApi();
    api.connect();
    sockets[0].open();
    sockets[0].drop();
    // The socket is gone; PaneTile keeps sending. Nothing may be lost.
    api.send({ type: 'input', id: 'pane-1', data: 'typed-while-down' });
    assert.equal(api.pending.length, 1);
    runTimers();
    sockets[1].open();
    assert.deepEqual(sockets[1].sent, [frame({ type: 'input', id: 'pane-1', data: 'typed-while-down' })]);
  });
});

console.log('\nincoming frames — parse isolation and id routing');
test('a non-JSON frame is swallowed, and the NEXT valid frame still dispatches', () => {
  withEnv({}, ({ sockets }) => {
    const api = newApi();
    const seen = [];
    api.on('pane-1', (m) => seen.push(m));
    api.connect();
    sockets[0].open();
    assert.doesNotThrow(() => sockets[0].emit('<!DOCTYPE html> not json at all'));
    sockets[0].emit(frame({ type: 'pty', id: 'pane-1', data: 'hello' }));
    assert.deepEqual(seen, [{ type: 'pty', id: 'pane-1', data: 'hello' }], 'one bad frame must not poison the socket');
  });
});
test('a malformed frame never reaches onAnyMessage either', () => {
  withEnv({}, ({ sockets }) => {
    const api = newApi();
    let anyCalls = 0;
    api.onAnyMessage = () => { anyCalls += 1; };
    api.connect();
    sockets[0].open();
    sockets[0].emit('{"type":"pty",'); // truncated JSON
    assert.equal(anyCalls, 0);
    sockets[0].emit(frame({ type: 'pty', id: 'pane-1', data: 'x' }));
    assert.equal(anyCalls, 1, 'App.tsx:512 new-activity tracking still sees valid traffic');
  });
});
test('only handlers registered for m.id fire', () => {
  withEnv({}, ({ sockets }) => {
    const api = newApi();
    const one = [], two = [];
    api.on('pane-1', (m) => one.push(m.data));
    api.on('pane-2', (m) => two.push(m.data));
    api.connect();
    sockets[0].open();
    sockets[0].emit(frame({ type: 'pty', id: 'pane-1', data: 'a' }));
    assert.deepEqual(one, ['a']);
    assert.deepEqual(two, [], 'a pane must never receive another pane’s PTY output');
  });
});
test('onAnyMessage fires for an id with NO registered handler (no throw)', () => {
  withEnv({}, ({ sockets }) => {
    const api = newApi();
    const any = [];
    api.onAnyMessage = (m) => any.push(m.id);
    api.connect();
    sockets[0].open();
    assert.doesNotThrow(() => sockets[0].emit(frame({ type: 'pty', id: 'closed-pane', data: 'x' })));
    assert.deepEqual(any, ['closed-pane'], 'App.tsx still badges activity for a pane with no live tile');
  });
});

console.log('\ndispatch iterates a COPY of the handler set (stream.ts:30)');
test('a handler that unsubscribes ITSELF mid-dispatch does not disturb the others', () => {
  withEnv({}, ({ sockets }) => {
    const api = newApi();
    const fired = [];
    let offA;
    const a = () => { fired.push('a'); offA(); };
    offA = api.on('pane-1', a);
    api.on('pane-1', () => fired.push('b'));
    api.on('pane-1', () => fired.push('c'));
    api.connect();
    sockets[0].open();
    sockets[0].emit(frame({ type: 'pty', id: 'pane-1', data: 'x' }));
    assert.deepEqual(fired, ['a', 'b', 'c'], 'every handler registered at dispatch time runs');
    sockets[0].emit(frame({ type: 'pty', id: 'pane-1', data: 'y' }));
    assert.deepEqual(fired, ['a', 'b', 'c', 'b', 'c'], 'the self-unsubscribe took effect for the NEXT frame');
  });
});
test('a handler unsubscribed by an EARLIER handler still receives the in-flight frame', () => {
  // This is the branch the copy exists for: with a live `set`, removing a
  // not-yet-visited entry mid-iteration silently skips it.
  withEnv({}, ({ sockets }) => {
    const api = newApi();
    const fired = [];
    let offB;
    api.on('pane-1', () => { fired.push('a'); offB(); });
    offB = api.on('pane-1', () => fired.push('b'));
    api.connect();
    sockets[0].open();
    sockets[0].emit(frame({ type: 'pty', id: 'pane-1', data: 'x' }));
    assert.deepEqual(fired, ['a', 'b'], 'dispatch is a snapshot taken before the first handler runs');
    sockets[0].emit(frame({ type: 'pty', id: 'pane-1', data: 'y' }));
    assert.deepEqual(fired, ['a', 'b', 'a'], 'and b is genuinely gone from the next frame');
  });
});
test('a handler registered DURING dispatch does not receive the in-flight frame', () => {
  // The other half of snapshot semantics: iterating the live set would visit the
  // newly added entry, delivering one frame twice (and risking an unbounded loop).
  withEnv({}, ({ sockets }) => {
    const api = newApi();
    const fired = [];
    api.on('pane-1', () => {
      fired.push('a');
      if (fired.length === 1) api.on('pane-1', () => fired.push('late'));
    });
    api.connect();
    sockets[0].open();
    sockets[0].emit(frame({ type: 'pty', id: 'pane-1', data: 'x' }));
    assert.deepEqual(fired, ['a'], 'the late handler must not see the frame that created it');
    sockets[0].emit(frame({ type: 'pty', id: 'pane-1', data: 'y' }));
    assert.deepEqual(fired, ['a', 'a', 'late'], 'it does see the next one');
  });
});

console.log('\non() / unsubscribe — the map-cleanup contract (PaneTile.tsx:548)');
test('the LAST unsubscribe for an id removes the map key entirely', () => {
  withEnv({}, () => {
    const api = newApi();
    const off = api.on('pane-1', () => {});
    assert.equal(api.handlers.size, 1);
    off();
    assert.equal(api.handlers.has('pane-1'), false, 'a closed pane must not leave an empty Set behind');
    assert.equal(api.handlers.size, 0);
  });
});
test('an unsubscribe with siblings still registered KEEPS the key', () => {
  withEnv({}, () => {
    const api = newApi();
    const off = api.on('pane-1', () => {});
    api.on('pane-1', () => {});
    off();
    assert.equal(api.handlers.has('pane-1'), true);
    assert.equal(api.handlers.get('pane-1').size, 1);
  });
});
test('open/close churn over many panes leaves the map empty (no session-long leak)', () => {
  withEnv({}, () => {
    const api = newApi();
    for (let i = 0; i < 50; i += 1) {
      const off = api.on('pane-' + i, () => {});
      off();
    }
    assert.equal(api.handlers.size, 0, 'the handler map must not grow with pane churn');
  });
});
test('a double unsubscribe is harmless and does not disturb a re-registered id', () => {
  withEnv({}, ({ sockets }) => {
    const api = newApi();
    const off = api.on('pane-1', () => {});
    off();
    off(); // React can run a cleanup only once, but the contract must be idempotent
    const fired = [];
    api.on('pane-1', () => fired.push('fresh'));
    api.connect();
    sockets[0].open();
    sockets[0].emit(frame({ type: 'pty', id: 'pane-1', data: 'x' }));
    assert.deepEqual(fired, ['fresh'], 'the re-registered handler survives the stale cleanup');
  });
});

console.log('\nlifecycle — onOpen/onClose/ready and the 1500ms reconnect (App.tsx:510-511)');
test('onOpen fires on open and `ready` mirrors readyState === 1', () => {
  withEnv({}, ({ sockets }) => {
    const api = newApi();
    let conn = null;
    api.onOpen = () => { conn = true; };
    api.onClose = () => { conn = false; };
    api.connect();
    assert.equal(api.ready, false, 'CONNECTING is not ready');
    assert.equal(conn, null, 'the badge must not go green before the socket opens');
    sockets[0].open();
    assert.equal(api.ready, true);
    assert.equal(conn, true);
  });
});
test('onclose nulls the socket, fires onClose, and `ready` goes false', () => {
  withEnv({}, ({ sockets }) => {
    const api = newApi();
    let conn = null;
    api.onClose = () => { conn = false; };
    api.connect();
    sockets[0].open();
    sockets[0].drop();
    assert.equal(api.ws, null, 'a dead socket must be released so connect() can rebuild');
    assert.equal(api.ready, false);
    assert.equal(conn, false, 'the connection badge tracks reality');
  });
});
test('onclose schedules the reconnect at exactly 1500ms', () => {
  withEnv({}, ({ sockets, timers }) => {
    const api = newApi();
    api.connect();
    sockets[0].open();
    sockets[0].drop();
    assert.equal(timers.length, 1, 'exactly one reconnect is scheduled per drop');
    assert.equal(timers[0].ms, 1500);
    assert.equal(sockets.length, 1, 'and nothing reconnects before the delay elapses');
  });
});
test('the scheduled reconnect builds a new socket and re-arms onOpen', () => {
  withEnv({}, ({ sockets, runTimers }) => {
    const api = newApi();
    let opens = 0;
    api.onOpen = () => { opens += 1; };
    api.connect();
    sockets[0].open();
    sockets[0].drop();
    runTimers();
    assert.equal(sockets.length, 2);
    sockets[1].open();
    assert.equal(opens, 2, 'the badge goes green again after a recovered drop');
    assert.equal(api.ready, true);
  });
});
test('frames from the RECONNECTED socket dispatch to still-live handlers', () => {
  withEnv({}, ({ sockets, runTimers }) => {
    const api = newApi();
    const seen = [];
    api.on('pane-1', (m) => seen.push(m.data));
    api.connect();
    sockets[0].open();
    sockets[0].drop();
    runTimers();
    sockets[1].open();
    sockets[1].emit(frame({ type: 'pty', id: 'pane-1', data: 'after-reconnect' }));
    assert.deepEqual(seen, ['after-reconnect'], 'a surviving pane keeps receiving across a drop');
  });
});
test('a drop clears the connecting guard, so a manual connect() still works', () => {
  withEnv({}, ({ sockets }) => {
    const api = newApi();
    api.connect();
    sockets[0].drop(); // dropped while still CONNECTING (server refused)
    assert.equal(api.connecting, false, 'a stuck guard would wedge the app offline forever');
    api.connect();
    assert.equal(sockets.length, 2);
  });
});

console.log('\nglobals are restored — no fake WebSocket/location/setTimeout leaks to other suites');
test('globalThis.WebSocket / location / setTimeout are back to their originals', () => {
  assert.equal(globalThis.WebSocket, savedWebSocket);
  assert.equal(globalThis.location, savedLocation);
  assert.equal(globalThis.setTimeout, savedSetTimeout);
});

console.log(`\n✓ STREAM TRANSPORT TESTS PASS (${passed})`);
