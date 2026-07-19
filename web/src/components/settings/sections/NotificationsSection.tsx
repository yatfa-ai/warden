// Notifications section — THREE delivery channels with TWO persistence paths,
// now visually delimited so the split is visible (WARDEN-784): the in-app toast
// toggles + the webhook "push" channel are backend /api/config (drafted, then
// committed by Save), while the OS desktop-alert toggles are pure client
// localStorage (applied instantly). Each channel below is wrapped in a titled
// bordered container that states whether it takes effect on Save or instantly,
// mirroring the titled-container pattern the Webhook block already shipped.
// Extracted from SettingsPage (WARDEN-664); behavior is unchanged — this only
// surfaces the existing persistence split that decomposition made structural.
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { requestAlertPermission } from '@/lib/desktopAlerts';
import { SettingsSection } from '../SettingsSection';
import { type ConfigData, type SetConfig, type DesktopAlertPrefs } from '../types';

export type NotificationsSectionProps = DesktopAlertPrefs & {
  config: ConfigData;
  setConfig: SetConfig;
  // Webhook write-only shared secret (WARDEN-555): GET returns only a masked
  // set + tail, so the input stays empty until the human types a new one; on
  // save it is sent ONLY when non-empty (handled in useBackendConfig.handleSave).
  webhookSecretSet: boolean;
  webhookSecretTail: string | null;
  webhookSecretInput: string;
  setWebhookSecretInput: (v: string) => void;
  testingWebhook: boolean;
  sendTestAlert: () => void;
  hidden: boolean;
};

export function NotificationsSection(props: NotificationsSectionProps) {
  const {
    attentionDesktopAlerts, setAttentionDesktopAlerts,
    attentionStates, setAttentionStates,
    alertCritical, setAlertCritical,
    alertWarning, setAlertWarning,
    alertDirective, setAlertDirective,
    alertError, setAlertError,
    config, setConfig,
    webhookSecretSet, webhookSecretTail, webhookSecretInput, setWebhookSecretInput,
    testingWebhook, sendTestAlert,
    hidden,
  } = props;

  return (
    <SettingsSection title="Notifications" className={hidden ? 'hidden' : undefined}>
      {/* Channel 1 of 3 — In-app toasts. Backend /api/config: drafted into
          `config` here, committed only when the human presses Save in the
          footer (NOT instant). The titled bordered container mirrors the
          Webhook block below (WARDEN-784). */}
      <div className="flex flex-col gap-3 rounded-md border border-border/60 p-3 mt-2">
        <div className="flex flex-col gap-1">
          <span className="text-sm font-medium">In-app toasts</span>
          <span className="text-xs text-muted-foreground">
            Toast notifications inside Warden. Saved when you press Save.
          </span>
        </div>

        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <Switch
              id="notifyChatOps"
              checked={config.notifyChatOps}
              onCheckedChange={(v) => setConfig({ ...config, notifyChatOps: v })}
            />
            <Label htmlFor="notifyChatOps" className="cursor-pointer">
              Chat operations
            </Label>
          </div>
          <p className="text-xs text-muted-foreground">
            Session kill, chat kill, resume, and rename notifications
          </p>
        </div>

        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <Switch
              id="notifyErrors"
              checked={config.notifyErrors}
              onCheckedChange={(v) => setConfig({ ...config, notifyErrors: v })}
            />
            <Label htmlFor="notifyErrors" className="cursor-pointer">
              Errors
            </Label>
          </div>
          <p className="text-xs text-muted-foreground">Error toast notifications</p>
        </div>

        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <Switch
              id="notifySuccess"
              checked={config.notifySuccess}
              onCheckedChange={(v) => setConfig({ ...config, notifySuccess: v })}
            />
            <Label htmlFor="notifySuccess" className="cursor-pointer">
              Success messages
            </Label>
          </div>
          <p className="text-xs text-muted-foreground">Success toast notifications</p>
        </div>

        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <Switch
              id="notifyObserver"
              checked={config.notifyObserver}
              onCheckedChange={(v) => setConfig({ ...config, notifyObserver: v })}
            />
            <Label htmlFor="notifyObserver" className="cursor-pointer">
              Observer events
            </Label>
          </div>
          <p className="text-xs text-muted-foreground">
            Observer connection timeout and gate prompt notifications
          </p>
        </div>
      </div>

      {/* Channel 2 of 3 — Desktop alerts (WARDEN-259). A DIFFERENT channel +
          persistence path than the toast toggles above. Those gate in-app
          toasts via the server-side `config` / PUT /api/config; this is a pure
          client-side localStorage pref that fires an OS notification when an
          agent newly needs attention while Warden is UNFOCUSED (the always-on
          badge already covers the in-app case). Applied INSTANTLY — no Save
          needed. On enable we request OS permission fire-and-forget; if denied
          the toggle still flips on but alerts simply no-op until granted. The
          titled bordered container mirrors the Webhook block below (WARDEN-784). */}
      <div className="flex flex-col gap-3 rounded-md border border-border/60 p-3 mt-2">
        <div className="flex flex-col gap-1">
          <span className="text-sm font-medium">Desktop alerts</span>
          <span className="text-xs text-muted-foreground">
            Applied instantly and remembered locally on this device.
          </span>
        </div>

        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <Switch
              id="attentionDesktopAlerts"
              checked={attentionDesktopAlerts}
              onCheckedChange={(v) => {
                setAttentionDesktopAlerts(v);
                if (v) void requestAlertPermission();
              }}
            />
            <Label htmlFor="attentionDesktopAlerts" className="cursor-pointer">
              Desktop alerts when agents need attention (while Warden is unfocused)
            </Label>
          </div>
          <p className="text-xs text-muted-foreground">
            Show an OS notification when an agent needs attention — critical/warning, a newly stuck/erroring/waiting/blocked pane, or a new directive/error — while you’re in another app. Clicking it focuses Warden. Your OS will ask for permission when you turn this on.
          </p>
        </div>

        {/* Per-state toggle (WARDEN-344): which pane states raise the
            Attention badge + desktop alert. Each defaults ON; a human can
            silence a noisy "waiting" without losing "erroring". Same
            client-side channel/persistence as the master toggle above. */}
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap gap-x-4 gap-y-2">
            {([
              { k: 'erroring', label: 'Erroring', hint: 'errors / stack traces' },
              { k: 'stuck', label: 'Stuck', hint: 'repeating-output loops' },
              { k: 'waiting', label: 'Waiting on you', hint: 'human-input prompts' },
              { k: 'blocked', label: 'Blocked', hint: 'coordination / dependency' },
              // WARDEN-575: the POSITIVE "finished" state — a recently-working
              // agent going idle. Surfaces the green Finished section + a done
              // desktop ping. Distinct from the problem states (it is a review
              // cue, not an alarm) but gated the same way.
              { k: 'done', label: 'Finished', hint: 'agent completed a task' },
            ] as const).map(({ k, label, hint }) => (
              <div key={k} className="flex items-center gap-2">
                <Switch
                  id={`attention-state-${k}`}
                  checked={attentionStates[k] !== false}
                  onCheckedChange={(v) => setAttentionStates({ ...attentionStates, [k]: v })}
                />
                <Label htmlFor={`attention-state-${k}`} className="cursor-pointer leading-tight">
                  {label}
                  <span className="block text-[10px] text-muted-foreground font-normal">{hint}</span>
                </Label>
              </div>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">
            Which agent pane states raise the Attention badge (and desktop alert). Turn a noisy one off without losing the others.
          </p>

          {/* WARDEN-364 — per-severity routing, nested under the master
              toggle. Greyed + inert while the master is off: the whole
              channel is off then, so routing is moot. Defaults are all
              ON (behavior-preserving); the human opts buckets OUT. */}
          <div className={cn('pl-4 ml-1 flex flex-col gap-2 border-l border-border/60', !attentionDesktopAlerts && 'pointer-events-none opacity-50')}>
            <div className="flex items-center gap-2">
              <Switch id="alertCritical" checked={alertCritical} disabled={!attentionDesktopAlerts} onCheckedChange={setAlertCritical} />
              <Label htmlFor="alertCritical" className="cursor-pointer">Critical agents</Label>
            </div>
            <div className="flex items-center gap-2">
              <Switch id="alertWarning" checked={alertWarning} disabled={!attentionDesktopAlerts} onCheckedChange={setAlertWarning} />
              <Label htmlFor="alertWarning" className="cursor-pointer">Warning agents</Label>
            </div>
            <div className="flex items-center gap-2">
              <Switch id="alertDirective" checked={alertDirective} disabled={!attentionDesktopAlerts} onCheckedChange={setAlertDirective} />
              <Label htmlFor="alertDirective" className="cursor-pointer">Pending directives</Label>
            </div>
            <div className="flex items-center gap-2">
              <Switch id="alertError" checked={alertError} disabled={!attentionDesktopAlerts} onCheckedChange={setAlertError} />
              <Label htmlFor="alertError" className="cursor-pointer">Recent errors</Label>
            </div>
            <p className="text-xs text-muted-foreground">
              Choose which signals escalate to the desktop. To mute a specific agent, use the bell on its row in the attention menu (health signals only — directives and errors aren’t per-agent).
            </p>
          </div>
        </div>
      </div>

      {/* Channel 3 of 3 — Webhook "push" delivery channel (WARDEN-555). A THIRD
          channel alongside the in-app toast + OS desktop alert: it POSTs the
          alert to the user's OWN webhook URL (ntfy/Discord/Slack/Telegram/
          Home Assistant) so a human AWAY from the machine still gets pinged,
          even with the Warden window closed to tray. Off by default; sends
          nothing until a URL is set + enabled. Payload goes only to the user's
          URL (no yatfa SaaS) — same stance as the LLM API + telemetry
          endpoints. Persisted server-side via /api/config (NOT client
          localStorage) so it survives a restart — committed by Save, like the
          toast toggles above. This titled bordered container is the pattern
          channels 1 and 2 now mirror (WARDEN-784). */}
      <div className="flex flex-col gap-3 rounded-md border border-border/60 p-3 mt-2">
        <div className="flex flex-col gap-1">
          <span className="text-sm font-medium">Webhook push alerts</span>
          <span className="text-xs text-muted-foreground">
            Deliver critical alerts to your own webhook URL (ntfy, Discord, Slack, Telegram, Home Assistant) so you’re pinged on your phone even when Warden is closed to tray. Off by default. Saved when you press Save.
          </span>
        </div>

        <div className="flex items-center gap-2">
          <Switch
            id="webhookEnabled"
            checked={config.webhookEnabled}
            onCheckedChange={(v) => setConfig({ ...config, webhookEnabled: v })}
          />
          <Label htmlFor="webhookEnabled" className="cursor-pointer">
            Enable webhook push
          </Label>
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="webhookUrl">Webhook URL</Label>
          <Input
            id="webhookUrl"
            value={config.webhookUrl}
            onChange={(e) => setConfig({ ...config, webhookUrl: e.target.value })}
            placeholder="https://ntfy.sh/your-topic"
          />
          <p className="text-xs text-muted-foreground">
            Leave blank for unconfigured (sends nothing). Alerts go only to this URL — a destination you control, never a third-party service.
          </p>
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="webhookSecret">Shared secret (optional)</Label>
          <Input
            id="webhookSecret"
            type="password"
            value={webhookSecretInput}
            onChange={(e) => setWebhookSecretInput(e.target.value)}
            placeholder={webhookSecretSet ? `••••• set${webhookSecretTail ? ` (…${webhookSecretTail})` : ''}` : 'Not set'}
          />
          <p className="text-xs text-muted-foreground">
            {webhookSecretSet
              ? `A secret is saved${webhookSecretTail ? ` (ends …${webhookSecretTail})` : ''}. It is sent as Authorization: Bearer and X-Webhook-Secret. Type a new one to replace it; leave blank to keep it.`
              : 'Optional. Sent as Authorization: Bearer and X-Webhook-Secret so your endpoint can verify the request. Leave blank if your topic needs no auth.'}
          </p>
        </div>

        <div className="flex flex-col gap-2">
          <span className="text-sm font-medium">Which alerts to push</span>
          <div className="flex flex-wrap gap-x-4 gap-y-2">
            <div className="flex items-center gap-2">
              <Switch
                id="webhookAlertAttention"
                checked={config.webhookAlertAttention}
                onCheckedChange={(v) => setConfig({ ...config, webhookAlertAttention: v })}
              />
              <Label htmlFor="webhookAlertAttention" className="cursor-pointer leading-tight">
                Attention
                <span className="block text-[10px] text-muted-foreground font-normal">stuck / erroring / waiting / blocked</span>
              </Label>
            </div>
            <div className="flex items-center gap-2">
              <Switch
                id="webhookAlertBudget"
                checked={config.webhookAlertBudget}
                onCheckedChange={(v) => setConfig({ ...config, webhookAlertBudget: v })}
              />
              <Label htmlFor="webhookAlertBudget" className="cursor-pointer leading-tight">
                Token budget
                <span className="block text-[10px] text-muted-foreground font-normal">fleet / per-session breach</span>
              </Label>
            </div>
            {/* WARDEN-575: the POSITIVE "finished" push — a recently-working
                agent going idle, or a container genuinely ending. Non-
                alarming; the missing positive half of the alert loop. */}
            <div className="flex items-center gap-2">
              <Switch
                id="webhookAlertDone"
                checked={config.webhookAlertDone}
                onCheckedChange={(v) => setConfig({ ...config, webhookAlertDone: v })}
              />
              <Label htmlFor="webhookAlertDone" className="cursor-pointer leading-tight">
                Finished
                <span className="block text-[10px] text-muted-foreground font-normal">agent completed a task</span>
              </Label>
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            Attention alerts fire once per new transition into a stuck/erroring/waiting/blocked pane state. Budget alerts fire once per crossing of your token-spend threshold. Finished alerts fire once when a recently-working agent goes idle (or its container ends).
          </p>
        </div>

        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={sendTestAlert}
            disabled={testingWebhook || !config.webhookEnabled || !config.webhookUrl.trim()}
          >
            {testingWebhook ? 'Sending…' : 'Send test alert'}
          </Button>
          <span className="text-xs text-muted-foreground">
            Verify your topic receives it. Fires only when enabled with a URL set.
          </span>
        </div>
      </div>
    </SettingsSection>
  );
}
