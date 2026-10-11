import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * STATIC SOURCE GUARD for the Fleet Health title-row + summary-bar context menu
 * (WARDEN-1739, roadmap WARDEN-362). No front-end DOM runner exists, so these pin
 * properties of the SOURCE; "right-click opens the menu" is verified live.
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const text = fs.readFileSync(path.join(HERE, 'src', 'components', 'HealthDashboard.tsx'), 'utf8');

const menuStart = text.indexOf('const fleetChromeMenu = (');
assert.ok(menuStart !== -1, 'fleetChromeMenu not found');
const menuEnd = text.indexOf('</ContextMenuContent>', menuStart);
const menu = text.slice(menuStart, menuEnd);

const headerStart = text.indexOf('{/* Header */}');
const summaryStart = text.indexOf('{/* Summary Bar */}');
const errorStart = text.indexOf('{/* Error State */}');
assert.ok(headerStart !== -1 && summaryStart > headerStart && errorStart > summaryStart);
const headerBlock = text.slice(headerStart, summaryStart);
const summaryBlock = text.slice(summaryStart, errorStart);

describe('Fleet Health chrome context menu (WARDEN-1739)', () => {
  it('imports the themed primitive and adds no onContextMenu handler', () => {
    assert.match(text, /from '@\/components\/ui\/context-menu'/);
    assert.ok(!text.includes('onContextMenu'));
  });

  it('wraps the header div in an asChild trigger with the shared menu', () => {
    assert.strictEqual(headerBlock.split('<ContextMenuTrigger asChild>').length - 1, 1);
    const child = headerBlock.slice(headerBlock.indexOf('<ContextMenuTrigger asChild>') + '<ContextMenuTrigger asChild>'.length).trimStart();
    assert.ok(child.startsWith('<div className="flex items-center gap-2 px-3 py-2 border-b shrink-0">'));
    assert.ok(headerBlock.includes('Fleet Health'));
    assert.ok(headerBlock.indexOf('Fleet Health') > headerBlock.indexOf('<ContextMenuTrigger asChild>'));
    assert.match(headerBlock, /<\/ContextMenuTrigger>\s*\{fleetChromeMenu\}\s*<\/ContextMenu>/);
  });

  it('wraps the summary-bar div in an asChild trigger with the same shared menu', () => {
    assert.strictEqual(summaryBlock.split('<ContextMenuTrigger asChild>').length - 1, 1);
    const child = summaryBlock.slice(summaryBlock.indexOf('<ContextMenuTrigger asChild>') + '<ContextMenuTrigger asChild>'.length).trimStart();
    assert.ok(child.startsWith('<div className="px-3 py-2 border-b bg-muted/30">'));
    assert.match(summaryBlock, /<\/ContextMenuTrigger>\s*\{fleetChromeMenu\}\s*<\/ContextMenu>/);
  });

  it('Refresh uses the same handler/disabled gate as the header ↻', () => {
    assert.match(menu, /disabled=\{loading \|\| fleetGit\.loading\}/);
    assert.match(menu, /onSelect=\{\(\) => \{ void fetchHealth\(\); fleetGit\.refresh\(\); \}\}/);
    assert.match(menu, />\s*Refresh\s*</);
  });

  it('offers Group by only for modes other than the current groupBy', () => {
    assert.match(menu, /groupBy !== 'host' && <ContextMenuItem onSelect=\{\(\) => setGroupBy\('host'\)\}>Group by Host/);
    assert.match(menu, /groupBy !== 'project' && <ContextMenuItem onSelect=\{\(\) => setGroupBy\('project'\)\}>Group by Project/);
    assert.match(menu, /groupBy !== 'health' && <ContextMenuItem onSelect=\{\(\) => setGroupBy\('health'\)\}>Group by Health/);
  });

  it('Copy fleet summary goes through copyWithToast + the pure helper, disabled without healthData', () => {
    assert.match(menu, /disabled=\{!healthData\}/);
    assert.match(menu, /copyWithToast\(formatFleetSummaryText\(/);
    assert.match(menu, /axes: FLEET_GIT_AXES/);
    assert.match(menu, />\s*Copy fleet summary\s*</);
  });

  it('ends with a separator then Close panel bound to onClose', () => {
    assert.match(menu, /<ContextMenuSeparator \/>\s*<ContextMenuItem onSelect=\{onClose\}>Close panel<\/ContextMenuItem>/);
  });
});
