import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * STATIC SOURCE GUARDS for the SnippetRow / PresetRow right-click menus
 * (WARDEN-1359) and the duplicateSnippet / duplicatePreset handlers that back
 * their Duplicate items.
 *
 * WHY SOURCE GUARDS AND NOT BEHAVIOR TESTS: this repo has no front-end DOM test
 * runner (see commitRowContextMenu.test.mjs — the same guard pattern shipped for
 * the sibling CommitRow menu), so "right-click opens the themed menu" cannot be
 * asserted here; that acceptance criterion is verified live in the running app.
 * Every test below is named for what it actually checks: a property of the SOURCE.
 *
 * What a source scan CAN see, and what a unit test could not:
 *
 *  1. THE MENU SHAPE THE SIBLING ESTABLISHED. PatternRow (WARDEN-898) is the
 *     in-directory precedent: same outer row div cloned by an `asChild` trigger,
 *     Copy items first, Duplicate, a separator, then destructive Delete. A wrap
 *     that dropped `asChild` would insert a wrapper element between the section's
 *     `key`ed row and its inputs; one that added `preventDefault`/`stopPropagation`
 *     would re-create the WARDEN-926 trap the menu is meant to retire.
 *
 *  2. THAT COPIES GO THROUGH copyWithToast. Bare `navigator.clipboard` fails
 *     SILENTLY in Electron — no throw, no toast, nothing to assert on at runtime.
 *
 *  3. THAT DUPLICATE IS GUARDED LIKE ITS SIBLINGS. The WARDEN-1247 lesson: the
 *     loader keeps the FIRST fifty snippets, so a duplicate appended past the cap
 *     is silently discarded on reload unless the write site refuses first — the
 *     guard must run BEFORE the append, exactly as addSnippet's does (pinned in
 *     storage.test.mjs).
 *
 *  4. THAT DELETE STAYS CONFIRM-GUARDED (WARDEN-942). The menu's Delete must
 *     call the same `onDelete` prop the visible Trash button uses — the section
 *     wires that to `setPendingDelete`, so the ConfirmDialog stays between the
 *     click and the storage write. A direct `filter` from the menu would bypass
 *     the only undo-free safety net a hand-written instruction body has.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (...p) => fs.readFileSync(path.join(here, ...p), 'utf8');

const snippetRow = read('src', 'components', 'settings', 'rows', 'SnippetRow.tsx');
const presetRow = read('src', 'components', 'settings', 'rows', 'PresetRow.tsx');
const snippetsSection = read('src', 'components', 'settings', 'sections', 'SnippetsSection.tsx');
const newChatsSection = read('src', 'components', 'settings', 'sections', 'NewChatsSection.tsx');
const patternRow = read('src', 'components', 'settings', 'rows', 'PatternRow.tsx');

/** The inner text of the first `<Tag ...>` … `</Tag>` pair inside `src`. */
function element(src, tag) {
  const open = src.indexOf(`<${tag}`);
  assert.ok(open !== -1, `<${tag}> not found`);
  const bodyStart = src.indexOf('>', open) + 1;
  const close = src.indexOf(`</${tag}>`, bodyStart);
  assert.ok(close !== -1, `</${tag}> not found`);
  return src.slice(bodyStart, close);
}

/** The `onSelect` payload declared for the menu item labelled `label`. */
function payloadFor(content, label) {
  const m = content.match(new RegExp(`onSelect=\\{\\(\\) => ([^}]+)\\}>${label}<`));
  assert.ok(m, `no menu item labelled "${label}" with an onSelect handler`);
  return m[1].trim();
}

for (const [name, src, copySecondLabel, secondValue] of [
  ['SnippetRow', snippetRow, 'Copy instruction text', 'snippet.text'],
  ['PresetRow', presetRow, 'Copy command', 'preset.cmd'],
]) {
  describe(`${name} declares a themed context menu (WARDEN-1359)`, () => {
    it('wraps the row in a radix ContextMenu with an asChild trigger (PatternRow shape)', () => {
      assert.match(src, /<ContextMenu>/, `${name} declares no <ContextMenu>`);
      assert.match(src, /<ContextMenuTrigger asChild>/, 'the trigger must use asChild so no wrapper element is added');
      assert.match(src, /import \{[^}]*ContextMenuTrigger[^}]*\} from '@\/components\/ui\/context-menu'/);
      // The trigger's cloned child is the row's own outer div — the single root
      // the section keys on — not a new wrapper element.
      const trigger = element(src, 'ContextMenuTrigger');
      assert.match(trigger, /className="flex flex-col gap-1 rounded-md border bg-muted\/30 p-2"/,
        'the trigger must wrap the row div itself (asChild clones onto it)');
    });

    it('adds none of the WARDEN-926 trap handlers (no preventDefault / stopPropagation)', () => {
      assert.doesNotMatch(src, /onContextMenu/,
        'no onContextMenu override — the radix trigger owns the event');
      // The trap is about the TRIGGER ELEMENT's own props swallowing the
      // contextmenu event — assert on the opening tag, not the subtree (an
      // editable field nested inside legitimately preventDefaults its own
      // ⌘/Ctrl+Enter commit; that is unrelated to the menu).
      const open = src.indexOf('<ContextMenuTrigger');
      const triggerTag = src.slice(open, src.indexOf('>', open) + 1);
      assert.doesNotMatch(triggerTag, /preventDefault/, 'preventDefault on the trigger kills the menu entirely');
      assert.doesNotMatch(triggerTag, /stopPropagation/, 'stopPropagation on the trigger is the other half of the trap');
    });

    it(`offers Copy name, ${copySecondLabel}, Duplicate, then destructive Delete — in that order`, () => {
      const content = element(src, 'ContextMenuContent');
      const order = ['Copy name', copySecondLabel, 'Duplicate', 'Delete'];
      const positions = order.map((label) => content.indexOf(`>${label}<`));
      positions.forEach((p, i) => assert.ok(p !== -1, `menu item "${order[i]}" is missing`));
      const sorted = [...positions].sort((a, b) => a - b);
      assert.deepEqual(positions, sorted, 'menu items are out of the sibling PatternRow order');
      assert.match(content, /<ContextMenuSeparator \/>/, 'Delete sits below a separator, as in PatternRow');
      assert.match(content, /<ContextMenuItem variant="destructive"[\s\S]{0,140}>Delete<\/ContextMenuItem>/,
        'Delete is the destructive variant');
    });

    it('copy items route through copyWithToast with the row\'s RAW committed values', () => {
      assert.match(src, /import \{ copyWithToast \} from '@\/lib\/clipboardToast'/);
      const content = element(src, 'ContextMenuContent');
      assert.equal(payloadFor(content, 'Copy name'), `copyWithToast(${name === 'SnippetRow' ? 'snippet' : 'preset'}.name)`);
      assert.equal(payloadFor(content, copySecondLabel), `copyWithToast(${secondValue})`);
    });

    it('Duplicate calls the onDuplicate prop with the row\'s name (the section owns the handler)', () => {
      const content = element(src, 'ContextMenuContent');
      assert.equal(payloadFor(content, 'Duplicate'), `onDuplicate(${name === 'SnippetRow' ? 'snippet' : 'preset'}.name)`);
    });

    it('menu Delete calls the SAME onDelete prop as the visible Trash button (WARDEN-942 confirm path)', () => {
      const content = element(src, 'ContextMenuContent');
      assert.equal(payloadFor(content, 'Delete'), `onDelete(${name === 'SnippetRow' ? 'snippet' : 'preset'}.name)`);
      // …and the row declares onDelete as a plain prop, never a direct storage call.
      assert.doesNotMatch(src, /setSnippets|setCustomPresets/,
        'the row must never touch storage directly — sections own the writes');
    });

    it('keeps commit-on-blur intact inside the trigger (both editable fields re-sync drafts)', () => {
      assert.match(src, /onBlur=\{commitName\}/);
      assert.match(src, name === 'SnippetRow' ? /onBlur=\{commitText\}/ : /onBlur=\{commitCmd\}/);
    });
  });
}

describe('SnippetsSection wires the menu actions (WARDEN-1359)', () => {
  it('passes onDuplicate={duplicateSnippet} alongside the unchanged confirm-guarded onDelete', () => {
    const rowUsage = snippetsSection.slice(snippetsSection.indexOf('<SnippetRow'));
    assert.match(rowUsage, /onDuplicate=\{duplicateSnippet\}/);
    assert.match(rowUsage, /onDelete=\{\(name\) => setPendingDelete\(name\)\}/,
      'Delete must still route through the WARDEN-942 ConfirmDialog state');
  });

  it('duplicateSnippet refuses at the SNIPPET_MAX_COUNT cap BEFORE appending, with addSnippet\'s exact toast', () => {
    const fnStart = snippetsSection.indexOf('const duplicateSnippet = (name: string) =>');
    assert.notEqual(fnStart, -1, 'duplicateSnippet is findable in the section source');
    const appendIdx = snippetsSection.indexOf('setSnippets([...snippets', fnStart);
    assert.notEqual(appendIdx, -1, 'the append call is findable');
    const guardIdx = snippetsSection.indexOf('snippets.length >= SNIPPET_MAX_COUNT', fnStart);
    assert.ok(guardIdx !== -1 && guardIdx > fnStart && guardIdx < appendIdx,
      'the cap guard must run BEFORE the append — the loader keeps the FIRST fifty (WARDEN-1247)');
    assert.match(
      snippetsSection.slice(guardIdx, appendIdx),
      /toast\.error\(`You can have at most \$\{SNIPPET_MAX_COUNT\} instruction snippets\.`\);/,
      'the refusal reuses addSnippet\'s toast wording, as duplicatePattern reuses addPattern\'s');
  });

  it('duplicateSnippet synthesizes a non-colliding suffixed copy, truncated to SNIPPET_NAME_MAX', () => {
    const fn = snippetsSection.slice(
      snippetsSection.indexOf('const duplicateSnippet = (name: string) =>'),
      snippetsSection.indexOf('const deleteSnippet'),
    );
    assert.match(fn, /const suffix = n === 1 \? ' \(copy\)' : ` \(copy \$\{n\}\)`;/,
      'the duplicatePattern suffix scheme: "Name (copy)" then "Name (copy 2)" …');
    assert.match(fn, /src\.name\.slice\(0, SNIPPET_NAME_MAX - suffix\.length\)/,
      'truncation so a name already at the cap does not overflow once suffixed');
    assert.match(fn, /validateSnippetName\(copyName, snippets\) === 'duplicate'/,
      'the loop terminates on a free slot only (empty/too-long are unreachable)');
    assert.match(fn, /text: src\.text/, 'the copy carries the source instruction body');
  });
});

describe('NewChatsSection wires the menu actions (WARDEN-1359)', () => {
  it('passes onDuplicate={duplicatePreset} alongside the unchanged confirm-guarded onDelete', () => {
    const rowUsage = newChatsSection.slice(newChatsSection.indexOf('<PresetRow'));
    assert.match(rowUsage, /onDuplicate=\{duplicatePreset\}/);
    assert.match(rowUsage, /onDelete=\{\(name\) => setPendingDelete\(name\)\}/,
      'Delete must still route through the WARDEN-942 ConfirmDialog state');
  });

  it('duplicatePreset synthesizes a non-colliding suffixed copy, truncated to PRESET_NAME_MAX', () => {
    const fn = newChatsSection.slice(
      newChatsSection.indexOf('const duplicatePreset = (name: string) =>'),
      newChatsSection.indexOf('const deletePreset'),
    );
    assert.match(fn, /const suffix = n === 1 \? ' \(copy\)' : ` \(copy \$\{n\}\)`;/,
      'the duplicatePattern suffix scheme: "Name (copy)" then "Name (copy 2)" …');
    assert.match(fn, /src\.name\.slice\(0, PRESET_NAME_MAX - suffix\.length\)/,
      'truncation so a name already at the cap does not overflow once suffixed');
    assert.match(fn, /validatePresetName\(copyName, customPresets\) === 'duplicate'/,
      'the loop terminates on a free slot only (empty/reserved are unreachable for a suffixed name)');
    assert.match(fn, /cmd: src\.cmd/, 'the copy carries the source command');
  });
});

describe('the PatternRow precedent is untouched (WARDEN-898 menu stays byte-identical)', () => {
  it('still declares its original menu — no shared rewrite leaked into the sibling', () => {
    assert.match(patternRow, /<ContextMenuTrigger asChild>/);
    const content = element(patternRow, 'ContextMenuContent');
    assert.equal(payloadFor(content, 'Copy name'), 'copyWithToast(pattern.name)');
    assert.equal(payloadFor(content, 'Copy expression'), 'copyWithToast(pattern.expression)');
    assert.equal(payloadFor(content, 'Duplicate'), 'onDuplicate(pattern.id)');
    assert.equal(payloadFor(content, 'Delete'), 'onDelete(pattern.id)');
  });
});
