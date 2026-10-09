// WARDEN-1665 (client-state slice 45) — STATIC SOURCE GUARD. App no longer subscribes to the
// per-host display labels; useTokenBudget reads them from the store at alarm time, so a label
// edit in Settings → Hosts does not re-render App. Same readFileSync precedent as
// hostStatusesSubscriptionGuard.test.mjs (no React/DOM runner here).

import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(resolve(__dirname, p), 'utf8');
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/.*$/gm, '');

const app = stripComments(read('src/App.tsx'));
const budget = stripComments(read('src/lib/useTokenBudget.ts'));

test('(a) App.tsx neither subscribes to nor threads hostLabels', () => {
  assert.ok(!/useHostLabels/.test(app), 'App.tsx must not reference useHostLabels');
  assert.ok(!/hostLabels/.test(app), 'App.tsx must not reference hostLabels');
});

test('(b) useTokenBudget reads hostLabels from the store inside deliver(), with no ref/arg', () => {
  assert.ok(!/hostLabelsRef/.test(budget), 'no hostLabelsRef stash');
  assert.ok(!/hostLabels\s*\?\s*:/.test(budget), 'hostLabels is not an arg');
  assert.ok(/formatBudgetMessageWith\(\s*b\s*,\s*formatTokens\s*,\s*uiStore\.getState\(\)\.hostLabels\s*\)/.test(budget),
    'deliver passes uiStore.getState().hostLabels at call time');
});
