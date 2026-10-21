import { describe, it, before, after, afterEach, mock } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  pendingWriteCount,
  atomicWrite,
  atomicWriteJson,
  atomicAppend,
  removeFile,
  readJsonDefensive,
  readJsonDefensiveSync,
  corruptBackupPath,
} from './persist.js';
import { deferred } from './testGate.js';

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

describe('atomicWrite per-file ordering', () => {
  it('last-issued overlapping write wins on disk (8 writers x 25 trials)', async () => {
    for (let trial = 0; trial < 25; trial++) {
      const p = file(`order-${trial}.json`);
      const writes = [];
      for (let n = 1; n <= 8; n++) {
        // Alternate raw and JSON writers; both go through the same queue.
        writes.push(n % 2 ? atomicWriteJson(p, { n }) : atomicWrite(p, JSON.stringify({ n }, null, 2) + '\n'));
      }
      await Promise.all(writes);
      assert.deepStrictEqual(JSON.parse(fs.readFileSync(p, 'utf8')), { n: 8 }, `trial ${trial}`);
    }
  });

  it('a rejected write rejects for its caller and does not poison later writes', async () => {
    const blocker = file('iamafile');
    fs.writeFileSync(blocker, 'x');
    const bad = path.join(blocker, 'child.json'); // parent is a file -> mkdir fails
    const p1 = atomicWrite(bad, 'a');
    const p2 = atomicWrite(bad, 'b');
    await assert.rejects(p1);
    await assert.rejects(p2);
    // Same path (now made writable) still accepts a write after the failures.
    fs.rmSync(blocker);
    await atomicWrite(bad, 'ok');
    assert.strictEqual(fs.readFileSync(bad, 'utf8'), 'ok');
    // A failure queued between two good writes does not block the follow-up.
    const q = file('mixed.json');
    const w1 = atomicWrite(q, '1');
    const failing = atomicWrite(q, { toString() { throw new Error('boom'); } });
    const w3 = atomicWrite(q, '3');
    await w1;
    await assert.rejects(failing).catch(() => {});
    await w3;
    assert.strictEqual(fs.readFileSync(q, 'utf8'), '3');
  });

  it('different files are not serialized against each other; queue entries are cleaned up', async () => {
    const slow = file('slow.json');
    const fast = file('fast.json');
    const gate = deferred();
    const realOpen = fs.promises.open;
    const m = mock.method(fs.promises, 'open', async (p, ...rest) => {
      if (String(p).includes('slow.json')) await gate.promise; // deliberately slow first writer
      return realOpen.call(fs.promises, p, ...rest);
    });
    try {
      const slowP = atomicWrite(slow, 'slow');
      const fastP = atomicWrite(fast, 'fast');
      await fastP; // must resolve while slow is still blocked
      assert.strictEqual(fs.readFileSync(fast, 'utf8'), 'fast');
      assert.strictEqual(fs.existsSync(slow), false);
      await new Promise((r) => setImmediate(r)); // let fast's queue entry clean up
      assert.strictEqual(pendingWriteCount(), 1); // only slow still tracked
      gate.resolve();
      await slowP;
      assert.strictEqual(fs.readFileSync(slow, 'utf8'), 'slow');
    } finally {
      gate.resolve();
      m.mock.restore();
    }
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(pendingWriteCount(), 0);
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
  // Both properties asserted here are load-bearing (WARDEN-1040): the artifact
  // must leave the `.json` namespace its scanner globs, and the name must be
  // stable for stable content so re-reading an unchanged corrupt file cannot
  // keep minting new artifacts on a request path.
  it('produces a <base>.corrupt-<digest><ext>.bak path with no forbidden characters', () => {
    const p = corruptBackupPath('/home/u/.yatfa-warden/config.json', '<<<not json>>>');
    assert.match(p, /^\/home\/u\/\.yatfa-warden\/config\.corrupt-[0-9a-f]{12}\.json\.bak$/);
    // No characters Windows forbids in paths.
    assert.ok(!p.includes(':'), `backup path contains a colon: ${p}`);
  });

  it('leaves the scanned .json namespace so the backup is never re-read', () => {
    for (const src of ['/home/u/.yatfa-warden/config.json', '/tmp/activity', '/tmp/sessions/bad.json']) {
      const p = corruptBackupPath(src, 'broken');
      assert.ok(!p.endsWith('.json'), `quarantine artifact must not end in .json: ${p}`);
    }
  });

  it('still produces a usable name when the source has no extension', () => {
    const p = corruptBackupPath('/tmp/activity', 'broken');
    assert.match(p, /^\/tmp\/activity\.corrupt-[0-9a-f]{12}\.bak$/);
    assert.ok(!p.includes(':'), `backup path contains a colon: ${p}`);
  });

  it('is stable for identical content and distinct for different content', () => {
    const f = '/tmp/sessions/bad.json';
    assert.strictEqual(
      corruptBackupPath(f, '{"a":'), corruptBackupPath(f, '{"a":'),
      'the same corrupt bytes must resolve to the same artifact — otherwise every re-read mints a new file',
    );
    assert.notStrictEqual(
      corruptBackupPath(f, '{"a":'), corruptBackupPath(f, '{"b":'),
      'genuinely different corruption deserves its own artifact',
    );
  });
});
