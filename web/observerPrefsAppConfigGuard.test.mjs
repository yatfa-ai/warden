// WARDEN-1701 (client-state slice 51) — STATIC SOURCE GUARD. observerAutoStart /
// observerSessionTimeout left App.tsx: ObserverTabs reads them from the ['app-config']
// query itself. Same readFileSync precedent as appConfigReadGuard.test.mjs.

import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(resolve(__dirname, p), 'utf8');
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/.*$/gm, '');

const app = stripComments(read('src/App.tsx'));
const tabs = stripComments(read('src/components/ObserverTabs.tsx'));

test('(a) App.tsx holds no observer lifecycle state, setters or props', () => {
  assert.ok(!/observerAutoStart/.test(app), 'App.tsx must not reference observerAutoStart');
  assert.ok(!/observerSessionTimeout/.test(app), 'App.tsx must not reference observerSessionTimeout');
  assert.ok(!/setObserver(AutoStart|SessionTimeout)/.test(app));
});

test('(b) ObserverTabs takes no such props and reads both hooks itself', () => {
  const props = tabs.match(/interface Props\s*\{[\s\S]*?\n\}/)?.[0] ?? '';
  assert.ok(props, 'found Props interface');
  assert.ok(!/observerAutoStart|observerSessionTimeout/.test(props), 'Props has neither observer pref');
  assert.ok(/useObserverAutoStart\(\)/.test(tabs));
  assert.ok(/useObserverSessionTimeout\(\)/.test(tabs));
});

test('(c) the session-timeout hook does not coalesce a loaded null to 30', () => {
  const hooks = stripComments(read('src/lib/appConfigHooks.ts'));
  assert.ok(/data === undefined \? 30 : data/.test(hooks));
});
