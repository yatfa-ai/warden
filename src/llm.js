// Minimal Anthropic-Messages-compatible client.
// Credentials/model resolution (so warden runs from ANY terminal, not just inside
// Claude Code): process env → ~/.yatfa-warden/config.json `llm` → ~/.claude/settings.json
// `env` (Claude Code's own GLM wiring) → defaults. The model id carries a `[1m]`
// context tag the raw API rejects, so it's stripped (glm-5.2[1m] -> glm-5.2).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
const wardenLlm = (readJson(path.join(os.homedir(), '.yatfa-warden', 'config.json')) || {}).llm || {};
const claudeEnv = ((readJson(path.join(os.homedir(), '.claude', 'settings.json')) || {}).env) || {};
const pick = (...vals) => vals.find((v) => v) || '';

const BASE = pick(process.env.ANTHROPIC_BASE_URL, wardenLlm.baseUrl, claudeEnv.ANTHROPIC_BASE_URL) || 'https://api.anthropic.com';
const TOKEN = pick(process.env.ANTHROPIC_AUTH_TOKEN, process.env.ANTHROPIC_API_KEY, wardenLlm.authToken, wardenLlm.token, claudeEnv.ANTHROPIC_AUTH_TOKEN, claudeEnv.ANTHROPIC_API_KEY);

export function resolveModel() {
  const m = pick(process.env.WARDEN_MODEL, wardenLlm.model, process.env.ANTHROPIC_DEFAULT_SONNET_MODEL, process.env.ANTHROPIC_MODEL, claudeEnv.ANTHROPIC_DEFAULT_SONNET_MODEL, claudeEnv.ANTHROPIC_MODEL, '');
  const stripped = m.replace(/\[[^\]]+\]$/, ''); // glm-5.2[1m] -> glm-5.2
  return stripped || 'glm-5.2';
}

export function hasCredentials() {
  return Boolean(TOKEN);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// complete({system, messages, tools, max_tokens}) -> raw Anthropic message JSON.
export async function complete({ system, messages, tools, max_tokens = 2048 }) {
  if (!TOKEN) {
    throw new Error('no LLM credentials: set ANTHROPIC_AUTH_TOKEN (or ANTHROPIC_API_KEY).');
  }
  const body = { model: resolveModel(), max_tokens, messages };
  if (system) body.system = system;
  if (tools && tools.length) {
    body.tools = tools;
    body.tool_choice = { type: 'auto' };
  }
  const url = `${BASE.replace(/\/$/, '')}/v1/messages`;
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'anthropic-version': '2023-06-01',
          authorization: `Bearer ${TOKEN}`,
          'x-api-key': TOKEN,
        },
        body: JSON.stringify(body),
      });
      const text = await res.text();
      if (res.ok) return JSON.parse(text);
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`LLM HTTP ${res.status}: ${text.slice(0, 200)}`);
        await sleep(1200 * (attempt + 1));
        continue;
      }
      throw new Error(`LLM HTTP ${res.status}: ${text.slice(0, 300)}`);
    } catch (e) {
      if (e.message && e.message.startsWith('LLM HTTP')) throw e;
      lastErr = e; // network blip — retry
      await sleep(1000 * (attempt + 1));
    }
  }
  throw lastErr || new Error('LLM request failed');
}
