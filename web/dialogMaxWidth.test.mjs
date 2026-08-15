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

/**
 * The base component's own class string — the text inside the `cn(...)` call in
 * `DialogContent`. Anchored on `fixed top-1/2`, the one stable prefix of that
 * string; if the anchor ever stops matching the read throws rather than silently
 * returning '' and turning the invariants below into tests that pass by finding
 * nothing.
 */
function baseDialogContentClasses() {
  const text = fs.readFileSync(path.join(SRC_DIR, 'components', 'ui', 'dialog.tsx'), 'utf8');
  const match = text.match(/"(fixed top-1\/2[^"]*)"/);
  if (!match) throw new Error('could not locate the base DialogContent class string in dialog.tsx');
  return match[1];
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

/**
 * SECOND CLASS-WIDE INVARIANT over the same component (WARDEN-1006).
 *
 * Fixing the max-w bug above gave FileViewer the 896px panel it declared — and the
 * close X still covered the right ~30% of its "Changes" button, because the panel's
 * WIDTH was never the whole cause. `DialogContent` lays its children out as a grid,
 * and a grid item defaults to `min-width: auto`: it refuses to shrink below its
 * content's min-content size. One wide descendant therefore expands the implicit
 * column track, every sibling stretches to that expanded track, and the toolbar
 * slides out from under the panel — while the `absolute top-2 right-2` close button
 * stays positioned against the correct, unexpanded box. Measured live at 1280px
 * before the fix: dialog right=1088, children right=1506.
 *
 * The same source-scan-vs-unit-test argument as above applies, only harder: this
 * defect is a relationship between a shared component's display mode and the CSS
 * initial value of a property nobody wrote down. There is no module whose logic is
 * wrong, and no front-end DOM runner in this repo to catch the geometry — both
 * guards in this suite were green while the button was unclickable.
 *
 * So, in the same spirit as the invariant above: assert the class-wide enabler is
 * present on the BASE and not removable by a caller. It pins no call site's markup
 * and no individual dialog's spelling.
 */
describe('DialogContent children can shrink below their content (WARDEN-1006)', () => {
  it('the base enables direct-child shrink, covering every call site at once', () => {
    assert.match(
      baseDialogContentClasses(),
      /(^|\s)\*:min-w-0(\s|$)/,
      'the base DialogContent must neutralise its children\'s default `min-width: auto`. '
      + 'Without it one wide descendant expands the layout track, every sibling row '
      + 'stretches with it, and the toolbar slides under the absolutely-positioned '
      + 'close button — clicking a toolbar button closes the dialog instead.',
    );
  });

  it('applies it at the direct-child boundary, so it reaches the flex call site too', () => {
    // ConflictView passes `flex flex-col`, REPLACING the base's `grid`. A track-level
    // grid fix (`grid-cols-[minmax(0,1fr)]`) is inert on a flex container, so a
    // grid-only spelling would leave that call site on `min-width: auto`. The `*:`
    // variant targets the items themselves and is therefore display-mode agnostic.
    const base = baseDialogContentClasses();
    const overridesDisplay = sourceFiles().flatMap(({ file, text }) =>
      file === path.join('components', 'ui', 'dialog.tsx') ? [] : dialogContentTags(text))
      .filter((tag) => /(^|[\s"'`{])(flex|block|inline-\w+|table|contents)([\s"'`}])/.test(tag));
    assert.ok(
      overridesDisplay.length > 0,
      'expected at least one call site to override the base `grid` display — if none '
      + 'does any more, this invariant is over-strict and can be relaxed, but do not '
      + 'delete it without checking',
    );
    assert.match(
      base,
      /(^|\s)\*:min-w-0(\s|$)/,
      `${overridesDisplay.length} call site(s) override the base display mode, so the `
      + 'shrink must be expressed on the CHILDREN (`*:min-w-0`), not on a grid track.',
    );
  });

  it('no caller can silently take it back', () => {
    // tailwind-merge dedupes a caller's class against the base's within the same
    // group and modifier, so a call site passing its own `*:min-w-*` would REPLACE
    // the base's `*:min-w-0` and reinstate the defect for that dialog only.
    const offenders = [];
    for (const { file, text } of sourceFiles()) {
      if (file === path.join('components', 'ui', 'dialog.tsx')) continue;
      for (const tag of dialogContentTags(text)) {
        for (const m of tag.matchAll(/(^|[\s"'`{])(\*:min-w-[^\s"'`}]+)/g)) {
          offenders.push(`${file}: ${m[2]}`);
        }
      }
    }
    assert.deepEqual(
      offenders,
      [],
      'a `*:min-w-*` on a DialogContent call site replaces the base component\'s '
      + '`*:min-w-0` via tailwind-merge, restoring `min-width: auto` on that dialog\'s '
      + 'children and reintroducing the overflow the base fix exists to prevent.',
    );
  });

  it('is actually reading the base class string (guards a silently-empty scan)', () => {
    // Without this, a refactor that moves or reformats the base class string turns
    // every assertion above into a check against '' — reporting safety it never read.
    const base = baseDialogContentClasses();
    assert.match(base, /\bgrid\b/, 'expected the base string to still carry its display mode');
    assert.match(base, /\bsm:max-w-sm\b/, 'expected the base string to still carry its default width');
  });
});

