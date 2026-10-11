import type { ReactNode } from 'react';
import { ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem, ContextMenuSeparator } from '@/components/ui/context-menu';
import { getFeatureUsageSampler } from '@/lib/featureUsageTelemetry';
import {
  useSidebarCollapsed, useObserverCollapsed, useHealthCollapsed,
  useSetHealthCollapsed, useToggleSidebarCollapsed, useToggleObserverCollapsed,
  useSetGlobalSearchOpen, useSetSettingsOpen,
} from '@/lib/uiStore';

/**
 * AppHeaderMenu — the main app header strip (WARDEN-1748, roadmap WARDEN-362)
 * wrapped in the themed right-click menu. The <header> lives HERE (asChild =
 * zero extra DOM, classNames unchanged) so this component can subscribe to the
 * three collapse flags itself and a toggle never re-renders App (WARDEN-1645).
 *
 * Every item calls the same store action/handler as its header button. The
 * sidebar/observer items only call the store action — PanelLayoutSync owns their
 * expand ticks, so recording here would double-count. The Health item records
 * 'panel-expand-health' on collapsed→expanded only, exactly as the Health
 * button does (PanelToggleButtons.tsx). No own context-menu handler and no
 * event-swallowing: WorkspaceTabs' per-tab menus (nested deeper) keep winning.
 */
export function AppHeaderMenu({ children }: { children: ReactNode }) {
  const sidebarCollapsed = useSidebarCollapsed();
  const observerCollapsed = useObserverCollapsed();
  const healthCollapsed = useHealthCollapsed();
  const toggleSidebar = useToggleSidebarCollapsed();
  const toggleObserver = useToggleObserverCollapsed();
  const setHealthCollapsed = useSetHealthCollapsed();
  const setGlobalSearchOpen = useSetGlobalSearchOpen();
  const setSettingsOpen = useSetSettingsOpen();
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <header className="flex items-center gap-3 px-3 h-11 border-b shrink-0">
          {children}
        </header>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={() => { toggleSidebar(); }}>{sidebarCollapsed ? 'Show sidebar' : 'Hide sidebar'}</ContextMenuItem>
        <ContextMenuItem onSelect={() => { if (healthCollapsed) getFeatureUsageSampler().sampler.recordFeatureUse('panel-expand-health'); setHealthCollapsed(!healthCollapsed); }}>{healthCollapsed ? 'Show Health panel' : 'Hide Health panel'}</ContextMenuItem>
        <ContextMenuItem onSelect={() => { toggleObserver(); }}>{observerCollapsed ? 'Show observer' : 'Hide observer'}</ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => setGlobalSearchOpen(true)}>Search…</ContextMenuItem>
        <ContextMenuItem onSelect={() => { getFeatureUsageSampler().sampler.recordFeatureUse('settings'); setSettingsOpen(true); }}>Settings…</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
