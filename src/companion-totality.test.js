// WARDEN-1412 — the companion-transport TOTALITY SWEEP: one whole-surface test
// that drives EVERY remote-op surface over a seeded live channel and fails the
// moment any of them reaches outside it.
//
// WHY THIS FILE EXISTS. The companion-transport migration has converged: every
// remote-op domain is gated (the gate census on origin/main @ 06ed08f is 36
// sites across 8 files — asserted live below, never trusted from a stored
// number). The roadmap bar (WARDEN-270, outcome #1 — totality) is that with the
// companion installed, a working session opens ZERO connections outside its
// channel. Each delivered slice pins ITS op (companion-exec-legs.test.js,
// companion-attach.test.js, companion-read.test.js,
// server-companion-probe.test.js, …), but nothing failed when a NEW remote op
// landed without its companion branch — and one did: src/pasteImage.js was
// created on the raw-ssh pattern five days AFTER the cutover (WARDEN-1348) and
// shipped traffic outside the channel, caught only by a manual re-sweep. This
// file is the standing guard for that regression class.
//
// THE DETECTOR. Test files are self-contained and node --test runs each in its
// own process, but the test process and an imported server.js SHARE the
// companion.js module registry — so seeding ONE live fake channel via
// getChannel(host, {}, deps) (the server-companion-probe.test.js pattern)
// makes every routed surface in the same process ride it. The fake transport
// answers EVERY method of the closed channel vocabulary (re-enumerated live in
// the census test below) and records each request on the wire. Per surface:
//   toggle ON  → the op either SUCCEEDS over the channel (the method appears on
//                the wire) or fails with a companion-contract error — never a
//                raw-ssh transport failure.
//   toggle OFF → the same drive produces the RAW failure signature (detector
//                control: proves the sweep can actually SEE a fallback, so a
//                broken detector cannot read as a green sweep).
// The discriminating fact this file is built on (server-companion-probe.test.js):
// this sandbox has NO ssh binary, so every raw-ssh spawn fails fast (spawn
// ENOENT). CI (ubuntu-latest) DOES ship an ssh client, so the same raw drive
// fails there with ssh's own connect/DNS error against an unresolvable host.
// Both are raw transport failures — every raw-class assertion in this file is
// written as "failure text matches a raw transport signature and carries no
// companion-contract wording", never as the literal ENOENT string.
// (node:test's mock.module is unavailable on this repo's Node 20 runtime; no
// module boundary is mocked anywhere here.)
//
// THE ALLOW-LIST IS ASSERTED, NOT SILENT (the ticket's §e): the deliberate
// raw-ssh exceptions are encoded as their own tests with citations, so an
// INCOMPLETE sweep is distinguishable from a PASSING one:
//   • bootstrap  — getChannel's probe/upload/channel legs ARE the raw-ssh path
//     by design: a channel cannot install itself (asserted below: a fresh host
//     bootstraps over raw ssh and fails with the raw signature inside a
//     CompanionTransportError envelope — never on the wire).
//   • uninstall  — POST /api/companion/uninstall keeps the raw validateHost
//     precheck (companion-routed, it could bootstrap the very binary the
//     operator asked to remove); pinned by server-companion-probe.test.js
//     TRAP 1, re-asserted here against the sweep's own seeded channel.
//   • CLI LOCAL  — attachInteractiveTmux serves host '(local)' only since
//     WARDEN-1364 (companion-cli-attach.test.js pins "attachInteractiveTmux …
//     was never touched" for REMOTE and "LOCAL is served by
//     attachInteractiveTmux, never the companion"); LOCAL is out of the
//     companion's scope by construction, so no sweep leg drives it.
//
// SIBLING COVERAGE (not re-pinned here): per-op parity/delegation/companion-or-
// fail contracts live in their slices' own files. The sweep drives ROUTING —
// which transport each surface reaches under each toggle state — and the gate
// census that ties the driven set to every gate site in the tree.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOST = 'totality-host';          // gets the live channel seeded
const BOOTSTRAP_HOST = 'totality-bootstrap-host'; // allow-list leg only
// (Deliberately no 'companion' substring in the host names: the sweep's
// failure-class classifier greps for companion-contract wording, and the
// shipped failure envelopes quote the host verbatim.)
const TEST_VER = 'a0b1c2d3e4f5';

// server.js reads config/catalog and rotates activity logs at module load, and
// it APPLIES the persisted toggle at import — so redirect HOME and set the
// env-var gate BEFORE the single import. With the env var already set, the
// import's applyCompanionToggle runs in operator-override mode and can never
// clobber the test's flips (the same discipline server-companion-probe.test.js
// uses, plus the env-first ordering its `before` does at runtime).
const TEMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-1412-home-'));
process.env.HOME = TEMP_HOME;
const wardenDir = path.join(TEMP_HOME, '.yatfa-warden');
fs.mkdirSync(wardenDir, { recursive: true });
// issueLinksEnabled: the /api/pane-project leg's first gate (the route answers
// {state:'disabled'} without it). hosts: the probe leg's default host list.
fs.writeFileSync(path.join(wardenDir, 'config.json'), JSON.stringify({
  hosts: [HOST],
  issueLinksEnabled: true,
  companionTransportEnabled: true,
}) + '\n');
// A catalog chat for the /api/pane-project HTTP leg: a MANUAL remote chat
// (container hydrates null from the disk catalog) whose project fallback walk
// must ride the channel.
fs.writeFileSync(path.join(wardenDir, 'chats.json'), JSON.stringify([
  { kind: 'tmux', host: HOST, session: 'sweepproj', name: 'sweepproj' },
]) + '\n');
process.env.WARDEN_COMPANION_TRANSPORT = '1';

// The project modules are imported DYNAMICALLY, after the env redirect below —
// static imports would hoist and evaluate the whole dependency tree (config.js
// reads HOME at import) before the temp HOME exists (the
// companion-exec-legs.test.js / companion-cli-attach.test.js discipline).
const {
  applyCompanionToggle, getChannel, getCompanionStatus,
  subscribePanes, unsubscribePanes, reconcilePaneSubscriptions,
  CompanionAttachSession,
  _resetChannelCacheForTests, _channelCacheHasForTests,
  _resetPaneDeltaStateForTests,
} = await import('./companion.js');
const { discover: chatsDiscover, discoverManual, capturePanes: chatsCapturePanes } = await import('./chats.js');
const {
  read: tmuxRead, send: tmuxSend, sendKey: tmuxSendKey, hasSession: tmuxHasSession,
  probeSession: tmuxProbeSession, resize: tmuxResize, spawn: tmuxSpawn, kill: tmuxKill,
  attachStream, attachInteractive,
} = await import('./tmux.js');
const { detectClaude } = await import('./ssh.js');
const { runGit, runInContext } = await import('./gitRoutes.js');
const { readTranscriptPhase } = await import('./observer.js');
const { remoteClaudeSessionsDetail } = await import('./claudeSessions.js');
const { deliverPastedImage } = await import('./pasteImage.js');
const { resolvePaneContainer, clearPaneContainerCache } = await import('./paneContainer.js');
const { cmdDash } = await import('./cli.js');

const {
  readChatFile, remoteFileExists, remoteSearchClaudeSessions,
  remoteReadSessionTranscript, preflightTmux, app,
} = await import('./server.js');

// The closed channel vocabulary — companion/main.go's dispatch `case` names.
// The census test below re-enumerates this list against the Go source live; the
// fake channel answers every one of them, so a FUTURE op whose surface this
// sweep has not been taught about fails its leg with 'unknown method' instead
// of silently passing.
const CHANNEL_METHODS = [
  'ping', 'discover', 'capturePanes', 'hasSession', 'spawnSession', 'killSession',
  'resize', 'send', 'sendKeys', 'exec', 'writeFile',
  'subscribePanes', 'unsubscribePanes',
  'attachStart', 'attachInput', 'attachResize', 'attachKill',
];

// The exec legs' shared stdout — one bland payload every script leg's parser
// tolerates: the linkifier sees EXISTS, the tmux preflight sees OK, the
// alive-check matches `1 <session>`, and the strict window_activity parser
// (whole-payload digits only) correctly refuses it and stamps nothing.
const GENERIC_EXEC_STDOUT = 'OK\nEXISTS\n1 totalitysess\n';

// Every RPC that crossed the seeded channel, in order. This is the sweep's
// routing evidence: a surface's leg asserts the DELTA of its methods. A raw-ssh
// fallback cannot write here — the raw path spawns a real ssh child, never a
// channel RPC.
const WIRE = [];
const wireCount = (method) => WIRE.filter((w) => w.method === method).length;

function fakeTransport(handler) {
  let lineCB = null;
  return {
    write(line) {
      let resp = null;
      try { resp = handler(JSON.parse(line)); } catch { /* swallow */ }
      if (resp) setImmediate(() => { if (lineCB) lineCB(JSON.stringify(resp)); });
    },
    onLine(cb) { lineCB = cb; },
    onExit() {},
    kill() {},
  };
}

// The seeded companion answers EVERY vocabulary method with a success-shaped
// payload, and records the request. An unknown method → ok:false — which turns
// into a companion-contract failure on the driving leg, i.e. the sweep goes red
// naming the surface, exactly the sensitivity the ticket requires for ops this
// file has not been taught.
function companionHandler(req) {
  WIRE.push({ method: req.method, params: req.params || {} });
  switch (req.method) {
    case 'ping': return { id: req.id, ok: true, result: { version: TEST_VER, methods: CHANNEL_METHODS } };
    case 'discover': return {
      id: req.id, ok: true,
      result: { containers: [{ name: 'tot-agent', status: 'running', cwd: '/work/tot', active: true, pane: 'working' }] },
    };
    case 'capturePanes': return { id: req.id, ok: true, result: { panes: { totkey: 'captured pane body' } } };
    case 'hasSession': return { id: req.id, ok: true, result: { exists: true } };
    case 'exec': return { id: req.id, ok: true, result: { ok: true, code: 0, stdout: GENERIC_EXEC_STDOUT, stderr: '' } };
    case 'attachStart': return { id: req.id, ok: true, result: { sid: 'totsid' } };
    case 'resize': case 'send': case 'sendKeys': case 'writeFile':
      return { id: req.id, ok: true, result: { ok: true, code: 0, stdout: '', stderr: '' } };
    case 'spawnSession': case 'killSession': case 'subscribePanes':
    case 'unsubscribePanes': case 'attachInput': case 'attachResize': case 'attachKill':
      return { id: req.id, ok: true, result: {} };
    default:
      return { id: req.id, ok: false, error: `unknown method '${req.method}' (companion-totality sweep was not taught this op)` };
  }
}

function seedingDeps() {
  return {
    manifest: { version: TEST_VER, binaries: { 'linux/amd64': 'warden-companion-linux-amd64' } },
    run: async () => ({ ok: true, stdout: 'OS=Linux\nARCH=x86_64\nHAVE=0\n' }),
    upload: async () => ({ ok: true }),
    spawnChannel: () => fakeTransport(companionHandler),
  };
}

// ----------------------------- failure classifiers -----------------------------
// A raw transport failure is ssh's own words (or the spawn's) — sandbox: spawn
// ENOENT; CI: ssh's DNS/connect error against the unresolvable sweep host.
// A companion-contract failure carries the module's own envelope wording. The
// two vocabularies must never be confused: the ON sweep accepts only
// channel-success or companion-contract failure; the OFF control accepts only
// raw failure.
const RAW_FAILURE_RE = /ENOENT|Could not resolve|Name or service|getaddrinfo|Connection refused|Connection timed out|ssh exited|spawn .*ssh|Network is unreachable/i;

function assertNoCompanionWording(text, label) {
  assert.ok(!/companion/i.test(String(text)),
    `${label}: failure text must not be companion-contract wording, got: ${JSON.stringify(String(text))}`);
}
function assertRawFailure(text, label) {
  assertNoCompanionWording(text, label);
  assert.ok(RAW_FAILURE_RE.test(String(text)),
    `${label}: expected a raw-transport failure signature (ssh ENOENT in the sandbox, ssh DNS/connect in CI), got: ${JSON.stringify(String(text))}`);
}

// Bound one drive so a hung raw path fails the sweep with a named surface
// instead of wedging the whole file. unref'd so the loser timer never holds the
// process open.
function guard(promise, ms, label) {
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => {
      const t = setTimeout(() => reject(new Error(`surface '${label}' did not settle within ${ms}ms — its raw path hung instead of failing`)), ms);
      if (typeof t.unref === 'function') t.unref();
    }),
  ]);
}

const settle = () => new Promise((r) => setImmediate(() => setImmediate(r)));

// A minimal PNG header — describeImage only sniffs the signature (≥12 bytes).
const PNG_BUF = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0, 0, 0, 1, 0, 0, 0x01, 0]);

// Shared chat shapes. `container` chat = yatfa shape; `manual` = bare tmux.
const CHAT = { host: HOST, container: 'totc', session: 'agent', cwd: '/work/tot', key: 'totc', name: 'totc', id: `${HOST}:totc`, cmd: 'bash' };
const CAP_CHAT = { host: HOST, container: 'totc', session: 'agent', key: 'totkey', name: 'totkey', id: `${HOST}:totkey` };
const SUB_CHAT = { host: HOST, container: 'totc', session: 'agent', key: 'totkey', name: 'totkey', id: `${HOST}:totkey` };
const CATALOG_ENTRY = { host: HOST, session: 'totalitysess', kind: 'tmux', lastActivity: null };

let httpServer, baseUrl;

describe('WARDEN-1412 companion-totality sweep', () => {
  let originalEnv;
  before(async () => {
    originalEnv = process.env.WARDEN_COMPANION_TRANSPORT;
    applyCompanionToggle(true);
    _resetChannelCacheForTests();
    httpServer = app.listen(0, '127.0.0.1');
    await new Promise((res, rej) => { httpServer.once('listening', res); httpServer.once('error', rej); });
    baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
    // Seed THE one live channel for HOST. Every ON leg below rides it — the
    // cache is what makes "zero connections outside the channel" observable.
    await getChannel(HOST, {}, seedingDeps());
    assert.strictEqual(getCompanionStatus(HOST).state, 'active', 'seed precondition: channel live');
    assert.strictEqual(_channelCacheHasForTests(HOST), true, 'seed precondition: channel cached');
  });
  after(async () => {
    _resetChannelCacheForTests();
    _resetPaneDeltaStateForTests();
    if (httpServer) await new Promise((r) => httpServer.close(r));
    if (originalEnv === undefined) delete process.env.WARDEN_COMPANION_TRANSPORT;
    else process.env.WARDEN_COMPANION_TRANSPORT = originalEnv;
    try { fs.rmSync(TEMP_HOME, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  // -------------------------------------------------------------------------
  // TOGGLE ON — every surface rides the channel. Each leg: drive the REAL
  // exported surface (production shape, no seams), assert its methods appear
  // on the wire (delta), and assert that any failure it reports is
  // companion-contract wording — never a raw transport failure.
  // -------------------------------------------------------------------------
  describe('toggle ON: every remote-op surface rides the seeded channel (zero raw fallbacks)', () => {
    it('hosts-status probe — GET /api/hosts/health rides the live channel ping (no ssh exists to answer raw)', async () => {
      const before = wireCount('ping');
      const body = await (await fetch(`${baseUrl}/api/hosts/health`)).json();
      const row = body.hosts.find((h) => h.host === HOST);
      assert.ok(row, 'probe host present');
      assert.strictEqual(row.ok, true,
        'online proves the answer came from the companion ping: the raw validateHost has no ssh binary to spawn in the sandbox, and no route to the sweep host in CI');
      assert.ok(wireCount('ping') > before, 'the probe issued a channel ping (WARDEN-1324 pingProbe)');
      // Same probeHostReachability also serves the cached /api/hosts/status poll
      // (pinned in depth by server-companion-probe.test.js — not re-driven here
      // because the 15s status cache makes toggle-flip assertions unreliable).
    });

    it('discovery — chats.discover routes to the channel discover RPC', async () => {
      const before = wireCount('discover');
      const r = await guard(chatsDiscover(HOST, {}), 15000, 'discover');
      assert.strictEqual(r.ok, true, `discover must succeed over the channel, got: ${JSON.stringify(r)}`);
      assert.strictEqual(r.chats.length, 1, 'the fake host reports one container');
      assert.strictEqual(r.chats[0].container, 'tot-agent');
      assert.ok(wireCount('discover') > before);
    });

    it('discovery catalog legs — discoverManual alive-check + window_activity ride the channel exec', async () => {
      const before = wireCount('exec');
      const entries = await guard(discoverManual(HOST, [CATALOG_ENTRY], {}), 20000, 'discoverManual');
      assert.strictEqual(entries[0].active, true,
        `the alive-check exec answered "1 totalitysess" over the channel: ${JSON.stringify(entries[0])}`);
      assert.ok(wireCount('exec') - before >= 2,
        'both remote legs (alive-check + window_activity, WARDEN-1371) rode exec');
    });

    it('capturePanes — chats.capturePanes routes to the channel capturePanes RPC', async () => {
      _resetPaneDeltaStateForTests(); // a live push cache would SKIP the RPC by design
      const before = wireCount('capturePanes');
      const out = await guard(chatsCapturePanes([CAP_CHAT], {}), 15000, 'capturePanes');
      assert.strictEqual(out[CAP_CHAT.id], 'captured pane body', `panes map: ${JSON.stringify(out)}`);
      assert.ok(wireCount('capturePanes') > before);
    });

    it('tmux read — tmux.read routes the capture-pane read to channel exec', async () => {
      const before = wireCount('exec');
      const out = await guard(tmuxRead(CHAT, {}, 40), 15000, 'tmux.read');
      assert.strictEqual(out, GENERIC_EXEC_STDOUT, 'the exec result flows through unchanged');
      assert.ok(wireCount('exec') > before);
    });

    it('tmux send — the directive write rides the channel send RPC', async () => {
      const before = wireCount('send');
      await guard(tmuxSend(CHAT, {}, 'hello totality'), 15000, 'tmux.send');
      assert.ok(wireCount('send') > before, 'send went over the channel');
    });

    it('tmux sendKey — the special key rides the channel sendKeys RPC', async () => {
      const before = wireCount('sendKeys');
      await guard(tmuxSendKey(CHAT, {}, 'Enter'), 15000, 'tmux.sendKey');
      assert.ok(wireCount('sendKeys') > before);
    });

    it('tmux hasSession — the liveness probe rides the channel hasSession RPC', async () => {
      const before = wireCount('hasSession');
      const alive = await guard(tmuxHasSession(CHAT, {}), 15000, 'tmux.hasSession');
      assert.strictEqual(alive, true);
      assert.ok(wireCount('hasSession') > before);
    });

    it('tmux probeSession — the bounded attach preflight rides the channel hasSession RPC', async () => {
      const before = wireCount('hasSession');
      const r = await guard(tmuxProbeSession(CHAT, {}), 15000, 'tmux.probeSession');
      assert.strictEqual(r.ok, true, `probe result: ${JSON.stringify(r)}`);
      assert.ok(wireCount('hasSession') > before);
    });

    it('tmux resize — the control-plane op rides the channel resize RPC', async () => {
      const before = wireCount('resize');
      await guard(tmuxResize(CHAT, {}, 100, 30), 15000, 'tmux.resize');
      assert.ok(wireCount('resize') > before);
    });

    it('tmux spawn — the agent create rides the channel spawnSession RPC', async () => {
      const before = wireCount('spawnSession');
      const ok = await guard(tmuxSpawn(CHAT, {}), 15000, 'tmux.spawn');
      assert.strictEqual(ok, true);
      assert.ok(wireCount('spawnSession') > before);
    });

    it('tmux kill — the agent destroy rides the channel killSession RPC', async () => {
      const before = wireCount('killSession');
      await guard(tmuxKill(CHAT, {}), 15000, 'tmux.kill');
      assert.ok(wireCount('killSession') > before);
    });

    it('tmux attachStream — the live web pane allocates its PTY over the channel (attachStart)', async () => {
      const before = wireCount('attachStart');
      const pty = attachStream(CHAT, {});
      assert.ok(pty instanceof CompanionAttachSession, 'the channel-backed handle, not a node-pty');
      await settle();
      assert.strictEqual(pty.sid, 'totsid', 'attachStart ACKed over the channel');
      assert.ok(wireCount('attachStart') > before);
      pty.kill();
      await settle();
    });

    it('CLI attachInteractive — warden attach routes the interactive bridge to the channel', async () => {
      // The BRIDGE's own behavior (rawMode stdin, SIGWINCH, exit codes) is
      // companion-cli-attach.test.js territory; the sweep asserts the ROUTING:
      // the companion bridge is the one asked, and it is asked for this host
      // with the composed attach script.
      let bridgeCall = null;
      await guard(attachInteractive(CHAT, {}, {
        attachInteractiveCompanion: async (host, script, cfg, deps) => {
          bridgeCall = { host, script };
          return 0;
        },
      }), 15000, 'tmux.attachInteractive');
      assert.ok(bridgeCall, 'the companion interactive bridge was routed (never attachInteractiveTmux)');
      assert.strictEqual(bridgeCall.host, HOST);
      assert.ok(bridgeCall.script.startsWith('export LANG=en_US.UTF-8'),
        'the composed attach command went through the shared remote-script wrapper (the WARDEN-1295 parity wrapper)');
    });

    it('script-delivery leg: file viewer read (readChatFile REMOTE branch) rides channel exec', async () => {
      const before = wireCount('exec');
      const r = await guard(readChatFile({ host: HOST, cwd: '/work/tot' }, 'src/app.js'), 15000, 'readChatFile');
      assert.deepStrictEqual(r, { ok: true, content: GENERIC_EXEC_STDOUT }, `got: ${JSON.stringify(r)}`);
      assert.ok(wireCount('exec') > before);
    });

    it('script-delivery leg: linkifier existence probe (remoteFileExists) rides channel exec', async () => {
      const before = wireCount('exec');
      const exists = await guard(remoteFileExists(HOST, '/work', 'src/app.js'), 15000, 'remoteFileExists');
      assert.strictEqual(exists, true);
      assert.ok(wireCount('exec') > before);
    });

    it('script-delivery leg: session search (remoteSearchClaudeSessions) rides channel exec', async () => {
      const before = wireCount('exec');
      const sessions = await guard(remoteSearchClaudeSessions(HOST, 'needle'), 20000, 'remoteSearchClaudeSessions');
      assert.ok(Array.isArray(sessions), 'the search parsed (empty is fine — routing is the claim)');
      assert.ok(wireCount('exec') > before);
    });

    it('script-delivery leg: session transcript view (remoteReadSessionTranscript) rides channel exec', async () => {
      const before = wireCount('exec');
      const r = await guard(remoteReadSessionTranscript(HOST, 'sess-1'), 15000, 'remoteReadSessionTranscript');
      assert.strictEqual(r.ok, true);
      assert.ok(wireCount('exec') > before);
    });

    it('script-delivery leg: tmux preflight (preflightTmux REMOTE branch) rides channel exec', async () => {
      const before = wireCount('exec');
      const err = await guard(preflightTmux(HOST), 15000, 'preflightTmux');
      assert.strictEqual(err, null, 'the preflight saw OK over the channel');
      assert.ok(wireCount('exec') > before);
    });

    it('script-delivery leg: claude-install detection (detectClaude REMOTE probes) rides channel exec x3', async () => {
      const before = wireCount('exec');
      const p = await guard(detectClaude(HOST), 20000, 'detectClaude');
      assert.strictEqual(p, null, 'no probe line starts with / on the generic payload — routing is the claim');
      assert.strictEqual(wireCount('exec') - before, 3, 'all three probes rode the channel concurrently');
    });

    it('script-delivery leg: observer transcript tail (readTranscriptPhase, container branch) rides channel exec', async () => {
      const before = wireCount('exec');
      await guard(readTranscriptPhase({ host: HOST, container: 'totc' }, {}), 15000, 'readTranscriptPhase');
      assert.ok(wireCount('exec') > before,
        'the FULL docker-exec `sh -c` string rode as the script (container unset — WARDEN-1284 leg 6)');
    });

    it('script-delivery leg: session-browser listing (remoteClaudeSessionsDetail) rides channel exec', async () => {
      const before = wireCount('exec');
      const r = await guard(remoteClaudeSessionsDetail(HOST, 40), 20000, 'remoteClaudeSessionsDetail');
      assert.deepStrictEqual(r, { sessions: [], unreachable: false }, `got: ${JSON.stringify(r)}`);
      assert.ok(wireCount('exec') > before);
    });

    it('git routes — runGit (remote container chat) rides channel exec', async () => {
      const before = wireCount('exec');
      const r = await guard(runGit({ host: HOST, container: 'totc' }, ['status'], '/work/tot'), 15000, 'runGit');
      assert.strictEqual(r.ok, true, `git result: ${JSON.stringify(r)}`);
      assert.ok(wireCount('exec') > before);
    });

    it('git routes — runInContext rides channel exec with the inner script + container', async () => {
      const before = wireCount('exec');
      const r = await guard(runInContext({ host: HOST, container: 'totc' }, 'echo hi'), 15000, 'runInContext');
      assert.strictEqual(r.ok, true, `runInContext result: ${JSON.stringify(r)}`);
      assert.ok(wireCount('exec') > before);
      const last = [...WIRE].reverse().find((w) => w.method === 'exec');
      assert.strictEqual(last.params.container, 'totc',
        'the container rides the RPC so the host side reassembles the docker-exec shape byte-identically');
    });

    it('pasteImage writeFile — the clipboard-image delivery rides the channel writeFile RPC (the WARDEN-1348 regression site)', async () => {
      const before = wireCount('writeFile');
      const r = await guard(deliverPastedImage(CHAT, {}, PNG_BUF), 15000, 'deliverPastedImage');
      assert.strictEqual(r.ok, true, `paste delivery: ${JSON.stringify(r)}`);
      assert.ok(r.marker, 'a marker is only ever earned over a delivered write');
      assert.ok(wireCount('writeFile') > before);
    });

    it('paneContainer resolve — the pane process-tree walk rides channel exec', async () => {
      clearPaneContainerCache();
      const before = wireCount('exec');
      const resolution = await guard(resolvePaneContainer({ host: HOST, session: 'sweepwalk' }, {}), 15000, 'resolvePaneContainer');
      assert.strictEqual(resolution.state, 'none',
        'transport ok + an empty tree = honest none (routing is the claim)');
      assert.ok(wireCount('exec') > before);
    });

    it('/api/pane-project — the HTTP fallback walk rides channel exec', async () => {
      clearPaneContainerCache();
      const before = wireCount('exec');
      const body = await (await fetch(`${baseUrl}/api/pane-project?id=sweepproj`)).json();
      assert.strictEqual(body.state, 'none', `endpoint answer: ${JSON.stringify(body)}`);
      assert.ok(wireCount('exec') > before, 'the walk reached the host over the channel (WARDEN-1405)');
    });

    it('CLI dash — cmdDash discovers + preflights over the channel and hands the attach to the companion bridge', async () => {
      let bridgeCall = null;
      let died = null;
      await guard(cmdDash(['--host', HOST], {}, {
        die: (msg) => { died = msg; },
        exit: () => {},
        attachInteractiveCompanion: async (host, script) => { bridgeCall = { host, script }; return 0; },
      }), 25000, 'cmdDash');
      assert.strictEqual(died, null, `dash died: ${died}`);
      assert.ok(bridgeCall, 'the multi-window attach went to the companion bridge');
      assert.strictEqual(bridgeCall.host, HOST);
      assert.ok(/tmux new-session/.test(bridgeCall.script), 'the composed dash script rides the bridge');
      // discover + preflight both crossed the wire this leg.
      assert.ok(wireCount('discover') > 0 && wireCount('exec') > 0, 'dash legs rode the channel');
    });

    it('pane-push subscriptions — reconcilePaneSubscriptions subscribes over the channel; unsubscribe releases', async () => {
      _resetPaneDeltaStateForTests();
      const beforeSub = wireCount('subscribePanes');
      await guard(reconcilePaneSubscriptions([SUB_CHAT], {}), 15000, 'reconcilePaneSubscriptions');
      assert.ok(wireCount('subscribePanes') > beforeSub, 'the production trigger subscribed over the channel');
      const beforeUnsub = wireCount('unsubscribePanes');
      await guard(unsubscribePanes(HOST, ['totkey'], {}), 15000, 'unsubscribePanes');
      assert.ok(wireCount('unsubscribePanes') > beforeUnsub);
      _resetPaneDeltaStateForTests();
      // The WS gate that drives these ops (wsLayer.js syncMonitorSubscription +
      // the close-handler grouping) is exercised at this op level because the
      // ws layer's per-connection state is not importable; its gate composition
      // (toggle + LOCAL + exclusion) is pinned by companion.test.js.
    });

    it('invariant: the seeded channel survived every ON leg — one channel, zero side channels', () => {
      assert.strictEqual(_channelCacheHasForTests(HOST), true,
        'no leg tore down or replaced the one channel (a second bootstrap would have)');
    });
  });

  // -------------------------------------------------------------------------
  // ALLOW-LIST — the deliberate raw-ssh exceptions, asserted so an INCOMPLETE
  // sweep can never masquerade as a passing one. (See the file header.)
  // -------------------------------------------------------------------------
  describe('allow-list: the deliberate raw-ssh exceptions (asserted, with citations)', () => {
    it('bootstrap is raw BY DESIGN — a fresh host bootstraps over raw ssh (raw signature inside a companion envelope, nothing on the wire)', async () => {
      assert.strictEqual(_channelCacheHasForTests(BOOTSTRAP_HOST), false, 'precondition: never engaged');
      await assert.rejects(
        guard(getChannel(BOOTSTRAP_HOST, {}, {}), 30000, 'bootstrap'),
        (e) => {
          assert.ok(/bootstrap probe failed/.test(e.message), `the failure is the bootstrap probe: ${e.message}`);
          // The companion ENVELOPE is companion wording BY DESIGN here — the
          // bootstrap IS the raw path — so assert the raw signature is present
          // inside it rather than the envelope's absence.
          assert.ok(RAW_FAILURE_RE.test(e.message),
            `bootstrap probe failure must carry the raw ssh signature, got: ${JSON.stringify(e.message)}`);
          return true;
        },
      );
      assert.strictEqual(getCompanionStatus(BOOTSTRAP_HOST).state, 'error');
      assert.strictEqual(_channelCacheHasForTests(BOOTSTRAP_HOST), false,
        'a failed bootstrap leaves no channel — the raw path is the INSTALL path, never a fallback behind one');
    });

    it('uninstall precheck is raw BY DESIGN — it fails fast over raw ssh, never touches the seeded channel', async () => {
      assert.strictEqual(_channelCacheHasForTests(HOST), true, 'precondition: seeded channel live');
      const wireBefore = WIRE.length;
      const r = await guard(fetch(`${baseUrl}/api/companion/uninstall`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ host: HOST }),
      }), 30000, 'uninstall');
      assert.strictEqual(r.status, 400,
        'the raw validateHost precheck fails without a working ssh → connectivity 400 (a companion-routed precheck would ping OK and fall through)');
      assert.strictEqual(_channelCacheHasForTests(HOST), true, 'the precheck neither rode nor tore down the channel');
      assert.strictEqual(WIRE.length, wireBefore, 'zero channel RPCs — uninstall is the raw path by design (WARDEN-882/1324)');
      // Deep pin: server-companion-probe.test.js TRAP 1.
    });
  });

  // -------------------------------------------------------------------------
  // DETECTOR CONTROL — the same drives with the toggle OFF. Each surface must
  // produce its raw signature, proving the sweep can SEE a fallback (a broken
  // detector cannot read as a green sweep). Two honest per-family signature
  // differences, both documented rather than papered over:
  //   • the probe's shipped failure envelope is validateHost's generic
  //     'Host unreachable' (it does not quote ssh) — the ON/OFF states are
  //     still perfectly distinguishable (ok:true vs ok:false).
  //   • the subscription ops bootstrap on demand (they have no production
  //     caller with the toggle off — wsLayer's gate refuses first, asserted on
  //     reconcilePaneSubscriptions below) — so the direct op's OFF signature is
  //     the RAW ssh failure arriving INSIDE the companion bootstrap envelope.
  // -------------------------------------------------------------------------
  describe('toggle OFF (detector control): every surface shows its raw signature', () => {
    let envBefore;
    before(async () => {
      envBefore = process.env.WARDEN_COMPANION_TRANSPORT;
      applyCompanionToggle(false);
      _resetChannelCacheForTests();          // no channel to ride — raw paths only
      clearPaneContainerCache();
      _resetPaneDeltaStateForTests();
    });
    after(() => {
      applyCompanionToggle(true);            // the top-level after() restores for real
      _resetChannelCacheForTests();
      clearPaneContainerCache();
      _resetPaneDeltaStateForTests();
    });

    it('hosts-status probe OFF — the raw validateHost runs and fails (ok:false, no channel ping)', async () => {
      const before = wireCount('ping');
      const body = await (await fetch(`${baseUrl}/api/hosts/health`)).json();
      const row = body.hosts.find((h) => h.host === HOST);
      assert.strictEqual(row.ok, false, 'the raw probe cannot succeed here');
      assertNoCompanionWording(row.error, 'probe OFF');
      assert.strictEqual(wireCount('ping'), before, 'no channel RPC');
    });

    it('discovery OFF — chats.discover fails with the raw signature', async () => {
      const before = wireCount('discover');
      const r = await guard(chatsDiscover(HOST, {}), 20000, 'discover OFF');
      assert.strictEqual(r.ok, false);
      assertRawFailure(r.error, 'discover OFF');
      assert.strictEqual(wireCount('discover'), before);
    });

    it('discovery catalog legs OFF — nothing is active, nothing rides the channel', async () => {
      const before = wireCount('exec');
      const entries = await guard(discoverManual(HOST, [CATALOG_ENTRY], {}), 20000, 'discoverManual OFF');
      // WARDEN-1422 rework: a failed raw alive-check reads UNKNOWN (null), not a
      // fabricated false — a transport failure must never be readable as
      // "confirmed stopped" (the temporary-entry GC keys on strict === false).
      assert.strictEqual(entries[0].active, null, 'the raw alive-check could not run — unknown, not stopped');
      assert.strictEqual(wireCount('exec'), before);
    });

    it('capturePanes OFF — the panes map stays empty (raw capture failed, no channel RPC)', async () => {
      const before = wireCount('capturePanes');
      const out = await guard(chatsCapturePanes([CAP_CHAT], {}), 20000, 'capturePanes OFF');
      assert.strictEqual(out[CAP_CHAT.id], undefined, 'no pane content arrived');
      assert.strictEqual(wireCount('capturePanes'), before);
    });

    it('tmux read OFF — throws the raw transport failure', async () => {
      const before = wireCount('exec');
      await assert.rejects(
        guard(tmuxRead(CHAT, {}, 40), 20000, 'tmux.read OFF'),
        (e) => { assertRawFailure(e.message, 'tmux.read OFF'); return true; },
      );
      assert.strictEqual(wireCount('exec'), before);
    });

    it('tmux send OFF — throws the raw transport failure', async () => {
      const before = wireCount('send');
      await assert.rejects(
        guard(tmuxSend(CHAT, {}, 'x'), 20000, 'tmux.send OFF'),
        (e) => { assertRawFailure(e.message, 'tmux.send OFF'); return true; },
      );
      assert.strictEqual(wireCount('send'), before);
    });

    it('tmux sendKey OFF — throws the raw transport failure', async () => {
      const before = wireCount('sendKeys');
      await assert.rejects(
        guard(tmuxSendKey(CHAT, {}, 'Enter'), 20000, 'tmux.sendKey OFF'),
        (e) => { assertRawFailure(e.message, 'tmux.sendKey OFF'); return true; },
      );
      assert.strictEqual(wireCount('sendKeys'), before);
    });

    it('tmux hasSession OFF — reports not-alive (the raw probe cannot run)', async () => {
      const before = wireCount('hasSession');
      const alive = await guard(tmuxHasSession(CHAT, {}), 20000, 'tmux.hasSession OFF');
      assert.strictEqual(alive, false);
      assert.strictEqual(wireCount('hasSession'), before);
    });

    it('tmux probeSession OFF — the raw probe shape (ok:false, non-zero code, ssh wording)', async () => {
      const before = wireCount('hasSession');
      const r = await guard(tmuxProbeSession(CHAT, {}), 20000, 'tmux.probeSession OFF');
      assert.strictEqual(r.ok, false);
      assert.notStrictEqual(r.code, 0);
      assertRawFailure(r.stderr, 'tmux.probeSession OFF');
      assert.strictEqual(wireCount('hasSession'), before);
    });

    it('tmux resize OFF — settles without the channel (best-effort void, shipped contract)', async () => {
      const before = wireCount('resize');
      await guard(tmuxResize(CHAT, {}, 100, 30), 20000, 'tmux.resize OFF');
      assert.strictEqual(wireCount('resize'), before);
    });

    it('tmux spawn OFF — throws the raw transport failure', async () => {
      const before = wireCount('spawnSession');
      await assert.rejects(
        guard(tmuxSpawn(CHAT, {}), 20000, 'tmux.spawn OFF'),
        (e) => { assertRawFailure(e.message, 'tmux.spawn OFF'); return true; },
      );
      assert.strictEqual(wireCount('spawnSession'), before);
    });

    it('tmux kill OFF — settles without the channel (best-effort void, shipped contract)', async () => {
      const before = wireCount('killSession');
      await guard(tmuxKill(CHAT, {}), 20000, 'tmux.kill OFF');
      assert.strictEqual(wireCount('killSession'), before);
    });

    it('tmux attachStream OFF — the raw `ssh -tt` pty exits (or throws) without ever reaching the channel', async () => {
      const before = wireCount('attachStart');
      let outcome;
      try {
        const pty = attachStream(CHAT, {});
        outcome = await Promise.race([
          new Promise((res) => pty.onExit((x) => res({ exited: true, x }))),
          guard(new Promise(() => {}), 20000, 'attachStream OFF'),
        ]).catch((e) => ({ error: e }));
      } catch (e) {
        outcome = { error: e };
      }
      assert.ok(outcome.exited || outcome.error,
        `the raw attach must fail fast (ssh ENOENT in the sandbox, ssh connect/DNS in CI), got: ${JSON.stringify(outcome)}`);
      assert.strictEqual(wireCount('attachStart'), before, 'no attachStart ever crossed the channel');
    });

    it('script-delivery legs OFF — readChatFile, remoteFileExists, search, transcript, preflight, detectClaude, observer tail, session browser: raw failures, zero exec on the wire', async () => {
      const execBefore = wireCount('exec');

      const rf = await guard(readChatFile({ host: HOST, cwd: '/work/tot' }, 'src/app.js'), 20000, 'readChatFile OFF');
      assert.strictEqual(rf.ok, false);
      assertNoCompanionWording(rf.error, 'readChatFile OFF');
      // Known shipped envelope: readChatFile's mapReadScriptError collapses any
      // non-marker output to 'read failed' — the raw ssh stderr is not quoted.
      // The detector claim here is "not a companion answer, not a channel
      // success"; the raw signature for this family is asserted on the legs
      // whose envelopes DO quote it (transcript view, git routes, preflight).

      const exists = await guard(remoteFileExists(HOST, '/work', 'a.js'), 20000, 'remoteFileExists OFF');
      assert.strictEqual(exists, false);

      const sessions = await guard(remoteSearchClaudeSessions(HOST, 'needle'), 25000, 'remoteSearchClaudeSessions OFF');
      assert.deepStrictEqual(sessions, []);

      const tr = await guard(remoteReadSessionTranscript(HOST, 'sess-1'), 20000, 'remoteReadSessionTranscript OFF');
      assert.strictEqual(tr.ok, false);
      assertRawFailure(`${tr.stdout || ''}${tr.stderr || ''}`, 'remoteReadSessionTranscript OFF');

      const pf = await guard(preflightTmux(HOST), 20000, 'preflightTmux OFF');
      assert.ok(typeof pf === 'string' && pf.length > 0, 'the preflight reports a failure');
      assertNoCompanionWording(pf, 'preflightTmux OFF');
      // Known shipped artifact, noted honestly: the OFF wording blames tmux
      // ("tmux is required on <host>") because the raw stdout was empty — the
      // detector claim here is "not a companion answer, not a channel success".

      const dc = await guard(detectClaude(HOST), 25000, 'detectClaude OFF');
      assert.strictEqual(dc, null, 'no probe answered');

      const rt = await guard(readTranscriptPhase({ host: HOST, container: 'totc' }, {}), 20000, 'readTranscriptPhase OFF');
      assert.strictEqual(rt, null, 'the observer tail reports nothing on a raw failure');

      const detail = await guard(remoteClaudeSessionsDetail(HOST, 40), 25000, 'remoteClaudeSessionsDetail OFF');
      assert.strictEqual(detail.unreachable, true, 'the raw failure classifies as transport-unreachable');
      assert.deepStrictEqual(detail.sessions, []);

      assert.strictEqual(wireCount('exec'), execBefore, 'zero exec RPCs across all eight legs');
    });

    it('git routes OFF — runGit + runInContext fail with the raw signature', async () => {
      const before = wireCount('exec');
      const g = await guard(runGit({ host: HOST, container: 'totc' }, ['status'], '/work/tot'), 20000, 'runGit OFF');
      assert.strictEqual(g.ok, false);
      assertRawFailure(`${g.stdout || ''}${g.stderr || ''}`, 'runGit OFF');
      const ric = await guard(runInContext({ host: HOST, container: 'totc' }, 'echo hi'), 20000, 'runInContext OFF');
      assert.strictEqual(ric.ok, false);
      assertRawFailure(`${ric.stdout || ''}${ric.stderr || ''}`, 'runInContext OFF');
      assert.strictEqual(wireCount('exec'), before);
    });

    it('pasteImage writeFile OFF — the delivery fails with the raw signature (the WARDEN-1348 shape, now visible)', async () => {
      const before = wireCount('writeFile');
      const r = await guard(deliverPastedImage(CHAT, {}, PNG_BUF), 20000, 'deliverPastedImage OFF');
      assert.strictEqual(r.ok, false);
      assert.ok(r.marker === undefined, 'no marker is ever earned on a failed delivery');
      assertRawFailure(r.error, 'deliverPastedImage OFF');
      assert.strictEqual(wireCount('writeFile'), before);
    });

    it('paneContainer resolve OFF — the walk reports failed with the raw reason', async () => {
      clearPaneContainerCache();
      const before = wireCount('exec');
      const resolution = await guard(resolvePaneContainer({ host: HOST, session: 'sweepwalk' }, {}), 20000, 'resolvePaneContainer OFF');
      assert.strictEqual(resolution.state, 'failed');
      assertRawFailure(resolution.reason, 'resolvePaneContainer OFF');
      assert.strictEqual(wireCount('exec'), before);
    });

    it('/api/pane-project OFF — the HTTP walk answers failed with zero channel RPCs', async () => {
      clearPaneContainerCache();
      const before = wireCount('exec');
      const body = await (await fetch(`${baseUrl}/api/pane-project?id=sweepproj`)).json();
      assert.strictEqual(body.state, 'failed');
      assert.strictEqual(wireCount('exec'), before);
    });

    it('CLI dash OFF — dies at discovery with the raw signature (never reaches preflight/attach)', async () => {
      const before = wireCount('exec') + wireCount('discover');
      let died = null;
      await guard(cmdDash(['--host', HOST], {}, {
        die: (msg) => { throw new Error(msg); },
        exit: () => {},
      }), 25000, 'cmdDash OFF').catch((e) => { died = e.message; });
      assert.ok(died, 'dash reported its failure');
      assertRawFailure(died, 'cmdDash OFF');
      assert.strictEqual(wireCount('exec') + wireCount('discover'), before);
    });

    it('pane-push subscriptions OFF — the production trigger is a no-op gate (reconcile returns [])', async () => {
      const beforeSub = wireCount('subscribePanes');
      const results = await guard(reconcilePaneSubscriptions([SUB_CHAT], {}), 20000, 'reconcile OFF');
      assert.deepStrictEqual(results, [], 'the toggle-off gate issues nothing (wsLayer.js:216 refuses upstream)');
      assert.strictEqual(wireCount('subscribePanes'), beforeSub);
    });

    it('pane-push subscriptions OFF — the direct op bootstraps on demand, and the RAW ssh failure arrives inside the companion envelope', async () => {
      const beforeSub = wireCount('subscribePanes');
      const r = await guard(subscribePanes(HOST, [SUB_CHAT], {}), 30000, 'subscribePanes OFF');
      assert.strictEqual(r.ok, false, 'no subscription without a channel');
      assert.ok(/bootstrap probe failed/.test(r.error || ''), `the op tried to bootstrap (its only path): ${r.error}`);
      // The companion envelope is companion wording BY DESIGN (bootstrap is the
      // op's only path to a channel) — assert the raw signature is present
      // inside it rather than the envelope's absence.
      assert.ok(RAW_FAILURE_RE.test(r.error || ''),
        `the bootstrap failure must carry the raw ssh signature, got: ${JSON.stringify(r.error)}`);
      assert.strictEqual(wireCount('subscribePanes'), beforeSub);
    });
  });

  // -------------------------------------------------------------------------
  // THE GATE CENSUS — the completeness tie. The sweep is only as good as its
  // enumeration, so the enumeration is checked LIVE against the tree on every
  // run (the census grew 30 → 36 while the ticket sat in review — never trust a
  // stored count). If this fails, a gate site was added or removed: re-run
  //   git grep -n isCompanionExcludedHost -- 'src/*.js' | grep -v test
  // and, for a NEW routed op family, TEACH THE SWEEP: add an ON leg + an OFF
  // control leg above (and extend CHANNEL_METHODS if the Go vocabulary grew).
  // A new UNGATED remote op has no census row to grow — it fails the ON sweep
  // with 'unknown method' the first time it is driven, which is exactly the
  // WARDEN-1348 class this file exists to catch.
  // -------------------------------------------------------------------------
  describe('gate census: the sweep covers every isCompanionExcludedHost site in the tree', () => {
    // Expected per-file counts, cross-checked against origin/main @ 06ed08f:
    // `git grep -n isCompanionExcludedHost -- 'src/*.js' | grep -v test`.
    const CENSUS = {
      'chats.js': 4,        // discover + viaCompanion(×2 legs) + capturePanes
      'cli.js': 2,          // import + cmdDash's useCompanion
      'companion.js': 10,   // the module's own doc line, predicate, status maps, op backstops
      'paneContainer.js': 2,// import + runWalk's remote route
      'pasteImage.js': 2,   // import + deliverPastedImage's remote gate (the WARDEN-1348 site)
      'server.js': 2,       // import + pollFleetStates eligibility
      'tmux.js': 11,        // import + read/send/sendKey/hasSession/probeSession/resize/spawn/kill/attachStream/attachInteractive
      'wsLayer.js': 3,      // import + syncMonitorSubscription + close-handler grouping
    };

    it('every non-test src file matches its census row, and no unlisted file grew a gate', () => {
      const srcDir = path.dirname(fileURLToPath(import.meta.url));
      const files = fs.readdirSync(srcDir)
        .filter((f) => f.endsWith('.js') && !f.endsWith('.test.js'))
        .sort();
      const found = {};
      for (const f of files) {
        const text = fs.readFileSync(path.join(srcDir, f), 'utf8');
        const n = text.split('\n').filter((line) => /\bisCompanionExcludedHost\b/.test(line)).length;
        if (n > 0) found[f] = n;
      }
      for (const [f, expected] of Object.entries(CENSUS)) {
        assert.strictEqual(found[f], expected,
          `gate census moved in src/${f}: expected ${expected} isCompanionExcludedHost lines, found ${found[f] ?? 0}. ` +
          `A gate site was added or removed — re-run the census grep, and if a NEW remote op family is routed, add its ON leg + OFF control to this sweep (see the census test's comment).`);
      }
      const unlisted = Object.keys(found).filter((f) => !(f in CENSUS));
      assert.deepStrictEqual(unlisted, [],
        `new gate-site file(s) appeared: ${unlisted.join(', ')} — add census rows AND sweep legs for their op families`);
      const total = Object.values(found).reduce((a, b) => a + b, 0);
      assert.strictEqual(total, 36,
        `total gate sites changed (${total} ≠ 36) — update CENSUS and re-verify the sweep covers the new/removed family`);
    });

    // -----------------------------------------------------------------------
    // THE RAW-TRANSPORT CALL-SITE CENSUS (WARDEN-1421) — the companion of the
    // gate census above, and the closure of the blind spot that census's own
    // comment concedes four lines up: "A new UNGATED remote op has no census
    // row to grow". The gate census counts GATES, so a WARDEN-1348-shaped
    // regression — a NEW file created on the raw-ssh pattern, with no gate at
    // all — adds ZERO gate sites, drives no sweep leg (the driven-leg list is
    // hand-maintained), and ships GREEN. Nothing drives a file nobody noticed.
    //
    // THE INSTRUMENT. Every raw remote op in this tree begins at one of ssh.js's
    // six remote-spawn exports — run, runWithPool, validateHost, attach,
    // attachPty, buildSshArgv (ssh.js's own `spawn(SSH_BIN, …)` sites are :115
    // inside run/validateHost's argv path, :603 in attach, :624 in attachPty).
    // So the census counts CALL-SITE REFERENCES TO THOSE IMPORTED BINDINGS,
    // per non-test src file, and pins every file that carries one.
    //
    // COUNTING RULE (stated because a naive rule is worse than none):
    //   • Only files whose `import { … } from './ssh.js'` names at least one of
    //     the six participate. shellQuote/isTransportFailure-only importers —
    //     git.js, gitRoutes.js, observer.js, claudeSessions.js,
    //     sessionRecovery.js, tmux.js — are invisible BY CONSTRUCTION, and
    //     childCapture.js deliberately imports no ssh transport at all
    //     (in-file comment, childCapture.js:18).
    //   • Counted on the source with COMMENTS AND STRING/TEMPLATE LITERALS
    //     STRIPPED, and with the ssh.js import statement itself blanked. That
    //     is not fussiness: a raw `\brun\b` token census over this tree is pure
    //     noise (`--dry-run`, `re-run`, `tmux attach -t …` inside shell script
    //     literals, and `run:`/`attach:` object keys all match), which is why
    //     the proposal's naive measurement found 40+ false hits in files that
    //     never import these bindings at all.
    //   • References, not literal `binding(` calls. This codebase's dominant
    //     seam is injection — `(deps.X ?? X)(args)` and
    //     `const runFn = deps.run ?? X; … runFn(…)` — so a call-site regex
    //     misses the REAL sites in cli.js, companion.js and chats.js. The
    //     binding REFERENCE is the tripwire: a new raw op cannot reach ssh
    //     without naming one.
    //   • Property accesses (`deps.run`) and object keys (`{ run: … }`) are NOT
    //     counted — those are the injection seam's plumbing, not a transport
    //     reach. Hence chats.js:374's `{ run: runWithPoolFn }` option value and
    //     every `deps.run` is excluded, while the `?? run` fallback it guards is
    //     counted.
    //
    // ZERO TOLERANCE, mirroring the gate census's maintenance model: any count
    // change in a mapped file, and ANY unlisted file carrying one of the six,
    // is RED with re-triage instructions. Never trust a stored count — the gate
    // census grew 30 → 36 while its own ticket sat in review, and between this
    // slice's proposal (720bc00) and its implementation (d2d72cc) the server.js
    // validateHost anchors moved by +1/+25 lines inside a single day.
    //
    // MUTATION CONTROL (run at implementation time, the same discipline as the
    // toggle-OFF control legs above — a guard that has never been seen to fail
    // is not a guard). BOTH arms were driven and reverted:
    //   1. UNLISTED FILE. A temp consumer src/warden-1421-mutant.js importing
    //      buildSshArgv from ./ssh.js and spawning it was added to the tree.
    //      This census turned RED with "unlisted file(s) reach the raw ssh
    //      transport: warden-1421-mutant.js", naming the file and the two
    //      remedies — while the GATE census above stayed GREEN, which IS the
    //      blind spot this census closes. Reverted → GREEN.
    //   2. COUNT DRIFT. A second buildSshArgv call was added to pasteImage.js
    //      (the WARDEN-1348 file). RED with "raw-transport census moved in
    //      src/pasteImage.js: expected {"buildSshArgv":1}, found
    //      {"buildSshArgv":2}". Reverted → GREEN.
    // The detector sees exactly the WARDEN-1348 shape it exists for.
    // -----------------------------------------------------------------------
    const RAW_BINDINGS = ['run', 'runWithPool', 'validateHost', 'attach', 'attachPty', 'buildSshArgv'];

    // Per-file expected call-site counts of the six bindings, re-derived LIVE
    // against origin/main @ d2d72cc. Every row is a CITED deliberate raw path:
    // class (a) the transport core, (b) a gated toggle-off branch, (c) a named
    // allow-list exception. Rows are the routing decision's audit trail — the
    // census PINS them, so growth or shrink is visible on the next push.
    const RAW_TRANSPORT_CENSUS = {
      // ---- class (a): the deliberate raw core ----------------------------
      // ssh.js IS the transport (buildSshArgv :73, validateHost :384, run :435,
      // runWithPool :560, attach :600, attachPty :621) — it defines the six
      // rather than importing them, so it carries no ssh.js import and is
      // invisible to this instrument by construction, asserted separately below.
      'companion.js': {
        // The bootstrap legs: a channel cannot install itself over the channel.
        // `run as defaultRun` (:33) reaches the tree through the injection
        // rebind `deps.run ?? defaultRun`.
        run: 3,          // :969 bootstrapChannel, :1219 uninstallCompanion, :1805 deliverRemoteScript's raw path
        buildSshArgv: 2, // :564 spawnPersistentChannel, :638 streamFileToHost — the upload/channel legs
      },
      // ---- class (b): gated toggle-off branches --------------------------
      'chats.js': {
        run: 1,          // :366 discoverManual's `deps.run ?? run` — activity read, behind viaCompanion()
        runWithPool: 3,  // :265 discover + :367 discoverManual injection rebinds, :715 capturePanes' raw else-branch
      },
      'paneContainer.js': {
        // :292, the else-branch of the gated ternary at :289–291
        // (`companionOn && !isCompanionExcludedHost(host) ? deliverRemoteScript : runWithPool`).
        runWithPool: 1,
      },
      'cli.js': {
        run: 1,          // :232 cmdDash's dash preflight (dry-run-guarded)
        attach: 1,       // :253 the toggle-off attach fallback; the companion-bridged path is the default
      },
      'pasteImage.js': {
        buildSshArgv: 1, // :221 buildPasteSshArgv — the gated WARDEN-1348 site
      },
      // ---- class (b) + (c): server.js carries one of each -----------------
      'server.js': {
        // :1217 probeHostReachability's raw fallback — companion-routing the
        //   probe would bootstrap the binary being probed (comments :1200–1213).
        // :2424 POST /api/companion/uninstall's precheck — a named allow-list
        //   exception: a host whose flag was on and is now off must still be
        //   cleanable, so the endpoint works regardless of toggle state
        //   (comments :2420–2422; re-asserted as a sweep leg above).
        validateHost: 2,
      },
    };

    it('every raw ssh-transport call site sits in a cited census row, and no unlisted file reaches the transport', () => {
      const srcDir = path.dirname(fileURLToPath(import.meta.url));

      // Blank comments and string/template literals so the census counts CODE,
      // not prose and shell scripts. Template-literal `${…}` holes are recursed
      // into (they are code), newlines are preserved so line numbers survive.
      const stripNonCode = (src) => {
        let out = '';
        let i = 0;
        const n = src.length;
        while (i < n) {
          const c = src[i];
          const d = src[i + 1];
          if (c === '/' && d === '/') { while (i < n && src[i] !== '\n') i++; continue; }
          if (c === '/' && d === '*') {
            i += 2;
            while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { if (src[i] === '\n') out += '\n'; i++; }
            i += 2; continue;
          }
          if (c === "'" || c === '"') {
            const q = c; i++;
            while (i < n && src[i] !== q) { if (src[i] === '\\') i++; if (src[i] === '\n') out += '\n'; i++; }
            i++; continue;
          }
          if (c === '`') {
            i++;
            while (i < n && src[i] !== '`') {
              if (src[i] === '\\') { i += 2; continue; }
              if (src[i] === '$' && src[i + 1] === '{') {
                i += 2;
                let depth = 1; let inner = '';
                while (i < n) {
                  if (src[i] === '{') depth++;
                  else if (src[i] === '}') { depth--; if (!depth) break; }
                  inner += src[i]; i++;
                }
                out += ` ${stripNonCode(inner)} `;
                i++; continue;
              }
              if (src[i] === '\n') out += '\n';
              i++;
            }
            i++; continue;
          }
          out += c; i++;
        }
        return out;
      };

      const files = fs.readdirSync(srcDir)
        .filter((f) => f.endsWith('.js') && !f.endsWith('.test.js'))
        .sort();

      const found = {};
      for (const f of files) {
        const text = fs.readFileSync(path.join(srcDir, f), 'utf8');
        // The import must be detected on the RAW text: stripNonCode blanks the
        // module specifier's string literal, so `from './ssh.js'` is gone from
        // the stripped source. Detect there, count on the stripped source —
        // stripNonCode preserves newlines, so the two agree line for line.
        const im = text.match(/import\s*\{([^}]*)\}\s*from\s*['"]\.\/ssh\.js['"]\s*;?/s);
        if (!im) continue;
        // Map imported name → local binding, keeping only the six (`run as
        // defaultRun` in companion.js is why the alias half matters).
        const bindings = im[1].split(',')
          .map((s) => s.trim()).filter(Boolean)
          .map((s) => { const p = s.split(/\s+as\s+/); return { imported: p[0].trim(), local: (p[1] || p[0]).trim() }; })
          .filter((b) => RAW_BINDINGS.includes(b.imported));
        if (!bindings.length) continue;
        const lines = stripNonCode(text).split('\n');
        assert.strictEqual(lines.length, text.split('\n').length,
          `the census's comment/literal stripper changed src/${f}'s line count — its counts and citations would no longer line up`);
        // Blank the import statement's own lines — naming a binding to import
        // it is not reaching the transport.
        const firstLine = text.slice(0, im.index).split('\n').length; // 1-based
        const lastLine = firstLine + im[0].split('\n').length - 1;
        for (let i = firstLine - 1; i < lastLine; i++) lines[i] = '';
        const body = lines.join('\n');
        const counts = {};
        for (const b of bindings) {
          // Not preceded by `.` or an identifier char (excludes `deps.run`),
          // not followed by `:` (excludes the `{ run: … }` option key).
          const re = new RegExp(`(?:^|[^.\\w$])${b.local}(?![\\w$])(?!\\s*:)`, 'gm');
          const n = (body.match(re) || []).length;
          if (n > 0) counts[b.imported] = n;
        }
        if (Object.keys(counts).length) found[f] = counts;
      }

      // (1) No UNLISTED file may reach the transport — the WARDEN-1348 shape.
      const unlisted = Object.keys(found).filter((f) => !(f in RAW_TRANSPORT_CENSUS)).sort();
      assert.deepStrictEqual(unlisted, [],
        `unlisted file(s) reach the raw ssh transport: ${unlisted.join(', ')} — a new remote op was built on raw ssh. ` +
        'Either ROUTE it onto the companion channel (gate it with isCompanionExcludedHost + deliverRemoteScript, and add its ON leg + OFF control to this sweep), ' +
        'or, if the raw path is genuinely deliberate, add a CITED row to RAW_TRANSPORT_CENSUS saying which class it is (core / gated toggle-off branch / named allow-list exception) and why.');

      // (2) Every mapped file matches its pinned per-binding counts exactly.
      for (const [f, expected] of Object.entries(RAW_TRANSPORT_CENSUS)) {
        assert.deepStrictEqual(found[f], expected,
          `raw-transport census moved in src/${f}: expected ${JSON.stringify(expected)}, found ${JSON.stringify(found[f] ?? {})}. ` +
          'A raw ssh call site was added or removed — re-derive the counts live (never trust the stored map), then re-triage: ' +
          'a GROWN count needs its new site cited in the comment above the row (and, if it is a new op family, an ON leg + OFF control in this sweep); ' +
          'a SHRUNK count means a raw path was routed or deleted — update the row and drop its stale citation.');
      }

      // (3) paneContainer.js specifically — its raw else-branch was present in
      // this slice's evidence but missing from the filed map, so it is pinned
      // by name: a census that silently loses a row is a census that lies.
      assert.deepStrictEqual(found['paneContainer.js'], { runWithPool: 1 },
        'paneContainer.js runWalk must keep exactly one raw runWithPool site (the else-branch of its gated ternary)');

      // (4) The transport core defines the six rather than importing them, so
      // it must never appear in this census at all. If ssh.js ever imports one
      // of its own exports from itself, the instrument's premise is broken.
      assert.ok(!('ssh.js' in found),
        'src/ssh.js appeared in the raw-transport census — it DEFINES the six remote-spawn exports (buildSshArgv/validateHost/run/runWithPool/attach/attachPty) and must not import them');
      const sshText = fs.readFileSync(path.join(srcDir, 'ssh.js'), 'utf8');
      for (const b of RAW_BINDINGS) {
        assert.ok(new RegExp(`^export\\s+(?:async\\s+)?function\\s+${b}\\b`, 'm').test(sshText),
          `src/ssh.js no longer exports ${b}() — the raw-transport census counts the wrong bindings; re-derive RAW_BINDINGS from ssh.js's remote-spawn exports`);
      }

      // (5) The instrument only sees files that IMPORT the six by name. Pin
      // that premise: a namespace import, a re-export or a dynamic import of
      // ssh.js would route around the census entirely.
      for (const f of files) {
        const text = fs.readFileSync(path.join(srcDir, f), 'utf8');
        assert.ok(!/import\s+\*\s+as\s+[\w$]+\s+from\s*['"]\.\/ssh\.js['"]/.test(text),
          `src/${f} takes a NAMESPACE import of ./ssh.js — the raw-transport census counts named bindings and cannot see ns.run(); import the bindings by name or teach the census`);
        assert.ok(!/export\s*(?:\*|\{[^}]*\})\s*from\s*['"]\.\/ssh\.js['"]/.test(text),
          `src/${f} RE-EXPORTS ./ssh.js — a consumer could reach the transport through it without importing ssh.js, which is invisible to this census`);
        assert.ok(!/import\s*\(\s*['"]\.\/ssh\.js['"]/.test(text),
          `src/${f} takes a DYNAMIC import of ./ssh.js — the raw-transport census reads static imports only`);
      }
    });

    it('the sweep was taught every method of the closed channel vocabulary (companion/main.go dispatch)', () => {
      // Live re-enumeration of the Go RPC vocabulary, so a new case in
      // companion/main.go forces this file (and CHANNEL_METHODS) to catch up
      // instead of the fake channel silently answering 'unknown method' only
      // when a leg happens to drive it.
      const goPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'companion', 'main.go');
      let go = '';
      try { go = fs.readFileSync(goPath, 'utf8'); } catch { assert.ok(false, `companion/main.go not found at ${goPath}`); }
      const cases = [...go.matchAll(/case "([^"]+)":/g)].map((m) => m[1]);
      assert.ok(cases.length >= CHANNEL_METHODS.length, `the Go vocabulary has ${cases.length} methods; CHANNEL_METHODS carries ${CHANNEL_METHODS.length}`);
      const missing = cases.filter((c) => !CHANNEL_METHODS.includes(c));
      assert.deepStrictEqual(missing, [],
        `companion/main.go grew RPC(s) not in CHANNEL_METHODS: ${missing.join(', ')} — extend the list and the fake responder, then teach the sweep the op's surface`);
    });
  });
});
