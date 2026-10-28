import { describe, it } from 'node:test';
import assert from 'node:assert';
import { boundHostOf, hostGuardMiddleware } from './originGuard.js';

/**
 * WARDEN-1994 — pins the wiring half of src/originGuard.js (WARDEN-1896):
 * `boundHostOf` and the `hostGuardMiddleware(getBoundHost)` thunk / non-loopback
 * bind / 403-body contract. The pure predicates are pinned elsewhere
 * (wsLayer-origin-guard.test.js, originGuard-http.test.js); the real-server
 * tests there bind 127.0.0.1, where the bound-host arm is indistinguishable
 * from the loopback arm. Pure unit tests: fake res / fake server, no ports.
 */

function fakeRes() {
  const res = { statusCode: undefined, contentType: undefined, body: undefined, sends: 0 };
  res.status = (c) => { res.statusCode = c; return res; };
  res.type = (t) => { res.contentType = t; return res; };
  res.send = (b) => { res.body = b; res.sends += 1; return res; };
  return res;
}

function run(mw, host) {
  const res = fakeRes();
  let nextCalls = 0;
  const req = { headers: host === undefined ? {} : { host } };
  mw(req, res, () => { nextCalls += 1; });
  return { res, nextCalls };
}

function assertAdmitted({ res, nextCalls }) {
  assert.strictEqual(nextCalls, 1, 'next called exactly once');
  assert.strictEqual(res.statusCode, undefined, 'no status written');
  assert.strictEqual(res.sends, 0, 'no body written');
}

function assertForbidden({ res, nextCalls }) {
  assert.strictEqual(nextCalls, 0, 'next not called');
  assert.strictEqual(res.statusCode, 403);
  assert.strictEqual(res.contentType, 'text/plain');
  assert.strictEqual(res.body, 'Forbidden: unexpected Host header');
  assert.strictEqual(res.sends, 1);
}

describe('boundHostOf (WARDEN-1994)', () => {
  it('returns the .address of a TCP-style address object', () => {
    const server = { address: () => ({ address: '10.0.0.5', family: 'IPv4', port: 7421 }) };
    assert.strictEqual(boundHostOf(server), '10.0.0.5');
  });

  it('returns undefined for a pipe path string, pre-listen null, a throwing address() and a null server — never throws', () => {
    assert.strictEqual(boundHostOf({ address: () => '/tmp/warden.sock' }), undefined);
    assert.strictEqual(boundHostOf({ address: () => null }), undefined);
    assert.strictEqual(boundHostOf({ address: () => { throw new Error('boom'); } }), undefined);
    assert.strictEqual(boundHostOf(null), undefined);
  });
});

describe('hostGuardMiddleware (WARDEN-1994)', () => {
  it('admits loopback hosts and a missing Host: next once, nothing written', () => {
    const mw = hostGuardMiddleware(() => undefined);
    for (const h of ['localhost', '127.0.0.1:7421', '[::1]:7421', undefined]) {
      assertAdmitted(run(mw, h));
    }
  });

  it('rejects a foreign host with exactly 403 / text/plain / the Host body, next not called', () => {
    assertForbidden(run(hostGuardMiddleware(() => undefined), 'evil.example:7421'));
  });

  it('rejects an unparsable Host (a:b:c) with the same 403 contract', () => {
    assertForbidden(run(hostGuardMiddleware(() => undefined), 'a:b:c'));
  });

  it('non-loopback bind: the thunk-returned address is admitted, a sibling address is rejected', () => {
    const mw = hostGuardMiddleware(() => '10.0.0.5');
    assertAdmitted(run(mw, '10.0.0.5:7421'));
    assertForbidden(run(mw, '10.0.0.6:7421'));
  });

  it('reads the thunk per request (bind happens after module load) on the SAME middleware instance', () => {
    let bound;
    const mw = hostGuardMiddleware(() => bound);
    assertForbidden(run(mw, '10.0.0.5:7421'));
    bound = '10.0.0.5';
    assertAdmitted(run(mw, '10.0.0.5:7421'));
  });

  it('composes with boundHostOf: a fake server bound to a non-loopback address admits only that Host', () => {
    const server = { address: () => ({ address: '10.0.0.5', port: 7421 }) };
    const mw = hostGuardMiddleware(() => boundHostOf(server));
    assertAdmitted(run(mw, '10.0.0.5'));
    assertForbidden(run(mw, 'evil.example'));
  });

  it('tolerates no thunk: loopback passes, non-loopback is 403, nothing throws', () => {
    const mw = hostGuardMiddleware();
    assertAdmitted(run(mw, '127.0.0.1:7421'));
    assertForbidden(run(mw, '10.0.0.5:7421'));
  });
});
