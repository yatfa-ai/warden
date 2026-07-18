// Reset section (danger zone, WARDEN-346) — workspace-preserving reset of all
// client-side UI prefs. Owns its own confirm-dialog state. Always visible (it has
// no `hidden` prop, matching the prior inline section which rendered outside the
// activeSection gating). Extracted verbatim from SettingsPage (WARDEN-664);
// behavior is unchanged.
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
}

export function ResetSection({ resetUiPrefsToDefaults }: ResetSectionProps) {
  // "Reset preferences to defaults" confirm dialog (danger-zone). Always gated
  // by the confirm — it is a rare, destructive-to-prefs action worth the
  // friction regardless of the confirmDestructiveActions kill-toggle (that
  // toggle is about chat/session kills, not about reverting your own tuning).
  const [resetPrefsOpen, setResetPrefsOpen] = useState(false);

  // Confirm the workspace-preserving prefs reset: applies the App callback
  // (which snaps every pref to its default and lets the saveUi effect persist
  // it), closes the dialog, and toasts. The workspace (tabs/panes/focus) and
  // panel layout are untouched by design.
  const confirmResetPrefs = () => {
    resetUiPrefsToDefaults();
    setResetPrefsOpen(false);
    toast.success('Preferences reset to defaults');
  };

  return (
    <>
      <SettingsSection title="Reset">
        <div className="flex flex-col gap-3 rounded-md border border-destructive/30 p-3">
          <div className="flex flex-col gap-1">
            <span className="text-sm font-medium">Reset preferences to defaults</span>
            <span className="text-xs text-muted-foreground">
              Resets all appearance, terminal, new-chat, and behavior preferences to their defaults. Your open tabs, panes, focus, and panel layout are preserved.
            </span>
          </div>
          <div>
            <Button variant="destructive" size="sm" onClick={() => setResetPrefsOpen(true)}>
              Reset preferences to defaults
            </Button>
          </div>
        </div>
      </SettingsSection>

      <ConfirmDialog
        open={resetPrefsOpen}
        onOpenChange={(o) => { if (!o) setResetPrefsOpen(false); }}
        title="Reset preferences to defaults?"
        description="Resets all appearance, terminal, new-chat, and behavior preferences to their defaults. Your open tabs, panes, focus, and panel layout are preserved."
        confirmLabel="Reset"
        cancelLabel="Cancel"
        destructive
        onConfirm={confirmResetPrefs}
      />
    </>
  );
}
