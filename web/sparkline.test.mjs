// Tests for the <Sparkline> component itself (web/src/components/Sparkline.tsx,
// WARDEN-1243) — the drawing half of the Fleet Health per-agent activity strip.
//
// WHY THIS FILE EXISTS. The data producer side is exhaustively tested
// (web/agentSparkline.test.mjs covers buildAgentActivity + selectAgentSparkline),
// but the component that turns the selected series into ink had ZERO coverage —
// its only mentions anywhere in the suite were a comment and an assertion
// message. That assertion message states a contract on the component's behalf
// that no test verified: "all buckets zero -> Sparkline hasData=false -> flat
// baseline" (agentSparkline.test.mjs, case 3). This is not hypothetical — the
// flat-baseline-for-idle-agents behaviour shipped dead once already (the
// WARDEN-299 follow-up fix: an idle container was absent from the activity map
// and rendered nothing) and nothing was added at the time to stop it happening
// again. These tests exercise the component directly so the next change that
// breaks the drawn output fails the suite instead of shipping. They
// CHARACTERISE current, correct behaviour; the component is not modified.
//
// Harness — the same one the producer's suite uses (agentSparkline.test.mjs /
// storage.test.mjs precedent): transpile the REAL source via Vite's OXC
// transform and import it under Node. <Sparkline> is a pure function returning
// an element tree — no hooks, no browser APIs — so calling it directly and
// asserting on the returned tree needs no DOM and no new test dependencies.
// Its one runtime import is `cn` from @/lib/utils, so that module is transpiled
// alongside it and the bare `@/lib/utils` specifier rewritten to the sibling
// file — the ONE specifier rewrite (utils' own bare imports, clsx and
// tailwind-merge, are left alone; see the tmp-dir note below).
//
// One deliberate deviation from the precedent: the tmp dir is created INSIDE
// web/ (not os.tmpdir()), because the emitted Sparkline module carries bare npm
// imports — react/jsx-runtime (OXC's automatic JSX runtime), plus clsx and
// tailwind-merge via utils — which Node can only resolve by walking up to
// web/node_modules. The emitted files are named *.mjs (never *.test.mjs) so
// `node --test` cannot pick them up, and cleanup runs in a finally block so a
// failed import never litters the working tree.
//
// Honest limitation (accepted when this file was commissioned): asserting on
// the returned element structure pins React's internal element shape rather
// than final rendered output. It verifies what the component RETURNS, not what
// a browser paints — a change to the JSX structure fails these tests, a change
// only in CSS painting semantics would not. Asserting on returned plain
// objects is already the suite's standard practice for pure modules.
//
// Run: node sparkline.test.mjs   (or: npm test, from web/)
import { transformWithOxc } from 'vite';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const compPath = resolve(__dirname, 'src/components/Sparkline.tsx');
const utilsPath = resolve(__dirname, 'src/lib/utils.ts');

// --- Load the REAL Sparkline.tsx (TSX -> ESM via the OXC transform Vite bundles)
const src = readFileSync(compPath, 'utf8');
const utilsSrc = readFileSync(utilsPath, 'utf8');
const { code } = await transformWithOxc(src, compPath, {});
const { code: utilsCode } = await transformWithOxc(utilsSrc, utilsPath, {});

// Inside web/ (NOT os.tmpdir) so bare npm specifiers resolve via web/node_modules.
const tmpDir = mkdtempSync(join(__dirname, 'warden-sparkline-test-'));
let mod;
try {
  writeFileSync(join(tmpDir, 'utils.mjs'), utilsCode);
  const tmpFile = join(tmpDir, 'Sparkline.mjs');
  writeFileSync(tmpFile, code.replaceAll('@/lib/utils', './utils.mjs'));
  mod = await import(tmpFile);
} finally {
  rmSync(tmpDir, { recursive: true, force: true });
}
const { Sparkline } = mod;

let passed = 0;
const test = (name, fn) => {
  fn();
  passed += 1;
  console.log('  ok -', name);
};

// Float-tolerant equality: bar geometry is computed (v/max)*VB_H etc., so exact
// literals differ in the last ulp. 1e-9 is far below any visually meaningful
// difference in a 100x20 unitless viewBox.
const near = (actual, expected, what) =>
  assert.ok(Math.abs(actual - expected) < 1e-9, `${what}: expected ~${expected}, got ${actual}`);

// --- Tree-walking helpers ------------------------------------------------------
// The with-data branch renders values.map(...) -> an ARRAY of one <g> per
// bucket. Each <g> holds the muted volume <rect> plus, for a bucket with
// errors, a second red-base <rect> (the `{hadError && ...}` child is `false`
// when absent, so filter rather than index blindly).
const bucketGroups = (el) => {
  const kids = el.props.children;
  assert.ok(Array.isArray(kids), 'with-data sparkline must render one <g> per bucket (array)');
  return kids;
};
const parseBar = (g) => {
  const inner = Array.isArray(g.props.children) ? g.props.children : [g.props.children];
  const rects = inner.filter((k) => k && k.type === 'rect');
  const [bar, errBase] = rects;
  return {
    x: bar.props.x,
    y: bar.props.y,
    width: bar.props.width,
    height: bar.props.height,
    className: bar.props.className,
    err: errBase
      ? { y: errBase.props.y, height: errBase.props.height, className: errBase.props.className }
      : null,
  };
};

console.log('\nsvg shell — the sizing/scale contract (unitless viewBox, no px leakage)');
test('root is an svg with role=img and the aria-label passed through', () => {
  const el = Sparkline({ values: [1], ariaLabel: '1 event in the last 24 hours' });
  assert.equal(el.type, 'svg');
  assert.equal(el.props.role, 'img');
  assert.equal(el.props['aria-label'], '1 event in the last 24 hours');
});
test('unitless 100x20 viewBox + preserveAspectRatio=none (scales to CSS size, no magic px)', () => {
  const el = Sparkline({ values: [1], ariaLabel: 'a' });
  assert.equal(el.props.viewBox, '0 0 100 20');
  assert.equal(el.props.preserveAspectRatio, 'none');
});
test('no className -> muted-foreground base only (the caller always owns size)', () => {
  const el = Sparkline({ values: [1], ariaLabel: 'a' });
  assert.equal(el.props.className, 'text-muted-foreground shrink-0');
});
test("caller's size classes are merged over the base via the REAL cn (twMerge)", () => {
  // Mirrors the HealthDashboard call site: spacing-token size + compact density.
  const el = Sparkline({
    values: [1],
    ariaLabel: 'a',
    className: 'w-14 h-4 compact:w-12 compact:h-3.5',
  });
  assert.equal(el.props.className, 'text-muted-foreground shrink-0 w-14 h-4 compact:w-12 compact:h-3.5');
});

console.log('\nno data — the flat baseline (the contract agentSparkline.test.mjs asserts on this component\'s behalf)');
test('all-zero values (the producer\'s idle zero-fill) -> ONE flat baseline rect, no bars', () => {
  // THE regression this file exists to guard: selectAgentSparkline hands a
  // zero-filled series to <Sparkline> for an alive-but-quiet agent, and the
  // component must answer with a visible flat line — never a blank. This is
  // exactly the branch that shipped dead in WARDEN-299 and needed a follow-up.
  const el = Sparkline({ values: [0, 0, 0, 0, 0], errors: [0, 0, 0, 0, 0], ariaLabel: '0 events in the last 24 hours' });
  const kids = el.props.children;
  assert.ok(!Array.isArray(kids), 'idle sparkline renders a single baseline element, not per-bucket groups');
  assert.equal(kids.type, 'rect');
  assert.equal(el.props['aria-label'], '0 events in the last 24 hours');
});
test('baseline geometry: bottom-anchored thin strip spanning the full strip', () => {
  const el = Sparkline({ values: [0, 0, 0], ariaLabel: 'idle' });
  const r = el.props.children.props;
  assert.equal(r.x, 0);
  assert.equal(r.y, 18); // VB_H - 2
  assert.equal(r.width, 100);
  assert.equal(r.height, 2);
  assert.equal(r.className, 'fill-current opacity-40');
});
test('empty values array -> the same flat baseline, never a blank svg', () => {
  const el = Sparkline({ values: [], ariaLabel: 'no buckets yet' });
  assert.equal(el.props.children.type, 'rect');
  assert.equal(el.props.children.props.height, 2);
});

console.log('\nwith data — one bar per bucket, height ∝ volume, red base for errors');
test('one <g> per bucket; muted bar with x/width on an even grid, height ∝ value/max', () => {
  // values [0,2,0,3,1]: max 3, so barW = (100 - 1*4)/5 = 19.2, pitch 20.2.
  const el = Sparkline({ values: [0, 2, 0, 3, 1], errors: [0, 0, 0, 0, 0], ariaLabel: '6 events in the last 24 hours' });
  const bars = bucketGroups(el).map(parseBar);
  assert.equal(bars.length, 5);
  // Grid: x_i = i * (barW + GAP), constant width.
  bars.forEach((b, i) => {
    near(b.x, i * 20.2, `bar ${i} x`);
    near(b.width, 19.2, `bar ${i} width`);
    assert.equal(b.className, 'fill-current opacity-60');
    assert.equal(b.err, null, 'no errors -> no red base anywhere');
  });
  // Height ∝ value against the series max, bottom-anchored (y = 20 - h).
  near(bars[1].height, (2 / 3) * 20, 'v=2 height');
  near(bars[1].y, 20 - (2 / 3) * 20, 'v=2 y');
  near(bars[3].height, 20, 'v=3 (the max) is a full-height bar');
  near(bars[3].y, 0, 'max bucket touches the top');
  near(bars[0].height, 0, 'v=0 renders a zero-height bar');
  near(bars[0].y, 20, 'v=0 sits on the baseline');
});
test('bucket with errors: whole bar tinted red + a crisp red base ∝ the error sub-count', () => {
  const el = Sparkline({ values: [0, 2, 0, 0, 0], errors: [0, 1, 0, 0, 0], ariaLabel: '2 events, 1 error in the last 24 hours' });
  const bars = bucketGroups(el).map(parseBar);
  assert.equal(bars[1].className, 'fill-red-500/70', 'errored bucket tints the whole bar');
  assert.ok(bars[1].err, 'errored bucket gets a red base rect');
  assert.equal(bars[1].err.className, 'fill-red-500');
  // values max is 2 -> the bar is full height; error base = (1/2)*20 = 10.
  near(bars[1].height, 20, 'v=2 is the series max -> full-height bar');
  near(bars[1].err.height, (1 / 2) * 20, 'error base height');
  near(bars[1].err.y, 20 - (1 / 2) * 20, 'error base y');
  assert.ok(bars[1].err.height < bars[1].height, 'error base never taller than its bar');
  assert.equal(bars[0].err, null, 'clean bucket gets no red base');
});
test('low-volume agent (series max of 1) still draws a full-height bar — alive, not idle', () => {
  // max(1, ...values): a single event is a visible bar, not a flatline.
  const el = Sparkline({ values: [1, 0, 0], ariaLabel: '1 event in the last 24 hours' });
  const bars = bucketGroups(el).map(parseBar);
  near(bars[0].height, 20, 'max=1 floor gives the lone event full height');
  near(bars[0].y, 0, 'and it reaches the top');
});
test('error base clamps to the total bar height so it can never overshoot', () => {
  // errors[0] (4) > values[0] (2) cannot happen on the wire, but the component
  // clamps defensively: errorH = min(totalH, (err/max)*VB_H) = min(10, 20).
  const el = Sparkline({ values: [2, 4], errors: [4, 0], ariaLabel: 'clamped' });
  const bars = bucketGroups(el).map(parseBar);
  near(bars[0].height, 10, 'v=2 against max 4');
  near(bars[0].err.height, 10, 'overshooting error clamps to the bar height');
  near(bars[0].err.y, bars[0].y, 'and shares the bar baseline');
});
test('errors prop omitted entirely -> plain muted bars, no crash', () => {
  const el = Sparkline({ values: [3], ariaLabel: '3 events in the last 24 hours' });
  const [bar] = bucketGroups(el).map(parseBar);
  near(bar.height, 20, 'single bucket is a full-height bar');
  near(bar.width, 100, 'single bucket spans the whole strip (no gap to leave)');
  assert.equal(bar.err, null);
  assert.equal(bar.className, 'fill-current opacity-60');
});

console.log(`\n✓ SPARKLINE TESTS PASS (${passed})`);
