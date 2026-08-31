// Tests for the fan-out toast RENDER seam — showFanoutToast in
// src/lib/fanoutToast.tsx (WARDEN-935 collapsed five hand-copied renders into
// it; WARDEN-1220 pins it).
//
// WHY THIS FILE EXISTS: the producer half of the partial-failure report is
// guarded rigorously — fanout.test.mjs asserts the formatter's description is
// the FULL "\n"-joined per-agent list ("the list must not be truncated",
// fanout.test.mjs:380) — but the RENDER half had no coverage at all. Between
// the formatter and the screen sits exactly one load-bearing detail: sonner's
// default description element normalizes whitespace, so the multi-line list
// collapses into a single run-on line UNLESS it is rendered inside the
// `whitespace-pre-line` wrapper. Remove that wrapper (pass the description as
// a raw string) or drop/alter the class, and every partially-failed bulk
// kill / broadcast / key-send degrades silently — correct data, unreadable
// rendering, no test failure. This suite makes that regression loud.
//
// WHAT IS PINNED (a characterisation test of current, correct behaviour — if
// the test and the implementation disagree, the test is wrong):
//   1. An ERROR variant renders through toast.error with a description that
//      is a REAL React element: <span className="whitespace-pre-line"> — the
//      wrapper whose CSS is the only thing turning "\n" into line breaks.
//   2. The span's children are the formatter's string BYTE-IDENTICAL — the
//      render seam must not split, join, escape, or truncate the list.
//   3. A SUCCESS variant renders through toast.success with the title alone
//      (no description, no wrapper).
//   4. `enabled === false` renders NOTHING — the notification preference is
//      enforced inside the seam so no call site can forget it.
//
// HARNESS: the same OXC-transpile-to-temp-`.mjs` + dynamic `import()` pattern
// as fanout.test.mjs / kill.test.mjs, loading the REAL fanoutToast.tsx — with
// two specifier rewrites on the TRANSFORMED output, because this module (unlike
// fanout.ts) has runtime imports:
//   - "sonner" → a mock module in the temp dir whose `toast` records every
//     call, so the suite can assert WHAT was handed to the toaster without a
//     DOM (the established no-DOM component-level pattern; see clipboard.test.mjs
//     for the same mocked-boundary idea).
//   - "react/jsx-runtime" (INJECTED by the JSX transform) → the project's REAL
//     react in web/node_modules, so the wrapper the seam builds is a genuine
//     React element, checked with the real React.isValidElement.
//
// Run: node fanoutToast.test.mjs   (from web/)
import { transformWithOxc } from 'vite';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const libDir = resolve(__dirname, 'src/lib');
const webDir = __dirname;

// --- Load the REAL fanoutToast.tsx (TSX -> ESM via OXC) ----------------------
// Mock sonner: records every toast.success / toast.error call. The suite
// imports this same module to read (and reset) the call log between cases.
const sonnerMock = `
export const __calls = { success: [], error: [] };
export const toast = {
  success(...args) { __calls.success.push(args); },
  error(...args) { __calls.error.push(args); },
};
`;

const src = readFileSync(join(libDir, 'fanoutToast.tsx'), 'utf8');
const { code } = await transformWithOxc(src, join(libDir, 'fanoutToast.tsx'), {});
const tmpDir = mkdtempSync(join(tmpdir(), 'warden-fanouttoast-test-'));
const sonnerFile = join(tmpDir, 'sonner.mjs');
writeFileSync(sonnerFile, sonnerMock);

// Rewrite BOTH runtime specifiers on the transformed output: sonner → the
// mock above; react/jsx-runtime (injected by the automatic JSX transform) →
// the project's real react, so the wrapper is a real React element.
const jsxRuntime = join(webDir, 'node_modules', 'react', 'jsx-runtime.js');
const rewritten = code
  .replace(/from\s+['"]sonner['"]/, `from ${JSON.stringify(sonnerFile)}`)
  .replace(/from\s+['"]react\/jsx-runtime['"]/, `from ${JSON.stringify(jsxRuntime)}`);
const seamFile = join(tmpDir, 'fanoutToast.mjs');
writeFileSync(seamFile, rewritten);

const { showFanoutToast } = await import(seamFile);
const { __calls } = await import(sonnerFile);
const { default: React } = await import(join(webDir, 'node_modules', 'react', 'index.js'));
rmSync(tmpDir, { recursive: true, force: true });

let passed = 0;
const test = (name, fn) => {
  fn();
  passed += 1;
  console.log('  ok -', name);
};
const resetCalls = () => { __calls.success.length = 0; __calls.error.length = 0; };

// A partial-failure outcome exactly as formatFanoutToast emits it (the
// producer's own suite pins that construction; this seam only consumes it).
const partialFailure = {
  title: 'Stopped 2 of 3 agents — 1 failed',
  description: 'agent-b: host unreachable',
  variant: 'error',
};
// A longer all-failed list — the multi-agent shape the wrapper exists for.
const fiveFailed = {
  title: 'Failed to stop 5 of 5 agents',
  description: ['a: e1', 'b: e2', 'c: e3', 'd: e4', 'e: e5'].join('\n'),
  variant: 'error',
};
const allGood = { title: 'Stopped 3 agents', variant: 'success' };

// ---------------------------------------------------------------------------
console.log('\nerror variant — the whitespace-preserving wrapper');
// ---------------------------------------------------------------------------
test('partial failure renders its per-agent list inside a whitespace-pre-line span', () => {
  resetCalls();
  showFanoutToast(partialFailure, true);
  assert.equal(__calls.error.length, 1, 'exactly one toast.error');
  assert.equal(__calls.success.length, 0, 'a failure is never a success toast');
  const [title, opts] = __calls.error[0];
  assert.equal(title, partialFailure.title, 'the formatter title passes through');
  // THE pin. A raw-string description (wrapper removed) is not a React element
  // and fails here; a wrapper without whitespace-pre-line fails on className.
  assert.ok(React.isValidElement(opts.description), 'description is a React element, not a raw string that sonner would whitespace-collapse');
  assert.equal(opts.description.type, 'span');
  assert.equal(opts.description.props.className, 'whitespace-pre-line', 'the class that makes \\n render as line breaks');
});

test('a five-agent failure list reaches the span UNTRUNCATED and byte-identical — every newline separator intact', () => {
  // The render-side twin of the producer guard (fanout.test.mjs:380 pins the
  // formatter's list; this pins that the wrapper neither truncates it nor
  // mangles the separators that whitespace-pre-line turns into line breaks).
  resetCalls();
  showFanoutToast(fiveFailed, true);
  const [, opts] = __calls.error[0];
  const rendered = opts.description.props.children;
  assert.equal(rendered, fiveFailed.description, 'byte-identical — not re-split, joined, or escaped');
  assert.equal(rendered.split('\n').length, 5, 'every failed agent keeps its own rendered line');
});

// ---------------------------------------------------------------------------
console.log('\nsuccess variant');
// ---------------------------------------------------------------------------
test('all-succeeded renders toast.success with the title alone — no description, no wrapper', () => {
  resetCalls();
  showFanoutToast(allGood, true);
  assert.equal(__calls.success.length, 1, 'exactly one toast.success');
  assert.equal(__calls.error.length, 0);
  const [title, ...rest] = __calls.success[0];
  assert.equal(title, allGood.title);
  assert.equal(rest.length, 0, 'no options object — there is no list to wrap');
});

// ---------------------------------------------------------------------------
console.log('\nnotification preference');
// ---------------------------------------------------------------------------
test('enabled === false renders NOTHING for either variant (uniform suppression)', () => {
  resetCalls();
  showFanoutToast(partialFailure, false);
  showFanoutToast(allGood, false);
  assert.equal(__calls.error.length, 0);
  assert.equal(__calls.success.length, 0);
});

console.log(`\n✓ FANOUT TOAST TESTS PASS (${passed})`);
