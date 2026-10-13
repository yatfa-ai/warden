import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * STATIC SOURCE GUARD for the Fleet matrix GRIDCELL context menu (WARDEN-1780).
 * No front-end DOM runner exists in this repo, so "right-click opens the themed
 * menu" is verified live, not here. These tests pin properties of the SOURCE:
 * both panels wrap their gridcell in the shared FleetMatrixCellMenu (whose
 * trigger is `asChild`, so role/aria-label/title/className survive), Open is
 * gated on onOpenChat && chat with the catalog-identical payload, copies go
 * through copyWithToast, and the copied summary IS the tooltip string.
 * The rowheader trigger guard lives in fleetMatrixContextMenu.test.mjs and is
 * untouched.
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const C = (f) => fs.readFileSync(path.join(HERE, 'src', 'components', f), 'utf8');
const matrix = C('FleetMatrixPanel.tsx');
const heatmap = C('FleetActivityHeatmap.tsx');
const timeline = C('FleetStateTimeline.tsx');
const dash = C('HealthDashboard.tsx');

/** The first FleetMatrixCellMenu element's body in a panel, or null. */
function cellMenuBody(src) {
  const m = src.match(/<FleetMatrixCellMenu\b[^>]*>([\s\S]*?)<\/FleetMatrixCellMenu>/);
  return m ? m[1] : null;
}

/** Every property the panel's wrapped gridcell must still carry. */
function assertPanelWrapsCell(name, src, ariaVar) {
  const body = cellMenuBody(src);
  assert.ok(body, `${name}: gridcell must be wrapped in <FleetMatrixCellMenu>`);
  assert.match(body.trimStart(), /^<div\b/, `${name}: the wrapper's immediate child is the gridcell div`);
  assert.match(body, /role="gridcell"/, `${name}: role`);
  assert.ok(body.includes(`aria-label={${ariaVar}}`), `${name}: aria-label`);
  assert.match(body, /title=\{summary\}/, `${name}: title is the shared summary`);
  assert.match(body, /MATRIX_CELL_SIZE/, `${name}: MATRIX_CELL_SIZE`);
  assert.match(src, /const summary = `\$\{agentName\} · \$\{bucketTime\}: \$\{/, `${name}: summary built once from the tooltip shape`);
  // The role="gridcell" must not exist outside the wrapper.
  assert.strictEqual((src.match(/role="gridcell"/g) || []).length, 1, `${name}: exactly one gridcell`);
}

describe('Fleet matrix cell context menu (static source guard)', () => {
  it('both panels wrap their gridcell in FleetMatrixCellMenu and keep its contract', () => {
    assertPanelWrapsCell('heatmap', heatmap, 'cellAria');
    assertPanelWrapsCell('timeline', timeline, 'label');
  });

  it('the shared helper uses an asChild trigger and sits OUTSIDE FleetMatrixPanel', () => {
    const helperStart = matrix.indexOf('export function FleetMatrixCellMenu');
    const scaffoldStart = matrix.indexOf('export function FleetMatrixPanel');
    assert.ok(helperStart > -1 && scaffoldStart > -1);
    assert.ok(helperStart < scaffoldStart, 'helper defined before (outside) the scaffold function');
    const helper = matrix.slice(helperStart, scaffoldStart);
    assert.match(helper, /<ContextMenuTrigger asChild>\{children\}<\/ContextMenuTrigger>/);
    assert.doesNotMatch(helper, /stopPropagation|preventDefault/);
  });

  it('Open agent is first, gated on onOpenChat && chat, with the catalog payload', () => {
    const helper = matrix.slice(matrix.indexOf('export function FleetMatrixCellMenu'), matrix.indexOf('export function FleetMatrixPanel'));
    assert.match(helper, /onOpenChat && chat && \(\s*<ContextMenuItem onSelect=\{\(\) => onOpenChat\(chat\.key \|\| chat\.id\)\}>Open agent</);
    assert.ok(helper.indexOf('Open agent') < helper.indexOf('Copy cell summary'));
    assert.ok(helper.indexOf('Copy cell summary') < helper.indexOf('Copy hour'));
  });

  it('copy items go through copyWithToast with the summary and the absolute hour', () => {
    const helper = matrix.slice(matrix.indexOf('export function FleetMatrixCellMenu'), matrix.indexOf('export function FleetMatrixPanel'));
    assert.match(helper, /copyWithToast\(summary\)\}>Copy cell summary/);
    assert.match(helper, /copyWithToast\(formatTimestamp\(bucket, 'absolute'\)\)\}>Copy hour/);
    assert.doesNotMatch(helper, /navigator\.clipboard/);
  });

  it('the scaffold passes its own chat + onOpenChat into renderCell (not re-derived in panels)', () => {
    assert.match(matrix, /renderCell\(\{ cell, index: i, agentName: name, bucket: buckets\[i\], chat, onOpenChat \}\)/);
    assert.match(matrix, /chat\?: Chat;/);
    assert.doesNotMatch(heatmap + timeline, /chatByContainer/);
  });

  it('HealthDashboard still threads onOpenChat to both panels', () => {
    assert.match(dash, /<FleetActivityHeatmap[^>]*onOpenChat=/);
    assert.match(dash, /<FleetStateTimeline[^>]*onOpenChat=/);
  });

  it('negative control: the guard goes red when the wrapper is removed from either panel', () => {
    const strip = (src) => src
      .replace(/<FleetMatrixCellMenu\b[^>]*>/, '')
      .replace('</FleetMatrixCellMenu>', '');
    assert.throws(() => assertPanelWrapsCell('heatmap', strip(heatmap), 'cellAria'));
    assert.throws(() => assertPanelWrapsCell('timeline', strip(timeline), 'label'));
  });
});
