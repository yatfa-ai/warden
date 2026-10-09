import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * STATIC SOURCE GUARD for the Fleet Health Health-mode section header context
 * menu (WARDEN-1679, roadmap WARDEN-362). No front-end DOM runner exists, so
 * these pin properties of the SOURCE; "right-click opens the menu" is verified
 * live, not here.
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const text = fs.readFileSync(path.join(HERE, 'src', 'components', 'HealthDashboard.tsx'), 'utf8');

const branchStart = text.indexOf("groupBy === 'health' ? (");
assert.ok(branchStart !== -1, "groupBy === 'health' ? ( not found");
const mapStart = text.indexOf('HEALTH_SECTION_ORDER.filter(section', branchStart);
assert.ok(mapStart !== -1, 'health-mode section map not found');
const endMarker = text.indexOf('Agent List', mapStart);
assert.ok(endMarker !== -1, 'Agent List marker not found');
const block = text.slice(mapStart, endMarker);
const ctxStart = block.indexOf('<ContextMenu>');
const content = block.slice(block.indexOf('<ContextMenuContent>'), block.indexOf('</ContextMenuContent>'));

describe('Fleet Health section header declares a themed context menu (WARDEN-1679)', () => {
  it('wraps the section header in one asChild ContextMenuTrigger', () => {
    assert.ok(ctxStart !== -1, 'no <ContextMenu> in the health-section block');
    assert.strictEqual(block.split('<ContextMenuTrigger asChild>').length - 1, 1);
    const trig = block.indexOf('<ContextMenuTrigger asChild>', ctxStart);
    const child = block.slice(trig + '<ContextMenuTrigger asChild>'.length).trimStart();
    assert.ok(child.startsWith('<div className={`flex items-center gap-1.5 px-2 py-1 text-[10px] uppercase'), 'trigger child must be the header div');
    const inside = block.slice(trig, block.indexOf('</ContextMenuTrigger>', trig));
    assert.match(inside, /<Checkbox/);
    assert.ok(!inside.includes('renderAgent'), 'agent rows must stay outside the header trigger');
  });

  it('keeps renderAgent after the menu so rows keep their own menu', () => {
    const after = text.slice(endMarker, endMarker + 400);
    assert.match(after, /renderAgent\(agent, true\)/);
    assert.ok(!block.includes('renderAgent'));
  });

  it('has Select/Deselect all gated and targeted like the checkbox', () => {
    assert.match(content, /disabled=\{sectionIds\.length === 0\}/);
    assert.match(content, /onSelect=\{\(\) => toggleGroup\(sectionIds\)\}/);
    assert.match(content, /isSelectedAll\(selectedIds, sectionIds\) \? 'Deselect all' : 'Select all'/);
  });

  it('has Copy section name and Copy agent names (rendered `shown` only)', () => {
    assert.match(content, /copyWithToast\(sectionInfo\.title\)\}>Copy section name/);
    assert.match(content, /copyWithToast\(shown\.map\(agent => agent\.name \|\| agent\.key \|\| agent\.id\)\.join\('\\n'\)\)/);
    assert.match(content, /Copy agent names/);
    assert.match(content, /<ContextMenuSeparator \/>/);
  });

  it('adds no Collapse, Expand or Remove companion items', () => {
    assert.ok(!content.includes('Remove companion'));
    assert.ok(!content.includes('Collapse'));
    assert.ok(!content.includes('Expand'));
  });

  it('has no hand-rolled onContextMenu handler (WARDEN-926)', () => {
    assert.ok(!block.includes('onContextMenu'));
  });

  it('keeps the key on the existing section wrapper', () => {
    assert.match(block, /<div key=\{section\} className="flex flex-col gap-1">/);
  });
});
