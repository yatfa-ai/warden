import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * WARDEN-2135 — pin Observer#serializeForUi, the item mapping behind the ws
 * 'history' frame. The method reconstructs the UI conversation from the raw LLM
 * message history; its only caller is the history push on every observer socket
 * connect/reconnect (src/wsLayer.js, `items: obs.serializeForUi()`), so whatever
 * it returns is exactly what JSON.stringify puts on the wire and the operator's
 * ObserverPanel renders.
 *
 * The four-branch mapping loop had never executed under any test — a
 * branch-level gap, not a zero-coverage claim on the symbol: the method DOES
 * run on every connect, but only on sessions with zero messages, so none of the
 * branches was ever taken. This file pins the invariants nothing else asserts:
 *   1. user string content maps verbatim to { role: 'user', text };
 *   2. user ARRAY content — the tool_result batch — produces NO item;
 *   3. assistant text blocks with falsy text are dropped;
 *   4. tool_use blocks map to { role: 'tool', name, id }, with id read from
 *      input.id — the shared server+web convention (web/src/lib/types.ts
 *      declares `input?: { id?: string }`; ObserverPanel maps item.id to the
 *      ToolChip arg) — defaulting to '';
 *   5. the '' id default is a WIRE default: the key survives JSON.stringify,
 *      never undefined (an undefined value would be dropped from the frame and
 *      the ToolChip arg lookup on the web side would see no id at all);
 *   6. interleaved user / assistant / tool order is preserved;
 *   7. the projection NEVER THROWS on unrecognized persisted shapes — messages
 *      are disk-owned, so a legacy/corrupt {sid}.json must not crash the
 *      history push that runs on every reconnect.
 *
 * Harness follows the sanctioned observer-send-directive.test.js pattern
 * (WARDEN-1880 / WARDEN-1071 Principle 2): HOME is redirected to a throwaway
 * dir BEFORE the dynamic import, so the freshly loaded module instances pin
 * their data-dir constants (observer.js DIRECTIVES_LOG / DATA_DIR, computed
 * from os.homedir() at module load) to the temp home. Nothing under the real
 * ~/.yatfa-warden is ever touched.
 *
 * No session store, no LLM, no I/O: serializeForUi reads this.messages and
 * nothing else, so the documented DI constructor seam builds the instance bare
 * (`new Observer({})` — sid-less, gate-less, io-less) and each test hands it a
 * literal messages array.
 */

describe('Observer#serializeForUi — ws history-frame item mapping (redirected HOME — WARDEN-2135)', () => {
  let savedHome, tempHome;
  let Observer, DIRECTIVES_LOG, DATA_DIR;

  before(async () => {
    savedHome = process.env.HOME;
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-observer-2135-'));
    process.env.HOME = tempHome;
    fs.mkdirSync(path.join(tempHome, '.yatfa-warden'), { recursive: true });
    // Dynamic imports AFTER the HOME redirect: fresh module instances pin their
    // data-dir constants to the temp home.
    ({ Observer, DIRECTIVES_LOG, DATA_DIR } = await import('./observer.js'));
    // Positive control: the pins must live in the temp home, or the redirect
    // failed and the loaded modules would read the real data dir.
    assert.ok(DIRECTIVES_LOG.startsWith(tempHome), 'log path must be redirected into the temp HOME');
    assert.ok(DATA_DIR.startsWith(tempHome), 'data dir must be redirected into the temp HOME');
  });

  after(() => {
    if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
    try { fs.rmSync(tempHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  // A bare Observer over a hand-built messages array. serializeForUi() is pure
  // over this.messages, so no io bag, gate, or sid is involved anywhere below.
  function obsWith(messages) {
    const obs = new Observer({});
    obs.messages = messages;
    return obs;
  }

  it('maps user string content verbatim to { role: "user", text }', () => {
    const text = 'ship the migration, keep the rollback script';
    const items = obsWith([{ role: 'user', content: text }]).serializeForUi();
    // deepStrictEqual is key-set EXACT: the emitted item carries exactly the
    // two keys the web side renders — no more, no less.
    assert.deepEqual(items, [{ role: 'user', text }]);
  });

  it('emits NO item for a user tool_result batch (array content)', () => {
    const items = obsWith([
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'open=3 idle=1' }] },
      // a tool_result whose own content is a block array (the Anthropic shape)
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_2', content: [{ type: 'text', text: 'pane dump' }] }] },
    ]).serializeForUi();
    assert.deepEqual(items, [], 'tool_result batches are internal plumbing and must not surface in the UI history');
  });

  it('drops assistant text blocks with falsy text', () => {
    const items = obsWith([
      { role: 'assistant', content: [
        { type: 'text', text: '' },
        { type: 'text', text: null },
        { type: 'text' }, // text omitted entirely
        { type: 'text', text: 'kept' },
      ] },
    ]).serializeForUi();
    assert.deepEqual(items, [{ role: 'assistant', text: 'kept' }]);
  });

  it('maps tool_use blocks to { role: "tool", name, id } reading id from input.id', () => {
    const items = obsWith([
      { role: 'assistant', content: [
        { type: 'tool_use', name: 'send_directive', input: { id: 'myproject-worker', directive: 'ship it' } },
        { type: 'tool_use', name: 'read_chats', input: { open_only: true } }, // input present, no id in it
        { type: 'tool_use', name: 'list_chats' },                             // no input at all
      ] },
    ]).serializeForUi();
    assert.deepEqual(items, [
      { role: 'tool', name: 'send_directive', id: 'myproject-worker' },
      { role: 'tool', name: 'read_chats', id: '' },
      { role: 'tool', name: 'list_chats', id: '' },
    ]);
  });

  it('defaults the tool id to "" on the wire — the key survives JSON.stringify, never undefined', () => {
    const items = obsWith([
      { role: 'assistant', content: [{ type: 'tool_use', name: 'list_chats' }] },
    ]).serializeForUi();
    // This is the exact value wsLayer JSON.stringifies onto the 'history'
    // frame: a missing input.id must land as the literal "" string, because an
    // undefined value is DROPPED from the JSON and the web-side ToolChip arg
    // lookup (ObserverPanel reading item.id) would see no key at all.
    const wire = JSON.stringify(items);
    assert.ok(wire.includes('"id":""'), `wire frame must carry "id":"", got: ${wire}`);
    assert.strictEqual(items[0].id, '');
  });

  it('preserves interleaved user / assistant / tool order', () => {
    const items = obsWith([
      { role: 'user', content: 'start the migration' },
      { role: 'assistant', content: [
        { type: 'text', text: 'On it — checking the panes first.' },
        { type: 'tool_use', name: 'read_chats', input: { open_only: true } },
      ] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_9', content: 'panes...' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'All three agents are idle.' }] },
      { role: 'user', content: 'ship it' },
    ]).serializeForUi();
    assert.deepEqual(items, [
      { role: 'user', text: 'start the migration' },
      { role: 'assistant', text: 'On it — checking the panes first.' },
      { role: 'tool', name: 'read_chats', id: '' },
      { role: 'assistant', text: 'All three agents are idle.' },
      { role: 'user', text: 'ship it' },
    ]);
  });

  it('never throws on unrecognized persisted shapes', () => {
    const obs = obsWith([
      null,
      { role: 'assistant', content: [null, { type: 'text', text: 'text after a null block' }] },
      { role: 'assistant', content: 'legacy plain-string assistant turn' },
      { role: 'assistant', content: null },
      { role: 'assistant', content: { type: 'text', text: 'content is an object, not an array' } },
      { role: 'system', content: 'a persisted system prompt' },
      { role: 'tool', content: 'orphan tool turn' },
      { role: 'user', content: null },
      { role: 'user', content: [{ type: 'text', text: 'user array text (still not a string)' }] },
      { content: 'a message with no role at all' },
      { role: 'assistant', content: [{ type: 'unknown_block', data: 1 }, { type: 'text', text: 'still rendered among the junk' }] },
    ]);
    let items;
    // Messages are disk-owned: a legacy/corrupt {sid}.json must not crash the
    // 'history' push that runs on every observer socket connect/reconnect.
    assert.doesNotThrow(() => { items = obs.serializeForUi(); }, 'serializeForUi must never throw on unrecognized persisted shapes');
    assert.ok(Array.isArray(items));
    // Tolerance is per-message, not a blanket empty result: the one
    // recognizable turn among the junk still reaches the operator.
    assert.deepEqual(items, [
      { role: 'assistant', text: 'text after a null block' },
      { role: 'assistant', text: 'still rendered among the junk' },
    ]);
  });
  // WARDEN-2153 — `messages` itself is disk-owned too: a {sid}.json with valid
  // JSON but a non-array `messages` passes the defensive reader (only unparseable
  // files are backed up), so the constructor must not keep it verbatim.
  for (const [label, bad] of [['{}', {}], ['5', 5]]) {
    it(`constructor yields [] from a persisted non-array messages (${label}) and serializeForUi does not throw`, () => {
      const sid = `bad-messages-${label === '{}' ? 'obj' : 'num'}`;
      const dir = path.join(tempHome, '.yatfa-warden', 'sessions');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${sid}.json`), JSON.stringify({ id: sid, name: 'x', messages: bad }));
      const obs = new Observer({}, { sid });
      assert.deepStrictEqual(obs.messages, []);
      let items;
      assert.doesNotThrow(() => { items = obs.serializeForUi(); });
      assert.deepStrictEqual(items, []);
    });
  }
});
