import { describe, it, mock, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import { load } from './config.js';

// `load()` reads `~/.yatfa-warden/config.json` via fs.readFileSync. We mock that
// call to drive the merge/default behavior deterministically (no real file I/O).
describe('config notification preferences', () => {
  afterEach(() => {
    mock.restoreAll();
  });

  it('exposes the 4 notification categories, all enabled by default', () => {
    // first run — no config file on disk
    mock.method(fs, 'readFileSync', () => {
      throw new Error('ENOENT: config.json does not exist');
    });
    const cfg = load();
    assert.strictEqual(cfg.notifyChatOps, true);
    assert.strictEqual(cfg.notifyErrors, true);
    assert.strictEqual(cfg.notifySuccess, true);
    assert.strictEqual(cfg.notifyObserver, true);
  });

  it('does NOT expose the removed notifyAgentLifecycle toggle', () => {
    mock.method(fs, 'readFileSync', () => {
      throw new Error('ENOENT');
    });
    const cfg = load();
    assert.ok(
      !('notifyAgentLifecycle' in cfg),
      'notifyAgentLifecycle was a dead toggle (nothing to gate) and must be removed'
    );
  });

  it('preserves user overrides while defaulting unset notification prefs', () => {
    mock.method(fs, 'readFileSync', () =>
      JSON.stringify({ notifyErrors: false, notifyObserver: false })
    );
    const cfg = load();
    assert.strictEqual(cfg.notifyErrors, false, 'user override honored');
    assert.strictEqual(cfg.notifyObserver, false, 'user override honored');
    assert.strictEqual(cfg.notifyChatOps, true, 'unset pref keeps default');
    assert.strictEqual(cfg.notifySuccess, true, 'unset pref keeps default');
  });

  it('falls back to defaults when the config file is corrupt', () => {
    mock.method(fs, 'readFileSync', () => 'not valid json {{{');
    const cfg = load();
    assert.strictEqual(cfg.notifyErrors, true);
    assert.strictEqual(cfg.notifyChatOps, true);
    assert.strictEqual(cfg.notifySuccess, true);
    assert.strictEqual(cfg.notifyObserver, true);
  });

  it('disabling chat ops is observable through load() round-trip', () => {
    // Simulates what happens after a user toggles "Chat operations" off in Settings
    // and the app reloads prefs — the preference must persist and read back as false.
    mock.method(fs, 'readFileSync', () => JSON.stringify({ notifyChatOps: false }));
    const cfg = load();
    assert.strictEqual(cfg.notifyChatOps, false);
    assert.strictEqual(cfg.notifyErrors, true, 'other categories unaffected');
  });
});

describe('config confirm-before-destructive-actions preference', () => {
  afterEach(() => {
    mock.restoreAll();
  });

  it('defaults to ON (true) on first run', () => {
    // first run — no config file on disk; the footgun fix must apply immediately
    mock.method(fs, 'readFileSync', () => {
      throw new Error('ENOENT: config.json does not exist');
    });
    const cfg = load();
    assert.strictEqual(cfg.confirmDestructiveActions, true);
  });

  it('honors a user opt-out (false) and round-trips through load()', () => {
    // Simulates a power user disabling confirms in Settings and the app reloading
    // — the opt-out must persist and read back as false.
    mock.method(fs, 'readFileSync', () => JSON.stringify({ confirmDestructiveActions: false }));
    const cfg = load();
    assert.strictEqual(cfg.confirmDestructiveActions, false);
  });

  it('falls back to ON when the config file is corrupt', () => {
    mock.method(fs, 'readFileSync', () => 'not valid json {{{');
    const cfg = load();
    assert.strictEqual(cfg.confirmDestructiveActions, true);
  });

  it('keeps the default ON even when other prefs are overridden', () => {
    // An existing user who only customizes unrelated prefs must still get the
    // safe default — no silent regression of the destructive-action guard.
    mock.method(fs, 'readFileSync', () => JSON.stringify({ pollIntervalMs: 9999 }));
    const cfg = load();
    assert.strictEqual(cfg.confirmDestructiveActions, true);
  });
});
