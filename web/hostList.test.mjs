// Tests for the client host-list union behind WARDEN-1202.
//
// `GET /api/ssh-hosts` returns TWO keys and, until mergeHostList existed, every
// client read only one:
//
//   res.json({ hosts: await allSshHosts(), configured: cfg.hosts })
//
// `hosts` is ~/.ssh/config `Host` aliases; `configured` is cfg.hosts — the REAL
// fleet the server sweeps as `[LOCAL, ...cfg.hosts]`. `configured` had ZERO
// readers, and the divergence is reachable through a SHIPPED control: the
// WARDEN-940 free-text "Add Host" field deliberately performs no ssh-config
// membership test ("accepting hosts the picker cannot see is the whole point"),
// so a typed host is by design absent from ~/.ssh/config. The result was no
// sidebar row, no Open Chat scope chip, and — worse than omission — an ACTIVE
// reset of a stored defaultNewChatHost back to (local) on every New Chat open.
//
// So the load-bearing case here is `configured`-only: that is the state the
// shipped affordance produces, and the one that was silently dropped. The
// de-dup and (local) cases are the regressions a naive union would introduce.
//
// No FE test runner in this repo, so (like hostInput.test.mjs) this loads the
// REAL src/lib/hostList.ts plus its ./chatDisplay dependency (for THIS_MACHINE),
// transpiled TS -> ESM via Vite's OXC transform, rewriting the relative specifier
// so it resolves from the temp dir.
//
// Run: node hostList.test.mjs   (or: npm test, from web/)
import { transformWithOxc } from 'vite';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const libDir = resolve(__dirname, 'src/lib');
const libPath = join(libDir, 'hostList.ts');

const tmpDir = mkdtempSync(join(tmpdir(), 'warden-hostlist-test-'));
const chatDisplayPath = join(libDir, 'chatDisplay.ts');
const { code: chatDisplayCode } = await transformWithOxc(
  readFileSync(chatDisplayPath, 'utf8'), chatDisplayPath, {},
);
writeFileSync(join(tmpDir, 'chatDisplay.mjs'), chatDisplayCode);

const src = readFileSync(libPath, 'utf8')
  .replace(/from ['"]\.\/chatDisplay['"]/, 'from "./chatDisplay.mjs"');
const { code } = await transformWithOxc(src, libPath, {});
const tmpFile = join(tmpDir, 'hostList.mjs');
writeFileSync(tmpFile, code);
const { mergeHostList } = await import(tmpFile);
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

console.log('\ndiscovered-only (~/.ssh/config aliases, no configured fleet)');
test('returns the ssh-config aliases unchanged, in order', () => {
  assert.deepEqual(mergeHostList({ hosts: ['alpha', 'beta'], configured: [] }), ['alpha', 'beta']);
});
test('a missing `configured` key degrades to the discovered list (old server)', () => {
  // A pre-WARDEN-1202 server, or a partial response, must shorten the list
  // rather than throw inside the consumer's .then().
  assert.deepEqual(mergeHostList({ hosts: ['alpha'] }), ['alpha']);
});

console.log('\nconfigured-only — THE DEFECT: a host typed in Settings reaches the list');
test('a cfg.hosts-only host is INCLUDED when ~/.ssh/config is absent', () => {
  // The exact success-criterion-1 state: no ssh config, cfg.hosts: ["build-box"].
  // Before this helper the client rendered [] here, so the sidebar had no row
  // (enterHost unreachable) and Open Chat had no scope chip.
  assert.deepEqual(mergeHostList({ hosts: [], configured: ['build-box'] }), ['build-box']);
});
test('a missing `hosts` key still yields the configured fleet', () => {
  assert.deepEqual(mergeHostList({ configured: ['build-box'] }), ['build-box']);
});
test('configured-only hosts append after discovered ones, preserving each order', () => {
  assert.deepEqual(
    mergeHostList({ hosts: ['alpha', 'beta'], configured: ['build-box', 'ci'] }),
    ['alpha', 'beta', 'build-box', 'ci'],
  );
});

console.log('\noverlap → de-duplicated (a host in BOTH files appears exactly once)');
test('a host in both `hosts` and `configured` yields ONE entry', () => {
  // Success criterion 3: no duplicate chip/row. A naive concat would render
  // 'alpha' twice, and React would warn on the duplicate key.
  assert.deepEqual(mergeHostList({ hosts: ['alpha'], configured: ['alpha'] }), ['alpha']);
});
test('a partial overlap keeps discovered order and appends only the newcomers', () => {
  assert.deepEqual(
    mergeHostList({ hosts: ['alpha', 'beta'], configured: ['beta', 'build-box'] }),
    ['alpha', 'beta', 'build-box'],
  );
});
test('a fully-overlapping fleet adds nothing (the common real-world config)', () => {
  assert.deepEqual(
    mergeHostList({ hosts: ['alpha', 'beta'], configured: ['alpha', 'beta'] }),
    ['alpha', 'beta'],
  );
});
test('a repeat WITHIN one source is also collapsed', () => {
  assert.deepEqual(mergeHostList({ hosts: ['alpha', 'alpha'], configured: [] }), ['alpha']);
});

console.log(`\n'${THIS_MACHINE}' is filtered from BOTH sources (consumers prepend it themselves)`);
test('a literal (local) in cfg.hosts never reaches the list', () => {
  // Success criterion 4. Consumers render [THIS_MACHINE, ...sshHosts], so a
  // hand-edited config.json carrying the literal would otherwise show a
  // duplicate local row that removal could never fully undo.
  assert.deepEqual(mergeHostList({ hosts: [], configured: [THIS_MACHINE, 'build-box'] }), ['build-box']);
});
test('a literal (local) in the ssh-config aliases is filtered too', () => {
  assert.deepEqual(mergeHostList({ hosts: [THIS_MACHINE, 'alpha'], configured: [] }), ['alpha']);
});
test('the (local) filter is CASE-INSENSITIVE, matching validateNewHost', () => {
  // hostInput.ts rejects a typed '(LOCAL)' case-insensitively; a case variant
  // that slipped in by hand must not sneak through this list either.
  assert.deepEqual(mergeHostList({ hosts: [], configured: ['(LOCAL)', 'build-box'] }), ['build-box']);
  assert.deepEqual(mergeHostList({ hosts: ['(Local)'], configured: [] }), []);
});

console.log('\ndegenerate / defensive inputs never throw inside a .then()');
test('both keys empty → empty list', () => {
  assert.deepEqual(mergeHostList({ hosts: [], configured: [] }), []);
});
test('an empty object → empty list', () => {
  assert.deepEqual(mergeHostList({}), []);
});
test('null / undefined → empty list', () => {
  assert.deepEqual(mergeHostList(null), []);
  assert.deepEqual(mergeHostList(undefined), []);
});

console.log('\nthe input arrays are not mutated (the response object is reused by callers)');
test('mergeHostList is pure — neither source array is modified', () => {
  const hosts = ['alpha'];
  const configured = ['build-box'];
  mergeHostList({ hosts, configured });
  assert.deepEqual(hosts, ['alpha']);
  assert.deepEqual(configured, ['build-box']);
});

console.log(`\n${passed} passed`);
