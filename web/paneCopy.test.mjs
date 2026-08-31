// Tests for the terminal pane's copy routine — copySelectionToClipboard in
// src/components/PaneTile.tsx (WARDEN-1244).
//
// THE BUG: the pane copied the xterm selection by issuing
// document.execCommand('copy') and DISCARDING the boolean. execCommand can
// refuse WITHOUT throwing — it returns false and writes nothing, so the
// previous clipboard contents survive (the exact case web/clipboard.test.mjs
// pins for the shared helper: "execCommand returns false → false"). A silent
// refusal read as success; the user selected text, believed it copied, and the
// next paste sent the OLD text into a live agent pane. All three entry points
// shared the flaw: copy-on-select, Ctrl/Cmd+C, and the context-menu Copy item.
//
// THE FIX, verified here:
//   - the execCommand result (false return OR throw) fires the pane's standard
//     error toast, gated on the notifyErrors pref (the WARDEN-400 convention
//     used by every other error toast in PaneTile) — error-only by design;
//   - success stays SILENT (no new noise on the happy path);
//   - an empty selection stays a no-op (de-select never clobbers/toasts).
//
// HOW THIS LOADS THE REAL CODE: PaneTile.tsx can't be imported in Node (React,
// xterm, sonner, the @/ alias), and this repo deliberately keeps the pane's
// copy implementation IN the component (WARDEN-1244 scopes it there; the
// shared src/lib/clipboard.ts helper is out of bounds and the pane doesn't
// call it). So this suite extracts the function TEXT from the live source —
// it can never test a stale copy; a rename or reshape that defeats the regex
// fails loudly here — then runs it through the same OXC-transpile-to-temp-
// `.mjs` + dynamic import() harness clipboard.test.mjs / paneAttach.test.mjs
// use, with `toast` bound to a mock sink and `document` swapped on globalThis
// between cases (copySelectionToClipboard reads both at call time).
//
// The final section is a STATIC wiring guard (the dialogMaxWidth.test.mjs
// pattern): the two mount-once call sites must read the pref through
// notifyErrorsRef — reading `prefs` directly there would capture the
// mount-time value, the stale-pref trap the ticket calls out, and no
// function-level test can see that.
//
// Run: node paneCopy.test.mjs   (or: npm test, from web/)
import { transformWithOxc } from 'vite';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const paneTilePath = resolve(__dirname, 'src/components/PaneTile.tsx');
const src = readFileSync(paneTilePath, 'utf8');

// --- Extract the REAL copySelectionToClipboard (TS -> ESM via OXC) -----------
// Module-level function: starts at column 0 with `function copySelectionTo…`
// and ends at the first column-0 `}` (its body's braces are all indented).
const fnMatch = src.match(/^function copySelectionToClipboard\([^)]*\)[^{]*\{[\s\S]*?^\}/m);
if (!fnMatch) {
  throw new Error('copySelectionToClipboard not found in PaneTile.tsx — moved or renamed? Update this test.');
}
const { code } = await transformWithOxc(fnMatch[0], paneTilePath, {});

// Bind `toast` (imported from 'sonner' in the real file) to a global sink the
// tests reset and read, so the extracted function closes over the mock.
const tmpDir = mkdtempSync(join(tmpdir(), 'warden-panecopy-test-'));
const tmpFile = join(tmpDir, 'paneCopyFn.mjs');
writeFileSync(tmpFile, `
const toast = {
  error: (msg) => globalThis.__paneCopyToasts.error.push(msg),
  success: (msg) => globalThis.__paneCopyToasts.success.push(msg),
};
${code}
export { copySelectionToClipboard };
`);
const { copySelectionToClipboard } = await import(tmpFile);
rmSync(tmpDir, { recursive: true, force: true });

// Node 21+ ships globalThis.document-adjacent globals as getter-only
// accessors where present, so defineProperty (not assignment) installs mocks
// cleanly — the same setGlobal helper clipboard.test.mjs uses.
const setGlobal = (name, value) =>
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
const realDocument = globalThis.document;
const restore = () => setGlobal('document', realDocument);

// A mock DOM mirroring the real fallback's element lifecycle
// (createElement → set value → append → select → execCommand → removeChild)
// and recording every step, so a refusal-path bug that leaks the textarea or
// skips the cleanup is visible, not just the toast.
function mockDoc({ execReturns = true, execThrows = false } = {}) {
  let taValue;
  let appended = 0, removed = 0, selected = false, execArg = null;
  const ta = {
    style: {},
    select() { selected = true; },
    set value(v) { taValue = v; },
    get value() { return taValue; },
  };
  return {
    document: {
      createElement: () => ta,
      body: {
        appendChild() { appended += 1; },
        removeChild() { removed += 1; },
      },
      execCommand: (cmd) => {
        execArg = cmd;
        if (execThrows) throw new Error('refused');
        return execReturns;
      },
    },
    state: () => ({ taValue, appended, removed, selected, execArg }),
  };
}

// xterm stub: the routine only needs getSelection().
const termWith = (selection) => ({ getSelection: () => selection });

const resetToasts = () => { globalThis.__paneCopyToasts = { error: [], success: [] }; };
resetToasts();

let passed = 0;
const test = (name, fn) => { resetToasts(); fn(); passed += 1; console.log('  ok -', name); };

// ---------------------------------------------------------------------------
console.log('\nrefusal is surfaced (the WARDEN-1244 fix)');
// ---------------------------------------------------------------------------
test('execCommand returns false → one error toast, nothing on success', () => {
  const m = mockDoc({ execReturns: false });
  setGlobal('document', m.document);
  copySelectionToClipboard(termWith('selected text'), true);
  assert.equal(globalThis.__paneCopyToasts.error.length, 1, 'a refused copy must tell the user');
  assert.ok(globalThis.__paneCopyToasts.error[0].length > 0, 'the toast carries a message');
  assert.equal(globalThis.__paneCopyToasts.success.length, 0);
  restore();
});

test('execCommand throws → also an error toast (a throw is a refusal too)', () => {
  const m = mockDoc({ execThrows: true });
  setGlobal('document', m.document);
  copySelectionToClipboard(termWith('selected text'), true);
  assert.equal(globalThis.__paneCopyToasts.error.length, 1);
  restore();
});

test('refusal with notifyErrors=false → silent (the pref gates the toast)', () => {
  const m = mockDoc({ execReturns: false });
  setGlobal('document', m.document);
  copySelectionToClipboard(termWith('selected text'), false);
  assert.equal(globalThis.__paneCopyToasts.error.length, 0);
  assert.equal(globalThis.__paneCopyToasts.success.length, 0);
  restore();
});

// ---------------------------------------------------------------------------
console.log('\nsuccess and no-op paths are unchanged (no new noise)');
// ---------------------------------------------------------------------------
test('execCommand returns true → completely silent', () => {
  const m = mockDoc();
  setGlobal('document', m.document);
  copySelectionToClipboard(termWith('selected text'), true);
  assert.equal(globalThis.__paneCopyToasts.error.length, 0);
  assert.equal(globalThis.__paneCopyToasts.success.length, 0);
  restore();
});

test('empty selection → no-op: execCommand never runs, no toast', () => {
  const m = mockDoc();
  setGlobal('document', m.document);
  copySelectionToClipboard(termWith(''), true);
  assert.equal(m.state().execArg, null, 'a cleared selection must not touch the clipboard');
  assert.equal(globalThis.__paneCopyToasts.error.length, 0);
  restore();
});

// ---------------------------------------------------------------------------
console.log('\ntextarea lifecycle survives the refusal branch');
// ---------------------------------------------------------------------------
test('refusal still cleans up: value set, appended once, removed once, exec copy', () => {
  const m = mockDoc({ execReturns: false });
  setGlobal('document', m.document);
  copySelectionToClipboard(termWith('selected text'), false);
  const s = m.state();
  assert.equal(s.taValue, 'selected text');
  assert.equal(s.execArg, 'copy');
  assert.equal(s.selected, true);
  assert.equal(s.appended, 1);
  assert.equal(s.removed, 1, 'the hidden textarea must be removed even when the copy refuses');
  restore();
});

// ---------------------------------------------------------------------------
console.log('\nstatic wiring guard — all three entry points, no stale pref');
// ---------------------------------------------------------------------------
// The function above proves the toast logic; this proves the WIRING: every
// copySelectionToClipboard call site passes the live pref, and the pref reaches
// the mount-once handlers through notifyErrorsRef (reading `prefs` directly
// inside the mount effect would freeze the mount-time value — the trap the
// ticket calls out; only a source guard can see it).
test('exactly three call sites, each passing notifyErrorsRef.current', () => {
  const calls = [...src.matchAll(/copySelectionToClipboard\(/g)];
  assert.equal(calls.length, 4, '1 definition + 3 call sites (copy-on-select, Ctrl/Cmd+C, menu)');
  const viaRef = [...src.matchAll(/copySelectionToClipboard\(\s*(?:term|termRef\.current)!?,\s*notifyErrorsRef\.current\s*\)/g)];
  assert.equal(viaRef.length, 3, 'every call site must pass the ref-read pref');
});

test('notifyErrorsRef mirrors prefs.notifyErrors during render (latest-value pattern)', () => {
  assert.match(src, /const notifyErrorsRef = useRef\(prefs\.notifyErrors\);\s*\n\s*notifyErrorsRef\.current = prefs\.notifyErrors;/);
});

console.log(`\n${passed} passing\n`);
