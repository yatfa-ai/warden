// Shared cross-await serialization chains (WARDEN-1870).
//
// One dependency-free module for the promise-chain mutex that four earlier,
// separately-landed data-loss fixes each hand-rolled: the catalog mutation
// chain (config.js, WARDEN-991 — unserialized chats.json read-modify-writes
// resurrected killed chats), the collections chain (collections.js,
// WARDEN-1675 — concurrent creates persisted 1 of 5), the per-file write
// queue (persist.js, WARDEN-1734 — overlapping config.json writes left a
// stale file), and the per-sid turn chains (observer.js, WARDEN-1867 — two
// tabs on one sid erased each other's completed turns). Same pattern, four
// copies: chaining, failure isolation and bounded cleanup live here; the
// domain-specific halves (what runs inside the critical section, and the
// re-sync-under-the-lock discipline) stay at the call sites.
//
// CONTRACT, identical to every predecessor implementation:
// - Calls made while an earlier call on the same key is still in flight are
//   queued and run strictly in issue order (last-issued wins on disk).
// - A rejecting call NEVER poisons the chain for callers behind it: the chain
//   swallows the failure, while the promise `run` returns still rejects — for
//   its own caller only.
// - The internal map stays bounded by in-flight keys: an entry is deleted when
//   its settling link is still the tail (a queued newer call has already
//   replaced it), so `pending()` counts exactly the keys with a call queued or
//   in flight. This cleanup parity is pinned by persist.test.js
//   (`pendingWriteCount` 1→0) and mirrored by chainMutex.test.js.
//
// Same limitation as every one of the four originals: IN-PROCESS ONLY. A
// separate process (CLI vs server) is not ordered by any of this — see the
// LIMITATION notes in config.js / collections.js; closing the cross-process
// race needs a file lock and stays deliberately out of scope.

/** Key under which a global chain stores its single implicit chain. */
const GLOBAL_KEY = Symbol('chainMutex.global');

/**
 * Create a keyed chain: `{ run(key, fn), pending() }`.
 *
 * `run(key, fn)` queues `fn` behind the current tail for `key` and returns the
 * promise for THIS call (it resolves with `fn`'s value and rejects with `fn`'s
 * error; the chain itself only ever observes the swallowed form). `fn` is
 * invoked with no arguments — anything it reads must be read inside it, which
 * is exactly what makes read-modify-write callers safe (a pre-read snapshot
 * passed in would preserve the race the chains exist to fix).
 * `pending()` reports how many keys currently have a call queued or in flight.
 */
export function createKeyedChain() {
  // key -> the tail promise of that key's chain (the swallowed form, so the
  // stored predecessor never rejects and can never poison the next link).
  const chains = new Map();

  function run(key, fn) {
    const prev = chains.get(key) || Promise.resolve();
    const link = prev.catch(() => {}).then(() => fn());
    const tail = link.catch(() => {}).then(() => {
      // Drop the entry only when the settling link is still the tail; a queued
      // newer call has already replaced it.
      if (chains.get(key) === tail) chains.delete(key);
    });
    chains.set(key, tail);
    return link;
  }

  return {
    run,
    pending: () => chains.size,
  };
}

/**
 * Create a global chain: `{ run(fn) }` — a keyed chain with a single implicit
 * key, for whole-document mutations (chats.json, collections.json) that have
 * no natural sub-key to serialize on.
 */
export function createGlobalChain() {
  const keyed = createKeyedChain();
  return {
    run: (fn) => keyed.run(GLOBAL_KEY, fn),
  };
}
