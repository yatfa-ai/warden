// Direct unit suite for the shared bounded-retry policy (WARDEN-1074).
//
// src/retry.js (WARDEN-1067) is the SINGLE home of the retry policy consumed by
// both outbound-POST transports — src/notify.js (webhook) and
// src/telemetry-send.js (telemetry) — and by any transport that adopts the leaf
// later. Until this file existed its only coverage was transitive through those
// two suites, and that coverage had a measured hole: both suites assert the cap
// RELATIVE TO ITSELF (`assert.strictEqual(r.attempts, _INTERNALS.MAX_ATTEMPTS)`
// at notify.test.js:218 and telemetry-send.test.js:334), so mutating
// MAX_ATTEMPTS 3 → 5 in retry.js turned ZERO of their 108 tests red. Neither
// isTransientStatus nor backoffMs was called directly by any test at all.
//
// This file pins the VALUES, not the values against themselves. It deliberately
// does NOT touch the two transport suites: their self-referential assertions are
// the regression guard proving WARDEN-1067's relocation was behavior-neutral and
// must stay exactly as they are. This adds the missing direct pin alongside them.
//
// What is deliberately NOT pinned: the exact millisecond backoffMs returns. The
// +/-25% jitter is non-deterministic BY DESIGN (anti-thunder-herd), so backoff is
// asserted as an ENVELOPE over many samples. Pinning an exact ms — or stubbing
// Math.random to fake one — would either make this suite flaky or freeze a
// property the production code intends to leave free.
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { MAX_ATTEMPTS, isTransientStatus, backoffMs, realSleep, noopLog } from './retry.js';

describe('MAX_ATTEMPTS', () => {
  // THE assertion that closes the mutation hole. Literal 3 — not
  // `r.attempts === MAX_ATTEMPTS`. A 3 → 5 edit to retry.js re-times the webhook
  // AND telemetry transports at once; this is the only test in the repo that
  // goes red when that happens.
  it('is exactly 3', () => {
    assert.strictEqual(MAX_ATTEMPTS, 3);
  });

  it('is a positive integer (a bound the retry loops can actually terminate on)', () => {
    assert.ok(Number.isInteger(MAX_ATTEMPTS), 'must be an integer — loops compare attempt counts to it');
    assert.ok(MAX_ATTEMPTS > 0, 'must be > 0 — a cap of 0 would send nothing at all');
  });
});

describe('isTransientStatus', () => {
  // Truth table over the real boundaries. Retryable: rate-limit + 5xx. Everything
  // else is permanent for these payloads — the body is already fixed by the time
  // it reaches the transport, so retrying an identical body cannot fix a 4xx.
  const TRANSIENT = [
    [429, 'rate limit — the one retryable 4xx'],
    [500, '5xx lower bound'],
    [502, 'bad gateway'],
    [503, 'service unavailable — the canonical receiver-is-down case'],
    [504, 'gateway timeout'],
    [599, '5xx upper bound, inclusive'],
  ];

  const PERMANENT = [
    [199, 'below any success code'],
    [200, 'success is not a retry'],
    [204, 'success is not a retry'],
    [301, '3xx is not transient'],
    [400, 'bad request — the body cannot fix itself'],
    [401, 'unauthorized — a retry sends the same bad credentials'],
    [404, 'wrong endpoint — retrying will not create it'],
    [410, 'gone'],
    [415, 'schema drift — telemetry circuit-breaks on this, never retries it'],
    [422, 'unprocessable — the payload is wrong, not the moment'],
    [499, 'just below the 5xx lower bound'],
    [600, 'ABOVE the 5xx upper bound — the `<= 599` half of the predicate'],
    [700, 'well above any real status'],
  ];

  for (const [status, why] of TRANSIENT) {
    it(`${status} is transient (${why})`, () => {
      assert.strictEqual(isTransientStatus(status), true);
    });
  }

  for (const [status, why] of PERMANENT) {
    it(`${status} is NOT transient (${why})`, () => {
      assert.strictEqual(isTransientStatus(status), false);
    });
  }

  // The upper bound is load-bearing and is the documented reason src/llm.js's
  // drifted copy (a bare `>= 500` at llm.js:89) was EXCLUDED from the extraction
  // in WARDEN-1067. Someone "simplifying" `>= 500 && <= 599` down to `>= 500`
  // would make the leaf look adoptable by llm.js while silently changing what
  // both transports retry. 499/500 and 599/600 are the two edges that catch it.
  it('brackets the 5xx range exactly at both edges (499|500 and 599|600)', () => {
    assert.strictEqual(isTransientStatus(499), false, 'lower edge: 499 is outside');
    assert.strictEqual(isTransientStatus(500), true, 'lower edge: 500 is inside');
    assert.strictEqual(isTransientStatus(599), true, 'upper edge: 599 is inside');
    assert.strictEqual(isTransientStatus(600), false, 'upper edge: 600 is outside — a bare `>= 500` fails here');
  });

  it('returns a real boolean, not a truthy value', () => {
    // The retry loops branch on this directly; a truthy non-boolean would still
    // "work" but would break strict comparisons in callers and in these tests.
    assert.strictEqual(typeof isTransientStatus(503), 'boolean');
    assert.strictEqual(typeof isTransientStatus(404), 'boolean');
  });
});

describe('backoffMs', () => {
  // Jittered exponential: base = 200 * 2**attempt, then +/-25% of base. The
  // envelope per attempt is therefore [base * 0.75, base * 1.25]. These bounds
  // are the real observed envelope of the merged implementation, not a guess.
  const SAMPLES = 3000;
  const ENVELOPES = [
    [0, 150, 250],
    [1, 300, 500],
    [2, 600, 1000],
  ];

  for (const [attempt, lo, hi] of ENVELOPES) {
    it(`attempt ${attempt} always lands in [${lo}, ${hi}] (base ${200 * 2 ** attempt} +/-25%)`, () => {
      let min = Infinity;
      let max = -Infinity;
      for (let i = 0; i < SAMPLES; i++) {
        const ms = backoffMs(attempt);
        assert.ok(
          ms >= lo && ms <= hi,
          `backoffMs(${attempt}) returned ${ms}, outside the +/-25% envelope [${lo}, ${hi}]`,
        );
        if (ms < min) min = ms;
        if (ms > max) max = ms;
      }
      // Exponential growth: each attempt's WHOLE envelope sits above the previous
      // attempt's. Asserting the observed extremes (rather than a single sample)
      // keeps this deterministic while still catching a linear/constant backoff.
      assert.ok(min >= lo, `observed minimum ${min} fell below ${lo}`);
      assert.ok(max <= hi, `observed maximum ${max} rose above ${hi}`);
    });
  }

  it('never returns a negative delay', () => {
    // The Math.max(0, ...) clamp. Includes hostile/degenerate inputs a caller
    // should never pass but which must not produce a negative setTimeout.
    for (const attempt of [0, 1, 2, 3, 5, 10, -1, -5]) {
      for (let i = 0; i < 200; i++) {
        assert.ok(backoffMs(attempt) >= 0, `backoffMs(${attempt}) went negative`);
      }
    }
  });

  it('returns an integer (a whole millisecond)', () => {
    for (const attempt of [0, 1, 2, 3]) {
      for (let i = 0; i < 200; i++) {
        const ms = backoffMs(attempt);
        assert.ok(Number.isInteger(ms), `backoffMs(${attempt}) returned non-integer ${ms}`);
      }
    }
  });

  it('grows exponentially: every attempt-N delay is shorter than every attempt-N+1 delay', () => {
    // Computed from REAL samples, not from the envelope literals — the observed
    // extremes of each attempt must not overlap. Because the true envelopes are
    // disjoint (250 < 300, 500 < 600) this is deterministic in practice, and it
    // catches a regression to linear backoff, which narrows the gap between
    // successive attempts until the ranges collide.
    const extremes = [0, 1, 2].map((attempt) => {
      let min = Infinity;
      let max = -Infinity;
      for (let i = 0; i < SAMPLES; i++) {
        const ms = backoffMs(attempt);
        if (ms < min) min = ms;
        if (ms > max) max = ms;
      }
      return { attempt, min, max };
    });

    for (let n = 0; n < extremes.length - 1; n++) {
      const lower = extremes[n];
      const upper = extremes[n + 1];
      assert.ok(
        lower.max < upper.min,
        `attempt ${lower.attempt} (max ${lower.max}ms) must always be shorter than ` +
          `attempt ${upper.attempt} (min ${upper.min}ms) — the ranges overlap, so backoff is not doubling`,
      );
    }
  });

  it('is jittered — repeated calls for one attempt do not all return the same ms', () => {
    // Anti-thunder-herd is the whole point of the jitter term. If someone
    // deletes it, every client retries in lockstep and every one of these 500
    // samples is identical. (With real jitter, all-500-identical has probability
    // ~0 — this is not a flaky assertion.)
    const seen = new Set();
    for (let i = 0; i < 500; i++) seen.add(backoffMs(1));
    assert.ok(seen.size > 1, 'every sample was identical — the jitter term is gone');
  });
});

describe('realSleep', () => {
  it('returns a promise that actually waits the requested time', async () => {
    const started = Date.now();
    const result = await realSleep(25);
    const elapsed = Date.now() - started;
    // Lower bound only, and loose: timers may fire a hair early and the upper
    // bound is at the mercy of a loaded CI box, so pinning one would be flaky.
    assert.ok(elapsed >= 15, `realSleep(25) returned after only ${elapsed}ms — it did not wait`);
    assert.strictEqual(result, undefined, 'resolves with no value');
  });

  it('is thenable (the transports await it)', () => {
    const p = realSleep(0);
    assert.ok(p instanceof Promise, 'must return a Promise, not a sync value');
    return p;
  });

  it('resolves rather than hanging for a 0ms sleep', async () => {
    await realSleep(0);
  });
});

describe('noopLog', () => {
  it('returns undefined', () => {
    assert.strictEqual(noopLog(), undefined);
    assert.strictEqual(noopLog('anything', 1, { a: 2 }), undefined);
  });

  it('writes nothing anywhere — transports are fire-and-forget by default', () => {
    // The whole point of the seam's DEFAULT: a transport with no injected logger
    // must stay silent. This would catch `export const noopLog = console.log`.
    const captured = [];
    const realOut = process.stdout.write;
    const realErr = process.stderr.write;
    const realConsole = { log: console.log, warn: console.warn, error: console.error, info: console.info };
    process.stdout.write = (chunk) => { captured.push(String(chunk)); return true; };
    process.stderr.write = (chunk) => { captured.push(String(chunk)); return true; };
    console.log = console.warn = console.error = console.info = (...args) => { captured.push(args.join(' ')); };
    try {
      noopLog('webhook failed: 503');
      noopLog();
    } finally {
      process.stdout.write = realOut;
      process.stderr.write = realErr;
      console.log = realConsole.log;
      console.warn = realConsole.warn;
      console.error = realConsole.error;
      console.info = realConsole.info;
    }
    assert.deepStrictEqual(captured, [], `noopLog emitted output: ${JSON.stringify(captured)}`);
  });

  it('accepts any arguments without throwing (it stands in for a real logger)', () => {
    assert.doesNotThrow(() => noopLog('a', 'b', 'c', null, undefined, 0));
  });
});
