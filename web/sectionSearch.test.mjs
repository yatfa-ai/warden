// Tests for sectionSearch — the Settings section metadata + search seam
// (WARDEN-912).
//
// No front-end test runner in this repo, so (like sectionPersistence.test.mjs
// and settingsDirty.test.mjs) this loads the REAL
// src/components/settings/sectionSearch.ts (transpiled TS -> ESM via Vite's OXC
// transform) and exercises the pure helpers. The module is import-free (no
// React, no UI), so it loads standalone.
//
// This file is auto-discovered by `npm test` (`node --test` runs every
// *.test.mjs in web/), so it runs in CI with no package.json wiring.
//
// Run: node sectionSearch.test.mjs   (from web/)
//
// ---------------------------------------------------------------------------
// What this file is actually for
// ---------------------------------------------------------------------------
// `keywords` is a hand-maintained parallel corpus of text that renders
// somewhere in Settings. Nothing in the type system ties the two together, so
// the corpus can drift the moment a row is added or renamed, and the symptom of
// drift is the worst possible one: the search box answers
// "No matching sections." for a preference that demonstrably ships, which a
// user reads as "Warden has no such setting."
//
// The durable requirement is a guard that holds IN BOTH DIRECTIONS, over every
// authoring shape a label can take:
//
//   corpus -> source  ("no phantom hits"):  1. LABELS_EXIST_IN_SOURCE — every
//      label the corpus claims (via the SHIPPED_LABELS mirror) is really
//      rendered, in its section's markup OR in the data module its options are
//      declared in. Catches a RENAME/REMOVAL: the corpus describing a row or
//      option that no longer exists.
//   source -> corpus  ("nothing unfindable"): 2. EVERY_LABEL_FINDS_ITS_SECTION
//      and 3. EVERY_SOURCE_ROW_IS_IN_THE_CORPUS — every user-visible label the
//      Settings source renders, in ANY of the shapes it can be authored in,
//      resolves to its own section. Catches PARAPHRASE and OMISSION.
//
// And the authoring shapes are the point — this ticket failed audit three
// times, each time because a set of shipped labels was missing, and each fix
// transcribed that set rather than closing the class. A label can be authored:
//
//   a. literally in section markup       — <Label>/<SelectItem> text, headings,
//                                          aria-labels (extractor below);
//   b. as data in a plain module         — the theme roster, the terminal font
//                                          list, the telemetry consent
//                                          categories, rendered via .map()
//                                          (OPTION_DATA_MODULES below);
//   c. as data inline in the section     — a `label:` string inside an array
//                                          literal in the section file itself
//                                          (Notifications' pane-state
//                                          switches, `this machine (local)`) —
//                                          covered by `label:` literal
//                                          extraction over the section source.
//
// Shape (b) is the one a section-markup-only extractor is structurally blind
// to, and the one that broke round three: 15 shipped option labels (`Dracula`,
// `Nord`, `JetBrains Mono`, …) returned the empty state while their literal
// sibling `System (follow OS)` from the same dropdown resolved. A shape-(b)
// mutation — adding a theme to lib/themes.ts — left the whole suite green.
// The data-module guards below exist so that mutation goes red.
import { transformWithOxc } from 'vite';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const helperPath = resolve(__dirname, 'src/components/settings/sectionSearch.ts');
const sectionsDir = resolve(__dirname, 'src/components/settings/sections');

// --- Load the REAL sectionSearch.ts (TS -> ESM via the OXC transform) ---
async function loadTsModule(path) {
  const src = readFileSync(path, 'utf8');
  const { code } = await transformWithOxc(src, path, {});
  const tmpDir = mkdtempSync(join(tmpdir(), 'warden-section-search-test-'));
  const tmpFile = join(tmpDir, 'module.mjs');
  writeFileSync(tmpFile, code);
  try {
    return await import(tmpFile);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

const { SETTINGS_SECTIONS, searchSections, normalizeSearchText } = await loadTsModule(helperPath);

/** ids of matching sections, for terse assertions. */
const ids = (query) => searchSections(query).map((s) => s.id);

// ---------------------------------------------------------------------------
// Data-authored option sources (authoring shape b).
//
// Static, curated, shipped option lists that are declared in a plain data
// module and rendered by mapping over it. They are every bit as user-visible
// as a literal <SelectItem> — a user who knows they want the Dracula theme
// types `Dracula` — but a section-markup extractor never sees their text,
// because the JSX children are `{t.label}`, not the string itself.
//
// Keep this list complete: the imported-array guard below FAILS when a section
// file maps over an imported array that is not registered here (or explicitly
// excluded in MAPPED_IMPORT_EXCLUSIONS), so a NEW data-authored option list
// cannot ship unfindable the way the theme roster did.
//
// `load: true` modules are import-free, so the harness loads the REAL module
// and reads the runtime array — the source of truth is the shipped code, not a
// regex over its text. fontOptions.ts imports @/lib/storage (unresolvable
// outside the bundler), so its labels are extracted by regex instead.
const OPTION_DATA_MODULES = [
  {
    module: resolve(__dirname, 'src/lib/themes.ts'),
    exportName: 'THEMES',
    section: 'appearance',
    renderedIn: 'AppearanceSection.tsx',
    load: true,
    minLabels: 8,
  },
  {
    module: resolve(__dirname, 'src/components/settings/fontOptions.ts'),
    exportName: 'TERMINAL_FONT_OPTIONS',
    section: 'appearance',
    renderedIn: 'AppearanceSection.tsx',
    load: false,
    minLabels: 6,
  },
  {
    module: resolve(__dirname, 'src/lib/telemetry/consent.ts'),
    exportName: 'TELEMETRY_CATEGORIES',
    section: 'telemetry',
    renderedIn: 'TelemetrySection.tsx',
    load: true,
    minLabels: 2,
  },
];

/** The labels each data module ships, as [label, sourceDescriptor] pairs. */
async function dataModuleLabels() {
  const out = [];
  for (const src of OPTION_DATA_MODULES) {
    let labels;
    if (src.load) {
      const mod = await loadTsModule(src.module);
      const arr = mod[src.exportName];
      assert.ok(Array.isArray(arr), `${src.module} must export an array as ${src.exportName}`);
      labels = arr.map((e) => e.label);
    } else {
      const text = readFileSync(src.module, 'utf8');
      labels = [...text.matchAll(/\blabel:\s*(['"])((?:\\.|(?!\1).)*)\1/g)].map((m) => m[2]);
    }
    // A regex that silently stopped matching (or a loaded export whose shape
    // changed) would otherwise make every data-module guard below vacuously
    // green — the same trap as the row-count floor further down.
    assert.ok(
      labels.length >= src.minLabels,
      `${src.module} yielded only ${labels.length} labels (floor ${src.minLabels}) — ` +
        `the extraction has stopped matching, or entries were removed without updating this floor`,
    );
    for (const label of labels) out.push([label, src]);
  }
  return out;
}

const DATA_LABELS = await dataModuleLabels();

// ---------------------------------------------------------------------------
// The shipped rows: [section id, verbatim on-screen text, source file].
// Text is the row label, a Select option, or the aria-label of a field that has
// no visible label (Snippets/Patterns). Helper prose beneath a row is
// deliberately absent — see rule 2 in sectionSearch.ts.
//
// The optional third element names WHERE the label is authored when that is not
// the section file itself: data-module options point at their data module, so
// the corpus->source guard checks the module (the section only renders
// `{t.label}`). It defaults to the section's own file.
// ---------------------------------------------------------------------------
const SECTION_FILES = {
  hosts: 'HostsSection.tsx',
  observer: 'ObserverSection.tsx',
  safety: 'SafetySection.tsx',
  attention: 'AttentionThresholdsSection.tsx',
  tokenbudget: 'TokenBudgetSection.tsx',
  performance: 'PerformanceSection.tsx',
  telemetry: 'TelemetrySection.tsx',
  display: 'DisplaySection.tsx',
  appearance: 'AppearanceSection.tsx',
  newchats: 'NewChatsSection.tsx',
  snippets: 'SnippetsSection.tsx',
  patterns: 'PatternsSection.tsx',
  notifications: 'NotificationsSection.tsx',
};

const SHIPPED_LABELS = [
  ['hosts', 'Configured Hosts'],
  ['hosts', 'Add Host'],
  ['hosts', 'Add a host from ~/.ssh/config'],
  ['hosts', 'Host name to add'],
  ['hosts', 'Display label per host'],
  ['hosts', 'this machine (local)'],
  ['hosts', 'Dashboard Refresh Interval (ms)'],
  ['hosts', 'Tmux Session Name'],
  ['hosts', 'Connect Timeout (seconds)'],

  ['observer', 'Directive Confirmation'],
  ['observer', 'Always confirm (default)'],
  ['observer', 'Auto-send safe directives'],
  ['observer', 'Auto-start Observer'],
  ['observer', 'Session Auto-stop (minutes)'],
  ['observer', 'Observer model'],
  ['observer', 'Base URL'],
  ['observer', 'Auth token'],
  ['observer', 'Max output tokens'],

  ['safety', 'Confirm before destructive actions (force-kill, kill chat)'],

  ['attention', 'Warning after (minutes)'],
  ['attention', 'Critical after (minutes)'],

  ['tokenbudget', 'Enable token-spend budget alerts'],
  ['tokenbudget', 'Fleet threshold (tokens)'],
  ['tokenbudget', 'Window (hours)'],
  ['tokenbudget', 'Per-session threshold (tokens)'],

  ['performance', 'Companion transport'],

  // The consent switches render from the registry (lib/telemetry/consent.ts,
  // WARDEN-1116) — authored as data, so their SOURCE is the module.
  ['telemetry', 'Anonymous errors, crashes & freezes', 'src/lib/telemetry/consent.ts'],
  ['telemetry', 'Chat & session names', 'src/lib/telemetry/consent.ts'],
  ['telemetry', 'Operational metrics', 'src/lib/telemetry/consent.ts'],
  ['telemetry', 'Receiver endpoint'],
  ['telemetry', 'Receiver auth token (optional)'],

  ['display', 'Show host tags (local/hostname badges)'],
  ['display', 'Show type badges (shell/claude/yatfa labels)'],
  ['display', 'Show status indicators (active/idle/dead dots)'],
  ['display', 'Show project badges'],
  ['display', 'Hide offline hosts (collapse into an expandable summary)'],

  ['appearance', 'Terminal font size'],
  ['appearance', 'Terminal font family'],
  ['appearance', 'Custom terminal font family'],
  ['appearance', 'Terminal scrollback (lines)'],
  ['appearance', 'Theme'],
  ['appearance', 'Terminal color scheme'],
  ['appearance', 'Match app theme (default)'],
  ['appearance', 'Terminal cursor style'],
  ['appearance', 'Copy on select'],
  ['appearance', 'Density'],
  ['appearance', 'Timestamp format'],
  ['appearance', 'Pane layout'],
  ['appearance', 'When an agent exits'],
  ['appearance', 'Auto-focus pane on open'],
  ['appearance', 'Restore workspace on startup'],
  ['appearance', 'Remember window position and size'],
  ['appearance', 'Launch Warden at login'],
  ['appearance', 'Close to tray'],
  ['appearance', 'System (follow OS)'],
  ['appearance', 'Blinking block (default)'],
  ['appearance', 'Steady underline'],
  ['appearance', 'Comfortable (default)'],
  ['appearance', 'Compact'],
  ['appearance', 'Relative (default)'],
  ['appearance', 'Auto grid (default)'],
  ['appearance', 'Side-by-side (single row)'],
  ['appearance', 'Stacked (single column)'],
  ['appearance', 'Keep pane (default)'],
  ['appearance', 'Auto-close pane'],
  ['appearance', 'Reopen previous (default)'],
  ['appearance', 'Start empty'],
  // Theme + font options — authored in lib/themes.ts and
  // settings/fontOptions.ts, rendered by mapping over them.
  ['appearance', 'GitHub Light', 'src/lib/themes.ts'],
  ['appearance', 'Light+ (VS Code)', 'src/lib/themes.ts'],
  ['appearance', 'GitHub Dark', 'src/lib/themes.ts'],
  ['appearance', 'Dark+ (VS Code)', 'src/lib/themes.ts'],
  ['appearance', 'Catppuccin Mocha', 'src/lib/themes.ts'],
  ['appearance', 'Dracula', 'src/lib/themes.ts'],
  ['appearance', 'Nord', 'src/lib/themes.ts'],
  ['appearance', 'One Dark', 'src/lib/themes.ts'],
  ['appearance', 'System default', 'src/components/settings/fontOptions.ts'],
  ['appearance', 'Cascadia Code', 'src/components/settings/fontOptions.ts'],
  ['appearance', 'JetBrains Mono', 'src/components/settings/fontOptions.ts'],
  ['appearance', 'Fira Code', 'src/components/settings/fontOptions.ts'],
  ['appearance', 'Source Code Pro', 'src/components/settings/fontOptions.ts'],
  ['appearance', 'Menlo', 'src/components/settings/fontOptions.ts'],
  ['appearance', 'Consolas', 'src/components/settings/fontOptions.ts'],

  ['newchats', 'Default agent type'],
  ['newchats', 'claude (default)'],
  ['newchats', 'Custom presets'],
  ['newchats', 'Add preset'],
  ['newchats', 'New preset name'],
  ['newchats', 'New preset command'],
  ['newchats', 'Default host'],
  ['newchats', 'this machine (local)'],
  ['newchats', 'Default shell (fallback for any host without its own)'],
  ['newchats', 'Default shell per host'],
  ['newchats', 'Default working directory (fallback for any host without its own)'],
  ['newchats', 'Working directory per host'],
  ['newchats', 'Agent type per host'],
  ['newchats', 'Use global default'],

  ['snippets', 'Add snippet'],
  ['snippets', 'New snippet name'],
  ['snippets', 'New snippet instruction text'],

  ['patterns', 'Add pattern'],
  ['patterns', 'New pattern name'],
  ['patterns', 'New pattern expression'],
  ['patterns', 'New pattern match mode'],

  ['notifications', 'In-app toasts'],
  ['notifications', 'Chat operations'],
  ['notifications', 'Errors'],
  ['notifications', 'Success messages'],
  ['notifications', 'Observer events'],
  ['notifications', 'Desktop alerts'],
  ['notifications', 'Desktop alerts when agents need attention (while Warden is unfocused)'],
  ['notifications', 'Which alerts to push'],
  ['notifications', 'Critical agents'],
  ['notifications', 'Warning agents'],
  ['notifications', 'Pending directives'],
  ['notifications', 'Recent errors'],
  ['notifications', 'Token budget'],
  ['notifications', 'Webhook push alerts'],
  ['notifications', 'Enable webhook push'],
  ['notifications', 'Webhook URL'],
  ['notifications', 'Shared secret (optional)'],
  // Pane-state switches — authored as an inline data array in the section file.
  ['notifications', 'Erroring'],
  ['notifications', 'Stuck'],
  ['notifications', 'Waiting on you'],
  ['notifications', 'Blocked'],
  ['notifications', 'Finished'],
];

// --- Guard 1 (corpus -> source): the table describes rows that really render --
test('every shipped label really appears in its source (rename guard)', () => {
  const cache = new Map();
  const sourceOf = (entry) => {
    const [id, , where] = entry;
    if (where) return resolve(__dirname, where);
    return join(sectionsDir, SECTION_FILES[id]);
  };
  for (const entry of SHIPPED_LABELS) {
    const [id, label] = entry;
    const path = sourceOf(entry);
    if (!cache.has(path)) {
      // JSX wraps text across lines and escapes `&` as `&amp;`; normalizing the
      // whole file makes the comparison whitespace- and entity-insensitive.
      const raw = readFileSync(path, 'utf8').replaceAll('&amp;', '&');
      cache.set(path, normalizeSearchText(raw));
    }
    assert.ok(
      cache.get(path).includes(normalizeSearchText(label)),
      `"${label}" is not rendered by ${relative(__dirname, path)} (section "${id}") — ` +
        `the row or option was renamed or removed, so its keywords entry in sectionSearch.ts ` +
        `is now describing a preference that does not exist.`,
    );
  }
});

// --- Guard 2 (source -> corpus): the corpus is verbatim, so a label finds its
// own section. This is the regression test for the shipped defect. It asserts
// the BEHAVIOUR (the label resolves) rather than byte-identical transcription,
// so a punctuation-only paraphrase now passes — correctly, since normalization
// makes it equivalent. What still fails is every paraphrase that changes WORDS,
// which is the class that shipped: dropping one (`Receiver auth token
// (optional)` -> `receiver auth token`), substituting one (`&` -> `and`), or
// splitting a label into fragments that are never contiguous (`Default shell
// per host` -> `default shell` + `per host`). Each of those was verified to
// turn this red.
test('every shipped label finds its own section (paraphrase guard)', () => {
  for (const [id, label] of SHIPPED_LABELS) {
    assert.ok(
      ids(label).includes(id),
      `searching the verbatim on-screen label "${label}" did not return its own section ` +
        `"${id}" (got: ${JSON.stringify(ids(label))}). The keywords entry is paraphrasing the ` +
        `row instead of transcribing it — a user typing the label they are looking at gets ` +
        `"No matching sections."`,
    );
  }
});

test('no shipped label ever produces the "No matching sections." empty state', () => {
  // Success criterion 2: the empty state is only ever correct for a term that
  // matches no real preference.
  for (const [, label] of SHIPPED_LABELS) {
    assert.notEqual(searchSections(label).length, 0, label);
  }
});

// --- Guard 3 (source -> corpus): the corpus claims EVERYTHING the source
// renders, in every authoring shape -----------------------------------------
// Guards 1 and 2 both run corpus -> source: they ask "does what I claim
// exist?" and "does what I claim resolve?". Neither can ask "did I claim
// everything?", because SHIPPED_LABELS is itself a hand-maintained mirror of
// `keywords` — a row missing from BOTH is invisible to both. That is exactly
// how `Match app theme (default)` shipped unfindable while its two sibling
// options from the same dropdown were present, and it is the drift direction
// that dominates from here (the next person ADDS a row; they rarely rename
// one). This guard runs the other way — source -> corpus — so it fails on a
// row that was never transcribed at all.

/** Files with no section id. Reset is always visible, outside activeSection gating. */
const UNSECTIONED_FILES = new Set(['ResetSection.tsx']);

// Text extracted from source that is deliberately NOT a searchable preference.
// Keeping this explicit (rather than just absent from the corpus) is the point:
// it makes "deliberately excluded" distinguishable from "forgotten".
// NOTHING is currently excluded — every string the extractors below surface
// resolves today. If you add an entry, say why in a comment beside it; an
// entry with no reason is indistinguishable from a bug.
const NOT_A_PREFERENCE = new Set([
  // (empty — see above)
]);

/**
 * Strip comments before extraction. Comments are not rendered, but they CAN
 * contain JSX-shaped text: HostsSection's WARDEN-951 comment says `not
 * <Label>): it heads a GROUP…`, and the raw extractor matched that `<Label>` as
 * the start of a real row, swallowing everything up to the first real
 * `</Label>` and surfacing comment prose as a phantom row. Only block comments
 * are stripped — that is the JSX/TS comment form these files use, and
 * stripping `//` line comments would corrupt strings holding URLs.
 */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '');
}

/**
 * Every user-visible row/option/field name rendered by a section file.
 *
 * Covers the shapes a row's accessible name actually takes in these files:
 *   - <Label>/<SelectItem> children  (most rows and every literal dropdown option)
 *   - font-medium <span>/<div> group headings (Notifications channels, Observer model)
 *   - aria-label="…" on inputs with no visible label (Snippets, Patterns,
 *     custom font, presets) — a user searches for these by that name too.
 *   - `label: '…'` string literals (inline data arrays: Notifications'
 *     pane-state switches, `this machine (local)`) — the inline variant of
 *     authoring shape (b), where the array lives in the section file itself.
 *
 * Only the LEADING plain-text run of an element is taken: children are cut at
 * the first nested tag or `{expression}`. That keeps a label from being
 * concatenated with its sub-hint <span> (`Attention` + `stuck / erroring / …`,
 * which would produce a string that renders nowhere), and it drops genuinely
 * dynamic runtime values (`{defaultNewChatPreset} (deleted)`, `{host} (no
 * longer available)` — per-host text, not preferences).
 *
 * ⚠️ Cutting at `{` ALSO drops STATIC option lists rendered by mapping over a
 * data module (`{TERMINAL_FONT_OPTIONS.map(…)}`, `{THEMES.filter(…).map(…)}`,
 * `{TELEMETRY_CATEGORIES.map(…)}`) — shipped, curated strings that are every
 * bit as user-visible as the literals. That is not a claim that everything cut
 * at `{` is dynamic; it is a limit of reading markup alone. Those sites are
 * covered SEPARATELY, at the data module itself, by the data-module guards
 * below (and any NEW mapped-import array fails the imported-array guard), so
 * the class is closed rather than silently dropped.
 */
function extractRowAndOptionText(source) {
  const found = new Set();
  const push = (raw) => {
    const text = String(raw).split(/<|\{/)[0].replace(/\s+/g, ' ').replaceAll('&amp;', '&').trim();
    if (text) found.add(text);
  };
  let m;
  const rows = /<(Label|SelectItem)\b[^>]*>([\s\S]*?)<\/\1>/g;
  while ((m = rows.exec(source))) push(m[2]);
  const headings = /<(span|div)\b[^>]*\bfont-medium\b[^>]*>([\s\S]*?)<\/\1>/g;
  while ((m = headings.exec(source))) push(m[2]);
  const ariaLabels = /aria-label="([^"]+)"/g;
  while ((m = ariaLabels.exec(source))) push(m[1]);
  // Inline data arrays: `{ k: 'erroring', label: 'Erroring', hint: '…' }` —
  // the label renders (via `{label}` children the JSX pass cannot read), the
  // key/hint do not surface as row names.
  const inlineLabels = /\blabel:\s*(['"])((?:\\.|(?!\1).)*)\1/g;
  while ((m = inlineLabels.exec(source))) push(m[2]);
  return [...found];
}

test('every section source file is mapped to a section id (new-section guard)', () => {
  // Without this, a newly added FooSection.tsx would simply be skipped by the
  // guard below — its rows unfindable, its absence silent.
  for (const file of readdirSync(sectionsDir).filter((f) => f.endsWith('.tsx'))) {
    assert.ok(
      UNSECTIONED_FILES.has(file) || Object.values(SECTION_FILES).includes(file),
      `${file} is not in SECTION_FILES — add it (and its keywords corpus), or list it in ` +
        `UNSECTIONED_FILES if it renders outside the activeSection nav.`,
    );
  }
});

test('every row the source renders resolves to its own section (omission guard)', () => {
  let checked = 0;
  for (const [id, file] of Object.entries(SECTION_FILES)) {
    const source = stripComments(readFileSync(join(sectionsDir, file), 'utf8'));
    for (const text of extractRowAndOptionText(source)) {
      if (NOT_A_PREFERENCE.has(text)) continue;
      checked++;
      assert.ok(
        ids(text).includes(id),
        `${file} renders "${text}", but searching it does not return "${id}" ` +
          `(got: ${JSON.stringify(ids(text))}). This row was never transcribed into the ` +
          `keywords corpus in sectionSearch.ts, so a user typing the row name they are ` +
          `looking at gets "No matching sections." Add it verbatim.`,
      );
    }
  }
  // A regex that silently stops matching would make this test vacuously green.
  assert.ok(checked > 100, `extractor found only ${checked} rows — it has stopped matching`);
});

// --- Data-module guards (authoring shape b) ----------------------------------
//
// The option labels declared in plain data modules and rendered by .map() —
// the exact blind spot of round three, where 15 shipped labels were unfindable
// and every mutation probe that validated the guard added options the LITERAL
// way, through the path the extractor already read.

test('every data-authored option label resolves to its section (omission, shape b)', () => {
  for (const [label, src] of DATA_LABELS) {
    assert.ok(
      ids(label).includes(src.section),
      `${relative(__dirname, src.module)} ships the option "${label}", but searching it does ` +
        `not return "${src.section}" (got: ${JSON.stringify(ids(label))}). Data-authored labels ` +
        `are corpus entries too — add it verbatim to that section's keywords in ` +
        `sectionSearch.ts. A user who knows they want this option types its name.`,
    );
  }
});

test('each data module is actually rendered by the section it is registered under (wiring guard)', () => {
  // Extraction without rendering would let a data module's labels leak into
  // the corpus (or the registry rot while the section moved on). Each entry
  // must be imported AND mapped over in the section file it names — that is
  // the mechanism by which module labels become on-screen text.
  for (const src of OPTION_DATA_MODULES) {
    const sectionSource = readFileSync(join(sectionsDir, src.renderedIn), 'utf8');
    assert.ok(
      new RegExp(`\\b${src.exportName}\\s*\\.(?:map|filter)\\s*\\(`).test(sectionSource),
      `${src.renderedIn} no longer maps over ${src.exportName} — either the options moved ` +
        `(update OPTION_DATA_MODULES / the corpus), or they stopped rendering (drop the corpus ` +
        `entries).`,
    );
  }
});

// Mapped imports deliberately NOT in OPTION_DATA_MODULES. Same honesty
// contract as NOT_A_PREFERENCE: an entry without a reason is indistinguishable
// from a bug. (Runtime/user-data arrays — hosts, presets, snippets, patterns —
// are LOCALS or props, not imports, so they never reach this check; only
// static imported arrays do.)
const MAPPED_IMPORT_EXCLUSIONS = new Map([
  // (empty — every mapped imported array in settings/sections is registered
  //  above. If you exclude one, say why here.)
]);

test('every imported array a section maps over is registered as a data source (new-module guard)', () => {
  // The round-three failure mode, one level up: someone adds a NEW data module
  // of options, maps over it in a section, and no guard notices because the
  // section markup still shows only `{label}`. This fails instead: mapping over
  // an IMPORTED identifier in a section file requires a registry entry (or an
  // explicit, reasoned exclusion).
  const registered = new Set(OPTION_DATA_MODULES.map((s) => s.exportName));
  for (const file of readdirSync(sectionsDir).filter((f) => f.endsWith('.tsx'))) {
    const source = stripComments(readFileSync(join(sectionsDir, file), 'utf8'));
    // Imported names: `import { X, Y } from '…'` and `import X from '…'`.
    const imported = new Set();
    for (const m of source.matchAll(/import\s*\{([^}]*)\}\s*from/g))
      for (const name of m[1].split(',')) {
        const id = name.trim().split(/\s+as\s+/).pop().trim();
        if (id) imported.add(id);
      }
    for (const m of source.matchAll(/import\s+([A-Za-z_$][\w$]*)\s+from/g)) imported.add(m[1]);
    // Receivers: `IDENT.map(` / `IDENT.filter(` — the two forms a rendered
    // list takes (THEMES is filtered then mapped; the others map directly).
    for (const m of source.matchAll(/\b([A-Za-z_$][\w$]*)\s*\.(?:map|filter)\s*\(/g)) {
      const name = m[1];
      if (!imported.has(name)) continue; // local/prop arrays are runtime data
      if (registered.has(name)) continue;
      if (MAPPED_IMPORT_EXCLUSIONS.has(name)) continue;
      assert.fail(
        `${file} maps over the imported array ${name}, but it is not in OPTION_DATA_MODULES — ` +
        `its labels render in Settings and must be corpus entries (register it with its ` +
        `module/section/exportName), or record it in MAPPED_IMPORT_EXCLUSIONS with a reason.`,
      );
    }
  }
});

test('the data-module label table mirrors the corpus table (no phantom data entries)', () => {
  // The corpus->source direction for data labels: a SHIPPED_LABELS entry whose
  // source is a data module must still be a label that module ships. Renaming
  // a theme turns THIS red (the mirror names the old label) together with the
  // omission guard (the corpus lacks the new one) — both directions bite.
  const shipped = new Map(SHIPPED_LABELS.filter((e) => e[2]).map((e) => [e[1], e[2]]));
  for (const [label, src] of DATA_LABELS) {
    const claimed = shipped.get(label);
    assert.ok(
      claimed !== undefined,
      `data label "${label}" (${src.exportName}) is extracted but not mirrored in SHIPPED_LABELS — ` +
        `add it so the rename guard covers it.`,
    );
    assert.equal(
      claimed,
      relative(__dirname, src.module),
      `"${label}" is mirrored against ${claimed} but is shipped by ${relative(__dirname, src.module)}`,
    );
  }
  // And the mirror names no data label the modules no longer ship (the direct
  // phantom-hit check: corpus says Dracula, themes.ts no longer has it).
  const live = new Set(DATA_LABELS.map(([l]) => l));
  for (const [label, where] of shipped) {
    assert.ok(
      live.has(label),
      `SHIPPED_LABELS claims "${label}" is shipped by ${where}, but that module no longer has it — ` +
        `a phantom corpus entry: searching it would match a section for an option that no ` +
        `longer exists. Remove the entry (and its keyword).`,
    );
  }
});


// Normalization + a bigger corpus WIDEN matching, so these assert the exact
// result set, not merely "contains" — a new section creeping in is a regression.
test('WARDEN-887 shipped search table is unregressed', () => {
  assert.deepEqual(ids('font'), ['appearance']);
  assert.deepEqual(ids('kill'), ['safety', 'tokenbudget']);
  assert.deepEqual(ids('webhook'), ['notifications']);
  assert.deepEqual(ids('telemetry'), ['telemetry']);
  assert.deepEqual(ids('host'), ['hosts', 'display', 'newchats']);
  assert.deepEqual(ids('zzz'), []);
  assert.equal(searchSections('').length, SETTINGS_SECTIONS.length);
});

test('empty and whitespace/punctuation-only queries return every section', () => {
  for (const q of ['', '   ', '???', '   -  ', '()']) {
    assert.equal(searchSections(q).length, SETTINGS_SECTIONS.length, JSON.stringify(q));
  }
});

// --- The ticket's own zero-match probe: 22 of 24 returned nothing before -----
test("the ticket's probe terms resolve to the sections that ship them", () => {
  const PROBES = [
    ['scrollback', 'appearance'],
    ['cursor', 'appearance'],
    ['font size', 'appearance'],
    ['density', 'appearance'],
    ['compact', 'appearance'],
    ['timestamp', 'appearance'],
    ['tray', 'appearance'],
    ['dark', 'appearance'],
    ['light', 'appearance'],
    ['clipboard', 'appearance'],
    ['copy', 'appearance'],
    ['layout', 'appearance'],
    ['grid', 'appearance'],
    ['bell', 'notifications'],
    ['poll', 'hosts'],
    ['interval', 'hosts'],
    ['refresh', 'hosts'],
    ['secret', 'notifications'],
    ['cwd', 'newchats'],
    ['preset', 'newchats'],
    ['token', 'tokenbudget'],
    ['working directory', 'newchats'],
    // Data-authored option names — the round-three failure: a user who knows
    // they want a specific theme or font types ITS name, not the word "theme".
    ['Dracula', 'appearance'],
    ['Nord', 'appearance'],
    ['Catppuccin Mocha', 'appearance'],
    ['One Dark', 'appearance'],
    ['JetBrains Mono', 'appearance'],
    ['Fira Code', 'appearance'],
    ['Menlo', 'appearance'],
    ['System default', 'appearance'],
    ['Chat & session names', 'telemetry'],
  ];
  for (const [term, id] of PROBES) {
    assert.ok(ids(term).includes(id), `${term} -> expected ${id}, got ${JSON.stringify(ids(term))}`);
  }
});

// --- Punctuation insensitivity, from both directions ------------------------
test('punctuation in either the query or the corpus never decides a match', () => {
  // The user typed the label; the corpus has it verbatim.
  assert.ok(ids('Session Auto-stop (minutes)').includes('observer'));
  // The user dropped the punctuation the label renders with.
  assert.ok(ids('session auto stop minutes').includes('observer'));
  // The user typed `and` where the label renders `&`, and vice versa.
  assert.ok(ids('anonymous errors crashes freezes').includes('telemetry'));
  assert.ok(ids('Anonymous errors, crashes & freezes').includes('telemetry'));
  // Case and stray whitespace are irrelevant.
  assert.deepEqual(ids('  TERMINAL SCROLLBACK  '), ids('terminal scrollback'));
});

test('normalizeSearchText collapses to bare lowercase words', () => {
  assert.equal(normalizeSearchText('Show host tags (local/hostname badges)'), 'show host tags local hostname badges');
  assert.equal(normalizeSearchText('Anonymous errors, crashes & freezes'), 'anonymous errors crashes freezes');
  assert.equal(normalizeSearchText('WARDEN_COMPANION_TRANSPORT'), 'warden companion transport');
  assert.equal(normalizeSearchText('  --  '), '');
});

// --- Structural drift guards ------------------------------------------------
test('every section carries a non-empty keyword corpus', () => {
  // A 14th section added with no `keywords` would otherwise be silently
  // unfindable by any of its rows.
  for (const s of SETTINGS_SECTIONS) {
    assert.ok(Array.isArray(s.keywords), `${s.id} keywords must be an array`);
    assert.ok(s.keywords.length > 0, `${s.id} has an empty keyword corpus`);
    for (const k of s.keywords) {
      assert.notEqual(normalizeSearchText(k), '', `${s.id} has a keyword that normalizes to nothing`);
    }
  }
});

test('every section is reachable by its own label, and ids are unique', () => {
  const seen = new Set();
  for (const s of SETTINGS_SECTIONS) {
    assert.ok(!seen.has(s.id), `duplicate section id ${s.id}`);
    seen.add(s.id);
    assert.ok(ids(s.label).includes(s.id), `${s.label} does not find ${s.id}`);
  }
});

test('the shipped-label table covers every section', () => {
  const covered = new Set(SHIPPED_LABELS.map(([id]) => id));
  for (const s of SETTINGS_SECTIONS) {
    assert.ok(covered.has(s.id), `no shipped label listed for section "${s.id}"`);
  }
});

test('search preserves the declared section order', () => {
  const order = SETTINGS_SECTIONS.map((s) => s.id);
  const got = ids('e'); // a broad query hitting most sections
  assert.deepEqual(got, order.filter((id) => got.includes(id)));
});
