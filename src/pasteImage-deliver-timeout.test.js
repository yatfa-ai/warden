import { describe, it, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { deliverPastedImage, DELIVER_TIMEOUT_MS } from './pasteImage.js';

function pngHeader() {
  const b = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8); b.write('IHDR', 12, 'ascii');
  b.writeUInt32BE(800, 16); b.writeUInt32BE(600, 20);
  return b;
}
function fakeChild() {
  const child = new EventEmitter();
  child.kills = [];
  child.stdin = Object.assign(new EventEmitter(), { end() {} });
  child.stdout = Object.assign(new EventEmitter(), { resume() {} });
  child.stderr = Object.assign(new EventEmitter(), { setEncoding() {} });
  child.kill = (sig) => { child.kills.push(sig); };
  return child;
}
const chat = { host: 'box', container: 'c' };

describe('deliverPastedImage — the DELIVER_TIMEOUT_MS deadline on a wedged child', () => {
  afterEach(() => { mock.timers.reset(); });
  it('SIGKILLs a child that never exits/closes, exactly once, at the deadline and not before', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const child = fakeChild();
    const p = deliverPastedImage(chat, {}, pngHeader(), { spawn: () => child });
    mock.timers.tick(DELIVER_TIMEOUT_MS - 1);
    assert.deepEqual(child.kills, []);
    mock.timers.tick(1);
    assert.deepEqual(child.kills, ['SIGKILL']);
    const r = await p;
    assert.equal(r.ok, false);
    assert.equal(r.marker, undefined);
    mock.timers.tick(DELIVER_TIMEOUT_MS * 3);
    assert.deepEqual(child.kills, ['SIGKILL']);
  });
  it('reports "timed out after <ms>ms" and keeps the stderr gathered so far', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const child = fakeChild();
    const p = deliverPastedImage(chat, {}, pngHeader(), { spawn: () => child });
    child.stderr.emit('data', 'Warning: slow link\n');
    mock.timers.tick(DELIVER_TIMEOUT_MS);
    const r = await p;
    assert.equal(r.ok, false);
    assert.match(r.error, /Warning: slow link/);
    assert.match(r.error, new RegExp(`timed out after ${DELIVER_TIMEOUT_MS}ms`));
  });
  it('a child that closes normally clears the deadline: no later SIGKILL', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const child = fakeChild();
    const p = deliverPastedImage(chat, {}, pngHeader(), { spawn: () => child });
    child.emit('close', 0);
    assert.equal((await p).ok, true);
    mock.timers.tick(DELIVER_TIMEOUT_MS * 2);
    assert.deepEqual(child.kills, []);
  });
  it('a failed (non-zero close) delivery also clears the deadline', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const child = fakeChild();
    const p = deliverPastedImage(chat, {}, pngHeader(), { spawn: () => child });
    child.stderr.emit('data', 'boom');
    child.emit('close', 2);
    const r = await p;
    assert.equal(r.ok, false);
    assert.match(r.error, /boom/);
    mock.timers.tick(DELIVER_TIMEOUT_MS * 2);
    assert.deepEqual(child.kills, []);
  });
  it('a kill() that throws still settles the delivery (best-effort kill)', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const child = fakeChild();
    child.kill = () => { throw new Error('ESRCH'); };
    const p = deliverPastedImage(chat, {}, pngHeader(), { spawn: () => child });
    mock.timers.tick(DELIVER_TIMEOUT_MS);
    const r = await p;
    assert.equal(r.ok, false);
    assert.match(r.error, /timed out/);
  });
});
