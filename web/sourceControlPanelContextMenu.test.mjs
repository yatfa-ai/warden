import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * STATIC SOURCE GUARD for the Source Control panel header + bucket-header right-click
 * menus (WARDEN-1689), in the style of gitListRowsContextMenu.test.mjs. No DOM runner
 * exists, so "right-click opens the themed menu" is verified live. Each test names the
 * SOURCE property it checks.
 */

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), 'src', 'components', 'sidebar', 'SourceControlPanel.tsx');
const text = fs.readFileSync(SRC, 'utf8');

function between(startMarker, endMarker) {
  const s = text.indexOf(startMarker);
  assert.ok(s !== -1, `marker not found: ${startMarker}`);
  const e = text.indexOf(endMarker, s + startMarker.length);
  assert.ok(e !== -1, `end marker not found: ${endMarker}`);
  return text.slice(s, e);
}
function element(src, tag) {
  const open = src.indexOf(`<${tag}`);
  assert.ok(open !== -1, `<${tag}> not found`);
  const bodyStart = src.indexOf('>', open) + 1;
  const close = src.indexOf(`</${tag}>`, bodyStart);
  assert.ok(close !== -1, `</${tag}> not found`);
  return src.slice(bodyStart, close);
}

const section = between('function FileSection(', '/**\n * The collapsible');
const sectionTrigger = element(section, 'ContextMenuTrigger');
const sectionContent = element(section, 'ContextMenuContent');
const panel = text.slice(text.indexOf('export function SourceControlPanel('));
const headerMenu = panel.slice(panel.indexOf('<ContextMenu>'), panel.indexOf('</ContextMenu>'));
const headerTrigger = element(headerMenu, 'ContextMenuTrigger');
const headerContent = element(headerMenu, 'ContextMenuContent');

describe('SourceControlPanel themed context menus (WARDEN-1689)', () => {
  it('declares exactly two ContextMenuTrigger asChild', () => {
    assert.equal((text.match(/<ContextMenuTrigger asChild>/g) || []).length, 2);
  });

  it('header trigger wraps only the collapse Button, keeping toggle + aria contract', () => {
    assert.match(headerTrigger.trim(), /^<Button\b/);
    assert.match(headerTrigger.trim(), /<\/Button>$/);
    assert.match(headerTrigger, /onClick=\{\(\) => onCollapsedChange\(!collapsed\)\}/);
    assert.match(headerTrigger, /aria-expanded=\{!collapsed\}/);
    assert.doesNotMatch(headerTrigger, /FileSection|GitRepoDetails/);
  });

  it('header menu: Expand/Collapse first, then separator, then copy items in order', () => {
    const order = ["'Expand' : 'Collapse'", '<ContextMenuSeparator />', '>Copy branch name<', '>Copy HEAD commit<', '>Copy upstream<', '>Copy repository path<'];
    const pos = order.map((l) => headerContent.indexOf(l));
    pos.forEach((p, i) => assert.ok(p !== -1, `missing ${order[i]}`));
    assert.deepEqual([...pos].sort((a, b) => a - b), pos);
  });

  it('header copies exactly the documented payloads', () => {
    assert.match(headerContent, /copyWithToast\(gitInfo\.branch!\)\}>Copy branch name</);
    assert.match(headerContent, /copyWithToast\(gitInfo\.headSha!\)\}>Copy HEAD commit</);
    assert.match(headerContent, /copyWithToast\(gitInfo\.upstream!\)\}>Copy upstream</);
    assert.match(headerContent, /copyWithToast\(gitInfo\.cwd!\)\}>Copy repository path</);
    assert.match(headerContent, /onSelect=\{\(\) => onCollapsedChange\(!collapsed\)\}>/);
  });

  it('conditional items mirror conditional data; detached excludes Copy branch name', () => {
    assert.match(headerContent, /\{!gitInfo\.detached && <ContextMenuItem [^\n]*?>Copy branch name</);
    assert.match(headerContent, /\{gitInfo\.headSha && <ContextMenuItem [^\n]*?>Copy HEAD commit</);
    assert.match(headerContent, /\{gitInfo\.upstream && <ContextMenuItem [^\n]*?>Copy upstream</);
    assert.match(headerContent, /\{gitInfo\.cwd && <ContextMenuItem [^\n]*?>Copy repository path</);
  });

  it('bucket trigger wraps only the label · count header div; GitChangedFile rows are outside', () => {
    assert.match(sectionTrigger.trim(), /^<div className=\{cn\('px-2 pb-0\.5/);
    assert.match(sectionTrigger, /\{label\} · \{files\.length\}/);
    assert.doesNotMatch(sectionTrigger, /GitChangedFile/);
    const menuEnd = section.indexOf('</ContextMenu>');
    assert.ok(menuEnd !== -1 && section.indexOf('<GitChangedFile', menuEnd) > menuEnd);
  });

  it('bucket menu copies newline-joined paths (with count in label) and the section name', () => {
    assert.match(sectionContent, /copyWithToast\(files\.map\(\(f\) => f\.path\)\.join\('\\n'\)\)\}>Copy file paths \(\{files\.length\}\)</);
    assert.match(sectionContent, /copyWithToast\(label\)\}>Copy section name</);
  });

  it('uses themed primitives + copyWithToast, never onClick items or bare navigator.clipboard', () => {
    assert.match(text, /from '@\/components\/ui\/context-menu'/);
    assert.match(text, /import \{ copyWithToast \} from '@\/lib\/clipboardToast'/);
    for (const c of [headerContent, sectionContent]) assert.doesNotMatch(c, /onClick=/);
    const code = text.replace(/\{?\/\*[\s\S]*?\*\/\}?/g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.doesNotMatch(code, /navigator\.clipboard/);
  });
});
