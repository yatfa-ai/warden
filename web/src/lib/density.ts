/**
 * UI density management for Warden.
 *
 * 'comfortable' = default spacing (today's exact look, zero visual change).
 * 'compact' tightens row/header/gap padding across the sidebar, observer panel,
 * and pane chrome so more of the agent workforce fits on one screen.
 *
 * Mirrors the theme.ts pattern: density is a pure client-side localStorage
 * preference (never sent to the backend), and we toggle a class on <html> that a
 * Tailwind custom-variant (`compact:`) keys off of (see `@custom-variant compact`
 * in index.css). Existing utility classes opt into compact spacing additively,
 * e.g. `py-1.5 compact:py-1`.
 */

export type Density = 'comfortable' | 'compact';

/**
 * Apply density to the document by adding/removing the 'compact' class on the
 * root element. Mirrors applyTheme()'s handling of the 'dark' class.
 */
export function applyDensity(density: Density) {
  document.documentElement.classList.toggle('compact', density === 'compact');
}
