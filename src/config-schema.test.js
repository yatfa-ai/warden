import { describe, it } from 'node:test';
import assert from 'node:assert';

/**
 * Unit tests for the pure registry functions in src/config-schema.js (WARDEN-773).
 *
 * The HTTP-level wire contract (GET shape/order/masking, PUT guards/clamps/
 * no-clobber, post-save side-effects) is pinned end-to-end in
 * server-config-registry.test.js + the sibling server-config*.test.js files.
 * THIS file unit-tests the pure derivations directly — fast, no server — and
 * pins the two structural properties the HTTP tests can't reach on their own:
 *
 *   - DEFAULTS is fully derived from CONFIG_FIELDS (the "single source of
 *     truth" success criterion #1) — key set, persisted order, and values.
 *   - afterSave invokes ALL FOUR post-save deps (Correction 2) — the structural
 *     guarantee that a registry refactor can't silently drop a side-effect.
 */

import {
  CONFIG_FIELDS,
  deriveDefaults,
  buildGetResponse,
  applyConfigPut,
  afterSave,
  resetConfig,
  validateRegistry,
} from './config-schema.js';

describe('deriveDefaults — DEFAULTS is fully derived from CONFIG_FIELDS', () => {
  it('produces every default-only and public/secret field (NOT the derived one)', () => {
    const d = deriveDefaults();
    // The derived field companionTransportOverridden is computed from env, not
    // persisted — it must NOT appear in DEFAULTS.
    assert.ok(!('companionTransportOverridden' in d), 'derived field is not a persisted default');
    // Every non-derived descriptor with a default is present.
    for (const f of CONFIG_FIELDS) {
      if (f.exposure === 'derived') continue;
      if (!('default' in f)) continue;
      assert.ok(f.key in d, `default for '${f.key}' is derived`);
    }
  });

  it('preserves the byte-pinned persisted key order (config.json order)', () => {
    // The DEFAULTS key order IS the CONFIG_FIELDS array order (minus the derived
    // entry). This is the order save() writes to config.json.
    const d = deriveDefaults();
    const expected = CONFIG_FIELDS
      .filter((f) => f.exposure !== 'derived' && 'default' in f)
      .map((f) => f.key);
    assert.deepStrictEqual(Object.keys(d), expected,
      'DEFAULTS key order must follow CONFIG_FIELDS array order');
  });

  it('carries the canonical default values', () => {
    const d = deriveDefaults();
    assert.strictEqual(d.connectTimeout, 10);
    assert.strictEqual(d.tmuxSession, 'agent');
    assert.strictEqual(d.healthWarningThresholdMin, 5);
    assert.strictEqual(d.healthCriticalThresholdMin, 30);
    assert.strictEqual(d.tokenBudgetWindowHours, 24);
    assert.strictEqual(d.tokenBudgetThresholdTokens, 2_000_000);
    assert.deepStrictEqual(d.hosts, []);
    assert.deepStrictEqual(d.llm, {});
    assert.deepStrictEqual(d.pins, []);
    assert.strictEqual(d.webhookAlertDone, true);
    assert.strictEqual(d.companionTransportEnabled, false);
    // internal-only fields are present (managed by other endpoints, not /api/config)
    assert.ok('agentNotes' in d && 'sessionTags' in d);
  });

  it('CLONES mutable defaults — a consumer mutating a derived value never corrupts the registry (WARDEN-889)', () => {
    // load() shallow-spreads DEFAULTS into the live cfg, so without cloning a
    // shared mutable default (e.g. llm / hosts) would BE the registry's default
    // object — and applyLlmPut's in-place mutation during a PUT would corrupt
    // it, so a later deriveDefaults() (resetConfig) would return the mutated
    // value instead of the pristine default. Pin that deriveDefaults hands out
    // fresh copies every call: mutating one derivation must not affect the next.
    const a = deriveDefaults();
    a.llm.model = 'mutated';
    a.hosts.push('sneaky-host');
    a.watchPatterns.push({ id: 'x' });
    const b = deriveDefaults();
    assert.deepStrictEqual(b.llm, {}, 'llm default not corrupted by a prior mutation');
    assert.deepStrictEqual(b.hosts, [], 'hosts default not corrupted');
    assert.deepStrictEqual(b.watchPatterns, [], 'watchPatterns default not corrupted');
    // Identity: two derivations are distinct objects (not the shared registry ref).
    assert.notStrictEqual(b.llm, a.llm, 'each derivation gets its own llm object');
    assert.notStrictEqual(b.hosts, a.hosts, 'each derivation gets its own hosts array');
  });
});

describe('buildGetResponse — GET derived from the registry', () => {
  it('emits secret fields as {key}Set/{key}Tail only — never the cleartext key', () => {
    const cfg = {
      telemetryAuthToken: 'tok-ABCD', webhookSecret: 'sec-WXYZ',
      llm: { authToken: 'sk-EFGH' },
    };
    const out = buildGetResponse(cfg, { companionEnvOverridden: false });
    assert.strictEqual(out.telemetryAuthTokenSet, true);
    assert.strictEqual(out.telemetryAuthTokenTail, 'ABCD');
    assert.ok(!('telemetryAuthToken' in out), 'no cleartext telemetryAuthToken');
    assert.strictEqual(out.webhookSecretSet, true);
    assert.strictEqual(out.webhookSecretTail, 'WXYZ');
    assert.ok(!('webhookSecret' in out), 'no cleartext webhookSecret');
    assert.strictEqual(out.llm.authTokenSet, true);
    assert.strictEqual(out.llm.authTokenTail, 'EFGH');
    assert.ok(!('authToken' in out.llm), 'no cleartext llm.authToken');
  });

  it('emits the derived companionTransportOverridden from the boot ctx (not cfg)', () => {
    const cfg = { companionTransportEnabled: true };
    assert.strictEqual(
      buildGetResponse(cfg, { companionEnvOverridden: true }).companionTransportOverridden,
      true,
      'mirrors the boot env snapshot',
    );
    assert.strictEqual(
      buildGetResponse(cfg, { companionEnvOverridden: false }).companionTransportOverridden,
      false,
    );
  });

  it('applies the non-uniform GET resolution rules', () => {
    // !== false → true; === true strict; ?? '' ; typeof-number-or-null.
    const out = buildGetResponse(
      { webhookAlertAttention: undefined, webhookEnabled: 1, telemetryEndpoint: undefined, llm: {} },
      { companionEnvOverridden: false },
    );
    assert.strictEqual(out.webhookAlertAttention, true, 'undefined → true via !== false');
    assert.strictEqual(out.webhookEnabled, false, 'non-true → false via === true');
    assert.strictEqual(out.telemetryEndpoint, '', 'undefined → "" via ?? ""');
    assert.strictEqual(out.llm.maxTokens, null, 'non-number → null');
  });

  it('emits a boolean (never undefined) for the derived field even with no ctx', () => {
    // Hardened resolver: a no-ctx call must still emit a real boolean so the GET
    // shape can't lose the key to JSON's undefined-omission.
    assert.strictEqual(buildGetResponse({}).companionTransportOverridden, false);
    assert.strictEqual(buildGetResponse({}, { companionEnvOverridden: true }).companionTransportOverridden, true);
  });
});

describe('validateRegistry — fail loud on a malformed descriptor (no silent no-op)', () => {
  // The refactor's whole point is that the GET/PUT/DEFAULTS lists CANNOT drift.
  // A typo'd type/resolve or a duplicate order would silently re-create that
  // drift; validateRegistry turns those into a startup error. (Importing the
  // module already proves the shipping registry passes — this block pins the
  // rejection of each malformed shape.)
  const ok = (extra) => ({ key: 'x', default: false, exposure: 'public', type: 'boolean', resolve: 'identity', order: 1, ...extra });

  it('accepts the shipping registry (it is well-formed)', () => {
    assert.doesNotThrow(() => validateRegistry(CONFIG_FIELDS));
  });

  it('rejects an unknown type (would silently no-op the PUT guard)', () => {
    assert.throws(() => validateRegistry([ok({ type: 'secert' })]), /unknown type 'secert'/);
  });

  it('rejects an unknown resolve (would silently coerce wrong on GET)', () => {
    assert.throws(() => validateRegistry([ok({ resolve: 'neqfalse' })]), /unknown resolve 'neqfalse'/);
  });

  it('rejects a GET-visible field missing a numeric order', () => {
    const { order: _drop, ...noOrder } = ok({});
    assert.throws(() => validateRegistry([noOrder]), /missing numeric 'order'/);
  });

  it('rejects a duplicate GET order (would make the byte-pinned order ambiguous)', () => {
    const a = ok({ key: 'a', order: 5 });
    const b = ok({ key: 'b', order: 5 });
    assert.throws(() => validateRegistry([a, b]), /collides/);
  });

  it('rejects an unknown exposure', () => {
    assert.throws(() => validateRegistry([ok({ exposure: 'pubic' })]), /unknown exposure/);
  });
});

describe('applyConfigPut — PUT guards derived from the registry', () => {
  it('clamps connectTimeout into [1,60] (WARDEN-747)', () => {
    const cfg = { connectTimeout: 10 };
    applyConfigPut(cfg, { connectTimeout: 999 });
    assert.strictEqual(cfg.connectTimeout, 60);
    applyConfigPut(cfg, { connectTimeout: 0 });
    assert.strictEqual(cfg.connectTimeout, 1);
    applyConfigPut(cfg, { connectTimeout: 30 });
    assert.strictEqual(cfg.connectTimeout, 30);
  });

  it('preserves the tokenBudget null-asymmetry + Math.max(1) floor', () => {
    const cfg = { tokenBudgetThresholdTokens: 100, tokenBudgetWindowHours: 5, tokenBudgetPerSessionThresholdTokens: 50 };
    // threshold + per-session accept null (clear); windowHours does NOT.
    applyConfigPut(cfg, { tokenBudgetThresholdTokens: null, tokenBudgetWindowHours: null, tokenBudgetPerSessionThresholdTokens: null });
    assert.strictEqual(cfg.tokenBudgetThresholdTokens, null, 'threshold cleared');
    assert.strictEqual(cfg.tokenBudgetWindowHours, 5, 'windowHours null IGNORED (asymmetry)');
    assert.strictEqual(cfg.tokenBudgetPerSessionThresholdTokens, null, 'per-session cleared');
    // floor at 1
    applyConfigPut(cfg, { tokenBudgetThresholdTokens: 0, tokenBudgetWindowHours: -3, tokenBudgetPerSessionThresholdTokens: 0.5 });
    assert.strictEqual(cfg.tokenBudgetThresholdTokens, 1);
    assert.strictEqual(cfg.tokenBudgetWindowHours, 1);
    assert.strictEqual(cfg.tokenBudgetPerSessionThresholdTokens, 1, '0.5 floored to 1');
  });

  it('runs both cross-field invariants after the per-field loop', () => {
    // health warning <= critical
    const cfg = { healthWarningThresholdMin: 5, healthCriticalThresholdMin: 30, telemetryBaseEnabled: true, telemetryExtendedEnabled: true };
    applyConfigPut(cfg, { healthWarningThresholdMin: 60, healthCriticalThresholdMin: 30 });
    assert.strictEqual(cfg.healthWarningThresholdMin, 30, 'inverted pair clamped');
    // telemetry extended-requires-base (revoking base latches extended)
    applyConfigPut(cfg, { telemetryBaseEnabled: false });
    assert.strictEqual(cfg.telemetryExtendedEnabled, false, 'extended latched off when base revoked');
  });

  it('no-clobbers secrets (empty/omitted preserves the stored value)', () => {
    const cfg = { telemetryAuthToken: 'keep', webhookSecret: 'keep', llm: { authToken: 'keep' } };
    applyConfigPut(cfg, { telemetryAuthToken: '', webhookSecret: '' });
    assert.strictEqual(cfg.telemetryAuthToken, 'keep');
    assert.strictEqual(cfg.webhookSecret, 'keep');
    applyConfigPut(cfg, { llm: { authToken: '' } });
    assert.strictEqual(cfg.llm.authToken, 'keep');
    // a non-empty value overwrites
    applyConfigPut(cfg, { telemetryAuthToken: 'new' });
    assert.strictEqual(cfg.telemetryAuthToken, 'new');
  });

  it('ignores unknown fields and rejects malformed values (PATCH semantics)', () => {
    const cfg = { notifyErrors: true, tmuxSession: 'agent', observerConfirmMode: 'always' };
    applyConfigPut(cfg, { bogusField: 123, notifyErrors: 'yes', tmuxSession: 42, observerConfirmMode: 'bogus' });
    assert.strictEqual(cfg.notifyErrors, true, 'non-boolean rejected');
    assert.strictEqual(cfg.tmuxSession, 'agent', 'non-string rejected');
    assert.strictEqual(cfg.observerConfirmMode, 'always', 'non-oneOf rejected');
    assert.ok(!('bogusField' in cfg), 'unknown field not stored');
  });
});

describe('resetConfig — restore every backend preference to its default (WARDEN-889)', () => {
  // A seeded non-default backend state across every exposure class: public
  // (webhookUrl/enabled, observer knobs, thresholds, tokens), secret (the three
  // write-only auth tokens a GET masks), and the nested llm object. internal
  // fields (pins/agentNotes/sessionTags) are user DATA, not settings, so they
  // are seeded too and asserted to SURVIVE the reset.
  function seeded() {
    return {
      hosts: ['prod-box', 'staging'],
      tmuxSession: 'watcher',
      connectTimeout: 60,
      pollIntervalMs: 99,
      observerConfirmMode: 'auto-safe',
      observerAutoStart: true,
      observerSessionTimeout: 180,
      llm: { model: 'glm-5.2', baseUrl: 'https://x.example', maxTokens: 9000, authToken: 'sk-secret' },
      healthWarningThresholdMin: 25,
      healthCriticalThresholdMin: 200,
      tokenBudgetEnabled: true,
      tokenBudgetThresholdTokens: 500,
      tokenBudgetWindowHours: 7,
      tokenBudgetPerSessionThresholdTokens: 250,
      companionTransportEnabled: true,
      confirmDestructiveActions: false,
      notifyChatOps: false,
      notifyErrors: false,
      notifySuccess: false,
      notifyObserver: false,
      showHostTags: false,
      showTypeBadges: false,
      showStatusIndicators: false,
      showProjectBadges: true,
      hideOfflineHosts: true,
      telemetryBaseEnabled: true,
      telemetryExtendedEnabled: true,
      telemetryEndpoint: 'https://receiver.example/ingest',
      telemetryAuthToken: 'tok-ABCD',
      webhookUrl: 'https://hooks.example/notify',
      webhookEnabled: true,
      webhookSecret: 'sec-WXYZ',
      webhookAlertAttention: false,
      webhookAlertBudget: false,
      webhookAlertDone: false,
      watchPatterns: [{ id: 'p1', name: 'X', expression: 'x', mode: 'string', enabled: true }],
      // USER DATA — must survive a backend-config reset (not a setting).
      pins: ['chat-1', 'chat-2'],
      agentNotes: { agentA: 'note' },
      sessionTags: { sess1: ['tag'] },
    };
  }

  it('restores every public + secret field to deriveDefaults()', () => {
    const cfg = seeded();
    resetConfig(cfg);
    const defaults = deriveDefaults();
    for (const f of CONFIG_FIELDS) {
      if (f.exposure !== 'public' && f.exposure !== 'secret') continue;
      assert.deepStrictEqual(cfg[f.key], defaults[f.key],
        `field '${f.key}' reset to its default`);
    }
  });

  it('clears the write-only secrets a GET masks (the tokens a user cannot otherwise clear)', () => {
    // This is the load-bearing reason resetConfig bypasses applyConfigPut: the
    // secret no-clobber that protects an untouched password field on a normal
    // Save would refuse to blank these. A reset MUST clear them.
    const cfg = seeded();
    resetConfig(cfg);
    assert.strictEqual(cfg.webhookSecret, '', 'webhookSecret cleared');
    assert.strictEqual(cfg.telemetryAuthToken, '', 'telemetryAuthToken cleared');
    assert.deepStrictEqual(cfg.llm, {}, 'llm (incl. authToken) cleared to {}');
  });

  it('clears a configured webhook + endpoint back to unconfigured (sends nothing)', () => {
    const cfg = seeded();
    resetConfig(cfg);
    assert.strictEqual(cfg.webhookUrl, '');
    assert.strictEqual(cfg.webhookEnabled, false);
    assert.strictEqual(cfg.telemetryEndpoint, '');
    assert.strictEqual(cfg.telemetryBaseEnabled, false);
  });

  it('PRESERVES internal user data (pins / agentNotes / sessionTags)', () => {
    // internal fields are managed by their own endpoints, not /api/config — a
    // backend-config reset must not wipe a user's pinned chats, notes, or tags.
    const cfg = seeded();
    resetConfig(cfg);
    assert.deepStrictEqual(cfg.pins, ['chat-1', 'chat-2'], 'pins preserved');
    assert.deepStrictEqual(cfg.agentNotes, { agentA: 'note' }, 'agentNotes preserved');
    assert.deepStrictEqual(cfg.sessionTags, { sess1: ['tag'] }, 'sessionTags preserved');
  });

  it('leaves the restored state well-formed (crossField invariants hold)', () => {
    // The restored defaults run through crossField, exactly as a PUT would, so
    // the persisted pair stays well-ordered and telemetry extended cannot be on
    // without base. (Defaults are well-formed by construction; these assert the
    // reset output satisfies the same invariants a PUT leaves behind.)
    const cfg = seeded();
    resetConfig(cfg);
    assert.ok(cfg.healthWarningThresholdMin <= cfg.healthCriticalThresholdMin,
      'health warning <= critical after reset');
    assert.ok(!(cfg.telemetryExtendedEnabled && !cfg.telemetryBaseEnabled),
      'telemetry extended-requires-base holds after reset');
  });

  it('mutates the cfg object in place and returns it', () => {
    // The server holds a single cfg reference; reset must mutate THAT object
    // (not return a fresh one) so every consumer sees the restored defaults.
    const cfg = seeded();
    const ret = resetConfig(cfg);
    assert.strictEqual(ret, cfg, 'returns the same cfg object');
    assert.strictEqual(cfg.webhookUrl, '', 'cfg mutated in place');
  });
});

describe('afterSave — the four post-save side-effects (Correction 2)', () => {
  // The structural pin: a registry refactor that drops afterSave silently breaks
  // telemetry/companion/budget/attention. This asserts the pipeline invokes every
  // injected dep — the HTTP test observes only the two most observable ones
  // (process.send + companion env) end-to-end.
  it('invokes all four deps in order with the right arguments', () => {
    const calls = [];
    const cfg = { companionTransportEnabled: true, telemetryBaseEnabled: true };
    afterSave(cfg, {
      forwardTelemetryConfig: (c) => calls.push(['forwardTelemetryConfig', c === cfg]),
      applyCompanionToggle: (enabled, opts) => calls.push(['applyCompanionToggle', enabled, opts]),
      restartBudgetPoll: () => calls.push(['restartBudgetPoll']),
      restartAttentionPoll: () => calls.push(['restartAttentionPoll']),
      companionOverridden: false,
    });
    assert.deepStrictEqual(
      calls.map((c) => c[0]),
      ['forwardTelemetryConfig', 'applyCompanionToggle', 'restartBudgetPoll', 'restartAttentionPoll'],
      'all four side-effects fire in the declared order',
    );
    // forwardTelemetryConfig received the live cfg (it reads clamped values off it)
    assert.strictEqual(calls[0][1], true, 'forwardTelemetryConfig received cfg');
    // applyCompanionToggle received the toggle + the boot override flag
    assert.strictEqual(calls[1][1], true, 'applyCompanionToggle received companionTransportEnabled');
    assert.deepStrictEqual(calls[1][2], { override: false }, 'applyCompanionToggle received the override flag');
  });

  it('passes the operator-override flag through to applyCompanionToggle', () => {
    let received;
    afterSave(
      { companionTransportEnabled: false },
      {
        forwardTelemetryConfig: () => {},
        applyCompanionToggle: (_e, opts) => { received = opts; },
        restartBudgetPoll: () => {},
        restartAttentionPoll: () => {},
        companionOverridden: true,
      },
    );
    assert.deepStrictEqual(received, { override: true }, 'override=true forwarded (toggle inert by design)');
  });
});
