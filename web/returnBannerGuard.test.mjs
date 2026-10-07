// WARDEN-1612 (client-state slice 36) — STATIC SOURCE GUARD for the <ReturnBanner/>
// extraction. Banner-only state lives in the component (so banner-only state changes
// stop re-rendering App), the component stays continuously mounted OUTSIDE the
// settings ternary (so the once-per-launch return check does not re-run on Settings
// open/close), and the warden:lastClose READ lives with the banner while the WRITE
// (try/catch, WARDEN-1259) stays in App.tsx. Same source-reading precedent as
// lastCloseGuard.test.mjs / appStoreReadsGuard.test.mjs (no React/DOM runner here).

import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const appSrc = readFileSync(resolve(__dirname, 'src/App.tsx'), 'utf8');
const bannerSrc = readFileSync(resolve(__dirname, 'src/components/ReturnBanner.tsx'), 'utf8');

const BANNER_NAMES = [
  'activitySinceClose',
  'returnedAfterAbsence',
  'bannerDismissed',
  'returnWindowActive',
  'bannerShownOnce',
  'RETURN_BANNER_WINDOW_MS',
];

test('(a) banner-only state + constant live in ReturnBanner.tsx, not App.tsx', () => {
  for (const name of BANNER_NAMES) {
    assert.ok(!new RegExp(`\\b${name}\\b`).test(appSrc), `${name} must not appear in App.tsx`);
    assert.ok(new RegExp(`\\b${name}\\b`).test(bannerSrc), `${name} must appear in ReturnBanner.tsx`);
  }
});

test('(b) <ReturnBanner appears exactly once in App.tsx, BEFORE the settingsOpen ternary', () => {
  const matches = appSrc.match(/<ReturnBanner\b/g) ?? [];
  assert.strictEqual(matches.length, 1, '<ReturnBanner rendered exactly once');
  const bannerIdx = appSrc.indexOf('<ReturnBanner');
  const ternaryIdx = appSrc.indexOf('{settingsOpen ?');
  assert.notEqual(ternaryIdx, -1, 'the settingsOpen ternary is findable in App.tsx');
  assert.ok(bannerIdx < ternaryIdx, '<ReturnBanner must precede the settingsOpen ternary (stays mounted)');
});

test('(c) warden:lastClose READ lives in ReturnBanner.tsx; the WRITE + try/catch stays in App.tsx', () => {
  assert.ok(bannerSrc.includes("getItem('warden:lastClose')"), 'getItem lives in ReturnBanner.tsx');
  assert.ok(!appSrc.includes("getItem('warden:lastClose')"), 'getItem must not remain in App.tsx');
  assert.ok(!bannerSrc.includes("setItem('warden:lastClose'"), 'setItem must not move into ReturnBanner.tsx');
  const setIdx = appSrc.indexOf("localStorage.setItem('warden:lastClose'");
  assert.notEqual(setIdx, -1, 'setItem stays in App.tsx');
  const tryIdx = appSrc.lastIndexOf('try {', setIdx);
  const catchIdx = appSrc.indexOf('catch', setIdx);
  assert.ok(tryIdx !== -1 && catchIdx !== -1 && setIdx - tryIdx < 80, 'setItem stays inside try/catch');
});
