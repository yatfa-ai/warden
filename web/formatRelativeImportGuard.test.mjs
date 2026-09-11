import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * STATIC SOURCE GUARD — no component ever imports `formatRelative` (WARDEN-1342,
 * roadmap WARDEN-1204 slice 4).
 *
 * WHY THIS FILE EXISTS: `formatRelative` (web/src/lib/formatTimestamp.ts) is the
 * low-level relative-mode primitive `formatTimestamp` dispatches to. It is an
 * INTERNAL building block — display code calls the pref-aware `formatTimestamp`
 * so the user's Relative ⇄ Absolute choice actually reaches the screen. Three
 * surfaces called `formatRelative` directly instead, hardcoding relative mode on
 * always-visible row text and silently ignoring the pref:
 *
 *   GitBadges.tsx (Source Control header, last-commit freshness)   → WARDEN-545
 *   GitBadges.tsx (branch-list rows, per-branch freshness)         → WARDEN-577
 *   TelemetryTransmissionLog.tsx (per-send recency)                → WARDEN-668
 *
 * This is a REGROWTH of a defect WARDEN-420/422 had already fixed once (in
 * FileViewer): their acceptance criterion — "a repo-wide `git grep "timeAgo("`
 * returns zero timestamp-display hits" — passed the day it shipped and still
 * passes today, yet it constrained nothing about the NEXT instance, because it
 * was keyed to the helper name that one instance happened to use. Three
 * regrowths landed within 72 hours of the fix.
 *
 * THE LESSON BAKED INTO THIS GUARD: scope the invariant to the import, not to a
 * call-site name. A unit test on any one surface's output cannot see the class
 * of defect (the rendered string is valid relative output — it is just the WRONG
 * mode, and only the user's pref says so), and no front-end DOM runner exists in
 * this repo anyway. But a component cannot render `formatRelative` without
 * binding it — so banning the BINDING under web/src/components/ closes the
 * class: the pref-aware `formatTimestamp(value, mode)` is the only sanctioned
 * route from a component to a rendered timestamp, and it reaches the primitive
 * internally.
 *
 * Scope is `web/src/components/` deliberately: `lib/formatTimestamp.ts` itself
 * legitimately defines `formatRelative` and dispatches to it — that is the
 * encapsulation working, not broken.
 */

const COMPONENTS_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'src',
  'components',
);

/** Every .ts/.tsx source under web/src/components, recursively. */
function componentFiles(dir = COMPONENTS_DIR) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return componentFiles(full);
    if (!/\.tsx?$/.test(entry.name)) return [];
    return [{ file: path.relative(COMPONENTS_DIR, full), text: fs.readFileSync(full, 'utf8') }];
  });
}

/**
 * Bindings of `formatRelative` in a source text.
 *
 * Form 1 — named import/re-export, including aliased and multiline forms:
 *     import { formatRelative } from '@/lib/formatTimestamp';
 *     import { formatTimestamp, formatRelative } from '@/lib/formatTimestamp';
 *     import { formatRelative as rel } from '@/lib/formatTimestamp';
 *     export { formatRelative } from '@/lib/formatTimestamp';
 *  (matched by `(import|export)` … `formatRelative` … `from` within one `;`-
 *  terminated statement; `[^;]` spans newlines, so wrapped import lists are
 *  covered too)
 *
 * Form 2 — namespace-qualified access (`import * as ft from …` → `ft.formatRelative`):
 *  the one binding form an import-statement scan cannot see, so it is matched at
 *  its (unambiguous) use site instead.
 */
function formatRelativeBindings(text) {
  const hits = [];
  const re = /(?:\b(import|export)\b[^;]*?\bformatRelative\b[^;]*?\bfrom\b)|(\.\s*formatRelative\b)/g;
  for (const match of text.matchAll(re)) {
    hits.push(match[0].replace(/\s+/g, ' ').trim());
  }
  return hits;
}

/** Import/export statements at all (the scanner's positive control). */
function timestampModuleStatements(text) {
  return [...text.matchAll(/\b(?:import|export)\b[^;]*?['"][^'"]*formatTimestamp['"]/g)].length;
}

describe('no component binds the formatRelative primitive (WARDEN-1342)', () => {
  it('never imports (or re-exports) formatRelative under web/src/components', () => {
    const offenders = [];
    for (const { file, text } of componentFiles()) {
      for (const binding of formatRelativeBindings(text)) {
        offenders.push(`${file}: ${binding}`);
      }
    }
    assert.deepEqual(
      offenders,
      [],
      'a component bound formatRelative, the relative-mode primitive formatTimestamp '
      + 'dispatches to internally. That hardcodes relative mode on a user-visible '
      + 'surface and silently ignores the Timestamp format preference (the exact '
      + 'regrowth this guard exists for — see GitBadges / TelemetryTransmissionLog, '
      + 'WARDEN-545/577/668). Call the pref-aware formatTimestamp(value, mode) from '
      + "@/lib/formatTimestamp instead; subscribe to the mode via useTimestampFormat() "
      + 'from @/lib/uiStore.',
    );
  });

  it('is actually scanning the module the primitive lives in (guards against a silently-empty scan)', () => {
    // Without this, a moved src dir or a renamed module would turn the invariant
    // above into a test that passes by finding nothing. The scanner must see the
    // REAL import statements that reach for '@/lib/formatTimestamp' — the same
    // statement shape the invariant inspects.
    const total = componentFiles().reduce((n, { text }) => n + timestampModuleStatements(text), 0);
    assert.ok(
      total >= 10,
      `expected the scanner to find imports of @/lib/formatTimestamp, found ${total} — `
      + 'the walk or the path is broken, so the invariant above proves nothing',
    );
  });

  it('the matcher fires on every realistic binding form (pinned on synthetic text)', () => {
    const cases = [
      "import { formatRelative } from '@/lib/formatTimestamp';",
      "import { formatTimestamp, formatRelative } from '@/lib/formatTimestamp';",
      "import { formatRelative as rel } from '@/lib/formatTimestamp';",
      "import {\n  formatTimestamp,\n  formatRelative,\n} from '@/lib/formatTimestamp';",
      "export { formatRelative } from '@/lib/formatTimestamp';",
      "import * as ft from '@/lib/formatTimestamp';\nft.formatRelative(Date.now());",
    ];
    for (const text of cases) {
      assert.equal(
        formatRelativeBindings(text).length,
        1,
        `matcher missed the binding form:\n${text}`,
      );
    }
    // And the sanctioned path must NOT fire the matcher.
    assert.equal(
      formatRelativeBindings(
        "import { formatTimestamp } from '@/lib/formatTimestamp';\nformatTimestamp(ts, mode);",
      ).length,
      0,
      'matcher fired on the sanctioned formatTimestamp path',
    );
  });
});
