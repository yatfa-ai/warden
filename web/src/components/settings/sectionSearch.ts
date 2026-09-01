// Settings section metadata + the search seam behind the header search box.
//
// Lifted out of SettingsPage.tsx (WARDEN-912) for the same reason
// sectionPersistence.ts (WARDEN-870) and configDirty.ts (WARDEN-906) were: it
// is pure, import-free logic, so `node --test` can load it by file path and
// assert on it. The guard that matters here is drift — `keywords` is a
// hand-maintained parallel corpus of text that actually renders somewhere under
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
// "Warden has no such setting." It does have it. `keywords` puts those rows in
// the corpus so already-delivered preferences are reachable. It adds no
// preferences and touches no config/persistence.
//
// ---------------------------------------------------------------------------
// Two rules keep this corpus correct. Both were learned the hard way.
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
// Beyond the verbatim text, each row may carry the obvious synonym a user would
// type for it (`poll interval` for Dashboard Refresh Interval, `system tray`
// for Close to tray). Synonyms are additive; they never replace the real text.
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
// Invariant: adding or renaming a preference row means updating its entry here.
// The same holds for an option ADDED TO A DATA MODULE (a theme, a terminal
// font, a telemetry consent category): see rule 4.

/** One entry per row/option/synonym. Matching is per-entry (see `searchSections`). */
export interface SettingsSectionMeta {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly keywords: readonly string[];
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
    keywords: [
      // Rows — HostsSection.tsx
      'Configured Hosts',
      'Add Host',
      'Add a host from ~/.ssh/config',
      'Host name to add',
      'Display label per host',
      'this machine (local)',
      'Dashboard Refresh Interval (ms)',
      'Tmux Session Name',
      'Connect Timeout (seconds)',
      // Synonyms
      'remove host',
      'friendly name',
      'host tag',
      'poll interval',
      'polling',
      'refresh rate',
      'ssh',
    ],
  },
  {
    id: 'observer',
    label: 'Observer Preferences',
    description: 'Control the observer meta-chat: directive confirmation, auto-start, idle auto-stop, and its model.',
    keywords: [
      // Rows + options — ObserverSection.tsx
      'Directive Confirmation',
      'Always confirm (default)',
      'Auto-send safe directives',
      'Auto-start Observer',
      'Session Auto-stop (minutes)',
      'Observer model',
      'Model',
      'Base URL',
      'Auth token',
      'Max output tokens',
      // Synonyms
      'idle timeout',
      'api endpoint',
      'api key',
      'secret',
    ],
  },
  {
    id: 'safety',
    label: 'Safety',
    description: 'Choose whether Warden confirms before destructive actions like force-killing a chat.',
    keywords: [
      // Row — SafetySection.tsx
      'Confirm before destructive actions (force-kill, kill chat)',
      // Synonyms
      'confirmation prompt',
      'undo',
      'dangerous',
    ],
  },
  {
    id: 'attention',
    label: 'Attention thresholds',
    description: 'Set how long an agent waits before Warden flags it as needing attention.',
    keywords: [
      // Rows — AttentionThresholdsSection.tsx
      'Warning after (minutes)',
      'Critical after (minutes)',
      // Synonyms
      'idle threshold',
      'stale',
      'needs attention',
      'health',
    ],
  },
  {
    id: 'tokenbudget',
    label: 'Token budget',
    description: 'Configure token-budget alerts that notify you — they never auto-kill or pause agents.',
    keywords: [
      // Rows — TokenBudgetSection.tsx
      'Enable token-spend budget alerts',
      'Fleet threshold (tokens)',
      'Window (hours)',
      'Per-session threshold (tokens)',
      // Synonyms
      'spend',
      'cost',
      'usage alert',
    ],
  },
  {
    id: 'performance',
    label: 'Performance',
    description: 'Route remote tmux operations through a persistent SSH channel (experimental).',
    keywords: [
      // Row + badges — PerformanceSection.tsx. NOTE: the helper prose lists
      // `kill` among the routed tmux ops; it is deliberately NOT transcribed
      // (see rule 2 above) so `kill` stays Safety + Token budget.
      'Companion transport',
      'experimental',
      'env override',
      'WARDEN_COMPANION_TRANSPORT',
      // Synonyms
      'persistent ssh channel',
      'remote tmux ops',
      'capture',
      'spawn',
      'liveness',
      'resize',
    ],
  },
  {
    id: 'telemetry',
    label: 'Telemetry',
    description: 'Opt-in usage telemetry — off by default. Nothing leaves your machine until you turn it on.',
    keywords: [
      // Rows — TelemetrySection.tsx. The two consent switches render FROM THE
      // REGISTRY (lib/telemetry/consent.ts, WARDEN-1116): their labels are
      // data-module strings, transcribed here verbatim and guarded there (see
      // rule 4 in this file's header and OPTION_DATA_MODULES in the test).
      'Anonymous errors, crashes & freezes',
      'Chat & session names',
      'Operational metrics',
      'Receiver endpoint',
      'Receiver auth token (optional)',
      // Synonyms
      'privacy',
      'opt-in',
      'test connection',
      'secret',
    ],
  },
  {
    id: 'display',
    label: 'Display',
    description: 'Choose which badges and indicators Warden shows for hosts and chats.',
    keywords: [
      // Rows — DisplaySection.tsx
      'Show host tags (local/hostname badges)',
      'Show type badges (shell/claude/yatfa labels)',
      'Show status indicators (active/idle/dead dots)',
      'Show project badges',
      'Hide offline hosts (collapse into an expandable summary)',
    ],
  },
  {
    id: 'appearance',
    label: 'Appearance',
    description: 'Theme, terminal font, and color preferences — applied instantly.',
    keywords: [
      // Rows — AppearanceSection.tsx
      'Terminal font size',
      'Terminal font family',
      'Custom terminal font family',
      'Terminal scrollback (lines)',
      'Theme',
      'Terminal color scheme',
      'Terminal cursor style',
      'Copy on select',
      'Density',
      'Timestamp format',
      'Pane layout',
      'When an agent exits',
      'Auto-focus pane on open',
      'Restore workspace on startup',
      'Remember window position and size',
      'Launch Warden at login',
      'Close to tray',
      // Select options — AppearanceSection.tsx
      'System (follow OS)',
      'Match app theme (default)',
      'Always dark',
      'Always light',
      'Blinking block (default)',
      'Steady block',
      'Blinking underline',
      'Steady underline',
      'Blinking bar',
      'Steady bar',
      'Comfortable (default)',
      'Compact',
      'Relative (default)',
      'Absolute',
      'Auto grid (default)',
      'Stacked (single column)',
      'Side-by-side (single row)',
      'Keep pane (default)',
      'Dim pane',
      'Auto-close pane',
      'Reopen previous (default)',
      'Start empty',
      // Select options authored as DATA and rendered by mapping over it —
      // the theme roster (lib/themes.ts) and the terminal font list
      // (settings/fontOptions.ts). Same dropdown, different authoring shape:
      // these labels ship exactly as visibly as the literals above, so they are
      // corpus entries too (see rule 4 in this file's header).
      'GitHub Light',
      'Light+ (VS Code)',
      'GitHub Dark',
      'Dark+ (VS Code)',
      'Catppuccin Mocha',
      'Dracula',
      'Nord',
      'One Dark',
      'System default',
      'Cascadia Code',
      'JetBrains Mono',
      'Fira Code',
      'Source Code Pro',
      'Menlo',
      'Consolas',
      // Synonyms
      'history buffer',
      'nerd font',
      'custom font',
      'clipboard',
      'select-to-copy',
      'system tray',
      'minimize to tray',
      'start on boot',
      'startup',
      'time',
    ],
  },
  {
    id: 'newchats',
    label: 'New Chats',
    description: 'Set the defaults for new chats: agent type, host, shell, and working directory.',
    keywords: [
      // Rows + options — NewChatsSection.tsx
      'Default agent type',
      'Custom presets',
      'Add preset',
      'New preset name',
      'New preset command',
      'Default host',
      'this machine (local)',
      'Default shell (fallback for any host without its own)',
      'Default shell per host',
      'Default working directory (fallback for any host without its own)',
      'Working directory per host',
      'Agent type per host',
      'Use global default',
      'claude (default)',
      'claude',
      'shell',
      // Synonyms
      'preset',
      'cwd',
    ],
  },
  {
    id: 'snippets',
    label: 'Instruction snippets',
    description: 'Manage reusable instruction snippets for broadcasts and pane sends.',
    keywords: [
      // Rows — SnippetsSection.tsx (fields are placeholder/aria-labelled)
      'Add snippet',
      'New snippet name',
      'New snippet instruction text',
      // Synonyms
      'reusable',
      'broadcast',
      'pane send',
      'macro',
      'template',
    ],
  },
  {
    id: 'patterns',
    label: 'Watch patterns',
    description: 'Define watch patterns that flag matching agent output, matched server-side.',
    keywords: [
      // Rows — PatternsSection.tsx (fields are placeholder/aria-labelled)
      'Add pattern',
      'New pattern name',
      'New pattern expression',
      'New pattern match mode',
      // Synonyms
      'text substring',
      'regex',
      'regular expression',
      'watched chats',
      'flag output',
    ],
  },
  {
    id: 'notifications',
    label: 'Notifications',
    description: 'Control toast, desktop, and webhook notifications for agent events.',
    keywords: [
      // Rows — NotificationsSection.tsx. NOTE: the "Chat operations" helper line
      // ("Session kill, chat kill, resume, and rename notifications") is
      // deliberately NOT transcribed (see rule 2 above).
      'In-app toasts',
      'Chat operations',
      'Errors',
      'Success messages',
      'Observer events',
      'Desktop alerts',
      'Desktop alerts when agents need attention (while Warden is unfocused)',
      'Which alerts to push',
      'Critical agents',
      'Warning agents',
      'Pending directives',
      'Recent errors',
      'Token budget',
      'Webhook push alerts',
      'Enable webhook push',
      'Webhook URL',
      'Shared secret (optional)',
      // Attention pane-state switches — authored as an inline data array in
      // NotificationsSection and rendered by mapping over it. Transcribed
      // verbatim so the corpus carries the text the user actually reads (the
      // old lowercase synonyms for these were replaced by these entries —
      // normalization makes them the same query either way).
      'Erroring',
      'Stuck',
      'Waiting on you',
      'Blocked',
      'Finished',
      // Synonyms
      'unfocused',
      'permission',
      'mute',
      'bell',
      'test alert',
      'attention alert',
    ],
  },
] as const satisfies readonly SettingsSectionMeta[];

export type SettingsSectionEntry = (typeof SETTINGS_SECTIONS)[number];
export type SectionId = SettingsSectionEntry['id'];

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
const HAYSTACKS: readonly (readonly string[])[] = SETTINGS_SECTIONS.map((s) => [
  normalizeSearchText(s.label),
  normalizeSearchText(s.description),
  ...s.keywords.map(normalizeSearchText),
]);

/**
 * Filter the section list by a search query.
 *
 * Case- and punctuation-insensitive substring match over each section's label,
 * description and keyword corpus, so any shipped preference is findable both by
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
  return SETTINGS_SECTIONS.filter((_, i) => HAYSTACKS[i].some((h) => h.includes(q)));
}
