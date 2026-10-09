// WARDEN-1714 (client-state slice 54) — STATIC SOURCE GUARD. showHostTags /
// issueLinksEnabled / issueLinkTrackers (and the markdown entry set) left App.tsx:
// PaneTile and the two markdown mounts read them from the ['app-config'] query.
// Same readFileSync precedent as observerPrefsAppConfigGuard.test.mjs.

import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(resolve(__dirname, p), 'utf8');
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/.*$/gm, '');

const app = stripComments(read('src/App.tsx'));
const grid = stripComments(read('src/components/PaneGrid.tsx'));
const tile = stripComments(read('src/components/PaneTile.tsx'));
const tabs = stripComments(read('src/components/ObserverTabs.tsx'));
const host = stripComments(read('src/components/GlobalSearchHost.tsx'));
const query = read('src/lib/appConfigQuery.ts');

test('(a) App.tsx holds no display/issue-link state, setters or props', () => {
  assert.ok(!/displaySettings|setDisplaySettings/.test(app));
  assert.ok(!/issueLinkTrackers|setIssueLinkTrackers/.test(app));
  assert.ok(!/markdownIssueEntries/.test(app));
  assert.ok(!/normalizeIssueLinkEntries|unambiguousPrefixEntries|IssueLinkEntry/.test(app));
  assert.ok(!/showHostTags|issueLinksEnabled/.test(app));
});

test('(b) PaneGrid carries no showHostTags / issueLink* props', () => {
  assert.ok(!/showHostTags|issueLinksEnabled|issueLinkTrackers/.test(grid));
});

test('(c) PaneTile declares no such props and calls the three hooks itself', () => {
  const props = tile.match(/interface Props\s*\{[\s\S]*?\n\}/)?.[0] ?? '';
  assert.ok(props, 'found Props interface');
  assert.ok(!/showHostTags|issueLinksEnabled|issueLinkTrackers/.test(props));
  assert.ok(/const showHostTags = useShowHostTags\(\)/.test(tile));
  assert.ok(/const issueLinksEnabled = useIssueLinksEnabled\(\)/.test(tile));
  assert.ok(/const issueLinkTrackers = useIssueLinkTrackers\(\)/.test(tile));
});

test('(d) ObserverTabs and GlobalSearchHost take no issueEntries prop and call useMarkdownIssueEntries', () => {
  const tabProps = tabs.match(/interface Props\s*\{[\s\S]*?\n\}/)?.[0] ?? '';
  assert.ok(tabProps && !/issueEntries/.test(tabProps));
  const hostProps = host.match(/interface GlobalSearchHostProps\s*\{[\s\S]*?\n\}/)?.[0] ?? '';
  assert.ok(hostProps && !/issueEntries/.test(hostProps));
  assert.ok(/useMarkdownIssueEntries\(\)/.test(tabs));
  assert.ok(/useMarkdownIssueEntries\(\)/.test(host));
});

test('(e) normalization composes in the hook path; appConfigQuery.ts stays import-free', () => {
  const hooks = stripComments(read('src/lib/appConfigHooks.ts'));
  assert.ok(/normalizeIssueLinkEntries\(data\)/.test(hooks));
  assert.ok(!/^\s*import\s/m.test(query), 'appConfigQuery.ts stays import-free');
});
