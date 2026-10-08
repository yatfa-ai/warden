import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * STATIC SOURCE GUARD for the stash / reflog / branch row right-click menus
 * (WARDEN-1649), in the style of commitRowContextMenu.test.mjs. This repo has no
 * front-end DOM runner, so "right-click opens the themed menu" is verified live, not
 * here. Every test names the SOURCE property it checks: which element each trigger
 * wraps, the exact copy payloads, that conditional items mirror conditional rendering,
 * and that no bare navigator.clipboard sneaks in (it fails silently in Electron).
 */

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), 'src', 'components', 'sidebar', 'GitBadges.tsx');
const text = fs.readFileSync(SRC, 'utf8');

/** The slice of `text` from `startMarker` up to (not including) `endMarker`. */
function between(startMarker, endMarker) {
  const s = text.indexOf(startMarker);
  assert.ok(s !== -1, `marker not found: ${startMarker}`);
  const e = text.indexOf(endMarker, s + startMarker.length);
  assert.ok(e !== -1, `end marker not found: ${endMarker}`);
  return text.slice(s, e);
}
/** Inner text of the first `<Tag ...>` … `</Tag>` pair inside `src`. */
function element(src, tag) {
  const open = src.indexOf(`<${tag}`);
  assert.ok(open !== -1, `<${tag}> not found`);
  const bodyStart = src.indexOf('>', open) + 1;
  const close = src.indexOf(`</${tag}>`, bodyStart);
  assert.ok(close !== -1, `</${tag}> not found`);
  return src.slice(bodyStart, close);
}

const stashRow = between('{stashList.map((s, i) => (', '<ListStateRow error={stashError}');
const reflogRow = between('{reflogList.map((op, i) => (', '<ListStateRow error={reflogError}');
const branchRow = between('{branchList.map((b, i) => {', '<ListStateRow error={branchError}');

const stashTrigger = element(stashRow, 'ContextMenuTrigger');
const stashContent = element(stashRow, 'ContextMenuContent');
const reflogTrigger = element(reflogRow, 'ContextMenuTrigger');
const reflogContent = element(reflogRow, 'ContextMenuContent');
const branchTrigger = element(branchRow, 'ContextMenuTrigger');
const branchContent = element(branchRow, 'ContextMenuContent');

/** The handler body declared for the item labelled `label`. */
const payloadFor = (content, label) => {
  const m = content.match(new RegExp(`onSelect=\\{\\(\\) => (?:\\{ void )?([^}]+?);?(?: \\})?\\}>${label}<`));
  assert.ok(m, `no item labelled "${label}" with an onSelect handler`);
  return m[1].trim();
};

describe('GitBadges declares a themed context menu per stash / reflog / branch row (WARDEN-1649)', () => {
  it('has one ContextMenuTrigger asChild per list row type on top of the commit/file ones', () => {
    assert.ok((text.match(/<ContextMenuTrigger asChild>/g) || []).length >= 5);
  });

  it('scopes the stash trigger to the role=button header, leaving StashFile outside it as a sibling', () => {
    assert.match(stashTrigger, /role="button"/);
    assert.doesNotMatch(stashTrigger, /StashFile/, 'StashFile rows must stay OUTSIDE the stash trigger');
    const menuEnd = stashRow.indexOf('</ContextMenu>');
    const expansion = stashRow.indexOf('expandedStashRef === s.ref && (', menuEnd);
    assert.ok(menuEnd !== -1 && expansion > menuEnd, 'the expansion block must follow </ContextMenu> as a sibling');
  });

  it('keeps the stash header\'s role / aria / click / keyboard contract declared on that same div', () => {
    assert.match(stashTrigger, /tabIndex=\{0\}/);
    assert.match(stashTrigger, /aria-expanded=\{expandedStashRef === s\.ref\}/);
    assert.match(stashTrigger, /aria-label=\{`inspect files in stash \$\{s\.ref\}`\}/);
    assert.match(stashTrigger, /onClick=\{\(e\) => \{ e\.stopPropagation\(\); toggleStash\(s\.ref\); \}\}/);
    assert.match(stashTrigger, /onKeyDown=.*e\.key === 'Enter' \|\| e\.key === ' '/);
  });

  it('wraps each reflog and branch <li> in its trigger', () => {
    assert.match(reflogTrigger.trim(), /^<li /);
    assert.match(branchTrigger.trim(), /^<li\b/);
  });
});

describe('menu item order and copy payloads', () => {
  it('stash menu offers Inspect files FIRST, bound to toggleStash(s.ref)', () => {
    assert.equal(payloadFor(stashContent, 'Inspect files'), 'toggleStash(s.ref)');
    const order = ['Inspect files', 'Copy stash ref', 'Copy stash subject', 'Copy timestamp'];
    const pos = order.map((l) => stashContent.indexOf(`>${l}<`));
    pos.forEach((p, i) => assert.ok(p !== -1, `missing "${order[i]}"`));
    assert.deepEqual([...pos].sort((a, b) => a - b), pos);
  });

  it('copies exactly the documented payloads', () => {
    assert.equal(payloadFor(stashContent, 'Copy stash ref'), 'copyWithToast(s.ref)');
    assert.equal(payloadFor(stashContent, 'Copy stash subject'), 'copyWithToast(s.subject)');
    assert.equal(payloadFor(stashContent, 'Copy timestamp'), 'copyWithToast(s.date)');
    assert.equal(payloadFor(reflogContent, 'Copy operation'), 'copyWithToast(op.subject)');
    assert.equal(payloadFor(reflogContent, 'Copy commit hash'), 'copyWithToast(op.hash)');
    assert.equal(payloadFor(reflogContent, 'Copy timestamp'), 'copyWithToast(op.date)');
    assert.equal(payloadFor(branchContent, 'Copy branch name'), 'copyWithToast(b.name)');
    assert.equal(payloadFor(branchContent, 'Copy tip commit'), 'copyWithToast(b.headSha)');
  });

  it('renders hash / date / href items only when their value is truthy', () => {
    assert.match(stashContent, /\{s\.date && <ContextMenuItem [^\n]*?>Copy timestamp</);
    assert.match(reflogContent, /\{op\.hash && <ContextMenuItem [^\n]*?>Copy commit hash</);
    assert.match(reflogContent, /\{op\.date && <ContextMenuItem [^\n]*?>Copy timestamp</);
    assert.match(branchContent, /\{href && <ContextMenuItem [^\n]*?>Open on remote</);
    assert.match(branchContent, /\{b\.headSha && <ContextMenuItem [^\n]*?>Copy tip commit</);
  });

  it('branch Open on remote comes first and uses openExternalUrl, not a synthetic anchor click', () => {
    assert.match(branchContent, /openExternalUrl\(href\)/);
    assert.ok(branchContent.indexOf('>Open on remote<') < branchContent.indexOf('>Copy branch name<'));
    assert.match(text, /import \{ openExternalUrl \} from '@\/lib\/electron'/);
    assert.doesNotMatch(branchContent, /\.click\(\)|createElement/);
  });

  it('keeps reflog index keys and the branch link stopPropagation', () => {
    assert.match(reflogRow, /<ContextMenu key=\{i\}>/);
    assert.match(branchRow, /<ContextMenu key=\{b\.name \|\| i\}>/);
    assert.match(branchTrigger, /onClick=\{\(e\) => e\.stopPropagation\(\)\}/);
  });

  it('uses onSelect (never onClick) and never bare navigator.clipboard', () => {
    for (const c of [stashContent, reflogContent, branchContent]) assert.doesNotMatch(c, /onClick=/);
    const code = text.replace(/\{?\/\*[\s\S]*?\*\/\}?/g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.doesNotMatch(code, /navigator\.clipboard/);
  });
});
