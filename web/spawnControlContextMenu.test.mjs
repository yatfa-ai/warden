import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * STATIC SOURCE GUARD for the SpawnControl collapsed-row right-click menu (WARDEN-1786).
 * No front-end DOM runner exists, so these tests pin properties of the SOURCE only;
 * that right-click opens the themed menu is verified live, not here.
 */
const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), 'src', 'components', 'sidebar', 'SpawnControl.tsx');
const text = fs.readFileSync(SRC, 'utf8');
const code = text.replace(/\{?\/\*[\s\S]*?\*\/\}?/g, '').replace(/^\s*\/\/.*$/gm, '');

const trigger = code.slice(code.indexOf('<ContextMenuTrigger asChild>'), code.indexOf('</ContextMenuTrigger>'));
const content = code.slice(code.indexOf('<ContextMenuContent'), code.indexOf('</ContextMenuContent>'));
const expandedStart = code.indexOf('data-testid="spawn-expanded"');
const expandedBranch = code.slice(expandedStart, code.indexOf(') : ('));

describe('SpawnControl collapsed row declares a themed context menu (WARDEN-1786)', () => {
  it('imports the themed primitive and has exactly one asChild trigger', () => {
    assert.match(text, /from '@\/components\/ui\/context-menu'/);
    assert.strictEqual((code.match(/<ContextMenuTrigger asChild>/g) || []).length, 1);
    assert.strictEqual((code.match(/<ContextMenuTrigger/g) || []).length, 1);
  });

  it('the trigger wraps the host chip, directory button and + shell button with original wiring', () => {
    assert.match(trigger, /data-testid="spawn-collapsed-host"/);
    assert.match(trigger, /aria-label="directory — open spawn options"/);
    assert.match(trigger, /onClick=\{\(\) => setExpanded\(true\)\}/);
    assert.match(trigger, /onClick=\{\(\) => void spawn\(\)\}/);
    assert.match(trigger, /disabled=\{busy \|\| disabled\}/);
    assert.doesNotMatch(trigger, /stopPropagation|preventDefault|onContextMenu/);
  });

  it('items call spawn() / setExpanded(true) / copyWithToast through onSelect', () => {
    assert.match(content, /disabled=\{busy \|\| disabled\} onSelect=\{\(\) => \{ void spawn\(\); \}\}>Start a shell here</);
    assert.match(content, /onSelect=\{\(\) => setExpanded\(true\)\}>Spawn options…</);
    assert.match(content, /onSelect=\{\(\) => copyWithToast\(label\)\}>Copy host name</);
    assert.match(code, /from '@\/lib\/clipboardToast'/);
    assert.doesNotMatch(code, /navigator\.clipboard/);
    assert.doesNotMatch(content, /onClick=/, 'menu items use onSelect');
  });

  it('SSH item is gated on THIS_MACHINE and directory item on cwd', () => {
    assert.match(content, /\{selectedHost !== THIS_MACHINE && <ContextMenuItem onSelect=\{\(\) => copyWithToast\(`ssh \$\{selectedHost\}`\)\}>Copy SSH address</);
    assert.match(content, /\{cwd && <ContextMenuItem onSelect=\{\(\) => copyWithToast\(cwd\)\}>Copy directory</);
  });

  it('the expanded branch carries no ContextMenu (native field menus preserved)', () => {
    assert.ok(expandedStart > 0 && expandedBranch.length > 100);
    assert.doesNotMatch(expandedBranch, /ContextMenu/);
  });
});
