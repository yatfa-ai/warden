// Component contract test for LiveFeedChrome (web/src/components/LiveFeedChrome.tsx)
// — the shared Observer live-feed chrome extracted from ActivityTimeline and
// DirectiveHistory in WARDEN-1419.
//
// WHY THIS FILE EXISTS: before the extraction, NO spec anywhere referenced
// either feed component (`git grep -lE "ActivityTimeline|DirectiveHistory" --
// '*test*'` matched only HTTP-level and pure-helper suites), so the controls and
// the fetch-failure strip were pinned by nothing at all — and the strip had
// already been BUILT TWICE (WARDEN-1060 for activity, WARDEN-1122 for
// directives) and its "filter menus reorder on every poll" sibling bug FIXED
// TWICE (WARDEN-1113). Consolidating the JSX removes the lockstep tax; this
// suite is what stops the single surviving copy from silently regressing.
//
// WHAT IT PINS, and why each leg is not cosmetic:
//   - RAW-COUNT GATE. The strip must key off the caller's raw row count, never
//     the filtered count. Invert that and an active filter matching nothing
//     during a perfectly HEALTHY fetch is dressed up as a failure; drop it and a
//     feed with zero rows shows a strip over an empty list instead of the
//     caller's own full-screen error arm.
//   - error.message, NOT error. `useLiveTimeline` stores an `Error` instance
//     (useLiveTimeline.ts: `setError(e instanceof Error ? e : new Error(...))`).
//     An Error object as a React child THROWS, so the strip would take the whole
//     Observer tab down at the exact moment the backend is already failing.
//   - NON-BLOCKING. The strip is a sibling of the header, and the caller's rows
//     stay on screen underneath. If it ever became a replacement, a transient
//     poll failure would wipe a feed the user is reading.
//   - PER-CALLER COPY. `title` / `noun` / `staleNoun` are props precisely so the
//     two feeds keep saying different things ("events" vs "directives", "last
//     known activity" vs "last known directives") — the anti-uniformize
//     constraint. `staleNoun` is separate from `noun` because the activity feed
//     counts "events" but describes its retained rows as "activity".
//   - ACTIVITY-ONLY TYPE FILTER. It arrives through `extraFilters` and renders
//     FIRST in the filter row; DirectiveHistory passes none and must never grow
//     one (it has no types).
//
// No front-end test runner in this repo, so (like companionIndicator.test.mjs)
// this loads the REAL component (TSX -> ESM via Vite's OXC transform) and renders
// it with react-dom/server. The tmp transpile dir lives under web/ so the emitted
// `react/jsx-runtime` imports resolve; the ui primitives' `@/lib/utils` alias is
// pointed at a minimal cn stub (plain class join — sufficient, the assertions read
// literal class tokens and text, not merge semantics), and `@/lib/timelinePacing`
// is loaded for real so the stats line's "Updated Ns ago" suffix is the genuine
// formatter.
//
// Run: node liveFeedChrome.test.mjs   (or: npm test, from web/)
import { transformWithOxc } from 'vite';
import { renderToString } from 'react-dom/server';
import { createElement } from 'react';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));

const tmpDir = mkdtempSync(join(__dirname, '.tmp-liveFeedChrome-test-'));
try {
  writeFileSync(
    join(tmpDir, 'cn-stub.mjs'),
    'export function cn(...inputs) { return inputs.flat(Infinity).filter(Boolean).join(" "); }\n',
  );

  const emit = async (rel) => {
    const abs = resolve(__dirname, rel);
    return (await transformWithOxc(readFileSync(abs, 'utf8'), abs, {})).code;
  };
  const aliasCn = (code) => code.replaceAll(/from ['"]@\/lib\/utils['"]/g, `from './cn-stub.mjs'`);

  writeFileSync(join(tmpDir, 'button.mjs'), aliasCn(await emit('src/components/ui/button.tsx')));
  writeFileSync(join(tmpDir, 'select.mjs'), aliasCn(await emit('src/components/ui/select.tsx')));
  writeFileSync(join(tmpDir, 'timelinePacing.mjs'), await emit('src/lib/timelinePacing.ts'));

  const chromeCode = (await emit('src/components/LiveFeedChrome.tsx'))
    .replace(/from ['"]@\/components\/ui\/button['"]/, `from './button.mjs'`)
    .replace(/from ['"]@\/components\/ui\/select['"]/, `from './select.mjs'`)
    .replace(/from ['"]@\/lib\/timelinePacing['"]/, `from './timelinePacing.mjs'`);
  // The rewrites are ASSERTED, not assumed: an unrewritten `@/` specifier would
  // fail to resolve loudly, but a PARTIAL rewrite could silently load a
  // different module, so pin that no alias survives.
  assert.ok(!chromeCode.includes('@/'), 'every @/ specifier was rewritten onto the tmp modules');
  writeFileSync(join(tmpDir, 'LiveFeedChrome.mjs'), chromeCode);

  const { LiveFeedChrome } = await import(`${tmpDir}/LiveFeedChrome.mjs?t=${Date.now()}`);

  let passed = 0;
  const test = (name, fn) => {
    fn();
    passed += 1;
    console.log('  ok -', name);
  };

  const noop = () => {};
  // Defaults model a healthy activity feed; each test overrides only what it means to.
  const base = {
    title: 'Activity Timeline',
    noun: 'events',
    staleNoun: 'activity',
    isLive: true,
    setIsLive: noop,
    refresh: noop,
    loading: false,
    refreshing: false,
    lastUpdated: null,
    now: 0,
    error: null,
    hostFilter: 'all',
    setHostFilter: noop,
    agentFilter: 'all',
    setAgentFilter: noop,
    allHosts: [],
    allAgents: [],
    limit: 100,
    setLimit: noop,
    filteredCount: 0,
    totalCount: 0,
  };
  const render = (props) => renderToString(createElement(LiveFeedChrome, { ...base, ...props }));
  // React inserts `<!-- -->` text-boundary markers between adjacent children;
  // strip them so assertions read the sentence a human actually sees.
  const text = (html) => html.replaceAll('<!-- -->', '').replace(/<[^>]+>/g, '');
  const stripHtml = (html) => html.slice(html.indexOf('<div role="status"'));

  console.log('\nfetch-failure strip — the RAW-count gate (the invariant both copies carried)');
  test('error + raw rows > 0 -> strip renders', () => {
    // filteredCount 0 deliberately: this is the discriminating case. Gating on
    // the filtered count instead of the raw one makes this strip DISAPPEAR
    // while the feed is genuinely failing with stale rows on screen.
    const html = render({ error: new Error('HTTP 503'), totalCount: 7, filteredCount: 0 });
    assert.ok(html.includes('role="status"'), 'strip present');
    assert.match(text(html), /Live updates failed \(HTTP 503\) — showing last known activity\./);
  });
  test('error + raw rows === 0 -> NO strip (the caller owns the full-screen error arm)', () => {
    const html = render({ error: new Error('HTTP 503'), totalCount: 0, filteredCount: 0 });
    assert.ok(!html.includes('role="status"'));
  });
  test('a filter matching nothing during a HEALTHY fetch is never dressed up as a failure', () => {
    // filteredCount 0 with rows loaded and no error: gating on the filtered
    // count instead of the raw one would show a failure strip here.
    const html = render({ error: null, totalCount: 40, filteredCount: 0 });
    assert.ok(!html.includes('role="status"'));
  });
  test('error during the FIRST load (loading) -> NO strip; the loading state owns the screen', () => {
    const html = render({ loading: true, error: new Error('HTTP 503'), totalCount: 7 });
    assert.ok(!html.includes('role="status"'));
  });
  test('the strip renders error.message, never the Error object (an Error as a child throws)', () => {
    const html = render({ error: new Error('HTTP 503'), totalCount: 7 });
    const strip = stripHtml(html);
    assert.match(strip, /title="Live updates failed: HTTP 503"/);
    assert.ok(!text(strip).includes('Error:'), 'no stringified Error leaked into the copy');
  });
  test('non-blocking: the strip is a SIBLING of the header, not a replacement for it', () => {
    const html = render({ error: new Error('HTTP 503'), totalCount: 7 });
    // Header still rendered, and the strip follows it at the same level.
    assert.ok(html.indexOf('Activity Timeline') < html.indexOf('role="status"'));
    assert.ok(html.includes('Showing'), 'the stats line survives a failed poll');
  });
  test('the message is NOT truncated — clipping would hide the one diagnostic part', () => {
    const strip = stripHtml(render({ error: new Error('HTTP 503'), totalCount: 7 }));
    const span = strip.match(/<span class="([^"]*)">Live updates failed/)?.[1] ?? '';
    assert.ok(span.split(' ').includes('min-w-0'));
    assert.ok(!span.split(' ').includes('truncate'));
  });

  console.log('\nper-caller copy — title / noun / staleNoun stay props (anti-uniformize)');
  test('the directives feed says "directives" in BOTH the stats line and the strip tail', () => {
    const html = render({
      title: 'Directives',
      noun: 'directives',
      staleNoun: 'directives',
      error: new Error('HTTP 500'),
      totalCount: 12,
      filteredCount: 3,
    });
    const t = text(html);
    assert.match(t, /Directives/);
    assert.match(t, /Showing 3 of 12 directives/);
    assert.match(t, /showing last known directives\./);
  });
  test('the activity feed COUNTS "events" but describes retained rows as "activity"', () => {
    // staleNoun is a separate prop precisely so these two words can differ.
    const t = text(render({ error: new Error('x'), totalCount: 12, filteredCount: 3 }));
    assert.match(t, /Showing 3 of 12 events/);
    assert.match(t, /showing last known activity\./);
  });

  console.log('\nheader controls');
  test('Live: pulse dot + "Live" + the pause affordance', () => {
    const html = render({ isLive: true });
    assert.match(text(html), /Live/);
    assert.ok(html.includes('bg-green-500 animate-pulse'));
    assert.match(html, /title="Pause live updates"/);
  });
  test('Paused: muted dot + "Paused" + the resume affordance', () => {
    const html = render({ isLive: false });
    assert.match(text(html), /Paused/);
    assert.ok(html.includes('bg-muted-foreground'));
    assert.ok(!html.includes('animate-pulse'));
    assert.match(html, /title="Resume live updates"/);
  });
  test('Refresh shows the transient "Refreshing..." label while a fetch is in flight', () => {
    assert.match(text(render({ refreshing: false })), /Refresh(?!ing)/);
    assert.match(text(render({ refreshing: true })), /Refreshing\.\.\./);
  });
  test('Refresh is disabled during loading and during refreshing', () => {
    // Match the ATTRIBUTE, not the substring: the Button class literal itself
    // contains `disabled:pointer-events-none`, so a bare `.includes('disabled')`
    // passes on every render and asserts nothing.
    const isDisabled = (html) => html.includes('disabled=""');
    assert.ok(isDisabled(render({ loading: true })));
    assert.ok(isDisabled(render({ refreshing: true })));
    assert.ok(!isDisabled(render({})));
  });

  console.log('\nstats line');
  test('Paused suppresses the freshness label (a paused clock must not read "live")', () => {
    const t = text(render({ isLive: false, lastUpdated: 1_000, now: 61_000 }));
    assert.match(t, /Showing 0 of 0 events · Paused/);
    assert.ok(!t.includes('Updated'));
  });
  test('Live + lastUpdated renders the REAL formatUpdatedAgo label', () => {
    const t = text(render({ isLive: true, lastUpdated: 1_000, now: 61_000 }));
    assert.match(t, /· Updated 1m ago/);
  });
  test('Live with no successful fetch yet renders neither suffix', () => {
    const t = text(render({ isLive: true, lastUpdated: null }));
    assert.match(t, /Showing 0 of 0 events$/);
  });

  console.log('\nfilter row — three shared Selects, plus the Activity-only slot');
  test('exactly three Selects by default (host / agent / limit)', () => {
    const html = render({});
    assert.equal(html.match(/role="combobox"/g).length, 3);
  });
  test('extraFilters renders FIRST, ahead of the shared three', () => {
    const html = render({
      extraFilters: createElement('div', { 'data-testid': 'type-filter' }, 'All Types'),
    });
    assert.equal(html.match(/role="combobox"/g).length, 3, 'the shared three are unchanged');
    assert.ok(
      html.indexOf('data-testid="type-filter"') < html.indexOf('role="combobox"'),
      'the caller slot precedes the host Select',
    );
  });
  test('DirectiveHistory passes no slot, so no type filter can appear on it', () => {
    const html = render({ title: 'Directives', noun: 'directives', staleNoun: 'directives' });
    assert.ok(!text(html).includes('All Types'));
  });

  console.log(`\n${passed} passed`);
} finally {
  rmSync(tmpDir, { recursive: true, force: true });
}
