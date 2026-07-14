package main

import (
	"os/exec"
	"strings"
	"testing"
)

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
