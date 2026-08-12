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
// somewhere under settings/sections/*. Nothing in the type system ties the two
// together, so the corpus can drift the moment a row is added or renamed, and
// the symptom of drift is the worst possible one: the search box answers
// "No matching sections." for a preference that demonstrably ships, which a
// user reads as "Warden has no such setting."
//
// So there are three guards here, and they are deliberately different — the
// first two run corpus -> source, the third runs source -> corpus:
//
//   1. LABELS_EXIST_IN_SOURCE — every label in the table below is really
//      rendered by its section's .tsx. This catches a RENAME (the table, and
//      therefore the corpus, silently describing a row that no longer exists).
//   2. EVERY_LABEL_FINDS_ITS_SECTION — every label in the table resolves
//      through the real search predicate to its own section. This catches a
//      PARAPHRASE, which is the bug that shipped: the first cut of the corpus
//      rewrote punctuation as it transcribed (`Terminal scrollback (lines)` ->
//      `terminal scrollback lines`, `&` -> `and`, dropped `optional`/`also`),
//      and since matching is a substring test, 22 of 29 verbatim on-screen
//      labels returned the empty state.
//   3. EVERY_SOURCE_ROW_IS_IN_THE_CORPUS — every row/option/aria-label the
//      section SOURCE renders resolves to its own section. This catches an
//      OMISSION, which guards 1 and 2 structurally cannot see: both read the
//      hand-maintained table, so a row missing from both the table and the
//      corpus is invisible to them. `Match app theme (default)` shipped
//      unfindable past 12 green tests for exactly that reason.
//
// Guard 2 caught the shipped defect; guard 3 closes the class rather than the
// instance. Note both drive the input shape that makes the property FAIL (the
// row's own verbatim text), not the one the corpus already satisfied.
import { transformWithOxc } from 'vite';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const helperPath = resolve(__dirname, 'src/components/settings/sectionSearch.ts');
const sectionsDir = resolve(__dirname, 'src/components/settings/sections');

// --- Load the REAL sectionSearch.ts (TS -> ESM via the OXC transform) ---
const src = readFileSync(helperPath, 'utf8');
const { code } = await transformWithOxc(src, helperPath, {});
const tmpDir = mkdtempSync(join(tmpdir(), 'warden-section-search-test-'));
const tmpFile = join(tmpDir, 'sectionSearch.mjs');
writeFileSync(tmpFile, code);
const { SETTINGS_SECTIONS, searchSections, normalizeSearchText } = await import(tmpFile);
rmSync(tmpDir, { recursive: true, force: true });

/** ids of matching sections, for terse assertions. */
const ids = (query) => searchSections(query).map((s) => s.id);

// ---------------------------------------------------------------------------
// The shipped rows: [section id, source file, verbatim on-screen text].
// Text is the row label, a Select option, or the aria-label of a field that has
// no visible label (Snippets/Patterns). Helper prose beneath a row is
// deliberately absent — see rule 2 in sectionSearch.ts.
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

  ['telemetry', 'Anonymous errors, crashes & freezes'],
  ['telemetry', 'Also include chat & session names'],
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
];

// --- Guard 1: the table describes rows that really render -------------------
test('every shipped label really appears in its section source (rename guard)', () => {
  const cache = new Map();
  for (const [id, label] of SHIPPED_LABELS) {
    if (!cache.has(id)) {
      // JSX wraps text across lines and escapes `&` as `&amp;`; normalizing the
      // whole file makes the comparison whitespace- and entity-insensitive.
      const raw = readFileSync(join(sectionsDir, SECTION_FILES[id]), 'utf8').replaceAll('&amp;', '&');
      cache.set(id, normalizeSearchText(raw));
    }
    assert.ok(
      cache.get(id).includes(normalizeSearchText(label)),
      `"${label}" is not rendered by ${SECTION_FILES[id]} — the row was renamed or removed, ` +
        `so its keywords entry in sectionSearch.ts is now describing a preference that does not exist.`,
    );
  }
});

// --- Guard 2: the corpus is verbatim, so a label finds its own section -------
// This is the regression test for the shipped defect. It asserts the BEHAVIOUR
// (the label resolves) rather than byte-identical transcription, so a
// punctuation-only paraphrase now passes — correctly, since normalization makes
// it equivalent. What still fails is every paraphrase that changes WORDS, which
// is the class that shipped: dropping one (`Receiver auth token (optional)` ->
// `receiver auth token`), substituting one (`&` -> `and`), or splitting a label
// into fragments that are never contiguous (`Default shell per host` ->
// `default shell` + `per host`). Each of those was verified to turn this red.
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

// --- Guard 3: the corpus claims EVERYTHING the source renders ---------------
// Guards 1 and 2 both run corpus -> source: they ask "does what I claim exist?"
// and "does what I claim resolve?". Neither can ask "did I claim everything?",
// because SHIPPED_LABELS is itself a hand-maintained mirror of `keywords` — a
// row missing from BOTH is invisible to both. That is exactly how
// `Match app theme (default)` shipped unfindable while its two sibling options
// from the same dropdown were present, and it is the drift direction that
// dominates from here (the next person ADDS a row; they rarely rename one).
//
// This guard runs the other way — source -> corpus — so it fails on a row that
// was never transcribed at all.

/** Files with no section id. Reset is always visible, outside activeSection gating. */
const UNSECTIONED_FILES = new Set(['ResetSection.tsx']);

// Text extracted from source that is deliberately NOT a searchable preference.
// Keeping this explicit (rather than just absent from the corpus) is the point:
// it makes "deliberately excluded" distinguishable from "forgotten".
const NOT_A_PREFERENCE = new Set([
  // PatternsSection's match-mode options are the bare words `text` and `regex`.
  // Both already resolve via the section's `text substring` / `regex` synonyms;
  // listed here only because the extractor cannot tell an option from a word.
]);

/**
 * Every user-visible row/option/field name rendered by a section file.
 *
 * Covers the three shapes a row's accessible name actually takes in these files:
 *   - <Label>/<SelectItem> children  (most rows and every dropdown option)
 *   - font-medium <span>/<div> group headings (Notifications channels, Observer model)
 *   - aria-label="…" on inputs with no visible label (Snippets, Patterns,
 *     custom font, presets) — a user searches for these by that name too.
 *
 * Only the LEADING plain-text run of an element is taken: children are cut at
 * the first nested tag or `{expression}`. That keeps a label from being
 * concatenated with its sub-hint <span> (`Attention` + `stuck / erroring / …`,
 * which would produce a string that renders nowhere), and it drops interpolated
 * runtime values (`{defaultNewChatPreset} (deleted)`, `{host} (no longer
 * available)`) — dynamic host/preset text, not preferences.
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
    const source = readFileSync(join(sectionsDir, file), 'utf8');
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
