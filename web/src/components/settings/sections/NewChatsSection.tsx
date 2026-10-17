// New Chats section — pure client localStorage prefs (default cwd, shell, and
// their per-host overrides). SUBSCRIBES to the shared client-state store
// (lib/uiStore.ts) for the whole spawn family (WARDEN-1383, roadmap
// WARDEN-1204 slice 8) instead of receiving a threaded pref bag, exactly as
// SnippetsSection (WARDEN-1271) and AppearanceSection (WARDEN-1322) do.
// `availableHosts` is the only prop left — the only non-client input, from the
// backend /api/ssh-hosts load — plus the `hidden` toggle. The agent-type /
// host / custom-preset controls were retired in WARDEN-1816: WARDEN-1422
// deleted NewChatForm, their only consumer, so nothing applied them.
import { Input } from '@/components/ui/input';
import { EditableContextMenu } from '@/components/ui/editable-context-menu';
import { Label } from '@/components/ui/label';
import { SettingsSection } from '../SettingsSection';
import { ClientPrefResetToDefaultButton } from '../rows/ResetToDefaultButton';
import {
  useDefaultNewChatCwd,
  useSetDefaultNewChatCwd,
  useDefaultNewChatCwdByHost,
  useSetDefaultNewChatCwdByHost,
  useDefaultShell,
  useSetDefaultShell,
  useDefaultShellByHost,
  useSetDefaultShellByHost,
} from '@/lib/uiStore';

export type NewChatsSectionProps = { availableHosts: string[]; hidden: boolean };

export function NewChatsSection({ availableHosts, hidden }: NewChatsSectionProps) {
  // WARDEN-1383 (slice 8): the spawn family's ONE home is the store — these
  // subscriptions replace the NewChatsPrefs bag this section used to receive,
  // under the SAME local names so every handler body and rendered control
  // below is byte-identical.
  const defaultNewChatCwd = useDefaultNewChatCwd();
  const setDefaultNewChatCwd = useSetDefaultNewChatCwd();
  const defaultNewChatCwdByHost = useDefaultNewChatCwdByHost();
  const setDefaultNewChatCwdByHost = useSetDefaultNewChatCwdByHost();
  const defaultShell = useDefaultShell();
  const setDefaultShell = useSetDefaultShell();
  const defaultShellByHost = useDefaultShellByHost();
  const setDefaultShellByHost = useSetDefaultShellByHost();

  // Write a per-host cwd override (WARDEN-336). An empty/whitespace value means
  // "inherit the global defaultNewChatCwd" — drop the key entirely so it never
  // persists as a blank that cwdFor would return instead of falling through to
  // the global default. (The load-time sanitizer drops blanks too; this keeps
  // the live state in the same sanitized shape between saves.) Keys are the same
  // host strings the spawn control uses ('(local)' / SSH host name).
  const setHostCwd = (host: string, value: string) => {
    const next = { ...defaultNewChatCwdByHost };
    if (value.trim() === '') {
      delete next[host];
    } else {
      next[host] = value;
    }
    setDefaultNewChatCwdByHost(next);
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
      {/* Default shell (WARDEN-429): the single shell preference governing
          BOTH the sidebar's Start shell button and the ＋ split button. Blank
          (default) = the host's own login shell (auto-detected per host;
          never hardcoded — a zsh-login host yields zsh out of the box), so
          an unconfigured user gets the right shell with zero config. A
          non-empty value (e.g. zsh/fish/pwsh) is used everywhere, overridable
          per host below. Supersedes the prior split-only "Default split
          shell" (folded in on load) and the hardcoded 'bash' the retired
          new-chat shell preset used to force-feed. */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <Label htmlFor="defaultShell">Default shell (fallback for any host without its own)</Label>
          <ClientPrefResetToDefaultButton label="Default shell (fallback for any host without its own)" prefKey="defaultShell" value={defaultShell} setter={setDefaultShell} />
        </div>
        <EditableContextMenu>
          <Input
            id="defaultShell"
            value={defaultShell}
            onChange={(e) => setDefaultShell(e.target.value)}
            placeholder="auto (host login shell)"
          />
        </EditableContextMenu>
        <p className="text-xs text-muted-foreground">
          Shell opened by the sidebar's <em>Start shell</em> button and the ＋ split button. Enter a name like <code className="bg-muted px-1 rounded">zsh</code> or <code className="bg-muted px-1 rounded">fish</code>; leave blank to use each host's default login shell (the out-of-the-box behavior). Set a per-host override below to use a different shell on a specific host.
        </p>
      </div>

      {/* Per-host default-shell overrides (WARDEN-429 — the shell mirror of
          the per-host cwd block below). A shell is host-specific (zsh on a
          mac, fish on a Linux box), so a single global default breaks the
          moment there is a second host. Leave a host blank to inherit the
          global default above (then the host's login shell). Keys are the
          same host strings the spawn control uses ('(local)' / SSH host). */}
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
                <EditableContextMenu>
                  <Input
                    id={safeId}
                    value={defaultShellByHost[key] ?? ''}
                    onChange={(e) => setHostShell(key, e.target.value)}
                    placeholder="auto (host login shell)"
                    className="h-8"
                  />
                </EditableContextMenu>
              </div>
            );
          })}
        </div>
      </div>

      {/* Default working directory (WARDEN-311): the GLOBAL cwd fallback
          pre-filled in the sidebar's Start shell control. Blank → the host's
          home directory (today's behavior); the seeded value is still
          editable per-spawn in the control. WARDEN-336 adds per-host
          overrides below — a host with its own value wins over this. */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <Label htmlFor="defaultNewChatCwd">Default working directory (fallback for any host without its own)</Label>
          <ClientPrefResetToDefaultButton label="Default working directory (fallback for any host without its own)" prefKey="defaultNewChatCwd" value={defaultNewChatCwd} setter={setDefaultNewChatCwd} />
        </div>
        <EditableContextMenu>
          <Input
            id="defaultNewChatCwd"
            value={defaultNewChatCwd}
            onChange={(e) => setDefaultNewChatCwd(e.target.value)}
            placeholder="auto (home directory)"
          />
        </EditableContextMenu>
        <p className="text-xs text-muted-foreground">
          Working directory pre-filled in the sidebar's Start shell control. Enter a path like <code className="bg-muted px-1 rounded">~/projects/warden</code>; leave blank to start each chat in the host's home directory (today's behavior). Editable per-spawn. Set a per-host override below to use a different directory on a specific host.
        </p>
      </div>

      {/* Per-host working directory overrides (WARDEN-336): one input per
          configured host. A filesystem path is inherently host-specific,
          so a single global cwd breaks the moment there is a second host.
          Leave a host blank to inherit the global default above. Keys are
          the same host strings the spawn control uses ('(local)' / SSH host). */}
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
                <EditableContextMenu>
                  <Input
                    id={safeId}
                    value={defaultNewChatCwdByHost[key] ?? ''}
                    onChange={(e) => setHostCwd(key, e.target.value)}
                    placeholder="auto (home directory)"
                    className="h-8"
                  />
                </EditableContextMenu>
              </div>
            );
          })}
        </div>
      </div>
    </SettingsSection>
  );
}
