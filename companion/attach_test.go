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

// ---------------------------- attach RPC family ------------------------------
// WARDEN-1295. These drive the REAL attach path — a real host PTY running a real
// shell — rather than a mock, because the whole point of the slice is that the
// terminal semantics (a tty, byte-exact output, SIGWINCH on resize, a clean
// teardown) survive the move from `ssh -tt` to a host-side PTY. A mocked pty
// would assert only that JSON round-trips.

// collectLines is a writeLine sink that records emitted event lines and lets a
// test wait for one. Mirrors the shared writeLine contract in main(): every
// emitter (subscription watcher, attach pump) goes through one mutex-guarded
// function, so a test sink can be a plain slice under a lock.
type collectLines struct {
	mu    sync.Mutex
	lines []any
}

func (c *collectLines) write(v any) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.lines = append(c.lines, v)
}

func (c *collectLines) snapshot() []any {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]any(nil), c.lines...)
}

// dataString concatenates every attachData payload for sid, decoded from base64.
func (c *collectLines) dataString(sid string) string {
	var b strings.Builder
	for _, l := range c.snapshot() {
		if ev, ok := l.(attachDataEvent); ok && ev.Sid == sid {
			raw, err := base64.StdEncoding.DecodeString(ev.Data)
			if err == nil {
				b.Write(raw)
			}
		}
	}
	return b.String()
}

func (c *collectLines) exitFor(sid string) (attachExitEvent, bool) {
	for _, l := range c.snapshot() {
		if ev, ok := l.(attachExitEvent); ok && ev.Sid == sid {
			return ev, true
		}
	}
	return attachExitEvent{}, false
}

// waitFor polls cond until it holds or the deadline passes.
func waitFor(t *testing.T, d time.Duration, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(d)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

func startForTest(t *testing.T, sink *collectLines, p attachStartParams) string {
	t.Helper()
	raw, err := json.Marshal(p)
	if err != nil {
		t.Fatalf("marshal params: %v", err)
	}
	sid, launch, err := startAttach(raw, sink.write)
	if err != nil {
		t.Fatalf("startAttach: %v", err)
	}
	launch()
	t.Cleanup(func() {
		b, _ := json.Marshal(attachSidParams{Sid: sid})
		_ = attachKill(b)
	})
	return sid
}

func callInput(t *testing.T, sid, data string) error {
	t.Helper()
	b, _ := json.Marshal(attachInputParams{Sid: sid, Data: base64.StdEncoding.EncodeToString([]byte(data))})
	return attachInput(b)
}

// TestPingAdvertisesAttachMethods pins the feature-detect contract: warden gates
// the whole companion attach path on these names appearing in the ping `methods`
// list (channelMethods → attachPreflight), and a Windows build must NOT advertise
// them because it cannot allocate a PTY (pty_windows.go). The list is the ONE
// mechanism serving both the stale-binary gate and platform honesty.
func TestPingAdvertisesAttachMethods(t *testing.T) {
	methods := pingMethods()
	has := func(m string) bool {
		for _, v := range methods {
			if v == m {
				return true
			}
		}
		return false
	}
	// The pre-existing families must survive the append — a regression here would
	// silently disable send/exec/subscribePanes on every host.
	for _, m := range baseMethods {
		if !has(m) {
			t.Fatalf("ping methods dropped the base RPC %q: %v", m, methods)
		}
	}
	for _, m := range attachMethods {
		if has(m) != hostPTYSupported {
			t.Fatalf("attach method %q advertised=%v but hostPTYSupported=%v (a build that cannot allocate a PTY must not claim the attach RPCs)",
				m, has(m), hostPTYSupported)
		}
	}
}

// TestAttachStartRunsDeliveredScriptUnderAPTY is the PARITY-adjacent test: the
// script the Go side runs is executed VERBATIM (never rebuilt host-side), and it
// runs under a real terminal. `tty -s` exits 0 only on a real tty, so a run that
// prints TTY=yes proves the PTY is genuinely allocated rather than a pipe pair —
// the difference tmux and every full-screen program actually care about.
func TestAttachStartRunsDeliveredScriptUnderAPTY(t *testing.T) {
	if !hostPTYSupported {
		t.Skip("host PTY unsupported on this platform")
	}
	sink := &collectLines{}
	sid := startForTest(t, sink, attachStartParams{
		Script: `if tty -s; then echo TTY=yes; else echo TTY=no; fi; echo COLS=$(tput cols)`,
		Cols:   137, Rows: 41, Term: "xterm-256color",
	})
	waitFor(t, 5*time.Second, "attachExit", func() bool {
		_, ok := sink.exitFor(sid)
		return ok
	})
	out := sink.dataString(sid)
	if !strings.Contains(out, "TTY=yes") {
		t.Fatalf("the delivered script did not run under a tty; output: %q", out)
	}
	// The requested winsize must reach the child: tput reads it from the terminal,
	// so this proves attachStart's cols/rows are applied at ALLOCATION time (not
	// only via a later attachResize).
	if !strings.Contains(out, "COLS=137") {
		t.Fatalf("attachStart cols were not applied to the PTY; output: %q", out)
	}
}

// TestAttachStartAppliesTerm pins the TERM forwarding. On the default path
// node-pty puts TERM on the ssh child and `ssh -tt` propagates it to the host;
// the companion path must do the same or a remote tmux renders with the wrong
// terminfo (no colors, broken key handling).
func TestAttachStartAppliesTerm(t *testing.T) {
	if !hostPTYSupported {
		t.Skip("host PTY unsupported on this platform")
	}
	sink := &collectLines{}
	sid := startForTest(t, sink, attachStartParams{Script: `echo TERM=$TERM`, Cols: 80, Rows: 24, Term: "xterm-256color"})
	waitFor(t, 5*time.Second, "attachExit", func() bool { _, ok := sink.exitFor(sid); return ok })
	if out := sink.dataString(sid); !strings.Contains(out, "TERM=xterm-256color") {
		t.Fatalf("TERM was not forwarded to the child; output: %q", out)
	}
}

// TestAttachStartDefaultsTerm — an absent term must not leave the child with an
// EMPTY TERM (which makes ncurses programs refuse to start). node-pty's own
// DEFAULT_NAME is 'xterm'; the companion matches it.
func TestAttachStartDefaultsTerm(t *testing.T) {
	if !hostPTYSupported {
		t.Skip("host PTY unsupported on this platform")
	}
	sink := &collectLines{}
	sid := startForTest(t, sink, attachStartParams{Script: `echo TERM=$TERM`, Cols: 80, Rows: 24})
	waitFor(t, 5*time.Second, "attachExit", func() bool { _, ok := sink.exitFor(sid); return ok })
	if out := sink.dataString(sid); !strings.Contains(out, "TERM=xterm") {
		t.Fatalf("absent term must default to node-pty's 'xterm'; output: %q", out)
	}
}

// TestAttachInputReachesTheTerminal drives the WRITE half: base64 input decoded
// and written to the master must be read by the child as terminal input.
func TestAttachInputReachesTheTerminal(t *testing.T) {
	if !hostPTYSupported {
		t.Skip("host PTY unsupported on this platform")
	}
	sink := &collectLines{}
	// `read` blocks on the tty until the input line arrives — so the echo can only
	// happen if attachInput really reached the terminal.
	sid := startForTest(t, sink, attachStartParams{Script: `read line; echo GOT=$line`, Cols: 80, Rows: 24})
	waitFor(t, 3*time.Second, "the child to start reading", func() bool { return getAttachSession(sid) != nil })
	if err := callInput(t, sid, "hello\n"); err != nil {
		t.Fatalf("attachInput: %v", err)
	}
	waitFor(t, 5*time.Second, "the echoed input", func() bool {
		return strings.Contains(sink.dataString(sid), "GOT=hello")
	})
}

// TestAttachInputRejectsBadBase64 — the wire payload is attacker-adjacent input
// (it crosses the channel), so a malformed frame must be a clean RPC error, not
// a partial write of garbage into a live terminal.
func TestAttachInputRejectsBadBase64(t *testing.T) {
	if !hostPTYSupported {
		t.Skip("host PTY unsupported on this platform")
	}
	sink := &collectLines{}
	sid := startForTest(t, sink, attachStartParams{Script: `sleep 5`, Cols: 80, Rows: 24})
	b, _ := json.Marshal(attachInputParams{Sid: sid, Data: "not!valid!base64"})
	if err := attachInput(b); err == nil || !strings.Contains(err.Error(), "base64") {
		t.Fatalf("expected a base64 error, got %v", err)
	}
}

// TestAttachResizeSignalsTheChild is the RESIZE contract: TIOCSWINSZ must deliver
// SIGWINCH to the foreground process group, which is what makes tmux re-render on
// a browser window resize. Asserting the trap fires proves the SIGNAL was
// delivered, not merely that a winsize struct was stored.
func TestAttachResizeSignalsTheChild(t *testing.T) {
	if !hostPTYSupported {
		t.Skip("host PTY unsupported on this platform")
	}
	sink := &collectLines{}
	// The trap body runs only when bash regains control between commands, so the
	// wait loop uses SHORT sleeps rather than one long one — a bash `trap` on a
	// blocking foreground `sleep 30` is deferred until that sleep returns.
	sid := startForTest(t, sink, attachStartParams{
		Script: `trap 'echo WINCH=$(tput cols)' WINCH; echo READY; for i in $(seq 1 100); do sleep 0.1; done`,
		Cols:   80, Rows: 24,
	})
	waitFor(t, 5*time.Second, "the child's trap to be armed", func() bool {
		return strings.Contains(sink.dataString(sid), "READY")
	})
	b, _ := json.Marshal(attachResizeParams{Sid: sid, Cols: 132, Rows: 50})
	if err := attachResize(b); err != nil {
		t.Fatalf("attachResize: %v", err)
	}
	waitFor(t, 5*time.Second, "the SIGWINCH trap to fire with the new width", func() bool {
		return strings.Contains(sink.dataString(sid), "WINCH=132")
	})
}

// TestAttachKillTearsDownAndEmitsExactlyOneExit is the WARDEN-365-adjacent
// host-side half. The JS wrapper guarantees one onExit per session, but it can
// only do that if the host emits at most one attachExit — a kill racing the
// child's natural exit must not produce two 'ended' frames for one pane.
func TestAttachKillTearsDownAndEmitsExactlyOneExit(t *testing.T) {
	if !hostPTYSupported {
		t.Skip("host PTY unsupported on this platform")
	}
	sink := &collectLines{}
	sid := startForTest(t, sink, attachStartParams{Script: `echo READY; sleep 30`, Cols: 80, Rows: 24})
	waitFor(t, 5*time.Second, "the child to start", func() bool {
		return strings.Contains(sink.dataString(sid), "READY")
	})
	b, _ := json.Marshal(attachSidParams{Sid: sid})
	if err := attachKill(b); err != nil {
		t.Fatalf("attachKill: %v", err)
	}
	waitFor(t, 5*time.Second, "attachExit after kill", func() bool { _, ok := sink.exitFor(sid); return ok })
	// A second kill of the now-dead session is IDEMPOTENT (mirrors killSession):
	// a detach→attach race must never surface a spurious failure at warden's
	// best-effort kill call site.
	if err := attachKill(b); err != nil {
		t.Fatalf("attachKill on an already-gone session must be a benign ok, got %v", err)
	}
	// Settle, then count: exactly one exit for this sid, ever.
	time.Sleep(200 * time.Millisecond)
	n := 0
	for _, l := range sink.snapshot() {
		if ev, ok := l.(attachExitEvent); ok && ev.Sid == sid {
			n++
		}
	}
	if n != 1 {
		t.Fatalf("expected exactly ONE attachExit for %s, got %d — a duplicate 'ended' is what WARDEN-365's identity gate exists to prevent", sid, n)
	}
	if getAttachSession(sid) != nil {
		t.Fatalf("session %s was not deregistered after exit", sid)
	}
}

// TestAttachExitCarriesTheChildExitCode — server.js forwards the code into the
// pane's `ended` frame, so a wrong code is user-visible.
func TestAttachExitCarriesTheChildExitCode(t *testing.T) {
	if !hostPTYSupported {
		t.Skip("host PTY unsupported on this platform")
	}
	sink := &collectLines{}
	sid := startForTest(t, sink, attachStartParams{Script: `exit 7`, Cols: 80, Rows: 24})
	waitFor(t, 5*time.Second, "attachExit", func() bool { _, ok := sink.exitFor(sid); return ok })
	ev, _ := sink.exitFor(sid)
	if ev.Code != 7 {
		t.Fatalf("expected exit code 7, got %d", ev.Code)
	}
}

// TestAttachStreamsBytesExactly is the FRAMING contract. PTY output is arbitrary
// binary — ANSI control sequences, multibyte UTF-8, and \n itself — and the
// channel is line-delimited JSON. base64 is what makes those coexist; this proves
// the bytes survive the round trip unchanged, including a byte sequence that
// would be destroyed by a lossy text encoding.
func TestAttachStreamsBytesExactly(t *testing.T) {
	if !hostPTYSupported {
		t.Skip("host PTY unsupported on this platform")
	}
	sink := &collectLines{}
	// A CSI color sequence, a multibyte box-drawing glyph, and an embedded newline
	// — the exact payload shape a tmux repaint produces.
	sid := startForTest(t, sink, attachStartParams{
		Script: `printf '\033[31m\342\224\202RED\033[0m\nSECOND\n'`,
		Cols:   80, Rows: 24,
	})
	waitFor(t, 5*time.Second, "attachExit", func() bool { _, ok := sink.exitFor(sid); return ok })
	out := sink.dataString(sid)
	if !strings.Contains(out, "\x1b[31m") || !strings.Contains(out, "\x1b[0m") {
		t.Fatalf("ANSI control sequences did not survive framing: %q", out)
	}
	if !strings.Contains(out, "\u2502RED") {
		t.Fatalf("multibyte glyph did not survive framing: %q", out)
	}
	if !strings.Contains(out, "SECOND") {
		t.Fatalf("content after an embedded newline was lost: %q", out)
	}
}

// TestAttachStartRejectsAnEmptyScript — an empty script would allocate a PTY for
// a shell that instantly exits, presenting as a pane that opens and dies. Refuse
// it up front so the failure names itself.
func TestAttachStartRejectsAnEmptyScript(t *testing.T) {
	sink := &collectLines{}
	if _, _, err := startAttach(json.RawMessage(`{"cols":80,"rows":24}`), sink.write); err == nil {
		t.Fatal("expected an error for an empty script")
	}
}

// TestAttachStartOnAnUnsupportedPlatformIsActionable — the windows build must
// return an error a HUMAN can act on (how to get back to the default SSH path),
// not a bare failure. On unix this asserts the opposite half of the same
// contract: a supported host really can allocate.
func TestAttachStartOnAnUnsupportedPlatformIsActionable(t *testing.T) {
	sink := &collectLines{}
	sid, launch, err := startAttach(json.RawMessage(`{"script":"true","cols":80,"rows":24}`), sink.write)
	if hostPTYSupported {
		if err != nil {
			t.Fatalf("a host with PTY support must allocate: %v", err)
		}
		launch()
		b, _ := json.Marshal(attachSidParams{Sid: sid})
		_ = attachKill(b)
		return
	}
	if err == nil {
		t.Fatal("a platform without PTY support must return an error")
	}
	msg := err.Error()
	if !strings.Contains(msg, "WARDEN_COMPANION_TRANSPORT=0") {
		t.Fatalf("the error must tell the user how to reach the default SSH path: %q", msg)
	}
}

// TestUnknownSidIsAnError — input/resize against a session that already exited
// must be a named error, so a wedged pane is diagnosable rather than silently
// swallowing keystrokes.
func TestUnknownSidIsAnError(t *testing.T) {
	b, _ := json.Marshal(attachInputParams{Sid: "nope", Data: base64.StdEncoding.EncodeToString([]byte("x"))})
	if err := attachInput(b); err == nil || !strings.Contains(err.Error(), "unknown attach session") {
		t.Fatalf("expected an unknown-session error, got %v", err)
	}
	r, _ := json.Marshal(attachResizeParams{Sid: "nope", Cols: 80, Rows: 24})
	if err := attachResize(r); err == nil || !strings.Contains(err.Error(), "unknown attach session") {
		t.Fatalf("expected an unknown-session error, got %v", err)
	}
}

// TestStopAllAttachSessionsOnChannelClose — when stdin closes (the channel died),
// every live attach must be torn down. Otherwise a warden restart leaves orphaned
// host-side PTYs, each holding a tmux client, accumulating per reconnect.
func TestStopAllAttachSessionsOnChannelClose(t *testing.T) {
	if !hostPTYSupported {
		t.Skip("host PTY unsupported on this platform")
	}
	sink := &collectLines{}
	sid := startForTest(t, sink, attachStartParams{Script: `echo READY; sleep 30`, Cols: 80, Rows: 24})
	waitFor(t, 5*time.Second, "the child to start", func() bool {
		return strings.Contains(sink.dataString(sid), "READY")
	})
	stopAllAttachSessions()
	waitFor(t, 5*time.Second, "the session to be reaped", func() bool { return getAttachSession(sid) == nil })
	if _attachSessionCountForTests() != 0 {
		t.Fatalf("expected no live sessions after a channel close, got %d", _attachSessionCountForTests())
	}
}

// TestConcurrentAttachSessionsAreIndependent — one channel multiplexes every
// pane, so two attaches must not cross-feed. The sid is the whole discriminator
// (warden's wrapper filters on it), so the host must never reuse one.
func TestConcurrentAttachSessionsAreIndependent(t *testing.T) {
	if !hostPTYSupported {
		t.Skip("host PTY unsupported on this platform")
	}
	sink := &collectLines{}
	a := startForTest(t, sink, attachStartParams{Script: `echo ALPHA; sleep 2`, Cols: 80, Rows: 24})
	b := startForTest(t, sink, attachStartParams{Script: `echo BETA; sleep 2`, Cols: 80, Rows: 24})
	if a == b {
		t.Fatalf("two concurrent attaches got the same sid %q — the sid is the ONLY discriminator on the shared channel", a)
	}
	waitFor(t, 5*time.Second, "both streams", func() bool {
		return strings.Contains(sink.dataString(a), "ALPHA") && strings.Contains(sink.dataString(b), "BETA")
	})
	if strings.Contains(sink.dataString(a), "BETA") || strings.Contains(sink.dataString(b), "ALPHA") {
		t.Fatal("attach streams cross-fed: one pane received another's output")
	}
}

// TestClampDim pins the host-side backstop on wire-supplied dimensions. warden
// floors cols/rows server-side already, but a malformed param must not produce a
// 0x0 terminal (every full-screen program misrenders) or overflow a uint16.
func TestClampDim(t *testing.T) {
	cases := []struct {
		in, def int
		want    uint16
	}{
		{0, 100, 100},       // absent -> attachPty's default
		{-5, 30, 30},        // negative -> default
		{137, 100, 137},     // ordinary
		{99999, 100, 65535}, // overflow -> clamped, never wrapped
	}
	for _, c := range cases {
		if got := clampDim(c.in, c.def); got != c.want {
			t.Fatalf("clampDim(%d,%d) = %d, want %d", c.in, c.def, got, c.want)
		}
	}
}

// TestHostPTYSupportedMatchesPlatform documents the platform split as an
// assertion rather than only a comment: unix builds allocate, windows does not.
func TestHostPTYSupportedMatchesPlatform(t *testing.T) {
	want := runtime.GOOS != "windows"
	if hostPTYSupported != want {
		t.Fatalf("hostPTYSupported=%v on %s, want %v", hostPTYSupported, runtime.GOOS, want)
	}
}
