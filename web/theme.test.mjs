// Tests for the DOM apply-layer of the theme system: web/src/lib/theme.ts
// (WARDEN-255 named-theme registry, WARDEN-1002 coverage).
//
// The PURE half of the theme system (@/lib/themes — resolveSystemThemeId,
// getThemeMode, normalizeThemePref) is already covered by themes.test.mjs /
// storage.test.mjs. The half that actually PAINTS was not covered at all, and
// its contract is load-bearing in two places nothing else guards:
//
//  1. applyTheme owns a PAIRED DOM contract — `data-theme="<id>"` selects the
//     CSS token block (index.css:72) AND `.dark` is toggled as a pure
//     Tailwind-variant signal (index.css:432). The branch most likely to rot
//     silently is theme.ts's `classList.remove('dark')` else-branch: if it is
//     dropped, switching from a dark theme to a light one leaves `.dark` stale
//     on <html> and EVERY `dark:` utility in the app keeps rendering dark on a
//     light theme. So the light case below deliberately starts from a
//     documentElement that ALREADY has `.dark`, making it a removal assertion
//     rather than an add-only one.
//  2. listenSystemThemeChange's cleanup must remove the SAME handler reference
//     it added. App.tsx returns that cleanup from an effect keyed [theme], so a
//     broken cleanup leaks one OS-media listener per theme toggle.
//
// getEffectiveMode is intentionally NOT tested here: it is consumerless
// (zero hits outside its own definition), flagged separately rather than
// covered, so this diff protects only live code.
//
// No FE test runner in this repo, so (like storage.test.mjs / hostInput.test.mjs)
// this loads the REAL theme.ts + themes.ts, transpiled TS -> ESM via Vite's OXC
// transform, rewriting the `@/lib/themes` alias to a relative path Node resolves.
// Expected ids come from the REAL themes.ts, never hardcoded, so these tests keep
// guarding the rule if the constants are re-valued.
//
// Run: node theme.test.mjs   (or: npm test, from web/)
import { transformWithOxc } from 'vite';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const libDir = resolve(__dirname, 'src/lib');
const themePath = join(libDir, 'theme.ts');
const themesPath = join(libDir, 'themes.ts');

const tmpDir = mkdtempSync(join(tmpdir(), 'warden-theme-test-'));
const { code: themesCode } = await transformWithOxc(readFileSync(themesPath, 'utf8'), themesPath, {});
writeFileSync(join(tmpDir, 'themes.mjs'), themesCode);
const { code: themeCode } = await transformWithOxc(readFileSync(themePath, 'utf8'), themePath, {});
const tmpFile = join(tmpDir, 'theme.mjs');
writeFileSync(tmpFile, themeCode.replaceAll('@/lib/themes', './themes.mjs'));
const { resolveThemeId, applyTheme, listenSystemThemeChange } = await import(tmpFile);
const { SYSTEM_DARK_THEME_ID, SYSTEM_LIGHT_THEME_ID, THEMES, getThemeMode } = await import(join(tmpDir, 'themes.mjs'));
rmSync(tmpDir, { recursive: true, force: true });

let passed = 0;
const test = (name, fn) => {
  fn();
  passed += 1;
  console.log('  ok -', name);
};

// Concrete non-'system' ids taken from the REAL registry, so the light/dark
// pairing assertions follow the roster instead of restating it.
const A_DARK_ID = THEMES.find((t) => t.mode === 'dark').id;
const A_LIGHT_ID = THEMES.find((t) => t.mode === 'light').id;

// --- Minimal DOM stubs -------------------------------------------------------
// window.matchMedia: records its call count (so the 'never consults the OS'
// claim is assertable) and every listener add/remove with the exact args, so
// cleanup can be checked by REFERENCE equality rather than by "count went down".
const makeMediaStub = (matches) => {
  const listeners = [];
  const added = [];
  const removed = [];
  return {
    matches,
    listeners,
    added,
    removed,
    addEventListener(type, fn) {
      added.push([type, fn]);
      listeners.push([type, fn]);
    },
    removeEventListener(type, fn) {
      removed.push([type, fn]);
      const i = listeners.findIndex(([t, f]) => t === type && f === fn);
      if (i !== -1) listeners.splice(i, 1);
    },
    // Fire an OS flip at whatever is still registered.
    fire(nextMatches) {
      for (const [type, fn] of [...listeners]) {
        if (type === 'change') fn({ matches: nextMatches });
      }
    },
  };
};

// document.documentElement: `initialClasses` lets a test start from a stale
// `.dark`, which is what makes the light-theme case a removal assertion.
const makeHtmlStub = (initialClasses = []) => {
  const classes = new Set(initialClasses);
  const attrs = new Map();
  return {
    classes,
    attrs,
    setAttribute: (k, v) => { attrs.set(k, v); },
    getAttribute: (k) => (attrs.has(k) ? attrs.get(k) : null),
    classList: {
      add: (c) => { classes.add(c); },
      remove: (c) => { classes.delete(c); },
      contains: (c) => classes.has(c),
    },
  };
};

const savedWindow = globalThis.window;
const savedDocument = globalThis.document;

// Install the stubs, run `fn(dom)`, and ALWAYS restore the real globals — a
// failing assertion must not leak a fake window/document into later files.
const withDom = ({ osDark = false, htmlClasses = [] } = {}, fn) => {
  const media = makeMediaStub(osDark);
  const html = makeHtmlStub(htmlClasses);
  const queries = [];
  globalThis.window = {
    matchMedia: (q) => { queries.push(q); return media; },
  };
  globalThis.document = { documentElement: html };
  try {
    return fn({ media, html, queries });
  } finally {
    globalThis.window = savedWindow;
    globalThis.document = savedDocument;
  }
};

console.log('\nresolveThemeId: a concrete id passes through without touching the OS');
test('a concrete theme id is returned unchanged', () => {
  withDom({ osDark: true }, () => {
    assert.equal(resolveThemeId(A_LIGHT_ID), A_LIGHT_ID);
    assert.equal(resolveThemeId(A_DARK_ID), A_DARK_ID);
  });
});
test('matchMedia is never consulted for a concrete id (OS state is irrelevant)', () => {
  withDom({ osDark: true }, ({ queries }) => {
    resolveThemeId(A_LIGHT_ID);
    assert.equal(queries.length, 0, 'a concrete id must short-circuit before the media query');
  });
});

console.log("\nresolveThemeId: 'system' defers to prefers-color-scheme");
test("OS dark -> SYSTEM_DARK_THEME_ID (from the real themes.ts)", () => {
  withDom({ osDark: true }, ({ queries }) => {
    assert.equal(resolveThemeId('system'), SYSTEM_DARK_THEME_ID);
    assert.deepEqual(queries, ['(prefers-color-scheme: dark)'], 'queries the OS dark-scheme media');
  });
});
test('OS light -> SYSTEM_LIGHT_THEME_ID (from the real themes.ts)', () => {
  withDom({ osDark: false }, () => {
    assert.equal(resolveThemeId('system'), SYSTEM_LIGHT_THEME_ID);
  });
});

console.log('\napplyTheme: the PAIRED data-theme + .dark contract (index.css:72 / :432)');
test('a dark theme sets data-theme to the id AND adds .dark', () => {
  withDom({}, ({ html }) => {
    applyTheme(A_DARK_ID);
    assert.equal(html.getAttribute('data-theme'), A_DARK_ID, 'data-theme selects the token block');
    assert.equal(html.classList.contains('dark'), true, 'Tailwind dark: variant signal is on');
  });
});
test('a light theme sets data-theme AND REMOVES a stale .dark (the else-branch)', () => {
  // Starts dark — exactly the dark->light switch. If theme.ts's
  // `classList.remove('dark')` is dropped, this assertion fails.
  withDom({ htmlClasses: ['dark'] }, ({ html }) => {
    assert.equal(html.classList.contains('dark'), true, 'precondition: .dark is stale on <html>');
    applyTheme(A_LIGHT_ID);
    assert.equal(html.getAttribute('data-theme'), A_LIGHT_ID);
    assert.equal(
      html.classList.contains('dark'), false,
      'a light theme MUST clear .dark or every dark: utility keeps rendering dark',
    );
  });
});
test('every theme in the registry pairs data-theme with its inherent mode', () => {
  for (const t of THEMES) {
    // Each starts from the OPPOSITE class state, so both branches are exercised
    // for every theme rather than only for the two sampled above.
    withDom({ htmlClasses: t.mode === 'dark' ? [] : ['dark'] }, ({ html }) => {
      applyTheme(t.id);
      assert.equal(html.getAttribute('data-theme'), t.id, `data-theme for ${t.id}`);
      assert.equal(
        html.classList.contains('dark'), getThemeMode(t.id) === 'dark',
        `.dark must match ${t.id}'s inherent mode (${t.mode})`,
      );
    });
  }
});
test("applyTheme('system') writes the OS-RESOLVED id, never the literal 'system'", () => {
  withDom({ osDark: true }, ({ html }) => {
    applyTheme('system');
    assert.equal(html.getAttribute('data-theme'), SYSTEM_DARK_THEME_ID);
    assert.notEqual(html.getAttribute('data-theme'), 'system', "'system' is not a CSS token block");
    assert.equal(html.classList.contains('dark'), true);
  });
  withDom({ osDark: false, htmlClasses: ['dark'] }, ({ html }) => {
    applyTheme('system');
    assert.equal(html.getAttribute('data-theme'), SYSTEM_LIGHT_THEME_ID);
    assert.equal(html.classList.contains('dark'), false, 'OS flip to light clears .dark');
  });
});

console.log('\nlistenSystemThemeChange: resolves the event to a theme id');
test('the callback receives the resolved id, not the raw MediaQueryListEvent', () => {
  withDom({ osDark: false }, ({ media }) => {
    const seen = [];
    listenSystemThemeChange((id) => seen.push(id));
    media.fire(true);
    assert.deepEqual(seen, [SYSTEM_DARK_THEME_ID], 'OS -> dark yields the dark theme id');
    media.fire(false);
    assert.deepEqual(seen, [SYSTEM_DARK_THEME_ID, SYSTEM_LIGHT_THEME_ID], 'OS -> light yields the light theme id');
    for (const id of seen) {
      assert.equal(typeof id, 'string', 'a theme id, not an event object');
    }
  });
});

console.log('\nlistenSystemThemeChange: cleanup removes the SAME handler it added');
test("cleanup calls removeEventListener with the identical ('change', handler) pair", () => {
  withDom({}, ({ media }) => {
    const cleanup = listenSystemThemeChange(() => {});
    assert.equal(media.added.length, 1, 'exactly one listener added');
    const [addedType, addedFn] = media.added[0];
    assert.equal(addedType, 'change');

    cleanup();
    assert.equal(media.removed.length, 1, 'exactly one removeEventListener call');
    const [removedType, removedFn] = media.removed[0];
    assert.equal(removedType, addedType, 'same event type');
    assert.equal(removedFn, addedFn, 'SAME handler reference — an anonymous re-wrap would leak');
    assert.equal(media.listeners.length, 0, 'listener count returns to 0');
  });
});
test('after cleanup an OS flip no longer reaches the callback', () => {
  withDom({}, ({ media }) => {
    let calls = 0;
    const cleanup = listenSystemThemeChange(() => { calls += 1; });
    media.fire(true);
    assert.equal(calls, 1, 'precondition: the live listener fires');
    cleanup();
    media.fire(false);
    assert.equal(calls, 1, 'a detached listener must not fire');
  });
});
test('re-registering per theme toggle (App.tsx effect keyed [theme]) leaks nothing', () => {
  withDom({}, ({ media }) => {
    // Mirrors App.tsx: the effect re-runs on each theme change, running the
    // previous cleanup before registering again. Steady state must be 1, not N.
    let cleanup = listenSystemThemeChange(() => {});
    for (let i = 0; i < 5; i += 1) {
      cleanup();
      cleanup = listenSystemThemeChange(() => {});
    }
    assert.equal(media.listeners.length, 1, 'one live listener regardless of toggle count');
    cleanup();
    assert.equal(media.listeners.length, 0, 'final cleanup leaves none');
  });
});

console.log('\nglobals are restored — no fake window/document leaks to other suites');
test('globalThis.window / globalThis.document are back to their originals', () => {
  assert.equal(globalThis.window, savedWindow);
  assert.equal(globalThis.document, savedDocument);
});

console.log(`\n✓ THEME DOM TESTS PASS (${passed})`);
