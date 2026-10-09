import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * STATIC SOURCE GUARD for the recent / unpushed / incoming commit-list SECTION-HEADER
 * right-click menus (WARDEN-1707), in the style of gitListRowsContextMenu.test.mjs.
 * No front-end DOM runner exists, so "right-click opens the themed menu" is verified
 * live; here each test names the SOURCE property it checks: which element each trigger
 * wraps, the exact items, copy payloads, disabled guards, range-diff kinds, and that no
 * bare navigator.clipboard is used.
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
const HEADER_DIV = '<div className="mb-1 flex items-center justify-between gap-2 px-0.5">';

const recentMenu = between('<ContextMenu>\n            <ContextMenuTrigger asChild>\n              ' + HEADER_DIV, '</ContextMenu>');
const outMenu = between("<ContextMenu>\n                <ContextMenuTrigger asChild>\n                  " + HEADER_DIV + '\n                    <span className="text-[10px] font-medium text-amber-400">', '</ContextMenu>');
const incMenu = between("<ContextMenu>\n                <ContextMenuTrigger asChild>\n                  " + HEADER_DIV + '\n                    <span className="text-[10px] font-medium text-blue-400">', '</ContextMenu>');

const triggerOf = (m) => element(m, 'ContextMenuTrigger');
const contentOf = (m) => element(m, 'ContextMenuContent');
const itemLabels = (content) => [...content.matchAll(/>([^<>{}]+)<\/ContextMenuItem>/g)].map((x) => x[1]);

describe('GitRepoDetails commit-list section headers declare themed context menus (WARDEN-1707)', () => {
  it('declares three header triggers on top of the pre-existing five <ContextMenuTrigger asChild> row/file ones', () => {
    assert.strictEqual((text.match(/<ContextMenuTrigger asChild>/g) || []).length, 8);
  });

  it('wraps ONLY the header div in each trigger — never the list, so CommitRow keeps its own menu', () => {
    for (const m of [recentMenu, outMenu, incMenu]) {
      const t = triggerOf(m).trim();
      assert.ok(t.startsWith(HEADER_DIV), 'trigger child must be the header div');
      assert.doesNotMatch(t, /<ul\b/);
      assert.doesNotMatch(t, /<CommitRow/);
    }
    assert.match(triggerOf(recentMenu), /recent commits ·/);
    assert.match(triggerOf(outMenu), /unpushed · ↑ \{aheadCount\} ahead/);
    assert.match(triggerOf(incMenu), /incoming · ↓ \{behindCount\} behind/);
  });

  it('keeps the ↻ refresh and "full diff" buttons inside the headers untouched (asChild, no handler change)', () => {
    assert.match(triggerOf(recentMenu), /onFetch\?\.\(\); if \(behindCount > 0\) onFetchIncoming\?\.\(\); if \(aheadCount > 0\) onFetchOutgoing\?\.\(\);/);
    assert.match(triggerOf(outMenu), /onClick=\{\(e\) => \{ e\.stopPropagation\(\); setRangeDiff\(\{ kind: 'outgoing', count: aheadCount \}\); \}\}/);
    assert.match(triggerOf(incMenu), /onClick=\{\(e\) => \{ e\.stopPropagation\(\); setRangeDiff\(\{ kind: 'incoming', count: behindCount \}\); \}\}/);
  });

  it('unpushed header: exact items, same outgoing range diff, copy payloads from outList', () => {
    const c = contentOf(outMenu);
    assert.deepStrictEqual(itemLabels(c), ['View full diff', 'Copy commit hashes', 'Copy commit subjects', 'Copy section name']);
    assert.match(c, /<ContextMenuItem onSelect=\{\(\) => setRangeDiff\(\{ kind: 'outgoing', count: aheadCount \}\)\}>View full diff/);
    assert.match(c, /<ContextMenuSeparator \/>/);
    assert.match(c, /disabled=\{listCopyDisabled\(outList\)\} onSelect=\{\(\) => copyWithToast\(hashesOf\(outList\)\)\}>Copy commit hashes/);
    assert.match(c, /disabled=\{listCopyDisabled\(outList\)\} onSelect=\{\(\) => copyWithToast\(subjectsOf\(outList\)\)\}>Copy commit subjects/);
    assert.match(c, /copyWithToast\(`unpushed · ↑ \$\{aheadCount\} ahead`\)\}>Copy section name/);
  });

  it('incoming header: exact items, same incoming range diff, copy payloads from incList', () => {
    const c = contentOf(incMenu);
    assert.deepStrictEqual(itemLabels(c), ['View full diff', 'Copy commit hashes', 'Copy commit subjects', 'Copy section name']);
    assert.match(c, /<ContextMenuItem onSelect=\{\(\) => setRangeDiff\(\{ kind: 'incoming', count: behindCount \}\)\}>View full diff/);
    assert.match(c, /<ContextMenuSeparator \/>/);
    assert.match(c, /disabled=\{listCopyDisabled\(incList\)\} onSelect=\{\(\) => copyWithToast\(hashesOf\(incList\)\)\}>Copy commit hashes/);
    assert.match(c, /disabled=\{listCopyDisabled\(incList\)\} onSelect=\{\(\) => copyWithToast\(subjectsOf\(incList\)\)\}>Copy commit subjects/);
    assert.match(c, /copyWithToast\(`incoming · ↓ \$\{behindCount\} behind`\)\}>Copy section name/);
  });

  it('recent header: hashes + subjects from `recent`, branch / detached-HEAD item mirrors the span, no section name or range diff', () => {
    const c = contentOf(recentMenu);
    assert.deepStrictEqual(itemLabels(c), ['Copy commit hashes', 'Copy commit subjects', 'Copy HEAD commit', 'Copy branch name']);
    assert.match(c, /disabled=\{listCopyDisabled\(recent\)\} onSelect=\{\(\) => copyWithToast\(hashesOf\(recent\)\)\}>Copy commit hashes/);
    assert.match(c, /disabled=\{listCopyDisabled\(recent\)\} onSelect=\{\(\) => copyWithToast\(subjectsOf\(recent\)\)\}>Copy commit subjects/);
    assert.match(c, /isDetached \? \(sha && <ContextMenuItem onSelect=\{\(\) => copyWithToast\(sha\)\}>Copy HEAD commit<\/ContextMenuItem>\) : \(branch && <ContextMenuItem onSelect=\{\(\) => copyWithToast\(branch\)\}>Copy branch name/);
    assert.doesNotMatch(c, /Copy section name/);
    assert.doesNotMatch(c, /setRangeDiff/);
  });

  it('copy helpers join the SAME resolved lists with "\\n" and disable on loading / error / empty', () => {
    assert.match(text, /const hashesOf = \(l: \{ items\?: GitCommit\[\] \}\) => \(l\.items \?\? \[\]\)\.map\(\(cm\) => cm\.hash\)\.join\('\\n'\);/);
    assert.match(text, /const subjectsOf = \(l: \{ items\?: GitCommit\[\] \}\) => \(l\.items \?\? \[\]\)\.map\(\(cm\) => cm\.subject\)\.join\('\\n'\);/);
    assert.match(text, /l\.loading \|\| !!l\.error \|\| !l\.items \|\| l\.items\.length === 0/);
    assert.match(text, /const recent = listFor\(/);
    assert.match(text, /const outList = listFor\('outgoing'/);
    assert.match(text, /const incList = listFor\('incoming'/);
  });

  it('never uses bare navigator.clipboard', () => {
    const code = text.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.doesNotMatch(code, /navigator\.clipboard/);
  });
});
