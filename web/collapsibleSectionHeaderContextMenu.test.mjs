import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * STATIC SOURCE GUARD for the shared CollapsibleSectionHeader context menu
 * (WARDEN-1697, roadmap WARDEN-362). No front-end DOM runner exists, so these
 * pin properties of the SOURCE; "right-click opens the menu" is verified live.
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const text = fs.readFileSync(path.join(HERE, 'src', 'components', 'CollapsibleSectionHeader.tsx'), 'utf8');
const content = text.slice(text.indexOf('<ContextMenuContent>'), text.indexOf('</ContextMenuContent>'));

describe('CollapsibleSectionHeader declares a themed context menu (WARDEN-1697)', () => {
  it('imports the menu primitives from the themed kit and copyWithToast', () => {
    assert.match(text, /import \{ ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem \} from '@\/components\/ui\/context-menu';/);
    assert.match(text, /import \{ copyWithToast \} from '@\/lib\/clipboardToast';/);
  });

  it('has exactly one asChild ContextMenuTrigger wrapping the header', () => {
    assert.strictEqual(text.split('<ContextMenuTrigger asChild>').length - 1, 1);
    assert.match(text, /<ContextMenuTrigger asChild>\{header\}<\/ContextMenuTrigger>/);
  });

  it('binds Expand/Collapse to onToggle and Copy section name to label', () => {
    assert.match(content, /<ContextMenuItem onSelect=\{onToggle\}>\{open \? 'Collapse' : 'Expand'\}<\/ContextMenuItem>/);
    assert.match(content, /onSelect=\{\(\) => copyWithToast\(label\)\}>Copy section name/);
    assert.strictEqual(content.split('<ContextMenuItem').length - 1, 2);
  });

  it('keeps the action-less branch as the bare toggle (no extra wrapper)', () => {
    assert.match(text, /\) : \(\n\s+toggle\n\s+\);/);
    assert.match(text, /const header = actions \? \(/);
  });

  it('has no hand-rolled onContextMenu handler (WARDEN-926)', () => {
    assert.ok(!text.includes('onContextMenu'));
  });
});
