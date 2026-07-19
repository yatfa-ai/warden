import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { IconTooltip } from '@/components/ui/icon-tooltip';
import { ArrowLeft } from 'lucide-react';
import { cn } from '@/lib/utils';
import { type HostLabels } from '@/lib/chatDisplay';

import { useBackendConfig } from '@/components/settings/useBackendConfig';
import {
  type AppearancePrefs,
  type NewChatsPrefs,
  type SnippetsPrefs,
  type DesktopAlertPrefs,
} from '@/components/settings/types';

import { HostsSection } from '@/components/settings/sections/HostsSection';
import { ObserverSection } from '@/components/settings/sections/ObserverSection';
import { SafetySection } from '@/components/settings/sections/SafetySection';
import { AttentionThresholdsSection } from '@/components/settings/sections/AttentionThresholdsSection';
import { TokenBudgetSection } from '@/components/settings/sections/TokenBudgetSection';
import { PerformanceSection } from '@/components/settings/sections/PerformanceSection';
import { TelemetrySection } from '@/components/settings/sections/TelemetrySection';
import { DisplaySection } from '@/components/settings/sections/DisplaySection';
import { AppearanceSection } from '@/components/settings/sections/AppearanceSection';
import { NewChatsSection } from '@/components/settings/sections/NewChatsSection';
import { SnippetsSection } from '@/components/settings/sections/SnippetsSection';
import { PatternsSection } from '@/components/settings/sections/PatternsSection';
import { NotificationsSection } from '@/components/settings/sections/NotificationsSection';
import { ResetSection } from '@/components/settings/sections/ResetSection';

// The settings section nav entries: a left rail on wide screens, a dropdown on
// narrow ones. Order is the display order; the first entry is active by default.
// The `id` doubles as the active-section discriminator — each section component
// hides itself unless its id matches `activeSection`. (Reset is intentionally
// absent here: it is always visible at the bottom of the content pane, outside
// the activeSection gating.)
const SETTINGS_SECTIONS = [
  { id: 'hosts', label: 'Hosts & Connection', description: 'Manage SSH hosts and connection settings for Warden.' },
  { id: 'observer', label: 'Observer Preferences', description: 'Control the observer meta-chat: directive confirmation, auto-start, idle auto-stop, and its model.' },
  { id: 'safety', label: 'Safety', description: 'Choose whether Warden confirms before destructive actions like force-killing a chat.' },
  { id: 'attention', label: 'Attention thresholds', description: 'Set how long an agent waits before Warden flags it as needing attention.' },
  { id: 'tokenbudget', label: 'Token budget', description: 'Configure token-budget alerts that notify you — they never auto-kill or pause agents.' },
  { id: 'performance', label: 'Performance', description: 'Route remote tmux operations through a persistent SSH channel (experimental).' },
  { id: 'telemetry', label: 'Telemetry', description: 'Opt-in usage telemetry — off by default. Nothing leaves your machine until you turn it on.' },
  { id: 'display', label: 'Display', description: 'Choose which badges and indicators Warden shows for hosts and chats.' },
  { id: 'appearance', label: 'Appearance', description: 'Theme, terminal font, and color preferences — applied instantly.' },
  { id: 'newchats', label: 'New Chats', description: 'Set the defaults for new chats: agent type, host, shell, and working directory.' },
  { id: 'snippets', label: 'Instruction snippets', description: 'Manage reusable instruction snippets for broadcasts and pane sends.' },
  { id: 'patterns', label: 'Watch patterns', description: 'Define watch patterns that flag matching agent output, matched server-side.' },
  { id: 'notifications', label: 'Notifications', description: 'Control toast, desktop, and webhook notifications for agent events.' },
] as const;
type SectionId = (typeof SETTINGS_SECTIONS)[number]['id'];

interface Props {
  /** Return to the dashboard without saving backend config. */
  onClose: () => void;
  onConfigChange: () => void;
  // Per-section client-pref groups (partitioned from the prior flat ~70-prop
  // wall — WARDEN-664). Each group is spread straight through to its section
  // component. Backend /api/config fields are NOT here — they live in the
  // useBackendConfig seam and never round-trip through App, which is what makes
  // the "client pref never reaches PUT /api/config" invariant structural.
  appearance: AppearancePrefs;
  newChats: NewChatsPrefs;
  snippets: SnippetsPrefs;
  alerts: DesktopAlertPrefs;
  hostLabels: HostLabels;
  setHostLabels: (v: HostLabels) => void;
  resetUiPrefsToDefaults: () => void;
}

/**
 * A thin shell over the per-section components (WARDEN-664). Owns only the
 * master-detail nav (activeSection state + the section rail/picker) and the
 * save/cancel footer; everything else — the backend `/api/config` persistence
 * boundary, the client-pref bodies, the row editors — lives in the
 * `settings/` tree. All sections stay mounted and toggle visibility via the
 * `hidden` class (so editing a draft then switching sections then switching
 * back preserves the draft — behavior unchanged from the prior god-component).
 */
export function SettingsPage({
  onClose,
  onConfigChange,
  appearance,
  newChats,
  snippets,
  alerts,
  hostLabels,
  setHostLabels,
  resetUiPrefsToDefaults,
}: Props) {
  // The backend /api/config persistence seam: GET on mount, PUT on Save, the
  // write-only secrets, the live test/runtime status. onSaved fires after a
  // successful PUT (App's config refresh + close) — matching the prior behavior.
  const {
    config, setConfig, availableHosts, loading, saving, handleSave,
    observerAuthTokenSet, observerAuthTokenTail, observerAuthTokenInput, setObserverAuthTokenInput,
    webhookSecretSet, webhookSecretTail, webhookSecretInput, setWebhookSecretInput, testingWebhook, sendTestAlert,
    telemetryAuthTokenSet, telemetryAuthTokenTail, telemetryAuthTokenInput, setTelemetryAuthTokenInput,
    telemetryTestLoading, telemetryTestVerdict, setTelemetryTestVerdict, sendTestConnection, telemetryRuntimeStatus,
  } = useBackendConfig({ onSaved: () => { onConfigChange(); onClose(); } });

  // Active section in the master-detail nav. The first section is selected by
  // default; switching shows only that section, so there's no cross-section
  // page-level scroll. Persisting across visits is intentionally not done.
  const [activeSection, setActiveSection] = useState<SectionId>('hosts');

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <header className="flex items-center gap-2 px-3 h-11 border-b shrink-0">
        <IconTooltip label="Back to dashboard" side="bottom">
          <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Back to dashboard">
            <ArrowLeft />
          </Button>
        </IconTooltip>
        <h1 className="text-sm font-semibold tracking-wide">Settings</h1>
        <span className="text-xs text-muted-foreground">
          {SETTINGS_SECTIONS.find((s) => s.id === activeSection)?.description}
        </span>
      </header>

      <div className="flex flex-1 min-h-0">
        {/* Section nav rail — wide screens (md+). A VS Code-style master-detail
            left rail: pick a section, see only that section in the content pane. */}
        <nav aria-label="Settings sections" className="hidden w-56 shrink-0 flex-col gap-1 overflow-y-auto border-r p-2 md:flex">
          {SETTINGS_SECTIONS.map((s) => (
            <Button
              key={s.id}
              variant="ghost"
              size="sm"
              className={cn(
                'w-full justify-start',
                activeSection === s.id && 'bg-accent font-medium text-accent-foreground hover:bg-accent hover:text-accent-foreground',
              )}
              onClick={() => setActiveSection(s.id)}
              aria-current={activeSection === s.id ? 'page' : undefined}
            >
              {s.label}
            </Button>
          ))}
        </nav>
        <main className="flex min-w-0 min-h-0 flex-1 flex-col">
          {/* Compact section picker — narrow screens (<md). The rail would crowd
              content below ~768px, so it collapses to a dropdown here. Same
              `activeSection` state as the rail; the two never show at once. */}
          <div className="shrink-0 border-b px-4 pb-3 pt-4 md:hidden">
            <Select value={activeSection} onValueChange={(v) => setActiveSection(v as SectionId)}>
              <SelectTrigger className="w-full" aria-label="Settings section">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SETTINGS_SECTIONS.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {/* Content pane — scrolls the ACTIVE section only (no cross-section
              page scroll). Left-aligned with a readable cap so wide screens use
              the horizontal space via nav+pane, not a centered narrow column.
              All sections stay mounted (toggled via the `hidden` class) so their
              local draft state survives a section switch. */}
          <div className="flex-1 min-h-0 overflow-y-auto">
            <div className="flex max-w-4xl flex-col gap-6 px-4 py-6 md:px-6">
              {loading ? (
                <div className="py-8 text-center text-sm text-muted-foreground">Loading configuration…</div>
              ) : (
                <>
                  <HostsSection
                    config={config}
                    setConfig={setConfig}
                    hostLabels={hostLabels}
                    setHostLabels={setHostLabels}
                    availableHosts={availableHosts}
                    hidden={activeSection !== 'hosts'}
                  />
                  <ObserverSection
                    config={config}
                    setConfig={setConfig}
                    observerAuthTokenSet={observerAuthTokenSet}
                    observerAuthTokenTail={observerAuthTokenTail}
                    observerAuthTokenInput={observerAuthTokenInput}
                    setObserverAuthTokenInput={setObserverAuthTokenInput}
                    hidden={activeSection !== 'observer'}
                  />
                  <SafetySection config={config} setConfig={setConfig} hidden={activeSection !== 'safety'} />
                  <AttentionThresholdsSection config={config} setConfig={setConfig} hidden={activeSection !== 'attention'} />
                  <TokenBudgetSection config={config} setConfig={setConfig} hidden={activeSection !== 'tokenbudget'} />
                  <PerformanceSection config={config} setConfig={setConfig} hidden={activeSection !== 'performance'} />
                  <TelemetrySection
                    config={config}
                    setConfig={setConfig}
                    telemetryAuthTokenSet={telemetryAuthTokenSet}
                    telemetryAuthTokenTail={telemetryAuthTokenTail}
                    telemetryAuthTokenInput={telemetryAuthTokenInput}
                    setTelemetryAuthTokenInput={setTelemetryAuthTokenInput}
                    telemetryTestLoading={telemetryTestLoading}
                    telemetryTestVerdict={telemetryTestVerdict}
                    setTelemetryTestVerdict={setTelemetryTestVerdict}
                    sendTestConnection={sendTestConnection}
                    telemetryRuntimeStatus={telemetryRuntimeStatus}
                    hidden={activeSection !== 'telemetry'}
                  />
                  <DisplaySection config={config} setConfig={setConfig} hidden={activeSection !== 'display'} />
                  <AppearanceSection {...appearance} hidden={activeSection !== 'appearance'} />
                  <NewChatsSection {...newChats} availableHosts={availableHosts} hidden={activeSection !== 'newchats'} />
                  <SnippetsSection {...snippets} hidden={activeSection !== 'snippets'} />
                  <PatternsSection config={config} setConfig={setConfig} hidden={activeSection !== 'patterns'} />
                  <NotificationsSection
                    {...alerts}
                    config={config}
                    setConfig={setConfig}
                    webhookSecretSet={webhookSecretSet}
                    webhookSecretTail={webhookSecretTail}
                    webhookSecretInput={webhookSecretInput}
                    setWebhookSecretInput={setWebhookSecretInput}
                    testingWebhook={testingWebhook}
                    sendTestAlert={sendTestAlert}
                    hidden={activeSection !== 'notifications'}
                  />
                  <ResetSection resetUiPrefsToDefaults={resetUiPrefsToDefaults} />
                </>
              )}
            </div>
          </div>
        </main>
      </div>

      <footer className="flex items-center justify-end gap-2 px-4 h-14 border-t shrink-0">
        <Button variant="outline" onClick={onClose} disabled={saving}>
          Cancel
        </Button>
        <Button onClick={handleSave} disabled={saving || loading}>
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </footer>
    </div>
  );
}
