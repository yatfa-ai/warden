// WARDEN-1887 — the pure view decision behind the non-blocking update chip.
import { transformWithOxc } from 'vite';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import test from 'node:test';

const libDir = resolve(dirname(fileURLToPath(import.meta.url)), 'src/lib');
const p = join(libDir, 'updateBanner.ts');
const { code } = await transformWithOxc(readFileSync(p, 'utf8'), p, {});
const dir = mkdtempSync(join(tmpdir(), 'warden-updatebanner-'));
writeFileSync(join(dir, 'u.mjs'), code);
const { updateBannerView } = await import(join(dir, 'u.mjs'));
rmSync(dir, { recursive: true, force: true });

const s = (o) => ({ status: 'idle', currentVersion: '0.1.104', version: null, percent: null, silent: true, downloadUrl: null, error: null, lastCheckedAt: null, ...o });

test('shows nothing for idle / checking / up-to-date / disabled / error', () => {
  for (const status of ['idle', 'checking', 'up-to-date', 'disabled', 'error']) {
    assert.equal(updateBannerView(s({ status, error: status === 'error' ? 'x' : null })), null, status);
  }
  assert.equal(updateBannerView(null), null);
});

test('ready → "update ready — restart to apply" with a Restart action', () => {
  const v = updateBannerView(s({ status: 'ready', version: '0.1.105' }));
  assert.match(v.text, /ready — restart to apply/);
  assert.deepEqual([v.kind, v.action, v.actionLabel], ['ready', 'install', 'Restart']);
});

test('downloading shows progress and no action', () => {
  const v = updateBannerView(s({ status: 'downloading', version: '0.1.105', percent: 40 }));
  assert.match(v.text, /40%/);
  assert.equal(v.action, null);
});

test('available (unsigned macOS) offers Download only when a URL exists', () => {
  assert.equal(updateBannerView(s({ status: 'available', version: '0.1.105', downloadUrl: 'https://x' })).action, 'download');
  assert.equal(updateBannerView(s({ status: 'available', version: '0.1.105' })).action, null);
});
