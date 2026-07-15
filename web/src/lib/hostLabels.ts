// React wiring for per-host display labels (WARDEN-490).
//
// hostTagOf / hostLabelFor (the pure funnel + label resolver) live in
// chatDisplay.ts; THIS module is the React context that carries the hostLabels
// UiState pref to every host-tag display surface WITHOUT prop-drilling through
// intermediate components (PaneGrid → PaneTile → Kill/Broadcast/Collision
// dialogs; ChatSidebar → ChatRow/OpenPaneRow; ObserverTabs → ActivityTimeline /
// DirectiveHistory / SessionTranscriptViewer; HealthDashboard's group header +
// agent rows). App owns the pref and provides it once at the root; each leaf
// surface calls useHostLabels() and passes the result to hostTagOf/hostLabelFor.
//
// Default is undefined: a subtree with no provider (or any surface rendered
// before App mounts its provider) resolves labels=undefined, which
// hostTagOf/hostLabelFor treat as "no labels" → byte-identical to today.

import { createContext, useContext } from 'react';
import type { HostLabels } from '@/lib/chatDisplay';

// The hostLabels pref, or undefined when no provider wraps the subtree. Callers
// pass this straight to hostTagOf(host, labels) / hostLabelFor(host, labels),
// which no-op cleanly on undefined.
export const HostLabelsContext = createContext<HostLabels | undefined>(undefined);

// Read the current host-labels map. Returns undefined outside a provider, which
// the pure funnel helpers treat as "no labels" (today's behavior).
export function useHostLabels(): HostLabels | undefined {
  return useContext(HostLabelsContext);
}
