import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * STATIC SOURCE GUARD for the uncommitted ± / stashed work / recent operations / branches
 * SECTION-HEADER right-click menus (WARDEN-1715), in the style of
 * gitListHeadersContextMenu.test.mjs. No front-end DOM runner exists, so "right-click
 * opens the themed menu" is verified live; here each test names the SOURCE property it
 * checks.
 */

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), 'src', 'components', 'sidebar', 'GitBadges.tsx');
const text = fs.readFileSync(SRC, 'utf8');

function between(startMarker, endMarker, from = 0) {
  const s = text.indexOf(startMarker, from);
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
const itemLabels = (content) => [...content.matchAll(/>([^<>{}]+)<\/ContextMenuItem>/g)].map((x) => x[1]);
const triggerOf = (m) => element(m, 'ContextMenuTrigger');
const contentOf = (m) => element(m, 'ContextMenuContent');

const HDR = '<ContextMenu>\n                <ContextMenuTrigger asChild>\n                  <div className="mb-';
const uncommittedMenu = between(HDR + '1 flex items-center justify-between gap-2 px-0.5">\n                    <span className="flex items-center gap-1 text-[10px] font-medium text-yellow-400">', '</ContextMenu>');
const stashMenu = between(HDR + '0.5 flex items-center justify-between gap-2 px-0.5">\n                    <span className="truncate text-[10px] font-medium text-fuchsia-400">', '</ContextMenu>');
const reflogMenu = between(HDR + '0.5 flex items-center justify-between gap-2 px-0.5">\n                    <span className="truncate text-[10px] font-medium text-muted-foreground">⏱ recent operations', '</ContextMenu>');
const branchMenu = between(HDR + '0.5 flex items-center justify-between gap-2 px-0.5">\n                    <span className="truncate text-[10px] font-medium text-muted-foreground">⎇ branches', '</ContextMenu>');

describe('GitRepoDetails uncommitted / stash / reflog / branch section headers declare themed context menus (WARDEN-1715)', () => {
  it('has 12 <ContextMenuTrigger asChild> in total (8 + the four new headers)', () => {
    assert.strictEqual((text.match(/<ContextMenuTrigger asChild>/g) || []).length, 12);
  });

  it('wraps ONLY the header div in each trigger — never the <ul>/rows', () => {
    for (const m of [uncommittedMenu, stashMenu, reflogMenu, branchMenu]) {
      const t = triggerOf(m).trim();
      assert.ok(t.startsWith('<div className="mb-'), 'trigger child must be the header div');
      assert.ok(t.endsWith('</div>'));
      assert.doesNotMatch(t, /<ul\b/);
    }
    assert.match(triggerOf(uncommittedMenu), /uncommitted · ±/);
    assert.match(triggerOf(stashMenu), /🗄 stashed work · \{stashN\}/);
    assert.match(triggerOf(reflogMenu), /⏱ recent operations/);
    assert.match(triggerOf(branchMenu), /⎇ branches · \{branchList\?\.length \?\? 0\}/);
  });

  it('keeps the ↻ refresh and "full diff" handlers inside the headers untouched', () => {
    assert.match(triggerOf(uncommittedMenu), /onClick=\{\(e\) => \{ e\.stopPropagation\(\); setRangeDiff\(\{ kind: 'worktree' \}\); \}\}/);
    assert.match(triggerOf(stashMenu), /onClick=\{\(e\) => \{ e\.stopPropagation\(\); fetchStash\(\); \}\}/);
    assert.match(triggerOf(reflogMenu), /onClick=\{\(e\) => \{ e\.stopPropagation\(\); fetchReflog\(\); \}\}/);
    assert.match(triggerOf(branchMenu), /onClick=\{\(e\) => \{ e\.stopPropagation\(\); fetchBranches\(\); \}\}/);
  });

  it('uncommitted header: exact items, worktree range diff, diffstat copy guarded like DiffStatChip', () => {
    const c = contentOf(uncommittedMenu);
    assert.deepStrictEqual(itemLabels(c), ['View full diff', 'Copy diff stat', 'Copy section name']);
    assert.match(c, /<ContextMenuItem onSelect=\{\(\) => setRangeDiff\(\{ kind: 'worktree' \}\)\}>View full diff/);
    assert.match(c, /<ContextMenuSeparator \/>/);
    assert.match(c, /disabled=\{diffstatCopyDisabled\} onSelect=\{\(\) => copyWithToast\(`\+\$\{diffstat\?\.insertions \?\? 0\} −\$\{diffstat\?\.deletions \?\? 0\}`\)\}>Copy diff stat/);
    assert.match(c, /copyWithToast\('uncommitted'\)\}>Copy section name/);
    assert.match(text, /const diffstatCopyDisabled = !diffstat \|\| \(diffstat\.insertions === 0 && diffstat\.deletions === 0\);/);
  });

  it('stash header: refs + subjects joined with "\\n", disabled while loading / error / empty', () => {
    const c = contentOf(stashMenu);
    assert.deepStrictEqual(itemLabels(c), ['Copy stash refs', 'Copy stash subjects', 'Copy section name']);
    assert.match(c, /disabled=\{stashCopyDisabled\} onSelect=\{\(\) => copyWithToast\(\(stashList \?\? \[\]\)\.map\(\(st\) => st\.ref\)\.join\('\\n'\)\)\}>Copy stash refs/);
    assert.match(c, /disabled=\{stashCopyDisabled\} onSelect=\{\(\) => copyWithToast\(\(stashList \?\? \[\]\)\.map\(\(st\) => st\.subject\)\.join\('\\n'\)\)\}>Copy stash subjects/);
    assert.match(c, /copyWithToast\(`stashed work · \$\{stashN\}`\)\}>Copy section name/);
    assert.match(text, /const stashCopyDisabled = stashLoading \|\| !!stashError \|\| !stashList \|\| stashList\.length === 0;/);
  });

  it('reflog header: subjects + non-empty hashes only, disabled while loading / error / empty', () => {
    const c = contentOf(reflogMenu);
    assert.deepStrictEqual(itemLabels(c), ['Copy operations', 'Copy commit hashes', 'Copy section name']);
    assert.match(c, /disabled=\{reflogCopyDisabled\} onSelect=\{\(\) => copyWithToast\(\(reflogList \?\? \[\]\)\.map\(\(op\) => op\.subject\)\.join\('\\n'\)\)\}>Copy operations/);
    assert.match(c, /disabled=\{reflogCopyDisabled\} onSelect=\{\(\) => copyWithToast\(\(reflogList \?\? \[\]\)\.map\(\(op\) => op\.hash\)\.filter\(Boolean\)\.join\('\\n'\)\)\}>Copy commit hashes/);
    assert.match(c, /copyWithToast\('recent operations'\)\}>Copy section name/);
    assert.match(text, /const reflogCopyDisabled = reflogLoading \|\| !!reflogError \|\| !reflogList \|\| reflogList\.length === 0;/);
  });

  it('branches header: names joined with "\\n", disabled while loading / error / empty', () => {
    const c = contentOf(branchMenu);
    assert.deepStrictEqual(itemLabels(c), ['Copy branch names', 'Copy section name']);
    assert.match(c, /disabled=\{branchCopyDisabled\} onSelect=\{\(\) => copyWithToast\(\(branchList \?\? \[\]\)\.map\(\(b\) => b\.name\)\.join\('\\n'\)\)\}>Copy branch names/);
    assert.match(c, /copyWithToast\(`branches · \$\{branchList\?\.length \?\? 0\}`\)\}>Copy section name/);
    assert.match(text, /const branchCopyDisabled = branchLoading \|\| !!branchError \|\| !branchList \|\| branchList\.length === 0;/);
  });

  it('is read-only: no mutating items in any of the four menus', () => {
    for (const m of [uncommittedMenu, stashMenu, reflogMenu, branchMenu]) {
      assert.doesNotMatch(contentOf(m), /checkout|delete|drop|apply|pop|reset/i);
    }
  });

  it('never uses bare navigator.clipboard', () => {
    const code = text.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.doesNotMatch(code, /navigator\.clipboard/);
  });
});
