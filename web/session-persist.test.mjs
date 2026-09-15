// Unit tests for the ordered async session persister (WARDEN-1376).
//
// electron/session-persist.cjs takes the main process's session-time state
// writes (the debounced telemetry-transmission-log save and the debounced
// window-state captures) off the main thread — main's event loop IS Chromium's
// browser UI thread, so every sync write there froze input delivery for its
// duration (the telemetry-confirmed win32 freezes). Ordering is the new risk an
// async whole-file rewrite introduces: two overlapping writers of one file must
// still apply in call order, and the exit path must be able to write
// synchronously (app.quit() will not wait for a promise).
//
// Run: node session-persist.test.mjs   (from web/)
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const { createSessionPersister } = require('../electron/session-persist.cjs');

let passed = 0;
const test = (name, fn) => {
  fn();
  passed += 1;
  console.log('  ok -', name);
};
// Async twin (the web/electron.test.mjs pattern).
const testAsync = (name, fn) =>
  fn().then(
    () => {
      passed += 1;
      console.log('  ok -', name);
    },
    (e) => {
      console.error('  NOT OK -', name, e && e.message);
      throw e;
    },
  );

const tick = () => new Promise((resolve) => setImmediate(resolve));

// ==========================================================================
// Ordering — the whole point of the module
// ==========================================================================

testAsync('concurrent async writes apply in CALL order (one in flight at a time)', async () => {
  const written = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const persister = createSessionPersister({
    writeAsync: (state) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      // A slow, variable-latency write: later states take LONGER, so a naive
      // implementation would let them finish out of order.
      const delay = state.n === 1 ? 1 : state.n === 2 ? 20 : 8;
      return new Promise((resolve) => setTimeout(() => {
        inFlight -= 1;
        written.push(state.n);
        resolve();
      }, delay));
    },
    writeSync: () => {},
  });
  persister.persist({ n: 1 });
  persister.persist({ n: 2 });
  persister.persist({ n: 3 });
  await persister.idle();
  assert.deepEqual(written, [1, 2, 3], 'disk order == call order regardless of latency');
  assert.equal(maxInFlight, 1, 'writes are serialized — never two in flight on one file');
});

testAsync('a FAILING async write does not wedge the chain — later writes still land', async () => {
  const errors = [];
  const written = [];
  const persister = createSessionPersister({
    writeAsync: (state) =>
      state.n === 2
        ? Promise.reject(new Error('disk gone'))
        : Promise.resolve().then(() => written.push(state.n)),
    writeSync: () => {},
    onError: (e) => errors.push(e),
  });
  persister.persist({ n: 1 });
  persister.persist({ n: 2 });
  persister.persist({ n: 3 });
  await persister.idle();
  assert.deepEqual(written, [1, 3], 'the failed write was skipped, the chain continued');
  assert.equal(errors.length, 1, 'the failure surfaced through onError exactly once');
  assert.equal(errors[0].message, 'disk gone');
});

testAsync('a SYNC-throwing writeAsync is contained the same way (chain continues)', async () => {
  const written = [];
  const persister = createSessionPersister({
    writeAsync: (state) => {
      if (state.n === 2) throw new Error('sync boom');
      return Promise.resolve().then(() => written.push(state.n));
    },
    writeSync: () => {},
    onError: () => {},
  });
  persister.persist({ n: 1 });
  persister.persist({ n: 2 });
  persister.persist({ n: 3 });
  await persister.idle();
  assert.deepEqual(written, [1, 3]);
});

testAsync('a throwing onError never breaks the persist chain', async () => {
  const written = [];
  const persister = createSessionPersister({
    writeAsync: () => Promise.reject(new Error('disk gone')),
    writeSync: () => {},
    onError: () => { throw new Error('listener boom'); },
  });
  persister.persist({ n: 1 });
  persister.persist({ n: 2 });
  await persister.idle();
  assert.deepEqual(written, []);
  assert.equal(persister.inFlight(), 0, 'the chain settled despite the throwing listener');
});

// ==========================================================================
// The sync exit path
// ==========================================================================

test('persistSync writes synchronously (durability before process exit)', () => {
  const written = [];
  const persister = createSessionPersister({
    writeAsync: () => new Promise(() => {}), // never settles — must not matter
    writeSync: (state) => written.push(state.n),
  });
  persister.persistSync({ n: 9 });
  assert.deepEqual(written, [9], 'the write landed before persistSync returned');
});

test('a throwing writeSync is swallowed and reported through onError (never breaks the quit path)', () => {
  const errors = [];
  const persister = createSessionPersister({
    writeAsync: () => Promise.resolve(),
    writeSync: () => { throw new Error('sync disk gone'); },
    onError: (e) => errors.push(e),
  });
  assert.doesNotThrow(() => persister.persistSync({ n: 1 }));
  assert.equal(errors.length, 1);
  assert.equal(errors[0].message, 'sync disk gone');
});

testAsync('inFlight tracks unsettled async writes (diagnostics)', async () => {
  let release;
  const persister = createSessionPersister({
    writeAsync: () => new Promise((resolve) => { release = resolve; }),
    writeSync: () => {},
  });
  persister.persist({ n: 1 });
  await tick(); // the chain step (and so the promise executor) runs on a microtask
  assert.equal(persister.inFlight(), 1, 'one write pending');
  release();
  await persister.idle();
  assert.equal(persister.inFlight(), 0, 'settled');
});

// ==========================================================================
// Missing dependencies fail fast and loudly (a mis-wired main.cjs must not
// silently persist nothing)
// ==========================================================================

test('a missing writeAsync/writeSync dependency throws on USE, not construction', () => {
  const persister = createSessionPersister({});
  assert.throws(() => persister.persist({}), TypeError);
  assert.throws(() => persister.persistSync({}), TypeError);
});

console.log(`\n✓ SESSION PERSIST TESTS PASS (${passed})`);
