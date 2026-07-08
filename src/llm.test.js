import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// llm.js resolves credentials/model from process.env + config files under
// os.homedir() AT MODULE-LOAD time (TOKEN, BASE) — captured in closures — while
// resolveModel() re-reads process.env on every call. To test both branches
// deterministically we re-evaluate the module source through a *unique* data:
// URL (so the ES module cache is bypassed and module-level code re-runs) with a
// controlled HOME + env. This isolates us from the host's real
// ~/.claude/settings.json and ~/.yatfa-warden/config.json.

const LLMSRC = fs.readFileSync(new URL('./llm.js', import.meta.url), 'utf8');

const ENV_KEYS = [
  'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL',
  'WARDEN_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_MODEL',
  'HOME', 'USERPROFILE',
];

let loadCounter = 0;

// Re-evaluate llm.js fresh. `env` is active during module-level eval (so it
// drives TOKEN/BASE). `homeDir` redirects os.homedir() so config files are read
// from a controlled location. All controlled env keys are restored afterwards.
async function loadFresh({ env = {}, homeDir } = {}) {
  const saved = {};
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  if (homeDir) process.env.HOME = homeDir;
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  try {
    // A unique leading comment => a unique data: URL => the loader cannot reuse
    // a cached module instance => module-level code (TOKEN/BASE/config reads)
    // re-runs against the env we just set.
    const unique = `/* load-${loadCounter++} */\n${LLMSRC}`;
    const dataUrl = 'data:text/javascript;base64,' + Buffer.from(unique, 'utf8').toString('base64');
    return await import(dataUrl);
  } finally {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

// An empty home directory with no config files — guarantees no credentials or
// model leak in from the host when we only want to exercise env resolution.
const EMPTY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-llm-empty-'));

// A home directory containing a ~/.yatfa-warden/config.json with the given object.
function makeHome(config) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-llm-cfg-'));
  fs.mkdirSync(path.join(dir, '.yatfa-warden'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.yatfa-warden', 'config.json'), JSON.stringify(config));
  return dir;
}

// Build a fetch mock that serves a fixed sequence of responses (one per call).
// Each response: { ok, status, json } -> JSON body, { ok, status, body } -> raw
// text, or { throw } -> throws to simulate a network failure.
function fetchSequence(responses) {
  let i = 0;
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, opts });
    const r = responses[Math.min(i, responses.length - 1)];
    i++;
    if (r.throw) throw r.throw;
    const text = r.body !== undefined ? r.body : JSON.stringify(r.json ?? { ok: true });
    return { ok: r.ok, status: r.status, text: async () => text };
  };
  fn.calls = calls;
  fn.count = () => i;
  return fn;
}

describe('resolveModel', () => {
  const MODEL_KEYS = ['WARDEN_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_MODEL'];
  let saved;
  beforeEach(() => {
    saved = {};
    for (const k of MODEL_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  });
  afterEach(() => {
    for (const k of MODEL_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  describe('context-tag stripping', () => {
    it('strips a trailing [1m] context tag (glm-5.2[1m] -> glm-5.2)', async () => {
      const m = await loadFresh({ homeDir: EMPTY_HOME });
      process.env.WARDEN_MODEL = 'glm-5.2[1m]';
      assert.strictEqual(m.resolveModel(), 'glm-5.2');
    });

    it('strips arbitrary trailing tag content ([2m], [long-context])', async () => {
      const m = await loadFresh({ homeDir: EMPTY_HOME });
      process.env.WARDEN_MODEL = 'model-x[2m]';
      assert.strictEqual(m.resolveModel(), 'model-x');
      process.env.WARDEN_MODEL = 'gpt-4o[long-context]';
      assert.strictEqual(m.resolveModel(), 'gpt-4o');
    });

    it('does not strip a tag that is not at the end', async () => {
      const m = await loadFresh({ homeDir: EMPTY_HOME });
      process.env.WARDEN_MODEL = 'foo[1m]-bar';
      assert.strictEqual(m.resolveModel(), 'foo[1m]-bar');
    });

    it('falls back to default when stripping leaves an empty string', async () => {
      const m = await loadFresh({ homeDir: EMPTY_HOME });
      process.env.WARDEN_MODEL = '[1m]'; // whole value is the tag
      assert.strictEqual(m.resolveModel(), 'glm-5.2');
    });
  });

  describe('model id formats (no tag)', () => {
    it('passes a plain model id through unchanged', async () => {
      const m = await loadFresh({ homeDir: EMPTY_HOME });
      process.env.WARDEN_MODEL = 'claude-sonnet-4';
      assert.strictEqual(m.resolveModel(), 'claude-sonnet-4');
    });

    it('preserves dots and version segments', async () => {
      const m = await loadFresh({ homeDir: EMPTY_HOME });
      process.env.WARDEN_MODEL = 'a.b.c-1';
      assert.strictEqual(m.resolveModel(), 'a.b.c-1');
    });

    it('strips a trailing tag from a dotted/segmented id', async () => {
      const m = await loadFresh({ homeDir: EMPTY_HOME });
      process.env.WARDEN_MODEL = 'a.b.c[1m]';
      assert.strictEqual(m.resolveModel(), 'a.b.c');
    });
  });

  describe('default / fallback', () => {
    it('returns glm-5.2 when nothing is configured', async () => {
      const m = await loadFresh({ homeDir: EMPTY_HOME });
      assert.strictEqual(m.resolveModel(), 'glm-5.2');
    });
  });

  describe('precedence', () => {
    it('WARDEN_MODEL beats ANTHROPIC_DEFAULT_SONNET_MODEL and ANTHROPIC_MODEL', async () => {
      const m = await loadFresh({ homeDir: EMPTY_HOME });
      process.env.WARDEN_MODEL = 'warden-picks[1m]';
      process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = 'sonnet-picks';
      process.env.ANTHROPIC_MODEL = 'anthropic-picks';
      assert.strictEqual(m.resolveModel(), 'warden-picks');
    });

    it('ANTHROPIC_DEFAULT_SONNET_MODEL beats ANTHROPIC_MODEL', async () => {
      const m = await loadFresh({ homeDir: EMPTY_HOME });
      process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = 'sonnet-picks';
      process.env.ANTHROPIC_MODEL = 'anthropic-picks';
      assert.strictEqual(m.resolveModel(), 'sonnet-picks');
    });

    it('ANTHROPIC_MODEL is used when nothing higher is set', async () => {
      const m = await loadFresh({ homeDir: EMPTY_HOME });
      process.env.ANTHROPIC_MODEL = 'anthropic-picks[1m]';
      assert.strictEqual(m.resolveModel(), 'anthropic-picks');
    });
  });

  describe('config file resolution', () => {
    it('reads llm.model from ~/.yatfa-warden/config.json and strips its tag', async () => {
      const home = makeHome({ llm: { model: 'glm-5.2[1m]' } });
      const m = await loadFresh({ homeDir: home });
      assert.strictEqual(m.resolveModel(), 'glm-5.2');
    });

    it('WARDEN_MODEL env overrides the config-file model', async () => {
      const home = makeHome({ llm: { model: 'cfg-model' } });
      const m = await loadFresh({ homeDir: home });
      process.env.WARDEN_MODEL = 'env-model[1m]';
      assert.strictEqual(m.resolveModel(), 'env-model');
    });
  });
});

describe('hasCredentials', () => {
  it('returns false with no credentials anywhere', async () => {
    const m = await loadFresh({ homeDir: EMPTY_HOME });
    assert.strictEqual(m.hasCredentials(), false);
  });

  it('returns false for an empty-string token', async () => {
    const m = await loadFresh({ homeDir: EMPTY_HOME, env: { ANTHROPIC_AUTH_TOKEN: '' } });
    assert.strictEqual(m.hasCredentials(), false);
  });

  it('returns true when ANTHROPIC_AUTH_TOKEN is set', async () => {
    const m = await loadFresh({ homeDir: EMPTY_HOME, env: { ANTHROPIC_AUTH_TOKEN: 'sk-token' } });
    assert.strictEqual(m.hasCredentials(), true);
  });

  it('returns true when only ANTHROPIC_API_KEY is set', async () => {
    const m = await loadFresh({ homeDir: EMPTY_HOME, env: { ANTHROPIC_API_KEY: 'sk-key' } });
    assert.strictEqual(m.hasCredentials(), true);
  });

  it('returns true when credentials come from the config file (llm.authToken)', async () => {
    const home = makeHome({ llm: { authToken: 'cfg-token' } });
    const m = await loadFresh({ homeDir: home });
    assert.strictEqual(m.hasCredentials(), true);
  });

  it('returns true when credentials come from the config file (llm.token)', async () => {
    const home = makeHome({ llm: { token: 'cfg-token' } });
    const m = await loadFresh({ homeDir: home });
    assert.strictEqual(m.hasCredentials(), true);
  });

  it('returns false when config file has no token under llm', async () => {
    const home = makeHome({ hosts: [], tmuxSession: 'agent' });
    const m = await loadFresh({ homeDir: home });
    assert.strictEqual(m.hasCredentials(), false);
  });
});

describe('complete', () => {
  let origFetch, origST;
  beforeEach(() => {
    origFetch = globalThis.fetch;
    origST = globalThis.setTimeout;
    // Make retry backoff sleeps fire instantly so retry/exhaustion tests are fast.
    globalThis.setTimeout = (fn) => { Promise.resolve().then(fn); return 0; };
  });
  afterEach(() => {
    globalThis.fetch = origFetch;
    globalThis.setTimeout = origST;
  });

  it('throws when no credentials are configured', async () => {
    const m = await loadFresh({ homeDir: EMPTY_HOME });
    await assert.rejects(
      () => m.complete({ messages: [{ role: 'user', content: 'hi' }] }),
      /no LLM credentials/,
    );
  });

  describe('successful request', () => {
    it('returns parsed JSON and calls fetch exactly once', async () => {
      const m = await loadFresh({ homeDir: EMPTY_HOME, env: { ANTHROPIC_AUTH_TOKEN: 'tok' } });
      const f = fetchSequence([{ ok: true, status: 200, json: { id: 'msg_1', content: [] } }]);
      globalThis.fetch = f;
      const out = await m.complete({ messages: [] });
      assert.strictEqual(out.id, 'msg_1');
      assert.strictEqual(f.count(), 1);
    });

    it('POSTs to {BASE}/v1/messages with the default base URL', async () => {
      const m = await loadFresh({ homeDir: EMPTY_HOME, env: { ANTHROPIC_AUTH_TOKEN: 'tok' } });
      const f = fetchSequence([{ ok: true, status: 200, json: { ok: true } }]);
      globalThis.fetch = f;
      await m.complete({ messages: [] });
      assert.strictEqual(f.calls[0].url, 'https://api.anthropic.com/v1/messages');
      assert.strictEqual(f.calls[0].opts.method, 'POST');
    });

    it('strips a trailing slash from a custom ANTHROPIC_BASE_URL', async () => {
      const m = await loadFresh({
        homeDir: EMPTY_HOME,
        env: { ANTHROPIC_AUTH_TOKEN: 'tok', ANTHROPIC_BASE_URL: 'https://gateway.example.com/' },
      });
      const f = fetchSequence([{ ok: true, status: 200, json: { ok: true } }]);
      globalThis.fetch = f;
      await m.complete({ messages: [] });
      assert.strictEqual(f.calls[0].url, 'https://gateway.example.com/v1/messages');
    });

    it('sends both Bearer authorization and x-api-key headers using the token', async () => {
      const m = await loadFresh({ homeDir: EMPTY_HOME, env: { ANTHROPIC_AUTH_TOKEN: 'tok-123' } });
      const f = fetchSequence([{ ok: true, status: 200, json: { ok: true } }]);
      globalThis.fetch = f;
      await m.complete({ messages: [] });
      assert.strictEqual(f.calls[0].opts.headers.authorization, 'Bearer tok-123');
      assert.strictEqual(f.calls[0].opts.headers['x-api-key'], 'tok-123');
      assert.strictEqual(f.calls[0].opts.headers['anthropic-version'], '2023-06-01');
    });

    it('prefers ANTHROPIC_AUTH_TOKEN over ANTHROPIC_API_KEY', async () => {
      const m = await loadFresh({
        homeDir: EMPTY_HOME,
        env: { ANTHROPIC_AUTH_TOKEN: 'auth-tok', ANTHROPIC_API_KEY: 'api-tok' },
      });
      const f = fetchSequence([{ ok: true, status: 200, json: { ok: true } }]);
      globalThis.fetch = f;
      await m.complete({ messages: [] });
      assert.strictEqual(f.calls[0].opts.headers.authorization, 'Bearer auth-tok');
    });
  });

  describe('request body', () => {
    it('includes resolved model (tag stripped), default max_tokens=2048, and messages', async () => {
      const m = await loadFresh({
        homeDir: EMPTY_HOME,
        env: { ANTHROPIC_AUTH_TOKEN: 'tok', WARDEN_MODEL: 'glm-5.2[1m]' },
      });
      const f = fetchSequence([{ ok: true, status: 200, json: { ok: true } }]);
      globalThis.fetch = f;
      await m.complete({ messages: [{ role: 'user', content: 'hi' }] });
      const body = JSON.parse(f.calls[0].opts.body);
      assert.strictEqual(body.model, 'glm-5.2');
      assert.strictEqual(body.max_tokens, 2048);
      assert.deepStrictEqual(body.messages, [{ role: 'user', content: 'hi' }]);
      assert.ok(!('system' in body), 'should not include system when not provided');
      assert.ok(!('tools' in body), 'should not include tools when not provided');
      assert.ok(!('tool_choice' in body), 'should not include tool_choice when no tools');
    });

    it('includes system and a custom max_tokens when provided', async () => {
      const m = await loadFresh({ homeDir: EMPTY_HOME, env: { ANTHROPIC_AUTH_TOKEN: 'tok' } });
      const f = fetchSequence([{ ok: true, status: 200, json: { ok: true } }]);
      globalThis.fetch = f;
      await m.complete({ system: 'be brief', max_tokens: 100, messages: [] });
      const body = JSON.parse(f.calls[0].opts.body);
      assert.strictEqual(body.system, 'be brief');
      assert.strictEqual(body.max_tokens, 100);
    });

    it('adds tools and tool_choice=auto when a non-empty tools array is given', async () => {
      const m = await loadFresh({ homeDir: EMPTY_HOME, env: { ANTHROPIC_AUTH_TOKEN: 'tok' } });
      const f = fetchSequence([{ ok: true, status: 200, json: { ok: true } }]);
      globalThis.fetch = f;
      const tools = [{ name: 'list_chats', description: 'd', input_schema: {} }];
      await m.complete({ messages: [], tools });
      const body = JSON.parse(f.calls[0].opts.body);
      assert.deepStrictEqual(body.tools, tools);
      assert.deepStrictEqual(body.tool_choice, { type: 'auto' });
    });

    it('omits tools and tool_choice for an empty tools array', async () => {
      const m = await loadFresh({ homeDir: EMPTY_HOME, env: { ANTHROPIC_AUTH_TOKEN: 'tok' } });
      const f = fetchSequence([{ ok: true, status: 200, json: { ok: true } }]);
      globalThis.fetch = f;
      await m.complete({ messages: [], tools: [] });
      const body = JSON.parse(f.calls[0].opts.body);
      assert.ok(!('tools' in body));
      assert.ok(!('tool_choice' in body));
    });
  });

  describe('retry on retryable status then success', () => {
    it('retries on 429 then succeeds', async () => {
      const m = await loadFresh({ homeDir: EMPTY_HOME, env: { ANTHROPIC_AUTH_TOKEN: 'tok' } });
      const f = fetchSequence([
        { ok: false, status: 429, body: 'rate limited' },
        { ok: true, status: 200, json: { id: 'after-retry' } },
      ]);
      globalThis.fetch = f;
      const out = await m.complete({ messages: [] });
      assert.strictEqual(out.id, 'after-retry');
      assert.strictEqual(f.count(), 2);
    });

    it('retries on 500 then succeeds', async () => {
      const m = await loadFresh({ homeDir: EMPTY_HOME, env: { ANTHROPIC_AUTH_TOKEN: 'tok' } });
      const f = fetchSequence([
        { ok: false, status: 500, body: 'server error' },
        { ok: true, status: 200, json: { ok: true } },
      ]);
      globalThis.fetch = f;
      await m.complete({ messages: [] });
      assert.strictEqual(f.count(), 2);
    });

    it('retries on 503 (any 5xx) then succeeds', async () => {
      const m = await loadFresh({ homeDir: EMPTY_HOME, env: { ANTHROPIC_AUTH_TOKEN: 'tok' } });
      const f = fetchSequence([
        { ok: false, status: 503, body: 'unavailable' },
        { ok: false, status: 599, body: 'still bad' },
        { ok: true, status: 200, json: { ok: true } },
      ]);
      globalThis.fetch = f;
      await m.complete({ messages: [] });
      assert.strictEqual(f.count(), 3);
    });

    it('retries on a network error (fetch throws) then succeeds', async () => {
      const m = await loadFresh({ homeDir: EMPTY_HOME, env: { ANTHROPIC_AUTH_TOKEN: 'tok' } });
      const f = fetchSequence([
        { throw: new Error('fetch failed: ECONNRESET') },
        { ok: true, status: 200, json: { id: 'recovered' } },
      ]);
      globalThis.fetch = f;
      const out = await m.complete({ messages: [] });
      assert.strictEqual(out.id, 'recovered');
      assert.strictEqual(f.count(), 2);
    });
  });

  describe('exhaustion after 3 attempts', () => {
    it('throws the last 429 error after 3 attempts', async () => {
      const m = await loadFresh({ homeDir: EMPTY_HOME, env: { ANTHROPIC_AUTH_TOKEN: 'tok' } });
      const f = fetchSequence([
        { ok: false, status: 429, body: 'rate limited' },
        { ok: false, status: 429, body: 'rate limited' },
        { ok: false, status: 429, body: 'rate limited' },
      ]);
      globalThis.fetch = f;
      await assert.rejects(() => m.complete({ messages: [] }), /LLM HTTP 429/);
      assert.strictEqual(f.count(), 3);
    });

    it('throws the last 5xx error after 3 attempts', async () => {
      const m = await loadFresh({ homeDir: EMPTY_HOME, env: { ANTHROPIC_AUTH_TOKEN: 'tok' } });
      const f = fetchSequence([
        { ok: false, status: 500, body: 'server error' },
        { ok: false, status: 500, body: 'server error' },
        { ok: false, status: 500, body: 'server error' },
      ]);
      globalThis.fetch = f;
      await assert.rejects(() => m.complete({ messages: [] }), /LLM HTTP 500/);
      assert.strictEqual(f.count(), 3);
    });

    it('throws the network error after 3 failed attempts', async () => {
      const m = await loadFresh({ homeDir: EMPTY_HOME, env: { ANTHROPIC_AUTH_TOKEN: 'tok' } });
      const f = fetchSequence([
        { throw: new Error('fetch failed: ETIMEDOUT') },
        { throw: new Error('fetch failed: ETIMEDOUT') },
        { throw: new Error('fetch failed: ETIMEDOUT') },
      ]);
      globalThis.fetch = f;
      await assert.rejects(() => m.complete({ messages: [] }), /ETIMEDOUT/);
      assert.strictEqual(f.count(), 3);
    });

    it('truncates the 429 error body to 200 chars in the message', async () => {
      const m = await loadFresh({ homeDir: EMPTY_HOME, env: { ANTHROPIC_AUTH_TOKEN: 'tok' } });
      const longBody = 'x'.repeat(600);
      const f = fetchSequence([
        { ok: false, status: 429, body: longBody },
        { ok: false, status: 429, body: longBody },
        { ok: false, status: 429, body: longBody },
      ]);
      globalThis.fetch = f;
      await assert.rejects(
        () => m.complete({ messages: [] }),
        (err) => {
          assert.ok(err.message.startsWith('LLM HTTP 429: '), 'message prefixes with status');
          // "LLM HTTP 429: " (14 chars) + body slice(0, 200)
          assert.ok(err.message.length <= 14 + 200, 'body is truncated to 200 chars');
          return true;
        },
      );
    });
  });

  describe('non-retryable client errors (4xx except 429)', () => {
    it('throws immediately on 400 without retrying', async () => {
      const m = await loadFresh({ homeDir: EMPTY_HOME, env: { ANTHROPIC_AUTH_TOKEN: 'tok' } });
      const f = fetchSequence([{ ok: false, status: 400, body: 'bad request' }]);
      globalThis.fetch = f;
      await assert.rejects(() => m.complete({ messages: [] }), /LLM HTTP 400/);
      assert.strictEqual(f.count(), 1);
    });

    it('throws immediately on 401 without retrying', async () => {
      const m = await loadFresh({ homeDir: EMPTY_HOME, env: { ANTHROPIC_AUTH_TOKEN: 'tok' } });
      const f = fetchSequence([{ ok: false, status: 401, body: 'unauthorized' }]);
      globalThis.fetch = f;
      await assert.rejects(() => m.complete({ messages: [] }), /LLM HTTP 401/);
      assert.strictEqual(f.count(), 1);
    });

    it('throws immediately on 404 without retrying', async () => {
      const m = await loadFresh({ homeDir: EMPTY_HOME, env: { ANTHROPIC_AUTH_TOKEN: 'tok' } });
      const f = fetchSequence([{ ok: false, status: 404, body: 'not found' }]);
      globalThis.fetch = f;
      await assert.rejects(() => m.complete({ messages: [] }), /LLM HTTP 404/);
      assert.strictEqual(f.count(), 1);
    });

    it('includes up to 300 chars of the body in the error message', async () => {
      const m = await loadFresh({ homeDir: EMPTY_HOME, env: { ANTHROPIC_AUTH_TOKEN: 'tok' } });
      const longBody = 'y'.repeat(600);
      const f = fetchSequence([{ ok: false, status: 422, body: longBody }]);
      globalThis.fetch = f;
      await assert.rejects(
        () => m.complete({ messages: [] }),
        (err) => {
          assert.ok(err.message.startsWith('LLM HTTP 422: '));
          assert.ok(err.message.length <= 'LLM HTTP 422: '.length + 300);
          return true;
        },
      );
    });
  });
});
