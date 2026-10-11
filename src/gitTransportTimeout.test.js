import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runLocalGit, runGit, LOCAL, LOCAL_GIT_TIMEOUT_MS } from './gitTransport.js';

/**
 * WARDEN-1742: the LOCAL git / local docker-exec-git probes must be bounded.
 * runLocalCapture arms its SIGTERM timer only when given a timeout; runLocalGit and
 * runGit's container+LOCAL leg used to pass none, so a hung child never resolved.
 *
 * Hang stand-in: fake `git` / `docker` first on PATH that `exec sleep` (exec matters —
 * without it SIGTERM hits only the sh wrapper and the orphaned sleep keeps the stdio
 * pipes open, so 'close' never fires). setTimeout is mocked so the 15s bound can be
 * crossed instantly; the real SIGTERM then closes the real child.
 */
describe('WARDEN-1742 local git timeout', () => {
  let dir;
  let oldPath;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'w1742-'));
    oldPath = process.env.PATH;
  });
  afterEach(() => {
    mock.timers.reset();
    process.env.PATH = oldPath;
    rmSync(dir, { recursive: true, force: true });
  });
  const stub = (name, body) => {
    const f = join(dir, name);
    writeFileSync(f, `#!/bin/sh\n${body}\n`);
    chmodSync(f, 0o755);
    process.env.PATH = `${dir}:${oldPath}`;
  };

  it('exports a 15s bound', () => {
    assert.strictEqual(LOCAL_GIT_TIMEOUT_MS, 15000);
  });

  it('runLocalGit resolves {ok:false, code:-1} when git hangs', async () => {
    stub('git', 'exec sleep 300');
    mock.timers.enable({ apis: ['setTimeout'] });
    const p = runLocalGit(['status'], dir);
    mock.timers.tick(LOCAL_GIT_TIMEOUT_MS);
    const r = await p;
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, -1);
  });

  it('runGit container+LOCAL resolves {ok:false, code:-1} when docker exec hangs', async () => {
    stub('docker', 'exec sleep 300');
    mock.timers.enable({ apis: ['setTimeout'] });
    const p = runGit({ container: 'c1', host: LOCAL }, ['status'], '/w');
    mock.timers.tick(LOCAL_GIT_TIMEOUT_MS);
    const r = await p;
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, -1);
  });

  it('a fast successful git resolves ok with full stdout and is not killed', async () => {
    stub('git', 'printf "hello\\n"');
    mock.timers.enable({ apis: ['setTimeout'] });
    const r = await runLocalGit(['status'], dir);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.stdout, 'hello\n');
  });

  it('a fast successful docker exec resolves ok with full stdout', async () => {
    stub('docker', 'printf "ok\\n"');
    mock.timers.enable({ apis: ['setTimeout'] });
    const r = await runGit({ container: 'c1', host: LOCAL }, ['status'], '/w');
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.stdout, 'ok\n');
  });
});
