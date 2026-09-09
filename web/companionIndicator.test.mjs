// Component contract test for CompanionIndicator (web/src/components/CompanionIndicator.tsx)
// — specifically the WARDEN-1312 rework's layout contract: the visible ops suffix
// must NEVER be able to displace the host name from the Fleet Health host row.
//
// The first cut of the suffix rendered the full per-method summary ("60 ops ·
// unsubscribePanes 15 · …") inside an unconstrained inline-flex wrapper, which
// won the host row's flex line and collapsed the hostname (`flex-1 min-w-0
// truncate`, the row's only shrinkable element) to 0px at every realistic panel
// width (measured 300/312/360/420px; recovery only ~520px). Node --test can't
// lay out a flex row — but it CAN render the real component to HTML and pin the
// DOM contract that makes the collapse structurally impossible (short visible
// form + min-w-0 wrapper + bounded, truncating suffix), plus assert the width
// budget arithmetic against the measured row numbers. Change any of these
// classes or the visible form only with a fresh in-browser measurement of the
// host row at ~300px.
//
// No front-end test runner in this repo, so (like hostHealth.test.mjs) this
// loads the REAL component (TSX -> ESM via Vite's OXC transform) and renders it
// with react-dom/server. The tmp transpile dir lives under web/ so the emitted
// `react/jsx-runtime` imports resolve; StatusDot's `@/lib/utils` alias is
// pointed at a minimal cn stub (plain class join — sufficient, the assertions
// read literal class tokens, not merge semantics).
//
// Run: node companionIndicator.test.mjs   (or: npm test, from web/)
import { transformWithOxc } from 'vite';
import { renderToString } from 'react-dom/server';
import { createElement } from 'react';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));

// --- Load the REAL component (TSX -> ESM via OXC), stubbing only the @ alias ----
const tmpDir = mkdtempSync(join(__dirname, '.tmp-companionIndicator-test-'));
try {
  // StatusDot imports cn from '@/lib/utils' — a bare join is enough here.
  writeFileSync(join(tmpDir, 'cn-stub.mjs'),
    'export function cn(...inputs) { return inputs.flat(Infinity).filter(Boolean).join(" "); }\n');
  const dotPath = resolve(__dirname, 'src/components/StatusDot.tsx');
  const dotCode = (await transformWithOxc(readFileSync(dotPath, 'utf8'), dotPath, {})).code
    .replace(/from ['"]@\/lib\/utils['"]/, `from './cn-stub.mjs'`);
  writeFileSync(join(tmpDir, 'StatusDot.mjs'), dotCode);

  const indPath = resolve(__dirname, 'src/components/CompanionIndicator.tsx');
  const indCode = (await transformWithOxc(readFileSync(indPath, 'utf8'), indPath, {})).code
    .replace(/from ['"]@\/components\/StatusDot['"]/, `from './StatusDot.mjs'`);
  writeFileSync(join(tmpDir, 'CompanionIndicator.mjs'), indCode);

  const { CompanionIndicator } = await import(
    `${tmpDir}/CompanionIndicator.mjs?t=${Date.now()}`);

  let passed = 0;
  const test = (name, fn) => {
    fn();
    passed += 1;
    console.log('  ok -', name);
  };

  const render = (companion) => renderToString(createElement(CompanionIndicator, { companion }));
  const suffixSpan = (html) => {
    const m = [...html.matchAll(/<span class="([^"]*)">([^<]*)<\/span>/g)]
      .find(([, cls]) => cls.includes('truncate'));
    return m && { class: m[1], text: m[2] };
  };
  const ariaLabel = (html) => html.match(/aria-label="([^"]*)"/)?.[1];

  // The exact heavy tally from the rejected first cut's QA (send rides the
  // agent-send path; the lifecycle/exec/discover/unsubscribe noise is real
  // Fleet Health panel traffic) — 60 ops across 4 methods, 2 transport-failed.
  const HEAVY = {
    send: { n: 19, failures: 2, lastAt: 1757376000000 },
    unsubscribePanes: { n: 15, failures: 0, lastAt: 1757376000001 },
    discover: { n: 13, failures: 0, lastAt: 1757376000002 },
    exec: { n: 13, failures: 0, lastAt: 1757376000003 },
  };

  console.log('\nlayout contract: the suffix must never displace the host name (WARDEN-1312 rework)');
  const heavy = render({ state: 'active', version: 'd7a2a8e16ce9', ops: HEAVY });
  test('a heavy tally renders the SHORT visible form — the total alone, no method names', () => {
    const suffix = suffixSpan(heavy);
    assert.ok(suffix, 'suffix span rendered');
    assert.equal(suffix.text, '60 ops');
  });
  test('the suffix is bounded and self-truncating: min-w-0 + max-w-24 + truncate', () => {
    const suffix = suffixSpan(heavy);
    for (const token of ['min-w-0', 'max-w-24', 'truncate']) {
      assert.ok(suffix.class.split(' ').includes(token), `suffix class carries ${token}`);
    }
  });
  test('the wrapper can shrink: min-w-0 (it competes with the hostname for the flex line)', () => {
    const wrapper = heavy.match(/<span class="(inline-flex[^"]*)"/);
    assert.ok(wrapper, 'wrapper span rendered');
    assert.ok(wrapper[1].split(' ').includes('min-w-0'), 'wrapper class carries min-w-0');
  });
  test('width budget: dot + gap + capped suffix stays under the host-name-collapse threshold', () => {
    // Measured on the real host row (rejected first cut): the row's shrink-0
    // content is ~160px and the panel is ~300px. The indicator therefore has a
    // hard budget: size-2 dot (8px) + gap-1 (4px) + max-w-24 suffix (96px) =
    // 108px -> the hostname keeps >= ~32px even at the cap. Any of these
    // tokens growing silently breaks the row again, so pin all three.
    assert.ok(heavy.includes('size-2'), 'default 8px dot');
    assert.ok(heavy.includes('gap-1'), '4px gap');
    assert.ok(heavy.includes('max-w-24'), '96px suffix cap');
    const DOT_PX = 8, GAP_PX = 4, SUFFIX_CAP_PX = 24 * 4; // Tailwind: size-2, gap-1, spacing unit 4px
    const PANEL_PX = 300, FIXED_ROW_PX = 160;
    const budget = DOT_PX + GAP_PX + SUFFIX_CAP_PX;
    assert.ok(budget <= 110, `indicator worst case ${budget}px must stay <= ~110px`);
    assert.ok(PANEL_PX - FIXED_ROW_PX - budget >= 30,
      'hostname keeps non-zero (~>=30px) width at the 300px panel even at the cap');
  });
  test('the FULL breakdown (methods + failures) lives in the accessible label — truncation loses nothing', () => {
    assert.equal(
      ariaLabel(heavy),
      'Companion active (vd7a2a8e16ce9) — 60 ops · send 19 · unsubscribePanes 15 · discover 13 · 2 failed',
    );
  });

  console.log('\nshape: still only actionable state, still a single small element');
  test('a host with NO ops renders no suffix at all (dot only)', () => {
    const html = render({ state: 'active', version: 'v1' });
    assert.ok(!html.includes('max-w-24'), 'no suffix span');
    assert.equal((html.match(/<span/g) || []).length, 2, 'wrapper + dot only');
    assert.equal(ariaLabel(html), 'Companion active (vv1)');
  });
  test('a single op reads singular ("1 op")', () => {
    const html = render({ state: 'active', ops: { send: { n: 1, failures: 0, lastAt: 1 } } });
    assert.equal(suffixSpan(html).text, '1 op');
  });
  test('inactive state renders nothing (LOCAL / never-engaged fleet stays clean)', () => {
    assert.equal(render({ state: 'inactive' }), '');
  });
  test('missing companion renders nothing (transport disabled)', () => {
    assert.equal(render(undefined), '');
  });

  console.log('\nstate vocabulary unchanged (WARDEN-878)');
  test('bootstrapping: yellow pulse, ops suffix still bounded', () => {
    const html = render({ state: 'bootstrapping', ops: HEAVY });
    assert.equal(ariaLabel(html), 'Companion bootstrapping — 60 ops · send 19 · unsubscribePanes 15 · discover 13 · 2 failed');
    assert.ok(html.includes('animate-pulse'));
    assert.ok(html.includes('bg-yellow-500'));
  });
  test('error: red square, lastError in the label; a tally appends the FULL summary there too', () => {
    const html = render({ state: 'error', lastError: 'ssh refused', ops: HEAVY });
    assert.equal(ariaLabel(html), 'Companion error: ssh refused — 60 ops · send 19 · unsubscribePanes 15 · discover 13 · 2 failed');
    assert.ok(html.includes('bg-red-500'));
  });

  console.log(`\n${passed} passed`);
} finally {
  rmSync(tmpDir, { recursive: true, force: true });
}
