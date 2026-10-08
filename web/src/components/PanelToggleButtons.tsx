import { IconTooltip } from '@/components/ui/icon-tooltip';
import { getFeatureUsageSampler } from '@/lib/featureUsageTelemetry';
import {
  useSidebarCollapsed, useObserverCollapsed, useHealthCollapsed,
  useSetHealthCollapsed, useToggleSidebarCollapsed, useToggleObserverCollapsed,
} from '@/lib/uiStore';

// WARDEN-1645 (client-state slice 42): the three header panel-toggle buttons,
// extracted from App.tsx so each subscribes to its own collapse flag (a toggle
// re-renders only the buttons, not App). One instance per header position: the
// sidebar button sits at the far left of the header, health/observer in the
// right-hand cluster — DOM order and classNames are unchanged.
const BTN = 'text-muted-foreground hover:text-foreground transition-all duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background rounded px-1.5 py-0.5 hover:bg-accent/50';

export type PanelToggleKind = 'sidebar' | 'health' | 'observer';

function SidebarToggle() {
  const collapsed = useSidebarCollapsed();
  const toggle = useToggleSidebarCollapsed();
  return <IconTooltip label="toggle sidebar" side="bottom"><button onClick={() => { toggle(); }} className={BTN}>{collapsed ? '▸' : '◂'}</button></IconTooltip>;
}

function HealthToggle() {
  const collapsed = useHealthCollapsed();
  const setCollapsed = useSetHealthCollapsed();
  return <IconTooltip label="toggle health panel" side="bottom"><button onClick={() => { if (collapsed) getFeatureUsageSampler().sampler.recordFeatureUse('panel-expand-health'); setCollapsed(!collapsed); }} className={BTN}>{collapsed ? '◂' : '▸'} Health</button></IconTooltip>;
}

function ObserverToggle() {
  const collapsed = useObserverCollapsed();
  const toggle = useToggleObserverCollapsed();
  return <IconTooltip label="toggle observer" side="bottom"><button onClick={() => { toggle(); }} className={BTN}>{collapsed ? '◂' : '▸'}</button></IconTooltip>;
}

export function PanelToggleButtons({ panel }: { panel: PanelToggleKind }) {
  if (panel === 'sidebar') return <SidebarToggle />;
  if (panel === 'health') return <HealthToggle />;
  return <ObserverToggle />;
}
