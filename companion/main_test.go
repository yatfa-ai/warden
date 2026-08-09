package main

import (
	"encoding/json"
	"os/exec"
	"strings"
	"testing"
	"time"
)

// tmuxAvailable reports whether a real tmux is on PATH (the subscribe watcher's
// captureOnce drives a live tmux session, mirroring the Node e2e parity tests).
func tmuxAvailable() bool {
	out, err := exec.Command("tmux", "-V").Output()
	return err == nil && len(strings.TrimSpace(string(out))) > 0
}

func uniqueSession() string {
	return "warden-test-" + strings.ReplaceAll(time.Now().Format("150405.000000"), ".", "-")
}

// waitForRendered polls the pane until marker appears in its capture (or a short
// timeout elapses). new-session -d returns before the shell has drawn its prompt,
// so two back-to-back captures can straddle the render: capture #1 catches the
// pre-prompt pane, capture #2 catches the rendered prompt — a spurious "change"
// that breaks the heartbeat's empty-diff assertion (~5% flaky, WARDEN-413 review).
// Waiting for a marker we send AFTER the prompt guarantees the pane is fully
// rendered and STABLE before the test's captures begin. Mirrors the Node parity
// test, which seeds content with an explicit send-keys marker before asserting.
func waitForRendered(t *testing.T, session, marker string) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		out, err := exec.Command("tmux", "capture-pane", "-t", session, "-p").Output()
		if err == nil && strings.Contains(string(out), marker) {
			// One more yield so any in-flight redraw flushes, then the pane is stable.
			time.Sleep(30 * time.Millisecond)
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("marker %q never rendered in tmux session %s", marker, session)
}

// TestBuildActivityScript locks the byte-exact, sentinel-framed leading-line
// capture script the companion runs host-side for activity (WARDEN-376). It must
// run the SAME per-container command the default SSH discover path runs
// (src/chats.js): `docker exec <c> tmux capture-pane -t <session> -p -S - -E -
// 2>/dev/null | head -1`, ___B_/___E_ sentinel-bracketed so parseCaptureSentinels
// recovers a name→line map. The timestamp PARSING stays in JS (parseActivityTimestamp);
// Go only captures + emits the raw line, so the framing is the contract under test.
func TestBuildActivityScript(t *testing.T) {
	t.Run("single active container, default session", func(t *testing.T) {
		got := buildActivityScript([]string{"p-worker"}, "agent")
		want := "printf '___B_p-worker___\\n'; docker exec 'p-worker' tmux capture-pane -t 'agent' -p -S - -E - 2>/dev/null | head -1; printf '\\n___E_p-worker___\\n'"
		if got != want {
			t.Fatalf("buildActivityScript mismatch:\ngot:  %s\nwant: %s", got, want)
		}
	})

	t.Run("empty session defaults to agent", func(t *testing.T) {
		got := buildActivityScript([]string{"p-worker"}, "")
		if !strings.Contains(got, "capture-pane -t 'agent' ") {
			t.Fatalf("expected session to default to 'agent'; got: %s", got)
		}
	})

	t.Run("custom session is shellQuoted", func(t *testing.T) {
		got := buildActivityScript([]string{"p-worker"}, "my session")
		if !strings.Contains(got, "capture-pane -t 'my session' ") {
			t.Fatalf("expected shellQuoted custom session; got: %s", got)
		}
	})

	t.Run("multiple active containers joined with '; ', order preserved", func(t *testing.T) {
		got := buildActivityScript([]string{"a-worker", "b-planner"}, "agent")
		ai := strings.Index(got, "___B_a-worker___")
		bi := strings.Index(got, "___B_b-planner___")
		if ai < 0 || bi < 0 || ai > bi {
			t.Fatalf("expected a-worker before b-planner; got: %s", got)
		}
		if c := strings.Count(got, "___B_"); c != 2 {
			t.Fatalf("expected 2 begin sentinels; got %d", c)
		}
		if c := strings.Count(got, "___E_"); c != 2 {
			t.Fatalf("expected 2 end sentinels; got %d", c)
		}
	})

	t.Run("container name with an apostrophe is shellQuoted", func(t *testing.T) {
		got := buildActivityScript([]string{"c'x"}, "agent")
		if !strings.Contains(got, "docker exec 'c'\\''x' tmux") {
			t.Fatalf("expected shellQuoted container; got: %s", got)
		}
	})
}

// TestBuildActivityScriptRoundTripViaBash runs the real buildActivityScript
// output through bash with a stubbed docker() that emits a leading timestamped
// line, then parses the sentinel framing with parseCaptureSentinels — proving
// the Go activity script + the (Go and JS) sentinel parser interop for the
// activity path. Mirrors the JS capturePanes bash-validation (companion.test.js)
// and the parity contract: the raw line the companion emits is the line the JS
// parseActivityTimestamp parses. (WARDEN-376)
func TestBuildActivityScriptRoundTripViaBash(t *testing.T) {
	// Stub docker as a shell function: `docker exec <c> ...` echoes a leading
	// timestamped line (what `tmux capture-pane | head -1` would yield).
	const stub = "docker() { if [ \"$1\" = exec ]; then echo \"[2024-01-15 10:30:00] worker thinking\"; fi; }\n"
	script := buildActivityScript([]string{"a-worker", "b-planner"}, "agent")
	out, err := exec.Command("bash", "-c", stub+script).Output()
	if err != nil {
		t.Fatalf("bash run failed: %v; output: %s", err, out)
	}
	m := parseCaptureSentinels(string(out))
	if len(m) != 2 {
		t.Fatalf("expected 2 captured lines; got %d: %v", len(m), m)
	}
	for _, key := range []string{"a-worker", "b-planner"} {
		line, ok := m[key]
		if !ok {
			t.Fatalf("expected key %q in parsed map; got %v", key, m)
		}
		if got := strings.TrimSpace(line); !strings.Contains(got, "[2024-01-15 10:30:00] worker thinking") {
			t.Fatalf("key %q: expected the timestamped leading line; got %q", key, line)
		}
	}
}

// TestBuildActivityScriptRoundTripNoOutput: a stub that emits nothing (e.g. an
// empty pane) yields an empty/absent value, which leaves Pane empty so JS
// parseActivityTimestamp returns null and lastActivity stays null — discover
// still succeeds with no Pane. (WARDEN-376)
func TestBuildActivityScriptRoundTripNoOutput(t *testing.T) {
	const stub = "docker() { :; }\n" // `docker exec …` emits nothing
	script := buildActivityScript([]string{"p-worker"}, "agent")
	out, err := exec.Command("bash", "-c", stub+script).Output()
	if err != nil {
		t.Fatalf("bash run failed: %v; output: %s", err, out)
	}
	m := parseCaptureSentinels(string(out))
	// Either absent or empty — both leave Pane empty → JS parses null.
	if line, ok := m["p-worker"]; ok && strings.TrimSpace(line) != "" {
		t.Fatalf("expected empty/absent capture for an emitting-nothing stub; got %q", line)
	}
}

// TestBuildResizeScript locks the byte-exact resize command the companion runs
// host-side (WARDEN-409). It must build the SAME `set-option -t <target>
// window-size latest` src/tmux.js resize() runs over runTmux — `docker exec <c>
// tmux` when a container is set, else bare `tmux`, with the target shellQuoted and
// defaulting to "agent". The command string is the contract under test (the
// "both paths agree by construction" parity).
func TestBuildResizeScript(t *testing.T) {
	t.Run("yatfa chat: docker exec prefix, agent session", func(t *testing.T) {
		got := buildResizeScript("p-worker", "agent")
		want := "docker exec 'p-worker' tmux set-option -t 'agent' window-size latest"
		if got != want {
			t.Fatalf("buildResizeScript mismatch:\ngot:  %s\nwant: %s", got, want)
		}
	})

	t.Run("bare-tmux chat: no container, custom session shellQuoted", func(t *testing.T) {
		got := buildResizeScript("", "my session")
		want := "tmux set-option -t 'my session' window-size latest"
		if got != want {
			t.Fatalf("bare-tmux resize mismatch:\ngot:  %s\nwant: %s", got, want)
		}
	})

	t.Run("empty target defaults to agent", func(t *testing.T) {
		got := buildResizeScript("p-worker", "")
		if !strings.Contains(got, "set-option -t 'agent' window-size latest") {
			t.Fatalf("expected target to default to 'agent'; got: %s", got)
		}
	})

	t.Run("container name with an apostrophe is shellQuoted", func(t *testing.T) {
		got := buildResizeScript("c'x", "agent")
		if !strings.Contains(got, "docker exec 'c'\\''x' tmux") {
			t.Fatalf("expected shellQuoted container; got: %s", got)
		}
	})
}

// ------------------------------- subscribePanes --------------------------------
// WARDEN-413 (problem #3 of roadmap WARDEN-270): the host PUSHES pane-output
// deltas instead of being polled. The watcher's change detection is a pure
// content-hash diff (hashContent + diffPanes); the push path (captureOnce +
// loop) drives the SAME batched capturePanes capture used by the RPC. These tests
// pin the diff contract (the part that decides what gets pushed) and the
// capture→push path against a live tmux session.

func TestHashContent(t *testing.T) {
	// Deterministic: same input -> same digest.
	if hashContent("hello") != hashContent("hello") {
		t.Fatal("hashContent is not deterministic for identical input")
	}
	// Distinct: different input -> different digest (the change signal must not
	// collide for realistic pane content).
	if hashContent("line1") == hashContent("line2") {
		t.Fatal("hashContent collided for distinct inputs")
	}
	// Empty content is a valid, stable digest (an empty pane is a real state).
	if hashContent("") == "" {
		t.Fatal("hashContent('') returned an empty digest")
	}
}

func TestDiffPanes(t *testing.T) {
	t.Run("initial capture marks every pane changed (seeds the cache)", func(t *testing.T) {
		hashes := map[string]string{}
		changed := diffPanes(map[string]string{"a": "x", "b": "y"}, hashes)
		if len(changed) != 2 {
			t.Fatalf("expected both panes changed on first diff; got %d", len(changed))
		}
		if changed["a"] != "x" || changed["b"] != "y" {
			t.Fatalf("changed map carries the content; got %v", changed)
		}
		if len(hashes) != 2 {
			t.Fatalf("hashes seeded for every pane; got %d", len(hashes))
		}
	})

	t.Run("unchanged content yields no changes", func(t *testing.T) {
		hashes := map[string]string{"a": hashContent("x")}
		changed := diffPanes(map[string]string{"a": "x"}, hashes)
		if len(changed) != 0 {
			t.Fatalf("stable pane must not be re-pushed; got %v", changed)
		}
	})

	t.Run("only the changed pane is pushed", func(t *testing.T) {
		hashes := map[string]string{"a": hashContent("x"), "b": hashContent("y")}
		changed := diffPanes(map[string]string{"a": "x", "b": "CHANGED"}, hashes)
		if len(changed) != 1 || changed["b"] != "CHANGED" {
			t.Fatalf("expected only b changed; got %v", changed)
		}
	})

	t.Run("a pane that left the set is dropped from hashes", func(t *testing.T) {
		hashes := map[string]string{"a": hashContent("x"), "b": hashContent("y")}
		diffPanes(map[string]string{"a": "x"}, hashes) // b vanished
		if _, ok := hashes["b"]; ok {
			t.Fatalf("vanished pane b must be dropped from hashes; got %v", hashes)
		}
	})
}

// TestCaptureOncePushesInitialDelta drives the watcher's push path (captureOnce
// -> capturePanesList -> diffPanes -> writeLine) against a REAL tmux session: an
// empty hash map means the first capture marks every pane changed and pushes the
// full content — the "initial capture" that seeds warden's cache within ~one
// interval of the ACK. No ticker/timing involved; one batched capture. Skipped
// without tmux.
func TestCaptureOncePushesInitialDelta(t *testing.T) {
	if !tmuxAvailable() {
		t.Skip("tmux not available")
	}
	session := uniqueSession()
	if out, err := exec.Command("tmux", "new-session", "-d", "-s", session).Output(); err != nil {
		t.Fatalf("tmux new-session failed: %v; %s", err, out)
	}
	defer exec.Command("tmux", "kill-session", "-t", session).Run()
	exec.Command("tmux", "send-keys", "-t", session, "WARDEN_PUSH_MARKER_7").Run()
	// Wait for the marker to render so the pane is stable before the back-to-back
	// captures (eliminates the new-session render race — see waitForRendered).
	waitForRendered(t, session, "WARDEN_PUSH_MARKER_7")

	s := &paneSubscription{
		panes:  []capturePaneReq{{Key: session, Container: "", Session: session}},
		hashes: map[string]string{},
	}
	var emitted []paneDeltaEvent
	writeLine := func(v any) {
		if e, ok := v.(paneDeltaEvent); ok {
			emitted = append(emitted, e)
		}
	}
	lastEmit := time.Now()
	s.captureOnce(writeLine, &lastEmit, lastEmit)

	if len(emitted) != 1 {
		t.Fatalf("expected one paneDelta on the initial capture; got %d", len(emitted))
	}
	if emitted[0].Event != "paneDelta" {
		t.Fatalf("event name is paneDelta; got %q", emitted[0].Event)
	}
	content, ok := emitted[0].Panes[session]
	if !ok {
		t.Fatalf("paneDelta pushed the pane under its key %q; got %v", session, emitted[0].Panes)
	}
	if !strings.Contains(content, "WARDEN_PUSH_MARKER_7") {
		t.Fatalf("pushed content includes the marker; got:\n%s", content)
	}

	// A second capture with no content change pushes nothing (the diff is empty
	// and the heartbeat is not yet due) — this is the idle case: no paneDelta.
	s.captureOnce(writeLine, &lastEmit, lastEmit)
	if len(emitted) != 1 {
		t.Fatalf("an unchanged pane with no heartbeat due must NOT be re-pushed; got %d events", len(emitted))
	}
}

// TestCaptureOnceHeartbeat: once the heartbeat interval elapses with no change,
// captureOnce pushes an EMPTY-panes paneDelta — the liveness heartbeat that keeps
// warden out of its poll backstop without re-transferring pane content.
func TestCaptureOnceHeartbeat(t *testing.T) {
	if !tmuxAvailable() {
		t.Skip("tmux not available")
	}
	session := uniqueSession()
	if out, err := exec.Command("tmux", "new-session", "-d", "-s", session).Output(); err != nil {
		t.Fatalf("tmux new-session failed: %v; %s", err, out)
	}
	defer exec.Command("tmux", "kill-session", "-t", session).Run()
	// Seed a marker and wait for it to render so both captures see a STABLE pane.
	// Without this, capture #1 can straddle the shell's first prompt render, the
	// content then differs on capture #2, and the heartbeat's empty-diff assertion
	// fails (~5% flaky). The marker is drawn after the prompt, so once it is visible
	// the pane is fully rendered. (WARDEN-413 test-stability fix.)
	exec.Command("tmux", "send-keys", "-t", session, "WARDEN_HB_STABLE").Run()
	waitForRendered(t, session, "WARDEN_HB_STABLE")

	s := &paneSubscription{
		panes:  []capturePaneReq{{Key: session, Container: "", Session: session}},
		hashes: map[string]string{},
	}
	var emitted []paneDeltaEvent
	writeLine := func(v any) {
		if e, ok := v.(paneDeltaEvent); ok {
			emitted = append(emitted, e)
		}
	}
	// loop() keeps lastEmit and the tick time in SEPARATE variables; mirror that
	// here so advancing the tick does not also advance lastEmit.
	lastEmit := time.Now()
	s.captureOnce(writeLine, &lastEmit, lastEmit) // initial: pushes full content
	if len(emitted) != 1 || len(emitted[0].Panes) != 1 {
		t.Fatalf("initial push carries the pane; got %v", emitted)
	}
	// Advance the tick time past the heartbeat interval with no content change.
	// lastEmit is unchanged (the prior push reset it), so the heartbeat is now due.
	now := lastEmit.Add(subscribeHeartbeat + time.Second)
	s.captureOnce(writeLine, &lastEmit, now)
	if len(emitted) != 2 {
		t.Fatalf("a heartbeat-due idle tick must push an empty paneDelta; got %d events", len(emitted))
	}
	if len(emitted[1].Panes) != 0 {
		t.Fatalf("heartbeat paneDelta carries NO panes (liveness only); got %v", emitted[1].Panes)
	}
}

// ------------------------------- send / sendKeys --------------------------------
// WARDEN-888 (the final slice): the user-input WRITE path. buildSendScript must
// reproduce src/tmux.js send()'s WARDEN-254 bracketed-paste sequence in ONE
// atomic bash -lc script — byte-for-byte the SAME tmux argv the default runTmux
// path issues (single-line send-keys -l + Enter; multiline set-buffer /
// paste-buffer -p -d / send-keys Enter with a delete-buffer cleanup that does NOT
// mask the failure exit code). buildSendKeysScript must reproduce sendKey()'s
// `send-keys -t <target> <key>`.

func TestBuildSendScript(t *testing.T) {
	t.Run("single-line: docker exec prefix, send-keys -l then Enter, no buffer", func(t *testing.T) {
		got := buildSendScript("p-worker", "agent", "just one line", "warden-send-test")
		want := "docker exec 'p-worker' tmux send-keys -t 'agent' -l 'just one line' && docker exec 'p-worker' tmux send-keys -t 'agent' Enter"
		if got != want {
			t.Fatalf("buildSendScript single-line mismatch:\ngot:  %s\nwant: %s", got, want)
		}
	})

	t.Run("single-line: bare-tmux (no container), custom session shellQuoted", func(t *testing.T) {
		got := buildSendScript("", "my session", "hello", "warden-send-test")
		want := "tmux send-keys -t 'my session' -l 'hello' && tmux send-keys -t 'my session' Enter"
		if got != want {
			t.Fatalf("bare-tmux single-line mismatch:\ngot:  %s\nwant: %s", got, want)
		}
	})

	t.Run("single-line text with an apostrophe is shellQuoted", func(t *testing.T) {
		got := buildSendScript("", "agent", "it's here", "warden-send-test")
		if !strings.Contains(got, "send-keys -t 'agent' -l 'it'\\''s here'") {
			t.Fatalf("expected shellQuoted apostrophe text; got: %s", got)
		}
	})

	t.Run("single-line text with a leading dash is shellQuoted (tmux -l still sees it verbatim)", func(t *testing.T) {
		got := buildSendScript("", "agent", "-flag start", "warden-send-test")
		// single-line uses send-keys -l (no buffer), so the leading '-' is just an
		// arg to -l after shell-quoting; tmux receives it verbatim.
		if !strings.Contains(got, "-l '-flag start'") {
			t.Fatalf("expected leading-dash text preserved verbatim; got: %s", got)
		}
	})

	t.Run("multiline: set-buffer / paste-buffer -p -d / send-keys Enter, byte-exact", func(t *testing.T) {
		// text carries an ACTUAL newline; shellQuote keeps it inside the single
		// quotes (a single-quoted string may span newlines), so tmux set-buffer
		// receives the whole block as one arg — matching the JS multiline path.
		got := buildSendScript("p-worker", "agent", "line1\nline2", "warden-send-test")
		want := "docker exec 'p-worker' tmux set-buffer -b 'warden-send-test' -- 'line1\nline2' && " +
			"docker exec 'p-worker' tmux paste-buffer -p -d -b 'warden-send-test' -t 'agent' && " +
			"docker exec 'p-worker' tmux send-keys -t 'agent' Enter || " +
			"{ rc=$?; docker exec 'p-worker' tmux delete-buffer -b 'warden-send-test' 2>/dev/null; exit $rc; }"
		if got != want {
			t.Fatalf("buildSendScript multiline mismatch:\ngot:  %s\nwant: %s", got, want)
		}
	})

	t.Run("multiline: bracketed-paste flags -p and -d are both present", func(t *testing.T) {
		got := buildSendScript("", "agent", "a\nb", "warden-send-test")
		if !strings.Contains(got, "paste-buffer -p -d -b 'warden-send-test'") {
			t.Fatalf("expected paste-buffer -p (bracketed) -d (reclaim); got: %s", got)
		}
	})

	t.Run("multiline leading-dash data is protected by the -- separator", func(t *testing.T) {
		got := buildSendScript("", "agent", "-flag start\nsecond", "warden-send-test")
		if !strings.Contains(got, "set-buffer -b 'warden-send-test' -- '-flag start\nsecond'") {
			t.Fatalf("expected `--` to protect leading-dash multiline data; got: %s", got)
		}
	})

	t.Run("multiline cleanup reclaims the SAME buffer and preserves the failure exit code", func(t *testing.T) {
		// The cleanup must (a) target the same buffer set-buffer created, (b) run
		// only on failure (`||`), and (c) propagate the real exit code via
		// `exit $rc` so a failed paste can never look like a 0. Capturing rc
		// BEFORE delete-buffer is what keeps the failure code intact.
		got := buildSendScript("", "agent", "a\nb", "warden-send-test")
		if !strings.Contains(got, "|| { rc=$?; tmux delete-buffer -b 'warden-send-test' 2>/dev/null; exit $rc; }") {
			t.Fatalf("expected rc-preserving cleanup block; got: %s", got)
		}
		if strings.HasSuffix(strings.TrimSpace(got), "|| true") {
			t.Fatalf("cleanup must NOT end in `|| true` (that masks the failure as a 0); got: %s", got)
		}
	})

	t.Run("empty target defaults to agent", func(t *testing.T) {
		got := buildSendScript("p-worker", "", "hi", "warden-send-test")
		if !strings.Contains(got, "send-keys -t 'agent' -l 'hi'") {
			t.Fatalf("expected target to default to 'agent'; got: %s", got)
		}
	})

	t.Run("container name with an apostrophe is shellQuoted", func(t *testing.T) {
		got := buildSendScript("c'x", "agent", "hi", "warden-send-test")
		if !strings.Contains(got, "docker exec 'c'\\''x' tmux") {
			t.Fatalf("expected shellQuoted container; got: %s", got)
		}
	})
}

func TestBuildSendKeysScript(t *testing.T) {
	t.Run("docker exec prefix, send-keys -t <target> <key>", func(t *testing.T) {
		got := buildSendKeysScript("p-worker", "agent", "C-c")
		want := "docker exec 'p-worker' tmux send-keys -t 'agent' 'C-c'"
		if got != want {
			t.Fatalf("buildSendKeysScript mismatch:\ngot:  %s\nwant: %s", got, want)
		}
	})

	t.Run("bare-tmux, custom session shellQuoted, key shellQuoted", func(t *testing.T) {
		got := buildSendKeysScript("", "my session", "Enter")
		want := "tmux send-keys -t 'my session' 'Enter'"
		if got != want {
			t.Fatalf("bare-tmux sendKeys mismatch:\ngot:  %s\nwant: %s", got, want)
		}
	})

	t.Run("empty target defaults to agent", func(t *testing.T) {
		got := buildSendKeysScript("p-worker", "", "C-c")
		if !strings.Contains(got, "send-keys -t 'agent' 'C-c'") {
			t.Fatalf("expected target to default to 'agent'; got: %s", got)
		}
	})
}

// TestNextSendBufferUnique pins the per-call buffer uniqueness multiline send
// relies on: two consecutive calls return distinct names so two concurrent sends
// to the same tmux server can't clobber each other's buffer (mirrors the JS
// `warden-send-${Date.now()}-${++sendSeq}` contract at src/tmux.js:59).
func TestNextSendBufferUnique(t *testing.T) {
	a := nextSendBuffer()
	b := nextSendBuffer()
	if a == b {
		t.Fatalf("consecutive nextSendBuffer() calls must differ; got %q twice", a)
	}
	for _, name := range []string{a, b} {
		if !strings.HasPrefix(name, "warden-send-") {
			t.Fatalf("buffer name must keep the warden-send- prefix; got %q", name)
		}
	}
}

// TestSendLiveTmux drives the REAL send() / sendKeys() against a LIVE tmux
// session: single-line + multiline send must land the text on the pane, and
// sendKeys must run send-keys against the live session without error. Proves the
// atomic bash -lc script buildSendScript produces actually works end-to-end on a
// real tmux server (the docker-exec path is the same code with a prefix). Skipped
// without tmux.
func TestSendLiveTmux(t *testing.T) {
	if !tmuxAvailable() {
		t.Skip("tmux not available")
	}
	session := uniqueSession()
	if out, err := exec.Command("tmux", "new-session", "-d", "-s", session).Output(); err != nil {
		t.Fatalf("tmux new-session failed: %v; %s", err, out)
	}
	defer exec.Command("tmux", "kill-session", "-t", session).Run()

	capture := func() string {
		out, _ := exec.Command("tmux", "capture-pane", "-t", session, "-p").Output()
		return string(out)
	}

	t.Run("single-line send lands the text on the pane", func(t *testing.T) {
		params, _ := json.Marshal(map[string]any{"container": "", "session": session, "text": "WARDEN_SEND_SINGLE_7"})
		res := send(params)
		if !res.OK {
			t.Fatalf("single-line send failed: code=%d stderr=%q", res.Code, res.Stderr)
		}
		waitForRendered(t, session, "WARDEN_SEND_SINGLE_7")
		if !strings.Contains(capture(), "WARDEN_SEND_SINGLE_7") {
			t.Fatalf("single-line marker never landed on the pane; got:\n%s", capture())
		}
	})

	t.Run("multiline send lands the whole block (bracketed paste, one submit)", func(t *testing.T) {
		params, _ := json.Marshal(map[string]any{"container": "", "session": session, "text": "WARDEN_LINE_ONE\nWARDEN_LINE_TWO"})
		res := send(params)
		if !res.OK {
			t.Fatalf("multiline send failed: code=%d stderr=%q", res.Code, res.Stderr)
		}
		waitForRendered(t, session, "WARDEN_LINE_TWO")
		got := capture()
		if !strings.Contains(got, "WARDEN_LINE_ONE") || !strings.Contains(got, "WARDEN_LINE_TWO") {
			t.Fatalf("multiline block did not land intact; got:\n%s", got)
		}
	})

	t.Run("send against a dead session reclaims the buffer and returns ok:false (no leak, no false success)", func(t *testing.T) {
		// A dead session makes paste-buffer fail ("can't find session"). The
		// cleanup must reclaim the set buffer (no leak) AND the result must be
		// ok:false with the real tmux error — the rc-preserving `exit $rc` is what
		// stops the cleanup delete-buffer from turning the failure into a 0.
		params, _ := json.Marshal(map[string]any{"container": "", "session": session + "-nope", "text": "a\nb\nc"})
		res := send(params)
		if res.OK {
			t.Fatalf("send against a dead session must be ok:false, not ok:true (cleanup masked the failure?)")
		}
		// tmux's exact wording is version/target-dependent ("can't find session" /
		// "can't find pane"); the meaningful signal is that the REAL tmux error
		// surfaced on stderr (not masked) rather than a specific string.
		if !strings.Contains(res.Stderr, "can't find") {
			t.Fatalf("expected the real tmux 'can't find ...' error on stderr; got %q", res.Stderr)
		}
		// The buffer must NOT leak: list-buffers should not hold a warden-send-* buf.
		lb, _ := exec.Command("tmux", "list-buffers").Output()
		if strings.Contains(string(lb), "warden-send-") {
			t.Fatalf("multiline send leaked a warden-send-* buffer on the dead-session failure; list-buffers:\n%s", lb)
		}
	})

	t.Run("sendKeys runs send-keys -t <session> <key> against the live session", func(t *testing.T) {
		params, _ := json.Marshal(map[string]any{"container": "", "session": session, "key": "C-c"})
		res := sendKeys(params)
		if !res.OK {
			t.Fatalf("sendKeys failed against a live session: code=%d stderr=%q", res.Code, res.Stderr)
		}
	})
}
