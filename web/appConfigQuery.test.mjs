// Tests for the pure seam behind WARDEN-1696 (client-state slice 50): the shared
// /api/config fact in the TanStack cache — query key identity, the fetcher
// (parsed body; throws on non-ok), and the companionTransportEnabled selector
// (defaults TRUE when absent). The React glue (appConfigHooks.ts) is not tested
// here — this repo has no React test stack.
//
// Run: node appConfigQuery.test.mjs   (from web/)
import { transformWithOxc } from 'vite';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const srcPath = resolve(__dirname, 'src/lib/appConfigQuery.ts');
const { code } = await transformWithOxc(readFileSync(srcPath, 'utf8'), srcPath, {});
const tmpDir = mkdtempSync(join(tmpdir(), 'warden-app-config-query-test-'));
const tmpFile = join(tmpDir, 'appConfigQuery.mjs');
writeFileSync(tmpFile, code);
const { APP_CONFIG_KEY, appConfigQueryKey, fetchAppConfig, selectCompanionTransportEnabled, selectObserverAutoStart, selectObserverSessionTimeout } = await import(tmpFile);
rmSync(tmpDir, { recursive: true, force: true });

const jsonResponse = (json, status = 200) => async (url) => {
  jsonResponse.lastUrl = url;
  return { ok: status >= 200 && status < 300, status, json: async () => json };
};

test('query key is ["app-config"] and stable', () => {
  assert.equal(APP_CONFIG_KEY, 'app-config');
  assert.deepEqual(appConfigQueryKey(), ['app-config']);
  assert.deepEqual(appConfigQueryKey(), appConfigQueryKey());
});

test('selector defaults true on undefined / null / missing key / null value', () => {
  assert.equal(selectCompanionTransportEnabled(undefined), true);
  assert.equal(selectCompanionTransportEnabled(null), true);
  assert.equal(selectCompanionTransportEnabled({}), true);
  assert.equal(selectCompanionTransportEnabled({ companionTransportEnabled: null }), true);
});

test('selector passes explicit true / false', () => {
  assert.equal(selectCompanionTransportEnabled({ companionTransportEnabled: true }), true);
  assert.equal(selectCompanionTransportEnabled({ companionTransportEnabled: false }), false);
});

test('fetchAppConfig GETs /api/config and returns the parsed body', async () => {
  const body = { companionTransportEnabled: false, pollIntervalMs: 1500 };
  assert.deepEqual(await fetchAppConfig(jsonResponse(body)), body);
  assert.equal(jsonResponse.lastUrl, '/api/config');
});

test('fetchAppConfig throws on a non-ok status', async () => {
  await assert.rejects(() => fetchAppConfig(jsonResponse({}, 500)), /config HTTP 500/);
});

test('observer auto-start selector: false unless explicitly true', () => {
  assert.equal(selectObserverAutoStart(undefined), false);
  assert.equal(selectObserverAutoStart(null), false);
  assert.equal(selectObserverAutoStart({}), false);
  assert.equal(selectObserverAutoStart({ observerAutoStart: false }), false);
  assert.equal(selectObserverAutoStart({ observerAutoStart: true }), true);
});

test('observer session timeout selector: 30 before config, null once loaded-but-absent', () => {
  assert.equal(selectObserverSessionTimeout(undefined), 30);
  assert.equal(selectObserverSessionTimeout(null), 30);
  assert.equal(selectObserverSessionTimeout({}), null, 'absent key on a loaded body is fail-safe null');
  assert.equal(selectObserverSessionTimeout({ observerSessionTimeout: null }), null, 'explicit null = disabled');
  assert.equal(selectObserverSessionTimeout({ observerSessionTimeout: 45 }), 45);
});
