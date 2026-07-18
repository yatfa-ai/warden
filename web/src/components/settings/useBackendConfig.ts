// The backend `/api/config` persistence seam for Settings (WARDEN-664).
//
// Extracted from the prior 3,314-line SettingsPage god-component. Everything in
// this hook is the BACKEND persistence model: the `config` state (GET/PUT
// /api/config), the write-only secrets (observer auth token / webhook secret /
// telemetry auth token — GET never returns cleartext, so they live in their own
// inputs and are sent on save only when typed), the live test/runtime status
// (webhook test alert, telemetry test-connection probe, telemetry runtime drift
// push), and the atomic load + save.
//
// Client localStorage prefs are deliberately NOT here (they are App-owned,
// persisted by App's saveUi effect) — keeping the two persistence models in
// separate modules is what makes the "client pref never reaches PUT /api/config"
// invariant structural rather than comment-enforced.
//
// The logic is relocated verbatim from SettingsPage; no useState/effect/rule is
// altered, only moved.
import { useState, useEffect } from 'react';
import { toast } from 'sonner';
import { putJson } from '@/lib/api';
import { type TelemetryTestVerdict } from '@/lib/telemetry/testConnection';
import {
  getTelemetryRuntimeStatus,
  onTelemetryRuntimeStatus,
  clearTelemetryRuntimeDrift,
  type TelemetryRuntimeStatus,
} from '@/lib/electron';
import { type ConfigData } from './types';

/** The default `config` state, used before the GET /api/config load resolves. */
const DEFAULT_CONFIG: ConfigData = {
  hosts: [],
  pollIntervalMs: 1500,
  tmuxSession: 'agent',
  connectTimeout: 10,
  observerConfirmMode: 'always',
  observerAutoStart: false,
  observerSessionTimeout: 30,
  llm: { model: '', baseUrl: '', maxTokens: null },
  healthWarningThresholdMin: 5,
  healthCriticalThresholdMin: 30,
  tokenBudgetEnabled: false,
  tokenBudgetThresholdTokens: 2_000_000,
  tokenBudgetWindowHours: 24,
  tokenBudgetPerSessionThresholdTokens: 1_000_000,
  companionTransportEnabled: false,
  companionTransportOverridden: false,
  confirmDestructiveActions: true,
  notifyChatOps: true,
  notifyErrors: true,
  notifySuccess: true,
  notifyObserver: true,
  // Display customization
  showHostTags: true,
  showTypeBadges: true,
  showStatusIndicators: true,
  showProjectBadges: false,
  hideOfflineHosts: false,
  // Telemetry consent (WARDEN-457) — off by default.
  telemetryBaseEnabled: false,
  telemetryExtendedEnabled: false,
  // Receiver endpoint (WARDEN-522) — empty by default = unconfigured = no-op.
  telemetryEndpoint: '',
  // Webhook push channel (WARDEN-555) — off by default; both routing toggles on.
  webhookUrl: '',
  webhookEnabled: false,
  webhookAlertAttention: true,
  webhookAlertBudget: true,
  webhookAlertDone: true,
  // WARDEN-540 — empty until the GET /api/config load populates it.
  watchPatterns: [],
};

/**
 * Owns the backend config state + its GET/PUT round-trip + the write-only
 * secrets + the live test/runtime status. `onSaved` is fired after a successful
 * PUT (SettingsPage wires it to App's onConfigChange + close). Returns a flat
 * bag that SettingsPage destructures and passes through to the backend-touching
 * sections.
 */
export function useBackendConfig({ onSaved }: { onSaved: () => void }) {
  const [config, setConfig] = useState<ConfigData>(DEFAULT_CONFIG);
  const [availableHosts, setAvailableHosts] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // Observer auth token — write-only (WARDEN-350). GET /api/config returns only
  // a masked indicator (authTokenSet + optional last-4); there is no cleartext
  // to seed into the password input, so it stays empty until the human types a
  // new token. On save it is sent ONLY when non-empty; an untouched field is
  // omitted so the backend no-clobbers the stored secret.
  const [observerAuthTokenSet, setObserverAuthTokenSet] = useState(false);
  const [observerAuthTokenTail, setObserverAuthTokenTail] = useState<string | null>(null);
  const [observerAuthTokenInput, setObserverAuthTokenInput] = useState('');

  // Webhook shared secret (WARDEN-555) — write-only, identical discipline to the
  // observer auth token above: GET returns only a set + tail indicator, so the
  // input stays empty until the human types a new secret; on save it is sent ONLY
  // when non-empty, and an untouched field is omitted so the backend no-clobbers
  // the stored secret.
  const [webhookSecretSet, setWebhookSecretSet] = useState(false);
  const [webhookSecretTail, setWebhookSecretTail] = useState<string | null>(null);
  const [webhookSecretInput, setWebhookSecretInput] = useState('');
  const [testingWebhook, setTestingWebhook] = useState(false);

  // Telemetry receiver auth token (WARDEN-569) — write-only, identical discipline
  // to the webhook secret above: GET returns only a set + tail indicator, so the
  // password input stays empty until the human types a new token; on save it is
  // sent ONLY when non-empty, and an untouched field is omitted so the backend
  // no-clobbers the stored token. Sent on the wire as `Authorization: Bearer`.
  const [telemetryAuthTokenSet, setTelemetryAuthTokenSet] = useState(false);
  const [telemetryAuthTokenTail, setTelemetryAuthTokenTail] = useState<string | null>(null);
  const [telemetryAuthTokenInput, setTelemetryAuthTokenInput] = useState('');

  // "Test connection" probe state (WARDEN-595). The verdict is NOT the destination
  // label's "configured" non-claim — it is a LIVE probe of the receiver's
  // /capabilities (reachable + schema-matched + authed), driven through the backend
  // (renderer→receiver is cross-origin → CORS-blocked). It stays in component state
  // only — never persisted (a cached "connected" goes stale: receiver down, token
  // rotated). `telemetryTestVerdict` is one of the four kinds the backend returns, or
  // null before the first probe / after the endpoint it was derived from changes.
  const [telemetryTestLoading, setTelemetryTestLoading] = useState(false);
  const [telemetryTestVerdict, setTelemetryTestVerdict] = useState<TelemetryTestVerdict | null>(null);

  // WARDEN-631 — the RUNTIME telemetry drift status, pushed from main (the pipeline
  // arms a per-endpoint breaker on a 415 schema mismatch) and pulled on mount. null
  // before the first pull resolves; deriveTelemetryRuntimeStatus maps null → ok, so
  // nothing renders until main has unambiguously reported drift. Like the test
  // verdict this is live-only — never persisted (drift re-arms on the next send).
  const [telemetryRuntimeStatus, setTelemetryRuntimeStatus] = useState<TelemetryRuntimeStatus | null>(null);
  useEffect(() => {
    // Pull the current value on mount (a window opened AFTER drift armed must show
    // it immediately), then subscribe to live PUSH updates (the bridge fires only on
    // an arm/clear, so the warning appears the moment a 415 lands). Both accessors
    // no-op cleanly when the Electron bridge is absent (browser/dev/smoke). `pushed`
    // guards the merge race: if a fresher push lands before the pull resolves, the
    // pull's (now-stale) snapshot is discarded rather than clobbering the live value.
    let cancelled = false;
    let pushed = false;
    getTelemetryRuntimeStatus().then((status) => {
      if (!cancelled && !pushed) setTelemetryRuntimeStatus(status);
    });
    const unsubscribe = onTelemetryRuntimeStatus((status) => {
      pushed = true;
      setTelemetryRuntimeStatus(status);
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  // Load current config and available hosts when the page mounts.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([
      fetch('/api/config').then((r) => r.json()),
      fetch('/api/ssh-hosts').then((r) => r.json()),
    ])
      .then(([configData, hostsData]) => {
        if (cancelled) return;
        setConfig({
          hosts: configData.hosts || [],
          pollIntervalMs: configData.pollIntervalMs || 1500,
          tmuxSession: configData.tmuxSession || 'agent',
          connectTimeout: configData.connectTimeout || 10,
          observerConfirmMode: ['always', 'auto-safe'].includes(configData.observerConfirmMode)
            ? configData.observerConfirmMode
            : 'always',
          observerAutoStart: configData.observerAutoStart || false,
          observerSessionTimeout: configData.observerSessionTimeout ?? 30,
          llm: {
            model: configData.llm?.model ?? '',
            baseUrl: configData.llm?.baseUrl ?? '',
            maxTokens: typeof configData.llm?.maxTokens === 'number' ? configData.llm.maxTokens : null,
          },
          healthWarningThresholdMin: configData.healthWarningThresholdMin ?? 5,
          healthCriticalThresholdMin: configData.healthCriticalThresholdMin ?? 30,
          tokenBudgetEnabled: configData.tokenBudgetEnabled ?? false,
          tokenBudgetThresholdTokens:
            typeof configData.tokenBudgetThresholdTokens === 'number'
              ? configData.tokenBudgetThresholdTokens
              : 2_000_000,
          tokenBudgetWindowHours:
            typeof configData.tokenBudgetWindowHours === 'number'
              ? configData.tokenBudgetWindowHours
              : 24,
          tokenBudgetPerSessionThresholdTokens:
            typeof configData.tokenBudgetPerSessionThresholdTokens === 'number'
              ? configData.tokenBudgetPerSessionThresholdTokens
              : 1_000_000,
          companionTransportEnabled: configData.companionTransportEnabled ?? false,
          companionTransportOverridden: configData.companionTransportOverridden ?? false,
          confirmDestructiveActions: configData.confirmDestructiveActions ?? true,
          notifyChatOps: configData.notifyChatOps ?? true,
          notifyErrors: configData.notifyErrors ?? true,
          notifySuccess: configData.notifySuccess ?? true,
          notifyObserver: configData.notifyObserver ?? true,
          // Display customization
          showHostTags: configData.showHostTags ?? true,
          showTypeBadges: configData.showTypeBadges ?? true,
          showStatusIndicators: configData.showStatusIndicators ?? true,
          showProjectBadges: configData.showProjectBadges ?? false,
          hideOfflineHosts: configData.hideOfflineHosts ?? false,
          // Telemetry consent (WARDEN-457) — defensive ?? false so an older
          // backend that does not return the fields stays safely OFF.
          telemetryBaseEnabled: configData.telemetryBaseEnabled ?? false,
          telemetryExtendedEnabled: configData.telemetryExtendedEnabled ?? false,
          // Defensive ?? '' so an older backend that does not return the field
          // stays safely unconfigured (empty = sends nothing).
          telemetryEndpoint: configData.telemetryEndpoint ?? '',
          // Webhook push channel (WARDEN-555). Defensive fallbacks so an older
          // backend without these fields stays safely OFF / unconfigured.
          webhookUrl: configData.webhookUrl ?? '',
          webhookEnabled: configData.webhookEnabled ?? false,
          webhookAlertAttention: configData.webhookAlertAttention ?? true,
          webhookAlertBudget: configData.webhookAlertBudget ?? true,
          webhookAlertDone: configData.webhookAlertDone ?? true,
          // WARDEN-540: patterns are sanitized on the PUT boundary, so the GET
          // response is already well-formed. Defensive ?? [] keeps an older backend
          // (no watchPatterns field) safely empty → no alerts.
          watchPatterns: Array.isArray(configData.watchPatterns) ? configData.watchPatterns : [],
        });
        setAvailableHosts(hostsData.hosts || []);
        setObserverAuthTokenSet(Boolean(configData.llm?.authTokenSet));
        setObserverAuthTokenTail(configData.llm?.authTokenTail ?? null);
        setWebhookSecretSet(Boolean(configData.webhookSecretSet));
        setWebhookSecretTail(configData.webhookSecretTail ?? null);
        setTelemetryAuthTokenSet(Boolean(configData.telemetryAuthTokenSet));
        setTelemetryAuthTokenTail(configData.telemetryAuthTokenTail ?? null);
      })
      .catch((err) => {
        console.error('Failed to load config:', err);
        toast.error('Failed to load configuration');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleSave = async () => {
    setSaving(true);
    try {
      // The auth token is write-only: GET never returns cleartext, so the
      // password field is empty until the human types a new one. Send the typed
      // value only when non-empty; omit it on an untouched field so the backend
      // no-clobbers the stored secret. model/baseUrl/maxTokens round-trip.
      const llm: { model: string; baseUrl: string; maxTokens: number | null; authToken?: string } = { ...config.llm };
      const token = observerAuthTokenInput.trim();
      if (token) llm.authToken = token;
      // Webhook secret is write-only too (WARDEN-555): send it only when the human
      // typed a new one; omit it on an untouched field so the backend no-clobbers
      // the stored secret.
      const webhookSecret = webhookSecretInput.trim();
      const webhookExtra: { webhookSecret?: string } = {};
      if (webhookSecret) webhookExtra.webhookSecret = webhookSecret;
      // Telemetry auth token is write-only too (WARDEN-569): send it only when the
      // human typed a new one; omit it on an untouched field so the backend
      // no-clobbers the stored token.
      const telemetryAuthToken = telemetryAuthTokenInput.trim();
      const telemetryExtra: { telemetryAuthToken?: string } = {};
      if (telemetryAuthToken) telemetryExtra.telemetryAuthToken = telemetryAuthToken;
      const { ok, error } = await putJson('/api/config', { ...config, llm, ...webhookExtra, ...telemetryExtra });
      if (!ok) {
        throw new Error(error || 'Failed to save configuration');
      }
      onSaved();
    } catch (err) {
      console.error('Failed to save config:', err);
      toast.error(err instanceof Error ? err.message : 'Failed to save configuration');
    } finally {
      setSaving(false);
    }
  };

  // "Send test alert" (WARDEN-555): POST a test payload so the user can verify
  // their ntfy/Discord/Slack/Telegram topic end-to-end. The endpoint honors the
  // on-the-wire gate (enabled + URL), so the button is disabled until both are
  // set; the response tells us sent / dropped / not-configured. This MUST be
  // called after a Save when the user just typed a new URL/secret/enable — the
  // backend reads the PERSISTED config, not the in-memory draft.
  const sendTestAlert = async () => {
    setTestingWebhook(true);
    try {
      const res = await fetch('/api/webhook-test', { method: 'POST' });
      const body = await res.json();
      if (body.ok) {
        toast.success('Test alert sent — check your webhook destination.');
      } else if (body.attempts === 0) {
        toast.error('Enable the webhook and set a URL first, then Save.');
      } else if (body.dropped) {
        toast.error(`Could not deliver (last status ${body.status ?? 'n/a'}). Check the URL and try again.`);
      } else {
        toast.error('Test alert did not succeed.');
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to send test alert');
    } finally {
      setTestingWebhook(false);
    }
  };

  // "Test connection" (WARDEN-595): probe the configured receiver's /capabilities
  // through the backend (the renderer→receiver fetch is cross-origin → CORS-blocked,
  // so it MUST go via /api/telemetry-test, exactly like sendTestAlert). Unlike
  // webhook-test, the endpoint/token are sent in the BODY so the user can test a
  // typo'd URL BEFORE saving — and the backend falls back to the persisted token when
  // no draft is supplied (the token is write-only, so this component never holds its
  // cleartext). The verdict is rendered as a precise multi-line result below the
  // button, not just a toast, because the four states carry distinct, actionable copy.
  // Never persisted — a cached "connected" would go stale (receiver down, token
  // rotated) and become a false trust signal.
  const sendTestConnection = async () => {
    const endpoint = config.telemetryEndpoint.trim();
    if (!endpoint) return; // button is disabled when blank, but guard anyway
    setTelemetryTestLoading(true);
    setTelemetryTestVerdict(null);
    try {
      // Send the draft token only when the human typed a new one; omit it on an
      // untouched field so the backend uses the persisted token (no-clobber parity).
      const draftToken = telemetryAuthTokenInput.trim();
      const res = await fetch('/api/telemetry-test', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ endpoint, ...(draftToken ? { token: draftToken } : {}) }),
      });
      const body = await res.json();
      if (body && typeof body.kind === 'string' && typeof body.message === 'string') {
        setTelemetryTestVerdict(body as TelemetryTestVerdict);
        // WARDEN-631 — a 'connected' probe means the receiver is schema-matched, so
        // any stale runtime drift breaker is resolved: clear it so sends resume
        // (and so the drift warning does not contradict a green 'Connected'). This
        // is the in-session recovery path for a receiver fixed at the same url,
        // which setEndpoint's change-guard would otherwise leave wedged. Harmless
        // when the probe tested a still-unsaved draft endpoint: a save re-points
        // the endpoint (clearing drift via setEndpoint) and a lingering drift on
        // the old endpoint would just re-arm on the next 415. The returned status
        // updates the warning immediately; the push is authoritative on changes.
        if ((body as TelemetryTestVerdict).kind === 'connected') {
          clearTelemetryRuntimeDrift().then((status) => setTelemetryRuntimeStatus(status));
        }
      } else if (body && typeof body.error === 'string') {
        setTelemetryTestVerdict({ kind: 'no-receiver', ok: false, message: body.error });
      } else {
        setTelemetryTestVerdict({
          kind: 'no-receiver',
          ok: false,
          message: 'Could not interpret the receiver response.',
        });
      }
    } catch (err) {
      setTelemetryTestVerdict({
        kind: 'no-receiver',
        ok: false,
        message: err instanceof Error ? err.message : 'Failed to test the connection.',
      });
    } finally {
      setTelemetryTestLoading(false);
    }
  };

  return {
    config,
    setConfig,
    availableHosts,
    loading,
    saving,
    handleSave,
    // Observer write-only auth token.
    observerAuthTokenSet,
    observerAuthTokenTail,
    observerAuthTokenInput,
    setObserverAuthTokenInput,
    // Webhook write-only secret + test alert.
    webhookSecretSet,
    webhookSecretTail,
    webhookSecretInput,
    setWebhookSecretInput,
    testingWebhook,
    sendTestAlert,
    // Telemetry write-only auth token + test-connection probe + runtime drift.
    telemetryAuthTokenSet,
    telemetryAuthTokenTail,
    telemetryAuthTokenInput,
    setTelemetryAuthTokenInput,
    telemetryTestLoading,
    telemetryTestVerdict,
    setTelemetryTestVerdict,
    sendTestConnection,
    telemetryRuntimeStatus,
  };
}
