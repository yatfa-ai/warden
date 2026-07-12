// Source-code highlighting helper for the FileViewer's source-rendering branches
// (WARDEN-281). Mirrors how @/lib/diff factors shared line classification into a
// small standalone module: an extension→language map + a token-tree → per-line
// flattener, both pure and unit-testable, plus a thin Prism-backed wrapper.
//
// The binding constraint (WARDEN-281): highlighting MUST keep one DOM row per
// source line. WARDEN-227's Cmd/Ctrl+click `path:line` jump scrolls to + rings a
// specific line row (FileViewer's `highlightRef`), and WARDEN-205's annotate view
// aligns a blame gutter row-for-row with the source — both collapse if the file is
// rendered as one tokenized blob. So this module returns a PER-LINE list of colored
// "leaf" spans; the caller renders one row per line and drops the leaves inside it.
// Multi-line tokens (a `/* … */` comment, a triple-quoted docstring) are split on
// the newline so a token that spans lines still yields one leaf-row per source line.
//
// Tokenization itself is delegated to Prism (prismjs); this module owns the map,
// the grammar loading (in dependency order), and the flattener.
import Prism from 'prismjs';
// Grammar components register onto the global `Prism` the core import sets up.
// Each may `Prism.languages.extend(<prerequisite>, …)`, so import order is
// load-bearing: an out-of-order import silently leaves a language unregistered,
// which then falls back to plain monospace. `.js` extensions are explicit so the
// bare-specifier resolution works under BOTH Vite (build) and plain Node (the
// headless test, which imports the transpiled module directly). Only the languages
// FileViewer maps are loaded, to keep the bundle small (tree-shaking per the ticket).
import 'prismjs/components/prism-markup.js';
import 'prismjs/components/prism-clike.js';
import 'prismjs/components/prism-css.js';
import 'prismjs/components/prism-javascript.js';
import 'prismjs/components/prism-typescript.js';
import 'prismjs/components/prism-jsx.js';
import 'prismjs/components/prism-tsx.js';
import 'prismjs/components/prism-python.js';
import 'prismjs/components/prism-go.js';
import 'prismjs/components/prism-rust.js';
import 'prismjs/components/prism-bash.js';
import 'prismjs/components/prism-json.js';
import 'prismjs/components/prism-yaml.js';

// A flattened, render-ready token: a CSS `className` (space-joined, `tok-`-prefixed
// Prism types — a leaf can carry a type CHAIN like `tok-string tok-template-string`
// when it sits inside a nested token) and the literal text to render. Splitting the
// source into these leaves per line is what keeps highlighting compatible with a
// one-row-per-line layout.
export interface Leaf {
  className: string;
  value: string;
}

// Minimal Prism Token shape — only the fields the flattener reads. Defined locally
// (and structurally, not via `import type`) so the flattener is unit-testable with a
// plain mock tree and its signature never references Prism's runtime class, which
// keeps the pure logic decoupled from the library's type definitions. `content` can
// be a nested token (Prism sometimes nests one token rather than a single-element
// array) as well as a string or a token array.
export interface SyntaxToken {
  type: string;
  content: string | SyntaxToken | Array<string | SyntaxToken>;
  alias?: string | string[];
}

// Extension → Prism language id. Case-insensitive (so .TS / .PY match). Unknown
// extensions return null → the caller renders plain monospace (never break rendering
// for an unsupported language; WARDEN-281 success criterion #4). Markdown is
// deliberately NOT mapped: WARDEN-266's rendered-docs mode is left untouched, and
// markdown *source* stays plain monospace — this slice only colors code files.
// Every id here has its grammar loaded above; an unmapped-but-listed language would
// gracefully fall back via tokenizeCode's missing-grammar check, but the two are
// kept in sync so the map is an honest statement of what gets colored.
const EXTENSION_TO_LANGUAGE: Record<string, string> = {
  ts: 'typescript', tsx: 'tsx',
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'jsx',
  py: 'python', pyi: 'python',
  go: 'go',
  rs: 'rust',
  sh: 'bash', bash: 'bash', zsh: 'bash', shell: 'bash',
  json: 'json', jsonc: 'json', json5: 'json',
  yml: 'yaml', yaml: 'yaml',
  html: 'markup', htm: 'markup', xml: 'markup', svg: 'markup', mathml: 'markup',
  css: 'css',
};

// Infer the Prism language id from a file path's extension, or null if unsupported.
// Uses the last dot so dotted names like `foo.config.ts` resolve to `typescript`,
// and `Dockerfile` (no dot) resolves to null. Pure → unit-tested directly.
export function languageFromPath(filePath: string): string | null {
  const dot = filePath.lastIndexOf('.');
  if (dot < 0) return null;
  const ext = filePath.slice(dot + 1).toLowerCase();
  return EXTENSION_TO_LANGUAGE[ext] ?? null;
}

// Turn a chain of Prism type names into a deduped, `tok-`-prefixed CSS class string.
// Prism nests tokens (e.g. a `keyword` inside a `function` definition); carrying the
// full ancestor chain onto each leaf mirrors how Prism CSS themes use descendant
// selectors, flattened to one class list so simple `.tok-keyword { … }` rules match
// regardless of nesting.
function chainToClassName(types: readonly string[]): string {
  const seen = new Set<string>();
  let out = '';
  for (const t of types) {
    const cls = 'tok-' + t;
    if (seen.has(cls)) continue;
    seen.add(cls);
    out = out ? out + ' ' + cls : cls;
  }
  return out;
}

function aliasTypes(alias: SyntaxToken['alias']): string[] {
  if (!alias) return [];
  return Array.isArray(alias) ? alias : [alias];
}

// Flatten a Prism token tree into a PER-LINE array of leaves, preserving each
// token's type chain as a CSS class. Newlines inside a token (multi-line comments,
// triple-quoted strings, template literals) are split so each source line becomes
// its own leaf-row — the property WARDEN-227/WARDEN-205 rely on. Pure: takes a token
// list, returns leaves; the only mutable state is the output accumulator, so it is
// unit-testable with a hand-built mock tree (no Prism needed to exercise the
// newline-splitting + class-threading logic).
export function flattenToLines(tokens: ReadonlyArray<string | SyntaxToken>): Leaf[][] {
  const lines: Leaf[][] = [[]];

  // Emit one chunk of (possibly multi-line) text under a type chain, splitting it
  // across line boundaries. Empty chunks contribute nothing but a lone "\n" still
  // opens a new line (the `i > 0` branch), which is how a blank source line yields
  // an empty leaf-row the caller renders as a kept-height space.
  const emit = (types: readonly string[], value: string) => {
    const parts = value.split('\n');
    for (let i = 0; i < parts.length; i++) {
      if (i > 0) lines.push([]);
      if (parts[i] !== '') lines[lines.length - 1].push({ className: chainToClassName(types), value: parts[i] });
    }
  };

  const walk = (toks: ReadonlyArray<string | SyntaxToken>, parentTypes: readonly string[]) => {
    for (const t of toks) {
      if (typeof t === 'string') {
        if (t !== '') emit(parentTypes, t);
        continue;
      }
      const types = [...parentTypes, t.type, ...aliasTypes(t.alias)];
      const content = t.content;
      if (typeof content === 'string') {
        emit(types, content);
      } else if (Array.isArray(content)) {
        walk(content, types);
      } else {
        // Prism sometimes nests a single token directly rather than a 1-element array.
        walk([content], types);
      }
    }
  };

  walk(tokens, []);
  return lines;
}

// Tokenize `code` for `language` into per-line leaves, or null if no Prism grammar is
// registered for that language (→ caller renders plain monospace). The number of
// returned lines always equals `code.split('\n').length` (a trailing newline opens a
// final empty line, matching how the viewer's own `split('\n')` counts rows), so a
// caller indexing leaves by line number stays aligned with its existing line grid.
// Wrapped defensively: a Prism grammar throwing on some pathological input must NEVER
// break the file view — fall back to null (plain monospace) rather than crash render.
export function tokenizeCode(code: string, language: string): Leaf[][] | null {
  const grammar = Prism.languages[language];
  if (!grammar) return null;
  try {
    return flattenToLines(Prism.tokenize(code, grammar) as Array<string | SyntaxToken>);
  } catch {
    return null;
  }
}
