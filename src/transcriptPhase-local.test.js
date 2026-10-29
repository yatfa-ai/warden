import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { readTranscriptPhase } from './transcriptPhase.js';

// WARDEN-2022: pins the file-selection clauses of the private
// readLocalTranscriptTail through readTranscriptPhase's public return value.
// The single-file examples in observer.test.js never present a second
// candidate, so newest-mtime wins / .jsonl-only / directory-only go unasserted
// there. Own file so the HOME redirect is process-isolated.

const line = (type, stop) => JSON.stringify(type === 'user'
  ? { type, message: { role: 'user', content: 'go' } }
  : { type, message: { role: 'assistant', content: [], stop_reason: stop } });
const LOCAL_CHAT = { container: null, host: '(local)', key: 'm', session: 'm' };

describe('readTranscriptPhase local branch — transcript selection', () => {
  let realHome;
  let tmp;
  before(() => {
    realHome = process.env.HOME;
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-phase-sel-'));
    process.env.HOME = tmp;
  });
  after(() => {
    process.env.HOME = realHome;
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  const proj = (n) => {
    const d = path.join(tmp, '.claude', 'projects', n);
    fs.mkdirSync(d, { recursive: true });
    return d;
  };
  const put = (fp, body, mtime) => { fs.writeFileSync(fp, body); fs.utimesSync(fp, mtime, mtime); };
  const wipe = () => fs.rmSync(path.join(tmp, '.claude'), { recursive: true, force: true });
  const ended = [line('user'), line('assistant', 'end_turn')].join('\n') + '\n';
  const mid = [line('user'), line('assistant', 'tool_use')].join('\n') + '\n';

  it('reads the most-recently-modified .jsonl across projects, not the oldest', async () => {
    wipe();
    put(path.join(proj('a'), 'old.jsonl'), ended, 1000);
    put(path.join(proj('b'), 'new.jsonl'), mid, 2000);
    assert.strictEqual(await readTranscriptPhase(LOCAL_CHAT), 'mid-turn');
    fs.utimesSync(path.join(tmp, '.claude/projects/a/old.jsonl'), 3000, 3000); // now newest
    assert.strictEqual(await readTranscriptPhase(LOCAL_CHAT), 'awaiting-input');
  });

  it('ignores non-.jsonl files even when they are the newest', async () => {
    wipe();
    const d = proj('a');
    put(path.join(d, 's.jsonl'), ended, 1000);
    put(path.join(d, 'notes.txt'), mid, 5000);
    assert.strictEqual(await readTranscriptPhase(LOCAL_CHAT), 'awaiting-input');
  });

  it('skips stray non-directory entries under projects/', async () => {
    wipe();
    put(path.join(proj('a'), 's.jsonl'), ended, 1000);
    put(path.join(tmp, '.claude', 'projects', 'stray.jsonl'), 'x', 9000);
    assert.strictEqual(await readTranscriptPhase(LOCAL_CHAT), 'awaiting-input');
  });
});
