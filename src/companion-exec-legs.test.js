// WARDEN-1284 — routing the remaining NINE script-delivery legs onto the
// companion `exec` RPC.
//
// WARDEN-1261 put the git domain (runGit / runInContext) on the persistent
// companion channel behind the `companionTransportEnabled` toggle. Nine "deliver
// an already-assembled script to a remote host, read the cmdResult" call sites
// were left spawning their own un-pooled `ssh` per call:
//
//   1  file viewer read            readChatFile (REMOTE branch)        server.js
//   2  linkifier existence probe   remoteFileExists                    server.js
//   3  session search              remoteSearchClaudeSessions          server.js
//   4  session transcript view     remoteReadSessionTranscript         server.js
//   5  session-browser listing     remoteClaudeSessionsDetail   claudeSessions.js
//   6  observer tail, container    readTranscriptPhase (docker exec)   observer.js
//   7  observer tail, bare remote  readTranscriptPhase                 observer.js
//   8  tmux presence preflight     preflightTmux (REMOTE branch)       server.js
//   9  claude-install detection    detectClaude (REMOTE probes)             ssh.js
//
// This suite drives the REAL exported functions through the shared routing seam
// (`deps` = { isCompanionTransportEnabled, execInContext, run }) — no real ssh —
// and pins the ticket's four contracts PER LEG:
//
//   PARITY        the bash-delivered command under the flag is BYTE-IDENTICAL to
//                 the string run() receives with the flag off. Asserted by
//                 driving the same call twice and comparing the two captured
//                 strings, then pinning the expected shape explicitly so a
//                 quoting drift in EITHER path fails with a readable diff. This
//                 is the whole ticket in one assertion: whichever transport
//                 serves the leg, the host executes the same command.
//   DELEGATION    under the flag a REMOTE call issues ZERO run() spawns.
//   COMPANION-OR-FAIL  a channel/bootstrap failure propagates through the leg's
//                 own error handling; run() is NEVER consulted as a fallback.
//   FLAG-OFF      with the toggle off the companion is never touched and the
//                 delivered command + opts are byte-for-byte the pre-1284 ones.
//
// LOCAL branches are covered too: they must never reach the companion, flag or
// not — every one of these legs is reached only on the REMOTE side.
//
// Leg 6 carries the one delivery nuance worth its own test: the observer's
// container branch delivers `docker exec <c> sh -c <script>` — `sh -c`, NOT
// `bash -lc`. Parity therefore requires the FULL pre-assembled string to ride as
// the script with `container` UNSET; routing it through `container` would have
// the companion's host side rebuild it as `docker exec <c> bash -lc <script>`,
// silently changing the in-container interpreter. Both halves are pinned below.

import { describe, it, beforeEach, afterEach, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { deliverRemoteScript } from './companion.js';
import { shellQuote, detectClaude } from './ssh.js';
import { remoteClaudeSessionsDetail, buildRemoteSessionScript, buildSessionReadScript } from './claudeSessions.js';
import { readTranscriptPhase, buildTranscriptTailScript } from './observer.js';

// server.js reads config/catalog and rotates activity logs at module load, so
// redirect HOME before the single import (the file-exists.test.js discipline).
const TEMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-1284-home-'));
process.env.HOME = TEMP_HOME;
const {
  readChatFile, remoteFileExists, remoteSearchClaudeSessions,
  remoteReadSessionTranscript, preflightTmux,
  buildReadFileScript, buildFileExistsScript, buildSessionSearchScript,
} = await import('./server.js');

after(() => {
  try { fs.rmSync(TEMP_HOME, { recursive: true, force: true }); } catch { /* best-effort */ }
});

const ORIG_ENV = process.env.WARDEN_COMPANION_TRANSPORT;
const REMOTE = 'prod-1';
const LOCAL = '(local)';

// A companion result that satisfies every leg's success predicate. `ok:true`
// plus stdout the leg's own parser will accept — the legs are exercised for
// ROUTING here, their parsers have their own suites.
const okResult = (stdout = '') => ({ host: REMOTE, ok: true, code: 0, stdout, stderr: '' });

// The companion-or-fail envelope execInContext produces on a dead channel: the
// message rides stderr (the raw run() shape), never an `error` field.
const CHANNEL_DEAD = {
  host: REMOTE, ok: false, code: -1, stdout: '',
  stderr: `companion transport error for ${REMOTE}: channel died. Set WARDEN_COMPANION_TRANSPORT=0 to use the default SSH path.`,
};

// Drive ONE leg twice — flag ON (capturing what reaches the companion) and flag
// OFF (capturing what reaches run()) — and return both captures plus the opts
// each transport saw. `invoke(deps)` calls the real exported function.
async function captureBothTransports(invoke, { stdout = '' } = {}) {
  const on = { script: null, opts: null, host: null, cfg: null, runCalls: 0 };
  process.env.WARDEN_COMPANION_TRANSPORT = '1';
  await invoke({
    execInContext: async (host, script, opts, cfg) => {
      on.host = host; on.script = script; on.opts = opts; on.cfg = cfg;
      return okResult(stdout);
    },
    run: async () => { on.runCalls++; throw new Error('flag ON must not touch run()'); },
  });

  const off = { cmd: null, opts: null, host: null, companionCalls: 0 };
  process.env.WARDEN_COMPANION_TRANSPORT = '0';
  await invoke({
    execInContext: async () => { off.companionCalls++; throw new Error('flag OFF must not touch the companion'); },
    run: async (host, cmd, opts) => { off.host = host; off.cmd = cmd; off.opts = opts; return okResult(stdout); },
  });
  process.env.WARDEN_COMPANION_TRANSPORT = '1';
  return { on, off };
}

// The three per-leg claims every leg shares, asserted from one pair of captures.
// `expectedScript` pins the shape explicitly (not just the identity) so a
// quoting drift in BOTH paths at once still fails.
function assertParity({ on, off }, { expectedScript, timeout }) {
  assert.strictEqual(on.script, off.cmd,
    `the delivered script must be byte-identical on both paths:\ncompanion: ${on.script}\nrun():     ${off.cmd}`);
  assert.strictEqual(off.cmd, expectedScript, 'the delivered command is the pre-WARDEN-1284 one');
  assert.strictEqual(on.host, REMOTE, 'the companion is asked for the same host');
  assert.strictEqual(off.host, REMOTE);
  assert.strictEqual(on.opts.timeout, timeout, 'the leg keeps its deadline on the companion path');
  assert.deepStrictEqual(off.opts, { timeout }, 'the default path keeps its exact opts');
  assert.strictEqual(on.opts.container, '', 'host-scoped leg -> no container (bare `bash -lc` delivery)');
  assert.strictEqual(on.runCalls, 0, 'the companion path issues ZERO per-op ssh spawns');
  assert.strictEqual(off.companionCalls, 0, 'flag OFF -> the companion is never consulted');
}

describe('WARDEN-1284 — the nine script-delivery legs route onto the companion `exec` RPC', () => {
  beforeEach(() => { process.env.WARDEN_COMPANION_TRANSPORT = '1'; });
  afterEach(() => {
    if (ORIG_ENV === undefined) delete process.env.WARDEN_COMPANION_TRANSPORT;
    else process.env.WARDEN_COMPANION_TRANSPORT = ORIG_ENV;
  });

  // ------------------------------------------------------------------ leg 1
  describe('leg 1 — file viewer read (readChatFile, REMOTE branch)', () => {
    const chat = { host: REMOTE, cwd: '/work/proj' };

    it('PARITY + delegation: the read script is byte-identical on both transports, 10s deadline kept', async () => {
      const captures = await captureBothTransports(
        (deps) => readChatFile(chat, 'src/app.js', deps),
        { stdout: 'file body\n' },
      );
      assertParity(captures, {
        expectedScript: buildReadFileScript('/work/proj', 'src/app.js'),
        timeout: 10000,
      });
    });

    it('the companion result flows through the SAME consumers: content is returned unchanged', async () => {
      const r = await readChatFile(chat, 'src/app.js', {
        execInContext: async () => okResult('hello world\n'),
        run: async () => { throw new Error('no run()'); },
      });
      assert.deepStrictEqual(r, { ok: true, content: 'hello world\n' });
    });

    it("COMPANION-OR-FAIL: a dead channel maps through mapReadScriptError, run() is NEVER consulted", async () => {
      let runCalls = 0;
      const r = await readChatFile(chat, 'src/app.js', {
        execInContext: async () => CHANNEL_DEAD,
        run: async () => { runCalls++; return okResult('should not appear'); },
      });
      assert.strictEqual(runCalls, 0, 'no silent raw-SSH fallback inside the experimental path');
      assert.strictEqual(r.ok, false);
      assert.ok(r.status >= 400, `the failure surfaces through the route's existing error handling: ${JSON.stringify(r)}`);
    });

    it('a LOCAL chat never reaches the companion, even under the flag', async () => {
      let companionCalls = 0;
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-1284-local-'));
      fs.writeFileSync(path.join(cwd, 'a.txt'), 'local body\n');
      const r = await readChatFile({ host: LOCAL, cwd }, 'a.txt', {
        execInContext: async () => { companionCalls++; return okResult(); },
      });
      assert.strictEqual(companionCalls, 0, 'LOCAL reads the filesystem, never the channel');
      assert.deepStrictEqual(r, { ok: true, content: 'local body\n' });
      fs.rmSync(cwd, { recursive: true, force: true });
    });
  });

  // ------------------------------------------------------------------ leg 2
  describe('leg 2 — linkifier existence probe (remoteFileExists)', () => {
    it('PARITY + delegation: the existence script is byte-identical on both transports, 8s deadline kept', async () => {
      const captures = await captureBothTransports(
        (deps) => remoteFileExists(REMOTE, '/work', 'src/app.js', deps),
        { stdout: 'EXISTS\n' },
      );
      assertParity(captures, {
        expectedScript: buildFileExistsScript('/work', 'src/app.js'),
        timeout: 8000,
      });
    });

    it('the EXISTS marker check reads the companion result unchanged (true / false)', async () => {
      const hit = await remoteFileExists(REMOTE, '/work', 'a.js', { execInContext: async () => okResult('EXISTS\n') });
      assert.strictEqual(hit, true);
      const miss = await remoteFileExists(REMOTE, '/work', 'a.js', { execInContext: async () => okResult('') });
      assert.strictEqual(miss, false, 'no marker -> not a file');
    });

    it('COMPANION-OR-FAIL: a dead channel collapses to exists:false, run() is NEVER consulted', async () => {
      let runCalls = 0;
      const r = await remoteFileExists(REMOTE, '/work', 'a.js', {
        execInContext: async () => CHANNEL_DEAD,
        run: async () => { runCalls++; return okResult('EXISTS'); },
      });
      assert.strictEqual(runCalls, 0);
      assert.strictEqual(r, false, 'the linkifier only needs yes/no — a transport failure is not a yes');
    });
  });

  // ------------------------------------------------------------------ leg 3
  describe('leg 3 — session search (remoteSearchClaudeSessions)', () => {
    it('PARITY + delegation: the search script is byte-identical on both transports, 15s deadline kept', async () => {
      const captures = await captureBothTransports(
        (deps) => remoteSearchClaudeSessions(REMOTE, 'needle', deps),
      );
      assertParity(captures, {
        expectedScript: buildSessionSearchScript('needle'),
        timeout: 15000,
      });
    });

    it("the user's query still rides SHELL-QUOTED through the companion (no injection surface)", async () => {
      let sent = null;
      await remoteSearchClaudeSessions(REMOTE, "it's; rm -rf /", {
        execInContext: async (host, script) => { sent = script; return okResult(''); },
      });
      assert.ok(sent.includes(shellQuote("it's; rm -rf /")),
        `the query is shellQuoted in the delivered script: ${sent}`);
    });

    it('COMPANION-OR-FAIL: a dead channel degrades to the empty list, run() is NEVER consulted', async () => {
      let runCalls = 0;
      const rows = await remoteSearchClaudeSessions(REMOTE, 'q', {
        execInContext: async () => CHANNEL_DEAD,
        run: async () => { runCalls++; return okResult(''); },
      });
      assert.strictEqual(runCalls, 0);
      assert.deepStrictEqual(rows, []);
    });
  });

  // ------------------------------------------------------------------ leg 4
  describe('leg 4 — session transcript view (remoteReadSessionTranscript)', () => {
    it('PARITY + delegation: the read script is byte-identical on both transports, 15s deadline kept', async () => {
      const captures = await captureBothTransports(
        (deps) => remoteReadSessionTranscript(REMOTE, 'abc-123', {}, deps),
      );
      assertParity(captures, {
        expectedScript: buildSessionReadScript('abc-123', { before: undefined }),
        timeout: 15000,
      });
    });

    it('the `before` cursor still reaches the script builder through the companion path', async () => {
      let sent = null;
      await remoteReadSessionTranscript(REMOTE, 'abc-123', { before: 4096 }, {
        execInContext: async (host, script) => { sent = script; return okResult(''); },
      });
      assert.strictEqual(sent, buildSessionReadScript('abc-123', { before: 4096 }),
        'the paging cursor is not lost in the routing');
      assert.notStrictEqual(sent, buildSessionReadScript('abc-123', {}),
        'and the paged script genuinely differs from the first-page one');
    });

    it('COMPANION-OR-FAIL: a dead channel surfaces {ok:false} for the route to report unreachable', async () => {
      let runCalls = 0;
      const r = await remoteReadSessionTranscript(REMOTE, 'abc-123', {}, {
        execInContext: async () => CHANNEL_DEAD,
        run: async () => { runCalls++; return okResult(''); },
      });
      assert.strictEqual(runCalls, 0);
      assert.strictEqual(r.ok, false);
      assert.ok(r.stderr.includes('WARDEN_COMPANION_TRANSPORT=0'), 'the error is actionable');
    });
  });

  // ------------------------------------------------------------------ leg 5
  describe('leg 5 — session-browser listing (remoteClaudeSessionsDetail)', () => {
    it('PARITY + delegation: the listing script is byte-identical on both transports, 15s deadline kept', async () => {
      const captures = await captureBothTransports(
        (deps) => remoteClaudeSessionsDetail(REMOTE, 40, deps),
      );
      assertParity(captures, {
        expectedScript: buildRemoteSessionScript(),
        timeout: 15000,
      });
    });

    it('the pre-existing `deps.run` seam still drives the DEFAULT path (flag off) unchanged', async () => {
      process.env.WARDEN_COMPANION_TRANSPORT = '0';
      let seen = null;
      const r = await remoteClaudeSessionsDetail('deadhost', 40, {
        run: async (host, cmd, opts) => {
          seen = { host, cmd, opts };
          return { ok: false, code: 255, stdout: '', stderr: 'ssh: connect to host deadhost port 22: Connection refused' };
        },
      });
      assert.deepStrictEqual(seen, { host: 'deadhost', cmd: buildRemoteSessionScript(), opts: { timeout: 15000 } });
      assert.deepStrictEqual(r, { sessions: [], unreachable: true },
        'isTransportFailure still classifies the default path exactly as before');
    });

    it('COMPANION-OR-FAIL: a dead channel is reported as unreachable, run() is NEVER consulted', async () => {
      let runCalls = 0;
      const r = await remoteClaudeSessionsDetail(REMOTE, 40, {
        execInContext: async () => CHANNEL_DEAD,
        run: async () => { runCalls++; return okResult(''); },
      });
      assert.strictEqual(runCalls, 0);
      assert.strictEqual(r.unreachable, true, 'isTransportFailure reads the companion envelope the same way');
      assert.deepStrictEqual(r.sessions, []);
    });
  });

  // --------------------------------------------------------------- legs 6+7
  describe('legs 6 & 7 — observer transcript tail (readTranscriptPhase)', () => {
    const containerChat = { host: REMOTE, container: 'p-worker' };
    const bareChat = { host: REMOTE };
    const TAIL_OK = '___TAIL\n{"type":"assistant","message":{"stop_reason":"end_turn"}}\n';

    it('leg 7 PARITY + delegation (bare remote tmux): byte-identical script, 10s deadline kept', async () => {
      const captures = await captureBothTransports(
        (deps) => readTranscriptPhase(bareChat, {}, deps),
        { stdout: TAIL_OK },
      );
      assertParity(captures, {
        expectedScript: buildTranscriptTailScript(),
        timeout: 10000,
      });
    });

    // THE leg-6 nuance. The default path delivers `docker exec <c> sh -c
    // <script>` — `sh -c`, not `bash -lc`. Parity comes from riding the FULL
    // pre-assembled string with `container` UNSET; the `container` route would
    // have the host side rebuild it as `docker exec <c> bash -lc <script>`,
    // silently swapping the in-container interpreter.
    it('leg 6 PARITY (container): the FULL `docker exec … sh -c` string rides as the script, container UNSET', async () => {
      const captures = await captureBothTransports(
        (deps) => readTranscriptPhase(containerChat, {}, deps),
        { stdout: TAIL_OK },
      );
      const expected = `docker exec ${shellQuote('p-worker')} sh -c ${shellQuote(buildTranscriptTailScript())}`;
      assertParity(captures, { expectedScript: expected, timeout: 10000 });
      // Spelled out, because this is the assertion the nuance exists for:
      assert.ok(captures.on.script.includes(' sh -c '),
        `the in-container interpreter stays \`sh -c\`: ${captures.on.script}`);
      assert.ok(!captures.on.script.includes('bash -lc'),
        'routing via `container` (which would rebuild it as `bash -lc`) is NOT what happens');
      assert.strictEqual(captures.on.opts.container, '',
        'container is deliberately UNSET so the host side does not re-assemble the docker-exec prefix');
    });

    it('the phase parser reads the companion result unchanged', async () => {
      const phase = await readTranscriptPhase(bareChat, {}, {
        execInContext: async () => okResult(TAIL_OK),
      });
      assert.strictEqual(phase, 'awaiting-input', 'parsePhaseFromTailOutput reads the same {ok, stdout}');
    });

    it('COMPANION-OR-FAIL: a dead channel degrades to null (never fatal), run() is NEVER consulted', async () => {
      let runCalls = 0;
      for (const chat of [bareChat, containerChat]) {
        const phase = await readTranscriptPhase(chat, {}, {
          execInContext: async () => CHANNEL_DEAD,
          run: async () => { runCalls++; return okResult(TAIL_OK); },
        });
        assert.strictEqual(phase, null, 'a transcript read can never break a pane read (WARDEN-89)');
      }
      assert.strictEqual(runCalls, 0, 'no silent raw-SSH fallback');
    });

    it('the `cfg` the observer threads reaches the companion client (bootstrap host config)', async () => {
      let seenCfg = null;
      const cfg = { tmuxSession: 'agent', hosts: ['prod-1'] };
      await readTranscriptPhase(bareChat, cfg, {
        execInContext: async (host, script, opts, c) => { seenCfg = c; return okResult(TAIL_OK); },
      });
      assert.strictEqual(seenCfg, cfg, 'cfg is threaded through, not dropped by the routing');
    });

    it('a LOCAL bare chat never reaches the companion, even under the flag', async () => {
      let companionCalls = 0;
      await readTranscriptPhase({ host: LOCAL }, {}, {
        execInContext: async () => { companionCalls++; return okResult(TAIL_OK); },
      });
      assert.strictEqual(companionCalls, 0, 'the local branch reads the filesystem');
    });
  });

  // ------------------------------------------------------------------ leg 8
  describe('leg 8 — tmux presence preflight (preflightTmux, REMOTE branch)', () => {
    const PROBE = 'command -v tmux >/dev/null 2>&1 && echo OK || echo MISSING';

    it('PARITY + delegation: the probe string is byte-identical on both transports, 8s deadline kept', async () => {
      const captures = await captureBothTransports(
        (deps) => preflightTmux(REMOTE, deps),
        { stdout: 'OK\n' },
      );
      assertParity(captures, { expectedScript: PROBE, timeout: 8000 });
    });

    it('the OK/MISSING verdict is read from the companion result unchanged', async () => {
      const pass = await preflightTmux(REMOTE, { execInContext: async () => okResult('OK\n') });
      assert.strictEqual(pass, null, 'OK -> no error string, the spawn/resume proceeds');
      const fail = await preflightTmux(REMOTE, { execInContext: async () => okResult('MISSING\n') });
      assert.ok(fail && fail.includes('tmux is required'), `MISSING -> the install hint: ${fail}`);
    });

    it('COMPANION-OR-FAIL: a dead channel blocks the spawn with the install hint, run() is NEVER consulted', async () => {
      let runCalls = 0;
      const err = await preflightTmux(REMOTE, {
        execInContext: async () => CHANNEL_DEAD,
        run: async () => { runCalls++; return okResult('OK\n'); },
      });
      assert.strictEqual(runCalls, 0, 'a spawn must not proceed on a raw-SSH fallback we did not take');
      assert.ok(err, 'an empty stdout is not an OK — preflight fails closed');
    });

    it('the LOCAL branch never reaches the companion, even under the flag', async () => {
      let companionCalls = 0;
      await preflightTmux(LOCAL, { execInContext: async () => { companionCalls++; return okResult('OK\n'); } });
      assert.strictEqual(companionCalls, 0, 'local uses runLocalTmux([-V])');
    });
  });

  // ------------------------------------------------------------------ leg 9
  describe('leg 9 — claude-install detection (detectClaude, REMOTE probes)', () => {
    // The three concurrent candidate probes (WARDEN-440), in priority order.
    const CMDS = [
      'zsh -lic "command -v claude" 2>/dev/null',
      'bash -lc "command -v claude" 2>/dev/null',
      'for p in ~/.local/bin/claude /opt/homebrew/bin/claude /usr/local/bin/claude ~/bin/claude ~/n/bin/claude; do [ -x "$p" ] && { echo "$p"; break; }; done',
    ];

    it('PARITY + delegation: all THREE probes ride the guard with their strings and 8s deadline unchanged', async () => {
      const seen = [];
      const hit = await detectClaude(REMOTE, {
        deliverRemoteScript: async (host, script, opts) => {
          seen.push({ host, script, timeout: opts.timeout });
          return okResult(script.startsWith('zsh') ? '/home/u/.local/bin/claude\n' : '');
        },
        runWithPool: async () => { throw new Error('flag ON must not touch runWithPool'); },
      });
      assert.deepStrictEqual(seen.map((s) => s.script), CMDS, 'the three probe strings are unchanged');
      assert.deepStrictEqual([...new Set(seen.map((s) => s.timeout))], [8000], 'each probe keeps its 8s deadline');
      assert.deepStrictEqual([...new Set(seen.map((s) => s.host))], [REMOTE]);
      assert.strictEqual(hit, '/home/u/.local/bin/claude', 'the first `/`-prefixed hit wins, priority order preserved');
    });

    it('FLAG OFF: the probes still go through runWithPool (pooling + retry), with the exact pre-1284 opts', async () => {
      process.env.WARDEN_COMPANION_TRANSPORT = '0';
      const calls = [];
      const hit = await detectClaude(REMOTE, {
        runWithPool: async (host, cmd, opts, cfg) => {
          calls.push({ host, cmd, opts, cfg });
          return okResult(cmd.startsWith('bash') ? '/usr/local/bin/claude\n' : '');
        },
      });
      assert.deepStrictEqual(calls.map((c) => c.cmd), CMDS);
      assert.deepStrictEqual(calls.map((c) => c.opts), [{ timeout: 8000 }, { timeout: 8000 }, { timeout: 8000 }]);
      assert.deepStrictEqual(calls.map((c) => c.cfg), [{}, {}, {}], 'the empty cfg the pre-1284 call passed');
      assert.strictEqual(hit, '/usr/local/bin/claude');
    });

    // The default path here is runWithPool, NOT run() — the routing guard takes
    // it as `opts.run` so it cannot leak into `deps`, which the guard forwards
    // to the companion client where `deps.run` is the BOOTSTRAP transport.
    // Pinned in BOTH directions because getting it backwards is silently green
    // everywhere else while routing the binary upload through the pool.
    it('FLAG OFF: a `deps.run` (bootstrap) seam does NOT hijack this leg`s default transport', async () => {
      process.env.WARDEN_COMPANION_TRANSPORT = '0';
      let poolCalls = 0;
      let bootstrapRunCalls = 0;
      await detectClaude(REMOTE, {
        runWithPool: async () => { poolCalls++; return okResult(''); },
        run: async () => { bootstrapRunCalls++; return okResult(''); },
      });
      assert.strictEqual(poolCalls, 3, 'the pooled transport still serves all three probes');
      assert.strictEqual(bootstrapRunCalls, 0, 'deps.run is the bootstrap transport, not this leg`s default');
    });

    it('FLAG ON: the pooled transport is NOT forwarded to the companion as `deps.run` (the bootstrap seam)', async () => {
      // The guard forwards `deps` verbatim to execInContext, where `deps.run` is
      // the transport that PROBES AND UPLOADS THE BINARY. Passing this leg's
      // pooled default in that slot would silently re-route the bootstrap
      // through the connection pool — a change nothing else here would catch,
      // since the probe results would look identical.
      let seenDeps = null;
      let poolCalls = 0;
      const pooled = async () => { poolCalls++; return okResult(''); };
      await detectClaude(REMOTE, {
        runWithPool: pooled,
        deliverRemoteScript: async (host, script, opts, cfg, deps) => {
          seenDeps = deps;
          assert.strictEqual(opts.run, pooled, 'the leg declares its default transport as an OPTION');
          return okResult('');
        },
      });
      assert.strictEqual(poolCalls, 0, 'under the flag the pool is not used at all');
      assert.notStrictEqual(seenDeps.run, pooled,
        'the pooled transport must NOT ride in deps.run — that slot is the companion bootstrap`s');
    });

    it('COMPANION-OR-FAIL: a dead channel yields no detection, runWithPool is NEVER consulted', async () => {      let poolCalls = 0;
      const hit = await detectClaude(REMOTE, {
        deliverRemoteScript: async () => CHANNEL_DEAD,
        runWithPool: async () => { poolCalls++; return okResult('/usr/local/bin/claude\n'); },
      });
      assert.strictEqual(poolCalls, 0, 'no silent raw-SSH fallback inside the experimental path');
      assert.strictEqual(hit, null, 'a failed probe reports "not found", it does not fabricate a path');
    });

    it('the per-probe .catch() belt still holds: a THROWING probe cannot reject the whole fan', async () => {
      const hit = await detectClaude(REMOTE, {
        deliverRemoteScript: async (host, script) => {
          if (script.startsWith('zsh')) throw new Error('transport exploded');
          return okResult(script.startsWith('bash') ? '/opt/homebrew/bin/claude\n' : '');
        },
      });
      assert.strictEqual(hit, '/opt/homebrew/bin/claude', 'the surviving probes still answer');
    });

    it('the LOCAL branch never reaches the guard, even under the flag', async () => {
      let deliverCalls = 0;
      await detectClaude(LOCAL, {
        deliverRemoteScript: async () => { deliverCalls++; return okResult(''); },
      }).catch(() => {});
      assert.strictEqual(deliverCalls, 0, 'local resolves through the filesystem/PATH, never the channel');
    });
  });

  // ------------------------------------------------------- the shared guard
  // deliverRemoteScript itself was lifted out of gitRoutes.js so all ten legs
  // (the git domain + these nine) share ONE companion-or-fail discipline. Its
  // own contract is pinned here rather than inside any one leg.
  describe('the shared routing guard (deliverRemoteScript)', () => {
    it('flag ON -> execInContext with the script verbatim; flag OFF -> run() with the same string', async () => {
      let companionScript = null;
      let runCmd = null;
      const script = "cd '/w' && cat 'a b.txt'";
      await deliverRemoteScript(REMOTE, script, { timeout: 1234 }, {}, {
        execInContext: async (h, s) => { companionScript = s; return okResult(); },
        run: async () => { throw new Error('flag ON must not touch run()'); },
      });
      process.env.WARDEN_COMPANION_TRANSPORT = '0';
      await deliverRemoteScript(REMOTE, script, { timeout: 1234 }, {}, {
        execInContext: async () => { throw new Error('flag OFF must not touch the companion'); },
        run: async (h, cmd) => { runCmd = cmd; return okResult(); },
      });
      assert.strictEqual(companionScript, script, 'the script rides verbatim — never rebuilt JS-side');
      assert.strictEqual(companionScript, runCmd);
    });

    it('`opts.run` (a caller`s own default transport) takes precedence over `deps.run` (the bootstrap seam)', async () => {
      process.env.WARDEN_COMPANION_TRANSPORT = '0';
      let ownCalls = 0;
      let bootstrapCalls = 0;
      await deliverRemoteScript(REMOTE, 'true', { run: async () => { ownCalls++; return okResult(); } }, {}, {
        run: async () => { bootstrapCalls++; return okResult(); },
      });
      assert.strictEqual(ownCalls, 1);
      assert.strictEqual(bootstrapCalls, 0);
    });

    it('the innerScript+container shape (the git container branch) still reaches the companion intact', async () => {
      let payload = null;
      await deliverRemoteScript(REMOTE, 'docker exec c bash -lc inner', { innerScript: 'inner', container: 'c', timeout: 6000 }, {}, {
        execInContext: async (h, s, opts) => { payload = { s, opts }; return okResult(); },
      });
      assert.strictEqual(payload.s, 'inner', 'the INNER script rides when a container is named');
      assert.strictEqual(payload.opts.container, 'c');
      assert.strictEqual(payload.opts.timeout, 6000);
    });

    it('the default timeout is 8000ms on both paths (the pre-1284 run() default these legs passed)', async () => {
      let onTimeout = null;
      let offOpts = null;
      await deliverRemoteScript(REMOTE, 'true', {}, {}, {
        execInContext: async (h, s, opts) => { onTimeout = opts.timeout; return okResult(); },
      });
      process.env.WARDEN_COMPANION_TRANSPORT = '0';
      await deliverRemoteScript(REMOTE, 'true', {}, {}, {
        run: async (h, c, opts) => { offOpts = opts; return okResult(); },
      });
      assert.strictEqual(onTimeout, 8000);
      assert.deepStrictEqual(offOpts, { timeout: 8000 });
    });
  });
});
