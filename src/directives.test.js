import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

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

  it('returns every directive, newest-first, with full text + target + role', () => {
    const out = readDirectives();
    assert.strictEqual(out.length, 3, 'all three directives parsed');
    assert.deepStrictEqual(out.map((d) => d.timestamp), [tNew, tMid, tOld], 'newest-first');

    const newest = out[0];
    assert.strictEqual(newest.container, 'proj-worker');
    assert.strictEqual(newest.host, 'hostA');
    assert.strictEqual(newest.role, 'agent');
    assert.strictEqual(newest.text, 'show git status');
  });

  it('preserves a multi-line body that contains a `## ` markdown line (no false split)', () => {
    const reviewer = readDirectives().find((d) => d.container === 'proj-reviewer');
    assert.ok(reviewer, 'reviewer directive parsed');
    // The whole body — including the embedded heading — survives as one record.
    assert.strictEqual(
      reviewer.text,
      'Review the PR.\n\n## Notes\n\nThis is part of the body, not a new directive.',
    );
  });

  it('filters by agent (container)', () => {
    const out = readDirectives({ agent: 'proj-worker' });
    assert.strictEqual(out.length, 2);
    assert.ok(out.every((d) => d.container === 'proj-worker'));
    // Still newest-first within the filtered set.
    assert.deepStrictEqual(out.map((d) => d.timestamp), [tNew, tOld]);
  });

  it('filters by host', () => {
    const out = readDirectives({ host: 'hostB' });
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].container, 'proj-reviewer');
  });

  it('honours a limit (applied after sort, so it keeps the newest)', () => {
    const out = readDirectives({ limit: 1 });
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].timestamp, tNew);
  });

  it('returns [] for an empty file (graceful-empty)', () => {
    fs.writeFileSync(logPath, '');
    assert.deepStrictEqual(readDirectives(), []);
  });

  it('returns [] for a missing file (never throws)', () => {
    // Last test: deletes the seeded file. readDirectives must degrade to [],
    // matching activity.js readEvents' missing-file contract (never a 500).
    fs.unlinkSync(logPath);
    assert.deepStrictEqual(readDirectives(), []);
  });
});
