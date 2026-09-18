import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';


/**
 * HTTP integration tests for GET /api/pane-project (WARDEN-1405).
 *
 * The manual-pane project fallback for the issue-key linkifier: a manual/tmux
 * chat hardcodes a placeholder project ('local'/'manual' — the chats.js/server.js
 * factories), so the frontend's strict per-project scoping correctly linkifies
 * nothing. The endpoint answers WHICH project the pane's foreground really
 * belongs to: a container-bearing chat answers from its own project (no walk);
 * a container-less one walks the pane's docker-exec process tree through
 * resolvePaneContainer (WARDEN-1377's resolver — the seam pasted-image delivery
 * already proves live) and parses the container with the product's own
 * container→project split (chatMeta.parseContainerName).
 *
 * Real Express app from src/server.js (the server-config.test.js pattern), with
 * the resolver pre-warmed so every endpoint answer below is deterministic and
 * no endpoint request ever spawns a real walk: resolvePaneContainer caches per
 * `host|target` for RESOLUTION_TTL_MS, so a direct injected-deps warm-up call
 * in the test process (same module instance the server imported) serves the
 * route's own call from the TTL cache. The fake tmux/ps/pgrep binaries on PATH
 * are the paste-container-resolution.test.js pattern — the walk script itself
 * really runs under sh against them in the warm-up.
 *
 * The 'known' (container-bearing chat) arm is deliberately NOT reachable here:
 * disk-catalog chats always hydrate container:null (toCatalogChat), and yatfa
 * chats need live docker/ssh discovery, which an integration test must not
 * depend on. The frontend gate pins that arm's OBSERVABLE consequence —
 * shouldResolvePaneProject returns false for any chat with a container, so a
 * yatfa pane never even fetches this endpoint (web/issue-links.test.mjs) — and
 * the branch is two readable lines in server.js.
 */
describe('/api/pane-project (real Express app from server.js)', () => {
  let httpServer;
  let baseUrl;
  let originalHome;
  let tempHome;
  let originalPath;

  before(async () => {
    originalHome = process.env.HOME;
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-pane-project-'));
    process.env.HOME = tempHome;
    const wardenDir = path.join(tempHome, '.yatfa-warden');
    fs.mkdirSync(wardenDir, { recursive: true });
    // Toggle OFF by default (the shipped default; the endpoint's first gate).
    fs.writeFileSync(path.join(wardenDir, 'config.json'), JSON.stringify({ hosts: [] }));
    // One manual local chat — the population the endpoint exists for
    // (catalog chats hydrate container:null, project 'local' for host '(local)').
    fs.writeFileSync(path.join(wardenDir, 'chats.json'), JSON.stringify([
      { kind: 'tmux', host: '(local)', session: 'projwalk', name: 'projwalk' },
    ]));

    const { app } = await import('./server.js');
    httpServer = app.listen(0, '127.0.0.1');
    await new Promise((resolve, reject) => {
      httpServer.once('listening', resolve);
      httpServer.once('error', reject);
    });
    baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
  });

  after(async () => {
    if (httpServer) await new Promise((r) => httpServer.close(r));
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    try { fs.rmSync(tempHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  const get = (id) => fetch(`${baseUrl}/api/pane-project?id=${encodeURIComponent(id)}`);
  const putConfig = (body) => fetch(`${baseUrl}/api/config`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  // ---- the fake process tree (paste-container-resolution.test.js pattern) ----
  const OBSERVED_ATTACH = 'docker exec -it -u yatfa yatfa-planner-2 tmux attach -t agent';

  function installFakes({ panePid = '100', tree = true, ambiguous = false } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-projwalk-'));
    fs.writeFileSync(path.join(dir, 'tmux'), `#!/bin/sh\necho ${JSON.stringify(panePid)}\n`);
    const psCases = tree
      ? (ambiguous
          ? '  100) printf \'Ss   bash\\n\' ;;\n' +
            '  101) printf \'S+   docker exec -it proj-a tmux attach\\n\' ;;\n' +
            '  102) printf \'S+   docker exec -it proj-b tmux attach\\n\' ;;\n'
          : '  100) printf \'Ss   bash\\n\' ;;\n' +
            '  101) printf \'S+   zsh\\n\' ;;\n' +
            `  102) printf 'S+   ${OBSERVED_ATTACH}\\n' ;;\n`)
      : '';
    fs.writeFileSync(
      path.join(dir, 'ps'),
      '#!/bin/sh\ncase "$2" in\n' + psCases + '  *) exit 3 ;;\nesac\n',
    );
    const pgrepCases = tree ? (ambiguous ? '  100) echo "101 102" ;;\n' : '  100) echo 101 ;;\n  101) echo 102 ;;\n') : '';
    fs.writeFileSync(
      path.join(dir, 'pgrep'),
      '#!/bin/sh\ncase "$2" in\n' + pgrepCases + '  *) exit 1 ;;\nesac\n',
    );
    for (const b of ['tmux', 'ps', 'pgrep']) fs.chmodSync(path.join(dir, b), 0o755);
    return dir;
  }

  function useFakes(dir) {
    if (originalPath === undefined) originalPath = process.env.PATH;
    process.env.PATH = `${dir}:${process.env.PATH}`;
    return () => { process.env.PATH = originalPath; };
  }

  async function prewarm({ dir, session, deps } = {}) {
    const restorePath = dir ? useFakes(dir) : null;
    try {
      const { resolvePaneContainer, clearPaneContainerCache } = await import('./paneContainer.js');
      clearPaneContainerCache();
      // Injected deps so the WARM-UP walk is deterministic; the route's own
      // call then hits the TTL cache (same `host|target` key, same module).
      const resolution = await resolvePaneContainer({ host: '(local)', session }, {}, deps);
      return resolution;
    } finally {
      if (restorePath) restorePath();
    }
  }

  beforeEach(async () => {
    // Each case starts from the shipped toggle state it asserts about.
    await putConfig({ issueLinksEnabled: false });
  });

  it('answers { state: "disabled" } while the integration is off — even for a stray/unknown id, with no 404', async () => {
    const res = await get('(local):projwalk');
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(await res.json(), { state: 'disabled' });
    const stray = await get('totally:unknown');
    assert.strictEqual(stray.status, 200);
    assert.deepStrictEqual(await stray.json(), { state: 'disabled' });
  });

  it('with the integration on, an unknown id is a 404 (mirrors /api/pane-export\u2019s resolve shape)', async () => {
    await putConfig({ issueLinksEnabled: true });
    const res = await get('totally:unknown');
    assert.strictEqual(res.status, 404);
    assert.ok((await res.json()).error);
  });

  it('a manual pane whose walk resolves answers { state: "resolved", project, container } — the parsed project', async () => {
    await putConfig({ issueLinksEnabled: true });
    const warm = await prewarm({ session: 'projwalk', dir: installFakes({ tree: true }) });
    assert.deepStrictEqual(warm, { state: 'resolved', container: 'yatfa-planner-2' });
    const res = await get('(local):projwalk');
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(await res.json(), { state: 'resolved', project: 'yatfa-planner', container: 'yatfa-planner-2' });
  });

  it('a walk that finds no docker exec is an honest none — { state: "none", project: null }', async () => {
    await putConfig({ issueLinksEnabled: true });
    await prewarm({ session: 'projwalk', dir: installFakes({ tree: false }) });
    const res = await get('(local):projwalk');
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(await res.json(), { state: 'none', project: null });
  });

  it('a walk with two live boundaries is ambiguous — { state: "ambiguous", project: null }', async () => {
    await putConfig({ issueLinksEnabled: true });
    await prewarm({ session: 'projwalk', dir: installFakes({ tree: true, ambiguous: true }) });
    const res = await get('(local):projwalk');
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(await res.json(), { state: 'ambiguous', project: null });
  });

  it('a walk that cannot run is an honest failure — { state: "failed", project: null }', async () => {
    await putConfig({ issueLinksEnabled: true });
    await prewarm({ session: 'projwalk', deps: { spawn: () => { throw new Error('no sh here'); } } });
    const res = await get('(local):projwalk');
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(await res.json(), { state: 'failed', project: null });
  });
});
