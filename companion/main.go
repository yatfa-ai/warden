// Command warden-companion is the host-side companion process for warden's
// companion transport (WARDEN-272, slice 1 of roadmap WARDEN-270).
//
// It is bootstrapped into user-space on a remote host (~/.warden/companion-<ver>)
// over the SSH session warden already holds, then driven over a SINGLE persistent
// ssh process's stdio using newline-delimited JSON RPC. warden's discover() rides
// this one channel with ZERO per-op ssh handshakes.
//
// It opens NO network port: requests arrive on stdin, responses leave on stdout.
// "No one can reach your warden" stays literally true.
//
// Protocol (one JSON object per line):
//
//	request : {"id":<any-json>,"method":"ping"|"discover","params":{...}}
//	response: {"id":<echoed>,"ok":true,"result":{...}}
//	          {"id":<echoed>,"ok":false,"error":"..."}
//
// `id` is echoed untouched so the caller (warden) can be a multiplexing client
// with many requests in flight on the one stdio channel. stderr is for human
// diagnostics only — warden never parses it.
package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"sync"
)

// version is baked in at build time via -ldflags "-X main.version=..." and is
// written to companion/dist/manifest.json by the same build script, so warden
// (Node) and the companion (Go) agree on the identity of the binary. A ping
// returns this version; warden uses a mismatch to detect a stale cached binary
// on the host and force a re-upload.
var version = "dev"

// Request is one RPC request read from stdin. ID is kept as RawMessage so any
// JSON scalar/object can be echoed back verbatim (the caller owns id semantics).
type Request struct {
	ID     json.RawMessage `json:"id"`
	Method string          `json:"method"`
	Params json.RawMessage `json:"params,omitempty"`
}

// Response is one RPC response written to stdout.
type Response struct {
	ID     json.RawMessage `json:"id"`
	OK     bool            `json:"ok"`
	Result any             `json:"result,omitempty"`
	Error  string          `json:"error,omitempty"`
}

// containerInfo is one row of a discover result. It mirrors warden's
// DISCOVER_SCRIPT TSV layout (name \t status \t cwd \t active) so the Node side
// can map it to the identical chat shape the default discover() path produces.
type containerInfo struct {
	Name   string `json:"name"`
	Status string `json:"status"`
	Cwd    string `json:"cwd"`
	Active bool   `json:"active"`
}

type discoverParams struct {
	Session string `json:"session"` // tmux session to probe; defaults to "agent"
}

func main() {
	scanner := bufio.NewScanner(os.Stdin)
	// A discover over many containers can produce a sizable line; raise the
	// per-line cap well above the 64KB default so large fleets don't truncate.
	scanner.Buffer(make([]byte, 1024*1024), 64*1024*1024)

	// All stdout writes go through one encoder + mutex so concurrent dispatch
	// (future) can never interleave half-lines. Requests are read serially today.
	var outMu sync.Mutex
	enc := json.NewEncoder(os.Stdout)
	write := func(r Response) {
		outMu.Lock()
		defer outMu.Unlock()
		_ = enc.Encode(r) // json.Encoder appends the newline delimiter
	}

	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		var req Request
		if err := json.Unmarshal([]byte(line), &req); err != nil {
			// No usable id → cannot route a response. Diagnose on stderr and skip.
			fmt.Fprintln(os.Stderr, "companion: malformed request line:", err)
			continue
		}
		switch req.Method {
		case "ping":
			write(Response{ID: req.ID, OK: true, Result: map[string]any{
				"version": version,
				"methods": []string{"ping", "discover"},
			}})
		case "discover":
			containers, err := discover(req.Params)
			if err != nil {
				write(Response{ID: req.ID, OK: false, Error: err.Error()})
			} else {
				write(Response{ID: req.ID, OK: true, Result: map[string]any{
					"containers": containers,
				}})
			}
		default:
			write(Response{ID: req.ID, OK: false, Error: "unknown method: " + req.Method})
		}
	}
	if err := scanner.Err(); err != nil {
		fmt.Fprintln(os.Stderr, "companion: stdin scanner error:", err)
		os.Exit(1)
	}
}

// discover mirrors warden's DISCOVER_SCRIPT (src/chats.js): one `docker ps`, then
// for each container a `docker exec <c> tmux has-session -t <session>` probe (the
// `agent` session by default), resolving the in-container cwd via
// `tmux display-message '#{pane_current_path}'` when live, else `docker inspect`
// WorkingDir. All of this runs LOCALLY on the host inside the companion process —
// no further ssh handshakes — which is the per-op-handshake win this slice proves.
func discover(params json.RawMessage) ([]containerInfo, error) {
	var p discoverParams
	if len(params) > 0 {
		_ = json.Unmarshal(params, &p) // bad params → fall through to default
	}
	session := p.Session
	if session == "" {
		session = "agent"
	}

	// `docker ps` once. If docker is absent or the daemon is down, surface a
	// clear, actionable error — warden reports it verbatim in the experimental
	// path (companion-or-fail; no silent fallback).
	out, err := exec.Command("docker", "ps", "--format", "{{.Names}}\t{{.Status}}").Output()
	if err != nil {
		stderr := strings.TrimSpace(string(out))
		if exitErr, ok := err.(*exec.ExitError); ok {
			stderr = strings.TrimSpace(string(exitErr.Stderr))
		}
		if stderr == "" {
			stderr = err.Error()
		}
		return nil, fmt.Errorf("docker ps failed: %s", stderr)
	}

	var result []containerInfo
	for _, line := range strings.Split(string(out), "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		// docker --format gives exactly one tab between name and status, but
		// SplitN tolerates a status that itself contains a tab.
		parts := strings.SplitN(line, "\t", 2)
		name := strings.TrimSpace(parts[0])
		if name == "" {
			continue
		}
		status := ""
		if len(parts) == 2 {
			status = strings.TrimSpace(parts[1])
		}

		// Probe the tmux session. has-session exits 0 only when it exists; any
		// other outcome (no session, no tmux in the container) → inactive.
		active := exec.Command("docker", "exec", name, "tmux", "has-session", "-t", session).Run() == nil

		cwd := ""
		if active {
			cwd = captureFirst("docker", "exec", name, "tmux", "display-message", "-p", "-t", session, "#{pane_current_path}")
		}
		if cwd == "" {
			// Fallback: the image's WorkingDir (same fallback the script uses).
			cwd = captureFirst("docker", "inspect", name, "--format", "{{.Config.WorkingDir}}")
		}

		result = append(result, containerInfo{
			Name:   name,
			Status: status,
			Cwd:    cwd,
			Active: active,
		})
	}
	return result, nil
}

// captureFirst runs a command and returns its stdout trimmed of surrounding
// whitespace and a trailing CR (which can sneak in over a pty). Empty on any
// error — callers treat empty as "could not derive".
func captureFirst(name string, args ...string) string {
	out, err := exec.Command(name, args...).Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(strings.TrimRight(string(out), "\r"))
}
