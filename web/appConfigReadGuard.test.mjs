// WARDEN-1696 (client-state slice 50) — STATIC SOURCE GUARD. companionTransportEnabled left
// App.tsx: HealthPanel reads it from the ['app-config'] query cache itself, and App's
// refreshConfigPrefs fills that cache via queryClient.fetchQuery instead of a raw fetch.
// Same readFileSync precedent as hostLabelsReadGuard.test.mjs (no React/DOM runner here).

import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(resolve(__dirname, p), 'utf8');
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/.*$/gm, '');

const app = stripComments(read('src/App.tsx'));
const panel = stripComments(read('src/components/HealthPanel.tsx'));
const query = stripComments(read('src/lib/appConfigQuery.ts'));

test('(a) App.tsx has no companionTransportEnabled / setter / raw /api/config fetch', () => {
  assert.ok(!/companionTransportEnabled/i.test(app), 'App.tsx must not reference companionTransportEnabled');
  assert.ok(!/setCompanionTransportEnabled/.test(app));
  assert.ok(!/fetch\('\/api\/config'\)/.test(app), 'refreshConfigPrefs must go through queryClient.fetchQuery');
  assert.ok(/queryClient\.fetchQuery\(/.test(app));
});

test('(b) HealthPanel reads the flag itself and takes no such prop', () => {
  assert.ok(/useCompanionTransportEnabled\(\)/.test(panel));
  const props = panel.match(/interface HealthPanelProps\s*\{[^}]*\}/)?.[0] ?? '';
  assert.ok(props && !/companionTransportEnabled/.test(props), 'HealthPanelProps has no companionTransportEnabled');
});

test('(c) appConfigQuery.ts stays pure (no imports)', () => {
  assert.ok(!/^\s*import\s/m.test(query), 'appConfigQuery.ts must have no imports');
});

// WARDEN-1706 (slice 52) — confirmDestructiveActions left App.tsx: the shared destructive gate
// reads the ['app-config'] cache at press time instead of subscribing via useState.
test('(d) App.tsx has no confirmDestructiveActions state/setter; the gate reads the cache at press time', () => {
  assert.ok(!/confirmDestructiveActions/.test(app), 'App.tsx must not reference confirmDestructiveActions');
  assert.ok(!/setConfirmDestructiveActions/.test(app));
  const gate = app.match(/const shouldConfirmDestructive = useCallback\([\s\S]*?\);/)?.[0] ?? '';
  assert.ok(/getQueryData/.test(gate) && /selectConfirmDestructiveActions/.test(gate), 'gate must use getQueryData + selectConfirmDestructiveActions');
});

// WARDEN-1709 (slice 53) — pollIntervalMs left App: usePollIntervalMs() reads the resolved
// cadence from the ['app-config'] cache for App's poller and FileViewer; no prop chains remain.
test('(e) pollIntervalMs is a hook read, not App state or a prop chain', () => {
  assert.ok(!/setPollIntervalMs/.test(app), 'App.tsx must not have setPollIntervalMs');
  assert.ok(!/useState<number>\(WEB_POLL_DEFAULT_MS\)/.test(app));
  assert.ok(/const pollIntervalMs = usePollIntervalMs\(\)/.test(app));
  for (const f of ['FileViewer', 'ChatSidebar', 'PaneGrid', 'PaneTile', 'HealthPanel', 'HealthDashboard']) {
    const src = stripComments(read(`src/components/${f}.tsx`));
    assert.ok(!/pollIntervalMs\??\s*:/.test(src), `${f} must not declare a pollIntervalMs prop`);
    assert.ok(!/pollIntervalMs=\{/.test(src), `${f} must not pass a pollIntervalMs JSX attribute`);
    if (f !== 'FileViewer') assert.ok(!/pollIntervalMs/.test(src), `${f} must not reference pollIntervalMs`);
  }
  assert.ok(/usePollIntervalMs\(\)/.test(stripComments(read('src/components/FileViewer.tsx'))));
  assert.ok(!/^\s*import\s/m.test(query), 'appConfigQuery.ts stays import-free');
});

// WARDEN-1736 (slice 57) — App stopped subscribing to the four notify* toast-gate prefs: each
// gesture-time callback reads the ['app-config'] cache at call time.
test('(f) App.tsx reads notify* prefs at call time in each toast-gating callback', () => {
  assert.ok(!/useNotificationPrefs|prefs\.notify/.test(app), 'App.tsx must not subscribe to notify* prefs');
  assert.ok(/selectNotificationPrefs\(\s*queryClient\.getQueryData<AppConfig>\(appConfigQueryKey\(\)\)/.test(app));
  for (const name of ['spawnShell', 'respawnChat', 'saveClosedSession', 'performForceKill', 'performKill', 'renameChat', 'handleReplyResult']) {
    const start = app.indexOf(`const ${name} = useCallback(`);
    assert.ok(start >= 0, `found ${name}`);
    const end = app.indexOf('\n  }, [', start);
    const body = app.slice(start, end);
    const deps = app.slice(end, app.indexOf(']);', end));
    assert.ok(/readNotificationPrefs\(\)\.notify/.test(body), `${name} reads prefs at call time`);
    assert.ok(!/prefs\.notify/.test(deps), `${name} deps carry no prefs.*`);
  }
});

// WARDEN-1746 (slice 58) — ObserverTabs, ChatSidebar and HealthDashboard stopped subscribing to the
// notify* toast-gate prefs: they read the ['app-config'] cache at call time via the stable
// useNotificationPrefsReader().
test('(g) ObserverTabs/ChatSidebar/HealthDashboard read notify* prefs at call time via the reader', () => {
  const hooksRaw = read('src/lib/appConfigHooks.ts');
  const hooks = stripComments(hooksRaw);
  assert.ok(/export function useNotificationPrefsReader\(\)/.test(hooks), 'reader exported');
  assert.ok(/export function useNotificationPrefs\(\)/.test(hooks), 'useNotificationPrefs stays exported');
  for (const f of ['ObserverTabs', 'ChatSidebar', 'HealthDashboard']) {
    const src = stripComments(read(`src/components/${f}.tsx`));
    assert.ok(/useNotificationPrefsReader\(\)/.test(src), `${f} calls useNotificationPrefsReader()`);
    assert.ok(/readNotificationPrefs\(\)\.notify/.test(src), `${f} reads prefs at call time`);
    assert.ok(!/useNotificationPrefs\b(?!Reader)/.test(src), `${f} must not use the subscribing useNotificationPrefs`);
    assert.ok(!/prefs\.notify/.test(src), `${f} must not read prefs.notify*`);
    assert.ok(!/prefsRef/.test(src), `${f} must not keep a prefsRef mirror`);
  }
  const sidebar = stripComments(read('src/components/ChatSidebar.tsx'));
  const start = sidebar.indexOf('const fetchCollections = useCallback(');
  assert.ok(start >= 0, 'found fetchCollections');
  const end = sidebar.indexOf('\n  }, [', start);
  const deps = sidebar.slice(end, sidebar.indexOf(']);', end));
  assert.ok(!/prefs/.test(deps.replace(/readNotificationPrefs/g, '')), 'fetchCollections deps carry no prefs.*');
});
