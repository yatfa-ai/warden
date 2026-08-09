import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

// Structural invariant for the durable local-persistence layer (WARDEN-831).
//
// The persistence modules that own warden's small-state + log files must route
// EVERY write through the shared atomic-write primitive in src/persist.js (temp +
// fsync + rename, or append), never via a direct fs.writeFileSync /
// fs.appendFileSync to the durable target — that direct write is exactly the
// corruption vector (a crash / power loss / disk-full mid-write leaves a truncated
// file; the old defensive read then silently defaulted = silent data loss).
//
// This test greps those modules' source and fails if any direct sync write to a
// durable target is (re)introduced. It is the "verified by grep + tests" check the
// ticket's territory requires — a regression here means someone bypassed the
// atomic primitive, re-opening the corruption window.
//
// Scope (this ticket owns warden's core STATE + LOGS):
//   IN:  config.js (config + catalog), collections.js, sessions.js, activity.js,
//        and observer.js's directives persistence (logDirective → atomicAppend).
//   OUT (separate subsystems, not this persistence ticket):
//        - observer.js `write_file` tool (writeReportFile): the observer's general
//          report-writing tool, whose writes are entangled with the security-
//          critical symlink-containment loop resolveWithinDataDir (WARDEN-96,
//          fs.realpathSync). Converting it is a separate, security-sensitive change.
//        - cli.js: a short-lived offline process, not the server request path.
//        - gitRoutes.js temp files (diffNoIndex) + git dir reads (HEAD/MERGE_HEAD…).
//        - claudeSessions.js / companion.js / llm.js credential reads.
//        - ssh.js boot spawnSync('where',['tmux']) — the documented boot exception.

const SRC = path.resolve(new URL('.', import.meta.url).pathname);

function read(name) {
  return fs.readFileSync(path.join(SRC, name), 'utf8');
}

describe('persistence layer — atomic-write invariant (WARDEN-831)', () => {
  const STATE_MODULES = ['config.js', 'collections.js', 'sessions.js', 'activity.js'];

  it('state/log modules never write a durable target via fs.writeFileSync (route through persist.js)', () => {
    for (const mod of STATE_MODULES) {
      const src = read(mod);
      assert.ok(
        !src.includes('writeFileSync'),
        `${mod} must not use fs.writeFileSync directly — route durable writes through src/persist.js (atomicWrite/atomicWriteJson). ` +
          'A direct sync write to the target re-opens the truncation/corruption window.',
      );
    }
  });

  it('state/log modules never append via fs.appendFileSync (route through persist.js)', () => {
    for (const mod of STATE_MODULES) {
      const src = read(mod);
      assert.ok(
        !src.includes('appendFileSync'),
        `${mod} must not use fs.appendFileSync directly — route appends through src/persist.js (atomicAppend).`,
      );
    }
  });

  it('the persistence modules import the atomic primitive from persist.js', () => {
    // Each state/log module must reach the atomic helper rather than reinventing it.
    for (const mod of STATE_MODULES) {
      assert.ok(
        read(mod).includes("from './persist.js'"),
        `${mod} should import its atomic-write / defensive-read primitive from ./persist.js`,
      );
    }
  });

  it('persist.js exports the atomic + defensive primitives', () => {
    const src = read('persist.js');
    for (const exp of ['atomicWrite', 'atomicWriteJson', 'atomicAppend', 'readJsonDefensive', 'readJsonDefensiveSync', 'removeFile']) {
      assert.ok(new RegExp(`export (async )?function ${exp}\\b`).test(src), `persist.js must export ${exp}`);
    }
  });

  it('observer.js directives write (logDirective) uses the atomic append helper, not appendFileSync', () => {
    // observer.js is excluded from the blanket no-sync-write check above because the
    // write_file *tool* (writeReportFile) still uses sync fs (out of scope — see the
    // header). But the DIRECTIVES log persistence this ticket owns must use the atomic
    // append primitive. logDirective is the only directives writer; assert it routes
    // through atomicAppend and does not call appendFileSync itself.
    const src = read('observer.js');
    assert.ok(src.includes('atomicAppend'), 'observer.js must import atomicAppend from persist.js');
    const logDirectiveBody = src.match(/export async function logDirective[\s\S]*?\n}\n/);
    assert.ok(logDirectiveBody, 'logDirective must be an async export');
    assert.ok(
      !logDirectiveBody[0].includes('appendFileSync'),
      'logDirective must append via atomicAppend (persist.js), not fs.appendFileSync',
    );
    assert.ok(
      logDirectiveBody[0].includes('atomicAppend'),
      'logDirective must call atomicAppend for the append-only directives log',
    );
  });
});
