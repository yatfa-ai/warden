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
