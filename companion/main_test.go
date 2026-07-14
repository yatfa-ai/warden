package main

import (
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
