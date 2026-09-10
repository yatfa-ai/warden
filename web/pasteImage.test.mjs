// Tests for the clipboard-IMAGE paste path — src/lib/pasteImage.ts and the
// PaneTile.tsx wiring that calls it (WARDEN-1282).
//
// THE DEFECT: pasting into an agent pane read TEXT only. `navigator.clipboard
// .readText()` on an image-only clipboard resolves to `''`, and the `if (t)`
// guard dropped it in SILENCE — copying a screenshot and pasting it did nothing
// at all. Both entry branches were text-only, including the Electron
// execCommand fallback.
//
// WARDEN-1338 EXTENSION: the app menu's Edit ▸ Paste is the THIRD paste entry
// point and the only one that never reached pasteIntoTerm — `{ role: 'paste' }`
// is executed by Electron as webContents.paste(), which never consults the DOM
// handlers. On an image clipboard it died in TOTAL silence. The fix claims the
// role's native paste event in the CAPTURE phase (the only phase that sees it —
// xterm's own paste listener stops propagation) when the event targets the
// pane's terminal textarea AND the payload carries files, then routes into the
// same pasteIntoTerm.
//
// WHAT THIS SUITE LOCKS IN:
//   - IMAGE WINS on an image+text clipboard (one deterministic rule);
//   - a TEXT-ONLY clipboard never reaches this module — so the WARDEN-254
//     bracketed-paste contract is untouched, not merely preserved;
//   - the three-context degradation (Electron / browser / smoke): every host
//     that cannot read an image resolves null and the caller falls through to
//     the unchanged text path, and NOTHING here ever rejects;
//   - NO MARKER WITHOUT A FILE — a failed delivery returns an error and no
//     marker, because pasting one would point the agent at a file that is not
//     there (worse than the silence being fixed);
//   - the WARDEN-1338 routing decision: a native paste event is claimed only
//     for THIS pane's focused terminal textarea carrying files — Settings
//     inputs and text-only pastes are never claimed (the menu roles must keep
//     pasting natively outside the terminal);
//   - ALL THREE paste entry points (Ctrl/Cmd+V, themed menu item, Edit ▸
//     Paste capture wiring) go through the image-aware routine;
//   - the request is a RAW body with the id on the query string (the server's
//     global 1mb express.json limit is untouchable, and base64 in JSON would
//     inflate a screenshot ~33% past a limit it already exceeds).
//
// The final section is a STATIC wiring guard over PaneTile.tsx (the
// dialogMaxWidth.test.mjs / paneCopy.test.mjs pattern): the component cannot be
// imported in Node (React, xterm, sonner, the @/ alias), and no function-level
// test can see whether BOTH paste entry points were actually rewired. Reading
// the source is the only way to prove the menu item and the Ctrl/Cmd+V binding
// both go through the image-aware routine.
//
// Run: node pasteImage.test.mjs   (or: npm test, from web/)
import { transformWithOxc } from 'vite';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const libDir = resolve(__dirname, 'src/lib');
const paneTilePath = resolve(__dirname, 'src/components/PaneTile.tsx');

// --- Load the REAL pasteImage.ts (TS -> ESM via OXC) ------------------------
// No runtime imports, so no specifier rewriting is needed — same harness as
// clipboard.test.mjs / keysend.test.mjs.
const src = readFileSync(join(libDir, 'pasteImage.ts'), 'utf8');
const { code } = await transformWithOxc(src, join(libDir, 'pasteImage.ts'), {});
const tmpDir = mkdtempSync(join(tmpdir(), 'warden-pasteimage-test-'));
const file = join(tmpDir, 'pasteImage.mjs');
writeFileSync(file, code);
const { readClipboardImage, deliverImagePaste, shouldRouteNativePasteToTerminal } = await import(file);
rmSync(tmpDir, { recursive: true, force: true });

let passed = 0;
const test = (name, fn) => Promise.resolve()
  .then(fn)
  .then(() => { passed += 1; console.log('  ok -', name); });

// A stand-in for a ClipboardItem: the two members readClipboardImage touches.
const item = (types, get = async (t) => ({ size: 10, type: t })) => ({ types, getType: get });
const navWith = (items) => ({ clipboard: { read: async () => items, readText: async () => '' } });

console.log('readClipboardImage — IMAGE WINS, and every failure degrades to text');

await test('reads an image-only clipboard', async () => {
  const blob = { size: 1234, type: 'image/png' };
  const got = await readClipboardImage(navWith([item(['image/png'], async () => blob)]));
  assert.equal(got, blob);
});

await test('IMAGE WINS over text on a mixed clipboard', async () => {
  // The deterministic rule: an image+text clipboard is overwhelmingly a
  // screenshot tool that also wrote a caption or a path, and the image is the
  // part the owner cannot retype. Never a prompt, never a size heuristic.
  const blob = { size: 99, type: 'image/png' };
  const got = await readClipboardImage(navWith([
    item(['text/plain', 'image/png'], async (t) => (t === 'image/png' ? blob : 'caption')),
  ]));
  assert.equal(got, blob);
});

await test('a TEXT-ONLY clipboard yields null — the text path is untouched', async () => {
  // The WARDEN-254 guarantee: text paste never even enters this module.
  assert.equal(await readClipboardImage(navWith([item(['text/plain'])])), null);
});

await test('an empty clipboard yields null', async () => {
  assert.equal(await readClipboardImage(navWith([])), null);
});

await test('scans PAST a text-only item to an image on a later one', async () => {
  const blob = { size: 5, type: 'image/jpeg' };
  const got = await readClipboardImage(navWith([
    item(['text/plain']),
    item(['image/jpeg'], async () => blob),
  ]));
  assert.equal(got, blob);
});

await test('a zero-byte image blob is refused (nothing to deliver)', async () => {
  const got = await readClipboardImage(navWith([item(['image/png'], async () => ({ size: 0 }))]));
  assert.equal(got, null);
});

await test('keeps looking when an advertised flavour cannot be materialized', async () => {
  const blob = { size: 7, type: 'image/gif' };
  const got = await readClipboardImage(navWith([
    item(['image/png'], async () => { throw new Error('unavailable'); }),
    item(['image/gif'], async () => blob),
  ]));
  assert.equal(got, blob);
});

// --- the three-context degradation ------------------------------------------

await test('smoke context (no navigator at all) → null, never a throw', async () => {
  assert.equal(await readClipboardImage(undefined), null);
});

await test('no navigator.clipboard → null', async () => {
  assert.equal(await readClipboardImage({}), null);
});

await test('a host with readText but NO read() → null (feature-detect the METHOD)', async () => {
  // `read` is strictly newer than `readText`, so a host can have one without
  // the other. Detecting the `clipboard` object alone would throw here.
  assert.equal(await readClipboardImage({ clipboard: { readText: async () => 'hi' } }), null);
});

await test('a permission refusal → null, so the paste falls through to text', async () => {
  const nav = { clipboard: { read: async () => { throw new Error('NotAllowedError'); } } };
  assert.equal(await readClipboardImage(nav), null);
});

await test('a clipboard.read() resolving undefined → null, not a crash', async () => {
  assert.equal(await readClipboardImage({ clipboard: { read: async () => undefined } }), null);
});

console.log('deliverImagePaste — raw body, and NO MARKER WITHOUT A FILE');

const blob = { size: 3, type: 'image/png' };

await test('POSTs the RAW blob with the id on the query string', async () => {
  // Not base64-in-JSON: the server's GLOBAL express.json limit is 1mb and must
  // never be raised, and base64 would inflate a screenshot ~33% past a limit it
  // already exceeds. The body is the picture, so the id cannot ride in it.
  let seen;
  await deliverImagePaste('(local):agent', blob, async (url, init) => {
    seen = { url, init };
    return { ok: true, status: 200, json: async () => ({ ok: true, marker: '[m]', path: '/p' }) };
  });
  assert.equal(seen.url, '/api/paste-image?id=(local)%3Aagent');
  assert.equal(seen.init.method, 'POST');
  assert.equal(seen.init.body, blob);          // the Blob ITSELF, not a string
  assert.equal(seen.init.headers['content-type'], 'image/png');
});

await test('a typeless blob still declares a content-type', async () => {
  let seen;
  await deliverImagePaste('id', { size: 1, type: '' }, async (_u, init) => {
    seen = init;
    return { ok: true, status: 200, json: async () => ({ marker: '[m]' }) };
  });
  assert.equal(seen.headers['content-type'], 'application/octet-stream');
});

await test('success returns the server marker verbatim', async () => {
  const r = await deliverImagePaste('id', blob, async () => ({
    ok: true, status: 200,
    json: async () => ({ ok: true, marker: '[pasted image → /tmp/warden/paste/p.png (PNG 8×8)]', path: '/tmp/warden/paste/p.png' }),
  }));
  assert.deepEqual(r, {
    ok: true,
    marker: '[pasted image → /tmp/warden/paste/p.png (PNG 8×8)]',
    path: '/tmp/warden/paste/p.png',
  });
});

await test('an HTTP error returns the SERVER\u2019s reason and NO marker', async () => {
  const r = await deliverImagePaste('id', blob, async () => ({
    ok: false, status: 500, json: async () => ({ error: 'docker: no such container' }),
  }));
  assert.equal(r.ok, false);
  assert.equal(r.marker, undefined);
  assert.match(r.error, /no such container/);
});

await test('an HTTP error with an unreadable body still reports the status', async () => {
  const r = await deliverImagePaste('id', blob, async () => ({
    ok: false, status: 413, json: async () => { throw new Error('not json'); },
  }));
  assert.equal(r.ok, false);
  assert.equal(r.marker, undefined);
  assert.match(r.error, /413/);
});

await test('a network failure resolves as a result — it never rejects', async () => {
  // One shape to branch on, matching lib/api.ts's ApiResult contract.
  const r = await deliverImagePaste('id', blob, async () => { throw new Error('Failed to fetch'); });
  assert.equal(r.ok, false);
  assert.equal(r.marker, undefined);
  assert.match(r.error, /Failed to fetch/);
});

await test('a 2xx carrying NO marker is refused, not pasted as undefined', async () => {
  // A contract violation must not put the string "undefined" into a live agent
  // pane. This is the same class of bug as WARDEN-1244's discarded boolean.
  const r = await deliverImagePaste('id', blob, async () => ({
    ok: true, status: 200, json: async () => ({ ok: true, path: '/p' }),
  }));
  assert.equal(r.ok, false);
  assert.equal(r.marker, undefined);
});

console.log('shouldRouteNativePasteToTerminal — the WARDEN-1338 claim conditions');

// Fake DataTransfer / FileList stand-ins: the helper only reads .files.length.
const clipData = (n) => ({ files: Array.from({ length: n }, (_, i) => ({ name: `f${i}.png` })) });
const TERM_TA = { tagName: 'TEXTAREA' };   // stands in for term.textarea
const SETTINGS_INPUT = { tagName: 'INPUT' }; // a Settings field's focused element

await test('claims a paste event that targets the terminal textarea carrying files', async () => {
  // The Edit ▸ Paste role path: image clipboard, pane focused. THIS is the
  // claim that makes the third entry point deliver images.
  assert.equal(shouldRouteNativePasteToTerminal(TERM_TA, TERM_TA, clipData(1)), true);
});

await test('claims a multi-file payload (a FileList has a length, not a fixed shape)', async () => {
  assert.equal(shouldRouteNativePasteToTerminal(TERM_TA, TERM_TA, clipData(3)), true);
});

await test('NEVER claims when the target is another element — Settings stays native', async () => {
  // A paste into a Settings input targets THAT input. The Edit roles exist
  // for exactly those fields (menu-template.cjs's constraint comment), so the
  // capture wiring must not take the event — this assertion is the mutation
  // check for "no regression in Settings".
  assert.equal(shouldRouteNativePasteToTerminal(SETTINGS_INPUT, TERM_TA, clipData(1)), false);
  assert.equal(shouldRouteNativePasteToTerminal(null, TERM_TA, clipData(1)), false);
});

await test('NEVER claims a TEXT-ONLY paste — the native xterm path stays byte-for-byte', async () => {
  // files.length === 0 is the text clipboard shape (verified live:
  // types=['text/plain'], files=0). Leaving it unclaimed is what preserves
  // the WARDEN-254 bracketed-paste contract on the role path.
  assert.equal(shouldRouteNativePasteToTerminal(TERM_TA, TERM_TA, clipData(0)), false);
  assert.equal(shouldRouteNativePasteToTerminal(TERM_TA, TERM_TA, { files: null }), false);
  assert.equal(shouldRouteNativePasteToTerminal(TERM_TA, TERM_TA, null), false);
  assert.equal(shouldRouteNativePasteToTerminal(TERM_TA, TERM_TA, undefined), false);
  assert.equal(shouldRouteNativePasteToTerminal(TERM_TA, TERM_TA, {}), false);
});

await test('NEVER claims when the pane has no terminal (disposed / not yet open)', async () => {
  assert.equal(shouldRouteNativePasteToTerminal(TERM_TA, null, clipData(1)), false);
  assert.equal(shouldRouteNativePasteToTerminal(TERM_TA, undefined, clipData(1)), false);
});

// --- STATIC wiring guard over PaneTile.tsx ----------------------------------
// The component can't be imported in Node, and these are exactly the facts no
// function-level test can see.
console.log('PaneTile wiring — BOTH entry points, and no image bytes in the pty');

const pane = readFileSync(paneTilePath, 'utf8');

await test('pasteIntoTerm tries the IMAGE before either text read', async () => {
  const fn = pane.match(/^async function pasteIntoTerm\([\s\S]*?^\}/m);
  assert.ok(fn, 'pasteIntoTerm not found in PaneTile.tsx — moved or renamed? Update this test.');
  const body = fn[0];
  const imageAt = body.indexOf('readClipboardImage');
  const textAt = body.indexOf('readText');
  assert.ok(imageAt > 0, 'the image branch is missing');
  assert.ok(textAt > imageAt, 'the text read must come AFTER the image attempt');
});

await test('the image branch RETURNS before the text path — never both', async () => {
  // An image paste that also pasted the clipboard's text flavour would put a
  // caption into the pane behind the marker.
  const fn = pane.match(/^async function pasteIntoTerm\([\s\S]*?^\}/m)[0];
  const branch = fn.slice(fn.indexOf('if (image)'), fn.indexOf('readText'));
  assert.ok(/\breturn;/.test(branch), 'the image branch falls through to the text path');
});

await test('a delivery failure toasts and pastes NOTHING', async () => {
  const fn = pane.match(/^async function pasteIntoTerm\([\s\S]*?^\}/m)[0];
  const fail = fn.slice(fn.indexOf('if (!res.ok)'), fn.indexOf('term.paste(res.marker'));
  assert.ok(/toast\.error/.test(fail), 'no error toast on a failed delivery');
  assert.ok(!/term\.paste/.test(fail), 'a marker is pasted on the FAILURE leg');
  // Gated on the pref, the WARDEN-400 convention every other toast here uses.
  assert.ok(/notifyErrors/.test(fail));
});

await test('ONLY the marker is pasted — the blob never reaches term.paste', async () => {
  // Acceptance criterion 6, made grep-able: image bytes never cross the pty.
  const fn = pane.match(/^async function pasteIntoTerm\([\s\S]*?^\}/m)[0];
  const pastes = [...fn.matchAll(/term\.paste\(([^)]*)\)/g)].map((m) => m[1]);
  assert.deepEqual(pastes.sort(), ['res.marker!', 't', 'ta.value']);
  assert.ok(!/term\.paste\(\s*(image|blob)/.test(fn));
});

await test('ALL THREE entry points call the image-aware routine', async () => {
  // The Ctrl/Cmd+V binding (WARDEN-254), the themed Paste menu item
  // (WARDEN-380), and the Edit ▸ Paste capture wiring (WARDEN-1338 — the
  // application menu's role:'paste' never reached this routine at all).
  // Wiring only some of them leaves the other gestures text-only / silent —
  // the exact asymmetry each successive slice fixed.
  // `void ` prefixed — which excludes the declaration itself (`async function
  // pasteIntoTerm(term: Terminal, …)`), whose signature would otherwise match.
  const calls = [...pane.matchAll(/void pasteIntoTerm\((term|termRef\.current!)[^)]*\)/g)].map((m) => m[0]);
  assert.equal(calls.length, 3, `expected 3 call sites, found ${calls.length}`);
  for (const c of calls) {
    assert.ok(/,\s*id\s*,/.test(c), `call site does not pass the pane id: ${c}`);
    assert.ok(/notifyErrorsRef\.current/.test(c), `call site does not pass the pref: ${c}`);
  }
});

await test('the pref is read through notifyErrorsRef, never captured at mount', async () => {
  // Reading `prefs.notifyErrors` at a mount-once call site captures the
  // mount-time value — the stale-pref trap WARDEN-1244 pinned for copy.
  const key = pane.match(/if \(e\.code === 'KeyV'\) \{[\s\S]*?\n      \}/);
  assert.ok(key, 'the Ctrl/Cmd+V handler was not found');
  assert.ok(/notifyErrorsRef\.current/.test(key[0]));
  assert.ok(!/prefs\.notifyErrors/.test(key[0]));
});

// --- WARDEN-1338: the Edit ▸ Paste capture wiring ----------------------------
// The application menu's { role: 'paste' } never reached pasteIntoTerm —
// Electron runs it as webContents.paste(), which consults no DOM handler. The
// fix claims the role's native paste event in the CAPTURE phase. These guards
// pin the wiring's shape; removing or weakening any of them is the mutation
// the suite must catch (revert the wiring → RED here).
console.log('PaneTile Edit-Paste capture wiring — the third entry point');

await test('the capture listener is registered on document with capture=true', async () => {
  // Capture is LOAD-BEARING, not a style choice: xterm's own paste listener
  // stops propagation, so a bubble-phase listener never sees the role's event
  // (verified live under Electron 43 — capture fired, bubble never did).
  const reg = pane.match(/document\.addEventListener\('paste',\s*(\w+),\s*true\)/);
  assert.ok(reg, 'no document-level CAPTURE paste listener found — the third entry point is unwired');
  assert.ok(reg[1] === 'onNativePasteCapture', `unexpected handler name: ${reg[1]}`);
  const rm = pane.match(/document\.removeEventListener\('paste',\s*onNativePasteCapture,\s*true\)/);
  assert.ok(rm, 'the capture listener is never removed — a pane disposal would leak it');
});

await test('the claim decision goes through the routing helper, not an inline ad-hoc check', async () => {
  const handler = pane.match(/const onNativePasteCapture = \(e: ClipboardEvent\) => \{[\s\S]*?\n    \};/);
  assert.ok(handler, 'onNativePasteCapture handler not found');
  assert.ok(handler[0].includes('shouldRouteNativePasteToTerminal('),
    'the claim decision bypasses the unit-tested routing helper');
});

await test('a claimed event is stopped from BOTH xterm and the default action', async () => {
  // stopPropagation in the capture phase is what keeps xterm's own handler
  // from running (it would paste getData('text/plain') === '' — a no-op today
  // but a latent double-paste if an image clipboard ever also carried text);
  // preventDefault is what stops the browser's default insertion.
  const handler = pane.match(/const onNativePasteCapture = \(e: ClipboardEvent\) => \{[\s\S]*?\n    \};/);
  const claim = handler[0].slice(handler[0].indexOf('shouldRouteNativePasteToTerminal'));
  const posDefault = claim.indexOf('e.preventDefault()');
  const posStop = claim.indexOf('e.stopPropagation()');
  const posRoute = claim.indexOf('void pasteIntoTerm(');
  assert.ok(posDefault >= 0, 'no preventDefault on the claimed path');
  assert.ok(posStop >= 0, 'no stopPropagation on the claimed path');
  assert.ok(posRoute >= 0, 'claimed event is not routed to pasteIntoTerm');
  assert.ok(posDefault < posRoute && posStop < posRoute,
    'the event must be stopped BEFORE routing, so the route is the only consequence');
});

await test('the capture route reuses the SAME routine with id + live pref', async () => {
  const handler = pane.match(/const onNativePasteCapture = \(e: ClipboardEvent\) => \{[\s\S]*?\n    \};/);
  const route = handler[0].match(/void pasteIntoTerm\(term, id, notifyErrorsRef\.current\)/);
  assert.ok(route, 'the capture wiring must call pasteIntoTerm(term, id, notifyErrorsRef.current) — the shared routine, the pane id, and the LIVE pref');
});

console.log(`\n${passed} tests passed`);
