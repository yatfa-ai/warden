import { useEffect } from 'react';
import { applyTheme, listenSystemThemeChange, resolveThemeId } from '@/lib/theme';
import { applyDensity } from '@/lib/density';
import { useTheme, useDensity, useSetResolvedThemeId } from '@/lib/uiStore';

// WARDEN-1659 (client-state slice 44): the theme/density apply effects, extracted
// from App.tsx so a Settings → Appearance change re-renders only this
// null-rendering component, not all of App (theme/density were consumed by these
// two effects alone — never rendered or passed as props). It must stay
// continuously mounted (App renders it OUTSIDE the settings ternary): Settings is
// where the theme changes, and the OS-flip listener must keep running while
// Settings is open. Child effects run before parent effects in the same commit,
// so the theme is still applied in the first commit.
export function AppearanceSync() {
  const theme = useTheme();
  // The OS-resolved concrete theme id lives on the store as a NON-persisted fact
  // (WARDEN-1574, slice 31); PaneTile reads it via useTerminalThemeId().
  const setResolvedThemeId = useSetResolvedThemeId();
  const density = useDensity();

  // apply theme on mount and when theme changes (theme itself persists via the
  // single compile-locked saveUi effect in useConfigPersistence)
  useEffect(() => {
    // Apply theme immediately: sets the [data-theme] attribute (selecting the
    // matching CSS token block) and toggles `.dark` from the theme's mode.
    applyTheme(theme);
    // Keep the store's resolved concrete theme id in sync so the terminal pane
    // (which derives its xterm palette from it) follows a manual theme change live.
    setResolvedThemeId(resolveThemeId(theme));

    // If system mode, listen for system theme changes. The `theme` state stays
    // 'system' here (chrome re-paints via applyTheme's direct DOM attribute set),
    // but we ALSO push the OS-resolved theme id into the store so the terminal
    // surface — which re-themes imperatively in PaneTile — live-updates on an OS
    // flip (nuance #1).
    if (theme === 'system') {
      const cleanup = listenSystemThemeChange((id) => {
        applyTheme('system');
        setResolvedThemeId(id);
      });
      return cleanup;
    }
  }, [theme]);

  // apply density on mount and when density changes (persisted via the saveUi effect)
  useEffect(() => {
    applyDensity(density);
  }, [density]);

  return null;
}
