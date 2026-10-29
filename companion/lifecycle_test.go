package main

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// Real-tmux tests for the Go tmux lifecycle RPCs hasSession / spawnSession /
// killSession (WARDEN-382/386). Container-routed legs use a nonexistent
// container name: `docker exec` fails whether docker is absent or present, which
// is exactly what the assertions expect, so they are hermetic either way.

func rawJSON(t *testing.T, v any) json.RawMessage {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func tmuxHas(session string) bool {
	return exec.Command("tmux", "has-session", "-t", session).Run() == nil
}

func tmuxDisplay(t *testing.T, session, format string) string {
	t.Helper()
	out, err := exec.Command("tmux", "display-message", "-p", "-t", session, format).Output()
	if err != nil {
		t.Fatalf("tmux display-message %q: %v", format, err)
	}
	return strings.TrimSpace(string(out))
}

func TestHasSessionReportsExistence(t *testing.T) {
	skipOnWindows(t)
	if !tmuxAvailable() {
		t.Skip("tmux not available")
	}
	session := uniqueSession()
	res, err := hasSession(rawJSON(t, map[string]any{"session": session}))
	if err != nil || res["exists"] != false {
		t.Fatalf("absent session: got (%v, %v), want exists=false", res, err)
	}
	if out, err := exec.Command("tmux", "new-session", "-d", "-s", session).Output(); err != nil {
		t.Fatalf("tmux new-session: %v; %s", err, out)
	}
	defer exec.Command("tmux", "kill-session", "-t", session).Run()
	res, err = hasSession(rawJSON(t, map[string]any{"session": session}))
	if err != nil || res["exists"] != true {
		t.Fatalf("live session: got (%v, %v), want exists=true", res, err)
	}
	// An unreachable container is exists=false, never an RPC error.
	res, err = hasSession(rawJSON(t, map[string]any{"session": session, "container": "warden-no-such-container"}))
	if err != nil || res["exists"] != false {
		t.Fatalf("unreachable container: got (%v, %v), want exists=false and no error", res, err)
	}
}

func TestHasSessionBadParamsFallThroughToDefaults(t *testing.T) {
	skipOnWindows(t)
	res, err := hasSession(json.RawMessage(`{not json`))
	if err != nil {
		t.Fatalf("malformed params must not be an RPC error, got %v", err)
	}
	if _, ok := res["exists"].(bool); !ok {
		t.Fatalf("expected a boolean exists key, got %v", res)
	}
}

func TestSpawnSessionBuildsDetachedSessionWithSizeCwdAndArgv(t *testing.T) {
	skipOnWindows(t)
	if !tmuxAvailable() {
		t.Skip("tmux not available")
	}
	session := uniqueSession()
	dir := t.TempDir()
	marker := filepath.Join(dir, "argv.txt")
	err := spawnSession(rawJSON(t, map[string]any{
		"session": session,
		"cwd":     dir,
		"cmd":     []string{"sh", "-c", `printf '%s' "$1" > ` + marker + `; sleep 30`, "sh", "it's a b"},
	}))
	if err != nil {
		t.Fatalf("spawnSession: %v", err)
	}
	defer exec.Command("tmux", "kill-session", "-t", session).Run()
	if !tmuxHas(session) {
		t.Fatalf("session %s not created", session)
	}
	if got := tmuxDisplay(t, session, "#{window_width}x#{window_height}"); got != "120x32" {
		t.Fatalf("initial size = %s, want 120x32", got)
	}
	want, _ := filepath.EvalSymlinks(dir)
	got, _ := filepath.EvalSymlinks(tmuxDisplay(t, session, "#{pane_current_path}"))
	if got != want {
		t.Fatalf("cwd = %s, want %s", got, want)
	}
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if b, err := os.ReadFile(marker); err == nil {
			if string(b) != "it's a b" {
				t.Fatalf("argv element mangled: %q", b)
			}
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("command never ran")
}

func TestSpawnSessionEmptyCmdLaunchesDefaultShell(t *testing.T) {
	skipOnWindows(t)
	if !tmuxAvailable() {
		t.Skip("tmux not available")
	}
	session := uniqueSession()
	if err := spawnSession(rawJSON(t, map[string]any{"session": session})); err != nil {
		t.Fatalf("spawnSession: %v", err)
	}
	defer exec.Command("tmux", "kill-session", "-t", session).Run()
	if !tmuxHas(session) {
		t.Fatalf("session not created")
	}
	if cmd := tmuxDisplay(t, session, "#{pane_current_command}"); cmd == "" {
		t.Fatalf("no pane command")
	}
}

func TestSpawnSessionErrors(t *testing.T) {
	skipOnWindows(t)
	if !tmuxAvailable() {
		t.Skip("tmux not available")
	}
	if err := spawnSession(json.RawMessage(`{not json`)); err == nil || !strings.Contains(err.Error(), "invalid spawnSession params") {
		t.Fatalf("malformed params: got %v", err)
	}
	session := uniqueSession()
	if err := spawnSession(rawJSON(t, map[string]any{"session": session, "cmd": []string{"sleep", "30"}})); err != nil {
		t.Fatalf("first spawn: %v", err)
	}
	defer exec.Command("tmux", "kill-session", "-t", session).Run()
	err := spawnSession(rawJSON(t, map[string]any{"session": session, "cmd": []string{"sleep", "30"}}))
	if err == nil || !strings.HasPrefix(err.Error(), "spawnSession failed: ") || !strings.Contains(err.Error(), "duplicate session") {
		t.Fatalf("duplicate spawn: got %v", err)
	}
	err = spawnSession(rawJSON(t, map[string]any{"session": uniqueSession(), "container": "warden-no-such-container"}))
	if err == nil || !strings.HasPrefix(err.Error(), "spawnSession failed: ") {
		t.Fatalf("unreachable container must fail with a spawnSession error, got %v", err)
	}
}

func TestKillSessionKillsAndIsIdempotent(t *testing.T) {
	skipOnWindows(t)
	if !tmuxAvailable() {
		t.Skip("tmux not available")
	}
	session := uniqueSession()
	keeper := "k" + session // NOT session+"-x": tmux -t prefix-matches
	for _, s := range []string{session, keeper} {
		if out, err := exec.Command("tmux", "new-session", "-d", "-s", s, "sleep", "30").Output(); err != nil {
			t.Fatalf("tmux new-session: %v; %s", err, out)
		}
		defer exec.Command("tmux", "kill-session", "-t", s).Run()
	}
	if err := killSession(rawJSON(t, map[string]any{"session": session})); err != nil {
		t.Fatalf("killSession: %v", err)
	}
	if tmuxHas(session) {
		t.Fatalf("session still alive after killSession")
	}
	if !tmuxHas(keeper) {
		t.Fatalf("killSession killed an unrelated session")
	}
	if err := killSession(rawJSON(t, map[string]any{"session": session})); err != nil {
		t.Fatalf("second kill must be a benign no-op, got %v", err)
	}
	exec.Command("tmux", "kill-session", "-t", keeper).Run()
	if err := killSession(rawJSON(t, map[string]any{"session": session})); err != nil {
		t.Fatalf("kill with no server must be a benign no-op, got %v", err)
	}
}

func TestKillSessionSurfacesNonBenignFailures(t *testing.T) {
	skipOnWindows(t)
	if err := killSession(json.RawMessage(`{not json`)); err == nil || !strings.Contains(err.Error(), "invalid killSession params") {
		t.Fatalf("malformed params: got %v", err)
	}
	err := killSession(rawJSON(t, map[string]any{"session": "x", "container": "warden-no-such-container"}))
	if err == nil || !strings.HasPrefix(err.Error(), "killSession failed: ") {
		t.Fatalf("unreachable container must surface a killSession error, got %v", err)
	}
}
