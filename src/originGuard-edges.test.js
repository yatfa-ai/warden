import { describe, it } from 'node:test';
import assert from 'node:assert';
import { hostnameOfHostHeader, isAllowedHost, isAllowedOrigin } from './originGuard.js';

describe('hostnameOfHostHeader — bracketed-IPv6 and port grammar edges', () => {
  it('rejects text trailing a closing bracket unless it is a :port', () => {
    for (const h of ['[::1]evil', '[::1]x:80', '[::1]:abc', '[::1]:80:90', '[::1] :80']) {
      assert.strictEqual(hostnameOfHostHeader(h), null, JSON.stringify(h));
    }
  });
  it('accepts an empty port after a bracketed or plain host', () => {
    assert.strictEqual(hostnameOfHostHeader('[::1]:'), '::1');
    assert.strictEqual(hostnameOfHostHeader('localhost:'), 'localhost');
  });
  it('trims surrounding whitespace and lowercases a bracketed host', () => {
    assert.strictEqual(hostnameOfHostHeader('  LocalHost:80  '), 'localhost');
    assert.strictEqual(hostnameOfHostHeader(' [::1]:7421 '), '::1');
    assert.strictEqual(hostnameOfHostHeader('[LOCALHOST]'), 'localhost');
  });
  it('returns null for non-strings and blank values', () => {
    for (const h of [undefined, null, 42, ['localhost'], {}, '', '   ']) {
      assert.strictEqual(hostnameOfHostHeader(h), null, JSON.stringify(h));
    }
  });
});

describe('isAllowedHost — bound-host edges', () => {
  it('does not treat the literal string "undefined" as a bound host when none is bound', () => {
    assert.strictEqual(isAllowedHost('undefined', undefined), false);
    assert.strictEqual(isAllowedHost('null', null), false);
  });
  it('an empty or non-string bound host admits only loopback', () => {
    assert.strictEqual(isAllowedHost('evil.example', ''), false);
    assert.strictEqual(isAllowedHost('localhost:80', ''), true);
    assert.strictEqual(isAllowedHost('localhost:80', 42), true);
    assert.strictEqual(isAllowedHost('42', 42), false);
  });
  it('compares the bound host case-insensitively and with IPv6 brackets stripped', () => {
    assert.strictEqual(isAllowedHost('Box.Local:7421', 'BOX.local'), true);
    assert.strictEqual(isAllowedHost('[fe80::1]:7421', 'fe80::1'), true);
    assert.strictEqual(isAllowedHost('[fe80::2]:7421', 'fe80::1'), false);
    assert.strictEqual(isAllowedHost('[fe80::1]', '[fe80::1]'), true);
  });
  it('treats an array (repeated) Host header as unparsable, not as a crash', () => {
    assert.strictEqual(isAllowedHost(['localhost', 'evil.example'], '127.0.0.1'), false);
  });
  it('allows null Host like undefined', () => {
    assert.strictEqual(isAllowedHost(null, '127.0.0.1'), true);
  });
});

describe('isAllowedOrigin — scheme and type edges', () => {
  it('allows a null Origin value the same as undefined', () => {
    assert.strictEqual(isAllowedOrigin(null), true);
  });
  it('rejects non-string Origin values (duplicated header arrays, numbers)', () => {
    for (const o of [['http://localhost'], 42, {}, true]) {
      assert.strictEqual(isAllowedOrigin(o), false, JSON.stringify(o));
    }
  });
  it('rejects loopback hosts on non-http(s) schemes', () => {
    for (const o of ['ws://localhost', 'wss://127.0.0.1:7421', 'ftp://localhost', 'file://localhost/x', 'ws://[::1]']) {
      assert.strictEqual(isAllowedOrigin(o), false, o);
    }
  });
  it('matches the loopback hostname case-insensitively', () => {
    assert.strictEqual(isAllowedOrigin('http://LOCALHOST:5173'), true);
    assert.strictEqual(isAllowedOrigin('HTTPS://LocalHost'), true);
  });
});
