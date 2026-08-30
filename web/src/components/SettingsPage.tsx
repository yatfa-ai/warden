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
import { sectionGate, canSaveBackendConfig } from '@/components/settings/sectionLoadGate';
import {
  SETTINGS_SECTIONS,
  searchSections,
  normalizeSearchText,
  type SectionId,
} from '@/components/settings/sectionSearch';
import { SettingsSection } from '@/components/settings/SettingsSection';
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

// The section Settings opens on (WARDEN-976). Deliberately decoupled from the
// rail ORDER — which is unchanged — because the landing section is now chosen
// for how fast it is usable, not for where it sits in the list. Appearance is a
// client-localStorage section: it needs no network, so it is fully interactive
// on the first frame even while the `/api/config` GET is still in flight.
const LANDING_SECTION: SectionId = 'appearance';


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
    config, setConfig, availableHosts, loading, loadError, configLoaded, reload, saving, handleSave, isDirty,
    resetting, resetBackendConfig,
    observerAuthTokenSet, observerAuthTokenTail, observerAuthTokenInput, setObserverAuthTokenInput,
    observerAuthTokenPendingClear, removeObserverAuthToken, undoRemoveObserverAuthToken,
    webhookSecretSet, webhookSecretTail, webhookSecretInput, setWebhookSecretInput,
    webhookSecretPendingClear, removeWebhookSecret, undoRemoveWebhookSecret,
    testingWebhook, sendTestAlert, webhookTestVerdict, setWebhookTestVerdict,
    telemetryAuthTokenSet, telemetryAuthTokenTail, telemetryAuthTokenInput, setTelemetryAuthTokenInput,
    telemetryAuthTokenPendingClear, removeTelemetryAuthToken, undoRemoveTelemetryAuthToken,
    telemetryTestLoading, telemetryTestVerdict, setTelemetryTestVerdict, sendTestConnection, telemetryRuntimeStatus,
  } = useBackendConfig({ onSaved: () => { onConfigChange(); onClose(); }, onConfigChange });

  // Active section in the master-detail nav. Switching shows only that section,
  // so there's no cross-section page-level scroll. Persisting across visits is
  // intentionally not done. Lands on LANDING_SECTION (Appearance) — usable with
  // no network, so Settings is interactive on the first frame (WARDEN-976).
  const [activeSection, setActiveSection] = useState<SectionId>(LANDING_SECTION);

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

  // Section search: a case- AND punctuation-insensitive substring match over
  // each section's label, description AND per-row keyword corpus, so any
  // preference is findable both by a fragment (`font`→Appearance,
  // `kill`→Safety, `webhook`→Notifications, `scrollback`/`density`/`tray`→
  // Appearance, `poll`→Hosts) and by its full on-screen name, punctuation and
  // all (`Terminal scrollback (lines)`, `Anonymous errors, crashes & freezes`).
  // Pure UI over the static SETTINGS_SECTIONS metadata — adds no preferences,
  // touches no config/persistence, so it cannot disturb the client-pref /
  // PUT /api/config invariant. When the query hides the active section, the
  // content pane stays put until the user picks a match (VS-Code-style
  // filter-then-click). See sectionSearch.ts (WARDEN-912).
  const [search, setSearch] = useState('');
  // Normalized here too so a punctuation-only query ('???') counts as empty for
  // the header description and reveals all sections, exactly like a blank box.
  const q = normalizeSearchText(search);
  const matches = searchSections(search);
  // The narrow-screen Select resolves its trigger label from the rendered item
  // matching `value`; if the active section is filtered out of the list the
  // trigger would go blank, so always include the active section here.
  const matchIds = new Set(matches.map((s) => s.id));
  const selectItems = SETTINGS_SECTIONS.filter((s) => matchIds.has(s.id) || s.id === activeSection);

  // The active section's persistence model, shown in the footer so Save/Cancel
  // stop lying on the instant client-pref sections (Appearance/NewChats/
  // Snippets). See sectionPersistence.ts (WARDEN-870).
  const persistence = sectionPersistence(activeSection);

  // WARDEN-976 — per-section readiness, replacing the old full-pane load gate.
  // `gate` describes only what the ACTIVE section needs: a client-pref section
  // is always 'ready' (its values are client localStorage, already on screen),
  // a backend-config section is 'pending'/'failed' until the config GET
  // resolves. Both keys come from sectionLoadGate.ts, which reads the same
  // CLIENT_PREF_SECTIONS classification the footer label above uses.
  const gate = sectionGate(activeSection, { configLoaded, loadFailed: !!loadError });
  const activeMeta = SETTINGS_SECTIONS.find((s) => s.id === activeSection);

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
            {activeMeta?.description}
          </span>
        )}
        {/* Section search — filters the wide-screen rail and the narrow-screen
            dropdown by label+description+keywords (see `matches`/`selectItems` above).
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
              local draft state survives a section switch.

              WARDEN-976 — there is NO full-pane load gate here any more. The
              client-pref sections (Appearance/NewChats/Snippets) and the danger
              zone mount unconditionally and are fully operable while the config
              GET is still in flight; only the backend-config sections wait, and
              they wait IN PLACE via the pending/retry block below. */}
          <div className="flex-1 min-h-0 overflow-y-auto">
            <div className="flex max-w-4xl flex-col gap-6 px-4 py-6 md:px-6">
              {/* Instant client-localStorage sections — never gated on the
                  backend. These are the three ids in CLIENT_PREF_SECTIONS
                  (sectionPersistence.ts), the same classification the footer
                  label and sectionGate() read. `availableHosts` settles on its
                  own decoupled fetch (WARDEN-828) and degrades to the configured
                  hosts, so NewChats does not wait on it either. */}
              <AppearanceSection {...appearance} hidden={activeSection !== 'appearance'} />
              <NewChatsSection {...newChats} availableHosts={availableHosts} hidden={activeSection !== 'newchats'} />
              <SnippetsSection {...snippets} hidden={activeSection !== 'snippets'} />

              {/* Backend-config sections. Mounted only once a GET /api/config
                  has succeeded — before that their values are unknown, and
                  rendering them against DEFAULT_CONFIG would show wrong values
                  and invite a Save that clobbers the real persisted config.
                  Once mounted they stay mounted, so drafts survive a switch. */}
              {configLoaded ? (
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
                    webhookTestVerdict={webhookTestVerdict}
                    setWebhookTestVerdict={setWebhookTestVerdict}
                    hidden={activeSection !== 'notifications'}
                  />
                </>
              ) : (
                // The in-place stand-in for whichever backend-config section is
                // active while its values are unknown. It carries that section's
                // own title, so the page reads as "this section is still
                // loading" rather than "Settings is loading" — the neighbouring
                // sections stay usable behind it. Hidden outright when the
                // active section is a client-pref one (gate === 'ready'), which
                // is what keeps those three off the backend's critical path.
                //
                // WARDEN-828's bounded-failure contract is preserved verbatim:
                // the retry affordance and its message still appear, and Retry
                // still works — it is only scoped to the sections that need it.
                <SettingsSection
                  title={activeMeta?.label ?? 'Settings'}
                  className={gate === 'ready' ? 'hidden' : undefined}
                >
                  {gate === 'failed' ? (
                    <div className="flex flex-col items-start gap-3">
                      <p className="max-w-sm text-sm text-muted-foreground">{loadError?.message}</p>
                      <Button variant="outline" onClick={reload} disabled={loading}>
                        <RefreshCw className="h-4 w-4" /> Try again
                      </Button>
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground" role="status" aria-busy>
                      Loading configuration…
                    </p>
                  )}
                </SettingsSection>
              )}

              <ResetSection
                resetUiPrefsToDefaults={resetUiPrefsToDefaults}
                resettingBackend={resetting}
                onResetBackendConfig={resetBackendConfig}
              />
            </div>
          </div>
        </main>
      </div>

      <footer className="flex items-center justify-end gap-2 px-4 h-14 border-t shrink-0">
        {/* Persistence indicator (WARDEN-870). States the active section's
            persistence model so Save/Cancel stop reading as undo/commit on the
            instant client-pref sections (Appearance/NewChats/Snippets), mirroring
            the in-section labels WARDEN-784 added to NotificationsSection.
            `mr-auto` parks the label left while the buttons stay right;
            `min-w-0 truncate` keeps it from crowding the buttons on narrow
            screens (full text on hover via title).

            WARDEN-976 — shown whenever the ACTIVE section can actually act on
            it. On a client-pref section that is immediately: the label is the
            reassurance that this section needs no Save, which is most valuable
            precisely while the backend is still loading. A server-config
            section still hides it until the config is loaded — it cannot commit
            what it has not loaded, and Save is disabled in that state. */}
        {(configLoaded || persistence.kind === 'client') && (
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
        {/* Save PUTs the whole backend config, so it stays disabled until a GET
            has actually succeeded — a never-loaded draft is DEFAULT_CONFIG, and
            writing that would clobber the real persisted configuration. See
            canSaveBackendConfig (sectionLoadGate.ts). */}
        <Button onClick={handleSave} disabled={!canSaveBackendConfig({ configLoaded, saving })}>
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
