import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * STATIC SOURCE GUARD for the SnippetRow and PresetRow right-click menus
 * (WARDEN-1359) — the slice that gives the last two named-entity Settings rows
 * the themed menu their sibling PatternRow has shipped since WARDEN-898.
 *
 * WHY A SOURCE GUARD AND NOT A BEHAVIOR TEST: this repo has no front-end DOM
 * test runner (see the note at the top of commitRowContextMenu.test.mjs), so
 * "right-click opens the themed menu" cannot be asserted here — that acceptance
 * criterion is verified live in the running app and is NOT what these tests
 * claim. Every test below is named for what it actually checks: a property of
 * the SOURCE.
 *
 * What a source scan CAN see, and what these tests therefore pin:
 *
 *  1. WHICH ELEMENT THE TRIGGER WRAPS. The whole row — the single root
 *     `<div className="flex flex-col gap-1 rounded-md border bg-muted/30 p-2">` —
 *     must sit INSIDE `<ContextMenuTrigger asChild>`…`</ContextMenuTrigger>`, so
 *     right-clicking anywhere on the row (name field, body field, chrome) opens
 *     the row menu. `asChild` adds no DOM element of its own.
 *
 *  2. THAT THE TRIGGER DOES NOT INTERCEPT THE EVENT. WARDEN-926's trap: a
 *     `preventDefault()` on the context-menu event kills the themed menu, and a
 *     `stopPropagation` or `onContextMenu` on the trigger breaks the row contract.
 *     This app registers NO `context-menu` IPC handler, so Electron pops no
 *     default menu either — the menu must be allowed to open, full stop.
 *
 *  3. THAT COPIES GO THROUGH copyWithToast WITH THE RAW STORED VALUES. Bare
 *     `navigator.clipboard` fails SILENTLY in Electron — no throw, no toast.
 *     Drafts must NOT be the payload: an abandoned edit would copy text the
 *     row never saved.
 *
 *  4. THAT THE MENU'S DELETE REUSES THE onDelete PROP. The rows hold no list
 *     access (no setSnippets/setCustomPresets) — the destructive item must call
 *     the same prop the trash button calls, so the WARDEN-942 ConfirmDialog
 *     stays the only delete path and the menu cannot route around it.
 *
 *  5. THE SECTION WIRING that makes Duplicate real: onDuplicate passed from
 *     SnippetsSection / NewChatsSection, the shared nonCollidingCopyName loop
 *     in use, and (where a count cap exists) the cap guard carrying the same
 *     toast wording the section's add handler uses.
 *
 * It deliberately pins structure and payloads, not cosmetics: class strings,
 * the surrounding comments, and item ordering beyond the PatternRow shape
 * (copies first, separator before the destructive Delete) are free to change.
 */

const ROWS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'src', 'components', 'settings');

function readSrc(rel) {
  return fs.readFileSync(path.join(ROWS_DIR, rel), 'utf8');
}

/** Minimal structural asserts shared by both rows. */
function assertRowMenuContract(text, { label, copyItemLabels, valueA, valueB, noPreventDefault }) {
  // (1) Whole row is the trigger, asChild, wrapping the single-root div.
  const triggerAt = text.indexOf('<ContextMenuTrigger asChild>');
  assert.ok(triggerAt !== -1, `${label}: <ContextMenuTrigger asChild> missing`);
  const rootAt = text.indexOf('<div className="flex flex-col gap-1 rounded-md border bg-muted/30 p-2">', triggerAt);
  assert.ok(rootAt !== -1 && rootAt - triggerAt < 80, `${label}: the row's root div is not immediately inside the trigger`);
  const triggerCloseAt = text.indexOf('</ContextMenuTrigger>', rootAt);
  const contentAt = text.indexOf('<ContextMenuContent>', triggerCloseAt);
  assert.ok(triggerCloseAt !== -1 && contentAt !== -1, `${label}: trigger does not close before the menu content`);

  // The row's root div must CLOSE before the trigger closes (whole row inside).
  const rootCloseAt = text.indexOf('</div>', rootAt);
  assert.ok(rootCloseAt !== -1 && rootCloseAt < triggerCloseAt, `${label}: the row root div must close inside the trigger`);

  // (2) No interception on the trigger (WARDEN-926 trap).
  assert.ok(!text.includes('onContextMenu'), `${label}: must not declare onContextMenu (radix owns the event)`);
  assert.ok(!text.includes('stopPropagation'), `${label}: must not stopPropagation (asChild merges handlers; interception breaks the menu)`);
  if (noPreventDefault) {
    assert.ok(!text.includes('preventDefault'), `${label}: preventDefault must not appear anywhere (it kills the menu)`);
  }

  // (3) Copies route through copyWithToast with the RAW STORED values.
  const content = text.slice(contentAt, text.indexOf('</ContextMenuContent>', contentAt));
  for (const item of copyItemLabels) {
    assert.ok(content.includes(`>${item}<`), `${label}: menu item "${item}" missing`);
  }
  const copyCalls = [...content.matchAll(/onSelect=\{\(\) => copyWithToast\(([^)]+)\)\}/g)].map((m) => m[1]);
  assert.ok(copyCalls.length >= 2, `${label}: expected both Copy items via copyWithToast, found ${copyCalls.length}`);
  for (const payload of [valueA, valueB]) {
    assert.ok(copyCalls.includes(payload), `${label}: copyWithToast must be called with the raw stored value ${payload}, found [${copyCalls.join(', ')}]`);
  }
  assert.ok(!text.includes('navigator.clipboard'), `${label}: bare navigator.clipboard fails silently in Electron — copyWithToast only`);

  // (4) Duplicate and Delete call the row's props — never a direct list write.
  assert.ok(content.includes('onSelect={() => onDuplicate('), `${label}: Duplicate must call the onDuplicate prop`);
  const destructive = content.slice(content.indexOf('ContextMenuSeparator'));
  assert.ok(destructive.includes('variant="destructive"'), `${label}: Delete must be the destructive variant`);
  const deleteSelect = destructive.match(/onSelect=\{\(\) => (onDelete\([^)]*\))\}/);
  assert.ok(deleteSelect, `${label}: destructive Delete must call the onDelete prop verbatim`);
  assert.ok(!text.includes('setSnippets') && !text.includes('setCustomPresets'), `${label}: the row must hold no direct list access — delete/copy state belongs to the section`);
}

describe('SnippetRow right-click menu (WARDEN-1359) — source guard', () => {
  const text = readSrc(path.join('rows', 'SnippetRow.tsx'));

  it('declares the onDuplicate prop alongside the existing contract', () => {
    assert.ok(text.includes('onDuplicate: (name: string) => void'), 'SnippetRow must take onDuplicate(name)');
  });

  it('wraps the whole row in an asChild trigger that does not intercept the event', () => {
    assertRowMenuContract(text, {
      label: 'SnippetRow',
      copyItemLabels: ['Copy name', 'Copy instruction text'],
      valueA: 'snippet.name',
      valueB: 'snippet.text',
      noPreventDefault: false, // the Textarea's ⌘/Ctrl+Enter commit may preventDefault on KEYDOWN
    });
  });

  it('keeps preventDefault confined to the ⌘/Ctrl+Enter commit — never on the menu path', () => {
    const occurrences = [...text.matchAll(/preventDefault/g)].map((m) => text.lastIndexOf('\n', m.index) + 1);
    assert.ok(occurrences.length === 1, `SnippetRow must contain exactly one preventDefault (the ⌘Enter keydown), found ${occurrences.length}`);
    const line = text.slice(occurrences[0], text.indexOf('\n', occurrences[0]));
    assert.ok(line.includes('Enter') && (line.includes('metaKey') || line.includes('ctrlKey')), `the one preventDefault must be the ⌘/Ctrl+Enter commit line, got: ${line.trim()}`);
  });

  it('the Delete menu item reuses the same onDelete prop the trash button uses', () => {
    const uses = [...text.matchAll(/onDelete\(snippet\.name\)/g)].length;
    assert.ok(uses === 2, `onDelete(snippet.name) must be called exactly twice (trash button + menu item), found ${uses}`);
  });
});

describe('PresetRow right-click menu (WARDEN-1359) — source guard', () => {
  const text = readSrc(path.join('rows', 'PresetRow.tsx'));

  it('declares the onDuplicate prop alongside the existing contract', () => {
    assert.ok(text.includes('onDuplicate: (name: string) => void'), 'PresetRow must take onDuplicate(name)');
  });

  it('wraps the whole row in an asChild trigger that does not intercept the event', () => {
    assertRowMenuContract(text, {
      label: 'PresetRow',
      copyItemLabels: ['Copy name', 'Copy command'],
      valueA: 'preset.name',
      valueB: 'preset.cmd',
      noPreventDefault: true,
    });
  });

  it('the Delete menu item reuses the same onDelete prop the trash button uses', () => {
    const uses = [...text.matchAll(/onDelete\(preset\.name\)/g)].length;
    assert.ok(uses === 2, `onDelete(preset.name) must be called exactly twice (trash button + menu item), found ${uses}`);
  });
});

describe('Section wiring for the new Duplicate affordance (WARDEN-1359) — source guard', () => {
  it('SnippetsSection passes onDuplicate, loops through the shared helper, and guards the 50-count cap with the add-handler wording', () => {
    const text = readSrc(path.join('sections', 'SnippetsSection.tsx'));
    assert.ok(text.includes('<SnippetRow'), 'SnippetRow must still be rendered here');
    assert.ok(/<SnippetRow[\s\S]*?onDuplicate=\{duplicateSnippet\}/.test(text), 'SnippetRow must receive onDuplicate={duplicateSnippet}');
    assert.ok(text.includes('nonCollidingCopyName'), 'duplicateSnippet must synthesize its name via the shared lib/copyName helper');
    assert.ok(/snippets\.length >= SNIPPET_MAX_COUNT[\s\S]{0,200}toast\.error\(`You can have at most \$\{SNIPPET_MAX_COUNT\} instruction snippets\.`\)/.test(text),
      'duplicateSnippet must refuse at SNIPPET_MAX_COUNT with the same toast wording addSnippet uses');
    assert.ok(text.includes("{ name: copyName, text: src.text }"), 'the copy must carry the source snippet\'s instruction text');
    // Delete path untouched: the row's onDelete still feeds the WARDEN-942 dialog.
    assert.ok(text.includes('onDelete={(name) => setPendingDelete(name)}'), 'onDelete must still route into pendingDelete (ConfirmDialog), menu or trash alike');
    assert.ok(text.includes('<ConfirmDialog'), 'the WARDEN-942 ConfirmDialog must remain the delete gate');
  });

  it('NewChatsSection passes onDuplicate, loops through the shared helper, and the copy does not touch the default', () => {
    const text = readSrc(path.join('sections', 'NewChatsSection.tsx'));
    assert.ok(text.includes('<PresetRow'), 'PresetRow must still be rendered here');
    assert.ok(/<PresetRow[\s\S]*?onDuplicate=\{duplicatePreset\}/.test(text), 'PresetRow must receive onDuplicate={duplicatePreset}');
    assert.ok(text.includes('nonCollidingCopyName'), 'duplicatePreset must synthesize its name via the shared lib/copyName helper');
    assert.ok(text.includes("{ name: copyName, cmd: src.cmd }"), 'the copy must carry the source preset\'s command');
    // A duplicated preset must NOT become the default: duplicatePreset's body
    // touches only setCustomPresets — no setDefaultNewChatPreset write.
    const fn = text.slice(text.indexOf('const duplicatePreset'), text.indexOf('const setHostCwd'));
    assert.ok(fn.includes('setCustomPresets'), 'duplicatePreset must append via setCustomPresets');
    assert.ok(!fn.includes('setDefaultNewChatPreset'), 'duplicating a preset must never move the default agent type');
    // Delete path untouched.
    assert.ok(text.includes('onDelete={(name) => setPendingDelete(name)}'), 'onDelete must still route into pendingDelete (ConfirmDialog), menu or trash alike');
    assert.ok(text.includes('<ConfirmDialog'), 'the WARDEN-942 ConfirmDialog must remain the delete gate');
  });

  it('PatternsSection now synthesizes its duplicate name through the same shared helper (one canonical loop)', () => {
    const text = readSrc(path.join('sections', 'PatternsSection.tsx'));
    assert.ok(text.includes('nonCollidingCopyName'), 'duplicatePattern should use the shared lib/copyName loop');
    assert.ok(!text.includes('const makeName'), 'the hand-copied makeName loop must be gone from PatternsSection');
  });
});
