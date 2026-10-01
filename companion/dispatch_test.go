package main

import (
	"encoding/base64"
	"encoding/json"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"
)

// WARDEN-1491 — the dispatcher's head-of-line properties. These drive the REAL
// request router (handle) with a real PTY and real subprocesses: the bug was a
// timing property of the whole loop, so a mock handler would prove nothing.

type respSink struct {
	mu    sync.Mutex
	resps []Response
}

func (r *respSink) write(resp Response) {
	r.mu.Lock()
	r.resps = append(r.resps, resp)
	r.mu.Unlock()
}

func (r *respSink) has(id string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, x := range r.resps {
		if string(x.ID) == id {
			return true
		}
	}
	return false
}

func (r *respSink) get(id string) (Response, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, x := range r.resps {
		if string(x.ID) == id {
			return x, true
		}
	}
	return Response{}, false
}

func newTestDispatcher(t *testing.T) (*dispatcher, *respSink, *collectLines) {
	t.Helper()
	rs := &respSink{}
	lines := &collectLines{}
	d := newDispatcher(rs.write, lines.write, func(sid string, b []byte) {
		lines.write(attachDataEvent{Event: "attachData", Sid: sid, Data: base64.StdEncoding.EncodeToString(b)})
	})
	return d, rs, lines
}

func req(id, method string, params any) Request {
	raw, _ := json.Marshal(params)
	return Request{ID: json.RawMessage(id), Method: method, Params: raw}
}

func skipOnWindows(t *testing.T) {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("exercises bash/cat under a unix PTY")
	}
}

// TestSlowExecDoesNotDelayKeystrokeEcho is THE regression: a slow exec RPC in
// flight must not delay a keystroke's echo. Before the dispatcher the loop was
// serial and the echo waited out the whole exec (measured 2,914ms behind a 3s
// sleep against the real binary; 8s timeout + 2s WaitDelay = the ~10s tail).
func TestSlowExecDoesNotDelayKeystrokeEcho(t *testing.T) {
	skipOnWindows(t)
	d, rs, lines := newTestDispatcher(t)

	d.handle(req("1", "attachStart", attachStartParams{Script: "cat", Cols: 80, Rows: 24}))
	waitFor(t, 5*time.Second, "attachStart ack", func() bool { return rs.has("1") })
	ack, _ := rs.get("1")
	if !ack.OK {
		t.Fatalf("attachStart failed: %s", ack.Error)
	}
	sid := ack.Result.(map[string]any)["sid"].(string)
	t.Cleanup(func() { b, _ := json.Marshal(attachSidParams{Sid: sid}); _ = attachKill(b) })

	// A slow probe in flight: sleeps 3s (the production shape: a hung git probe).
	d.handle(req("2", "exec", execParams{Script: "sleep 3", TimeoutMs: 8000}))
	time.Sleep(100 * time.Millisecond) // let it start

	t0 := time.Now()
	d.handle(req("3", "attachInput", attachInputParams{Sid: sid, Data: base64.StdEncoding.EncodeToString([]byte("ECHOME\n"))}))
	waitFor(t, 2*time.Second, "echo of the keystroke", func() bool { return strings.Contains(lines.dataString(sid), "ECHOME") })
	if dt := time.Since(t0); dt > 1500*time.Millisecond {
		t.Fatalf("keystroke echo took %v behind a 3s exec — the request loop is head-of-line blocked again", dt)
	}
	if rs.has("2") {
		t.Fatalf("test invalid: the slow exec finished before the echo was measured")
	}
	// And the slow exec still completes with its own response.
	waitFor(t, 6*time.Second, "slow exec response", func() bool { return rs.has("2") })
}

// TestHandleNeverBlocksOnSlowWork pins the loop contract directly: handle()
// returns promptly for every method that does subprocess work.
func TestHandleNeverBlocksOnSlowWork(t *testing.T) {
	skipOnWindows(t)
	d, _, _ := newTestDispatcher(t)
	slow := execParams{Script: "sleep 2", TimeoutMs: 8000}
	for _, m := range []string{"exec", "writeFile", "send", "sendKeys", "resize", "spawnSession", "killSession", "hasSession", "capturePanes", "discover"} {
		var params any = slow
		if m == "send" || m == "sendKeys" || m == "resize" || m == "spawnSession" || m == "killSession" || m == "hasSession" {
			params = map[string]any{"session": "warden-1491-nonexistent-session"}
		}
		start := time.Now()
		d.handle(req("9", m, params))
		if dt := time.Since(start); dt > 250*time.Millisecond {
			t.Fatalf("handle(%s) blocked the request loop for %v", m, dt)
		}
	}
}

// TestControlLaneKeepsOrder: the tmux-mutating ops keep the relative order the
// serial loop used to guarantee (send, then Enter-style follow-ups), even though
// they no longer queue behind reads or exec.
func TestControlLaneKeepsOrder(t *testing.T) {
	var lane serialLane
	var mu sync.Mutex
	var got []int
	var wg sync.WaitGroup
	for i := 0; i < 50; i++ {
		i := i
		wg.Add(1)
		lane.submit(func() {
			defer wg.Done()
			if i%7 == 0 {
				time.Sleep(2 * time.Millisecond) // a slow job must not be overtaken
			}
			mu.Lock()
			got = append(got, i)
			mu.Unlock()
		})
	}
	wg.Wait()
	for i, v := range got {
		if v != i {
			t.Fatalf("serialLane reordered jobs: %v", got)
		}
	}
}

// TestSerialLaneSubmitNeverBlocks: submit is what the request loop calls, so it
// must return immediately even when the lane's current job is stuck.
func TestSerialLaneSubmitNeverBlocks(t *testing.T) {
	var lane serialLane
	release := make(chan struct{})
	lane.submit(func() { <-release })
	start := time.Now()
	for i := 0; i < 100; i++ {
		lane.submit(func() {})
	}
	if dt := time.Since(start); dt > 100*time.Millisecond {
		t.Fatalf("submit blocked behind a stuck job for %v", dt)
	}
	close(release)
}

// TestSendDoesNotWaitBehindExec: a send (the user's pasted text) rides the
// control lane, not the exec pool, so a slow probe cannot hold it.
func TestSendDoesNotWaitBehindExec(t *testing.T) {
	skipOnWindows(t)
	d, rs, _ := newTestDispatcher(t)
	d.handle(req("1", "exec", execParams{Script: "sleep 3", TimeoutMs: 8000}))
	time.Sleep(50 * time.Millisecond)
	d.handle(req("2", "sendKeys", sendKeysParams{Session: "warden-1491-no-such-session", Key: "Enter"}))
	// The send fails fast (no tmux session) — the point is it ANSWERS while the
	// exec is still sleeping.
	waitFor(t, 2*time.Second, "sendKeys response", func() bool { return rs.has("2") })
	if rs.has("1") {
		t.Fatalf("test invalid: exec finished first")
	}
	waitFor(t, 6*time.Second, "exec response", func() bool { return rs.has("1") })
}

// TestAttachInputKeepsKeystrokeOrder: keystrokes ride one ordered lane per
// session; concurrency must never reorder what the user typed.
func TestAttachInputKeepsKeystrokeOrder(t *testing.T) {
	skipOnWindows(t)
	d, rs, lines := newTestDispatcher(t)
	d.handle(req("1", "attachStart", attachStartParams{Script: "cat", Cols: 80, Rows: 24}))
	waitFor(t, 5*time.Second, "attachStart ack", func() bool { return rs.has("1") })
	ack, _ := rs.get("1")
	sid := ack.Result.(map[string]any)["sid"].(string)
	t.Cleanup(func() { b, _ := json.Marshal(attachSidParams{Sid: sid}); _ = attachKill(b) })

	const n = 60
	want := make([]string, 0, n)
	for i := 0; i < n; i++ {
		ch := string(rune('a'+(i%26))) + string(rune('A'+(i/26)))
		want = append(want, ch)
		d.handle(req(strings.Repeat("7", 1)+"0"+string(rune('0'+i%10)), "attachInput",
			attachInputParams{Sid: sid, Data: base64.StdEncoding.EncodeToString([]byte(ch))}))
	}
	d.handle(req("99", "attachInput", attachInputParams{Sid: sid, Data: base64.StdEncoding.EncodeToString([]byte("\n"))}))
	joined := strings.Join(want, "")
	waitFor(t, 5*time.Second, "all keystrokes echoed", func() bool { return strings.Contains(lines.dataString(sid), joined) })
}

// TestAttachInputUnknownSidAnswersOnTheLoop: bad input is still an immediate
// {ok:false}, never queued onto a lane that does not exist.
func TestAttachInputUnknownSidAnswersOnTheLoop(t *testing.T) {
	d, rs, _ := newTestDispatcher(t)
	d.handle(req("5", "attachInput", attachInputParams{Sid: "nope", Data: base64.StdEncoding.EncodeToString([]byte("x"))}))
	r, ok := rs.get("5")
	if !ok || r.OK || !strings.Contains(r.Error, "unknown attach session") {
		t.Fatalf("expected an immediate unknown-session error; got %+v ok=%v", r, ok)
	}
}

// TestDispatcherAnswersEveryMethodExactlyOnce: every advertised method gets
// exactly one response, whatever lane it rode (the id contract of the channel).
func TestDispatcherAnswersEveryMethodExactlyOnce(t *testing.T) {
	skipOnWindows(t)
	d, rs, _ := newTestDispatcher(t)
	d.handle(req("1", "ping", nil))
	d.handle(req("2", "no-such-method", nil))
	d.handle(req("3", "subscribePanes", capturePanesParams{}))
	d.handle(req("4", "unsubscribePanes", nil))
	d.handle(req("5", "attachResize", attachResizeParams{Sid: "nope", Cols: 80, Rows: 24}))
	d.handle(req("6", "attachKill", attachSidParams{Sid: "nope"}))
	d.handle(req("7", "exec", execParams{Script: "true"}))
	waitFor(t, 5*time.Second, "all responses", func() bool {
		for _, id := range []string{"1", "2", "3", "4", "5", "6", "7"} {
			if !rs.has(id) {
				return false
			}
		}
		return true
	})
	time.Sleep(50 * time.Millisecond)
	rs.mu.Lock()
	defer rs.mu.Unlock()
	counts := map[string]int{}
	for _, r := range rs.resps {
		counts[string(r.ID)]++
	}
	for id, c := range counts {
		if c != 1 {
			t.Fatalf("id %s answered %d times", id, c)
		}
	}
	if r, _ := func() (Response, bool) {
		for _, x := range rs.resps {
			if string(x.ID) == "2" {
				return x, true
			}
		}
		return Response{}, false
	}(); r.OK || !strings.Contains(r.Error, "unknown method") {
		t.Fatalf("unknown method must be refused; got %+v", r)
	}
}

// ----------------------------- subscription swap -----------------------------

func resetSubscriptionForTest(t *testing.T) {
	t.Helper()
	stopSubscription()
	t.Cleanup(stopSubscription)
}

// TestStartSubscriptionNeverWaitsOnTheCapture: replacing/stopping the watcher
// while its capture is mid-flight returns at once. The old shape closed `stop`
// and blocked on `done` — i.e. on the capture, a docker-exec-per-pane script
// with no deadline — on the request loop, once per released pane every 30s.
func TestStartSubscriptionNeverWaitsOnTheCapture(t *testing.T) {
	skipOnWindows(t)
	resetSubscriptionForTest(t)
	// A "pane" whose capture hangs: the container is a docker that sleeps. We
	// emulate with a bare-tmux session name — and PATH shadowing so `tmux`
	// sleeps 30s, standing in for a wedged `docker exec`.
	useCaptureScript(t, "sleep 30")
	lines := &collectLines{}
	startSubscription([]capturePaneReq{{Key: "a", Session: "a"}}, lines.write)
	time.Sleep(300 * time.Millisecond) // the first capture is now hung in the stub

	start := time.Now()
	startSubscription([]capturePaneReq{{Key: "a", Session: "a"}, {Key: "b", Session: "b"}}, lines.write)
	startSubscription([]capturePaneReq{{Key: "b", Session: "b"}}, lines.write)
	startSubscription(nil, lines.write) // unsubscribe
	if dt := time.Since(start); dt > 500*time.Millisecond {
		t.Fatalf("subscription changes blocked for %v on an in-flight capture — the request loop would freeze", dt)
	}
}

// TestStartSubscriptionSameSetIsNoOp: warden re-sends the full set on every TTL
// sweep; an unchanged set must not disturb the watcher (no restart, no re-push).
func TestStartSubscriptionSameSetIsNoOp(t *testing.T) {
	resetSubscriptionForTest(t)
	lines := &collectLines{}
	set := []capturePaneReq{{Key: "x", Session: "x"}, {Key: "y", Session: "y"}}
	startSubscription(set, lines.write)
	subMu.Lock()
	first := activeSub
	subMu.Unlock()
	startSubscription([]capturePaneReq{{Key: "y", Session: "y"}, {Key: "x", Session: "x"}}, lines.write) // same set, reordered
	subMu.Lock()
	second := activeSub
	subMu.Unlock()
	if first == nil || first != second {
		t.Fatalf("an identical pane set must keep the same watcher")
	}
	startSubscription([]capturePaneReq{{Key: "x", Session: "x"}}, lines.write)
	subMu.Lock()
	third := activeSub
	n := len(third.panes)
	subMu.Unlock()
	if third != first || n != 1 {
		t.Fatalf("a changed set must update the watcher IN PLACE (same watcher, new set); same=%v n=%d", third == first, n)
	}
}

// TestSubscriptionRetiredWatcherNeverPushes: after unsubscribe, a capture that
// finishes late must not push a stale snapshot (the paneDelta would revive the
// warden-side cache the unsubscribe just cleared).
func TestSubscriptionRetiredWatcherNeverPushes(t *testing.T) {
	skipOnWindows(t)
	resetSubscriptionForTest(t)
	useCaptureScript(t, "sleep 0.6; printf '___B_a___\\nlate\\n___E_a___\\n'")
	lines := &collectLines{}
	startSubscription([]capturePaneReq{{Key: "a", Session: "a"}}, lines.write)
	time.Sleep(150 * time.Millisecond) // capture in flight
	startSubscription(nil, lines.write)
	time.Sleep(1200 * time.Millisecond)
	for _, l := range lines.snapshot() {
		if _, ok := l.(paneDeltaEvent); ok {
			t.Fatalf("a retired watcher pushed a paneDelta after unsubscribe")
		}
	}
}

// TestWatcherCaptureIsBounded: one hung capture must not park the watcher
// forever (no pushes AND no heartbeat). It is abandoned at the bound and the
// next tick retries. The bound is shrunk for the test via the package vars.
func TestWatcherCaptureIsBounded(t *testing.T) {
	skipOnWindows(t)
	useCaptureScript(t, "sleep 60")
	ctx, cancel := contextWithCancelForTest()
	defer cancel()
	prev := subscribeCaptureBase
	subscribeCaptureBase = 600 * time.Millisecond
	defer func() { subscribeCaptureBase = prev }()
	start := time.Now()
	_, err := capturePanesListCtx(ctx, []capturePaneReq{{Key: "a", Session: "a"}})
	if err == nil {
		t.Fatalf("a hung capture must fail, not succeed")
	}
	if dt := time.Since(start); dt > 5*time.Second {
		t.Fatalf("capture ran %v — the bound did not hold", dt)
	}
}

// TestCaptureBoundScalesWithPaneCount: a legitimately slow capture of a large
// fleet must not be killed by a bound sized for one pane (that would starve the
// push entirely), and the bound is capped so a hung one is still abandoned.
func TestCaptureBoundScalesWithPaneCount(t *testing.T) {
	if subscribeCaptureBound(200) <= subscribeCaptureBound(1) {
		t.Fatalf("bound must grow with panes")
	}
	if subscribeCaptureBound(200) < 40*time.Second {
		t.Fatalf("a 200-pane fleet capture needs real headroom; got %v", subscribeCaptureBound(200))
	}
	if subscribeCaptureBound(100000) != subscribeCaptureMax {
		t.Fatalf("bound must be capped at %v", subscribeCaptureMax)
	}
}
