// WARDEN-1724 (client-state slice 56) — STATIC SOURCE GUARD. The notify* toast-gate
// prefs are a select over the shared ['app-config'] cache; the module singleton and
// the reloadNotificationPrefs plumbing are gone.
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(resolve(__dirname, p), 'utf8');
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/.*$/gm, '');
const walk = (d) => readdirSync(d).flatMap((f) => {
  const p = join(d, f);
  return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(p) ? [p] : [];
});

test('(a) reloadNotificationPrefs appears nowhere under web/src (comments included)', () => {
  for (const f of walk(resolve(__dirname, 'src'))) {
    assert.ok(!/reloadNotificationPrefs/.test(readFileSync(f, 'utf8')), `${f} still mentions reloadNotificationPrefs`);
  }
});

test('(b) the old singleton module is gone; no listener registry / raw config fetch for notification prefs in lib', () => {
  assert.ok(!existsSync(resolve(__dirname, 'src/lib/useNotificationPrefs.ts')));
  for (const f of walk(resolve(__dirname, 'src/lib'))) {
    const src = stripComments(readFileSync(f, 'utf8'));
    if (/notify(ChatOps|Errors|Success|Observer)|NotificationPrefs/.test(src)) {
      assert.ok(!/new Set</.test(src) || !/listeners/.test(src), `${f} has a listener registry`);
      assert.ok(!/fetch\(\s*['"`]\/api\/config/.test(src), `${f} raw-fetches /api/config for notification prefs`);
    }
  }
});

test('(c) hook is a select over the shared cache', () => {
  const hooks = stripComments(read('src/lib/appConfigHooks.ts'));
  assert.ok(/export function useNotificationPrefs\(\)/.test(hooks));
  assert.ok(/select: selectNotificationPrefs/.test(hooks));
  assert.ok(/data \?\? NOTIFICATION_PREF_DEFAULTS/.test(hooks));
});

test('(d) App does not destructure reload from useNotificationPrefs', () => {
  const app = stripComments(read('src/App.tsx'));
  assert.ok(/const \{ prefs \} = useNotificationPrefs\(\)/.test(app));
  assert.ok(!/reload\b[^\n]*=\s*useNotificationPrefs/.test(app));
});

test('(e) useConfigPersistence has no reload arg and handleConfigChange still refreshes config prefs', () => {
  const src = stripComments(read('src/lib/useConfigPersistence.ts'));
  assert.ok(!/reloadNotificationPrefs/.test(src));
  const hc = src.match(/const handleConfigChange = useCallback\(\(\) => \{[\s\S]*?\}, \[[^\]]*\]\)/)?.[0] ?? '';
  assert.ok(hc, 'found handleConfigChange');
  assert.ok(/refreshConfigPrefs\(\)/.test(hc));
  assert.ok(/refresh\(\)/.test(hc));
});
