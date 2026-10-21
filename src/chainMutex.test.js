import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createKeyedChain, createGlobalChain } from './chainMutex.js';
import { deferred } from './testGate.js';

// WARDEN-1870 — pins for the shared chain-mutex module. The four predecessor
// chains (persist.js writeQueues, config.js catalogChain, collections.js
// collectionsChain, observer.js sidTurnChains) each carried the same contract;
// these tests pin that contract once, at the module level:
//   - same-key calls queue and run strictly in issue order;
//   - different keys stay fully parallel;
//   - a rejecting call rejects for ITS caller only and never poisons later
//     calls on the same key (predecessor failure isolation);
//   - entries are cleaned up once the settling link is still the tail, so
//     pending() mirrors the persist.test.js pins (1 while in flight, 0 after);
//   - the global chain serializes everything through one implicit key.

// Macrotask boundary: guarantees every queued microtask (chain links, tail
// cleanup) has flushed before an assertion reads state.
const settle = () => new Promise((r) => setImmediate(r));

describe('createKeyedChain', () => {
  it('queues same-key calls and runs them strictly in issue order', async () => {
    const chain = createKeyedChain();
    const order = [];
    const gate = deferred();
    const p1 = chain.run('a', async () => {
      order.push('1-start');
      await gate.promise;
      order.push('1-end');
      return 'r1';
    });
    const p2 = chain.run('a', async () => {
      order.push('2-start');
      return 'r2';
    });
    await settle();
    // p2 must NOT have started while p1 is still in flight.
    assert.deepStrictEqual(order, ['1-start']);
    gate.resolve();
    assert.strictEqual(await p1, 'r1');
    assert.strictEqual(await p2, 'r2');
    assert.deepStrictEqual(order, ['1-start', '1-end', '2-start']);
  });

  it('runs different keys fully in parallel (a blocked key stalls no other key)', async () => {
    const chain = createKeyedChain();
    const gate = deferred();
    const blocked = chain.run('slow', async () => {
      await gate.promise;
      return 'slow';
    });
    const free = chain.run('fast', () => 'fast');
    // The unrelated key completes while 'slow' is still blocked.
    assert.strictEqual(await free, 'fast');
    gate.resolve();
    assert.strictEqual(await blocked, 'slow');
  });

  it('isolates a predecessor failure: the next same-key call still runs and succeeds', async () => {
    const chain = createKeyedChain();
    const failing = chain.run('k', async () => {
      throw new Error('first call fails');
    });
    const following = chain.run('k', () => 'recovered');
    await assert.rejects(failing, /first call fails/);
    assert.strictEqual(await following, 'recovered');
  });

  it('delivers a rejection to its own caller only, with the original error object', async () => {
    const chain = createKeyedChain();
    const err = new Error('caller-visible');
    await assert.rejects(
      chain.run('x', () => Promise.reject(err)),
      (e) => e === err,
    );
    // The chain stays usable for the same key afterwards.
    assert.strictEqual(await chain.run('x', () => 'after'), 'after');
  });

  it('pending() counts keys with work in flight and cleans up settled tails (1 -> 0)', async () => {
    const chain = createKeyedChain();
    const g1 = deferred();
    const g2 = deferred();
    assert.strictEqual(chain.pending(), 0);
    const p1 = chain.run('f1', async () => { await g1.promise; });
    const p2 = chain.run('f2', async () => { await g2.promise; });
    await settle();
    assert.strictEqual(chain.pending(), 2);
    g1.resolve();
    await p1;
    await settle(); // let f1's tail cleanup run
    assert.strictEqual(chain.pending(), 1); // f1 dropped, f2 still in flight
    g2.resolve();
    await p2;
    await settle();
    assert.strictEqual(chain.pending(), 0);
  });

  it('keeps a queued call pending until its turn: a queued link holds the key', async () => {
    const chain = createKeyedChain();
    const gate = deferred();
    const p1 = chain.run('k', async () => { await gate.promise; });
    const p2 = chain.run('k', () => {});
    await settle();
    assert.strictEqual(chain.pending(), 1); // 'k' queued or in flight, counted once
    gate.resolve();
    await Promise.all([p1, p2]);
    await settle();
    assert.strictEqual(chain.pending(), 0);
  });
});

describe('createGlobalChain', () => {
  it('serializes every call through one implicit key, in issue order', async () => {
    const chain = createGlobalChain();
    const order = [];
    const gate = deferred();
    const p1 = chain.run(async () => {
      order.push('1-start');
      await gate.promise;
      order.push('1-end');
    });
    const p2 = chain.run(() => { order.push('2-start'); });
    await settle();
    assert.deepStrictEqual(order, ['1-start']); // p2 blocked behind p1
    gate.resolve();
    await p1;
    await p2;
    assert.deepStrictEqual(order, ['1-start', '1-end', '2-start']);
  });

  it('a failing call rejects for its caller and does not block the next global call', async () => {
    const chain = createGlobalChain();
    const failing = chain.run(() => { throw new Error('boom'); });
    const following = chain.run(() => 'next');
    await assert.rejects(failing, /boom/);
    assert.strictEqual(await following, 'next');
  });
});
