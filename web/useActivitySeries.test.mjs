// Tests for web/src/lib/useActivitySeries.ts — the 60s activity-series poller hook
// behind the Fleet Health per-row sparklines, FleetActivityHeatmap and
// FleetStateTimeline (sole consumer: HealthDashboard). The server endpoint
// (activity-series-http.test.js) and the pure renderers (heatmap / stateTimeline /
// agentSparkline tests) are pinned elsewhere, and visiblePoller.test.mjs pins the
// poller core — but the hook's OWN contract had zero references in any suite,
// although it has already regressed once (WARDEN-1077/1078: "Loading… forever"
// because the hook had no error channel).
//
// WHAT IS PINNED:
//   - the request: /api/activity/series?after=<ISO(now-24h)>, colon percent-encoded,
//     window recomputed from Date.now() on EVERY poll, no bucket param;
//   - the cadence: one poller registration, 60_000 ms, deps [] (no options), and
//     fetch options derived from the 60s period via pollerFetchOptions (WARDEN-1144:
//     no retries, deadline below the period) rather than one-shot defaults;
//   - the outcomes: success sets series/clears error; a non-2xx is a failure
//     `HTTP <status>` (body never parsed, WARDEN-1078); a thrown Error is kept by
//     identity, a non-Error is wrapped; a blip after good data RETAINS the last
//     series while recording the error; loading flips true -> false exactly once.
//
// HARNESS (same seam-first shape as useWatchCatchup.test.mjs): the REAL hook is
// transpiled with vite's transformWithOxc; `react`, `@/lib/api` and
// `@/lib/useVisiblePoller` are rewritten onto a useState shim, a fake
// fetchBounded / pollerFetchOptions, and a poller recorder. The rewrites are
// ASSERTED, not assumed (react IS installed, so an unrewritten import would load
// the real react and throw outside a renderer — loud, never a silent pass).
//
// Run: node useActivitySeries.test.mjs   (or: npm test, from web/)
import { transformWithOxc } from 'vite';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const tmpDir = mkdtempSync(join(__dirname, '.use-activity-series-test-'));

writeFileSync(
  join(tmpDir, 'react-shim.mjs'),
  `
let current = null;
export const __aim = (inst) => { current = inst; };
export function useState(initial) {
  const self = current;
  const slot = self.cursor++;
  if (self.slots.length <= slot) {
    self.slots.push({ value: typeof initial === 'function' ? initial() : initial });
  }
  const cell = self.slots[slot];
  return [cell.value, (next) => {
    cell.value = typeof next === 'function' ? next(cell.value) : next;
    self.render();
  }];
}
`,
);

// Fake @/lib/api: a controllable fetchBounded and a recording pollerFetchOptions
// that hands back a unique sentinel (so the hook's options are asserted by identity).
writeFileSync(
  join(tmpDir, 'api-shim.mjs'),
  `
export const calls = { fetch: [], optionsFor: [] };
export const sentinel = { retries: 0, timeoutMs: 30000, tag: 'poller-options-sentinel' };
export const control = { impl: async () => { throw new Error('fetchBounded not configured'); } };
export function pollerFetchOptions(periodMs) {
  calls.optionsFor.push(periodMs);
  return sentinel;
}
export function fetchBounded(url, opts) {
  calls.fetch.push([url, opts]);
  return control.impl(url, opts);
}
`,
);

// Fake @/lib/useVisiblePoller: records each registration; the test fires it.
writeFileSync(
  join(tmpDir, 'poller-shim.mjs'),
  `
export const registrations = [];
export function useVisiblePoller(...args) {
  registrations.push(args);
}
`,
);

const emit = async (srcRel, outName, map) => {
  const p = resolve(__dirname, srcRel);
  const { code } = await transformWithOxc(readFileSync(p, 'utf8'), p, {});
  let out = code;
  for (const [from, to] of Object.entries(map)) {
    const before = out;
    out = out.replaceAll(`"${from}"`, `"${to}"`).replaceAll(`'${from}'`, `'${to}'`);
    if (before === out) assert.fail(`specifier rewrite ${from} -> ${to} did not land in ${srcRel}`);
  }
  assert.ok(!/from ['"]@\//.test(out), `${srcRel} still has an unrewritten @/ import`);
  assert.ok(!/from ['"]react['"]/.test(out), `${srcRel} still imports the real react`);
  writeFileSync(join(tmpDir, outName), out);
};
await emit('src/lib/useActivitySeries.ts', 'useActivitySeries.mjs', {
  react: './react-shim.mjs',
  '@/lib/api': './api-shim.mjs',
  '@/lib/useVisiblePoller': './poller-shim.mjs',
});

const { useActivitySeries } = await import(join(tmpDir, 'useActivitySeries.mjs'));
const { __aim: aimShim, useState: useStateShim } = await import(join(tmpDir, 'react-shim.mjs'));
const { calls, sentinel, control } = await import(join(tmpDir, 'api-shim.mjs'));
const { registrations } = await import(join(tmpDir, 'poller-shim.mjs'));
// pollerFetchOptions runs ONCE at hook-module load (a module-level constant), so
// snapshot that call now, before any per-test recorder reset.
const moduleLoadOptionsFor = [...calls.optionsFor];
rmSync(tmpDir, { recursive: true, force: true });

let passed = 0;
const test = async (name, fn) => {
  await fn();
  passed += 1;
  console.log('  ok -', name);
};

const realNow = Date.now;
const T0 = Date.parse('2026-10-27T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const setNow = (ms) => {
  Date.now = () => ms;
};

const mountHook = (runHook) => {
  const inst = { slots: [], cursor: 0, renders: 0, state: null, frames: [], render: null };
  inst.render = () => {
    aimShim(inst);
    inst.cursor = 0;
    inst.renders += 1;
    inst.state = runHook();
    inst.frames.push(inst.state);
    return inst.state;
  };
  inst.render();
  return inst;
};

// Fresh mount with clean recorders. `poll()` fires the poller callback registered at
// mount (the real hook keeps it for deps [] — setters are stable, so a first-render
// closure is exactly what production runs).
const mount = () => {
  calls.fetch.length = 0;
  registrations.length = 0;
  control.impl = async () => {
    throw new Error('fetchBounded not configured');
  };
  setNow(T0);
  const d = mountHook(() => useActivitySeries());
  d.poll = () => registrations[0][0]();
  return d;
};

const okResponse = (body) => ({
  ok: true,
  status: 200,
  json: async () => body,
});
const respondWith = (res) => {
  control.impl = async () => res;
};

try {
  console.log('\ndriver precondition');
  await test('a state write re-renders the driver', () => {
    let setN;
    const d = mountHook(() => {
      const [n, set] = useStateShim(1);
      setN = set;
      return { n };
    });
    assert.equal(d.state.n, 1);
    setN(2);
    assert.equal(d.state.n, 2);
    assert.equal(d.renders, 2);
  });

  console.log('\ninitial state and registration');
  await test('initial state is {series:null, loading:true, error:null} and nothing is fetched before the poller fires', () => {
    const d = mount();
    assert.deepEqual(d.state, { series: null, loading: true, error: null });
    assert.equal(calls.fetch.length, 0);
  });
  await test('registers exactly one poller: load fn, 60_000 ms, deps [], no options', () => {
    mount();
    assert.equal(registrations.length, 1);
    const [fn, ms, deps, ...rest] = registrations[0];
    assert.equal(typeof fn, 'function');
    assert.equal(ms, 60_000);
    assert.deepEqual(deps, []);
    assert.deepEqual(rest, [], 'no options (no runWhileHidden / mountPoll override)');
  });

  console.log('\nrequest');
  await test('requests /api/activity/series?after=<ISO(now-24h)> with the colons percent-encoded and no bucket param', async () => {
    const d = mount();
    respondWith(okResponse({}));
    await d.poll();
    assert.equal(calls.fetch.length, 1);
    const iso = new Date(T0 - 24 * HOUR).toISOString();
    assert.equal(iso, '2026-10-26T12:00:00.000Z');
    assert.equal(calls.fetch[0][0], '/api/activity/series?after=2026-10-26T12%3A00%3A00.000Z');
    assert.ok(!calls.fetch[0][0].includes('bucket'));
  });
  await test('the 24h window is recomputed from Date.now() on every poll', async () => {
    const d = mount();
    respondWith(okResponse({}));
    await d.poll();
    setNow(T0 + 60_000);
    await d.poll();
    assert.equal(calls.fetch.length, 2);
    assert.equal(calls.fetch[0][0], '/api/activity/series?after=2026-10-26T12%3A00%3A00.000Z');
    assert.equal(calls.fetch[1][0], '/api/activity/series?after=2026-10-26T12%3A01%3A00.000Z');
  });
  await test('fetch options come from pollerFetchOptions(60_000) (WARDEN-1144), passed through by identity', async () => {
    const d = mount();
    respondWith(okResponse({}));
    await d.poll();
    assert.deepEqual(moduleLoadOptionsFor, [60_000]);
    assert.equal(calls.fetch[0][1], sentinel);
  });

  console.log('\noutcomes');
  await test('success sets the series by identity, loading false, error null', async () => {
    const d = mount();
    const body = { buckets: [], agents: {} };
    respondWith(okResponse(body));
    await d.poll();
    assert.equal(d.state.series, body);
    assert.equal(d.state.loading, false);
    assert.equal(d.state.error, null);
  });
  await test('a non-2xx is a failure `HTTP 503`: body never parsed, series stays null, loading false (WARDEN-1078)', async () => {
    const d = mount();
    let parsed = false;
    respondWith({
      ok: false,
      status: 503,
      json: async () => {
        parsed = true;
        return {};
      },
    });
    await d.poll();
    assert.equal(parsed, false, 'the error body is never read as a series');
    assert.ok(d.state.error instanceof Error);
    assert.equal(d.state.error.message, 'HTTP 503');
    assert.equal(d.state.series, null);
    assert.equal(d.state.loading, false, 'not "Loading…" forever');
  });
  await test('a thrown Error is recorded by identity', async () => {
    const d = mount();
    const boom = new Error('network down');
    control.impl = async () => {
      throw boom;
    };
    await d.poll();
    assert.equal(d.state.error, boom);
    assert.equal(d.state.loading, false);
  });
  await test('a non-Error throw is wrapped with String(value)', async () => {
    const d = mount();
    control.impl = async () => {
      throw 'plain string';
    };
    await d.poll();
    assert.ok(d.state.error instanceof Error);
    assert.equal(d.state.error.message, 'plain string');
  });
  await test('a rejected res.json() is recorded, not an unhandled rejection', async () => {
    const d = mount();
    const bad = new SyntaxError('Unexpected token <');
    respondWith({
      ok: true,
      status: 200,
      json: async () => {
        throw bad;
      },
    });
    await d.poll();
    assert.equal(d.state.error, bad);
    assert.equal(d.state.series, null);
    assert.equal(d.state.loading, false);
  });

  console.log('\nretention across polls');
  await test('a blip after good data retains the last series and records the error', async () => {
    const d = mount();
    const good = { buckets: [1] };
    respondWith(okResponse(good));
    await d.poll();
    respondWith({ ok: false, status: 502, json: async () => ({}) });
    await d.poll();
    assert.equal(d.state.series, good, 'last good chart is kept');
    assert.equal(d.state.error.message, 'HTTP 502');
    assert.equal(d.state.loading, false);
  });
  await test('the next success clears the error and replaces the series', async () => {
    const d = mount();
    const first = { buckets: [1] };
    const second = { buckets: [2] };
    respondWith(okResponse(first));
    await d.poll();
    control.impl = async () => {
      throw new Error('blip');
    };
    await d.poll();
    assert.ok(d.state.error);
    respondWith(okResponse(second));
    await d.poll();
    assert.equal(d.state.series, second);
    assert.equal(d.state.error, null);
  });
  await test('loading flips true -> false exactly once and never back', async () => {
    const d = mount();
    respondWith(okResponse({}));
    await d.poll();
    control.impl = async () => {
      throw new Error('blip');
    };
    await d.poll();
    respondWith(okResponse({ x: 1 }));
    await d.poll();
    const loadingSeq = d.frames.map((f) => f.loading);
    assert.equal(loadingSeq[0], true);
    const firstFalse = loadingSeq.indexOf(false);
    assert.ok(firstFalse > 0);
    assert.ok(loadingSeq.slice(firstFalse).every((v) => v === false), 'never returns to loading');
    assert.ok(loadingSeq.slice(0, firstFalse).every((v) => v === true));
  });
} finally {
  Date.now = realNow;
}

console.log(`\n${passed} passed`);
