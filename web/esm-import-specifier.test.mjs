// WARDEN-1280 — STATIC SOURCE GUARD for CJS→ESM dynamic import specifiers in
// electron/main.cjs.
//
// WHY THIS FILE EXISTS: main.cjs is CommonJS and package.json is
// `"type": "module"`, so every src/ module it needs must cross the boundary via
// `await import(...)`. There are two such sites today (the stall journal reader
// behind Help > Stall Diagnostics…, and the WARDEN-524 telemetry transport), and
// both were originally written as `await import(path.join(__dirname, '..',
// 'src', 'x.js'))`.
//
// That form is WRONG on win32 and RIGHT on POSIX, which is the worst possible
// combination: `path.join` yields a drive-letter path (`C:\...\src\x.js`), and
// Node's ESM loader — which Electron's main process uses, per Electron's own
// ESM documentation — parses the leading `C:` as a URL SCHEME and rejects the
// specifier with ERR_UNSUPPORTED_ESM_URL_SCHEME before it ever touches the
// filesystem. A POSIX absolute path happens to URL-resolve against the importing
// module, so the identical code works on macOS/Linux. Warden ships a Windows
// NSIS installer (package.json build.win.target), and both call sites are
// wrapped in try/catch — so on Windows the failure degrades into a plausible-
// looking message ("Could not read the stall journal", "telemetry stays inert")
// rather than a crash, and no Linux CI run or Linux sandbox probe can ever see
// it. That is precisely the kind of defect a static guard is for.
//
// The fix is `pathToFileURL(...).href` (main.cjs's `srcModuleUrl` helper), which
// produces a `file:` specifier on every platform. This file pins BOTH halves:
// the loader behavior that makes the raw form unsafe (executable proof, not a
// comment), and the absence of that form from main.cjs (regression guard).
//
// Static-source-assertion precedent in this repo: web/lastCloseGuard.test.mjs
// (#1259) and web/sessionTagCap.test.mjs (#1241) — a source scan can see a
// property of a module that cannot be loaded under `node --test` at all.
//
// Auto-discovered by `npm test` in web/ (`node --test`).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname, win32 as pathWin32 } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MAIN_CJS = resolve(__dirname, '..', 'electron', 'main.cjs');
const source = readFileSync(MAIN_CJS, 'utf8');

// A specifier of exactly the shape `path.join(__dirname, '..', 'src', x)`
// produces when main.cjs runs from a Windows install directory.
const WIN32_SPECIFIER = pathWin32.join('C:\\Program Files\\Yatfa Warden\\electron', '..', 'src', 'stall-log.js');

// ---------------------------------------------------------------------------
// The loader behavior the guard exists to protect against.
// ---------------------------------------------------------------------------

test('a win32 drive-letter path is NOT a usable ESM specifier (the bug being guarded)', async () => {
  assert.match(WIN32_SPECIFIER, /^C:\\/, 'precondition: path.join on win32 yields a drive-letter path');
  await assert.rejects(
    () => import(WIN32_SPECIFIER),
    (err) => {
      assert.equal(err.code, 'ERR_UNSUPPORTED_ESM_URL_SCHEME');
      return true;
    },
    'Node rejects a drive-letter specifier as an unsupported URL scheme',
  );
});

test('pathToFileURL turns that same path into a file: specifier the loader accepts', () => {
  const href = pathToFileURL(WIN32_SPECIFIER).href;
  assert.match(href, /^file:\/\//, 'the fixed specifier carries the file: scheme on every platform');
  assert.doesNotMatch(href, /^[A-Za-z]:/, 'no bare drive letter survives to be read as a scheme');
});

test('the fixed form actually resolves a real src/ module on this platform', async () => {
  const href = pathToFileURL(resolve(__dirname, '..', 'src', 'stall-log.js')).href;
  const mod = await import(href);
  assert.equal(typeof mod.readStalls, 'function', 'the stall reader main.cjs imports loads through the fixed form');
});

// ---------------------------------------------------------------------------
// The regression guard over main.cjs itself.
// ---------------------------------------------------------------------------

test('electron/main.cjs never passes a raw path.join() result to import()', () => {
  const offenders = source
    .split('\n')
    .map((line, i) => [i + 1, line])
    .filter(([, line]) => /\bimport\s*\(\s*path\.join\s*\(/.test(line));
  assert.deepEqual(
    offenders,
    [],
    `import(path.join(...)) is ERR_UNSUPPORTED_ESM_URL_SCHEME on win32 — use srcModuleUrl()/pathToFileURL(...).href instead:\n${offenders
      .map(([n, l]) => `  main.cjs:${n}: ${l.trim()}`)
      .join('\n')}`,
  );
});

test('every dynamic import in electron/main.cjs uses a file-URL specifier', () => {
  const calls = [...source.matchAll(/\bawait import\(([^)]*)\)/g)].map((m) => m[1].trim());
  assert.ok(calls.length >= 2, `expected the stall-log and telemetry-send imports, found ${calls.length}`);
  for (const arg of calls) {
    assert.match(
      arg,
      /srcModuleUrl\(|pathToFileURL\(/,
      `dynamic import specifier ${JSON.stringify(arg)} must be built as a file URL (win32 safety)`,
    );
  }
});

test('main.cjs defines srcModuleUrl via pathToFileURL and imports it from node:url', () => {
  assert.match(source, /const \{ pathToFileURL \} = require\('url'\);/, 'pathToFileURL is required at the top');
  assert.match(
    source,
    /function srcModuleUrl\([\s\S]*?pathToFileURL\(path\.join\(__dirname, '\.\.', 'src', \.\.\.segments\)\)\.href/,
    'srcModuleUrl resolves src/ modules through pathToFileURL',
  );
});

// ---------------------------------------------------------------------------
// The About-box description is READ, not transcribed (no silent manifest drift).
// ---------------------------------------------------------------------------

test('the About dialog renders the package.json description rather than a copy of it', () => {
  assert.match(source, /function appDescription\(\)/, 'appDescription() reads the manifest');
  assert.match(source, /detail: `Version \$\{app\.getVersion\(\)\}\\n\$\{appDescription\(\)\}`/);
  const { description } = JSON.parse(readFileSync(resolve(__dirname, '..', 'package.json'), 'utf8'));
  assert.ok(description && description.trim(), 'package.json still carries a description to read');
  assert.doesNotMatch(
    source,
    new RegExp(`detail:[^\\n]*${description.replace(/[.*+?^${}()|[\]\\—]/g, '\\$&')}`),
    'the description must not also be hardcoded into the dialog',
  );
});
