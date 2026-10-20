import { describe, it } from 'node:test';
import assert from 'node:assert';
import { pollUntil, sleep } from './testWait.js';

// Unit contract for pollUntil's `resolveAnyway` opt (WARDEN-1882). The
// deadline arm is code a green run of the migrated call sites never reaches
// — their waits succeed — so the option's semantics (resolve with the LAST
// falsy fn() result instead of throwing; truthy still wins; fn still runs at
// least once; non-anyway mode unchanged) are proven here.

describe('testWait pollUntil resolveAnyway', () => {
  it('default mode still throws at the deadline (non-anyway behavior unchanged)', async () => {
    await assert.rejects(
      pollUntil(() => null, { what: 'the marker', timeout: 60, interval: 10 }),
      (err) => err instanceof Error && err.message === 'timed out (60ms) waiting for the marker',
    );
  });

  it('default mode still appends describe() output to the deadline error', async () => {
    await assert.rejects(
      pollUntil(() => 0, { what: 'the frame', timeout: 60, interval: 10, describe: () => 'saw nothing' }),
      (err) => err.message === 'timed out (60ms) waiting for the frame; saw nothing',
    );
  });

  it('resolveAnyway resolves with the LAST (falsy) fn() result at the deadline instead of throwing', async () => {
    let evals = 0;
    const value = await pollUntil(() => { evals += 1; return null; },
      { what: 'never met', timeout: 60, interval: 10, resolveAnyway: true });
    assert.equal(value, null);
    assert.ok(evals >= 1, 'fn was evaluated at least once');
  });

  it('resolveAnyway still resolves with the FIRST truthy value when the condition is met', async () => {
    let evals = 0;
    const value = await pollUntil(() => (++evals >= 3 ? 'met' : null),
      { timeout: 2000, interval: 5, resolveAnyway: true });
    assert.equal(value, 'met');
    assert.equal(evals, 3);
  });

  it('truthy always wins — even an evaluation that lands after the deadline has passed', async () => {
    // An evaluation is not interrupted: this one sleeps past the deadline and
    // only then turns truthy. The value check precedes the deadline check
    // within one iteration, so the truthy result is returned instead of the
    // deadline arm firing — resolveAnyway only changes THAT arm (WARDEN-110 §2).
    const value = await pollUntil(async () => {
      await sleep(80);
      return 'late-but-truthy';
    }, { what: 'slow truth', timeout: 30, interval: 10, resolveAnyway: true });
    assert.equal(value, 'late-but-truthy');
  });
});
