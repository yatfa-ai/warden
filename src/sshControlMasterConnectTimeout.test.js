import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { EventEmitter } from 'node:events';
import { ensureControlMaster } from './ssh.js';

/**
 * Pins ensureControlMaster's CONNECT-TIMEOUT arm (WARDEN-2194) — the one bound on
 * a WEDGED connect.
 *
 * The daemonizing-success contract (WARDEN-1107: settle on 'exit', never 'close')
 * has a flip side: a connect that never produces ANY child event — host firewall
 * DROP, half-open TCP, a wedged ControlPersist master stuck at session-request —
 * leaves the spawned child silent forever. The armed connect timer (the
 * `setTimeout` inside ensureControlMaster's spawn promise whose callback
 * `settle()`s, `child.kill('SIGTERM')`s and rejects with
 * `ControlMaster connect timeout to ${host}` at `timeout * 1000 + 5000`) is the
 * ONLY bound on that state. Disarm it, drop the SIGTERM or mis-name the rejection,
 * and `getConnection` never resolves while every pooled remote call (pane reads,
 * send-keys, discover) wedges behind it — and every existing test stays green.
 * The sibling suite (sshControlMaster.test.js) asserts the timer must NOT fire on
 * success ("the connect timer never fired, so nothing was SIGTERmed") but never
 * fires it; these two examples do.
 *
 * Harness: the same fake-child + `cfg.spawn` seam as sshControlMaster.test.js.
 * The `-O check` probe keeps the real spawn exactly as there — the untouched
 * positive control — and is harmless here: the control socket these tests name
 * does not exist, so the probe resolves non-zero at once without any network I/O
 * (and -1 at once when ssh is absent entirely; sshControl NEVER rejects).
 *
 * Timer determinism: the repo-precedented `globalThis.setTimeout` patch
 * (llm.test.js patches the same global to make retry backoff instant), here in
 * the RECORDING form this file needs — the patch ARMS NOTHING and records
 * `{fn, delay}`; each test fires the recorded connect callback explicitly and
 * afterEach restores the real timer. Production's `clearTimeout` tolerates the
 * handle-shaped return (node's clearTimeout no-ops on a plain object), so no
 * real timer is ever scheduled and nothing leaks past the test.
 *
 * Per-test timeout: these tests are driven by FIRING a recorded callback, so a
 * regression that drops the `reject` inside the settle callback would leave `p`
 * forever unsettled — awaiting it would hang the whole suite with every other
 * assertion green. The 8s per-test timeout turns exactly that shape into a
 * named failure instead of a hang. (The runner's own timeout clock is internal
 * to node:test and unaffected by the globalThis patch.)
 *
 * Deliberately NOT pinned (equivalent mutant, house rule): dropping the
 * `clearTimeout(timer)` inside settle() — on this arm or at the failure-drain
 * handoff — is behaviorally INERT: the single-settle guard makes a stale timer's
 * callback no-op through `if (settled) return`, so no assertion can discriminate
 * either removal, and a mutant that drops them passes every example here.
 */

// Same stand-in as the sibling file, except kill RECORDS THE SIGNAL so the
// single-SIGTERM discipline is assertable (the sibling only counts kills).
function fakeChild() {
  const encodings = {};
  const c = new EventEmitter();
  c.stdout = Object.assign(new EventEmitter(), { setEncoding(e) { encodings.stdout = e; } });
  c.stderr = Object.assign(new EventEmitter(), { setEncoding(e) { encodings.stderr = e; } });
  c.kills = [];
  c.kill = (signal) => { c.kills.push(signal); };
  c.encodings = encodings;
  return c;
}

// Same harness as the sibling file: ensureControlMaster awaits its `-O check`
// probe BEFORE spawning, so the fake child does not exist synchronously — hand
// back a promise that settles the moment the injected spawn is called, so every
// test drives a real, already-wired child.
function harness() {
  let child = null;
  let announce;
  const spawned = new Promise((r) => { announce = r; });
  const calls = [];
  const spawn = (bin, args, opts) => {
    child = fakeChild();
    calls.push({ bin, args, opts });
    announce(child);
    return child;
  };
  return { spawn, spawned, calls, get child() { return child; } };
}

const realSetTimeout = globalThis.setTimeout;
let arms = [];

describe('ensureControlMaster — the connect-timeout arm (WARDEN-2194)', () => {
  beforeEach(() => {
    arms = [];
    // Arm NOTHING; record the callback and its delay so each test can pin the
    // arm DELAY itself (an assertion class auto-fire cannot express) and fire
    // the connect timer exactly when the wedged scenario calls for it.
    globalThis.setTimeout = (fn, delay) => {
      const entry = { fn, delay };
      arms.push(entry);
      return { recorded: entry };  // handle-shaped; production clearTimeout no-ops on it
    };
  });
  afterEach(() => {
    globalThis.setTimeout = realSetTimeout;
  });

  it('gate 1: a wedged connect (child never emits) SIGTERMs the child exactly once and rejects `ControlMaster connect timeout to wedged-host` when the connect timer fires', { timeout: 8000 }, async () => {
    const h = harness();
    const p = ensureControlMaster('wedged-host', { spawn: h.spawn });
    const child = await h.spawned;

    // Exactly one arm sits at the default connect bound (cfg.connectTimeout
    // defaults to 10 → 10 * 1000 + 5000); the probe's own recorded arm is 2s.
    const connectArms = arms.filter((a) => a.delay === 10 * 1000 + 5000);
    assert.strictEqual(connectArms.length, 1,
      'exactly one arm at the default connect bound is armed for the spawned child');
    const armsAtFire = arms.length;

    // The wedge: the child emits nothing, forever. Fire the connect timer — the
    // ONLY bound on this state — and hold the arm count steady through the settle.
    connectArms[0].fn();

    await assert.rejects(() => p, (e) => {
      assert.strictEqual(e.message, 'ControlMaster connect timeout to wedged-host');
      return true;
    });
    assert.deepStrictEqual(child.kills, ['SIGTERM'],
      'exactly one SIGTERM, and no other signal, reached the wedged child');
    assert.strictEqual(arms.length, armsAtFire,
      'nothing re-armed after the settle — the wedge is bounded exactly once');
  });

  it('gate 1b: the connect bound is connectTimeout * 1000 + 5000 — the cfg-threaded connectTimeout plus a 5s grace on top of ssh\'s own -o ConnectTimeout', { timeout: 8000 }, async () => {
    const h = harness();
    const p = ensureControlMaster('slow-host', { spawn: h.spawn, connectTimeout: 7 });
    const child = await h.spawned;

    const connectArms = arms.filter((a) => a.delay === 7 * 1000 + 5000);
    assert.strictEqual(connectArms.length, 1,
      'the connect arm is armed at exactly connectTimeout * 1000 + 5000 (12000 for 7)');
    connectArms[0].fn();

    await assert.rejects(() => p, (e) => {
      // Firing the filtered arm proves the recorded delay belongs to the connect
      // timer itself, not to any incidental recorded entry.
      assert.strictEqual(e.message, 'ControlMaster connect timeout to slow-host');
      return true;
    });
    assert.deepStrictEqual(child.kills, ['SIGTERM']);
  });
});
