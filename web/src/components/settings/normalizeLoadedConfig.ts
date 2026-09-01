// The post-GET normalization seam for Settings (WARDEN-1178).
//
// `GET /api/config` returns a loosely-shaped blob (an older backend may omit
// fields entirely), so useBackendConfig defensively normalizes it into a
// well-formed `ConfigData` before that object becomes BOTH the rendered state
// and the dirty baseline. That normalization used to live inline in the hook's
// fetch callback; it is relocated here — pure, dependency-free (the single
// `import type` is erased at transpile time) — so the rules can be unit-tested
// without React, a DOM, or a network. See normalizeLoadedConfig.test.mjs.
//
// ── The distinction this module exists to preserve ───────────────────────────
//
// Two fields use `null` to mean DISABLED, and for them an ABSENT field and an
// explicit `null` are NOT the same thing:
//
//   - `observerSessionTimeout`     — null = never auto-close Observer tabs.
//   - `tokenBudgetPerSessionThresholdTokens` — null = per-session alarm off.
//
// `null` genuinely round-trips: both Sections write null when their input is
// emptied (placeholders "Disabled when empty" / "Empty disables the per-session
// alarm"), `config-schema.js` passes null through UNclamped as the deliberate
// disable path, and the GET resolver emits it verbatim. So a `?? default` here
// coerces the user's "off" back into a number — and because the same object is
// also handed to `setBaseline`, `isBackendConfigDirty` reads NOT dirty, the
// unsaved-changes guard never fires, and the next Save of any unrelated field
// re-PUTs the coerced number over the user's choice. Silent, and self-reversing.
//
// Hence the shape used for those two: `null` is preserved, a number passes
// through, and only an ABSENT (or malformed) value falls back to the default —
// the same fail-safe-for-unknown intent the old code had, minus the conflation.
// This mirrors `App.tsx`'s reader, which states the invariant outright: "`?? null`
// preserves an explicit null (disabled) and coalesces an absent field to null".
//
// ⚠ The neighbouring `??` defaults are NOT the same case and are deliberately
// left alone. For the FLEET threshold (`tokenBudgetThresholdTokens`) null means
// "use the default" — `budget.js` resolves null → DEFAULT_TOKEN_BUDGET_THRESHOLD
// (2,000,000), which is exactly this fallback, so coercing it is correct. The
// health thresholds and `pollIntervalMs` are not nullable at all. Only the two
// fields above carry the disable meaning; copy the discrimination, not the guard.
import type { ConfigData } from './types';

/**
 * Normalize one of the two DISABLE-PATH numeric prefs.
 *
 * An explicit `null` is the user's "off" and is preserved verbatim. A real
 * number passes through. Anything else — the field absent from an older
 * backend's response, or a malformed value — falls back to `fallback`, which is
 * the fail-safe for UNKNOWN and is unchanged from the previous behavior.
 */
function nullableNumberPreservingDisable(value: unknown, fallback: number): number | null {
  if (value === null) return null;
  return typeof value === 'number' ? value : fallback;
}

/**
 * Build the well-formed `ConfigData` the Settings form renders and baselines,
 * from the raw `GET /api/config` payload.
 *
 * Typed as `any` to mirror the hook's prior `fetch().then(r => r.json())`
 * semantics: the response is a loosely-shaped config blob, defensively
 * normalized here.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function normalizeLoadedConfig(rawConfigData: any): ConfigData {
  // The hook already applies `result.data ?? {}`; this repeats it so the helper
  // is total on its own (a null/undefined payload normalizes to all-defaults)
  // and so every field expression below stays byte-identical to the inline
  // original it was relocated from — only the two WARDEN-1178 lines differ.
  const configData = rawConfigData ?? {};
  return {
    hosts: configData.hosts || [],
    pollIntervalMs: configData.pollIntervalMs || 1500,
    tmuxSession: configData.tmuxSession || 'agent',
    connectTimeout: configData.connectTimeout || 10,
    observerConfirmMode: ['always', 'auto-safe'].includes(configData.observerConfirmMode)
      ? configData.observerConfirmMode
      : 'always',
    observerAutoStart: configData.observerAutoStart || false,
    // WARDEN-1178 — null is DISABLED (never auto-close) and must survive the
    // load; only an ABSENT field falls back to 30. See the module header.
    observerSessionTimeout: nullableNumberPreservingDisable(configData.observerSessionTimeout, 30),
    llm: {
      model: configData.llm?.model ?? '',
      baseUrl: configData.llm?.baseUrl ?? '',
      maxTokens: typeof configData.llm?.maxTokens === 'number' ? configData.llm.maxTokens : null,
    },
    healthWarningThresholdMin: configData.healthWarningThresholdMin ?? 5,
    healthCriticalThresholdMin: configData.healthCriticalThresholdMin ?? 30,
    tokenBudgetEnabled: configData.tokenBudgetEnabled ?? false,
    // NOT a disable path: for the FLEET threshold null means "use the default",
    // and budget.js resolves null to exactly this 2,000,000. Left as-is.
    tokenBudgetThresholdTokens:
      typeof configData.tokenBudgetThresholdTokens === 'number'
        ? configData.tokenBudgetThresholdTokens
        : 2_000_000,
    tokenBudgetWindowHours:
      typeof configData.tokenBudgetWindowHours === 'number'
        ? configData.tokenBudgetWindowHours
        : 24,
    // WARDEN-1178 — null is DISABLED (per-session alarm off) and must survive
    // the load; only an ABSENT field falls back to 1,000,000.
    tokenBudgetPerSessionThresholdTokens: nullableNumberPreservingDisable(
      configData.tokenBudgetPerSessionThresholdTokens,
      1_000_000,
    ),
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
    // WARDEN-1116 — per-category consent, each independent and defaulting to
    // OFF when the backend omits it (a partial/older GET can never turn a
    // category on by accident).
    telemetryIncidentsEnabled: configData.telemetryIncidentsEnabled === true,
    telemetryNamesEnabled: configData.telemetryNamesEnabled === true,
    // WARDEN-1258 — the operational-metrics category rides the same defensive
    // `=== true` rule: an older backend omitting the field stays safely OFF.
    telemetryOperationalMetricsEnabled: configData.telemetryOperationalMetricsEnabled === true,
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
}
