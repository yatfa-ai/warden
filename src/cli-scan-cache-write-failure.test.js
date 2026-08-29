import { describe, it } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * WARDEN-1226: `warden scan` writes its chat cache WITHOUT awaiting
 * `writeCache()` (cli.js cmdScan). The write helper is async (atomic
 * temp+fsync+rename, WARDEN-831), so a failing write's rejection is dropped,
 * escapes as an unhandled rejection, and kills the process with a raw stack
 * trace — AFTER the command already printed a successful listing. Every other
 * write call site in cli.js awaits; this pins the scan failure path to the
 * CLI's uniform error handler (`main().catch((e) => die(e.message))`).
 *
 * The failure is staged physically: cache.json is replaced by a directory, so
 * the atomic rename fails with EISDIR — a real failed write, not a mock.
 */
describe('cmdScan cache-write failure flows through the CLI error path (WARDEN-1226)', () => {
  const cli = path.join(import.meta.dirname, 'cli.js');

  it('reports the failure via `warden: <msg>` and exits 1 — no stack trace, no unhandled rejection', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-1226-'));
    try {
      fs.mkdirSync(path.join(home, '.yatfa-warden', 'cache.json'), { recursive: true }); // dir ⇒ rename fails
      const r = spawnSync(process.execPath, [cli, 'scan', '--json'], {
        env: { ...process.env, HOME: home },
        encoding: 'utf8',
      });
      assert.strictEqual(r.status, 1, `expected exit 1, got ${r.status}\nstderr: ${r.stderr}`);
      assert.match(r.stderr, /^warden: /m, 'failure must surface through die(), the uniform error path');
      assert.ok(!r.stderr.includes('UnhandledPromiseRejection') && !r.stderr.includes('node:internal'),
        'must not crash with a raw stack trace');
      assert.ok(!r.stderr.includes('at '), 'no stack frames in stderr');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('a successful scan is unchanged: JSON listing on stdout, exit 0', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-1226-ok-'));
    try {
      const r = spawnSync(process.execPath, [cli, 'scan', '--json'], {
        env: { ...process.env, HOME: home },
        encoding: 'utf8',
      });
      assert.strictEqual(r.status, 0, `expected exit 0, got ${r.status}\nstderr: ${r.stderr}`);
      const out = JSON.parse(r.stdout);
      assert.ok(Array.isArray(out.chats) && Array.isArray(out.errors));
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
