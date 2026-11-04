// Pins the persist/config defensive-read legs no other suite executes
// (WARDEN-2116). persist.test.js covers readJsonDefensiveSync's missing/valid/
// unparseable branches and readJsonDefensive's revive hook; config.test.js
// covers unparseable config.json text. NOT pinned anywhere else — and each
// mutant below changes observable behavior while keeping both suites green:
//
//   - readJsonDefensiveSync's `revive` hook (boot-only twin of the async
//     revive tests): a revive that throws on VALID JSON must quarantine the
//     original text via backupCorruptSync and return the fallback, a revive
//     that succeeds must return the REVIVED value (not the parsed one), and
//     revive must not run for unparseable text.
//   - both twins' backup-WRITE-failure leg: a quarantine write that itself
//     fails (EROFS/ENOSPC) must still return the fallback and say so —
//     never rethrow, never silently drop the corruption.
//   - the async unreadable (non-ENOENT) leg: fallback + warn, no backup.
//   - config load()'s boot-time reviveConfig quarantine: a syntactically
//     valid but WRONG-TYPED config.json root (`[]`, `"str"`, `42`, `null`,
//     …) is backed up under `.corrupt-` and boot continues on DEFAULTS.
//     migrateConfig (config-schema.js) deliberately passes non-objects
//     through unchanged, so without reviveConfig a `["x"]` root would spread
//     an indexed "0" key into the live cfg with no backup taken.

import { describe, it, before, after, afterEach, mock } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import { readJsonDefensive, readJsonDefensiveSync } from './persist.js';
import { load } from './config.js';

const ROOT = path.join(os.tmpdir(), `warden-persist-revive-${process.pid}-${Date.now().toString(36)}`);
const file = (n) => path.join(ROOT, n);
const backupsOf = (stem) => fs.readdirSync(ROOT).filter((n) => n.startsWith(`${stem}.corrupt-`));

before(() => fs.mkdirSync(ROOT, { recursive: true }));
after(() => fs.rmSync(ROOT, { recursive: true, force: true }));
afterEach(() => {
  mock.restoreAll();
  for (const e of fs.readdirSync(ROOT)) fs.rmSync(path.join(ROOT, e), { recursive: true, force: true });
});

const requireArray = (v) => { if (!Array.isArray(v)) throw new Error('expected array'); return v; };

describe('readJsonDefensiveSync revive hook', () => {
  it('a revive that throws on valid JSON quarantines the original text and returns the fallback', () => {
    mock.method(console, 'warn', () => {});
    const p = file('wrong-type.json');
    fs.writeFileSync(p, '{"not":"an array"}');
    const out = readJsonDefensiveSync(p, { fallback: ['FB'], revive: requireArray });
    assert.deepStrictEqual(out, ['FB']);
    const b = backupsOf('wrong-type');
    assert.strictEqual(b.length, 1, 'wrong-typed file must be backed up, not silently dropped');
    assert.strictEqual(fs.readFileSync(path.join(ROOT, b[0]), 'utf8'), '{"not":"an array"}');
  });

  it('a revive that succeeds returns the REVIVED value and writes no backup', () => {
    const p = file('ok.json');
    fs.writeFileSync(p, '[1,2,3]');
    const out = readJsonDefensiveSync(p, { fallback: [], revive: (v) => v.map((n) => n * 2) });
    assert.deepStrictEqual(out, [2, 4, 6]);
    assert.strictEqual(backupsOf('ok').length, 0);
  });

  it('revive is not consulted for unparseable text (parse failure alone takes the backup path)', () => {
    mock.method(console, 'warn', () => {});
    const p = file('garbage.json');
    fs.writeFileSync(p, '{{{');
    let calls = 0;
    const out = readJsonDefensiveSync(p, { fallback: 'FB', revive: (v) => { calls += 1; return v; } });
    assert.strictEqual(out, 'FB');
    assert.strictEqual(calls, 0);
    assert.strictEqual(backupsOf('garbage').length, 1);
  });

  it('still returns the fallback when the quarantine write itself fails, and says so', () => {
    const warn = mock.method(console, 'warn', () => {});
    const p = file('nobackup.json');
    fs.writeFileSync(p, '"scalar"');
    const real = fs.writeFileSync;
    mock.method(fs, 'writeFileSync', (target, ...rest) => {
      if (String(target).includes('.corrupt-')) throw new Error('EROFS: read-only');
      return real(target, ...rest);
    });
    const out = readJsonDefensiveSync(p, { fallback: ['FB'], revive: requireArray });
    assert.deepStrictEqual(out, ['FB']);
    assert.ok(warn.mock.calls.some((c) => /could not write corruption backup .*EROFS/.test(String(c.arguments[0]))));
  });

  it('an unreadable (non-ENOENT) path returns the fallback with a warning and NO backup', () => {
    const warn = mock.method(console, 'warn', () => {});
    const dir = file('is-a-dir.json');
    fs.mkdirSync(dir);
    assert.strictEqual(readJsonDefensiveSync(dir, { fallback: 'FB' }), 'FB');
    assert.ok(warn.mock.calls.some((c) => /unreadable .*is-a-dir\.json/.test(String(c.arguments[0]))));
    assert.strictEqual(backupsOf('is-a-dir').length, 0);
  });
});

describe('readJsonDefensive (async) — unreadable and backup-failure legs', () => {
  it('an unreadable (non-ENOENT) path returns the fallback with a warning and NO backup', async () => {
    const warn = mock.method(console, 'warn', () => {});
    const dir = file('is-a-dir2.json');
    fs.mkdirSync(dir);
    assert.strictEqual(await readJsonDefensive(dir, { fallback: 'FB' }), 'FB');
    assert.ok(warn.mock.calls.some((c) => /unreadable .*is-a-dir2\.json/.test(String(c.arguments[0]))));
    assert.strictEqual(backupsOf('is-a-dir2').length, 0);
  });

  it('still returns the fallback when the quarantine write itself fails, and says so', async () => {
    const warn = mock.method(console, 'warn', () => {});
    const p = file('nobackup2.json');
    fs.writeFileSync(p, '{"x":1}');
    const real = fsp.writeFile;
    mock.method(fsp, 'writeFile', async (target, ...rest) => {
      if (String(target).includes('.corrupt-')) throw new Error('ENOSPC: no space');
      return real(target, ...rest);
    });
    const out = await readJsonDefensive(p, { fallback: ['FB'], revive: requireArray });
    assert.deepStrictEqual(out, ['FB']);
    assert.ok(warn.mock.calls.some((c) => /could not write corruption backup .*ENOSPC/.test(String(c.arguments[0]))));
  });
});

// config.js load() runs at boot with revive = reviveConfig (object-only). migrateConfig passes
// non-objects through unchanged, so without the guard the spread copies junk keys into cfg.
describe('config load() — wrong-typed config.json root (boot-time reviveConfig)', () => {
  const defaults = (() => {
    mock.method(fs, 'readFileSync', () => { throw new Error('ENOENT'); });
    const d = load();
    mock.restoreAll();
    return d;
  })();

  for (const text of ['[]', '["x","y"]', 'null', '"a string"', '42', 'true']) {
    it(`root ${text}: backed up under .corrupt- and cfg equals the defaults`, () => {
      mock.method(console, 'warn', () => {});
      const writes = mock.method(fs, 'writeFileSync', () => {});
      mock.method(fs, 'readFileSync', () => text);
      const cfg = load();
      assert.deepStrictEqual(cfg, defaults, 'wrong-typed root must never leak into the live config');
      assert.ok(!('0' in cfg), 'no indexed keys spread from an array/string root');
      const call = writes.mock.calls.find((c) => String(c.arguments[0]).includes('.corrupt-'));
      assert.ok(call, 'the wrong-typed file must be quarantined, not silently dropped');
      assert.strictEqual(call.arguments[1], text);
    });
  }

  it('a valid object root is NOT quarantined and keeps its overrides', () => {
    const writes = mock.method(fs, 'writeFileSync', () => {});
    mock.method(fs, 'readFileSync', () => JSON.stringify({ notifyErrors: false }));
    const cfg = load();
    assert.strictEqual(cfg.notifyErrors, false);
    assert.strictEqual(writes.mock.calls.filter((c) => String(c.arguments[0]).includes('.corrupt-')).length, 0);
  });
});
