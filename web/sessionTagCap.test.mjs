import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * STATIC SOURCE GUARD for the session-tag count cap (WARDEN-1241).
 *
 * WHY THIS FILE EXISTS: the server caps a session at MAX_TAGS_PER_SESSION (8) tags
 * and silently truncates anything past it, answering `ok` with the already-shortened
 * list — there is NO discarded error for the client to consume (that truncation is
 * pinned by src/server-session-tags.test.js and is out of scope to change). A client
 * that keeps offering "+ tag" at the cap lets the user add a tag that vanishes with
 * no chip, no error and no explanation: the add appears to work, and the interface
 * mirrors the server's truncated list back into state so it *looks* consistent.
 *
 * The fix has two enforcement points, and this repo has no front-end DOM test runner,
 * so both are pinned here as source invariants (the dialogMaxWidth.test.mjs
 * precedent — a source scan can see a render-branch/ordering relationship a unit
 * test over pure helpers cannot):
 *
 *   1. web/src/components/sidebar/SessionTags.tsx — at the cap, SessionTagChips
 *      REPLACES the "+ tag" affordance with a visible limit note. The invariant is
 *      the DEFECT CLASS, not the wording: the user is TOLD the limit (a note naming
 *      the cap) instead of being handed an affordance that discards input. Below the
 *      cap the render is unchanged.
 *   2. web/src/components/ChatSidebar.tsx — addSessionTag checks the cap explicitly
 *      BEFORE the PUT. addTag always returns a NEW array (even for a rejected add),
 *      so a caller cannot detect rejection by comparing references — the check must
 *      exist at the point of adding, ahead of the updateSessionTags call. This also
 *      backstops the in-flight race a UI gate alone cannot cover.
 *
 * Like dialogMaxWidth, these assertions deliberately pin presence + ordering (the
 * defect class), not exact spelling: renames and rewordings stay green, and only
 * reintroducing the silent-discard class fails.
 */

const webDir = path.dirname(fileURLToPath(import.meta.url));
const chipsSrc = fs.readFileSync(
  path.join(webDir, 'src/components/sidebar/SessionTags.tsx'),
  'utf8',
);
const sidebarSrc = fs.readFileSync(path.join(webDir, 'src/components/ChatSidebar.tsx'), 'utf8');

describe('SessionTagChips count-cap affordance (WARDEN-1241)', () => {
  it('gates the add affordance on the shared count-cap constant', () => {
    assert.match(
      chipsSrc,
      /tags\.length >= MAX_TAGS_PER_SESSION/,
      'SessionTagChips must compare tags.length against MAX_TAGS_PER_SESSION (imported from @/lib/sessionTags) so the cap is a single shared mirror of the server, not a second hard-coded number',
    );
    assert.match(
      chipsSrc,
      /import \{ MAX_TAGS_PER_SESSION \} from '@\/lib\/sessionTags';/,
      'the cap must be imported from the shared pure layer, not redefined locally',
    );
  });

  it('at the cap renders a visible limit note, not the add affordance', () => {
    // The addBtn ternary is `adding ? <Input/> : atCap ? <span …/> : <button + tag>`.
    // Pin that the at-cap branch is a NON-INTERACTIVE element whose text names the
    // cap (uses the constant, so a cap change re-labels the note automatically) —
    // the "limit is visible" half of the ticket. The branch must not contain a
    // <button: an at-cap branch that still offers an interaction is the silent-discard
    // defect in new clothes.
    const capIdx = chipsSrc.indexOf('tags.length >= MAX_TAGS_PER_SESSION');
    assert.ok(capIdx !== -1, 'cap comparison must exist');
    const afterCap = chipsSrc.slice(capIdx);
    const noteMatch = afterCap.match(/<span[\s\S]{0,600}?<\/span>/);
    assert.ok(noteMatch, 'an at-cap <span> limit note must follow the cap comparison');
    const note = noteMatch[0];
    assert.match(
      note,
      /\{MAX_TAGS_PER_SESSION\}/,
      'the limit note must state the cap using the shared constant',
    );
    assert.doesNotMatch(note, /<button/, 'the at-cap branch must not offer an interactive control');
    // …and the note must sit BEFORE the "+ tag" button branch, i.e. it replaces the
    // affordance at the cap rather than living somewhere unrelated to the add flow.
    const noteAbsIdx = capIdx + noteMatch.index;
    const addBtnIdx = chipsSrc.indexOf('aria-label="add tag"');
    assert.ok(
      addBtnIdx > noteAbsIdx,
      'the limit note must precede the add-button branch (it replaces the affordance at the cap)',
    );
  });

  it('keeps the per-tag LENGTH cap untouched (the out-of-scope boundary)', () => {
    // The ticket pins the existing per-tag length behaviour. If this fails, someone
    // changed the length mirror while working on the count cap.
    assert.match(
      chipsSrc,
      /const MAX_TAG_LEN = 40; \/\/ mirror the backend per-tag cap \(src\/server\.js\)/,
      'the per-tag length mirror (MAX_TAG_LEN = 40) must be untouched',
    );
  });
});

describe('addSessionTag explicit cap check (WARDEN-1241)', () => {
  it('checks the count cap explicitly, before the PUT', () => {
    // Slice out the addSessionTag body so the ordering assertion is about THIS
    // function, not a coincidental constant elsewhere in a 1500-line file.
    const start = sidebarSrc.indexOf('const addSessionTag');
    const end = sidebarSrc.indexOf('const removeSessionTag', start);
    assert.ok(start !== -1 && end > start, 'addSessionTag must exist beside removeSessionTag');
    const fn = sidebarSrc.slice(start, end);

    const checkIdx = fn.indexOf('.length >= MAX_TAGS_PER_SESSION');
    const putIdx = fn.indexOf('updateSessionTags(id, addTag(');
    assert.ok(checkIdx !== -1, 'addSessionTag must check the cap against the shared constant');
    assert.ok(putIdx !== -1, 'addSessionTag must still PUT via updateSessionTags(id, addTag(...))');
    assert.ok(
      checkIdx < putIdx,
      'the explicit cap check must come BEFORE the PUT — the point of adding is the only place a rejected add is detectable (addTag returns a new array, so references cannot signal it)',
    );
  });
});
