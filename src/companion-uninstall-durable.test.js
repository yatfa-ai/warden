// WARDEN-1475 — an operator's companion removal is DURABLE until the operator
// reverses it. The roadmap-WARDEN-270 "Removability" outcome ("nothing gets
// installed that cannot be taken off") was built in the opt-in era (WARDEN-882)
// and voided by the default-ON cutover (WARDEN-1379) without a line of its own
// code changing: uninstallCompanion's writes are all process-lifetime in-memory
// maps, and the now-always-running 60s lifecycle tick re-uploaded the binary and
// respawned the channel within ~60 seconds — no error, no user-visible signal.
//
// THE MEASUREMENT THIS FILE PINS, and why it is COUNTERS and not status:
// status alone is a weak instrument here. A host can read `inactive` for many
// reasons (toggle off, never engaged, LOCAL), so asserting it after a removal
// cannot distinguish "nothing was installed" from "the status map happened to be
// empty at read time". The bootstrap SEAM counters can: `upload` is the binary
// being streamed to the host and `spawnChannel` is the ssh child being started.
// Those two going 1 → 2 across one ordinary op IS the defect, and holding at 1
// IS the fix. Every assertion below reads them.
//
// POSITIVE CONTROLS everywhere: each refusal assertion is paired with a leg
// that proves the same instrument SEES a successful bootstrap (the counters do
// move when nothing suppresses them), so a green result can never come from an
// instrument that is simply dead.
//
// No real ssh anywhere — everything rides the shipped deps seams
// (deps.run / deps.upload / deps.spawnChannel), exactly as companion.test.js does.
import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert';
import {
  getChannel, discover, uninstallCompanion, recordCompanionUninstall,
  applyCompanionExclusions, isCompanionExcludedHost,
  getCompanionStatus, CompanionChannel, CompanionTransportError,
  _resetChannelCacheForTests, _channelCacheHasForTests, _bootstrapFailureForTests,
} from './companion.js';
import { load } from './config.js';

const TEST_VER = 'abc123def456';
const TEST_MANIFEST = {
  version: TEST_VER,
  binaries: {
    'linux/amd64': 'warden-companion-linux-amd64',
    'linux/arm64': 'warden-companion-linux-arm64',
    'darwin/amd64': 'warden-companion-darwin-amd64',
    'darwin/arm64': 'warden-companion-darwin-arm64',
    'windows/amd64': 'warden-companion-windows-amd64.exe',
    'windows/arm64': 'warden-companion-windows-arm64.exe',
  },
};

// A transport that answers ping (so a bootstrap SUCCEEDS whenever one is
// allowed to start) and every product op this file drives.
function fakeTransport() {
  let lineCB = null;
  return {
    write(line) {
      let req;
      try { req = JSON.parse(line); } catch { return; }
      const resp = req.method === 'ping'
        ? { id: req.id, ok: true, result: { version: TEST_VER, methods: ['ping', 'discover'] } }
        : { id: req.id, ok: true, result: { containers: [] } };
      setImmediate(() => { if (lineCB) lineCB(JSON.stringify(resp)); });
    },
    onLine(cb) { lineCB = cb; },
    onExit() {},
    kill() {},
  };
}

// The three bootstrap seams, counted. `upload` and `spawnChannel` are the two
// that answer "was the binary re-installed and the channel respawned".
function countingDeps() {
  const calls = { run: 0, upload: 0, spawnChannel: 0 };
  return {
    calls,
    deps: {
      manifest: TEST_MANIFEST,
      run: async () => { calls.run++; return { ok: true, code: 0, stdout: 'OS=Linux\nARCH=x86_64\nHAVE=0\n' }; },
      upload: async () => { calls.upload++; return { ok: true }; },
      spawnChannel: () => { calls.spawnChannel++; return fakeTransport(); },
    },
  };
}

const okRun = async () => ({ ok: true, code: 0, stdout: '', stderr: '' });

let savedToggleEnv;
let savedExclusionEnv;

before(() => {
  savedToggleEnv = process.env.WARDEN_COMPANION_TRANSPORT;
  savedExclusionEnv = process.env.WARDEN_COMPANION_EXCLUDED_HOSTS;
});

beforeEach(() => {
  // The transport MUST be ON: getCompanionStatus short-circuits to a bare
  // `inactive` while it is off, which would make every status assertion here
  // tautological, and the routing gates only consult the exclusion when on.
  process.env.WARDEN_COMPANION_TRANSPORT = '1';
  process.env.WARDEN_COMPANION_EXCLUDED_HOSTS = '';
  applyCompanionExclusions([]);
  _resetChannelCacheForTests();
});

after(() => {
  applyCompanionExclusions([]);
  if (savedToggleEnv === undefined) delete process.env.WARDEN_COMPANION_TRANSPORT;
  else process.env.WARDEN_COMPANION_TRANSPORT = savedToggleEnv;
  if (savedExclusionEnv === undefined) delete process.env.WARDEN_COMPANION_EXCLUDED_HOSTS;
  else process.env.WARDEN_COMPANION_EXCLUDED_HOSTS = savedExclusionEnv;
  _resetChannelCacheForTests();
});

// ---------------------------------------------------------------------------
// 1. THE MEASURED DEFECT IS CLOSED (success criterion 1)
// ---------------------------------------------------------------------------

describe('WARDEN-1475: a removal survives the next ordinary op (the measured defect)', () => {
  it('bootstrap → uninstall → ONE ordinary discover(): no upload, no channel spawn, host stays inactive', async () => {
    const HOST = 'durable-1';
    const cfg = { companionExcludedHosts: [] };
    const { deps, calls } = countingDeps();

    // Precondition: a real bootstrap, so the counters have a live baseline and
    // the host is genuinely `active` before the removal.
    await getChannel(HOST, cfg, deps);
    assert.strictEqual(calls.upload, 1, 'precondition: the binary was uploaded once');
    assert.strictEqual(calls.spawnChannel, 1, 'precondition: one channel was spawned');
    assert.deepStrictEqual(getCompanionStatus(HOST), { state: 'active', version: TEST_VER },
      'precondition: the host reads active');

    const res = await uninstallCompanion(HOST, cfg, { manifest: TEST_MANIFEST, run: okRun });
    assert.strictEqual(res.ok, true, 'precondition: the uninstall script ran');

    const uploadsAfterRemoval = calls.upload;
    const spawnsAfterRemoval = calls.spawnChannel;

    // ONE ordinary op — the same call the 60s lifecycle tick makes per host.
    const r = await discover(HOST, cfg, {}, deps);

    assert.strictEqual(calls.upload, uploadsAfterRemoval,
      `THE DEFECT: the binary was re-uploaded after a removal (${uploadsAfterRemoval} → ${calls.upload})`);
    assert.strictEqual(calls.spawnChannel, spawnsAfterRemoval,
      `THE DEFECT: the channel was respawned after a removal (${spawnsAfterRemoval} → ${calls.spawnChannel})`);
    assert.strictEqual(_channelCacheHasForTests(HOST), false, 'no channel was cached for the removed host');
    assert.notStrictEqual(getCompanionStatus(HOST).state, 'active',
      'the host must not return to active on its own');
    assert.strictEqual(r.ok, false, 'companion-or-fail: the op reports the refusal rather than silently re-installing');
    assert.match(r.error, /excluded/i, `the refusal names the reason: ${r.error}`);
  });

  it('POSITIVE CONTROL — the SAME instrument sees a normal re-bootstrap for a host that was never removed', async () => {
    // Without this leg, a green test above could come from an instrument that
    // never moves. Here nothing suppresses the bootstrap, so it must move.
    const HOST = 'durable-control';
    const cfg = { companionExcludedHosts: [] };
    const { deps, calls } = countingDeps();

    await getChannel(HOST, cfg, deps);
    assert.strictEqual(calls.upload, 1);
    assert.strictEqual(calls.spawnChannel, 1);

    // Drop the cached channel WITHOUT recording a removal (the in-memory-only
    // teardown the pre-fix uninstall amounted to), then run one ordinary op.
    _resetChannelCacheForTests();
    const r = await discover(HOST, cfg, {}, deps);

    assert.strictEqual(r.ok, true, 'the op succeeded');
    assert.strictEqual(calls.upload, 2, 'the instrument SEES a re-upload when nothing suppresses it');
    assert.strictEqual(calls.spawnChannel, 2, 'the instrument SEES a respawn when nothing suppresses it');
    // state/version only — a ridden op adds its WARDEN-1312 tally to the status.
    const status = getCompanionStatus(HOST);
    assert.strictEqual(status.state, 'active',
      'and the host returns to active — exactly what a removed host must NOT do');
    assert.strictEqual(status.version, TEST_VER, 'with the version the bootstrap ping verified');
  });

  it('every getChannel caller is covered — a direct getChannel throws, not only the op skeleton', async () => {
    // There are three non-test getChannel call sites (companionOp, attachSession,
    // the pane-sync release leg). The gate lives INSIDE getChannel precisely so a
    // site that bypasses companionOp inherits it; this pins that placement.
    const HOST = 'durable-direct';
    const cfg = { companionExcludedHosts: [] };
    const { deps, calls } = countingDeps();
    await getChannel(HOST, cfg, deps);
    await uninstallCompanion(HOST, cfg, { manifest: TEST_MANIFEST, run: okRun });
    const before = { ...calls };

    await assert.rejects(() => getChannel(HOST, cfg, deps), (e) => {
      assert.ok(e instanceof CompanionTransportError, 'a transport error, not a generic throw');
      assert.match(e.message, /excluded from companion transport/, e.message);
      return true;
    });
    assert.strictEqual(calls.upload, before.upload, 'no upload from the direct call either');
    assert.strictEqual(calls.spawnChannel, before.spawnChannel, 'no spawn from the direct call either');
  });

  it('a FAILED uninstall records nothing — the binary is still there, so the transport must keep working', async () => {
    // The durable fact is recorded on SUCCESS only. Suppressing a host whose rm
    // never ran would dark a host that still has a perfectly good companion.
    const HOST = 'durable-failed';
    const cfg = { companionExcludedHosts: [] };
    const { deps, calls } = countingDeps();
    await getChannel(HOST, cfg, deps);

    const res = await uninstallCompanion(HOST, cfg, {
      manifest: TEST_MANIFEST,
      run: async () => ({ ok: false, code: 255, stdout: '', stderr: 'Permission denied (publickey).' }),
    });
    assert.strictEqual(res.ok, false, 'precondition: the removal failed');
    assert.deepStrictEqual(cfg.companionExcludedHosts, [], 'nothing was recorded for a failed removal');
    assert.strictEqual(isCompanionExcludedHost(HOST), false, 'and nothing was applied to the live gate');

    const r = await discover(HOST, cfg, {}, deps);
    assert.strictEqual(r.ok, true, 'the host still works over the companion — it was never actually cleaned');
    assert.strictEqual(calls.spawnChannel, 2, 'a fresh channel was spawned, as it should be');
  });
});

// ---------------------------------------------------------------------------
// 2. THE FACT SURVIVES A PROCESS RESTART (success criterion 2)
// ---------------------------------------------------------------------------

describe('WARDEN-1475: the removal is persisted config, not an in-memory map', () => {
  it('the recorded fact lands on cfg.companionExcludedHosts — the field save() writes and load() reads back', async () => {
    const HOST = 'durable-persist';
    const cfg = { companionExcludedHosts: [] };
    await uninstallCompanion(HOST, cfg, { manifest: TEST_MANIFEST, run: okRun });
    assert.deepStrictEqual(cfg.companionExcludedHosts, [HOST],
      'the fact is on the PERSISTED config field, not in a process-lifetime map');

    // Structural proof that this field is a real persisted preference rather
    // than an ad-hoc property: the config loader's derived defaults declare it.
    const defaults = load();
    assert.ok('companionExcludedHosts' in defaults,
      'companionExcludedHosts is a declared config field, so save() persists it and load() restores it');
    assert.ok(Array.isArray(defaults.companionExcludedHosts), 'and it is array-shaped');
  });

  it('a FRESH process state re-hydrating that config refuses the bootstrap — the restart simulation', async () => {
    // Simulate the restart: wipe EVERY in-memory companion map (the maps a real
    // process restart starts empty), then re-apply ONLY what came off disk —
    // which is exactly what server.js's boot does (applyCompanionExclusions at
    // :119, from the loaded cfg). If the fact lived in a map, this would
    // re-install; because it lives in config, it does not.
    const HOST = 'durable-restart';
    const persistedCfg = { companionExcludedHosts: [] };
    const first = countingDeps();
    await getChannel(HOST, persistedCfg, first.deps);
    await uninstallCompanion(HOST, persistedCfg, { manifest: TEST_MANIFEST, run: okRun });

    // --- the "restart" ---
    _resetChannelCacheForTests();                 // every per-host map starts empty
    process.env.WARDEN_COMPANION_EXCLUDED_HOSTS = ''; // the env gate starts unset
    applyCompanionExclusions([]);
    assert.strictEqual(isCompanionExcludedHost(HOST), false,
      'precondition: after the wipe, nothing in memory knows about the removal');

    // Boot re-applies the list read off disk.
    const rehydrated = { companionExcludedHosts: [...persistedCfg.companionExcludedHosts] };
    applyCompanionExclusions(rehydrated.companionExcludedHosts);

    const second = countingDeps();
    const r = await discover(HOST, rehydrated, {}, second.deps);
    assert.strictEqual(r.ok, false, 'the removal still holds after the restart');
    assert.strictEqual(second.calls.upload, 0, 'no binary was re-uploaded by the fresh process');
    assert.strictEqual(second.calls.spawnChannel, 0, 'no channel was respawned by the fresh process');
  });
});

// ---------------------------------------------------------------------------
// 3. THE INDICATOR KEEPS TELLING THE TRUTH (success criterion 3)
// ---------------------------------------------------------------------------

describe('WARDEN-1475: the status surface stays honest across subsequent ticks', () => {
  it('getCompanionStatus reads inactive WITH a reason, and stays that way over repeated ops', async () => {
    const HOST = 'durable-status';
    const cfg = { companionExcludedHosts: [] };
    const { deps } = countingDeps();
    await getChannel(HOST, cfg, deps);
    assert.strictEqual(getCompanionStatus(HOST).state, 'active', 'precondition: active');

    await uninstallCompanion(HOST, cfg, { manifest: TEST_MANIFEST, run: okRun });
    assert.deepStrictEqual(getCompanionStatus(HOST), { state: 'inactive', reason: 'excluded-by-setting' },
      'the removed host says WHY the channel is dark instead of looking broken');

    // Three more "ticks". A status that flickered into `bootstrapping` or
    // `error` would be the indicator lying about a host nobody is installing to.
    for (let i = 0; i < 3; i++) await discover(HOST, cfg, {}, deps);
    assert.deepStrictEqual(getCompanionStatus(HOST), { state: 'inactive', reason: 'excluded-by-setting' },
      'and it holds across subsequent ticks — no bootstrapping flicker, no error dot');
  });
});

// ---------------------------------------------------------------------------
// 4. WARDEN-1399's CONTRACT IS INTACT (success criterion 4)
// ---------------------------------------------------------------------------

describe('WARDEN-1475: the removal fact and the bootstrap-failure cooldown are DIFFERENT facts', () => {
  it('a host uninstalled mid-cooldown still has its failure record cleared (WARDEN-1399 unchanged)', async () => {
    const HOST = 'durable-cooldown';
    const cfg = { companionExcludedHosts: [] };
    const failing = {
      manifest: TEST_MANIFEST,
      run: async () => { throw new Error('probe refused'); },
      upload: async () => ({ ok: true }),
      spawnChannel: () => fakeTransport(),
    };
    await assert.rejects(() => getChannel(HOST, cfg, failing), () => true);
    assert.ok(_bootstrapFailureForTests(HOST), 'precondition: a failure record is stamped');

    await uninstallCompanion(HOST, cfg, { manifest: TEST_MANIFEST, run: okRun });
    assert.strictEqual(_bootstrapFailureForTests(HOST), undefined,
      'WARDEN-1399 INTACT: the removal still clears the stale FAILURE suppression');
    assert.deepStrictEqual(cfg.companionExcludedHosts, [HOST],
      'and the separate DELIBERATE-REMOVAL fact was recorded beside it');
  });

  it('lifting the removal leaves no failure suppression behind — the two never got collapsed', async () => {
    const HOST = 'durable-uncollapsed';
    const cfg = { companionExcludedHosts: [] };
    const failing = {
      manifest: TEST_MANIFEST,
      run: async () => { throw new Error('probe refused'); },
      upload: async () => ({ ok: true }),
      spawnChannel: () => fakeTransport(),
    };
    await assert.rejects(() => getChannel(HOST, cfg, failing), () => true);
    await uninstallCompanion(HOST, cfg, { manifest: TEST_MANIFEST, run: okRun });

    // Re-include: if the removal had been implemented by RE-STAMPING a failure
    // record instead of a separate durable fact, this host would now fail fast
    // off that record rather than getting a fair attempt.
    applyCompanionExclusions([]);
    const { deps, calls } = countingDeps();
    const ch = await getChannel(HOST, cfg, deps);
    assert.ok(ch instanceof CompanionChannel, 'the re-included host got a fair bootstrap attempt');
    assert.strictEqual(calls.upload, 1, 'and a real install, not a suppressed one');
  });
});

// ---------------------------------------------------------------------------
// 5. RE-INSTALL IS ONE OPERATOR GESTURE (success criterion 5) — both directions
// ---------------------------------------------------------------------------

describe('WARDEN-1475: re-install is one gesture, and it is reversible both ways', () => {
  it('removing the host from the persisted list lets the very next op bootstrap normally', async () => {
    const HOST = 'durable-reinstall';
    const cfg = { companionExcludedHosts: [] };
    const { deps, calls } = countingDeps();

    await getChannel(HOST, cfg, deps);
    await uninstallCompanion(HOST, cfg, { manifest: TEST_MANIFEST, run: okRun });

    // DIRECTION 1: suppressed.
    let r = await discover(HOST, cfg, {}, deps);
    assert.strictEqual(r.ok, false, 'suppressed while the fact holds');
    const suppressed = { ...calls };

    // THE ONE GESTURE: take the host off the list (what the Settings input does)
    // and apply it, exactly as afterSave does on a PUT /api/config.
    cfg.companionExcludedHosts = cfg.companionExcludedHosts.filter((h) => h !== HOST);
    applyCompanionExclusions(cfg.companionExcludedHosts);

    // DIRECTION 2: re-installed.
    r = await discover(HOST, cfg, {}, deps);
    assert.strictEqual(r.ok, true, 'one gesture later, the op succeeds again');
    assert.strictEqual(calls.upload, suppressed.upload + 1, 'the binary was re-installed');
    assert.strictEqual(calls.spawnChannel, suppressed.spawnChannel + 1, 'and the channel respawned');
    // state/version only — the discover just ridden adds its WARDEN-1312 tally.
    const status = getCompanionStatus(HOST);
    assert.strictEqual(status.state, 'active', 'and the host reads active again');
    assert.strictEqual(status.version, TEST_VER, 'with the verified version');
  });
});

// ---------------------------------------------------------------------------
// 6. recordCompanionUninstall's own contract
// ---------------------------------------------------------------------------

describe('WARDEN-1475: recordCompanionUninstall (the durable-fact recorder)', () => {
  it('adds the host once and reports changed', () => {
    const cfg = { companionExcludedHosts: [] };
    assert.deepStrictEqual(recordCompanionUninstall('rec-a', cfg), { changed: true, hosts: ['rec-a'] });
    assert.deepStrictEqual(cfg.companionExcludedHosts, ['rec-a']);
  });

  it('is IDEMPOTENT — a re-removal (or a host the user already excluded by hand) writes nothing', () => {
    const cfg = { companionExcludedHosts: ['rec-b'] };
    const res = recordCompanionUninstall('rec-b', cfg);
    assert.strictEqual(res.changed, false, 'no change → the route can skip a pointless config write');
    assert.deepStrictEqual(cfg.companionExcludedHosts, ['rec-b'], 'and the list is not double-added to');
  });

  it('preserves the OTHER hosts already on the list (a removal is not a list replacement)', () => {
    const cfg = { companionExcludedHosts: ['win-box'] };
    recordCompanionUninstall('rec-c', cfg);
    assert.deepStrictEqual(cfg.companionExcludedHosts, ['win-box', 'rec-c'],
      "a user's hand-typed exclusion survives an unrelated host's removal");
  });

  it('refuses LOCAL, blanks and non-strings (the companion is remote-only)', () => {
    for (const bad of ['(local)', '', '   ', null, undefined, 42, {}]) {
      const cfg = { companionExcludedHosts: [] };
      const res = recordCompanionUninstall(bad, cfg);
      assert.strictEqual(res.changed, false, `refused: ${JSON.stringify(bad)}`);
      assert.deepStrictEqual(cfg.companionExcludedHosts, [], `nothing written for: ${JSON.stringify(bad)}`);
    }
  });

  it('records nothing when the EXISTING list is malformed — never persists a value the PUT guard refuses', () => {
    // ',' is the env serialization separator, so the whole-field sanitizer
    // refuses a list carrying one. Recording anyway would write a value PUT
    // /api/config would reject, and serialize an ambiguous env list.
    const cfg = { companionExcludedHosts: ['bad,entry'] };
    const res = recordCompanionUninstall('rec-d', cfg);
    assert.strictEqual(res.changed, false, 'the sanitizer refusal is honored');
    assert.deepStrictEqual(cfg.companionExcludedHosts, ['bad,entry'], 'the (pre-existing) list is left untouched');
  });

  it('tolerates a cfg with no list at all (an older config.json predating the field)', () => {
    const cfg = {};
    assert.deepStrictEqual(recordCompanionUninstall('rec-e', cfg), { changed: true, hosts: ['rec-e'] });
    assert.deepStrictEqual(cfg.companionExcludedHosts, ['rec-e']);
  });

  it('LIVE-APPLIES the fact: the env gate every routing predicate reads is updated at once', () => {
    const cfg = { companionExcludedHosts: [] };
    assert.strictEqual(isCompanionExcludedHost('rec-live'), false, 'precondition: not excluded');
    recordCompanionUninstall('rec-live', cfg);
    assert.strictEqual(isCompanionExcludedHost('rec-live'), true,
      'the refusal is in force on the very next op, with no restart');
  });
});
