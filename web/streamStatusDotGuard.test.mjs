// WARDEN-1634 (client-state slice 40) — STATIC SOURCE GUARD for the <StreamStatusDot/>
// extraction. Connection state lives in the dot (so websocket open/close stops
// re-rendering all of App) and it seeds from streamApi.ready so the dot is correct
// when the header remounts after Settings closes. Same readFileSync precedent as
// returnBannerGuard.test.mjs (no React/DOM runner here).

import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const appSrc = readFileSync(resolve(__dirname, 'src/App.tsx'), 'utf8');
const paneActivitySrc = readFileSync(resolve(__dirname, 'src/components/PaneActivitySync.tsx'), 'utf8');
const dotSrc = readFileSync(resolve(__dirname, 'src/components/StreamStatusDot.tsx'), 'utf8');

test('(a) connection state + handler slots + write-only refresh state are gone from App.tsx', () => {
  for (const name of ['streamConn', 'setStreamConn', 'setLastRefreshAt', 'lastRefreshAt']) {
    assert.ok(!new RegExp(`\\b${name}\\b`).test(appSrc), `${name} must not appear in App.tsx`);
  }
  assert.ok(!/streamApi\.onOpen\b/.test(appSrc), 'streamApi.onOpen must not be assigned in App.tsx');
  assert.ok(!/streamApi\.onClose\b/.test(appSrc), 'streamApi.onClose must not be assigned in App.tsx');
  // WARDEN-1691: onAnyMessage moved to <PaneActivitySync/>; App no longer touches it.
  assert.ok(!/\b(onAnyMessage|markPaneActivity|clearPaneActivity)\b/.test(appSrc), 'App must not reference onAnyMessage/markPaneActivity/clearPaneActivity');
  assert.ok(/streamApi\.onAnyMessage\b/.test(paneActivitySrc), 'onAnyMessage lives in PaneActivitySync (feeds markPaneActivity)');
});

test('(b) <StreamStatusDot/> is rendered once in App; component owns handlers and seeds from streamApi.ready', () => {
  assert.strictEqual((appSrc.match(/<StreamStatusDot\b/g) ?? []).length, 1, 'rendered exactly once');
  assert.ok(/streamApi\.onOpen\s*=\s*\(\)\s*=>\s*setConn\(true\)/.test(dotSrc), 'owns onOpen');
  assert.ok(/streamApi\.onClose\s*=\s*\(\)\s*=>\s*setConn\(false\)/.test(dotSrc), 'owns onClose');
  assert.ok(/useState\(\(\)\s*=>\s*streamApi\.ready\)/.test(dotSrc), 'seeds from streamApi.ready (Settings-return parity)');
  assert.ok(/setConn\(streamApi\.ready\)/.test(dotSrc), 're-syncs on mount');
  assert.ok(dotSrc.includes("'Connected'") && dotSrc.includes("'Disconnected'"), 'Connected/Disconnected labels');
});

test('(c) cleanup nulls both handler slots', () => {
  const cleanup = dotSrc.slice(dotSrc.indexOf('return () =>'));
  assert.ok(/streamApi\.onOpen\s*=\s*null/.test(cleanup), 'cleanup nulls onOpen');
  assert.ok(/streamApi\.onClose\s*=\s*null/.test(cleanup), 'cleanup nulls onClose');
});
