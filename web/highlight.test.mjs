// Tests for the FileViewer source-highlighting helper (WARDEN-281): the
// extension→language map, the pure token-tree → per-line flattener, and the
// Prism-backed tokenizeCode wrapper.
//
// No front-end test runner in this repo, so (like diff.test.mjs) this loads the
// REAL src/lib/highlight.ts (transpiled TS -> ESM via Vite's OXC transform) and
// exercises it directly. That module imports `prismjs`, so the transpiled file is
// written INSIDE web/ (not os.tmpdir) — bare-specifier resolution then walks up to
// web/node_modules/prismjs, the same way Vite resolves it for the bundle. (This is
// the one difference from the import-free lib tests.)
//
// What MUST hold for WARDEN-281:
//  - the map infers the right language from an extension; unknown → null (plain
//    monospace fallback, never a broken render);
//  - flattenToLines splits a token tree on newlines so one source line → one
//    leaf-row (the property WARDEN-227's line-jump + WARDEN-205's blame gutter
//    depend on), threading each token's type chain into a CSS class;
//  - tokenizeCode emits distinct token classes for keywords / strings / comments /
//    numbers across the mapped languages, and returns null for an unmapped grammar;
//  - the leaf-row count always equals code.split('\n').length so indexing by line
//    number stays aligned with the viewer's existing line grid.
//
// Run: node highlight.test.mjs   (or: npm test, from web/)
import { transformWithOxc } from 'vite';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const highlightPath = resolve(__dirname, 'src/lib/highlight.ts');

// --- Load the REAL highlight.ts (TS -> ESM via the OXC transform Vite bundles) ----
const src = readFileSync(highlightPath, 'utf8');
const { code } = await transformWithOxc(src, highlightPath, {});
// Written under web/ (not os.tmpdir) so the module's `import Prism from 'prismjs'`
// + grammar side-effect imports resolve from web/node_modules.
const tmpDir = mkdtempSync(join(__dirname, '.tmp-highlight-test-'));
const tmpFile = join(tmpDir, 'highlight.mjs');
writeFileSync(tmpFile, code);
let mod;
try {
  mod = await import(pathToFileURL(tmpFile).href);
} finally {
  rmSync(tmpDir, { recursive: true, force: true });
}
const { languageFromPath, flattenToLines, tokenizeCode } = mod;

let passed = 0;
const test = (name, fn) => {
  fn();
  passed += 1;
  console.log('  ok -', name);
};

// All distinct CSS classes across a tokenizeCode result, for "emits a class" checks.
const allClasses = (leafLines) => {
  const set = new Set();
  for (const line of leafLines) for (const lf of line) for (const c of lf.className.split(' ')) set.add(c);
  return set;
};
const hasClass = (leafLines, cls) => allClasses(leafLines).has(cls);

// --- languageFromPath: extension → language ------------------------------------
console.log('\nlanguageFromPath: extension → language');
test('.ts → typescript', () => assert.equal(languageFromPath('src/lib/highlight.ts'), 'typescript'));
test('.tsx → tsx', () => assert.equal(languageFromPath('ui/Button.tsx'), 'tsx'));
test('.js/.mjs/.cjs → javascript', () => {
  assert.equal(languageFromPath('a.js'), 'javascript');
  assert.equal(languageFromPath('b.mjs'), 'javascript');
  assert.equal(languageFromPath('c.cjs'), 'javascript');
});
test('.py/.pyi → python', () => {
  assert.equal(languageFromPath('app.py'), 'python');
  assert.equal(languageFromPath('stub.pyi'), 'python');
});
test('code langs map through', () => {
  assert.equal(languageFromPath('main.go'), 'go');
  assert.equal(languageFromPath('lib.rs'), 'rust');
  assert.equal(languageFromPath('run.sh'), 'bash');
  assert.equal(languageFromPath('data.json'), 'json');
  assert.equal(languageFromPath('config.yml'), 'yaml');
  assert.equal(languageFromPath('config.YAML'), 'yaml'); // case-insensitive
});
test('dotted name resolves last extension (foo.config.ts → typescript)', () =>
  assert.equal(languageFromPath('foo.config.ts'), 'typescript'));
test('unknown extension → null (plain fallback)', () =>
  assert.equal(languageFromPath('notes.txt'), null));
test('no extension → null (Dockerfile stays plain)', () =>
  assert.equal(languageFromPath('Dockerfile'), null));
test('markdown is NOT mapped (WARDEN-266 rendered mode left untouched)', () =>
  assert.equal(languageFromPath('README.md'), null));

// --- flattenToLines: pure token-tree → per-line leaves -------------------------
console.log('\nflattenToLines: newline split + class threading (mock tree, no Prism)');
test('a multi-line comment token splits into one leaf-row per line', () => {
  const lines = flattenToLines([{ type: 'comment', content: '/* a\nb\nc */' }]);
  assert.equal(lines.length, 3);
  assert.equal(lines[0][0].className, 'tok-comment'); assert.equal(lines[0][0].value, '/* a');
  assert.equal(lines[1][0].className, 'tok-comment'); assert.equal(lines[1][0].value, 'b');
  assert.equal(lines[2][0].className, 'tok-comment'); assert.equal(lines[2][0].value, 'c */');
});
test('plain text between tokens with a "\n" opens a new leaf-row', () => {
  const lines = flattenToLines([
    { type: 'keyword', content: 'a' }, '\n', { type: 'number', content: '1' },
  ]);
  assert.equal(lines.length, 2);
  assert.equal(lines[0][0].className, 'tok-keyword');
  assert.equal(lines[1][0].className, 'tok-number');
});
test('a nested token carries its ancestor type chain (deduped)', () => {
  // Prism nests a token inside a same-typed token; the leaf should carry one chain.
  const lines = flattenToLines([{ type: 'function', content: [{ type: 'function', content: 'add' }] }]);
  assert.equal(lines[0][0].className, 'tok-function');
  assert.equal(lines[0][0].value, 'add');
});
test('an alias becomes an extra class on the leaf', () => {
  const lines = flattenToLines([{ type: 'keyword', alias: 'control', content: 'if' }]);
  assert.equal(lines[0][0].className, 'tok-keyword tok-control');
});
test('empty input → one empty leaf-row (kept-height blank line)', () => {
  const lines = flattenToLines([]);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].length, 0);
});

// --- tokenizeCode: real Prism grammars emit distinct token classes -------------
console.log('\ntokenizeCode: real grammars color keywords/strings/comments/numbers');
test('TypeScript: keyword, string, comment, number all present', () => {
  const lines = tokenizeCode(`// header\nconst x = "hi";\nfunction add(a: number) { return a + 1; }`, 'typescript');
  assert.ok(hasClass(lines, 'tok-comment'), 'emits tok-comment');
  assert.ok(hasClass(lines, 'tok-keyword'), 'emits tok-keyword (const/function/return)');
  assert.ok(hasClass(lines, 'tok-string'), 'emits tok-string ("hi")');
  assert.ok(hasClass(lines, 'tok-number'), 'emits tok-number (1)');
});
test('Python: docstring (triple-quoted-string), keyword (def), and # comment all present', () => {
  const lines = tokenizeCode('"""doc"""\ndef f():\n  return 1  # note\n', 'python');
  assert.ok(hasClass(lines, 'tok-triple-quoted-string'), 'docstring colored as a string');
  assert.ok(hasClass(lines, 'tok-keyword'), 'def/return colored as keyword');
  assert.ok(hasClass(lines, 'tok-comment'), '# comment colored as comment');
});
test('JSON: object keys (property), numbers, and strings all present', () => {
  const lines = tokenizeCode('{"a": 1, "b": "x"}', 'json');
  assert.ok(hasClass(lines, 'tok-property'), 'key colored as property');
  assert.ok(hasClass(lines, 'tok-number'), 'number colored');
  assert.ok(hasClass(lines, 'tok-string'), 'string value colored');
});
test('YAML: keys and numbers present', () => {
  const lines = tokenizeCode('name: ward\nport: 7421\n', 'yaml');
  assert.ok(hasClass(lines, 'tok-key'), 'yaml key colored');
  assert.ok(hasClass(lines, 'tok-number'), 'yaml number colored');
});
test('Bash: string and keyword present', () => {
  const lines = tokenizeCode('#!/bin/bash\necho "hi"\nfor x in a; do true; done\n', 'bash');
  assert.ok(hasClass(lines, 'tok-string'), 'echo arg colored as string');
  assert.ok(hasClass(lines, 'tok-keyword'), 'for/do colored as keyword');
});
test('Go: keyword and function present', () => {
  const lines = tokenizeCode('package main\nfunc add(a int) int { return a }\n', 'go');
  assert.ok(hasClass(lines, 'tok-keyword'), 'package/func/return colored as keyword');
  assert.ok(hasClass(lines, 'tok-function'), 'func name colored as function');
});
test('unmapped language → null (caller renders plain monospace)', () =>
  assert.equal(tokenizeCode('whatever', 'cobol'), null));
test('grammar-not-loaded language → null (graceful plain fallback)', () =>
  assert.equal(tokenizeCode('x', 'rust-never-loaded'), null));

// --- the line-grid invariant the viewer's index alignment relies on ------------
console.log('\nline-grid invariant: leaf-rows === code.split("\\n").length');
for (const [code, lang] of [
  ['const a = 1;', 'javascript'],
  ['line1\nline2\nline3', 'typescript'],
  ['trailing newline\n', 'javascript'],   // trailing \n opens a final empty row
  ['', 'javascript'],                      // empty → one row
  ['no newline at end', 'python'],
]) {
  test(`row count matches split for ${lang} (${JSON.stringify(code).slice(0, 24)}…)`, () =>
    assert.equal(tokenizeCode(code, lang).length, code.split('\n').length));
}

// --- multi-line comment stays colored on every line it spans -------------------
console.log('\nmulti-line tokens stay colored across lines (keeps row grid + color)');
test('a /* multi\\nline\\ncomment */ colors all three of its lines as comments', () => {
  const lines = tokenizeCode('/* multi\nline\ncomment */\nconst y = 2;', 'javascript');
  assert.equal(lines.length, 4);
  assert.equal(lines[0][0].className, 'tok-comment');
  assert.equal(lines[1][0].className, 'tok-comment');
  assert.equal(lines[2][0].className, 'tok-comment');
});

console.log(`\n✓ HIGHLIGHT TESTS PASS (${passed})`);
