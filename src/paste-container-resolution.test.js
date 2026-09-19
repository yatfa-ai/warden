import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildPaneTreeWalkScript,
  parseTreeWalkOutput,
  extractDockerExecContainer,
  resolveContainerFromTree,
  resolvePaneContainer,
  clearPaneContainerCache,
  projectFromContainerResolution,
  MAX_TREE_DEPTH,
  RESOLUTION_TTL_MS,
  WALK_TIMEOUT_MS,
} from './paneContainer.js';
import { deliverPastedImage, buildMarker, buildPasteSshArgv, buildContainerExecArgv, describeImage, PASTE_DIR } from './pasteImage.js';

/**
 * WARDEN-1377 — resolving a paste's container from the pane's OWN process tree.
 *
 * A manual tmux pane whose user docker-exec-attached into an agent container
 * carries no `container` on the chat, so a pasted image used to land on the ssh
 * host and the marker named a path the in-container agent could never read.
 *
 * WHY THIS SUITE IS SHAPED THIS WAY. The walk runs on the user's macOS host —
 * a machine this sandbox does not have — so the script builder, the output
 * parser, the boundary detector, and the decision rule are pure and exported,
 * pinned byte-exactly (the buildReceiveScript precedent, WARDEN-1282). The
 * script's control flow itself IS executed here, under the system's real `sh`,
 * against fake `tmux`/`ps`/`pgrep` binaries on PATH — including the observed
 * two-level-deep boundary (`bash → zsh → docker exec -it -u yatfa …`) the
 * user-verified mechanism produced. Delivery-leg integration pins the routing
 * and the honest fallback marker with the resolver injected.
 */

// The observed attach command from the user's host (2026-09-14): flags BEFORE
// the container, boundary two levels below the pane's root process.
const OBSERVED_ATTACH = 'docker exec -it -u yatfa yatfa-planner-2 tmux attach -t agent';

const WALK_SCRIPT_AGENT =
  `pid=$(tmux display-message -p -t 'agent' '#{pane_pid}' 2>/dev/null | tr -d ' \\t\\r\\n')\n` +
  `[ -n "$pid" ] || exit 0\n` +
  `front=$pid\n` +
  `depth=0\n` +
  `while [ "$depth" -le 4 ]; do\n` +
  `next=""\n` +
  `for p in $front; do\n` +
  `line=$(ps -p "$p" -o stat=,command= 2>/dev/null)\n` +
  `[ -n "$line" ] && printf '%s\\t%s\\t%s\\n' "$depth" "$p" "$line"\n` +
  `kids=$(pgrep -P "$p" 2>/dev/null | tr '\\n' ' ')\n` +
  `next="$next $kids"\n` +
  `done\n` +
  `front=$next\n` +
  `depth=$((depth + 1))\n` +
  `done`;

describe('buildPaneTreeWalkScript — one host-side script per resolution', () => {
  it('reads the pane pid, then walks descendants level by level — byte-exact', () => {
    assert.equal(buildPaneTreeWalkScript('agent'), WALK_SCRIPT_AGENT);
  });

  it('quotes the tmux target, so a hostile session name stays an argument', () => {
    const s = buildPaneTreeWalkScript("ag; rm -rf /'ent");
    assert.ok(s.includes("-t 'ag; rm -rf /'\\''ent'"), s.split('\n')[0]);
  });

  it('is bounded — the loop stops at MAX_TREE_DEPTH, it is not an unbounded climb', () => {
    assert.ok(WALK_SCRIPT_AGENT.includes(`-le ${MAX_TREE_DEPTH}`));
    assert.ok(buildPaneTreeWalkScript('agent', 1).includes('-le 1'));
  });
});

describe('the walk script runs under real sh (fake tmux/ps/pgrep on PATH)', () => {
  // The observed tree, two levels deep, exactly as the user's host resolved it:
  // pane root bash (100) → zsh (101) → docker exec boundary (102).
  function installFakes({ panePid = '100', tree = true } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-walkbin-'));
    fs.writeFileSync(path.join(dir, 'tmux'), `#!/bin/sh\necho ${JSON.stringify(panePid)}\n`);
    fs.writeFileSync(
      path.join(dir, 'ps'),
      '#!/bin/sh\ncase "$2" in\n' +
        (tree
          ? '  100) printf \'Ss   bash\\n\' ;;\n' +
            '  101) printf \'S+   zsh\\n\' ;;\n' +
            `  102) printf 'S+   ${OBSERVED_ATTACH}\\n' ;;\n` +
            '  *) exit 3 ;;\n'
          : '  *) exit 3 ;;\n') +
        'esac\n',
    );
    fs.writeFileSync(
      path.join(dir, 'pgrep'),
      '#!/bin/sh\ncase "$2" in\n' +
        (tree ? '  100) echo 101 ;;\n  101) echo 102 ;;\n' : '') +
        '  *) exit 1 ;;\nesac\n',
    );
    for (const b of ['tmux', 'ps', 'pgrep']) fs.chmodSync(path.join(dir, b), 0o755);
    return dir;
  }

  function runScript(script, binDir) {
    return spawnSync('sh', ['-c', script], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` },
    });
  }

  it('the observed two-level-deep boundary resolves to its own container', () => {
    const dir = installFakes();
    try {
      const r = runScript(buildPaneTreeWalkScript('agent'), dir);
      assert.equal(r.status, 0);
      const resolution = resolveContainerFromTree(parseTreeWalkOutput(r.stdout));
      assert.deepStrictEqual(resolution, { state: 'resolved', container: 'yatfa-planner-2' });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a dead pane (display-message yields nothing) exits 0 with NO output — an honest none', () => {
    const dir = installFakes({ panePid: '', tree: false });
    try {
      const r = runScript(buildPaneTreeWalkScript('agent'), dir);
      assert.equal(r.status, 0);
      assert.equal(r.stdout, '');
      assert.deepStrictEqual(resolveContainerFromTree(parseTreeWalkOutput(r.stdout)), { state: 'none' });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a live pane with NO docker exec anywhere is also an honest none (agent is host-side)', () => {
    const dir = installFakes({ tree: false, panePid: '100' });
    try {
      const r = runScript(buildPaneTreeWalkScript('agent'), dir);
      assert.equal(r.status, 0);
      assert.deepStrictEqual(resolveContainerFromTree(parseTreeWalkOutput(r.stdout)), { state: 'none' });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('parseTreeWalkOutput — depth<TAB>pid<TAB><ps output>, nothing else trusted', () => {
  it('parses depth, pid, stat, command — tolerating ps header-width padding on stat', () => {
    assert.deepStrictEqual(parseTreeWalkOutput('0\t100\tSs   bash\n'), [
      { depth: 0, pid: 100, stat: 'Ss', command: 'bash' },
    ]);
  });

  it('keeps the whole command verbatim, flags and all', () => {
    const [node] = parseTreeWalkOutput(`2\t102\tS+   ${OBSERVED_ATTACH}\n`);
    assert.equal(node.command, OBSERVED_ATTACH);
  });

  it('skips blank and garbage lines instead of throwing', () => {
    assert.deepStrictEqual(
      parseTreeWalkOutput('\nnot a walk line\n7\tabc\tSs\tnope\n0\t100\tSs\tkeep\n'),
      [{ depth: 0, pid: 100, stat: 'Ss', command: 'keep' }],
    );
  });

  it('a stat with no command (a zombie) still parses, with an empty command', () => {
    assert.deepStrictEqual(parseTreeWalkOutput('1\t101\tZs\n'), [
      { depth: 1, pid: 101, stat: 'Zs', command: '' },
    ]);
  });

  it('empty or null input parses to no nodes', () => {
    assert.deepStrictEqual(parseTreeWalkOutput(''), []);
    assert.deepStrictEqual(parseTreeWalkOutput(null), []);
  });
});

describe('extractDockerExecContainer — the boundary detector, fail-closed', () => {
  it('reads the OBSERVED flags-before-container shape (`-it -u yatfa`)', () => {
    assert.equal(extractDockerExecContainer(OBSERVED_ATTACH), 'yatfa-planner-2');
  });

  it('reads the plain shape with no flags', () => {
    assert.equal(extractDockerExecContainer('docker exec yatfa-planner-2 tmux attach -t agent'), 'yatfa-planner-2');
  });

  it('combined short clusters: the trailing value-taking char consumes the next token', () => {
    assert.equal(extractDockerExecContainer('docker exec -itu yatfa c2 bash'), 'c2');
    assert.equal(extractDockerExecContainer('docker exec -iu yatfa c2 bash'), 'c2');
  });

  it('long flags with and without embedded `=`', () => {
    assert.equal(extractDockerExecContainer('docker exec --user yatfa c3 zsh'), 'c3');
    assert.equal(extractDockerExecContainer('docker exec --user=yatfa c3 zsh'), 'c3');
  });

  it('other value-taking flags (-e/-w and friends) do not swallow the container', () => {
    assert.equal(extractDockerExecContainer('docker exec -e FOO=bar -w /srv c4 bash'), 'c4');
    assert.equal(extractDockerExecContainer('docker exec --env PATH=/usr/bin c4 bash'), 'c4');
  });

  it('valueless flags (-d, -t, -i in any order) skip cleanly', () => {
    assert.equal(extractDockerExecContainer('docker exec -d c5 sleep infinity'), 'c5');
    assert.equal(extractDockerExecContainer('docker exec -t -i -u yatfa c5 zsh'), 'c5');
  });

  it('a path-prefixed docker binary and a leading sudo still resolve', () => {
    assert.equal(extractDockerExecContainer('/usr/local/bin/docker exec c6 tmux a'), 'c6');
    assert.equal(extractDockerExecContainer(`sudo docker exec c7 tmux a`), 'c7');
    assert.equal(extractDockerExecContainer('doas docker exec c8 tmux a'), 'c8');
  });

  it('non-exec docker commands are not boundaries', () => {
    assert.equal(extractDockerExecContainer('docker run -it c bash'), null);
    assert.equal(extractDockerExecContainer('docker ps'), null);
    assert.equal(extractDockerExecContainer('docker exec'), null);
  });

  it('non-docker and empty command lines are not boundaries', () => {
    assert.equal(extractDockerExecContainer('zsh'), null);
    assert.equal(extractDockerExecContainer('podman exec c bash'), null);
    assert.equal(extractDockerExecContainer(''), null);
    assert.equal(extractDockerExecContainer(null), null);
  });

  it('a charset-invalid token fails CLOSED — a misparse must never pick a container', () => {
    assert.equal(extractDockerExecContainer('docker exec * c bash'), null);
    assert.equal(extractDockerExecContainer('docker exec "a b" bash'), null); // argv has no quotes; the space already split it
  });
});

describe('resolveContainerFromTree — the pane\u2019s current foreground chain decides', () => {
  const node = (depth, pid, stat, command) => ({ depth, pid, stat, command });

  it('no nodes, or no docker exec anywhere → none (agent is host-side)', () => {
    assert.deepStrictEqual(resolveContainerFromTree([]), { state: 'none' });
    assert.deepStrictEqual(resolveContainerFromTree([node(0, 1, 'Ss', 'bash'), node(1, 2, 'S+', 'claude')]), { state: 'none' });
  });

  it('exactly one boundary → resolved, whatever its depth', () => {
    assert.deepStrictEqual(
      resolveContainerFromTree([node(0, 1, 'Ss', 'bash'), node(2, 3, 'S+', OBSERVED_ATTACH)]),
      { state: 'resolved', container: 'yatfa-planner-2' },
    );
  });

  it('the deepest chain wins over a shallower leftover', () => {
    const r = resolveContainerFromTree([
      node(1, 2, 'S', 'docker exec cShallow tmux a'),
      node(2, 3, 'S+', 'docker exec cDeep tmux a'),
    ]);
    assert.deepStrictEqual(r, { state: 'resolved', container: 'cDeep' });
  });

  it('at the deepest level a Ctrl-Z-suspended boundary loses to the live foreground', () => {
    const r = resolveContainerFromTree([
      node(2, 3, 'T', 'docker exec cSuspended tmux a'),
      node(2, 4, 'S+', 'docker exec cLive tmux a'),
    ]);
    assert.deepStrictEqual(r, { state: 'resolved', container: 'cLive' });
  });

  it('a missing stat field counts as live — only an explicit T drops a candidate', () => {
    const r = resolveContainerFromTree([
      node(2, 3, 'T', 'docker exec cSuspended tmux a'),
      node(2, 4, '', 'docker exec cUnknown tmux a'),
    ]);
    assert.deepStrictEqual(r, { state: 'resolved', container: 'cUnknown' });
  });

  it('two live boundaries at the same depth naming DIFFERENT containers → ambiguous', () => {
    const r = resolveContainerFromTree([
      node(2, 3, 'S+', 'docker exec cB tmux a'),
      node(2, 4, 'S+', 'docker exec cA tmux a'),
    ]);
    assert.deepStrictEqual(r, { state: 'ambiguous', containers: ['cA', 'cB'] });
  });

  it('all deepest candidates suspended → still ambiguous (nothing proven live)', () => {
    const r = resolveContainerFromTree([
      node(2, 3, 'T', 'docker exec cA tmux a'),
      node(2, 4, 'T', 'docker exec cB tmux a'),
    ]);
    assert.deepStrictEqual(r, { state: 'ambiguous', containers: ['cA', 'cB'] });
  });

  it('several boundaries naming the SAME container are not ambiguous', () => {
    const r = resolveContainerFromTree([
      node(2, 3, 'S+', 'docker exec cOne tmux a'),
      node(2, 4, 'S', 'docker exec -d cOne sleep infinity'),
    ]);
    assert.deepStrictEqual(r, { state: 'resolved', container: 'cOne' });
  });
});

describe('projectFromContainerResolution — the container→project half (WARDEN-1405)', () => {
  // Real shapes: exactly the parses chatMeta.test.js pins for parseContainerName —
  // the last-hyphen split that names the project on every yatfa chat.
  it('a resolved container parses to its project (last-hyphen split)', () => {
    assert.equal(projectFromContainerResolution({ state: 'resolved', container: 'myproj-worker' }), 'myproj');
    assert.equal(projectFromContainerResolution({ state: 'resolved', container: 'multi-dash-project-planner' }), 'multi-dash-project');
    assert.equal(projectFromContainerResolution({ state: 'resolved', container: 'barename' }), 'barename');
  });

  it('composed with the REAL resolver: the observed attach tree yields the parsed project', () => {
    const nodes = parseTreeWalkOutput(WALK_SCRIPT_LIKE_OUTPUT());
    const resolution = resolveContainerFromTree(nodes);
    assert.deepStrictEqual(resolution, { state: 'resolved', container: 'yatfa-planner-2' });
    assert.equal(projectFromContainerResolution(resolution), 'yatfa-planner');
  });

  it('the honest states never mint a project — null, not a guess', () => {
    assert.equal(projectFromContainerResolution({ state: 'none' }), null);
    assert.equal(projectFromContainerResolution({ state: 'ambiguous', containers: ['c1-a', 'c1-b'] }), null);
    assert.equal(projectFromContainerResolution({ state: 'failed', reason: 'walk failed (exit -1)' }), null);
  });

  it('defensive shapes yield null too (missing container, non-object)', () => {
    assert.equal(projectFromContainerResolution({ state: 'resolved' }), null);
    assert.equal(projectFromContainerResolution({ state: 'resolved', container: '' }), null);
    assert.equal(projectFromContainerResolution(null), null);
    assert.equal(projectFromContainerResolution(undefined), null);
    assert.equal(projectFromContainerResolution('resolved'), null);
  });

  // The walk output for the composed test: the observed two-level attach, as
  // parseTreeWalkOutput consumes it.
  function WALK_SCRIPT_LIKE_OUTPUT() {
    return `0\t100\tSs\tbash\n1\t101\tS+\tzsh\n2\t102\tS+\t${OBSERVED_ATTACH}\n`;
  }
});

describe('resolvePaneContainer — one walk per pane, cached; honest when it cannot walk', () => {
  beforeEach(() => clearPaneContainerCache());

  const WALKED = `0\t100\tSs\tbash\n2\t102\tS+\t${OBSERVED_ATTACH}\n`;
  const chat = { host: 'box', session: 'agent', container: null, kind: 'tmux' };

  it('runs the walk over ssh for a remote chat and resolves from its output', async () => {
    const seen = [];
    const r = await resolvePaneContainer(chat, {}, {
      now: 1_000,
      runWithPool: (host, script, opts, cfg) => {
        seen.push({ host, script, opts, cfg });
        return { ok: true, code: 0, stdout: WALKED, stderr: '' };
      },
    });
    assert.deepStrictEqual(r, { state: 'resolved', container: 'yatfa-planner-2' });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].host, 'box');
    assert.equal(seen[0].script, buildPaneTreeWalkScript('agent'));
    assert.equal(seen[0].opts.timeout, WALK_TIMEOUT_MS);
  });

  it('caches per pane — a burst of pastes walks ONCE — and TTL expiry re-walks', async () => {
    let walks = 0;
    const deps = {
      now: 1_000,
      runWithPool: () => { walks += 1; return { ok: true, code: 0, stdout: WALKED, stderr: '' }; },
    };
    await resolvePaneContainer(chat, {}, deps);
    await resolvePaneContainer(chat, {}, deps);
    await resolvePaneContainer({ ...chat, session: 'other' }, {}, deps); // a different pane, its own walk
    assert.equal(walks, 2);
    await resolvePaneContainer(chat, {}, { ...deps, now: 1_000 + RESOLUTION_TTL_MS - 1 }); // still cached
    assert.equal(walks, 2);
    await resolvePaneContainer(chat, {}, { ...deps, now: 1_000 + RESOLUTION_TTL_MS }); // expired → re-walks
    assert.equal(walks, 3);
  });

  it('clearPaneContainerCache forces the next paste to re-walk (test seam)', async () => {
    let walks = 0;
    const deps = { now: 1, runWithPool: () => { walks += 1; return { ok: true, code: 0, stdout: '', stderr: '' }; } };
    await resolvePaneContainer(chat, {}, deps);
    await resolvePaneContainer(chat, {}, deps);
    clearPaneContainerCache();
    await resolvePaneContainer(chat, {}, deps);
    assert.equal(walks, 2);
  });

  it('a failed walk says failed — it never guesses', async () => {
    const r = await resolvePaneContainer(chat, {}, {
      runWithPool: () => ({ ok: false, code: 255, stdout: '', stderr: 'ssh: connect refused\n' }),
    });
    assert.deepStrictEqual(r, { state: 'failed', reason: 'ssh: connect refused' });
  });

  it('an empty walk (dead pane, no boundary) is an honest none', async () => {
    const r = await resolvePaneContainer(chat, {}, { runWithPool: () => ({ ok: true, code: 0, stdout: '', stderr: '' }) });
    assert.deepStrictEqual(r, { state: 'none' });
  });

  it('the companion toggle routes the walk through the channel, never a raw ssh spawn', async () => {
    const seen = [];
    const r = await resolvePaneContainer(chat, { someCfg: 1 }, {
      isCompanionTransportEnabled: () => true,
      deliverRemoteScript: (host, script, opts, cfg) => {
        seen.push({ host, script, opts, cfg });
        return { ok: true, code: 0, stdout: WALKED, stderr: '' };
      },
      run: () => { throw new Error('raw ssh must not run under the companion toggle'); },
      runWithPool: () => { throw new Error('pooled ssh must not run under the companion toggle either'); },
    });
    assert.deepStrictEqual(r, { state: 'resolved', container: 'yatfa-planner-2' });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].host, 'box');
    assert.equal(seen[0].opts.timeout, WALK_TIMEOUT_MS);
    assert.equal(seen[0].cfg.someCfg, 1);
  });

  it('a local chat walks THIS machine with `sh -c` and the same script', async () => {
    let seen = null;
    const child = new EventEmitter();
    child.stdout = Object.assign(new EventEmitter(), { resume() {}, setEncoding() {} });
    child.stderr = Object.assign(new EventEmitter(), { setEncoding() {} });
    child.kill = () => {};
    const r = await resolvePaneContainer({ host: '(local)', session: 'agent' }, {}, {
      spawn: (bin, argv) => {
        seen = { bin, argv };
        // Emit the observed tree, then settle like a real child would.
        setImmediate(() => {
          child.stdout.emit('data', Buffer.from(WALKED));
          child.emit('close', 0);
        });
        return child;
      },
    });
    assert.equal(seen.bin, 'sh');
    assert.deepStrictEqual(seen.argv, ['-c', buildPaneTreeWalkScript('agent')]);
    assert.deepStrictEqual(r, { state: 'resolved', container: 'yatfa-planner-2' });
  });

  it('the walk targets the SAME pane the marker is keystroked into (the send ladder, cfg leg included)', async () => {
    const scripts = [];
    const deps = { runWithPool: (_h, script) => { scripts.push(script); return { ok: true, code: 0, stdout: '', stderr: '' }; } };
    await resolvePaneContainer({ host: 'box', session: 'mysess' }, { tmuxSession: 'cfgsess' }, deps);
    await resolvePaneContainer({ host: 'box', session: '' }, { tmuxSession: 'cfgsess' }, deps);
    await resolvePaneContainer({ host: 'box', session: '' }, {}, deps);
    assert.deepEqual(
      scripts.map((s) => s.split('\n')[0]),
      [
        "pid=$(tmux display-message -p -t 'mysess' '#{pane_pid}' 2>/dev/null | tr -d ' \\t\\r\\n')",
        "pid=$(tmux display-message -p -t 'cfgsess' '#{pane_pid}' 2>/dev/null | tr -d ' \\t\\r\\n')",
        "pid=$(tmux display-message -p -t 'agent' '#{pane_pid}' 2>/dev/null | tr -d ' \\t\\r\\n')",
      ],
    );
  });
});

// ------------------- deliverPastedImage — the routing gate -------------------
// The chat shapes that already carry a container must be UNTOUCHABLE by the
// resolution; the container-less manual shapes get it; every non-resolved
// outcome falls back to today's host write, with the honest marker when the
// pane's tree could not settle where the agent lives.
describe('deliverPastedImage — pane-tree resolution (WARDEN-1377)', () => {
  const NOW = Date.parse('2026-09-03T00:00:00Z');
  const DEST = `${PASTE_DIR}/paste-2026-09-03T00-00-00-000.png`;

  // The resolution adds an `await` BEFORE the delivery spawn attaches its
  // listeners, so a synthetic 'close' must be emitted on a macrotask — a
  // synchronous emit would be lost and each test would wait out the 60s
  // delivery kill timer.
  const closeSoon = (child) => setImmediate(() => child.emit('close', 0));

  // A minimal PNG header: 8-byte signature + IHDR length/type + 800×600.
  function pngHeader(w = 800, h = 600) {
    const b = Buffer.alloc(24);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
    b.write('IHDR', 12, 'latin1');
    b.writeUInt32BE(w, 16);
    b.writeUInt32BE(h, 20);
    return b;
  }

  function fakeChild() {
    const child = new EventEmitter();
    child.written = null;
    child.stdin = Object.assign(new EventEmitter(), { end(buf) { child.written = buf; } });
    child.stdout = Object.assign(new EventEmitter(), { resume() {} });
    child.stderr = Object.assign(new EventEmitter(), { setEncoding() {} });
    child.kill = () => {};
    return child;
  }

  it('a remote manual pane whose tree resolves to a container gets the docker exec leg', async () => {
    let seen = null;
    const child = fakeChild();
    const buf = pngHeader();
    const p = deliverPastedImage({ host: 'box', session: 'agent', container: null }, { connectTimeout: 7 }, buf, {
      now: NOW,
      isCompanionTransportEnabled: () => false,
      resolvePaneContainer: async () => ({ state: 'resolved', container: 'yatfa-planner-2' }),
      spawn: (bin, argv) => { seen = { bin, argv }; return child; },
    });
    closeSoon(child);
    const r = await p;
    assert.equal(r.ok, true);
    assert.match(seen.bin, /^ssh(\.exe)?$/);
    assert.deepStrictEqual(
      seen.argv,
      buildPasteSshArgv('box', 'yatfa-planner-2', DEST, { connectTimeout: 7 }),
    );
    // Resolved delivery → the marker names the CONTAINER path, plainly.
    assert.equal(r.marker, `[pasted image → ${DEST} (PNG 800×600)]`);
    assert.equal(child.written, buf);
  });

  it('a local manual pane whose tree resolves gets the local docker exec leg — bytes on stdin', async () => {
    let seen = null;
    const child = fakeChild();
    const buf = pngHeader();
    const p = deliverPastedImage({ host: '(local)', session: 'agent', container: null }, {}, buf, {
      now: NOW,
      resolvePaneContainer: async () => ({ state: 'resolved', container: 'agent-7' }),
      spawn: (bin, argv) => { seen = { bin, argv }; return child; },
    });
    closeSoon(child);
    const r = await p;
    assert.equal(r.ok, true);
    assert.equal(seen.bin, 'docker');
    assert.deepStrictEqual(seen.argv, buildContainerExecArgv('agent-7', DEST));
    assert.equal(child.written, buf);
    assert.ok(!/ssh/.test(seen.bin));
  });

  it('an honest none (tree walked clean, no boundary) keeps today\u2019s host leg AND plain marker', async () => {
    let argv = null;
    let resolverCalls = 0;
    const child = fakeChild();
    const buf = pngHeader();
    const p = deliverPastedImage({ host: 'box', session: 'agent', container: null }, {}, buf, {
      now: NOW,
      isCompanionTransportEnabled: () => false,
      resolvePaneContainer: async () => { resolverCalls += 1; return { state: 'none' }; },
      spawn: (_b, a) => { argv = a; return child; },
    });
    closeSoon(child);
    const r = await p;
    assert.equal(resolverCalls, 1);
    assert.equal(r.ok, true);
    assert.ok(argv[argv.length - 1].startsWith('bash -lc '));
    assert.ok(!argv[argv.length - 1].includes('docker'));
    assert.equal(r.marker, `[pasted image → ${DEST} (PNG 800×600)]`, 'no boundary = the agent IS host-side = the path is readable');
  });

  it('ambiguous → host write, and the marker says the file landed on the warden host', async () => {
    let argv = null;
    const child = fakeChild();
    const buf = pngHeader();
    const p = deliverPastedImage({ host: 'box', session: 'agent', container: null }, {}, buf, {
      now: NOW,
      isCompanionTransportEnabled: () => false,
      resolvePaneContainer: async () => ({ state: 'ambiguous', containers: ['cA', 'cB'] }),
      spawn: (_b, a) => { argv = a; return child; },
    });
    closeSoon(child);
    const r = await p;
    assert.equal(r.ok, true);
    assert.ok(argv[argv.length - 1].startsWith('bash -lc '));
    assert.equal(r.marker, `[pasted image → ${DEST} on the warden host (PNG 800×600)]`);
  });

  it('a failed walk degrades the same way — host write, honest marker, never a failed paste', async () => {
    let argv = null;
    const child = fakeChild();
    const buf = pngHeader();
    const p = deliverPastedImage({ host: 'box', session: 'agent', container: null }, {}, buf, {
      now: NOW,
      isCompanionTransportEnabled: () => false,
      resolvePaneContainer: async () => ({ state: 'failed', reason: 'ssh down' }),
      spawn: (_b, a) => { argv = a; return child; },
    });
    closeSoon(child);
    const r = await p;
    assert.equal(r.ok, true);
    assert.ok(argv[argv.length - 1].startsWith('bash -lc '));
    assert.equal(r.marker, buildMarker(DEST, describeImage(buf), { where: 'host' }));
  });

  it('a THROWING resolver can never fail a paste — it degrades to the host write', async () => {
    let argv = null;
    const child = fakeChild();
    const buf = pngHeader();
    const p = deliverPastedImage({ host: 'box', session: 'agent', container: null }, {}, buf, {
      now: NOW,
      isCompanionTransportEnabled: () => false,
      resolvePaneContainer: async () => { throw new Error('boom'); },
      spawn: (_b, a) => { argv = a; return child; },
    });
    closeSoon(child);
    const r = await p;
    assert.equal(r.ok, true);
    assert.ok(argv[argv.length - 1].startsWith('bash -lc '));
    assert.equal(r.marker, `[pasted image → ${DEST} on the warden host (PNG 800×600)]`);
  });

  it('a chat that ALREADY carries a container never reaches the resolver — yatfa/catalog shapes untouched', async () => {
    let resolverCalls = 0;
    let argv = null;
    const child = fakeChild();
    const buf = pngHeader();
    const p = deliverPastedImage({ host: 'box', container: 'agent-1', session: 'agent' }, {}, buf, {
      now: NOW,
      isCompanionTransportEnabled: () => false,
      resolvePaneContainer: async () => { resolverCalls += 1; return { state: 'resolved', container: 'WRONG' }; },
      spawn: (_b, a) => { argv = a; return child; },
    });
    closeSoon(child);
    const r = await p;
    assert.equal(resolverCalls, 0, 'the resolution must be unreachable for container-carrying chats');
    assert.equal(r.ok, true);
    assert.deepStrictEqual(argv, buildPasteSshArgv('box', 'agent-1', DEST, {}), 'the chat\u2019s OWN container delivered, byte-exact');
  });

  it('a chat with NO session has no pane to walk — no resolution, legacy behavior', async () => {
    let resolverCalls = 0;
    const child = fakeChild();
    const buf = pngHeader();
    const p = deliverPastedImage({ host: 'box', container: null }, {}, buf, {
      now: NOW,
      isCompanionTransportEnabled: () => false,
      resolvePaneContainer: async () => { resolverCalls += 1; return { state: 'resolved', container: 'WRONG' }; },
      spawn: () => child,
    });
    closeSoon(child);
    await p;
    assert.equal(resolverCalls, 0);
  });

  it('under the companion toggle a resolved container rides writeFileToHost with the container set', async () => {
    let seen = null;
    const buf = pngHeader();
    const r = await deliverPastedImage({ host: 'box', session: 'agent', container: null }, {}, buf, {
      now: NOW,
      isCompanionTransportEnabled: () => true,
      resolvePaneContainer: async () => ({ state: 'resolved', container: 'yatfa-planner-2' }),
      writeFileToHost: (host, args) => { seen = { host, args }; return { ok: true, code: 0, stdout: '', stderr: '' }; },
      spawn: () => { throw new Error('ssh must not spawn under the companion toggle'); },
    });
    assert.equal(r.ok, true);
    assert.equal(seen.args.container, 'yatfa-planner-2');
  });
});
