import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * STATIC SOURCE GUARDS for the Settings → Hosts "Configured Hosts" chip
 * right-click menu (WARDEN-1655). Same rationale as rowContextMenu.test.mjs:
 * there is no front-end DOM runner, so these name what they check — a property
 * of the SOURCE:
 *
 *  1. The trigger is `asChild` on the chip div (no wrapper in the flex-wrap row)
 *     and adds no preventDefault/stopPropagation (the WARDEN-926 trap).
 *  2. Copy items go through copyWithToast with the RAW host alias.
 *  3. "Remove host…" routes through setPendingRemoval (the WARDEN-928
 *     ConfirmDialog) and never calls removeHost / setConfig itself.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(
  path.join(here, 'src', 'components', 'settings', 'sections', 'HostsSection.tsx'),
  'utf8',
);

function element(s, tag) {
  const open = s.indexOf(`<${tag}`);
  assert.ok(open !== -1, `<${tag}> not found`);
  const bodyStart = s.indexOf('>', open) + 1;
  const close = s.indexOf(`</${tag}>`, bodyStart);
  assert.ok(close !== -1, `</${tag}> not found`);
  return s.slice(bodyStart, close);
}

function payloadFor(content, label) {
  const m = content.match(new RegExp(`onSelect=\\{\\(\\) => (.+?)\\}>${label}<`));
  assert.ok(m, `no menu item labelled "${label}" with an onSelect handler`);
  return m[1].trim();
}

describe('Configured Hosts chip declares a themed context menu (WARDEN-1655)', () => {
  it('imports the themed primitives and copyWithToast', () => {
    assert.match(src, /import \{[^}]*ContextMenuTrigger[^}]*\} from '@\/components\/ui\/context-menu'/);
    assert.match(src, /import \{ copyWithToast \} from '@\/lib\/clipboardToast'/);
  });

  it('wraps the chip div with an asChild trigger (no wrapper element)', () => {
    assert.match(src, /<ContextMenu key=\{host\}>/, 'the keyed root is the ContextMenu');
    assert.match(src, /<ContextMenuTrigger asChild>/, 'the trigger must use asChild');
    const trigger = element(src, 'ContextMenuTrigger');
    assert.match(trigger.trim(), /^<div className="inline-flex items-center gap-0\.5">/,
      'the trigger clones onto the chip div itself');
    assert.match(trigger, /<Badge variant="secondary">\{host\}<\/Badge>/, 'chip text is kept');
    assert.match(trigger, /aria-label=\{`Remove host \$\{host\}`\}/, 'the trash button keeps its accessible name');
  });

  it('adds none of the WARDEN-926 trap handlers', () => {
    assert.doesNotMatch(src, /onContextMenu/);
    const open = src.indexOf('<ContextMenuTrigger');
    const tag = src.slice(open, src.indexOf('>', open) + 1);
    assert.doesNotMatch(tag, /preventDefault/);
    assert.doesNotMatch(tag, /stopPropagation/);
    assert.doesNotMatch(element(src, 'ContextMenuContent'), /preventDefault|stopPropagation/);
  });

  it('offers Copy host name, Copy SSH address, then destructive Remove host… below a separator', () => {
    const content = element(src, 'ContextMenuContent');
    const order = ['Copy host name', 'Copy SSH address', 'Remove host…'];
    const positions = order.map((l) => content.indexOf(`>${l}<`));
    positions.forEach((p, i) => assert.ok(p !== -1, `menu item "${order[i]}" is missing`));
    assert.deepEqual(positions, [...positions].sort((a, b) => a - b));
    assert.match(content, /<ContextMenuSeparator \/>/);
    assert.match(content, /<ContextMenuItem variant="destructive"[^\n]*>Remove host…<\/ContextMenuItem>/);
  });

  it('copy items go through copyWithToast with the raw alias / ssh <alias>', () => {
    const content = element(src, 'ContextMenuContent');
    assert.equal(payloadFor(content, 'Copy host name'), 'copyWithToast(host)');
    assert.equal(payloadFor(content, 'Copy SSH address'), 'copyWithToast(`ssh ${host}`)');
  });

  it('Remove host… routes through setPendingRemoval, never removeHost/setConfig directly', () => {
    const content = element(src, 'ContextMenuContent');
    assert.equal(payloadFor(content, 'Remove host…'), 'setPendingRemoval(host)');
    assert.doesNotMatch(content, /removeHost|setConfig/,
      'removal must stay behind the WARDEN-928 ConfirmDialog');
  });

  it('removeHost is still only invoked from the ConfirmDialog onConfirm', () => {
    const calls = src.match(/removeHost\(/g) ?? [];
    // one definition `const removeHost = (host…` has no `removeHost(` text; the
    // sole call site is the dialog's onConfirm.
    assert.equal(calls.length, 1);
    const dialog = src.slice(src.indexOf('<ConfirmDialog'));
    assert.match(dialog, /onConfirm=\{\(\) => \{[\s\S]*removeHost\(pendingRemoval\)/);
  });
});
