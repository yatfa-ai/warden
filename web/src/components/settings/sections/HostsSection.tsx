// Hosts & Connection section — MIXED persistence: `config` (hosts, poll
// interval, tmux session, connect timeout) is backend /api/config, while
// `hostLabels` is a pure client localStorage pref threaded in separately. The
// addHost/removeHost/setHostLabel handlers are relocated here verbatim from
// SettingsPage (WARDEN-664) — each operates only on props this section already
// receives, so behavior is unchanged.
import { useState } from 'react';
import { Trash2 } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { resolvePollIntervalMs } from '@/lib/pollInterval';
import { THIS_MACHINE, type HostLabels } from '@/lib/chatDisplay';
import { SettingsSection } from '../SettingsSection';
import {
  POLL_INPUT_MAX_MS,
  POLL_INPUT_MIN_MS,
  commitPollIntervalDraft,
  isPollDraftOutOfRange,
} from '../pollIntervalDraft';
import { type ConfigData, type SetConfig } from '../types';

export interface HostsSectionProps {
  config: ConfigData;
  setConfig: SetConfig;
  // Pure client localStorage pref (display-only labels), never sent to the
  // backend. Threaded in separately from the `config` fields above.
  hostLabels: HostLabels;
  setHostLabels: (v: HostLabels) => void;
  availableHosts: string[];
  hidden: boolean;
}

export function HostsSection({
  config,
  setConfig,
  hostLabels,
  setHostLabels,
  availableHosts,
  hidden,
}: HostsSectionProps) {
  // WARDEN-928 — the host pending confirmed removal (`null` = dialog closed).
  // Hosts are a list, so this is ONE piece of state driving ONE shared
  // ConfirmDialog, not a boolean per chip. Cancel/Escape/overlay-click clear it
  // WITHOUT touching setConfig, so a dismissed dialog leaves the draft
  // byte-identical and never newly dirties the config (web/settingsDirty.test.mjs).
  const [pendingRemoval, setPendingRemoval] = useState<string | null>(null);

  // WARDEN-938 — the Dashboard Refresh Interval draft. `null` means "the user
  // has not typed in this field", in which case the input displays the RESOLVED
  // cadence derived from config (what the dashboard actually runs). The moment
  // the user types, the draft holds their raw keystrokes and the resolver leaves
  // the render path entirely — previously `value` was the resolver output, so
  // typing `1` (the first digit of `15000`) re-rendered as `60000` and the field
  // could not be typed into at all.
  //
  // Nothing is written to `config` until blur, so an untouched field can never
  // rewrite the stored value (it is shared with the CLI, whose watch mode uses
  // the 1500ms default) and mid-edit keystrokes never dirty the settings draft
  // behind the discard guard. Same local-draft shape as `customFontText` in
  // AppearanceSection.
  const [pollDraft, setPollDraft] = useState<string | null>(null);
  const pollDisplay = pollDraft ?? String(resolvePollIntervalMs(config.pollIntervalMs));

  const addHost = (host: string) => {
    if (!config.hosts.includes(host)) {
      setConfig({ ...config, hosts: [...config.hosts, host] });
    }
  };

  const removeHost = (host: string) => {
    setConfig({ ...config, hosts: config.hosts.filter((h) => h !== host) });
  };

  // Write a per-host display label (WARDEN-490). An empty/whitespace value means
  // "no label" (show the raw host, today's behavior) — drop the key entirely so
  // it never persists as a blank (matching the load-time sanitizer + the funnel's
  // empty = no-label rule). Keys are the raw host strings ('(local)' / SSH host
  // name) — the same every display surface keys on.
  const setHostLabel = (host: string, value: string) => {
    const next = { ...hostLabels };
    if (value.trim() === '') {
      delete next[host];
    } else {
      next[host] = value;
    }
    setHostLabels(next);
  };

  const availableHostsToAdd = availableHosts.filter((h) => !config.hosts.includes(h));

  return (
    <>
    <SettingsSection title="Hosts & Connection" className={hidden ? 'hidden' : undefined}>
      {/* Host Management */}
      <div className="flex flex-col gap-2">
        <Label>Configured Hosts</Label>
        <div className="flex flex-wrap gap-2 min-h-10 p-2 rounded-md border bg-muted/30">
          {config.hosts.length === 0 ? (
            <span className="text-xs text-muted-foreground">No hosts configured</span>
          ) : (
            config.hosts.map((host) => (
              // WARDEN-928 — the chip BODY is inert. Removal lives on a
              // dedicated, keyboard-reachable ghost icon-button with an
              // accessible name, matching PatternRow/SnippetRow/PresetRow.
              // `icon-xs` (not `icon-sm`) because those rows are full-height
              // form rows while this control sits beside an `h-5` Badge —
              // its `size-3` glyph matches the badge's own icon scale.
              <div key={host} className="inline-flex items-center gap-0.5">
                <Badge variant="secondary">{host}</Badge>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={() => setPendingRemoval(host)}
                  aria-label={`Remove host ${host}`}
                >
                  <Trash2 />
                </Button>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Add Host */}
      {availableHostsToAdd.length > 0 && (
        <div className="flex flex-col gap-2">
          <Label htmlFor="addHost">Add Host</Label>
          <Select
            value=""
            onValueChange={(v) => {
              if (v) addHost(v);
            }}
          >
            <SelectTrigger id="addHost" className="w-full">
              <SelectValue placeholder="Select a host to add…" />
            </SelectTrigger>
            <SelectContent>
              {availableHostsToAdd.map((host) => (
                <SelectItem key={host} value={host}>
                  {host}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {/* Per-host display labels (WARDEN-490) — a friendly name for each
          host shown wherever a host tag appears (sidebar rows, pane
          header, Kill/Collision/Broadcast dialogs, Health dashboard,
          token-budget offender line, etc.). Pure client-side: never
          sent to the backend (it's a UiState pref, not config). Leave a
          host blank to show its raw name. Covers this machine plus every
          configured host; this machine is listed even though it isn't in
          config.hosts (it's always implied). */}
      <div className="flex flex-col gap-2">
        <Label>Display label per host</Label>
        <p className="text-xs text-muted-foreground">
          Give any host a friendly name (e.g. <code className="bg-muted px-1 rounded">CI runner</code>) shown wherever a host tag appears. Leave blank to show the raw host name. Local and remote alike. Stored on this machine only — never sent to the server.
        </p>
        <div className="flex flex-col gap-2 rounded-md border bg-muted/30 p-2">
          {[{ key: THIS_MACHINE, label: 'this machine (local)' }, ...config.hosts.filter((h) => h !== THIS_MACHINE).map((h) => ({ key: h, label: h }))].map(({ key, label }) => {
            const safeId = `hostLabel-${key.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
            return (
              <div className="flex flex-col gap-1" key={`hostLabel-${key}`}>
                <Label htmlFor={safeId} className="text-xs font-normal text-muted-foreground">{label}</Label>
                <Input
                  id={safeId}
                  value={hostLabels[key] ?? ''}
                  onChange={(e) => setHostLabel(key, e.target.value)}
                  placeholder={`raw name (${key === THIS_MACHINE ? 'local' : key})`}
                  className="h-8"
                />
              </div>
            );
          })}
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="pollIntervalMs">Dashboard Refresh Interval (ms)</Label>
        <Input
          id="pollIntervalMs"
          type="number"
          min={POLL_INPUT_MIN_MS}
          max={POLL_INPUT_MAX_MS}
          step="5000"
          value={pollDisplay}
          onChange={(e) => setPollDraft(e.target.value)}
          onBlur={() => {
            // Commit the typed value, clamped into the [10000, 120000] band the
            // input advertises — mirrors the connectTimeout clamp below. The
            // untouched case is the one that matters: a `null` draft means the
            // field was never edited, and clamping there would rewrite the
            // STORED value (turning the CLI's 1500ms watch default into 10000ms
            // just because the user tabbed past). Both this early return and
            // `commitPollIntervalDraft`'s own null result keep that path silent.
            // An unparseable draft likewise commits nothing, so clearing the
            // field and leaving reverts to the stored cadence.
            if (pollDraft === null) return;
            const committed = commitPollIntervalDraft(pollDraft);
            if (committed !== null && committed !== config.pollIntervalMs) {
              setConfig({ ...config, pollIntervalMs: committed });
            }
            // Back to displaying the resolved stored value. Everything committed
            // above is inside the pass-through band, so the field now shows
            // exactly what was persisted and what the dashboard runs.
            setPollDraft(null);
          }}
        />
        {isPollDraftOutOfRange(pollDraft) && (
          <p className="text-xs text-destructive">
            Must be between {POLL_INPUT_MIN_MS} and {POLL_INPUT_MAX_MS} ms — capped to{' '}
            {commitPollIntervalDraft(pollDraft)} on blur.
          </p>
        )}
        <p className="text-xs text-muted-foreground">
          How often the dashboard auto-refreshes — re-pulls the chat catalog, re-checks engaged hosts for live status, and re-checks host connectivity. Range 10000–120000ms (10s–2min); a typed value outside that range is capped to it when you leave the field. The dashboard enforces a 10s minimum and reverts any smaller stored value (including the 1500ms CLI default) to 60s, so the value shown is the cadence you get. The CLI reads the raw value directly for its watch mode (default 1500ms) — this field leaves that default alone unless you edit it. Backgrounded tabs still skip ticks.
        </p>
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="tmuxSession">Tmux Session Name</Label>
        <Input
          id="tmuxSession"
          value={config.tmuxSession}
          onChange={(e) => setConfig({ ...config, tmuxSession: e.target.value })}
        />
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="connectTimeout">Connect Timeout (seconds)</Label>
        <Input
          id="connectTimeout"
          type="number"
          min="1"
          max="60"
          value={config.connectTimeout}
          onChange={(e) =>
            setConfig({ ...config, connectTimeout: parseInt(e.target.value) || 10 })
          }
          onBlur={() => {
            // WARDEN-747: clamp the committed value into the [1, 60] bounds the
            // input already advertises — mirrors the WARDEN-374 attention-
            // threshold clamp and the backend PUT /api/config guard so the value
            // that persists is the value displayed. connectTimeout is always a
            // number (onChange coerces via `parseInt || 10`), so no null guard.
            const clamped = Math.min(60, Math.max(1, config.connectTimeout));
            if (clamped !== config.connectTimeout) {
              setConfig({ ...config, connectTimeout: clamped });
            }
          }}
        />
        {(config.connectTimeout < 1 || config.connectTimeout > 60) && (
          <p className="text-xs text-destructive">
            Must be between 1 and 60 seconds — capped to{' '}
            {Math.min(60, Math.max(1, config.connectTimeout))} on blur.
          </p>
        )}
      </div>
    </SettingsSection>

    {/* WARDEN-928 — removing a host un-discovers every agent on that machine
        (chat catalog, /api/hosts/status, fleet health, the Observer), so the
        delete is confirmed and names the host explicitly. Rendered as a sibling
        of the section (the ObserverSection shape) so it never nests inside the
        chip flow row. Dismissal does NOT call setConfig. */}
    <ConfirmDialog
      open={pendingRemoval !== null}
      onOpenChange={(o) => { if (!o) setPendingRemoval(null); }}
      title={`Remove host "${pendingRemoval ?? ''}"?`}
      description={`Chats and agents on ${pendingRemoval ?? 'this host'} stop being discovered once you press Save — it disappears from the dashboard, host status, fleet health and the Observer. You can re-add it from the "Add Host" picker.`}
      confirmLabel="Remove host"
      destructive
      onConfirm={() => {
        if (pendingRemoval !== null) removeHost(pendingRemoval);
        setPendingRemoval(null);
      }}
    />
    </>
  );
}
