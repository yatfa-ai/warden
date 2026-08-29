import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * STATIC SOURCE GUARD for the observer Stop flag (WARDEN-1222).
 *
 * WHY THIS FILE EXISTS: `connect` in ObserverPanel is deliberately memoized on
 * [sessionId] only (widening the deps would tear down and rebuild the WebSocket
 * on every preference change). Its `ws.onclose` handler must decide between
 * "user pressed Stop — stay closed" and "genuine disconnect — reconnect in
 * 1.5s", but a plain `userStopped` state read inside that callback captures the
 * value at connect time (always false), so Stop was silently a no-op: the socket
 * reconnected and the reconnect path wiped the stopped state.
 *
 * This repo has no front-end DOM test runner, so the closure staleness itself is
 * not assertable from a unit test. What a source scan CAN see is the contract
 * the fix rests on — the same in-file idiom used three times already
 * (notifyObserverRef, onActivityRef, mountedRef): a long-lived callback reads
 * mutable session state through a ref, never through state captured in a
 * memoized closure.
 *
 * The invariant asserted here is CLASS-WIDE over the panel's stop machinery:
 *   1. `ws.onclose` gates reconnect on `userStoppedRef.current`, not `userStopped`
 *   2. `stop` sets `userStoppedRef.current = true`
 *   3. `connect` resets it to false (so a manual Reconnect clears the flag)
 *   4. the ref is declared, and `connect`'s dependency array never names the flag
 *      (the forbidden fix that would rebuild the socket on every stop/start)
 *
 * Run: node observerStop.test.mjs   (from web/)
 */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(
  path.join(__dirname, 'src/components/ObserverPanel.tsx'),
  'utf8',
);

const connectStart = src.indexOf('const connect = useCallback(');
assert.ok(connectStart > 0, 'connect callback found');
// End of the memoized connect callback = its dependency array line.
const connectEnd = (() => {
  const dep = src.indexOf('}, [sessionId,', connectStart);
  assert.ok(dep > 0, 'connect dep array found');
  return dep;
})();

describe('ObserverPanel Stop flag (WARDEN-1222)', () => {
  it('declares the userStopped ref following the in-file ref idiom', () => {
    assert.match(src, /const userStoppedRef = useRef\(false\)/);
  });

  it('stop() sets the ref so the close handler observes it', () => {
    const stopStart = src.indexOf('const stop = useCallback(');
    assert.ok(stopStart > 0, 'stop callback found');
    const stopEnd = src.indexOf(');', src.indexOf('}', stopStart));
    const stopBody = src.slice(stopStart, stopEnd);
    assert.match(stopBody, /userStoppedRef\.current = true/);
  });

  it('connect() resets the ref so a manual reconnect clears the flag', () => {
    const connectBody = src.slice(connectStart, connectEnd);
    assert.match(connectBody, /userStoppedRef\.current = false/);
  });

  it('ws.onclose gates the auto-reconnect on the ref, not stale state', () => {
    const connectBody = src.slice(connectStart, connectEnd);
    assert.match(connectBody, /if \(!userStoppedRef\.current\)/);
    // The stale-closure shape that WAS the bug: reading the state value inside
    // the memoized callback. (useState-based userStopped no longer exists.)
    assert.doesNotMatch(connectBody, /if \(!userStopped\)/);
    assert.doesNotMatch(src, /const \[userStopped, setUserStopped\]/);
  });

  it('connect dependency array never lists the stop flag (no socket rebuild)', () => {
    const depEnd = src.indexOf('])', connectEnd);
    const depLine = src.slice(connectEnd, depEnd);
    assert.ok(depLine.includes('sessionId'));
    assert.ok(!depLine.includes('userStopped'));
  });
});
