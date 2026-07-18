// New Chats section — pure client localStorage prefs (default agent type, host,
// cwd, shell, custom presets). Receives its pref group from App via SettingsPage
// plus `availableHosts` (the only non-client input — it comes from the backend
// /api/ssh-hosts load). The custom-preset CRUD + per-host setters are relocated
// here verbatim from SettingsPage (WARDEN-664): each operates only on props this
// section already receives, so behavior is unchanged.
import { useState } from 'react';
import { toast } from 'sonner';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  type PresetNameIssue,
  PRESET_NAME_MAX,
  validatePresetName,
} from '@/lib/storage';
import { PresetRow } from '../rows/PresetRow';
import { SettingsSection } from '../SettingsSection';
import { type NewChatsPrefs } from '../types';

export type NewChatsSectionProps = NewChatsPrefs & { availableHosts: string[]; hidden: boolean };

export function NewChatsSection(props: NewChatsSectionProps) {
  const {
    defaultNewChatPreset, setDefaultNewChatPreset,
    defaultNewChatPresetByHost, setDefaultNewChatPresetByHost,
    defaultNewChatHost, setDefaultNewChatHost,
    defaultNewChatCwd, setDefaultNewChatCwd,
    defaultNewChatCwdByHost, setDefaultNewChatCwdByHost,
    customPresets, setCustomPresets,
    defaultShell, setDefaultShell,
    defaultShellByHost, setDefaultShellByHost,
    availableHosts,
    hidden,
  } = props;

  // --- Custom spawn-preset management (create / rename / delete) -------------
  // All pure client-side: edits apply instantly via setCustomPresets and are
  // persisted by App's saveUi effect. Renaming/deleting a preset that is the
  // current default keeps the default in sync (rename tracks it; delete falls
  // back to claude) so the default never dangles.
  const [newPresetName, setNewPresetName] = useState('');
  const [newPresetCmd, setNewPresetCmd] = useState('');

  // Human message for a non-null preset-name validation issue. The contract
  // itself lives in storage.ts (validatePresetName); this just renders it.
  const presetNameErrorMessage = (name: string, issue: PresetNameIssue): string => {
    switch (issue) {
      case 'empty': return 'Preset needs a name.';
      case 'too-long': return `Preset name must be ${PRESET_NAME_MAX} characters or fewer.`;
      case 'reserved': return `"${name}" is a reserved preset name (use the built-in claude/shell instead).`;
      case 'duplicate': return `A preset named "${name}" already exists.`;
    }
  };

  const addPreset = () => {
    const name = newPresetName.trim();
    const cmd = newPresetCmd.trim();
    if (!name || !cmd) {
      toast.error('Preset needs both a name and a command.');
      return;
    }
    const issue = validatePresetName(name, customPresets);
    if (issue) {
      toast.error(presetNameErrorMessage(name, issue));
      return;
    }
    setCustomPresets([...customPresets, { name, cmd }]);
    setNewPresetName('');
    setNewPresetCmd('');
  };

  // Returns true on success (PresetRow reverts its draft on false). Coordinated
  // with the default so renaming the current default keeps it selected.
  // Validates through the shared storage contract so a name the load-time
  // sanitizer would drop (too long / reserved / duplicate) can never be persisted.
  const renamePreset = (oldName: string, newName: string): boolean => {
    const issue = validatePresetName(newName, customPresets, oldName);
    if (issue) {
      // commitName already reverts an empty draft silently before calling us;
      // only surface a toast for the rejectable issues.
      if (issue !== 'empty') toast.error(presetNameErrorMessage(newName.trim(), issue));
      return false;
    }
    const name = newName.trim();
    setCustomPresets(customPresets.map((p) => (p.name === oldName ? { ...p, name } : p)));
    if (defaultNewChatPreset === oldName) setDefaultNewChatPreset(name);
    // Keep per-host overrides in sync (WARDEN-352): a host defaulting to the
    // renamed preset must keep pointing at it, not dangle on the old name (which
    // the load-time sanitizer would drop on next reload — this avoids a stale
    // dropdown between saves). Mirrors the defaultNewChatPreset sync above.
    if (Object.values(defaultNewChatPresetByHost).includes(oldName)) {
      setDefaultNewChatPresetByHost(Object.fromEntries(
        Object.entries(defaultNewChatPresetByHost).map(([h, p]) => [h, p === oldName ? name : p]),
      ));
    }
    return true;
  };

  const updatePresetCmd = (name: string, cmd: string) => {
    const trimmed = cmd.trim();
    // Never persist an empty command — parseCustomPresets would drop the whole
    // preset on next reload (silent data loss). PresetRow also reverts an empty
    // draft on blur, but this guards the contract at the write site itself.
    if (!trimmed) return;
    setCustomPresets(customPresets.map((p) => (p.name === name ? { ...p, cmd: trimmed } : p)));
  };

  const deletePreset = (name: string) => {
    setCustomPresets(customPresets.filter((p) => p.name !== name));
    if (defaultNewChatPreset === name) setDefaultNewChatPreset('claude');
    // Drop any per-host override referencing the deleted preset (WARDEN-352): the
    // host would fall back to the global default on next load anyway (the load-
    // time sanitizer drops it), but removing it here keeps the live dropdown free
    // of a dangling name between saves. Mirrors the defaultNewChatPreset reset.
    if (Object.values(defaultNewChatPresetByHost).includes(name)) {
      setDefaultNewChatPresetByHost(Object.fromEntries(
        Object.entries(defaultNewChatPresetByHost).filter(([, p]) => p !== name),
      ));
    }
  };

  // Write a per-host cwd override (WARDEN-336). An empty/whitespace value means
  // "inherit the global defaultNewChatCwd" — drop the key entirely so it never
  // persists as a blank that cwdFor would return instead of falling through to
  // the global default. (The load-time sanitizer drops blanks too; this keeps
  // the live state in the same sanitized shape between saves.) Keys are the same
  // host strings the spawn form uses ('(local)' / SSH host name).
  const setHostCwd = (host: string, value: string) => {
    const next = { ...defaultNewChatCwdByHost };
    if (value.trim() === '') {
      delete next[host];
    } else {
      next[host] = value;
    }
    setDefaultNewChatCwdByHost(next);
  };

  // Write a per-host agent-type (preset) override (WARDEN-352 — the preset mirror
  // of setHostCwd). A blank/"use global" value means "inherit the global
  // defaultNewChatPreset" — drop the key entirely so it never persists as a blank
  // that presetFor would return instead of falling through to the global default.
  // (The load-time sanitizer drops invalid/blank entries too; this keeps the live
  // state in the same sanitized shape between saves.) Keys are the same host
  // strings the spawn form uses ('(local)' / SSH host name).
  const setHostPreset = (host: string, value: string) => {
    const next = { ...defaultNewChatPresetByHost };
    if (value.trim() === '') {
      delete next[host];
    } else {
      next[host] = value;
    }
    setDefaultNewChatPresetByHost(next);
  };

  // Write a per-host default-shell override (WARDEN-429 — the shell mirror of
  // setHostCwd). An empty/whitespace value means "inherit the global defaultShell"
  // (then the host login shell) — drop the key entirely so it never persists as a
  // blank that the resolver would return instead of falling through to the global
  // default. (The load-time sanitizer drops blanks too; this keeps the live state
  // in the same sanitized shape between saves.) Keys are the same host strings the
  // spawn form uses ('(local)' / SSH host name).
  const setHostShell = (host: string, value: string) => {
    const next = { ...defaultShellByHost };
    if (value.trim() === '') {
      delete next[host];
    } else {
      next[host] = value;
    }
    setDefaultShellByHost(next);
  };

  return (
    <SettingsSection title="New Chats" className={hidden ? 'hidden' : undefined}>
      <div className="flex flex-col gap-2">
        <Label htmlFor="defaultNewChatPreset">Default agent type</Label>
        <Select
          value={defaultNewChatPreset}
          onValueChange={(v) => setDefaultNewChatPreset(v)}
        >
          <SelectTrigger id="defaultNewChatPreset" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="claude">claude (default)</SelectItem>
            <SelectItem value="shell">shell</SelectItem>
            {customPresets.map((p) => (
              <SelectItem key={p.name} value={p.name}>
                {p.name}
              </SelectItem>
            ))}
            {/* A default naming a since-deleted preset must never leave
                an empty trigger — render it visibly but disabled so the
                user sees it's gone. Mirrors the default-host fallback. */}
            {defaultNewChatPreset !== 'claude' &&
              defaultNewChatPreset !== 'shell' &&
              !customPresets.some((p) => p.name === defaultNewChatPreset) && (
                <SelectItem value={defaultNewChatPreset} disabled>
                  {defaultNewChatPreset} (deleted)
                </SelectItem>
              )}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          Which command preset the ＋ new chat form starts with. Define your own below (e.g. codex, gemini, a wrapper script).
        </p>
      </div>

      {/* Custom spawn presets — create / rename / delete. Pure client-side. */}
      <div className="flex flex-col gap-2">
        <Label>Custom presets</Label>
        {customPresets.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No custom presets yet. Add one to turn any agent command into a one-click spawn button.
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            {customPresets.map((p) => (
              <PresetRow
                key={p.name}
                preset={p}
                isDefault={defaultNewChatPreset === p.name}
                onRename={renamePreset}
                onCmdChange={updatePresetCmd}
                onDelete={deletePreset}
              />
            ))}
          </div>
        )}

        {/* Add a new preset */}
        <div className="flex flex-col gap-1 rounded-md border bg-muted/30 p-2">
          <Input
            value={newPresetName}
            onChange={(e) => setNewPresetName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                addPreset();
              }
            }}
            className="h-8"
            placeholder="name (e.g. codex)"
            aria-label="New preset name"
            maxLength={PRESET_NAME_MAX}
          />
          <Input
            value={newPresetCmd}
            onChange={(e) => setNewPresetCmd(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                addPreset();
              }
            }}
            className="h-8"
            placeholder="command (e.g. codex)"
            aria-label="New preset command"
          />
          <Button variant="outline" size="sm" className="w-full" onClick={addPreset}>
            Add preset
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Custom presets appear as one-click buttons in the ＋ new chat form and can be set as the default above. Names can't reuse the built-ins claude/shell.
        </p>
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="defaultNewChatHost">Default host</Label>
        <Select value={defaultNewChatHost} onValueChange={(v) => setDefaultNewChatHost(v)}>
          <SelectTrigger id="defaultNewChatHost" className="w-full">
            <SelectValue placeholder="this machine (local)" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="(local)">this machine (local)</SelectItem>
            {availableHosts.map((h) => (
              <SelectItem key={h} value={h}>
                {h}
              </SelectItem>
            ))}
            {/* A stored default host that's no longer detected must never leave
                an empty/dangling trigger — render it visibly but disabled so the
                user sees it's gone and can pick a new default. Mirrors the
                "never empty" rule NewChatForm enforces at open time. */}
            {defaultNewChatHost !== '(local)' && !availableHosts.includes(defaultNewChatHost) && (
              <SelectItem value={defaultNewChatHost} disabled>
                {defaultNewChatHost} (no longer available)
              </SelectItem>
            )}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          Where new chats spawn by default. Detected SSH hosts appear here; a default host no longer available is shown disabled here and falls back to local at spawn time.
        </p>
      </div>

      {/* Default shell (WARDEN-429): the single shell preference governing
          BOTH the ＋ new-chat *shell* preset and the ＋ split button. Blank
          (default) = the host's own login shell (auto-detected per host;
          never hardcoded — a zsh-login host yields zsh out of the box), so
          an unconfigured user gets the right shell with zero config. A
          non-empty value (e.g. zsh/fish/pwsh) is used everywhere, overridable
          per host below. Supersedes the prior split-only "Default split
          shell" (folded in on load) and the hardcoded 'bash' the new-chat
          shell preset used to force-feed. */}
      <div className="flex flex-col gap-2">
        <Label htmlFor="defaultShell">Default shell (fallback for any host without its own)</Label>
        <Input
          id="defaultShell"
          value={defaultShell}
          onChange={(e) => setDefaultShell(e.target.value)}
          placeholder="auto (host login shell)"
        />
        <p className="text-xs text-muted-foreground">
          Shell opened by the ＋ new-chat <em>shell</em> preset and the ＋ split button. Enter a name like <code className="bg-muted px-1 rounded">zsh</code> or <code className="bg-muted px-1 rounded">fish</code>; leave blank to use each host's default login shell (the out-of-the-box behavior). Set a per-host override below to use a different shell on a specific host.
        </p>
      </div>

      {/* Per-host default-shell overrides (WARDEN-429 — the shell mirror of
          the per-host cwd block below). A shell is host-specific (zsh on a
          mac, fish on a Linux box), so a single global default breaks the
          moment there is a second host. Leave a host blank to inherit the
          global default above (then the host's login shell). Keys are the
          same host strings the spawn form uses ('(local)' / SSH host). */}
      <div className="flex flex-col gap-2">
        <Label>Default shell per host</Label>
        <p className="text-xs text-muted-foreground">
          Override the default shell for a specific host. Leave a host blank to use the global default above (or the host's login shell).
        </p>
        <div className="flex flex-col gap-2 rounded-md border bg-muted/30 p-2">
          {[{ key: '(local)', label: 'this machine (local)' }, ...availableHosts.map((h) => ({ key: h, label: h }))].map(({ key, label }) => {
            const safeId = `defaultShellByHost-${key.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
            return (
              <div className="flex flex-col gap-1" key={`shellByHost-${key}`}>
                <Label htmlFor={safeId} className="text-xs font-normal text-muted-foreground">{label}</Label>
                <Input
                  id={safeId}
                  value={defaultShellByHost[key] ?? ''}
                  onChange={(e) => setHostShell(key, e.target.value)}
                  placeholder="auto (host login shell)"
                  className="h-8"
                />
              </div>
            );
          })}
        </div>
      </div>

      {/* Default working directory (WARDEN-311): the GLOBAL cwd fallback
          pre-filled in the ＋ new chat spawn form. Blank → the host's
          home directory (today's behavior); the seeded value is still
          editable per-spawn in the form. WARDEN-336 adds per-host
          overrides below — a host with its own value wins over this. */}
      <div className="flex flex-col gap-2">
        <Label htmlFor="defaultNewChatCwd">Default working directory (fallback for any host without its own)</Label>
        <Input
          id="defaultNewChatCwd"
          value={defaultNewChatCwd}
          onChange={(e) => setDefaultNewChatCwd(e.target.value)}
          placeholder="auto (home directory)"
        />
        <p className="text-xs text-muted-foreground">
          Working directory pre-filled in the ＋ new chat spawn form. Enter a path like <code className="bg-muted px-1 rounded">~/projects/warden</code>; leave blank to start each chat in the host's home directory (today's behavior). Editable per-spawn. Set a per-host override below to use a different directory on a specific host.
        </p>
      </div>

      {/* Per-host agent-type (preset) overrides (WARDEN-352 — the preset
          mirror of the per-host cwd block below). Just like a cwd path,
          the agent you run is host-specific: claude locally but codex
          (or a wrapper) on a remote GPU box. Leave a host on "Use global
          default" to inherit the default agent type above. Keys are the
          same host strings the spawn form uses ('(local)' / SSH host). */}
      <div className="flex flex-col gap-2">
        <Label>Agent type per host</Label>
        <p className="text-xs text-muted-foreground">
          Override the default agent type for a specific host when spawning. Leave a host on “Use global default” to use the default agent type above.
        </p>
        <div className="flex flex-col gap-2 rounded-md border bg-muted/30 p-2">
          {[{ key: '(local)', label: 'this machine (local)' }, ...availableHosts.map((h) => ({ key: h, label: h }))].map(({ key, label }) => {
            // Radix Select forbids an empty-string item value, so
            // "inherit global" is a sentinel option mapped to a blank
            // (deleted) entry by setHostPreset — a cleared row means
            // "inherit the global default", never a persisted blank.
            const INHERIT = '__inherit_global__';
            const saved = defaultNewChatPresetByHost[key];
            const hasOverride = typeof saved === 'string' && saved.trim() !== '';
            const validOverride = hasOverride && (saved === 'claude' || saved === 'shell' || customPresets.some((p) => p.name === saved));
            return (
              <div className="flex flex-col gap-1" key={`presetByHost-${key}`}>
                <Label className="text-xs font-normal text-muted-foreground">{label}</Label>
                <Select value={hasOverride ? saved : INHERIT} onValueChange={(v) => setHostPreset(key, v === INHERIT ? '' : v)}>
                  <SelectTrigger className="h-8 w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={INHERIT}>Use global default</SelectItem>
                    <SelectItem value="claude">claude</SelectItem>
                    <SelectItem value="shell">shell</SelectItem>
                    {customPresets.map((p) => (
                      <SelectItem key={p.name} value={p.name}>
                        {p.name}
                      </SelectItem>
                    ))}
                    {/* A saved value naming a since-deleted preset
                        (only reachable via direct localStorage
                        tampering — the load sanitizer + the rename/
                        delete propagation above keep the live map
                        valid) must never leave an empty trigger;
                        render it visibly but disabled, mirroring the
                        global preset Select's "(deleted)" item. */}
                    {hasOverride && !validOverride && (
                      <SelectItem value={saved} disabled>
                        {saved} (deleted)
                      </SelectItem>
                    )}
                  </SelectContent>
                </Select>
              </div>
            );
          })}
        </div>
      </div>

      {/* Per-host working directory overrides (WARDEN-336): one input per
          configured host. A filesystem path is inherently host-specific,
          so a single global cwd breaks the moment there is a second host.
          Leave a host blank to inherit the global default above. Keys are
          the same host strings the spawn form uses ('(local)' / SSH host). */}
      <div className="flex flex-col gap-2">
        <Label>Working directory per host</Label>
        <p className="text-xs text-muted-foreground">
          Override the default working directory for a specific host when spawning. Leave a host blank to use the global default above.
        </p>
        <div className="flex flex-col gap-2 rounded-md border bg-muted/30 p-2">
          {[{ key: '(local)', label: 'this machine (local)' }, ...availableHosts.map((h) => ({ key: h, label: h }))].map(({ key, label }) => {
            const safeId = `defaultNewChatCwdByHost-${key.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
            return (
              <div className="flex flex-col gap-1" key={`cwdByHost-${key}`}>
                <Label htmlFor={safeId} className="text-xs font-normal text-muted-foreground">{label}</Label>
                <Input
                  id={safeId}
                  value={defaultNewChatCwdByHost[key] ?? ''}
                  onChange={(e) => setHostCwd(key, e.target.value)}
                  placeholder="auto (home directory)"
                  className="h-8"
                />
              </div>
            );
          })}
        </div>
      </div>
    </SettingsSection>
  );
}
