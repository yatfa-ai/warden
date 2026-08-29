import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * Catalog mutation serialization — lost updates under concurrency (WARDEN-991).
 *
 * chats.json is a WHOLE-FILE document: saveCatalog → atomicWriteJson gives each
 * write torn-free semantics but NO isolation. Five code paths do load→modify→save
 * (/api/rename, /api/spawn, /api/resume, /api/kill, stampCatalogActivity), and any
 * two overlapping in the async gap clobber one another last-write-wins.
 *
 * Measured on the unfixed module, replaying each site's expression verbatim:
 *   5 concurrent kills          -> 4 ghost entries survived  (expected 0)
 *   3 concurrent spawns         -> 1 entry persisted         (expected 3)
 *   60 poller-vs-kill trials    -> 0 clean outcomes (35 resurrected the killed chat)
 *
 * These tests pin the three reproduced failure modes to their fixed outcomes. Each
 * `unfixed shape` test below replays the OLD raw load/save expression to prove the
 * scenario genuinely DETECTS the bug — a serialization test that passes against
 * buggy code would be worthless (green is not proof).
 *
 * NOTE: we do NOT top-level import ./config.js. `catalogPath` is computed from
 * os.homedir() at module load, so HOME must point at a throwaway dir BEFORE the
 * first import — we dynamic-import inside before(). (node --test runs each file in
 * its own process, so this file's HOME shenanigans don't leak.)
 */

describe('catalog mutation serialization under concurrency — WARDEN-991', () => {
  let mutateCatalog, loadCatalog, saveCatalog, stampCatalogActivity, sameCatalogEntry;
  let originalHome, tempHome, catPath;

  const entry = (session, extra = {}) => ({ kind: 'tmux', host: '(local)', session, name: session, ...extra });
  const seed = (entries) => fs.writeFileSync(catPath, JSON.stringify(entries, null, 2) + '\n');
  const readCatalog = () => { try { return JSON.parse(fs.readFileSync(catPath, 'utf8')); } catch { return []; } };
  const sessions = (list) => list.map((c) => c.session).sort();

  before(async () => {
    originalHome = process.env.HOME;
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-catconc-'));
    process.env.HOME = tempHome;
    fs.mkdirSync(path.join(tempHome, '.yatfa-warden'), { recursive: true });
    catPath = path.join(tempHome, '.yatfa-warden', 'chats.json');
    ({ mutateCatalog, loadCatalog, saveCatalog, stampCatalogActivity, sameCatalogEntry } = await import('./config.js'));
  });

  after(() => {
    if (originalHome !== undefined) process.env.HOME = originalHome;
    try { fs.rmSync(tempHome, { recursive: true, force: true }); } catch { /* noop */ }
  });

  beforeEach(() => seed([]));

  // ---- (1) concurrent kill — the fleet batch-kill / ghost-entry case ----------

  describe('concurrent kill (fleet batch-kill)', () => {
    const KILLS = 5;

    it('removes ALL 5 entries when 5 kill-shaped mutations run concurrently', async () => {
      seed(Array.from({ length: KILLS }, (_, i) => entry(`s${i}`)));
      // Exactly the /api/kill expression, routed through the queue.
      await Promise.all(Array.from({ length: KILLS }, (_, i) =>
        mutateCatalog((c) => c.filter((x) => !sameCatalogEntry(x, '(local)', `s${i}`)))));
      assert.deepStrictEqual(readCatalog(), [], 'every killed chat must be gone — surviving entries are sidebar ghosts');
    });

    it('unfixed shape (raw load→filter→save) LOSES updates — proves the test detects the bug', async () => {
      seed(Array.from({ length: KILLS }, (_, i) => entry(`s${i}`)));
      // Verbatim replay of the pre-fix src/server.js:1641 expression.
      await Promise.all(Array.from({ length: KILLS }, async (_, i) =>
        saveCatalog((await loadCatalog()).filter((x) => !sameCatalogEntry(x, '(local)', `s${i}`)))));
      assert.ok(readCatalog().length > 0, 'the unfixed read-modify-write must leave ghosts, else this scenario proves nothing');
    });
  });

  // ---- (2) concurrent spawn — the orphaned-session case -----------------------

  describe('concurrent spawn (append)', () => {
    it('persists ALL 3 entries when 3 append-shaped mutations run concurrently', async () => {
      const names = ['a', 'b', 'c'];
      // Exactly the /api/spawn append: fresh read inside, re-check the collision.
      await Promise.all(names.map((s) =>
        mutateCatalog((c) => (c.some((x) => sameCatalogEntry(x, '(local)', s)) ? undefined : [...c, entry(s)]))));
      assert.deepStrictEqual(sessions(readCatalog()), names,
        'a dropped append orphans a LIVE tmux session from the catalog — invisible in the UI and not killable through it');
    });

    it('append survives a spawn-shaped await between the pre-check and the write', async () => {
      // The real window is a full buildAndSpawn (tmux/ssh round-trip). The load must
      // happen INSIDE the callback — passing a pre-read snapshot in preserves the bug.
      const names = ['x', 'y', 'z'];
      await Promise.all(names.map(async (s) => {
        await loadCatalog();                                  // pre-flight duplicate check
        await new Promise((r) => setTimeout(r, 20));          // stand-in for buildAndSpawn
        return mutateCatalog((c) => [...c, entry(s)]);        // fresh read inside
      }));
      assert.deepStrictEqual(sessions(readCatalog()), names);
    });

    it('re-checks the collision inside the mutation (concurrent same-host duplicate)', async () => {
      const both = await Promise.all([
        mutateCatalog((c) => (c.some((x) => sameCatalogEntry(x, '(local)', 'dup')) ? undefined : [...c, entry('dup')])),
        mutateCatalog((c) => (c.some((x) => sameCatalogEntry(x, '(local)', 'dup')) ? undefined : [...c, entry('dup')])),
      ]);
      assert.strictEqual(readCatalog().length, 1, 'host+session identity must stay unique');
      assert.strictEqual(both.filter(Boolean).length, 1, 'exactly one append wins; the loser returns falsy so the handler 409s');
    });

    it('unfixed shape (snapshot reused across the spawn await) LOSES updates', async () => {
      // Verbatim replay of the pre-fix src/server.js:1582→1588 pair.
      await Promise.all(['a', 'b', 'c'].map(async (s) => {
        const catalog = await loadCatalog();
        await new Promise((r) => setTimeout(r, 20));
        await saveCatalog([...catalog, entry(s)]);
      }));
      assert.ok(readCatalog().length < 3, 'the unfixed snapshot-reuse must drop appends, else this scenario proves nothing');
    });
  });

  // ---- (3) background poller vs kill — the resurrection case ------------------

  describe('discovery activity-stamp racing a kill', () => {
    it('applies the stamp AND keeps the kill — both, not either', async () => {
      seed([entry('keepme'), entry('killme')]);
      const ts = 1_700_000_000_000;
      await Promise.all([
        stampCatalogActivity('(local)', 'keepme', ts),
        mutateCatalog((c) => c.filter((x) => !sameCatalogEntry(x, '(local)', 'killme'))),
      ]);
      const after = readCatalog();
      assert.deepStrictEqual(sessions(after), ['keepme'], 'the killed chat must NOT be resurrected by the background stamp');
      assert.strictEqual(after[0].lastActivity, ts, 'the stamp must survive the concurrent kill');
    });

    it('holds with the kill issued first (both interleavings)', async () => {
      seed([entry('keepme'), entry('killme')]);
      const ts = 1_700_000_000_001;
      await Promise.all([
        mutateCatalog((c) => c.filter((x) => !sameCatalogEntry(x, '(local)', 'killme'))),
        stampCatalogActivity('(local)', 'keepme', ts),
      ]);
      const after = readCatalog();
      assert.deepStrictEqual(sessions(after), ['keepme']);
      assert.strictEqual(after[0].lastActivity, ts);
    });

    it('unfixed shape (raw stamp vs raw kill) loses one of the two writes', async () => {
      seed([entry('keepme'), entry('killme')]);
      const ts = 1_700_000_000_002;
      // Verbatim replay of the pre-fix stampCatalogActivity body vs the pre-fix kill.
      await Promise.all([
        (async () => {
          const catalog = await loadCatalog();
          const e = catalog.find((c) => sameCatalogEntry(c, '(local)', 'keepme'));
          await new Promise((r) => setTimeout(r, 5));
          if (e && (!e.lastActivity || e.lastActivity < ts)) { e.lastActivity = ts; await saveCatalog(catalog); }
        })(),
        (async () => {
          const c = await loadCatalog();
          await new Promise((r) => setTimeout(r, 5));
          await saveCatalog(c.filter((x) => !sameCatalogEntry(x, '(local)', 'killme')));
        })(),
      ]);
      const after = readCatalog();
      const killLost = after.some((c) => c.session === 'killme');
      const stampLost = !after.find((c) => c.session === 'keepme')?.lastActivity;
      assert.ok(killLost || stampLost, 'unfixed, one of the two writes must be lost, else this scenario proves nothing');
    });
  });

  // ---- queue semantics --------------------------------------------------------

  describe('queue semantics', () => {
    it('a falsy return skips the write (the 404 / already-fresh branches)', async () => {
      seed([entry('only')]);
      const before = fs.readFileSync(catPath, 'utf8');
      const r = await mutateCatalog(() => undefined);
      assert.strictEqual(r, undefined);
      assert.strictEqual(fs.readFileSync(catPath, 'utf8'), before, 'a skipped mutation must not rewrite the file');
    });

    it('an EMPTY catalog is still written (kill-the-last-chat must not be skipped)', async () => {
      seed([entry('last')]);
      await mutateCatalog((c) => c.filter((x) => !sameCatalogEntry(x, '(local)', 'last')));
      assert.deepStrictEqual(readCatalog(), [], '[] is truthy — the last removal must persist');
    });

    it('a rejecting mutation does not poison the queue', async () => {
      seed([]);
      const boom = mutateCatalog(() => { throw new Error('boom'); });
      await assert.rejects(boom, /boom/, 'the failure must still surface to ITS caller');
      // Everything queued behind the failure must still run, in order.
      await Promise.all(['p', 'q'].map((s) => mutateCatalog((c) => [...c, entry(s)])));
      assert.deepStrictEqual(sessions(readCatalog()), ['p', 'q']);
    });

    it('mutations observe the previous mutation\'s result (read is inside the section)', async () => {
      seed([]);
      const seen = [];
      await Promise.all(Array.from({ length: 4 }, (_, i) =>
        mutateCatalog((c) => { seen.push(c.length); return [...c, entry(`n${i}`)]; })));
      assert.deepStrictEqual(seen, [0, 1, 2, 3], 'each mutation must read the prior one\'s write, not a stale snapshot');
    });
  });

  // ---- stampCatalogActivity contract (unchanged by the reroute) ---------------

  describe('stampCatalogActivity contract preserved', () => {
    it('returns false and writes nothing for an unknown entry', async () => {
      seed([entry('known')]);
      const before = fs.readFileSync(catPath, 'utf8');
      assert.strictEqual(await stampCatalogActivity('(local)', 'ghost', 123), false);
      assert.strictEqual(fs.readFileSync(catPath, 'utf8'), before);
    });

    it('returns false for a non-fresher stamp (no disk thrash on the 60s re-discover)', async () => {
      seed([entry('s', { lastActivity: 500 })]);
      assert.strictEqual(await stampCatalogActivity('(local)', 's', 400), false, 'older stamp must be ignored');
      assert.strictEqual(await stampCatalogActivity('(local)', 's', 500), false, 'equal stamp must not rewrite');
      assert.strictEqual(readCatalog()[0].lastActivity, 500);
    });

    it('returns true and persists a fresher stamp', async () => {
      seed([entry('s', { lastActivity: 500 })]);
      assert.strictEqual(await stampCatalogActivity('(local)', 's', 900), true);
      assert.strictEqual(readCatalog()[0].lastActivity, 900);
    });

    it('rejects a non-finite / missing timestamp without touching disk', async () => {
      seed([entry('s')]);
      const before = fs.readFileSync(catPath, 'utf8');
      for (const bad of [null, undefined, NaN, Infinity, 'x']) {
        assert.strictEqual(await stampCatalogActivity('(local)', 's', bad), false);
      }
      assert.strictEqual(fs.readFileSync(catPath, 'utf8'), before);
    });
  });
});
