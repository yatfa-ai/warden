import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * Tests for the read-only single-session transcript viewer (WARDEN-233).
 *
 * Same structure as session-search.test.js: ONE file-level before() that puts HOME
 * (and therefore config.js's module-level dir) in place before the FIRST import of
 * server.js freezes it.
 *
 *  1. Pure unit tests for the helpers the endpoint is built on:
 *       extractTranscriptMessage, buildTranscriptView,
 *       buildSessionReadScript, parseSessionReadOutput
 *     These cover the trickiest logic — the {role, text, ts} mapping + skip
 *     semantics, the message-cap tail window, and the REMOTE path's shell script
 *     + delimited-output parsing (the latter is tested without SSH by feeding
 *     parseSessionReadOutput the exact stdout the script emits).
 *
 *  2. HTTP integration tests against the REAL Express app from src/server.js. We
 *     seed a throwaway HOME whose ~/.claude/projects archive holds sessions, then
 *     GET /api/claude-session?id=…&host=… and assert on the wire response. cfg.hosts
 *     is empty so only the LOCAL host is read — no SSH, fully deterministic.
 *     Covers the success criteria:
 *       - opening a past session returns its full conversation as messages WITHOUT
 *         resuming (and crucially WITHOUT creating a catalog entry / spawning a
 *         process — asserted via the catalog file staying absent)
 *       - tool_result / summary / malformed lines are skipped
 *       - an unknown id → 404; an invalid id → 400
 *       - a huge session is bounded (truncated flag + message cap)
 */

// ---- helpers under test (assigned from the dynamic import in before()) ----
let extractTranscriptMessage;
let buildTranscriptView;
let buildSessionReadScript;
let parseSessionReadOutput;

let httpServer;
let baseUrl;
let originalHome;
let tempHome;
let catalogPath;

function writeSession(home, project, id, lines, mtimeSec) {
  const dir = path.join(home, '.claude', 'projects', project);
  fs.mkdirSync(dir, { recursive: true });
  const fp = path.join(dir, `${id}.jsonl`);
  fs.writeFileSync(fp, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  if (mtimeSec != null) fs.utimesSync(fp, mtimeSec, mtimeSec);
  return fp;
}

function jsonlLine(obj) { return JSON.stringify(obj); }

before(async () => {
  originalHome = process.env.HOME;
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-session-view-'));
  process.env.HOME = tempHome;

  const wardenDir = path.join(tempHome, '.yatfa-warden');
  fs.mkdirSync(wardenDir, { recursive: true });
  fs.writeFileSync(path.join(wardenDir, 'config.json'), JSON.stringify({ hosts: [] }));

  // A normal session: a user message, an assistant markdown reply, AND a
  // tool_result line + a summary line that must be SKIPPED (not rendered).
  writeSession(tempHome, 'projA', 'sess-view-1', [
    { type: 'user', cwd: '/repo/view-one', message: { role: 'user', content: '**summarize** the plan' } },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'giant blob of base64 that must NOT render' }] } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'here is the **plan**:\n\n- step one\n- step two' }] } },
    { type: 'summary', summary: 'a summary record that must be skipped' },
  ], 1000);

  // A session whose body is larger than the message cap so the tail window +
  // truncated flag are exercised end-to-end through the real local read.
  const longBody = [{ type: 'user', cwd: '/repo/view-long', message: { role: 'user', content: 'go' } }];
  for (let i = 0; i < 505; i++) {
    longBody.push({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: `message ${i}` }] } });
  }
  writeSession(tempHome, 'projB', 'sess-view-long', longBody, 2000);

  // An empty (zero-byte) session — file exists but has no readable messages.
  const emptyDir = path.join(tempHome, '.claude', 'projects', 'projC');
  fs.mkdirSync(emptyDir, { recursive: true });
  fs.writeFileSync(path.join(emptyDir, 'sess-view-empty.jsonl'), '');

  // A session with per-turn token usage on its assistant turns (WARDEN-474), so the
  // usage crosses the local API boundary and is attributable turn-by-turn. The user
  // line carries no usage; the assistant turns do (one plain, one with cache reads).
  writeSession(tempHome, 'projD', 'sess-view-tokens', [
    { type: 'user', cwd: '/repo/tokens', message: { role: 'user', content: 'do the work' } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'starting' }], usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'finishing' }], usage: { input_tokens: 200, output_tokens: 10, cache_creation_input_tokens: 500, cache_read_input_tokens: 2000 } } },
  ], 3000);

  const server = await import('./server.js');
  extractTranscriptMessage = server.extractTranscriptMessage;
  buildTranscriptView = server.buildTranscriptView;
  buildSessionReadScript = server.buildSessionReadScript;
  parseSessionReadOutput = server.parseSessionReadOutput;
  ({ catalogPath } = await import('./config.js'));
  httpServer = server.app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    httpServer.once('listening', resolve);
    httpServer.once('error', reject);
  });
  baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
});

after(async () => {
  if (httpServer) await new Promise((r) => httpServer.close(r));
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  try { fs.rmSync(tempHome, { recursive: true, force: true }); } catch { /* best-effort */ }
});

describe('extractTranscriptMessage', () => {
  it('maps a user line to {role, text, ts}', () => {
    const line = jsonlLine({ type: 'user', timestamp: '2026-07-10T10:00:00Z', message: { role: 'user', content: 'hello world' } });
    assert.deepStrictEqual(extractTranscriptMessage(line), { role: 'user', text: 'hello world', ts: '2026-07-10T10:00:00Z' });
  });

  it('joins text blocks from array content and defaults ts to ""', () => {
    const line = jsonlLine({ type: 'assistant', message: { role: 'assistant', content: [
      { type: 'text', text: 'part one' }, { type: 'text', text: 'part two' },
    ] } });
    assert.deepStrictEqual(extractTranscriptMessage(line), { role: 'assistant', text: 'part one part two', ts: '' });
  });

  it('returns null when content has only non-text blocks (tool results)', () => {
    const line = jsonlLine({ type: 'user', message: { role: 'user', content: [
      { type: 'tool_result', content: 'giant blob of base64' },
    ] } });
    assert.strictEqual(extractTranscriptMessage(line), null);
  });

  it('returns null for summary / malformed lines', () => {
    assert.strictEqual(extractTranscriptMessage(jsonlLine({ type: 'summary', summary: 'x' })), null);
    assert.strictEqual(extractTranscriptMessage('not json at all'), null);
    assert.strictEqual(extractTranscriptMessage(''), null);
  });

  it('returns null for an empty/whitespace text block (no stray empty bubble)', () => {
    // extractMessageText returns '' for a text block with no text (e.g. beside
    // tool_use blocks); the viewer must skip it rather than render an empty bubble.
    assert.strictEqual(extractTranscriptMessage(jsonlLine({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '' }] } })), null);
    assert.strictEqual(extractTranscriptMessage(jsonlLine({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '   ' }] } })), null);
  });
});

describe('extractTranscriptMessage — per-turn usage (WARDEN-474)', () => {
  it('surfaces message.usage with the correct field mapping + total on an assistant line', () => {
    const line = jsonlLine({ type: 'assistant', timestamp: '2026-07-10T10:00:00Z', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }], usage: {
      input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 2000, cache_read_input_tokens: 8000,
    } } });
    const msg = extractTranscriptMessage(line);
    assert.strictEqual(msg.role, 'assistant');
    assert.strictEqual(msg.text, 'done');
    assert.strictEqual(msg.ts, '2026-07-10T10:00:00Z');
    assert.deepStrictEqual(msg.usage, { input: 100, output: 50, cacheCreation: 2000, cacheRead: 8000, total: 10150 });
    // DONE criterion: total equals the sum of its parts.
    assert.strictEqual(msg.usage.total, msg.usage.input + msg.usage.output + msg.usage.cacheCreation + msg.usage.cacheRead);
  });

  it('coerces string/null usage fields via tok() without throwing', () => {
    const line = jsonlLine({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'x' }], usage: {
      input_tokens: '120', output_tokens: null, cache_creation_input_tokens: 30, cache_read_input_tokens: undefined,
    } } });
    assert.deepStrictEqual(extractTranscriptMessage(line).usage, { input: 120, output: 0, cacheCreation: 30, cacheRead: 0, total: 150 });
  });

  it('returns no usage on a user line (and a tool_result line stays null)', () => {
    const userLine = jsonlLine({ type: 'user', message: { role: 'user', content: 'hi' } });
    const userMsg = extractTranscriptMessage(userLine);
    assert.ok(!('usage' in userMsg), 'a user line must carry no usage key');
    // A tool_result line maps to null (no renderable text) — no usage either.
    const toolLine = jsonlLine({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'b64' }] } });
    assert.strictEqual(extractTranscriptMessage(toolLine), null);
  });

  it('omits the usage key when a turn carries an all-zero usage object', () => {
    // Mirrors parseJsonlTokenUsage's null-for-zero contract: a turn that spent no
    // tokens renders no chip. The key is absent (not { total: 0 }) so the message
    // stays {role, text, ts} exactly.
    const line = jsonlLine({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'free' }], usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } });
    const msg = extractTranscriptMessage(line);
    assert.ok(!('usage' in msg), 'an all-zero usage object must not attach a usage key');
  });
});

describe('buildTranscriptView', () => {
  it('takes cwd from the head window and messages from the body window, in order', () => {
    const head = jsonlLine({ cwd: '/repo/x' }) + '\n';
    const body = [
      jsonlLine({ type: 'user', message: { role: 'user', content: 'hi' } }),
      jsonlLine({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'hello back' }] } }),
    ].join('\n');
    const view = buildTranscriptView(head, body);
    assert.strictEqual(view.cwd, '/repo/x');
    assert.strictEqual(view.truncated, false);
    assert.strictEqual(view.messages.length, 2);
    assert.strictEqual(view.messages[0].role, 'user');
    assert.strictEqual(view.messages[0].text, 'hi');
    assert.strictEqual(view.messages[1].role, 'assistant');
    assert.strictEqual(view.messages[1].text, 'hello back');
  });

  it('skips tool_result / summary / malformed lines', () => {
    const body = [
      jsonlLine({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'b64' }] } }),
      jsonlLine({ type: 'summary', summary: 's' }),
      'garbage not json',
      jsonlLine({ type: 'assistant', message: { role: 'assistant', content: 'the only real message' } }),
    ].join('\n');
    const view = buildTranscriptView('', body);
    assert.strictEqual(view.messages.length, 1, 'only the one human-text message survives');
    assert.strictEqual(view.messages[0].text, 'the only real message');
  });

  it('keeps the most-recent messages and flags truncated when over the cap', () => {
    // SESSION_VIEW_MAX_MESSAGES is 500 (see server.js). Build 505 so the cap bites.
    const lines = [];
    for (let i = 0; i < 505; i++) {
      lines.push(jsonlLine({ type: 'user', message: { role: 'user', content: `m${i}` } }));
    }
    const view = buildTranscriptView('', lines.join('\n'));
    assert.strictEqual(view.truncated, true);
    assert.strictEqual(view.messages.length, 500, 'capped to the max message count');
    // The oldest 5 (m0..m4) are dropped; the tail (m504) is last.
    assert.strictEqual(view.messages[0].text, 'm5');
    assert.strictEqual(view.messages[499].text, 'm504');
  });

  it('carries per-turn usage through to the returned messages (WARDEN-474)', () => {
    const body = [
      jsonlLine({ type: 'user', message: { role: 'user', content: 'go' } }),
      jsonlLine({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'a' }], usage: { input_tokens: 10, output_tokens: 5 } } }),
      jsonlLine({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'b' }], usage: { input_tokens: 20, output_tokens: 0, cache_read_input_tokens: 100 } } }),
    ].join('\n');
    const view = buildTranscriptView('', body);
    assert.strictEqual(view.messages.length, 3);
    assert.ok(!('usage' in view.messages[0]), 'user message carries no usage');
    assert.deepStrictEqual(view.messages[1].usage, { input: 10, output: 5, cacheCreation: 0, cacheRead: 0, total: 15 });
    assert.deepStrictEqual(view.messages[2].usage, { input: 20, output: 0, cacheCreation: 0, cacheRead: 100, total: 120 });
  });

  it('handles an empty body with no crash and no truncation', () => {
    const view = buildTranscriptView(jsonlLine({ cwd: '/r' }), '');
    assert.deepStrictEqual(view.messages, []);
    assert.strictEqual(view.cwd, '/r');
    assert.strictEqual(view.truncated, false);
  });
});

describe('buildSessionReadScript', () => {
  it('resolves the file by its unique id basename across project dirs and bounds output', () => {
    const s = buildSessionReadScript('sess-abc');
    assert.ok(s.includes('~/.claude/projects/*/sess-abc.jsonl'), 'must glob the id across project dirs');
    assert.ok(s.includes('head -c 8192'), 'must emit a head window for cwd');
    assert.ok(s.includes('tail -c '), 'must emit a bounded tail window for the body');
    assert.ok(s.includes('___NOSESSION'), 'must emit a not-found marker when no file matches');
  });

  it('embeds the validated id verbatim in the glob', () => {
    // ids are validated /^[\w-]+$/ at the endpoint (no shell metacharacters); the
    // script embeds the id verbatim. Assert the shape so a quoting change is caught.
    const s = buildSessionReadScript('abc_123-XYZ');
    assert.ok(s.includes('~/.claude/projects/*/abc_123-XYZ.jsonl'));
  });
});

describe('parseSessionReadOutput', () => {
  it('detects the not-found marker', () => {
    assert.deepStrictEqual(parseSessionReadOutput('___NOSESSION\n'), { notFound: true });
  });

  it('splits head/body, sets cwd, and extracts messages', () => {
    const head = jsonlLine({ cwd: '/repo/h' });
    const body = jsonlLine({ type: 'user', message: { role: 'user', content: 'hi' } }) + '\n';
    const stdout = `___SZ\t42\n___HEAD\n${head}\n___BODY\n${body}`;
    const view = parseSessionReadOutput(stdout);
    assert.strictEqual(view.cwd, '/repo/h');
    assert.strictEqual(view.messages.length, 1);
    assert.strictEqual(view.messages[0].text, 'hi');
    assert.strictEqual(view.truncated, false);
  });

  it('flags byte-truncation when the reported file size exceeds the cap', () => {
    // A huge size (well above any sane cap) so this is robust to the exact cap value.
    const stdout = `___SZ\t10000000\n___HEAD\n${jsonlLine({ cwd: '/r' })}\n___BODY\n${jsonlLine({ type: 'user', message: { role: 'user', content: 'x' } })}`;
    assert.strictEqual(parseSessionReadOutput(stdout).truncated, true);
  });

  it('treats marker-less stdout as the body (graceful fallback)', () => {
    const view = parseSessionReadOutput(jsonlLine({ type: 'user', message: { role: 'user', content: 'raw' } }));
    assert.strictEqual(view.messages.length, 1);
    assert.strictEqual(view.messages[0].text, 'raw');
  });

  it('preserves per-turn usage through the remote (parsed stdout) path (WARDEN-474)', () => {
    // The remote read funnels through buildTranscriptView → extractTranscriptMessage
    // just like the local path, so the single parse fix reaches a remote host's
    // transcripts. Verify usage survives the delimited head/body split.
    const head = jsonlLine({ cwd: '/repo/remote' });
    const body = jsonlLine({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }], usage: { input_tokens: 7, output_tokens: 3 } } }) + '\n';
    const stdout = `___SZ\t42\n___HEAD\n${head}\n___BODY\n${body}`;
    const view = parseSessionReadOutput(stdout);
    assert.strictEqual(view.messages.length, 1);
    assert.deepStrictEqual(view.messages[0].usage, { input: 7, output: 3, cacheCreation: 0, cacheRead: 0, total: 10 });
  });
});

describe('/api/claude-session HTTP endpoint (real Express app from server.js)', () => {
  it('reads a past session transcript WITHOUT resuming it (local)', async () => {
    const res = await fetch(`${baseUrl}/api/claude-session?id=sess-view-1&host=${encodeURIComponent('(local)')}`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.host, '(local)');
    assert.strictEqual(body.cwd, '/repo/view-one');
    assert.ok(Array.isArray(body.messages));
    const texts = body.messages.map((m) => m.text);
    assert.ok(texts.some((t) => t.includes('summarize')), 'first user message present');
    assert.ok(texts.some((t) => t.includes('step two')), 'assistant reply present');
    // The tool_result blob and summary record must NOT appear as messages.
    assert.ok(!texts.some((t) => t.includes('giant blob of base64')), 'tool_result must be skipped');
    assert.ok(!texts.some((t) => t.includes('a summary record')), 'summary record must be skipped');
    // Every message is well-formed.
    for (const m of body.messages) {
      assert.ok(typeof m.role === 'string' && m.role.length > 0);
      assert.ok(typeof m.text === 'string' && m.text.length > 0);
      assert.ok('ts' in m);
    }
  });

  it('carries per-turn token usage across the API boundary (local) (WARDEN-474)', async () => {
    const body = await (await fetch(`${baseUrl}/api/claude-session?id=sess-view-tokens`)).json();
    assert.strictEqual(body.cwd, '/repo/tokens');
    assert.ok(Array.isArray(body.messages));
    assert.strictEqual(body.messages.length, 3);
    // First message is the user line — no usage key.
    assert.ok(!('usage' in body.messages[0]));
    // Two assistant turns carry usage whose totals are the sum of their parts.
    assert.deepStrictEqual(body.messages[1].usage, { input: 100, output: 50, cacheCreation: 0, cacheRead: 0, total: 150 });
    assert.deepStrictEqual(body.messages[2].usage, { input: 200, output: 10, cacheCreation: 500, cacheRead: 2000, total: 2710 });
  });

  it('does NOT create a catalog entry or spawn a process (pure read)', async () => {
    // A read-only view must never write the catalog. Snapshot its existence/content
    // before and after: saveCatalog (the only writer) is never called, so the file
    // stays exactly as it was. This is the observable proof of "no side effects".
    const before = fs.existsSync(catalogPath) ? fs.readFileSync(catalogPath, 'utf8') : null;
    const res = await fetch(`${baseUrl}/api/claude-session?id=sess-view-1`);
    assert.strictEqual(res.status, 200);
    const after = fs.existsSync(catalogPath) ? fs.readFileSync(catalogPath, 'utf8') : null;
    assert.strictEqual(after, before, 'a read must not create or modify the catalog');
  });

  it('bounds a huge session to the message cap and flags truncated', async () => {
    const body = await (await fetch(`${baseUrl}/api/claude-session?id=sess-view-long`)).json();
    assert.strictEqual(body.cwd, '/repo/view-long');
    assert.strictEqual(body.truncated, true, 'over-cap transcript must be flagged truncated');
    assert.ok(body.messages.length <= 500, 'message list must be bounded');
    assert.ok(body.messages.length > 0);
  });

  it('returns an empty message list for a session with no readable messages', async () => {
    const body = await (await fetch(`${baseUrl}/api/claude-session?id=sess-view-empty`)).json();
    assert.deepStrictEqual(body.messages, []);
  });

  it('returns 404 for an unknown session id', async () => {
    const res = await fetch(`${baseUrl}/api/claude-session?id=does-not-exist-999`);
    assert.strictEqual(res.status, 404);
  });

  it('returns 400 for an invalid session id', async () => {
    // '/' (and other non-[\w-] chars) must be rejected by the id guard.
    const res = await fetch(`${baseUrl}/api/claude-session?id=${encodeURIComponent('bad/id')}`);
    assert.strictEqual(res.status, 400);
  });

  it('defaults host to (local) when omitted', async () => {
    const body = await (await fetch(`${baseUrl}/api/claude-session?id=sess-view-1`)).json();
    assert.strictEqual(body.host, '(local)');
    assert.ok(body.messages.length > 0);
  });
});
