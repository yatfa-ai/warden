/**
 * Theme management utilities for Warden
 * Supports light, dark, and system (follows OS preference) modes
 */

export type Theme = 'light' | 'dark' | 'system';

/**
 * Get the effective theme (light or dark) based on theme preference.
 * If theme is 'system', detects OS color scheme preference.
 */
export function getEffectiveTheme(theme: Theme): 'light' | 'dark' {
  if (theme !== 'system') return theme;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/**
 * Apply theme to document by adding/removing 'dark' class.
 * This works with Tailwind's dark mode variant and CSS variables.
 */
export function applyTheme(theme: Theme) {
  const effective = getEffectiveTheme(theme);
  const html = document.documentElement;

  if (effective === 'dark') {
    html.classList.add('dark');
  } else {
    html.classList.remove('dark');
  }
}

/**
 * Listen for system theme changes.
 * Returns a cleanup function to remove the event listener.
 */
export function listenSystemThemeChange(callback: (theme: 'light' | 'dark') => void): () => void {
  const media = window.matchMedia('(prefers-color-scheme: dark)');

  const handleChange = (e: MediaQueryListEvent) => {
    callback(e.matches ? 'dark' : 'light');
  };

  media.addEventListener('change', handleChange);

  return () => media.removeEventListener('change', handleChange);
}
