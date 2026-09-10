import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * STATIC SOURCE GUARD for the FleetMatrixPanel row-header context menu
 * (WARDEN-1336).
 *
 * WHY A SOURCE GUARD AND NOT A BEHAVIOR TEST: this repo has no front-end DOM test
 * runner (see the note at the top of commitRowContextMenu.test.mjs), so
 * "right-click opens the themed menu" cannot be asserted here — that acceptance
 * criterion is verified live in the running app and is NOT what these tests
 * claim. Every test below is named for what it actually checks: a property of
 * the SOURCE.
 *
 * What a source scan CAN see, and what a unit test could not:
 *
 *  1. WHICH ELEMENT THE TRIGGER WRAPS. The load-bearing decision in this slice
 *     is that `<ContextMenuTrigger asChild>` wraps ONLY the rowheader
 *     `<div role="rowheader">` — not the `role="row"` (which also carries 24
 *     `role="gridcell"` divs, each with its own per-bucket tooltip) and not a
 *     cell. If a later edit moves the trigger to the row div, radix still opens
 *     SOME menu, nothing throws, and no behavior test could fail — but a
 *     right-click on a CELL would then answer with an agent-level menu: the
 *     wrong menu, reading worse than a missing one. That regression lives
 *     entirely in the JSX nesting, and test 1 goes RED under exactly that
 *     mutation (verified by hand before shipping).
 *
 *  2. THAT COPIES GO THROUGH copyWithToast. Bare `navigator.clipboard` fails
 *     SILENTLY in Electron — no throw, no toast, nothing to assert on at
 *     runtime.
 *
 *  3. THAT THE WRAPPED ELEMENT'S OWN CONTRACT SURVIVED THE WRAP. `asChild`
 *     merges the pointer handlers onto the existing element and contributes no
 *     DOM of its own, so `role="rowheader"` / the `truncate` class / `title`
 *     must all still be declared on that same div — and the row div keeps its
 *     `key` / `tabIndex={0}` / summary `aria-label` / the grid keeps its
 *     `aria-rowcount` / `aria-colcount`. A wrap that dropped one of them would
 *     render a menu perfectly while breaking the grid's aria contract.
 *
 *  4. THAT THE OPEN PATH IS THE ONE OPEN PATH. Open must call
 *     `onOpenChat(chat.key || chat.id)` — byte-identical to the agent-catalog
 *     row's Open — and HealthDashboard must actually thread the callback into
 *     BOTH panels. The prop is optional, so a dropped pass-through compiles
 *     clean and silently loses Open on both surfaces: only a source scan of the
 *     call sites can catch it.
 *
 * It deliberately pins structure and payloads, not cosmetics: surrounding
 * comments and the item copy styling are free to change.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, 'src', 'components', 'FleetMatrixPanel.tsx');
const DASH = path.join(HERE, 'src', 'components', 'HealthDashboard.tsx');
const text = fs.readFileSync(SRC, 'utf8');
const dashText = fs.readFileSync(DASH, 'utf8');

/** The source of one top-level `function <name>(...)` declaration, brace-matched.
 *  Tolerates a generic parameter list (`function Name<T>(`). */
function functionSource(src, name) {
  const start = src.indexOf(`function ${name}`);
  assert.ok(start !== -1, `${name} not found`);
  const open = src.indexOf('{', src.indexOf(') {', start));
  assert.ok(open !== -1, `${name}: no opening brace`);
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced braces reading ${name}`);
}

/** The inner text of the first `<Tag ...>` … `</Tag>` pair inside `src`; for a
 *  self-closing `<Tag … />` (both panel call sites in HealthDashboard), the
 *  whole opening tag. */
function element(src, tag) {
  const open = src.indexOf(`<${tag}`);
  assert.ok(open !== -1, `<${tag}> not found`);
  const tagEnd = src.indexOf('>', open);
  assert.ok(tagEnd !== -1, `<${tag}>: unbalanced opening tag`);
  if (src.slice(open, tagEnd + 1).endsWith('/>')) return src.slice(open, tagEnd + 1);
  const bodyStart = tagEnd + 1;
  const close = src.indexOf(`</${tag}>`, bodyStart);
  assert.ok(close !== -1, `</${tag}> not found`);
  return src.slice(bodyStart, close);
}

/** The opening tag of the FIRST JSX element inside `src` (the trigger's
 *  immediate child — what `asChild` actually merges onto). */
function firstOpeningTag(src) {
  const lt = src.indexOf('<');
  assert.ok(lt !== -1, 'no JSX element found');
  const gt = src.indexOf('>', lt);
  assert.ok(gt !== -1, 'unbalanced opening tag');
  return src.slice(lt, gt + 1);
}

const panel = functionSource(text, 'FleetMatrixPanel');
const trigger = element(panel, 'ContextMenuTrigger');
const content = element(panel, 'ContextMenuContent');
// The trigger's immediate child element — the mutation target. If the trigger
// were moved to wrap the `role="row"` div, THIS tag is the one that changes.
const triggerChild = firstOpeningTag(trigger);

describe('FleetMatrixPanel declares a themed context menu (WARDEN-1336)', () => {
  it('declares a radix ContextMenu with an asChild trigger, using the house primitive (WARDEN-68 Rule 3)', () => {
    assert.match(panel, /<ContextMenu>/, 'FleetMatrixPanel declares no <ContextMenu>');
    assert.match(panel, /<ContextMenuTrigger asChild>/, 'the trigger must use asChild so no wrapper element is added to the grid');
    assert.match(
      text,
      /import \{[^}]*ContextMenuTrigger[^}]*\} from '@\/components\/ui\/context-menu'/,
      'the menu must come from the house ui/context-menu primitive',
    );
  });

  it('wraps ONLY the rowheader div — not the row, not a cell', () => {
    // The trigger's IMMEDIATE child must be the rowheader itself: its opening
    // tag carries role="rowheader". Under the wrap-the-row mutation this tag is
    // the row div's (role="row", no rowheader role) and this goes RED.
    assert.match(triggerChild, /role="rowheader"/, 'the trigger must wrap the rowheader div itself, not a container of it');
    assert.doesNotMatch(triggerChild, /tabIndex=/, 'the trigger child must not be the focusable row div');
    assert.doesNotMatch(triggerChild, /key=\{/, 'the trigger child must not be the keyed row div');
    // …and the cells must stay OUTSIDE the trigger: a cell right-click keeps
    // its own per-bucket tooltip and never opens the agent-level menu.
    assert.doesNotMatch(trigger, /renderCell/, 'renderCell output must stay OUTSIDE the trigger');
    assert.doesNotMatch(trigger, /role="gridcell"/, 'gridcells must stay OUTSIDE the trigger');
  });

  it('leaves the rowheader div\'s own aria/visual contract declared unchanged on that div', () => {
    // asChild merges handlers onto this element — every one of these must survive.
    assert.match(triggerChild, /role="rowheader"/);
    assert.match(triggerChild, /className="truncate text-\[10px\] text-muted-foreground pr-1"/, 'the truncate class must survive the wrap (the menu IS the copy affordance)');
    assert.match(triggerChild, /title=\{name\}/);
  });

  it('keeps the row div\'s own contract — key, role, focus, summary aria-label — outside the menu', () => {
    // key={row.agent.container} stays on the role="row" div; the menu wraps the
    // INNER rowheader, so the row's opening tag must not have moved under the
    // trigger and must still declare its focusability and summary label.
    const at = panel.indexOf('key={row.agent.container}');
    assert.ok(at !== -1, 'the row div lost its key');
    const lt = panel.lastIndexOf('<div', at);
    const gt = panel.indexOf('>', at);
    const rowTag = panel.slice(lt, gt + 1);
    assert.match(rowTag, /role="row"/);
    assert.match(rowTag, /tabIndex=\{0\}/, 'the row must stay keyboard-focusable');
    assert.match(rowTag, /aria-label=\{\`\$\{name\}: \$\{rowAriaLabel\(row\.cells\)\}\`\}/, 'the row summary aria-label must stay byte-identical');
    // The grid's declared dimensions are untouched by the wrap.
    assert.match(panel, /aria-rowcount=\{rows\.length \+ 1\}/);
    assert.match(panel, /aria-colcount=\{colCount \+ 1\}/);
    assert.match(panel, /role="grid"/);
  });
});

describe('FleetMatrixPanel\'s menu items name the row header\'s four actions and copy the right values', () => {
  it('offers Open FIRST, bound to onOpenChat(chat.key || chat.id) — the one open path, byte-identical to the agent-catalog row', () => {
    assert.match(
      content,
      /<ContextMenuItem onSelect=\{\(\) => onOpenChat\(chat\.key \|\| chat\.id\)\}>Open<\/ContextMenuItem>/,
      'Open must call onOpenChat(chat.key || chat.id), exactly as HealthDashboard\'s agent-catalog row does',
    );
    // Open-first house pattern (WARDEN-444/853/1263).
    const order = ['>Open<', '>Copy agent name<', '>Copy host<', '>Copy container id<'];
    const positions = order.map((label) => content.indexOf(label));
    positions.forEach((p, i) => assert.ok(p !== -1, `menu item ${order[i]} is missing`));
    assert.deepEqual([...positions].sort((a, b) => a - b), positions, 'Open must come first, before the Copy items');
  });

  it('renders Open only when the host threaded the callback (optional-prop pattern)', () => {
    // Mirrors FleetRecentCommits' onOpenFile?: absent callback → no Open item,
    // the three Copy items remain.
    assert.match(content, /\{onOpenChat && chat && \(/, 'the Open item must be gated on the callback (and the row\'s Chat)');
  });

  it('copies the displayed name, the RAW host string, and the full container id', () => {
    // The name is what the rowheader displays (displayName, container fallback).
    assert.match(content, /onSelect=\{\(\) => copyWithToast\(name\)\}>Copy agent name</);
    // Host copies the RAW SSH / docker-exec identifier (chat.host) — what a
    // human pastes into a command — NOT the hostLabels display label.
    assert.match(content, /onSelect=\{\(\) => copyWithToast\(chat\.host\)\}>Copy host</);
    // The container id is rendered nowhere in the panel, yet is the id every
    // docker exec / docker logs takes.
    assert.match(content, /onSelect=\{\(\) => copyWithToast\(row\.agent\.container\)\}>Copy container id</);
  });

  it('routes every copy through copyWithToast and uses onSelect, never onClick', () => {
    const copyItems = [...content.matchAll(/onSelect=\{\(\) => (copyWithToast\([^)]*\))\}/g)];
    assert.equal(copyItems.length, 3, 'expected exactly three Copy items (name, host, container id)');
    assert.doesNotMatch(content, /onClick=/, 'menu items use onSelect, matching every sibling Copy slice');
    // Bare navigator.clipboard fails silently in Electron — the whole file must
    // avoid it. Comments are stripped first so prose mentioning the
    // anti-pattern cannot trip the guard.
    const code = text.replace(/\{?\/\*[\s\S]*?\*\/\}?/g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.doesNotMatch(code, /navigator\.clipboard/, 'copies must go through copyWithToast, never bare navigator.clipboard');
  });
});

describe('both Fleet Health panels actually receive the Open callback', () => {
  it('HealthDashboard threads onOpenChat into BOTH matrix panels', () => {
    // The prop is OPTIONAL — a dropped pass-through compiles clean and silently
    // loses Open on both surfaces, so only a source scan of the call sites can
    // catch it.
    for (const tag of ['FleetActivityHeatmap', 'FleetStateTimeline']) {
      const callSite = element(dashText, tag);
      assert.match(callSite, /onOpenChat=\{onOpenChat\}/, `<${tag}> must pass onOpenChat through to the matrix scaffold`);
    }
  });

  it('the two panel files pass the prop straight through to FleetMatrixPanel', () => {
    for (const file of ['FleetActivityHeatmap.tsx', 'FleetStateTimeline.tsx']) {
      const src = fs.readFileSync(path.join(HERE, 'src', 'components', file), 'utf8');
      assert.match(src, /onOpenChat\?: \(id: string\) => void/, `${file} must declare the optional prop`);
      assert.match(src, /onOpenChat=\{onOpenChat\}/, `${file} must pass the prop through to <FleetMatrixPanel>`);
    }
  });
});
