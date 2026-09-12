import { describe, it, mock, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import { load, loadCatalog, catalogPath } from './config.js';
import { corruptBackupPath } from './persist.js';

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


// WARDEN-1351: pin `reviveCatalog` — the revive hook `loadCatalog()` passes to
// readJsonDefensive (persist.js) for chats.json. Mutation-probed at origin/main:
// gutting the whole hook body to `return v` (deleting the array guard AND both
// legacy migrations) still left the FULL suite green (2515/2515) — every
// catalog-seeding suite (~26) writes today's MODERN shape, which takes no branch
// in the hook. The hook carries three behaviors, pinned here one leg at a time:
//   (1) the array-shape guard — a syntactically-valid-but-wrong-typed file is
//       quarantined to *.corrupt-<digest>.json.bak and the [] fallback returned,
//       never propagated (the WARDEN-89 never-silently-default invariant);
//   (2) legacy kind:'local' → kind:'tmux' with host defaulting to '(local)';
//   (3) legacy cmd + args[] folded into one joined cmd line, args deleted.
// chats.json is the user's hand-created chat catalog — the only record of chats
// they spawned manually — so the guard is the crash-barrier on the request path
// and the migrations are what keep chats created by an OLDER warden build
// openable after an upgrade. Both are upgrade/corruption paths a developer never
// exercises locally, which is exactly how the suite drifted off them.
//
// MECHANISM: config.js is statically imported above, so it is evaluated against
// the REAL HOME — `catalogPath` is pinned at module load (os.homedir()) and the
// throwaway-HOME + dynamic-import harness used by catalog-concurrency.test.js /
// server-catalog.test.js cannot re-pin it here (a second import returns the
// already-evaluated module). Instead we drive the REAL
// loadCatalog() → readJsonDefensive() → reviveCatalog() chain by intercepting
// fs.promises — the same mock.method(fs, …) idiom the load() tests above use for
// their sync reads. persist.js holds `fsp = fs.promises` by reference, so the
// mock reaches the defensive read, and every unmatched path calls through to the
// real fs. The quarantine half of the guard is asserted on the intercepted
// .bak write: the exact content-addressed path (via corruptBackupPath, the
// production helper) plus the original bytes preserved — both halves together,
// so a silent default alone cannot pass legs 1–2.
describe('loadCatalog revive hook — chats.json guard + legacy migrations (WARDEN-1351)', () => {
  const seededReads = new Map(); // path -> raw file text served to the defensive read
  const backupWrites = []; // recorded .bak quarantine writes { path, text }
  // Captured BEFORE any mock is installed; unmatched paths call through to the
  // real fs so nothing outside chats.json sees the harness.
  const realReadFile = fs.promises.readFile.bind(fs.promises);
  const realWriteFile = fs.promises.writeFile.bind(fs.promises);

  const armFs = () => {
    mock.method(fs.promises, 'readFile', (p) => {
      const text = seededReads.get(String(p));
      return text === undefined ? realReadFile(p, 'utf8') : Promise.resolve(text);
    });
    mock.method(fs.promises, 'writeFile', (p, text) => {
      if (String(p).endsWith('.bak')) {
        backupWrites.push({ path: String(p), text: String(text) });
        return Promise.resolve();
      }
      return realWriteFile(p, text);
    });
  };
  const seedRaw = (raw) => seededReads.set(catalogPath, raw);
  const seedCatalog = (entries) => seedRaw(JSON.stringify(entries, null, 2) + '\n');

  afterEach(() => {
    mock.restoreAll();
    seededReads.clear();
    backupWrites.length = 0;
  });

  it('non-array root (object) → [] fallback AND a *.corrupt-*.json.bak quarantine write', async () => {
    armFs();
    const raw = '{"oops":true}';
    seedRaw(raw);
    assert.deepStrictEqual(await loadCatalog(), [],
      'a wrong-typed root must resolve to the [] fallback, never propagate');
    const expected = corruptBackupPath(catalogPath, raw);
    const call = backupWrites.find((b) => b.path === expected);
    assert.ok(call,
      `corrupt file must be quarantined to ${expected} — the fallback alone would pass against a silent default`);
    assert.strictEqual(call.text, raw, 'quarantine must preserve the original bytes');
  });

  it('non-array root (JSON string, then number) → same [] + quarantine contract — pins Array.isArray, not a typeof check', async () => {
    armFs();
    for (const raw of ['"a bare JSON string"', '42']) {
      backupWrites.length = 0;
      seedRaw(raw);
      assert.deepStrictEqual(await loadCatalog(), [],
        `root ${raw} parses fine but is not an array → fallback`);
      const expected = corruptBackupPath(catalogPath, raw);
      const call = backupWrites.find((b) => b.path === expected);
      assert.ok(call, `string/number roots must be quarantined too (${expected})`);
      assert.strictEqual(call.text, raw, 'quarantine must preserve the original bytes');
    }
  });

  it("legacy kind:'local' migrates to kind:'tmux' with host defaulted to '(local)'", async () => {
    armFs();
    seedCatalog([{ kind: 'local', session: 's1', cmd: 'claude' }]);
    assert.deepStrictEqual(await loadCatalog(), [
      { kind: 'tmux', host: '(local)', session: 's1', cmd: 'claude' },
    ], "kind:'local' (direct PTY) must fold forward to the tmux shape");
  });

  it("legacy kind:'local' with an EXPLICIT host keeps that host (pins the e.host || '(local)' term)", async () => {
    armFs();
    seedCatalog([{ kind: 'local', host: 'prod-box', session: 's2', cmd: 'claude' }]);
    const list = await loadCatalog();
    assert.strictEqual(list[0].kind, 'tmux');
    assert.strictEqual(list[0].host, 'prod-box',
      "an explicit host must survive the migration — leg 3 alone cannot tell a default from an unconditional assign");
  });

  it('legacy cmd+args[] folds into one joined cmd, the args key is deleted, and filter(Boolean) drops an empty cmd', async () => {
    armFs();
    seedCatalog([
      { kind: 'tmux', host: '(local)', session: 's3', cmd: 'claude', args: ['--resume', 'abc123'] },
      { kind: 'tmux', host: '(local)', session: 's3b', cmd: 'claude', args: [] },
      { kind: 'tmux', host: '(local)', session: 's3c', cmd: '', args: ['--resume', 'abc123'] },
    ]);
    const list = await loadCatalog();
    const bySession = Object.fromEntries(list.map((e) => [e.session, e]));
    assert.strictEqual(bySession.s3.cmd, 'claude --resume abc123', 'cmd + args joined with single spaces');
    assert.ok(!('args' in bySession.s3), 'the folded args key must be deleted, not kept alongside cmd');
    assert.strictEqual(bySession.s3b.cmd, 'claude', 'an EMPTY args array folds to the unchanged cmd');
    assert.ok(!('args' in bySession.s3b), 'even an empty args key is folded away');
    assert.strictEqual(bySession.s3c.cmd, '--resume abc123',
      'filter(Boolean) drops the empty cmd head — without it this joins to " --resume abc123"');
  });

  it('combined legacy entry — the kind migration and the args fold compose in ONE pass', async () => {
    armFs();
    seedCatalog([{ kind: 'local', session: 's4', cmd: 'claude', args: ['-c', 'continue'] }]);
    assert.deepStrictEqual(await loadCatalog(), [
      { kind: 'tmux', host: '(local)', session: 's4', cmd: 'claude -c continue' },
    ], 'both migrations must apply to the same entry');
  });

  it('a MODERN entry round-trips unchanged — the hook is a no-op on today\'s shape', async () => {
    armFs();
    const modern = { host: '(local)', session: 's5', cwd: '/tmp/proj', cmd: 'claude --resume xyz', name: 's5' };
    seedCatalog([modern]);
    assert.deepStrictEqual(await loadCatalog(), [modern],
      "today's shape must survive the hook untouched — a future 'simplification' that makes it lossy fails here");
  });
});
