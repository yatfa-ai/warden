import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * STATIC SOURCE GUARD for the Fleet Health Project-mode group header context
 * menu (WARDEN-1673, roadmap WARDEN-362). No front-end DOM runner exists, so
 * these pin properties of the SOURCE; "right-click opens the menu" is verified
 * live, not here.
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const text = fs.readFileSync(path.join(HERE, 'src', 'components', 'HealthDashboard.tsx'), 'utf8');

const mapStart = text.indexOf('projectGroups.map(group');
assert.ok(mapStart !== -1, 'projectGroups.map not found');
const endMarker = text.indexOf('Agents beneath, reusing the standard row', mapStart);
assert.ok(endMarker !== -1, 'agents-beneath marker not found');
const block = text.slice(mapStart, endMarker);
const ctxStart = block.indexOf('<ContextMenu>');
const content = block.slice(block.indexOf('<ContextMenuContent>'), block.indexOf('</ContextMenuContent>'));

describe('Fleet Health project header declares a themed context menu (WARDEN-1673)', () => {
  it('wraps the whole three-line header in one asChild ContextMenuTrigger', () => {
    assert.ok(ctxStart !== -1, 'no <ContextMenu> in the project-group block');
    const trig = block.indexOf('<ContextMenuTrigger asChild>', ctxStart);
    assert.ok(trig !== -1, 'project header must use <ContextMenuTrigger asChild>');
    const child = block.slice(trig + '<ContextMenuTrigger asChild>'.length).trimStart();
    assert.ok(child.startsWith('<div className="flex flex-col gap-1 min-w-0">'), 'trigger child must be the header column');
    const inside = block.slice(trig, block.indexOf('</ContextMenuTrigger>', trig));
    assert.match(inside, /<Checkbox/);
    assert.match(inside, /summarizeProjectHosts/);
    assert.match(inside, /<CompanionIndicator/);
    assert.match(inside, /health distribution|dist\.map/);
    assert.ok(!inside.includes('renderAgent'), 'agent rows must stay outside the header trigger');
  });

  it('keeps renderAgent after the menu so rows keep their own menu', () => {
    const after = text.slice(endMarker, endMarker + 400);
    assert.match(after, /renderAgent\(agent, false\)/);
  });

  it('has Select/Deselect all gated like the checkbox', () => {
    assert.match(content, /disabled=\{projectIds\.length === 0\}/);
    assert.match(content, /onSelect=\{\(\) => toggleGroup\(projectIds\)\}/);
    assert.match(content, /isSelectedAll\(selectedIds, projectIds\) \? 'Deselect all' : 'Select all'/);
  });

  it('has Copy project name and Copy agent names with the right payloads', () => {
    assert.match(content, /copyWithToast\(group\.project\)\}>Copy project name/);
    assert.match(content, /copyWithToast\(group\.agents\.map\(agent => agent\.name \|\| agent\.key \|\| agent\.id\)\.join\('\\n'\)\)/);
    assert.match(content, /Copy agent names/);
    assert.match(content, /<ContextMenuSeparator \/>/);
  });

  it('does not add collapse or Remove companion (host header only)', () => {
    assert.ok(!content.includes('Remove companion'));
    assert.ok(!content.includes('Collapse'));
  });

  it('has no hand-rolled onContextMenu handler (WARDEN-926)', () => {
    assert.ok(!block.includes('onContextMenu'));
  });

  it('keeps the key on the existing group wrapper', () => {
    assert.match(block, /<div key=\{group\.project\} className="flex flex-col gap-1 min-w-0">/);
  });
});
