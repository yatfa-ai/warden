import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

// WARDEN-1861 — pins the HANDLER GLUE of createPaneRouter (src/paneRoutes.js,
// the seven pane I/O routes WARDEN-1849 extracted verbatim from server.js with
// no spec of its own): the resolve→404 mapping and the route's own `|| ''`
// id defaults, the parseInt line defaults (200 / 5000) threading into
// `tmux capture-pane -S`, the pane-export meta envelope (name→key→id fallback
// chain, container/session/project/role/kind ?? null, ISO timestamp), the
// send/key delivery argv + `{ok:true}` + 500 channels + ALLOWED_KEYS rejection,
// the paste-image 400-empty-body error string and both 500 channels, and the
// search-pane pipeline (400 query-required, key-AND-id matching across chats,
// id dedup, capturePanes attribution, case-insensitive match, line/text/
// context projection, empty and single-match guards, capture-failure degrade).
//
// A UNIT harness on a bare express() app — NOT another server.js import — for
// one structural reason (the finding this suite exists around): chats.js
// resolveChat('') substring-matches on `session.includes('')`, so with exactly
// one cached chat the EMPTY id RESOLVES to it. That is why real-server
// integration suites cannot kill the `req.query?.id || ''` default mutants
// (the mutated `''`→`'x'` still resolves); only a resolve seam that answers
// `''` and `'x'` differently pins the route's own default. So `resolve` is
// injected here with `''` → a named error and `'x'` → a DIFFERENT chat, and
// `cfg` / `chatCatalog` are injected the same way createPaneRouter takes them
// at server.js's mount point.
//
// The local tmux transport runs against a fake `tmux` shim prepended to PATH
// (the chatFileRoutes.test.js shim pattern): every invocation appends its argv
// to a log file (\\037-separated, so per-argument asserts are exact), a
// fail-target file forces exit-3 failures for a named `-t` target, and
// capture-pane answers a canned 6-line pane (leading blank line, a padded
// middle line, no trailing newline) with the target interpolated so per-chat
// attribution is provable from the captured text alone. HOME is frozen to a
// temp dir BEFORE the top-level import (module-freeze discipline, WARDEN-130)
// and the companion transport is deleted from the env so the default local
// path carries everything. The /api/pane-project walk arms prewarm the
// resolver's 5-minute TTL cache from injected-deps calls against tiny
// ps/pgrep shims (server-pane-project.test.js's own pattern), so no route
// request ever spawns a real walk; clearPaneContainerCache() in beforeEach
// keeps the shared module cache from leaking between cases.

const originalEnv = {
  HOME: process.env.HOME,
  PATH: process.env.PATH,
  COMPANION: process.env.WARDEN_COMPANION_TRANSPORT,
};

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-paneRoutes-'));
process.env.HOME = path.join(tmpRoot, 'home');
fs.mkdirSync(process.env.HOME, { recursive: true });
delete process.env.WARDEN_COMPANION_TRANSPORT;

const shimDir = path.join(tmpRoot, 'bin');
const logFile = path.join(shimDir, 'calls.log');
const failFile = path.join(shimDir, 'fail_target');
fs.mkdirSync(shimDir, { recursive: true });
fs.writeFileSync(logFile, '');

// The canned capture pane for target T — exactly 6 lines, NO trailing newline
// (so split('\n') yields 6 elements and the +2 context clamp at the last line
// is observable): a leading blank line (the before-context at the first match
// clamps to ''), an UPPERCASE needle line (matching it with a lowercase query
// is observable only through the route's line-side case folding), a padded
// middle match line (text/context trim is observable), and needle matches at
// indices 1, 2, 3 and 5.
const cannedPane = (t) =>
  `\n${t} needle-top\nFILLER ${t.toUpperCase()} NEEDLE mid\n  padded ${t} needle  \nfiller ${t} low\n${t} needle-end`;

// Every invocation appends ONE line: the argv joined with \037 (unit separator,
// never in the payloads below), so calls() can recover the exact argv array.
// Fail targets are matched on the value after `-t`; a match exits 3 with no
// output, which is what makes the handlers surface `… failed (exit 3)`.
const TMUX_SHIM = `#!/bin/bash
printf -v line '%s\\037' "$@"
printf '%s\\n' "$line" >> "${logFile}"
target=""
prev=""
for a in "$@"; do
  if [ "$prev" = "-t" ]; then target="$a"; fi
  prev="$a"
done
if [ -f "${failFile}" ] && grep -qxF "$target" "${failFile}" 2>/dev/null; then exit 3; fi
case "$1" in
  capture-pane)
    printf '\\n%s needle-top\\nFILLER %s NEEDLE mid\\n  padded %s needle  \\nfiller %s low\\n%s needle-end' "$target" "\${target^^}" "$target" "$target" "$target"
    ;;
  display-message) echo 100 ;;
  *) exit 0 ;;
esac
`;
fs.writeFileSync(path.join(shimDir, 'tmux'), TMUX_SHIM);
fs.chmodSync(path.join(shimDir, 'tmux'), 0o755);
process.env.PATH = `${shimDir}${path.delimiter}${process.env.PATH}`;

const { createPaneRouter } = await import('./paneRoutes.js');
const { resolvePaneContainer, clearPaneContainerCache } = await import('./paneContainer.js');

const LOCAL = '(local)';
const calls = () => fs.readFileSync(logFile, 'utf8')
  .split('\n').filter((line) => line.length > 0)
  .map((line) => line.split('\x1f').slice(0, -1));
const clearLog = () => fs.writeFileSync(logFile, '');
const setFailTarget = (t) => fs.writeFileSync(failFile, `${t}\n`);
const clearFailTarget = () => { try { fs.rmSync(failFile, { force: true }); } catch { /* best-effort */ } };

// The chat catalogue the injected resolve serves and chatCatalog.snapshot()
// returns. Shapes mirror the product's chats (id `${host}:${name}`, key, host,
// session, container, project, role, kind); explicit nulls so JSON envelopes
// can be deep-equality asserted without undefined-vs-missing noise.
const CHATS = {
  alpha: { id: `${LOCAL}:alpha`, key: 'alpha', host: LOCAL, name: 'alpha', session: 'alpha', container: null, project: 'proj-a', role: 'planner', kind: 'tmux' },
  // no name: pane-export meta.name and search rows must fall back to the key.
  paneb: { id: `${LOCAL}:paneb`, key: 'paneb', host: LOCAL, name: null, session: 'paneb', container: null, project: null, role: null, kind: null },
  // container-bearing yatfa chat — LOCAL with a container so its pane is
  // capturable by the shim: the /api/pane-project "known" arm, and a non-null
  // container for the export meta.
  yatfa: { id: `${LOCAL}:planner`, key: 'yatfa-planner-2', host: LOCAL, name: 'planner', session: 'agent', container: 'yatfa-planner-2', project: 'yatfa-planner', role: 'planner', kind: 'yatfa' },
  // a SECOND chat whose id is 'alpha': the key-AND-id double match in search.
  idalpha: { id: 'alpha', key: 'idalpha', host: LOCAL, name: 'idalpha', session: 'idalpha', container: null, project: 'proj-b', role: null, kind: null },
  // no name AND empty key: meta.name must fall through to the id.
  idonly: { id: 'idonly', key: '', host: LOCAL, name: null, session: 'idonly', container: null, project: null, role: null, kind: null },
  // resolvable as 'x': makes the routes' `|| ''` id DEFAULT observable — the
  // mutated default would resolve this chat instead of erroring.
  x: { id: 'x', key: 'x', host: LOCAL, name: 'x', session: 'x', container: null, project: null, role: null, kind: null },
  // container-less local chat for the /api/pane-project resolved-walk arm.
  walks: { id: `${LOCAL}:walks`, key: 'walks', host: LOCAL, name: 'walks', session: 'walks', container: null, project: 'local', role: null, kind: null },
};
const CATALOG = [CHATS.alpha, CHATS.paneb, CHATS.yatfa, CHATS.idalpha, CHATS.idonly, CHATS.x, CHATS.walks];

// A LOCAL chat that already carries a container: the paste-image delivery leg
// that docker-execs (its failure channel is deterministic with or without a
// docker binary). Deliberately NOT in the search catalogue.
const CHAT_LOCALBOX = { id: 'localbox', key: 'localbox', host: LOCAL, name: 'localbox', session: 'localbox', container: 'definitely-missing-box', project: null, role: null, kind: null };

const RESOLVABLE = new Map([
  ['alpha', CHATS.alpha], [`${LOCAL}:alpha`, CHATS.alpha],
  ['paneb', CHATS.paneb], [`${LOCAL}:paneb`, CHATS.paneb],
  ['yatfa-planner-2', CHATS.yatfa], [`${LOCAL}:planner`, CHATS.yatfa],
  ['idalpha', CHATS.idalpha],
  ['idonly', CHATS.idonly],
  ['x', CHATS.x],
  ['walks', CHATS.walks], [`${LOCAL}:walks`, CHATS.walks],
  ['localbox', CHAT_LOCALBOX],
]);

let cfg = {}; // the LIVE object the router closed over at mount (server.js's cfg is mutated in place, never reassigned)
let resolveCalls;
const resolve = async (id) => {
  resolveCalls += 1;
  if (id === '') return { error: 'no chat ""' };
  const chat = RESOLVABLE.get(id);
  return chat ? { chat } : { error: `no chat "${id}"` };
};
const chatCatalog = { snapshot: () => CATALOG };

// The walk fakes for /api/pane-project's resolver prewarm (server-pane-project
// pattern): the real walk script runs under sh against these, so the seeded
// TTL-cache entry is an HONEST resolution, not a fabricated one.
function installWalkFakes({ tree = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-paneRoutes-walk-'));
  fs.writeFileSync(path.join(dir, 'tmux'), '#!/bin/sh\necho 100\n');
  const psCases = tree
    ? '  100) printf \'Ss   bash\\n\' ;;\n' +
      '  101) printf \'S+   zsh\\n\' ;;\n' +
      '  102) printf \'S+   docker exec -it -u yatfa yatfa-planner-2 tmux attach -t agent\\n\' ;;\n'
    : '  100) printf \'Ss   bash\\n\' ;;\n';
  fs.writeFileSync(path.join(dir, 'ps'), '#!/bin/sh\ncase "$2" in\n' + psCases + '  *) exit 3 ;;\nesac\n');
  const pgrepCases = tree ? '  100) echo 101 ;;\n  101) echo 102 ;;\n' : '';
  fs.writeFileSync(path.join(dir, 'pgrep'), '#!/bin/sh\ncase "$2" in\n' + pgrepCases + '  *) exit 1 ;;\nesac\n');
  for (const b of ['tmux', 'ps', 'pgrep']) fs.chmodSync(path.join(dir, b), 0o755);
  return dir;
}

// Seed the resolver's module-level TTL cache for one `(local)|<session>` pane
// so the route's own resolvePaneContainer call is served from the cache and
// never spawns a walk mid-request.
async function prewarmWalk(session, { tree = true } = {}) {
  const dir = installWalkFakes({ tree });
  const prevPath = process.env.PATH;
  process.env.PATH = `${dir}${path.delimiter}${prevPath}`;
  try {
    clearPaneContainerCache();
    return await resolvePaneContainer({ host: LOCAL, session }, {}, {});
  } finally {
    process.env.PATH = prevPath;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

let server;
let baseUrl;

before(async () => {
  const app = express();
  app.use(express.json({ limit: '1mb' })); // the global parser server.js mounts
  app.use(createPaneRouter({ cfg, resolve, chatCatalog }));
  await new Promise((resolveListen, rejectListen) => {
    server = app.listen(0, '127.0.0.1');
    server.once('listening', resolveListen);
    server.once('error', rejectListen);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((r) => server.close(r));
  clearFailTarget();
  clearPaneContainerCache();
  process.env.PATH = originalEnv.PATH;
  process.env.HOME = originalEnv.HOME;
  if (originalEnv.COMPANION === undefined) delete process.env.WARDEN_COMPANION_TRANSPORT;
  else process.env.WARDEN_COMPANION_TRANSPORT = originalEnv.COMPANION;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

beforeEach(() => {
  delete cfg.issueLinksEnabled;
  resolveCalls = 0;
  clearLog();
  clearPaneContainerCache();
});

const get = async (route) => {
  const res = await fetch(`${baseUrl}${route}`);
  return { status: res.status, body: await res.json() };
};
const postJson = async (route, body) => {
  const res = await fetch(`${baseUrl}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
};
const postRaw = async (route, buf, contentType) => {
  const res = await fetch(`${baseUrl}${route}`, {
    method: 'POST',
    headers: { 'content-type': contentType },
    body: buf,
  });
  return { status: res.status, body: await res.json() };
};

// A real 1×1 PNG, byte for byte (the paste-image-http.test.js fixture), so the
// server's header sniffing names format PNG with real 1×1 dimensions.
const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

describe('GET /api/pane', () => {
  it('a missing id resolves the route\u2019s own "" default \u2192 404 with the resolver body, never reaching tmux', async () => {
    const r = await get('/api/pane');
    assert.equal(r.status, 404);
    assert.deepEqual(r.body, { error: 'no chat ""' });
    assert.deepEqual(calls(), []);
  });

  it('the default capture reads 200 lines through `-S -200` for the resolved chat', async () => {
    const r = await get('/api/pane?id=alpha');
    assert.equal(r.status, 200);
    assert.equal(r.body.pane, cannedPane('alpha'));
    assert.deepEqual(calls(), [['capture-pane', '-t', 'alpha', '-p', '-e', '-S', '-200', '-E', '-']]);
  });

  it('?lines=7 threads the requested depth into `-S -7`', async () => {
    const r = await get('/api/pane?id=alpha&lines=7');
    assert.equal(r.status, 200);
    assert.deepEqual(calls()[0][6], '-7');
  });

  it('a failing capture is a 500 carrying the transport\u2019s `read failed (exit 3)`', async () => {
    setFailTarget('alpha');
    try {
      const r = await get('/api/pane?id=alpha');
      assert.equal(r.status, 500);
      assert.deepEqual(r.body, { error: 'read failed (exit 3)' });
    } finally {
      clearFailTarget();
    }
  });
});

describe('GET /api/pane-export', () => {
  it('defaults to a 5000-line capture through `-S -5000`', async () => {
    const r = await get('/api/pane-export?id=alpha');
    assert.equal(r.status, 200);
    assert.deepEqual(calls()[0][6], '-5000');
  });

  it('?lines=9 threads through `-S -9`', async () => {
    const r = await get('/api/pane-export?id=alpha&lines=9');
    assert.equal(r.status, 200);
    assert.deepEqual(calls()[0][6], '-9');
  });

  it('the envelope carries the pane plus the full meta block with an ISO timestamp', async () => {
    const r = await get('/api/pane-export?id=alpha');
    assert.equal(r.status, 200);
    assert.equal(r.body.pane, cannedPane('alpha'));
    assert.equal(Number.isNaN(Date.parse(r.body.meta.timestamp)), false, 'meta.timestamp must parse as a date');
    assert.deepEqual(
      { ...r.body.meta, timestamp: undefined },
      {
        name: 'alpha',
        host: LOCAL,
        container: null,
        session: 'alpha',
        project: 'proj-a',
        role: 'planner',
        kind: 'tmux',
        timestamp: undefined,
      },
    );
  });

  it('a container-bearing chat\u2019s container travels verbatim in meta', async () => {
    const r = await get('/api/pane-export?id=yatfa-planner-2');
    assert.equal(r.status, 200);
    assert.equal(r.body.meta.container, 'yatfa-planner-2');
    assert.equal(r.body.meta.host, LOCAL);
    assert.equal(r.body.meta.project, 'yatfa-planner');
  });

  it('meta.name falls back to the key for a chat with no name', async () => {
    const r = await get('/api/pane-export?id=paneb');
    assert.equal(r.status, 200);
    assert.equal(r.body.meta.name, 'paneb');
    assert.equal(r.body.meta.session, 'paneb');
  });

  it('meta.name falls through to the id when the name AND the key are missing', async () => {
    const r = await get('/api/pane-export?id=idonly');
    assert.equal(r.status, 200);
    assert.equal(r.body.meta.name, 'idonly');
    assert.equal(r.body.meta.container, null);
    assert.equal(r.body.meta.kind, null);
  });

  it('an unknown id is a 404 with the resolver body', async () => {
    const r = await get('/api/pane-export');
    assert.equal(r.status, 404);
    assert.deepEqual(r.body, { error: 'no chat ""' });
  });

  it('a failing capture is a 500 JSON error, not a raw transport body', async () => {
    setFailTarget('alpha');
    try {
      const r = await get('/api/pane-export?id=alpha');
      assert.equal(r.status, 500);
      assert.deepEqual(r.body, { error: 'read failed (exit 3)' });
    } finally {
      clearFailTarget();
    }
  });
});

describe('GET /api/pane-project', () => {
  it('answers { state: "disabled" } with the gate off — without resolving the id at all', async () => {
    const r = await get('/api/pane-project?id=yatfa-planner-2');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { state: 'disabled' });
    assert.equal(resolveCalls, 0, 'the off gate must answer before any resolve');
  });

  it('with the gate on, an unknown id is a 404 with the resolver body', async () => {
    cfg.issueLinksEnabled = true;
    const r = await get('/api/pane-project?id=nobody');
    assert.equal(r.status, 404);
    assert.deepEqual(r.body, { error: 'no chat "nobody"' });
  });

  it('a container-bearing chat answers { state: "known", project } from its own project, with no walk', async () => {
    cfg.issueLinksEnabled = true;
    const r = await get('/api/pane-project?id=yatfa-planner-2');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { state: 'known', project: 'yatfa-planner' });
  });

  it('a container-less chat whose walk resolved answers { state: "resolved", project, container }', async () => {
    cfg.issueLinksEnabled = true;
    const warm = await prewarmWalk('walks', { tree: true });
    assert.deepEqual(warm, { state: 'resolved', container: 'yatfa-planner-2' });
    const r = await get('/api/pane-project?id=walks');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { state: 'resolved', project: 'yatfa-planner', container: 'yatfa-planner-2' });
  });
});

describe('POST /api/send', () => {
  it('a missing id resolves the "" default \u2192 404 with the resolver body', async () => {
    const res = await fetch(`${baseUrl}/api/send`, { method: 'POST' });
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: 'no chat ""' });
  });

  it('delivers the body text with `send-keys -l` then a separate Enter, answering { ok: true }', async () => {
    const r = await postJson('/api/send', { id: 'alpha', text: 'say hi' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { ok: true });
    assert.deepEqual(calls(), [
      ['send-keys', '-t', 'alpha', '-l', 'say hi'],
      ['send-keys', '-t', 'alpha', 'Enter'],
    ]);
  });

  it('a missing text field delivers the empty string', async () => {
    const r = await postJson('/api/send', { id: 'alpha' });
    assert.equal(r.status, 200);
    assert.deepEqual(calls()[0], ['send-keys', '-t', 'alpha', '-l', '']);
  });

  it('a failing delivery is a 500 carrying the transport\u2019s `send failed (exit 3)`', async () => {
    setFailTarget('alpha');
    try {
      const r = await postJson('/api/send', { id: 'alpha', text: 'hello' });
      assert.equal(r.status, 500);
      assert.deepEqual(r.body, { error: 'send failed (exit 3)' });
    } finally {
      clearFailTarget();
    }
  });
});

describe('POST /api/key', () => {
  it('a missing id resolves the "" default \u2192 404 with the resolver body', async () => {
    const res = await fetch(`${baseUrl}/api/key`, { method: 'POST' });
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: 'no chat ""' });
  });

  it('sends an allowed key verbatim with `send-keys` and answers { ok: true }', async () => {
    const r = await postJson('/api/key', { id: 'alpha', key: 'Enter' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { ok: true });
    assert.deepEqual(calls(), [['send-keys', '-t', 'alpha', 'Enter']]);
  });

  it('a missing key is rejected with `unsupported key ""` and never reaches tmux', async () => {
    const r = await postJson('/api/key', { id: 'alpha' });
    assert.equal(r.status, 500);
    assert.ok(r.body.error.startsWith('unsupported key ""'), r.body.error);
    assert.deepEqual(calls(), []);
  });

  it('a disallowed key name surfaces verbatim in the rejection message', async () => {
    const r = await postJson('/api/key', { id: 'alpha', key: 'nope' });
    assert.equal(r.status, 500);
    assert.ok(r.body.error.startsWith('unsupported key "nope"'), r.body.error);
  });

  it('a failing send-keys is a 500 carrying the transport\u2019s `key failed (exit 3)`', async () => {
    setFailTarget('alpha');
    try {
      const r = await postJson('/api/key', { id: 'alpha', key: 'C-c' });
      assert.equal(r.status, 500);
      assert.deepEqual(r.body, { error: 'key failed (exit 3)' });
    } finally {
      clearFailTarget();
    }
  });
});

describe('POST /api/paste-image', () => {
  it('an unknown pane id is a 404', async () => {
    const r = await postRaw('/api/paste-image?id=no-such-pane', PNG_1x1, 'image/png');
    assert.equal(r.status, 404);
  });

  it('delivers the bytes to the local paste dir answering { ok, path, marker } — the id rides the QUERY string', async () => {
    // Prewarm the pane's tree walk to an honest `none` so the delivery takes
    // the host-write leg deterministically (a live walk against this sandbox's
    // real ps tree could theoretically resolve a container and docker-exec).
    const warm = await prewarmWalk('alpha', { tree: false });
    assert.deepEqual(warm, { state: 'none' });
    const r = await postRaw('/api/paste-image?id=alpha', PNG_1x1, 'image/png');
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.ok(r.body.path.startsWith('/tmp/warden/paste/paste-'), r.body.path);
    assert.ok(r.body.path.endsWith('.png'), r.body.path);
    assert.equal(fs.existsSync(r.body.path), true, 'the delivered file must exist');
    assert.equal(fs.readFileSync(r.body.path).equals(PNG_1x1), true, 'delivered bytes must equal the posted image');
    assert.equal(r.body.marker, `[pasted image \u2192 ${r.body.path} (PNG 1\u00d71)]`);
  });

  it('a body that never became a Buffer (json content-type) is a 400 `empty image body`', async () => {
    // express.json (mounted globally) parses application/json bodies first, so
    // the route's raw parser never runs and req.body arrives as a plain object.
    const res = await fetch(`${baseUrl}/api/paste-image?id=alpha`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ not: 'an image' }),
    });
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: 'empty image body' });
  });

  it('an unwritable destination is a 500 carrying the write error', async () => {
    await prewarmWalk('alpha', { tree: false });
    const pasteDir = '/tmp/warden/paste';
    const backup = `${pasteDir}.paneRoutes-bak-${process.pid}`;
    let renamed = false;
    try {
      // Swap the paste DIRECTORY for a regular file so mkdir/write fail
      // deterministically, then put the directory back (kept as short as
      // possible — the paste-image-http suite shares this path).
      if (fs.existsSync(pasteDir)) { fs.renameSync(pasteDir, backup); renamed = true; }
      fs.writeFileSync(pasteDir, 'a regular file, not the paste directory');
      const r = await postRaw('/api/paste-image?id=alpha', PNG_1x1, 'image/png');
      assert.equal(r.status, 500);
      assert.ok(r.body.error.startsWith('write failed: '), `expected the write-failure channel, got: ${r.body.error}`);
    } finally {
      fs.rmSync(pasteDir, { force: true });
      if (renamed) fs.renameSync(backup, pasteDir);
    }
  });

  it('a local container chat whose docker delivery fails is a 500 carrying the delivery error', async () => {
    // A chat that already carries a container bypasses the walk and the host
    // write: the bytes must go through `docker exec` to the container. With no
    // docker binary the spawn fails; with one, the container name is refused —
    // either way the route maps deliverPastedImage's ok:false to a 500.
    const r = await postRaw('/api/paste-image?id=localbox', PNG_1x1, 'image/png');
    assert.equal(r.status, 500);
    assert.equal(typeof r.body.error, 'string');
    assert.ok(r.body.error.length > 0);
  });
});

describe('GET /api/search-pane', () => {
  it('a missing query is a 400 `query required`', async () => {
    const r = await get('/api/search-pane');
    assert.equal(r.status, 400);
    assert.deepEqual(r.body, { error: 'query required' });
  });

  it('a whitespace-only query is a 400 — trim happens before the emptiness check', async () => {
    const r = await get(`/api/search-pane?query=${encodeURIComponent('   ')}`);
    assert.equal(r.status, 400);
    assert.deepEqual(r.body, { error: 'query required' });
  });

  it('no panes parameter searches nothing — results: [] with the query echoed, zero captures', async () => {
    const r = await get('/api/search-pane?query=needle');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { results: [], query: 'needle' });
    assert.deepEqual(calls(), []);
  });

  it('a panes value matching no chat searches nothing — results: []', async () => {
    const r = await get('/api/search-pane?query=needle&panes=no-such-key');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { results: [], query: 'needle' });
    assert.deepEqual(calls(), []);
  });

  it('a key matching one chat\u2019s key AND another chat\u2019s id searches BOTH panes, attributed per chat, case-insensitively', async () => {
    // 'alpha' is CHATS.alpha's KEY and CHATS.idalpha's ID; each pane's canned
    // capture interpolates its own tmux target, so the rows' text proves the
    // attribution. The uppercase query pins the query-side case folding; the
    // canned pane's UPPERCASE needle line pins the line-side folding.
    const r = await get('/api/search-pane?query=NEEDLE&panes=alpha');
    assert.equal(r.status, 200);
    assert.equal(r.body.query, 'NEEDLE');
    assert.equal(r.body.results.length, 8);
    const alphaRows = r.body.results.filter((row) => row.name === 'alpha');
    const idalphaRows = r.body.results.filter((row) => row.name === 'idalpha');
    assert.equal(alphaRows.length, 4);
    assert.equal(idalphaRows.length, 4);
    assert.deepEqual(alphaRows.map((row) => row.line).sort(), [1, 2, 3, 5]);
    assert.deepEqual(idalphaRows.map((row) => row.line).sort(), [1, 2, 3, 5]);
    assert.ok(alphaRows.every((row) => row.key === 'alpha' && row.host === LOCAL));
    assert.ok(idalphaRows.every((row) => row.key === 'idalpha' && row.host === LOCAL));
    // Every row's text comes from ITS OWN chat's capture — provable because the
    // two panes' canned texts (target interpolated) are disjoint.
    const textsOf = (t) => new Set(cannedPane(t).split('\n').map((l) => l.trim()));
    const alphaTexts = textsOf('alpha');
    const idalphaTexts = textsOf('idalpha');
    assert.ok(alphaRows.every((row) => alphaTexts.has(row.text) && !idalphaTexts.has(row.text)));
    assert.ok(idalphaRows.every((row) => idalphaTexts.has(row.text) && !alphaTexts.has(row.text)));
  });

  it('rows project trimmed text with the \u00b12 context windows and edge clamping', async () => {
    const r = await get(`/api/search-pane?query=${encodeURIComponent(' needle ')}&panes=alpha`);
    assert.equal(r.status, 200);
    assert.equal(r.body.query, 'needle', 'the echoed query is the trimmed one');
    // Both catalog chats match the 'alpha' key (CHATS.alpha by key, idalpha by
    // id), so both panes are searched: 4 needle lines each. An untrimmed query
    // (' needle ') would match only the padded and uppercase lines — 4 rows.
    assert.equal(r.body.results.length, 8, 'the padded query still matches every needle line per pane');
    const at = (line) => r.body.results.find((row) => row.line === line && row.name === 'alpha');
    assert.deepEqual(
      { text: at(1).text, before: at(1).context.before, after: at(1).context.after },
      { text: 'alpha needle-top', before: '', after: 'padded alpha needle' },
      'the first match\u2019s before-context clamps to the leading blank line',
    );
    assert.deepEqual(
      { text: at(3).text, before: at(3).context.before, after: at(3).context.after },
      { text: 'padded alpha needle', before: 'alpha needle-top', after: 'alpha needle-end' },
      'the middle match reads two lines up (not 0, not 1, not 3) and two down',
    );
    assert.deepEqual(
      { text: at(5).text, before: at(5).context.before, after: at(5).context.after },
      { text: 'alpha needle-end', before: 'padded alpha needle', after: 'alpha needle-end' },
      'the last match\u2019s after-context clamps to the final line (itself)',
    );
  });

  it('a single-key match still returns rows — naming a nameless chat from its key', async () => {
    const r = await get('/api/search-pane?query=needle&panes=paneb');
    assert.equal(r.status, 200);
    assert.equal(r.body.results.length, 4);
    assert.ok(r.body.results.every((row) => row.name === 'paneb' && row.key === 'paneb' && row.host === LOCAL));
  });

  it('a failed capture degrades to 200 with that pane omitted from the results', async () => {
    setFailTarget('alpha');
    try {
      const r = await get('/api/search-pane?query=needle&panes=alpha');
      assert.equal(r.status, 200);
      assert.equal(r.body.results.length, 4, 'only the healthy pane\u2019s matches survive');
      assert.ok(r.body.results.every((row) => row.name === 'idalpha'));
    } finally {
      clearFailTarget();
    }
  });

  it('multiple panes keys union every matching chat', async () => {
    const r = await get('/api/search-pane?query=needle&panes=alpha,paneb');
    assert.equal(r.status, 200);
    // 'alpha' matches two chats (key + id), 'paneb' one more: 4 rows each.
    assert.equal(r.body.results.length, 12);
    assert.deepEqual(
      [...new Set(r.body.results.map((row) => row.name))].sort(),
      ['alpha', 'idalpha', 'paneb'],
    );
  });
});
