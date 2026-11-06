// Pins the two SYNCHRONOUS spawn-failure legs of src/companionTransport.js that
// no other test drives: spawnPersistentChannel's try/catch around spawnFn
// (-> makeDeadTransport) and streamFileToHost's try/catch (-> {ok:false, code:-1,
// stderr:'spawn failed: …'}). child_process.spawn throws synchronously for an
// argv it refuses (ERR_INVALID_ARG_VALUE on a NUL byte, EAGAIN/E2BIG-class
// failures); the contract is that the failure is DATA — a channel that dies on the
// next macrotask / a resolved failed-upload result — never an exception that
// escapes into getChannel's bootstrap or the HTTP request.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  CompanionChannel, CompanionTransportError, spawnPersistentChannel, streamFileToHost,
} from './companionTransport.js';
import { SSH_BIN } from './ssh.js';

const throwingSpawn = (msg = 'spawn ssh EINVAL') => {
  const calls = [];
  const fn = (bin, args, opts) => { calls.push({ bin, args, opts }); throw new Error(msg); };
  fn.calls = calls;
  return fn;
};
const nextMacrotask = () => new Promise((r) => setImmediate(r));

describe('spawnPersistentChannel — a synchronous spawn throw becomes a dead transport, not an exception', () => {
  it('does not throw: it returns a transport and attempted exactly one spawn of SSH_BIN', () => {
    const spawnFn = throwingSpawn();
    let transport;
    assert.doesNotThrow(() => { transport = spawnPersistentChannel('prod-1', '/remote/p', {}, spawnFn); });
    assert.equal(spawnFn.calls.length, 1);
    assert.equal(spawnFn.calls[0].bin, SSH_BIN);
    for (const m of ['write', 'onLine', 'onExit', 'kill']) {
      assert.equal(typeof transport[m], 'function', `transport.${m} is callable`);
    }
  });

  it('the channel built on it is alive in the constructor tick and dies on the NEXT macrotask with the spawn message', async () => {
    const ch = new CompanionChannel('prod-1', spawnPersistentChannel('prod-1', '/remote/p', {}, throwingSpawn('boom: E2BIG')));
    assert.equal(ch.dead, false, 'death is deferred so the constructor (which assigns onExit AFTER) still observes it');
    await nextMacrotask();
    assert.equal(ch.dead, true);
    assert.equal(ch._diedWith.message, 'failed to spawn companion ssh: boom: E2BIG');
  });

  it('a call() on that channel rejects with a CompanionTransportError naming the spawn failure; nothing is left pending', async () => {
    const ch = new CompanionChannel('prod-1', spawnPersistentChannel('prod-1', '/remote/p', {}, throwingSpawn('boom')));
    await nextMacrotask();
    await assert.rejects(
      () => ch.call('exec', { script: 'true' }),
      (e) => {
        assert.ok(e instanceof CompanionTransportError);
        assert.equal(e.host, 'prod-1');
        assert.match(e.message, /channel is dead \(failed to spawn companion ssh: boom\); cannot send 'exec'/);
        return true;
      },
    );
    assert.equal(ch.pending.size, 0, 'no request was left pending on the dead channel');
  });

  it('a request already in flight when the deferred death lands is rejected with the spawn error', async () => {
    const ch = new CompanionChannel('prod-1', spawnPersistentChannel('prod-1', '/remote/p', {}, throwingSpawn('boom')));
    const inflight = ch.call('exec', { script: 'true' }, { timeout: 5000 });
    await assert.rejects(inflight, /failed to spawn companion ssh: boom/);
  });

  it('onDead handlers registered before the tick fire once with the spawn error; a late registrant still learns of it', async () => {
    const ch = new CompanionChannel('prod-1', spawnPersistentChannel('prod-1', '/remote/p', {}, throwingSpawn('boom')));
    const early = [];
    ch.onDead((e) => early.push(e.message));
    await nextMacrotask();
    assert.deepEqual(early, ['failed to spawn companion ssh: boom']);
    const late = [];
    ch.onDead((e) => late.push(e.message));
    assert.deepEqual(late, ['failed to spawn companion ssh: boom']);
  });

  it('kill() on the dead transport is a harmless no-op', async () => {
    const ch = new CompanionChannel('prod-1', spawnPersistentChannel('prod-1', '/remote/p', {}, throwingSpawn()));
    await nextMacrotask();
    assert.doesNotThrow(() => ch.kill());
    assert.equal(ch.dead, true);
  });
});

describe('streamFileToHost — a synchronous spawn throw resolves a failed upload instead of rejecting', () => {
  it("resolves {ok:false, code:-1, stderr:'spawn failed: <message>'} after exactly one spawn of SSH_BIN", async () => {
    const spawnFn = throwingSpawn('spawn ssh EINVAL');
    const res = await streamFileToHost('prod-1', '/nonexistent/warden-companion.bin', '/remote/p', {}, spawnFn);
    assert.deepEqual(res, { ok: false, code: -1, stderr: 'spawn failed: spawn ssh EINVAL' });
    assert.equal(spawnFn.calls.length, 1);
    assert.equal(spawnFn.calls[0].bin, SSH_BIN);
  });
});
