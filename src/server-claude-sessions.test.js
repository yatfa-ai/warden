import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { mergeAndPaginateSessions } from './server.js';

/**
 * Tests for the cross-host "All Sessions" pagination (WARDEN-176).
 *
 * Older Claude sessions used to be silently dropped at five caps (local slice 40,
 * remote slice 40, per-host 20, global 40, and a client render slice). Pagination
 * (offset/limit + hasMore) eliminates all of them for the unified view. Coverage:
 *
 *   1. Unit tests of the real `mergeAndPaginateSessions` transformation — the
 *      cross-host merge + global sort + offset/limit + hasMore math, exercised
 *      with fake per-host buckets so NO SSH is needed. These assert the actual
 *      return value, so they FAIL if interleaving, slicing, or hasMore is wrong.
 *
 *   2. An HTTP integration test of the real Express app (src/server.js): it boots
 *      the actual /api/claude-sessions-all route on an ephemeral port against a
 *      throwaway HOME seeded with >40 fake .jsonl session files, then paginates
 *      to the end. This proves the LOCAL cap is no longer silently 40 (sessions
 *      older than the newest page are reachable via offset) end-to-end.
 *
 * SSH is unavailable in CI, so remote coverage comes from the unit tests over the
 * pure merge function (the endpoint delegates per-host slicing to
 * localClaudeSessions/remoteClaudeSessions and the global math to this helper).
 * Node 20 lacks mock.module, so rather than monkey-patch the internal fetchers we
 * test the pure algorithm directly and the local path end-to-end — the split
 * keeps coverage real without that dependency (same approach as server-hosts-status).
 */

// --- helpers for the unit tests -------------------------------------------------

// One session row as the per-host fetchers produce it (most-recent-first within a host).
// tokenUsage is optional (matches the additive contract — pre-WARDEN-367 rows omit it).
function row(id, mtime, cwd = '/x', tokenUsage = undefined) {
  return tokenUsage === undefined
    ? { id, cwd, summary: '', mtime }
    : { id, cwd, summary: '', mtime, tokenUsage };
}

// One host bucket: { host, sessions }.
function bucket(host, sessions) {
  return { host, sessions };
}

describe('mergeAndPaginateSessions — pure cross-host merge + pagination', () => {
  it('returns the globally-newest N on the first page, interleaving hosts by mtime', () => {
    // Host A is globally recent (100,80,60); host B sits between (90,70,50).
    const buckets = [
      bucket('a', [row('a1', 100), row('a2', 80), row('a3', 60)]),
      bucket('b', [row('b1', 90), row('b2', 70), row('b3', 50)]),
    ];
    const { sessions, hasMore } = mergeAndPaginateSessions(buckets, 0, 2);

    // Global order is 100,90,80,70,60,50 — page 1 is the newest two, alternating hosts.
    assert.deepStrictEqual(sessions.map((s) => s.id), ['a1', 'b1']);
    assert.strictEqual(hasMore, true, '6 total > offset+limit(2) → more remain');
    // The host tag is stamped onto every row by the merge.
    assert.deepStrictEqual(sessions.map((s) => s.host), ['a', 'b']);
  });

  it('offset returns the next page correctly (global [offset, offset+limit))', () => {
    const buckets = [
      bucket('a', [row('a1', 100), row('a2', 80), row('a3', 60)]),
      bucket('b', [row('b1', 90), row('b2', 70), row('b3', 50)]),
    ];
    const page2 = mergeAndPaginateSessions(buckets, 2, 2);

    // Global ranks 2,3 = mtimes 80,70 → a2 then b2.
    assert.deepStrictEqual(page2.sessions.map((s) => s.id), ['a2', 'b2']);
    assert.strictEqual(page2.hasMore, true, '6 total > 2+2 → more remain');
  });

  it('hasMore is false exactly at the end and the pages tile the whole set', () => {
    const buckets = [
      bucket('a', [row('a1', 100), row('a2', 80), row('a3', 60)]),
      bucket('b', [row('b1', 90), row('b2', 70), row('b3', 50)]),
    ];
    const seen = [];
    // Walk 2-per-page until hasMore is false — must converge and cover all 6.
    const pages = [];
    for (let offset = 0; ; offset += 2) {
      const page = mergeAndPaginateSessions(buckets, offset, 2);
      pages.push(page);
      seen.push(...page.sessions.map((s) => s.id));
      if (!page.hasMore) break;
    }
    // Three pages: [a1,b1], [a2,b2], [a3,b3]. The last has hasMore false.
    assert.strictEqual(pages.length, 3);
    assert.strictEqual(pages[pages.length - 1].hasMore, false, 'must stop at the end');
    // Paginated union is the full globally-sorted timeline, no gaps or dupes.
    assert.deepStrictEqual(seen, ['a1', 'b1', 'a2', 'b2', 'a3', 'b3']);
  });

  it('returns an empty page with hasMore false once exhausted (no off-by-one)', () => {
    const buckets = [bucket('a', [row('a1', 100), row('a2', 80)])];
    const page = mergeAndPaginateSessions(buckets, 2, 2);
    assert.strictEqual(page.sessions.length, 0, 'past the end → empty page');
    assert.strictEqual(page.hasMore, false, '2 total is not > 2+2');
  });

  it('hasMore flips at exactly total = offset+limit (boundary is total > offset+limit)', () => {
    // total == offset+limit: the page is full but there is no next item.
    let r = mergeAndPaginateSessions([bucket('a', [row('a1', 3), row('a2', 2), row('a3', 1)])], 0, 3);
    assert.strictEqual(r.sessions.length, 3);
    assert.strictEqual(r.hasMore, false, '3 total is not > 0+3');

    // total == offset+limit+1: one more exists beyond the page.
    r = mergeAndPaginateSessions([bucket('a', [row('a1', 4), row('a2', 3), row('a3', 2), row('a4', 1)])], 0, 3);
    assert.strictEqual(r.sessions.length, 3);
    assert.strictEqual(r.hasMore, true, '4 total > 0+3 → one more exists');
  });

  it('host-dominance: when one host owns the timeline, hasMore stays honest', () => {
    // Host a holds the 5 newest sessions; host b is older. This is the case where a
    // missing +1 in the per-host window would hide the boundary item and make
    // hasMore wrongly false. The helper sees all rows the caller supplied, so with
    // the full top-(offset+limit+1) per host the verdict is correct.
    const buckets = [
      bucket('a', [row('a1', 100), row('a2', 99), row('a3', 98), row('a4', 97), row('a5', 96)]),
      bucket('b', [row('b1', 50)]),
    ];
    const page = mergeAndPaginateSessions(buckets, 0, 4);
    assert.deepStrictEqual(page.sessions.map((s) => s.id), ['a1', 'a2', 'a3', 'a4']);
    assert.strictEqual(page.hasMore, true, 'a5 (rank 4) exists → more remain');
  });

  it('handles empty buckets gracefully (no hosts responded)', () => {
    const { sessions, hasMore } = mergeAndPaginateSessions([], 0, 40);
    assert.deepStrictEqual(sessions, []);
    assert.strictEqual(hasMore, false);
  });

  // ---- token-usage totals (WARDEN-367) ---------------------------------------

  it('totals: per-host subtotals roll up to the grand total over the returned page', () => {
    const buckets = [
      bucket('a', [
        row('a1', 100, '/x', { input: 10, output: 1, cacheCreation: 0, cacheRead: 2, total: 13 }),
        row('a2', 80, '/x', { input: 5, output: 0, cacheCreation: 0, cacheRead: 0, total: 5 }),
      ]),
      bucket('b', [
        row('b1', 90, '/x', { input: 100, output: 4, cacheCreation: 1, cacheRead: 8, total: 113 }),
        row('b2', 70, '/x', null), // no usage → contributes nothing
      ]),
    ];
    const { sessions, totals } = mergeAndPaginateSessions(buckets, 0, 4);
    // Grand total over the page = 13 + 5 + 113 (b2's null skipped).
    assert.strictEqual(totals.grand.total, 131);
    assert.strictEqual(totals.byHost.a.total, 18, 'host a = 13 + 5');
    assert.strictEqual(totals.byHost.b.total, 113, 'host b = 113 (b2 null skipped)');
    // Per-host subtotals MUST sum to the grand total over the page.
    const hostSum = Object.values(totals.byHost).reduce((acc, h) => acc + h.total, 0);
    assert.strictEqual(hostSum, totals.grand.total, 'per-host subtotals roll up to grand');
    // tokenUsage survives the cross-host merge onto each returned row.
    assert.strictEqual(sessions.find((s) => s.id === 'a1').tokenUsage.total, 13);
    assert.strictEqual(sessions.find((s) => s.id === 'b2').tokenUsage, null);
  });

  it('totals covers only the returned window, not every fetched row', () => {
    // 3 sessions but page size 1 → totals reflects only the single returned row.
    const buckets = [bucket('a', [
      row('a1', 100, '/x', { input: 10, output: 0, cacheCreation: 0, cacheRead: 0, total: 10 }),
      row('a2', 80, '/x', { input: 50, output: 0, cacheCreation: 0, cacheRead: 0, total: 50 }),
      row('a3', 60, '/x', { input: 90, output: 0, cacheCreation: 0, cacheRead: 0, total: 90 }),
    ])];
    const { totals } = mergeAndPaginateSessions(buckets, 0, 1);
    assert.strictEqual(totals.grand.total, 10, 'only the newest (returned) session counts');
  });

  it('totals is additive: present on the return but ignored by pre-WARDEN-367 callers', () => {
    // A caller that destructures only { sessions, hasMore } is unaffected by the
    // new totals field — proves the shape change is purely additive.
    const { sessions, hasMore } = mergeAndPaginateSessions(
      [bucket('a', [row('a1', 1, '/x', { input: 1, output: 0, cacheCreation: 0, cacheRead: 0, total: 1 })])], 0, 40,
    );
    assert.strictEqual(sessions.length, 1);
    assert.strictEqual(hasMore, false);
  });
});

// --- HTTP integration test against the real Express app ------------------------

// Seed `count` fake .jsonl sessions under <tempHome>/.claude/projects/testproj/,
// with s00 the oldest and s<count-1> the newest. Each file carries a `cwd` so the
// real localClaudeSessions() keeps it (it filters out cwd-less sessions).
function seedLocalSessions(tempHome, count) {
  const projDir = path.join(tempHome, '.claude', 'projects', 'testproj');
  fs.mkdirSync(projDir, { recursive: true });
  const base = 1_700_000_000; // fixed epoch (seconds) → deterministic mtimes
  for (let i = 0; i < count; i++) {
    const id = `s${String(i).padStart(2, '0')}`;
    const file = path.join(projDir, `${id}.jsonl`);
    // A cwd-bearing first record is all parseJsonlHead needs.
    fs.writeFileSync(file, JSON.stringify({ cwd: `/${id}` }) + '\n');
    // mtime increases with i, so s00 is oldest, sNN is newest.
    fs.utimesSync(file, base + i, base + i);
  }
}

describe('/api/claude-sessions-all HTTP endpoint (real Express app from server.js)', () => {
  let httpServer;
  let baseUrl;
  let originalHome;
  let tempHome;
  const TOTAL = 45; // > 40 so the old silent global cap would have dropped 5

  before(async () => {
    originalHome = process.env.HOME;
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-claude-sessions-'));
    process.env.HOME = tempHome;
    // No remote hosts → the endpoint only reads the (local) archive we seed.
    const wardenDir = path.join(tempHome, '.yatfa-warden');
    fs.mkdirSync(wardenDir, { recursive: true });
    fs.writeFileSync(path.join(wardenDir, 'config.json'), JSON.stringify({ hosts: [] }));
    seedLocalSessions(tempHome, TOTAL);

    const { app } = await import('./server.js');
    httpServer = app.listen(0, '127.0.0.1');
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

  it('responds 200 + { sessions: [...], hasMore, totals } (additive WARDEN-367 contract)', async () => {
    const res = await fetch(`${baseUrl}/api/claude-sessions-all`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get('content-type'), 'application/json; charset=utf-8');
    const body = await res.json();
    assert.ok(Array.isArray(body.sessions), 'body must be { sessions: [...] }');
    assert.strictEqual(typeof body.hasMore, 'boolean', 'hasMore must be a boolean');
    // totals is additive (WARDEN-367): always an object, zero grand when no usage.
    assert.ok(body.totals && typeof body.totals === 'object', 'totals must be present');
    assert.strictEqual(body.totals.grand.total, 0, 'seeded sessions have no usage → 0');
    assert.ok(body.totals.byHost && typeof body.totals.byHost === 'object');
  });

  it('default page returns the newest 40 and flags more (page 1 == old global cap, now not a hard ceiling)', async () => {
    const body = await (await fetch(`${baseUrl}/api/claude-sessions-all`)).json();
    assert.strictEqual(body.sessions.length, 40, 'default page size is 40');
    assert.strictEqual(body.hasMore, true, `${TOTAL} exist → more than the first page`);
    const cwds = body.sessions.map((s) => s.cwd);
    // Newest 40 = s05..s44. The newest is present; the oldest is NOT on page 1.
    assert.ok(cwds.includes('/s44'), 'newest session must be on page 1');
    assert.ok(!cwds.includes('/s00'), 'oldest session must not be on page 1');
    // Newest-first ordering is preserved across the wire.
    const mtimes = body.sessions.map((s) => s.mtime);
    assert.deepStrictEqual([...mtimes].sort((a, b) => b - a), mtimes, 'page must be newest-first');
  });

  it('offset reaches the older tail — the local cap is no longer silently 40', async () => {
    // Page 2 = the 5 oldest sessions (s00..s04), which the old 40-cap made invisible.
    const body = await (await fetch(`${baseUrl}/api/claude-sessions-all?offset=40&limit=40`)).json();
    assert.strictEqual(body.sessions.length, 5, 'the 5 sessions past the old cap must now be reachable');
    assert.strictEqual(body.hasMore, false, 'no more beyond the tail');
    const cwds = body.sessions.map((s) => s.cwd).sort();
    assert.deepStrictEqual(cwds, ['/s00', '/s01', '/s02', '/s03', '/s04'], 'page 2 is the oldest tail');
  });

  it('paginating page-by-page converges (hasMore false) and covers every session exactly once', async () => {
    const seen = [];
    let more = true;
    for (let offset = 0; more; offset += 40) {
      const body = await (await fetch(`${baseUrl}/api/claude-sessions-all?offset=${offset}&limit=40`)).json();
      seen.push(...body.sessions.map((s) => s.cwd));
      more = body.hasMore;
    }
    assert.strictEqual(seen.length, TOTAL, 'pagination must surface all sessions');
    // No dupes: every one of the 45 cwds appears exactly once.
    assert.strictEqual(new Set(seen).size, TOTAL, 'no session must appear twice across pages');
  });

  it('honours an explicit limit smaller than the default', async () => {
    const body = await (await fetch(`${baseUrl}/api/claude-sessions-all?offset=0&limit=10`)).json();
    assert.strictEqual(body.sessions.length, 10, 'limit=10 → 10 sessions');
    assert.strictEqual(body.hasMore, true, `${TOTAL} exist → more than 10`);
    assert.strictEqual(body.sessions[0].cwd, '/s44', 'still newest-first');
  });

  it('a bogus offset/limit falls back to sane defaults (no crash, no negatives)', async () => {
    const body = await (await fetch(`${baseUrl}/api/claude-sessions-all?offset=foo&limit=bar`)).json();
    assert.strictEqual(body.sessions.length, 40, 'non-numeric → default offset 0 + limit 40');
    assert.strictEqual(body.hasMore, true);
    const neg = await (await fetch(`${baseUrl}/api/claude-sessions-all?offset=-5&limit=-3`)).json();
    assert.ok(neg.sessions.length >= 1 && neg.sessions.length <= 40, 'clamped to >=1 page size, offset >=0');
  });
});

// --- token-usage end-to-end on the LOCAL path (WARDEN-367) ---------------------
//
// Seeds real assistant `message.usage` records into the temp archive and asserts
// the LOCAL full-file read surfaces correct per-session tokenUsage on BOTH
// endpoints + a non-zero fleet total — proving the data already on disk is wired
// through, and that a no-usage session degrades to tokenUsage null (no 500).
// SSH is unavailable in CI so the remote path is covered by the unit tests over
// the pure helper + the validated grep+awk pipeline (see server-session-tokens).

function seedUsageSession(tempHome, id, turns, mtimeSec) {
  const projDir = path.join(tempHome, '.claude', 'projects', 'tokproj');
  fs.mkdirSync(projDir, { recursive: true });
  const lines = [{ cwd: `/repo/${id}` }, ...turns];
  const file = path.join(projDir, `${id}.jsonl`);
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  fs.utimesSync(file, mtimeSec, mtimeSec);
}

describe('/api/claude-sessions(+all) token usage — LOCAL full-file read (WARDEN-367)', () => {
  let httpServer;
  let baseUrl;
  let originalHome;
  let tempHome;

  before(async () => {
    originalHome = process.env.HOME;
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-session-tokens-'));
    process.env.HOME = tempHome;
    const wardenDir = path.join(tempHome, '.yatfa-warden');
    fs.mkdirSync(wardenDir, { recursive: true });
    fs.writeFileSync(path.join(wardenDir, 'config.json'), JSON.stringify({ hosts: [] }));

    const usage = (i, o, cc, cr) => ({ type: 'assistant', message: { role: 'assistant', usage: { input_tokens: i, output_tokens: o, cache_creation_input_tokens: cc, cache_read_input_tokens: cr } } });
    // sess-a: 110/5/2/3 = 120 total (two turns). newest.
    seedUsageSession(tempHome, 'sess-a', [usage(10, 5, 2, 3), usage(100, 0, 0, 0)], 3000);
    // sess-b: cache-heavy, 195529/63632/0/5320192 = 5579353 total.
    seedUsageSession(tempHome, 'sess-b', [usage(195529, 63632, 0, 5320192)], 2000);
    // sess-c: NO usage (a user-only conversation) → tokenUsage null, never a 500.
    seedUsageSession(tempHome, 'sess-c', [{ type: 'user', message: { role: 'user', content: 'just talking' } }], 1000);

    const { app } = await import('./server.js');
    httpServer = app.listen(0, '127.0.0.1');
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

  it('/api/claude-sessions attaches tokenUsage per session (null for no-usage)', async () => {
    const body = await (await fetch(`${baseUrl}/api/claude-sessions?host=(local)`)).json();
    const byId = Object.fromEntries(body.sessions.map((s) => [s.id, s]));
    assert.deepStrictEqual(byId['sess-a'].tokenUsage, { input: 110, output: 5, cacheCreation: 2, cacheRead: 3, total: 120 });
    assert.strictEqual(byId['sess-b'].tokenUsage.total, 5579353, 'cache-heavy total matches the raw usage sum');
    assert.strictEqual(byId['sess-c'].tokenUsage, null, 'no-usage session → null (no badge, no error)');
  });

  it('/api/claude-sessions-all returns a non-zero fleet total over the window + per-host split', async () => {
    const body = await (await fetch(`${baseUrl}/api/claude-sessions-all?offset=0&limit=40`)).json();
    // Grand = 120 + 5579353 (sess-c null skipped).
    assert.strictEqual(body.totals.grand.total, 5579473);
    assert.ok(body.totals.byHost['(local)'], 'the local host bucket carries its subtotal');
    assert.strictEqual(body.totals.byHost['(local)'].total, 5579473);
    // Per-host subtotals roll up to grand.
    const hostSum = Object.values(body.totals.byHost).reduce((acc, h) => acc + h.total, 0);
    assert.strictEqual(hostSum, body.totals.grand.total);
    // The cache-heavy session surfaces first under usage-sort is a frontend concern;
    // here we just confirm both usage-bearing sessions are in the returned page.
    const ids = body.sessions.map((s) => s.id);
    assert.ok(ids.includes('sess-a') && ids.includes('sess-b') && ids.includes('sess-c'));
  });

  it('a no-usage session never causes a 500 (graceful-empty contract)', async () => {
    const res = await fetch(`${baseUrl}/api/claude-sessions-all`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    const c = body.sessions.find((s) => s.id === 'sess-c');
    assert.ok(c, 'no-usage session is still listed');
    assert.strictEqual(c.tokenUsage, null);
  });
});
