// Settings section metadata + the search seam behind the header search box.
//
// Lifted out of SettingsPage.tsx (WARDEN-912) for the same reason
// sectionPersistence.ts (WARDEN-870) and configDirty.ts (WARDEN-906) were: it
// is pure, import-free logic, so `node --test` can load it by file path and
// assert on it. The guard that matters here is drift — the corpus is a
// hand-maintained parallel mirror of text that actually renders somewhere under
// `settings/sections/*`, and only a test can keep it honest as rows are added
// or renamed. See sectionSearch.test.mjs.
//
// ---------------------------------------------------------------------------
// Why a keyword corpus exists at all
// ---------------------------------------------------------------------------
// WARDEN-887 shipped search over section label+description only. The ~74
// individual preference ROWS inside the section bodies were not in the corpus,
// so searching for a preference by the name the product itself gives it
// (`scrollback`, `density`, `timestamp`, `tray`, `poll interval`, …) returned
// the authoritative empty state "No matching sections." — which reads as
// "Warden has no such setting." It does have it. The corpus puts those rows in
// so already-delivered preferences are reachable. It adds no preferences and
// touches no config/persistence.
//
// ---------------------------------------------------------------------------
// WARDEN-1290 — the corpus is now ROW-KEYED, not a flat bag of strings
// ---------------------------------------------------------------------------
// Until now each section carried one flat `keywords: readonly string[]`, so a
// match could only ever answer WHICH SECTION holds the setting. The user then
// landed on a 16-row section and scanned by eye for the row the search already
// knew it had matched. Row identity was discarded at match time — structurally,
// not accidentally.
//
// `rows` keeps every one of those strings, but grouped per ROW and tagged with
// the DOM `id` of the control that row renders (`anchorId`). That is the whole
// change: `searchSectionsWithRows` can now say "Appearance, and it was the
// `closeToTray` row", so SettingsPage can highlight that row and scroll it into
// view (see rowHighlight.ts).
//
// `anchorId` is OPTIONAL and legitimately absent in two cases — a group heading
// that is a plain <span>/<Label> with no `htmlFor` (`Configured Hosts`,
// `Display label per host`), and a per-host row whose id is minted at runtime
// from the host name (`hostLabel-<host>`). Those entries still MATCH exactly as
// before; they simply cannot point at a row, and the highlight effect skips
// them. Where a heading unambiguously heads a group, it borrows the anchor of
// that group's first control so searching the heading still lands you on it.
//
// MATCHING SEMANTICS ARE UNCHANGED BY THIS RESTRUCTURE. `searchSections` still
// flattens label + description + every term and runs the same per-entry
// substring test over the same normalization, so for every query it returns
// exactly the sections it returned before (guarded by the unmodified probe /
// shipped-label tables in sectionSearch.test.mjs).
//
// ---------------------------------------------------------------------------
// Four rules keep this corpus correct. All four were learned the hard way.
// ---------------------------------------------------------------------------
// 1. TRANSCRIBE ROW TEXT VERBATIM — do not paraphrase.
//    The first cut of this corpus rewrote labels as it copied them: parentheses
//    were flattened (`Terminal scrollback (lines)` -> `terminal scrollback
//    lines`), `&` became `and`, commas and words like `optional`/`also` were
//    dropped, and `Default shell per host` was split into two fragments that
//    were never contiguous. Because matching is a substring test, the effect was
//    that a label was not a substring of its own keywords: 22 of 29 verbatim
//    on-screen labels still returned "No matching sections." — the exact defect
//    this file exists to fix, just narrowed to labels carrying punctuation.
//    Typing the label you are staring at is the single most predictable query a
//    user makes, so every row's own text ships here EXACTLY as rendered.
//
// 2. ROW NAMES AND OPTION VALUES ONLY — never the helper prose beneath a row.
//    Helper paragraphs mention things the row is not about, and pull unrelated
//    sections into results. Notifications' helper line "Session kill, chat kill,
//    resume, and rename notifications" would make `kill` match Notifications,
//    breaking WARDEN-887's shipped `kill` -> Safety + Token budget result.
//    Performance's prose lists `kill` for the same reason and is likewise
//    excluded. Section-level intent belongs in `description`, not here.
//
//    Beyond the verbatim text, each row may carry the obvious synonym a user
//    would type for it (`poll interval` for Dashboard Refresh Interval, `system
//    tray` for Close to tray). Synonyms are additive; they never replace the
//    real text, and they live on the row they describe so a synonym match
//    highlights the right row.
//
// 3. TRANSCRIBE EVERY ROW — omission is the drift direction that bites next.
//    Rules 1 and 2 are about text that IS here being wrong. The likelier future
//    mistake is text that is simply absent: someone adds a row and forgets this
//    file. That shipped too — `Match app theme (default)`, the DEFAULT option of
//    Terminal color scheme, was missing while both its siblings (`Always dark`,
//    `Always light`) were present, so a user typing what their own dropdown says
//    was told Warden has no such setting. Three aria-labelled fields
//    (`Custom terminal font family`, `New preset name`, `New preset command`)
//    were missing the same way.
//    A corpus->source test structurally CANNOT catch this: a row absent from
//    both the corpus and the test table is invisible to both. The guard that
//    catches it reads the SOURCE and requires every row/option/aria-label found
//    there to resolve — see EVERY_SOURCE_ROW_IS_IN_THE_CORPUS in the test file.
//    Note a row's accessible name may be an `aria-label` rather than a visible
//    <Label> (Snippets, Patterns, the custom-font and preset inputs); those are
//    rows too, and users search for them by that name.
//
// 4. A LABEL'S SEARCHABILITY MUST NOT DEPEND ON HOW IT WAS AUTHORED.
//    Some option labels are written literally in the section markup
//    (`Always dark`); others are declared in a plain data module and rendered
//    by mapping over it — the terminal theme roster (`THEMES`,
//    lib/themes.ts), the terminal font list (`TERMINAL_FONT_OPTIONS`,
//    settings/fontOptions.ts), and the telemetry consent categories
//    (`TELEMETRY_CATEGORIES`, lib/telemetry/consent.ts) are all authored that
//    way. Those are static, curated, shipped strings, every bit as user-visible
//    as a literal one: a user who knows they want the Dracula theme types
//    `Dracula`, not `theme`. Rule 3's extractor reads section MARKUP and cuts
//    children at the first `{`, so it is structurally blind to them — which is
//    exactly how 15 shipped option labels shipped unfindable past a green
//    suite. The test therefore ALSO extracts `label` strings from those data
//    modules (loading the import-free ones as real modules) and requires every
//    one to resolve — see OPTION_DATA_MODULES in the test file. A smaller
//    inline variant of the same shape (a `label:` string inside an array
//    literal in the section file itself — Notifications' pane-state switches,
//    `this machine (local)`) is covered by extracting `label:` literals from
//    the section source too.
//
// Invariant: adding or renaming a preference row means updating its entry here,
// INCLUDING its `anchorId` — a stale anchor is a row that silently stops being
// highlighted, so the test file requires every anchor to resolve in the section
// source. The same holds for an option ADDED TO A DATA MODULE (a theme, a
// terminal font, a telemetry consent category): see rule 4.

/**
 * One ROW of a settings section, as the search corpus sees it.
 *
 * `terms` is that row's searchable text: its verbatim on-screen name first,
 * then any option labels it renders, then the synonyms a user would plausibly
 * type for it. Matching is per-TERM (see `searchSections`) — never over a
 * joined blob — so a query can not match by straddling two unrelated strings.
 *
 * `anchorId` is the DOM `id` of the control this row renders, used to point the
 * user AT the row (highlight + scroll, WARDEN-1290). Omitted for a group
 * heading with no control of its own and for rows whose id is minted per host
 * at runtime; such a row still matches, it just cannot be pointed at.
 */
export interface SettingsSectionRow {
  readonly anchorId?: string;
  readonly terms: readonly string[];
}

/** A settings section: its nav entry plus its row-keyed search corpus. */
export interface SettingsSectionMeta {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly rows: readonly SettingsSectionRow[];
}

// The settings section nav entries: a left rail on wide screens, a dropdown on
// narrow ones. Order is the display order; the first entry is active by default.
// The `id` doubles as the active-section discriminator — each section component
// hides itself unless its id matches `activeSection`. (Reset is intentionally
// absent here: it is always visible at the bottom of the content pane, outside
// the activeSection gating.)
export const SETTINGS_SECTIONS = [
  {
    id: 'hosts',
    label: 'Hosts & Connection',
    description: 'Manage SSH hosts and connection settings for Warden.',
    // Rows — HostsSection.tsx
    rows: [
      // `Configured Hosts` heads the host-badge list; the per-host Remove
      // buttons carry runtime-minted names, so there is no single control to
      // anchor to.
      { terms: ['Configured Hosts', 'remove host', 'ssh'] },
      { anchorId: 'addHostName', terms: ['Add Host'] },
      { anchorId: 'addHost', terms: ['Add a host from ~/.ssh/config'] },
      { anchorId: 'addHostName', terms: ['Host name to add'] },
      // Per-host label inputs: ids are `hostLabel-<host>`, minted at runtime.
      { terms: ['Display label per host', 'this machine (local)', 'friendly name', 'host tag'] },
      {
        anchorId: 'pollIntervalMs',
        terms: ['Dashboard Refresh Interval (ms)', 'poll interval', 'polling', 'refresh rate'],
      },
      { anchorId: 'tmuxSession', terms: ['Tmux Session Name'] },
      { anchorId: 'connectTimeout', terms: ['Connect Timeout (seconds)'] },
    ],
  },
  {
    id: 'observer',
    label: 'Observer Preferences',
    description: 'Control the observer meta-chat: directive confirmation, auto-start, idle auto-stop, and its model.',
    // Rows + options — ObserverSection.tsx
    rows: [
      {
        anchorId: 'observerConfirmMode',
        terms: ['Directive Confirmation', 'Always confirm (default)', 'Auto-send safe directives'],
      },
      { anchorId: 'observerAutoStart', terms: ['Auto-start Observer'] },
      { anchorId: 'observerSessionTimeout', terms: ['Session Auto-stop (minutes)', 'idle timeout'] },
      // `Observer model` is the group heading over Model/Base URL/Auth token/
      // Max output tokens — it borrows the first control in that group.
      { anchorId: 'observerModel', terms: ['Observer model'] },
      { anchorId: 'observerModel', terms: ['Model'] },
      { anchorId: 'observerBaseUrl', terms: ['Base URL', 'api endpoint'] },
      { anchorId: 'observerAuthToken', terms: ['Auth token', 'api key', 'secret'] },
      { anchorId: 'observerMaxTokens', terms: ['Max output tokens'] },
    ],
  },
  {
    id: 'safety',
    label: 'Safety',
    description: 'Choose whether Warden confirms before destructive actions like force-killing a chat.',
    // Row — SafetySection.tsx
    rows: [
      {
        anchorId: 'confirmDestructiveActions',
        terms: [
          'Confirm before destructive actions (force-kill, kill chat)',
          'confirmation prompt',
          'undo',
          'dangerous',
        ],
      },
    ],
  },
  {
    id: 'attention',
    label: 'Attention thresholds',
    description: 'Set how long an agent waits before Warden flags it as needing attention.',
    // Rows — AttentionThresholdsSection.tsx
    rows: [
      {
        anchorId: 'healthWarningThresholdMin',
        terms: ['Warning after (minutes)', 'idle threshold', 'stale'],
      },
      {
        anchorId: 'healthCriticalThresholdMin',
        terms: ['Critical after (minutes)', 'needs attention', 'health'],
      },
    ],
  },
  {
    id: 'tokenbudget',
    label: 'Token budget',
    description: 'Configure token-budget alerts that notify you — they never auto-kill or pause agents.',
    // Rows — TokenBudgetSection.tsx
    rows: [
      {
        anchorId: 'tokenBudgetEnabled',
        terms: ['Enable token-spend budget alerts', 'spend', 'cost', 'usage alert'],
      },
      { anchorId: 'tokenBudgetThresholdTokens', terms: ['Fleet threshold (tokens)'] },
      { anchorId: 'tokenBudgetWindowHours', terms: ['Window (hours)'] },
      { anchorId: 'tokenBudgetPerSessionThresholdTokens', terms: ['Per-session threshold (tokens)'] },
    ],
  },
  {
    id: 'performance',
    label: 'Performance',
    description: 'Route remote tmux operations through a persistent SSH channel (experimental).',
    // Row + badges — PerformanceSection.tsx. NOTE: the helper prose lists
    // `kill` among the routed tmux ops; it is deliberately NOT transcribed
    // (see rule 2 above) so `kill` stays Safety + Token budget.
    rows: [
      {
        anchorId: 'companionTransportEnabled',
        terms: [
          'Companion transport',
          'experimental',
          'persistent ssh channel',
          'remote tmux ops',
          'capture',
          'spawn',
          'liveness',
          'resize',
        ],
      },
      // The env-override disclosure is prose beneath the row, not a control.
      { terms: ['env override', 'WARDEN_COMPANION_TRANSPORT'] },
    ],
  },
  {
    id: 'telemetry',
    label: 'Telemetry',
    description: 'Opt-in usage telemetry — off by default. Nothing leaves your machine until you turn it on.',
    // Rows — TelemetrySection.tsx. The three consent switches render FROM THE
    // REGISTRY (lib/telemetry/consent.ts, WARDEN-1116): their labels are
    // data-module strings, transcribed here verbatim and guarded there (see
    // rule 4 in this file's header and OPTION_DATA_MODULES in the test). Their
    // DOM ids are each category's `configKey`, declared in the same registry.
    rows: [
      { anchorId: 'telemetryIncidentsEnabled', terms: ['Anonymous errors, crashes & freezes'] },
      { anchorId: 'telemetryNamesEnabled', terms: ['Chat & session names'] },
      { anchorId: 'telemetryOperationalMetricsEnabled', terms: ['Operational metrics'] },
      { anchorId: 'telemetryEndpoint', terms: ['Receiver endpoint'] },
      { anchorId: 'telemetryAuthToken', terms: ['Receiver auth token (optional)', 'secret'] },
      // Section-level intent + the test-connection button (no id of its own).
      { terms: ['privacy', 'opt-in', 'test connection'] },
    ],
  },
  {
    id: 'display',
    label: 'Display',
    description: 'Choose which badges and indicators Warden shows for hosts and chats.',
    // Rows — DisplaySection.tsx
    rows: [
      { anchorId: 'showHostTags', terms: ['Show host tags (local/hostname badges)'] },
      { anchorId: 'showTypeBadges', terms: ['Show type badges (shell/claude/yatfa labels)'] },
      { anchorId: 'showStatusIndicators', terms: ['Show status indicators (active/idle/dead dots)'] },
      { anchorId: 'showProjectBadges', terms: ['Show project badges'] },
      { anchorId: 'hideOfflineHosts', terms: ['Hide offline hosts (collapse into an expandable summary)'] },
    ],
  },
  {
    id: 'appearance',
    label: 'Appearance',
    description: 'Theme, terminal font, and color preferences — applied instantly.',
    // Rows + their own select options — AppearanceSection.tsx. Option labels
    // authored as DATA and rendered by mapping over it (the theme roster,
    // lib/themes.ts; the terminal font list, settings/fontOptions.ts) sit on
    // the row whose dropdown renders them — same dropdown, different authoring
    // shape (see rule 4 in this file's header).
    rows: [
      { anchorId: 'terminalFontSize', terms: ['Terminal font size'] },
      {
        anchorId: 'terminalFontFamily',
        terms: [
          'Terminal font family',
          'System default',
          'Cascadia Code',
          'JetBrains Mono',
          'Fira Code',
          'Source Code Pro',
          'Menlo',
          'Consolas',
        ],
      },
      {
        anchorId: 'customTerminalFontFamily',
        terms: ['Custom terminal font family', 'nerd font', 'custom font'],
      },
      { anchorId: 'terminalScrollback', terms: ['Terminal scrollback (lines)', 'history buffer'] },
      {
        anchorId: 'theme',
        terms: [
          'Theme',
          'System (follow OS)',
          'GitHub Light',
          'Light+ (VS Code)',
          'GitHub Dark',
          'Dark+ (VS Code)',
          'Catppuccin Mocha',
          'Dracula',
          'Nord',
          'One Dark',
        ],
      },
      {
        anchorId: 'terminalColorScheme',
        terms: ['Terminal color scheme', 'Match app theme (default)', 'Always dark', 'Always light'],
      },
      {
        anchorId: 'terminalCursorStyle',
        terms: [
          'Terminal cursor style',
          'Blinking block (default)',
          'Steady block',
          'Blinking underline',
          'Steady underline',
          'Blinking bar',
          'Steady bar',
        ],
      },
      { anchorId: 'copyOnSelect', terms: ['Copy on select', 'clipboard', 'select-to-copy'] },
      { anchorId: 'density', terms: ['Density', 'Comfortable (default)', 'Compact'] },
      { anchorId: 'timestampFormat', terms: ['Timestamp format', 'Relative (default)', 'Absolute', 'time'] },
      {
        anchorId: 'paneLayout',
        terms: ['Pane layout', 'Auto grid (default)', 'Stacked (single column)', 'Side-by-side (single row)'],
      },
      {
        anchorId: 'onExitBehavior',
        terms: ['When an agent exits', 'Keep pane (default)', 'Dim pane', 'Auto-close pane'],
      },
      { anchorId: 'autoFocusNewPane', terms: ['Auto-focus pane on open'] },
      {
        anchorId: 'restoreOnStartup',
        terms: ['Restore workspace on startup', 'Reopen previous (default)', 'Start empty', 'startup'],
      },
      { anchorId: 'rememberWindowBounds', terms: ['Remember window position and size'] },
      { anchorId: 'launchAtLogin', terms: ['Launch Warden at login', 'start on boot'] },
      { anchorId: 'closeToTray', terms: ['Close to tray', 'system tray', 'minimize to tray'] },
    ],
  },
  {
    id: 'newchats',
    label: 'New Chats',
    description: 'Set the defaults for new chats: agent type, host, shell, and working directory.',
    // Rows + options — NewChatsSection.tsx
    rows: [
      {
        anchorId: 'defaultNewChatPreset',
        terms: ['Default agent type', 'claude (default)', 'claude', 'shell'],
      },
      // `Custom presets` heads the preset list + the add-a-preset block; it
      // borrows the first control of that block.
      { anchorId: 'newPresetName', terms: ['Custom presets'] },
      { anchorId: 'newPresetName', terms: ['Add preset', 'preset'] },
      { anchorId: 'newPresetName', terms: ['New preset name'] },
      { anchorId: 'newPresetCmd', terms: ['New preset command'] },
      { anchorId: 'defaultNewChatHost', terms: ['Default host', 'this machine (local)'] },
      { anchorId: 'defaultShell', terms: ['Default shell (fallback for any host without its own)'] },
      // Per-host rows below: ids are minted at runtime from the host name
      // (`defaultShellByHost-<host>`, `defaultNewChatCwdByHost-<host>`), so
      // these group headings carry no anchor.
      { terms: ['Default shell per host'] },
      {
        anchorId: 'defaultNewChatCwd',
        terms: ['Default working directory (fallback for any host without its own)', 'cwd'],
      },
      { terms: ['Working directory per host'] },
      { terms: ['Agent type per host', 'Use global default'] },
    ],
  },
  {
    id: 'snippets',
    label: 'Instruction snippets',
    description: 'Manage reusable instruction snippets for broadcasts and pane sends.',
    // Rows — SnippetsSection.tsx (fields are placeholder/aria-labelled)
    rows: [
      { anchorId: 'newSnippetName', terms: ['Add snippet'] },
      { anchorId: 'newSnippetName', terms: ['New snippet name'] },
      { anchorId: 'newSnippetText', terms: ['New snippet instruction text'] },
      { terms: ['reusable', 'broadcast', 'pane send', 'macro', 'template'] },
    ],
  },
  {
    id: 'patterns',
    label: 'Watch patterns',
    description: 'Define watch patterns that flag matching agent output, matched server-side.',
    // Rows — PatternsSection.tsx (fields are placeholder/aria-labelled)
    rows: [
      { anchorId: 'newPatternName', terms: ['Add pattern'] },
      { anchorId: 'newPatternName', terms: ['New pattern name'] },
      {
        anchorId: 'newPatternExpression',
        terms: ['New pattern expression', 'text substring', 'regular expression'],
      },
      { anchorId: 'newPatternMode', terms: ['New pattern match mode', 'regex'] },
      { terms: ['watched chats', 'flag output'] },
    ],
  },
  {
    id: 'notifications',
    label: 'Notifications',
    description: 'Control toast, desktop, and webhook notifications for agent events.',
    // Rows — NotificationsSection.tsx. NOTE: the "Chat operations" helper line
    // ("Session kill, chat kill, resume, and rename notifications") is
    // deliberately NOT transcribed (see rule 2 above). The three channel
    // headings (`In-app toasts`, `Desktop alerts`, `Webhook push alerts`) and
    // `Which alerts to push` are plain <span>s, so each borrows the first
    // control of the block it heads.
    rows: [
      { anchorId: 'notifyChatOps', terms: ['In-app toasts'] },
      { anchorId: 'notifyChatOps', terms: ['Chat operations'] },
      { anchorId: 'notifyErrors', terms: ['Errors'] },
      { anchorId: 'notifySuccess', terms: ['Success messages'] },
      { anchorId: 'notifyObserver', terms: ['Observer events'] },
      { anchorId: 'attentionDesktopAlerts', terms: ['Desktop alerts'] },
      {
        anchorId: 'attentionDesktopAlerts',
        terms: [
          'Desktop alerts when agents need attention (while Warden is unfocused)',
          'unfocused',
          'permission',
          'mute',
          'bell',
          'attention alert',
        ],
      },
      // Attention pane-state switches — authored as an inline data array in
      // NotificationsSection and rendered by mapping over it, with ids minted
      // from each entry's key (`attention-state-<k>`). Transcribed verbatim so
      // the corpus carries the text the user actually reads.
      { anchorId: 'attention-state-erroring', terms: ['Erroring'] },
      { anchorId: 'attention-state-stuck', terms: ['Stuck'] },
      { anchorId: 'attention-state-waiting', terms: ['Waiting on you'] },
      { anchorId: 'attention-state-blocked', terms: ['Blocked'] },
      { anchorId: 'attention-state-done', terms: ['Finished'] },
      { anchorId: 'alertCritical', terms: ['Critical agents'] },
      { anchorId: 'alertWarning', terms: ['Warning agents'] },
      { anchorId: 'alertDirective', terms: ['Pending directives'] },
      { anchorId: 'alertError', terms: ['Recent errors'] },
      { anchorId: 'webhookEnabled', terms: ['Webhook push alerts'] },
      { anchorId: 'webhookEnabled', terms: ['Enable webhook push'] },
      { anchorId: 'webhookUrl', terms: ['Webhook URL'] },
      { anchorId: 'webhookSecret', terms: ['Shared secret (optional)'] },
      { anchorId: 'webhookAlertAttention', terms: ['Which alerts to push', 'test alert'] },
      { anchorId: 'webhookAlertBudget', terms: ['Token budget'] },
    ],
  },
] as const satisfies readonly SettingsSectionMeta[];

export type SettingsSectionEntry = (typeof SETTINGS_SECTIONS)[number];
export type SectionId = SettingsSectionEntry['id'];

/** A section that matched, plus WHICH of its rows matched (WARDEN-1290). */
export interface SectionRowMatch {
  readonly section: SettingsSectionEntry;
  /**
   * The `anchorId`s of the rows whose own terms matched, in declared (visual)
   * order and de-duplicated — several corpus rows can point at one control (a
   * group heading and its first row). Empty when the section matched only by
   * its label/description, or when every matching row is anchor-less.
   */
  readonly matchedAnchors: readonly string[];
}

/**
 * Collapse a string to bare lowercase words for punctuation-insensitive matching.
 *
 * The user types what they see, and what they see carries punctuation the query
 * box has no reason to reproduce faithfully — `Session Auto-stop (minutes)`,
 * `Anonymous errors, crashes & freezes`, `Show host tags (local/hostname
 * badges)`. Normalizing BOTH the query and the corpus means a hyphen, comma,
 * parenthesis, slash or `&` can never be the reason a shipped preference
 * reports that it does not exist. It also makes `auto stop`, `Auto-stop` and
 * `AUTO-STOP` the same query.
 */
export function normalizeSearchText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// Normalized haystacks, built once at module load rather than on every
// keystroke. Each entry stays SEPARATE on purpose: matching per-entry means a
// query can never match by straddling the boundary between two unrelated rows
// (a single joined blob would let `default shell per host` match a section that
// merely had `default shell` followed by `per host`, which is precisely the
// false positive this corpus was rewritten to avoid).
//
// The section-level pair (label, description) is kept apart from the row terms
// so a section that matched only by its own name reports NO matched rows —
// there is nothing in the body to point at.
interface SectionHaystack {
  readonly sectionTerms: readonly string[];
  readonly rows: readonly { readonly anchorId?: string; readonly terms: readonly string[] }[];
}

const HAYSTACKS: readonly SectionHaystack[] = SETTINGS_SECTIONS.map((s) => ({
  sectionTerms: [normalizeSearchText(s.label), normalizeSearchText(s.description)],
  // The `as const` above narrows every row to its own literal type, and a row
  // that omits `anchorId` has no such property to read. The widening is safe by
  // construction — `satisfies readonly SettingsSectionMeta[]` on the literal is
  // exactly the proof that each row IS a SettingsSectionRow — and it is the one
  // place that widening happens, so the literal types stay available to anyone
  // who wants them.
  rows: (s.rows as readonly SettingsSectionRow[]).map((r) => ({
    anchorId: r.anchorId,
    terms: r.terms.map(normalizeSearchText),
  })),
}));

/** Does any term of this section (section-level OR any row) contain `q`? */
function sectionMatches(h: SectionHaystack, q: string): boolean {
  if (h.sectionTerms.some((t) => t.includes(q))) return true;
  return h.rows.some((r) => r.terms.some((t) => t.includes(q)));
}

/**
 * Filter the section list by a search query.
 *
 * Case- and punctuation-insensitive substring match over each section's label,
 * description and row corpus, so any shipped preference is findable both by
 * a fragment (`scrollback`, `poll`, `tray`) and by its full on-screen name
 * (`Terminal scrollback (lines)`). An empty or punctuation-only query returns
 * every section.
 *
 * Pure over static metadata — it adds no preferences and touches no
 * config/persistence, so it cannot disturb the client-pref / PUT /api/config
 * invariant.
 */
export function searchSections(query: string): readonly SettingsSectionEntry[] {
  const q = normalizeSearchText(query);
  if (q === '') return SETTINGS_SECTIONS;
  return SETTINGS_SECTIONS.filter((_, i) => sectionMatches(HAYSTACKS[i], q));
}

/**
 * The same filter, plus WHICH rows matched (WARDEN-1290).
 *
 * Identical predicate, identical normalization, identical order: the sections
 * this returns are exactly `searchSections(query)`, one for one (asserted in
 * sectionSearch.test.mjs). The only addition is `matchedAnchors`, the DOM ids
 * of the matching rows — which is what lets SettingsPage highlight the row the
 * search already knew it had matched, instead of handing the user a section to
 * scan by eye.
 *
 * An empty/punctuation-only query returns every section with NO matched
 * anchors: "show everything" is not a match, and nothing should be highlighted.
 */
export function searchSectionsWithRows(query: string): readonly SectionRowMatch[] {
  const q = normalizeSearchText(query);
  if (q === '') return SETTINGS_SECTIONS.map((section) => ({ section, matchedAnchors: [] }));
  const out: SectionRowMatch[] = [];
  SETTINGS_SECTIONS.forEach((section, i) => {
    const h = HAYSTACKS[i];
    if (!sectionMatches(h, q)) return;
    const anchors: string[] = [];
    for (const row of h.rows) {
      if (row.anchorId === undefined) continue;
      if (anchors.includes(row.anchorId)) continue;
      if (row.terms.some((t) => t.includes(q))) anchors.push(row.anchorId);
    }
    out.push({ section, matchedAnchors: anchors });
  });
  return out;
}
