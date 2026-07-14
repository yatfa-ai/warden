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
//	request : {"id":<any-json>,"method":"ping"|"discover"|"capturePanes"|"hasSession","params":{...}}
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
// Pane carries the raw LEADING pane line for an active container (captured
// host-side in ONE batched shell when activity is requested) so the Node side
// can parse lastActivity from it via the SAME helper the default path uses —
// closing the read-parity gap where companion-discovered agents classified
// UNKNOWN in Fleet Health. Empty when inactive, lean, or no parseable line.
// (WARDEN-376)
type containerInfo struct {
	Name   string `json:"name"`
	Status string `json:"status"`
	Cwd    string `json:"cwd"`
	Active bool   `json:"active"`
	Pane   string `json:"pane,omitempty"`
}

type discoverParams struct {
	Session string `json:"session"` // tmux session to probe; defaults to "agent"
	// Activity gates the leading-pane-line capture. The Node side forwards
	// opts.activity !== false as a boolean: true for the user-facing discover
	// (capture pane lines so Fleet Health classifies HEALTHY/WARNING/CRITICAL),
	// false for the lean 60s lifecycle poll (skip per-container capture-pane
	// work — WARDEN-147's optimization, preserved exactly). Absent (a direct
	// stdio caller that sends no activity field) defaults to false → no capture.
	Activity bool `json:"activity"`
}

// hasSessionParams is the liveness-probe RPC params (WARDEN-382). Container is
// the docker container (empty for a bare-tmux / manual chat); Session is the
// tmux target, falling back to Container then "agent" — identical to
// capturePanes (main.go:263-269) and src/chats.js. Both are JSON-serialized RPC
// params, never persisted fields (the same trust boundary capturePanes' panes[]
// already relies on).
type hasSessionParams struct {
	Container string `json:"container"`
	Session   string `json:"session"`
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
				"methods": []string{"ping", "discover", "capturePanes", "hasSession", "spawnSession", "killSession"},
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
		case "capturePanes":
			panes, err := capturePanes(req.Params)
			if err != nil {
				write(Response{ID: req.ID, OK: false, Error: err.Error()})
			} else {
				write(Response{ID: req.ID, OK: true, Result: map[string]any{
					"panes": panes,
				}})
			}
		case "hasSession":
			result, err := hasSession(req.Params)
			if err != nil {
				write(Response{ID: req.ID, OK: false, Error: err.Error()})
			} else {
				write(Response{ID: req.ID, OK: true, Result: result})
			}
		case "spawnSession":
			if err := spawnSession(req.Params); err != nil {
				write(Response{ID: req.ID, OK: false, Error: err.Error()})
			} else {
				write(Response{ID: req.ID, OK: true, Result: map[string]any{}})
			}
		case "killSession":
			if err := killSession(req.Params); err != nil {
				write(Response{ID: req.ID, OK: false, Error: err.Error()})
			} else {
				write(Response{ID: req.ID, OK: true, Result: map[string]any{}})
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

	// Activity capture (WARDEN-376): when requested (the non-lean path — the
	// lifecycle poll forwards activity:false to SKIP this), batch-capture each
	// ACTIVE container's leading pane line in ONE local shell invocation. This
	// is the same `docker exec <c> tmux capture-pane -t <session> -p -S - -E -
	// | head -1` the default SSH discover path runs per active agent (chats.js),
	// sentinel-framed like capturePanes so parseCaptureSentinels recovers a
	// name→line map. The raw line is emitted on Pane; the timestamp is PARSED
	// in JS by the shared parseActivityTimestamp so both paths agree by
	// construction (the regex lives once, in chatMeta.js). Skipped entirely
	// when lean (zero per-tick local capture-pane work — lean-mode parity) and
	// when no container is active.
	if p.Activity {
		var actives []string
		for i := range result {
			if result[i].Active {
				actives = append(actives, result[i].Name)
			}
		}
		if len(actives) > 0 {
			lines := captureActivityLines(actives, session)
			for i := range result {
				if result[i].Active {
					result[i].Pane = lines[result[i].Name]
				}
			}
		}
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

// --------------------------- activity capture --------------------------------
// WARDEN-376 (read-parity slice of roadmap WARDEN-270). The default SSH discover
// path captures each active agent's leading pane line and parses a timestamp
// out of it to populate chat.lastActivity — without which Fleet Health renders
// an actively-working companion-discovered agent as UNKNOWN (health.js short-
// circuits on a null lastActivity). This captures that SAME leading line
// host-side, in ONE batched local shell (zero further ssh handshakes — the
// companion is already local), and emits it raw on containerInfo.Pane for the
// Node side to parse with the shared parseActivityTimestamp. The bootstrap+
// channel are slice 1's, reused verbatim; this only adds the host-side capture.

// buildActivityScript builds the batched, sentinel-framed script that captures
// the LEADING pane line for each active container in ONE local shell. It runs
// the SAME per-container command the default SSH discover path runs
// (chats.js): `docker exec <c> tmux capture-pane -t <session> -p -S - -E -
// 2>/dev/null | head -1`, sentinel-bracketed with ___B_<name>___ / ___E_<name>___
// so parseCaptureSentinels recovers a name→line map. Container names are docker
// names (^[A-Za-z0-9_.-]+$), never free-form input, so interpolating <name>
// verbatim inside the single-quoted printf argument is the same trust boundary
// buildCaptureScript relies on. (WARDEN-376)
func buildActivityScript(names []string, session string) string {
	if session == "" {
		session = "agent"
	}
	target := shellQuote(session)
	parts := make([]string, 0, len(names))
	for _, name := range names {
		c := shellQuote(name)
		parts = append(parts,
			"printf '___B_"+name+"___\\n'; "+
				"docker exec "+c+" tmux capture-pane -t "+target+
				" -p -S - -E - 2>/dev/null | head -1; "+
				"printf '\\n___E_"+name+"___\\n'")
	}
	return strings.Join(parts, "; ")
}

// captureActivityLines runs the batched leading-line capture for the given
// active container names in ONE `bash -lc` invocation (mirrors capturePanes:
// one local fan-out, zero further ssh). Returns a name→line map; a container
// whose capture yielded no line is absent (callers leave Pane empty → JS parses
// null → lastActivity stays null, exactly as the default path's per-agent
// .catch() leaves it). A failed batch (e.g. tmux absent) is non-fatal: discover
// still returns the containers with no Pane, so a transient capture failure
// never breaks discovery — it just leaves lastActivity null. (WARDEN-376)
func captureActivityLines(names []string, session string) map[string]string {
	script := buildActivityScript(names, session)
	out, err := exec.Command("bash", "-lc", script).Output()
	if err != nil {
		return map[string]string{}
	}
	return parseCaptureSentinels(string(out))
}

// ----------------------------- capturePanes ---------------------------------
// WARDEN-276 (slice 2 of roadmap WARDEN-270). capture-pane is the highest-
// frequency remote op (it fires on every observer poll + the 2s monitor tick),
// so migrating it onto the companion channel collapses the per-tick ssh
// handshake that dominates the ControlMaster-disabled / Windows path. The
// bootstrap+channel are slice 1's, reused verbatim; this only adds the RPC.

// capturePaneReq is one pane to capture. Mirrors the per-pane fields the JS
// capturePanes path needs: Key (the map key / sentinel tag), Container (docker
// container, or "" for a bare-tmux chat), Session (the tmux target, falling back
// to Container then "agent" — identical to src/chats.js).
type capturePaneReq struct {
	Key       string `json:"key"`
	Container string `json:"container"`
	Session   string `json:"session"`
}

type capturePanesParams struct {
	Panes []capturePaneReq `json:"panes"`
}

// shellQuote wraps s in POSIX single quotes, escaping embedded single quotes.
// Byte-identical to src/ssh.js shellQuote() so the host-side command the
// companion builds matches the default runWithPool capturePanes path exactly.
func shellQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", "'\\''") + "'"
}

// buildCaptureScript builds the batched, sentinel-framed capture script for one
// host. It is byte-for-byte identical to src/chats.js buildCaptureScript(list):
// each pane is bracketed by ___B_<key>___ / ___E_<key>___ sentinels, and the
// tmux invocation is `docker exec <container> tmux` when a container is set,
// else bare `tmux` (so bare-tmux / manual chats still work). The whole batch
// runs in one shell — one local fan-out, zero further ssh handshakes.
//
// NOTE: like the default JS path, <key> is interpolated inside the single-quoted
// printf argument verbatim. Keys are warden chat keys (container / session
// names matching ^[A-Za-z0-9_.-]+$), never free-form user input, so they cannot
// break the single-quoting — the same trust boundary the default path relies on.
func buildCaptureScript(panes []capturePaneReq) string {
	parts := make([]string, 0, len(panes))
	for _, c := range panes {
		key := c.Key
		var tmuxCmd string
		if c.Container != "" {
			tmuxCmd = "docker exec " + shellQuote(c.Container) + " tmux"
		} else {
			tmuxCmd = "tmux"
		}
		target := c.Session
		if target == "" {
			target = c.Container
		}
		if target == "" {
			target = "agent"
		}
		s := shellQuote(target)
		parts = append(parts,
			"printf '___B_"+key+"___\\n'; "+tmuxCmd+
				" capture-pane -t "+s+" -p -e -S -60 -E - 2>/dev/null; "+
				"printf '\\n___E_"+key+"___\\n'")
	}
	return strings.Join(parts, "; ")
}

// stripSentinel returns the key from a ___B_<key>___ / ___E_<key>___ line, or
// ok=false when the line is not a sentinel (or the key is empty — the JS parser
// regex (.+) requires at least one character, which this mirrors).
func stripSentinel(line, prefix string) (key string, ok bool) {
	const suffix = "___"
	if !strings.HasPrefix(line, prefix) || !strings.HasSuffix(line, suffix) {
		return "", false
	}
	k := line[len(prefix):len(line)-len(suffix)]
	if k == "" {
		return "", false
	}
	return k, true
}

// parseCaptureSentinels extracts the key->content map from the stdout of the
// batched capture script. Byte-for-byte equivalent to src/chats.js
// parseCaptureSentinels(): a ___B_<key>___ line opens a pane (resetting the
// buffer, no commit), ___E_<key>___ closes it (committing the buffered lines
// joined by "\n"), and any line in between is captured content. Lines outside a
// B/E block are ignored, so a login-shell profile banner cannot corrupt output.
func parseCaptureSentinels(stdout string) map[string]string {
	out := map[string]string{}
	var cur string
	inBlock := false
	var buf []string
	for _, ln := range strings.Split(stdout, "\n") {
		if key, isB := stripSentinel(ln, "___B_"); isB {
			cur = key
			buf = nil
			inBlock = true
			continue
		}
		if _, isE := stripSentinel(ln, "___E_"); isE {
			if inBlock {
				out[cur] = strings.Join(buf, "\n")
			}
			inBlock = false
			cur = ""
			buf = nil
			continue
		}
		if inBlock {
			buf = append(buf, ln)
		}
	}
	return out
}

// capturePanes mirrors warden's batched capturePanes (src/chats.js) for ONE host:
// build the ___B_/___E_ sentinel-framed batch script, run it once in a login
// shell LOCALLY on the host (the per-op-handshake win — no further ssh), parse
// the sentinels back into a key->content map, return it in one RPC response. The
// docker-exec vs bare-tmux selection is reproduced faithfully via
// buildCaptureScript so both yatfa (container set) and manual (bare-tmux) chats
// work through the companion.
func capturePanes(params json.RawMessage) (map[string]string, error) {
	var p capturePanesParams
	if len(params) > 0 {
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, fmt.Errorf("invalid capturePanes params: %s", err)
		}
	}
	if len(p.Panes) == 0 {
		return map[string]string{}, nil
	}
	script := buildCaptureScript(p.Panes)
	// `bash -lc` mirrors the default runWithPool path (CLAUDE.md: always wrap
	// remote commands in a login shell) so docker/tmux resolve on PATH exactly as
	// they do over SSH today.
	out, err := exec.Command("bash", "-lc", script).Output()
	if err != nil {
		stderr := ""
		if exitErr, ok := err.(*exec.ExitError); ok {
			stderr = strings.TrimSpace(string(exitErr.Stderr))
		}
		if stderr == "" {
			stderr = err.Error()
		}
		return nil, fmt.Errorf("capturePanes script failed: %s", stderr)
	}
	return parseCaptureSentinels(string(out)), nil
}

// ------------------------------- hasSession ---------------------------------
// WARDEN-382 (slice 3 of roadmap WARDEN-270). has-session is the pre-attach /
// pre-recovery LIVENESS PROBE: it fires on every pane open + the recovery flows,
// so — like discover and capturePanes — migrating it onto the persistent
// companion channel collapses the per-probe SSH handshake the default
// probeSession path pays (one ssh spawn per probe). The bootstrap+channel are
// slice 1's, reused verbatim; this only adds the RPC.

// hasSession is the liveness-probe RPC. It runs `tmux has-session -t <target>`
// LOCALLY on the host using the IDENTICAL docker-exec/bare-tmux selection as
// buildCaptureScript (main.go:253-277: `docker exec <container> tmux` when
// container is set, else bare `tmux`). The target falls back session → container
// → "agent" (same fallback chain as capturePanes). has-session exits 0 only when
// the session exists, so exists = (exit 0). `bash -lc` mirrors capturePanes /
// the default runWithPool path so docker and tmux resolve on PATH identically.
//
// The result is returned as {ok:true, exists:<bool>}: the RPC itself never fails
// (a host-side command failure — tmux missing, container absent — is simply
// exists:false, never an RPC error), so the only {ok:false} this RPC can produce
// is the dispatch-level "unknown method" path. This is what lets warden map the
// result to the tri-state attach reason unambiguously: exists separates
// "session absent" from "host unreachable", which the raw-SSH isTransportFailure
// heuristic could only guess at.
func hasSession(params json.RawMessage) (map[string]any, error) {
	var p hasSessionParams
	if len(params) > 0 {
		_ = json.Unmarshal(params, &p) // bad params → fall through to defaults
	}
	target := p.Session
	if target == "" {
		target = p.Container
	}
	if target == "" {
		target = "agent"
	}
	var tmuxCmd string
	if p.Container != "" {
		tmuxCmd = "docker exec " + shellQuote(p.Container) + " tmux"
	} else {
		tmuxCmd = "tmux"
	}
	script := tmuxCmd + " has-session -t " + shellQuote(target)
	err := exec.Command("bash", "-lc", script).Run()
	return map[string]any{"exists": err == nil}, nil
}

// ------------------------------- lifecycle -----------------------------------
// WARDEN-386 (slice 3 of roadmap WARDEN-270). The agent lifecycle commands —
// spawn (create) + kill (destroy) — are the create/destroy twins that today still
// spawn their own per-op SSH handshake. These two RPCs run the tmux command
// LOCALLY on the host in one round-trip over the persistent channel (the per-op-
// handshake win), mirroring the shipped capturePanes sibling. The bootstrap +
// channel are slice 1's, reused verbatim; this only adds the two RPCs.

// spawnSessionParams mirrors the fields warden's tmux.spawn() (src/tmux.js) needs
// to build the new-session argv: Container (docker container, or "" for a bare-
// tmux / manual chat → bare `tmux`), Session (the tmux target, falling back to
// Container then "agent" — identical to src/tmux.js sess()), Cwd (the working dir
// for `-c`; chat.cwd VERBATIM for remote, "" → omit `-c`), and Cmd (the command
// argv appended after the tmux flags; empty → tmux launches its own default shell,
// the WARDEN-223 "no explicit shell" case).
type spawnSessionParams struct {
	Container string   `json:"container"`
	Session   string   `json:"session"`
	Cwd       string   `json:"cwd"`
	Cmd       []string `json:"cmd"`
}

// killSessionParams mirrors tmux.kill(): Container + Session (same fallback as
// spawnSession). kill is idempotent/best-effort, so only the target is needed.
type killSessionParams struct {
	Container string `json:"container"`
	Session   string `json:"session"`
}

// tmuxPrefix reproduces the docker-exec vs bare-tmux selection from
// buildCaptureScript (and src/ssh.js runTmux's prefix): `docker exec <container>
// tmux` when a container is set, else bare `tmux` — so both yatfa (container set)
// and manual (bare-tmux) chats work through the companion. The container is
// shell-quoted (byte-identical to buildCaptureScript / ssh.js shellQuote).
func tmuxPrefix(container string) string {
	if container != "" {
		return "docker exec " + shellQuote(container) + " tmux"
	}
	return "tmux"
}

// resolveSession applies the Session -> Container -> "agent" fallback shared by
// src/tmux.js sess() and buildCaptureScript's target selection, so the companion
// resolves the tmux target identically to the default path.
func resolveSession(session, container string) string {
	if session != "" {
		return session
	}
	if container != "" {
		return container
	}
	return "agent"
}

// spawnSession mirrors warden's tmux.spawn() (src/tmux.js): creates a detached
// tmux session via `new-session -d -s <session> -x 120 -y 32 [-c <cwd>] <cmd...>`,
// run LOCALLY on the host in one round-trip. The argv is byte-for-byte identical
// to the default runTmux path (src/tmux.js spawn builds the same args; ssh.js
// runTmux shell-quotes each and prefixes docker-exec/bare tmux):
//   - `-d` detached, `-s <session>`, `-x 120 -y 32` initial size
//   - optional `-c <cwd>` (cwd is chat.cwd VERBATIM for remote — the msys-path
//     translation in tmux.js is LOCAL-only and does NOT apply on the companion path)
//   - the cmd argv (`chat.cmd.split(/\s+/).filter(Boolean)`); an EMPTY cmd launches
//     tmux's default shell (WARDEN-223): no trailing argv is appended.
// Each argv element is shell-quoted (byte-identical to ssh.js shellQuote) and run
// in a login shell (`bash -lc`, per CLAUDE.md) so docker/tmux resolve on PATH
// exactly as they do over SSH today.
func spawnSession(params json.RawMessage) error {
	var p spawnSessionParams
	if len(params) > 0 {
		if err := json.Unmarshal(params, &p); err != nil {
			return fmt.Errorf("invalid spawnSession params: %s", err)
		}
	}
	session := resolveSession(p.Session, p.Container)
	argv := []string{"new-session", "-d", "-s", session, "-x", "120", "-y", "32"}
	if p.Cwd != "" {
		argv = append(argv, "-c", p.Cwd)
	}
	argv = append(argv, p.Cmd...)
	quoted := make([]string, len(argv))
	for i, a := range argv {
		quoted[i] = shellQuote(a)
	}
	script := tmuxPrefix(p.Container) + " " + strings.Join(quoted, " ")
	_, err := exec.Command("bash", "-lc", script).Output()
	if err != nil {
		stderr := ""
		if exitErr, ok := err.(*exec.ExitError); ok {
			stderr = strings.TrimSpace(string(exitErr.Stderr))
		}
		if stderr == "" {
			stderr = err.Error()
		}
		return fmt.Errorf("spawnSession failed: %s", stderr)
	}
	return nil
}

// killSession mirrors warden's tmux.kill() (src/tmux.js): `kill-session -t
// <session>`, run LOCALLY on the host. kill is IDEMPOTENT / best-effort:
// kill-session on an already-dead session is a no-op the caller already swallows
// (src/server.js /api/kill try/catch noop, "a dead session may not exist"). So a
// "session not found" / "no server running" outcome is surfaced as a benign ok
// (nil), not a hard error — any OTHER failure (docker exec failed, tmux missing)
// is returned as an error. This preserves /api/kill's best-effort semantics: the
// session being already gone is exactly what the caller wanted.
func killSession(params json.RawMessage) error {
	var p killSessionParams
	if len(params) > 0 {
		if err := json.Unmarshal(params, &p); err != nil {
			return fmt.Errorf("invalid killSession params: %s", err)
		}
	}
	session := resolveSession(p.Session, p.Container)
	script := tmuxPrefix(p.Container) + " kill-session -t " + shellQuote(session)
	_, err := exec.Command("bash", "-lc", script).Output()
	if err == nil {
		return nil
	}
	// A missing session (or no tmux server at all) is the idempotent case — the
	// session is already gone, which is what the caller wanted. tmux reports these
	// as "can't find session: <name>" / "no server running on <socket>"; the same
	// strings surface when docker-exec'ing tmux in a container with no server.
	stderr := ""
	if exitErr, ok := err.(*exec.ExitError); ok {
		stderr = string(exitErr.Stderr)
	}
	low := strings.ToLower(stderr)
	if strings.Contains(low, "can't find session") ||
		strings.Contains(low, "session not found") ||
		strings.Contains(low, "no server running") {
		return nil // benign: the session is already gone
	}
	msg := strings.TrimSpace(stderr)
	if msg == "" {
		msg = err.Error()
	}
	return fmt.Errorf("killSession failed: %s", msg)
}
