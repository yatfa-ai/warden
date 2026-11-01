import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';

/**
 * Shared body for the four telemetry wiring tests: the WARDEN-1578 ssh-run
 * pair and the WARDEN-1598 companion-rpc pair. Each ON/OFF twin boots
 * server.js with a different consent posture, and server.js evaluates its
 * config at import, so the four files MUST stay separate processes — only the
 * shared body lives here. The file is .mjs on purpose:
 * companion-totality.test.js and loop-monitor-coverage.test.js read every
 * non-.test.js .js file in src/ as runtime source, and node --test only
 * auto-runs *.test.*, so an .mjs helper is invisible to both.
 */

const SUBJECTS = {
  'ssh-run': {
    label: 'ssh-run',
    tempPrefix: 'warden-sshtel-home-',
    operation: 'ssh-run',
    secrets: ['secret-host'],
    telemetry: (mod) => mod.sshTelemetry,
    async prepare() {
      const ssh = await import('./ssh.js');
      function fakeChild() {
        const c = new EventEmitter();
        c.stdout = Object.assign(new EventEmitter(), { setEncoding() {} });
        c.stderr = Object.assign(new EventEmitter(), { setEncoding() {} });
        c.kill = () => {};
        return c;
      }
      return async function drive() {
        let child;
        const p = ssh.run('secret-host.example.com', 'git push', { spawn: () => { child = fakeChild(); return child; }, timeout: 60000 });
        child.emit('close', 0);
        await p;
      };
    },
  },
  'companion-rpc': {
    label: 'companion-rpc-exec',
    tempPrefix: 'warden-companionrpctel-home-',
    operation: 'companion-rpc-exec',
    secrets: ['secret-host', 'git push'],
    telemetry: (mod) => mod.companionRpcTelemetry,
    async prepare() {
      const companion = await import('./companion.js');
      function fakeTransport(handler) {
        let lineCB = null;
        return {
          write(line) { const resp = handler(JSON.parse(line)); setImmediate(() => lineCB(JSON.stringify(resp))); },
          onLine(cb) { lineCB = cb; }, onExit() {}, kill() {},
        };
      }
      return async function drive() {
        const ch = new companion.CompanionChannel('secret-host.example.com',
          fakeTransport((r) => ({ id: r.id, ok: true, result: { ok: 1 } })));
        await ch.call('exec', { cmd: 'git push --force' }, { timeout: 500 });
        await ch.call('ping', {}, { timeout: 500 });
      };
    },
  },
};

export function defineTelemetryWiringTest(subjectName, consent) {
  const subject = SUBJECTS[subjectName];
  let originalHome; let tempHome; let mod; let drive;
  const sent = [];

  before(async () => {
    originalHome = process.env.HOME;
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), subject.tempPrefix));
    process.env.HOME = tempHome;
    const dir = path.join(tempHome, '.yatfa-warden');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(
      consent ? { hosts: [], telemetryOperationalMetricsEnabled: true } : { hosts: [] },
    ));
    process.send = (msg) => sent.push(msg);
    mod = await import('./server.js');
    drive = await subject.prepare();
  });

  after(() => {
    delete process.send;
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    try { fs.rmSync(tempHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  describe(`${subjectName} telemetry wiring (consent ${consent ? 'ON' : 'OFF'})`, () => {
    it(consent ? `a run() observation is forwarded as telemetry-metrics with ${subject.label}` : 'a run() observation is dropped: nothing retained, nothing forwarded', async () => {
      await drive();
      const snap = subject.telemetry(mod).flushNow();
      if (!consent) {
        assert.equal(snap, null);
        assert.deepEqual(sent, []);
        return;
      }
      assert.ok(snap);
      assert.equal(sent.length, 1);
      assert.equal(sent[0].type, 'telemetry-metrics');
      assert.deepEqual(sent[0].snapshot.operations.map((o) => o.operation), [subject.operation]);
      assert.equal(sent[0].snapshot.operations[0].count, 1);
      assert.equal(sent[0].snapshot.operations[0].okCount, 1);
      for (const secret of subject.secrets) {
        assert.equal(JSON.stringify(sent[0]).includes(secret), false);
      }
    });
  });
}
