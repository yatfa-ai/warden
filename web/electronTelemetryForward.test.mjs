// Tests for the three consent-gated telemetry window forwards in
// web/src/lib/electron.ts (WARDEN-2024): forwardPaneMetrics (WARDEN-1385),
// forwardWorkspaceShape (WARDEN-1424), forwardFeatureUsage (WARDEN-1479).
//
// They are copy-pasted siblings of forwardRendererError, each mapped to its
// OWN preload method / IPC channel, and main gates each on a DIFFERENT consent
// category. A cross-wired method name would deliver one category's window to
// another category's consent gate and nothing else would fail, so each forward
// is pinned to its own bridge method, its feature-detect no-op, and its
// swallowed bridge throw.
//
// Same harness as electron.test.mjs: OXC-transform the REAL electron.ts to a
// temp .mjs and import it; the helpers read `window.wardenTelemetry` at CALL
// time, so we swap globalThis.window per case.
//
// Run: node --test electronTelemetryForward.test.mjs   (from web/)
import { test, after } from 'node:test';
import { transformWithOxc } from 'vite';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const libDir = resolve(__dirname, 'src/lib');

const src = readFileSync(join(libDir, 'electron.ts'), 'utf8');
const { code } = await transformWithOxc(src, join(libDir, 'electron.ts'), {});
const tmpDir = mkdtempSync(join(tmpdir(), 'warden-electron-fwd-test-'));
const file = join(tmpDir, 'electron.mjs');
writeFileSync(file, code);
const mod = await import(file);
after(() => rmSync(tmpDir, { recursive: true, force: true }));

const CASES = [
  ['forwardPaneMetrics', 'reportPaneMetrics'],
  ['forwardWorkspaceShape', 'reportWorkspaceShape'],
  ['forwardFeatureUsage', 'reportFeatureUsage'],
];
const ALL_METHODS = CASES.map(([, m]) => m);

// Run fn with window / console.warn swapped; always restore.
function withEnv(win, fn) {
  const hadWindow = Object.prototype.hasOwnProperty.call(globalThis, 'window');
  const prevWindow = globalThis.window;
  const prevWarn = console.warn;
  const warnings = [];
  globalThis.window = win;
  console.warn = (...args) => warnings.push(args);
  try {
    return fn(warnings);
  } finally {
    console.warn = prevWarn;
    if (hadWindow) globalThis.window = prevWindow;
    else delete globalThis.window;
  }
}

for (const [name, method] of CASES) {
  const forward = mod[name];

  test(`${name} hands the snapshot (by reference) to ${method} only`, () => {
    const calls = [];
    const bridge = {};
    for (const m of ALL_METHODS) bridge[m] = (snap) => calls.push([m, snap]);
    const snap = { a: 1 };
    withEnv({ wardenTelemetry: bridge }, () => forward(snap));
    assert.deepEqual(calls, [[method, snap]]);
    assert.equal(calls[0][1], snap);
  });

  test(`${name} is a silent no-op when the bridge or method is absent`, () => {
    withEnv({}, (warnings) => {
      const others = {};
      let called = 0;
      for (const m of ALL_METHODS) {
        if (m !== method) others[m] = () => { called += 1; };
      }
      assert.doesNotThrow(() => forward({ a: 1 })); // no wardenTelemetry
      globalThis.window = { wardenTelemetry: {} };
      assert.doesNotThrow(() => forward({ a: 1 }));
      globalThis.window = { wardenTelemetry: others };
      assert.doesNotThrow(() => forward({ a: 1 }));
      assert.equal(called, 0, 'must not fall back to a sibling method');
      globalThis.window = { wardenTelemetry: { [method]: 'not-a-function' } };
      assert.doesNotThrow(() => forward({ a: 1 }));
      // Absence is detected up front, not via a caught failed call.
      assert.deepEqual(warnings, []);
    });
  });

  test(`${name} swallows a throwing bridge and warns once`, () => {
    const boom = new Error('ipc closed');
    withEnv(
      { wardenTelemetry: { [method]: () => { throw boom; } } },
      (warnings) => {
        assert.doesNotThrow(() => forward({ a: 1 }));
        assert.equal(warnings.length, 1);
        assert.match(
          warnings[0][0],
          new RegExp(`\\[warden:electron\\] ${name} failed`),
        );
        assert.equal(warnings[0][1], boom);
        assert.equal(warnings[0][1].message, 'ipc closed');
      },
    );
  });
}
