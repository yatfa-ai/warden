import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * STATIC SOURCE GUARDS for the Settings → Telemetry status banners and the
 * Test-connection verdict panel right-click menus (WARDEN-1818). No front-end DOM
 * runner exists, so these assert properties of the SOURCE:
 *
 *  1. Themed primitives + copyWithToast are imported.
 *  2. `<ContextMenuTrigger asChild>` directly wraps each banner root / the verdict
 *     panel (no wrapper element), and no onContextMenu / preventDefault /
 *     stopPropagation is added (WARDEN-926 trap).
 *  3. Item wiring: banners copy the rendered text + host-only destination (omitted
 *     on the unconfigured banner); the verdict panel copies label+message and host,
 *     and "Test again" routes to sendTestConnection under the button's predicate.
 *  4. The auth token / raw endpoint never reach a copy payload.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (...p) => fs.readFileSync(path.join(here, 'src', 'components', 'settings', ...p), 'utf8');
const banners = read('rows', 'TelemetryStatus.tsx');
const section = read('sections', 'TelemetrySection.tsx');

describe('telemetry status banners declare a themed context menu (WARDEN-1818)', () => {
  it('imports the themed primitives and copyWithToast', () => {
    for (const src of [banners, section]) {
      assert.match(src, /import \{[^}]*ContextMenu,[^}]*ContextMenuContent[^}]*ContextMenuItem[^}]*ContextMenuSeparator[^}]*ContextMenuTrigger[^}]*\} from '@\/components\/ui\/context-menu'/s);
      assert.match(src, /import \{ copyWithToast \} from '@\/lib\/clipboardToast'/);
    }
  });

  it('wraps all five banner root divs, each trigger asChild directly on the div', () => {
    assert.equal((banners.match(/^\s+role="status"$/gm) ?? []).length, 5);
    assert.equal((banners.match(/<ContextMenu>/g) ?? []).length, 5);
    const triggers = banners.match(/<ContextMenuTrigger asChild>\s*<div\s+ref=\{ref\}\s+role="status"/g) ?? [];
    assert.equal(triggers.length, 5, 'every trigger child is the role="status" div itself');
    assert.equal((banners.match(/<\/div>\s*<\/ContextMenuTrigger>/g) ?? []).length, 5);
  });

  it('adds none of the WARDEN-926 trap handlers', () => {
    for (const src of [banners, section]) {
      assert.doesNotMatch(src, /onContextMenu|preventDefault|stopPropagation/);
    }
  });

  it('banner menu copies the visible text and the host-only destination', () => {
    assert.match(banners, /textContent \?\? ''\)\.replace\(\/\\s\+\/g, ' '\)\.trim\(\)/);
    assert.match(banners, /onSelect=\{\(\) => copyWithToast\(message\(\)\)\}>Copy status message</);
    assert.match(banners, /\{destination && \(\s*<ContextMenuItem onSelect=\{\(\) => copyWithToast\(destination\)\}>Copy receiver host</);
  });

  it('wires destination per banner: omitted on unconfigured, destination elsewhere', () => {
    const uses = [...banners.matchAll(/<BannerMenuContent message=\{message\}( destination=\{([^}]+)\})? \/>/g)].map((m) => m[2] ?? null);
    assert.deepEqual(uses, [null, 'status.destination', 'status.destination', 'destination', 'destination']);
  });

  it('never copies the endpoint URL or auth token', () => {
    for (const src of [banners, section]) {
      assert.doesNotMatch(src, /copyWithToast\([^)]*(telemetryEndpoint|AuthToken|authToken)/);
    }
  });
});

describe('Test-connection verdict panel declares a themed context menu (WARDEN-1818)', () => {
  it('asChild trigger directly wraps the verdict div', () => {
    assert.match(section, /<ContextMenuTrigger asChild>\s*<div\s+className=\{[^]*?data-telemetry-test-verdict=\{telemetryTestVerdict\.kind\}[^]*?<\/div>\s*<\/ContextMenuTrigger>/);
    assert.equal((section.match(/<ContextMenu>/g) ?? []).length, 1);
  });

  it('copy items carry label+message and the host-only label', () => {
    assert.match(section, /const verdictText = `\$\{label\}\\n\$\{telemetryTestVerdict\.message\}`;/);
    assert.match(section, /const receiverHost = telemetryDestinationLabel\(config\.telemetryEndpoint\);/);
    assert.match(section, /copyWithToast\(verdictText\)\}>Copy test result</);
    assert.match(section, /\{receiverHost && \(\s*<ContextMenuItem onSelect=\{\(\) => copyWithToast\(receiverHost\)\}>Copy receiver host</);
  });

  it('Test again routes to sendTestConnection under the same predicate as the button', () => {
    assert.match(section, /<ContextMenuItem disabled=\{testDisabled\} onSelect=\{sendTestConnection\}>Test again</);
    const pred = 'telemetryTestLoading || !config.telemetryEndpoint.trim()';
    assert.ok(section.includes(`const testDisabled = ${pred};`));
    assert.ok(section.includes(`disabled={${pred}}`), 'visible button keeps the same predicate');
  });
});
