// Unit tests for the auto-update pure core + controller (WARDEN-1887):
// version comparison, the update-state reducer, the platform capability
// decision, and the controller's dev-inert / silent / manual / failure-safe
// behaviour. electron/updater*.cjs are electron-free by injection, so every
// live dependency here is a stub.
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';

const require = createRequire(import.meta.url);
const core = require('../electron/updater-core.cjs');
const { createUpdater } = require('../electron/updater.cjs');

// ---------------------------------------------------------------- versions
test('compareVersions orders numerically, not lexically', () => {
  assert.equal(core.compareVersions('0.1.99', '0.1.104'), -1);
  assert.equal(core.compareVersions('0.1.104', '0.1.104'), 0);
  assert.equal(core.compareVersions('0.2.0', '0.1.999'), 1);
  assert.equal(core.compareVersions('1.0.0', 'v1.0.0'), 0);
});

test('prerelease sorts below its release; unparseable → null', () => {
  assert.equal(core.compareVersions('1.0.0-beta.1', '1.0.0'), -1);
  assert.equal(core.compareVersions('1.0.0-beta.2', '1.0.0-beta.10'), -1);
  assert.equal(core.compareVersions('1.0', '1.0.1'), null);
  assert.equal(core.compareVersions(undefined, '1.0.1'), null);
});

test('isNewerVersion is strict and conservative on garbage', () => {
  assert.equal(core.isNewerVersion('0.1.104', '0.1.105'), true);
  assert.equal(core.isNewerVersion('0.1.104', '0.1.104'), false);
  assert.equal(core.isNewerVersion('0.1.104', '0.1.103'), false);
  assert.equal(core.isNewerVersion('0.1.104', 'latest'), false);
});

test('parseFeedVersion reads electron-builder feeds', () => {
  assert.equal(core.parseFeedVersion('version: 0.1.104\nfiles:\n  - url: x\n'), '0.1.104');
  assert.equal(core.parseFeedVersion("version: '0.1.105'\n"), '0.1.105');
  assert.equal(core.parseFeedVersion('files: []'), null);
  assert.equal(core.parseFeedVersion('version: nope\n'), null);
  assert.equal(core.parseFeedVersion(null), null);
});

// ------------------------------------------------------------ capabilities
test('silent install: Windows yes, Linux only as AppImage, macOS never', () => {
  assert.equal(core.canInstallSilently({ platform: 'win32' }), true);
  assert.equal(core.canInstallSilently({ platform: 'linux', env: { APPIMAGE: '/x.AppImage' } }), true);
  assert.equal(core.canInstallSilently({ platform: 'linux', env: {} }), false);
  assert.equal(core.canInstallSilently({ platform: 'darwin', env: { APPIMAGE: '/x' } }), false);
});

test('downloadUrlFor: macOS gets the DMG, others the release page, bad version the latest page', () => {
  assert.equal(core.downloadUrlFor({ platform: 'darwin', version: '0.1.105' }),
    'https://github.com/yatfa-ai/warden/releases/download/v0.1.105/yatfa-warden-0.1.105.dmg');
  assert.equal(core.downloadUrlFor({ platform: 'linux', version: '0.1.105' }),
    'https://github.com/yatfa-ai/warden/releases/tag/v0.1.105');
  assert.equal(core.downloadUrlFor({ platform: 'darwin', version: '../../evil' }),
    'https://github.com/yatfa-ai/warden/releases/latest');
});

test('feedNameFor matches what electron-builder publishes per OS', () => {
  assert.equal(core.feedNameFor('win32'), 'latest.yml');
  assert.equal(core.feedNameFor('linux'), 'latest-linux.yml');
  assert.equal(core.feedNameFor('darwin'), 'latest-mac.yml');
});

// ----------------------------------------------------------------- reducer
const st = (o = {}) => ({ ...core.initialState({ currentVersion: '0.1.104', enabled: true, silent: true }), ...o });

test('initialState: disabled when not enabled', () => {
  assert.equal(core.initialState({ currentVersion: '1.0.0', enabled: false, silent: false }).status, 'disabled');
  assert.equal(core.initialState({ currentVersion: '1.0.0', enabled: true, silent: false }).status, 'idle');
});

test('disabled is terminal — no event leaves it', () => {
  const d = core.initialState({ currentVersion: '0.1.104', enabled: false, silent: false });
  for (const e of [{ type: 'check-start' }, { type: 'available', version: '9.9.9' }, { type: 'downloaded', version: '9.9.9' }, { type: 'error', message: 'x' }]) {
    assert.equal(core.reduceUpdateState(d, e), d);
  }
});

test('silent: check → available → progress → downloaded', () => {
  let s = core.reduceUpdateState(st(), { type: 'check-start' });
  assert.equal(s.status, 'checking');
  s = core.reduceUpdateState(s, { type: 'available', version: '0.1.105' });
  assert.deepEqual([s.status, s.version, s.percent], ['downloading', '0.1.105', 0]);
  s = core.reduceUpdateState(s, { type: 'progress', percent: 42.4 });
  assert.equal(s.percent, 42);
  s = core.reduceUpdateState(s, { type: 'progress', percent: 250 });
  assert.equal(s.percent, 100);
  s = core.reduceUpdateState(s, { type: 'downloaded', version: '0.1.105' });
  assert.deepEqual([s.status, s.version], ['ready', '0.1.105']);
});

test('manual path: available carries the download URL and never downloads', () => {
  const m = core.initialState({ currentVersion: '0.1.104', enabled: true, silent: false });
  const s = core.reduceUpdateState(m, { type: 'available', version: '0.1.105', downloadUrl: 'https://x/y' });
  assert.deepEqual([s.status, s.downloadUrl, s.percent], ['available', 'https://x/y', null]);
});

test('an "available" that is not strictly newer is treated as up to date', () => {
  const s = core.reduceUpdateState(st(), { type: 'available', version: '0.1.104' });
  assert.equal(s.status, 'up-to-date');
  assert.equal(core.reduceUpdateState(st(), { type: 'available', version: 'garbage' }).status, 'up-to-date');
});

test('ready is sticky: later checks, errors and not-available cannot clobber a downloaded update', () => {
  const ready = st({ status: 'ready', version: '0.1.105', percent: 100 });
  for (const e of [{ type: 'check-start' }, { type: 'not-available', at: 1 }, { type: 'error', message: 'offline' }, { type: 'available', version: '0.1.106' }]) {
    assert.equal(core.reduceUpdateState(ready, e), ready, e.type);
  }
});

test('error is quiet and recoverable: records the message, next check proceeds', () => {
  let s = core.reduceUpdateState(st(), { type: 'error', message: 'ENOTFOUND github.com', at: 5 });
  assert.deepEqual([s.status, s.error, s.lastCheckedAt], ['error', 'ENOTFOUND github.com', 5]);
  s = core.reduceUpdateState(s, { type: 'check-start' });
  assert.deepEqual([s.status, s.error], ['checking', null]);
  assert.equal(core.reduceUpdateState(st(), { type: 'error', message: 'x'.repeat(1000) }).error.length, 300);
});

test('a check-start mid-download does not reset the download', () => {
  const d = st({ status: 'downloading', version: '0.1.105', percent: 30 });
  assert.equal(core.reduceUpdateState(d, { type: 'check-start' }), d);
});

test('manual-path available is sticky: survives check-start', () => {
  const a = st({ silent: false, status: 'available', version: '0.1.105', downloadUrl: 'https://x/y' });
  assert.equal(core.reduceUpdateState(a, { type: 'check-start' }), a);
});

test('manual-path available survives error, recording the message and lastCheckedAt', () => {
  const a = st({ silent: false, status: 'available', version: '0.1.105', downloadUrl: 'https://x/y' });
  const s = core.reduceUpdateState(a, { type: 'error', message: 'HTTP 503', at: 42 });
  assert.deepEqual(
    [s.status, s.version, s.downloadUrl, s.error, s.lastCheckedAt],
    ['available', '0.1.105', 'https://x/y', 'HTTP 503', 42],
  );
});

test('a sticky available is still replaced by not-available, a newer available, or downloaded', () => {
  const a = st({ silent: false, status: 'available', version: '0.1.105', downloadUrl: 'https://x/y', error: 'HTTP 503' });
  const gone = core.reduceUpdateState(a, { type: 'not-available', at: 7 });
  assert.deepEqual([gone.status, gone.version, gone.downloadUrl, gone.error], ['up-to-date', null, null, null]);
  const newer = core.reduceUpdateState(a, { type: 'available', version: '0.1.106', downloadUrl: 'https://x/z' });
  assert.deepEqual([newer.status, newer.version, newer.downloadUrl, newer.error], ['available', '0.1.106', 'https://x/z', null]);
  assert.equal(core.reduceUpdateState(a, { type: 'downloaded', version: '0.1.105' }).status, 'ready');
});

// ---------------------------------------------------- manual-result wording
test('describeManualResult is honest in every state, including up to date', () => {
  const d = (status, extra = {}) => core.describeManualResult(st({ status, ...extra }));
  assert.match(d('up-to-date').message, /up to date/i);
  assert.equal(d('ready', { version: '0.1.105' }).action, 'install');
  assert.equal(d('available', { version: '0.1.105' }).action, 'download');
  assert.match(d('error', { error: 'boom' }).detail, /boom/);
  assert.match(d('disabled').message, /unavailable/i);
});

test('menuLabelFor flips only when an update is pending', () => {
  assert.equal(core.menuLabelFor(st()), 'Check for Updates…');
  assert.match(core.menuLabelFor(st({ status: 'ready', version: '0.1.105' })), /Restart to Apply Update \(0\.1\.105\)/);
  assert.equal(core.menuLabelFor(null), 'Check for Updates…');
});

// -------------------------------------------------------------- controller
class FakeAutoUpdater extends EventEmitter {
  constructor() { super(); this.checks = 0; this.installs = 0; this.behavior = 'none'; }
  async checkForUpdates() {
    this.checks++;
    this.emit('checking-for-update');
    if (this.behavior === 'reject') throw new Error('net::ERR_INTERNET_DISCONNECTED');
    if (this.behavior === 'newer') {
      this.emit('update-available', { version: '0.1.105' });
      this.emit('download-progress', { percent: 50 });
      this.emit('update-downloaded', { version: '0.1.105' });
    } else this.emit('update-not-available', {});
  }
  quitAndInstall() { this.installs++; }
}

function mk(over = {}) {
  const au = new FakeAutoUpdater();
  let loads = 0;
  const states = [];
  const timers = { set: [], cleared: 0 };
  const u = createUpdater({
    currentVersion: '0.1.104', isPackaged: true, platform: 'win32', env: {},
    getAutoUpdater: () => { loads++; return au; },
    fetchText: async () => { throw new Error('fetch must not be called'); },
    timers: {
      setTimeout: (fn, ms) => { timers.set.push(['timeout', ms, fn]); return { unref() {} }; },
      clearTimeout: () => { timers.cleared++; },
      setInterval: (fn, ms) => { timers.set.push(['interval', ms, fn]); return { unref() {} }; },
      clearInterval: () => { timers.cleared++; },
    },
    onStateChange: (s) => states.push(s.status),
    ...over,
  });
  return { u, au, states, timers, loads: () => loads };
}

test('dev/unpackaged: fully inert — no timers, no updater load, no fetch, no state change', async () => {
  const { u, timers, loads, states } = mk({ isPackaged: false });
  u.start();
  assert.equal(timers.set.length, 0);
  const s = await u.checkNow();
  assert.equal(s.status, 'disabled');
  assert.equal(loads(), 0);
  assert.deepEqual(states, []);
  assert.equal(u.installNow(), false);
});

test('start schedules a delayed startup check and a periodic one; stop clears both', () => {
  const { u, timers } = mk();
  u.start();
  assert.deepEqual(timers.set.map((t) => t[0]), ['timeout', 'interval']);
  assert.ok(timers.set[0][1] > 0 && timers.set[1][1] > timers.set[0][1]);
  u.start(); // idempotent
  assert.equal(timers.set.length, 2);
  u.stop();
  assert.equal(timers.cleared, 2);
});

test('silent path: a newer release is downloaded in the background and ends in "ready"', async () => {
  const { u, au, states } = mk();
  au.behavior = 'newer';
  const s = await u.checkNow();
  assert.equal(s.status, 'ready');
  assert.equal(au.autoDownload, true);
  assert.equal(au.autoInstallOnAppQuit, true, 'applies on next app start');
  assert.ok(states.includes('downloading'));
});

test('installNow only fires when an update is ready, and is the only quitAndInstall caller', async () => {
  const { u, au } = mk();
  assert.equal(u.installNow(), false);
  au.behavior = 'newer';
  await u.checkNow();
  assert.equal(u.installNow(), true);
  assert.equal(au.installs, 1);
});

test('offline / failed check never throws, is recorded quietly, and the next check recovers', async () => {
  const { u, au } = mk();
  au.behavior = 'reject';
  const s = await u.checkNow();
  assert.equal(s.status, 'error');
  assert.match(s.error, /INTERNET_DISCONNECTED/);
  au.behavior = 'none';
  assert.equal((await u.checkNow()).status, 'up-to-date');
});

test('overlapping checks are deduped to one in-flight check', async () => {
  const { u, au } = mk();
  await Promise.all([u.checkNow(), u.checkNow(), u.checkNow()]);
  assert.equal(au.checks, 1);
});

test('manual path (unsigned macOS): electron-updater is NEVER loaded; newer feed → available + DMG url', async () => {
  const { u, loads } = mk({
    platform: 'darwin',
    fetchText: async (url) => {
      assert.equal(url, 'https://github.com/yatfa-ai/warden/releases/latest/download/latest-mac.yml');
      return 'version: 0.1.105\n';
    },
  });
  assert.equal(u.silent, false);
  const s = await u.checkNow();
  assert.equal(s.status, 'available');
  assert.equal(s.version, '0.1.105');
  assert.match(s.downloadUrl, /yatfa-warden-0\.1\.105\.dmg$/);
  assert.equal(loads(), 0);
  assert.equal(u.installNow(), false);
});

test('manual path: same version → up to date; unreadable / failing feed → quiet error, no throw', async () => {
  let body = 'version: 0.1.104\n';
  let fail = false;
  const { u } = mk({ platform: 'darwin', fetchText: async () => { if (fail) throw new Error('HTTP 503'); return body; } });
  assert.equal((await u.checkNow()).status, 'up-to-date');
  body = 'garbage'; assert.equal((await u.checkNow()).status, 'error');
  fail = true; assert.match((await u.checkNow()).error, /503/);
});

test('manual path: a successful check followed by a failing re-check keeps status "available"', async () => {
  let fail = false;
  const { u, states } = mk({ platform: 'darwin', fetchText: async () => { if (fail) throw new Error('HTTP 503'); return 'version: 0.1.105\n'; } });
  assert.equal((await u.checkNow()).status, 'available');
  fail = true;
  const s = await u.checkNow();
  assert.equal(s.status, 'available');
  assert.equal(u.getState().status, 'available');
  assert.equal(u.getState().version, '0.1.105');
  assert.match(u.getState().error, /503/);
  assert.ok(!states.slice(states.indexOf('available')).includes('checking'), 'chip never drops to checking');
  assert.ok(!states.slice(states.indexOf('available')).includes('error'));
});

test('Linux without APPIMAGE takes the manual path', () => {
  assert.equal(mk({ platform: 'linux', env: {} }).u.silent, false);
  assert.equal(mk({ platform: 'linux', env: { APPIMAGE: '/a' } }).u.silent, true);
});

// ------------------------------------------------------------ wiring pins
// main.cjs cannot be required under node --test; pin its half by source.
const main = readFileSync(new URL('../electron/main.cjs', import.meta.url), 'utf8');
test('main.cjs wires the updater packaged-only and loads electron-updater lazily', () => {
  assert.match(main, /isPackaged:\s*app\.isPackaged/);
  assert.match(main, /getAutoUpdater:\s*\(\)\s*=>\s*require\('electron-updater'\)\.autoUpdater/);
  assert.ok(!/^const .*require\('electron-updater'\)/m.test(main), 'electron-updater must not be required at module scope');
  assert.match(main, /checkForUpdates:\s*\(\)\s*=>/);
  assert.match(main, /installAutoUpdater\(\);/);
});

test('openDownload takes no renderer-supplied URL and requires https', () => {
  const pre = readFileSync(new URL('../electron/preload.cjs', import.meta.url), 'utf8');
  assert.match(pre, /openDownload:\s*\(\)\s*=>/);
  assert.match(main, /\^https:\\\/\\\//);
});

test('package.json publishes to the GitHub release feed and depends on electron-updater', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.ok(pkg.dependencies['electron-updater']);
  assert.deepEqual(pkg.build.publish, [{ provider: 'github', owner: 'yatfa-ai', repo: 'warden' }]);
});

// Persistence across an applied update (WARDEN-181 stays true): chats/settings/
// observer sessions live in ~/.yatfa-warden and the renderer's userData
// localStorage. Neither the updater nor the window load may clear them — an
// applied update replaces only the app binary (NSIS keeps userData; AppImage
// replaces the file), and the fresh bundle is served by the no-cache server +
// content-hashed assets, not by wiping storage.
test('nothing in the update path (or main) wipes session/storage state', () => {
  for (const f of ['../electron/main.cjs', '../electron/updater.cjs', '../electron/updater-core.cjs']) {
    const src = readFileSync(new URL(f, import.meta.url), 'utf8').replace(/\/\/.*$/gm, '');
    assert.ok(!/clearStorageData|clearCache|clearHostResolverCache|\.rmSync\(|\.rm\(/.test(src), `${f} clears storage/cache`);
  }
  assert.match(main, /win\.loadURL\(`http:\/\/\$\{HOST\}:\$\{PORT\}\/\?_t=\$\{Date\.now\(\)\}`\)/, 'fresh-bundle cache-buster load removed');
});

test('updater state is main-process memory only — it persists nothing', () => {
  const src = readFileSync(new URL('../electron/updater.cjs', import.meta.url), 'utf8').replace(/\/\/.*$/gm, '');
  assert.ok(!/require\('fs'\)|require\('node:fs'\)|writeFile/.test(src));
});
