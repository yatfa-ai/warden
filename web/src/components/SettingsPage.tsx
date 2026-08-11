import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { IconTooltip } from '@/components/ui/icon-tooltip';
import { ArrowLeft, RefreshCw, SearchIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { type HostLabels } from '@/lib/chatDisplay';

import { useBackendConfig } from '@/components/settings/useBackendConfig';
import { sectionPersistence } from '@/components/settings/sectionPersistence';
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
//
// `keywords` is the search corpus for the individual preference ROWS that live
// inside each section body (WARDEN-912). WARDEN-887 shipped search over
// label+description only, so ~74 already-delivered preferences reported
// "No matching sections." when searched by the name the product gives them
// (`scrollback`, `density`, `timestamp`, `tray`, `poll interval`, …) — the box
// looked wired and answered wrongly. Terms are transcribed from the row text
// that actually ships in `settings/sections/*` (including inline Switch rows
// with no <Label>, and Select option text), plus the obvious synonym a user
// would type for that same row. Keeping them adjacent to the section metadata
// keeps one legible corpus instead of scattering per-section exports.
// Invariant: adding a preference row means adding its term here.
const SETTINGS_SECTIONS = [
  {
    id: 'hosts',
    label: 'Hosts & Connection',
    description: 'Manage SSH hosts and connection settings for Warden.',
    keywords:
      'configured hosts, add host, remove host, display label per host, friendly name, host tag, ' +
      'dashboard refresh interval, poll interval, polling, refresh rate, ms, ' +
      'tmux session name, connect timeout, seconds, ssh',
  },
  {
    id: 'observer',
    label: 'Observer Preferences',
    description: 'Control the observer meta-chat: directive confirmation, auto-start, idle auto-stop, and its model.',
    keywords:
      'directive confirmation, auto-start observer, session auto-stop, idle timeout, minutes, ' +
      'observer model, base url, api endpoint, auth token, api key, secret, max output tokens',
  },
  {
    id: 'safety',
    label: 'Safety',
    description: 'Choose whether Warden confirms before destructive actions like force-killing a chat.',
    keywords: 'confirm before destructive actions, force-kill, kill chat, confirmation prompt, undo, dangerous',
  },
  {
    id: 'attention',
    label: 'Attention thresholds',
    description: 'Set how long an agent waits before Warden flags it as needing attention.',
    keywords: 'warning after minutes, critical after minutes, idle threshold, stale, needs attention, health',
  },
  {
    id: 'tokenbudget',
    label: 'Token budget',
    description: 'Configure token-budget alerts that notify you — they never auto-kill or pause agents.',
    keywords:
      'enable token-spend budget alerts, fleet threshold tokens, window hours, ' +
      'per-session threshold, spend, cost, usage alert',
  },
  {
    id: 'performance',
    label: 'Performance',
    description: 'Route remote tmux operations through a persistent SSH channel (experimental).',
    keywords:
      'companion transport, experimental, persistent ssh channel, remote tmux ops, ' +
      'capture, spawn, liveness, resize, env override, WARDEN_COMPANION_TRANSPORT',
  },
  {
    id: 'telemetry',
    label: 'Telemetry',
    description: 'Opt-in usage telemetry — off by default. Nothing leaves your machine until you turn it on.',
    keywords:
      'anonymous errors crashes and freezes, include chat and session names, ' +
      'receiver endpoint, receiver auth token, secret, privacy, opt-in, test connection',
  },
  {
    id: 'display',
    label: 'Display',
    description: 'Choose which badges and indicators Warden shows for hosts and chats.',
    keywords:
      'show host tags, local hostname badges, show type badges, shell claude yatfa labels, ' +
      'show status indicators, active idle dead dots, show project badges, hide offline hosts',
  },
  {
    id: 'appearance',
    label: 'Appearance',
    description: 'Theme, terminal font, and color preferences — applied instantly.',
    keywords:
      'terminal font size, terminal font family, custom font, nerd font, ' +
      'terminal scrollback lines, history buffer, ' +
      'theme, system follow os, dark, light, terminal color scheme, ' +
      'terminal cursor style, blinking block, steady underline, bar, ' +
      'copy on select, clipboard, select-to-copy, ' +
      'density, comfortable, compact, ' +
      'timestamp format, relative, absolute, time, ' +
      'pane layout, auto grid, stacked, side-by-side, ' +
      'when an agent exits, keep pane, dim pane, auto-close pane, ' +
      'auto-focus pane on open, restore workspace on startup, reopen previous, start empty, ' +
      'remember window position and size, launch at login, launch warden at login, start on boot, startup, ' +
      'close to tray, system tray, minimize to tray',
  },
  {
    id: 'newchats',
    label: 'New Chats',
    description: 'Set the defaults for new chats: agent type, host, shell, and working directory.',
    keywords:
      'default agent type, custom presets, preset, default host, ' +
      'default shell, shell per host, ' +
      'default working directory, cwd, working directory per host, agent type per host',
  },
  {
    id: 'snippets',
    label: 'Instruction snippets',
    description: 'Manage reusable instruction snippets for broadcasts and pane sends.',
    keywords: 'snippet name, instruction text, reusable, broadcast, pane send, macro, template',
  },
  {
    id: 'patterns',
    label: 'Watch patterns',
    description: 'Define watch patterns that flag matching agent output, matched server-side.',
    keywords: 'pattern name, pattern expression, match mode, text substring, regex, regular expression, watched chats, flag output',
  },
  {
    id: 'notifications',
    label: 'Notifications',
    description: 'Control toast, desktop, and webhook notifications for agent events.',
    keywords:
      'in-app toasts, chat operations, errors, success messages, observer events, ' +
      'desktop alerts when agents need attention, unfocused, permission, mute, bell, ' +
      'erroring, stuck, waiting on you, blocked, finished, ' +
      'critical agents, warning agents, pending directives, recent errors, ' +
      'enable webhook push, webhook url, shared secret, test alert, ' +
      'attention alert, token budget alert, finished alert',
  },
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
    config, setConfig, availableHosts, loading, loadError, reload, saving, handleSave, isDirty,
    resetting, resetBackendConfig,
    observerAuthTokenSet, observerAuthTokenTail, observerAuthTokenInput, setObserverAuthTokenInput,
    observerAuthTokenPendingClear, removeObserverAuthToken, undoRemoveObserverAuthToken,
    webhookSecretSet, webhookSecretTail, webhookSecretInput, setWebhookSecretInput,
    webhookSecretPendingClear, removeWebhookSecret, undoRemoveWebhookSecret,
    testingWebhook, sendTestAlert,
    telemetryAuthTokenSet, telemetryAuthTokenTail, telemetryAuthTokenInput, setTelemetryAuthTokenInput,
    telemetryAuthTokenPendingClear, removeTelemetryAuthToken, undoRemoveTelemetryAuthToken,
    telemetryTestLoading, telemetryTestVerdict, setTelemetryTestVerdict, sendTestConnection, telemetryRuntimeStatus,
  } = useBackendConfig({ onSaved: () => { onConfigChange(); onClose(); }, onConfigChange });

  // Active section in the master-detail nav. The first section is selected by
  // default; switching shows only that section, so there's no cross-section
  // page-level scroll. Persisting across visits is intentionally not done.
  const [activeSection, setActiveSection] = useState<SectionId>('hosts');

  // WARDEN-906 — leaving with unsaved BACKEND edits used to drop them silently:
  // both exits (Back, Cancel) called `onClose` with no dirty check, so a typed
  // webhook URL / observer model / attention threshold vanished on a misclick.
  // Now both go through `requestClose`, which raises the same ConfirmDialog the
  // danger zone uses when `isDirty`, and closes immediately when it is not (no
  // friction on the common "opened, looked, left" path).
  //
  // Scope note: `isDirty` comes from useBackendConfig, so it covers ONLY the
  // /api/config draft. The instant client-pref sections (Appearance / NewChats /
  // Snippets) persist through App's saveUi effect the moment they change and are
  // never "unsaved" — they cannot raise this dialog. The save-then-close path is
  // clean too: handleSave re-baselines before firing onSaved.
  const [discardOpen, setDiscardOpen] = useState(false);
  const requestClose = () => {
    if (isDirty) setDiscardOpen(true);
    else onClose();
  };
  const confirmDiscard = () => {
    setDiscardOpen(false);
    onClose();
  };

  // Section search: a case-insensitive substring match over each section's
  // label, description AND keyword corpus, so any preference is findable by
  // term (e.g. `font`→Appearance, `kill`→Safety, `webhook`→Notifications,
  // `scrollback`/`density`/`tray`→Appearance, `poll`→Hosts). Pure UI over
  // the static SETTINGS_SECTIONS metadata — adds no preferences, touches no
  // config/persistence, so it cannot disturb the client-pref / PUT /api/config
  // invariant. When the query hides the active section, the content pane stays
  // put until the user picks a match (VS-Code-style filter-then-click).
  const [search, setSearch] = useState('');
  const q = search.trim().toLowerCase();
  const matches =
    q === ''
      ? SETTINGS_SECTIONS
      : SETTINGS_SECTIONS.filter(
          (s) =>
            s.label.toLowerCase().includes(q) ||
            s.description.toLowerCase().includes(q) ||
            s.keywords.toLowerCase().includes(q),
        );
  // The narrow-screen Select resolves its trigger label from the rendered item
  // matching `value`; if the active section is filtered out of the list the
  // trigger would go blank, so always include the active section here.
  const matchIds = new Set(matches.map((s) => s.id));
  const selectItems = SETTINGS_SECTIONS.filter((s) => matchIds.has(s.id) || s.id === activeSection);

  // The active section's persistence model, shown in the footer so Save/Cancel
  // stop lying on the instant client-pref sections (Appearance/NewChats/
  // Snippets). See sectionPersistence.ts (WARDEN-870).
  const persistence = sectionPersistence(activeSection);

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <header className="flex items-center gap-2 px-3 h-11 border-b shrink-0">
        <IconTooltip label="Back to dashboard" side="bottom">
          <Button variant="ghost" size="icon-sm" onClick={requestClose} aria-label="Back to dashboard">
            <ArrowLeft />
          </Button>
        </IconTooltip>
        <h1 className="text-sm font-semibold tracking-wide">Settings</h1>
        {!q && (
          <span className="min-w-0 truncate text-xs text-muted-foreground">
            {SETTINGS_SECTIONS.find((s) => s.id === activeSection)?.description}
          </span>
        )}
        {/* Section search — filters the wide-screen rail and the narrow-screen
            dropdown by label+description (see `matches`/`selectItems` above).
            Leading SearchIcon uses the established icon-input convention
            (relative wrapper, absolute affordance, padded input). */}
        <div className="relative ml-auto w-40 sm:w-64">
          <SearchIcon className="pointer-events-none absolute left-2 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search settings…"
            aria-label="Search settings"
            className="pl-8"
          />
        </div>
      </header>

      <div className="flex flex-1 min-h-0">
        {/* Section nav rail — wide screens (md+). A VS Code-style master-detail
            left rail: pick a section, see only that section in the content pane. */}
        <nav aria-label="Settings sections" className="hidden w-56 shrink-0 flex-col gap-1 overflow-y-auto border-r p-2 md:flex">
          {matches.length === 0 ? (
            <p className="px-2 py-4 text-xs text-muted-foreground">No matching sections.</p>
          ) : (
            matches.map((s) => (
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
            ))
          )}
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
                {selectItems.map((s) => (
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
              {loadError ? (
                // WARDEN-828 — bounded load failure. The config GET exhausted its
                // timeout + retry, so we surface a clear Retry instead of an
                // infinite spinner. Save stays disabled (see footer) so a stale
                // default config can never clobber the real one on a failed load.
                <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
                  <p className="max-w-sm text-sm text-muted-foreground">{loadError.message}</p>
                  <Button variant="outline" onClick={reload} disabled={loading}>
                    <RefreshCw className="h-4 w-4" /> Try again
                  </Button>
                </div>
              ) : loading ? (
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
                    observerAuthTokenPendingClear={observerAuthTokenPendingClear}
                    removeObserverAuthToken={removeObserverAuthToken}
                    undoRemoveObserverAuthToken={undoRemoveObserverAuthToken}
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
                    telemetryAuthTokenPendingClear={telemetryAuthTokenPendingClear}
                    removeTelemetryAuthToken={removeTelemetryAuthToken}
                    undoRemoveTelemetryAuthToken={undoRemoveTelemetryAuthToken}
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
                    webhookSecretPendingClear={webhookSecretPendingClear}
                    removeWebhookSecret={removeWebhookSecret}
                    undoRemoveWebhookSecret={undoRemoveWebhookSecret}
                    testingWebhook={testingWebhook}
                    sendTestAlert={sendTestAlert}
                    hidden={activeSection !== 'notifications'}
                  />
                  <ResetSection
                    resetUiPrefsToDefaults={resetUiPrefsToDefaults}
                    resettingBackend={resetting}
                    onResetBackendConfig={resetBackendConfig}
                  />
                </>
              )}
            </div>
          </div>
        </main>
      </div>

      <footer className="flex items-center justify-end gap-2 px-4 h-14 border-t shrink-0">
        {/* Persistence indicator (WARDEN-870). States the active section's
            persistence model so Save/Cancel stop reading as undo/commit on the
            instant client-pref sections (Appearance/NewChats/Snippets), mirroring
            the in-section labels WARDEN-784 added to NotificationsSection. Hidden
            while config is loading/failed — a server-config section can't commit
            during a failed load, and Save is already disabled then. `mr-auto`
            parks the label left while the buttons stay right; `min-w-0 truncate`
            keeps it from crowding the buttons on narrow screens (full text on
            hover via title). */}
        {!(loading || loadError) && (
          <span
            className="mr-auto min-w-0 truncate text-xs text-muted-foreground"
            title={persistence.label}
          >
            {persistence.label}
          </span>
        )}
        <Button variant="outline" onClick={requestClose} disabled={saving}>
          Cancel
        </Button>
        <Button onClick={handleSave} disabled={saving || loading || !!loadError}>
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </footer>

      {/* WARDEN-906 — the unsaved-backend-edits guard for both exits. Not marked
          `destructive`: discarding a draft is reversible-by-retyping, not a
          delete, so it uses the default (non-red) confirm styling — the danger
          zone's red is reserved for the actual destructive resets. */}
      <ConfirmDialog
        open={discardOpen}
        onOpenChange={(o) => { if (!o) setDiscardOpen(false); }}
        title="Discard unsaved changes?"
        description="Your edits to the server configuration haven't been saved. Leaving now discards them. Appearance and other instantly-applied preferences are unaffected."
        confirmLabel="Discard changes"
        cancelLabel="Keep editing"
        onConfirm={confirmDiscard}
      />
    </div>
  );
}
