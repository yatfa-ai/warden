import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import express from 'express';

/**
 * Route-layer tests for the five /api/collections handlers of
 * createUserDataRouter (src/userDataRoutes.js, extracted from server.js by
 * WARDEN-1733). collections.js / collections.test.js cover the MODULE; this
 * suite pins the HTTP layer: status mapping (400/404/409), body wrapping,
 * criteria/metadata forwarding and live catalog-snapshot matching.
 *
 * Mounts the router on a bare Express app with an injected fake chatCatalog
 * (no server.js import, no network beyond 127.0.0.1, no tmux). HOME is pointed
 * at a temp dir BEFORE importing the router, since collections.js resolves its
 * storage path from config.js at import time.
 */

describe('/api/collections routes (createUserDataRouter)', () => {
  let httpServer;
  let baseUrl;
  let originalHome;
  let tempHome;
  let chats;
  let snapshotCalls;

  const call = async (method, url, body) => {
    const res = await fetch(`${baseUrl}${url}`, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, json: await res.json() };
  };
  const list = async () => (await call('GET', '/api/collections')).json.collections;
  const create = async (name, extra = {}) => {
    const r = await call('POST', '/api/collections', { name, ...extra });
    assert.strictEqual(r.status, 200);
    return r.json.collection;
  };

  before(async () => {
    originalHome = process.env.HOME;
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-usrdata-coll-'));
    process.env.HOME = tempHome;

    chats = [
      { id: 'c1', name: 'alpha', role: 'worker', project: 'p1', host: 'h1' },
      { id: 'c2', name: 'beta', role: 'reviewer', project: 'p1', host: 'h2' },
      { id: 'c3', name: 'gamma', role: 'worker', project: 'p2', host: 'h1' },
    ];
    snapshotCalls = 0;
    const chatCatalog = { snapshot: () => { snapshotCalls += 1; return chats; } };

    const { createUserDataRouter } = await import('./userDataRoutes.js');
    const app = express();
    app.use(express.json());
    app.use(createUserDataRouter({ cfg: {}, chatCatalog }));
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

  it('GET /api/collections on a fresh store returns 200 { collections: [] }', async () => {
    const r = await call('GET', '/api/collections');
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.json, { collections: [] });
  });

  it('POST rejects a missing / non-string / empty / null name with 400 "name is required (string)"', async () => {
    for (const body of [{}, { name: 5 }, { name: '' }, { name: null }]) {
      const r = await call('POST', '/api/collections', body);
      assert.strictEqual(r.status, 400, JSON.stringify(body));
      assert.deepStrictEqual(r.json, { error: 'name is required (string)' }, JSON.stringify(body));
    }
    assert.deepStrictEqual(await list(), []);
  });

  it('POST returns { collection } with trimmed name and forwarded criteria + metadata, and it is then listed', async () => {
    const r = await call('POST', '/api/collections', {
      name: '  Workers  ',
      criteria: { role: 'worker' },
      metadata: { color: 'red' },
    });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(Object.keys(r.json), ['collection']);
    const c = r.json.collection;
    assert.strictEqual(c.name, 'Workers');
    assert.deepStrictEqual(c.criteria, { role: 'worker' });
    assert.deepStrictEqual(c.metadata, { color: 'red' });
    assert.ok(typeof c.id === 'string' && c.id.length > 0);

    const listed = await list();
    assert.ok(listed.some((x) => x.id === c.id && x.name === 'Workers'));
  });

  it('POST a duplicate name returns 409 /already exists/', async () => {
    await create('dup-name');
    const r = await call('POST', '/api/collections', { name: 'dup-name' });
    assert.strictEqual(r.status, 409);
    assert.match(r.json.error, /already exists/);
  });

  it('POST a whitespace-only name returns 400 "Collection name is required" (not 409)', async () => {
    const r = await call('POST', '/api/collections', { name: '   ' });
    assert.strictEqual(r.status, 400);
    assert.deepStrictEqual(r.json, { error: 'Collection name is required' });
  });

  it('POST non-object criteria / metadata returns 400 with the module message and persists nothing', async () => {
    const before = (await list()).length;
    const crit = await call('POST', '/api/collections', { name: 'post-bad-criteria', criteria: 'worker' });
    assert.strictEqual(crit.status, 400);
    assert.deepStrictEqual(crit.json, { error: 'Collection criteria must be an object' });

    const meta = await call('POST', '/api/collections', { name: 'post-bad-metadata', metadata: [] });
    assert.strictEqual(meta.status, 400);
    assert.deepStrictEqual(meta.json, { error: 'Collection metadata must be an object' });

    assert.strictEqual((await list()).length, before);
  });

  it('PATCH rename returns 200 { collection } with the same id and the new name', async () => {
    const c = await create('to-rename');
    const r = await call('PATCH', `/api/collections/${c.id}`, { name: 'renamed' });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(Object.keys(r.json), ['collection']);
    assert.strictEqual(r.json.collection.id, c.id);
    assert.strictEqual(r.json.collection.name, 'renamed');
    const persisted = (await list()).find((x) => x.id === c.id);
    assert.strictEqual(persisted.name, 'renamed');
  });

  it('PATCH forwards criteria and metadata updates to storage', async () => {
    const c = await create('patch-fields');
    const r = await call('PATCH', `/api/collections/${c.id}`, {
      criteria: { project: 'p1' },
      metadata: { color: 'blue' },
    });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.json.collection.criteria, { project: 'p1' });
    assert.deepStrictEqual(r.json.collection.metadata, { color: 'blue' });
    const persisted = (await list()).find((x) => x.id === c.id);
    assert.deepStrictEqual(persisted.criteria, { project: 'p1' });
    assert.deepStrictEqual(persisted.metadata, { color: 'blue' });
  });

  it('PATCH an unknown id returns 404 /not found/', async () => {
    const r = await call('PATCH', '/api/collections/coll-does-not-exist', { name: 'whatever' });
    assert.strictEqual(r.status, 404);
    assert.match(r.json.error, /not found/);
  });

  it('PATCH renaming onto an existing name returns 400 /already exists/ (not 404 or 409)', async () => {
    await create('taken-name');
    const other = await create('wants-taken-name');
    const r = await call('PATCH', `/api/collections/${other.id}`, { name: 'taken-name' });
    assert.strictEqual(r.status, 400);
    assert.match(r.json.error, /already exists/);
  });

  it('PATCH with a blank name or non-object criteria / metadata returns 400 with the module message', async () => {
    const c = await create('patch-invalid');
    const blank = await call('PATCH', `/api/collections/${c.id}`, { name: '   ' });
    assert.strictEqual(blank.status, 400);
    assert.deepStrictEqual(blank.json, { error: 'Collection name is required' });

    const crit = await call('PATCH', `/api/collections/${c.id}`, { criteria: 'nope' });
    assert.strictEqual(crit.status, 400);
    assert.deepStrictEqual(crit.json, { error: 'Collection criteria must be an object' });

    const meta = await call('PATCH', `/api/collections/${c.id}`, { metadata: [] });
    assert.strictEqual(meta.status, 400);
    assert.deepStrictEqual(meta.json, { error: 'Collection metadata must be an object' });

    // Rejected input never reached storage.
    assert.strictEqual((await list()).find((x) => x.id === c.id).name, 'patch-invalid');
  });

  it('GET /:id/agents returns exactly the chats matching THAT collection, with count, reading the live snapshot', async () => {
    const byProject = await create('agents-by-project', { criteria: { project: 'p1' } });
    const byRole = await create('agents-by-role', { criteria: { role: 'worker' } });

    const before = snapshotCalls;
    const a = await call('GET', `/api/collections/${byProject.id}/agents`);
    assert.strictEqual(a.status, 200);
    assert.deepStrictEqual(a.json.agents.map((x) => x.id), ['c1', 'c2']);
    assert.strictEqual(a.json.count, a.json.agents.length);
    assert.strictEqual(snapshotCalls, before + 1);

    const b = await call('GET', `/api/collections/${byRole.id}/agents`);
    assert.strictEqual(b.status, 200);
    assert.deepStrictEqual(b.json.agents.map((x) => x.id), ['c1', 'c3']);
    assert.strictEqual(b.json.count, 2);

    // A new chat appears in the catalog: the next request reflects it (no caching).
    chats.push({ id: 'c4', name: 'delta', role: 'worker', project: 'p3', host: 'h3' });
    try {
      const b2 = await call('GET', `/api/collections/${byRole.id}/agents`);
      assert.deepStrictEqual(b2.json.agents.map((x) => x.id), ['c1', 'c3', 'c4']);
      assert.strictEqual(b2.json.count, 3);
    } finally {
      chats.pop();
    }
  });

  it('GET /:id/agents for an unknown id returns 404 "Collection not found" without touching the catalog', async () => {
    const before = snapshotCalls;
    const r = await call('GET', '/api/collections/coll-nope/agents');
    assert.strictEqual(r.status, 404);
    assert.deepStrictEqual(r.json, { error: 'Collection not found' });
    assert.strictEqual(snapshotCalls, before);
  });

  it('DELETE an unknown id returns 404 "Collection not found" and leaves the store unchanged', async () => {
    const before = await list();
    const r = await call('DELETE', '/api/collections/coll-nope');
    assert.strictEqual(r.status, 404);
    assert.deepStrictEqual(r.json, { error: 'Collection not found' });
    assert.deepStrictEqual(await list(), before);
  });

  it('DELETE a known id returns 200 { ok: true }, removes it from the list, and its /agents then 404s', async () => {
    const c = await create('to-delete', { criteria: { role: 'worker' } });
    const r = await call('DELETE', `/api/collections/${c.id}`);
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.json, { ok: true });
    assert.ok(!(await list()).some((x) => x.id === c.id));
    const agents = await call('GET', `/api/collections/${c.id}/agents`);
    assert.strictEqual(agents.status, 404);
  });
});
