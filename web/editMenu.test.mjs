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

  it('out-of-scope fields stay unwrapped (PaneTile search bar, ui/input.tsx)', () => {
    assert.ok(!read('src/components/PaneTile.tsx').includes('EditableContextMenu'));
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
});
