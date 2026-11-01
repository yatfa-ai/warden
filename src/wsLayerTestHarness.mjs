import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';

/**
 * Shared boot/teardown scaffold for the process-survival wsLayer-*.test.js files.
 *
 * Must stay `.mjs`: companion-totality.test.js and loop-monitor-coverage.test.js scan every
 * non-`.test` `.js` file in src/ as runtime source, so a `.js` test helper would be swept in.
 *
 * Order matters: HOME is redirected to a temp dir BEFORE `./wsLayer.js` is first imported,
 * because sessions.js freezes its data dir at import time. `prepare` runs in that window
 * (after the redirect, before the import) and carries per-file fixture setup.
 *
 * Returns { httpServer, port, tempHome, wdir, sessionsDir, close }. `close()` shuts the
 * server and restores every saved env var (deleting those that were unset) and removes
 * the temp home. Listener registration (unhandledRejection etc.) stays with the caller.
 */
export async function bootWsLayer({
  prefix,
  extraEnv = [],
  prepare,
  resolve = async () => ({ error: 'unused' }),
  chatCatalog = { snapshot: () => [], has: () => true },
  cfg = { connectTimeout: 1, hosts: [] },
} = {}) {
  const names = ['HOME', 'ANTHROPIC_AUTH_TOKEN', ...extraEnv];
  const saved = Object.fromEntries(names.map((k) => [k, process.env[k]]));
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const restore = () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    try { fs.rmSync(tempHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  };

  process.env.HOME = tempHome;
  process.env.ANTHROPIC_AUTH_TOKEN = 'test-token';
  const wdir = path.join(tempHome, '.yatfa-warden');
  const sessionsDir = path.join(wdir, 'sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });

  let httpServer;
  try {
    if (prepare) await prepare({ tempHome, wdir, sessionsDir });
    const { setupWsLayer } = await import('./wsLayer.js');
    httpServer = http.createServer(() => {});
    setupWsLayer({ server: httpServer, cfg, resolve, chatCatalog });
    await new Promise((res, rej) => {
      httpServer.once('error', rej);
      httpServer.listen(0, '127.0.0.1', res);
    });
  } catch (err) {
    if (httpServer?.listening) await new Promise((r) => httpServer.close(r));
    restore();
    throw err;
  }

  const close = async () => {
    await new Promise((r) => { httpServer.closeAllConnections?.(); httpServer.close(r); });
    restore();
  };
  return { httpServer, port: httpServer.address().port, tempHome, wdir, sessionsDir, close };
}
