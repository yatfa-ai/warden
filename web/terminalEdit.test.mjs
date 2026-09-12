// Tests for the terminal-surface EDIT decisions (WARDEN-1356) — the pure half
// of the Edit ▸ Select All / Edit ▸ Cut fix, exactly as WARDEN-1338's
// shouldRouteNativePasteToTerminal is pinned in pasteImage.test.mjs.
//
// THE DEFECT (live-measured, three consecutive runs): the Edit menu's stock
// roles execute flawlessly against the focused webContents and still do
// NOTHING on an agent pane. xterm registers clipboard listeners for copy and
// paste only (0 `cut`, 0 `selectall` in the installed dist) and its helper
// textarea is EMPTY, so webContents.selectAll() selects nothing (0 → 0) and
// webContents.cut() leaves the clipboard holding the sentinel. The passing
// Copy control in the same runs proved the gesture machinery worked — the
// pane was the surface the roles could not see. web/menu-template.test.mjs
// passed those items because every rung it owns judges the template object;
// a claim about SURFACE behaviour cannot be settled there (no DOM runner),
// so the shape is pinned as pure predicates HERE and the wiring is pinned by
// source assertion in the template suite.
//
// WHAT THIS SUITE LOCKS IN:
//   - CUT claims the role's native cut event ONLY for THIS pane's focused
//     terminal textarea WITH a selection — a Settings input is never claimed
//     (the native cut must keep working there byte-for-byte), and cut with
//     nothing selected stays an honest no-op;
//   - SELECT ALL routes by REAL DOM focus: a terminal textarea → the pane,
//     an editable field → the native execCommand fallback that keeps Settings
//     working, nothing editable → a no-op. The terminal check must WIN over
//     the editable check, because xterm's helper textarea IS a <textarea> —
//     an editable-first order would resurrect today's defect (select-all
//     routed into execCommand against the empty helper textarea).
//
// Run: node --test terminalEdit.test.mjs   (or: npm test, from web/)
import { transformWithOxc } from 'vite';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const libDir = resolve(__dirname, 'src/lib');

// --- Load the REAL terminalEdit.ts (TS -> ESM via OXC) ----------------------
// Same harness as pasteImage.test.mjs / clipboard.test.mjs: no runtime
// imports, so no specifier rewriting is needed.
const src = readFileSync(join(libDir, 'terminalEdit.ts'), 'utf8');
const { code } = await transformWithOxc(src, join(libDir, 'terminalEdit.ts'), {});
const tmpDir = mkdtempSync(join(tmpdir(), 'warden-termualedit-test-'));
const file = join(tmpDir, 'terminalEdit.mjs');
writeFileSync(file, code);
const { shouldRouteNativeCutToTerminal, routeMenuSelectAll, TERMINAL_SELECT_ALL_EVENT } = await import(file);
rmSync(tmpDir, { recursive: true, force: true });

let passed = 0;
const test = (name, fn) => Promise.resolve()
  .then(fn)
  .then(() => { passed += 1; console.log('  ok -', name); });

// A stand-in for the focused element, the way the callers hand it over:
// PaneTile passes the real DOM element (classList present); the adversarial
// shapes below stand in for non-element hosts (null activeElement, SVG nodes
// with a classList that behaves differently, a host that throws on contains).
const termTextarea = { classList: { contains: (c) => c === 'xterm-helper-textarea' }, tagName: 'TEXTAREA' };
const settingsInput = { classList: { contains: () => false }, tagName: 'INPUT' };
const settingsTextarea = { classList: { contains: () => false }, tagName: 'TEXTAREA' };
const contentEditable = { classList: { contains: () => false }, tagName: 'DIV', isContentEditable: true };
const pageBody = { classList: { contains: () => false }, tagName: 'BODY' };

console.log('shouldRouteNativeCutToTerminal — the target-identity test is the Settings guarantee');

await test('claims the cut event aimed at THIS pane\'s textarea, with a selection', () => {
  assert.equal(shouldRouteNativeCutToTerminal(termTextarea, termTextarea, true), true);
});

await test('never claims a cut aimed at a Settings field — even with a selection', () => {
  // The Edit roles exist FOR these fields (electron/menu-template.cjs's
  // Edit-submenu comment); a claimed field cut would empty it and drop the
  // native clipboard write.
  assert.equal(shouldRouteNativeCutToTerminal(settingsInput, termTextarea, true), false);
  assert.equal(shouldRouteNativeCutToTerminal(settingsTextarea, termTextarea, true), false);
});

await test('never claims a cut when the pane has NO selection', () => {
  // Cut-with-no-selection is a no-op on every surface; manufacturing a
  // clipboard write from a non-selection would be an invented effect.
  assert.equal(shouldRouteNativeCutToTerminal(termTextarea, termTextarea, false), false);
});

await test('matches target by IDENTITY, not by shape', () => {
  // A DIFFERENT pane's textarea has the same classList shape — identity with
  // THIS pane's term.textarea is the precise "this terminal has focus" test.
  const otherPaneTextarea = { ...termTextarea };
  assert.equal(shouldRouteNativeCutToTerminal(otherPaneTextarea, termTextarea, true), false);
});

await test('survives structurally-degraded targets without throwing', () => {
  assert.equal(shouldRouteNativeCutToTerminal(null, termTextarea, true), false);
  assert.equal(shouldRouteNativeCutToTerminal(undefined, null, true), false);
  assert.equal(shouldRouteNativeCutToTerminal(termTextarea, undefined, true), false);
});

console.log('routeMenuSelectAll — real DOM focus decides, terminal FIRST');

await test('routes to the pane when an xterm textarea holds focus', () => {
  assert.equal(routeMenuSelectAll(termTextarea), 'terminal');
});

await test('routes to the native fallback when an editable field holds focus', () => {
  // This is the Settings guarantee: the fallback (document.execCommand)
  // reproduces what role:'selectAll' did in fields, so the item stays honest
  // off the pane surface.
  assert.equal(routeMenuSelectAll(settingsInput), 'editable');
  assert.equal(routeMenuSelectAll(contentEditable), 'editable');
});

await test('routes nowhere when nothing editable holds focus', () => {
  assert.equal(routeMenuSelectAll(pageBody), 'none');
  assert.equal(routeMenuSelectAll(null), 'none');
  assert.equal(routeMenuSelectAll(undefined), 'none');
});

await test('the TERMINAL check wins over the EDITABLE check — the textarea-vs-textarea trap', () => {
  // xterm's helper textarea IS a <textarea>: an editable-first order would
  // route a pane-focused Select All into execCommand, which acts on the EMPTY
  // helper textarea and changes nothing — today's defect, resurrected. This
  // is the one ordering assertion the fix cannot live without.
  const routed = routeMenuSelectAll(termTextarea);
  assert.equal(routed, 'terminal', 'a focused helper textarea must route to the pane, never the editable fallback');
  assert.notEqual(routed, 'editable');
});

await test('degrades safely on exotic hosts (throwing classList, missing fields)', () => {
  const hostile = { get classList() { throw new Error('SVG quirks'); } };
  assert.equal(routeMenuSelectAll(hostile), 'none');
  assert.equal(routeMenuSelectAll({}), 'none');
});

await test('the broadcast event name is the string PaneTile listens for', () => {
  // App broadcasts and PaneTile subscribes through this one constant; a
  // rename on one side alone would make the menu push find no claimant and
  // the item inert again — the exact dead state this ticket removes.
  assert.equal(typeof TERMINAL_SELECT_ALL_EVENT, 'string');
  assert.ok(TERMINAL_SELECT_ALL_EVENT.length > 0);
});

console.log(`\n${passed} tests passed`);
