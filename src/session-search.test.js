import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * Tests for the cross-host full-content session search (WARDEN-161).
 *
 * Two layers, sharing ONE file-level before() — same structure as
 * git-log.test.js, because src/server.js evaluates `const cfg = load()` at
 * module load and load() reads config.js's module-level dir (= HOME-based).
 * The FIRST import of server.js freezes HOME for the process, so HOME (and the
 * config + seeded JSONL archive) must be in place before that import.
 *
 *  1. Pure unit tests for the helpers the endpoint is built on:
 *       extractMessageText, snippetFromLine, buildSessionSearchScript
 *     These are the trickiest logic — human-text extraction, bounded snippets,
 *     and the remote-shell injection surface (the query is user input in a remote
 *     `grep`). (Fixed-string, not regex, matching is asserted end-to-end by the
 *     HTTP `c.t ≠ cat` test against the real local `grep -F` path.)
 *
 *  2. HTTP integration tests against the REAL Express app from src/server.js.
 *     We seed a throwaway HOME whose ~/.claude/projects archive (one jsonl file
 *     per session) holds sessions whose BODIES (not first-message summaries)
 *     contain known phrases, then GET /api/claude-sessions-search?q=… and assert
 *     on the wire response.
 *     cfg.hosts is empty so only the LOCAL host is searched — no SSH, fully
 *     deterministic. Covers the success criteria:
 *       - a phrase inside a session BODY (not its summary) is found
 *       - each result carries its host + a content snippet
 *       - the query is a LITERAL, never a regex (c.t does not match "cat")
 *       - shell-injection payloads are treated as literal search text
 *       - empty query → 400; absent phrase → 200 + []
 *       - matches are recency-ranked
 */

// ---- helpers under test (assigned from the dynamic import in before()) ----
let extractMessageText;
let snippetFromLine;
let buildSessionSearchScript;

let httpServer;
let baseUrl;
let originalHome;
let tempHome;

// Build one JSONL session file under <home>/.claude/projects/<project>/<id>.jsonl.
// `lines` is an array of raw JSONL objects (each becomes one line). `mtimeSec`
// sets the file mtime (seconds) so recency ordering is deterministic.
function writeSession(home, project, id, lines, mtimeSec) {
  const dir = path.join(home, '.claude', 'projects', project);
  fs.mkdirSync(dir, { recursive: true });
  const fp = path.join(dir, `${id}.jsonl`);
  fs.writeFileSync(fp, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  if (mtimeSec != null) fs.utimesSync(fp, mtimeSec, mtimeSec);
  return fp;
}

function jsonlLine(obj) { return JSON.stringify(obj); }

// The sessions seeded into the temp archive. Phrases live in the BODY (assistant
// text), never only in the first-message summary, so a body search is exercised.
const LONG_PAD = 'la la la '.repeat(60); // >180 chars, to exercise snippet bounding

before(async () => {
  originalHome = process.env.HOME;
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-session-search-'));
  process.env.HOME = tempHome;

  // config.json with no SSH hosts → endpoint searches only '(local)'.
  const wardenDir = path.join(tempHome, '.yatfa-warden');
  fs.mkdirSync(wardenDir, { recursive: true });
  fs.writeFileSync(path.join(wardenDir, 'config.json'), JSON.stringify({ hosts: [] }));

  // S1: body contains "SSH pool leak"; summary is the (different) first message.
  writeSession(tempHome, 'projA', 'sess-aaa', [
    { type: 'user', cwd: '/repo/aaa', message: { role: 'user', content: 'start working on the thing' } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'we debugged the SSH pool leak together today' }] } },
  ], 1000);

  // S2: body contains "cat … dog" — used to prove literal-not-regex matching.
  writeSession(tempHome, 'projA', 'sess-bbb', [
    { type: 'user', cwd: '/repo/bbb', message: { role: 'user', content: 'hello there' } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'the cat sat on the dog' }] } },
  ], 2000);

  // S3: body literally contains a shell-injection-looking string.
  writeSession(tempHome, 'projA', 'sess-ccc', [
    { type: 'user', cwd: '/repo/ccc', message: { role: 'user', content: 'go' } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'run foo; rm -rf / now please' }] } },
  ], 3000);

  // S4: NEWER than S1 and also matches "SSH pool leak"; body text is long to
  // exercise the snippet length bound. Recency sort must put S4 before S1.
  writeSession(tempHome, 'projB', 'sess-ddd', [
    { type: 'user', cwd: '/repo/ddd', message: { role: 'user', content: 'deep dive' } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: `${LONG_PAD}the SSH pool leak is the root cause${LONG_PAD}` }] } },
  ], 4000);

  // S5: the DANGEROUS input class — the session's ONLY occurrence of the needle
  // sits past the 1500-byte matched-line transfer cap. The needle lives deep
  // inside a large tool_result blob (>2000 chars of padding precede it), exactly
  // where real error strings / log lines hide. The first line carries cwd (so
  // the session is otherwise returnable) but NOT the needle. grep -m1 matches
  // the long second line; streamBoundedSearch caps that row to 1500 chars BEFORE
  // the needle; snippetFromLine therefore returns ''. The endpoint must STILL
  // return this session (grep matched it) — pushing regardless of snippet is the
  // property under test. (WARDEN-161 reviewer finding: local search dropped it.)
  const DEEP_PAD = 'x'.repeat(2200); // >> 1500-byte transfer cap
  writeSession(tempHome, 'projC', 'sess-eee', [
    { type: 'user', cwd: '/repo/eee', message: { role: 'user', content: 'go' } },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: `${DEEP_PAD}DeepNeedlePhraseZQ9` }] } },
  ], 5000);

  // Import server.js ONCE — after HOME/config/archive are in place.
  const server = await import('./server.js');
  extractMessageText = server.extractMessageText;
  snippetFromLine = server.snippetFromLine;
  buildSessionSearchScript = server.buildSessionSearchScript;
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

describe('extractMessageText', () => {
  it('returns string message content', () => {
    const line = jsonlLine({ type: 'user', message: { role: 'user', content: 'hello world' } });
    assert.strictEqual(extractMessageText(line), 'hello world');
  });

  it('joins text blocks from array content', () => {
    const line = jsonlLine({ type: 'assistant', message: { role: 'assistant', content: [
      { type: 'text', text: 'part one' }, { type: 'text', text: 'part two' },
    ] } });
    assert.strictEqual(extractMessageText(line), 'part one part two');
  });

  it('returns null when content has only non-text blocks (tool results)', () => {
    const line = jsonlLine({ type: 'user', message: { role: 'user', content: [
      { type: 'tool_result', content: 'giant blob of base64' },
    ] } });
    assert.strictEqual(extractMessageText(line), null);
  });

  it('returns null for non-message / malformed lines', () => {
    assert.strictEqual(extractMessageText(jsonlLine({ type: 'summary', summary: 'x' })), null);
    assert.strictEqual(extractMessageText('not json at all'), null);
    assert.strictEqual(extractMessageText(''), null);
  });
});

describe('snippetFromLine', () => {
  it('extracts a clean human-text snippet centered on the needle', () => {
    const line = jsonlLine({ type: 'assistant', message: { role: 'assistant', content: [
      { type: 'text', text: 'we debugged the SSH pool leak together today' },
    ] } });
    const snip = snippetFromLine(line, 'ssh pool leak');
    assert.ok(snip.includes('SSH pool leak'), `snippet should contain the needle; got: ${snip}`);
    // Human text, not raw JSON.
    assert.ok(!snip.includes('"type"') && !snip.includes('{'), 'snippet should be clean text, not JSON');
    assert.strictEqual(snip, 'we debugged the SSH pool leak together today');
  });

  it('is bounded to the max length', () => {
    const pad = 'x '.repeat(500); // >> maxLen
    const line = jsonlLine({ type: 'assistant', message: { role: 'assistant', content: [
      { type: 'text', text: `${pad}NEEDLE${pad}` },
    ] } });
    const snip = snippetFromLine(line, 'needle');
    assert.ok(snip.includes('NEEDLE'));
    assert.ok(snip.length <= 180, `snippet must be bounded; got len=${snip.length}`);
  });

  it('returns "" when the line does not contain the needle', () => {
    const line = jsonlLine({ type: 'user', message: { role: 'user', content: 'nothing relevant here' } });
    assert.strictEqual(snippetFromLine(line, 'absent-needle'), '');
  });

  it('returns "" for an empty needle', () => {
    assert.strictEqual(snippetFromLine('anything', ''), '');
  });

  it('falls back to a raw (bounded) snippet when the match is not in message text', () => {
    // A tool_result line: no extractable message text, but the raw line matches.
    const line = jsonlLine({ type: 'user', message: { role: 'user', content: [
      { type: 'tool_result', content: 'error: SSH pool leak detected in logs' },
    ] } });
    const snip = snippetFromLine(line, 'ssh pool leak');
    assert.ok(snip.includes('SSH pool leak'), `fallback snippet should still contain the needle; got: ${snip}`);
  });
});

describe('buildSessionSearchScript', () => {
  it('uses fixed-string, case-insensitive grep with an option-stop and bounded output', () => {
    const script = buildSessionSearchScript('foo');
    assert.match(script, /grep -m1 -F -i -I -- 'foo' "\$f"/, 'must grep with -F -i -I -- and the file');
    assert.ok(script.includes('head -c '), 'must bound the matched-line transfer');
    assert.ok(script.includes('~/.claude/projects/*/*.jsonl'), 'must walk the session archive');
  });

  it('shell-quotes the query so injection payloads are a LITERAL search pattern', () => {
    // A payload that would be catastrophic if interpreted as shell — it must end
    // up inside single quotes as a fixed grep pattern, not executed.
    const script = buildSessionSearchScript('foo; rm -rf /');
    assert.ok(script.includes(`-- 'foo; rm -rf /' "$f"`),
      `injection payload must be single-quoted as a literal pattern; script had:\n${script}`);
  });

  it('correctly quotes a query containing a single quote', () => {
    // shellQuote("it's") === "'it'\\''s'"
    const script = buildSessionSearchScript("it's");
    assert.ok(script.includes(`-- 'it'\\''s' "$f"`),
      `single quote must be POSIX-escaped; script had:\n${script}`);
  });
});

describe('/api/claude-sessions-search HTTP endpoint (real Express app from server.js)', () => {
  it('finds a session by a phrase in its BODY (not its first-message summary)', async () => {
    const res = await fetch(`${baseUrl}/api/claude-sessions-search?q=${encodeURIComponent('SSH pool leak')}`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.results));
    const ids = body.results.map((r) => r.sessionId);
    assert.ok(ids.includes('sess-aaa'), `body match must surface sess-aaa; got: ${ids.join(',')}`);
    // The summary is the FIRST message, which does NOT contain the phrase —
    // proving the match came from the body, not the summary.
    const aaa = body.results.find((r) => r.sessionId === 'sess-aaa');
    assert.strictEqual(aaa.summary, 'start working on the thing');
    assert.ok(aaa.snippet.includes('SSH pool leak'), `snippet must contain the body phrase; got: ${aaa.snippet}`);
  });

  it('attaches the host to every result (retires "where did that session run?")', async () => {
    const body = await (await fetch(`${baseUrl}/api/claude-sessions-search?q=${encodeURIComponent('SSH pool leak')}`)).json();
    assert.ok(body.results.length > 0);
    for (const r of body.results) {
      assert.strictEqual(r.host, '(local)', 'every result must carry its origin host');
      assert.ok(typeof r.sessionId === 'string' && r.sessionId.length > 0);
      assert.ok(typeof r.cwd === 'string');
      assert.ok(typeof r.summary === 'string');
      assert.ok(typeof r.snippet === 'string' && r.snippet.length > 0);
      assert.ok(typeof r.mtime === 'number');
    }
  });

  it('snippets are clean conversation text, not raw JSON', async () => {
    const body = await (await fetch(`${baseUrl}/api/claude-sessions-search?q=${encodeURIComponent('SSH pool leak')}`)).json();
    const aaa = body.results.find((r) => r.sessionId === 'sess-aaa');
    assert.ok(aaa, 'sess-aaa should be present');
    assert.ok(!aaa.snippet.includes('"type"'), 'snippet must not leak JSON structure');
  });

  it('treats the query as a LITERAL fixed string, not a regex (c.t ≠ cat)', async () => {
    // sess-bbb contains "cat" but not the literal "c.t". A regex c.t would match.
    const res = await fetch(`${baseUrl}/api/claude-sessions-search?q=c.t`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    const ids = body.results.map((r) => r.sessionId);
    assert.ok(!ids.includes('sess-bbb'), `literal search must not regex-match "cat"; got: ${ids.join(',')}`);
  });

  it('treats shell-injection text as a literal search pattern and still finds it', async () => {
    // sess-ccc literally contains "foo; rm -rf /" — the search must find it by
    // that exact text, proving the payload is a pattern, not executed.
    const body = await (await fetch(`${baseUrl}/api/claude-sessions-search?q=${encodeURIComponent('foo; rm -rf /')}`)).json();
    assert.ok(body.results.some((r) => r.sessionId === 'sess-ccc'), 'must find the session containing the literal payload');
    const ccc = body.results.find((r) => r.sessionId === 'sess-ccc');
    assert.ok(ccc.snippet.includes('foo; rm -rf /'), `snippet must contain the literal payload; got: ${ccc.snippet}`);
  });

  it('recency-ranks matches (newest first)', async () => {
    const body = await (await fetch(`${baseUrl}/api/claude-sessions-search?q=${encodeURIComponent('SSH pool leak')}`)).json();
    const ids = body.results.map((r) => r.sessionId);
    // sess-ddd (mtime 4000) is newer than sess-aaa (mtime 1000) → must come first.
    const dddIdx = ids.indexOf('sess-ddd');
    const aaaIdx = ids.indexOf('sess-aaa');
    assert.ok(dddIdx !== -1 && aaaIdx !== -1, 'both matching sessions must be present');
    assert.ok(dddIdx < aaaIdx, `newer session must rank first; got order: ${ids.join(',')}`);
    // Strictly descending mtimes across the whole result set.
    for (let i = 1; i < body.results.length; i++) {
      assert.ok(body.results[i - 1].mtime >= body.results[i].mtime, 'results must be recency-sorted');
    }
  });

  it('bounds the snippet length even for long body text', async () => {
    const body = await (await fetch(`${baseUrl}/api/claude-sessions-search?q=${encodeURIComponent('SSH pool leak')}`)).json();
    const ddd = body.results.find((r) => r.sessionId === 'sess-ddd');
    assert.ok(ddd, 'sess-ddd (long body) must be found');
    assert.ok(ddd.snippet.length <= 180, `snippet must be bounded; got len=${ddd.snippet.length}`);
    assert.ok(ddd.snippet.includes('SSH pool leak'));
  });

  it('returns 200 with an empty results array when nothing matches', async () => {
    const res = await fetch(`${baseUrl}/api/claude-sessions-search?q=zzz-not-present-anywhere-123`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.deepStrictEqual(body.results, []);
  });

  it('returns a session whose ONLY match is past the 1500-byte line cap (deep needle)', async () => {
    // sess-eee's needle "DeepNeedlePhraseZQ9" lives >2200 bytes into a large
    // tool_result line. grep genuinely matches the file, but the matched-line
    // transfer cap (1500) chops the line before the needle, so snippetFromLine
    // can only build an EMPTY snippet. The session must still be returned —
    // dropping it on an empty snippet would be a false negative that breaks the
    // core "a phrase inside the body returns that session" criterion. This is
    // the exact input the WARDEN-161 reviewer reproduced against the real
    // function; it went red under the old `if (snippet)` drop and stays green
    // now that the local path pushes unconditionally (matching the remote twin).
    const body = await (await fetch(`${baseUrl}/api/claude-sessions-search?q=${encodeURIComponent('DeepNeedlePhraseZQ9')}`)).json();
    const ids = body.results.map((r) => r.sessionId);
    assert.ok(ids.includes('sess-eee'),
      `deep-needle session must be returned even with an empty snippet; got: ${ids.join(',')}`);
    const eee = body.results.find((r) => r.sessionId === 'sess-eee');
    // The snippet is empty (needle past the cap) but the rest of the row is intact
    // — host/sessionId/cwd/summary/mtime all present, so the result is still useful
    // and resumable. An empty string is the honest, graceful representation.
    assert.strictEqual(eee.host, '(local)');
    assert.strictEqual(eee.cwd, '/repo/eee');
    assert.strictEqual(eee.snippet, '');
  });

  it('returns 400 for an empty query', async () => {
    const res = await fetch(`${baseUrl}/api/claude-sessions-search?q=`);
    assert.strictEqual(res.status, 400);
  });

  it('also matches a phrase that appears in the first-message summary', async () => {
    // "start working" is sess-aaa's first message (and thus its summary). It must
    // still be found — the body search is a superset of summary-only matching.
    const body = await (await fetch(`${baseUrl}/api/claude-sessions-search?q=${encodeURIComponent('start working')}`)).json();
    assert.ok(body.results.some((r) => r.sessionId === 'sess-aaa'), 'must find sessions by summary text too');
  });
});
