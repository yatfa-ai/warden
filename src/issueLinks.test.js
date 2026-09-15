// Unit tests for the issue-link tracker mapping sanitizer (WARDEN-1388) — the
// pure module src/issueLinks.js that config-schema.js's `issueLinkTrackers`
// descriptor delegates its PUT guard to (the sanitizeWatchPatterns shape).
//
// Pins the entry grammar (`project=prefix@tracker`), the structured-entry
// round-trip (GET output PUT back), the human-stated string form, the drop /
// dedupe / cap rules, and the field validators. The end-to-end wire contract
// (GET emission, PUT refusal reporting) is pinned in
// server-config-registry.test.js; this file is the pure-logic half.
//
// Run: node --test src/issueLinks.test.js   (or: npm test)
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ISSUE_LINK_TRACKER_MAX_COUNT,
  sanitizeIssueLinkTrackers,
  parseIssueLinkEntry,
  isValidIssueLinkProject,
  isValidIssueLinkPrefix,
  isValidIssueLinkTracker,
} from './issueLinks.js';

describe('parseIssueLinkEntry — the human-stated string grammar', () => {
  it('parses project=prefix@host[/path]', () => {
    assert.deepEqual(parseIssueLinkEntry('warden=WARDEN@github.com/acme/warden/issues'),
      { project: 'warden', prefix: 'WARDEN', tracker: 'github.com/acme/warden/issues' });
    assert.deepEqual(parseIssueLinkEntry('yatfa=YATFA@tracker.example.com:8443/browse'),
      { project: 'yatfa', prefix: 'YATFA', tracker: 'tracker.example.com:8443/browse' });
    assert.deepEqual(parseIssueLinkEntry('p=P@host.io'),
      { project: 'p', prefix: 'P', tracker: 'host.io' });
  });
  it('trims surrounding whitespace and a trailing slash on the tracker', () => {
    assert.deepEqual(parseIssueLinkEntry('  warden=WARDEN@host.io/path/  '),
      { project: 'warden', prefix: 'WARDEN', tracker: 'host.io/path' });
  });
  it('normalizes the prefix to UPPERCASE', () => {
    assert.equal(parseIssueLinkEntry('warden=warden@host.io').prefix, 'WARDEN');
    assert.equal(parseIssueLinkEntry('warden=Warden@host.io').prefix, 'WARDEN');
  });
  it('rejects malformed strings', () => {
    for (const bad of [
      '', 'no-separator', '=WARDEN@host.io', 'warden=@host.io', 'warden=WARDEN@',
      'warden@host.io', 'warden=WARDEN@host io', 'warden=WARDEN@host.io?q=1',
      'warden=WARDEN@https://host.io', 'war den=WARDEN@host.io', 'warden=-WARDEN@host.io',
      'warden=1WARDEN@host.io', 'warden=WARDEN-W@host.io', 'a='.repeat(30) + `x@host.io`,
    ]) {
      assert.equal(parseIssueLinkEntry(bad), null, `expected null for ${JSON.stringify(bad)}`);
    }
  });
});

describe('sanitizeIssueLinkTrackers — the PUT-guard sanitizer', () => {
  it('returns null for a non-array (no-mutation contract)', () => {
    for (const bad of [undefined, null, 'x', {}, 42]) {
      assert.equal(sanitizeIssueLinkTrackers(bad), null, `expected null for ${typeof bad}`);
    }
  });
  it('accepts the structured storage shape and re-validates it', () => {
    const out = sanitizeIssueLinkTrackers([
      { project: 'warden', prefix: 'WARDEN', tracker: 'github.com/acme/warden/issues' },
      { project: 'p', prefix: 'lower', tracker: 'host.io' },
    ]);
    assert.deepEqual(out, [
      { project: 'warden', prefix: 'WARDEN', tracker: 'github.com/acme/warden/issues' },
      { project: 'p', prefix: 'LOWER', tracker: 'host.io' },
    ]);
  });
  it('accepts BOTH forms in one array — string config.json edits survive a GET round-trip', () => {
    const out = sanitizeIssueLinkTrackers([
      'warden=WARDEN@host.io/path',
      { project: 'yatfa', prefix: 'YATFA', tracker: 'yatfa.dev' },
    ]);
    assert.deepEqual(out, [
      { project: 'warden', prefix: 'WARDEN', tracker: 'host.io/path' },
      { project: 'yatfa', prefix: 'YATFA', tracker: 'yatfa.dev' },
    ]);
    // And the round-trip is idempotent: sanitizing the sanitized output changes nothing.
    assert.deepEqual(sanitizeIssueLinkTrackers(out), out);
  });
  it('drops malformed entries without failing the whole save', () => {
    const out = sanitizeIssueLinkTrackers([
      'garbage',
      { project: 'warden', prefix: 'WARDEN', tracker: 'https://bad.io' },
      { project: 'ok', prefix: 'OK', tracker: 'ok.io' },
      42,
    ]);
    assert.deepEqual(out, [{ project: 'ok', prefix: 'OK', tracker: 'ok.io' }]);
  });
  it('dedupes by project — first occurrence wins', () => {
    const out = sanitizeIssueLinkTrackers([
      'warden=WARDEN@first.io',
      'warden=WARDEN@second.io',
      'yatfa=YATFA@other.io',
    ]);
    assert.equal(out.length, 2);
    assert.equal(out[0].tracker, 'first.io');
  });
  it('caps the array at ISSUE_LINK_TRACKER_MAX_COUNT', () => {
    const many = Array.from({ length: ISSUE_LINK_TRACKER_MAX_COUNT + 10 }, (_, i) => `p${i}=P${i}@host.io`);
    const out = sanitizeIssueLinkTrackers(many);
    assert.equal(out.length, ISSUE_LINK_TRACKER_MAX_COUNT);
    assert.equal(out[0].project, 'p0');
  });
  it('returns [] for an empty array (a legitimate "no mappings" save)', () => {
    assert.deepEqual(sanitizeIssueLinkTrackers([]), []);
  });
});

describe('field validators — shared by the string and structured forms', () => {
  it('project: slug charset, 1–64 chars, no = or @ or whitespace', () => {
    assert.ok(isValidIssueLinkProject('warden'));
    assert.ok(isValidIssueLinkProject('my.project_v2-x'));
    assert.ok(!isValidIssueLinkProject(''));
    assert.ok(!isValidIssueLinkProject('war den'));
    assert.ok(!isValidIssueLinkProject('a=b'));
    assert.ok(!isValidIssueLinkProject('a@b'));
    assert.ok(!isValidIssueLinkProject('-lead'));
    assert.ok(!isValidIssueLinkProject('a'.repeat(65)));
  });
  it('prefix: starts with a letter, alphanumerics only, 1–16 chars', () => {
    assert.ok(isValidIssueLinkPrefix('WARDEN'));
    assert.ok(isValidIssueLinkPrefix('A1'));
    assert.ok(!isValidIssueLinkPrefix('1A'));
    assert.ok(!isValidIssueLinkPrefix('W-1'));
    assert.ok(!isValidIssueLinkPrefix(''));
    assert.ok(!isValidIssueLinkPrefix('A'.repeat(17)));
  });
  it('tracker: host[:port][/path], NO scheme / whitespace / query / hash', () => {
    assert.ok(isValidIssueLinkTracker('github.com/acme/warden/issues'));
    assert.ok(isValidIssueLinkTracker('tracker.example.com:8443/browse'));
    assert.ok(isValidIssueLinkTracker('192.168.1.10:3000'));
    assert.ok(!isValidIssueLinkTracker('https://host.io'), 'scheme refused — https is always what the opener builds');
    assert.ok(!isValidIssueLinkTracker('host io'));
    assert.ok(!isValidIssueLinkTracker('host.io?q=1'));
    assert.ok(!isValidIssueLinkTracker('host.io#frag'));
    assert.ok(!isValidIssueLinkTracker(''));
    assert.ok(!isValidIssueLinkTracker('h'.repeat(201)));
  });
});
