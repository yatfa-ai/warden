import { describe, it, before, after, mock } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// startServer's listen-failure handler is the one place the backend turns a bind
// failure into an actionable message and a non-zero exit. scripts/start.mjs relays
// that exit code and electron/main.cjs reacts to the backend child exiting, so a
// regression to exit(0) would make `npm start` report success with no server.
// No other test calls startServer or spawns src/server.js.

const SERVER_JS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'server.js');

describe('startServer listen-error handler', () => {
  let tmpHome;
  let origHome;
  let blocker;
  let blockedPort;

  before(async () => {
    origHome = process.env.HOME;
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-listen-err-'));
    process.env.HOME = tmpHome;
    blocker = net.createServer();
    await new Promise((resolve, reject) => {
      blocker.once('error', reject);
      blocker.listen(0, '127.0.0.1', resolve);
    });
    blockedPort = blocker.address().port;
  });

  after(async () => {
    await new Promise((resolve) => blocker.close(resolve));
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('EADDRINUSE: real process prints the port + PORT=<other> remedy and exits 1', async () => {
    const child = spawn(process.execPath, [SERVER_JS], {
      env: { ...process.env, HOME: tmpHome, PORT: String(blockedPort) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 20000);
    const [code, signal] = await new Promise((resolve) => {
      child.on('exit', (c, s) => resolve([c, s]));
    });
    clearTimeout(timer);

    assert.strictEqual(signal, null, `server must exit on its own, stderr: ${stderr}`);
    assert.strictEqual(code, 1);
    assert.ok(stderr.includes(`port ${blockedPort} is already in use`), stderr);
    assert.ok(stderr.includes('PORT=<other> npm start'), stderr);
    assert.ok(!stdout.includes('warden ui →'), 'must not announce a running UI');
  });

  it('any other listen error prints `warden: server error: <msg>` and exits 1', async () => {
    const { startServer } = await import('./server.js');
    const errSpy = mock.method(console, 'error', () => {});
    let exitCode;
    let resolveExit;
    const exited = new Promise((r) => { resolveExit = r; });
    mock.method(process, 'exit', (c) => { exitCode = c; resolveExit(); });
    try {
      // TEST-NET-3: never a local interface -> EADDRNOTAVAIL on bind.
      startServer(0, '203.0.113.9');
      await exited;
      assert.strictEqual(exitCode, 1);
      const calls = errSpy.mock.calls.map((c) => c.arguments);
      assert.strictEqual(calls.length, 1);
      const line = calls[0].join(' ');
      assert.match(line, /^warden: server error: .*(EADDRNOTAVAIL|assign requested address)/);
      assert.ok(!line.includes('already in use'), line);
    } finally {
      process.exit.mock.restore();
      errSpy.mock.restore();
    }
  });
});
