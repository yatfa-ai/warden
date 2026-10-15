import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * STATIC SOURCE GUARDS for the sidebar host view's "Could not reach <host>"
 * unreachable callout right-click menu (WARDEN-1814). No front-end DOM runner
 * exists, so these assert properties of the SOURCE:
 *
 *  1. Themed primitives + copyWithToast are imported.
 *  2. `<ContextMenuTrigger asChild>` directly wraps the data-testid="host-unreachable"
 *     element (no wrapper), and no onContextMenu / preventDefault / stopPropagation
 *     is added (WARDEN-926 trap).
 *  3. Retry routes to onDiscoverHost(H); the copy items use the shared errText,
 *     hostLabel(H) and `ssh ${H}` (hidden for THIS_MACHINE).
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, 'src', 'components', 'ChatSidebar.tsx'), 'utf8');

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

describe('host-unreachable callout declares a themed context menu (WARDEN-1814)', () => {
  it('imports the themed primitives and copyWithToast', () => {
    assert.match(src, /import \{[^}]*ContextMenu\b[^}]*ContextMenuTrigger[^}]*ContextMenuContent[^}]*ContextMenuItem[^}]*ContextMenuSeparator[^}]*\} from '@\/components\/ui\/context-menu'/s);
    assert.match(src, /import \{ copyWithToast \} from '@\/lib\/clipboardToast'/);
  });

  it('asChild trigger directly wraps the host-unreachable div (no wrapper element)', () => {
    assert.match(src, /<ContextMenuTrigger asChild>/);
    const trigger = element(src, 'ContextMenuTrigger').trim();
    assert.match(trigger, /^<div\b/, 'the trigger child is the callout div itself');
    assert.match(trigger, /<\/div>$/, 'the div is the sole child');
    assert.match(trigger, /data-testid="host-unreachable"/);
    assert.match(trigger, /onClick=\{\(\) => onDiscoverHost\(H\)\}>retry</, 'retry link unchanged');
  });

  it('adds none of the WARDEN-926 trap handlers', () => {
    assert.doesNotMatch(src, /onContextMenu/);
    const open = src.indexOf('<ContextMenuTrigger');
    const tag = src.slice(open, src.indexOf('>', open) + 1);
    assert.doesNotMatch(tag, /preventDefault|stopPropagation/);
    assert.doesNotMatch(element(src, 'ContextMenuContent'), /preventDefault|stopPropagation/);
  });

  it('computes the error text once and renders it in the callout', () => {
    assert.match(src, /const errText = discoverErrors\[H\] \|\| 'the host is not responding';/);
    assert.match(element(src, 'ContextMenuTrigger'), /\{errText\}/);
  });

  it('Retry routes to onDiscoverHost(H)', () => {
    const content = element(src, 'ContextMenuContent');
    assert.equal(payloadFor(content, 'Retry'), 'onDiscoverHost(H)');
  });

  it('copy items carry the three payloads, SSH hidden for this machine', () => {
    const content = element(src, 'ContextMenuContent');
    assert.match(content, /<ContextMenuSeparator \/>/);
    assert.ok(content.indexOf('>Retry<') < content.indexOf('>Copy error<'));
    assert.ok(content.indexOf('>Copy error<') < content.indexOf('>Copy host name<'));
    assert.ok(content.indexOf('>Copy host name<') < content.indexOf('>Copy SSH address<'));
    assert.equal(payloadFor(content, 'Copy error'), 'copyWithToast(errText)');
    assert.equal(payloadFor(content, 'Copy host name'), 'copyWithToast(hostLabel(H))');
    assert.equal(payloadFor(content, 'Copy SSH address'), 'copyWithToast(`ssh ${H}`)');
    assert.match(content, /\{H !== THIS_MACHINE && <ContextMenuItem onSelect=.*>Copy SSH address</);
  });

  it('wraps only the unreachable callout', () => {
    assert.equal((src.match(/<ContextMenu>/g) ?? []).length, 1);
  });
});
