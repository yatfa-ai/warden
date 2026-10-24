import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// WARDEN-1934 — pins searchLocalClaudeSessions (src/claudeSessions.js, the LOCAL
// leg of /api/claude-sessions-search) at MODULE grain, with the real grep from
// PATH and the real module — no mocking of the code under test. HOME is frozen
// to a fixture archive (~/.claude/projects/.../*.jsonl with utimes-set mtimes)
// BEFORE the dynamic import, mirroring the harness convention of
// claudeSessionsRoutes.test.js.
//
// Why a module-level suite: the existing coverage is HTTP-mediated and partial —
// session-search.test.js drives the function through server.js (literal
// matching, recency, the deep-needle push) and claudeSessionsRoutes.test.js
// exercises the route glue (fake remote hosts, one seeded local file for the
// host-order test, and missing-archive [] on tests that seed no archive), so
// the local body's own contract is never asserted directly. The risky wiring of
// the local body — the grep argv (order-sensitive
// `-r -m 1 --include=*.jsonl -F -i -I -n --`), the caps threading
// (streamBoundedSearch maxResults=500 / per-line transfer 1500), the mtime
// ranking, the 8192-byte head read feeding parseJsonlHead's cwd gate, and the
// deliberate unconditional-push rule — is pinned here directly.
//
// The unconditional-push / snippet-empty-is-not-a-drop / per-host-cap points are
// the consistency contract this implementation shares with its REMOTE twin
// (remoteSearchClaudeSessions, pinned by the companion-exec-legs/totality
// suites); they are pinned here on the LOCAL side, per the source comment
// binding the two implementations to stay consistent.

const originalHome = process.env.HOME;
const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-claudeSessionsSearchLocal-'));
process.env.HOME = tempHome;

const { searchLocalClaudeSessions, SESSION_SEARCH_PER_HOST } = await import('./claudeSessions.js');

const projectsDir = path.join(tempHome, '.claude', 'projects');

// Write one session file under <home>/.claude/projects/<project>/<id>.jsonl.
// `lines` are raw JSONL objects (one per line); `mtimeSec` pins the file mtime
// so recency ordering is deterministic across the whole fixture archive.
function writeSession(project, id, lines, mtimeSec) {
  const dir = path.join(projectsDir, project);
  fs.mkdirSync(dir, { recursive: true });
  const fp = path.join(dir, `${id}.jsonl`);
  fs.writeFileSync(fp, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  if (mtimeSec != null) fs.utimesSync(fp, mtimeSec, mtimeSec);
  return fp;
}

describe('searchLocalClaudeSessions (local grep/rank/enrich leg of /api/claude-sessions-search)', () => {
  after(async () => {
    process.env.HOME = originalHome;
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  describe('guards', () => {
    it('returns [] for an empty query without scanning', async () => {
      assert.deepEqual(await searchLocalClaudeSessions(''), []);
    });

    it('returns [] when the local archive directory is missing', async () => {
      const noArchive = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-csl-noarchive-'));
      process.env.HOME = noArchive;
      try {
        assert.deepEqual(await searchLocalClaudeSessions('anything'), []);
      } finally {
        process.env.HOME = tempHome;
        fs.rmSync(noArchive, { recursive: true, force: true });
      }
    });

    it('returns [] when the archive path is a file, not a directory', async () => {
      const base = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-csl-filearchive-'));
      fs.mkdirSync(path.join(base, '.claude'), { recursive: true });
      fs.writeFileSync(path.join(base, '.claude', 'projects'), 'not a directory');
      process.env.HOME = base;
      try {
        assert.deepEqual(await searchLocalClaudeSessions('anything'), []);
      } finally {
        process.env.HOME = tempHome;
        fs.rmSync(base, { recursive: true, force: true });
      }
    });
  });

  describe('row shape, per-file dedup and recency ranking', () => {
    it('returns rows carrying id/cwd/summary/snippet derived from the archive', async () => {
      writeSession('shape', 'sess-shape', [
        { type: 'user', cwd: '/repo/shape', message: { role: 'user', content: 'please shape the thing' } },
        { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'theshapingneedle appears in the reply too' }] } },
      ], 5000);
      const rows = await searchLocalClaudeSessions('theshapingneedle');
      const row = rows.find((r) => r.id === 'sess-shape');
      assert.ok(row, 'expected a row for sess-shape');
      assert.equal(row.cwd, '/repo/shape');
      assert.equal(typeof row.summary, 'string');
      assert.ok(row.summary.length > 0, 'summary comes from the first user message in the head');
      assert.equal(typeof row.snippet, 'string');
      assert.ok(row.snippet.toLowerCase().includes('theshapingneedle'));
      assert.equal(typeof row.mtime, 'number');
    });

    it('emits at most one row per matching file (-m 1) even when several lines match', async () => {
      writeSession('dedup', 'sess-dup', [
        { type: 'user', cwd: '/repo/dup', message: { role: 'user', content: 'dupneedle on the first line' } },
        { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'dupneedle on the second line too' }] } },
      ], 5100);
      const rows = await searchLocalClaudeSessions('dupneedle');
      assert.equal(rows.filter((r) => r.id === 'sess-dup').length, 1,
        'grep -m 1 yields one row per file; the result must not duplicate the session');
    });

    it('orders matches most-recent-first by file mtime', async () => {
      writeSession('rank', 'sess-rank-old', [
        { type: 'user', cwd: '/repo/old', message: { role: 'user', content: 'rankneedle here' } },
      ], 5200);
      writeSession('rank', 'sess-rank-mid', [
        { type: 'user', cwd: '/repo/mid', message: { role: 'user', content: 'rankneedle here' } },
      ], 5250);
      writeSession('rank', 'sess-rank-new', [
        { type: 'user', cwd: '/repo/new', message: { role: 'user', content: 'rankneedle here' } },
      ], 5300);
      const ids = (await searchLocalClaudeSessions('rankneedle')).map((r) => r.id);
      assert.ok(ids.indexOf('sess-rank-new') < ids.indexOf('sess-rank-mid')
        && ids.indexOf('sess-rank-mid') < ids.indexOf('sess-rank-old'),
        `expected mtime-desc order, got: ${ids.join(', ')}`);
    });
  });

  describe('grep argv contract', () => {
    it('matches case-insensitively (-i) and anchors the snippet on the lowered needle', async () => {
      writeSession('case', 'sess-case', [
        { type: 'user', cwd: '/repo/case', message: { role: 'user', content: 'go' } },
        { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'the CaSeInSiT marker lives here' }] } },
      ], 5400);
      const rows = await searchLocalClaudeSessions('CASEINSIT');
      const row = rows.find((r) => r.id === 'sess-case');
      assert.ok(row, 'a differently-cased occurrence must match (grep -i), and the raw query must be lowered before use');
      assert.ok(row.snippet.toLowerCase().includes('caseinsit'),
        `snippet must be anchored on the lowered needle, got: ${JSON.stringify(row.snippet)}`);
    });

    it('treats the query as a literal string (-F): regex metacharacters match only themselves', async () => {
      writeSession('literal', 'sess-literal', [
        { type: 'user', cwd: '/repo/literal', message: { role: 'user', content: 'payload a.b*c here' } },
      ], 5500);
      writeSession('literal', 'sess-literal-decoy', [
        { type: 'user', cwd: '/repo/decoy', message: { role: 'user', content: 'the axbc decoy' } },
      ], 5600);
      const ids = (await searchLocalClaudeSessions('a.b*c')).map((r) => r.id);
      assert.ok(ids.includes('sess-literal'), 'the literal a.b*c must match');
      assert.ok(!ids.includes('sess-literal-decoy'),
        'a.b*c read as a regex would match "axbc" — -F must keep it literal');
    });

    it('scans only *.jsonl files (--include), ignoring other extensions', async () => {
      const dir = path.join(projectsDir, 'include');
      fs.mkdirSync(dir, { recursive: true });
      const jsonl = path.join(dir, 'sess-include-jsonl.jsonl');
      fs.writeFileSync(jsonl, JSON.stringify({ type: 'user', cwd: '/repo/jsonl', message: { role: 'user', content: 'includeneedle in the jsonl' } }) + '\n');
      fs.utimesSync(jsonl, 5700, 5700);
      const txt = path.join(dir, 'sess-include-txt.txt');
      fs.writeFileSync(txt, JSON.stringify({ type: 'user', cwd: '/repo/txt', message: { role: 'user', content: 'includeneedle in the txt' } }) + '\n');
      fs.utimesSync(txt, 5800, 5800);
      const ids = (await searchLocalClaudeSessions('includeneedle')).map((r) => r.id);
      assert.ok(ids.includes('sess-include-jsonl'));
      assert.ok(!ids.includes('sess-include-txt'), 'the .txt match must be ignored (--include=*.jsonl)');
    });

    it('searches a flag-shaped query (--max-wait) instead of erroring into []', async () => {
      writeSession('flag', 'sess-flag', [
        { type: 'user', cwd: '/repo/flag', message: { role: 'user', content: 'retry with --max-wait raised' } },
      ], 5900);
      const row = (await searchLocalClaudeSessions('--max-wait')).find((r) => r.id === 'sess-flag');
      assert.ok(row, 'the `--` option stop must keep grep reading the query as a pattern, not an option');
      assert.equal(row.cwd, '/repo/flag');
    });
  });

  describe('caps threading and the head read', () => {
    it('caps enrichment at SESSION_SEARCH_PER_HOST newest matches and drops the oldest', async () => {
      for (let i = 0; i < 35; i++) {
        writeSession('cap', `sess-cap-${String(i).padStart(2, '0')}`, [
          { type: 'user', cwd: `/repo/cap${i}`, message: { role: 'user', content: `capneedle number ${i}` } },
        ], 10000 + i);
      }
      const rows = await searchLocalClaudeSessions('capneedle');
      assert.equal(rows.length, SESSION_SEARCH_PER_HOST,
        `exactly the per-host cap (${SESSION_SEARCH_PER_HOST}) rows survive across 35 matches`);
      const ids = new Set(rows.map((r) => r.id));
      for (let i = 0; i < 5; i++) {
        assert.ok(!ids.has(`sess-cap-0${i}`), `oldest match sess-cap-0${i} must be dropped`);
      }
      for (let i = 15; i < 35; i++) {
        assert.ok(ids.has(`sess-cap-${String(i).padStart(2, '0')}`),
          `newest match sess-cap-${String(i).padStart(2, '0')} must be kept`);
      }
    });

    it('keeps a match whose cwd sits inside the 8192-byte head read', async () => {
      writeSession('head', 'sess-head-kept', [
        { type: 'user', cwd: '/repo/head-kept', message: { role: 'user', content: 'p'.repeat(1500) } },
        { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'headkeptneedle found here' }] } },
      ], 20000);
      const row = (await searchLocalClaudeSessions('headkeptneedle')).find((r) => r.id === 'sess-head-kept');
      assert.ok(row, 'a cwd at ~byte 1550 is inside the 8192-byte head and must enrich the row');
      assert.equal(row.cwd, '/repo/head-kept');
    });

    it('drops a match whose cwd sits beyond the 8192-byte head read', async () => {
      // Line 1 carries the ONLY cwd and is ~20k chars: the 8192-byte head read
      // truncates it mid-JSON, parseJsonlHead cannot recover a cwd, and the row
      // is skipped rather than pushed with a bogus cwd.
      writeSession('head', 'sess-head-dropped', [
        { type: 'user', cwd: '/repo/head-dropped', message: { role: 'user', content: 'y'.repeat(20000) } },
        { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'headdroppedneedle found here' }] } },
      ], 21000);
      const rows = await searchLocalClaudeSessions('headdroppedneedle');
      assert.ok(!rows.some((r) => r.id === 'sess-head-dropped'),
        'a cwd beyond the 8192-byte head is unparseable — the row must be dropped, not pushed cwd-less');
    });
  });

  describe('unconditional push (remote-twin consistency)', () => {
    it('pushes a match whose needle sits past the 1500-byte transfer cap, with an honestly-empty snippet', async () => {
      // The needle lives ~3000 chars into the matched line — beyond the 1500-char
      // row cap streamBoundedSearch applies — so snippetFromLine finds no
      // occurrence in the truncated text and returns ''. grep DID match the
      // file, so the session must surface (dropping it here is the false
      // negative the source comment explicitly forbids, and would diverge from
      // remoteSearchClaudeSessions, which pushes regardless of snippet).
      const DEEP_PAD = 'z'.repeat(3000);
      writeSession('push', 'sess-push', [
        { type: 'user', cwd: '/repo/push', message: { role: 'user', content: 'go' } },
        { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: `${DEEP_PAD}pushneedledeep` }] } },
      ], 22000);
      const row = (await searchLocalClaudeSessions('pushneedledeep')).find((r) => r.id === 'sess-push');
      assert.ok(row, 'grep matched the file — the session must surface even without a clean snippet');
      assert.equal(row.cwd, '/repo/push');
      assert.equal(row.snippet, '', 'a needle past the transfer cap yields an empty snippet, not a dropped row');
    });
  });
});
