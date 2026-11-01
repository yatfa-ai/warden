import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readLocalSessionTranscript, SESSION_VIEW_MAX_BYTES } from './claudeSessionsLocal.js';

// WARDEN-2067 — pins the `if (before == null) byteTruncated = size > cap` guard
// in readLocalSessionTranscript. `truncated` from the byte bound is a FIRST-PAGE
// signal only: an older window is bounded to the cap by construction, so its
// `truncated` reflects only the within-window message cap. Dropping the guard
// leaves every other local test green because they read older pages of files far
// under the cap (size > cap is false either way) or never assert `truncated` on
// an older page. This fixture is ~1MB of ~2KB lines, so each 400KB window holds
// ~200 messages: only the BYTE bound can set `truncated`, the 500-message cap
// cannot mask it.
//
// os.homedir() reads $HOME at call time, so each example points HOME at a tmp dir.

let savedHome;
let home;
let projectDir;

beforeEach(() => {
  savedHome = process.env.HOME;
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-older-page-'));
  process.env.HOME = home;
  projectDir = path.join(home, '.claude', 'projects', 'p');
  fs.mkdirSync(projectDir, { recursive: true });
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
  fs.rmSync(home, { recursive: true, force: true });
});

function assistantLine(i, padLen) {
  return JSON.stringify({
    type: 'assistant',
    timestamp: `2026-01-01T00:00:${String(i % 60).padStart(2, '0')}Z`,
    message: { role: 'assistant', content: [{ type: 'text', text: `m${i} ${'x'.repeat(padLen)}` }] },
  });
}

function writeSession(id, lineCount, padLen) {
  const lines = [JSON.stringify({ type: 'user', cwd: '/repo/older-page', message: { role: 'user', content: 'hi' } })];
  for (let i = 0; i < lineCount; i++) lines.push(assistantLine(i, padLen));
  const fp = path.join(projectDir, `${id}.jsonl`);
  fs.writeFileSync(fp, lines.join('\n') + '\n');
  return fp;
}

describe('readLocalSessionTranscript — truncated is first-page-only (WARDEN-2067)', () => {
  it('flags truncated on the first page of an over-cap file and not on an older page', async () => {
    const fp = writeSession('sess-older', 500, 2000);
    assert.ok(fs.statSync(fp).size > SESSION_VIEW_MAX_BYTES * 2, 'fixture must span several windows');

    const first = await readLocalSessionTranscript('sess-older', {});
    assert.equal(first.cwd, '/repo/older-page');
    assert.equal(first.truncated, true, 'first page of an over-cap file is byte-truncated');
    assert.equal(first.hasMore, true);
    assert.ok(first.messages.length < 500, 'byte bound, not message cap, limits the first page');

    const older = await readLocalSessionTranscript('sess-older', { before: first.prevCursor });
    assert.equal(older.cwd, '', 'older page skips the head read');
    assert.equal(older.truncated, false, 'an older window is bounded by construction');
    assert.ok(older.messages.length > 0);
    assert.ok(older.messages.length < 500, 'message cap cannot be what keeps truncated false');
    assert.equal(older.hasMore, true, 'a further-back window still exists');
  });

  it('reports truncated false and hasMore false for a small file', async () => {
    const fp = writeSession('sess-small', 3, 20);
    assert.ok(fs.statSync(fp).size < SESSION_VIEW_MAX_BYTES);
    const view = await readLocalSessionTranscript('sess-small', {});
    assert.equal(view.truncated, false);
    assert.equal(view.hasMore, false);
    assert.equal(view.messages.length, 4);
  });
});
