import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * STATIC SOURCE GUARD for the CommitRow right-click menu (WARDEN-1297).
 *
 * WHY A SOURCE GUARD AND NOT A BEHAVIOR TEST: this repo has no front-end DOM test
 * runner (see the note at the top of fleetRecentCommits.test.mjs), so "right-click
 * opens the themed menu" cannot be asserted here — that acceptance criterion is
 * verified live in the running app and is NOT what these tests claim. Every test
 * below is named for what it actually checks: a property of the SOURCE.
 *
 * What a source scan CAN see, and what a unit test could not:
 *
 *  1. WHICH ELEMENT THE TRIGGER WRAPS. The load-bearing decision in this slice is
 *     that `<ContextMenuTrigger asChild>` wraps ONLY the row-header
 *     `<div role="button">`, with the expansion body (CommitMessage + CommitFile)
 *     left OUTSIDE it. If a later edit moves the expansion inside the trigger,
 *     radix's innermost-trigger-wins still opens SOME menu, so nothing throws and
 *     no logic test fails — but right-click on an expanded commit's non-file
 *     regions silently starts answering with the COMMIT menu, and the WARDEN-917
 *     FILE menu's coverage inside the expanded state becomes ambiguous. That
 *     regression lives entirely in the JSX nesting.
 *
 *  2. THAT COPIES GO THROUGH copyWithToast. Bare `navigator.clipboard` fails
 *     SILENTLY in Electron — no throw, no toast, nothing to assert on at runtime.
 *
 *  3. THAT THE ROW'S OWN CONTRACT SURVIVED THE WRAP. `asChild` merges handlers onto
 *     the existing element, so role / tabIndex / aria-expanded / aria-label / the
 *     onClick toggle / the onKeyDown stopPropagation must all still be declared on
 *     the same div. A wrap that dropped one of them would render a menu perfectly
 *     while breaking keyboard expansion and the aria contract.
 *
 * It deliberately pins structure and payloads, not cosmetics: class strings, item
 * ordering beyond "Inspect files is first" (the Open-first house pattern), and the
 * surrounding comments are all free to change.
 */

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), 'src', 'components', 'sidebar', 'GitBadges.tsx');
const text = fs.readFileSync(SRC, 'utf8');

/** The source of one top-level `function <name>(...)` declaration, brace-matched. */
function functionSource(name) {
  const start = text.indexOf(`function ${name}(`);
  assert.ok(start !== -1, `${name} not found in GitBadges.tsx`);
  const open = text.indexOf('{', text.indexOf(') {', start));
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1;
    else if (text[i] === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced braces reading ${name}`);
}

/** The inner text of the first `<Tag ...>` … `</Tag>` pair inside `src`. */
function element(src, tag) {
  const open = src.indexOf(`<${tag}`);
  assert.ok(open !== -1, `<${tag}> not found`);
  const bodyStart = src.indexOf('>', open) + 1;
  const close = src.indexOf(`</${tag}>`, bodyStart);
  assert.ok(close !== -1, `</${tag}> not found`);
  return src.slice(bodyStart, close);
}

const commitRow = functionSource('CommitRow');
const trigger = element(commitRow, 'ContextMenuTrigger');
const content = element(commitRow, 'ContextMenuContent');

describe('CommitRow declares a themed context menu (WARDEN-1297)', () => {
  it('declares a radix ContextMenu around the row, using the already-imported primitive (WARDEN-68 Rule 3)', () => {
    assert.match(commitRow, /<ContextMenu>/, 'CommitRow declares no <ContextMenu>');
    assert.match(commitRow, /<ContextMenuTrigger asChild>/, 'the trigger must use asChild so no wrapper element is added');
    // The primitive is imported at the top of the file — no new dependency.
    assert.match(text, /import \{[^}]*ContextMenuTrigger[^}]*\} from '@\/components\/ui\/context-menu'/);
  });

  it('scopes the trigger to the row-header div, leaving the expansion body outside it', () => {
    // The trigger's ONLY child is the header div: it carries the row's role, and it
    // does NOT contain the expanded-state components.
    assert.match(trigger, /role="button"/, 'the trigger must wrap the row-header div');
    assert.doesNotMatch(trigger, /CommitFile/, 'CommitFile rows must stay OUTSIDE the commit trigger (WARDEN-917 file menu keeps its own coverage)');
    assert.doesNotMatch(trigger, /CommitMessage/, 'the expansion body must stay OUTSIDE the commit trigger');
    // …and the expansion body is emitted after the menu closes, as a sibling of it.
    const menuEnd = commitRow.indexOf('</ContextMenu>');
    const expansion = commitRow.indexOf('expandedHash === cm.hash && (');
    assert.ok(menuEnd !== -1 && expansion > menuEnd, 'the expansion block must be a SIBLING that follows </ContextMenu>, not a descendant of it');
  });

  it('leaves the row-header div\'s own interaction and aria contract declared unchanged on that div', () => {
    // asChild merges handlers onto this element — every one of these must survive.
    assert.match(trigger, /tabIndex=\{0\}/);
    assert.match(trigger, /aria-expanded=\{expandedHash === cm\.hash\}/);
    assert.match(trigger, /aria-label=\{`inspect files changed by commit \$\{cm\.hash\}`\}/);
    assert.match(trigger, /onClick=\{\(e\) => \{ e\.stopPropagation\(\); toggleCommit\(cm\.hash\); \}\}/);
    // Enter/Space still expand, and still stop the parent chat row from stealing them.
    assert.match(trigger, /onKeyDown=.*e\.key === 'Enter' \|\| e\.key === ' '/);
    assert.match(trigger, /onKeyDown=.*e\.stopPropagation\(\); toggleCommit\(cm\.hash\)/);
  });
});

describe('CommitRow\'s menu items name the row\'s five actions and copy the right values', () => {
  /** The `onSelect` payload declared for the item labelled `label`. */
  const payloadFor = (label) => {
    const m = content.match(new RegExp(`onSelect=\\{\\(\\) => ([^}]+)\\}>${label}<`));
    assert.ok(m, `no item labelled "${label}" with an onSelect handler`);
    return m[1].trim();
  };

  it('offers Inspect files FIRST, bound to the same toggleCommit a left-click fires', () => {
    // Open-first house pattern (WARDEN-444/853/1263): no new behavior, same handler.
    assert.equal(payloadFor('Inspect files'), 'toggleCommit(cm.hash)');
    const order = ['Inspect files', 'Copy commit hash', 'Copy commit subject', 'Copy timestamp'];
    const positions = order.map((label) => content.indexOf(`>${label}<`));
    positions.forEach((p, i) => assert.ok(p !== -1, `menu item "${order[i]}" is missing`));
    assert.deepEqual([...positions].sort((a, b) => a - b), positions, 'Inspect files must come first, before the Copy items');
  });

  it('copies the short hash, the FULL (untruncated) subject, and the displayed timestamp', () => {
    assert.equal(payloadFor('Copy commit hash'), 'copyWithToast(cm.hash)');
    // The row renders the subject `block truncate`, so the on-screen text is not the
    // whole value — the menu must copy cm.subject itself, not a derived/clipped form.
    assert.equal(payloadFor('Copy commit subject'), 'copyWithToast(cm.subject)');
    assert.equal(payloadFor('Copy timestamp'), 'copyWithToast(cm.date)');
  });

  it('renders Copy author only when cm.author is non-empty, mirroring the row\'s own conditional display', () => {
    assert.match(content, /\{cm\.author && <ContextMenuItem onSelect=\{\(\) => copyWithToast\(cm\.author\)\}>Copy author<\/ContextMenuItem>\}/);
    // The row itself renders the author conditionally at the same predicate.
    assert.match(trigger, /cm\.author \? ` · \$\{cm\.author\}` : ''/);
  });

  it('routes every copy through copyWithToast and uses onSelect, never onClick', () => {
    const copyItems = [...content.matchAll(/onSelect=\{\(\) => (copyWithToast\([^)]*\))\}/g)];
    assert.equal(copyItems.length, 4, 'expected four Copy items (hash, subject, author, timestamp)');
    assert.doesNotMatch(content, /onClick=/, 'menu items use onSelect, matching every sibling Copy slice');
    // Bare navigator.clipboard fails silently in Electron — the whole file must avoid
    // it. Comments are stripped first so prose mentioning the anti-pattern (including
    // the one two lines above) cannot trip the guard.
    const code = text.replace(/\{?\/\*[\s\S]*?\*\/\}?/g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.doesNotMatch(code, /navigator\.clipboard/, 'copies must go through copyWithToast, never bare navigator.clipboard');
  });
});

describe('the sibling GitChangedFile menu is untouched (WARDEN-917 regression guard)', () => {
  it('still declares its own three Copy items on the changed-FILE row', () => {
    const changedFile = functionSource('GitChangedFile');
    const fileMenu = element(changedFile, 'ContextMenuContent');
    for (const label of ['Copy file path', 'Copy filename', 'Copy status']) {
      assert.ok(fileMenu.includes(`>${label}<`), `GitChangedFile lost its "${label}" item`);
    }
  });
});
