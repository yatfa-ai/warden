// WCAG contrast verification for the themed ::selection rule (WARDEN-255).
//
// WHY THIS FILE EXISTS: the ticket's headline outcome is "text selection is
// clearly visible in every theme, light and dark — passes WCAG AA." The first
// pass reused the button brand pair (--primary/--primary-foreground) for
// ::selection and asserted that claim only in a code comment — but that pair is
// contrast-tuned for BUTTONS, not a selection highlight, and it silently missed
// the AA bar in two themes (the default GitHub Dark among them: white on
// --primary #2f81f7 = 3.75:1). A green test suite gave zero signal on this
// property. So selection now has a DEDICATED --selection / --selection-foreground
// token pair per theme, and THIS suite computes the actual WCAG contrast ratios
// from the SHIPPED CSS and asserts them. "Passes WCAG AA" is now verified, not
// asserted (reviewer feedback on PR #112).
//
// WHAT IT CHECKS, for every registered theme (and the :root FOUC default):
//   1. the [data-theme="<id>"] block exists in index.css and defines
//      --background, --selection, and --selection-foreground,
//   2. contrast(selection-foreground, selection) >= 4.5  (WCAG 2.x AA, normal text —
//      the selected text must be legible against the selection highlight), AND
//   3. contrast(selection, background) >= 3.0  (the WCAG AA UI-component /
//      non-text distinctness bar — the highlight must clearly separate from the
//      page background so it is visible at all).
//   4. the ::selection rule actually reads var(--selection) / var(--selection-foreground)
//      (otherwise the tested tokens are not the ones the browser paints), and
//   5. :root mirrors the DEFAULT theme's selection tokens (FOUC-free first paint).
//
// Source of truth is index.css — the values the browser actually ships — not a
// TS copy, so a CSS/TS drift can never silently pass. The theme ROSTER is read
// from themes.ts (the registry) so a theme added to the registry without a CSS
// block (or failing contrast) fails here.
//
// Run: node selection-contrast.test.mjs   (or: npm test, from web/)
import { transformWithOxc } from 'vite';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const cssPath = resolve(__dirname, 'src/index.css');
const themesPath = resolve(__dirname, 'src/lib/themes.ts');

// --- Load the roster + DEFAULT_THEME_ID from the REAL themes.ts (TS -> ESM) ---
const src = readFileSync(themesPath, 'utf8');
const { code } = await transformWithOxc(src, themesPath, {});
const tmpDir = mkdtempSync(join(tmpdir(), 'warden-selcontrast-test-'));
const tmpFile = join(tmpDir, 'themes.mjs');
writeFileSync(tmpFile, code);
const { THEMES, DEFAULT_THEME_ID } = await import(tmpFile);
rmSync(tmpDir, { recursive: true, force: true });

// --- Parse index.css into per-block token maps -------------------------------
const css = readFileSync(cssPath, 'utf8');

/** Parse a declaration block body into a { '--token': 'value' } map. */
function parseDecls(body) {
  const out = {};
  for (const m of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    out[m[1]] = m[2].trim();
  }
  return out;
}

/** Extract :root and every [data-theme="<id>"] block from the CSS. */
function extractBlocks(cssText) {
  const blocks = { root: {} };
  // Matches `:root { ... }` and `[data-theme="id"] { ... }` (block bodies have no nested braces).
  const re = /(?:^|\n)\s*(:root|\[data-theme="([\w-]+)"\])\s*\{([^}]*)\}/g;
  let m;
  while ((m = re.exec(cssText)) !== null) {
    const id = m[2] || 'root';
    blocks[id] = parseDecls(m[3]);
  }
  return blocks;
}

const blocks = extractBlocks(css);

// --- WCAG 2.x relative luminance + contrast ratio (the spec formula) ---------
function srgbToLinear(c) {
  c /= 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
function parseHex(h) {
  h = String(h).replace('#', '').trim();
  if (h.length === 3) h = h.split('').map((x) => x + x).join('');
  if (!/^[0-9a-fA-F]{6}$/.test(h)) {
    throw new Error(`expected a #rrggbb hex color, got ${JSON.stringify(h)}`);
  }
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
function relativeLuminance(hex) {
  const [r, g, b] = parseHex(hex);
  return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);
}
/** WCAG contrast ratio between two #rrggbb colors. Always >= 1. */
function contrastRatio(a, b) {
  const L1 = relativeLuminance(a);
  const L2 = relativeLuminance(b);
  const hi = Math.max(L1, L2);
  const lo = Math.min(L1, L2);
  return (hi + 0.05) / (lo + 0.05);
}

// The two bars the ticket + reviewer agreed on.
const TEXT_AA = 4.5;   // WCAG 2.x AA, normal text (selected text vs highlight)
const DISTINCTNESS = 3; // WCAG AA non-text / UI component (highlight vs page bg)

let passed = 0;
const test = (name, fn) => {
  fn();
  passed += 1;
  console.log('  ok -', name);
};

console.log('\n::selection rule points at the dedicated selection tokens');
test('the ::selection rule reads var(--selection) and var(--selection-foreground)', () => {
  // The declaration lives in @layer base; match it generously across whitespace/newlines.
  const selRule = /::selection\s*\{[^}]*background-color:\s*var\(--selection\)\s*;[^}]*color:\s*var\(--selection-foreground\)/;
  assert.ok(selRule.test(css), '::selection must use var(--selection) / var(--selection-foreground)');
});

console.log('\nthe default theme has a CSS block defining the selection tokens');
test('every theme in the registry has a matching [data-theme] block', () => {
  for (const t of THEMES) {
    assert.ok(blocks[t.id], `${t.id}: missing [data-theme="${t.id}"] block in index.css`);
  }
});
test('there are no orphan [data-theme] blocks outside the registry', () => {
  const registryIds = new Set(THEMES.map((t) => t.id));
  const cssIds = Object.keys(blocks).filter((k) => k !== 'root');
  for (const id of cssIds) {
    assert.ok(registryIds.has(id), `${id}: CSS block exists but is not in the registry`);
  }
});

console.log('\nselection contrast passes WCAG AA in EVERY theme (the WARDEN-143 fix)');
for (const t of THEMES) {
  const tokens = blocks[t.id];
  test(`${t.id}: defines --background, --selection, --selection-foreground as #rrggbb hex`, () => {
    for (const tok of ['--background', '--selection', '--selection-foreground']) {
      const v = tokens[tok];
      assert.equal(typeof v, 'string', `${t.id}: ${tok} is defined`);
      assert.ok(/^#[0-9a-fA-F]{6}$/.test(v), `${t.id}: ${tok} must be #rrggbb hex, got ${v}`);
    }
  });
  test(`${t.id}: selected text vs selection bg >= 4.5:1 (WCAG AA normal text)`, () => {
    const ratio = contrastRatio(tokens['--selection-foreground'], tokens['--selection']);
    assert.ok(
      ratio >= TEXT_AA,
      `${t.id}: selection text ${tokens['--selection-foreground']} on ${tokens['--selection']} = ${ratio.toFixed(2)}:1, need >= ${TEXT_AA}`,
    );
  });
  test(`${t.id}: selection bg vs page background >= 3:1 (visible-highlight distinctness)`, () => {
    const ratio = contrastRatio(tokens['--selection'], tokens['--background']);
    assert.ok(
      ratio >= DISTINCTNESS,
      `${t.id}: selection ${tokens['--selection']} vs page ${tokens['--background']} = ${ratio.toFixed(2)}:1, need >= ${DISTINCTNESS}`,
    );
  });
}

console.log('\n:root mirrors the DEFAULT theme (FOUC-free first paint)');
test(':root selection tokens equal the default theme (' + DEFAULT_THEME_ID + ') tokens', () => {
  const def = blocks[DEFAULT_THEME_ID];
  assert.ok(def, 'default theme has a CSS block');
  assert.equal(blocks.root['--selection'], def['--selection'], ':root --selection must mirror the default theme');
  assert.equal(blocks.root['--selection-foreground'], def['--selection-foreground'], ':root --selection-foreground must mirror the default theme');
});

console.log(`\n✓ SELECTION CONTRAST TESTS PASS (${passed})`);
