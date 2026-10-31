import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { localClaudeSessions } from './claudeSessionsLocal.js';

// WARDEN-2043 — pins localClaudeSessions' OWN catalog contract (the leaf module
// WARDEN-2033 split out of claudeSessions.js). The symbol is exercised widely at
// the route/server/cache layers (session-view, claudeSessionsRoutes,
// server-claude-sessions, sessionCache, server-budget, *unreachable), but every
// one of those examples builds well-formed sessions (cwd present, .jsonl only,
// limits at or above the fixture count), so three one-token mutations of this
// module survive the entire `node --test src` suite:
//   1. `out.filter((s) => s.cwd)` dropped — a transcript with no readable cwd
//      (summary-only or empty .jsonl) must NOT be listed in the resume catalog;
//   2. the `.endsWith('.jsonl')` enumeration filter dropped — a sibling
//      non-session file whose lines carry a cwd (e.g. a *.json index) must not
//      become a bogus session row;
//   3. the function-level `.slice(0, limit)` dropped — the route layer slices
//      again, so only a direct caller sees this bound (the 40 default, and the
//      large windows the budget sweeps pass).
// These examples call the exported function directly over real fs, so each
// mutation changes the returned array the assertions read (reachability).
//
// os.homedir() reads $HOME at CALL time inside this module (no import-time
// freeze — WARDEN-1071's one-concern-per-file freeze does not apply here), so
// every example points HOME at its own mkdtemp dir and seeds mtimes with utimes
// for a deterministic newest-first order.

let savedHome;
let home;
let projectsDir;

beforeEach(() => {
  savedHome = process.env.HOME;
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-claudeSessionsLocal-'));
  process.env.HOME = home;
  projectsDir = path.join(home, '.claude', 'projects');
});

afterEach(() => {
  process.env.HOME = savedHome;
  fs.rmSync(home, { recursive: true, force: true });
});

// Write one session transcript and pin its mtime so the newest-first order is
// deterministic. Lines are JSON objects written one per line (real JSONL shape).
function writeSession(project, id, lines, mtimeSec) {
  const dir = path.join(projectsDir, project);
  fs.mkdirSync(dir, { recursive: true });
  const fp = path.join(dir, `${id}.jsonl`);
  fs.writeFileSync(fp, lines.map((l) => JSON.stringify(l)).join('\n') + (lines.length ? '\n' : ''));
  if (mtimeSec != null) fs.utimesSync(fp, mtimeSec, mtimeSec);
  return fp;
}

// The minimal transcript localClaudeSessions lists: one user turn carrying both
// the cwd the catalog filter requires and the message it summarizes.
function cwdLine(cwd) {
  return { type: 'user', cwd, message: { role: 'user', content: 'hello' } };
}

describe('localClaudeSessions catalog contract', () => {
  it('omits a session whose transcript carries no cwd', async () => {
    // summary-only: a user message but no cwd anywhere in the file.
    writeSession('p1', 'summary-only', [
      { type: 'user', message: { role: 'user', content: 'orphan summary' } },
    ], 1000);
    // empty transcript: nothing readable at all.
    writeSession('p1', 'empty', [], 1001);
    // the well-formed one: cwd + user message.
    writeSession('p1', 'real', [cwdLine('/home/u/proj')], 1002);

    const out = await localClaudeSessions();
    assert.equal(out.length, 1);
    assert.equal(out[0].id, 'real');
    assert.equal(out[0].cwd, '/home/u/proj');
    assert.equal(out[0].summary, 'hello');
  });

  it('lists only *.jsonl files — a sibling non-session file with cwd lines is not a session', async () => {
    writeSession('p1', 'real', [cwdLine('/home/u/proj')], 1000);
    // Two non-.jsonl siblings whose lines are perfectly valid cwd-bearing
    // session records: neither may surface as a session row.
    fs.writeFileSync(
      path.join(projectsDir, 'p1', 'notes.txt'),
      `${JSON.stringify(cwdLine('/home/u/leaked'))}\n`,
    );
    fs.writeFileSync(
      path.join(projectsDir, 'p1', 'sessions-index.json'),
      `${JSON.stringify(cwdLine('/home/u/leaked-too'))}\n`,
    );

    const out = await localClaudeSessions();
    assert.deepEqual(out.map((s) => s.id), ['real']);
  });

  it('returns the newest-first limit window across project dirs; id is the basename minus .jsonl', async () => {
    // Four sessions across two project dirs with interleaved mtimes, so the
    // newest-first sort is proven GLOBAL across dirs, not per-dir.
    writeSession('alpha', 's-oldest', [cwdLine('/w/1')], 1000);
    writeSession('beta', 's-third', [cwdLine('/w/2')], 1001);
    writeSession('beta', 's-second', [cwdLine('/w/4')], 1002);
    writeSession('alpha', 's-newest', [cwdLine('/w/3')], 1003);

    // The function-level bound: exactly `limit` rows, newest first.
    const two = await localClaudeSessions(2);
    assert.deepEqual(two.map((s) => s.id), ['s-newest', 's-second']);

    const one = await localClaudeSessions(1);
    assert.deepEqual(one.map((s) => s.id), ['s-newest']);

    // Default (40): everything seeded, still newest-first, each row keeping its
    // own cwd — and the id is the file basename minus the .jsonl suffix.
    const all = await localClaudeSessions();
    assert.deepEqual(all.map((s) => s.id), ['s-newest', 's-second', 's-third', 's-oldest']);
    assert.deepEqual(all.map((s) => s.cwd), ['/w/3', '/w/4', '/w/2', '/w/1']);
  });

  it('returns [] when the projects dir does not exist', async () => {
    // HOME exists (beforeEach), but ~/.claude/projects was never created.
    const out = await localClaudeSessions();
    assert.deepEqual(out, []);
  });

  it('does not break listing when a stray .DS_Store file sits in the projects root', async () => {
    // Negative control (WARDEN-2035): the projects root holds a non-directory
    // entry; the per-entry isDirectory guard must skip it and still list the
    // real session. (Removing the guard is an equivalent mutation — readdir on
    // a regular file throws into the WARDEN-2029 per-dir catch — so this pins
    // the behaviour, not a kill.)
    fs.mkdirSync(projectsDir, { recursive: true });
    fs.writeFileSync(path.join(projectsDir, '.DS_Store'), 'not a directory');
    writeSession('p1', 'real', [cwdLine('/home/u/proj')], 1000);

    const out = await localClaudeSessions();
    assert.deepEqual(out.map((s) => s.id), ['real']);
  });
});
