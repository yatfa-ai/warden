import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// WARDEN-1492 — the remote existence probe is THREE-state (exists / absent /
// failed) so a transport failure is never reported as "the file is absent", and
// the telemetry splits absent-vs-broken. The cwd-containment script is untouched
// (file-exists.test.js pins it); this pins how its result is FOLDED.

process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-fe1492-home-'));
const { probeRemoteFile, remoteFileExists } = await import('./server.js');
const { createFileExistsTelemetry, FILE_EXISTS_OPS } = await import('./fileExistsTelemetry.js');
const { createMetricAggregator } = await import('./telemetry-metrics.cjs');

const HOST = 'user@example-host';
const via = (result) => ({
  isCompanionTransportEnabled: () => false,
  run: async () => result,
});
const res = (o) => ({ host: HOST, ok: false, code: 0, stdout: '', stderr: '', ...o });

describe('probeRemoteFile — three-state verdict', () => {
  it('EXISTS marker ⇒ exists', async () => {
    const r = await probeRemoteFile(HOST, '/work', 'a.js', via(res({ ok: true, stdout: 'EXISTS\n' })));
    assert.deepEqual(r, { state: 'exists' });
  });

  for (const marker of [
    'ERROR file not found',
    'ERROR invalid path',
    'ERROR path must be within working directory',
    'ERROR path is a directory',
    'ERROR not a file',
  ]) {
    it(`script verdict "${marker}" ⇒ conclusive absent`, async () => {
      const r = await probeRemoteFile(HOST, '/work', 'a.js', via(res({ code: 1, stdout: `${marker}\n` })));
      assert.deepEqual(r, { state: 'absent' });
    });
  }

  it('a stderr-only ERROR line can never forge an absent verdict', async () => {
    const r = await probeRemoteFile(HOST, '/work', 'a.js', via(res({ code: 255, stderr: 'ERROR file not found\n' })));
    assert.equal(r.state, 'failed');
  });

  it('transport error (code -1, no stdout) ⇒ failed/error, not absent', async () => {
    const r = await probeRemoteFile(HOST, '/work', 'a.js', via(res({ code: -1, stderr: 'ssh: connect to host x port 22: Connection refused' })));
    assert.deepEqual(r, { state: 'failed', reason: 'error' });
  });

  it('a rejecting transport ⇒ failed (never throws)', async () => {
    const r = await probeRemoteFile(HOST, '/work', 'a.js', {
      isCompanionTransportEnabled: () => false,
      run: async () => { throw new Error('boom'); },
    });
    assert.equal(r.state, 'failed');
  });

  it('a transport that hangs past the timeout is cut at the boundary ⇒ failed/timeout', async () => {
    const started = Date.now();
    const r = await probeRemoteFile(HOST, '/work', 'a.js', {
      isCompanionTransportEnabled: () => false,
      run: () => new Promise(() => {}), // never settles
      probeTimeoutMs: 40,
      probeDeadlineGraceMs: 10,
    });
    assert.deepEqual(r, { state: 'failed', reason: 'timeout' });
    assert.ok(Date.now() - started < 1000, 'the caller is not held past the configured boundary');
  });

  it('the script timeout handed to the transport is still 8000ms', async () => {
    let seen;
    await probeRemoteFile(HOST, '/work', 'a.js', {
      isCompanionTransportEnabled: () => false,
      run: async (h, s, opts) => { seen = opts.timeout; return res({ ok: true, stdout: 'EXISTS' }); },
    });
    assert.equal(seen, 8000);
  });

  it('remoteFileExists keeps its boolean contract (failed ⇒ false)', async () => {
    assert.equal(await remoteFileExists(HOST, '/work', 'a.js', via(res({ ok: true, stdout: 'EXISTS' }))), true);
    assert.equal(await remoteFileExists(HOST, '/work', 'a.js', via(res({ code: 1, stdout: 'ERROR not a file' }))), false);
    assert.equal(await remoteFileExists(HOST, '/work', 'a.js', via(res({ code: -1 }))), false);
  });
});

describe('telemetry — absent vs broken are separate buckets', () => {
  const OP_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
  function harness() {
    return createFileExistsTelemetry({
      consent: () => true,
      send: () => {},
      aggregator: createMetricAggregator({ now: () => 0 }),
    });
  }

  it('failures never fold into file-exists-remote; they get their own operations', () => {
    const tel = harness();
    tel.recordProbe('remote', 30, true);   // exists
    tel.recordProbe('remote', 40, false);  // conclusive absent
    tel.recordRemoteFailure('error', 120);
    tel.recordRemoteFailure('timeout', 9000);
    const snap = tel.flushNow();
    const byOp = Object.fromEntries(snap.operations.map((o) => [o.operation, o]));
    assert.equal(byOp[FILE_EXISTS_OPS.REMOTE].count, 2);
    assert.equal(byOp[FILE_EXISTS_OPS.REMOTE].okCount, 1);
    assert.equal(byOp[FILE_EXISTS_OPS.REMOTE].failCount, 1);
    assert.equal(byOp[FILE_EXISTS_OPS.REMOTE_FAILED].count, 1);
    assert.equal(byOp[FILE_EXISTS_OPS.REMOTE_TIMEOUT].count, 1);
    assert.equal(byOp[FILE_EXISTS_OPS.REMOTE_TIMEOUT].max, 9000);
    for (const op of snap.operations) assert.match(op.operation, OP_NAME_RE);
  });

  it('recordRemoteFailure is consent-gated', () => {
    const tel = createFileExistsTelemetry({ consent: () => false, send: () => {} });
    assert.equal(tel.recordRemoteFailure('timeout', 5), false);
  });
});
