/**
 * Named-theme registry for Warden (WARDEN-255).
 *
 * Replaces the mode-only `'light' | 'dark' | 'system'` model. Each entry is a
 * complete, contrast-safe token set drawn from an established open-source
 * palette (MIT/ISC). The CSS token values live in `web/src/index.css` under
 * `[data-theme="<id>"]` selectors; THIS module holds the metadata the app needs
 * at runtime — the display label, the inherent light/dark mode, and the xterm
 * hex palette (xterm.js cannot parse oklch(), so every theme ships concrete hex
 * for the terminal surface).
 *
 * This module is PURE: no DOM access, no React, no xterm import. That keeps it
 * trivially unit-testable (transpiled TS -> ESM via Vite's OXC transform, run
 * under Node like the other `web/*.test.mjs` suites) and lets `storage.ts` pull
 * `normalizeThemePref` from here without taking a DOM-module dependency.
 *
 * Palettes (values are the published hex from each project):
 *  - GitHub Light / Dark — Primer primitives (MIT)
 *  - Light+ / Dark+ — VS Code default themes (MIT)
 *  - Catppuccin Mocha, Dracula, Nord, One Dark — community palettes (MIT)
 */

/** Inherent light/dark mode of a theme. Drives the `.dark` class + Tailwind `dark:` variant. */
export type ThemeMode = 'light' | 'dark';

/**
 * A persisted theme preference. Either a concrete theme id, or `'system'` to
 * follow the OS (`prefers-color-scheme`) — resolving to the system default
 * light/dark theme. This is the shape stored in `UiState.theme`.
 */
export type ThemePref = ThemeId | 'system';

/**
 * xterm.js needs concrete hex — it does not reliably parse oklch() or CSS
 * variable references. Every theme therefore carries this palette, derived from
 * the same source palette as the CSS tokens. Field names match xterm's `ITheme`
 * so the object can be passed straight through. The ANSI 16-color palette is
 * intentionally left to xterm defaults (per the existing PaneTile convention)
 * so colored program output is unchanged; only the surface bg/fg/cursor +
 * selection are themed.
 */
export interface XtermPalette {
  background: string;
  foreground: string;
  cursor: string;
  cursorAccent: string;
  /** Terminal selection overlay (semi-transparent is fine here — it's an overlay, not page text). */
  selectionBackground: string;
}

/** Registry metadata for one theme. The full shadcn token set lives in CSS. */
export interface ThemeDefinition {
  id: ThemeId;
  /** Human-readable label shown in the Settings theme picker. */
  label: string;
  /** Which OS-prefers-color-scheme bucket this theme belongs to (also the `.dark` toggle). */
  mode: ThemeMode;
  /** xterm surface palette (hex). */
  xterm: XtermPalette;
}

/**
 * The concrete theme ids. These double as the `[data-theme="<id>"]` selector
 * keys in index.css, so a rename here MUST be paired with a rename there.
 */
export type ThemeId =
  | 'github-light'
  | 'github-dark'
  | 'vscode-light'
  | 'vscode-dark'
  | 'catppuccin-mocha'
  | 'dracula'
  | 'nord'
  | 'one-dark';

// --- System resolution defaults ---------------------------------------------
// The default theme overall, and the light/dark pair that "System (follow OS)"
// resolves to. GitHub Dark is the overall default; the system pair is
// GitHub Light ↔ GitHub Dark so a user on "System" gets the same family on both
// sides of the OS flip. Exported so tests + the picker can reference them.
export const DEFAULT_THEME_ID: ThemeId = 'github-dark';
export const SYSTEM_LIGHT_THEME_ID: ThemeId = 'github-light';
export const SYSTEM_DARK_THEME_ID: ThemeId = 'github-dark';
// Closest-named-theme migration targets for the legacy 'light'/'dark' prefs.
export const DEFAULT_LIGHT_THEME_ID: ThemeId = SYSTEM_LIGHT_THEME_ID;
export const DEFAULT_DARK_THEME_ID: ThemeId = SYSTEM_DARK_THEME_ID;

/**
 * The roster. ORDER MATTERS: the Settings theme picker renders themes in this
 * order (grouped by mode, but the in-group order is this array's order), so a
 * stable, curated order is part of the UX. Every id here must have a matching
 * `[data-theme="<id>"]` token block in index.css.
 */
export const THEMES: readonly ThemeDefinition[] = [
  // --- Light ----------------------------------------------------------------
  {
    id: 'github-light',
    label: 'GitHub Light',
    mode: 'light',
    xterm: { background: '#ffffff', foreground: '#1f2328', cursor: '#1f2328', cursorAccent: '#ffffff', selectionBackground: 'rgba(9, 105, 218, 0.28)' },
  },
  {
    id: 'vscode-light',
    label: 'Light+ (VS Code)',
    mode: 'light',
    xterm: { background: '#ffffff', foreground: '#000000', cursor: '#000000', cursorAccent: '#ffffff', selectionBackground: 'rgba(0, 122, 204, 0.28)' },
  },
  // --- Dark -----------------------------------------------------------------
  {
    id: 'github-dark',
    label: 'GitHub Dark',
    mode: 'dark',
    xterm: { background: '#0d1117', foreground: '#e6edf3', cursor: '#e6edf3', cursorAccent: '#0d1117', selectionBackground: 'rgba(56, 139, 253, 0.30)' },
  },
  {
    id: 'vscode-dark',
    label: 'Dark+ (VS Code)',
    mode: 'dark',
    xterm: { background: '#1e1e1e', foreground: '#d4d4d4', cursor: '#d4d4d4', cursorAccent: '#1e1e1e', selectionBackground: 'rgba(38, 79, 120, 0.55)' },
  },
  {
    id: 'catppuccin-mocha',
    label: 'Catppuccin Mocha',
    mode: 'dark',
    xterm: { background: '#1e1e2e', foreground: '#cdd6f4', cursor: '#f5e0dc', cursorAccent: '#1e1e2e', selectionBackground: 'rgba(203, 166, 247, 0.30)' },
  },
  {
    id: 'dracula',
    label: 'Dracula',
    mode: 'dark',
    xterm: { background: '#282a36', foreground: '#f8f8f2', cursor: '#f8f8f2', cursorAccent: '#282a36', selectionBackground: 'rgba(68, 71, 90, 0.70)' },
  },
  {
    id: 'nord',
    label: 'Nord',
    mode: 'dark',
    xterm: { background: '#2e3440', foreground: '#d8dee9', cursor: '#d8dee9', cursorAccent: '#2e3440', selectionBackground: 'rgba(136, 192, 208, 0.25)' },
  },
  {
    id: 'one-dark',
    label: 'One Dark',
    mode: 'dark',
    xterm: { background: '#282c34', foreground: '#abb2bf', cursor: '#abb2bf', cursorAccent: '#282c34', selectionBackground: 'rgba(97, 175, 239, 0.25)' },
  },
];

/** Fast id → definition lookup. Built once; ids are unique by construction. */
export const THEME_MAP: Readonly<Record<ThemeId, ThemeDefinition>> = Object.fromEntries(
  THEMES.map((t) => [t.id, t]),
) as Readonly<Record<ThemeId, ThemeDefinition>>;

/** All valid concrete theme ids (excludes 'system'). Used to validate stored prefs. */
export const THEME_IDS: readonly ThemeId[] = THEMES.map((t) => t.id);

/** True if `id` is a registered concrete theme id. */
export function isThemeId(id: string): id is ThemeId {
  return id in THEME_MAP;
}

/** Look up a theme definition by id. Returns `undefined` for an unknown id. */
export function getThemeById(id: ThemeId): ThemeDefinition;
export function getThemeById(id: string): ThemeDefinition | undefined;
export function getThemeById(id: string): ThemeDefinition | undefined {
  return THEME_MAP[id as ThemeId];
}

/** The inherent light/dark mode of a registered theme id. Pure. */
export function getThemeMode(id: ThemeId): ThemeMode {
  return THEME_MAP[id].mode;
}

/**
 * Resolve the "System (follow OS)" preference to a concrete theme id, given the
 * OS dark-mode state. PURE (the caller reads `matchMedia`), so it is testable
 * without a DOM — the OS state is just a boolean argument.
 */
export function resolveSystemThemeId(osDark: boolean): ThemeId {
  return osDark ? SYSTEM_DARK_THEME_ID : SYSTEM_LIGHT_THEME_ID;
}

/**
 * Resolve the terminal color-scheme override to a concrete theme id.
 *
 * - `'auto'`  → the active theme's palette (the resolved chrome theme id).
 * - `'dark'`  → the system default DARK theme (GitHub Dark).
 * - `'light'` → the system default LIGHT theme (GitHub Light).
 *
 * PURE (no DOM): `activeThemeId` is the already-OS-resolved chrome theme, so
 * the "auto follows an OS flip" behavior falls out of the caller re-resolving
 * `activeThemeId` and passing the new value here. Kept in this pure module so
 * the resolution is unit-testable.
 */
export function resolveTerminalThemeId(
  scheme: 'auto' | 'dark' | 'light',
  activeThemeId: ThemeId,
): ThemeId {
  if (scheme === 'dark') return SYSTEM_DARK_THEME_ID;
  if (scheme === 'light') return SYSTEM_LIGHT_THEME_ID;
  return activeThemeId;
}

/**
 * Normalize a raw stored theme value into a valid `ThemePref`.
 *
 * Handles the BACKWARD-COMPATIBLE migration from the old mode-only model
 * (`'light' | 'dark' | 'system'`): a legacy stored value is mapped to the
 * closest named theme, so an upgrade never crashes or produces a broken
 * (token-less) theme.
 *   - `'system'`           → `'system'` (unchanged)
 *   - a registered theme id → that id (new shape, as-is)
 *   - `'dark'`  (legacy)   → DEFAULT_DARK_THEME_ID  (GitHub Dark)
 *   - `'light'` (legacy)   → DEFAULT_LIGHT_THEME_ID (GitHub Light)
 *   - anything else / missing/non-string → `'system'` (the default)
 *
 * PURE and dependency-free (no DOM) so it is unit-tested directly and safe for
 * `storage.ts` to call inside `loadUi`.
 */
export function normalizeThemePref(raw: unknown): ThemePref {
  if (typeof raw !== 'string') return 'system';
  if (raw === 'system') return 'system';
  if (isThemeId(raw)) return raw;
  if (raw === 'dark') return DEFAULT_DARK_THEME_ID;
  if (raw === 'light') return DEFAULT_LIGHT_THEME_ID;
  return 'system';
}
