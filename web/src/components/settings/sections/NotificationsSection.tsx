// Notifications section — THREE delivery channels with TWO persistence paths,
// now visually delimited so the split is visible (WARDEN-784): the in-app toast
// toggles + the webhook "push" channel are backend /api/config (drafted, then
// committed by Save), while the OS desktop-alert toggles are pure client
// localStorage (applied instantly). Each channel below is wrapped in a titled
// bordered container that states whether it takes effect on Save or instantly,
// mirroring the titled-container pattern the Webhook block already shipped.
// Extracted from SettingsPage (WARDEN-664); behavior is unchanged — this only
// surfaces the existing persistence split that decomposition made structural.
import { useState } from 'react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { requestAlertPermission } from '@/lib/desktopAlerts';
import { SettingsSection } from '../SettingsSection';
import { type WebhookTestVerdict } from '@/lib/webhook/testAlert';
import { type ConfigData, type SetConfig, type DesktopAlertPrefs } from '../types';

export type NotificationsSectionProps = DesktopAlertPrefs & {
  config: ConfigData;
  setConfig: SetConfig;
  // Webhook write-only shared secret (WARDEN-555): GET returns only a masked
  // set + tail, so the input stays empty until the human types a new one; on
  // save it is sent ONLY when non-empty (handled in useBackendConfig.handleSave).
  // WARDEN-883 — the Remove action queues a clear (pendingClear → save sends
  // explicit null). undoRemove cancels a queued clear before Save.
  webhookSecretSet: boolean;
  webhookSecretTail: string | null;
  webhookSecretInput: string;
  setWebhookSecretInput: (v: string) => void;
  webhookSecretPendingClear: boolean;
  removeWebhookSecret: () => void;
  undoRemoveWebhookSecret: () => void;
  testingWebhook: boolean;
  sendTestAlert: () => void;
  // WARDEN-970 — the last "Send test alert" outcome, rendered as a precise
  // in-section verdict block (the same shape TelemetrySection uses). Transient
  // by design: never persisted, and cleared when the URL/secret it describes is
  // edited.
  webhookTestVerdict: WebhookTestVerdict | null;
  setWebhookTestVerdict: (v: WebhookTestVerdict | null) => void;
  hidden: boolean;
};

export function NotificationsSection(props: NotificationsSectionProps) {
  const {
    attentionDesktopAlerts, setAttentionDesktopAlerts,
    attentionStates, setAttentionStates,
    config, setConfig,
    webhookSecretSet, webhookSecretTail, webhookSecretInput, setWebhookSecretInput,
    webhookSecretPendingClear, removeWebhookSecret, undoRemoveWebhookSecret,
    testingWebhook, sendTestAlert,
    webhookTestVerdict, setWebhookTestVerdict,
    hidden,
  } = props;

  // WARDEN-883 — confirm the irreversible secret removal before queueing it.
  const [confirmRemoveOpen, setConfirmRemoveOpen] = useState(false);

  return (
    <>
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
          client-side localStorage pref. Applied INSTANTLY — no Save needed. On
          enable we request OS permission fire-and-forget; if denied the toggle
          still flips on but notifications simply no-op until granted. The titled
          bordered container mirrors the Webhook block below (WARDEN-784).

          WARDEN-1274 — the copy below is deliberately NARROWER than it was. This
          toggle used to be introduced as "alerts when agents need attention",
          which described the fleet attention alert; that channel is retired
          (its trigger was a regex GUESS over pane text). The toggle survives
          because it is the only opt-in on two channels that still fire — the
          token-budget notification and the per-chat watch ping — so the label
          now names exactly those. Do not restore the old wording. */}
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
              Desktop notifications while Warden is in the background
            </Label>
          </div>
          <p className="text-xs text-muted-foreground">
            Show an OS notification when a chat you’re <strong>watching</strong> matches one of your patterns, or when your <strong>token budget</strong> is breached — while you’re in another app. Clicking it focuses Warden. Your OS will ask for permission when you turn this on.
          </p>
        </div>

        {/* Per-state toggle (WARDEN-344): which pane states raise the
            Attention badge. Each defaults ON; a human can hide a noisy
            "waiting" without losing "erroring". Same client-side persistence as
            the master toggle above. WARDEN-1274: these are now purely DISPLAY
            filters on the passive badge/rundown — the desktop alert they also
            gated is retired, so nothing here interrupts the human. */}
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap gap-x-4 gap-y-2">
            {([
              { k: 'erroring', label: 'Erroring', hint: 'errors / stack traces' },
              { k: 'stuck', label: 'Stuck', hint: 'repeating-output loops' },
              { k: 'waiting', label: 'Waiting on you', hint: 'human-input prompts' },
              { k: 'blocked', label: 'Blocked', hint: 'coordination / dependency' },
              // WARDEN-575: the POSITIVE "finished" state — a recently-working
              // agent going idle. Surfaces the green Finished section. (Its done
              // desktop ping went with WARDEN-1274: active→idle is inferred from
              // pane text, so a crash back to a prompt read as a success.)
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
            Which agent pane states appear in the Attention badge and rundown. Turn a noisy one off without losing the others.
          </p>

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
            onChange={(e) => {
              setConfig({ ...config, webhookUrl: e.target.value });
              // An edited URL invalidates any prior test result (WARDEN-970).
              setWebhookTestVerdict(null);
            }}
            placeholder="https://ntfy.sh/your-topic"
          />
          <p className="text-xs text-muted-foreground">
            Leave blank for unconfigured (sends nothing). Alerts go only to this URL — a destination you control, never a third-party service.
          </p>
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="webhookSecret">Shared secret (optional)</Label>
          <div className="flex items-center gap-2">
            <Input
              id="webhookSecret"
              type="password"
              className="flex-1"
              value={webhookSecretInput}
              onChange={(e) => {
                setWebhookSecretInput(e.target.value);
                // An edited secret invalidates any prior test result (WARDEN-970).
                setWebhookTestVerdict(null);
              }}
              placeholder={
                webhookSecretPendingClear
                  ? 'Will be removed on Save'
                  : webhookSecretSet
                    ? `••••• set${webhookSecretTail ? ` (…${webhookSecretTail})` : ''}`
                    : 'Not set'
              }
            />
            {/* WARDEN-883 — Remove surfaces only when a secret is stored and not
                already queued for removal. The confirm dialog gates the click. */}
            {webhookSecretSet && !webhookSecretPendingClear && (
              <Button
                variant="outline"
                size="sm"
                className="shrink-0"
                onClick={() => setConfirmRemoveOpen(true)}
              >
                Remove
              </Button>
            )}
          </div>
          {webhookSecretPendingClear ? (
            <p className="text-xs text-amber-600 dark:text-amber-400">
              The saved secret will be removed when you press Save.{' '}
              <Button
                type="button"
                variant="link"
                size="sm"
                className="h-auto p-0 align-baseline"
                onClick={undoRemoveWebhookSecret}
              >
                Undo
              </Button>
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">
              {webhookSecretSet
                ? `A secret is saved${webhookSecretTail ? ` (ends …${webhookSecretTail})` : ''}. It is sent as Authorization: Bearer and X-Webhook-Secret. Type a new one to replace it; leave blank to keep it.`
                : 'Optional. Sent as Authorization: Bearer and X-Webhook-Secret so your endpoint can verify the request. Leave blank if your topic needs no auth.'}
            </p>
          )}
        </div>

        <div className="flex flex-col gap-2">
          <span className="text-sm font-medium">Which alerts to push</span>
          <div className="flex flex-wrap gap-x-4 gap-y-2">
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
            Budget alerts fire once per crossing of your token-spend threshold. Finished alerts fire once when an agent’s container ends.
          </p>
        </div>

        {/* WARDEN-970 — config-time verification, mirroring the Telemetry
            "Test connection" probe. No enable-gate: the backend already forces
            webhookEnabled for this one sanctioned explicit-send path (the click
            IS the human's opt-in to send), so a typo'd URL or a wrong secret can
            be verified BEFORE enabling and saving. The outcome renders below as
            a precise, persistent verdict naming the failure mode in plain
            language — not a transient toast with a raw HTTP code. Never
            persisted: it recomputes on every click and clears when the URL or
            secret it describes is edited. */}
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={sendTestAlert}
              disabled={testingWebhook || !config.webhookUrl.trim()}
            >
              {testingWebhook ? 'Sending…' : 'Send test alert'}
            </Button>
            <span className="text-xs text-muted-foreground">
              Verifies your topic receives it. Uses the URL and secret above — no Save required.
            </span>
          </div>
          {webhookTestVerdict && (
            <div
              className={
                webhookTestVerdict.tone === 'positive'
                  ? 'rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-700 dark:text-emerald-400'
                  : 'rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400'
              }
              data-webhook-test-verdict={webhookTestVerdict.kind}
              role={webhookTestVerdict.tone === 'positive' ? 'status' : 'alert'}
            >
              <p className="font-medium">{webhookTestVerdict.label}</p>
              <p>{webhookTestVerdict.message}</p>
            </div>
          )}
        </div>
      </div>
    </SettingsSection>

    {/* WARDEN-883 — confirm the secret removal before queueing the clear. */}
    <ConfirmDialog
      open={confirmRemoveOpen}
      onOpenChange={(o) => { if (!o) setConfirmRemoveOpen(false); }}
      title="Remove saved webhook secret?"
      description="The stored shared secret will be deleted from config.json, and webhook alerts will be sent without Authorization: Bearer / X-Webhook-Secret. You'll need to re-enter a secret if your topic requires auth. Applies when you press Save."
      confirmLabel="Remove secret"
      destructive
      onConfirm={() => { removeWebhookSecret(); setConfirmRemoveOpen(false); }}
    />
    </>
  );
}
