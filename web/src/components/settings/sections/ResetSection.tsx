// Reset section (danger zone, WARDEN-346) — the destructive "start over" actions.
// Owns its own confirm-dialog state for each action. Always visible (no `hidden`
// prop, matching the prior inline section which rendered outside the
// activeSection gating). Extracted from SettingsPage (WARDEN-664); WARDEN-889
// added the second action (backend-config reset) so the danger zone no longer
// implies a reset scope it did not actually cover.
//
// Two DISTINCT resets, each clearly labeled as to its scope (WARDEN-889 #4):
//   1. "Reset appearance & UI preferences" — CLIENT-side UI prefs only
//      (appearance/terminal/new-chat/behavior). Preserves the open workspace.
//      Never touches the backend / config.json.
//   2. "Reset backend configuration to defaults" — EVERY backend preference
//      (webhook/telemetry/observer/hosts/thresholds/…) restored to its default,
//      INCLUDING the write-only auth tokens no normal Save can clear. Instant
//      (persists + live-applies via the backend). Pinned chats / notes / session
//      tags are backend-side USER DATA and are preserved.
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { SettingsSection } from '../SettingsSection';

export interface ResetSectionProps {
  // Reset every client-side UI PREF (appearance, terminal, new-chat, behavior)
  // to its DEFAULT_UI value while preserving the open workspace (tabs/panes/
  // focus/host map) and panel layout. App-owned callback; pure client-side,
  // never touches the backend / config.json.
  resetUiPrefsToDefaults: () => void;
  // True while the backend-config reset round-trip (POST /api/config/reset) is
  // in flight — disables the button so the destructive action can't double-fire.
  resettingBackend: boolean;
  // Restore every BACKEND preference to its default (WARDEN-889). Instant — the
  // backend persists + live-applies deriveDefaults(). Also clears the write-only
  // secrets (observer/webhook/telemetry auth tokens) that a normal Save cannot.
  onResetBackendConfig: () => void;
}

export function ResetSection({ resetUiPrefsToDefaults, resettingBackend, onResetBackendConfig }: ResetSectionProps) {
  // Both confirm dialogs are ALWAYS gated — these are rare, destructive-to-
  // preferences/config actions worth the friction regardless of the
  // confirmDestructiveActions kill-toggle (that toggle is about chat/session
  // kills, not about reverting your own tuning).
  const [resetPrefsOpen, setResetPrefsOpen] = useState(false);
  const [resetBackendOpen, setResetBackendOpen] = useState(false);

  // Confirm the workspace-preserving prefs reset: applies the App callback
  // (which snaps every pref to its default and lets the saveUi effect persist
  // it), closes the dialog, and toasts. The workspace (tabs/panes/focus) and
  // panel layout are untouched by design.
  const confirmResetPrefs = () => {
    resetUiPrefsToDefaults();
    setResetPrefsOpen(false);
    toast.success('Preferences reset to defaults');
  };

  // Confirm the backend-config reset: fires the instant backend reset (which
  // persists the defaults, live-applies them, and clears the write-only secrets),
  // then closes the dialog. The hook owns the success/error toast.
  const confirmResetBackend = () => {
    setResetBackendOpen(false);
    onResetBackendConfig();
  };

  return (
    <>
      <SettingsSection title="Reset">
        <div className="flex flex-col gap-4 rounded-md border border-destructive/30 p-3">
          {/* (1) CLIENT-side UI prefs only — preserves the open workspace, never
              touches the backend / config.json. Scope is stated explicitly so a
              user is never left thinking this resets backend config too. */}
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1">
              <span className="text-sm font-medium">Reset appearance &amp; UI preferences</span>
              <span className="text-xs text-muted-foreground">
                Resets client-side appearance, terminal, new-chat, and behavior preferences to their defaults. Your open tabs, panes, focus, and panel layout are preserved. Does not touch backend configuration.
              </span>
            </div>
            <div>
              <Button variant="destructive" size="sm" onClick={() => setResetPrefsOpen(true)}>
                Reset UI preferences
              </Button>
            </div>
          </div>

          <div className="h-px bg-border" role="separator" />

          {/* (2) BACKEND config — every backend preference restored to its
              default, including the write-only secrets no Save can clear.
              Instant (no Save needed); pinned chats / notes / tags preserved. */}
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1">
              <span className="text-sm font-medium">Reset backend configuration to defaults</span>
              <span className="text-xs text-muted-foreground">
                Restores every backend setting (webhook, telemetry, observer, hosts, attention thresholds, token budget, and more) to its defaults, including the write-only secrets (observer, webhook, and telemetry auth tokens) that have no other clear button. Applies instantly — no Save needed. Pinned chats, agent notes, and session tags are preserved.
              </span>
            </div>
            <div>
              <Button
                variant="destructive"
                size="sm"
                onClick={() => setResetBackendOpen(true)}
                disabled={resettingBackend}
              >
                {resettingBackend ? 'Resetting…' : 'Reset backend configuration'}
              </Button>
            </div>
          </div>
        </div>
      </SettingsSection>

      <ConfirmDialog
        open={resetPrefsOpen}
        onOpenChange={(o) => { if (!o) setResetPrefsOpen(false); }}
        title="Reset appearance & UI preferences?"
        description="Resets all client-side appearance, terminal, new-chat, and behavior preferences to their defaults. Your open tabs, panes, focus, and panel layout are preserved. Backend configuration is not touched."
        confirmLabel="Reset"
        cancelLabel="Cancel"
        destructive
        onConfirm={confirmResetPrefs}
      />

      <ConfirmDialog
        open={resetBackendOpen}
        onOpenChange={(o) => { if (!o) setResetBackendOpen(false); }}
        title="Reset backend configuration to defaults?"
        description="This instantly restores every backend setting (webhook, telemetry, observer, hosts, attention thresholds, token budget, etc.) to its defaults and clears the write-only auth tokens (observer, webhook, telemetry). This action cannot be undone. Pinned chats, agent notes, and session tags are preserved."
        confirmLabel="Reset backend"
        cancelLabel="Cancel"
        destructive
        onConfirm={confirmResetBackend}
      />
    </>
  );
}
