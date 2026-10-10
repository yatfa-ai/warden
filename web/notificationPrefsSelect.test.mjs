// WARDEN-1724 (client-state slice 56) — pure selectNotificationPrefs tests.
// Run: node notificationPrefsSelect.test.mjs   (from web/)
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
const tmpDir = mkdtempSync(join(tmpdir(), 'warden-notif-prefs-test-'));
const tmpFile = join(tmpDir, 'appConfigQuery.mjs');
writeFileSync(tmpFile, code);
const { selectNotificationPrefs, NOTIFICATION_PREF_DEFAULTS } = await import(tmpFile);
rmSync(tmpDir, { recursive: true, force: true });


const KEYS = ['notifyChatOps', 'notifyErrors', 'notifySuccess', 'notifyObserver'];
const ALL_TRUE = { notifyChatOps: true, notifyErrors: true, notifySuccess: true, notifyObserver: true };

test('null / undefined / empty cfg → all true', () => {
  assert.deepEqual(selectNotificationPrefs(null), ALL_TRUE);
  assert.deepEqual(selectNotificationPrefs(undefined), ALL_TRUE);
  assert.deepEqual(selectNotificationPrefs({}), ALL_TRUE);
  assert.deepEqual(NOTIFICATION_PREF_DEFAULTS, ALL_TRUE);
});

test('null-valued keys coalesce to true', () => {
  assert.deepEqual(selectNotificationPrefs({ notifyChatOps: null, notifyErrors: null }), ALL_TRUE);
});

for (const k of KEYS) {
  test(`explicit false passes through for ${k} only`, () => {
    assert.deepEqual(selectNotificationPrefs({ [k]: false }), { ...ALL_TRUE, [k]: false });
  });
}

test('mixed values', () => {
  assert.deepEqual(
    selectNotificationPrefs({ notifyChatOps: false, notifyErrors: true, notifyObserver: false }),
    { notifyChatOps: false, notifyErrors: true, notifySuccess: true, notifyObserver: false },
  );
});
