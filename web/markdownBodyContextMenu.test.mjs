import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * STATIC SOURCE GUARD for the themed right-click menus inside the shared
 * MarkdownBody (WARDEN-1794, roadmap WARDEN-362): links (Open link / Copy link
 * address) and fenced code blocks (Copy code). No front-end DOM runner exists,
 * so these pin properties of the SOURCE; "right-click opens the menu" and
 * "an open menu survives streaming re-renders" are verified live.
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const text = fs.readFileSync(path.join(HERE, 'src', 'components', 'MarkdownBody.tsx'), 'utf8');

const section = (startMarker, endMarker) => {
  const s = text.indexOf(startMarker);
  assert.notStrictEqual(s, -1, `${startMarker} findable`);
  const e = text.indexOf(endMarker, s + startMarker.length);
  assert.notStrictEqual(e, -1, `${endMarker} findable after ${startMarker}`);
  return text.slice(s, e);
};
const codeBlock = section('function CodeBlock(', '// Link context (WARDEN-1794)');
const linkMenu = section('function LinkMenu(', '// Shared styled GFM');
const markdownLink = section('function MarkdownLink(', 'const MARKDOWN_COMPONENTS');

describe('MarkdownBody declares themed context menus (WARDEN-1794)', () => {
  it('imports the menu primitives from the themed kit and copyWithToast', () => {
    assert.match(text, /from '@\/components\/ui\/context-menu';/);
    assert.match(text, /import \{ copyWithToast \} from '@\/lib\/clipboardToast';/);
  });

  it('LinkMenu is module-level, asChild-triggered and offers Open + Copy items', () => {
    assert.match(text, /^function LinkMenu\(/m);
    assert.match(linkMenu, /<ContextMenuTrigger asChild>\{anchor\}<\/ContextMenuTrigger>/);
    assert.match(linkMenu, /copyWithToast\(copyValue\)/);
  });

  it('link labels: Copy link address / Open link, and Open file / Copy file path for resolved doc links', () => {
    assert.match(markdownLink, /copyLabel="Copy link address"/);
    assert.match(markdownLink, /openLabel="Open link"/);
    assert.match(markdownLink, /openLabel="Open file"/);
    assert.match(markdownLink, /copyLabel="Copy file path"/);
    assert.match(markdownLink, /copyValue=\{resolved\}/);
    assert.strictEqual(markdownLink.split('copyValue={href}').length - 1, 2);
  });

  it('all three anchor shapes are wrapped; an href-less anchor renders plain', () => {
    assert.strictEqual(markdownLink.split('<LinkMenu').length - 1, 3);
    assert.match(markdownLink, /if \(!href\) \{\s*return <a /);
  });

  it('click contracts are unchanged (issue → openExternalUrl, doc → onOpenPath, href kept)', () => {
    assert.match(markdownLink, /e\.preventDefault\(\);\s*void openExternalUrl\(href\);/);
    assert.match(markdownLink, /e\.preventDefault\(\);\s*onOpenPath\(resolved\);/);
    assert.match(markdownLink, /href=\{resolved\}/);
    assert.match(markdownLink, /target="_blank" rel="noreferrer noopener"/);
  });

  it('CodeBlock has a Copy code menu item and keeps the hover Copy button', () => {
    assert.match(codeBlock, /<ContextMenuTrigger asChild>/);
    assert.match(codeBlock, /copyWithToast\(children\)\}>Copy code<\/ContextMenuItem>/);
    assert.match(codeBlock, /aria-label="Copy code"/);
  });

  it('adds no stopPropagation, and no preventDefault outside the existing click handlers', () => {
    const code = text.replace(/\/\/.*$/gm, ''); // comments may mention the words
    assert.ok(!code.includes('stopPropagation'));
    assert.ok(!linkMenu.replace(/\/\/.*$/gm, '').includes('preventDefault'));
    assert.ok(!codeBlock.replace(/\/\/.*$/gm, '').includes('preventDefault'));
    // exactly the two pre-existing click-handler preventDefaults (issue + doc links)
    assert.strictEqual(code.split('preventDefault()').length - 1, 2);
  });

  it('has no hand-rolled onContextMenu handler (WARDEN-926)', () => {
    assert.ok(!text.includes('onContextMenu'));
  });

  it('the components map and the `a` renderer are module-level (stable identity across re-renders)', () => {
    assert.match(text, /^const MARKDOWN_COMPONENTS: Components = \{/m);
    assert.match(text, /^\s+a: MarkdownLink,$/m);
    assert.match(text, /components=\{MARKDOWN_COMPONENTS\}/);
    assert.match(text, /^function MarkdownLink\(/m);
    // no inline components object / inline `a:` arrow
    assert.ok(!/components=\{\{/.test(text));
    assert.ok(!/a: \(\{/.test(text));
  });

  it('link context is provided by MarkdownBody and read by the module-level renderer', () => {
    assert.match(text, /<MarkdownLinkContext\.Provider value=\{linkContext\}>/);
    assert.match(markdownLink, /useContext\(MarkdownLinkContext\)/);
  });
});
