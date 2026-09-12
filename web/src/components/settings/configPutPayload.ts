// The PUT /api/config request-body builder for Settings (WARDEN-1343).
//
// Extracted verbatim from useBackendConfig's handleSave so the payload-build
// seam is a pure, importable function — that seam had no test because the
// hook body is not callable outside React ("no front-end test runner in this
// repo"), and WARDEN-1343 is exactly a payload-build defect: the body the
// save path sent could contain a value the server refuses.
//
// ── Why tokenBudgetWindowHours is coerced here, and only it ──────────────────
//
// A cleared "Window (hours)" input drafts `null` (TokenBudgetSection's
// onChange maps empty → null). The server's `flooredNumber` guard accepts
// null only for `nullable: true` fields — and `tokenBudgetWindowHours` is
// deliberately `nullable: false` (src/config-schema.js: the asymmetry vs the
// two thresholds, WARDEN-773 corr. 3, pinned by src/config-schema.test.js
// 'windowHours null IGNORED (asymmetry)'). Before this module existed the
// null went onto the wire, the server refused it silently-into-`refused`, the
// prior custom value survived on disk, and handleSave's unconditional
// WARDEN-906 re-baseline marked the never-persisted clear as saved — while
// the placeholder ("Default 24"), the helper text, the onBlur comment and
// NULL_MEANS_DEFAULT_FIELDS all promised the opposite. The client carries the
// wrong half of the contract, so the clear gesture is materialized to the
// default HERE, at the save boundary: null → 24. `flooredNumber` then accepts
// it, nothing is refused, and the reopened Settings renders 24 — the
// "screen == persisted" invariant holds again.
//
// The value is DERIVED, never a second hardcoded literal: it reads
// `configFieldDefault('tokenBudgetWindowHours')`, i.e. `normalizeLoadedConfig({})`
// — the same derivation prefDefaultDiff.test.mjs pins field-by-field against
// `deriveDefaults()` in src/config-schema.js — so the client default cannot
// drift from the schema.
//
// The two nullable-DISABLE budget fields are deliberately NOT coerced: for
// `observerSessionTimeout` and `tokenBudgetPerSessionThresholdTokens`, null
// means DISABLED — a real user choice the server accepts (`nullable: true`)
// and WARDEN-1178 made load-bearing. Coercing either here would silently
// un-disable the feature. The genuinely clear-to-default-at-read fields
// (healthWarning/CriticalThresholdMin, tokenBudgetThresholdTokens, llm.maxTokens)
// are also untouched: the server already resolves their null to the default
// and persists that.
import { configFieldDefault } from './prefDefaultDiff';
import type { ConfigData } from './types';

/**
 * The write-only-secret extras handleSave layers on top of the config draft.
 * Shaped exactly as useBackendConfig declares them (WARDEN-555 / WARDEN-569 /
 * WARDEN-883): a pending Remove sends explicit null so the backend clears the
 * stored secret; an untouched field omits the key so the backend no-clobbers.
 */
export interface ConfigPutSecretExtras {
  webhookSecret?: string | null;
  telemetryAuthToken?: string | null;
}

/**
 * Build the PUT /api/config body from the drafted config plus the three
 * secret masses handleSave assembles. Pure: reads its arguments, mutates
 * nothing (the draft keeps its null — the pre-save "cleared" rendering and
 * the per-row affordance's at-default reading both stay truthful; the save
 * is what materializes 24).
 */
export function buildConfigPutPayload(
  config: ConfigData,
  llm: ConfigData['llm'],
  webhookExtra: ConfigPutSecretExtras,
  telemetryExtra: ConfigPutSecretExtras,
): Record<string, unknown> {
  return {
    ...config,
    llm,
    ...webhookExtra,
    ...telemetryExtra,
    // WARDEN-1343 — the one key that must never go over the wire as null.
    // Last in the object so it wins over the config spread regardless of
    // what the draft holds.
    tokenBudgetWindowHours:
      config.tokenBudgetWindowHours ?? configFieldDefault('tokenBudgetWindowHours'),
  };
}
