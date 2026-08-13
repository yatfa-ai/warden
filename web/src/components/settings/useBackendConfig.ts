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
import { useState, useEffect, useCallback, useRef } from 'react';
import { toast } from 'sonner';
import { putJson, fetchJson, postJson } from '@/lib/api';
import { type TelemetryTestVerdict } from '@/lib/telemetry/testConnection';
import {
  getTelemetryRuntimeStatus,
  onTelemetryRuntimeStatus,
  clearTelemetryRuntimeDrift,
  type TelemetryRuntimeStatus,
} from '@/lib/electron';
import { type ConfigData } from './types';
import { isBackendConfigDirty, type BackendConfigDraft } from './configDirty';

/**
 * The initial `config` state, held before the GET /api/config load resolves.
 *
 * WARDEN-976 — these values are never RENDERED: SettingsPage mounts the
 * backend-config sections only once `configLoaded` is true, precisely so a
 * never-loaded default can neither be displayed as if it were real nor PUT back
 * over the real persisted configuration. This is the shape the state starts in,
 * not a set of values the user can ever see or save.
 */
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
 * PUT (SettingsPage wires it to App's onConfigChange + close). `onConfigChange`
 * is fired after an INSTANT backend reset so the LIVE app reflects the restored
 * defaults without closing the page (the reset button stays in the danger zone,
 * mirroring the client-prefs reset). Returns a flat bag that SettingsPage
 * destructures and passes through to the backend-touching sections.
 */
export function useBackendConfig({ onSaved, onConfigChange }: { onSaved: () => void; onConfigChange: () => void }) {
  const [config, setConfig] = useState<ConfigData>(DEFAULT_CONFIG);
  const [availableHosts, setAvailableHosts] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  // WARDEN-889 — in-flight flag for the backend-config reset (POST /api/config/
  // reset). Disables the reset button while the round-trip is pending so a user
  // cannot double-fire the destructive action. Distinct from `saving` (the
  // footer PUT) because the two are independent actions with independent gates.
  const [resetting, setResetting] = useState(false);
  // WARDEN-828 — a bounded error state for the GET /api/config load. The prior
  // load path coupled config + hosts in a bare Promise.all with no timeout, so a
  // transiently-slow backend spun `loading` forever. Now config is fetched with a
  // bounded timeout + retry (fetchJson); if it still fails, `loading` clears and
  // `loadError` is set, so the page shows a Retry button instead of an infinite
  // spinner. `loadToken` re-fires the effect via `reload()` (Retry) without
  // unmounting. A hosts failure does NOT set this — see the load effect.
  const [loadError, setLoadError] = useState<{ message: string } | null>(null);
  const [loadToken, setLoadToken] = useState(0);
  // WARDEN-906 — the BASELINE snapshot of "what is persisted", captured when the
  // GET load resolves and re-captured after a successful save. Everything the
  // footer Save would send is diffed against it (see configDirty.ts) to derive
  // `isDirty`, which SettingsPage uses to warn before Back/Cancel discards typed
  // edits. null until the first successful load → not dirty (nothing to lose).
  const [baseline, setBaseline] = useState<BackendConfigDraft | null>(null);
  const reload = useCallback(() => setLoadToken((t) => t + 1), []);
  // Silent reload — re-fetch config WITHOUT flipping `loading` to true, so the
  // post-reset refetch shows no loading affordance at all: the form stays
  // mounted showing the prior values while the GET silently swaps in the
  // restored defaults, rather than reacting to a destructive confirm with a
  // spinner. The ref is read+cleared at the top of the load effect, so it only
  // affects the very next load (a later manual Retry still shows its state).
  // (WARDEN-889)
  //
  // WARDEN-976 note: `loading` no longer gates the whole content pane — the
  // per-section gate keys off `configLoaded`, which stays true across a reset,
  // so the sections could not flash to a loader here even without this flag.
  // It is kept because it still expresses the right intent for this refetch.
  const silentNextLoadRef = useRef(false);
  const reloadSilent = useCallback(() => {
    silentNextLoadRef.current = true;
    setLoadToken((t) => t + 1);
  }, []);

  // Observer auth token — write-only (WARDEN-350). GET /api/config returns only
  // a masked indicator (authTokenSet + optional last-4); there is no cleartext
  // to seed into the password input, so it stays empty until the human types a
  // new token. On save it is sent ONLY when non-empty; an untouched field is
  // omitted so the backend no-clobbers the stored secret.
  //
  // WARDEN-883 — a Remove control can clear the stored token. Because the input
  // is omitted when blank, "untouched" and "remove it" would be indistinguishable
  // on the wire; a `pendingClear` flag marks "the user clicked Remove" so save
  // sends an explicit null (the backend clears to ''). Editing the input cancels
  // a pending clear (typing is the natural undo); after Remove the input is
  // emptied so a blank field + pendingClear = "clear it", while a blank field +
  // no pendingClear = "leave it" (no-clobber).
  const [observerAuthTokenSet, setObserverAuthTokenSet] = useState(false);
  const [observerAuthTokenTail, setObserverAuthTokenTail] = useState<string | null>(null);
  const [observerAuthTokenInput, setObserverAuthTokenInputRaw] = useState('');
  const [observerAuthTokenPendingClear, setObserverAuthTokenPendingClear] = useState(false);
  const setObserverAuthTokenInput = useCallback((v: string) => {
    setObserverAuthTokenPendingClear(false);
    setObserverAuthTokenInputRaw(v);
  }, []);
  const removeObserverAuthToken = useCallback(() => {
    setObserverAuthTokenInputRaw('');
    setObserverAuthTokenPendingClear(true);
  }, []);
  const undoRemoveObserverAuthToken = useCallback(() => {
    setObserverAuthTokenPendingClear(false);
  }, []);

  // Webhook shared secret (WARDEN-555) — write-only, identical discipline to the
  // observer auth token above: GET returns only a set + tail indicator, so the
  // input stays empty until the human types a new secret; on save it is sent ONLY
  // when non-empty, and an untouched field is omitted so the backend no-clobbers
  // the stored secret. WARDEN-883 adds a Remove control (pendingClear → null).
  const [webhookSecretSet, setWebhookSecretSet] = useState(false);
  const [webhookSecretTail, setWebhookSecretTail] = useState<string | null>(null);
  const [webhookSecretInput, setWebhookSecretInputRaw] = useState('');
  const [webhookSecretPendingClear, setWebhookSecretPendingClear] = useState(false);
  const setWebhookSecretInput = useCallback((v: string) => {
    setWebhookSecretPendingClear(false);
    setWebhookSecretInputRaw(v);
  }, []);
  const removeWebhookSecret = useCallback(() => {
    setWebhookSecretInputRaw('');
    setWebhookSecretPendingClear(true);
  }, []);
  const undoRemoveWebhookSecret = useCallback(() => {
    setWebhookSecretPendingClear(false);
  }, []);
  const [testingWebhook, setTestingWebhook] = useState(false);

  // Telemetry receiver auth token (WARDEN-569) — write-only, identical discipline
  // to the webhook secret above: GET returns only a set + tail indicator, so the
  // password input stays empty until the human types a new token; on save it is
  // sent ONLY when non-empty, and an untouched field is omitted so the backend
  // no-clobbers the stored token. Sent on the wire as `Authorization: Bearer`.
  // WARDEN-883 adds a Remove control (pendingClear → null).
  const [telemetryAuthTokenSet, setTelemetryAuthTokenSet] = useState(false);
  const [telemetryAuthTokenTail, setTelemetryAuthTokenTail] = useState<string | null>(null);
  const [telemetryAuthTokenInput, setTelemetryAuthTokenInputRaw] = useState('');
  const [telemetryAuthTokenPendingClear, setTelemetryAuthTokenPendingClear] = useState(false);
  const setTelemetryAuthTokenInput = useCallback((v: string) => {
    setTelemetryAuthTokenPendingClear(false);
    setTelemetryAuthTokenInputRaw(v);
  }, []);
  const removeTelemetryAuthToken = useCallback(() => {
    setTelemetryAuthTokenInputRaw('');
    setTelemetryAuthTokenPendingClear(true);
  }, []);
  const undoRemoveTelemetryAuthToken = useCallback(() => {
    setTelemetryAuthTokenPendingClear(false);
  }, []);

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

  // Load current config and available hosts when the page mounts (and on Retry).
  //
  // WARDEN-828: config and hosts are DECOUPLED. /api/config gates the whole
  // render (every section reads it), so it is fetched with a bounded timeout +
  // retry (fetchJson) and a failure surfaces a clear Retry state rather than
  // spinning forever. /api/ssh-hosts only feeds the host picker, so it is fetched
  // independently — a stall or failure there degrades to "no discovered hosts"
  // plus a toast and MUST NOT block config from rendering. The two promises run
  // concurrently but settle independently; config never waits on hosts.
  useEffect(() => {
    let cancelled = false;
    // A silent reload (post-reset re-fetch) keeps the pane mounted: skip the
    // `loading` flip so the danger zone doesn't flash to the full-pane loader.
    const silent = silentNextLoadRef.current;
    silentNextLoadRef.current = false;
    if (!silent) setLoading(true);
    setLoadError(null);

    // Primary — gates the render. Bounded timeout + retry → ok, or a retry state.
    // Typed as `any` to mirror the prior `fetch().then(r => r.json())` semantics:
    // the response is a loosely-shaped config blob defensively normalized below.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    fetchJson<any>('/api/config').then((result) => {
      if (cancelled) return;
      if (!result.ok) {
        setLoadError({
          message: result.error || 'Failed to load configuration. The backend may be busy or unreachable.',
        });
        setLoading(false);
        return;
      }
      const configData = result.data ?? {};
      const loaded: ConfigData = {
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
      };
      setConfig(loaded);
      // WARDEN-906 — this GET is the persisted truth, so it is also the dirty
      // baseline. The write-only secrets are baselined EMPTY: GET never returns
      // cleartext, so a persisted secret is represented by a blank input +
      // no pending clear (= "leave it alone" on save). Typing one, or arming a
      // Remove, therefore reads as an unsaved change — which it is.
      setBaseline({
        config: loaded,
        observerAuthTokenInput: '',
        observerAuthTokenPendingClear: false,
        webhookSecretInput: '',
        webhookSecretPendingClear: false,
        telemetryAuthTokenInput: '',
        telemetryAuthTokenPendingClear: false,
      });
      setObserverAuthTokenSet(Boolean(configData.llm?.authTokenSet));
      setObserverAuthTokenTail(configData.llm?.authTokenTail ?? null);
      setWebhookSecretSet(Boolean(configData.webhookSecretSet));
      setWebhookSecretTail(configData.webhookSecretTail ?? null);
      setTelemetryAuthTokenSet(Boolean(configData.telemetryAuthTokenSet));
      setTelemetryAuthTokenTail(configData.telemetryAuthTokenTail ?? null);
      setLoading(false);
    });

    // Secondary — host picker only. Failure degrades to no discovered hosts + a
    // toast; it never sets loadError and never blocks the config render above.
    fetchJson<{ hosts?: string[] }>('/api/ssh-hosts').then((result) => {
      if (cancelled) return;
      if (result.ok) {
        setAvailableHosts(result.data?.hosts || []);
      } else {
        toast.error('Could not load discovered SSH hosts — host picker will show only configured hosts.');
      }
    });

    return () => {
      cancelled = true;
    };
  }, [loadToken]);

  const handleSave = async () => {
    setSaving(true);
    try {
      // The auth token is write-only: GET never returns cleartext, so the
      // password field is empty until the human types a new one. Send the typed
      // value only when non-empty; omit it on an untouched field so the backend
      // no-clobbers the stored secret. model/baseUrl/maxTokens round-trip.
      // WARDEN-883: a pending Remove sends explicit null so the backend clears
      // the stored token to '' (distinct from omit = no-clobber).
      const llm: { model: string; baseUrl: string; maxTokens: number | null; authToken?: string | null } = { ...config.llm };
      const token = observerAuthTokenInput.trim();
      if (observerAuthTokenPendingClear) llm.authToken = null;
      else if (token) llm.authToken = token;
      // Webhook secret is write-only too (WARDEN-555): send it only when the human
      // typed a new one; omit it on an untouched field so the backend no-clobbers
      // the stored secret. WARDEN-883: a pending Remove sends explicit null.
      const webhookSecret = webhookSecretInput.trim();
      const webhookExtra: { webhookSecret?: string | null } = {};
      if (webhookSecretPendingClear) webhookExtra.webhookSecret = null;
      else if (webhookSecret) webhookExtra.webhookSecret = webhookSecret;
      // Telemetry auth token is write-only too (WARDEN-569): send it only when the
      // human typed a new one; omit it on an untouched field so the backend
      // no-clobbers the stored token. WARDEN-883: a pending Remove sends null.
      const telemetryAuthToken = telemetryAuthTokenInput.trim();
      const telemetryExtra: { telemetryAuthToken?: string | null } = {};
      if (telemetryAuthTokenPendingClear) telemetryExtra.telemetryAuthToken = null;
      else if (telemetryAuthToken) telemetryExtra.telemetryAuthToken = telemetryAuthToken;
      const { ok, error } = await putJson('/api/config', { ...config, llm, ...webhookExtra, ...telemetryExtra });
      if (!ok) {
        throw new Error(error || 'Failed to save configuration');
      }
      // WARDEN-906 — the PUT succeeded, so what is on screen IS what is
      // persisted: re-baseline to the exact draft that was just sent (config +
      // the secret inputs / pending clears the save consumed) so `isDirty` goes
      // false. This must happen BEFORE onSaved(), which closes the page — the
      // normal save-then-close path must never raise the discard dialog.
      setBaseline({
        config,
        observerAuthTokenInput,
        observerAuthTokenPendingClear,
        webhookSecretInput,
        webhookSecretPendingClear,
        telemetryAuthTokenInput,
        telemetryAuthTokenPendingClear,
      });
      onSaved();
    } catch (err) {
      console.error('Failed to save config:', err);
      toast.error(err instanceof Error ? err.message : 'Failed to save configuration');
    } finally {
      setSaving(false);
    }
  };

  // "Reset backend configuration to defaults" (WARDEN-889): restore EVERY backend
  // preference to its default in one shot. Unlike handleSave (a draft → PUT), this
  // is INSTANT — the backend applies deriveDefaults() live (afterSave re-forwards
  // telemetry, re-applies the companion toggle, restarts the polls) and round-
  // trips through config.json. It also CLEARS the write-only secrets (observer /
  // webhook / telemetry auth tokens) that a normal Save cannot blank (the secret
  // no-clobber preserves an untouched field) — that clear is the whole reason the
  // reset bypasses applyConfigPut. On success we snap the form back to the GET
  // (so the inputs show the restored defaults), clear the write-only secret inputs
  // + their masked indicators, and fire onConfigChange so the LIVE app reflects
  // the reset without closing the page (parity with the client-prefs reset, which
  // also stays open). Pinned chats / notes / session tags are backend-side user
  // data, NOT settings, and are preserved by the backend (internal exposure).
  // NOTE: client-side host labels (UI pref keyed by host) are intentionally NOT
  // touched here — resetting `hosts` to [] can orphan labels for now-absent
  // hosts. Cosmetic and self-healing: a label re-attaches if the host is re-added.
  const resetBackendConfig = async () => {
    setResetting(true);
    try {
      const { ok, error } = await postJson('/api/config/reset', {});
      if (!ok) {
        throw new Error(error || 'Failed to reset backend configuration');
      }
      // Clear the write-only secret inputs + their masked indicators — the
      // backend wiped the stored tokens, so the fields must read empty/unset
      // immediately rather than flashing the stale "set" tail until the reload
      // settles.
      setObserverAuthTokenInput('');
      setObserverAuthTokenSet(false);
      setObserverAuthTokenTail(null);
      setWebhookSecretInput('');
      setWebhookSecretSet(false);
      setWebhookSecretTail(null);
      setTelemetryAuthTokenInput('');
      setTelemetryAuthTokenSet(false);
      setTelemetryAuthTokenTail(null);
      // Re-fetch the config into the form so every input reflects the restored
      // defaults (source of truth — never assume the default map locally). Silent:
      // keep the pane mounted (no full-pane loader flash) while the GET swaps in
      // the defaults behind the still-visible form.
      reloadSilent();
      // Refresh the LIVE app so the reset takes effect app-wide (webhook,
      // observer, poll cadence) without closing Settings.
      onConfigChange();
      toast.success('Backend configuration reset to defaults');
    } catch (err) {
      console.error('Failed to reset backend config:', err);
      toast.error(err instanceof Error ? err.message : 'Failed to reset backend configuration');
    } finally {
      setResetting(false);
    }
  };

  // "Send test alert" (WARDEN-555): POST a test payload so the user can verify
  // their ntfy/Discord/Slack/Telegram topic end-to-end. The draft URL is sent in
  // the BODY so the user can test a typo'd URL BEFORE saving — parity with
  // "Test connection" (sendTestConnection) below. A draft secret is sent only
  // when the human typed a new one; an empty field is omitted so the backend
  // reuses the persisted secret (no-clobber). The button is disabled until both
  // enabled + a URL are set; the response tells us sent / dropped / not-configured.
  const sendTestAlert = async () => {
    setTestingWebhook(true);
    try {
      const draftUrl = config.webhookUrl.trim();
      const draftSecret = webhookSecretInput.trim();
      const res = await fetch('/api/webhook-test', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          webhookUrl: draftUrl,
          ...(draftSecret ? { webhookSecret: draftSecret } : {}),
        }),
      });
      const body = await res.json();
      if (body.ok) {
        toast.success('Test alert sent — check your webhook destination.');
      } else if (body.attempts === 0) {
        toast.error('Enable the webhook and set a URL first.');
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

  // WARDEN-976 — "a GET /api/config has resolved successfully at least once".
  // The baseline is captured ONLY in the GET success handler (and re-captured
  // after a successful PUT), so it already IS that signal — deriving readiness
  // from it rather than adding a parallel flag keeps the two from drifting.
  //
  // This is the readiness input for the per-section gate (sectionLoadGate.ts)
  // and for Save. Note it is deliberately NOT `!loading`: the silent post-reset
  // refetch (reloadSilent) never flips `loading`, and a failed load clears
  // `loading` without ever producing values. "Did a GET ever succeed" is the
  // only question both consumers actually want answered.
  const configLoaded = baseline !== null;

  // WARDEN-906 — derived on every render from the live draft vs the baseline
  // snapshot. Cheap (a structural compare of one small config object) and
  // always in step with the state it describes.
  const isDirty = isBackendConfigDirty(
    {
      config,
      observerAuthTokenInput,
      observerAuthTokenPendingClear,
      webhookSecretInput,
      webhookSecretPendingClear,
      telemetryAuthTokenInput,
      telemetryAuthTokenPendingClear,
    },
    baseline,
  );

  return {
    config,
    setConfig,
    availableHosts,
    loading,
    loadError,
    // WARDEN-976 — per-section readiness + Save safety both key off this rather
    // than off `loading`/`loadError`. See the derivation above.
    configLoaded,
    reload,
    saving,
    handleSave,
    // WARDEN-906 — "the footer Save would send something different from what is
    // persisted". Derived (not stored) so it can never go stale behind the
    // edits it describes. SettingsPage gates Back/Cancel on it; it is also the
    // reusable signal a follow-up can use to disable Save when nothing changed.
    isDirty,
    // Reset every backend preference to its default (WARDEN-889). Instant —
    // persists + live-applies via the backend, distinct from the footer Save.
    resetting,
    resetBackendConfig,
    // Observer write-only auth token.
    observerAuthTokenSet,
    observerAuthTokenTail,
    observerAuthTokenInput,
    setObserverAuthTokenInput,
    observerAuthTokenPendingClear,
    removeObserverAuthToken,
    undoRemoveObserverAuthToken,
    // Webhook write-only secret + test alert.
    webhookSecretSet,
    webhookSecretTail,
    webhookSecretInput,
    setWebhookSecretInput,
    webhookSecretPendingClear,
    removeWebhookSecret,
    undoRemoveWebhookSecret,
    testingWebhook,
    sendTestAlert,
    // Telemetry write-only auth token + test-connection probe + runtime drift.
    telemetryAuthTokenSet,
    telemetryAuthTokenTail,
    telemetryAuthTokenInput,
    setTelemetryAuthTokenInput,
    telemetryAuthTokenPendingClear,
    removeTelemetryAuthToken,
    undoRemoveTelemetryAuthToken,
    telemetryTestLoading,
    telemetryTestVerdict,
    setTelemetryTestVerdict,
    sendTestConnection,
    telemetryRuntimeStatus,
  };
}
