// WARDEN-1329 — routing tmux.js `read()` (the depth-parameterized single-pane
// capture) onto the companion `exec` RPC, the last un-gated runtime op in
// tmux.js and the one slice of roadmap WARDEN-270 that fell between every
// prior category (it is neither a poll nor a stream, and it cannot ride the
// batched capturePanes RPC, which hardcodes `-S -60` while read()'s callers
// pass up to 5000 lines — /api/pane-export, the transcript the user downloads).
//
// This suite drives the REAL exported `read()` through the same deps seam its
// eight siblings use (no real ssh) and pins the ticket's contracts:
//
//   PARITY        the command delivered under the flag is BYTE-IDENTICAL to
//                 what runTmux delivers with the flag off, for BOTH container
//                 shapes — asserted by driving the same call twice and
//                 comparing the two captured strings, then pinning the
//                 expected literal (the companion-exec-legs.test.js shape).
//                 The container shape carries the slice's one delivery trap:
//                 runTmux prefixes BARE `docker exec <c>` (no -it, NO
//                 in-container shell), so the full pre-assembled command must
//                 ride as the script with `container` UNSET — routing it
//                 through `container` would have the host rebuild
//                 `docker exec <c> bash -lc <script>`, inserting a login shell
//                 today's path does not have (the WARDEN-1284 leg-6 nuance).
//   DELEGATION    under the flag a REMOTE read issues ZERO per-op ssh spawns
//                 (deps.runTmux is never consulted).
//   TIMEOUT       the companion path passes an EXPLICIT 30000 deadline — the
//                 default path inherits run()'s 30000, and execInContext's own
//                 default is 8000, a silent 30s→8s downgrade that would turn a
//                 slow 5000-line export into a timeout.
//   COMPANION-OR-FAIL  a dead channel and a stale binary predating `exec` both
//                 arrive as {ok:false} and propagate through read()'s existing
//                 `if (!r.ok) throw` — never a silent runTmux fallback.
//   UTF-8 (load-bearing)  a >64KB genuinely-multibyte pane round-trips
//                 byte-identically over the companion decode path (Go
//                 bytes.Buffer → JSON response line → readline → JSON.parse →
//                 envelope). sshEncoding.test.js exists because the OLD path
//                 corrupted exactly this payload (WARDEN-1042/1045); this
//                 migration moves it onto a completely different decode path,
//                 so byte-identity is re-proven here with the same paneLike()
//                 generator and the same full-string assertion. The newline-
//                 dense payload must also survive the newline-delimited JSON
//                 framing + readline reassembly when the response line arrives
//                 in several pipe chunks — the property whose failure would be
//                 silent (U+FFFD is valid JSON all the way to the user).
//
// LOCAL chats and the toggle-off default are byte-for-byte unchanged, and no
// file under companion/ is touched by this slice. Run: node --test src.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { read } from './tmux.js';
import { runTmux, buildRunCommand } from './ssh.js';
import { execInContext, spawnPersistentChannel, _resetChannelCacheForTests } from './companion.js';

const ORIG_ENV = process.env.WARDEN_COMPANION_TRANSPORT;
const REMOTE = 'prod-1';
const LOCAL = '(local)';

const okResult = (stdout = '') => ({ host: REMOTE, ok: true, code: 0, stdout, stderr: '' });

// The companion-or-fail envelope execInContext produces on a dead channel: the
// message rides stderr (the raw run() shape), never an `error` field.
const CHANNEL_DEAD = {
  host: REMOTE, ok: false, code: -1, stdout: '',
  stderr: `companion transport error for ${REMOTE}: channel died. Set WARDEN_COMPANION_TRANSPORT=0 to use the default SSH path.`,
};

// The capture argv read() builds (mirrors the exported function; suite A pins
// the assembled command literal so a drift in EITHER transport fails loudly).
const captureArgv = (session, lines) => ['capture-pane', '-t', session, '-p', '-e', '-S', `-${lines}`, '-E', '-'];

// Drive ONE read() call twice — flag ON (capturing what reaches the companion)
// and flag OFF (capturing, through the REAL runTmux with injected pool seams,
// what runWithPool delivers) — and return both captures plus the pane each
// transport returned.
async function captureBothTransports(chat, cfg, lines, { stdout = 'PANE\n' } = {}) {
  const on = { host: null, script: null, opts: null, cfg: null, runTmuxCalls: 0 };
  process.env.WARDEN_COMPANION_TRANSPORT = '1';
  const paneOn = await read(chat, cfg, lines, {
    companionExec: async (host, script, opts, c) => {
      on.host = host; on.script = script; on.opts = opts; on.cfg = c;
      return okResult(stdout);
    },
    runTmux: async () => { on.runTmuxCalls++; throw new Error('flag ON must not touch runTmux'); },
  });

  const off = { host: null, cmd: null, opts: null, execCalls: 0, argv: null };
  process.env.WARDEN_COMPANION_TRANSPORT = '0';
  const paneOff = await read(chat, cfg, lines, {
    companionExec: async () => { off.execCalls++; throw new Error('flag OFF must not touch the companion'); },
    runTmux: (c, args) => {
      off.argv = args;
      // The REAL runTmux, pool seams injected (the runWithPool deps param) so
      // the test captures the exact command the default path delivers.
      return runTmux(c, args, {}, {
        run: async (host, cmd, opts) => { off.host = host; off.cmd = cmd; off.opts = opts; return okResult(stdout); },
        getConnection: async () => ({ socketPath: '/tmp/warden-companion-read-test.sock' }),
        markUnhealthy: async () => {},
      });
    },
  });
  process.env.WARDEN_COMPANION_TRANSPORT = '1';
  return { on, off, paneOn, paneOff };
}

// The three claims every parity capture shares, asserted from one pair.
function assertParity({ on, off, paneOn, paneOff }, { expectedScript, lines }) {
  assert.strictEqual(on.script, off.cmd,
    `the delivered command must be byte-identical on both paths:\ncompanion: ${on.script}\nrunTmux:   ${off.cmd}`);
  assert.strictEqual(off.cmd, expectedScript, 'the delivered command is the pre-WARDEN-1329 one');
  assert.strictEqual(on.host, REMOTE, 'the companion is asked for the same host');
  assert.strictEqual(off.host, REMOTE);
  assert.deepStrictEqual(on.opts, { timeout: 30000 },
    'the companion path passes the EXPLICIT 30s deadline (run() parity, not execInContext\'s 8s default)');
  assert.strictEqual(on.opts.container, undefined,
    '`container` must be UNSET: the docker-exec prefix already rides inside the script (bare `docker exec <c> tmux`, no in-container shell)');
  assert.deepStrictEqual(off.argv, captureArgv('agent', lines), 'the default path builds the unchanged capture argv');
  assert.strictEqual(on.runTmuxCalls, 0, 'the companion path issues ZERO per-op ssh spawns');
  assert.strictEqual(off.execCalls, 0, 'flag OFF -> the companion is never consulted');
  assert.strictEqual(paneOn, paneOff, 'both transports deliver the same pane text');
}

// --------------------------- bootstrap harness -------------------------------
// Minimal fake-bootstrap deps (the fakeDeps shape companion.test.js uses) so the
// REAL execInContext can be driven end-to-end — through read() — without ssh.
const TEST_VER = 'abc123def456';
const TEST_MANIFEST = {
  version: TEST_VER,
  binaries: { 'linux/amd64': 'warden-companion-linux-amd64' },
};
function fakeBootstrapDeps(spawnChannel) {
  return {
    manifest: TEST_MANIFEST,
    run: async () => ({ ok: true, stdout: 'OS=Linux\nARCH=x86_64\nHAVE=0\n' }),
    upload: async () => ({ ok: true }),
    spawnChannel,
  };
}

// A `capture-pane -e`-like payload: box-drawing borders (3-byte), a 4-byte
// emoji, accented Latin (2-byte), interleaved with ASCII and SGR escapes — the
// SAME generator sshEncoding.test.js pins the raw-SSH path with (WARDEN-1045),
// where >50% of a realistic pane's bytes are multibyte continuation bytes.
function paneLike(lines) {
  let s = '';
  for (let i = 0; i < lines; i++) {
    s += `\x1b[36m╭${'─'.repeat(60)}╮\x1b[0m ⎿ ✓ 🚀 │ café — line ${i}\n`;
  }
  return s;
}

const countFFFD = (s) => (s.match(/\uFFFD/g) || []).length;
const PIPE_BUFFER = 65536;
const tick = () => new Promise((r) => setImmediate(r));

// A fake companion ssh child speaking the stdio RPC over REAL pipes: requests
// arrive on child.stdin (parsed line-by-line), responses go to child.stdout.
// The exec response is NOT written by the factory — the test holds the request
// and writes the (huge, chunked) response line itself, so the delivery shape
// under test (one giant JSON line arriving in several pipe reads) is explicit.
function fakeCompanionChild() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const child = Object.assign(new EventEmitter(), { stdin, stdout, kill: () => {} });
  let buf = '';
  let execReq = null;
  stdin.on('data', (d) => {
    buf += d.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let req;
      try { req = JSON.parse(line); } catch { continue; }
      if (req.method === 'ping') {
        stdout.write(JSON.stringify({ id: req.id, ok: true, result: { version: TEST_VER, methods: ['ping', 'exec'] } }) + '\n');
      } else if (req.method === 'exec') {
        execReq = req;
      }
    }
  });
  return { child, getExecReq: () => execReq };
}

describe('WARDEN-1329 — tmux.js read() routes onto the companion `exec` RPC', () => {
  beforeEach(() => { process.env.WARDEN_COMPANION_TRANSPORT = '1'; });
  afterEach(() => {
    if (ORIG_ENV === undefined) delete process.env.WARDEN_COMPANION_TRANSPORT;
    else process.env.WARDEN_COMPANION_TRANSPORT = ORIG_ENV;
  });

  describe('PARITY — the delivered command is byte-identical on both transports', () => {
    it('bare remote (no container): `tmux <quoted argv>`', async () => {
      const chat = { host: REMOTE, session: 'agent' };
      const captures = await captureBothTransports(chat, {}, 5000);
      assertParity(captures, {
        expectedScript: `tmux 'capture-pane' '-t' 'agent' '-p' '-e' '-S' '-5000' '-E' '-'`,
        lines: 5000,
      });
      // Pin the builder identity explicitly: the companion script is exactly
      // what ONE builder produces — the same builder runTmux itself now uses,
      // so both transports cannot drift (the WARDEN-1295 construction).
      assert.strictEqual(captures.on.script, buildRunCommand(chat, captureArgv('agent', 5000)));
    });

    it('yatfa chat (container): bare `docker exec <c> tmux …` — no -it, NO bash -lc inside the container', async () => {
      const chat = { host: REMOTE, container: 'p-worker', session: 'agent' };
      const captures = await captureBothTransports(chat, {}, 200);
      assertParity(captures, {
        expectedScript: `docker exec 'p-worker' tmux 'capture-pane' '-t' 'agent' '-p' '-e' '-S' '-200' '-E' '-'`,
        lines: 200,
      });
      assert.ok(!captures.on.script.includes('-it'), 'capture is non-tty: no -it (that is the attach shape)');
      assert.ok(!captures.on.script.includes('bash -lc'),
        'no in-container login shell: passing `container` would have the host rebuild `docker exec <c> bash -lc <script>` and change the delivery shape');
      // A container name containing a quote survives the same on both paths.
      const nasty = { host: REMOTE, container: "c'x", session: 'agent' };
      const q = await captureBothTransports(nasty, {}, 200);
      assert.strictEqual(q.on.script, q.off.cmd);
      assert.ok(q.on.script.includes(`docker exec 'c'\\''x' tmux`), `shellQuote applied to the container: ${q.on.script}`);
    });

    it('cfg is threaded to the companion client (bootstrap reads host config from it)', async () => {
      const chat = { host: REMOTE, session: 'agent' };
      const cfg = { companionTimeoutMs: 12345 };
      const captures = await captureBothTransports(chat, cfg, 200);
      assert.strictEqual(captures.on.cfg, cfg, 'the same cfg object reaches the companion client');
    });
  });

  describe('COMPANION-OR-FAIL — a failing channel throws, never a silent runTmux fallback', () => {
    const chat = { host: REMOTE, container: 'p-worker', session: 'agent' };

    it('a dead channel propagates through read()\'s existing `if (!r.ok) throw`', async () => {
      let runTmuxCalls = 0;
      await assert.rejects(
        () => read(chat, {}, 200, {
          companionExec: async () => CHANNEL_DEAD,
          runTmux: async () => { runTmuxCalls++; return okResult('should not be reached'); },
        }),
        /channel died/,
      );
      assert.strictEqual(runTmuxCalls, 0, 'a dead channel does NOT fall back to runTmux');
    });

    it('a stale binary predating `exec` surfaces the actionable too-old error (no {unsupported} degradation)', async () => {
      let runTmuxCalls = 0;
      const TOO_OLD = {
        host: REMOTE, ok: false, code: -1, stdout: '',
        stderr: `companion binary on ${REMOTE} is too old: it does not advertise the 'exec' RPC (ping methods: ping, discover). Remove ~/.warden/companion-abc123 on the host and retry so the bootstrap re-uploads the current binary, or set WARDEN_COMPANION_TRANSPORT=0 to use the default SSH path.`,
      };
      await assert.rejects(
        () => read(chat, {}, 200, {
          companionExec: async () => TOO_OLD,
          runTmux: async () => { runTmuxCalls++; return okResult('fallback'); },
        }),
        /too old/,
      );
      assert.strictEqual(runTmuxCalls, 0, 'the too-old error is companion-or-fail: no raw-SSH retry');
    });
  });

  describe('LOCAL + toggle-off — byte-for-byte unchanged', () => {
    it('a LOCAL chat never routes through the companion, even under the flag', async () => {
      let companionCalls = 0;
      const pane = await read({ host: LOCAL, session: 'agent' }, {}, 200, {
        companionExec: async () => { companionCalls++; return okResult('companion'); },
        runTmux: async () => okResult('local'),
        isCompanionTransportEnabled: () => true,
      });
      assert.strictEqual(companionCalls, 0, 'LOCAL is refused before the toggle is even consulted');
      assert.strictEqual(pane, 'local');
    });

    it('flag OFF: the companion is never consulted and the default runTmux path serves the read', async () => {
      process.env.WARDEN_COMPANION_TRANSPORT = '0';
      let companionCalls = 0;
      let seenArgs = null;
      const pane = await read({ host: REMOTE, session: 'agent' }, {}, 200, {
        companionExec: async () => { companionCalls++; return okResult('companion'); },
        runTmux: async (c, args) => { seenArgs = args; return okResult('default'); },
      });
      assert.strictEqual(companionCalls, 0);
      assert.strictEqual(pane, 'default');
      assert.deepStrictEqual(seenArgs, captureArgv('agent', 200), 'the default argv is unchanged');
    });
  });

  describe('UTF-8 INTEGRITY (load-bearing) — the >64KB multibyte pane round-trips byte-identically', () => {
    beforeEach(() => _resetChannelCacheForTests());

    it('gate 1: a 5000-line pane (~700KB, >50% multibyte) survives the real client end-to-end, read() → execInContext → envelope', async () => {
      const expected = paneLike(5000);
      const buf = Buffer.from(expected, 'utf8');
      assert.ok(buf.length > PIPE_BUFFER, 'payload must exceed the 64KB pipe buffer the old path corrupted at');

      // A fake transport whose exec handler returns the giant payload — the
      // same JSON-encoded response line shape the Go host emits (newlines
      // escaped INSIDE the JSON string, one line per response).
      const t = {
        write(line) {
          const req = JSON.parse(line);
          if (req.method === 'ping') {
            setImmediate(() => this._onLine(JSON.stringify({ id: req.id, ok: true, result: { version: TEST_VER, methods: ['ping', 'exec'] } })));
          } else if (req.method === 'exec') {
            setImmediate(() => this._onLine(JSON.stringify({ id: req.id, ok: true, result: { ok: true, code: 0, stdout: expected, stderr: '' } })));
          }
        },
        onLine(cb) { this._onLine = cb; },
        onExit() {},
        kill() {},
        _onLine: null,
      };

      // Drive the REAL read() → REAL execInContext with only the bootstrap
      // faked — the full JS decode path under test is production code.
      const pane = await read({ host: REMOTE, session: 'agent' }, {}, 5000, {
        companionExec: (h, s, o, c) => execInContext(h, s, o, c, fakeBootstrapDeps(() => t)),
      });

      // The load-bearing assertion: byte-identity on the FULL string. U+FFFD
      // counts are diagnostics only (sshEncoding.test.js discipline) — the
      // safe and dangerous inputs differ ONLY BY SIZE, so a small fixture
      // would pass against defective code by construction.
      assert.equal(pane, expected);
      assert.strictEqual(countFFFD(pane), 0, 'no replacement characters anywhere in the payload');
      assert.ok(pane.includes('\n'), 'the payload is newline-dense: framing must have escaped them inside the JSON string');
    });

    it('gate 2: the newline-dense response line survives newline-delimited framing + readline reassembly across pipe chunks', async () => {
      const expected = paneLike(5000);
      const { child, getExecReq } = fakeCompanionChild();

      const deps = fakeBootstrapDeps(
        (h, rp, c) => spawnPersistentChannel(h, rp, c, () => child),
      );

      const pending = read({ host: REMOTE, session: 'agent' }, {}, 5000, {
        companionExec: (h, s, o, c) => execInContext(h, s, o, c, deps),
      });

      // Wait for the bootstrap (probe/upload/ping) to finish and the exec
      // request to arrive on the fake child's stdin.
      for (let i = 0; i < 100 && !getExecReq(); i++) await tick();
      const req = getExecReq();
      assert.ok(req, 'the exec RPC reached the fake companion');
      // Pin the request the channel carries: the full pre-assembled capture
      // command, container UNSET (null on the wire), the explicit 30s deadline.
      assert.deepStrictEqual(req.params, {
        script: `tmux 'capture-pane' '-t' 'agent' '-p' '-e' '-S' '-5000' '-E' '-'`,
        container: null,
        timeoutMs: 30000,
      });

      // Deliver the response line in THREE chunks — the first cut INSIDE a
      // multibyte sequence at/after the 64KB pipe boundary (what a real pipe
      // read does when the boundary lands mid-character). readline's internal
      // StringDecoder must hold the partial sequence back and reassemble; the
      // JSON string's embedded newlines must NOT split the frame.
      const line = Buffer.from(JSON.stringify({ id: req.id, ok: true, result: { ok: true, code: 0, stdout: expected, stderr: '' } }) + '\n', 'utf8');
      assert.ok(line.length > 2 * PIPE_BUFFER, 'the response line genuinely spans multiple pipe reads');
      let cut = PIPE_BUFFER;
      while (cut < line.length && (line[cut] & 0xc0) !== 0x80) cut++;
      assert.ok(cut < line.length && (line[cut] & 0xc0) === 0x80, 'the first cut lands inside a multibyte sequence');
      const cut2 = Math.floor((cut + line.length) / 2);
      child.stdout.write(line.subarray(0, cut));
      await tick();
      child.stdout.write(line.subarray(cut, cut2));
      await tick();
      child.stdout.write(line.subarray(cut2));

      const pane = await pending;
      assert.equal(pane, expected, 'the 700KB multibyte, newline-dense pane is byte-identical after reassembly');
      assert.strictEqual(countFFFD(pane), 0);
    });
  });
});
