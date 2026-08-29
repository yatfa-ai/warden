import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SYNC_FS_METHODS, SYNC_CHILD_PROCESS_METHODS } from './loop-monitor.js';

/**
 * STATIC COVERAGE GUARD for the sync-I/O probe (WARDEN-977).
 *
 * WHY THIS FILE EXISTS: the first cut of `SYNC_FS_METHODS` was written as a
 * transcript of the call sites its author happened to look at, and it omitted
 * `openSync`/`readSync`/`closeSync` — the primitives behind every hand-rolled
 * windowed read in src/, including the 400KB per-request transcript read in
 * claudeSessions.js. The failure mode that creates is not a missing line in a
 * log; it is ACTIVE MISDIRECTION. The enclosing request span still names the
 * route, the attribution carries no `fs.*` entry, and the owner reading
 * stalls.jsonl concludes "synchronous I/O was not involved" on the exact path
 * that blocked the loop — which is worse than having no evidence at all, because
 * the follow-up ticket gets written away from the cause.
 *
 * A unit test cannot catch that: the probe was internally consistent and every
 * behavioral test passed. The gap was between the method list and the REPOSITORY.
 * So this suite reads the actual runtime sources and fails when a synchronous
 * call site exists that the probe cannot see.
 */

const SRC_DIR = path.dirname(fileURLToPath(import.meta.url));

/** Runtime modules only: a sync call in a test never blocks the server's loop. */
function runtimeSources() {
  return fs.readdirSync(SRC_DIR)
    .filter((f) => f.endsWith('.js') && !f.endsWith('.test.js'))
    .map((f) => ({ file: f, text: fs.readFileSync(path.join(SRC_DIR, f), 'utf8') }));
}

/** Every `<object>.<name>Sync` member access in a source file. */
function syncMemberCalls(text, object) {
  const re = new RegExp(`\\b${object}\\.([A-Za-z]+Sync)\\b`, 'g');
  return [...text.matchAll(re)].map((m) => m[1]);
}

describe('sync-I/O probe coverage — the method list vs. the actual call sites', () => {
  it('instruments every `fs.*Sync` member called anywhere in the runtime sources', () => {
    const uncovered = new Map(); // method -> files
    for (const { file, text } of runtimeSources()) {
      for (const method of syncMemberCalls(text, 'fs')) {
        if (SYNC_FS_METHODS.includes(method)) continue;
        if (!uncovered.has(method)) uncovered.set(method, new Set());
        uncovered.get(method).add(file);
      }
    }
    assert.deepEqual(
      [...uncovered.entries()].map(([m, files]) => `fs.${m} (${[...files].join(', ')})`),
      [],
      'a synchronous fs call the probe cannot time makes a stall on that path report '
      + '"no synchronous I/O involved". Add the method to SYNC_FS_METHODS in src/loop-monitor.js.',
    );
  });

  it('instruments every `childProcess.*Sync` member called in the runtime sources', () => {
    const uncovered = new Set();
    for (const { text } of runtimeSources()) {
      for (const object of ['childProcess', 'child_process', 'cp']) {
        for (const method of syncMemberCalls(text, object)) {
          if (!SYNC_CHILD_PROCESS_METHODS.includes(method)) uncovered.add(method);
        }
      }
    }
    assert.deepEqual([...uncovered], [], 'add the method to SYNC_CHILD_PROCESS_METHODS');
  });

  it('covers the fd-level read primitives that the windowed reads are built from', () => {
    // Named explicitly, and not only via the scan above, because these are the
    // ones that were missed: the scan proves "nothing is uncovered TODAY", this
    // proves "the specific family that caused the miss stays covered" even if
    // those call sites are refactored away and the scan goes quiet.
    for (const m of ['openSync', 'readSync', 'closeSync', 'mkdtempSync']) {
      assert.ok(SYNC_FS_METHODS.includes(m), `SYNC_FS_METHODS must include ${m}`);
    }
  });

  it('flags a NEW named-import sync call, which no module-object patch can reach', () => {
    // `import { spawnSync } from 'node:child_process'` binds the function before
    // instrumentSyncIo patches the module object, so such a call is invisible to
    // the probe FOREVER — the same false-negative class as a missing method,
    // and one the list above cannot fix.
    //
    // Known and accepted: src/ssh.js runs a single load-time win32 probe, which
    // is not a runtime path and cannot stall a request. If this fires for a new
    // file, either route the call through the module object (`import fs from
    // 'node:fs'` / `import childProcess from 'node:child_process'`) so the probe
    // can time it, or add it here with the reason it cannot block the loop.
    const ALLOWED = new Set(['ssh.js']);
    const offenders = [];
    for (const { file, text } of runtimeSources()) {
      if (ALLOWED.has(file)) continue;
      for (const m of text.matchAll(/^import\s*\{([^}]*)\}\s*from\s*'node:(?:child_process|fs)'/gm)) {
        const named = m[1].split(',').map((s) => s.trim().split(/\s+as\s+/)[0].trim());
        for (const name of named) {
          if (name.endsWith('Sync')) offenders.push(`${file}: ${name}`);
        }
      }
    }
    assert.deepEqual(offenders, [], 'named sync imports are unreachable by the sync-I/O probe');
  });
});
