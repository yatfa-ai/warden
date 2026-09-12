import { describe, it, mock, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import { load, loadCatalog } from './config.js';

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
    // The corrupt text was surfaced to a .corrupt-<digest>.json.bak backup, not lost.
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

describe('config telemetry consent (WARDEN-457 / WARDEN-1116)', () => {
  afterEach(() => {
    mock.restoreAll();
  });

  it('defaults EVERY telemetry consent category to false at fresh state (off by default)', () => {
    // first run — no config file on disk. Off-by-default is a non-negotiable
    // invariant: nothing leaves the machine until the user opts in via Settings.
    mock.method(fs, 'readFileSync', () => {
      throw new Error('ENOENT: config.json does not exist');
    });
    const cfg = load();
    assert.strictEqual(cfg.telemetryIncidentsEnabled, false, 'incidents OFF by default');
    assert.strictEqual(cfg.telemetryNamesEnabled, false, 'names OFF by default');
  });

  it('preserves user-enabled consent through load()', () => {
    mock.method(fs, 'readFileSync', () => JSON.stringify({
      telemetryIncidentsEnabled: true,
      telemetryNamesEnabled: true,
    }));
    const cfg = load();
    assert.strictEqual(cfg.telemetryIncidentsEnabled, true);
    assert.strictEqual(cfg.telemetryNamesEnabled, true);
  });

  it('resolves a MALFORMED persisted consent value to OFF (off-by-default survives corruption)', () => {
    mock.method(fs, 'readFileSync', () => JSON.stringify({
      telemetryIncidentsEnabled: 'true',
      telemetryNamesEnabled: 1,
    }));
    const cfg = load();
    assert.strictEqual(cfg.telemetryIncidentsEnabled, false, 'a string never enables a category');
    assert.strictEqual(cfg.telemetryNamesEnabled, false, 'a number never enables a category');
  });

  it('MIGRATES a pre-WARDEN-1116 opt-in forward with no behavioral change', () => {
    // A user who had base + extended on must land on incidents + names on — the
    // equivalent categories — and nothing else may become enabled.
    mock.method(fs, 'readFileSync', () => JSON.stringify({
      telemetryBaseEnabled: true,
      telemetryExtendedEnabled: true,
    }));
    const cfg = load();
    assert.strictEqual(cfg.telemetryIncidentsEnabled, true, 'base → incidents');
    assert.strictEqual(cfg.telemetryNamesEnabled, true, 'extended → names');
  });

  it('MIGRATES a base-only opt-in without silently enabling names', () => {
    mock.method(fs, 'readFileSync', () => JSON.stringify({ telemetryBaseEnabled: true }));
    const cfg = load();
    assert.strictEqual(cfg.telemetryIncidentsEnabled, true, 'base → incidents');
    assert.strictEqual(cfg.telemetryNamesEnabled, false, 'nothing new is silently enabled');
  });

  it('MIGRATES a stale extended-without-base pair to nothing enabled', () => {
    // The OLD model resolved {base:false, extended:true} to "send nothing". The
    // migration must carry that EFFECTIVE consent forward, not the raw flag —
    // otherwise upgrading would enable a category the user never effectively had.
    mock.method(fs, 'readFileSync', () => JSON.stringify({
      telemetryBaseEnabled: false,
      telemetryExtendedEnabled: true,
    }));
    const cfg = load();
    assert.strictEqual(cfg.telemetryIncidentsEnabled, false);
    assert.strictEqual(cfg.telemetryNamesEnabled, false,
      'a stale legacy pair the old model had latched off does not resurrect as consent');
  });

  it('a MIGRATED config keeps the legacy keys but never lets them override the new ones', () => {
    // Once the new keys exist they are authoritative: a leftover legacy key on
    // disk (or a downgrade/upgrade round trip) can never re-enable a category the
    // user has since turned off.
    mock.method(fs, 'readFileSync', () => JSON.stringify({
      telemetryBaseEnabled: true,
      telemetryExtendedEnabled: true,
      telemetryIncidentsEnabled: false,
      telemetryNamesEnabled: false,
    }));
    const cfg = load();
    assert.strictEqual(cfg.telemetryIncidentsEnabled, false, 'the new key wins over the legacy one');
    assert.strictEqual(cfg.telemetryNamesEnabled, false, 'the new key wins over the legacy one');
  });
});

// WARDEN-1351: pin `reviveCatalog` — the revive hook loadCatalog() passes to
// readJsonDefensive for chats.json. All three behaviors were mutation-tested
// unpinned: replacing the hook body with `return v` left the FULL suite green
// (2515/2515), because the ~26 catalog-seeding suites all write the MODERN
// shape, which takes no branch in the hook. These legs pin:
//   1. the array-shape guard — a syntactically-valid-but-wrong-typed root is
//      RECOVERED (fallback [] + corrupt-file backup), never propagated;
//   2/3. the two legacy migrations — kind:'local' → kind:'tmux' + host default,
//      and cmd+args[] folded into one cmd line — which keep chats created by an
//      OLDER warden build openable after an upgrade (upgrade/corruption paths a
//      developer never exercises locally, exactly where the suite drifted away).
// I/O is mocked at the fs.promises layer (the same object persist.js holds as
// `fsp`), matching this file's no-real-I/O house style — loadCatalog still runs
// the REAL loadCatalog → readJsonDefensive → reviveCatalog → backupCorrupt chain.
describe('chats.json revive hook (reviveCatalog via loadCatalog — WARDEN-1351)', () => {
  afterEach(() => {
    mock.restoreAll();
  });

  // Serve chats.json as `text` through the mocked async layer; the real
  // defensive-read + revive machinery runs on top of it.
  const seedChats = (text) => mock.method(fs.promises, 'readFile', async () => text);
  const absorbBackupWrite = () => mock.method(fs.promises, 'writeFile', async () => {});
  const backupWrite = (writes) =>
    writes.mock.calls.find((c) => /\.corrupt-[0-9a-f]{12}\.json\.bak$/.test(String(c.arguments[0])));

  it('recovers a wrong-typed OBJECT root to [] AND quarantines the file (both halves of the contract)', async () => {
    const corrupt = JSON.stringify({ oops: true });
    seedChats(corrupt);
    const writes = absorbBackupWrite();
    const cats = await loadCatalog();
    assert.deepStrictEqual(cats, [], 'fallback — the request path must never see the raw object');
    const backup = backupWrite(writes);
    assert.ok(backup, 'the wrong-typed file must be backed up, not silently discarded');
    assert.strictEqual(backup.arguments[1], corrupt, 'the backup preserves the original payload verbatim');
  });

  it('same recovery for other wrong-typed roots (JSON string, number) — Array.isArray, not a typeof shortcut', async () => {
    for (const text of [JSON.stringify('hello'), JSON.stringify(42)]) {
      mock.restoreAll();
      seedChats(text);
      const writes = absorbBackupWrite();
      const cats = await loadCatalog();
      assert.deepStrictEqual(cats, [], `fallback for root ${text}`);
      assert.ok(backupWrite(writes), `backup written for root ${text}`);
    }
  });

  it("migrates legacy kind:'local' to kind:'tmux' and defaults host to '(local)'", async () => {
    seedChats(JSON.stringify([{ kind: 'local', session: 's1', cmd: 'claude' }]));
    const [e] = await loadCatalog();
    assert.strictEqual(e.kind, 'tmux', "legacy direct-PTY chats must come back as tmux chats");
    assert.strictEqual(e.host, '(local)', "host defaults to '(local)' when the legacy entry carries none");
    assert.strictEqual(e.session, 's1', 'unrelated keys pass through untouched');
  });

  it("migrating kind:'local' PRESERVES an explicit host — `|| '(local)'` is a default, not an assign", async () => {
    seedChats(JSON.stringify([{ kind: 'local', host: 'myhost', session: 's2', cmd: 'claude' }]));
    const [e] = await loadCatalog();
    assert.strictEqual(e.kind, 'tmux');
    assert.strictEqual(e.host, 'myhost', 'an explicit host must survive the migration');
  });

  it('folds legacy cmd+args[] into one cmd line, deletes args, and drops an empty cmd via filter(Boolean)', async () => {
    seedChats(JSON.stringify([
      { kind: 'tmux', host: '(local)', session: 's3', cmd: 'claude', args: ['--resume', 'abc'] },
      { kind: 'tmux', host: '(local)', session: 's4', cmd: '', args: ['--foo'] },
    ]));
    const [joined, emptyCmd] = await loadCatalog();
    assert.strictEqual(joined.cmd, 'claude --resume abc', 'cmd and args joined with single spaces');
    assert.ok(!('args' in joined), 'args must be deleted after the fold, not left as a stale key');
    assert.strictEqual(emptyCmd.cmd, '--foo', 'a falsy cmd is dropped from the join (no leading space)');
  });

  it('both migrations COMPOSE on one legacy entry (kind + host default + args fold)', async () => {
    seedChats(JSON.stringify([{ kind: 'local', session: 's1', cmd: 'claude', args: ['--resume', 'abc'] }]));
    const [e] = await loadCatalog();
    assert.deepStrictEqual(e, { kind: 'tmux', host: '(local)', session: 's1', cmd: 'claude --resume abc' });
  });

  it('returns a MODERN entry byte-identical — the hook is a no-op on today\u2019s shape', async () => {
    const modern = { host: '(local)', session: 's9', cwd: '/tmp/proj', cmd: 'claude', name: 's9' };
    seedChats(JSON.stringify([modern]));
    const [e] = await loadCatalog();
    assert.deepStrictEqual(e, modern, 'no key added, removed, or rewritten — the hook must not be simplifiable into a lossy one');
  });
});
