import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * Collections mutation serialization — lost updates under concurrency (WARDEN-1675).
 *
 * collections.json is a WHOLE-FILE document: create/update/delete each do
 * load → mutate → saveCollections, so overlapping requests read the same snapshot
 * and last write wins (unfixed: 5 concurrent creates persisted 1; 2 concurrent
 * renames kept 1; 2 concurrent deletes removed 1; the duplicate-name guard raced).
 * These tests drive only the public API so they run unchanged against the
 * pre-fix module (negative control).
 *
 * HOME is redirected BEFORE the dynamic import because the path is computed from
 * os.homedir() at module load.
 */

describe('collections mutation serialization under concurrency — WARDEN-1675', () => {
  let mod, originalHome, tmpHome, collectionsPath;

  const read = () => { try { return JSON.parse(fs.readFileSync(collectionsPath, 'utf8')); } catch { return []; } };

  before(async () => {
    originalHome = process.env.HOME;
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-collections-conc-'));
    process.env.HOME = tmpHome;
    fs.mkdirSync(path.join(tmpHome, '.yatfa-warden'), { recursive: true });
    collectionsPath = path.join(tmpHome, '.yatfa-warden', 'collections.json');
    mod = await import('./collections.js');
  });

  after(() => {
    if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  beforeEach(() => { fs.rmSync(collectionsPath, { force: true }); });

  it('N concurrent creates persist N entries', async () => {
    const N = 8;
    const created = await Promise.all(
      Array.from({ length: N }, (_, i) => mod.createCollection(`c${i}`)),
    );
    assert.strictEqual(new Set(created.map((c) => c.id)).size, N);
    const names = read().map((c) => c.name).sort();
    assert.deepStrictEqual(names, Array.from({ length: N }, (_, i) => `c${i}`).sort());
  });

  it('concurrent renames of two different ids are both applied', async () => {
    const a = await mod.createCollection('a');
    const b = await mod.createCollection('b');
    const [ua, ub] = await Promise.all([
      mod.updateCollection(a.id, { name: 'a2' }),
      mod.updateCollection(b.id, { name: 'b2' }),
    ]);
    assert.strictEqual(ua.name, 'a2');
    assert.strictEqual(ub.name, 'b2');
    assert.deepStrictEqual(read().map((c) => c.name).sort(), ['a2', 'b2']);
  });

  it('concurrent deletes of two ids remove both and both return true', async () => {
    const a = await mod.createCollection('a');
    const b = await mod.createCollection('b');
    const keep = await mod.createCollection('keep');
    const results = await Promise.all([mod.deleteCollection(a.id), mod.deleteCollection(b.id)]);
    assert.deepStrictEqual(results, [true, true]);
    assert.deepStrictEqual(read().map((c) => c.id), [keep.id]);
  });

  it('concurrent deletes of the same id: exactly one returns true', async () => {
    const a = await mod.createCollection('a');
    const results = await Promise.all([mod.deleteCollection(a.id), mod.deleteCollection(a.id)]);
    assert.deepStrictEqual(results.slice().sort(), [false, true]);
    assert.deepStrictEqual(read(), []);
  });

  it('concurrent create of the same name: exactly one succeeds, the rest reject "already exists"', async () => {
    const settled = await Promise.allSettled(
      Array.from({ length: 5 }, () => mod.createCollection('dup')),
    );
    const ok = settled.filter((r) => r.status === 'fulfilled');
    const bad = settled.filter((r) => r.status === 'rejected');
    assert.strictEqual(ok.length, 1);
    assert.strictEqual(bad.length, 4);
    for (const r of bad) assert.match(r.reason.message, /Collection "dup" already exists/);
    assert.strictEqual(read().length, 1);
  });

  it('a rejecting mutation does not poison later calls', async () => {
    await mod.createCollection('x');
    const [dup, ok, missing, ok2] = await Promise.allSettled([
      mod.createCollection('x'),
      mod.createCollection('y'),
      mod.updateCollection('nope', { name: 'z' }),
      mod.createCollection('w'),
    ]);
    assert.strictEqual(dup.status, 'rejected');
    assert.match(dup.reason.message, /already exists/);
    assert.strictEqual(ok.status, 'fulfilled');
    assert.strictEqual(missing.status, 'rejected');
    assert.strictEqual(missing.reason.message, 'Collection not found');
    assert.strictEqual(ok2.status, 'fulfilled');
    assert.deepStrictEqual(read().map((c) => c.name).sort(), ['w', 'x', 'y']);
  });
});
