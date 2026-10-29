package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Hermetic tests for the Go docker-discovery RPC discover() and its helpers
// captureFirst / captureActivityLines (WARDEN-2016). A stub `docker` script is
// placed first on PATH, driven by files in a temp dir, so results are identical
// with or without a real docker installed.
//
// captureActivityLines runs `bash -lc`, and a login shell re-derives PATH from
// /etc/profile (dropping the stub dir), so the rig also points HOME at the temp
// dir and writes ~/.bash_profile re-prepending the stub dir.
//
// Stub layout (all under the rig root):
//   ps.out          stdout of `docker ps`            (ps.fail = exit 1, stderr from ps.err)
//   session/<name>  has-session succeeds iff -t target equals this file's content
//   cwd/<name>      stdout of `tmux display-message` (raw, may carry CR/LF)
//   pane/<name>     stdout of `tmux capture-pane`
//   inspect/<name>  stdout of `docker inspect`
//   calls.log       one line per docker invocation (args joined by a space)

const dockerStub = `#!/bin/sh
echo "$*" >> "$STUB_DIR/calls.log"
case "$1" in
ps)
  if [ -e "$STUB_DIR/ps.fail" ]; then
    [ -e "$STUB_DIR/ps.err" ] && cat "$STUB_DIR/ps.err" >&2
    exit 1
  fi
  cat "$STUB_DIR/ps.out"
  ;;
inspect)
  [ -e "$STUB_DIR/inspect/$2" ] && cat "$STUB_DIR/inspect/$2"
  exit 0
  ;;
exec)
  name="$2"
  case "$4" in
  has-session)
    [ -e "$STUB_DIR/session/$name" ] && [ "$(cat "$STUB_DIR/session/$name")" = "$6" ] && exit 0
    exit 1
    ;;
  display-message)
    [ -e "$STUB_DIR/cwd/$name" ] && cat "$STUB_DIR/cwd/$name"
    exit 0
    ;;
  capture-pane)
    [ -e "$STUB_DIR/pane/$name" ] && cat "$STUB_DIR/pane/$name"
    exit 0
    ;;
  esac
  ;;
esac
exit 0
`

type dockerRig struct {
	t   *testing.T
	dir string
}

func newDockerRig(t *testing.T) *dockerRig {
	t.Helper()
	skipOnWindows(t)
	dir := t.TempDir()
	bin := filepath.Join(dir, "bin")
	for _, d := range []string{bin, filepath.Join(dir, "session"), filepath.Join(dir, "cwd"),
		filepath.Join(dir, "pane"), filepath.Join(dir, "inspect")} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(bin, "docker"), []byte(dockerStub), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, ".bash_profile"),
		[]byte("export PATH="+bin+":$PATH\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("HOME", dir)
	t.Setenv("STUB_DIR", dir)
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	return &dockerRig{t: t, dir: dir}
}

func (r *dockerRig) write(rel, content string) {
	r.t.Helper()
	p := filepath.Join(r.dir, rel)
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		r.t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
		r.t.Fatal(err)
	}
}

func (r *dockerRig) calls() []string {
	r.t.Helper()
	b, err := os.ReadFile(filepath.Join(r.dir, "calls.log"))
	if err != nil {
		return nil
	}
	return strings.Split(strings.TrimRight(string(b), "\n"), "\n")
}

func (r *dockerRig) callsContaining(sub string) []string {
	var out []string
	for _, c := range r.calls() {
		if strings.Contains(c, sub) {
			out = append(out, c)
		}
	}
	return out
}

func byName(t *testing.T, got []containerInfo) map[string]containerInfo {
	t.Helper()
	m := map[string]containerInfo{}
	for _, c := range got {
		m[c.Name] = c
	}
	return m
}

func TestDiscoverParsesDockerPsLines(t *testing.T) {
	r := newDockerRig(t)
	r.write("ps.out", "alpha\tUp 2 hours\n"+
		"\n"+
		"   \n"+
		"  beta  \t  Up 5 min\textra\tcols  \n"+
		"gamma\n"+
		"naïve-é\tUp 1 second\n")
	got, err := discover(nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 4 {
		t.Fatalf("want 4 containers (blank lines skipped), got %d: %+v", len(got), got)
	}
	want := []containerInfo{
		{Name: "alpha", Status: "Up 2 hours"},
		{Name: "beta", Status: "Up 5 min\textra\tcols"}, // trimmed; inner tab preserved
		{Name: "gamma", Status: ""},                     // name-only line
		{Name: "naïve-é", Status: "Up 1 second"},
	}
	for i, w := range want {
		g := got[i]
		if g.Name != w.Name || g.Status != w.Status {
			t.Errorf("container %d = {%q,%q}, want {%q,%q}", i, g.Name, g.Status, w.Name, w.Status)
		}
	}
}

func TestDiscoverProbesActiveAndInactiveContainers(t *testing.T) {
	r := newDockerRig(t)
	r.write("ps.out", "live\tUp\ndead\tUp\nlivenocwd\tUp\n")
	r.write("session/live", "agent")
	r.write("session/livenocwd", "agent")
	r.write("cwd/live", "/live/pane/path\r\n")
	r.write("cwd/livenocwd", "") // active but display-message prints nothing
	r.write("inspect/live", "/image/live\n")
	r.write("inspect/dead", "/image/dead\r\n")
	r.write("inspect/livenocwd", "/image/livenocwd\n")
	// A dead container has a pane path the stub must NOT be asked for.
	r.write("cwd/dead", "/dead/pane/path\n")

	got, err := discover(nil)
	if err != nil {
		t.Fatal(err)
	}
	m := byName(t, got)

	if c := m["live"]; !c.Active || c.Cwd != "/live/pane/path" {
		t.Errorf("live = %+v, want Active with live pane path (CR/LF stripped)", c)
	}
	if c := m["dead"]; c.Active || c.Cwd != "/image/dead" {
		t.Errorf("dead = %+v, want inactive with docker inspect WorkingDir", c)
	}
	if c := m["livenocwd"]; !c.Active || c.Cwd != "/image/livenocwd" {
		t.Errorf("livenocwd = %+v, want Active with inspect fallback when display-message is empty", c)
	}
	if n := len(r.callsContaining("exec dead tmux display-message")); n != 0 {
		t.Errorf("inactive container must not be asked for its pane path, saw %d display-message calls", n)
	}
	if n := len(r.callsContaining("inspect live ")); n != 0 {
		t.Errorf("active container with a pane path must not hit docker inspect, saw %d calls", n)
	}
	if n := len(r.callsContaining("inspect dead ")); n != 1 {
		t.Errorf("inactive container must be inspected once, saw %d", n)
	}
}

func TestDiscoverSessionParamIsTheProbeTarget(t *testing.T) {
	cases := []struct {
		name   string
		params any // nil → no params
		raw    string
		target string
	}{
		{name: "explicit session", params: map[string]any{"session": "custom"}, target: "custom"},
		{name: "empty session defaults", params: map[string]any{"session": ""}, target: "agent"},
		{name: "no params defaults", params: nil, target: "agent"},
		{name: "malformed params default", raw: "{not json", target: "agent"},
		{name: "non-string session defaults", raw: `{"session": 7}`, target: "agent"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := newDockerRig(t)
			r.write("ps.out", "box\tUp\n")
			r.write("session/box", tc.target)
			r.write("cwd/box", "/p\n")
			var raw []byte
			switch {
			case tc.raw != "":
				raw = []byte(tc.raw)
			case tc.params != nil:
				raw = rawJSON(t, tc.params)
			}
			got, err := discover(raw)
			if err != nil {
				t.Fatal(err)
			}
			if len(got) != 1 || !got[0].Active {
				t.Fatalf("want box active via -t %q, got %+v (calls: %v)", tc.target, got, r.calls())
			}
			if n := len(r.callsContaining("has-session -t " + tc.target)); n != 1 {
				t.Errorf("want one has-session -t %s call, calls: %v", tc.target, r.calls())
			}
		})
	}
}

func TestDiscoverDockerPsFailureSurfacesStderr(t *testing.T) {
	r := newDockerRig(t)
	r.write("ps.fail", "")
	r.write("ps.err", "Cannot connect to the Docker daemon at unix:///var/run/docker.sock\n")
	got, err := discover(nil)
	if got != nil {
		t.Errorf("want nil result on docker ps failure, got %+v", got)
	}
	if err == nil {
		t.Fatal("want an error")
	}
	want := "docker ps failed: Cannot connect to the Docker daemon at unix:///var/run/docker.sock"
	if err.Error() != want {
		t.Errorf("error = %q, want %q", err.Error(), want)
	}
	if n := len(r.callsContaining("exec")); n != 0 {
		t.Errorf("no per-container probe may run after docker ps fails, saw %v", r.calls())
	}
}

func TestDiscoverDockerPsFailureWithoutStderrFallsBackToExitError(t *testing.T) {
	r := newDockerRig(t)
	r.write("ps.fail", "")
	_, err := discover(nil)
	if err == nil || !strings.HasPrefix(err.Error(), "docker ps failed: ") ||
		strings.TrimPrefix(err.Error(), "docker ps failed: ") == "" {
		t.Fatalf("want 'docker ps failed: <non-empty>', got %v", err)
	}
}

func TestDiscoverActivityCapturesLeadingLineOfActiveContainersOnly(t *testing.T) {
	r := newDockerRig(t)
	r.write("ps.out", "busy\tUp\nquiet\tUp\nidle\tUp\n")
	r.write("session/busy", "agent")
	r.write("session/quiet", "agent")
	// idle has no session → inactive. Give it a pane the stub would happily serve.
	r.write("pane/busy", "[2026-01-02 03:04:05] working\nsecond line\nthird line\n")
	r.write("pane/quiet", "") // active, empty pane
	r.write("pane/idle", "should never be captured\n")

	got, err := discover(rawJSON(t, map[string]any{"activity": true}))
	if err != nil {
		t.Fatal(err)
	}
	m := byName(t, got)

	if p := strings.TrimSpace(m["busy"].Pane); p != "[2026-01-02 03:04:05] working" {
		t.Errorf("busy.Pane = %q, want only the leading line", m["busy"].Pane)
	}
	if m["quiet"].Pane != "" {
		t.Errorf("quiet.Pane = %q, want empty for an empty pane", m["quiet"].Pane)
	}
	if m["idle"].Pane != "" {
		t.Errorf("idle.Pane = %q, inactive container must never get a pane", m["idle"].Pane)
	}
	if n := len(r.callsContaining("exec idle tmux capture-pane")); n != 0 {
		t.Errorf("inactive container must not be captured, saw %d capture-pane calls", n)
	}
	if n := len(r.callsContaining("exec busy tmux capture-pane")); n != 1 {
		t.Errorf("busy must be captured exactly once, saw %d", n)
	}
}

func TestDiscoverActivityCaptureUsesTheSessionTarget(t *testing.T) {
	r := newDockerRig(t)
	r.write("ps.out", "box\tUp\n")
	r.write("session/box", "custom")
	r.write("cwd/box", "/p\n")
	r.write("pane/box", "hello\n")
	got, err := discover(rawJSON(t, map[string]any{"activity": true, "session": "custom"}))
	if err != nil {
		t.Fatal(err)
	}
	if strings.TrimSpace(got[0].Pane) != "hello" {
		t.Errorf("Pane = %q, want hello", got[0].Pane)
	}
	if n := len(r.callsContaining("capture-pane -t custom")); n != 1 {
		t.Errorf("capture-pane must target the session, calls: %v", r.calls())
	}
}

func TestDiscoverWithoutActivitySkipsCaptureEntirely(t *testing.T) {
	for _, params := range []any{nil, map[string]any{"activity": false}} {
		r := newDockerRig(t)
		r.write("ps.out", "box\tUp\n")
		r.write("session/box", "agent")
		r.write("cwd/box", "/p\n")
		r.write("pane/box", "[2026-01-02 03:04:05] working\n")
		var raw []byte
		if params != nil {
			raw = rawJSON(t, params)
		}
		got, err := discover(raw)
		if err != nil {
			t.Fatal(err)
		}
		if got[0].Pane != "" {
			t.Errorf("params=%v: Pane = %q, want empty when activity is not requested", params, got[0].Pane)
		}
		if n := len(r.callsContaining("capture-pane")); n != 0 {
			t.Errorf("params=%v: want no capture-pane call, saw %d", params, n)
		}
	}
}

func TestDiscoverActivityWithNoActiveContainerRunsNoCapture(t *testing.T) {
	r := newDockerRig(t)
	r.write("ps.out", "a\tUp\nb\tUp\n")
	r.write("pane/a", "x\n")
	got, err := discover(rawJSON(t, map[string]any{"activity": true}))
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range got {
		if c.Active || c.Pane != "" {
			t.Errorf("%+v: want inactive with no pane", c)
		}
	}
	if n := len(r.callsContaining("capture-pane")); n != 0 {
		t.Errorf("no active container → no capture at all, saw %d calls", n)
	}
}

func TestCaptureFirst(t *testing.T) {
	skipOnWindows(t)
	cases := []struct {
		name string
		args []string
		want string
	}{
		{"trims surrounding whitespace", []string{"printf", "  /a/b  \n"}, "/a/b"},
		{"trims CR then whitespace", []string{"printf", " /a/b \r\n"}, "/a/b"},
		{"empty output", []string{"printf", ""}, ""},
		{"non-zero exit yields empty even with stdout", []string{"sh", "-c", "echo partial; exit 3"}, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := captureFirst(tc.args[0], tc.args[1:]...); got != tc.want {
				t.Errorf("captureFirst(%q) = %q, want %q", tc.args, got, tc.want)
			}
		})
	}
	t.Run("missing binary yields empty", func(t *testing.T) {
		if got := captureFirst("definitely-not-a-real-binary-warden-2016"); got != "" {
			t.Errorf("got %q, want empty", got)
		}
	})
}

func TestCaptureActivityLinesReturnsEmptyMapWhenBatchFails(t *testing.T) {
	skipOnWindows(t)
	// A login profile that exits non-zero makes the whole `bash -lc` batch fail.
	dir := t.TempDir()
	t.Setenv("HOME", dir)
	if err := os.WriteFile(filepath.Join(dir, ".bash_profile"), []byte("exit 7\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	got := captureActivityLines([]string{"x"}, "agent")
	if len(got) != 0 {
		t.Errorf("want an empty map on batch failure, got %#v", got)
	}
}
