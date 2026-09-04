// Tests for the terminal pane's right-click-on-a-token copy — WARDEN-1293.
//
// THE BUG: the terminal-surface context menu (PaneTile.tsx, WARDEN-380) always
// showed Copy as an ACTIVE item, and Copy copies the SELECTION. Right-clicking a
// highlighted URL (WARDEN-1256) or file path (WARDEN-227) creates no selection,
// so choosing Copy did nothing at all, silently — a menu that promises an action
// and skips it. Meanwhile the very same token opens fine on Ctrl/Cmd+click,
// because opening runs down a completely different path.
//
// THE FIX, in two halves, both pinned here:
//
//   1. A token-scoped item ("Copy Link Address" / "Copy File Path") appears when
//      the right-click landed on a highlighted token, and copies THAT token.
//   2. Plain Copy is DISABLED when there is no selection, so the item that would
//      do nothing can no longer be chosen at all.
//
// THE RUNTIME FACT THIS DESIGN RESTS ON (the ticket asked for it to be
// established on a running app, since it cannot be read out of the source):
// opening the Radix menu makes xterm fire the hovered link's `leave()`, which
// NULLS the hover state — before any menu item's onSelect can run. Instrumented
// on a live pane, right-clicking a link logs, in order:
//
//     contextmenu-time-hovered:https://example.com/foo
//     leave:https://example.com/foo
//     select-time-hovered:null
//
// So reading the hover ref from an item's onSelect reads `null` every time. The
// token MUST be latched in the contextmenu handler, which runs before the leave.
// The static guards at the end of this file are what keep that latch in place:
// a refactor that "simplifies" the menu items into reading hoveredTokenRef
// directly would restore the original bug and pass every behavioural test, so
// only a source-level guard can catch it (the dialogMaxWidth.test.mjs pattern,
// as used by paneCopy.test.mjs's own wiring section).
//
// HOW THIS LOADS THE REAL CODE: PaneTile.tsx can't be imported in Node (React,
// xterm, sonner, the @/ alias), so — exactly as paneCopy.test.mjs does for
// copySelectionToClipboard — the function TEXT is extracted from the live
// source and run through the OXC-transpile-to-temp-`.mjs` + dynamic import()
// harness, with `copyText` and `toast` bound to mock sinks. A rename or reshape
// that defeats the regex fails loudly here; the test can never assert against a
// stale copy of the function.
//
// Run: node paneTokenCopy.test.mjs   (or: npm test, from web/)
import { transformWithOxc } from 'vite';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const paneTilePath = resolve(__dirname, 'src/components/PaneTile.tsx');
const src = readFileSync(paneTilePath, 'utf8');

// --- Extract the REAL copyTokenToClipboard (TS -> ESM via OXC) --------------
// Module-level async function: starts at column 0 and ends at the first
// column-0 `}` (its body's braces are all indented).
const fnMatch = src.match(/^async function copyTokenToClipboard\([^)]*\)[^{]*\{[\s\S]*?^\}/m);
if (!fnMatch) {
  throw new Error('copyTokenToClipboard not found in PaneTile.tsx — moved or renamed? Update this test.');
}
const { code } = await transformWithOxc(fnMatch[0], paneTilePath, {});

// Bind the two imported names the extracted function closes over — `copyText`
// (from @/lib/clipboard) and `toast` (from sonner) — to global sinks the tests
// reset and read.
const tmpDir = mkdtempSync(join(tmpdir(), 'warden-panetoken-test-'));
const tmpFile = join(tmpDir, 'paneTokenCopyFn.mjs');
writeFileSync(tmpFile, `
const copyText = (t) => {
  globalThis.__tokenCopy.calls.push(t);
  return Promise.resolve(globalThis.__tokenCopy.result);
};
const toast = {
  error: (msg) => globalThis.__tokenCopy.toasts.error.push(msg),
  success: (msg) => globalThis.__tokenCopy.toasts.success.push(msg),
};
${code}
export { copyTokenToClipboard };
`);
const { copyTokenToClipboard } = await import(tmpFile);
rmSync(tmpDir, { recursive: true, force: true });

const reset = (result = true) => {
  globalThis.__tokenCopy = { calls: [], result, toasts: { error: [], success: [] } };
};
reset();

let passed = 0;
const test = async (name, fn) => { await fn(); passed += 1; console.log('  ok -', name); };

// ---------------------------------------------------------------------------
console.log('\nthe token reaches the clipboard verbatim');
// ---------------------------------------------------------------------------
await test('a URL is copied exactly as highlighted — no trimming, no re-encoding', async () => {
  reset();
  await copyTokenToClipboard('https://example.com/foo?a=1&b=2#frag', true);
  assert.deepEqual(globalThis.__tokenCopy.calls, ['https://example.com/foo?a=1&b=2#frag'],
    'the clipboard must receive the address itself, byte for byte');
});

await test('a file path is copied exactly as highlighted', async () => {
  reset();
  await copyTokenToClipboard('/workspace/warden/package.json', true);
  assert.deepEqual(globalThis.__tokenCopy.calls, ['/workspace/warden/package.json']);
});

await test('it routes through the SHARED helper (the Electron fallback comes with it)', async () => {
  // The whole point of calling copyText rather than re-inlining execCommand:
  // navigator.clipboard can fail silently in Electron, and the shared helper
  // already carries the textarea fallback for exactly that. Asserting the call
  // happened is asserting the fallback is in the path.
  reset();
  await copyTokenToClipboard('https://example.com/', true);
  assert.equal(globalThis.__tokenCopy.calls.length, 1, 'exactly one copy attempt, through the shared helper');
});

// ---------------------------------------------------------------------------
console.log('\nthe success flag is consulted (this surface\'s convention)');
// ---------------------------------------------------------------------------
await test('a failed copy raises an error toast — a silent failure is the bug we are fixing', async () => {
  reset(false);
  await copyTokenToClipboard('https://example.com/foo', true);
  assert.equal(globalThis.__tokenCopy.toasts.error.length, 1, 'a refused copy must tell the user');
  assert.ok(globalThis.__tokenCopy.toasts.error[0].length > 0, 'the toast carries a message');
});

await test('a successful copy is COMPLETELY silent — no success toast on this surface', async () => {
  // Deliberate divergence from copyWithToast (lib/clipboardToast.ts), which the
  // sidebar/FileViewer/search menus use and which DOES fire toast.success.
  // The terminal pane does not toast its happy path; routing here through
  // copyWithToast would have added noise the product does not want.
  reset(true);
  await copyTokenToClipboard('https://example.com/foo', true);
  assert.equal(globalThis.__tokenCopy.toasts.success.length, 0, 'no success toast in the pane');
  assert.equal(globalThis.__tokenCopy.toasts.error.length, 0);
});

await test('the failure toast is gated on the notifyErrors pref (WARDEN-400 convention)', async () => {
  reset(false);
  await copyTokenToClipboard('https://example.com/foo', false);
  assert.equal(globalThis.__tokenCopy.toasts.error.length, 0, 'pref off → silent');
  assert.equal(globalThis.__tokenCopy.calls.length, 1, 'but the copy was still attempted');
});

// ---------------------------------------------------------------------------
console.log('\nstatic wiring guard — the token is LATCHED at right-click, not read at select');
// ---------------------------------------------------------------------------
// These guard the one thing no behavioural test of the function can see: WHERE
// the token comes from. The runtime trace above proves that reading the hover
// ref from an onSelect yields null, so the latch is load-bearing.

await test('the contextmenu handler latches BOTH the token and the selection state', async () => {
  const handler = src.match(/onContextMenu=\{\(\) => \{[\s\S]*?\}\}/);
  assert.ok(handler, 'the terminal surface must carry an onContextMenu latch');
  assert.match(handler[0], /setMenuToken\(hoveredTokenRef\.current\)/,
    'the token under the cursor must be captured at right-click time');
  assert.match(handler[0], /setMenuHasSelection\(!!termRef\.current\?\.getSelection\(\)\)/,
    'whether Copy has anything to copy must be decided when the menu opens');
});

await test('the token menu item reads the LATCH, never the live hover ref', async () => {
  const item = src.match(/copyTokenToClipboard\([^)]*\)/g) || [];
  assert.ok(item.length >= 1, 'the token copy item must exist');
  assert.ok(
    item.some((c) => /copyTokenToClipboard\(menuToken\.text,\s*notifyErrorsRef\.current\)/.test(c)),
    'the item must copy menuToken.text (the latch) — reading hoveredTokenRef here is the original bug',
  );
  // The inverse, stated explicitly: no menu item may reach for the hover ref.
  const menuBody = src.slice(src.indexOf('<ContextMenuItem'), src.length);
  assert.ok(
    !/onSelect=\{[^}]*hoveredTokenRef/.test(menuBody),
    'no onSelect may read hoveredTokenRef — it is already nulled by the time onSelect runs',
  );
});

await test('Copy is disabled from the latch, and the token item is separated + kind-worded', async () => {
  assert.match(src, /<ContextMenuItem disabled=\{!menuHasSelection\}[\s\S]*?>Copy<\/ContextMenuItem>/,
    'Copy must be disabled when the latch says there is no selection');
  assert.match(src, /menuToken\.kind === 'url' \? 'Copy Link Address' : 'Copy File Path'/,
    'wording must follow the established vocabulary, per kind');
  // The token item is rendered only when a token was latched, and is followed
  // by a separator so it reads as a distinct group (the browser/terminal norm).
  const block = src.match(/\{menuToken && \(\s*<>[\s\S]*?<\/>\s*\)\}/);
  assert.ok(block, 'the token item must be conditional on a latched token');
  assert.match(block[0], /<ContextMenuSeparator \/>/,
    'token items are separated from the generic ones');
});

await test('the hover latch is set for URLs immediately, and for paths only once confirmed', async () => {
  // A URL is valid by construction (decorated at construction time), so it is
  // copyable the instant it is hoverable. A path candidate is only decorated
  // after its async existence probe confirms a real file — the menu must offer
  // a path only under that same condition, so it never claims a token the pane
  // did not highlight.
  assert.match(src, /hoveredTokenRef\.current = \{ text: u\.url, kind: 'url' \}/,
    'a hovered URL latches straight away');
  const pathHover = src.match(/hover\(event: MouseEvent\) \{\s*hoveredLinkRef\.current = c\.path;[\s\S]*?\n {12}\},/);
  assert.ok(pathHover, 'the path hover handler must still be found');
  assert.match(pathHover[0], /if \(ok && hoveredLinkRef\.current === c\.path\) \{[\s\S]*hoveredTokenRef\.current = \{ text: c\.path, kind: 'path' \}/,
    'a path latches only inside the confirmed-file + still-hovered guard');
});

await test('leaving a token clears the hover latch for BOTH kinds', async () => {
  const leaves = [...src.matchAll(/leave\(\) \{[\s\S]*?\},/g)].map((m) => m[0]);
  assert.equal(leaves.length, 2, 'one leave handler per link kind (url, path)');
  for (const l of leaves) {
    assert.match(l, /hoveredTokenRef\.current = null/,
      'every leave must clear the hover latch, or a stale token follows the cursor off the link');
  }
});

console.log(`\n${passed} passing\n`);
