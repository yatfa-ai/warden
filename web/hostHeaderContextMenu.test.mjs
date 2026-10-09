import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * STATIC SOURCE GUARD for the Fleet Health per-host header context menu
 * (WARDEN-1667, roadmap WARDEN-362). There is no front-end DOM runner in this
 * repo, so these tests pin properties of the SOURCE (trigger placement, item
 * labels, gating, destructive variant) — "right-click opens the menu" is
 * verified live, not here.
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const text = fs.readFileSync(path.join(HERE, 'src', 'components', 'HealthDashboard.tsx'), 'utf8');

// The host-group block: from the hostGroups.map to the agents-beneath marker.
const mapStart = text.indexOf('hostGroups.map(group');
assert.ok(mapStart !== -1, 'hostGroups.map not found');
const endMarker = text.indexOf('Agents beneath, reusing the standard row', mapStart);
assert.ok(endMarker !== -1, 'agents-beneath marker not found');
const block = text.slice(mapStart, endMarker);
const ctxStart = block.indexOf('<ContextMenu>');
const content = block.slice(block.indexOf('<ContextMenuContent>'), block.indexOf('</ContextMenuContent>'));

describe('Fleet Health host header declares a themed context menu (WARDEN-1667)', () => {
  it('imports ContextMenuSeparator from the house primitive', () => {
    assert.match(text, /import \{[^}]*ContextMenuSeparator[^}]*\} from '@\/components\/ui\/context-menu'/);
  });

  it('wraps the host header flex row in an asChild ContextMenuTrigger', () => {
    assert.ok(ctxStart !== -1, 'no <ContextMenu> in the host-group block');
    const trig = block.indexOf('<ContextMenuTrigger asChild>', ctxStart);
    assert.ok(trig !== -1, 'host header must use <ContextMenuTrigger asChild>');
    const child = block.slice(trig + '<ContextMenuTrigger asChild>'.length).trimStart();
    assert.ok(
      child.startsWith('<div className="flex items-start gap-1 w-full min-w-0">'),
      'the trigger child must be the header flex row',
    );
    // The collapse Button and trash button live INSIDE the trigger.
    const trigEnd = block.indexOf('</ContextMenuTrigger>', trig);
    const inside = block.slice(trig, trigEnd);
    assert.match(inside, /<Checkbox/);
    assert.match(inside, /aria-expanded=\{!collapsed\}/);
    assert.match(inside, /<Trash2 \/>/);
    // The agent rows are NOT inside the trigger.
    assert.ok(!inside.includes('renderAgent'), 'agent rows must stay outside the host-header trigger');
  });

  it('has Expand/Collapse, Copy host name and Copy SSH address items with the right payloads', () => {
    assert.match(content, /collapsed \? 'Expand' : 'Collapse'/);
    assert.match(content, /setCollapsedHosts\(\{ \.\.\.collapsedHosts, \[group\.host\]: !collapsedHosts\[group\.host\] \}\)/);
    assert.match(content, /copyWithToast\(group\.host\)[\s\S]*Copy host name/);
    assert.match(content, /copyWithToast\(`ssh \$\{group\.host\}`\)/);
    assert.match(content, /Copy SSH address/);
  });

  it('omits Copy SSH address for THIS_MACHINE', () => {
    assert.match(
      content,
      /group\.host !== THIS_MACHINE && \(\s*<ContextMenuItem onSelect=\{\(\) => copyWithToast\(`ssh/,
    );
  });

  it('gates Remove companion… on the same condition as the trash button and uses variant="destructive"', () => {
    const gate = 'companionTransportEnabled && group.host !== THIS_MACHINE';
    assert.ok(content.includes(gate), 'menu item must use the trash-button gate');
    assert.ok(block.indexOf(gate) < ctxStart + block.length && block.split(gate).length - 1 === 2,
      'gate must appear for both the trash button and the menu item');
    assert.match(content, /<ContextMenuItem variant="destructive" onSelect=\{\(\) => setRemoveCompanionHost\(group\.host\)\}>\s*Remove companion…/);
  });

  it('never deletes directly — routes through the existing ConfirmDialog state', () => {
    assert.ok(!/removeCompanion\(/.test(content), 'menu must not call a delete directly');
    assert.match(text, /removeCompanionHost/);
    assert.match(text, /<ConfirmDialog/);
  });

  it('has no hand-rolled onContextMenu handler on the header (WARDEN-926)', () => {
    assert.ok(!block.includes('onContextMenu'));
  });

  it('keeps the key on the existing group wrapper', () => {
    assert.match(block, /<div key=\{group\.host\} className="flex flex-col gap-1 min-w-0">/);
  });
});
