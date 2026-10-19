// Tests for the pure edit-menu item derivation (src/lib/editMenu.ts, WARDEN-1830)
// + static source guards for the wrapper and its two call sites. No front-end DOM
// runner exists, so the guards pin properties of the SOURCE; right-click/paste/undo
// behaviour is verified live.
import { describe, it } from 'node:test';
import { transformWithOxc } from 'vite';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const file = resolve(__dirname, 'src/lib/editMenu.ts');
const { code } = await transformWithOxc(readFileSync(file, 'utf8'), file, {});
const tmpDir = mkdtempSync(join(tmpdir(), 'warden-editmenu-test-'));
const out = join(tmpDir, 'editMenu.mjs');
writeFileSync(out, code);
const { editMenuItems, selectedText } = await import(out);
rmSync(tmpDir, { recursive: true, force: true });

const ids = (items) => items.map((i) => (i.kind === 'separator' ? '---' : i.id));
const state = (items) => Object.fromEntries(items.filter((i) => i.kind === 'item').map((i) => [i.id, i.disabled]));

describe('editMenuItems (WARDEN-1830)', () => {
  it('order is Cut · Copy · Paste · separator · Select all', () => {
    assert.deepEqual(ids(editMenuItems({ hasSelection: true })), ['cut', 'copy', 'paste', '---', 'select-all']);
  });

  it('with a selection everything is enabled', () => {
    assert.deepEqual(state(editMenuItems({ hasSelection: true })), { cut: false, copy: false, paste: false, 'select-all': false });
  });

  it('no selection disables Cut and Copy only', () => {
    assert.deepEqual(state(editMenuItems({ hasSelection: false })), { cut: true, copy: true, paste: false, 'select-all': false });
  });

  it('readOnly disables Cut and Paste but leaves Copy / Select all', () => {
    assert.deepEqual(state(editMenuItems({ hasSelection: true, readOnly: true })), { cut: true, copy: false, paste: true, 'select-all': false });
  });

  it('a disabled field gets no menu at all', () => {
    assert.deepEqual(editMenuItems({ hasSelection: true, disabled: true }), []);
  });

  it('labels are the human strings', () => {
    const labels = editMenuItems({ hasSelection: true }).filter((i) => i.kind === 'item').map((i) => i.label);
    assert.deepEqual(labels, ['Cut', 'Copy', 'Paste', 'Select all']);
  });

  it('number mode keys Cut/Copy enablement on the value, not the (unreadable) selection (WARDEN-1864)', () => {
    // A value present behaves like a selection: everything enabled.
    assert.deepEqual(state(editMenuItems({ hasSelection: false, numberValue: '42' })), { cut: false, copy: false, paste: false, 'select-all': false });
    // An empty value disables Cut and Copy only — Paste and Select all stay.
    assert.deepEqual(state(editMenuItems({ hasSelection: false, numberValue: '' })), { cut: true, copy: true, paste: false, 'select-all': false });
    // readOnly still disables Cut and Paste as in text mode.
    assert.deepEqual(state(editMenuItems({ hasSelection: false, numberValue: '42', readOnly: true })), { cut: true, copy: false, paste: true, 'select-all': false });
    // disabled still returns no menu at all.
    assert.deepEqual(editMenuItems({ hasSelection: false, numberValue: '42', disabled: true }), []);
    // Omitting numberValue leaves the text-mount semantics byte-identical.
    assert.deepEqual(state(editMenuItems({ hasSelection: false })), { cut: true, copy: true, paste: false, 'select-all': false });
  });
});

describe('selectedText (WARDEN-1830)', () => {
  it('slices the selection, in either order, and tolerates null', () => {
    assert.equal(selectedText('hello world', 6, 11), 'world');
    assert.equal(selectedText('hello world', 11, 6), 'world');
    assert.equal(selectedText('hello', 2, 2), '');
    assert.equal(selectedText('hello', null, undefined), '');
  });
});

const read = (p) => readFileSync(resolve(__dirname, p), 'utf8');
const wrapper = read('src/components/ui/editable-context-menu.tsx');
const quick = read('src/components/QuickReply.tsx');
const observer = read('src/components/ObserverPanel.tsx');
const sidebar = read('src/components/ChatSidebar.tsx');
const globalSearch = read('src/components/GlobalSearchDialog.tsx');
const workspaceSearch = read('src/components/WorkspaceSearchDialog.tsx');
const transcript = read('src/components/SessionTranscriptViewer.tsx');
const paneGrid = read('src/components/PaneGrid.tsx');
const spawnControl = read('src/components/sidebar/SpawnControl.tsx');
const gitBadges = read('src/components/sidebar/GitBadges.tsx');
const createCollection = read('src/components/CreateCollectionDialog.tsx');
const settingsPage = read('src/components/SettingsPage.tsx');
const hostsSection = read('src/components/settings/sections/HostsSection.tsx');
const newChatsSection = read('src/components/settings/sections/NewChatsSection.tsx');
const notificationsSection = read('src/components/settings/sections/NotificationsSection.tsx');
const observerSection = read('src/components/settings/sections/ObserverSection.tsx');
const appearanceSection = read('src/components/settings/sections/AppearanceSection.tsx');
const performanceSection = read('src/components/settings/sections/PerformanceSection.tsx');
const telemetrySection = read('src/components/settings/sections/TelemetrySection.tsx');
const patternsSection = read('src/components/settings/sections/PatternsSection.tsx');
const snippetsSection = read('src/components/settings/sections/SnippetsSection.tsx');
const attentionThresholdsSection = read('src/components/settings/sections/AttentionThresholdsSection.tsx');
const tokenBudgetSection = read('src/components/settings/sections/TokenBudgetSection.tsx');
const workspaceTabs = read('src/components/WorkspaceTabs.tsx');
const observerTabs = read('src/components/ObserverTabs.tsx');
const collectionsSection = read('src/components/CollectionsSection.tsx');
const savedSessionRows = read('src/components/sidebar/SavedSessionRows.tsx');
const patternRow = read('src/components/settings/rows/PatternRow.tsx');
const snippetRow = read('src/components/settings/rows/SnippetRow.tsx');
const paneTile = read('src/components/PaneTile.tsx');

describe('EditableContextMenu source guards (WARDEN-1830)', () => {
  it('wrapper uses the themed primitive via ContextMenuTrigger asChild', () => {
    assert.match(wrapper, /from '@\/components\/ui\/context-menu'/);
    assert.match(wrapper, /<ContextMenuTrigger asChild/);
  });

  it('wrapper has no hand-rolled contextmenu handling (WARDEN-926)', () => {
    assert.ok(!/onContextMenu/.test(wrapper.replace(/\/\/.*$/gm, '')));
    assert.ok(!/preventDefault|stopPropagation/.test(wrapper.replace(/\/\/.*$/gm, '')));
  });

  it('paste uses insertText execCommand (onChange + undo) and cut copies then deletes', () => {
    assert.match(wrapper, /execCommand\('insertText', false, text\)/);
    assert.match(wrapper, /execCommand\('delete'\)/);
    assert.match(wrapper, /navigator\.clipboard\.readText\(\)/);
    assert.match(wrapper, /toast\.error/);
    assert.match(wrapper, /copyWithToast/);
  });

  it('QuickReply textarea is wrapped; key handling untouched', () => {
    assert.match(quick, /<EditableContextMenu>\s*<Textarea/);
    assert.match(quick, /e\.key === 'Enter' && \(e\.metaKey \|\| e\.ctrlKey\)/);
    assert.ok(!quick.includes('onContextMenu'));
  });

  it('Observer composer textarea is wrapped; bare-Enter submit untouched', () => {
    assert.match(observer, /<EditableContextMenu>\s*<Textarea\s+ref=\{taRef\}\s+data-observer-composer/);
    assert.match(observer, /e\.key === 'Enter' && !e\.shiftKey && !e\.nativeEvent\.isComposing/);
    assert.match(observer, /disabled=\{!conn\}/);
  });
});

describe('EditableContextMenu text-input support (WARDEN-1837)', () => {
  const code = wrapper.replace(/\/\/.*$/gm, '');
  it('wrapper accepts an <input> or <textarea> child and types the ref for both', () => {
    assert.match(code, /type EditableEl = HTMLInputElement \| HTMLTextAreaElement/);
    assert.match(code, /React\.ComponentProps<'input'>/);
    assert.match(code, /children: React\.ReactElement<EditableProps>/);
    assert.ok(!/HTMLTextAreaElement \| null/.test(code), 'ref must not be textarea-only');
  });

  it('wrapper still adds no wrapper DOM node and keeps ContextMenuTrigger asChild', () => {
    assert.match(code, /<ContextMenuTrigger asChild/);
    assert.ok(!/<div|<span/.test(code));
  });

  it('wrapper treats a null selectionStart/End as no selection', () => {
    assert.match(code, /el\.selectionStart \?\? 0/);
  });

  const sites = [
    ['ChatSidebar sidebar search', () => sidebar, /<EditableContextMenu>\s*<Input\s+value=\{searchQuery\}/],
    ['GlobalSearchDialog', () => globalSearch, /<EditableContextMenu>\s*<Input\s+ref=\{inputRef\}/],
    ['WorkspaceSearchDialog', () => workspaceSearch, /<EditableContextMenu>\s*<Input\s+ref=\{inputRef\}/],
    ['SessionTranscriptViewer find', () => transcript, /<EditableContextMenu>\s*<Input\s+autoFocus\s+aria-label="Find in transcript"/],
    ['PaneGrid Open-file path', () => paneGrid, /<EditableContextMenu>\s*<Input\s+ref=\{fileInputRef\}/],
    ['SpawnControl directory', () => spawnControl, /<EditableContextMenu>\s*<Input\s+value=\{cwd\}/],
    ['SpawnControl session name', () => spawnControl, /<EditableContextMenu>\s*<Input\s+value=\{name\}/],
    ['GitBadges commit-message search', () => gitBadges, /<EditableContextMenu>\s*<Input\s+type="text"\s+value=\{grepInput\}/],
    ['CreateCollectionDialog Name', () => createCollection, /<EditableContextMenu>\s*<Input\s+id="name"/],
    ['CreateCollectionDialog Description', () => createCollection, /<EditableContextMenu>\s*<Input\s+id="description"/],
    ['CreateCollectionDialog Role', () => createCollection, /<EditableContextMenu>\s*<Input\s+value=\{role\}/],
    ['CreateCollectionDialog Project', () => createCollection, /<EditableContextMenu>\s*<Input\s+value=\{project\}/],
    ['CreateCollectionDialog Host', () => createCollection, /<EditableContextMenu>\s*<Input\s+value=\{host\}/],
    ['CreateCollectionDialog Custom criteria', () => createCollection, /<EditableContextMenu>\s*<Input\s+value=\{custom\}/],
    ['CreateCollectionDialog hex colour text', () => createCollection, /<EditableContextMenu>\s*<Input\s+value=\{color\}/],
    // WARDEN-1851 — the Settings surfaces. For the per-host mapped inputs
    // (id={safeId}) the distinguishing attribute is the mapped `value=` prop.
    ['SettingsPage search settings', () => settingsPage, /<EditableContextMenu>\s*<Input\s+type="text"\s+value=\{search\}/],
    ['HostsSection add-host name', () => hostsSection, /<EditableContextMenu>\s*<Input\s+id="addHostName"/],
    ['HostsSection per-host label', () => hostsSection, /<EditableContextMenu>\s*<Input\s+id=\{safeId\}\s+value=\{hostLabels\[key\]/],
    ['HostsSection tmux session', () => hostsSection, /<EditableContextMenu>\s*<Input\s+id="tmuxSession"/],
    ['NewChatsSection default shell', () => newChatsSection, /<EditableContextMenu>\s*<Input\s+id="defaultShell"/],
    ['NewChatsSection per-host shell', () => newChatsSection, /<EditableContextMenu>\s*<Input\s+id=\{safeId\}\s+value=\{defaultShellByHost\[key\]/],
    ['NewChatsSection default cwd', () => newChatsSection, /<EditableContextMenu>\s*<Input\s+id="defaultNewChatCwd"/],
    ['NewChatsSection per-host cwd', () => newChatsSection, /<EditableContextMenu>\s*<Input\s+id=\{safeId\}\s+value=\{defaultNewChatCwdByHost\[key\]/],
    ['NotificationsSection webhook URL', () => notificationsSection, /<EditableContextMenu>\s*<Input\s+id="webhookUrl"/],
    ['ObserverSection model', () => observerSection, /<EditableContextMenu>\s*<Input\s+id="observerModel"/],
    ['ObserverSection base URL', () => observerSection, /<EditableContextMenu>\s*<Input\s+id="observerBaseUrl"/],
    ['AppearanceSection custom font family', () => appearanceSection, /<EditableContextMenu>\s*<Input\s+id="customTerminalFontFamily"/],
    ['PerformanceSection companion excluded hosts', () => performanceSection, /<EditableContextMenu>\s*<Input\s+id="companionExcludedHosts"/],
    ['TelemetrySection receiver endpoint', () => telemetrySection, /<EditableContextMenu>\s*<Input\s+id="telemetryEndpoint"/],
    ['PatternsSection new pattern name', () => patternsSection, /<EditableContextMenu>\s*<Input\s+value=\{newPatternName\}/],
    ['PatternsSection new pattern expression', () => patternsSection, /<EditableContextMenu>\s*<Input\s+value=\{newPatternExpression\}/],
    ['SnippetsSection new snippet name', () => snippetsSection, /<EditableContextMenu>\s*<Input\s+value=\{newSnippetName\}/],
    ['SnippetsSection new snippet text', () => snippetsSection, /<EditableContextMenu>\s*<Textarea\s+value=\{newSnippetText\}/],
    // WARDEN-1854 — the in-place rename/note fields (radix's innermost trigger
    // wins, so the field menu shadows the row menu on the field only). The
    // four conditional-mount fields pass the focus-retention prop; the two
    // unconditioned Settings rows do not (their menu-open blur commits the
    // draft — established semantics — and the field never unmounts).
    ['WorkspaceTabs workspace rename', () => workspaceTabs, /<EditableContextMenu contentProps=\{\{ onOpenAutoFocus: \(e\) => e\.preventDefault\(\) \}\} holdBlurWhileOpen>\s*<Input\s+ref=\{inputRef\}/],
    ['ObserverTabs session rename', () => observerTabs, /<EditableContextMenu contentProps=\{\{ onOpenAutoFocus: \(e\) => e\.preventDefault\(\) \}\} holdBlurWhileOpen>\s*<Input\s+ref=\{inputRef\}/],
    ['CollectionsSection collection rename', () => collectionsSection, /<EditableContextMenu contentProps=\{\{ onOpenAutoFocus: \(e\) => e\.preventDefault\(\) \}\} holdBlurWhileOpen>\s*<Input\s+autoFocus\s+value=\{val\}/],
    ['SavedSessionRows rename', () => savedSessionRows, /<EditableContextMenu contentProps=\{\{ onOpenAutoFocus: \(e\) => e\.preventDefault\(\) \}\} holdBlurWhileOpen>\s*<Input\s+autoFocus\s+value=\{val\}/],
    ['SavedSessionRows note', () => savedSessionRows, /<EditableContextMenu contentProps=\{\{ onOpenAutoFocus: \(e\) => e\.preventDefault\(\) \}\} holdBlurWhileOpen>\s*<Input\s+autoFocus\s+value=\{noteVal\}/],
    ['PatternRow name', () => patternRow, /<EditableContextMenu>\s*<Input\s+value=\{nameDraft\}/],
    ['PatternRow expression', () => patternRow, /<EditableContextMenu>\s*<Input\s+value=\{exprDraft\}/],
    ['SnippetRow name', () => snippetRow, /<EditableContextMenu>\s*<Input\s+value=\{nameDraft\}/],
    ['SnippetRow instruction text', () => snippetRow, /<EditableContextMenu>\s*<Textarea\s+value=\{textDraft\}/],
  ];
  for (const [name, src, re] of sites) {
    it(`${name} input is wrapped and imports the wrapper`, () => {
      assert.match(src(), re);
      assert.match(src(), /import \{ EditableContextMenu \} from '@\/components\/ui\/editable-context-menu'/);
      assert.ok(!src().includes('onContextMenu={'));
    });
  }

  it('search/open-file Enter handlers are untouched', () => {
    assert.match(globalSearch, /onKeyDown=\{\(e\) => \{ if \(e\.key === 'Enter' && !searching\) doSearch\(\); \}\}/);
    assert.match(workspaceSearch, /onKeyDown=\{\(e\) => \{ if \(e\.key === 'Enter' && !searching\) doSearch\(\); \}\}/);
    assert.match(paneGrid, /onKeyDown=\{\(e\) => \{ if \(e\.key === 'Enter'\) handleOpenFile\(\); \}\}/);
    assert.match(paneGrid, /onOpenAutoFocus=\{\(e\) => e\.preventDefault\(\)\}/);
  });

  it('transcript find keeps Enter / Shift+Enter / Escape handling', () => {
    assert.match(transcript, /if \(e\.key === 'Enter'\) \{\s*e\.preventDefault\(\);\s*stepMatch\(e\.shiftKey \? -1 : 1\);\s*\} else if \(e\.key === 'Escape'\) \{\s*e\.preventDefault\(\);\s*toggleSearch\(\);\s*\}/);
  });

  it('out-of-scope fields stay unwrapped (ui/input.tsx; PaneTile search bar wrapped in WARDEN-1862)', () => {
    assert.ok(!read('src/components/ui/input.tsx').includes('EditableContextMenu'));
  });

  it('CreateCollectionDialog wraps exactly seven fields and leaves the type="color" swatch unwrapped (WARDEN-1847)', () => {
    assert.strictEqual((createCollection.match(/<EditableContextMenu>/g) || []).length, 7);
    assert.match(createCollection, /<Input\s+id="color"\s+type="color"/);
    assert.ok(!/<EditableContextMenu>\s*<Input\s+id="color"/.test(createCollection));
  });

  it('GitBadges search keeps its stopPropagation handlers and the clear button (WARDEN-1847)', () => {
    assert.match(gitBadges, /onChange=\{\(e\) => setGrepInput\(e\.target\.value\)\}\s+onClick=\{\(e\) => e\.stopPropagation\(\)\}\s+onKeyDown=\{\(e\) => e\.stopPropagation\(\)\}\s+placeholder="search commit messages…"/);
    assert.match(gitBadges, /<\/EditableContextMenu>\s*\{\(searching \|\| searchLoading\) && \(\s*<Button/);
  });

  it('Settings surfaces wrap exactly the 18 WARDEN-1851 text fields plus the 6 WARDEN-1864 number fields in these 10 files (24 wraps)', () => {
    const files = [settingsPage, hostsSection, newChatsSection, notificationsSection, observerSection, appearanceSection, performanceSection, telemetrySection, patternsSection, snippetsSection];
    assert.strictEqual(files.reduce((n, f) => n + (f.match(/<EditableContextMenu>/g) || []).length, 0), 24);
    for (const f of files) {
      assert.match(f, /import \{ EditableContextMenu \} from '@\/components\/ui\/editable-context-menu'/);
      assert.ok(!f.includes('onContextMenu={'));
    }
  });

  it('Settings secret fields stay unwrapped; the number inputs are now wrapped via the number-safe branch (WARDEN-1864)', () => {
    // The password/secret exclusion stands (cut/copy of a secret is a hazard):
    assert.ok(!read('src/components/settings/rows/WriteOnlySecretField.tsx').includes('EditableContextMenu'));
    // ...and no wrapped child anywhere in the Settings sections is type=password:
    for (const f of [settingsPage, hostsSection, newChatsSection, notificationsSection, observerSection, appearanceSection, performanceSection, telemetrySection, patternsSection, snippetsSection, attentionThresholdsSection, tokenBudgetSection]) {
      assert.ok(!/<EditableContextMenu[^>]*>\s*<Input[^>]*type="password"/.test(f), 'a password input must never be EditableContextMenu-wrapped');
    }
  });

  it('rename/note fields keep focus while the edit menu is open; Settings rows do not (WARDEN-1854)', () => {
    // The conditional-mount rename fields commit on blur by UNMOUNTING, so the
    // menu-open focus steal must be prevented or the field unmounts under the
    // open menu and every item no-ops. Supplied at the site via contentProps —
    // the wrapper bans preventDefault literals (WARDEN-926 guard above).
    for (const f of [workspaceTabs, observerTabs, collectionsSection, savedSessionRows]) {
      assert.match(f, /contentProps=\{\{ onOpenAutoFocus: \(e\) => e\.preventDefault\(\) \}\}/);
    }
    assert.strictEqual((savedSessionRows.match(/onOpenAutoFocus: \(e\) => e\.preventDefault\(\)/g) || []).length, 2,
      'both SavedSessionRows fields (name + note) carry the focus-retention prop');
    for (const f of [workspaceTabs, observerTabs, collectionsSection]) {
      assert.strictEqual((f.match(/onOpenAutoFocus: \(e\) => e\.preventDefault\(\)/g) || []).length, 1,
        'exactly one focus-retention site in this file');
    }
    // The unconditioned Settings rows never unmount on commit: the menu-open
    // blur fires commitName/commitExpr/commitText (established semantics) and
    // the menu acts on the committed value — no focus-retention prop there.
    for (const f of [patternRow, snippetRow]) {
      assert.ok(!f.includes('onOpenAutoFocus'));
    }
  });

  it('wrapper forwards contentProps to ContextMenuContent and stays free of preventDefault literals (WARDEN-1854)', () => {
    assert.match(wrapper, /<ContextMenuContent \{\.\.\.contentProps\}>/);
    assert.match(wrapper, /contentProps\?: ContextMenuContentProps/);
    assert.ok(!/preventDefault|stopPropagation/.test(wrapper.replace(/\/\/.*$/gm, '')),
      'the focus-retention preventDefault must live at the site, never in the wrapper source');
  });

  it('opt-in holdBlurWhileOpen holds the child blur while the menu is open (WARDEN-1854 hover-focus steal)', () => {
    // Radix menu items focus themselves on hover; without the hold, that steal
    // blur-commits a conditional-mount rename field mid-interaction.
    assert.match(wrapper, /menuOpenRef\.current = open/);
    assert.match(wrapper, /if \(!menuOpenRef\.current\) childOnBlur\(e\)/);
    assert.match(wrapper, /holdBlurWhileOpen = false/);
    // The default is off: unconditional mounts pass their blur through verbatim.
    assert.match(wrapper, /: childOnBlur/);
  });

  it('PaneTile in-pane search input is wrapped, plainly (WARDEN-1862)', () => {
    // The last editable-field gap on the WARDEN-1853 census (deferred there,
    // enumerated by WARDEN-1859). Plain wrap — NO contentProps / holdBlurWhileOpen:
    // unlike the rename fields, this field has no onBlur commit and no
    // conditional mount-on-edit (searchQuery is plain controlled state, the
    // input stays mounted under the open menu), so the WARDEN-1854
    // focus-retention machinery is not needed at this site.
    assert.match(paneTile, /import \{ EditableContextMenu \} from '@\/components\/ui\/editable-context-menu'/);
    assert.match(paneTile, /<EditableContextMenu>\s*<input autoFocus value=\{searchQuery\}/);
    assert.ok(!paneTile.includes('contentProps'), 'no contentProps at this site');
    assert.ok(!paneTile.includes('holdBlurWhileOpen'), 'no holdBlurWhileOpen at this site');
    // The raw field is untouched apart from the wrap: Enter still runs the
    // next-match search, Escape still closes the bar (source guard — right-click
    // / paste behaviour is verified live in the web dev harness).
    assert.match(paneTile, /onKeyDown=\{\(e\) => \{ if \(e\.key === 'Enter'\) doSearch\('next'\); if \(e\.key === 'Escape'\) setShowSearch\(false\); \}\}/);
    assert.match(paneTile, /placeholder="search…"/);
  });
});

describe('EditableContextMenu number-input support (WARDEN-1864)', () => {
  // The wrapper's old contract fenced number inputs out ("selectionStart is
  // null there") — an engineering limit of the text path, not a product
  // verdict. The number branch runs whole-value semantics and never touches
  // the selection/ranged primitives a number input rejects.
  const numberBranchStart = wrapper.indexOf('function runNumberItems');
  const numberBranchEnd = wrapper.indexOf('\nexport', numberBranchStart);
  const numberBranch = wrapper.slice(numberBranchStart, numberBranchEnd).replace(/\/\/.*$/gm, '');

  it('wrapper detects a type="number" child and dispatches it to the number branch', () => {
    assert.ok(numberBranchStart !== -1, 'runNumberItems present');
    assert.match(wrapper, /function isNumberInput/);
    assert.match(wrapper.replace(/\/\/.*$/gm, ''), /el\.type === 'number'/);
    assert.match(wrapper, /if \(isNumberInput\(el\)\) \{\s*await runNumberItems\(id, el\);\s*return;\s*\}/);
  });

  it('number branch: no selection/ranged primitive reachable (both throw or read null on number inputs)', () => {
    assert.ok(numberBranch.length > 0, 'number branch slice is non-empty');
    assert.ok(!/setRangeText|selectionStart|selectionEnd/.test(numberBranch),
      'the number branch must not call setRangeText (throws InvalidStateError) or read selectionStart/End (null)');
  });

  it('number branch: copy/cut run on the whole value; paste is insertText-only; select-all selects', () => {
    assert.match(numberBranch, /copyWithToast\(el\.value\)/);
    assert.match(numberBranch, /el\.select\(\)/);
    assert.match(numberBranch, /execCommand\('delete'\)/);
    // Paste goes through execCommand('insertText') ONLY — no ranged fallback.
    assert.match(numberBranch, /execCommand\('insertText', false, text\)/);
    assert.match(numberBranch, /navigator\.clipboard\.readText\(\)/);
    assert.match(numberBranch, /toast\.error\('Paste failed — clipboard unavailable'\)/);
  });

  it('number items are enabled from the value sampled at menu open (WARDEN-1864)', () => {
    const code = wrapper.replace(/\/\/.*$/gm, '');
    assert.match(code, /numberValue: numberMode \? numberValue : undefined/);
    assert.match(code, /setNumberMode\(numeric\)/);
    assert.match(code, /setNumberValue\(numeric \? el\.value : ''\)/);
  });

  it('contract comment: password inputs stay excluded; number inputs use the number-safe branch', () => {
    assert.match(wrapper, /Password inputs \(secret\s*\n\/\/\s*safety\) are never wrapped; number inputs use the number-safe branch/);
  });

  const sites = [
    ['AppearanceSection font size', () => appearanceSection, /<EditableContextMenu>\s*<Input\s+id="terminalFontSize"/],
    ['AppearanceSection scrollback', () => appearanceSection, /<EditableContextMenu>\s*<Input\s+id="terminalScrollback"/],
    ['AttentionThresholdsSection warning threshold', () => attentionThresholdsSection, /<EditableContextMenu>\s*<Input\s+id="healthWarningThresholdMin"/],
    ['AttentionThresholdsSection critical threshold', () => attentionThresholdsSection, /<EditableContextMenu>\s*<Input\s+id="healthCriticalThresholdMin"/],
    ['HostsSection poll interval', () => hostsSection, /<EditableContextMenu>\s*<Input\s+id="pollIntervalMs"/],
    ['HostsSection connect timeout', () => hostsSection, /<EditableContextMenu>\s*<Input\s+id="connectTimeout"/],
    ['ObserverSection session timeout', () => observerSection, /<EditableContextMenu>\s*<Input\s+id="observerSessionTimeout"/],
    ['ObserverSection max output tokens', () => observerSection, /<EditableContextMenu>\s*<Input\s+id="observerMaxTokens"/],
    ['TokenBudgetSection fleet threshold', () => tokenBudgetSection, /<EditableContextMenu>\s*<Input\s+id="tokenBudgetThresholdTokens"/],
    ['TokenBudgetSection window hours', () => tokenBudgetSection, /<EditableContextMenu>\s*<Input\s+id="tokenBudgetWindowHours"/],
    ['TokenBudgetSection per-session threshold', () => tokenBudgetSection, /<EditableContextMenu>\s*<Input\s+id="tokenBudgetPerSessionThresholdTokens"/],
  ];
  for (const [name, src, re] of sites) {
    it(`${name} number input is wrapped and imports the wrapper`, () => {
      assert.match(src(), re);
      assert.match(src(), /import \{ EditableContextMenu \} from '@\/components\/ui\/editable-context-menu'/);
      assert.ok(!src().includes('onContextMenu={'));
    });
  }

  it('the 11 number fields are wrapped across the 5 Settings sections (17 wraps: 3+2+5+4+3)', () => {
    // 3 in AppearanceSection (1 text + 2 number), 2 in AttentionThresholds,
    // 5 in HostsSection (3 text + 2 number), 4 in ObserverSection (2 text + 2
    // number), 3 in TokenBudgetSection — of which exactly 11 are the number
    // mounts this ticket wraps (the per-site rows above pin each by id).
    const files = [appearanceSection, attentionThresholdsSection, hostsSection, observerSection, tokenBudgetSection];
    assert.strictEqual(files.reduce((n, f) => n + (f.match(/<EditableContextMenu>/g) || []).length, 0), 17);
    for (const f of files) {
      assert.match(f, /import \{ EditableContextMenu \} from '@\/components\/ui\/editable-context-menu'/);
      assert.ok(!f.includes('onContextMenu={'));
    }
  });

  it('handlers are untouched: the wrap adds no onChange/onKeyDown/onBlur and the onBlur clamps keep their file (WARDEN-1864)', () => {
    // Spot-pins of the clamp seams the ticket forbids touching — the suite
    // green unmodified is the fuller check (pollIntervalDraft.test.mjs pins
    // the draft bounds; connectTimeout keeps its enforced [1, 60] clamp).
    assert.match(hostsSection, /onChange=\{\(e\) => setPollDraft\(e\.target\.value\)\}/);
    assert.match(hostsSection, /const clamped = clampToBounds\(config\.connectTimeout, timeoutBounds\);/);
    assert.match(observerSection, /const clamped = clampToBounds\(v, sessionTimeoutBounds\);/);
  });
});
