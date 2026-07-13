/**
 * Theme management utilities for Warden (WARDEN-255).
 *
 * The theme model is now a NAMED-THEME REGISTRY (`@/lib/themes`): each theme is
 * a complete, contrast-safe token set (CSS `[data-theme="<id>"]` blocks in
 * index.css) with an inherent light/dark mode and a matching xterm hex palette.
 * The persisted preference is a `ThemePref` — either a concrete theme id or
 * `'system'` to follow the OS.
 *
 * This module owns the DOM side: reading the OS preference, applying the active
 * theme to the document (`data-theme` attribute + the `.dark` class so Tailwind's
 * `dark:` variant and `@custom-variant dark (&:is(.dark *))` keep working), and
 * listening for OS changes. The pure registry + migration logic live in
 * `@/lib/themes` so they stay DOM-free and unit-testable.
 */

import {
  type ThemeId,
  type ThemePref,
  resolveSystemThemeId,
  getThemeMode,
} from '@/lib/themes';

// Re-export the registry + pure helpers so the common import surface stays
// `@/lib/theme`. Callers that only need metadata/migration can import themes
// directly; most app code imports from here.
export {
  type ThemeId,
  type ThemePref,
  type ThemeMode,
  type ThemeDefinition,
  type XtermPalette,
  THEMES,
  THEME_MAP,
  THEME_IDS,
  DEFAULT_THEME_ID,
  SYSTEM_LIGHT_THEME_ID,
  SYSTEM_DARK_THEME_ID,
  getThemeById,
  getThemeMode,
  isThemeId,
  resolveSystemThemeId,
  resolveTerminalThemeId,
  normalizeThemePref,
} from '@/lib/themes';

/**
 * Backward-compatible alias. Historically the app-wide theme type was
 * `Theme = 'light' | 'dark' | 'system'`; it is now `ThemePref` (a concrete theme
 * id or `'system'`). Existing import sites use `Theme`; aliasing keeps them
 * valid while the value space widens to the named-theme roster.
 */
export type Theme = ThemePref;

// Terminal color scheme preference (persisted client-side in UiState):
// - 'auto' (default): the terminal surface follows the active theme (its xterm
//   palette). When the app pref is 'system', the active theme is OS-resolved,
//   so "auto" follows the OS too — the pre-existing behavior, preserved.
// - 'dark' / 'light': force the terminal surface to the system default dark /
//   light theme regardless of the chrome theme.
export type TerminalColorScheme = 'auto' | 'dark' | 'light';

/**
 * Resolve a theme preference to a concrete theme id. `'system'` defers to the
 * OS `prefers-color-scheme`; a concrete id passes through. Reads the DOM (the OS
 * media query), so call from the browser — the pure OS-state → id mapping is
 * `resolveSystemThemeId` in `@/lib/themes`.
 */
export function resolveThemeId(pref: ThemePref): ThemeId {
  if (pref !== 'system') return pref;
  const osDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  return resolveSystemThemeId(osDark);
}

/**
 * The inherent light/dark MODE of a theme preference, OS-resolved when the pref
 * is 'system'. Used wherever the binary mode still matters (e.g. legacy
 * callers). Prefer the concrete id (`resolveThemeId`) when you need the palette.
 */
export function getEffectiveMode(pref: ThemePref): 'light' | 'dark' {
  return getThemeMode(resolveThemeId(pref));
}

/**
 * Apply a theme preference to the document.
 *
 * Sets the `data-theme` attribute on `<html>` to the resolved theme id — which
 * selects the matching `[data-theme="<id>"]` CSS token block — AND toggles the
 * `.dark` class from that theme's inherent mode, so Tailwind's `dark:` utilities
 * and the existing `@custom-variant dark (&:is(.dark *))` continue to work
 * regardless of which named theme is active. This is the extension of the old
 * mode-only `applyTheme` (which only toggled `.dark`).
 */
export function applyTheme(pref: ThemePref) {
  const id = resolveThemeId(pref);
  const html = document.documentElement;
  html.setAttribute('data-theme', id);
  if (getThemeMode(id) === 'dark') {
    html.classList.add('dark');
  } else {
    html.classList.remove('dark');
  }
}

/**
 * Listen for OS `prefers-color-scheme` changes.
 *
 * Fires `callback` with the newly-resolved concrete theme id (so the caller can
 * re-derive the terminal palette, etc.) whenever the OS flips between light and
 * dark — but ONLY matters while the pref is 'system' (the caller decides whether
 * to keep listening). Returns a cleanup function to remove the listener.
 */
export function listenSystemThemeChange(callback: (id: ThemeId) => void): () => void {
  const media = window.matchMedia('(prefers-color-scheme: dark)');

  const handleChange = (e: MediaQueryListEvent) => {
    callback(resolveSystemThemeId(e.matches));
  };

  media.addEventListener('change', handleChange);

  return () => media.removeEventListener('change', handleChange);
}
