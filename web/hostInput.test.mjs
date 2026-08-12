// Tests for the typed-host validator behind Settings → Hosts & Connection's new
// "add a host by typing its name" affordance (WARDEN-940).
//
// Before this, the ONLY add path was a Select scraped out of ~/.ssh/config, and
// that whole block was hidden when the picker had nothing to offer — an empty
// ssh config meant a settings screen with no way to add a host at all. The typed
// path routes through validateNewHost, so these are the rules standing between a
// keystroke and config.hosts. The rejections matter as much as the accepts: the
// pre-existing addHost silently no-ops on a duplicate, which is exactly the
// "button does nothing" feel the ticket set out to remove — so a duplicate MUST
// be rejected here (with a message) rather than swallowed downstream.
//
// No FE test runner in this repo, so (like agentFilter.test.mjs) this loads the
// REAL src/lib/hostInput.ts plus its ./chatDisplay dependency (for THIS_MACHINE),
// transpiled TS -> ESM via Vite's OXC transform, rewriting the relative specifier
// so it resolves from the temp dir.
//
// Run: node hostInput.test.mjs   (or: npm test, from web/)
import { transformWithOxc } from 'vite';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const libDir = resolve(__dirname, 'src/lib');
const libPath = join(libDir, 'hostInput.ts');

const tmpDir = mkdtempSync(join(tmpdir(), 'warden-hostinput-test-'));
const chatDisplayPath = join(libDir, 'chatDisplay.ts');
const { code: chatDisplayCode } = await transformWithOxc(
  readFileSync(chatDisplayPath, 'utf8'), chatDisplayPath, {},
);
writeFileSync(join(tmpDir, 'chatDisplay.mjs'), chatDisplayCode);

const src = readFileSync(libPath, 'utf8')
  .replace(/from ['"]\.\/chatDisplay['"]/, 'from "./chatDisplay.mjs"');
const { code } = await transformWithOxc(src, libPath, {});
const tmpFile = join(tmpDir, 'hostInput.mjs');
writeFileSync(tmpFile, code);
const { validateNewHost } = await import(tmpFile);
// THIS_MACHINE comes from the REAL chatDisplay.ts, not a hardcoded '(local)', so
// this test still guards the rule if that constant is ever renamed/re-valued.
const { THIS_MACHINE } = await import(join(tmpDir, 'chatDisplay.mjs'));
rmSync(tmpDir, { recursive: true, force: true });

let passed = 0;
const test = (name, fn) => {
  fn();
  passed += 1;
  console.log('  ok -', name);
};

const CONFIGURED = ['alpha', 'build-box'];

console.log('\naccepts a host the ssh-config picker could never offer');
test('a plain name not in ~/.ssh/config is accepted', () => {
  const r = validateNewHost('gamma', CONFIGURED);
  assert.equal(r.ok, true);
  assert.equal(r.host, 'gamma');
});
test('a bare IP is accepted (ssh <ip> is the same control path)', () => {
  assert.deepEqual(validateNewHost('10.0.0.5', CONFIGURED), { ok: true, host: '10.0.0.5' });
});
test('a dotted DNS name is accepted', () => {
  assert.deepEqual(validateNewHost('ci.example.com', CONFIGURED), { ok: true, host: 'ci.example.com' });
});
test('an empty configured list is fine (the first-ever host)', () => {
  assert.deepEqual(validateNewHost('first', []), { ok: true, host: 'first' });
});

console.log('\nthe stored value is TRIMMED (a stray space must not become part of the host)');
test('surrounding whitespace is stripped from the accepted host', () => {
  const r = validateNewHost('  gamma  ', CONFIGURED);
  assert.equal(r.ok, true);
  assert.equal(r.host, 'gamma', 'trailing/leading space would break ssh <host>');
});
test('a padded DUPLICATE is caught after trimming, not stored as a near-twin', () => {
  // The dangerous direction: if trim ran only on the accept path, " alpha "
  // would sail past the duplicate check and land as a second, distinct entry.
  const r = validateNewHost('  alpha  ', CONFIGURED);
  assert.equal(r.ok, false);
  assert.equal(r.issue, 'duplicate');
});
test('a tab/newline-padded value trims to the same host', () => {
  assert.deepEqual(validateNewHost('\t gamma \n', CONFIGURED), { ok: true, host: 'gamma' });
});

console.log('\nempty / whitespace-only → rejected with a message (never a silent no-op)');
test('the empty string is rejected', () => {
  const r = validateNewHost('', CONFIGURED);
  assert.equal(r.ok, false);
  assert.equal(r.issue, 'empty');
  assert.ok(r.error.length > 0, 'a rejection without a message is a silent no-op');
});
test('spaces only is rejected as empty', () => {
  assert.equal(validateNewHost('     ', CONFIGURED).issue, 'empty');
});
test('a tab/newline-only value is rejected as empty', () => {
  assert.equal(validateNewHost('\t\n ', CONFIGURED).issue, 'empty');
});

console.log('\na leading "-" → rejected (ssh would read it as an OPTION, not a host)');
test('an ssh option masquerading as a host is rejected', () => {
  // src/ssh.js pushes the host POSITIONALLY with no `--` separator
  // (`args.push(host, remote)`), so `-oProxyCommand=…` is consumed by ssh as a
  // flag and the run silently does something other than what was typed — the
  // exact silent-swallow this screen exists to remove. Not a shell injection
  // (spawn runs without a shell), but it must not reach config.hosts unseen.
  const r = validateNewHost('-oProxyCommand=x', []);
  assert.equal(r.ok, false);
  assert.equal(r.issue, 'invalid');
  assert.ok(r.error.length > 0, 'a rejection without a message is a silent no-op');
});
test('a short flag and a long flag are both rejected', () => {
  assert.equal(validateNewHost('-4', CONFIGURED).issue, 'invalid');
  assert.equal(validateNewHost('--help', CONFIGURED).issue, 'invalid');
});
test('padding does not smuggle a leading dash past the guard', () => {
  // The dangerous direction: if the guard ran on `raw` instead of the trimmed
  // value, '  -x  ' would sail through and land in config.hosts.
  assert.equal(validateNewHost('  -oProxyCommand=x  ', []).issue, 'invalid');
});
test('a dash ELSEWHERE in the name is still accepted', () => {
  // Guards against an over-broad includes('-'): dashes are ordinary in host
  // names, and 'build-box' is already a configured one.
  assert.equal(validateNewHost('ci-runner-02', []).ok, true);
  assert.deepEqual(validateNewHost('web-1.example.com', []), { ok: true, host: 'web-1.example.com' });
});

console.log('\nduplicates → rejected (addHost would swallow these silently)');
test('an exact existing host is rejected', () => {
  const r = validateNewHost('alpha', CONFIGURED);
  assert.equal(r.ok, false);
  assert.equal(r.issue, 'duplicate');
  assert.match(r.error, /alpha/, 'the message must name the offending host');
});
test('the second configured host is caught too (not just index 0)', () => {
  assert.equal(validateNewHost('build-box', CONFIGURED).issue, 'duplicate');
});
test('a host that merely SHARES A PREFIX with a configured one is accepted', () => {
  // Guards against a substring/startsWith check masquerading as membership.
  assert.equal(validateNewHost('alpha2', CONFIGURED).ok, true);
  assert.equal(validateNewHost('alph', CONFIGURED).ok, true);
  assert.equal(validateNewHost('build', CONFIGURED).ok, true);
});
test('duplicate matching is EXACT-case (matches the includes() guard it front-runs)', () => {
  // Deliberate: config.hosts.includes is case-sensitive, so 'Alpha' is a
  // different entry there; rejecting it here would claim a duplicate that the
  // draft does not actually contain.
  assert.equal(validateNewHost('Alpha', CONFIGURED).ok, true);
});

console.log('\n(local) → rejected (this machine is implied, never a config.hosts member)');
test('THIS_MACHINE is rejected', () => {
  const r = validateNewHost(THIS_MACHINE, CONFIGURED);
  assert.equal(r.ok, false);
  assert.equal(r.issue, 'this-machine');
  assert.ok(r.error.length > 0);
});
test('THIS_MACHINE is rejected even when the configured list is empty', () => {
  // The important direction: it is NOT in config.hosts, so a duplicate check
  // alone would happily accept it.
  assert.equal(validateNewHost(THIS_MACHINE, []).issue, 'this-machine');
});
test('padded and differently-cased (local) is still rejected', () => {
  assert.equal(validateNewHost('  (local)  ', []).issue, 'this-machine');
  assert.equal(validateNewHost('(LOCAL)', []).issue, 'this-machine');
  assert.equal(validateNewHost('(Local)', []).issue, 'this-machine');
});
test('a host that merely CONTAINS the word local is accepted', () => {
  assert.equal(validateNewHost('local', []).ok, true, "'local' is a real reachable ssh alias");
  assert.equal(validateNewHost('localhost', []).ok, true);
  assert.equal(validateNewHost('my-(local)-box', []).ok, true);
});

console.log('\nthe validator is PURE — it never mutates the caller’s host list');
test('the configured array is untouched by an accept or a reject', () => {
  const hosts = ['alpha'];
  validateNewHost('gamma', hosts);
  validateNewHost('alpha', hosts);
  validateNewHost('', hosts);
  assert.deepEqual(hosts, ['alpha'], 'validation must not add anything — only the caller commits');
});

console.log(`\n✓ HOST INPUT TESTS PASS (${passed})`);
