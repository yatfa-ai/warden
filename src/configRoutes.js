import express from 'express';
import { buildGetResponse, applyConfigPut, afterSave, resetConfig } from './config-schema.js';
import * as notify from './notify.js';
import { probeReceiverCapabilities } from './telemetry-capabilities.js';

// Settings HTTP routes (/api/config GET/PUT, /api/config/reset, /api/webhook-test,
// /api/telemetry-test), extracted verbatim from server.js. Injected: the live
// `cfg` object (mutated in place), `save`, the boot-time `companionEnvOverridden`
// flag, and `afterSaveDeps` — the one afterSave dependency object (companionOverridden,
// forwardTelemetryConfig, applyCompanionToggle, applyCompanionExclusions,
// restartBudgetPoll) shared by the PUT and reset handlers.
export function createConfigRouter({ cfg, save, companionEnvOverridden, afterSaveDeps }) {
  const router = express.Router();

  // GET /api/config — return the safe-subset response, derived from the single
  // CONFIG_FIELDS registry (WARDEN-773). buildGetResponse iterates the registry:
  // public fields emit by their resolve rule, secret fields auto-emit {key}Set +
  // {key}Tail only (cleartext never on the wire), and the derived
  // companionTransportOverridden emits from the boot env snapshot. The key order
  // is byte-pinned to the pre-refactor response (server-config-registry.test.js).
  router.get('/api/config', (_req, res) => res.json(
    buildGetResponse(cfg, { companionEnvOverridden }),
  ));

  // PUT /api/config — update configuration and persist. Derived from the single
  // CONFIG_FIELDS registry (WARDEN-773): applyConfigPut iterates the registry's
  // per-field guards (type checks, the [1,60] connectTimeout clamp, oneOf, the
  // tokenBudget null-asymmetry + Math.max(1) floor, sanitizeWatchPatterns, secret
  // no-clobber, and the nested llm sub-fields), then runs the two cross-field
  // invariants (health warning<=critical ordering + telemetry extended-requires-
  // base). The four post-save side-effects run through afterSave (Correction 2):
  // the IPC telemetry forward incl. cleartext authToken (WARDEN-524/569), the live
  // companion toggle (WARDEN-439), and the budget poll restart (WARDEN-415) —
  // declared as a pipeline so a refactor can't silently drop them the way the
  // source proposal's hooks would have.
  router.put('/api/config', async (req, res) => {
    // WARDEN-1331 — applyConfigPut now reports WHICH present-but-invalid values it
    // refused, so the route stops answering a bare { ok: true } to a rejected
    // write (the silent-ok is the amplifier that let the out-of-range-persist
    // defect class hide through five one-field repairs). The response stays
    // ADDITIVE: ok is still true whenever the request was processed (good fields
    // in a mixed body still save), and `refused` is {} on the normal path — only
    // the renderer's save flow reads it, to warn instead of silently dropping.
    const { refused } = applyConfigPut(cfg, req.body);
    await save(cfg); // persist to ~/.yatfa-warden/config.json (atomic, async — WARDEN-831)
    afterSave(cfg, afterSaveDeps);
    res.json({ ok: true, refused });
  });

  // POST /api/config/reset — restore EVERY backend preference to its default
  // (WARDEN-889). Until this endpoint the danger zone's only reset action touched
  // CLIENT-side UI prefs; the consequential backend settings (webhook / telemetry /
  // observer / hosts / thresholds / …) had no reset path, so reverting an
  // experiment or rotating a compromised setup meant hand-editing config.json —
  // and the write-only secrets (webhook / telemetry / observer auth tokens, which
  // a GET masks and a user cannot even see) could not be cleared via the UI at all.
  //
  // resetConfig overwrites every public + secret field with deriveDefaults(),
  // bypassing applyConfigPut's per-field guards on purpose: the secret no-clobber
  // that protects an untouched password field on a normal Save would otherwise
  // REFUSE to blank those tokens — clearing them is the whole point. internal
  // fields (pins / agentNotes / sessionTags — user data, not settings) and derived
  // fields (boot-computed) are left untouched. crossField then runs so the
  // restored state is well-formed exactly as a PUT would leave it.
  //
  // The persist + live-apply path is IDENTICAL to PUT's: save round-trips through
  // config.json (survives a restart) and afterSave re-forwards the telemetry
  // config to main, re-applies the companion toggle, and restarts the budget
  // poll — so the reset takes effect live on the next tick, not on restart. This is an INSTANT action (not a draft-then-Save); the UI labels it
  // so. No request body is consulted.
  router.post('/api/config/reset', async (_req, res) => {
    resetConfig(cfg);
    // save is async + atomic (temp + fsync + rename, WARDEN-831) — AWAIT it so the
    // reset's blanked secrets actually land on disk before we respond, mirroring the
    // PUT handler. Responding first would race the rename and leave the old (secret-
    // bearing) config.json observable.
    await save(cfg); // persist the restored defaults to ~/.yatfa-warden/config.json
    afterSave(cfg, afterSaveDeps);
    res.json({ ok: true });
  });

  // POST /api/webhook-test — send a test alert so the user can verify their
  // ntfy/Discord/Slack/Telegram topic end-to-end from Settings (WARDEN-555). This
  // is an EXPLICIT human action. The draft { webhookUrl, webhookSecret? } comes
  // from the BODY (not persisted config) so a user fixing a typo in their URL can
  // verify the NEW destination before committing it via Save — parity with
  // /api/telemetry-test right below. Any field not supplied in the body falls back
  // to the persisted cfg (write-only-secret parity: a draft secret is sent only
  // when the human typed a new one; an untouched field reuses the saved secret).
  //
  // The off-by-default invariant ("enabled off → zero outbound requests") still
  // holds for every AUTOMATIC dispatch path — the budget/attention/finished hooks
  // all dispatch via persisted cfg directly and are untouched here. This route is
  // the ONE sanctioned explicit-send path that bypasses the enable gate: the
  // button itself is the human's opt-in to send, exactly like /api/telemetry-test
  // (which has no enable gate at all), so the merged testCfg forces webhookEnabled:
  // true and only no-ops when the resolved URL (draft or persisted) is empty.
  // Returns the transport result so the UI can report sent/failed/no-config.
  router.post('/api/webhook-test', async (req, res) => {
    try {
      // Merge the draft over persisted cfg. A non-empty draft URL/secret overrides;
      // an absent or empty field falls back to the persisted value (no-clobber).
      const testCfg = {
        ...cfg,
        webhookEnabled: true,
        ...(typeof req.body?.webhookUrl === 'string' && req.body.webhookUrl.trim()
          ? { webhookUrl: req.body.webhookUrl.trim() }
          : {}),
        ...(typeof req.body?.webhookSecret === 'string' && req.body.webhookSecret
          ? { webhookSecret: req.body.webhookSecret }
          : {}),
      };
      const result = await notify.dispatchWebhook({
        event: 'test',
        severity: 'info',
        agent: 'Warden',
        reason: 'Test alert from Warden — your webhook is configured correctly.',
        cfg: testCfg,
        now: Date.now(),
      });
      res.json(result);
    } catch (e) {
      // dispatchWebhook never throws (best-effort), but guard anyway so a surprise
      // never 500s the Settings page.
      res.status(500).json({ error: e.message });
    }
  });

  // POST /api/telemetry-test — probe a configured telemetry receiver so the user
  // can confirm it is reachable + schema-matched + authed BEFORE relying on it
  // (WARDEN-595). The renderer cannot fetch the receiver directly: the telemetry
  // transport runs in the Node main process (no CORS), but the probe button lives
  // in the renderer, and a cross-origin renderer fetch would be CORS-blocked (the
  // receiver sends no CORS headers). So — exactly like /api/webhook-test above —
  // the renderer POSTs { endpoint, token? } and THIS backend does the outbound
  // GET /capabilities in Node (no CORS), returning a structured verdict the UI
  // renders (connected / schema-drift / auth-required / no-receiver).
  //
  // The endpoint comes from the BODY (not persisted config) so the user can test a
  // typo'd URL before saving — an improvement over /api/webhook-test. The optional
  // token likewise comes from the body when the user typed a new one; when it is
  // absent, the route falls back to the persisted cfg.telemetryAuthToken so a
  // previously-saved token is used for the probe without the user retyping it (the
  // token is write-only on GET /api/config, so the renderer never holds its
  // cleartext). The verdict is NEVER persisted: a cached "connected" would go stale
  // (receiver down, token rotated) and become a false trust signal, so it stays a
  // live, on-demand probe. Only the configured origin is ever contacted — no
  // third-party SaaS, no hardcoded host.
  router.post('/api/telemetry-test', async (req, res) => {
    try {
      const endpoint = typeof req.body?.endpoint === 'string' ? req.body.endpoint.trim() : '';
      if (!endpoint) {
        return res.status(400).json({ error: 'endpoint is required' });
      }
      // A draft token from the body takes precedence; otherwise probeReceiverCapabilities
      // falls back to the persisted cfg.telemetryAuthToken so a saved secret works
      // without retyping (the token is write-only on GET /api/config).
      const verdict = await probeReceiverCapabilities({
        endpoint,
        token: typeof req.body?.token === 'string' ? req.body.token : '',
        fallbackToken: typeof cfg.telemetryAuthToken === 'string' ? cfg.telemetryAuthToken : '',
        fetchImpl: fetch,
      });
      return res.json(verdict);
    } catch (e) {
      // The probe itself never throws (errors map to verdicts), but guard anyway so
      // a surprise never 500s the Settings page.
      res.status(500).json({ error: e.message });
    }
  });

  return router;
}
