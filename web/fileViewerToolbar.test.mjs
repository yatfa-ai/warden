// FileViewer header-toolbar collapse contract (WARDEN-1019).
//
// There is no front-end DOM test runner in this repo, so (like breadcrumbs.test.mjs
// and fileViewerChanges.test.mjs) this loads the REAL src/lib/fileViewerToolbar.ts
// (transpiled TS -> ESM via Vite's OXC transform) and drives the pure contract.
//
// WHY THIS FILE EXISTS: below `md` the FileViewer header cannot fit its toolbar —
// every control is `shrink-0`, so the toolbar's min-content width is a floor the
// row cannot go under and the buttons paint through DialogTitle's `pr-8` close-X
// reserve and out past the panel edge. Measured on `main` at 375px with a markdown
// file open: `Changes` starts at the panel's exact right edge and every hit-test
// point on it lands on the close X or the overlay, so aiming at Changes CLOSES the
// viewer. The fix collapses the low-priority controls into a `⋯` menu below `md`.
//
// The GEOMETRY of that fix is CSS (`hidden md:flex` / `md:hidden`) and is invisible
// to any test here — it is verified in a real browser, at real viewport widths, by
// hit-testing physical coordinates (the WARDEN-68 bar). What IS testable, and what
// a browser sweep would only catch by accident, is the collapse CONTRACT:
//
//   1. WHICH controls collapse — `Changes` must never be among them. It is the
//      control the destructive mis-hit was reported against; the whole point of
//      the fix is that it stays directly on the row at every viewport.
//   2. In WHAT ORDER, and that the two inline groups straddling `Changes`
//      (TOOLBAR_LEADING_KEYS / TOOLBAR_TRAILING_KEYS) partition that order exactly.
//      A future action added to neither group would silently vanish from the
//      desktop row while still appearing in the overflow menu — a regression that
//      only shows at >= md, i.e. nowhere near the viewport this ticket is about.
//   3. That each collapsed control reports its PRESSED STATE, so the menu can show
//      which toggles are on. A collapse that hid the state would be lossy: these
//      are toggles, not plain actions (success criterion 4).
//
// Run: node fileViewerToolbar.test.mjs   (or: npm test, from web/)
import { transformWithOxc } from 'vite';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const libPath = resolve(__dirname, 'src/lib/fileViewerToolbar.ts');

// --- Load the REAL fileViewerToolbar.ts (TS -> ESM via the OXC transform Vite bundles) ---
const src = readFileSync(libPath, 'utf8');
const { code } = await transformWithOxc(src, libPath, {});
const tmpDir = mkdtempSync(join(tmpdir(), 'warden-toolbar-test-'));
const tmpFile = join(tmpDir, 'fileViewerToolbar.mjs');
writeFileSync(tmpFile, code);
const { secondaryToolbarActions, TOOLBAR_LEADING_KEYS, TOOLBAR_TRAILING_KEYS } = await import(tmpFile);
rmSync(tmpDir, { recursive: true, force: true });

let passed = 0;
const test = (name, fn) => {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.error(`  FAIL  ${name}`);
    console.error(`        ${err.message}`);
    process.exitCode = 1;
  }
};

/** All-off, non-markdown baseline; override per case. */
const state = (over = {}) => ({
  isMarkdown: false,
  viewMode: 'rendered',
  history: false,
  annotate: false,
  follow: false,
  manualReloading: false,
  ...over,
});
const keys = (s) => secondaryToolbarActions(s).map((a) => a.key);
const byKey = (s, k) => secondaryToolbarActions(s).find((a) => a.key === k);

console.log('fileViewerToolbar (WARDEN-1019)');

// --- 1. Which controls collapse -------------------------------------------------

test('a plain file collapses the four always-present low-priority controls', () => {
  assert.deepEqual(keys(state()), ['history', 'annotate', 'reload', 'follow']);
});

test('a markdown file collapses a FIFTH control — the Rendered/Source toggle', () => {
  // The worst case, and the one the WARDEN-1006 measurement missed by being taken
  // on a non-md file: six controls on the row, not five.
  assert.deepEqual(keys(state({ isMarkdown: true })), ['viewmode', 'history', 'annotate', 'reload', 'follow']);
});

test('Changes never collapses — it stays on the row at every viewport', () => {
  for (const s of [state(), state({ isMarkdown: true }), state({ isMarkdown: true, history: true, annotate: true, follow: true })]) {
    assert.ok(!keys(s).includes('changes'), 'Changes must not be in the collapsible set');
  }
});

// --- 2. Order, and the two inline groups that straddle Changes ------------------

test('leading + trailing keys partition the collapsible set in order', () => {
  // The desktop row renders [leading] Changes [trailing]. If their concatenation
  // ever stops matching the descriptor order, a control is either duplicated,
  // reordered on desktop, or dropped from the row entirely while still living in
  // the menu — none of which a narrow-viewport check would see.
  const all = [...TOOLBAR_LEADING_KEYS, ...TOOLBAR_TRAILING_KEYS];
  assert.deepEqual(all, ['viewmode', 'history', 'annotate', 'reload', 'follow']);
  assert.deepEqual(keys(state({ isMarkdown: true })), all);
  // And with the markdown toggle absent, the remainder still partitions cleanly.
  const plain = keys(state());
  assert.deepEqual(
    [...TOOLBAR_LEADING_KEYS.filter((k) => plain.includes(k)), ...TOOLBAR_TRAILING_KEYS.filter((k) => plain.includes(k))],
    plain,
  );
});

test('every collapsible key belongs to exactly one inline group', () => {
  for (const k of keys(state({ isMarkdown: true }))) {
    const inLeading = TOOLBAR_LEADING_KEYS.includes(k);
    const inTrailing = TOOLBAR_TRAILING_KEYS.includes(k);
    assert.ok(inLeading !== inTrailing, `${k} must be in exactly one inline group`);
  }
});

// --- 3. Pressed state survives the collapse -------------------------------------

test('each toggle reports its own pressed state', () => {
  assert.equal(byKey(state({ history: true }), 'history').pressed, true);
  assert.equal(byKey(state({ history: false }), 'history').pressed, false);
  assert.equal(byKey(state({ annotate: true }), 'annotate').pressed, true);
  assert.equal(byKey(state({ follow: true }), 'follow').pressed, true);
  assert.equal(byKey(state({ isMarkdown: true, viewMode: 'rendered' }), 'viewmode').pressed, true);
  assert.equal(byKey(state({ isMarkdown: true, viewMode: 'source' }), 'viewmode').pressed, false);
});

test('one toggle being on does not flip its neighbours', () => {
  const actions = secondaryToolbarActions(state({ isMarkdown: true, annotate: true }));
  const on = actions.filter((a) => a.pressed === true).map((a) => a.key);
  assert.deepEqual(on, ['viewmode', 'annotate']); // viewMode defaults to 'rendered'
});

test('reload is a plain action (pressed null), NOT a toggle stuck off', () => {
  // The distinction is load-bearing for the menu: `pressed: null` is what
  // suppresses the ON/OFF pill, so a one-shot action never renders as "off".
  const r = byKey(state(), 'reload');
  assert.equal(r.pressed, null);
  assert.equal(r.busy, false);
  assert.equal(byKey(state({ manualReloading: true }), 'reload').busy, true);
  // Busy is NOT pressed — an in-flight reload must not read as an enabled view.
  assert.equal(byKey(state({ manualReloading: true }), 'reload').pressed, null);
});

test('every action carries a non-empty label and title for the menu row', () => {
  for (const a of secondaryToolbarActions(state({ isMarkdown: true }))) {
    assert.ok(a.label && a.label.trim().length > 0, `${a.key} needs a label`);
    assert.ok(a.title && a.title.trim().length > 0, `${a.key} needs a title`);
  }
});

test('toggle titles describe the action, flipping with state', () => {
  // The inline button's tooltip is the only place the toggle says what a click
  // will DO; the menu row reuses it verbatim, so it has to track state there too.
  assert.notEqual(byKey(state({ history: true }), 'history').title, byKey(state({ history: false }), 'history').title);
  assert.notEqual(byKey(state({ follow: true }), 'follow').title, byKey(state({ follow: false }), 'follow').title);
  assert.equal(byKey(state({ isMarkdown: true, viewMode: 'source' }), 'viewmode').label, 'Source');
  assert.equal(byKey(state({ isMarkdown: true, viewMode: 'rendered' }), 'viewmode').label, 'Rendered');
});

console.log(`\n${passed} passed`);
