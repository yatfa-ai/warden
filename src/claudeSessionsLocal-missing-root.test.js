import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readLocalSessionTranscript } from './claudeSessionsLocal.js';

// WARDEN-2191 — pins the projects-ROOT leg of findLocalSessionFile (module-private,
// reached through readLocalSessionTranscript). Its first statement is a two-arm
// guard on fsp.readdir(~/.claude/projects):
//   - ENOENT (no projects dir at all) → null → { notFound: true } (the route's 404);
//   - any other failure (e.g. EACCES on the root) → rethrown, never laundered into
//     null, so it reaches the route's 500/{error} channel (WARDEN-2026/2031).
// The existing suites pin only the per-PROJECT-dir legs (session-view.test.js) and
// seed a projects archive in every example, so neither root arm was exercised.
//
// os.homedir() reads $HOME at call time, so each example points HOME at a tmp dir.

let savedHome;
let home;
let root;

beforeEach(() => {
  savedHome = process.env.HOME;
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-missing-root-'));
  process.env.HOME = home;
  root = path.join(home, '.claude', 'projects');
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
  // The EACCES example restores the mode itself; this is a belt for an aborted run.
  try { fs.chmodSync(root, 0o755); } catch { /* root may not exist */ }
  fs.rmSync(home, { recursive: true, force: true });
});

function seedSession(id) {
  const dir = path.join(root, 'p');
  fs.mkdirSync(dir, { recursive: true });
  const lines = [
    JSON.stringify({ type: 'user', cwd: '/repo/missing-root', message: { role: 'user', content: 'hi' } }),
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-01-01T00:00:00Z',
      message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
    }),
  ];
  fs.writeFileSync(path.join(dir, `${id}.jsonl`), lines.join('\n') + '\n');
}

// Root bypasses mode bits, so the unreadable-root example cannot run there.
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
const skipRoot = isRoot ? 'running as root: chmod 000 does not block reads' : false;

describe('readLocalSessionTranscript — projects root leg of findLocalSessionFile (WARDEN-2191)', () => {
  it('answers { notFound: true } when ~/.claude/projects does not exist', async () => {
    assert.equal(fs.existsSync(root), false, 'fixture: no projects root');
    assert.deepStrictEqual(await readLocalSessionTranscript('sess-any', {}), { notFound: true });
  });

  it('answers { notFound: true } for an unknown id over a missing root', async () => {
    assert.deepStrictEqual(await readLocalSessionTranscript('no-such-session-id', {}), { notFound: true });
  });

  it('answers { notFound: true } when the projects root exists but is empty', async () => {
    fs.mkdirSync(root, { recursive: true });
    assert.deepStrictEqual(await readLocalSessionTranscript('sess-any', {}), { notFound: true });
  });

  it('answers { notFound: true } (no throw) when the projects root holds only a stray file', async () => {
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'stray.txt'), 'not a project dir');
    assert.deepStrictEqual(await readLocalSessionTranscript('sess-any', {}), { notFound: true });
  });

  it('answers { notFound: true } for an older-page read ({ before }) over a missing root', async () => {
    assert.deepStrictEqual(await readLocalSessionTranscript('sess-any', { before: 400000 }), { notFound: true });
  });

  it('control: a seeded session still resolves, so the fixture is not vacuous', async () => {
    seedSession('sess-control');
    const view = await readLocalSessionTranscript('sess-control', {});
    assert.equal(view.notFound, undefined);
    assert.equal(view.cwd, '/repo/missing-root');
    assert.equal(view.messages.length, 2);
  });

  it('rejects with EACCES (not { notFound }) when the projects root is unreadable', { skip: skipRoot }, async () => {
    seedSession('sess-locked');
    fs.chmodSync(root, 0o000);
    try {
      await assert.rejects(() => readLocalSessionTranscript('sess-locked', {}), { code: 'EACCES' });
    } finally {
      fs.chmodSync(root, 0o755);
    }
  });
});
