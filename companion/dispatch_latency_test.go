package main

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os/exec"
	"regexp"
	"strings"
	"testing"
	"time"
)

// WARDEN-1497 — latency-bound and ordering pins layered on the WARDEN-1491
// dispatcher (dispatch.go). 1491 landed the concurrency; these tests pin the
// ticket's sharper acceptance bounds that dispatch_test.go does not: the fast
// requests (ping, attachInput) answer inside a SMALL bound while a slow exec is
// in flight, the pipe-holder exec (setsid) does not pin the loop for
// timeoutMs+WaitDelay, rapid `send` RPCs to one session land in send order, and
// the ping `methods` list (the wire contract with deployed binaries) is stable.

// fastBound is the budget for a request that must NOT queue behind a slow one.
const fastBound = 250 * time.Millisecond

// TestPingAndKeystrokeAnswerFastBehindSlowExec: with a multi-second exec in
// flight, an attachInput to a live attach session and a ping are each answered
// inside fastBound. Against a serial loop both sat unread until the exec ended.
func TestPingAndKeystrokeAnswerFastBehindSlowExec(t *testing.T) {
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

	d.handle(req("2", "exec", execParams{Script: "sleep 3", TimeoutMs: 8000}))
	time.Sleep(100 * time.Millisecond)

	d.handle(req("3", "ping", map[string]any{}))
	waitFor(t, fastBound, "ping answered inside the fast bound", func() bool { return rs.has("3") })

	d.handle(req("4", "attachInput", attachInputParams{Sid: sid, Data: base64.StdEncoding.EncodeToString([]byte("FASTECHO\n"))}))
	waitFor(t, fastBound, "attachInput ack inside the fast bound", func() bool { return rs.has("4") })
	waitFor(t, fastBound, "keystroke echo inside the fast bound", func() bool { return strings.Contains(lines.dataString(sid), "FASTECHO") })
	if rs.has("2") {
		t.Fatalf("test invalid: the slow exec finished before the fast requests were measured")
	}
	waitFor(t, 6*time.Second, "slow exec response", func() bool { return rs.has("2") })
}

// TestPipeHolderExecDoesNotHoldTheLoop: `setsid sleep` detaches into its own
// session, so it survives the timeout kill AND holds the stdout pipe — pinning
// the exec's own completion to timeout+WaitDelay. The loop must be free long
// before that, so a ping answers inside fastBound while the exec is still out.
func TestPipeHolderExecDoesNotHoldTheLoop(t *testing.T) {
	skipOnWindows(t)
	d, rs, _ := newTestDispatcher(t)
	d.handle(req("1", "exec", execParams{Script: "setsid sleep 4 & sleep 30", TimeoutMs: 300}))
	time.Sleep(100 * time.Millisecond)
	d.handle(req("2", "ping", map[string]any{}))
	waitFor(t, fastBound, "ping answered while the pipe-holder exec is in flight", func() bool { return rs.has("2") })
	if rs.has("1") {
		t.Fatalf("test invalid: the exec had already answered")
	}
}

// TestRapidSendsToOneSessionApplyInOrder: many back-to-back `send` RPCs to one
// tmux session land in the pane in send order (the control lane is ordered).
func TestRapidSendsToOneSessionApplyInOrder(t *testing.T) {
	if !tmuxAvailable() {
		t.Skip("tmux not available")
	}
	session := uniqueSession()
	if out, err := exec.Command("tmux", "new-session", "-d", "-x", "120", "-y", "50", "-s", session, "cat").Output(); err != nil {
		t.Fatalf("tmux new-session failed: %v; %s", err, out)
	}
	defer exec.Command("tmux", "kill-session", "-t", session).Run()

	d, rs, _ := newTestDispatcher(t)
	const n = 12
	for i := 0; i < n; i++ {
		d.handle(req(fmt.Sprintf("%d", 100+i), "send", sendParams{Session: session, Text: fmt.Sprintf("SEND%02d", i)}))
	}
	for i := 0; i < n; i++ {
		id := fmt.Sprintf("%d", 100+i)
		waitFor(t, 20*time.Second, "send "+id, func() bool { return rs.has(id) })
	}
	waitForRendered(t, session, fmt.Sprintf("SEND%02d", n-1))
	out, _ := exec.Command("tmux", "capture-pane", "-t", session, "-p").Output()
	seen := map[string]bool{}
	var firsts []string
	for _, tok := range regexp.MustCompile(`SEND\d{2}`).FindAllString(string(out), -1) {
		if !seen[tok] {
			seen[tok] = true
			firsts = append(firsts, tok)
		}
	}
	if len(firsts) != n {
		t.Fatalf("expected %d sends on the pane, saw %v", n, firsts)
	}
	for i, tok := range firsts {
		if want := fmt.Sprintf("SEND%02d", i); tok != want {
			t.Fatalf("send %d landed as %s (want %s): %v", i, tok, want, firsts)
		}
	}
}

// TestPingMethodsListIsTheWireContract pins the ping `methods` list so deployed
// binaries and the JS client stay compatible in both directions.
func TestPingMethodsListIsTheWireContract(t *testing.T) {
	want := []string{
		"ping", "discover", "capturePanes", "hasSession", "spawnSession", "killSession",
		"resize", "send", "sendKeys", "subscribePanes", "unsubscribePanes", "exec",
		"writeFile",
	}
	if hostPTYSupported {
		want = append(want, "attachStart", "attachInput", "attachResize", "attachKill")
	}
	d, rs, _ := newTestDispatcher(t)
	d.handle(req("1", "ping", map[string]any{}))
	r, ok := rs.get("1")
	if !ok {
		t.Fatalf("ping not answered inline")
	}
	got, _ := json.Marshal(r.Result.(map[string]any)["methods"])
	wantJSON, _ := json.Marshal(want)
	if string(got) != string(wantJSON) {
		t.Fatalf("ping methods changed:\n got %s\nwant %s", got, wantJSON)
	}
}
