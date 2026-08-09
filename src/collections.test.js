import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// collections.js now persists through the async atomic-write + defensive-read
// helper (WARDEN-831), so we exercise it against REAL I/O under a redirected
// HOME (the same pattern src/server-config.test.js uses) rather than mocking fs.
// The module resolves ~/.yatfa-warden from os.homedir() at import time, so HOME
// is redirected BEFORE the dynamic import() below.

let mod; // dynamically-imported collections.js (after HOME redirect)
let tmpHome;
let wardenDir;
let collectionsPath;
let originalHome;

before(async () => {
  originalHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-collections-'));
  process.env.HOME = tmpHome;
  wardenDir = path.join(tmpHome, '.yatfa-warden');
  fs.mkdirSync(wardenDir, { recursive: true });
  collectionsPath = path.join(wardenDir, 'collections.json');
  mod = await import('./collections.js');
});

after(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

beforeEach(() => {
  // Each test starts from a clean (absent) collections file.
  fs.rmSync(collectionsPath, { force: true });
});

function seed(list) {
  fs.writeFileSync(collectionsPath, JSON.stringify(list, null, 2) + '\n');
}

// ----------------------------- loadCollections -------------------------------
describe('loadCollections — defensive parse contract', () => {
  it('returns [] when the file is missing (first run / ENOENT)', async () => {
    assert.deepStrictEqual(await mod.loadCollections(), []);
  });

  it('returns [] when the file contains corrupt JSON, and backs it up (WARDEN-831)', async () => {
    fs.writeFileSync(collectionsPath, 'not valid json {{{');
    assert.deepStrictEqual(await mod.loadCollections(), []);
    // The corrupt text was surfaced to a .corrupt-<ts>.json backup, not lost.
    const backups = fs.readdirSync(wardenDir).filter((n) => n.startsWith('collections.corrupt-'));
    assert.strictEqual(backups.length, 1);
    assert.strictEqual(fs.readFileSync(path.join(wardenDir, backups[0]), 'utf8'), 'not valid json {{{');
  });

  it('returns [] when the parsed value is not an array', async () => {
    // A corrupted/garbled write could leave an object or primitive at the top level.
    // That must never crash the app or be treated as a list.
    seed({ not: 'an array' });
    assert.deepStrictEqual(await mod.loadCollections(), []);
  });

  it('returns the parsed array when the file is valid', async () => {
    const stored = [{ id: 'coll-1', name: 'codex', criteria: { role: 'worker' } }];
    seed(stored);
    assert.deepStrictEqual(await mod.loadCollections(), stored);
  });
});

// ----------------------------- saveCollections -------------------------------
describe('saveCollections — persistence shape', () => {
  it('writes pretty JSON terminated by a newline to collectionsPath', async () => {
    const data = [{ id: 'coll-1', name: 'codex' }];
    await mod.saveCollections(data);
    assert.strictEqual(
      fs.readFileSync(collectionsPath, 'utf8'),
      JSON.stringify(data, null, 2) + '\n',
    );
  });

  it('is durable: a re-read round-trips the saved value', async () => {
    const data = [{ id: 'coll-1', name: 'codex' }, { id: 'coll-2', name: 'alpha' }];
    await mod.saveCollections(data);
    assert.deepStrictEqual(await mod.loadCollections(), data);
  });
});

// ----------------------------- createCollection ------------------------------
describe('createCollection — name validation + persistence', () => {
  it('throws "Collection name is required" when the name is empty / whitespace / null', async () => {
    await assert.rejects(() => mod.createCollection(''), /Collection name is required/);
    await assert.rejects(() => mod.createCollection('   '), /Collection name is required/);
    await assert.rejects(() => mod.createCollection(null), /Collection name is required/);
    await assert.rejects(() => mod.createCollection(undefined), /Collection name is required/);
  });

  it('throws when a collection with the same name already exists', async () => {
    seed([{ id: 'coll-1', name: 'codex' }]);
    await assert.rejects(() => mod.createCollection('codex'), /Collection "codex" already exists/);
  });

  it('trims surrounding whitespace and truncates the name to 60 characters', async () => {
    const trimmed = await mod.createCollection('   codex   ');
    assert.strictEqual(trimmed.name, 'codex', 'surrounding whitespace is trimmed');

    const longName = 'x'.repeat(80);
    const truncated = await mod.createCollection(longName);
    assert.strictEqual(truncated.name.length, 60, 'name is sliced to max 60 chars');
    assert.strictEqual(truncated.name, longName.slice(0, 60));
  });

  it('populates id/createdAt/updatedAt and persists the new collection', async () => {
    const created = await mod.createCollection('codex', { role: 'worker' }, { color: 'blue' });

    assert.ok(typeof created.id === 'string' && created.id.startsWith('coll-'), 'id is a coll-<…> string');
    assert.strictEqual(created.name, 'codex');
    assert.deepStrictEqual(created.criteria, { role: 'worker' });
    assert.deepStrictEqual(created.metadata, { color: 'blue' });
    assert.strictEqual(typeof created.createdAt, 'number');
    assert.strictEqual(created.createdAt, created.updatedAt);

    // the new collection was appended and written
    const persisted = await mod.loadCollections();
    assert.strictEqual(persisted.length, 1);
    assert.strictEqual(persisted[0].id, created.id);
    assert.strictEqual(persisted[0].name, 'codex');
  });
});

// ----------------------------- updateCollection ------------------------------
describe('updateCollection — identity preservation + uniqueness', () => {
  it('throws "Collection not found" when the id does not exist', async () => {
    seed([{ id: 'coll-1', name: 'alpha' }]);
    await assert.rejects(() => mod.updateCollection('coll-missing', { name: 'beta' }), /Collection not found/);
  });

  it('persists a new casing on rename (codex → Codex)', async () => {
    // A rename that only changes the casing of the row's own name must persist the new
    // casing. NOTE: this does NOT exercise the `c.id !== id` self-exclusion guard —
    // case-sensitive compare means 'codex' !== 'Codex' regardless of that guard.
    seed([{ id: 'coll-1', name: 'codex', createdAt: 1000, updatedAt: 1000 }]);
    const updated = await mod.updateCollection('coll-1', { name: 'Codex' });
    assert.strictEqual(updated.name, 'Codex');
  });

  it('excludes the row itself from the uniqueness check on a self-rename that trims to the same name', async () => {
    // 'alpha' -> '  alpha  ' trims back to 'alpha'. With the `c.id !== id` term this
    // succeeds; WITHOUT it, 'alpha' === 'alpha' would wrongly throw.
    seed([{ id: 'coll-1', name: 'alpha', createdAt: 1000, updatedAt: 1000 }]);
    const updated = await mod.updateCollection('coll-1', { name: '  alpha  ' });
    assert.strictEqual(updated.id, 'coll-1', 'rename succeeded (no self-collision)');
  });

  it('throws when renaming to a name already used by a DIFFERENT collection', async () => {
    seed([{ id: 'coll-1', name: 'alpha' }, { id: 'coll-2', name: 'beta' }]);
    await assert.rejects(() => mod.updateCollection('coll-1', { name: 'beta' }), /Collection "beta" already exists/);
  });

  it('preserves id and createdAt and bumps only updatedAt', async () => {
    seed([{ id: 'coll-1', name: 'alpha', createdAt: 1000, updatedAt: 1000 }]);
    const updated = await mod.updateCollection('coll-1', { criteria: { role: 'worker' } });
    assert.strictEqual(updated.id, 'coll-1', 'id preserved');
    assert.strictEqual(updated.createdAt, 1000, 'createdAt preserved');
    assert.ok(updated.updatedAt > 1000, 'updatedAt bumped to a newer timestamp');
    assert.deepStrictEqual(updated.criteria, { role: 'worker' }, 'merged update applied');

    const persisted = await mod.loadCollections();
    assert.strictEqual(persisted[0].id, 'coll-1');
    assert.strictEqual(persisted[0].createdAt, 1000);
    assert.strictEqual(persisted[0].updatedAt, updated.updatedAt);
  });
});

// ----------------------------- deleteCollection ------------------------------
describe('deleteCollection — not-found vs removed', () => {
  it('returns false and writes nothing when the id is not found', async () => {
    seed([{ id: 'coll-1', name: 'alpha' }]);
    const before = fs.readFileSync(collectionsPath, 'utf8');
    const result = await mod.deleteCollection('coll-missing');
    assert.strictEqual(result, false);
    // not-found short-circuits BEFORE saveCollections — file is byte-identical.
    assert.strictEqual(fs.readFileSync(collectionsPath, 'utf8'), before);
  });

  it('returns true and persists the list without the deleted row', async () => {
    seed([{ id: 'coll-1', name: 'alpha' }, { id: 'coll-2', name: 'beta' }]);
    const result = await mod.deleteCollection('coll-1');
    assert.strictEqual(result, true);
    const persisted = await mod.loadCollections();
    assert.strictEqual(persisted.length, 1, 'deleted row removed');
    assert.strictEqual(persisted[0].id, 'coll-2');
  });
});

// ----------------------------- getAgentsInCollection (pure) ------------------
describe('getAgentsInCollection — criteria matching (pure, no I/O)', () => {
  it('returns [] when the collection has no usable criteria', () => {
    const chat = { name: 'a', role: 'worker', project: 'warden', host: 'h1' };
    assert.deepStrictEqual(mod.getAgentsInCollection(null, [chat]), []);
    assert.deepStrictEqual(mod.getAgentsInCollection({}, [chat]), []);
    assert.deepStrictEqual(mod.getAgentsInCollection({ criteria: null }, [chat]), []);
    assert.deepStrictEqual(mod.getAgentsInCollection({ criteria: undefined }, [chat]), []);
  });

  it('returns [] when allChats is empty', () => {
    assert.deepStrictEqual(
      mod.getAgentsInCollection({ criteria: { role: 'worker' } }, []),
      [],
    );
  });

  it('matches ALL chats when criteria is present but has no filters', () => {
    const chats = [
      { name: 'a', role: 'worker', project: 'warden', host: 'h1' },
      { name: 'b', role: 'reviewer', project: 'other', host: 'h2' },
    ];
    assert.deepStrictEqual(mod.getAgentsInCollection({ criteria: {} }, chats), chats);
  });

  it('ANDs role / project / host filters', () => {
    const chats = [
      { name: 'all-match', role: 'worker', project: 'warden', host: 'h1' },
      { name: 'project-mismatch', role: 'worker', project: 'other', host: 'h1' },
      { name: 'role-mismatch', role: 'reviewer', project: 'warden', host: 'h1' },
      { name: 'host-mismatch', role: 'worker', project: 'warden', host: 'h2' },
    ];
    const out = mod.getAgentsInCollection(
      { criteria: { role: 'worker', project: 'warden', host: 'h1' } },
      chats,
    );
    assert.deepStrictEqual(out.map((c) => c.name), ['all-match']);
  });

  it('ORs the custom array against role / project / host / name', () => {
    const chats = [
      { name: 'alice', role: 'reviewer', project: 'x', host: 'h' },
      { name: 'bob', role: 'worker', project: 'y', host: 'h' },
      { name: 'carol', role: 'reviewer', project: 'warden', host: 'h' },
      { name: 'dave', role: 'reviewer', project: 'z', host: 'remote' },
      { name: 'eve', role: 'reviewer', project: 'z', host: 'h' },
    ];
    const out = mod.getAgentsInCollection(
      { criteria: { custom: ['alice', 'worker', 'warden', 'remote'] } },
      chats,
    );
    assert.deepStrictEqual(out.map((c) => c.name), ['alice', 'bob', 'carol', 'dave']);
  });

  it('ANDs a scalar filter (role) with the custom array', () => {
    const chats = [
      { name: 'a', role: 'worker', project: 'warden' },
      { name: 'b', role: 'worker', project: 'x' },
      { name: 'c', role: 'reviewer', project: 'warden' },
    ];
    const out = mod.getAgentsInCollection(
      { criteria: { role: 'worker', custom: ['warden'] } },
      chats,
    );
    assert.deepStrictEqual(out.map((c) => c.name), ['a']);
  });

  it('treats an empty custom array as "no custom filter"', () => {
    const chats = [
      { name: 'a', role: 'worker', project: 'warden' },
      { name: 'b', role: 'reviewer', project: 'other' },
    ];
    assert.deepStrictEqual(
      mod.getAgentsInCollection({ criteria: { role: 'worker', custom: [] } }, chats).map((c) => c.name),
      ['a'],
    );
  });
});
