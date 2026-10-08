// WARDEN-1651 (client-state slice 43) — STATIC SOURCE GUARD. The host-connectivity poll is
// subscribed by the surfaces that paint it (ChatSidebar, HostsSection), not by App, so a
// settled /api/hosts/status poll tick no longer re-renders the whole App. Same readFileSync
// precedent as streamStatusDotGuard.test.mjs (no React/DOM runner here).

import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(resolve(__dirname, p), 'utf8');
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/.*$/gm, '');

const app = stripComments(read('src/App.tsx'));
const sidebar = stripComments(read('src/components/ChatSidebar.tsx'));
const hosts = stripComments(read('src/components/sidebar/HostsSection.tsx'));

test('(a) App.tsx no longer subscribes to or threads the host-status map', () => {
  assert.ok(!/useHostStatuses/.test(app), 'App.tsx must not reference useHostStatuses');
  assert.ok(!/hostStatuses/.test(app), 'App.tsx must not reference hostStatuses');
});

test('(b) ChatSidebar and HostsSection each call useHostStatuses() themselves', () => {
  assert.ok(/useHostStatuses\(\)/.test(sidebar), 'ChatSidebar calls useHostStatuses()');
  assert.ok(/useHostStatuses\(\)/.test(hosts), 'HostsSection calls useHostStatuses()');
});

test('(c) no hostStatuses prop: not declared, not destructured from props, not forwarded', () => {
  assert.ok(!/hostStatuses\s*[:?]\s*(Host|Record)/.test(sidebar), 'ChatSidebar declares no hostStatuses prop type');
  assert.ok(!/hostStatuses\s*[:?]\s*(Host|Record)/.test(hosts), 'HostsSection declares no hostStatuses prop type');
  assert.ok(!/hostStatuses=\{/.test(sidebar), 'ChatSidebar does not forward hostStatuses');
  assert.ok(!/\bHostStatusMap\b/.test(hosts), 'HostStatusMap prop type is retired');
  assert.ok(/const hostStatuses = useHostStatuses\(\)/.test(sidebar), 'sidebar reads it as a local hook result');
  assert.ok(/const hostStatuses = useHostStatuses\(\)/.test(hosts), 'HostsSection reads it as a local hook result');
});
