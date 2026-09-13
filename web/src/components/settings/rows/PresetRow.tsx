/** One editable custom preset row: an inline name field (committed on blur/Enter,
 *  reverted on a rejected rename) and a live-editable command field, plus delete.
 *  Stateless w.r.t. its own value except the name draft — the list is the source
 *  of truth, so this is the only piece of local state needed.
 *
 *  Extracted verbatim from SettingsPage (WARDEN-664); behavior is unchanged.
 *
 *  WARDEN-1359: the whole row is wrapped in a themed right-click ContextMenu —
 *  Copy name · Copy command · Duplicate · Delete — the menu PatternRow has
 *  shipped since WARDEN-898. */
import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Trash2 } from 'lucide-react';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { copyWithToast } from '@/lib/clipboardToast';
import { type CustomPreset, PRESET_NAME_MAX } from '@/lib/storage';
import { decideDraftNameCommit, decideDraftValueCommit } from './draftCommit';

export function PresetRow({
  preset,
  isDefault,
  onRename,
  onCmdChange,
  onDuplicate,
  onDelete,
}: {
  preset: CustomPreset;
  isDefault: boolean;
  onRename: (oldName: string, newName: string) => boolean;
  onCmdChange: (name: string, cmd: string) => void;
  onDuplicate: (name: string) => void;
  onDelete: (name: string) => void;
}) {
  const [nameDraft, setNameDraft] = useState(preset.name);
  const [cmdDraft, setCmdDraft] = useState(preset.cmd);
  // Re-sync the drafts if the preset changes from the outside (e.g. after a
  // coordinated default rename or a load), so the inputs never drift.
  useEffect(() => {
    setNameDraft(preset.name);
  }, [preset.name]);
  useEffect(() => {
    setCmdDraft(preset.cmd);
  }, [preset.cmd]);

  const commitName = () => {
    const decision = decideDraftNameCommit(nameDraft, preset.name);
    if (decision.commit) {
      if (!onRename(preset.name, decision.value)) setNameDraft(preset.name); // revert on rejection
    } else {
      setNameDraft(preset.name); // empty or unchanged → revert
    }
  };

  // Commit the command on blur/Enter, mirroring commitName: free-edit while
  // focused, but never persist an empty command — parseCustomPresets would drop
  // the whole preset on next reload (silent data loss). Empty on commit reverts
  // to the last saved value, so the field is editable but never goes dangling.
  const commitCmd = () => {
    const decision = decideDraftValueCommit(cmdDraft);
    if (decision.commit) {
      onCmdChange(preset.name, decision.value);
    } else {
      setCmdDraft(preset.cmd); // empty → revert
    }
  };

  // Themed right-click menu (WARDEN-1359): Copy name · Copy command · Duplicate
  // · Delete — the exact shape PatternRow has shipped since WARDEN-898. Copy
  // goes through the shared copyWithToast helper (lib/clipboardToast) with the
  // RAW stored values, so the spawn command — which right-click used to leave
  // in total silence (this app registers no context-menu handler, so Electron
  // pops no default menu) — is finally copyable. Right-click moves focus to
  // the menu the same way clicking elsewhere does, so an in-flight name/cmd
  // edit still commits on blur (commitName/commitCmd above). Delete reuses
  // the same onDelete prop as the trash button, so the menu cannot bypass the
  // section's WARDEN-942 ConfirmDialog (with its cascade side-effect copy).
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div className="flex flex-col gap-1 rounded-md border bg-muted/30 p-2">
          <div className="flex items-center gap-2">
            <Input
              value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value)}
              onBlur={commitName}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.currentTarget.blur();
                if (e.key === 'Escape') setNameDraft(preset.name);
              }}
              className="h-8 flex-1"
              placeholder="name"
              aria-label="Preset name"
              maxLength={PRESET_NAME_MAX}
            />
            {isDefault && <Badge variant="secondary">default</Badge>}
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => onDelete(preset.name)}
              aria-label={`Delete ${preset.name} preset`}
            >
              <Trash2 />
            </Button>
          </div>
          <Input
            value={cmdDraft}
            onChange={(e) => setCmdDraft(e.target.value)}
            onBlur={commitCmd}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur();
              if (e.key === 'Escape') setCmdDraft(preset.cmd);
            }}
            className="h-8"
            placeholder="command"
            aria-label={`${preset.name} command`}
          />
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={() => copyWithToast(preset.name)}>Copy name</ContextMenuItem>
        <ContextMenuItem onSelect={() => copyWithToast(preset.cmd)}>Copy command</ContextMenuItem>
        <ContextMenuItem onSelect={() => onDuplicate(preset.name)}>Duplicate</ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem variant="destructive" onSelect={() => onDelete(preset.name)}>Delete</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
