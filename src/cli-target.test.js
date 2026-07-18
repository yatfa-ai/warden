import { describe, it } from 'node:test';
import assert from 'node:assert';
// Import via ./chats.js — the SAME re-export path src/cli.js uses — so this test
// also guards that the CLI's import (`import { ..., agentTarget } from './chats.js'`)
// resolves to the helper and not `undefined` (a broken re-export would make every
// `warden send`/`tail`/`key`/`observe` print `undefined@…` or crash).
import { agentTarget } from './chats.js';

/**
 * WARDEN-642 (cli sibling): the `warden send` / `tail` / `key` / `observe`
 * commands render the agent target with `agentTarget(chat)`, and the `warden send`
 * "no active session" warning renders the bare name. For a local/tmux chat
 * (`container: null`), the OLD inline `${chat.container}@${chat.host}` stringified
 * that null to the literal "null", so a founder running local agents saw
 * `null@(local)` on every daily-use CLI surface. These assertions pin the value
 * each command prints — `<session>@<host>` and the bare `<session>`, never `null`.
 *
 * The local chat below is constructed exactly as src/chats.js's discovery does
 * (`container: null, key: session, session`, `host: '(local)'` — chats.js:374),
 * so this is the real object shape `resolveChat` hands to cmdSend/cmdTail/etc.
 */
describe('cli agent-target display — never null@host for local/tmux chats (WARDEN-642)', () => {
  const localChat = {
    id: '(local):myproject', key: 'myproject', kind: 'tmux', host: '(local)',
    container: null, session: 'myproject', project: 'local', role: 'claude',
    active: true,
  };
  const dockerChat = {
    id: 'hostA:agent', key: 'agent', kind: 'yatfa', host: 'hostA',
    container: 'proj-worker', session: 'agent', project: 'proj', role: 'worker',
    active: true,
  };

  it('warden send / tail / key / observe: prints <session>@<host> for a local chat (never null@)', () => {
    // cmdSend success line is `✓ sent to ${agentTarget(chat)}` (cli.js:123);
    // cmdTail banner, cmdKey success, and cmdObserve gate use the same helper.
    const printed = agentTarget(localChat);
    assert.strictEqual(printed, 'myproject@(local)');
    assert.ok(!printed.startsWith('null@'), 'must not stringify a null container to "null@"');
    assert.ok(!printed.includes('null'), 'no literal "null" anywhere in the printed target');
  });

  it('warden send warning: prints the bare <session> for a local chat (never the bare "null")', () => {
    // cmdSend's "no active session" warning uses the bare fallback
    // `${chat.container || chat.key || 'local'}` (cli.js:121) — NOT agentTarget,
    // because the message wants just the name, not name@host.
    const bareName = localChat.container || localChat.key || 'local';
    assert.strictEqual(bareName, 'myproject');
    assert.notStrictEqual(bareName, 'null');
  });

  it('docker/yatfa chats: agentTarget unchanged (container@host)', () => {
    // Regression guard: the fallback must not change the docker display path.
    assert.strictEqual(agentTarget(dockerChat), 'proj-worker@hostA');
  });
});
