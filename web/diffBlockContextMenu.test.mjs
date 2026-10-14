import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * STATIC SOURCE GUARD for DiffBlock's right-click menu (WARDEN-1800).
 *
 * There is no front-end DOM test runner here, so "right-click opens the themed menu"
 * is verified live, not by these tests. Each test is named for what it checks: a
 * property of the SOURCE.
 *
 *  1. The trigger wraps the <pre> (the diff text), not something larger.
 *  2. Every copy routes through copyWithToast — bare navigator.clipboard fails
 *     silently in Electron.
 *  3. The two line-copy items carry `disabled` so an empty set can't copy "".
 */

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), 'src', 'components', 'DiffBlock.tsx');
const text = fs.readFileSync(SRC, 'utf8');

/** The inner text of the first `<Tag ...>` … `</Tag>` pair. */
function element(tag) {
  const open = text.indexOf(`<${tag}`);
  assert.ok(open !== -1, `<${tag}> not found`);
  const bodyStart = text.indexOf('>', open) + 1;
  const close = text.indexOf(`</${tag}>`, bodyStart);
  assert.ok(close !== -1, `</${tag}> not found`);
  return text.slice(bodyStart, close);
}

const trigger = element('ContextMenuTrigger');
const content = element('ContextMenuContent');

describe('DiffBlock declares a themed context menu (WARDEN-1800)', () => {
  it('uses the shared themed ContextMenu primitive with an asChild trigger', () => {
    assert.match(text, /import \{[^}]*ContextMenuTrigger[^}]*\} from '@\/components\/ui\/context-menu'/);
    assert.match(text, /<ContextMenuTrigger asChild>/, 'trigger must use asChild so no wrapper element is added');
  });

  it('the trigger wraps the <pre> and its classified line rendering', () => {
    assert.match(trigger, /^\s*<pre /, 'the trigger\'s only child must be the <pre>');
    assert.match(trigger, /<\/pre>\s*$/);
    assert.match(trigger, /DIFF_LINE_CLASS\[classifyDiffLine\(ln\)\]/);
    assert.doesNotMatch(trigger, /ContextMenuContent/);
  });

  it('keeps the <pre> classes unchanged', () => {
    assert.match(trigger, /className="mt-0\.5 max-h-64 overflow-auto rounded bg-muted\/40 p-1 font-mono text-\[10px\] leading-tight whitespace-pre"/);
  });
});

describe('DiffBlock menu items copy the right values', () => {
  const item = (label) => {
    const m = content.match(new RegExp(`<ContextMenuItem((?:[^>]|=>)*?)>${label}</ContextMenuItem>`));
    assert.ok(m, `no item labelled "${label}"`);
    return m[1];
  };

  it('Copy diff copies the full diff string via copyWithToast', () => {
    assert.match(item('Copy diff'), /onSelect=\{\(\) => copyWithToast\(diff\)\}/);
  });

  it('Copy added / removed lines copy the helper output via copyWithToast', () => {
    assert.match(item('Copy added lines'), /onSelect=\{\(\) => copyWithToast\(added\)\}/);
    assert.match(item('Copy removed lines'), /onSelect=\{\(\) => copyWithToast\(removed\)\}/);
    assert.match(text, /const added = addedLinesOf\(diff\)/);
    assert.match(text, /const removed = removedLinesOf\(diff\)/);
  });

  it('the two line-copy items carry `disabled`; Copy diff does not', () => {
    assert.match(item('Copy added lines'), /disabled=\{/);
    assert.match(item('Copy removed lines'), /disabled=\{/);
    assert.doesNotMatch(item('Copy diff'), /disabled/);
  });

  it('uses onSelect (never onClick) and never bare navigator.clipboard', () => {
    assert.doesNotMatch(content, /onClick/);
    assert.doesNotMatch(text.replace(/\/\*[\s\S]*?\*\//g, ''), /navigator\.clipboard/);
    assert.equal([...content.matchAll(/copyWithToast\(/g)].length, 3);
  });
});
