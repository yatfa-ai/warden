import { describe, it, mock, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import {
  collectionsPath,
  loadCollections,
  saveCollections,
  createCollection,
  updateCollection,
  deleteCollection,
  getAgentsInCollection,
} from './collections.js';

// collections.js persists to ~/.yatfa-warden/collections.json via fs.readFileSync /
// fs.writeFileSync / fs.mkdirSync. We mock those calls (exactly like src/config.test.js)
// so the tests drive the CRUD + parse-defensive behavior deterministically with no real
// file I/O. The module-load `dir` binding is irrelevant here — we mock the fs *calls*,
// not the path. getAgentsInCollection is pure and needs no mock.

// ----------------------------- loadCollections -------------------------------
describe('loadCollections — defensive parse contract', () => {
  afterEach(() => {
    mock.restoreAll();
  });

  it('returns [] when the file is missing (first run / ENOENT)', () => {
    mock.method(fs, 'readFileSync', () => {
      throw new Error('ENOENT: collections.json does not exist');
    });
    assert.deepStrictEqual(loadCollections(), []);
  });

  it('returns [] when the file contains corrupt JSON', () => {
    mock.method(fs, 'readFileSync', () => 'not valid json {{{');
    assert.deepStrictEqual(loadCollections(), []);
  });

  it('returns [] when the parsed value is not an array', () => {
    // A corrupted/garbled write could leave an object or primitive at the top level.
    // That must never crash the app or be treated as a list.
    mock.method(fs, 'readFileSync', () => JSON.stringify({ not: 'an array' }));
    assert.deepStrictEqual(loadCollections(), []);
  });

  it('returns the parsed array when the file is valid', () => {
    const stored = [{ id: 'coll-1', name: 'codex', criteria: { role: 'worker' } }];
    mock.method(fs, 'readFileSync', () => JSON.stringify(stored));
    assert.deepStrictEqual(loadCollections(), stored);
  });
});

// ----------------------------- saveCollections -------------------------------
describe('saveCollections — persistence shape', () => {
  afterEach(() => {
    mock.restoreAll();
  });

  it('ensures the directory exists and writes pretty JSON terminated by a newline', () => {
    mock.method(fs, 'mkdirSync', () => undefined);
    mock.method(fs, 'writeFileSync', () => {});

    const data = [{ id: 'coll-1', name: 'codex' }];
    saveCollections(data);

    // mkdir must be recursive so a first-run dir tree is created.
    const mkdirCall = fs.mkdirSync.mock.calls[0];
    assert.deepStrictEqual(mkdirCall.arguments[1], { recursive: true });

    // writeFileSync target is the module's collectionsPath; body is JSON + '\n'.
    const writeCall = fs.writeFileSync.mock.calls[0];
    assert.strictEqual(writeCall.arguments[0], collectionsPath);
    assert.strictEqual(writeCall.arguments[1], JSON.stringify(data, null, 2) + '\n');
  });
});

// ----------------------------- createCollection ------------------------------
describe('createCollection — name validation + persistence', () => {
  afterEach(() => {
    mock.restoreAll();
  });

  // shared no-op writes so createCollection can persist without touching disk
  function mockWrites() {
    mock.method(fs, 'mkdirSync', () => undefined);
    mock.method(fs, 'writeFileSync', () => {});
  }

  it('throws "Collection name is required" when the name is empty / whitespace / null', () => {
    mock.method(fs, 'readFileSync', () => '[]');
    assert.throws(() => createCollection(''), /Collection name is required/);
    assert.throws(() => createCollection('   '), /Collection name is required/);
    assert.throws(() => createCollection(null), /Collection name is required/);
    assert.throws(() => createCollection(undefined), /Collection name is required/);
  });

  it('throws when a collection with the same name already exists', () => {
    // read-then-write uniqueness: an existing identical name must block creation.
    mock.method(fs, 'readFileSync', () =>
      JSON.stringify([{ id: 'coll-1', name: 'codex' }])
    );
    assert.throws(() => createCollection('codex'), /Collection "codex" already exists/);
  });

  it('trims surrounding whitespace and truncates the name to 60 characters', () => {
    mock.method(fs, 'readFileSync', () => '[]');
    mockWrites();

    const trimmed = createCollection('   codex   ');
    assert.strictEqual(trimmed.name, 'codex', 'surrounding whitespace is trimmed');

    const longName = 'x'.repeat(80);
    const truncated = createCollection(longName);
    assert.strictEqual(truncated.name.length, 60, 'name is sliced to max 60 chars');
    assert.strictEqual(truncated.name, longName.slice(0, 60));
  });

  it('populates id/createdAt/updatedAt and persists the new collection', () => {
    mock.method(fs, 'readFileSync', () => '[]');
    mockWrites();

    const created = createCollection('codex', { role: 'worker' }, { color: 'blue' });

    // identity fields populated
    assert.ok(typeof created.id === 'string' && created.id.startsWith('coll-'), 'id is a coll-<…> string');
    assert.strictEqual(created.name, 'codex');
    assert.deepStrictEqual(created.criteria, { role: 'worker' });
    assert.deepStrictEqual(created.metadata, { color: 'blue' });
    // createdAt and updatedAt come from the same Date.now() snapshot — must be equal
    assert.strictEqual(typeof created.createdAt, 'number');
    assert.strictEqual(created.createdAt, created.updatedAt);

    // the new collection was appended and written
    const writeCall = fs.writeFileSync.mock.calls[0];
    const persisted = JSON.parse(writeCall.arguments[1]);
    assert.strictEqual(persisted.length, 1);
    assert.strictEqual(persisted[0].id, created.id);
    assert.strictEqual(persisted[0].name, 'codex');
  });
});

// ----------------------------- updateCollection ------------------------------
describe('updateCollection — identity preservation + uniqueness', () => {
  afterEach(() => {
    mock.restoreAll();
  });

  function mockWrites() {
    mock.method(fs, 'mkdirSync', () => undefined);
    mock.method(fs, 'writeFileSync', () => {});
  }

  it('throws "Collection not found" when the id does not exist', () => {
    mock.method(fs, 'readFileSync', () =>
      JSON.stringify([{ id: 'coll-1', name: 'alpha' }])
    );
    assert.throws(() => updateCollection('coll-missing', { name: 'beta' }), /Collection not found/);
  });

  it('persists a new casing on rename (codex → Codex)', () => {
    // A rename that only changes the casing of the row's own name must persist the new
    // casing. NOTE: this does NOT exercise the `c.id !== id` self-exclusion guard —
    // case-sensitive compare means 'codex' !== 'Codex' regardless of that guard. The
    // guard is driven by the same-trim self-rename test below (the only input that can
    // reach it).
    mock.method(fs, 'readFileSync', () =>
      JSON.stringify([{ id: 'coll-1', name: 'codex', createdAt: 1000, updatedAt: 1000 }])
    );
    mockWrites();

    const updated = updateCollection('coll-1', { name: 'Codex' });
    assert.strictEqual(updated.name, 'Codex');
  });

  it('excludes the row itself from the uniqueness check on a self-rename that trims to the same name', () => {
    // 'alpha' -> '  alpha  ' trims back to 'alpha'. With the `c.id !== id` term in the
    // uniqueness check this succeeds; WITHOUT it, `c.name === trimmedName` ('alpha' ===
    // 'alpha') would wrongly throw "Collection "alpha" already exists" — the exact
    // false-positive the guard exists to prevent. This is the only input that actually
    // drives that guard (a case-only rename can't reach it under case-sensitive compare).
    mock.method(fs, 'readFileSync', () =>
      JSON.stringify([{ id: 'coll-1', name: 'alpha', createdAt: 1000, updatedAt: 1000 }])
    );
    mockWrites();

    const updated = updateCollection('coll-1', { name: '  alpha  ' });
    assert.strictEqual(updated.id, 'coll-1', 'rename succeeded (no self-collision)');
  });

  it('throws when renaming to a name already used by a DIFFERENT collection', () => {
    mock.method(fs, 'readFileSync', () =>
      JSON.stringify([
        { id: 'coll-1', name: 'alpha' },
        { id: 'coll-2', name: 'beta' },
      ])
    );
    assert.throws(() => updateCollection('coll-1', { name: 'beta' }), /Collection "beta" already exists/);
  });

  it('preserves id and createdAt and bumps only updatedAt', () => {
    // Seed an old collection; after update the identity fields must be unchanged and
    // updatedAt must move forward.
    mock.method(fs, 'readFileSync', () =>
      JSON.stringify([
        { id: 'coll-1', name: 'alpha', createdAt: 1000, updatedAt: 1000 },
      ])
    );
    mockWrites();

    const updated = updateCollection('coll-1', { criteria: { role: 'worker' } });
    assert.strictEqual(updated.id, 'coll-1', 'id preserved');
    assert.strictEqual(updated.createdAt, 1000, 'createdAt preserved');
    assert.ok(updated.updatedAt > 1000, 'updatedAt bumped to a newer timestamp');
    assert.deepStrictEqual(updated.criteria, { role: 'worker' }, 'merged update applied');

    // persisted list still carries the (updated) row at the same slot
    const persisted = JSON.parse(fs.writeFileSync.mock.calls[0].arguments[1]);
    assert.strictEqual(persisted[0].id, 'coll-1');
    assert.strictEqual(persisted[0].createdAt, 1000);
    assert.strictEqual(persisted[0].updatedAt, updated.updatedAt);
  });
});

// ----------------------------- deleteCollection ------------------------------
describe('deleteCollection — not-found vs removed', () => {
  afterEach(() => {
    mock.restoreAll();
  });

  function mockWrites() {
    mock.method(fs, 'mkdirSync', () => undefined);
    mock.method(fs, 'writeFileSync', () => {});
  }

  it('returns false and writes nothing when the id is not found', () => {
    mock.method(fs, 'readFileSync', () =>
      JSON.stringify([{ id: 'coll-1', name: 'alpha' }])
    );
    mockWrites();

    const result = deleteCollection('coll-missing');
    assert.strictEqual(result, false);
    // not-found must short-circuit BEFORE saveCollections — no write happened
    assert.strictEqual(fs.writeFileSync.mock.calls.length, 0);
  });

  it('returns true and persists the list without the deleted row', () => {
    mock.method(fs, 'readFileSync', () =>
      JSON.stringify([
        { id: 'coll-1', name: 'alpha' },
        { id: 'coll-2', name: 'beta' },
      ])
    );
    mockWrites();

    const result = deleteCollection('coll-1');
    assert.strictEqual(result, true);

    const persisted = JSON.parse(fs.writeFileSync.mock.calls[0].arguments[1]);
    assert.strictEqual(persisted.length, 1, 'deleted row removed');
    assert.strictEqual(persisted[0].id, 'coll-2');
  });
});

// ----------------------------- getAgentsInCollection (pure) ------------------
describe('getAgentsInCollection — criteria matching (pure, no I/O)', () => {
  it('returns [] when the collection has no usable criteria', () => {
    const chat = { name: 'a', role: 'worker', project: 'warden', host: 'h1' };
    assert.deepStrictEqual(getAgentsInCollection(null, [chat]), []);
    assert.deepStrictEqual(getAgentsInCollection({}, [chat]), []);
    assert.deepStrictEqual(getAgentsInCollection({ criteria: null }, [chat]), []);
    assert.deepStrictEqual(getAgentsInCollection({ criteria: undefined }, [chat]), []);
  });

  it('returns [] when allChats is empty', () => {
    assert.deepStrictEqual(
      getAgentsInCollection({ criteria: { role: 'worker' } }, []),
      []
    );
  });

  it('matches ALL chats when criteria is present but has no filters', () => {
    // criteria:{} activates no role/project/host/custom branch, so nothing excludes
    // a chat — every chat is returned. (Distinct from the no-criteria guard above.)
    const chats = [
      { name: 'a', role: 'worker', project: 'warden', host: 'h1' },
      { name: 'b', role: 'reviewer', project: 'other', host: 'h2' },
    ];
    assert.deepStrictEqual(getAgentsInCollection({ criteria: {} }, chats), chats);
  });

  it('ANDs role / project / host filters', () => {
    const chats = [
      { name: 'all-match', role: 'worker', project: 'warden', host: 'h1' },
      { name: 'project-mismatch', role: 'worker', project: 'other', host: 'h1' },
      { name: 'role-mismatch', role: 'reviewer', project: 'warden', host: 'h1' },
      { name: 'host-mismatch', role: 'worker', project: 'warden', host: 'h2' },
    ];
    const out = getAgentsInCollection(
      { criteria: { role: 'worker', project: 'warden', host: 'h1' } },
      chats
    );
    assert.deepStrictEqual(
      out.map((c) => c.name),
      ['all-match']
    );
  });

  it('ORs the custom array against role / project / host / name', () => {
    const chats = [
      { name: 'alice', role: 'reviewer', project: 'x', host: 'h' }, // name === 'alice'
      { name: 'bob', role: 'worker', project: 'y', host: 'h' }, // role === 'worker'
      { name: 'carol', role: 'reviewer', project: 'warden', host: 'h' }, // project === 'warden'
      { name: 'dave', role: 'reviewer', project: 'z', host: 'remote' }, // host === 'remote'
      { name: 'eve', role: 'reviewer', project: 'z', host: 'h' }, // matches none
    ];
    const out = getAgentsInCollection(
      { criteria: { custom: ['alice', 'worker', 'warden', 'remote'] } },
      chats
    );
    assert.deepStrictEqual(
      out.map((c) => c.name),
      ['alice', 'bob', 'carol', 'dave']
    );
  });

  it('ANDs a scalar filter (role) with the custom array', () => {
    // role must match AND at least one custom value must hit role/project/host/name.
    const chats = [
      { name: 'a', role: 'worker', project: 'warden' }, // role ✓ + custom(project=warden) ✓
      { name: 'b', role: 'worker', project: 'x' }, // role ✓ but custom ✗
      { name: 'c', role: 'reviewer', project: 'warden' }, // role ✗ (custom would ✓)
    ];
    const out = getAgentsInCollection(
      { criteria: { role: 'worker', custom: ['warden'] } },
      chats
    );
    assert.deepStrictEqual(
      out.map((c) => c.name),
      ['a']
    );
  });

  it('treats an empty custom array as "no custom filter"', () => {
    // criteria.custom = [] must not exclude anyone (length === 0 short-circuits the branch).
    const chats = [
      { name: 'a', role: 'worker', project: 'warden' },
      { name: 'b', role: 'reviewer', project: 'other' },
    ];
    assert.deepStrictEqual(
      getAgentsInCollection({ criteria: { role: 'worker', custom: [] } }, chats).map(
        (c) => c.name
      ),
      ['a']
    );
  });
});
