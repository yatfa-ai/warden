// Unit tests for electron/external-nav.cjs (WARDEN-1906): the classifier that
// routes window.open / target=_blank / will-navigate to the system browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { classifyNavigation } = require('../electron/external-nav.cjs');

const APP = 'http://127.0.0.1:7421';

test('https URL on another host is classified external', () => {
  assert.equal(classifyNavigation('https://example.com/a?b=1', APP), 'external');
});

test('http URL on another host is classified external', () => {
  assert.equal(classifyNavigation('http://example.com/', APP), 'external');
});

test("the app's own loopback origin is allowed", () => {
  assert.equal(classifyNavigation('http://127.0.0.1:7421/?_t=1', APP), 'allow');
  assert.equal(classifyNavigation('http://127.0.0.1:7421/', APP), 'allow');
});

test('same host on a different port is external, not allowed', () => {
  assert.equal(classifyNavigation('http://127.0.0.1:9999/', APP), 'external');
});

test('same host over https (different origin) is external', () => {
  assert.equal(classifyNavigation('https://127.0.0.1:7421/', APP), 'external');
});

test('lookalike hosts are NOT treated as the app origin', () => {
  const app = 'http://localhost:7421';
  assert.equal(classifyNavigation('http://localhost.evil.com:7421/', app), 'external');
  // `localhost:7421.evil.com` is not a valid URL (non-numeric port) → deny, never allow.
  assert.equal(classifyNavigation('http://localhost:7421.evil.com/', app), 'deny');
  assert.equal(classifyNavigation('http://evil.com/http://localhost:7421/', app), 'external');
  assert.equal(classifyNavigation('http://user@localhost.evil.com/', app), 'external');
});

test('non-http(s) schemes are denied', () => {
  assert.equal(classifyNavigation('file:///etc/passwd', APP), 'deny');
  assert.equal(classifyNavigation('javascript:alert(1)', APP), 'deny');
  assert.equal(classifyNavigation('data:text/html,<h1>x</h1>', APP), 'deny');
  assert.equal(classifyNavigation('ftp://example.com/', APP), 'deny');
});

test('malformed or empty URLs are denied', () => {
  assert.equal(classifyNavigation('not a url', APP), 'deny');
  assert.equal(classifyNavigation('', APP), 'deny');
  assert.equal(classifyNavigation(undefined, APP), 'deny');
});

test('a missing/invalid app origin never allows, http(s) stays external', () => {
  assert.equal(classifyNavigation('http://127.0.0.1:7421/', undefined), 'external');
  assert.equal(classifyNavigation('http://127.0.0.1:7421/', 'garbage'), 'external');
});
