// Tests for web/src/components/settings/useBackendConfig.ts — the React hook that
// owns the Settings backend `/api/config` persistence seam (WARDEN-664). It is the
// one place that decides what the footer Save PUTs (including the write-only
// secrets: untouched => key omitted so the backend no-clobbers, pending Remove =>
// explicit `null`), what counts as "persisted" (the dirty baseline), and how
// reset / webhook-test / telemetry-test behave. The PURE helpers it calls are
// pinned by configPutPayload.test.mjs / settingsDirty.test.mjs /
// normalizeLoadedConfig.test.mjs / prefDefaultDiff.test.mjs; the hook that WIRES
// them had ZERO references in any suite file. This pins the wiring.
//
// WHY THESE LEGS (each is a user-visible regression if broken):
//   - load ladder: config gates the render (loadError + configLoaded stay honest),
//     hosts is DECOUPLED (a hosts failure toasts but never blocks config), the six
//     secret set/tail indicators hydrate from the GET, the baseline is captured, a
//     stale load (cancelled) never overwrites a newer one.
//   - secrets: typing cancels a pending Remove; Remove empties the input and arms
//     pendingClear; undo disarms. Each is an unsaved change.
//   - save: untouched secrets are OMITTED (no-clobber), typed values trimmed,
//     whitespace-only == untouched, pending Remove => explicit null; the body goes
//     through buildConfigPutPayload (cleared window hours => 24); failures toast
//     and leave the form dirty with onSaved unfired; `refused` keys => a warning;
//     success re-baselines BEFORE onSaved (the save-then-close path must never
//     raise the discard dialog).
//   - reset: instant POST, secret inputs/indicators cleared, the refetch is SILENT
//     (no loading frame), onConfigChange (not onSaved) fires; the silent flag is
//     one-shot.
//   - webhook / telemetry probes: DRAFT url/endpoint, secret/token only when typed,
//     verdict cleared at probe start, every failure shape mapped to a verdict;
//     'connected' clears the runtime drift breaker.
//   - runtime status: pull adopted, a fresher push beats a late pull, unmount
//     unsubscribes and discards a late pull.
//
// HARNESS (same seam-first shape as useWatchCatchup.test.mjs): no React runner
// exists in this repo, so the REAL hook plus the REAL helper modules are
// transpiled with vite's transformWithOxc; `react`, `sonner`, `@/lib/api` and
// `@/lib/electron` are rewritten onto a slot-based hook shim and recorders. The
// rewrites are ASSERTED, not assumed: react IS installed in web/, so an
// unrewritten import would load the REAL react, whose hooks throw outside a
// renderer — a loud failure, never a silent false pass. fetch is a fake global.
// Per WARDEN-997 the first legs prove the DRIVER re-renders on setState, keeps
// setter identity stable, and runs effects + cleanups by deps before any behavior
// verdict.
//
// Auto-discovered by `npm test` in web/ (`node --test`).
// Run: node useBackendConfig.test.mjs   (from web/)
import { transformWithOxc } from 'vite';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const tmpDir = mkdtempSync(join(tmpdir(), 'warden-use-backend-config-test-'));

// localStorage polyfill — storage.ts (pulled in by prefDefaultDiff) reads it lazily.
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => { mem.set(k, String(v)); },
  removeItem: (k) => { mem.delete(k); },
  clear: () => { mem.clear(); },
};

// react-shim.mjs — slot-based hooks over a module-level CURRENT instance the
// driver aims before every render. State writes re-render the mounted hook
// (batched while effects are flushing, like React) and bail out on Object.is
// equality; the setter identity is STABLE per slot (the hook lists the six secret
// setters in the load effect's deps, so an unstable setter would re-fire the load
// effect every render). useEffect queues during render and the driver flushes
// after the frame (cleanup of the previous run first) only when deps changed.
writeFileSync(
  join(tmpDir, 'react-shim.mjs'),
  `
let current = null;
export const __aim = (inst) => { current = inst; };
const depsChanged = (deps, prev) =>
  prev === undefined || deps === undefined || deps.length !== prev.length || deps.some((d, i) => !Object.is(d, prev[i]));
export function useState(initial) {
  const self = current;
  const slot = self.cursor++;
  if (self.slots.length <= slot) {
    const cell = { value: typeof initial === 'function' ? initial() : initial };
    cell.set = (next) => {
      const v = typeof next === 'function' ? next(cell.value) : next;
      if (Object.is(v, cell.value)) return;
      cell.value = v;
      if (self.flushing) self.dirty = true;
      else self.render();
    };
    self.slots.push(cell);
  }
  const cell = self.slots[slot];
  return [cell.value, cell.set];
}
export function useRef(initial) {
  const self = current;
  const slot = self.cursor++;
  if (self.slots.length <= slot) self.slots.push({ ref: { current: initial } });
  return self.slots[slot].ref;
}
export function useCallback(fn, deps) {
  const self = current;
  const slot = self.cursor++;
  const cell = self.slots[slot];
  if (cell === undefined) {
    self.slots.push({ fn, deps });
    return fn;
  }
  if (depsChanged(deps, cell.deps)) {
    cell.fn = fn;
    cell.deps = deps;
  }
  return cell.fn;
}
export function useEffect(fn, deps) {
  const self = current;
  const slot = self.cursor++;
  if (self.slots.length <= slot) self.slots.push({ deps: undefined, cleanup: null });
  const cell = self.slots[slot];
  if (depsChanged(deps, cell.deps)) {
    cell.deps = deps;
    self.pendingEffects.push(cell, fn);
  }
}
`,
);

// Recorder shims. Each delegates to globalThis.__env at CALL time so a test can
// swap behavior without re-importing the transpiled hook.
writeFileSync(
  join(tmpDir, 'sonner-shim.mjs'),
  `export const toast = {
  error: (...a) => globalThis.__env.toasts.push(['error', ...a]),
  warning: (...a) => globalThis.__env.toasts.push(['warning', ...a]),
  success: (...a) => globalThis.__env.toasts.push(['success', ...a]),
};\n`,
);
writeFileSync(
  join(tmpDir, 'api-shim.mjs'),
  `export const fetchJson = (...a) => globalThis.__env.fetchJson(...a);
export const putJson = (...a) => globalThis.__env.putJson(...a);
export const postJson = (...a) => globalThis.__env.postJson(...a);\n`,
);
writeFileSync(
  join(tmpDir, 'electron-shim.mjs'),
  `export const getTelemetryRuntimeStatus = (...a) => globalThis.__env.getTelemetryRuntimeStatus(...a);
export const onTelemetryRuntimeStatus = (...a) => globalThis.__env.onTelemetryRuntimeStatus(...a);
export const clearTelemetryRuntimeDrift = (...a) => globalThis.__env.clearTelemetryRuntimeDrift(...a);\n`,
);
// The hook's type-only specifiers survive transpilation as bare side-effect
// imports; point them at an empty module.
writeFileSync(join(tmpDir, 'empty-shim.mjs'), 'export {};\n');

// Transpile a real src module, rewriting specifiers per `map`; assert every
// rewrite landed (a missed one would resolve '@/lib/…' against nothing and crash,
// or 'react' against the real package and silently misbehave).
const emit = async (srcRel, outName, map = {}, optional = []) => {
  const p = resolve(__dirname, srcRel);
  const { code } = await transformWithOxc(readFileSync(p, 'utf8'), p, {});
  let out = code;
  for (const [from, to] of Object.entries(map)) {
    const before = out;
    out = out.replaceAll(`"${from}"`, `"${to}"`).replaceAll(`'${from}'`, `'${to}'`);
    if (before === out && !optional.includes(from)) {
      assert.fail(`specifier rewrite ${from} -> ${to} did not land in ${srcRel}`);
    }
  }
  writeFileSync(join(tmpDir, outName), out);
  return out;
};

const S = 'src/components/settings/';
await emit('src/lib/themes.ts', 'themes.mjs');
await emit('src/lib/storage.ts', 'storage.mjs', { '@/lib/themes': './themes.mjs' });
await emit(`${S}configDirty.ts`, 'configDirty.mjs');
await emit(`${S}normalizeLoadedConfig.ts`, 'normalizeLoadedConfig.mjs');
await emit(`${S}prefDefaultDiff.ts`, 'prefDefaultDiff.mjs', {
  './configDirty': './configDirty.mjs',
  './normalizeLoadedConfig': './normalizeLoadedConfig.mjs',
  '@/lib/storage': './storage.mjs',
});
await emit(`${S}configPutPayload.ts`, 'configPutPayload.mjs', { './prefDefaultDiff': './prefDefaultDiff.mjs' });
await emit('src/lib/webhook/testAlert.ts', 'testAlert.mjs');
const hookOut = await emit(
  `${S}useBackendConfig.ts`,
  'useBackendConfig.mjs',
  {
    react: './react-shim.mjs',
    sonner: './sonner-shim.mjs',
    '@/lib/api': './api-shim.mjs',
    '@/lib/electron': './electron-shim.mjs',
    '@/lib/webhook/testAlert': './testAlert.mjs',
    './configDirty': './configDirty.mjs',
    './normalizeLoadedConfig': './normalizeLoadedConfig.mjs',
    './configPutPayload': './configPutPayload.mjs',
    // type-only specifiers: rewritten when they survive as bare imports.
    './types': './empty-shim.mjs',
    '@/lib/telemetry/testConnection': './empty-shim.mjs',
  },
  ['./types', '@/lib/telemetry/testConnection'],
);
assert.ok(!/from ['"]@\//.test(hookOut), 'hook still has an unrewritten @/ import');
assert.ok(!/from ['"]react['"]/.test(hookOut), 'hook still imports the real react');
assert.ok(!/import ['"]@\//.test(hookOut), 'hook still has an unrewritten bare @/ import');
assert.ok(!/import ['"]\.\/types['"]/.test(hookOut), 'hook still has an unrewritten ./types import');

const { useBackendConfig } = await import(join(tmpDir, 'useBackendConfig.mjs'));
const { __aim: aimShim, useState: useStateShim, useEffect: useEffectShim, useCallback: useCallbackShim } =
  await import(join(tmpDir, 'react-shim.mjs'));
const { configFieldDefault } = await import(join(tmpDir, 'prefDefaultDiff.mjs'));
rmSync(tmpDir, { recursive: true, force: true });

// --- Fake platform ------------------------------------------------------------
const deferred = () => {
  let resolveFn;
  let rejectFn;
  const promise = new Promise((res, rej) => {
    resolveFn = res;
    rejectFn = rej;
  });
  return { promise, resolve: resolveFn, reject: rejectFn };
};
const flush = async () => {
  for (let i = 0; i < 8; i += 1) await new Promise((r) => setImmediate(r));
};
const recorder = () => {
  const fn = (...a) => {
    fn.calls.push(a);
  };
  fn.calls = [];
  return fn;
};

let env;
const resetEnv = () => {
  env = {
    toasts: [],
    fetchCalls: [],
    putCalls: [],
    postCalls: [],
    rawFetchCalls: [],
    clearDriftCalls: 0,
    unsubscribed: 0,
    pushListeners: [],
    // behavior hooks — tests override these
    configResult: () => Promise.resolve({ ok: true, data: loadedPayload() }),
    hostsResult: () => Promise.resolve({ ok: true, data: { hosts: ['alpha', 'beta'] } }),
    putResult: () => Promise.resolve({ ok: true, data: { ok: true } }),
    postResult: () => Promise.resolve({ ok: true, data: {} }),
    rawFetchResult: () => Promise.resolve({ json: async () => ({}) }),
    pullResult: () => Promise.resolve({ drifted: false, deliveryFailing: false }),
    clearResult: () => Promise.resolve({ drifted: false, deliveryFailing: false }),
  };
  globalThis.__env = {
    toasts: null,
    fetchJson: (url) => {
      env.fetchCalls.push(url);
      return url === '/api/config' ? env.configResult() : env.hostsResult();
    },
    putJson: (url, body) => {
      env.putCalls.push([url, body]);
      return env.putResult();
    },
    postJson: (url, body) => {
      env.postCalls.push([url, body]);
      return env.postResult();
    },
    getTelemetryRuntimeStatus: () => env.pullResult(),
    onTelemetryRuntimeStatus: (cb) => {
      env.pushListeners.push(cb);
      return () => {
        env.unsubscribed += 1;
      };
    },
    clearTelemetryRuntimeDrift: () => {
      env.clearDriftCalls += 1;
      return env.clearResult();
    },
  };
  Object.defineProperty(globalThis.__env, 'toasts', { get: () => env.toasts });
  globalThis.fetch = (url, init) => {
    env.rawFetchCalls.push([url, init]);
    return env.rawFetchResult();
  };
};
const rawBody = (i = 0) => JSON.parse(env.rawFetchCalls[i][1].body);
const countFetches = (url) => env.fetchCalls.filter((u) => u === url).length;

// A GET /api/config payload as the backend serves it (secrets masked, never cleartext).
const loadedPayload = (extra = {}) => ({
  pollIntervalMs: 20000,
  tmuxSession: 'main',
  llm: { model: 'm1', baseUrl: 'http://llm', maxTokens: 512, authTokenSet: true, authTokenTail: 'ab12' },
  webhookUrl: 'https://hook.example/topic',
  webhookSecretSet: true,
  webhookSecretTail: 'wh34',
  telemetryEndpoint: 'https://rx.example',
  telemetryAuthTokenSet: true,
  telemetryAuthTokenTail: 'tl56',
  ...extra,
});

// --- The driver ----------------------------------------------------------------
// Effects run after the frame (cleanup of the previous run first); state writes
// made while flushing are batched into one follow-up render, like React.
const mountHook = (runHook) => {
  const inst = {
    slots: [],
    pendingEffects: [],
    cursor: 0,
    renders: 0,
    state: null,
    frames: [],
    flushing: false,
    dirty: false,
    render: null,
    unmount: null,
  };
  inst.render = () => {
    do {
      inst.dirty = false;
      aimShim(inst);
      inst.cursor = 0;
      inst.renders += 1;
      inst.state = runHook();
      inst.frames.push(inst.state);
      const queued = inst.pendingEffects;
      inst.pendingEffects = [];
      inst.flushing = true;
      try {
        for (let i = 0; i < queued.length; i += 2) {
          const cell = queued[i];
          const fn = queued[i + 1];
          if (typeof cell.cleanup === 'function') cell.cleanup();
          cell.cleanup = fn() ?? null;
        }
      } finally {
        inst.flushing = false;
      }
    } while (inst.dirty);
    return inst.state;
  };
  inst.unmount = () => {
    for (const cell of inst.slots) {
      if (cell && typeof cell.cleanup === 'function') {
        cell.cleanup();
        cell.cleanup = null;
      }
    }
  };
  inst.render();
  return inst;
};

// Mount useBackendConfig synchronously (the load promises are still pending).
const mountNow = () => {
  const onSaved = recorder();
  const onConfigChange = recorder();
  const d = mountHook(() => useBackendConfig({ onSaved, onConfigChange }));
  d.onSaved = onSaved;
  d.onConfigChange = onConfigChange;
  return d;
};
// Mount and let the load settle (unless `settle: false`; then the caller must
// not await before inspecting the pre-resolution frame — prefer mountNow()).
const mount = async ({ settle = true } = {}) => {
  const d = mountNow();
  if (settle) await flush();
  return d;
};
const loadedHook = async () => mount();

let passed = 0;
const failures = [];
const queue = [];
const test = (name, fn) => queue.push([name, fn]);

// =============================================================================
// 1. Driver preconditions (WARDEN-997: prove the harness before any verdict)
// =============================================================================
test('driver: setState re-renders, keeps setter identity stable, and no-ops on an equal value', () => {
  resetEnv();
  let setter;
  const d = mountHook(() => {
    const [v, set] = useStateShim(0);
    setter = set;
    return { v, set };
  });
  const firstSet = d.state.set;
  assert.equal(d.state.v, 0);
  setter(5);
  assert.equal(d.state.v, 5);
  assert.equal(d.state.set, firstSet, 'setter identity is stable across renders');
  const renders = d.renders;
  setter(5);
  assert.equal(d.renders, renders, 'setting an equal value does not re-render');
});
test('driver: effects run by deps and the previous cleanup runs first; unmount runs cleanups', () => {
  resetEnv();
  const log = [];
  let dep = 'a';
  const d = mountHook(() => {
    const mine = dep;
    useEffectShim(() => {
      log.push(`run:${mine}`);
      return () => log.push(`clean:${mine}`);
    }, [mine]);
    return null;
  });
  d.render();
  assert.deepEqual(log, ['run:a'], 'unchanged deps do not re-run the effect');
  dep = 'b';
  d.render();
  assert.deepEqual(log, ['run:a', 'clean:a', 'run:b']);
  d.unmount();
  assert.equal(log[log.length - 1], 'clean:b');
});
test('driver: useCallback memoizes by deps', () => {
  resetEnv();
  let dep = 1;
  const d = mountHook(() => useCallbackShim(() => dep, [dep]));
  const first = d.state;
  d.render();
  assert.equal(d.state, first);
  dep = 2;
  d.render();
  assert.notEqual(d.state, first);
});

// =============================================================================
// 2. Load ladder
// =============================================================================
test('load: requests both /api/config and /api/ssh-hosts exactly once on mount', async () => {
  resetEnv();
  await loadedHook();
  assert.deepEqual([...env.fetchCalls].sort(), ['/api/config', '/api/ssh-hosts']);
});
test('load: starts loading, then hydrates config, hosts, and the six secret indicators', async () => {
  resetEnv();
  const d = mountNow();
  assert.equal(d.state.loading, true);
  assert.equal(d.state.configLoaded, false, 'not loaded before the GET resolves');
  await flush();
  const s = d.state;
  assert.equal(s.loading, false);
  assert.equal(s.loadError, null);
  assert.equal(s.configLoaded, true);
  assert.equal(s.config.tmuxSession, 'main');
  assert.equal(s.config.pollIntervalMs, 20000);
  assert.equal(s.config.llm.model, 'm1');
  assert.deepEqual(s.availableHosts, ['alpha', 'beta']);
  assert.equal(s.observerAuthTokenSet, true);
  assert.equal(s.observerAuthTokenTail, 'ab12');
  assert.equal(s.webhookSecretSet, true);
  assert.equal(s.webhookSecretTail, 'wh34');
  assert.equal(s.telemetryAuthTokenSet, true);
  assert.equal(s.telemetryAuthTokenTail, 'tl56');
});
test('load: absent secret indicators hydrate to unset / null tail; secret inputs start empty', async () => {
  resetEnv();
  env.configResult = () => Promise.resolve({ ok: true, data: { tmuxSession: 'x' } });
  const s = (await loadedHook()).state;
  assert.equal(s.observerAuthTokenSet, false);
  assert.equal(s.observerAuthTokenTail, null);
  assert.equal(s.webhookSecretSet, false);
  assert.equal(s.webhookSecretTail, null);
  assert.equal(s.telemetryAuthTokenSet, false);
  assert.equal(s.telemetryAuthTokenTail, null);
  assert.equal(s.observerAuthTokenInput, '');
  assert.equal(s.webhookSecretInput, '');
  assert.equal(s.telemetryAuthTokenInput, '');
});
test('load: the GET is captured as the dirty baseline (not dirty after load)', async () => {
  resetEnv();
  const d = await loadedHook();
  assert.equal(d.state.isDirty, false);
  d.state.setConfig({ ...d.state.config, tmuxSession: 'edited' });
  assert.equal(d.state.isDirty, true);
  d.state.setConfig({ ...d.state.config, tmuxSession: 'main' });
  assert.equal(d.state.isDirty, false, 'reverting the edit returns to the baseline');
});
test('load: a null/empty config body still loads (defaults) and counts as loaded', async () => {
  resetEnv();
  env.configResult = () => Promise.resolve({ ok: true, data: null });
  const s = (await loadedHook()).state;
  assert.equal(s.configLoaded, true);
  assert.equal(s.config.tmuxSession, 'agent');
  assert.equal(s.isDirty, false);
});
test('load: a config failure sets loadError from the server message and never marks configLoaded', async () => {
  resetEnv();
  env.configResult = () => Promise.resolve({ ok: false, error: 'backend on fire' });
  const s = (await loadedHook()).state;
  assert.deepEqual(s.loadError, { message: 'backend on fire' });
  assert.equal(s.loading, false);
  assert.equal(s.configLoaded, false);
  assert.equal(s.isDirty, false, 'nothing to lose on a form that never rendered');
});
test('load: a config failure with no server message uses the fallback copy', async () => {
  resetEnv();
  env.configResult = () => Promise.resolve({ ok: false });
  const s = (await loadedHook()).state;
  assert.deepEqual(s.loadError, {
    message: 'Failed to load configuration. The backend may be busy or unreachable.',
  });
});
test('load: a hosts failure is decoupled — toast only, config still loads, no loadError', async () => {
  resetEnv();
  env.hostsResult = () => Promise.resolve({ ok: false, error: 'nope' });
  const s = (await loadedHook()).state;
  assert.equal(s.loadError, null);
  assert.equal(s.configLoaded, true);
  assert.deepEqual(s.availableHosts, []);
  assert.equal(env.toasts.length, 1);
  assert.equal(env.toasts[0][0], 'error');
  assert.match(env.toasts[0][1], /Could not load discovered SSH hosts/);
});
test('load: a hosts body without a hosts array degrades to []', async () => {
  resetEnv();
  env.hostsResult = () => Promise.resolve({ ok: true, data: {} });
  const s = (await loadedHook()).state;
  assert.deepEqual(s.availableHosts, []);
  assert.equal(env.toasts.length, 0);
});
test('load: a slow hosts fetch does not block the config from rendering', async () => {
  resetEnv();
  const hosts = deferred();
  env.hostsResult = () => hosts.promise;
  const d = await loadedHook();
  assert.equal(d.state.configLoaded, true, 'config settled while hosts is still pending');
  assert.deepEqual(d.state.availableHosts, []);
  hosts.resolve({ ok: true, data: { hosts: ['late'] } });
  await flush();
  assert.deepEqual(d.state.availableHosts, ['late']);
});
test('load: reload() flips loading back on and re-fetches both endpoints', async () => {
  resetEnv();
  const d = await loadedHook();
  const gate = deferred();
  env.configResult = () => gate.promise;
  d.state.reload();
  assert.equal(d.state.loading, true, 'a manual Retry shows the loading state');
  assert.equal(countFetches('/api/config'), 2);
  assert.equal(countFetches('/api/ssh-hosts'), 2);
  gate.resolve({ ok: true, data: loadedPayload({ tmuxSession: 'second' }) });
  await flush();
  assert.equal(d.state.loading, false);
  assert.equal(d.state.config.tmuxSession, 'second');
});
test('load: Retry after a failure clears loadError and recovers', async () => {
  resetEnv();
  env.configResult = () => Promise.resolve({ ok: false, error: 'down' });
  const d = await loadedHook();
  assert.ok(d.state.loadError);
  env.configResult = () => Promise.resolve({ ok: true, data: loadedPayload() });
  d.state.reload();
  await flush();
  assert.equal(d.state.loadError, null);
  assert.equal(d.state.configLoaded, true);
});
test('load: a stale (cancelled) load resolving late is discarded, not applied over the newer one', async () => {
  resetEnv();
  const first = deferred();
  env.configResult = () => first.promise;
  const d = mountNow();
  env.configResult = () => Promise.resolve({ ok: true, data: loadedPayload({ tmuxSession: 'newer' }) });
  d.state.reload();
  await flush();
  assert.equal(d.state.config.tmuxSession, 'newer');
  first.resolve({ ok: true, data: loadedPayload({ tmuxSession: 'stale' }) });
  await flush();
  assert.equal(d.state.config.tmuxSession, 'newer', 'the cancelled load did not overwrite');
});
test('load: unmounting before the load resolves discards it', async () => {
  resetEnv();
  const gate = deferred();
  env.configResult = () => gate.promise;
  const d = mountNow();
  d.unmount();
  gate.resolve({ ok: true, data: loadedPayload() });
  await flush();
  assert.equal(d.state.configLoaded, false);
  assert.equal(d.state.loading, true);
});

// =============================================================================
// 3. Write-only secret state machine
// =============================================================================
const SECRETS = [
  { name: 'observer', input: 'observerAuthTokenInput', set: 'setObserverAuthTokenInput', pending: 'observerAuthTokenPendingClear', remove: 'removeObserverAuthToken', undo: 'undoRemoveObserverAuthToken' },
  { name: 'webhook', input: 'webhookSecretInput', set: 'setWebhookSecretInput', pending: 'webhookSecretPendingClear', remove: 'removeWebhookSecret', undo: 'undoRemoveWebhookSecret' },
  { name: 'telemetry', input: 'telemetryAuthTokenInput', set: 'setTelemetryAuthTokenInput', pending: 'telemetryAuthTokenPendingClear', remove: 'removeTelemetryAuthToken', undo: 'undoRemoveTelemetryAuthToken' },
];
for (const sec of SECRETS) {
  test(`secret(${sec.name}): typing marks dirty and updates the input`, async () => {
    resetEnv();
    const d = await loadedHook();
    d.state[sec.set]('hunter2');
    assert.equal(d.state[sec.input], 'hunter2');
    assert.equal(d.state.isDirty, true);
  });
  test(`secret(${sec.name}): Remove empties the input, arms pendingClear and marks dirty`, async () => {
    resetEnv();
    const d = await loadedHook();
    d.state[sec.set]('typed');
    d.state[sec.remove]();
    assert.equal(d.state[sec.input], '');
    assert.equal(d.state[sec.pending], true);
    assert.equal(d.state.isDirty, true);
  });
  test(`secret(${sec.name}): undo disarms pendingClear and returns to clean`, async () => {
    resetEnv();
    const d = await loadedHook();
    d.state[sec.remove]();
    d.state[sec.undo]();
    assert.equal(d.state[sec.pending], false);
    assert.equal(d.state.isDirty, false);
  });
  test(`secret(${sec.name}): typing after Remove cancels the pending clear`, async () => {
    resetEnv();
    const d = await loadedHook();
    d.state[sec.remove]();
    assert.equal(d.state[sec.pending], true);
    d.state[sec.set]('replacement');
    assert.equal(d.state[sec.pending], false, 'typing is the natural undo');
    assert.equal(d.state[sec.input], 'replacement');
  });
  test(`secret(${sec.name}): a whitespace-only input is not a pending change`, async () => {
    resetEnv();
    const d = await loadedHook();
    d.state[sec.set]('   ');
    assert.equal(d.state.isDirty, false);
  });
}

// =============================================================================
// 4. Save
// =============================================================================
const lastPut = () => env.putCalls[env.putCalls.length - 1];
test('save: PUTs /api/config and omits every untouched secret key (no-clobber)', async () => {
  resetEnv();
  const d = await loadedHook();
  await d.state.handleSave();
  assert.equal(env.putCalls.length, 1);
  const [url, body] = lastPut();
  assert.equal(url, '/api/config');
  assert.equal('authToken' in body.llm, false);
  assert.equal('webhookSecret' in body, false);
  assert.equal('telemetryAuthToken' in body, false);
  assert.equal(body.llm.model, 'm1', 'model/baseUrl/maxTokens round-trip');
  assert.equal(body.llm.baseUrl, 'http://llm');
  assert.equal(body.llm.maxTokens, 512);
  assert.equal(body.tmuxSession, 'main');
});
test('save: typed secrets are sent trimmed on their own wire keys', async () => {
  resetEnv();
  const d = await loadedHook();
  d.state.setObserverAuthTokenInput('  obs-tok  ');
  d.state.setWebhookSecretInput('\twh-sec ');
  d.state.setTelemetryAuthTokenInput(' tl-tok\n');
  await d.state.handleSave();
  const body = lastPut()[1];
  assert.equal(body.llm.authToken, 'obs-tok');
  assert.equal(body.webhookSecret, 'wh-sec');
  assert.equal(body.telemetryAuthToken, 'tl-tok');
});
test('save: whitespace-only secrets count as untouched (omitted, not sent as empty)', async () => {
  resetEnv();
  const d = await loadedHook();
  d.state.setObserverAuthTokenInput('   ');
  d.state.setWebhookSecretInput('  ');
  d.state.setTelemetryAuthTokenInput(' ');
  await d.state.handleSave();
  const body = lastPut()[1];
  assert.equal('authToken' in body.llm, false);
  assert.equal('webhookSecret' in body, false);
  assert.equal('telemetryAuthToken' in body, false);
});
test('save: a pending Remove sends explicit null for the observer token (not omit, not the typed value)', async () => {
  resetEnv();
  const d = await loadedHook();
  d.state.setObserverAuthTokenInput('typed-first');
  d.state.removeObserverAuthToken();
  await d.state.handleSave();
  const body = lastPut()[1];
  assert.ok('authToken' in body.llm, 'key present');
  assert.equal(body.llm.authToken, null);
});
test('save: a pending Remove sends explicit null for the webhook secret', async () => {
  resetEnv();
  const d = await loadedHook();
  d.state.setWebhookSecretInput('typed-first');
  d.state.removeWebhookSecret();
  await d.state.handleSave();
  const body = lastPut()[1];
  assert.ok('webhookSecret' in body);
  assert.equal(body.webhookSecret, null);
});
test('save: a pending Remove sends explicit null for the telemetry token', async () => {
  resetEnv();
  const d = await loadedHook();
  d.state.setTelemetryAuthTokenInput('typed-first');
  d.state.removeTelemetryAuthToken();
  await d.state.handleSave();
  const body = lastPut()[1];
  assert.ok('telemetryAuthToken' in body);
  assert.equal(body.telemetryAuthToken, null);
});
test('save: Remove on one secret does not leak null onto the others', async () => {
  resetEnv();
  const d = await loadedHook();
  d.state.removeWebhookSecret();
  await d.state.handleSave();
  const body = lastPut()[1];
  assert.equal(body.webhookSecret, null);
  assert.equal('authToken' in body.llm, false);
  assert.equal('telemetryAuthToken' in body, false);
});
test('save: the body goes through buildConfigPutPayload (cleared window hours => derived default; draft keeps null)', async () => {
  resetEnv();
  const d = await loadedHook();
  d.state.setConfig({ ...d.state.config, tokenBudgetWindowHours: null });
  await d.state.handleSave();
  assert.equal(lastPut()[1].tokenBudgetWindowHours, configFieldDefault('tokenBudgetWindowHours'));
  assert.equal(lastPut()[1].tokenBudgetWindowHours, 24);
  assert.equal(d.state.config.tokenBudgetWindowHours, null, 'the on-screen draft is not rewritten');
});
test('save: toggles saving around the round-trip', async () => {
  resetEnv();
  const d = await loadedHook();
  const gate = deferred();
  env.putResult = () => gate.promise;
  const p = d.state.handleSave();
  assert.equal(d.state.saving, true);
  gate.resolve({ ok: true, data: { ok: true } });
  await p;
  assert.equal(d.state.saving, false);
});
test('save: a failure toasts the server message, leaves the form dirty, and does not fire onSaved', async () => {
  resetEnv();
  const d = await loadedHook();
  d.state.setConfig({ ...d.state.config, tmuxSession: 'edited' });
  env.putResult = () => Promise.resolve({ ok: false, error: 'invalid thing' });
  await d.state.handleSave();
  assert.deepEqual(env.toasts.pop(), ['error', 'invalid thing']);
  assert.equal(d.state.isDirty, true, 'never-persisted edits are not re-baselined');
  assert.equal(d.state.saving, false);
  assert.equal(d.onSaved.calls.length, 0);
});
test('save: a failure with no server message toasts the fallback', async () => {
  resetEnv();
  const d = await loadedHook();
  env.putResult = () => Promise.resolve({ ok: false });
  await d.state.handleSave();
  assert.deepEqual(env.toasts.pop(), ['error', 'Failed to save configuration']);
  assert.equal(d.onSaved.calls.length, 0);
});
test('save: a thrown request toasts its message and leaves onSaved unfired', async () => {
  resetEnv();
  const d = await loadedHook();
  env.putResult = () => Promise.reject(new Error('socket hang up'));
  await d.state.handleSave();
  assert.deepEqual(env.toasts.pop(), ['error', 'socket hang up']);
  assert.equal(d.state.saving, false);
  assert.equal(d.onSaved.calls.length, 0);
});
test('save: refused keys raise a warning naming them, and the save still completes', async () => {
  resetEnv();
  const d = await loadedHook();
  env.putResult = () => Promise.resolve({ ok: true, data: { ok: true, refused: { pollIntervalMs: 'bad', connectTimeout: 'bad' } } });
  await d.state.handleSave();
  const warn = env.toasts.find((t) => t[0] === 'warning');
  assert.ok(warn, 'a warning toast fired');
  assert.equal(warn[1], 'Some values could not be saved: pollIntervalMs, connectTimeout');
  assert.match(warn[2].description, /rejected these values/);
  assert.equal(d.onSaved.calls.length, 1);
});
test('save: an empty or non-object refused value raises no warning', async () => {
  for (const refused of [{}, 'oops', null, 7, undefined]) {
    resetEnv();
    const d = await loadedHook();
    env.putResult = () => Promise.resolve({ ok: true, data: { ok: true, refused } });
    await d.state.handleSave();
    assert.equal(env.toasts.filter((t) => t[0] === 'warning').length, 0, `refused=${JSON.stringify(refused)}`);
    assert.equal(d.onSaved.calls.length, 1);
  }
});
test('save: a success body that is absent entirely raises no warning', async () => {
  resetEnv();
  const d = await loadedHook();
  env.putResult = () => Promise.resolve({ ok: true });
  await d.state.handleSave();
  assert.equal(env.toasts.length, 0);
  assert.equal(d.onSaved.calls.length, 1);
});
test('save: success re-baselines BEFORE onSaved fires (the save-then-close path never raises the discard dialog)', async () => {
  resetEnv();
  let dirtyAtOnSaved = null;
  const probe = mountHook(() => useBackendConfig({
    onSaved: () => { dirtyAtOnSaved = probe.state.isDirty; },
    onConfigChange: () => {},
  }));
  await flush();
  probe.state.setConfig({ ...probe.state.config, tmuxSession: 'edited' });
  assert.equal(probe.state.isDirty, true);
  await probe.state.handleSave();
  assert.equal(dirtyAtOnSaved, false, 'already re-baselined when onSaved ran');
  assert.equal(probe.state.isDirty, false);
});
test('save: success re-baselines the typed secret inputs too (still on screen, no longer dirty)', async () => {
  resetEnv();
  const d = await loadedHook();
  d.state.setWebhookSecretInput('new-secret');
  d.state.removeTelemetryAuthToken();
  assert.equal(d.state.isDirty, true);
  await d.state.handleSave();
  assert.equal(d.state.isDirty, false);
  assert.equal(d.onSaved.calls.length, 1);
});
test('save: a refused-but-ok save still re-baselines (the refused value stays on screen)', async () => {
  resetEnv();
  const d = await loadedHook();
  d.state.setConfig({ ...d.state.config, connectTimeout: 9999 });
  env.putResult = () => Promise.resolve({ ok: true, data: { refused: { connectTimeout: 'range' } } });
  await d.state.handleSave();
  assert.equal(d.state.config.connectTimeout, 9999);
  assert.equal(d.state.isDirty, false);
});

// =============================================================================
// 5. Reset
// =============================================================================
test('reset: POSTs /api/config/reset with {} and toggles resetting', async () => {
  resetEnv();
  const d = await loadedHook();
  const gate = deferred();
  env.postResult = () => gate.promise;
  const p = d.state.resetBackendConfig();
  assert.equal(d.state.resetting, true);
  gate.resolve({ ok: true, data: {} });
  await p;
  assert.deepEqual(env.postCalls, [['/api/config/reset', {}]]);
  assert.equal(d.state.resetting, false);
});
test('reset: clears typed secret inputs and the masked indicators immediately (before the refetch lands)', async () => {
  resetEnv();
  const d = await loadedHook();
  d.state.setObserverAuthTokenInput('o');
  d.state.setWebhookSecretInput('w');
  d.state.setTelemetryAuthTokenInput('t');
  const gate = deferred();
  env.configResult = () => gate.promise;
  await d.state.resetBackendConfig();
  const s = d.state;
  assert.equal(s.observerAuthTokenInput, '');
  assert.equal(s.webhookSecretInput, '');
  assert.equal(s.telemetryAuthTokenInput, '');
  assert.equal(s.observerAuthTokenSet, false);
  assert.equal(s.observerAuthTokenTail, null);
  assert.equal(s.webhookSecretSet, false);
  assert.equal(s.webhookSecretTail, null);
  assert.equal(s.telemetryAuthTokenSet, false);
  assert.equal(s.telemetryAuthTokenTail, null);
  gate.resolve({ ok: true, data: { tmuxSession: 'restored' } });
  await flush();
  assert.equal(s === d.state, false);
  assert.equal(d.state.config.tmuxSession, 'restored', 'the refetch swapped in the restored config');
  assert.equal(d.state.webhookSecretSet, false);
});
test('reset: the refetch is SILENT — no frame ever shows loading', async () => {
  resetEnv();
  const d = await loadedHook();
  const mark = d.frames.length;
  const gate = deferred();
  env.configResult = () => gate.promise;
  await d.state.resetBackendConfig();
  gate.resolve({ ok: true, data: {} });
  await flush();
  assert.equal(countFetches('/api/config'), 2, 'a refetch did happen');
  assert.ok(d.frames.length > mark);
  assert.equal(d.frames.slice(mark).some((f) => f.loading), false);
  assert.equal(d.state.configLoaded, true, 'the pane stays mounted across the reset');
});
test('reset: fires onConfigChange (not onSaved) and the success toast', async () => {
  resetEnv();
  const d = await loadedHook();
  await d.state.resetBackendConfig();
  assert.equal(d.onConfigChange.calls.length, 1);
  assert.equal(d.onSaved.calls.length, 0);
  assert.deepEqual(env.toasts.pop(), ['success', 'Backend configuration reset to defaults']);
});
test('reset: failure toasts the server message and leaves inputs, indicators and the pane alone', async () => {
  resetEnv();
  const d = await loadedHook();
  d.state.setWebhookSecretInput('keep-me');
  env.postResult = () => Promise.resolve({ ok: false, error: 'cannot reset' });
  await d.state.resetBackendConfig();
  assert.deepEqual(env.toasts.pop(), ['error', 'cannot reset']);
  assert.equal(d.state.webhookSecretInput, 'keep-me');
  assert.equal(d.state.webhookSecretSet, true);
  assert.equal(d.onConfigChange.calls.length, 0);
  assert.equal(countFetches('/api/config'), 1, 'no refetch');
  assert.equal(d.state.resetting, false);
});
test('reset: failure with no message uses the fallback; a thrown request toasts its message', async () => {
  resetEnv();
  const d = await loadedHook();
  env.postResult = () => Promise.resolve({ ok: false });
  await d.state.resetBackendConfig();
  assert.deepEqual(env.toasts.pop(), ['error', 'Failed to reset backend configuration']);
  env.postResult = () => Promise.reject(new Error('boom'));
  await d.state.resetBackendConfig();
  assert.deepEqual(env.toasts.pop(), ['error', 'boom']);
  assert.equal(d.onConfigChange.calls.length, 0);
});
test('reset: the silent flag is one-shot — the next manual reload shows loading again', async () => {
  resetEnv();
  const d = await loadedHook();
  await d.state.resetBackendConfig();
  await flush();
  const mark = d.frames.length;
  const gate = deferred();
  env.configResult = () => gate.promise;
  d.state.reload();
  assert.equal(d.state.loading, true);
  assert.equal(d.frames.slice(mark).some((f) => f.loading), true);
  gate.resolve({ ok: true, data: {} });
  await flush();
  assert.equal(d.state.loading, false);
});

// =============================================================================
// 6. Webhook test alert
// =============================================================================
const withWebhookUrl = (d, url) => d.state.setConfig({ ...d.state.config, webhookUrl: url });
test('webhook test: POSTs the trimmed DRAFT url (not the persisted one) to /api/webhook-test', async () => {
  resetEnv();
  const d = await loadedHook();
  withWebhookUrl(d, '  https://draft.example/t  ');
  env.rawFetchResult = () => Promise.resolve({ json: async () => ({ ok: true }) });
  await d.state.sendTestAlert();
  assert.equal(env.rawFetchCalls.length, 1);
  assert.equal(env.rawFetchCalls[0][0], '/api/webhook-test');
  assert.equal(env.rawFetchCalls[0][1].method, 'POST');
  assert.equal(env.rawFetchCalls[0][1].headers['content-type'], 'application/json');
  assert.deepEqual(rawBody(), { webhookUrl: 'https://draft.example/t' });
});
test('webhook test: the secret rides only when typed, and trimmed; whitespace-only is omitted', async () => {
  resetEnv();
  const d = await loadedHook();
  env.rawFetchResult = () => Promise.resolve({ json: async () => ({ ok: true }) });
  d.state.setWebhookSecretInput('  s3cret ');
  await d.state.sendTestAlert();
  assert.deepEqual(rawBody(0), { webhookUrl: 'https://hook.example/topic', webhookSecret: 's3cret' });
  d.state.setWebhookSecretInput('   ');
  await d.state.sendTestAlert();
  assert.equal('webhookSecret' in rawBody(1), false);
});
test('webhook test: clears the previous verdict at probe start, then adopts the new one', async () => {
  resetEnv();
  const d = await loadedHook();
  d.state.setWebhookTestVerdict({ kind: 'stale', tone: 'positive', label: 'old', message: 'old' });
  assert.equal(d.state.webhookTestVerdict.kind, 'stale');
  const gate = deferred();
  env.rawFetchResult = () => gate.promise;
  const p = d.state.sendTestAlert();
  assert.equal(d.state.webhookTestVerdict, null, 'verdict cleared while the probe is in flight');
  assert.equal(d.state.testingWebhook, true);
  gate.resolve({ json: async () => ({ ok: true }) });
  await p;
  assert.equal(d.state.testingWebhook, false);
  assert.equal(d.state.webhookTestVerdict.kind, 'delivered');
});
test('webhook test: a dropped 401 body maps to the auth-rejected verdict', async () => {
  resetEnv();
  const d = await loadedHook();
  env.rawFetchResult = () => Promise.resolve({ json: async () => ({ ok: false, dropped: true, attempts: 1, status: 401 }) });
  await d.state.sendTestAlert();
  assert.equal(d.state.webhookTestVerdict.kind, 'auth-rejected');
});
test('webhook test: a thrown request maps to the request-failed verdict carrying the message', async () => {
  resetEnv();
  const d = await loadedHook();
  env.rawFetchResult = () => Promise.reject(new Error('ECONNRESET'));
  await d.state.sendTestAlert();
  assert.equal(d.state.webhookTestVerdict.kind, 'request-failed');
  assert.match(d.state.webhookTestVerdict.message, /ECONNRESET/);
  assert.equal(d.state.testingWebhook, false);
});
test('webhook test: an unparseable body (json() throws) is a request-failed verdict, and a non-Error throw is stringified', async () => {
  resetEnv();
  const d = await loadedHook();
  env.rawFetchResult = () => Promise.resolve({ json: async () => { throw new Error('bad json'); } });
  await d.state.sendTestAlert();
  assert.equal(d.state.webhookTestVerdict.kind, 'request-failed');
  assert.match(d.state.webhookTestVerdict.message, /bad json/);
  env.rawFetchResult = () => Promise.reject('plain string');
  await d.state.sendTestAlert();
  assert.match(d.state.webhookTestVerdict.message, /plain string/);
});
test('webhook test: a probe never touches the dirty baseline or the saved config', async () => {
  resetEnv();
  const d = await loadedHook();
  env.rawFetchResult = () => Promise.resolve({ json: async () => ({ ok: true }) });
  await d.state.sendTestAlert();
  assert.equal(d.state.isDirty, false);
  assert.equal(env.putCalls.length, 0);
});

// =============================================================================
// 7. Telemetry test connection
// =============================================================================
const withEndpoint = (d, endpoint) => d.state.setConfig({ ...d.state.config, telemetryEndpoint: endpoint });
test('telemetry test: a blank endpoint sends nothing and leaves the verdict untouched', async () => {
  resetEnv();
  const d = await loadedHook();
  withEndpoint(d, '   ');
  d.state.setTelemetryTestVerdict({ kind: 'connected', ok: true, message: 'prior' });
  await d.state.sendTestConnection();
  assert.equal(env.rawFetchCalls.length, 0);
  assert.equal(d.state.telemetryTestLoading, false);
  assert.equal(d.state.telemetryTestVerdict.message, 'prior');
});
test('telemetry test: POSTs the trimmed draft endpoint; the token rides only when typed (trimmed)', async () => {
  resetEnv();
  const d = await loadedHook();
  withEndpoint(d, '  https://draft-rx.example  ');
  env.rawFetchResult = () => Promise.resolve({ json: async () => ({ kind: 'unreachable', ok: false, message: 'no' }) });
  await d.state.sendTestConnection();
  assert.equal(env.rawFetchCalls[0][0], '/api/telemetry-test');
  assert.equal(env.rawFetchCalls[0][1].method, 'POST');
  assert.deepEqual(rawBody(0), { endpoint: 'https://draft-rx.example' });
  d.state.setTelemetryAuthTokenInput('  tok  ');
  await d.state.sendTestConnection();
  assert.deepEqual(rawBody(1), { endpoint: 'https://draft-rx.example', token: 'tok' });
  d.state.setTelemetryAuthTokenInput('  ');
  await d.state.sendTestConnection();
  assert.equal('token' in rawBody(2), false);
});
test('telemetry test: clears the previous verdict at probe start and toggles the loading flag', async () => {
  resetEnv();
  const d = await loadedHook();
  d.state.setTelemetryTestVerdict({ kind: 'connected', ok: true, message: 'old' });
  const gate = deferred();
  env.rawFetchResult = () => gate.promise;
  const p = d.state.sendTestConnection();
  assert.equal(d.state.telemetryTestVerdict, null);
  assert.equal(d.state.telemetryTestLoading, true);
  gate.resolve({ json: async () => ({ kind: 'auth-rejected', ok: false, message: 'denied' }) });
  await p;
  assert.equal(d.state.telemetryTestLoading, false);
  assert.deepEqual(d.state.telemetryTestVerdict, { kind: 'auth-rejected', ok: false, message: 'denied' });
});
test('telemetry test: a non-connected verdict does NOT clear the runtime drift breaker', async () => {
  resetEnv();
  const d = await loadedHook();
  env.rawFetchResult = () => Promise.resolve({ json: async () => ({ kind: 'schema-mismatch', ok: false, message: 'm' }) });
  await d.state.sendTestConnection();
  assert.equal(env.clearDriftCalls, 0);
});
test('telemetry test: a connected verdict clears the drift breaker and adopts the returned status', async () => {
  resetEnv();
  const d = await loadedHook();
  env.pullResult = () => Promise.resolve({ drifted: true, deliveryFailing: false });
  d.unmount();
  const d2 = await loadedHook();
  assert.equal(d2.state.telemetryRuntimeStatus.drifted, true);
  env.clearResult = () => Promise.resolve({ drifted: false, deliveryFailing: true });
  env.rawFetchResult = () => Promise.resolve({ json: async () => ({ kind: 'connected', ok: true, message: 'Connected' }) });
  await d2.state.sendTestConnection();
  await flush();
  assert.equal(env.clearDriftCalls, 1);
  assert.equal(d2.state.telemetryTestVerdict.kind, 'connected');
  assert.deepEqual(d2.state.telemetryRuntimeStatus, { drifted: false, deliveryFailing: true });
});
test('telemetry test: an {error} body maps to a no-receiver verdict with that message', async () => {
  resetEnv();
  const d = await loadedHook();
  env.rawFetchResult = () => Promise.resolve({ json: async () => ({ error: 'endpoint refused' }) });
  await d.state.sendTestConnection();
  assert.deepEqual(d.state.telemetryTestVerdict, { kind: 'no-receiver', ok: false, message: 'endpoint refused' });
});
test('telemetry test: uninterpretable bodies (empty, null, half-shaped) map to the could-not-interpret verdict', async () => {
  for (const body of [{}, null, { kind: 'connected' }, { message: 'only message' }, { kind: 1, message: 'x' }]) {
    resetEnv();
    const d = await loadedHook();
    env.rawFetchResult = () => Promise.resolve({ json: async () => body });
    await d.state.sendTestConnection();
    assert.deepEqual(
      d.state.telemetryTestVerdict,
      { kind: 'no-receiver', ok: false, message: 'Could not interpret the receiver response.' },
      JSON.stringify(body),
    );
    assert.equal(env.clearDriftCalls, 0);
  }
});
test('telemetry test: a thrown request maps to a no-receiver verdict (Error message, or the generic fallback)', async () => {
  resetEnv();
  const d = await loadedHook();
  env.rawFetchResult = () => Promise.reject(new Error('ENOTFOUND'));
  await d.state.sendTestConnection();
  assert.deepEqual(d.state.telemetryTestVerdict, { kind: 'no-receiver', ok: false, message: 'ENOTFOUND' });
  assert.equal(d.state.telemetryTestLoading, false);
  env.rawFetchResult = () => Promise.reject('not an Error');
  await d.state.sendTestConnection();
  assert.equal(d.state.telemetryTestVerdict.message, 'Failed to test the connection.');
});

// =============================================================================
// 8. Runtime status (pull on mount + push, merge race)
// =============================================================================
test('runtime: starts null, adopts the pulled status when no push has landed', async () => {
  resetEnv();
  env.pullResult = () => Promise.resolve({ drifted: true, deliveryFailing: false });
  const d = mountNow();
  assert.equal(d.state.telemetryRuntimeStatus, null, 'null before the pull resolves');
  await flush();
  assert.deepEqual(d.state.telemetryRuntimeStatus, { drifted: true, deliveryFailing: false });
});
test('runtime: a live push is adopted', async () => {
  resetEnv();
  const d = await loadedHook();
  assert.equal(env.pushListeners.length, 1, 'subscribed exactly once');
  env.pushListeners[0]({ drifted: false, deliveryFailing: true });
  assert.deepEqual(d.state.telemetryRuntimeStatus, { drifted: false, deliveryFailing: true });
});
test('runtime: a fresher push beats a late pull (the stale snapshot is discarded)', async () => {
  resetEnv();
  const pull = deferred();
  env.pullResult = () => pull.promise;
  const d = mountNow();
  env.pushListeners[0]({ drifted: true, deliveryFailing: true });
  pull.resolve({ drifted: false, deliveryFailing: false });
  await flush();
  assert.deepEqual(d.state.telemetryRuntimeStatus, { drifted: true, deliveryFailing: true });
});
test('runtime: unmount unsubscribes, and a pull resolving after unmount is discarded', async () => {
  resetEnv();
  const pull = deferred();
  env.pullResult = () => pull.promise;
  const d = mountNow();
  assert.equal(env.unsubscribed, 0);
  d.unmount();
  assert.equal(env.unsubscribed, 1);
  pull.resolve({ drifted: true, deliveryFailing: true });
  await flush();
  assert.equal(d.state.telemetryRuntimeStatus, null);
});
test('runtime: subscribes once for the hook lifetime, not once per render or reload', async () => {
  resetEnv();
  const d = await loadedHook();
  d.state.setWebhookSecretInput('x');
  d.state.reload();
  await flush();
  assert.equal(env.pushListeners.length, 1);
  assert.equal(env.unsubscribed, 0);
});

// --- Run -----------------------------------------------------------------------
for (const [name, fn] of queue) {
  try {
    await fn();
    passed += 1;
    console.log('  ok -', name);
  } catch (err) {
    failures.push([name, err]);
    console.log('  FAIL -', name);
  }
}
if (failures.length > 0) {
  for (const [name, err] of failures) console.error(`\n${name}\n${err && err.stack ? err.stack : err}`);
  console.error(`\n${passed} passed, ${failures.length} failed`);
  process.exit(1);
}
console.log(`\n${passed} passed`);
