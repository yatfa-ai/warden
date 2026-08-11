// The "are there unsaved backend edits?" seam for Settings (WARDEN-906).
//
// Backend-config sections edit the `config` object held in useBackendConfig
// state; nothing persists until the footer Save fires PUT /api/config. Before
// this module there was no baseline to diff against, so both exit paths (Back /
// Cancel) dropped typed edits with zero warning. The hook now snapshots a
// BASELINE on load (and re-snapshots on a successful save) and diffs the live
// draft against it; SettingsPage gates its exits on the result.
//
// The comparison lives here — pure, dependency-free (the single `import type`
// is erased at transpile time) — so the dirty rule is unit-testable without a
// DOM or a React renderer. See settingsDirty.test.mjs.
//
// SCOPE: backend config ONLY. The instant client-pref sections (Appearance /
// NewChats / Snippets) persist immediately via App's saveUi effect and are never
// "unsaved", so keying the guard off this module's snapshot excludes them by
// construction — the same partition types.ts draws between the two persistence
// models.
import type { ConfigData } from './types';

/**
 * Everything a Save would send: the round-tripped `config` plus the three
 * WRITE-ONLY secrets, which are NOT part of `config` (GET returns only a masked
 * set+tail indicator) and so must be diffed alongside it. Each secret
 * contributes two ways a Save can differ from what is persisted:
 *   - a typed value in its input (sent on save), and
 *   - a pending Remove (WARDEN-883 — sends an explicit null on save).
 * Both are unsaved work worth warning about, so both are part of the snapshot.
 */
export interface BackendConfigDraft {
  config: ConfigData;
  observerAuthTokenInput: string;
  observerAuthTokenPendingClear: boolean;
  webhookSecretInput: string;
  webhookSecretPendingClear: boolean;
  telemetryAuthTokenInput: string;
  telemetryAuthTokenPendingClear: boolean;
}

/**
 * Structural equality for the config blob. `config` is not flat — it nests
 * `llm`, a `hosts: string[]`, and `watchPatterns: WatchPattern[]` (objects) —
 * so a shallow compare would miss a renamed pattern or a changed observer
 * model, and a JSON.stringify compare would be key-order sensitive (sections
 * rebuild the object via spread, which preserves order today but is not a
 * property worth depending on).
 *
 * An ABSENT key and an explicit `undefined` compare equal: the optional Display
 * fields (showHostTags & co.) may be absent on one side and defaulted on the
 * other, and that is not an edit the user made.
 */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  for (const key of new Set([...Object.keys(ao), ...Object.keys(bo)])) {
    if (!deepEqual(ao[key], bo[key])) return false;
  }
  return true;
}

/**
 * True when the live draft would send something different from the baseline —
 * i.e. there are unsaved backend edits and leaving now would silently drop them.
 *
 * A null baseline means the GET /api/config load has not resolved yet (or
 * failed): there is nothing to diff against and no edit could have been made
 * through a form that never rendered, so it reads NOT dirty — leaving stays
 * frictionless on the loading/retry states.
 *
 * Secrets are compared TRIMMED because that is exactly how handleSave treats
 * them (`input.trim()`, omitted when empty): a field holding only whitespace
 * sends nothing, so it is not a pending change and must not raise the dialog.
 */
export function isBackendConfigDirty(
  current: BackendConfigDraft,
  baseline: BackendConfigDraft | null,
): boolean {
  if (!baseline) return false;
  return (
    !deepEqual(current.config, baseline.config) ||
    current.observerAuthTokenInput.trim() !== baseline.observerAuthTokenInput.trim() ||
    current.observerAuthTokenPendingClear !== baseline.observerAuthTokenPendingClear ||
    current.webhookSecretInput.trim() !== baseline.webhookSecretInput.trim() ||
    current.webhookSecretPendingClear !== baseline.webhookSecretPendingClear ||
    current.telemetryAuthTokenInput.trim() !== baseline.telemetryAuthTokenInput.trim() ||
    current.telemetryAuthTokenPendingClear !== baseline.telemetryAuthTokenPendingClear
  );
}
