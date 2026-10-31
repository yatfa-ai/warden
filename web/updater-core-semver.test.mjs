// Branch-level pins for electron/updater-core.cjs (WARDEN-2053): prerelease
// precedence in compareVersions/comparePre, the progress clamp, the reducer's
// fallback text, the feed parser and describeManualResult defaults. Complements
// web/updater-core.test.mjs. Every example is a pure function call (no timers,
// no I/O). Wrong precedence here means a missed or spurious update prompt.
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import test from 'node:test';

const require = createRequire(import.meta.url);
const core = require('../electron/updater-core.cjs');

const cmp = (a, b) => core.compareVersions(a, b);

// ---------------------------------------------------- prerelease precedence
test('prerelease identifiers compare lexically: alpha < beta, and the reverse', () => {
  assert.equal(cmp('1.0.0-alpha', '1.0.0-beta'), -1);
  assert.equal(cmp('1.0.0-beta', '1.0.0-alpha'), 1);
  assert.equal(cmp('1.0.0-rc', '1.0.0-rc'), 0);
});

test('a numeric identifier sorts below an alphanumeric one, in both directions', () => {
  assert.equal(cmp('1.0.0-1', '1.0.0-alpha'), -1);
  assert.equal(cmp('1.0.0-alpha', '1.0.0-1'), 1);
});

test('a shorter prerelease sorts below a longer one with the same prefix', () => {
  assert.equal(cmp('1.0.0-alpha', '1.0.0-alpha.1'), -1);
  assert.equal(cmp('1.0.0-alpha.1', '1.0.0-alpha'), 1);
});

test('numeric prerelease identifiers compare as numbers: beta.10 > beta.2', () => {
  assert.equal(cmp('1.0.0-beta.10', '1.0.0-beta.2'), 1);
  assert.equal(cmp('1.0.0-beta.2', '1.0.0-beta.10'), -1);
});

test('a release is above its own prerelease; a higher patch prerelease beats a lower release', () => {
  assert.equal(cmp('1.0.0', '1.0.0-rc.1'), 1);
  assert.equal(cmp('1.0.0-rc.1', '1.0.0'), -1);
  assert.equal(cmp('1.0.1-alpha', '1.0.0'), 1);
});

test('build metadata is ignored and surrounding whitespace / leading v are tolerated', () => {
  assert.equal(cmp('1.0.0+build.5', '1.0.0+other'), 0);
  assert.equal(cmp('1.0.0-beta.1+sha.abc', '1.0.0-beta.1'), 0);
  assert.deepEqual(core.parseVersion(' v1.2.3 '), { major: 1, minor: 2, patch: 3, pre: [] });
  assert.deepEqual(core.parseVersion('1.2.3-rc.1+b').pre, ['rc', '1']);
});

test('isNewerVersion: a prerelease candidate of the current release is not newer', () => {
  assert.equal(core.isNewerVersion('1.0.0', '1.0.0-rc.1'), false);
  assert.equal(core.isNewerVersion('1.0.0-rc.1', '1.0.0'), true);
  assert.equal(core.isNewerVersion('1.0.0-alpha', '1.0.0-beta'), true);
});

// ------------------------------------------------------------ reducer: progress
const downloading = (percent = 30) => ({
  ...core.initialState({ currentVersion: '1.0.0', enabled: true, silent: true }),
  status: 'downloading',
  version: '1.1.0',
  percent,
});
const prog = (state, percent) => core.reduceUpdateState(state, { type: 'progress', percent });

test('progress is ignored outside the downloading status', () => {
  const checking = { ...downloading(), status: 'checking', percent: null };
  assert.equal(prog(checking, 50), checking);
});

test('progress is clamped to 0..100 and rounded to the nearest integer', () => {
  assert.equal(prog(downloading(), -5).percent, 0);
  assert.equal(prog(downloading(), 150).percent, 100);
  assert.equal(prog(downloading(), 99.6).percent, 100);
  assert.equal(prog(downloading(), 42.4).percent, 42);
});

test('non-finite progress keeps the previous percent', () => {
  assert.equal(prog(downloading(30), 'NaN').percent, 30);
  assert.equal(prog(downloading(30), undefined).percent, 30);
  assert.equal(prog(downloading(30), Infinity).percent, 30);
});

test('an unknown event returns the very same state object', () => {
  const s = downloading();
  assert.equal(core.reduceUpdateState(s, { type: 'bogus' }), s);
});

// ------------------------------------------------- reducer: fallbacks / keeps
const idle = () => core.initialState({ currentVersion: '1.0.0', enabled: true, silent: false });

test('error with an empty or missing message falls back to "update check failed"', () => {
  assert.equal(core.reduceUpdateState(idle(), { type: 'error', message: '' }).error, 'update check failed');
  assert.equal(core.reduceUpdateState(idle(), { type: 'error' }).error, 'update check failed');
});

test('not-available without `at` keeps the previous lastCheckedAt; with `at` it is set', () => {
  const s = { ...idle(), lastCheckedAt: 123 };
  assert.equal(core.reduceUpdateState(s, { type: 'not-available' }).lastCheckedAt, 123);
  assert.equal(core.reduceUpdateState(s, { type: 'not-available', at: 456 }).lastCheckedAt, 456);
});

test('downloaded without a version keeps the known one, and pins percent to 100', () => {
  const next = core.reduceUpdateState(downloading(40), { type: 'downloaded' });
  assert.equal(next.status, 'ready');
  assert.equal(next.version, '1.1.0');
  assert.equal(next.percent, 100);
});

// ------------------------------------------------------------ feed / urls
test('parseFeedVersion handles quoting, indentation-free lines and rejects non-semver', () => {
  assert.equal(core.parseFeedVersion('version: "1.2.3"\n'), '1.2.3');
  assert.equal(core.parseFeedVersion("path: x\nversion:   '1.2.3-rc.1'  \n"), '1.2.3-rc.1');
  assert.equal(core.parseFeedVersion('  version: 1.2.3\n'), null); // indented → not a top-level scalar
  assert.equal(core.parseFeedVersion('version: latest\n'), null);
  assert.equal(core.parseFeedVersion(undefined), null);
});

test('downloadUrlFor trims whitespace and strips a leading v; unparseable → latest', () => {
  assert.equal(core.downloadUrlFor({ platform: 'darwin', version: ' v1.2.3 ' }), `${core.RELEASES_BASE}/download/v1.2.3/yatfa-warden-1.2.3.dmg`);
  assert.equal(core.downloadUrlFor({ platform: 'linux', version: ' v1.2.3 ' }), `${core.RELEASES_BASE}/tag/v1.2.3`);
  assert.equal(core.downloadUrlFor({ platform: 'linux', version: 'nope' }), `${core.RELEASES_BASE}/latest`);
});

// ------------------------------------------------------- describeManualResult
test('describeManualResult: downloading shows 0% when percent is null', () => {
  const r = core.describeManualResult({ status: 'downloading', version: '1.1.0', percent: null, currentVersion: '1.0.0' });
  assert.match(r.detail, /^0% downloaded/);
  const r2 = core.describeManualResult({ status: 'downloading', version: '1.1.0', percent: 55, currentVersion: '1.0.0' });
  assert.match(r2.detail, /^55% downloaded/);
});

test('describeManualResult fallbacks: unknown current version, unknown error, default checking text', () => {
  assert.match(core.describeManualResult({ status: 'available', version: '1.1.0', currentVersion: null }).detail, /You are running unknown\./);
  assert.match(core.describeManualResult({ status: 'up-to-date', currentVersion: null }).detail, /Yatfa Warden unknown is/);
  assert.match(core.describeManualResult({ status: 'error', error: null, currentVersion: '1.0.0' }).detail, /^Unknown error\n/);
  const dflt = core.describeManualResult({ status: 'checking', currentVersion: '1.0.0' });
  assert.equal(dflt.message, 'Checking for updates…');
  assert.equal(dflt.action, null);
});
