// Shared deferred-gate primitive for the test suite (WARDEN-1886).
//
// A "gate" is a promise the TEST holds open and releases from inside the test,
// so ordering/concurrency is driven by control flow rather than by wall-clock
// sleeps. The race-fix series (WARDEN-1867 / 1874 / 1878) re-derived it at
// every fix site under four different spellings (`defer`, `openGate`,
// `deferred` with and without `reject`, and inline `let release; new Promise`
// closures); this is the one shared definition. Sibling to testWait.js, which
// owns the wall-clock primitives (`sleep`, `pollUntil`) and deliberately
// excludes this family.
//
// CONTRACT:
// - `deferred()` returns `{ promise, resolve, reject }`. `promise` stays
//   pending until the test calls `resolve(value)` or `reject(err)`; a value
//   passed to `resolve` is what awaiters receive. Calling either more than
//   once is harmless (first settlement wins, as with any promise).
//
// OUT OF SCOPE, deliberately: the delay-knob stubs (`fetchDelayMs`,
// `ackMs`, `delayMs`, ...) — one line of state inside hand-written stubs
// whose transport logic differs per file; and all production code.

/** A manually-released promise, so concurrency is driven by control flow rather
 *  than by wall-clock sleeps. Returns `{ promise, resolve, reject }`. */
export function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
