import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * STATIC SOURCE GUARD for the AttentionView chrome context menu (WARDEN-1762,
 * roadmap WARDEN-362). No front-end DOM runner exists, so these pin properties
 * of the SOURCE; "right-click opens the menu" is verified live.
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const text = fs.readFileSync(path.join(HERE, 'src', 'components', 'AttentionView.tsx'), 'utf8');
const content = text.slice(text.indexOf('<ContextMenuContent>'), text.indexOf('</ContextMenuContent>'));
const triggerBody = text.slice(text.indexOf('<ContextMenuTrigger asChild>'), text.indexOf('</ContextMenuTrigger>'));

describe('AttentionView declares a themed chrome context menu (WARDEN-1762)', () => {
  it('has exactly one asChild trigger wrapping header + filter row, not the rundown/empty state', () => {
    assert.strictEqual(text.split('<ContextMenuTrigger asChild>').length - 1, 1);
    assert.ok(triggerBody.includes('{summaryText}'));
    assert.ok(triggerBody.includes('showFilters &&'));
    assert.ok(!triggerBody.includes('<AttentionList'));
    assert.ok(!triggerBody.includes('<EmptyState'));
    assert.ok(text.indexOf('</ContextMenu>') < text.indexOf('<AttentionList\n'));
  });

  it('binds Clear filters to clearFilters, disabled on all/all, gated on showFilters', () => {
    assert.match(content, /disabled=\{!filtersActive\} onSelect=\{\(\) => clearFilters\(\)\}/);
    assert.match(text, /const filtersActive = hostFilter !== 'all' \|\| agentFilter !== 'all';/);
    assert.match(content, /\{showFilters && \(\s*<>\s*<ContextMenuItem disabled=\{!filtersActive\}/);
  });

  it('shares summaryText between the header span and Copy summary line', () => {
    assert.match(text, /<span className="text-sm font-semibold">\{summaryText\}<\/span>/);
    assert.match(content, /copyWithToast\(summaryText\)/);
  });

  it('copies host/agent filter labels, gated on showFilters', () => {
    assert.match(content, /copyWithToast\(hostFilter === 'all' \? 'All Hosts' : hostFilter\)/);
    assert.match(content, /copyWithToast\(agentFilter === 'all' \? 'All Agents' : agentFilter\)/);
    const idx = content.indexOf('Copy host filter');
    assert.ok(content.lastIndexOf('showFilters &&', idx) > content.indexOf('Copy summary line'));
  });

  it('has no hand-rolled onContextMenu handler (WARDEN-926)', () => {
    assert.ok(!text.includes('onContextMenu='));
  });
});
