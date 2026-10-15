// Tests for the pure SelectionActionBar context-menu item derivation
// (src/lib/selectionBarMenu.ts, WARDEN-1826). Loads the REAL module via the
// transpile-to-temp-`.mjs` harness (no module mocking; the module has no imports).
import { describe, it } from 'node:test';
import { transformWithOxc } from 'vite';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const file = resolve(__dirname, 'src/lib/selectionBarMenu.ts');
const { code } = await transformWithOxc(readFileSync(file, 'utf8'), file, {});
const tmpDir = mkdtempSync(join(tmpdir(), 'warden-selbarmenu-test-'));
const out = join(tmpDir, 'selectionBarMenu.mjs');
writeFileSync(out, code);
const { selectionBarMenuItems } = await import(out);
rmSync(tmpDir, { recursive: true, force: true });

const ids = (items) => items.map((i) => (i.kind === 'separator' ? '---' : i.id));
const base = { count: 3, hasInterrupt: false, hasWatch: false, names: [] };

describe('selectionBarMenuItems (WARDEN-1826)', () => {
  it('minimal bar (no interrupt/watch/names): Select all, Clear, separator, Kill', () => {
    assert.deepEqual(ids(selectionBarMenuItems(base)), ['select-all', 'clear', '---', 'kill']);
  });

  it('HealthDashboard shape (interrupt, no watch, names): no Watch item, full order', () => {
    const items = selectionBarMenuItems({ ...base, hasInterrupt: true, names: ['a', 'b'] });
    assert.deepEqual(ids(items), ['select-all', 'clear', 'interrupt', 'copy-names', '---', 'kill']);
    assert.ok(!ids(items).includes('watch'), 'Watch must not render without onWatch');
  });

  it('Watch appears only with hasWatch, labelled by watchMode', () => {
    const w = selectionBarMenuItems({ ...base, hasWatch: true, watchMode: 'watch' }).find((i) => i.id === 'watch');
    assert.equal(w.label, 'Watch 3');
    const u = selectionBarMenuItems({ ...base, hasWatch: true, watchMode: 'unwatch' }).find((i) => i.id === 'watch');
    assert.equal(u.label, 'Unwatch 3');
    assert.ok(!ids(selectionBarMenuItems({ ...base, watchMode: 'watch' })).includes('watch'));
  });

  it('Interrupt label carries the count and ellipsis; only with hasInterrupt', () => {
    const i = selectionBarMenuItems({ ...base, hasInterrupt: true }).find((x) => x.id === 'interrupt');
    assert.equal(i.label, 'Interrupt 3…');
    assert.ok(!ids(selectionBarMenuItems(base)).includes('interrupt'));
  });

  it('Copy selected agent names hidden when names absent, empty, or all blank', () => {
    assert.ok(!ids(selectionBarMenuItems({ ...base, names: undefined })).includes('copy-names'));
    assert.ok(!ids(selectionBarMenuItems({ ...base, names: [] })).includes('copy-names'));
    assert.ok(!ids(selectionBarMenuItems({ ...base, names: ['', ''] })).includes('copy-names'));
    assert.ok(ids(selectionBarMenuItems({ ...base, names: ['x'] })).includes('copy-names'));
  });

  it('Kill is always LAST, destructive, preceded by a separator; nothing else is destructive', () => {
    for (const hasInterrupt of [false, true]) for (const hasWatch of [false, true]) for (const names of [[], ['a']]) {
      const items = selectionBarMenuItems({ count: 2, hasInterrupt, hasWatch, watchMode: 'watch', names });
      const last = items[items.length - 1];
      assert.equal(last.id, 'kill');
      assert.equal(last.destructive, true);
      assert.equal(last.label, 'Kill 2…');
      assert.equal(items[items.length - 2].kind, 'separator');
      assert.equal(items.filter((i) => i.destructive).length, 1);
    }
  });
});
