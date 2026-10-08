import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * STATIC SOURCE GUARD for the RecentlyClosedFlyout row right-click menu (WARDEN-1643).
 * No front-end DOM runner exists, so these tests pin properties of the SOURCE only
 * (trigger shape, which props the items call, copy plumbing); that right-click
 * opens the themed menu is verified live, not here.
 */
const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), 'src', 'components', 'sidebar', 'RecentlyClosedFlyout.tsx');
const text = fs.readFileSync(SRC, 'utf8');
const code = text.replace(/\{?\/\*[\s\S]*?\*\/\}?/g, '').replace(/^\s*\/\/.*$/gm, '');

const trigger = code.slice(code.indexOf('<ContextMenuTrigger'), code.indexOf('</ContextMenuTrigger>'));
const content = code.slice(code.indexOf('<ContextMenuContent'), code.indexOf('</ContextMenuContent>'));

describe('RecentlyClosedFlyout rows declare a themed context menu (WARDEN-1643)', () => {
  it('wraps each row div in ContextMenu keyed by entry.id with an asChild trigger', () => {
    assert.match(code, /<ContextMenu key=\{entry\.id\}>/);
    assert.match(code, /<ContextMenuTrigger asChild>/);
    assert.match(trigger, /className="group mx-0\.5 block/, 'the trigger must wrap the row div');
    assert.doesNotMatch(trigger, /key=\{entry\.id\}/, 'key lives on the ContextMenu root');
    assert.match(text, /from '@\/components\/ui\/context-menu'/);
  });

  it('keeps the left-click reopen/save buttons wired to the same props', () => {
    assert.match(trigger, /onClick=\{\(\) => onReopen\(entry\.id\)\}/);
    assert.match(trigger, /onClick=\{\(\) => onSave\(entry\.id\)\}/);
  });

  it('Reopen and Save items call the onReopen/onSave props (not a re-implementation)', () => {
    assert.match(content, /onSelect=\{\(\) => onReopen\(entry\.id\)\}>Reopen</);
    assert.match(content, /onSelect=\{\(\) => onSave\(entry\.id\)\}>Save</);
    assert.ok(content.indexOf('>Reopen<') < content.indexOf('>Save<') && content.indexOf('>Save<') < content.indexOf('<ContextMenuSeparator'));
  });

  it('copies the raw name, cwd and host through copyWithToast, cwd/host only when non-empty', () => {
    assert.match(content, /onSelect=\{\(\) => copyWithToast\(entry\.name \|\| entry\.id\)\}>Copy session name</);
    assert.match(content, /\{entry\.cwd && <ContextMenuItem onSelect=\{\(\) => copyWithToast\(entry\.cwd\)\}>Copy working directory</);
    assert.match(content, /\{entry\.host && <ContextMenuItem onSelect=\{\(\) => copyWithToast\(entry\.host\)\}>Copy host</);
    assert.doesNotMatch(code, /navigator\.clipboard/);
    assert.doesNotMatch(content, /onClick=/, 'menu items use onSelect');
  });

  it('adds no Delete/dismiss item and no stopPropagation/preventDefault/onContextMenu on the trigger', () => {
    assert.doesNotMatch(content, /Delete|Dismiss|Remove/);
    assert.doesNotMatch(trigger, /stopPropagation|preventDefault|onContextMenu/);
  });

  it('Escape handler ignores an Escape the Radix menu already handled (defaultPrevented)', () => {
    assert.match(code, /e\.key === 'Escape' && !e\.defaultPrevented/);
  });
});
