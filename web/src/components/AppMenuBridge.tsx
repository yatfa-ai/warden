import { useEffect } from 'react';
import { onOpenSettings, onSelectAll } from '@/lib/electron';
import { getFeatureUsageSampler } from '@/lib/featureUsageTelemetry';
import { routeMenuSelectAll, TERMINAL_SELECT_ALL_EVENT } from '@/lib/terminalEdit';
import { useSetSettingsOpen } from '@/lib/uiStore';

// WARDEN-1671 (client-state slice 46): the application menu's Settings… and
// Edit ▸ Select All push subscriptions, extracted from App.tsx. Null-rendering
// and ALWAYS mounted (App renders it OUTSIDE the settings ternary): Select All's
// editable route serves a focused Settings field, and the Settings… push must
// work while Settings is already open.
export function AppMenuBridge() {
  const setSettingsOpen = useSetSettingsOpen();
  // WARDEN-1280 — the application menu's "Settings…" (CmdOrCtrl+,) item. Until
  // now the gear button below was the SOLE way into Settings; the menu item is
  // the second, and it is deliberately the SAME destination rather than a
  // parallel one — main pushes 'menu:open-settings' on the click and this effect
  // calls the exact setSettingsOpen(true) the gear calls. Runs once (the setter
  // identity is stable), and outside the Electron app onOpenSettings finds no
  // bridge and returns a no-op unsubscribe, so the `npm run dev` browser and
  // `node web/smoke.cjs` are byte-unaffected — neither has an application menu
  // to fire it.
  useEffect(() => onOpenSettings(() => {
    getFeatureUsageSampler().sampler.recordFeatureUse('settings');
    setSettingsOpen(true);
  }), []);
  // WARDEN-1356 — the application menu's Edit ▸ Select All item. The item is a
  // wired click (the bare role is inert on the agent-pane surface: xterm's
  // helper textarea is empty and webContents.selectAll() fires no DOM event the
  // pane could intercept), so main pushes 'menu:select-all' — the same bridge
  // shape as Settings above — and this effect routes by REAL DOM focus:
  //   terminal → broadcast to the panes; the one whose textarea is the active
  //              element claims it and calls term.selectAll();
  //   editable → a Settings (or other) field has focus;
  //              document.execCommand('selectAll') reproduces the role's
  //              native behaviour there, which is what keeps the item honest
  //              off the pane surface;
  //   none     → nothing editable has focus; a no-op, same as the role's
  //              select-nothing today.
  // DOM focus, not the focusedChat state, decides — focusedChat can still name
  // a pane while a Settings search field actually holds the keyboard, and the
  // role this replaces acted on real focus too. Runs once; outside the
  // Electron app onSelectAll finds no bridge and returns a no-op unsubscribe.
  useEffect(() => onSelectAll(() => {
    const route = routeMenuSelectAll(document.activeElement);
    if (route === 'terminal') {
      window.dispatchEvent(new CustomEvent(TERMINAL_SELECT_ALL_EVENT));
    } else if (route === 'editable') {
      document.execCommand('selectAll');
    }
  }), []);
  return null;
}
