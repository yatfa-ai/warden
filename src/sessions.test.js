import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// sessions.js is the durable store for Observer conversations: a session JSON
// (the LLM message history, for replay/resume) plus an append-only markdown
// transcript, under ~/.yatfa-warden/sessions/. It persists through the async
// atomic-write + defensive-read helpers (WARDEN-831), so — exactly as
// src/collections.test.js does for its sibling STATE_MODULE — we exercise it
// against REAL I/O under a redirected HOME rather than mocking fs.
//
// The module resolves DIR from os.homedir() at import time (sessions.js:11), so
// HOME is redirected BEFORE the dynamic import() below.
//
// These are CHARACTERIZATION tests: every assertion holds against unmodified
// production code. One exception, now resolved: the markdown-heading rewrite in
// renameSession (sessions.js:90) used to pass the new name straight into
// String.replace as the replacement STRING, so a name containing `$&` / `` $` `` /
// `$'` was interpreted as a replacement pattern. That was a defect, not a
// contract, so this suite deliberately declined to pin it (WARDEN-89) and banked
// it for a separate fix cycle. WARDEN-1044 was that cycle: the sink now takes a
// replacer function, and the "$-bearing names are literal" block below pins the
// fixed behaviour.

let mod; // dynamically-imported sessions.js (after HOME redirect)
let tmpHome;
let sessionsDir;
let originalHome;

const jsonPath = (id) => path.join(sessionsDir, `${id}.json`);
const mdPath = (id) => path.join(sessionsDir, `${id}.md`);

before(async () => {
  originalHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-sessions-'));
  process.env.HOME = tmpHome;
  sessionsDir = path.join(tmpHome, '.yatfa-warden', 'sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });
  mod = await import('./sessions.js');
});

after(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

beforeEach(() => {
  // Each test starts from an empty sessions directory.
  fs.rmSync(sessionsDir, { recursive: true, force: true });
  fs.mkdirSync(sessionsDir, { recursive: true });
});

// Seed a session JSON directly (bypassing createSession) so a test can pin an
// exact on-disk shape — including shapes createSession would never produce, such
// as a record missing `messages` or a truncated/corrupt document.
function seedJson(id, record) {
  fs.writeFileSync(jsonPath(id), JSON.stringify(record, null, 2) + '\n');
}

function seedCorrupt(id, text = '{"id":"broken","messages":[') {
  fs.writeFileSync(jsonPath(id), text);
}

function corruptBackups() {
  return fs.readdirSync(sessionsDir).filter((f) => f.includes('.corrupt-'));
}

// The defensive read logs to console.warn on corrupt/unreadable input. Silence it
// for the corruption tests (and return what was logged, so a test can assert the
// backup path was actually surfaced rather than swallowed).
async function withSilencedWarnings(fn) {
  const original = console.warn;
  const lines = [];
  console.warn = (...args) => lines.push(args.join(' '));
  try {
    return { result: await fn(), warnings: lines };
  } finally {
    console.warn = original;
  }
}

// ------------------------------- listSessions --------------------------------
describe('listSessions — index projection and defensive skip', () => {
  it('returns an empty list when no sessions have been written', async () => {
    assert.deepStrictEqual(await mod.listSessions(), []);
  });

  it('creates the sessions directory when it is absent', async () => {
    fs.rmSync(sessionsDir, { recursive: true, force: true });
    assert.deepStrictEqual(await mod.listSessions(), []);
    assert.ok(fs.existsSync(sessionsDir), 'listSessions should ensure the sessions dir exists');
  });

  it('indexes .json files only — transcripts and in-flight atomic-write temps are not sessions', async () => {
    seedJson('aaa', { id: 'aaa', name: 'real', createdAt: 1, updatedAt: 2, messages: [] });
    fs.writeFileSync(mdPath('aaa'), '# real\n\n');
    fs.writeFileSync(path.join(sessionsDir, 'notes.txt'), 'scratch');
    // A staged atomic-write temp (persist.js: `<file>.<pid>.<ts>.<n>.tmp`) holds
    // VALID JSON, so only the extension filter keeps a mid-write session from
    // being double-listed — a defensive read would happily parse it.
    fs.writeFileSync(
      path.join(sessionsDir, 'aaa.json.4242.abc.0.tmp'),
      JSON.stringify({ id: 'aaa', name: 'real', createdAt: 1, updatedAt: 999, messages: [] }),
    );

    const list = await mod.listSessions();
    assert.deepStrictEqual(list.map((s) => s.id), ['aaa'], 'only the .json session may be indexed');
    assert.deepStrictEqual(corruptBackups(), [], 'non-.json files are skipped by extension, never read or backed up');
  });

  it('skips a corrupt session file rather than crashing the list, and still lists the healthy ones', async () => {
    seedJson('good', { id: 'good', name: 'ok', createdAt: 1, updatedAt: 2, messages: [] });
    seedCorrupt('bad');

    const { result: list } = await withSilencedWarnings(() => mod.listSessions());

    assert.deepStrictEqual(list.map((s) => s.id), ['good'], 'the corrupt entry must be skipped, not fatal');
  });

  it('backs the corrupt session file up rather than silently swallowing it (WARDEN-831)', async () => {
    seedCorrupt('bad', '{"id":"bad","messages":[{');

    const { warnings } = await withSilencedWarnings(() => mod.listSessions());

    const backups = corruptBackups();
    assert.strictEqual(backups.length, 1, `expected one corruption backup, got ${JSON.stringify(backups)}`);
    assert.ok(backups[0].startsWith('bad.corrupt-'), `backup should be derived from the source name: ${backups[0]}`);
    assert.strictEqual(
      fs.readFileSync(path.join(sessionsDir, backups[0]), 'utf8'),
      '{"id":"bad","messages":[{',
      'the backup must preserve the original bytes so the user can recover them',
    );
    assert.ok(
      warnings.some((w) => w.includes('corrupt JSON') && w.includes('.corrupt-')),
      `corruption should be surfaced with its backup path; saw: ${JSON.stringify(warnings)}`,
    );
  });

  it('does not re-read its own corruption backup — repeated lists do not multiply files (WARDEN-1040)', async () => {
    seedCorrupt('bad', '{"id":"bad","messages":[{');
    seedJson('good', { id: 'good', name: 'ok', createdAt: 1, updatedAt: 2, messages: [] });

    // The quarantine artifact used to keep the `.json` extension, so the very
    // scanner that produced it re-globbed it, failed to parse it, and backed it
    // up AGAIN — doubling the directory on every call. `GET /api/sessions`
    // (server.js) is a request path, so that is unbounded traffic-driven disk
    // growth. A single-call test cannot see this: the count must be compared
    // ACROSS calls.
    await withSilencedWarnings(() => mod.listSessions());
    const afterFirst = fs.readdirSync(sessionsDir).sort();

    await withSilencedWarnings(() => mod.listSessions());
    await withSilencedWarnings(() => mod.listSessions());
    const afterThird = fs.readdirSync(sessionsDir).sort();

    assert.deepStrictEqual(
      afterThird, afterFirst,
      'listing again must not produce further backups — the quarantine artifact must leave the scanned namespace',
    );
    assert.strictEqual(
      corruptBackups().length, 1,
      `exactly one backup should ever be written for one corrupt file, got ${JSON.stringify(corruptBackups())}`,
    );
    assert.ok(
      !corruptBackups()[0].endsWith('.json'),
      `the backup must not land back in the scanned .json namespace: ${corruptBackups()[0]}`,
    );
  });

  it('skips legacy .corrupt-*.json quarantine artifacts already on disk (WARDEN-1040)', async () => {
    seedJson('good', { id: 'good', name: 'ok', createdAt: 1, updatedAt: 2, messages: [] });
    // Written by a pre-fix build: keeps the .json extension, so the extension
    // filter alone would let the scanner re-read and re-back-up this forever.
    fs.writeFileSync(path.join(sessionsDir, 'old.corrupt-2026-01-01T00-00-00-000Z.json'), '{"broken":');

    const before = fs.readdirSync(sessionsDir).sort();
    const { result: list } = await withSilencedWarnings(() => mod.listSessions());

    assert.deepStrictEqual(list.map((s) => s.id), ['good'], 'a legacy quarantine artifact is not a session');
    assert.deepStrictEqual(
      fs.readdirSync(sessionsDir).sort(), before,
      'a legacy quarantine artifact must be skipped, not re-read and re-backed-up',
    );
  });

  it('sorts by updatedAt descending (most recently touched first)', async () => {
    seedJson('mid', { id: 'mid', name: 'mid', createdAt: 1, updatedAt: 200, messages: [] });
    seedJson('old', { id: 'old', name: 'old', createdAt: 1, updatedAt: 100, messages: [] });
    seedJson('new', { id: 'new', name: 'new', createdAt: 1, updatedAt: 300, messages: [] });

    const list = await mod.listSessions();
    assert.deepStrictEqual(list.map((s) => s.id), ['new', 'mid', 'old']);
  });

  it('derives messageCount from the messages array, counting a missing array as 0', async () => {
    seedJson('two', { id: 'two', name: 'two', updatedAt: 2, messages: [{ role: 'user' }, { role: 'assistant' }] });
    seedJson('none', { id: 'none', name: 'none', updatedAt: 1 }); // no `messages` key at all

    const byId = Object.fromEntries((await mod.listSessions()).map((s) => [s.id, s]));
    assert.strictEqual(byId.two.messageCount, 2);
    assert.strictEqual(byId.none.messageCount, 0, 'a record with no messages array must count 0, not throw');
  });

  it('projects the chat-context fields, falling back to null when absent', async () => {
    seedJson('ctx', {
      id: 'ctx', name: 'with context', createdAt: 10, updatedAt: 20, messages: [],
      host: 'dev-box', container: 'warden-worker', project: 'warden', role: 'worker', chatKey: 'dev-box/warden-worker',
    });
    seedJson('bare', { id: 'bare', name: 'no context', createdAt: 5, updatedAt: 6, messages: [] });

    const byId = Object.fromEntries((await mod.listSessions()).map((s) => [s.id, s]));
    assert.deepStrictEqual(byId.ctx, {
      id: 'ctx', name: 'with context', createdAt: 10, updatedAt: 20, messageCount: 0,
      host: 'dev-box', container: 'warden-worker', project: 'warden', role: 'worker', chatKey: 'dev-box/warden-worker',
    });
    assert.deepStrictEqual(byId.bare, {
      id: 'bare', name: 'no context', createdAt: 5, updatedAt: 6, messageCount: 0,
      host: null, container: null, project: null, role: null, chatKey: null,
    });
  });

  it('projects an index row only — the message history is not loaded into the list', async () => {
    seedJson('heavy', {
      id: 'heavy', name: 'heavy', createdAt: 1, updatedAt: 2,
      messages: [{ role: 'user', content: 'a very large transcript' }],
    });

    const [row] = await mod.listSessions();
    assert.strictEqual(row.messageCount, 1);
    assert.ok(!('messages' in row), 'listSessions returns an index projection, not full session bodies');
  });
});

// -------------------------------- getSession ---------------------------------
describe('getSession — defensive single read', () => {
  it('returns null for an unknown id', () => {
    assert.strictEqual(mod.getSession('does-not-exist'), null);
  });

  it('returns the full persisted record, message history included', () => {
    const record = {
      id: 'abc', name: 'a session', createdAt: 1, updatedAt: 2,
      messages: [{ role: 'user', content: 'hi' }], host: 'dev-box', container: null, project: null, role: null, chatKey: null,
    };
    seedJson('abc', record);
    assert.deepStrictEqual(mod.getSession('abc'), record);
  });

  it('returns null for a corrupt file AND leaves a backup (never a silent default)', async () => {
    seedCorrupt('torn', '{"id":"torn","messages":[{"role":');

    const { result, warnings } = await withSilencedWarnings(() => mod.getSession('torn'));

    assert.strictEqual(result, null);
    const backups = corruptBackups();
    assert.strictEqual(backups.length, 1, `expected one corruption backup, got ${JSON.stringify(backups)}`);
    assert.ok(backups[0].startsWith('torn.corrupt-'));
    assert.strictEqual(
      fs.readFileSync(path.join(sessionsDir, backups[0]), 'utf8'),
      '{"id":"torn","messages":[{"role":',
    );
    assert.ok(warnings.some((w) => w.includes('corrupt JSON')), 'corruption must be surfaced, not swallowed');
  });
});

// ------------------------------- saveMessages --------------------------------
describe('saveMessages — persistence and origin-metadata preservation', () => {
  it('creates a new record when the session does not exist yet, defaulting name to the id', async () => {
    const out = await mod.saveMessages('fresh', [{ role: 'user', content: 'hello' }]);

    assert.strictEqual(out.id, 'fresh');
    assert.strictEqual(out.name, 'fresh', 'with no name and no previous record, name falls back to the id');
    assert.deepStrictEqual(out.messages, [{ role: 'user', content: 'hello' }]);
    assert.strictEqual(typeof out.createdAt, 'number');
    assert.ok(out.updatedAt >= out.createdAt);
    assert.deepStrictEqual(
      { host: out.host, container: out.container, project: out.project, role: out.role, chatKey: out.chatKey },
      { host: null, container: null, project: null, role: null, chatKey: null },
    );
  });

  it('writes the record to disk so it round-trips through getSession', async () => {
    const out = await mod.saveMessages('disk', [{ role: 'assistant', content: 'persisted' }], 'On disk');
    assert.deepStrictEqual(mod.getSession('disk'), out);
  });

  it('creates the sessions directory when it is absent', async () => {
    fs.rmSync(sessionsDir, { recursive: true, force: true });
    await mod.saveMessages('nodir', [{ role: 'user', content: 'x' }]);
    assert.ok(fs.existsSync(jsonPath('nodir')), 'saveMessages must ensure the dir before writing');
  });

  it('preserves createdAt across a re-save (a later write does not reset the session origin time)', async () => {
    seedJson('keep', { id: 'keep', name: 'keep', createdAt: 111, updatedAt: 222, messages: [] });

    const out = await mod.saveMessages('keep', [{ role: 'user', content: 'more' }]);

    assert.strictEqual(out.createdAt, 111, 'createdAt must carry over from the previous record');
    assert.ok(out.updatedAt >= 222, 'updatedAt must advance to the write time');
  });

  it('preserves the chat context (host/container/project/role/chatKey) carried from the previous record', async () => {
    seedJson('ctx', {
      id: 'ctx', name: 'ctx', createdAt: 1, updatedAt: 2, messages: [],
      host: 'dev-box', container: 'warden-worker', project: 'warden', role: 'worker', chatKey: 'dev-box/warden-worker',
    });

    const out = await mod.saveMessages('ctx', [{ role: 'user', content: 'next turn' }]);

    assert.deepStrictEqual(
      { host: out.host, container: out.container, project: out.project, role: out.role, chatKey: out.chatKey },
      { host: 'dev-box', container: 'warden-worker', project: 'warden', role: 'worker', chatKey: 'dev-box/warden-worker' },
      'a message save must not silently reset the session origin metadata',
    );
    assert.deepStrictEqual(mod.getSession('ctx').chatKey, 'dev-box/warden-worker', 'and it must survive on disk');
  });

  it('falls back to the previous name when no name is supplied', async () => {
    seedJson('named', { id: 'named', name: 'Original name', createdAt: 1, updatedAt: 2, messages: [] });

    const out = await mod.saveMessages('named', []);
    assert.strictEqual(out.name, 'Original name');
  });

  it('prefers an explicitly supplied name over the previous one', async () => {
    seedJson('named', { id: 'named', name: 'Original name', createdAt: 1, updatedAt: 2, messages: [] });

    const out = await mod.saveMessages('named', [], 'Renamed on save');
    assert.strictEqual(out.name, 'Renamed on save');
  });

  it('replaces the message history wholesale (the JSON is a snapshot, not an append log)', async () => {
    await mod.saveMessages('snap', [{ role: 'user', content: 'first' }, { role: 'assistant', content: 'second' }]);
    await mod.saveMessages('snap', [{ role: 'user', content: 'only' }]);

    assert.deepStrictEqual(mod.getSession('snap').messages, [{ role: 'user', content: 'only' }]);
  });

  it('starts a fresh record when the previous file is corrupt, and backs the corrupt one up', async () => {
    seedCorrupt('broken');

    const { result: out } = await withSilencedWarnings(() => mod.saveMessages('broken', [{ role: 'user', content: 'recovered' }]));

    assert.strictEqual(out.name, 'broken', 'an unreadable previous record cannot supply a name');
    assert.deepStrictEqual(out.messages, [{ role: 'user', content: 'recovered' }]);
    assert.strictEqual(corruptBackups().length, 1, 'the unparseable prior record must be preserved for recovery');
  });
});

// ------------------------------ appendTranscript -----------------------------
describe('appendTranscript — append-only markdown transcript', () => {
  it('initialises the heading when the transcript does not exist yet', async () => {
    await mod.appendTranscript('t1', 'user', 'hello there');

    const md = fs.readFileSync(mdPath('t1'), 'utf8');
    assert.ok(md.startsWith('# user\n\n'), `expected an initialised heading, got: ${JSON.stringify(md.slice(0, 40))}`);
    assert.ok(md.includes('hello there'));
  });

  it('is append-only: a second block never overwrites the first (WARDEN-831)', async () => {
    await mod.appendTranscript('t2', 'user', 'first message');
    await mod.appendTranscript('t2', 'assistant', 'second message');

    const md = fs.readFileSync(mdPath('t2'), 'utf8');
    assert.ok(md.includes('first message'), 'the earlier block must survive the later append');
    assert.ok(md.includes('second message'));
    assert.ok(
      md.indexOf('first message') < md.indexOf('second message'),
      'blocks must be appended in chronological order',
    );
  });

  it('writes the heading only once — a later append does not re-initialise it', async () => {
    await mod.appendTranscript('t3', 'user', 'one');
    await mod.appendTranscript('t3', 'assistant', 'two');
    await mod.appendTranscript('t3', 'user', 'three');

    const md = fs.readFileSync(mdPath('t3'), 'utf8');
    assert.strictEqual(md.split('# user\n\n').length - 1, 1, 'the heading must be initialised exactly once');
  });

  it('leaves an existing heading alone (e.g. the stub createSession wrote)', async () => {
    fs.writeFileSync(mdPath('t4'), '# My session\n\n');
    await mod.appendTranscript('t4', 'user', 'body');

    const md = fs.readFileSync(mdPath('t4'), 'utf8');
    assert.ok(md.startsWith('# My session\n\n'), 'an existing transcript heading must be preserved');
    assert.ok(!md.includes('# user'), 'no second heading may be injected when the transcript already exists');
  });

  it('labels a user block "🧑 user"', async () => {
    await mod.appendTranscript('t5', 'user', 'from the human');
    assert.ok(fs.readFileSync(mdPath('t5'), 'utf8').includes('— 🧑 user'));
  });

  it('labels an assistant block "🤖 observer"', async () => {
    await mod.appendTranscript('t6', 'assistant', 'from the observer');
    assert.ok(fs.readFileSync(mdPath('t6'), 'utf8').includes('— 🤖 observer'));
  });

  it('falls back to the raw role for any other role (e.g. system)', async () => {
    await mod.appendTranscript('t7', 'system', 'a system note');
    const md = fs.readFileSync(mdPath('t7'), 'utf8');
    assert.ok(md.includes('— system'), 'an unmapped role is used verbatim as the label');
    assert.ok(!md.includes('🧑') && !md.includes('🤖'), 'no user/assistant emoji may leak onto an unmapped role');
  });

  it('stamps each block with an ISO timestamp under a level-2 heading', async () => {
    await mod.appendTranscript('t8', 'user', 'timed');
    const md = fs.readFileSync(mdPath('t8'), 'utf8');
    assert.match(md, /^## \d{4}-\d{2}-\d{2}T[\d:.]+Z — 🧑 user$/m);
  });

  it('does not touch the session JSON (the transcript is the human-readable twin)', async () => {
    await mod.appendTranscript('t9', 'user', 'only markdown');
    assert.ok(!fs.existsSync(jsonPath('t9')), 'appendTranscript writes the .md only');
  });
});

// ------------------------------ renameSession --------------------------------
describe('renameSession — JSON + best-effort transcript heading', () => {
  it('returns null for an unknown id and writes nothing', async () => {
    assert.strictEqual(await mod.renameSession('missing', 'New name'), null);
    assert.deepStrictEqual(fs.readdirSync(sessionsDir), []);
  });

  it('updates the name and updatedAt, and persists both', async () => {
    seedJson('r1', { id: 'r1', name: 'Old name', createdAt: 1, updatedAt: 2, messages: [{ role: 'user' }] });

    const out = await mod.renameSession('r1', 'New name');

    assert.strictEqual(out.name, 'New name');
    assert.ok(out.updatedAt > 2, 'updatedAt must advance to the rename time');
    assert.strictEqual(mod.getSession('r1').name, 'New name', 'the rename must survive on disk');
  });

  it('preserves createdAt and the message history through a rename', async () => {
    seedJson('r2', {
      id: 'r2', name: 'Old', createdAt: 4242, updatedAt: 4243,
      messages: [{ role: 'user', content: 'keep me' }], host: 'dev-box', container: null, project: null, role: null, chatKey: null,
    });

    const out = await mod.renameSession('r2', 'New');

    assert.strictEqual(out.createdAt, 4242);
    assert.deepStrictEqual(out.messages, [{ role: 'user', content: 'keep me' }]);
    assert.strictEqual(out.host, 'dev-box', 'a rename must not drop the chat context');
  });

  it('rewrites the transcript heading to match the new name', async () => {
    seedJson('r3', { id: 'r3', name: 'Old name', createdAt: 1, updatedAt: 2, messages: [] });
    fs.writeFileSync(mdPath('r3'), '# Old name\n\n## 2026-01-01T00:00:00.000Z — 🧑 user\n\nbody text\n');

    await mod.renameSession('r3', 'New name');

    const md = fs.readFileSync(mdPath('r3'), 'utf8');
    assert.ok(md.startsWith('# New name\n'), `heading should be rewritten, got: ${JSON.stringify(md.slice(0, 30))}`);
    assert.ok(md.includes('body text'), 'the rename must not discard the existing transcript body');
    assert.ok(!md.includes('# Old name'), 'the stale heading must be gone');
  });

  it('rewrites only the first heading, leaving the ## block headings intact', async () => {
    seedJson('r4', { id: 'r4', name: 'Old name', createdAt: 1, updatedAt: 2, messages: [] });
    fs.writeFileSync(mdPath('r4'), '# Old name\n\n## 2026-01-01T00:00:00.000Z — 🧑 user\n\nfirst\n\n## 2026-01-02T00:00:00.000Z — 🤖 observer\n\nsecond\n');

    await mod.renameSession('r4', 'New name');

    const md = fs.readFileSync(mdPath('r4'), 'utf8');
    assert.strictEqual(md.split('\n').filter((l) => l.startsWith('## ')).length, 2, 'block headings are untouched');
    assert.strictEqual(md.split('\n').filter((l) => l.startsWith('# ')).length, 1);
  });

  it('tolerates a missing transcript best-effort — the JSON rename still succeeds', async () => {
    seedJson('r5', { id: 'r5', name: 'Old name', createdAt: 1, updatedAt: 2, messages: [] });
    assert.ok(!fs.existsSync(mdPath('r5')), 'precondition: no transcript on disk');

    const out = await mod.renameSession('r5', 'New name'); // must not throw

    assert.strictEqual(out.name, 'New name');
    assert.strictEqual(mod.getSession('r5').name, 'New name');
    assert.ok(!fs.existsSync(mdPath('r5')), 'a missing transcript is ignored, not conjured');
  });

  it('returns null for a corrupt session file rather than writing a half-renamed record', async () => {
    seedCorrupt('r6');

    const { result } = await withSilencedWarnings(() => mod.renameSession('r6', 'New name'));

    assert.strictEqual(result, null);
    assert.strictEqual(corruptBackups().length, 1, 'the corrupt record is backed up by the defensive read');
  });
});

// ------------- renameSession — `$`-bearing names are literal (WARDEN-1044) ----
// The heading rewrite feeds the new name to String.replace. Passed as a STRING,
// `$&` / `` $` `` / `$'` / `$<n>` are replacement PATTERNS, so an ordinary name
// typed into the rename field (`cost $5 $& done`) silently corrupts the heading,
// and `$'` re-injects everything after the match — the whole transcript body —
// doubling the file on every rename because the write re-enters its own reader.
// The sink takes a replacer function, which disables pattern interpretation.
describe('renameSession — a $-bearing name is written literally, not as a replacement pattern', () => {
  const BODY = '\n## 2026-01-01T00:00:00.000Z — 🧑 user\n\nsecret body line\n';

  // Seed a session whose transcript carries a heading plus a body, so an injected
  // `$&` (the match) / `` $` `` (before) / `$'` (after) has something to smuggle in.
  function seedRenamable(id) {
    seedJson(id, { id, name: 'Old name', createdAt: 1, updatedAt: 2, messages: [] });
    fs.writeFileSync(mdPath(id), `# Old name\n${BODY}`);
  }

  for (const [id, name] of [
    ['p1', 'A$&B'],
    ['p2', 'x$`y'],
    ['p3', "p$'q"],
    ['p4', 'cost $5 $& done'],
    ['p5', 'q$1w'],
  ]) {
    it(`writes ${JSON.stringify(name)} verbatim into the heading`, async () => {
      seedRenamable(id);

      await mod.renameSession(id, name);

      const md = fs.readFileSync(mdPath(id), 'utf8');
      assert.strictEqual(md.split('\n')[0], `# ${name}`,
        `the heading must be the literal name, not a substituted pattern (got ${JSON.stringify(md.split('\n')[0])})`);
      assert.ok(!md.includes('# Old name'), 'no fragment of the prior heading may survive');
      // The contract being restored: the two halves of one session must agree.
      assert.strictEqual(mod.getSession(id).name, name, 'the JSON name and the .md heading must agree');
      assert.strictEqual(md, `# ${name}\n${BODY}`, 'only the heading line changes; the body is untouched');
    });
  }

  it("does not grow the transcript across repeated $' renames (each rename used to double it)", async () => {
    seedRenamable('p6');
    const bytes = () => fs.statSync(mdPath('p6')).size;
    const startBytes = bytes();

    await mod.renameSession('p6', "p$'q");
    const afterFirstBytes = bytes();

    await mod.renameSession('p6', "p$'q");
    const afterSecondBytes = bytes();
    const afterSecond = fs.readFileSync(mdPath('p6'), 'utf8');

    // A single call shows growth; only a second call demonstrates the compounding.
    assert.strictEqual(afterSecondBytes, afterFirstBytes,
      'a repeated rename must be a fixed point — the buggy form doubled the file each time');
    // Both headings are ASCII, so the only legitimate change is their length delta.
    assert.strictEqual(afterFirstBytes, startBytes + "p$'q".length - 'Old name'.length,
      'the file changes only by the heading-length delta');
    assert.strictEqual(afterSecond.split('secret body line').length - 1, 1,
      'the transcript body must appear exactly once, not be re-injected by $\'');
    assert.strictEqual(afterSecond, `# p$'q\n${BODY}`);
  });

  it('leaves a plain-name rename byte-for-byte as before', async () => {
    seedRenamable('p7');

    await mod.renameSession('p7', 'plain rename');

    assert.strictEqual(fs.readFileSync(mdPath('p7'), 'utf8'), `# plain rename\n${BODY}`);
  });
});
