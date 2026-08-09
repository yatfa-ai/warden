import { describe, it, before, after, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  atomicWrite,
  atomicWriteJson,
  atomicAppend,
  removeFile,
  readJsonDefensive,
  readJsonDefensiveSync,
  corruptBackupPath,
} from './persist.js';

// Real-I/O tests against a unique temp dir: the atomic rename + corrupt-backup
// semantics are exactly what this ticket adds, so we exercise them for real
// rather than mocking fs (a mock cannot prove a temp file is renamed atomically
// or that a backup file lands on disk).
const ROOT = path.join(os.tmpdir(), `warden-persist-test-${process.pid}-${Date.now().toString(36)}`);
const file = (name) => path.join(ROOT, name);

before(() => fs.mkdirSync(ROOT, { recursive: true }));
after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

afterEach(() => {
  // Wipe contents between tests so each starts clean (keep the root dir).
  for (const entry of fs.readdirSync(ROOT)) {
    fs.rmSync(path.join(ROOT, entry), { recursive: true, force: true });
  }
});

describe('atomicWrite', () => {
  it('writes the exact bytes to the target (no partial)', async () => {
    const p = file('a.json');
    await atomicWrite(p, 'hello\n');
    assert.strictEqual(fs.readFileSync(p, 'utf8'), 'hello\n');
  });

  it('is byte-identical to the pre-refactor writeFileSync(JSON.stringify(v,null,2)+"\\n")', async () => {
    const value = { b: 2, a: 1, nested: { z: 9 } };
    const p = file('pretty.json');
    await atomicWriteJson(p, value);
    const expected = JSON.stringify(value, null, 2) + '\n';
    assert.strictEqual(fs.readFileSync(p, 'utf8'), expected);
  });

  it('creates parent directories that do not yet exist', async () => {
    const p = file('nested/dir/deep.json');
    await atomicWriteJson(p, { ok: true });
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(p, 'utf8')), { ok: true });
  });

  it('overwrites an existing file (replace, not append)', async () => {
    const p = file('replace.json');
    await atomicWrite(p, 'first');
    await atomicWrite(p, 'second');
    assert.strictEqual(fs.readFileSync(p, 'utf8'), 'second');
  });

  it('leaves no .tmp sibling behind after a successful write', async () => {
    const p = file('clean.json');
    await atomicWrite(p, 'x');
    const leftovers = fs.readdirSync(ROOT).filter((n) => n.endsWith('.tmp'));
    assert.deepStrictEqual(leftovers, []);
  });
});

describe('atomicAppend', () => {
  it('appends to an existing file', async () => {
    const p = file('log.jsonl');
    await atomicAppend(p, '{"a":1}\n');
    await atomicAppend(p, '{"a":2}\n');
    assert.strictEqual(fs.readFileSync(p, 'utf8'), '{"a":1}\n{"a":2}\n');
  });

  it('creates the file (and parent dirs) when absent', async () => {
    const p = file('sub/log2.jsonl');
    await atomicAppend(p, 'line\n');
    assert.strictEqual(fs.readFileSync(p, 'utf8'), 'line\n');
  });
});

describe('removeFile', () => {
  it('deletes an existing file', async () => {
    const p = file('gone.json');
    await atomicWrite(p, 'x');
    await removeFile(p);
    assert.ok(!fs.existsSync(p));
  });

  it('tolerates a missing file (no throw)', async () => {
    await assert.doesNotReject(() => removeFile(file('never-existed.json')));
  });
});

describe('readJsonDefensive (async)', () => {
  it('returns fallback when the file is missing (ENOENT)', async () => {
    assert.strictEqual(await readJsonDefensive(file('nope.json'), { fallback: 'DEF' }), 'DEF');
  });

  it('returns the parsed value for valid JSON', async () => {
    const p = file('ok.json');
    await atomicWriteJson(p, { x: 10 });
    assert.deepStrictEqual(await readJsonDefensive(p, { fallback: null }), { x: 10 });
  });

  it('backs up + surfaces corrupt JSON instead of silently defaulting', async () => {
    const p = file('bad.json');
    // Write genuinely corrupt JSON (truncated mid-document).
    await atomicWrite(p, '{ "host": "alpha", "hosts": [   ');
    const result = await readJsonDefensive(p, { fallback: { hosts: [] } });

    // Never silently swallowed: caller got the fallback, not the corrupt data.
    assert.deepStrictEqual(result, { hosts: [] });

    // A backup file was written, containing the corrupt text.
    const backups = fs.readdirSync(ROOT).filter((n) => n.startsWith('bad.corrupt-'));
    assert.strictEqual(backups.length, 1);
    assert.strictEqual(fs.readFileSync(path.join(ROOT, backups[0]), 'utf8'), '{ "host": "alpha", "hosts": [   ');
  });

  it('treats a revive rejection as corruption (backup + fallback)', async () => {
    const p = file('wrong-type.json');
    await atomicWriteJson(p, { not: 'an-array' });
    const revive = (v) => { if (!Array.isArray(v)) throw new Error('expected array'); return v; };
    const result = await readJsonDefensive(p, { fallback: [], revive });
    assert.deepStrictEqual(result, []);
    const backups = fs.readdirSync(ROOT).filter((n) => n.startsWith('wrong-type.corrupt-'));
    assert.strictEqual(backups.length, 1);
  });

  it('returns the revived value when revive succeeds', async () => {
    const p = file('arr.json');
    await atomicWriteJson(p, [1, 2, 3]);
    const revive = (v) => v.map((n) => n * 2);
    assert.deepStrictEqual(await readJsonDefensive(p, { fallback: [], revive }), [2, 4, 6]);
  });
});

describe('readJsonDefensiveSync (boot-only)', () => {
  it('returns fallback when the file is missing', () => {
    assert.strictEqual(readJsonDefensiveSync(file('nope2.json'), { fallback: 'DEF' }), 'DEF');
  });

  it('returns parsed value for valid JSON', () => {
    const p = file('ok2.json');
    fs.writeFileSync(p, JSON.stringify({ y: 5 }));
    assert.deepStrictEqual(readJsonDefensiveSync(p, { fallback: null }), { y: 5 });
  });

  it('backs up corrupt JSON and returns fallback', () => {
    const p = file('bad2.json');
    fs.writeFileSync(p, '<<<not json>>>');
    const result = readJsonDefensiveSync(p, { fallback: { d: 1 } });
    assert.deepStrictEqual(result, { d: 1 });
    const backups = fs.readdirSync(ROOT).filter((n) => n.startsWith('bad2.corrupt-'));
    assert.strictEqual(backups.length, 1);
    assert.strictEqual(fs.readFileSync(path.join(ROOT, backups[0]), 'utf8'), '<<<not json>>>');
  });
});

describe('corruptBackupPath', () => {
  it('produces a <base>.corrupt-<ts><ext> path with a filesystem-safe timestamp', () => {
    const p = corruptBackupPath('/home/u/.yatfa-warden/config.json');
    assert.match(p, /\/home\/u\/\.yatfa-warden\/config\.corrupt-\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d\d\dZ\.json$/);
    // No characters Windows forbids in paths.
    assert.ok(!p.includes(':'), `backup path contains a colon: ${p}`);
  });

  it('uses .json when the source has no extension', () => {
    const p = corruptBackupPath('/tmp/activity');
    assert.match(p, /\/tmp\/activity\.corrupt-.*\.json$/);
  });
});
