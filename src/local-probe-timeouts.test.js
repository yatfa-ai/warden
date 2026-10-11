import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// WARDEN-1752: the local `claude --version` probe (detectClaude) and
// streamBoundedSearch armed no timeout, so a hung child left the awaited promise
// pending forever. Fake binary first on PATH: `exec sleep` so SIGTERM hits the
// sleep itself, not an sh wrapper that would orphan it with the pipes open.

process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-probe-home-'));
const { detectClaude } = await import('./ssh.js');
const { streamBoundedSearch } = await import('./workspaceSearch.js');

const BIN = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-probe-bin-'));
const PIDFILE = path.join(BIN, 'pid');
const origPath = process.env.PATH;
const origExec = process.env.CLAUDE_CODE_EXECPATH;

function writeBin(name, body) {
  const p = path.join(BIN, name);
  fs.writeFileSync(p, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
}
function alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
async function waitDead(pid, ms = 2000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (!alive(pid)) return true; await new Promise((r) => setTimeout(r, 25)); }
  return !alive(pid);
}
const settledWithin = (p, ms) => Promise.race([
  p.then((v) => ({ settled: true, v })),
  new Promise((r) => setTimeout(() => r({ settled: false }), ms)),
]);

const skip = process.platform === 'win32';

describe('local probe timeouts (WARDEN-1752)', { skip }, () => {
  before(() => {
    process.env.PATH = `${BIN}${path.delimiter}${origPath}`;
    delete process.env.CLAUDE_CODE_EXECPATH;
  });
  after(() => {
    process.env.PATH = origPath;
    if (origExec === undefined) delete process.env.CLAUDE_CODE_EXECPATH; else process.env.CLAUDE_CODE_EXECPATH = origExec;
    fs.rmSync(BIN, { recursive: true, force: true });
  });

  describe('detectClaude (local)', () => {
    it('hung `claude --version` => resolves null shortly after the timeout and kills the child', async () => {
      writeBin('claude', `echo $$ > "${PIDFILE}"\nexec sleep 300`);
      const r = await settledWithin(detectClaude('(local)', { claudeProbeTimeoutMs: 150 }), 3000);
      assert.ok(r.settled, 'detectClaude must settle despite the hung child');
      assert.strictEqual(r.v, null);
      const pid = Number(fs.readFileSync(PIDFILE, 'utf8').trim());
      assert.ok(await waitDead(pid), 'hung child must be killed');
    });

    it('fast successful probe is unaffected', async () => {
      writeBin('claude', 'exit 0');
      assert.strictEqual(await detectClaude('(local)', { claudeProbeTimeoutMs: 5000 }), 'claude');
    });

    it('fast failing probe still resolves null', async () => {
      writeBin('claude', 'exit 1');
      assert.strictEqual(await detectClaude('(local)', { claudeProbeTimeoutMs: 5000 }), null);
    });
  });

  describe('streamBoundedSearch', () => {
    it('hung child => settles after timeout and kills the child', async () => {
      writeBin('hungsearch', `echo $$ > "${PIDFILE}"\nexec sleep 300`);
      const r = await settledWithin(streamBoundedSearch('hungsearch', [], BIN, { timeout: 150 }), 3000);
      assert.ok(r.settled, 'streamBoundedSearch must settle despite the hung child');
      assert.strictEqual(r.v, '');
      const pid = Number(fs.readFileSync(PIDFILE, 'utf8').trim());
      assert.ok(await waitDead(pid), 'hung child must be killed');
    });

    it('returns the partial lines collected before the timeout', async () => {
      writeBin('partialsearch', `echo $$ > "${PIDFILE}"\nprintf 'a:1:x\\nb:2:y\\n'\nexec sleep 300`);
      const r = await settledWithin(streamBoundedSearch('partialsearch', [], BIN, { timeout: 400 }), 3000);
      assert.ok(r.settled);
      assert.strictEqual(r.v, 'a:1:x\nb:2:y');
    });

    it('fast child is unaffected by the timer', async () => {
      writeBin('fastsearch', "printf 'a:1:x\\n'");
      const out = await streamBoundedSearch('fastsearch', [], BIN, { timeout: 5000 });
      assert.strictEqual(out, 'a:1:x');
    });
  });
});
