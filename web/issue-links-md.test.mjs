// Tests for remarkIssueLinks / unambiguousPrefixEntries — the markdown issue-key
// linkifier behind WARDEN-1394 (slice 2 of roadmap WARDEN-1386).
//
// Same harness as issue-links.test.mjs (no front-end test runner in this repo):
// load the REAL src/lib modules (transpiled TS -> ESM via Vite's OXC transform)
// and exercise them directly — over trees parsed by the REAL remark-parse (the
// parser react-markdown runs), so the pins cover the full parse → transform
// recognition half: which mdast text/inlineCode nodes become links, what URL
// each carries, what never linkifies (fenced blocks, existing links, ambiguous
// prefixes), and fleet-level scoping (unambiguousPrefixEntries). The shared
// `a:` renderer's click contract (openExternalUrl) and the prop threading are
// integration concerns verified live (as with slice 1); the STATIC SOURCE GUARD
// legs at the bottom pin that wiring so reverting the plugin registration turns
// this file red.
//
// Run: node issue-links-md.test.mjs   (or: npm test, from web/)
import { transformWithOxc } from 'vite';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { unified } from 'unified';
import remarkParse from 'remark-parse';

const __dirname = dirname(fileURLToPath(import.meta.url));
const libDir = resolve(__dirname, 'src/lib');

// --- Load the REAL modules (TS -> ESM via the OXC transform Vite bundles) ----
// remarkIssueLinks.ts imports ./issue-links, so transpile both and point the
// OUTPUT import at the transpiled sibling (the same dance path-links.test.mjs
// uses — applied to the transpiled output, because OXC's TS resolution may
// rewrite a source-level `.mjs` specifier back to extensionless; the output is
// plain ESM, so a verbatim replace there is deterministic).
const tmpDir = mkdtempSync(join(tmpdir(), 'warden-issuelinks-md-test-'));
const transpile = async (name) => {
  const src = readFileSync(join(libDir, name), 'utf8');
  const { code } = await transformWithOxc(src, join(libDir, name), {});
  const out = join(tmpDir, name.replace(/\.ts$/, '.mjs'));
  writeFileSync(out, code.replace(/from ['"]\.\/issue-links['"]/, 'from "./issue-links.mjs"'));
  return import(out);
};
const issueLinks = await transpile('issue-links.ts');
const { remarkIssueLinks, ISSUE_LINK_MARKER } = await transpile('remarkIssueLinks.ts');
rmSync(tmpDir, { recursive: true, force: true });

const parser = unified().use(remarkParse);
let passed = 0;
const test = (name, fn) => {
  fn();
  passed += 1;
  console.log('  ok -', name);
};

// The fixture mapping: two unique prefixes and one prefix deliberately mapped
// under TWO projects (the ambiguity case markdown surfaces must stay silent on).
const ENTRIES = [
  { project: 'warden', prefix: 'WARDEN', tracker: 'github.com/acme/warden/issues' },
  { project: 'ops', prefix: 'OPS', tracker: 'ops.internal:8443/browse' },
  { project: 'a', prefix: 'DUP', tracker: 'a.example/DUP' },
  { project: 'b', prefix: 'DUP', tracker: 'b.example/DUP' },
];
const FLEET = issueLinks.unambiguousPrefixEntries(ENTRIES);

// Parse markdown with the real remark-parse, run the plugin, return the tree.
const run = (md, entries = FLEET) => {
  const tree = parser.parse(md);
  remarkIssueLinks(entries)(tree);
  return tree;
};

// Every link node in the tree, depth-first.
const findLinks = (node, out = []) => {
  if (!node || typeof node !== 'object') return out;
  if (node.type === 'link') out.push(node);
  if (Array.isArray(node.children)) for (const c of node.children) findLinks(c, out);
  return out;
};
const linksOf = (md, entries) => findLinks(run(md, entries));
const keysOf = (md, entries) => linksOf(md, entries).map((l) => l.children[0]?.value);

console.log('\nfleet-level scoping — unambiguousPrefixEntries');
test('a prefix mapped under two projects is dropped entirely', () => {
  assert.deepEqual(FLEET.map((e) => e.prefix).sort(), ['OPS', 'WARDEN']);
});
test('a prefix mapped once survives with its own entry', () => {
  const warden = FLEET.find((e) => e.prefix === 'WARDEN');
  assert.equal(warden.project, 'warden');
  assert.equal(warden.tracker, 'github.com/acme/warden/issues');
});
test('empty input yields empty output', () => {
  assert.deepEqual(issueLinks.unambiguousPrefixEntries([]), []);
});

console.log('\nrecognition — prose keys become links (same matcher as the terminal)');
test('a plain key mid-sentence becomes one link with the tracker URL', () => {
  const [link] = linksOf('fix landed in WARDEN-1385 today');
  assert.equal(link.url, 'https://github.com/acme/warden/issues/WARDEN-1385');
  assert.deepEqual(link.children.map((c) => c.value), ['WARDEN-1385']);
  assert.equal(link.children[0].type, 'text');
});
test('the minted link carries the data-issue-link marker', () => {
  const [link] = linksOf('see WARDEN-1385');
  assert.equal(link.data.hProperties[ISSUE_LINK_MARKER], 'WARDEN-1385');
});
test('multiple keys on one line are independent links with surrounding text preserved', () => {
  const tree = run('WARDEN-1 then OPS-7 done');
  assert.deepEqual(findLinks(tree).map((l) => l.url), [
    'https://github.com/acme/warden/issues/WARDEN-1',
    'https://ops.internal:8443/browse/OPS-7',
  ]);
  const para = tree.children[0].children
    .map((n) => (n.type === 'link' ? n.children[0].value : n.value))
    .join('');
  assert.equal(para, 'WARDEN-1 then OPS-7 done', 'no character of the original text is lost');
});
test('a key at start or end of line is recognized', () => {
  assert.deepEqual(keysOf('WARDEN-1 is at the start'), ['WARDEN-1']);
  assert.deepEqual(keysOf('at the end: WARDEN-42'), ['WARDEN-42']);
});
test('punctuation-trim parity: the terminal matcher and the markdown link agree on the key span', () => {
  for (const line of [
    'see (WARDEN-1385).',
    '"WARDEN-1385", ok',
    '`WARDEN-1385` in prose backticks',
    '[WARDEN-1385] bracketed',
  ]) {
    const expected = issueLinks
      .findIssueCandidates(line, FLEET)
      .map((c) => line.slice(c.start, c.start + c.length));
    assert.deepEqual(keysOf(line), expected, `parity on: ${line}`);
  }
});
test('punctuation around a key stays as plain text outside the anchor', () => {
  const para = run('see (WARDEN-1385).').children[0].children;
  assert.equal(para[0].type, 'text');
  assert.equal(para[0].value, 'see (');
  assert.equal(para[1].type, 'link');
  assert.equal(para[2].value, ').');
});

console.log('\nstrictness — what never linkifies');
test('an unconfigured prefix stays plain text', () => {
  assert.deepEqual(keysOf('YATFA-1234 is another project'), []);
  assert.deepEqual(findLinks(run('YATFA-1234 is another project')), []);
});
test('a key inside a bigger word never linkifies (whole-token anchoring)', () => {
  assert.deepEqual(keysOf('XWARDEN-1385 and WARDEN-1385.tsx stay plain'), []);
});
test('an ambiguous prefix (mapped under two projects) links nowhere on markdown surfaces', () => {
  assert.deepEqual(keysOf('ref DUP-9 for details'), []);
});
test('fenced code blocks never linkify', () => {
  const tree = run('prose WARDEN-1 here\n\n```\nWARDEN-1385 inside fenced\n```\n\nmore WARDEN-2 prose');
  const keys = findLinks(tree).map((l) => l.children[0].value);
  assert.deepEqual(keys.sort(), ['WARDEN-1', 'WARDEN-2'], 'only the prose keys linkified');
  const codeNode = tree.children.find((n) => n.type === 'code');
  assert.equal(codeNode.value, 'WARDEN-1385 inside fenced', 'fenced content untouched');
});
test('text inside an EXISTING markdown link is never re-linkified', () => {
  const tree = run('[jump to WARDEN-1385](https://example.com)');
  const [existing] = findLinks(tree);
  assert.equal(existing.url, 'https://example.com', 'the author-chosen destination stands');
  assert.equal(existing.children[0].type, 'text');
  assert.equal(existing.children[0].value, 'jump to WARDEN-1385', 'plain text inside, no nested link');
});
test('inline code spans linkify only when the WHOLE span is exactly one key', () => {
  const [link] = linksOf('run `WARDEN-1385` to repro');
  assert.equal(link.url, 'https://github.com/acme/warden/issues/WARDEN-1385');
  assert.equal(link.children[0].type, 'inlineCode', 'the code node is preserved inside the anchor');
  assert.equal(link.children[0].value, 'WARDEN-1385');
});
test('an inline code span with any other content stays literal code', () => {
  const tree = run('`see WARDEN-1385` and `WARDEN-1385 extra` and `WARDEN-1385.` stay code');
  assert.deepEqual(findLinks(tree), []);
  const codes = [];
  const walk = (n) => { if (n?.type === 'inlineCode') codes.push(n.value); n?.children?.forEach(walk); };
  walk(tree);
  assert.deepEqual(codes.sort(), ['WARDEN-1385 extra', 'WARDEN-1385.', 'see WARDEN-1385']);
});

console.log('\nstructure — the walk reaches every phrasing context');
test('keys inside headings, list items, blockquotes and emphasis linkify', () => {
  const md = [
    '## heading WARDEN-10',
    '',
    '- list item WARDEN-11',
    '',
    '> quoted WARDEN-12',
    '',
    'really **bold WARDEN-13** move',
    '',
    '| col |',
    '| --- |',
    '| table WARDEN-14 |',
  ].join('\n');
  assert.deepEqual(
    keysOf(md).map((k) => Number(k.slice('WARDEN-'.length))),
    [10, 11, 12, 13, 14],
  );
});

console.log('\noff-by-default — the empty/absent-entries contract');
test('empty entries produce zero link nodes: the tree is left exactly as parsed', () => {
  const md = 'see WARDEN-1385 and `OPS-7` today';
  const expected = JSON.stringify(parser.parse(md));
  const actual = JSON.stringify(run(md, []));
  assert.equal(actual, expected, 'byte-identical tree with the plugin registered but no entries');
});
test('the plugin factory with zero entries is a registered no-op', () => {
  const tree = parser.parse('WARDEN-1385');
  remarkIssueLinks([])(tree);
  assert.deepEqual(findLinks(tree), []);
});

console.log('\nstatic source guard — MarkdownBody/App wiring (mutation check)');
// lastCloseGuard.test.mjs precedent: a source scan can see a wiring
// relationship a unit test over pure helpers cannot. Reverting the plugin
// registration, the click contract, or the off-by-default gate turns these RED.
const mbSrc = readFileSync(resolve(__dirname, 'src/components/MarkdownBody.tsx'), 'utf8');
const appSrc = readFileSync(resolve(__dirname, 'src/App.tsx'), 'utf8');

test('MarkdownBody declares the issueEntries prop', () => {
  assert.ok(/issueEntries\?: IssueLinkEntry\[\]/.test(mbSrc), 'prop declared in MarkdownBody');
});
test('MarkdownBody registers the plugin ONLY when entries are non-empty', () => {
  assert.ok(
    /\[\s*remarkGfm,\s*\[remarkIssueLinks,\s*issueEntries\]\s*\]/.test(mbSrc),
    'tuple form [remarkIssueLinks, issueEntries] registered',
  );
  // and the OFF branch stays [remarkGfm] — no plugin, byte-identical rendering
  assert.ok(/:\s*\[remarkGfm\]/.test(mbSrc), 'empty/absent entries keep the plain remarkGfm list');
});
test('the a: renderer routes marked links to openExternalUrl (system browser)', () => {
  const markerIdx = mbSrc.indexOf(`ISSUE_LINK_MARKER in node.properties`);
  assert.notEqual(markerIdx, -1, 'the marker check is findable in the a: renderer');
  const branch = mbSrc.slice(markerIdx, markerIdx + 600);
  assert.ok(/openExternalUrl\(href\)/.test(branch), 'the branch calls openExternalUrl');
  assert.ok(/e\.preventDefault\(\)/.test(branch), 'the branch preventDefaults the in-app navigation');
  assert.ok(/href=\{href\}/.test(branch), 'href is kept for copy-link');
});
test('App gates the markdown entries on the integration toggle (off by default)', () => {
  assert.ok(
    /displaySettings\.issueLinksEnabled\s*\n\s*\?\s*unambiguousPrefixEntries\(issueLinkTrackers\)/.test(appSrc),
    'markdownIssueEntries = enabled ? unambiguousPrefixEntries(trackers) : []',
  );
});
test('App threads markdownIssueEntries to the three fleet-level mounts', () => {
  for (const mount of ['<ObserverTabs', '<SessionTranscriptViewer', '<OpenChatBrowserPage']) {
    const at = appSrc.indexOf(mount);
    assert.notEqual(at, -1, `${mount} mount findable`);
    assert.ok(/issueEntries=\{markdownIssueEntries\}/.test(appSrc.slice(at, at + 1600)), `${mount} passes issueEntries`);
  }
});

console.log(`\n${passed} markdown issue-links assertions passed`);
