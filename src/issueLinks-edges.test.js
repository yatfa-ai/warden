// Edge pins for src/issueLinks.js: the inclusive upper bounds of the three field
// validators and of the entry grammar, repeated-trailing-slash stripping on both
// entry forms, the structured-form prefix uppercasing and trim, non-string input
// refusal (array coercion would otherwise slip through), and the per-project
// dedupe keys.
//
// Run: node --test src/issueLinks-edges.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ISSUE_LINK_PROJECT_MAX,
  ISSUE_LINK_PREFIX_MAX,
  ISSUE_LINK_TRACKER_MAX,
  ISSUE_LINK_TRACKER_MAX_COUNT,
  sanitizeIssueLinkTrackers,
  parseIssueLinkEntry,
  isValidIssueLinkProject,
  isValidIssueLinkPrefix,
  isValidIssueLinkTracker,
} from './issueLinks.js';

describe('issueLinks — inclusive upper bounds', () => {
  it('exports the documented caps', () => {
    assert.equal(ISSUE_LINK_PROJECT_MAX, 64);
    assert.equal(ISSUE_LINK_PREFIX_MAX, 16);
    assert.equal(ISSUE_LINK_TRACKER_MAX, 200);
    assert.equal(ISSUE_LINK_TRACKER_MAX_COUNT, 64);
  });
  it('project: exactly 64 chars is accepted, 65 is not', () => {
    assert.equal(isValidIssueLinkProject('a'.repeat(64)), true);
    assert.equal(isValidIssueLinkProject('a'.repeat(65)), false);
  });
  it('prefix: exactly 16 chars is accepted, 17 is not', () => {
    assert.equal(isValidIssueLinkPrefix('A'.repeat(16)), true);
    assert.equal(isValidIssueLinkPrefix('A'.repeat(17)), false);
  });
  it('tracker: exactly 200 chars is accepted, 201 is not', () => {
    assert.equal(isValidIssueLinkTracker('h'.repeat(200)), true);
    assert.equal(isValidIssueLinkTracker('h'.repeat(201)), false);
  });
  it('the string grammar admits a 64-char project and a 16-char prefix', () => {
    const p = 'p'.repeat(64);
    const x = 'X'.repeat(16);
    assert.deepEqual(parseIssueLinkEntry(`${p}=${x}@host.io`), { project: p, prefix: x, tracker: 'host.io' });
  });
  it('the string grammar refuses a 65-char project and a 17-char prefix', () => {
    assert.equal(parseIssueLinkEntry(`${'p'.repeat(65)}=X@host.io`), null);
    assert.equal(parseIssueLinkEntry(`p=${'X'.repeat(17)}@host.io`), null);
  });
  it('a tracker that is 200 chars only after trailing slashes are stripped still parses', () => {
    const t = 'h'.repeat(200);
    assert.equal(parseIssueLinkEntry(`p=P@${t}///`).tracker, t);
  });
});

describe('issueLinks — slash and whitespace normalisation', () => {
  it('parse strips every trailing slash, not just one', () => {
    assert.equal(parseIssueLinkEntry('p=P@host.io/a///').tracker, 'host.io/a');
  });
  it('structured form strips every trailing slash too', () => {
    const [e] = sanitizeIssueLinkTrackers([{ project: 'p', prefix: 'P', tracker: 'host.io/a//' }]);
    assert.equal(e.tracker, 'host.io/a');
  });
  it('structured form uppercases the prefix', () => {
    const [e] = sanitizeIssueLinkTrackers([{ project: 'p', prefix: 'abc', tracker: 'host.io' }]);
    assert.equal(e.prefix, 'ABC');
  });
  it('a bare trailing slash after the host is stripped to the bare host', () => {
    assert.deepEqual(parseIssueLinkEntry('p=P@host.io/'), { project: 'p', prefix: 'P', tracker: 'host.io' });
  });
  it('parse trims a newline- and tab-wrapped entry', () => {
    assert.equal(parseIssueLinkEntry('\n\tp=P@host.io\t\n').tracker, 'host.io');
  });
  it('an all-whitespace entry is null', () => {
    assert.equal(parseIssueLinkEntry('   '), null);
  });
});

describe('issueLinks — non-string and malformed structured input', () => {
  it('parseIssueLinkEntry returns null (never throws) for non-strings', () => {
    for (const v of [null, undefined, 5, {}, ['p=P@host.io'], true]) {
      assert.equal(parseIssueLinkEntry(v), null);
    }
  });
  it('validators refuse a single-element array that would coerce to a valid string', () => {
    assert.equal(isValidIssueLinkProject(['warden']), false);
    assert.equal(isValidIssueLinkPrefix(['WARDEN']), false);
    assert.equal(isValidIssueLinkTracker(['host.io']), false);
  });
  it('validators refuse null / undefined / numbers', () => {
    for (const v of [null, undefined, 42]) {
      assert.equal(isValidIssueLinkProject(v), false);
      assert.equal(isValidIssueLinkPrefix(v), false);
      assert.equal(isValidIssueLinkTracker(v), false);
    }
  });
  it('sanitize drops non-object/non-string members and arrays, keeping the valid ones', () => {
    const out = sanitizeIssueLinkTrackers([
      null, 7, true, [], ['p', 'P', 'host.io'],
      { project: 'ok', prefix: 'OK', tracker: 'host.io' },
    ]);
    assert.deepEqual(out, [{ project: 'ok', prefix: 'OK', tracker: 'host.io' }]);
  });
  it('a structured entry with any one bad field is dropped whole', () => {
    assert.deepEqual(sanitizeIssueLinkTrackers([
      { project: 'bad project', prefix: 'P', tracker: 'host.io' },
      { project: 'p', prefix: '1P', tracker: 'host.io' },
      { project: 'p', prefix: 'P', tracker: 'https://host.io' },
      { project: 'p', prefix: 'P' },
    ]), []);
  });
});

describe('issueLinks — dedupe and cap interplay', () => {
  it('dedupes across the string and structured forms (first wins)', () => {
    const out = sanitizeIssueLinkTrackers([
      'p=P@first.io',
      { project: 'p', prefix: 'Q', tracker: 'second.io' },
    ]);
    assert.deepEqual(out, [{ project: 'p', prefix: 'P', tracker: 'first.io' }]);
  });
  it('project dedupe is case-sensitive', () => {
    const out = sanitizeIssueLinkTrackers(['Warden=W@a.io', 'warden=W@b.io']);
    assert.equal(out.length, 2);
  });
  it('a dropped (invalid) entry does not consume the dedupe slot of a later valid one', () => {
    const out = sanitizeIssueLinkTrackers(['p=1@bad.io', 'p=P@good.io']);
    assert.deepEqual(out, [{ project: 'p', prefix: 'P', tracker: 'good.io' }]);
  });
  it('invalid entries do not count toward the cap: 64 valid ones survive behind 10 bad ones', () => {
    const bad = Array.from({ length: 10 }, () => 'nonsense');
    const good = Array.from({ length: ISSUE_LINK_TRACKER_MAX_COUNT + 5 }, (_, i) => `p${i}=P@host.io`);
    const out = sanitizeIssueLinkTrackers([...bad, ...good]);
    assert.equal(out.length, ISSUE_LINK_TRACKER_MAX_COUNT);
    assert.equal(out.at(-1).project, `p${ISSUE_LINK_TRACKER_MAX_COUNT - 1}`);
  });
  it('duplicates do not count toward the cap either', () => {
    const dups = Array.from({ length: 20 }, () => 'dup=D@host.io');
    const good = Array.from({ length: ISSUE_LINK_TRACKER_MAX_COUNT - 1 }, (_, i) => `p${i}=P@host.io`);
    const out = sanitizeIssueLinkTrackers([...dups, ...good]);
    assert.equal(out.length, ISSUE_LINK_TRACKER_MAX_COUNT);
  });
});
