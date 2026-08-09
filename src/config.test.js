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
    // WARDEN-831: a corrupt config.json is now backed up (not silently swallowed).
    // Mock the backup write so the test doesn't touch the real home dir.
    const writes = mock.method(fs, 'writeFileSync', () => {});
    mock.method(fs, 'readFileSync', () => 'not valid json {{{');
    const cfg = load();
    assert.strictEqual(cfg.notifyErrors, true);
    assert.strictEqual(cfg.notifyChatOps, true);
    assert.strictEqual(cfg.notifySuccess, true);
    assert.strictEqual(cfg.notifyObserver, true);
    // The corrupt text was surfaced to a .corrupt-<ts>.json backup, not lost.
    assert.ok(writes.mock.calls.some((c) => String(c.arguments[0]).includes('.corrupt-')));
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
    mock.method(fs, 'writeFileSync', () => {}); // absorb the corruption backup (WARDEN-831)
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

// WARDEN-350: the server-side cfg carries an `llm` key so the /api/config
// round-trip has a stable shape. It must be an EMPTY object by default — llm.js
// owns its own fallbacks ('glm-5.2' / 'https://api.anthropic.com' / 2048) and a
// default authToken or model must NEVER be invented here.
describe('config llm (Observer model — WARDEN-350)', () => {
  afterEach(() => {
    mock.restoreAll();
  });

  it('exposes an empty llm object by default (no invented credentials)', () => {
    mock.method(fs, 'readFileSync', () => {
      throw new Error('ENOENT: config.json does not exist');
    });
    const cfg = load();
    assert.ok(cfg.llm && typeof cfg.llm === 'object', 'llm key must exist');
    assert.ok(!Array.isArray(cfg.llm), 'llm must be an object, not an array');
    assert.deepStrictEqual(cfg.llm, {}, 'llm defaults to empty — no default authToken/model');
  });

  it('preserves a user-configured llm object through load()', () => {
    mock.method(fs, 'readFileSync', () => JSON.stringify({
      llm: { model: 'glm-5.2', baseUrl: 'https://gateway.example.com', maxTokens: 4096, authToken: 'sk-tok' },
    }));
    const cfg = load();
    assert.strictEqual(cfg.llm.model, 'glm-5.2');
    assert.strictEqual(cfg.llm.baseUrl, 'https://gateway.example.com');
    assert.strictEqual(cfg.llm.maxTokens, 4096);
    assert.strictEqual(cfg.llm.authToken, 'sk-tok');
  });
});

describe('config telemetry consent (WARDEN-457)', () => {
  afterEach(() => {
    mock.restoreAll();
  });

  it('defaults BOTH telemetry tiers to false at fresh state (off by default)', () => {
    // first run — no config file on disk. Off-by-default is a non-negotiable
    // invariant: nothing leaves the machine until the user opts in via Settings.
    mock.method(fs, 'readFileSync', () => {
      throw new Error('ENOENT: config.json does not exist');
    });
    const cfg = load();
    assert.strictEqual(cfg.telemetryBaseEnabled, false, 'base tier OFF by default');
    assert.strictEqual(cfg.telemetryExtendedEnabled, false, 'extended tier OFF by default');
  });

  it('preserves user-enabled consent through load()', () => {
    mock.method(fs, 'readFileSync', () => JSON.stringify({
      telemetryBaseEnabled: true,
      telemetryExtendedEnabled: true,
    }));
    const cfg = load();
    assert.strictEqual(cfg.telemetryBaseEnabled, true);
    assert.strictEqual(cfg.telemetryExtendedEnabled, true);
  });
});

