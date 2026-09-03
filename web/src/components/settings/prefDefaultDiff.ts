// The "is this ONE preference still at its default?" seam for Settings
// (WARDEN-1276).
//
// Settings shipped exactly two revert paths, and both are all-or-nothing:
// the footer Cancel (whole SECTION, backend sections only) and the two
// Reset-everything buttons in the danger zone, whose collateral WARDEN-956/957
// had to spell out (the client reset wipes presets/snippets/host labels; the
// backend reset deletes watch patterns and hosts). A user who wants ONE
// preference back to its default has no path that does not cost everything
// else. This module is the comparator behind the per-row "reset to default"
// affordance that closes that gap: the affordance renders ONLY when a row's
// current value differs from its default, so its mere visibility doubles as the
// VS Code-style "modified" indicator.
//
// ── The two persistence models, and why there are two comparators ────────────
//
// Settings' rows split along the SAME line types.ts and sectionPersistence.ts
// already draw (WARDEN-1210's per-section dependency map is the ONE
// classification source — behavior branches on it, never on a hand-list here):
//
//   • CLIENT prefs   — localStorage, applied instantly through a per-field
//                      setter and persisted by App's saveUi effect. Their
//                      defaults come from `resetUiPrefDefaults()`.
//   • BACKEND config — drafted into `config` and committed only by the footer
//                      Save (PUT /api/config). Their defaults come from
//                      `normalizeLoadedConfig({})`.
//
// ── Why those two default sources, and NOT a new constant ────────────────────
//
// This ticket adds ZERO preferences and ZERO defaults. Both comparators read a
// default source that already exists and is already the one production uses:
//
//   • `resetUiPrefDefaults()` (WARDEN-896) is the LIVE-state default of every
//     resettable client pref, and it carries one deliberate deviation from
//     DEFAULT_UI that matters here: `terminalFontFamily` is
//     DEFAULT_TERMINAL_FONT_FAMILY rather than DEFAULT_UI's `''` sentinel. `''`
//     is correct for the PERSISTED shape but App's live initializer coerces it,
//     and the font Select has no `''` option — so comparing a live value
//     against DEFAULT_UI directly would report the untouched default font as
//     "modified" and then restore a value that renders as "Custom…". Riding the
//     existing factory inherits the correct deviation (and its anti-aliasing
//     guarantee) instead of re-opening the trap.
//
//   • `normalizeLoadedConfig({})` is the backend default set AS THE WEB SEES
//     IT: normalizing an EMPTY GET payload yields exactly the ConfigData a
//     fresh install renders. It is the same function useBackendConfig runs on
//     every load, so the comparator's baseline is definitionally the shape the
//     sections display. web/prefDefaultDiff.test.mjs pins it field-by-field
//     against `deriveDefaults()` in src/config-schema.js — the registry
//     `resetConfig` itself iterates — so the two cannot drift silently.
//
// ── Deliberately NOT the same question as `isBackendConfigDirty` ─────────────
//
// configDirty.ts asks "does the DRAFT differ from the last SAVED baseline?"
// (unsaved work). This asks "does the value differ from its DEFAULT?" A field
// saved long ago at a non-default value is clean-but-modified: not dirty, and
// this affordance still shows. The two are orthogonal; only the structural
// comparator is shared (see the deepEqual import).
import { deepEqual } from './configDirty';
import { normalizeLoadedConfig } from './normalizeLoadedConfig';
import { resetUiPrefDefaults, type ResettableKey, type ResetUiDefaults } from '@/lib/storage';
import type { ConfigData } from './types';

// ---------------------------------------------------------------------------
// Client prefs (instant, localStorage)
// ---------------------------------------------------------------------------

/** The default LIVE value of one client pref (see the header on why this rides
 *  `resetUiPrefDefaults()` rather than DEFAULT_UI). */
export function clientPrefDefault<K extends ResettableKey>(key: K): ResetUiDefaults[K] {
  return resetUiPrefDefaults()[key];
}

/**
 * Whether a client pref's CURRENT live value differs from its default — i.e.
 * whether the per-row restore affordance should render on that row.
 *
 * Structural, not `===`: several of these prefs are objects/arrays
 * (`attentionStates`, `healthCollapsedHosts`, `customPresets`), and a freshly
 * built default object is never reference-equal to the live one even when the
 * two are identical.
 */
export function clientPrefDiffersFromDefault(key: ResettableKey, value: unknown): boolean {
  return !deepEqual(value, clientPrefDefault(key));
}

// ---------------------------------------------------------------------------
// Backend config fields (drafted, committed by Save)
// ---------------------------------------------------------------------------

/**
 * The backend default set as the web renders it — `normalizeLoadedConfig` over
 * an empty payload. Rebuilt per call (never a shared module constant) so a
 * caller that spreads or mutates the result can never corrupt the baseline the
 * next comparison reads, mirroring `deriveDefaults()`'s clone discipline and
 * `resetUiPrefDefaults()`'s factory rule.
 */
export function configFieldDefaults(): ConfigData {
  return normalizeLoadedConfig({});
}

/**
 * A comparable backend field: a `ConfigData` key, or a dotted path into the one
 * nested group the Settings form edits field-by-field (`llm.model`,
 * `llm.baseUrl`, `llm.maxTokens` — ObserverSection renders each as its own row,
 * so each needs its own affordance).
 */
export type ConfigFieldPath = string;

/** Read a (possibly dotted) path out of a config-shaped object. */
function readPath(source: unknown, path: ConfigFieldPath): unknown {
  let cursor: unknown = source;
  for (const segment of path.split('.')) {
    if (cursor === null || typeof cursor !== 'object') return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

/** The default value of one backend field (dotted paths supported). */
export function configFieldDefault(path: ConfigFieldPath): unknown {
  return readPath(configFieldDefaults(), path);
}

/**
 * The nullable numeric fields whose EMPTY input means "use the default", so a
 * `null` draft is AT default and must NOT show the affordance.
 *
 * This is the exact discrimination normalizeLoadedConfig.ts documents at
 * length, read from the other side. Two nullable fields are deliberately ABSENT
 * from this set because for them `null` is a real user choice — DISABLED, not
 * "default":
 *
 *   • `observerSessionTimeout`                — null = never auto-stop Observer
 *                                               ("Disabled when empty").
 *   • `tokenBudgetPerSessionThresholdTokens`  — null = per-session alarm off
 *                                               ("Empty disables the per-session alarm").
 *
 * Cleared to null, those two DIFFER from their defaults (30 / 1,000,000) and
 * correctly offer a restore. Copy the discrimination, not the guard.
 */
const NULL_MEANS_DEFAULT_FIELDS: ReadonlySet<ConfigFieldPath> = new Set([
  // "Leave empty for the default (5)" / "(30)" — the classifier resolves null
  // to these, so an emptied field IS the default.
  'healthWarningThresholdMin',
  'healthCriticalThresholdMin',
  // "Leave empty for the default (2,000,000)" — budget.js resolves null to
  // exactly the default (normalizeLoadedConfig says so explicitly).
  'tokenBudgetThresholdTokens',
  // "Default 24".
  'tokenBudgetWindowHours',
  // "Leave empty for the default (2048)" — llm.js owns the fallback.
  'llm.maxTokens',
]);

/**
 * Whether a backend config field's CURRENT DRAFT value differs from its
 * default — i.e. whether the per-row restore affordance should render.
 *
 * Three rules the naive `value !== default` misses:
 *
 *  1. ABSENT ≡ DEFAULT. The Display fields are optional on `ConfigData` and the
 *     section renders `config.showHostTags ?? true`, so an absent field
 *     DISPLAYS as its default. Treating absent as modified would paint a bogus
 *     "modified" affordance on every never-touched optional field of a fresh
 *     install. This mirrors deepEqual's documented absent≡undefined rule, and
 *     is why the comparison runs through it.
 *  2. NULL-MEANS-DEFAULT. See NULL_MEANS_DEFAULT_FIELDS above.
 *  3. STRUCTURAL. `llm` / `hosts` / `watchPatterns` are objects and arrays.
 */
export function configFieldDiffersFromDefault(path: ConfigFieldPath, value: unknown): boolean {
  if (value === undefined) return false; // rule 1
  if (value === null && NULL_MEANS_DEFAULT_FIELDS.has(path)) return false; // rule 2
  return !deepEqual(value, configFieldDefault(path)); // rule 3
}

/**
 * Convenience over a whole draft: read the field out of `config` and compare.
 * Sections call THIS (rather than threading the value themselves) so the read
 * and the restore write cannot drift apart on a dotted path.
 */
export function configDraftDiffersFromDefault(config: ConfigData, path: ConfigFieldPath): boolean {
  return configFieldDiffersFromDefault(path, readPath(config, path));
}

/**
 * The draft a restore commits: `config` with ONE field set back to its default.
 *
 * Returns a NEW object (never mutates the draft) so it slots straight into the
 * `setConfig({ ...config, field: value })` spread-from-closure pattern every
 * backend section already uses — the footer Save/Cancel contract is untouched:
 * the restore shows up as a pending edit in the existing `isDirty` state, Save
 * commits it via PUT, Cancel discards it.
 */
export function configDraftWithFieldRestored(config: ConfigData, path: ConfigFieldPath): ConfigData {
  const segments = path.split('.');
  const defaultValue = configFieldDefault(path);
  if (segments.length === 1) {
    return { ...config, [segments[0]]: defaultValue };
  }
  // One nesting level is all the Settings form edits (`llm.*`); deeper paths
  // would need a recursive rebuild and have no call site, so they are refused
  // loudly rather than silently writing the wrong shape.
  if (segments.length !== 2) {
    throw new Error(`configDraftWithFieldRestored: unsupported nested path "${path}"`);
  }
  const [group, field] = segments;
  const currentGroup = (config as unknown as Record<string, unknown>)[group];
  const nextGroup = {
    ...(currentGroup && typeof currentGroup === 'object' ? currentGroup : {}),
    [field]: defaultValue,
  };
  return { ...config, [group]: nextGroup };
}
