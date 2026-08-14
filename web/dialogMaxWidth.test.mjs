import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * STATIC SOURCE GUARD for DialogContent width overrides (WARDEN-1001).
 *
 * WHY THIS FILE EXISTS: the base `DialogContent` (web/src/components/ui/dialog.tsx)
 * carries `sm:max-w-sm` in its own class string. `tailwind-merge` cannot dedupe a
 * modifier-prefixed class against an unprefixed one, so a caller passing a bare
 * `max-w-4xl` ships BOTH classes; at equal specificity the bundle's source order
 * lets `sm:max-w-sm` win at every viewport >= 640px. The caller's declared width
 * is silently discarded and the dialog renders at 384px.
 *
 * The realized consequence was not merely "a narrow panel": in FileViewer the
 * toolbar overflowed the 384px panel and the absolutely-positioned close X landed
 * on top of the "Changes" button, so clicking Changes CLOSED the viewer. The
 * WARDEN-786 Changes view was unreachable by mouse for a month.
 *
 * No test in this suite could see that. web/fileViewerChanges.test.mjs drives the
 * pure `classifyChangesView` seam and passes green while the button it guards is
 * unclickable, because this repo has no front-end DOM test runner and a geometry
 * overlap is invisible without one. The defect is not in any module's LOGIC — it
 * is in the relationship between a caller's class string and the base component's,
 * which is exactly what a source scan can see and a unit test cannot.
 *
 * So this asserts a CLASS-WIDE INVARIANT over every DialogContent call site: no
 * caller passes an unprefixed `max-w-*`. It deliberately pins no individual call
 * site's spelling (the anti-pattern rejected in WARDEN-994) — it stays green under
 * rename, reformat, or a caller changing 4xl to 5xl, and fails only when someone
 * reintroduces the defect class.
 */

const SRC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'src');

/** Every .tsx/.ts source under web/src, recursively. */
function sourceFiles(dir = SRC_DIR) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    if (!/\.tsx?$/.test(entry.name)) return [];
    return [{ file: path.relative(SRC_DIR, full), text: fs.readFileSync(full, 'utf8') }];
  });
}

/**
 * Text of every `<DialogContent ...>` opening tag.
 *
 * Scans to the tag-closing `>` while tracking brace/quote depth, so a `>` inside
 * a prop expression (`onOpenAutoFocus={(e) => e.preventDefault()}` — present on
 * four real call sites) does not truncate the tag early and hide a class after it.
 */
function dialogContentTags(text) {
  const tags = [];
  const re = /<DialogContent\b/g;
  for (const match of text.matchAll(re)) {
    let depth = 0;
    let quote = null;
    for (let i = match.index; i < text.length; i++) {
      const ch = text[i];
      if (quote) {
        if (ch === quote) quote = null;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === '`') quote = ch;
      else if (ch === '{') depth++;
      else if (ch === '}') depth--;
      else if (ch === '>' && depth === 0) {
        tags.push(text.slice(match.index, i + 1));
        break;
      }
    }
  }
  return tags;
}

/**
 * Unprefixed `max-w-*` classes in a tag. A class is prefixed when it carries any
 * modifier (`sm:`, `dark:`, `group-hover:`, ...) — only those beat the base's own
 * `sm:max-w-sm`, so only those actually apply the caller's intent.
 */
function unprefixedMaxWidths(tag) {
  return [...tag.matchAll(/(^|[\s"'`{])(max-w-[^\s"'`}]+)/g)].map((m) => m[2]);
}

describe('DialogContent width overrides survive tailwind-merge (WARDEN-1001)', () => {
  it('never passes an unprefixed max-w-* to DialogContent', () => {
    const offenders = [];
    for (const { file, text } of sourceFiles()) {
      // The base component itself legitimately owns an unprefixed
      // `max-w-[calc(100%-2rem)]` mobile clamp; the invariant is about CALLERS.
      if (file === path.join('components', 'ui', 'dialog.tsx')) continue;
      for (const tag of dialogContentTags(text)) {
        for (const cls of unprefixedMaxWidths(tag)) {
          offenders.push(`${file}: ${cls}`);
        }
      }
    }
    assert.deepEqual(
      offenders,
      [],
      'an unprefixed max-w-* on DialogContent is silently overridden by the base '
      + "component's own `sm:max-w-sm`, so the dialog renders at 384px no matter what "
      + 'width it declares — and a too-narrow dialog overflows its toolbar under the '
      + 'absolutely-positioned close button. Prefix it (e.g. `sm:max-w-4xl`) so '
      + 'tailwind-merge can actually replace the base class.',
    );
  });

  it('is actually scanning call sites (guards against a silently-empty scan)', () => {
    // Without this, any future refactor that breaks the scanner — a renamed
    // import alias, a moved src dir — turns the invariant above into a test that
    // passes by finding nothing, reporting safety it never checked.
    const tags = sourceFiles().flatMap(({ file, text }) =>
      file === path.join('components', 'ui', 'dialog.tsx') ? [] : dialogContentTags(text));
    assert.ok(
      tags.length >= 5,
      `expected the scanner to find DialogContent call sites, found ${tags.length}`,
    );
    assert.ok(
      tags.some((t) => /\bsm:max-w-/.test(t)),
      'expected at least one call site to carry a prefixed max-w-*, proving the tag '
      + 'text reaches the className and the invariant above is testing something',
    );
  });

  it('reads past a `>` inside a prop expression', () => {
    // Four real call sites pass `onOpenAutoFocus={(e) => e.preventDefault()}`
    // BEFORE nothing, but a naive first-`>` scan would stop at the arrow and miss
    // any class following it. Pin the scanner's behaviour, not the call sites.
    const tags = dialogContentTags(
      '<DialogContent onOpenAutoFocus={(e) => e.preventDefault()} className="max-w-4xl">',
    );
    assert.equal(tags.length, 1);
    assert.deepEqual(unprefixedMaxWidths(tags[0]), ['max-w-4xl']);
  });

  it('does not flag a prefixed max-w-*', () => {
    const tags = dialogContentTags('<DialogContent className="sm:max-w-4xl max-h-[80vh]">');
    assert.deepEqual(unprefixedMaxWidths(tags[0]), []);
  });
});
