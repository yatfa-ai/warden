// FileViewer "co-editors" chip tests (WARDEN-810).
//
// The co-editors chip surfaces, in the FileViewer header, every OTHER same-project
// agent that also has the open path dirty (±) / in a merge conflict (⚑) / in an
// unpushed commit (↑) — the file-level complement to the sidebar's fleet ⚠ collision
// rollup (WARDEN-288), so a coordinator sees cross-agent file contention at the
// reading moment without leaving the reader for the sidebar badge.
//
// There is no front-end DOM test runner in this repo, so (like breadcrumbs.test.mjs
// / collisionCompare.test.mjs / fileViewerChanges.test.mjs) this loads the REAL
// src/lib/fileCoEditors.ts (transpiled TS -> ESM via Vite's OXC transform) and drives
// the pure finder the chip's behavior hinges on. The finder is import-free at
// runtime precisely so this harness can load it: the temp-`.mjs` is written to a
// tmp dir, where Node can neither resolve the `@/` alias nor a relative sibling —
// so the display label is injected via `labelFor` instead of a displayName import.
//
// The load-bearing properties this suite pins (each test drives the input that
// ACTUALLY BREAKS the guarded property, not a hand-shaped input the code already
// handles):
//
//   - SELF-EXCLUSION: the reader itself is NEVER in the result, even when it has
//     the file dirty. Without the `key === selfKey` skip the chip would name the
//     agent whose version is already on screen.
//   - COMPREHENSIVENESS vs the WARDEN-288 rollup: the rollup fires only at ≥2-DIRTY
//     (working-tree×working-tree). This finder must surface an IMPENDING sibling
//     (committed the path, CLEAN tree ⇒ not in `files`) and an OUTGOING sibling
//     (committed, unpushed) — the two matrix cells the live detector is blind to.
//     If someone "simplified" the finder to read `files` only (mirroring the live
//     detector), the impending/outgoing tests go RED — exactly the regression this
//     suite exists to catch.
//   - NO-SIGNAL GATE: a sibling touching NONE of the three axes is excluded, so the
//     chip never lists an unrelated same-project agent.
//   - ACTIVE + STATUS-KNOWN GATE: an inactive sibling, or one missing from the
//     gitStatus map, contributes nothing — never a stale/unknown false co-editor.
//   - DETERMINISTIC ORDER: siblings return in projectChats iteration order.
//
// Run: node fileCoEditors.test.mjs   (or: npm test, from web/)
import { transformWithOxc } from 'vite';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const libPath = resolve(__dirname, 'src/lib/fileCoEditors.ts');

// --- Load the REAL fileCoEditors.ts (TS -> ESM via the OXC transform Vite bundles)
const src = readFileSync(libPath, 'utf8');
const { code } = await transformWithOxc(src, libPath, {});
const tmpDir = mkdtempSync(join(tmpdir(), 'warden-filecoeditors-test-'));
const tmpFile = join(tmpDir, 'fileCoEditors.mjs');
writeFileSync(tmpFile, code);
const { findFileCoEditors } = await import(tmpFile);
rmSync(tmpDir, { recursive: true, force: true });

let passed = 0;
const test = (name, fn) => {
  fn();
  passed += 1;
  console.log('  ok -', name);
};

// --- Fixtures (plain objects matching CoEditorChat / CoEditorStatus). labelFor is
// injected by the React layer; tests pass `(key) => key` so label === key, keeping
// assertions on membership/flags/order decoupled from displayName's logic.
const chat = (id, extra = {}) => ({ id, key: id, project: 'P', active: true, ...extra });
const file = (path, conflict = false) => ({ path, conflict });
const status = ({ files = null, outgoing = null } = {}) => ({ files, outgoingFiles: outgoing });
const FILE = 'src/server.js';
const labelFor = (key) => key;  // predictable: label mirrors the key in tests

// Convenience: build the finder call with the self reader 'me' and a fixed open path.
const run = (projectChats, gitStatus, opts = {}) =>
  findFileCoEditors({ filePath: opts.filePath ?? FILE, selfKey: opts.selfKey ?? 'me', projectChats, gitStatus, labelFor });

console.log('\nfindFileCoEditors — self-exclusion (the chip names the OTHER agents, never the reader)');

test('the reader itself is never returned, even when it has the open path dirty', () => {
  // The reader has the file dirty AND in conflict AND unpushed — every axis — yet it
  // must NOT appear in its own co-editors list. Driving input: remove the selfKey
  // skip and this fails (the reader would top its own list).
  const res = run(
    [chat('me'), chat('bob')],
    {
      me: status({ files: [file(FILE, true)], outgoing: [FILE] }),  // reader: all three axes
      bob: status({ files: [file(FILE)] }),
    },
  );
  assert.deepEqual(res, [{ key: 'bob', label: 'bob', dirty: true, conflict: false, unpushed: false }]);
});

test('self-key resolves by key || id (a chat whose key differs from id is still excluded)', () => {
  // The reader is keyed by `key || id`; selfKey is that resolved key. A reader with
  // key='reader-key', id='1' must be excluded when selfKey='reader-key'.
  const res = run(
    [chat('1', { key: 'reader-key' }), chat('bob')],
    { 'reader-key': status({ files: [file(FILE)] }), bob: status({ files: [file(FILE)] }) },
    { selfKey: 'reader-key' },
  );
  assert.deepEqual(res, [{ key: 'bob', label: 'bob', dirty: true, conflict: false, unpushed: false }]);
});

console.log('\nfindFileCoEditors — dirty (±) inclusion');

test('a sibling with the open path in files is included as dirty', () => {
  const res = run([chat('me'), chat('bob')], { bob: status({ files: [file('other.js'), file(FILE)] }) });
  assert.deepEqual(res, [{ key: 'bob', label: 'bob', dirty: true, conflict: false, unpushed: false }]);
});

console.log('\nfindFileCoEditors — conflict (⚑) flag off the SAME dirty row');

test('a sibling whose file entry carries conflict:true is dirty AND conflict', () => {
  // conflict ⇒ dirty (a conflicted file sits in `files`). Both glyphs render, which
  // is honest: the file is uncommitted AND blocked on a merge. The conflict flag is
  // read off the SAME row that set dirty — not a separate scan.
  const res = run([chat('me'), chat('bob')], { bob: status({ files: [file(FILE, true)] }) });
  assert.deepEqual(res, [{ key: 'bob', label: 'bob', dirty: true, conflict: true, unpushed: false }]);
});

test('a sibling whose OTHER file is conflicted (not the open path) does NOT set conflict', () => {
  // The conflict flag must be tied to the OPEN path's row, not any conflict anywhere
  // in the sibling's tree. A sibling blocked on a merge of a DIFFERENT file is not
  // in contention for THIS file.
  const res = run(
    [chat('me'), chat('bob')],
    { bob: status({ files: [file(FILE), file('other.js', true)] }) },  // open path clean, other file conflicted
  );
  assert.deepEqual(res, [{ key: 'bob', label: 'bob', dirty: true, conflict: false, unpushed: false }]);
});

console.log('\nfindFileCoEditors — comprehensiveness vs the WARDEN-288 rollup (the property this finder exists for)');

test('an IMPENDING sibling (committed the path, CLEAN tree) is included as unpushed-only', () => {
  // THE case the live detector is blind to: agent committed the file (outgoingFiles)
  // and has a clean working tree (not in files). WARDEN-288's ≥2-dirty rollup would
  // surface NOTHING; this finder surfaces the sibling from the reader's perspective.
  // If the finder read `files` only, this test goes RED.
  const res = run([chat('me'), chat('bob')], { bob: status({ files: [], outgoing: [FILE] }) });
  assert.deepEqual(res, [{ key: 'bob', label: 'bob', dirty: false, conflict: false, unpushed: true }]);
});

test('a sibling with the path in outgoingFiles but a null file list is included as unpushed-only', () => {
  // The detached/no-branch shape for `files` (null) — outgoingFiles still carries the
  // path. The finder must not require a non-null files array to join outgoing.
  const res = run([chat('me'), chat('bob')], { bob: status({ files: null, outgoing: [FILE] }) });
  assert.deepEqual(res, [{ key: 'bob', label: 'bob', dirty: false, conflict: false, unpushed: true }]);
});

test('a sibling BOTH dirty AND unpushed on the open path sets both flags', () => {
  // The agent edited the file AND has a prior unpushed commit touching it. Both axes
  // are true — accurate, not double-counted (one entry).
  const res = run([chat('me'), chat('bob')], { bob: status({ files: [file(FILE)], outgoing: [FILE] }) });
  assert.deepEqual(res, [{ key: 'bob', label: 'bob', dirty: true, conflict: false, unpushed: true }]);
});

test('a clean sibling (path in neither files nor outgoing) is excluded', () => {
  // The no-signal gate: an active same-project agent touching the open path on NONE
  // of the three axes contributes nothing — the chip never lists an unrelated agent.
  const res = run(
    [chat('me'), chat('bob'), chat('carl')],
    { bob: status({ files: [file('other.js')], outgoing: ['unrelated.js'] }), carl: status({ files: [file(FILE)] }) },
  );
  assert.deepEqual(res, [{ key: 'carl', label: 'carl', dirty: true, conflict: false, unpushed: false }]);
});

console.log('\nfindFileCoEditors — active + status-known gate (never a stale/unknown false co-editor)');

test('an INACTIVE sibling with the file dirty is excluded (active gate, mirrors the detectors)', () => {
  // A dead/closed agent's stale cached status would be misleading — skip it, exactly
  // as detectProjectFileCollisions does (active && project population gate).
  const res = run(
    [chat('me'), chat('bob', { active: false }), chat('carl')],
    { bob: status({ files: [file(FILE)] }), carl: status({ files: [file(FILE)] }) },
  );
  assert.deepEqual(res, [{ key: 'carl', label: 'carl', dirty: true, conflict: false, unpushed: false }]);
});

test('a sibling with no project is excluded (project gate)', () => {
  // active but project-less — the population gate the detectors share.
  const res = run(
    [chat('me'), chat('bob', { project: undefined }), chat('carl')],
    { bob: status({ files: [file(FILE)] }), carl: status({ files: [file(FILE)] }) },
  );
  assert.deepEqual(res, [{ key: 'carl', label: 'carl', dirty: true, conflict: false, unpushed: false }]);
});

test('a sibling missing from the gitStatus map is excluded (unknown status ⇒ no guess)', () => {
  // Still loading / non-git cwd — never a false co-editor from a chat whose file
  // state is unknown.
  const res = run(
    [chat('me'), chat('bob'), chat('carl')],
    { carl: status({ files: [file(FILE)] }) },  // bob has no status entry at all
  );
  assert.deepEqual(res, [{ key: 'carl', label: 'carl', dirty: true, conflict: false, unpushed: false }]);
});

console.log('\nfindFileCoEditors — deterministic order (projectChats iteration order)');

test('multiple siblings return in projectChats iteration order', () => {
  // The detectors' contract: deterministic, chats-order output so tests assert deep
  // equality and the popover lists siblings stably.
  const res = run(
    [chat('me'), chat('zoe'), chat('amy'), chat('bob')],
    {
      zoe: status({ outgoing: [FILE] }),         // unpushed-only
      amy: status({ files: [file(FILE, true)] }), // dirty+conflict
      bob: status({ files: [file(FILE)] }),       // dirty
    },
  );
  assert.deepEqual(res.map((c) => c.key), ['zoe', 'amy', 'bob']);
});

test('with no siblings touching the file, returns an empty array (the chip renders nothing)', () => {
  const res = run([chat('me'), chat('bob')], { bob: status({ files: [file('other.js')] }) });
  assert.deepEqual(res, []);
});

console.log('\nfindFileCoEditors — edge guards');

test('an empty filePath returns [] (FileViewer initial render before fileTarget resolves)', () => {
  const res = run([chat('me'), chat('bob')], { bob: status({ files: [file('')] }) }, { filePath: '' });
  assert.deepEqual(res, []);
});

test('label is filled by the injected labelFor (kept out of an @/ displayName import)', () => {
  // The label join is the React layer's job (displayName(findChat(chats, key)));
  // the finder just passes the key through labelFor. Verifies the injection contract.
  const res = findFileCoEditors({
    filePath: FILE, selfKey: 'me', projectChats: [chat('me'), chat('bob')],
    gitStatus: { bob: status({ files: [file(FILE)] }) },
    labelFor: (key) => `<<${key}>>`,
  });
  assert.equal(res[0].label, '<<bob>>');
});

console.log(`\n${passed} passed`);
