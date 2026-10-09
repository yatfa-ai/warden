import { HealthDashboard } from '@/components/HealthDashboard';
import { HEALTH_WIDTH } from '@/lib/layout';
import { useCompanionTransportEnabled } from '@/lib/appConfigHooks';
import { useHealthCollapsed, useSetHealthCollapsed } from '@/lib/uiStore';

// WARDEN-1645 (client-state slice 42): the collapsible health column, extracted
// from App.tsx so the collapse flag is read here (width/opacity) and the close
// button is a store write — a toggle re-renders only this wrapper, not App.
export interface HealthPanelProps {
  onOpenChat: (id: string) => void;
  pollIntervalMs: number;
}

export function HealthPanel({ onOpenChat, pollIntervalMs }: HealthPanelProps) {
  const companionTransportEnabled = useCompanionTransportEnabled();
  const healthCollapsed = useHealthCollapsed();
  const setHealthCollapsed = useSetHealthCollapsed();
  return (
    <section className="border-l min-h-0 transition-all duration-200 ease-in-out overflow-hidden"
      style={{ width: healthCollapsed ? 0 : HEALTH_WIDTH, flexShrink: 0, opacity: healthCollapsed ? 0 : 1 }}>
      <HealthDashboard
        onOpenChat={onOpenChat}
        onClose={() => setHealthCollapsed(true)}
        pollIntervalMs={pollIntervalMs}
        companionTransportEnabled={companionTransportEnabled}
      />
    </section>
  );
}
