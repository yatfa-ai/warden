// Tests for the DOM arm of Settings row-search: web/src/components/settings/
// rowHighlight.ts (WARDEN-1290).
//
// sectionSearch.test.mjs covers the PURE half — which rows a query matches and
// which anchor ids they carry. This file covers the half that actually TOUCHES
// THE DOM, and it exists because that half carries two invariants nothing else
// can guard, both of which fail SILENTLY when broken:
//
//  1. HIDDEN SECTIONS MUST NOT BE TOUCHED. SettingsPage keeps EVERY section
//     mounted and toggles visibility with the `hidden` class (so a half-typed
//     draft survives a section switch). Ids are document-global, so dropping
//     the visibility gate makes getElementById find a row in a section nobody
//     can see — and the caller then scrolls the pane to an invisible element,
//     which reads as "search jumped somewhere random". A browser probe cannot
//     catch the regression reliably: it only shows up when a matching id
//     happens to exist in more than one section at once.
//
//  2. A MISSING ANCHOR IS NORMAL, NOT AN ERROR. Backend-config sections do not
//     render their rows until the /api/config GET resolves, and a conditional
//     row (the custom-font input, the webhook fields) is absent whenever its
//     branch is off. Searching in that window must do NOTHING — not throw, not
//     half-apply. The failure mode of getting this wrong is an exception inside
//     a render effect, i.e. a blank Settings page.
//
// Both are asserted here against a hand-rolled DOM stub rather than a real
// browser, matching theme.test.mjs's approach: the module touches exactly five
// DOM affordances (getElementById, querySelectorAll, classList, parentElement,
// closest), so a stub is both sufficient and honest about what is being tested.
//
// Run: node rowHighlight.test.mjs   (or: npm test, from web/)
import { transformWithOxc } from 'vite';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const modulePath = resolve(__dirname, 'src/components/settings/rowHighlight.ts');

const tmpDir = mkdtempSync(join(tmpdir(), 'warden-row-highlight-test-'));
const { code } = await transformWithOxc(readFileSync(modulePath, 'utf8'), modulePath, {});
const tmpFile = join(tmpDir, 'rowHighlight.mjs');
writeFileSync(tmpFile, code);
const { ROW_MATCH_CLASS, rowContainerFor, clearRowMatchHighlights, applyRowMatchHighlights } =
  await import(tmpFile);
rmSync(tmpDir, { recursive: true, force: true });

// --- Minimal DOM stub --------------------------------------------------------
// Only what rowHighlight touches. `classList` is a real Set behind the same
// three methods, so "did this element end up highlighted" is a direct read.

class El {
  constructor(tagName, { id = null, classes = [] } = {}) {
    this.tagName = tagName.toUpperCase();
    this.id = id;
    this.parentElement = null;
    this.children = [];
    const set = new Set(classes);
    this.classList = {
      add: (c) => set.add(c),
      remove: (c) => set.delete(c),
      contains: (c) => set.has(c),
      _set: set,
    };
  }

  append(...kids) {
    for (const k of kids) {
      k.parentElement = this;
      this.children.push(k);
    }
    return this;
  }

  /** Nearest ancestor (self included) matching a bare tag selector. */
  closest(selector) {
    const want = selector.toUpperCase();
    let node = this;
    while (node) {
      if (node.tagName === want) return node;
      node = node.parentElement;
    }
    return null;
  }

  get highlighted() {
    return this.classList.contains(ROW_MATCH_CLASS);
  }

  *walk() {
    yield this;
    for (const k of this.children) yield* k.walk();
  }
}

/** A stand-in for `document`, rooted at a tree of El nodes. */
function makeDocument(root) {
  return {
    root,
    getElementById(id) {
      for (const node of root.walk()) if (node.id === id) return node;
      return null;
    },
    querySelectorAll(selector) {
      // Only `.<class>` is used by the module under test.
      const cls = selector.replace(/^\./, '');
      return [...root.walk()].filter((n) => n.classList.contains(cls));
    },
  };
}

/**
 * The shape SettingsPage actually renders: one <section> per settings section,
 * inactive ones carrying `hidden`, each holding rows of
 * `<div class="flex …"><control id="…"/></div>`.
 */
function buildPage(sections) {
  const root = new El('div');
  const byId = new Map();
  for (const { name, hidden, rows } of sections) {
    const section = new El('section', { classes: hidden ? ['hidden'] : [] });
    section.name = name;
    for (const rowId of rows) {
      const container = new El('div', { classes: ['flex', 'flex-col', 'gap-2'] });
      const control = new El('input', { id: rowId });
      container.append(control);
      section.append(container);
      byId.set(rowId, { control, container });
    }
    root.append(section);
  }
  return { doc: makeDocument(root), byId };
}

// --- rowContainerFor ---------------------------------------------------------

test('rowContainerFor highlights the row container, not the bare control', () => {
  // A 24px Switch lit up on its own reads as a rendering artifact; the row
  // (label + control + hint) is what "this is your setting" means.
  const container = new El('div', { classes: ['flex', 'items-center'] });
  const control = new El('input', { id: 'closeToTray' });
  container.append(control);
  new El('section').append(container);
  assert.equal(rowContainerFor(control), container);
});

test('rowContainerFor never escalates to the whole section', () => {
  // A control that is a DIRECT child of the <section> has no row wrapper.
  // Highlighting its parent would tint the entire section — worse than
  // highlighting nothing, since it points at everything.
  const section = new El('section');
  const control = new El('input', { id: 'orphan' });
  section.append(control);
  assert.equal(rowContainerFor(control), control);
});

test('rowContainerFor tolerates a detached element', () => {
  const orphan = new El('input', { id: 'detached' });
  assert.equal(rowContainerFor(orphan), orphan);
});

// --- Invariant 1: hidden sections are never touched --------------------------

test('a row in a hidden section is never highlighted (all sections stay mounted)', () => {
  const { doc, byId } = buildPage([
    { name: 'appearance', hidden: false, rows: ['closeToTray'] },
    { name: 'notifications', hidden: true, rows: ['webhookSecret'] },
  ]);
  const first = applyRowMatchHighlights(['webhookSecret', 'closeToTray'], doc);
  assert.equal(byId.get('webhookSecret').container.highlighted, false);
  assert.equal(byId.get('closeToTray').container.highlighted, true);
  // …and the hidden row is not the scroll target either, even though it was
  // listed FIRST: scrolling the pane to an invisible element is the visible
  // symptom of this invariant breaking.
  assert.equal(first, byId.get('closeToTray').container);
});

test('every anchor hidden → nothing highlighted and no scroll target', () => {
  const { doc, byId } = buildPage([
    { name: 'appearance', hidden: false, rows: ['closeToTray'] },
    { name: 'hosts', hidden: true, rows: ['pollIntervalMs', 'tmuxSession'] },
  ]);
  assert.equal(applyRowMatchHighlights(['pollIntervalMs', 'tmuxSession'], doc), null);
  for (const [, { container }] of byId) assert.equal(container.highlighted, false);
});

// --- Invariant 2: a missing anchor is normal ---------------------------------

test('an anchor whose row has not rendered is skipped silently', () => {
  // The backend-config sections render no rows until GET /api/config resolves.
  const { doc, byId } = buildPage([{ name: 'appearance', hidden: false, rows: ['closeToTray'] }]);
  const first = applyRowMatchHighlights(['pollIntervalMs', 'closeToTray'], doc);
  assert.equal(first, byId.get('closeToTray').container);
  assert.equal(byId.get('closeToTray').container.highlighted, true);
});

test('no anchor resolves → returns null without throwing', () => {
  const { doc } = buildPage([{ name: 'appearance', hidden: false, rows: ['closeToTray'] }]);
  assert.equal(applyRowMatchHighlights(['webhookUrl', 'telemetryEndpoint'], doc), null);
});

test('an empty anchor list clears and returns null', () => {
  const { doc } = buildPage([{ name: 'appearance', hidden: false, rows: ['closeToTray'] }]);
  assert.equal(applyRowMatchHighlights([], doc), null);
});

// --- Clearing ----------------------------------------------------------------

test('clearing removes every highlight in the document', () => {
  // Criterion 3: clearing the query restores byte-today behavior — including
  // in sections the user has since switched away from.
  const { doc, byId } = buildPage([
    { name: 'appearance', hidden: false, rows: ['closeToTray', 'density'] },
    { name: 'hosts', hidden: true, rows: ['pollIntervalMs'] },
  ]);
  applyRowMatchHighlights(['closeToTray', 'density'], doc);
  byId.get('pollIntervalMs').container.classList.add(ROW_MATCH_CLASS); // a stale one
  clearRowMatchHighlights(doc);
  for (const [, { container }] of byId) assert.equal(container.highlighted, false);
});

test('applying is idempotent — a new query never leaves the old one lit', () => {
  // The effect re-runs on every keystroke; without the internal clear, typing
  // `t` then `tray` would leave every `t` row highlighted forever.
  const { doc, byId } = buildPage([
    { name: 'appearance', hidden: false, rows: ['terminalFontSize', 'density', 'closeToTray'] },
  ]);
  applyRowMatchHighlights(['terminalFontSize', 'density'], doc);
  applyRowMatchHighlights(['closeToTray'], doc);
  assert.deepEqual(
    [...doc.querySelectorAll(`.${ROW_MATCH_CLASS}`)],
    [byId.get('closeToTray').container],
  );
});

test('re-applying the same anchors twice is stable', () => {
  const { doc, byId } = buildPage([{ name: 'appearance', hidden: false, rows: ['closeToTray'] }]);
  const a = applyRowMatchHighlights(['closeToTray'], doc);
  const b = applyRowMatchHighlights(['closeToTray'], doc);
  assert.equal(a, b);
  assert.equal(doc.querySelectorAll(`.${ROW_MATCH_CLASS}`).length, 1);
  assert.equal(byId.get('closeToTray').container.highlighted, true);
});

// --- Ordering ----------------------------------------------------------------

test('the scroll target is the FIRST resolvable anchor, in the order given', () => {
  // sectionSearch returns anchors in declared (= visual) order, so "first" must
  // mean topmost — landing the user on the last matching row instead of the
  // first is the difference between "found it" and "scan upward yourself".
  const { doc, byId } = buildPage([
    {
      name: 'appearance',
      hidden: false,
      rows: ['terminalFontSize', 'terminalFontFamily', 'terminalScrollback'],
    },
  ]);
  const first = applyRowMatchHighlights(
    ['terminalFontSize', 'terminalFontFamily', 'terminalScrollback'],
    doc,
  );
  assert.equal(first, byId.get('terminalFontSize').container);
  // All three are still highlighted — only the SCROLL is singular.
  assert.equal(doc.querySelectorAll(`.${ROW_MATCH_CLASS}`).length, 3);
});

test('two anchors sharing one row container highlight it once', () => {
  // A group heading legitimately borrows the anchor of the first row it heads,
  // and two corpus rows can point at controls inside one container.
  const root = new El('div');
  const section = new El('section');
  const container = new El('div', { classes: ['flex', 'flex-col'] });
  const a = new El('input', { id: 'newPresetName' });
  const b = new El('input', { id: 'newPresetCmd' });
  container.append(a, b);
  section.append(container);
  root.append(section);
  const doc = makeDocument(root);
  const first = applyRowMatchHighlights(['newPresetName', 'newPresetCmd'], doc);
  assert.equal(first, container);
  assert.deepEqual([...doc.querySelectorAll(`.${ROW_MATCH_CLASS}`)], [container]);
});
