import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { agentTarget } from './chatMeta.js';

/**
 * Unit tests for `readDirectives` (src/observer.js) — the inverse of
 * `logDirective`, the reader that backs the GET /api/directives endpoint and the
 * read-only "Directives" history tab (WARDEN-359).
 *
 * `observer.js` evaluates `os.homedir()` at module load (DIRECTIVES_LOG is
 * module-level), so HOME is isolated to a temp dir and directives.md is seeded
 * with the EXACT bytes `logDirective` would produce BEFORE the dynamic import
 * (mirrors src/activity-series.test.js). node --test runs each file in its own
 * process, so the HOME swap never leaks.
 *
 * Seeds three directives: two for the same worker on hostA, one for a reviewer
 * on hostB whose body contains a `## ` markdown line (must NOT be mistaken for a
 * new block — the parser anchors a header on its leading ISO timestamp).
 */

const ISO = (offsetMs) => new Date(Date.now() + offsetMs).toISOString();

// Emits the exact bytes `logDirective` appends (header on first write only),
// so the parser is tested against the real on-disk shape, not a re-derivation.
function appendDirective(logPath, isFirst, { ts, container, host, role, text }) {
  const header = isFirst && !fs.existsSync(logPath) ? '# Yatfa Warden directives log\n' : '';
  const entry = `${header}\n## ${ts} → ${container}@${host} (${role})\n\n${text}\n`;
  fs.appendFileSync(logPath, entry);
}

describe('readDirectives — parses directives.md back into structured records', () => {
  let originalHome, tempHome, logPath, readDirectives;
  let tOld, tMid, tNew;

  before(async () => {
    originalHome = process.env.HOME;
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-directives-'));
    process.env.HOME = tempHome;
    const wdir = path.join(tempHome, '.yatfa-warden');
    fs.mkdirSync(wdir, { recursive: true });
    logPath = path.join(wdir, 'directives.md');

    // tNew > tMid > tOld. readDirectives sorts newest-first, so the order we
    // append (old → mid → new) is deliberately NOT the output order.
    tOld = ISO(-3 * 60 * 60 * 1000); // 3h ago
    tMid = ISO(-90 * 60 * 1000);     // 90m ago
    tNew = ISO(-5 * 60 * 1000);      // 5m ago

    appendDirective(logPath, true, { ts: tOld, container: 'proj-worker', host: 'hostA', role: 'worker', text: 'List the open tickets.' });
    appendDirective(logPath, false, {
      ts: tMid,
      container: 'proj-reviewer',
      host: 'hostB',
      role: 'reviewer',
      // A directive body containing a `## ` markdown line. The naive split on
      // /^## /m would tear this into two blocks; the ISO-anchored header must not.
      text: 'Review the PR.\n\n## Notes\n\nThis is part of the body, not a new directive.',
    });
    appendDirective(logPath, false, { ts: tNew, container: 'proj-worker', host: 'hostA', role: 'agent', text: 'show git status' });

    ({ readDirectives } = await import('./observer.js'));
  });

  after(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    try { fs.rmSync(tempHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it('returns every directive, newest-first, with full text + target + role', async () => {
    const out = await readDirectives();
    assert.strictEqual(out.length, 3, 'all three directives parsed');
    assert.deepStrictEqual(out.map((d) => d.timestamp), [tNew, tMid, tOld], 'newest-first');

    const newest = out[0];
    assert.strictEqual(newest.container, 'proj-worker');
    assert.strictEqual(newest.host, 'hostA');
    assert.strictEqual(newest.role, 'agent');
    assert.strictEqual(newest.text, 'show git status');
  });

  it('preserves a multi-line body that contains a `## ` markdown line (no false split)', async () => {
    const reviewer = (await readDirectives()).find((d) => d.container === 'proj-reviewer');
    assert.ok(reviewer, 'reviewer directive parsed');
    // The whole body — including the embedded heading — survives as one record.
    assert.strictEqual(
      reviewer.text,
      'Review the PR.\n\n## Notes\n\nThis is part of the body, not a new directive.',
    );
  });

  it('filters by agent (container)', async () => {
    const out = await readDirectives({ agent: 'proj-worker' });
    assert.strictEqual(out.length, 2);
    assert.ok(out.every((d) => d.container === 'proj-worker'));
    // Still newest-first within the filtered set.
    assert.deepStrictEqual(out.map((d) => d.timestamp), [tNew, tOld]);
  });

  it('filters by host', async () => {
    const out = await readDirectives({ host: 'hostB' });
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].container, 'proj-reviewer');
  });

  it('honours a limit (applied after sort, so it keeps the newest)', async () => {
    const out = await readDirectives({ limit: 1 });
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].timestamp, tNew);
  });

  // WARDEN-733: pre-WARDEN-642, logDirective wrote the bare `${chat.container}@
  // ${chat.host}` for a local/tmux chat whose container is null — stringifying
  // null to the literal "null" and permanently recording `## <ts> → null@<host>
  // (<role>)` blocks. directives.md is append-only history, so those legacy
  // headers never age out. readDirectives must coerce that "null" token back to
  // null at the source so the read path never surfaces it to DirectiveHistory
  // (which would otherwise render/copy `null@(local)` and offer "null" as an
  // agent-filter option). The WARDEN-642 writer test at L197 only covers the
  // post-fix writer; this fills the read-side gap for the legacy on-disk bytes.
  it('normalizes a legacy "null@host" header to container: null (WARDEN-733)', async () => {
    const ts = ISO(-10 * 60 * 1000); // 10m ago
    appendDirective(logPath, false, { ts, container: 'null', host: '(local)', role: 'agent', text: 'show git status' });

    const out = await readDirectives();
    const legacy = out.find((d) => d.host === '(local)');
    assert.ok(legacy, 'legacy null@(local) block parsed');
    assert.strictEqual(legacy.container, null, 'literal "null" token coerced back to null');
    assert.notStrictEqual(legacy.container, 'null', 'never the string "null"');
    assert.strictEqual(legacy.timestamp, ts);

    // DirectiveHistory L108 builds the agent-filter dropdown from
    // directives.map(d => d.container).filter(Boolean) — null is falsy, so a
    // normalized legacy entry is excluded and "null" never becomes a filter.
    const allAgents = Array.from(new Set(out.map((d) => d.container).filter(Boolean)));
    assert.ok(!allAgents.includes('null'), '"null" excluded from agent-filter options');

    // The agent filter (observer.js L177) compares against the normalized
    // container, so readDirectives({ agent: 'null' }) no longer matches the
    // legacy block (it is now container: null, not the string "null").
    assert.strictEqual((await readDirectives({ agent: 'null' })).length, 0, 'agent:"null" matches nothing post-normalize');
  });

  it('returns [] for an empty file (graceful-empty)', async () => {
    fs.writeFileSync(logPath, '');
    assert.deepStrictEqual(await readDirectives(), []);
  });

  it('returns [] for a missing file (never throws)', async () => {
    // Last test: deletes the seeded file. readDirectives must degrade to [],
    // matching activity.js readEvents' missing-file contract (never a 500).
    fs.unlinkSync(logPath);
    assert.deepStrictEqual(await readDirectives(), []);
  });
});

/**
 * WARDEN-642: `logDirective` must not stringify a local/tmux chat's
 * `container: null` to the literal "null". Both the on-disk directive header
 * (read back by DirectiveHistory's target badge + "Copy agent@host" payload) and
 * the `send_directive` `to:` return value must show `<session>@<host>`, never
 * `null@host`. The fix single-sources the identity through `agentTarget(chat)`
 * with the `container || key || session || 'local'` fallback.
 *
 * This block exercises the helper directly (both the container-set and
 * container-null paths) AND the writer→file→reader round-trip for a real
 * container-null chat — the exact user-facing surface WARDEN-642 corrupts. It
 * runs in its own HOME (cache-busted import) so it cannot perturb the
 * reader-focused describe above, which seeds and then deletes its own log.
 *
 * `agentTarget` is a pure helper (no HOME/module-level state), so it is imported
 * statically from its canonical home ./chatMeta.js; only the state-bound
 * `logDirective`/`readDirectives` (which read DIRECTIVES_LOG, evaluated at
 * module load) need the cache-busted ./observer.js import.
 */
describe('agentTarget + logDirective — never null@host for local/tmux chats (WARDEN-642)', () => {
  let originalHome, tempHome, logPath, logDirective, readDirectives;

  before(async () => {
    originalHome = process.env.HOME;
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-directives-null-'));
    process.env.HOME = tempHome;
    const wdir = path.join(tempHome, '.yatfa-warden');
    fs.mkdirSync(wdir, { recursive: true });
    logPath = path.join(wdir, 'directives.md');
    // Cache-bust so this module instance re-evaluates os.homedir() against the
    // new temp HOME (DIRECTIVES_LOG is module-level), isolating its log file
    // from the describe above. agentTarget is imported statically (pure helper).
    ({ logDirective, readDirectives } = await import('./observer.js?warden642'));
  });

  after(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    try { fs.rmSync(tempHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it('agentTarget: uses the container for docker/yatfa chats (unchanged)', () => {
    assert.strictEqual(
      agentTarget({ container: 'proj-worker', host: 'hostA' }),
      'proj-worker@hostA',
    );
  });

  it('agentTarget: falls back to the session key for local/tmux chats (container: null)', () => {
    // server.js buildAndSpawn / resume factories construct local chats as
    // { key: session, container: null, session, host, ... } — chat.key is the
    // tmux session name and is always set, so the helper must resolve to it
    // rather than stringifying null to "null".
    const target = agentTarget({ container: null, key: 'myproject', session: 'myproject', host: '(local)' });
    assert.strictEqual(target, 'myproject@(local)');
    assert.ok(!target.startsWith('null@'), 'must not stringify a null container to "null@"');
  });

  it('agentTarget: container → key → session → "local" fallback chain', () => {
    // container wins when set (docker), even if key/session differ.
    assert.strictEqual(agentTarget({ container: 'c', key: 'k', session: 's', host: 'h' }), 'c@h');
    // container null → key.
    assert.strictEqual(agentTarget({ container: null, key: 'k', session: 's', host: 'h' }), 'k@h');
    // container + key null → session.
    assert.strictEqual(agentTarget({ container: null, key: null, session: 's', host: 'h' }), 's@h');
    // nothing set → literal "local" (never the bare string "null").
    assert.strictEqual(agentTarget({ container: null, key: null, session: null, host: 'h' }), 'local@h');
  });

  it('logDirective: writes <session>@<host> for a local chat and round-trips through readDirectives', async () => {
    // A local/tmux chat exactly as server.js:3340 constructs it (container: null).
    const localChat = {
      id: '(local):myproject', key: 'myproject', kind: 'tmux', host: '(local)',
      container: null, session: 'myproject', project: 'manual', role: 'claude',
    };
    logDirective(localChat, 'show git status');

    // On-disk header must be session@host — never null@host (the WARDEN-642 bug).
    const onDisk = fs.readFileSync(logPath, 'utf8');
    assert.ok(onDisk.includes(' → myproject@(local) ('), 'header uses session@host');
    assert.ok(!onDisk.includes('null@'), 'never null@host');

    // DirectiveHistory reads via readDirectives — the parsed container must be
    // the session key, not the literal string "null" the old writer produced.
    const out = await readDirectives();
    assert.strictEqual(out.length, 1, 'one directive parsed');
    assert.strictEqual(out[0].container, 'myproject');
    assert.strictEqual(out[0].host, '(local)');
    assert.notStrictEqual(out[0].container, 'null');
  });

  it('logDirective: docker/yatfa chat header unchanged (container@host)', async () => {
    const dockerChat = {
      id: 'hostA:agent', key: 'agent', kind: 'yatfa', host: 'hostA',
      container: 'proj-worker', session: 'agent', project: 'proj', role: 'worker',
    };
    logDirective(dockerChat, 'list the open tickets');

    const onDisk = fs.readFileSync(logPath, 'utf8');
    assert.ok(onDisk.includes(' → proj-worker@hostA ('), 'docker header is container@host');
    assert.ok(!onDisk.includes('null@'), 'never null@host');

    // Two directives now (local above + this docker one); the docker record
    // parses back with its true container.
    const docker = (await readDirectives()).find((d) => d.container === 'proj-worker');
    assert.ok(docker, 'docker directive parsed');
    assert.strictEqual(docker.host, 'hostA');
  });
});
