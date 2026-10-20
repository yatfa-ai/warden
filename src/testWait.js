// Shared wall-clock wait primitives for the test suite (WARDEN-1877).
//
// One dependency-free module for the two timing idioms every load-flake fix
// (WARDEN-1631/1632, 1702, 1873, 1874) previously re-derived at its own fix
// site: a plain sleep, and a bounded poll. Same pattern, ~25 copies — the
// deadline math, the interval and the failure message lived differently in
// each file, so every new fix site re-invented them (slightly).
//
// CONTRACT:
// - `sleep(ms)` resolves after `ms` wall-clock milliseconds.
// - `pollUntil(fn, opts)` awaits `fn` (sync or async) and resolves with its
//   FIRST TRUTHY VALUE — call sites consume it (e.g. `const ev = await
//   pollUntil(...)` for a frame/event lookup; a boolean predicate works the
//   same way). Falsy results keep polling every `interval` ms until `timeout`
//   ms have elapsed, and then it THROWS an `Error` naming `what` plus, when
//   `describe` is given, the diagnostic detail `describe()` returns (sync or
//   async — e.g. a dump of the observed messages). That throw is the
//   red-on-bug. A call site that must fall through to its own trailing
//   assertion instead of this throw has to say so per-site (the one
//   resolve-anyway caller is companion.test.js's pane-push wait; see the note
//   there).
// - Defaults (`timeout` 5000ms, `interval` 25ms, `what` 'condition') are the
//   wsLayer suites' historical `waitFor` defaults, so a call site that only
//   names `what` keeps its old timing; every other migrated site pins its own
//   historical numbers explicitly.
//
// OUT OF SCOPE, deliberately — each is a different primitive, not a variant of
// these: setImmediate/recorded-clock settles, the fixed-timer failure-path
// settles, negative-window sleeps whose fixed window IS the assertion, and all
// production code.

/** Resolve after `ms` wall-clock milliseconds. */
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Poll `fn` until it returns a truthy value, and resolve with that value.
 *
 * `opts`:
 * - `what` — what is being waited for, named verbatim in the deadline error.
 * - `timeout` — deadline in ms (default 5000).
 * - `interval` — delay between attempts in ms (default 25).
 * - `describe` — optional (async) callback whose return value is appended to
 *   the deadline error as diagnostic context (the observed messages, the
 *   clients still attached, the last capture — whatever the site knows).
 *
 * `fn` is always evaluated at least once, and a truthy result always wins —
 * even one that lands after the deadline has passed.
 */
export async function pollUntil(fn, { what = 'condition', timeout = 5000, interval = 25, describe } = {}) {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - start > timeout) {
      const detail = describe ? `; ${await describe()}` : '';
      throw new Error(`timed out (${timeout}ms) waiting for ${what}${detail}`);
    }
    await sleep(interval);
  }
}
