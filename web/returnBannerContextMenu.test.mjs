import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * STATIC SOURCE GUARDS for the ReturnBanner directed callout right-click menu
 * (WARDEN-1663), twin of AttentionList's Callout menu (WARDEN-1269). No front-end
 * DOM runner exists, so these assert properties of the SOURCE:
 *
 *  1. Themed primitives + copyWithToast are imported.
 *  2. `<ContextMenuTrigger asChild>` directly wraps the callout Button (no wrapper
 *     element) and the file adds no onContextMenu / preventDefault (WARDEN-926 trap).
 *  3. Open routes to onOpenChat (shared with the Button click); Copy items go through
 *     copyWithToast with the RAW name-or-id and attentionReason(...).
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, 'src', 'components', 'ReturnBanner.tsx'), 'utf8');

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

describe('ReturnBanner callout declares a themed context menu (WARDEN-1663)', () => {
  it('imports the themed primitives and copyWithToast', () => {
    assert.match(src, /import \{[^}]*ContextMenuTrigger[^}]*ContextMenuContent[^}]*ContextMenuItem[^}]*ContextMenuSeparator[^}]*\} from '@\/components\/ui\/context-menu'/s);
    assert.match(src, /import \{ copyWithToast \} from '@\/lib\/clipboardToast'/);
  });

  it('asChild trigger directly wraps the callout Button (no wrapper element)', () => {
    assert.match(src, /<ContextMenuTrigger asChild>/);
    const trigger = element(src, 'ContextMenuTrigger');
    assert.match(trigger.trim(), /^<Button\b/, 'the trigger child is the Button itself');
    assert.match(trigger.trim(), /<\/Button>$/, 'the Button is the sole child');
    assert.match(trigger, /You&rsquo;re needed in/, 'the callout Button is the one wrapped');
    assert.match(trigger, /aria-label=\{`You're needed in /, 'accessible name kept');
    assert.match(trigger, /shrink min-w-0/, 'truncation layout classes kept');
  });

  it('adds none of the WARDEN-926 trap handlers', () => {
    assert.doesNotMatch(src, /onContextMenu/);
    const open = src.indexOf('<ContextMenuTrigger');
    const tag = src.slice(open, src.indexOf('>', open) + 1);
    assert.doesNotMatch(tag, /preventDefault|stopPropagation/);
    assert.doesNotMatch(element(src, 'ContextMenuContent'), /preventDefault|stopPropagation/);
  });

  it('menu sits inside the attentionTop branch, after the early return', () => {
    const early = src.indexOf('if (!showReturnBanner) return null;');
    assert.ok(early !== -1, 'early return kept');
    assert.ok(src.indexOf('<ContextMenu>') > early, 'menu is in the returned JSX');
    assert.ok(src.indexOf('<ContextMenu>') > src.indexOf('{attentionTop && ('), 'menu inside attentionTop branch');
  });

  it('Open routes to onOpenChat via the helper shared with the Button click', () => {
    assert.match(src, /const openTop = \(top: AttentionItem\) => onOpenChat\(top\.id, top\.anchor \?\? undefined\);/);
    const trigger = element(src, 'ContextMenuTrigger');
    assert.match(trigger, /onClick=\{\(\) => openTop\(attentionTop\)\}/);
    const content = element(src, 'ContextMenuContent');
    assert.equal(payloadFor(content, 'Open'), 'openTop(attentionTop)');
  });

  it('copy items go through copyWithToast with raw name-or-id and attentionReason', () => {
    const content = element(src, 'ContextMenuContent');
    assert.match(content, /<ContextMenuSeparator \/>/);
    assert.ok(content.indexOf('>Open<') < content.indexOf('>Copy pane name<'));
    assert.ok(content.indexOf('>Copy pane name<') < content.indexOf('>Copy reason<'));
    assert.equal(payloadFor(content, 'Copy pane name'), 'copyWithToast(attentionTop.name || attentionTop.id)');
    assert.equal(payloadFor(content, 'Copy reason'), 'copyWithToast(attentionReason(attentionTop))');
  });

  it('leaves View Activity and the dismiss × unwrapped', () => {
    assert.equal((src.match(/<ContextMenu>/g) ?? []).length, 1);
  });
});
