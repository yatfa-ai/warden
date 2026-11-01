import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { readTranscriptPhase } from './transcriptPhase.js';

// WARDEN-2065: pins readLocalTranscriptTail's 8 KB TAIL window through
// readTranscriptPhase's public return value. Every fixture in observer.test.js
// and transcriptPhase-local.test.js is under 8 KB, so `size - len === 0` there
// and reading the head instead of the tail is invisible. Own file so the HOME
// redirect is process-isolated.

const asst = (stop, pad = '') => JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: pad }], stop_reason: stop } });
const user = () => JSON.stringify({ type: 'user', message: { role: 'user', content: 'go' } });
const LOCAL_CHAT = { container: null, host: '(local)', key: 'm', session: 'm' };

describe('readTranscriptPhase local branch — 8 KB tail window', () => {
  let realHome;
  let tmp;
  before(() => {
    realHome = process.env.HOME;
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-phase-tail-'));
    process.env.HOME = tmp;
  });
  after(() => {
    process.env.HOME = realHome;
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  const write = (body) => {
    const d = path.join(tmp, '.claude', 'projects', 'p');
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 's.jsonl'), body);
  };

  it('decides the phase from the END of a transcript larger than the 8 KB window (end_turn in the head, tool_use at the tail)', async () => {
    const body = [user(), asst('end_turn'), asst('end_turn', 'x'.repeat(20000)), user(), asst('tool_use')].join('\n') + '\n';
    assert.ok(Buffer.byteLength(body) > 8192 * 2);
    write(body);
    assert.strictEqual(await readTranscriptPhase(LOCAL_CHAT), 'mid-turn');
  });

  it('a big tool_use head with an end_turn tail reads awaiting-input (the window cuts a padded line mid-way and the partial line is dropped)', async () => {
    write([user(), asst('tool_use', 'x'.repeat(20000)), user(), asst('end_turn')].join('\n') + '\n');
    assert.strictEqual(await readTranscriptPhase(LOCAL_CHAT), 'awaiting-input');
  });
});
