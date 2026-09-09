// The single source of truth for warden's user-facing config preferences.
//
// Before WARDEN-773, a preference had to be wired through FOUR hand-maintained
// sites (the "silent no-op trap," knowledge c7dcce65; caused ship-level
// regressions WARDEN-115/131/164): config.js DEFAULTS, the GET /api/config
// response object, the PUT /api/config destructure + guard chain, and the
// if(cfg.X) consumer. A field present in one list but missing from another was
// silently inert — no error, just a preference that did nothing.
//
// This module collapses the first three sites into one CONFIG_FIELDS registry.
// Each field is declared ONCE with its full semantics (default, type/exposure,
// PUT guard, GET resolution, GET order), and DEFAULTS / GET / PUT are DERIVED
// from it. Adding a preference is now a one-descriptor edit; the GET/PUT lists
// cannot drift because they no longer exist as hand-maintained lists.
//
// The 4th site (the `if (cfg.X)` consumer) is genuine per-feature logic and is
// deliberately NOT declarable — it stays at its call sites (out of scope).
//
// CONTRACT: the derived DEFAULTS, GET response, and PUT behavior are byte- and
// behavior-identical to the pre-refactor handlers (pinned by
// src/server-config-registry.test.js + the sibling server-config*.test.js
// files). The descriptor-schema shape is this module's design call; the pin is
// the external contract.

import { sanitizeWatchPatterns } from './agentState.js';
// WARDEN-1116 — THE telemetry consent authority. Its category registry DRIVES the
// telemetry consent fields below, so adding a category is one entry there rather
// than a new descriptor (plus a new GET key, a new PUT guard, a new default…)
// here. `.cjs` is CommonJS regardless of this package's "type": "module", and the
// module is pure + dependency-free — importing it pulls in no Electron and no
// renderer code; it is simply the ONE resolver implementation the main process
// and the server both run.
import {
  TELEMETRY_CATEGORIES,
  migrateConsentPrefs,
  resolveConsent,
} from './telemetry-consent.cjs';

// GET-order rank of the first telemetry consent category. Categories occupy
// consecutive ranks from here in registry order — 38/39 today, preserving the
// byte-pinned position the legacy telemetryBaseEnabled/telemetryExtendedEnabled
// pair held.
const TELEMETRY_CONSENT_ORDER = 38;

// exposure values:
//   'public'   — in DEFAULTS, emitted in GET (by resolve rule), accepted in PUT.
//   'secret'   — in DEFAULTS, emitted in GET as {key}Set + {key}Tail only,
//                accepted in PUT as NO-CLOBBER (only a non-empty string writes).
//   'derived'  — NOT in DEFAULTS (computed from a boot context, e.g. env), emit
//                in GET only; never in PUT.
//   'internal' — in DEFAULTS only; never in GET, never in PUT (e.g. pins/notes,
//                which are managed by their own endpoints).
//
// type values (the PUT guard + the value class):
//   'array'                   — truthy array (hosts).
//   'number'                  — typeof number (optional clamp: [min,max]; a
//                               side may be null = unbounded on that side).
//   'string'                  — typeof string.
//   'boolean'                 — typeof boolean.
//   'oneOf'                   — truthy + member of `oneOf`.
//   'nullablePositiveNumber'  — null OR a finite number > 0 (clamped into its
//                               advertised range when `clamp` is present).
//   'flooredNumber'           — finite number → Math.max(1, x); accepts null
//                               iff `nullable: true` (the tokenBudget asymmetry).
//   'watchPatterns'           — sanitizeWatchPatterns (null → no mutation).
//   'secret'                  — non-empty string only (no-clobber).
//   'llm'                     — nested object; sub-fields described by `fields`.
//
// range descriptors (WARDEN-1331 — the BOUNDS axis gets the same one-place
// treatment the type axis got from this registry):
//   clamp:   [min, max] — the range the PUT guards ENFORCE. `null` on a side =
//              unbounded on that side (the min-only [1, null] health bounds).
//              Honored only by types that read it ('number',
//              'nullablePositiveNumber'); validateRegistry rejects it anywhere
//              else so "added clamp: to a registry entry" can never again be a
//              silent no-op. buildBounds serves every clamp over GET.
//   uiRange: [min, max] — the WEB INPUT band for a field the server
//              deliberately does NOT clamp (pollIntervalMs: the CLI reads the
//              stored value raw at a 1500 default below this band). Metadata
//              only — never enforces a PUT. Served over GET alongside clamp.
//   Neither: emitted in `bounds` from the flooredNumber guard (min 1) so the
//              tokenBudget inputs derive their floor from the server too.
//
// resolve values (the GET emission for 'public' fields; default 'identity'):
//   'identity'    — cfg[key]
//   'neqFalse'    — cfg[key] !== false   (default-true toggle)
//   'eqTrue'      — cfg[key] === true    (strict toggle)
//   'orEmpty'     — cfg[key] ?? ''
//   'arrayOrEmpty'— Array.isArray(cfg[key]) ? cfg[key] : []
//
// order: the rank in the GET response. The GET key order is byte-pinned
// (server-config-registry.test.js), so every GET-visible field carries the rank
// that reproduces the pre-refactor order. DEFAULTS order is instead the array
// order below (config.json's persisted key order follows DEFAULTS).

export const CONFIG_FIELDS = [
  {
    key: 'hosts',
    default: [],
    exposure: 'public',
    type: 'array',
    resolve: 'identity',
    order: 1,
    // SSH host aliases to scan (from ~/.ssh/config). Add yours in
    // ~/.yatfa-warden/config.json
  },
  {
    key: 'tmuxSession',
    default: 'agent',
    exposure: 'public',
    type: 'string',
    resolve: 'identity',
    order: 3,
    // tmux session name yatfa creates inside each container
  },
  {
    key: 'connectTimeout',
    default: 10,
    exposure: 'public',
    type: 'number',
    clamp: [1, 60],
    resolve: 'identity',
    order: 4,
    // WARDEN-747: clamp into the [1, 60] bounds the Settings input advertises —
    // mirrors the WARDEN-374 threshold-clamp discipline so a direct API call
    // (or a typed out-of-range value the UI's onBlur didn't catch) can't
    // persist 0/999/negative. The committed value matches what the UI displays.
    // (Downstream read sites use `cfg.connectTimeout ?? 10`; ssh.js's control-
    // master separately re-clamps to [3,20].)
  },
  {
    key: 'pollIntervalMs',
    default: 1500,
    exposure: 'public',
    type: 'number',
    resolve: 'identity',
    order: 2,
    // WARDEN-1331 — deliberately NOT clamped server-side, and this is a stated
    // decision, not an omission. The field is shared with the CLI, whose watch
    // mode reads it RAW (`src/cli.js`: `cfg.pollIntervalMs || 1500`) and whose
    // default (1500) sits far BELOW the web input band; any server-side clamp
    // at the web floor would rewrite the CLI's legitimate cadence on the next
    // web save, and a [1,∞) clamp would enforce nothing the typeof guard
    // doesn't. What the web control needs — the INPUT band it advertises and
    // clamps to on blur — is declared ONCE here as `uiRange` and served over
    // GET in `bounds` (buildBounds), so the frontend no longer hand-copies it.
    // `uiRange` is metadata only: it never clamps a PUT. The web resolver
    // (resolvePollIntervalMs) remains the enforcement for stale/CLI values.
    uiRange: [10_000, 120_000],
  },
  {
    key: 'pins',
    default: [],
    exposure: 'internal',
    // chat ids to surface first in listings / UI
  },
  {
    key: 'agentNotes',
    default: {},
    exposure: 'internal',
    // id → short human note (mirrors pins; works for un-renameable yatfa agents)
  },
  {
    key: 'sessionTags',
    default: {},
    exposure: 'internal',
    // claude-session id → string[] of short reusable labels (WARDEN-342); local
    // sidecar, never written to transcripts
  },
  {
    key: 'watchPatterns',
    default: [],
    exposure: 'public',
    type: 'watchPatterns',
    resolve: 'arrayOrEmpty',
    order: 37,
    // User-authored output-pattern alerts (WARDEN-540). The deterministic,
    // zero-LLM, user-authored complement to the fixed Watch categories: a human
    // teaches Warden "ping me when a watched agent prints X." Each entry:
    //   { id, name, expression, mode: 'string'|'regex', enabled }
    // Evaluated ONLY over pane text already captured for the watched set (the
    // matcher rides pollAgentStates's existing capturePanes — ZERO new SSH
    // cost). Empty by default → behavior is identical to today (no patterns =
    // no custom alerts). Sanitized on PUT via sanitizeWatchPatterns.
  },
  {
    key: 'observerConfirmMode',
    default: 'always',
    exposure: 'public',
    type: 'oneOf',
    oneOf: ['always', 'auto-safe'],
    resolve: 'identity',
    order: 5,
    // 'always' | 'auto-safe' - whether to auto-approve read-only directives
  },
  {
    key: 'observerAutoStart',
    default: false,
    exposure: 'public',
    type: 'boolean',
    resolve: 'identity',
    order: 6,
    // boolean - whether to auto-start observer on first connection
  },
  {
    key: 'observerSessionTimeout',
    default: 30,
    exposure: 'public',
    type: 'nullablePositiveNumber',
    clamp: [1, 180],
    resolve: 'identity',
    order: 7,
    // minutes - auto-stop observer after inactivity, null to disable
    // WARDEN-867: clamp into the [1, 180] bounds the Settings input advertises —
    // mirrors WARDEN-747 (connectTimeout clamp) so a direct API call (or a typed
    // out-of-range value the UI's onBlur didn't catch) can't persist 999/0.5.
    // Honored by the nullablePositiveNumber case in applyField: null passes
    // through unclamped (disable path), a finite positive number clamps, ≤ 0 is
    // still rejected. The committed value matches what the UI displays.
  },
  {
    key: 'llm',
    default: {},
    exposure: 'public',
    type: 'llm',
    order: 8,
    // Observer LLM provider/model (WARDEN-350). Empty object by design — llm.js
    // owns its own fallbacks ('glm-5.2' / 'https://api.anthropic.com' / 2048
    // max_tokens); never invent a default authToken or model here. Populated via
    // Settings → PUT /api/config and read live by llm.js's per-call resolvers.
    // Sub-field semantics (incl. the no-clobber authToken + null-clearable
    // maxTokens) are declared once in LLM_FIELDS below.
    fields: [
      { key: 'model', type: 'string', get: 'orEmpty' },
      { key: 'baseUrl', type: 'string', get: 'orEmpty' },
      // WARDEN-1331: clamp into the [1, …] bound the Settings input advertises
      // (min=1, no max) — the last of the three clamp-less nullablePositiveNumber
      // fields named by WARDEN-867's byte-identical guard. Null (use the llm.js
      // default) passes through unclamped, exactly like the top-level fields.
      { key: 'maxTokens', type: 'nullablePositiveNumber', get: 'numberOrNull', clamp: [1, null] },
      // null clears to "use the llm.js default (2048)"; a finite positive int sets it.
      // authToken is a SECRET: GET masks it (Set + Tail only), PUT is no-clobber
      // (non-empty overwrites; explicit null CLEARS it — WARDEN-883).
      { key: 'authToken', type: 'secret' },
    ],
  },
  {
    key: 'healthWarningThresholdMin',
    default: 5,
    exposure: 'public',
    type: 'nullablePositiveNumber',
    resolve: 'identity',
    order: 9,
    // WARDEN-1331: clamp into the [1, …] bound the Settings input advertises
    // (min=1, no max) — a direct PUT of 0.5 used to pass the bare `value > 0`
    // guard and persist a fraction the UI cannot express. Null passes through
    // unclamped. There is NO static max: the warning≤critical ceiling is the
    // crossField RELATIONSHIP below, not a range, and stays there.
    clamp: [1, null],
    // Fleet health attention thresholds (minutes of inactivity).
    // healthWarningThresholdMin maps to the healthy→WARNING boundary: once an
    // agent has been inactive this long it needs attention (WARNING). Must be <=
    // the critical threshold or WARNING collapses. Default 5 = today's behavior.
  },
  {
    key: 'healthCriticalThresholdMin',
    default: 30,
    exposure: 'public',
    type: 'nullablePositiveNumber',
    resolve: 'identity',
    order: 10,
    // WARDEN-1331: clamp [1, …] — same as healthWarningThresholdMin above.
    clamp: [1, null],
    // healthCriticalThresholdMin maps to the warning→CRITICAL boundary: at this
    // much inactivity an agent is CRITICAL (and fires a desktop alert). ALSO
    // drives the IDLE branch for manual tmux sessions, so all three
    // getHealthState call sites consume the same configured value. Default 30.
  },
  {
    key: 'tokenBudgetEnabled',
    default: false,
    exposure: 'public',
    type: 'boolean',
    resolve: 'identity',
    order: 11,
    // Token-spend budget with threshold alerts (WARDEN-415). A meter without an
    // alarm is half-finished: WARDEN-367 surfaces per-session + fleet token
    // totals; these add the ALARM that routes human attention to a runaway/
    // looping agent's cost. Fully human-in-the-loop — it NOTIFY (desktop +
    // in-app toast), it never auto-kills/stops. Defaults: budget OFF.
  },
  {
    key: 'tokenBudgetThresholdTokens',
    default: 2_000_000,
    exposure: 'public',
    type: 'flooredNumber',
    nullable: true,
    resolve: 'identity',
    order: 12,
    // fleet-wide windowed threshold (the "spent across active sessions" alarm).
  },
  {
    key: 'tokenBudgetWindowHours',
    default: 24,
    exposure: 'public',
    type: 'flooredNumber',
    nullable: false,
    resolve: 'identity',
    order: 13,
    // rolling window (which SESSIONS count: active in the last N hours). NOT
    // null-able (the asymmetry vs the two thresholds — see WARDEN-773 corr. 3).
  },
  {
    key: 'tokenBudgetPerSessionThresholdTokens',
    default: 1_000_000,
    exposure: 'public',
    type: 'flooredNumber',
    nullable: true,
    resolve: 'identity',
    order: 14,
    // per-session runaway threshold (catches the SPECIFIC looping agent, not
    // just aggregate drift). null/0 disables it (null → resolveBudgetConfig
    // returns 0 → disabled).
    //
    // WARDEN-747: each finite number is FLOORED at 1 (the min the Settings
    // inputs advertise) so a direct API call can't persist 0/negative — matching
    // the frontend onBlur clamp and the WARDEN-374 "committed value matches
    // what persists" discipline. null stays null, only finite numbers are floored.
  },
  {
    key: 'companionTransportEnabled',
    default: false,
    exposure: 'public',
    type: 'boolean',
    resolve: 'identity',
    order: 15,
    // Companion transport (WARDEN-439 / roadmap WARDEN-270). A persistent RPC
    // channel to a remote host that collapses per-op SSH handshakes into one
    // connection — the biggest lever for cutting ssh-process churn on a
    // remote-heavy fleet. Was reachable only via the WARDEN_COMPANION_TRANSPORT=1
    // env var; now a first-class Settings toggle. Default OFF (experimental);
    // the env var remains an explicit operator override (force on/off regardless
    // of the UI). Remote-only by design — local hosts never route through it.
  },
  // Optional telemetry — OFF BY DEFAULT, INDEPENDENT PER-CATEGORY consent
  // (WARDEN-1116 / roadmap WARDEN-446 / design WARDEN-443 Principle 2). Nothing
  // leaves the machine until the user explicitly turns a category on in Settings;
  // this is warden's "off by default" trust foundation, persisted server-side (NOT
  // client localStorage) so it survives behind the backend config and a restart.
  // The receiver lives in a SEPARATE repo (warden-telemetry); this repo ships only
  // the client + the schema version it speaks.
  //
  // One `public` boolean per category, DERIVED from the consent registry — each
  // independent, each defaulting to false, NONE implying another. There is no
  // cross-field clamp between them (the old "extended requires base" is gone; see
  // crossField). The pre-WARDEN-1116 keys telemetryBaseEnabled /
  // telemetryExtendedEnabled are no longer declared: `migrateConfig` folds them
  // forward into these on load, once, and they are never read again.
  //
  // Only a category with a REAL PRODUCER is listed in the registry, so this can
  // never emit a toggle that collects nothing (WARDEN-131's silent-no-op trap
  // applied to a consent surface, where it is worst).
  ...TELEMETRY_CATEGORIES.map((cat, i) => ({
    key: cat.configKey,
    default: false,
    exposure: 'public',
    type: 'boolean',
    resolve: 'identity',
    order: TELEMETRY_CONSENT_ORDER + i,
    category: cat.id,
    summary: cat.summary,
  })),
  {
    key: 'telemetryEndpoint',
    default: '',
    exposure: 'public',
    type: 'string',
    resolve: 'orEmpty',
    order: 17,
    // Telemetry receiver endpoint (WARDEN-461). OFF by default: an empty string
    // means "unconfigured" and the transport sends NOTHING — it is the last gate
    // that makes "off by default / halts all traffic" real on the wire. Set this
    // to your self-hostable receiver's ingest URL via Settings. No hardcoded
    // SaaS host is ever used; events go only to this URL. Consent is a SEPARATE
    // gate — even with an endpoint set, the transport no-ops unless consent is on.
  },
  {
    key: 'telemetryAuthToken',
    default: '',
    exposure: 'secret',
    type: 'secret',
    order: 18,
    // Telemetry receiver shared-secret auth token (WARDEN-569). EMPTY by default
    // = sends no Authorization header (works against an AUTH_TOKEN-unset
    // receiver). When set, the transport sends it as
    // `Authorization: Bearer <token>`. This is a SECRET: GET never returns it in
    // cleartext (only a set + last-4 mask), and PUT only overwrites it on a
    // non-empty value (no-clobber — mirroring llm.authToken / webhookSecret) so
    // an untouched password field preserves the stored token. An explicit null
    // CLEARS it (WARDEN-883) — the Settings Remove action.
  },
  {
    key: 'webhookUrl',
    default: '',
    exposure: 'public',
    type: 'string',
    resolve: 'orEmpty',
    order: 20,
    // Webhook "push" delivery channel (WARDEN-555). OFF by default: sends
    // nothing until the user configures a URL and enables it. Delivers critical
    // agent alerts to the user's OWN webhook URL (ntfy/Discord/Slack/Telegram/
    // Home Assistant) so a human away from the machine still gets pinged the
    // moment an agent newly needs attention or a token budget breaches — even
    // with the Warden window closed to tray. Reuses the same fire-and-forget
    // POST shape as telemetryEndpoint; the payload goes ONLY to the user's own
    // URL (no yatfa SaaS). Off-by-default is enforced on the wire: sendWebhook
    // is a strict no-op unless webhookEnabled is true AND webhookUrl is non-empty.
    //   webhookUrl — destination URL. Empty = unconfigured = sends nothing.
  },
  {
    key: 'webhookEnabled',
    default: false,
    exposure: 'public',
    type: 'boolean',
    resolve: 'eqTrue',
    order: 21,
    //   webhookEnabled — master switch (the on-the-wire gate). GET resolves this
    //                    strictly (=== true) while PUT guards it as a boolean, so
    //                    the asymmetry is intentional.
  },
  {
    key: 'webhookSecret',
    default: '',
    exposure: 'secret',
    type: 'secret',
    order: 22,
    //   webhookSecret — shared secret (write-only on the wire: sent as
    //                   Authorization: Bearer + X-Webhook-Secret). No-clobber on
    //                   save (non-empty overwrites; explicit null CLEARS it —
    //                   WARDEN-883), mirroring llm.authToken.
  },
  {
    key: 'webhookAlertBudget',
    default: true,
    exposure: 'public',
    type: 'boolean',
    resolve: 'neqFalse',
    order: 25,
    //   webhookAlertBudget — route token-budget breach transitions (tickBudget).
  },
  {
    key: 'webhookAlertDone',
    default: true,
    exposure: 'public',
    type: 'boolean',
    resolve: 'neqFalse',
    order: 26,
    //   webhookAlertDone — route the POSITIVE "agent finished" transition
    //                      (WARDEN-575): a recently-working agent going idle, and
    //                      a container genuinely ending (lifecycle agent_ended).
    //                      Non-alarming 'info' severity; defaults true so the
    //                      missing positive half of the alert loop is on par with
    //                      the problem half (the channel itself stays off until
    //                      webhookEnabled). The category toggles use `!== false`
    //                      (neqFalse) so a stale/missing field resolves to the
    //                      DEFAULT (true), mirroring the desktop-alert defaults.
    //                      (Watch-pattern alerts are deferred: watch patterns
    //                      live client-side, so there is no server-side transition
    //                      to dispatch yet.)
  },
  {
    key: 'confirmDestructiveActions',
    default: true,
    exposure: 'public',
    type: 'boolean',
    resolve: 'identity',
    order: 27,
    // Safety: confirm before destructive actions (force-kill tmux session, kill chat)
  },
  {
    key: 'notifyChatOps',
    default: true,
    exposure: 'public',
    type: 'boolean',
    resolve: 'identity',
    order: 28,
    // Notification preferences (toast categories). chat operations (session kill, chat kill, resume, rename)
  },
  {
    key: 'notifyErrors',
    default: true,
    exposure: 'public',
    type: 'boolean',
    resolve: 'identity',
    order: 29,
    // error toasts
  },
  {
    key: 'notifySuccess',
    default: true,
    exposure: 'public',
    type: 'boolean',
    resolve: 'identity',
    order: 30,
    // success toasts
  },
  {
    key: 'notifyObserver',
    default: true,
    exposure: 'public',
    type: 'boolean',
    resolve: 'identity',
    order: 31,
    // observer events (timeout, gate prompts)
  },
  {
    key: 'showHostTags',
    default: true,
    exposure: 'public',
    type: 'boolean',
    resolve: 'identity',
    order: 32,
    // Display customization: Show host badges (local/hostname)
  },
  {
    key: 'showTypeBadges',
    default: true,
    exposure: 'public',
    type: 'boolean',
    resolve: 'identity',
    order: 33,
    // Show type labels (shell/claude/yatfa)
  },
  {
    key: 'showStatusIndicators',
    default: true,
    exposure: 'public',
    type: 'boolean',
    resolve: 'identity',
    order: 34,
    // Show status dots (active/idle/dead)
  },
  {
    key: 'showProjectBadges',
    default: false,
    exposure: 'public',
    type: 'boolean',
    resolve: 'identity',
    order: 35,
    // Show project name badges
  },
  {
    key: 'hideOfflineHosts',
    default: false,
    exposure: 'public',
    type: 'boolean',
    resolve: 'identity',
    order: 36,
    // Collapse offline SSH hosts into an expandable "Offline (N)" row in the sidebar
  },
  {
    key: 'companionTransportOverridden',
    exposure: 'derived',
    order: 16,
    // Derived (NOT from cfg): true when WARDEN_COMPANION_TRANSPORT was operator-
    // set at boot — in that case the env var wins and the UI toggle is inert, so
    // the page shows an "overridden" note instead of letting the toggle look
    // broken. Computed from the boot snapshot (NOT a live env read —
    // applyCompanionToggle writes the gate at boot, so a live read would always
    // be true). The boot snapshot is passed in via ctx.companionEnvOverridden.
    derived: (ctx = {}) => ctx.companionEnvOverridden === true,
  },
  {
    key: 'bounds',
    exposure: 'derived',
    order: 41,
    // WARDEN-1331 — the numeric-range metadata key. NOT a config field: nothing
    // is persisted, nothing is accepted on PUT (derived exposure guarantees
    // both — applyConfigPut/deriveDefaults/resetConfig all skip 'derived'), and
    // it emits at the END of the byte-pinned GET order (rank 41, after the
    // telemetry consent keys at 38/39/40) so the pin moves by exactly one
    // additive entry.
    // buildBounds() derives it from the same `clamp` / `uiRange` descriptors
    // the PUT guards read, so a range is declared once and both the server's
    // enforcement and the UI's advertised min/max come from that one place.
    derived: () => buildBounds(),
  },
];

// ---------------------------------------------------------------------------
// Registry self-check — fail LOUD at module load if a descriptor is malformed.
//
// The whole point of this refactor is that the GET/PUT/DEFAULTS lists CANNOT
// drift. But that guarantee holds only if every descriptor is well-formed: a
// typo'd `type`/`resolve` would make applyField/resolveGet hit a silent default
// (the field silently no-ops or coerces wrong — the exact WARDEN-115/131/164
// disease), and a duplicate/missing GET `order` would silently corrupt the
// byte-pinned GET shape. This one-time O(n) check turns those into a clear
// startup error so a developer's typo can never ship as a silent no-op. It runs
// once at import and asserts the CURRENT registry is well-formed; it has zero
// effect on the runtime /api/config behavior of a valid registry.
// ---------------------------------------------------------------------------

const VALID_TYPES = new Set([
  'array', 'number', 'string', 'boolean', 'oneOf',
  'nullablePositiveNumber', 'flooredNumber', 'watchPatterns', 'secret', 'llm',
]);
const VALID_RESOLVES = new Set(['identity', 'neqFalse', 'eqTrue', 'orEmpty', 'arrayOrEmpty']);
const VALID_EXPOSURES = new Set(['public', 'secret', 'derived', 'internal']);

// Types whose applyField case honors `clamp` (WARDEN-1331: this is the check
// that keeps "adding clamp: to a registry entry is a NO-OP" from recurring —
// a clamp on an unhonoring type is now a startup error, not a silent no-op).
const CLAMPABLE_TYPES = new Set(['number', 'nullablePositiveNumber']);

// A range descriptor is `[min, max]` with each side a finite number or null
// (null = unbounded on that side). Both-null is legal but pointless, so it is
// rejected as the typo it almost certainly is.
function validateRangeDescriptor(range, where) {
  if (!Array.isArray(range) || range.length !== 2) {
    throw new Error(`${where} must be [min, max]`);
  }
  const [min, max] = range;
  for (const side of [min, max]) {
    if (side !== null && (typeof side !== 'number' || !Number.isFinite(side))) {
      throw new Error(`${where} sides must be finite numbers or null`);
    }
  }
  if (min === null && max === null) throw new Error(`${where} cannot be [null, null]`);
  if (min !== null && max !== null && min > max) throw new Error(`${where}: min ${min} > max ${max}`);
}

function validateRegistry(fields = CONFIG_FIELDS) {
  const seenOrders = new Map(); // order → key (to name a collision)
  fields.forEach((d, i) => {
    const where = `CONFIG_FIELDS[${i}] (key='${d.key}')`;
    if (!VALID_EXPOSURES.has(d.exposure)) throw new Error(`${where}: unknown exposure '${d.exposure}'`);
    if (d.exposure !== 'derived' && !('default' in d)) throw new Error(`${where}: missing 'default'`);
    if (d.type !== undefined && !VALID_TYPES.has(d.type)) throw new Error(`${where}: unknown type '${d.type}'`);
    if (d.resolve !== undefined && !VALID_RESOLVES.has(d.resolve)) throw new Error(`${where}: unknown resolve '${d.resolve}'`);
    // WARDEN-1331 — validate the range descriptors the way type/resolve are
    // validated: a malformed clamp (swapped bounds, a string min) would clamp
    // every PUT to a wrong value SILENTLY (the exact disease this module
    // exists to prevent), so make it a startup error instead.
    if (d.clamp !== undefined) validateRangeDescriptor(d.clamp, `${where} clamp`);
    if (d.uiRange !== undefined) validateRangeDescriptor(d.uiRange, `${where} uiRange`);
    if (d.clamp !== undefined && d.uiRange !== undefined) {
      throw new Error(`${where}: cannot declare both 'clamp' and 'uiRange' — one enforced range per field (uiRange is the input band for an unclamped field)`);
    }
    if (d.clamp !== undefined && !CLAMPABLE_TYPES.has(d.type)) {
      throw new Error(`${where}: 'clamp' is not valid on type '${d.type}'`);
    }
    // The nested llm sub-fields aren't top-level descriptors, but they now
    // carry `clamp` too (llm.maxTokens) and buildBounds/applyField read it —
    // validate it under the same rules so a typo'd sub-field bound is also a
    // startup error rather than a wrong clamp.
    if (d.type === 'llm') {
      for (const f of d.fields || []) {
        if (f.clamp !== undefined) {
          validateRangeDescriptor(f.clamp, `${where} field '${f.key}' clamp`);
          if (!CLAMPABLE_TYPES.has(f.type)) {
            throw new Error(`${where} field '${f.key}': 'clamp' is not valid on type '${f.type}'`);
          }
        }
      }
    }
    // GET-visible fields must carry a unique numeric order (the byte-pinned GET rank).
    if (d.exposure === 'public' || d.exposure === 'secret' || d.exposure === 'derived') {
      if (typeof d.order !== 'number') throw new Error(`${where}: GET-visible field missing numeric 'order'`);
      if (seenOrders.has(d.order)) {
        throw new Error(`${where}: 'order' ${d.order} collides with '${seenOrders.get(d.order)}' — GET order must be unique`);
      }
      seenOrders.set(d.order, d.key);
    }
  });
}

// Fail loud at module load if the shipping registry is malformed (see block doc).
validateRegistry();
export { validateRegistry };

// The nested llm sub-fields are static — resolve them once, not per request.
const LLM_FIELDS = (() => {
  const llmDescriptor = CONFIG_FIELDS.find((d) => d.type === 'llm');
  return (llmDescriptor && llmDescriptor.fields) || [];
})();

// ---------------------------------------------------------------------------
// DEFAULTS — derived from the registry. This is the "1st source of truth" the
// GET/PUT handlers used to re-list by hand. Array order here is the persisted
// config.json key order (byte-pinned to the pre-refactor config.js literal).
// ---------------------------------------------------------------------------

export function deriveDefaults() {
  const out = {};
  for (const d of CONFIG_FIELDS) {
    if (d.exposure === 'derived') continue; // never persisted
    if (!('default' in d)) continue;
    // Mutable defaults (arrays/objects: hosts, llm, watchPatterns, pins,
    // agentNotes, sessionTags) are CLONED, never shared by reference, so a
    // consumer that mutates the value in place (applyLlmPut mutates cfg.llm's
    // sub-fields; applyField reassigns array entries) can never corrupt the
    // registry's canonical default. load() shallow-spreads DEFAULTS into the
    // live cfg, so without this clone cfg.llm WOULD be the very same object as
    // the registry's llm default — and a PUT would mutate the default a later
    // deriveDefaults() returns. Primitives are immutable and pass through.
    // (WARDEN-889: resetConfig re-derives defaults on every reset; the clone is
    // what lets it restore a pristine llm/hosts/watchPatterns after a PUT has
    // mutated the live cfg copies.)
    out[d.key] = (typeof d.default === 'object' && d.default !== null)
      ? structuredClone(d.default)
      : d.default;
  }
  return out;
}

// ---------------------------------------------------------------------------
// RESET — restore the backend config to its defaults (WARDEN-889).
//
// The danger zone previously had exactly ONE reset action and it touched ONLY
// client-side UI prefs (appearance/terminal/new-chat/behavior), leaving the
// consequential backend settings (webhook/telemetry/observer/hosts/thresholds…)
// with no reset path at all — to start over on any of them a user had to
// hand-edit ~/.yatfa-warden/config.json, and the write-only secrets (webhook /
// telemetry / observer auth tokens — the ones a GET masks and a user cannot even
// SEE) could not be cleared through the UI at all.
//
// resetConfig restores every USER-CONFIGURABLE backend field to its declared
// default in one shot. It is the single source of truth (deriveDefaults) routed
// through the SAME persist + live-apply path a PUT uses, so a reset takes effect
// on the next tick (afterSave re-forwards telemetry, re-applies the companion
// toggle, restarts the budget/attention polls) and round-trips through save
// (survives a restart). The endpoint wires save + afterSave; this function owns
// only the pure "what does a reset config look like" derivation.
//
// WHY this writes defaults DIRECTLY instead of going through applyConfigPut:
// applyField's 'secret' case is no-clobber (only a non-empty string overwrites,
// so an untouched password field survives a save). Routing a reset through it
// would therefore REFUSE to blank the secrets — the exact write-only tokens this
// path exists to clear. Writing the default ('' / {}) straight to cfg bypasses
// that guard by design: clearing is the intent, not a no-op to preserve.
//
// SCOPE — only `public` + `secret` exposure are reset:
//   `internal` fields (pins / agentNotes / sessionTags) are USER DATA managed by
//     their own endpoints, not settings — a config reset must not wipe a user's
//     pinned chats, notes, or session tags, so they are left untouched.
//   `derived` fields (companionTransportOverridden) are boot-computed from env,
//     not persisted in cfg, so there is nothing to reset.
// crossField then runs so the restored state is well-formed exactly as a PUT
// would leave it (health warning<=critical, telemetry consent booleans) —
// defensive: the defaults are already well-formed, but a future default that
// wasn't would still come out clean.
export function resetConfig(cfg) {
  // deriveDefaults() is the single source of truth for every default — use a
  // FRESH derivation so object/array fields (llm / hosts / watchPatterns) are
  // pristine copies the live cfg owns, not the registry's shared default a later
  // PUT could mutate (see deriveDefaults' clone note).
  const defaults = deriveDefaults();
  for (const d of CONFIG_FIELDS) {
    if (d.exposure !== 'public' && d.exposure !== 'secret') continue;
    cfg[d.key] = defaults[d.key];
  }
  crossField(cfg);
  return cfg;
}

// ---------------------------------------------------------------------------
// GET /api/config — build the safe-subset response by iterating the registry.
// Public fields emit by their resolve rule; secret fields auto-emit {key}Set +
// {key}Tail only; derived fields emit from the boot ctx. Order is the byte-pinned
// GET order (sorted by `order`), NOT the DEFAULTS array order.
// ---------------------------------------------------------------------------

export function buildGetResponse(cfg, ctx = {}) {
  const out = {};
  const visible = CONFIG_FIELDS
    .filter((d) => d.exposure === 'public' || d.exposure === 'secret' || d.exposure === 'derived')
    .slice()
    .sort((a, b) => (a.order ?? Infinity) - (b.order ?? Infinity));
  for (const d of visible) {
    if (d.exposure === 'derived') { out[d.key] = d.derived(ctx); continue; }
    if (d.type === 'llm') { out.llm = buildLlmGet(cfg); continue; }
    if (d.exposure === 'secret') {
      const v = cfg[d.key];
      out[`${d.key}Set`] = Boolean(v);
      out[`${d.key}Tail`] = v ? String(v).slice(-4) : null;
      continue;
    }
    out[d.key] = resolveGet(d, cfg[d.key]);
  }
  return out;
}

function resolveGet(d, v) {
  switch (d.resolve) {
    case 'neqFalse': return v !== false;
    case 'eqTrue': return v === true;
    case 'orEmpty': return v ?? '';
    case 'arrayOrEmpty': return Array.isArray(v) ? v : [];
    default: return v; // 'identity'
  }
}

// ---------------------------------------------------------------------------
// bounds — the numeric-range metadata emitted over GET (WARDEN-1331).
//
// One `bounds` object keyed by dotted field name ('llm.maxTokens' for the
// nested llm sub-field), each value {min?, max?} with an unbounded side
// OMITTED (the one-sided [1, null] bounds emit {min: 1}). This is what lets
// the Settings UI delete its hand-copies: the input's min/max attributes, the
// onBlur clamp and the "capped to N on blur" hint all derive from the served
// bound, exactly the bound the PUT guards enforce.
//
// Two deliberate shape decisions:
//   - `clamp` (server-ENFORCED) and `uiRange` (input band for a field the
//     server deliberately does not clamp — pollIntervalMs, whose CLI consumer
//     legitimately stores 1500 below the web band) emit the SAME {min, max}
//     shape. Consumers don't branch; the distinction is documented on the
//     registry entries and in the ticket, not re-encoded on the wire.
//   - `flooredNumber` fields emit {min: 1} derived from what the case actually
//     enforces (Math.max(1, x)) — they carry no clamp descriptor by design, so
//     their bound is derived from the guard, not re-declared.
// ---------------------------------------------------------------------------
export function buildBounds() {
  const out = {};
  const visible = CONFIG_FIELDS
    .filter((d) => d.exposure === 'public')
    .slice()
    .sort((a, b) => (a.order ?? Infinity) - (b.order ?? Infinity));
  const emit = (key, [min, max]) => {
    const b = {};
    if (min !== null) b.min = min;
    if (max !== null) b.max = max;
    out[key] = b;
  };
  for (const d of visible) {
    if (d.type === 'llm') {
      for (const f of d.fields || []) if (f.clamp) emit(`llm.${f.key}`, f.clamp);
      continue;
    }
    if (d.uiRange) emit(d.key, d.uiRange);
    else if (d.clamp) emit(d.key, d.clamp);
    else if (d.type === 'flooredNumber') emit(d.key, [1, null]);
  }
  return out;
}

// The nested llm object has its own (byte-pinned) key order + masking. Its
// sub-field semantics are declared once in the llm descriptor's `fields` (the
// hoisted LLM_FIELDS above) and driven through the same resolve/apply machinery
// as top-level fields.
function buildLlmGet(cfg) {
  const o = (cfg.llm && typeof cfg.llm === 'object' && !Array.isArray(cfg.llm)) ? cfg.llm : {};
  const out = {};
  for (const f of LLM_FIELDS) {
    if (f.type === 'secret') {
      out[`${f.key}Set`] = Boolean(o[f.key]);
      out[`${f.key}Tail`] = o[f.key] ? String(o[f.key]).slice(-4) : null;
    } else if (f.get === 'orEmpty') {
      out[f.key] = o[f.key] ?? '';
    } else if (f.get === 'numberOrNull') {
      out[f.key] = typeof o[f.key] === 'number' ? o[f.key] : null;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// PUT /api/config — apply the body by iterating the registry's per-field guards,
// then run the cross-field invariants. Each guard rejects undefined/absent
// fields (PATCH semantics — a field not in the body is left untouched), matching
// the pre-refactor destructure+guard behavior exactly.
//
// WARDEN-1331 — the route no longer has to answer { ok: true } to a REJECTED
// write. applyConfigPut now also returns WHICH present-but-invalid values it
// refused, as `{ refused: { [dottedFieldKey]: refusedBodyValue } }`. Refusal is
// strictly narrower than "didn't write": a value that was CLAMPED into its
// advertised range (the WARDEN-747/867/1331 discipline — commit matches
// display) is applied, not refused. Only a value that failed its type/shape
// guard outright (a string where a number belongs, a sub-zero threshold, a
// malformed pattern list) is reported. An ABSENT field is never a refusal —
// that is the PATCH no-op, not a rejected write. The no-clobber secret paths
// (blank string, wrong type) ARE refusals when the field was present in the
// body; an omitted secret (the normal untouched-field save) is not.
// ---------------------------------------------------------------------------

export function applyConfigPut(cfg, body = {}) {
  const refused = {};
  for (const d of CONFIG_FIELDS) {
    if (d.exposure === 'internal' || d.exposure === 'derived') continue;
    if (d.type === 'llm') { applyLlmPut(cfg, body.llm, refused); continue; }
    applyField(d, cfg, body[d.key], refused);
  }
  crossField(cfg);
  return { refused };
}

// Apply one field's declared guard to a target object. Shared by top-level
// fields and the nested llm sub-fields (target = cfg, or cfg.llm respectively).
// `refused` (WARDEN-1331) collects present-but-invalid values under their
// dotted key so the route can report them instead of answering a bare ok.
function applyField(d, target, value, refused, refuseKey) {
  const note = () => { if (refused && value !== undefined) refused[refuseKey ?? d.key] = value; };
  const { key, type } = d;
  switch (type) {
    case 'array':
      if (value && Array.isArray(value)) target[key] = value;
      else note();
      return;
    case 'number':
      if (typeof value === 'number') {
        target[key] = d.clamp ? clampToBounds(value, d.clamp) : value;
      } else note();
      return;
    case 'string':
      if (typeof value === 'string') target[key] = value;
      else note();
      return;
    case 'boolean':
      if (typeof value === 'boolean') target[key] = value;
      else note();
      return;
    case 'oneOf':
      if (value && d.oneOf.includes(value)) target[key] = value;
      else note();
      return;
    case 'nullablePositiveNumber':
      // Null is the disable path — it passes through UNclamped so the clamp
      // can't silently turn a "disabled" into a number. A finite positive
      // number clamps into its advertised range via the shared clampToBounds
      // (WARDEN-1331: every nullablePositiveNumber field now carries `clamp`,
      // so the bare `value > 0` pass-through that let 0.5 persist is gone);
      // ≤ 0 / non-numbers are refused (no write).
      if (value === null) { target[key] = null; return; }
      if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
        target[key] = d.clamp ? clampToBounds(value, d.clamp) : value;
      } else note();
      return;
    case 'flooredNumber':
      // null-asymmetry (WARDEN-773 correction 3): tokenBudgetThresholdTokens +
      // per-session accept null (clear-to-default-at-read); windowHours does NOT.
      if (d.nullable && value === null) { target[key] = null; return; }
      if (typeof value === 'number' && Number.isFinite(value)) target[key] = Math.max(1, value);
      else note();
      return;
    case 'watchPatterns': {
      // sanitizeWatchPatterns returns null for a non-array (→ no mutation); a
      // sanitized array otherwise (capped, deduped by id, bad entries dropped).
      const cleaned = sanitizeWatchPatterns(value);
      if (cleaned) target[key] = cleaned;
      else note();
      return;
    }
    case 'secret':
      // NO-CLOBBER: only a non-empty string overwrites the stored secret, so an
      // untouched password field (GET never seeds cleartext) survives a save.
      // An explicit null CLEARS the stored secret to '' (WARDEN-883) — the Remove
      // control mirrors the nullablePositiveNumber null path (above) so a user
      // can fall back to "no token" without hand-editing config.json. A present
      // but non-clearing, non-string value (including '') is REFUSED
      // (WARDEN-1331) rather than silently dropped; an omitted secret is the
      // normal untouched-field save and never appears in `refused`.
      if (value === null) { target[key] = ''; return; }
      if (typeof value === 'string' && value.length > 0) target[key] = value;
      else note();
      return;
    default:
      return;
  }
}

// The ONE clamp the numeric guards use (WARDEN-1331). Range sides may be null
// (= unbounded on that side — the one-sided [1, null] min-only bounds), so the
// old `Math.min(d.clamp[1], …)` ternary is replaced wholesale: Math.min(null, x)
// would coerce null to 0 and clamp everything to zero.
function clampToBounds(value, [min, max]) {
  if (min !== null && value < min) return min;
  if (max !== null && value > max) return max;
  return value;
}

function applyLlmPut(cfg, llm, refused) {
  if (!llm || typeof llm !== 'object' || Array.isArray(llm)) return;
  if (!cfg.llm || typeof cfg.llm !== 'object' || Array.isArray(cfg.llm)) cfg.llm = {};
  for (const f of LLM_FIELDS) {
    applyField(f, cfg.llm, llm[f.key], refused, `llm.${f.key}`);
  }
}

// Cross-field invariants — run AFTER the per-field loop (each depends only on
// fields the loop has already settled, so moving them to the end is
// behavior-identical to the interleaved pre-refactor guards).
function crossField(cfg) {
  // (a) Health thresholds well-ordered (WARDEN-374): keep warning <= critical,
  // resolving null to its default first, so a persisted inverted config can't
  // later make a silently-failing agent read HEALTHY. The classifier's
  // effectiveHealthyMs clamp is the real safety net; this keeps the persisted
  // config clean. The numeric critical value is persisted so the saved pair is
  // well-ordered and the UI round-trip stays consistent.
  const DEFAULT_WARNING_MIN = 5;
  const DEFAULT_CRITICAL_MIN = 30;
  const warningMin = cfg.healthWarningThresholdMin ?? DEFAULT_WARNING_MIN;
  const criticalMin = cfg.healthCriticalThresholdMin ?? DEFAULT_CRITICAL_MIN;
  if (warningMin > criticalMin) cfg.healthWarningThresholdMin = criticalMin;

  // (b) Telemetry consent (WARDEN-1116): the SERVER independently sanitizes what
  // it PERSISTS, so a hand-crafted PUT can never store a consent value that is
  // anything other than a real boolean. This is the second of the two INDEPENDENT
  // off-by-default enforcement points (the first is the Electron main process's
  // boot read, electron/telemetry-config.cjs) — deliberately not a single point of
  // trust. `resolveConsent` is `=== true` per category, so a non-boolean, missing,
  // corrupt, or unrecognized value lands as false.
  //
  // There is NO cross-CATEGORY clamp. The old "extended requires base" coupling is
  // gone: categories are independent, and the `names` category is safe on its own
  // because it only decorates events other categories produce — with nothing
  // collecting there is no event for a name to ride on. Re-introducing a clamp
  // here would re-couple the categories WARDEN-443 Principle 2 requires to be
  // independent.
  const consent = resolveConsent(cfg);
  for (const cat of TELEMETRY_CATEGORIES) cfg[cat.configKey] = consent[cat.id] === true;
}

// ---------------------------------------------------------------------------
// migrateConfig — fold a config written by an OLDER build forward (WARDEN-1116).
//
// Runs on LOAD, before DEFAULTS are spread, so a legacy key is still visible as
// "the new key is absent". Today it carries the linear telemetry consent pair
// (telemetryBaseEnabled / telemetryExtendedEnabled) into the per-category keys,
// preserving the user's EFFECTIVE consent exactly: base on → incidents on;
// extended on WITH base on → names on. A stale `{base:false, extended:true}` pair
// (which the old model resolved to "send nothing", because the old resolver
// clamped extended off unless base was on) migrates to NOTHING enabled —
// `incidents:false, names:false`. That is what the `requires` translation rule in
// the category registry is for: carrying the raw `extended:true` flag forward
// would resurrect `names:true`, a category the user's old EFFECTIVE consent never
// had on, and once a collecting category is later switched on it would put chat
// names on the wire the user never consented to. So nothing new is silently
// enabled.
//
// Non-destructive: the legacy keys are left on disk untouched (a downgrade still
// finds what it expects); they are simply never read once the new keys exist.
// ---------------------------------------------------------------------------
export function migrateConfig(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  return migrateConsentPrefs(raw);
}

// ---------------------------------------------------------------------------
// afterSave — the post-save side-effect pipeline (WARDEN-773 Correction 2).
//
// The source proposal modeled only per-field guards + crossField + derived and
// omitted the post-save side-effects the PUT handler runs after save(cfg).
// A registry refactor that drops them silently breaks: telemetry changes need a
// restart, the companion toggle needs a restart, budget config is delayed up to
// 120s. Declaring them here as a pipeline makes that drop impossible — and
// because the impure callables are INJECTED by the caller (server.js), this
// module stays dependency-free and fully unit-testable.
//
// WARDEN-1274: this was a FOUR-step pipeline; the fourth (restartAttentionPoll)
// went with the server-side attention webhook sweep it restarted.
//
// deps:
//   forwardTelemetryConfig(cfg)    — guarded process.send of the telemetry-config
//                                    IPC payload (incl. cleartext authToken) to
//                                    the Electron main process (WARDEN-524/569).
//   applyCompanionToggle           — the live companion-transport toggle fn.
//   restartBudgetPoll             — the live budget-poll restart fn.
//   companionOverridden            — the boot snapshot of the env override.
// ---------------------------------------------------------------------------

export function afterSave(cfg, deps) {
  deps.forwardTelemetryConfig(cfg);
  deps.applyCompanionToggle(cfg.companionTransportEnabled, { override: deps.companionOverridden });
  deps.restartBudgetPoll();
}
