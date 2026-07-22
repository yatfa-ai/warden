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
//	request : {"id":<any-json>,"method":"ping"|"discover"|"capturePanes"|"hasSession"|"resize"|"send"|"sendKeys"|"subscribePanes"|"unsubscribePanes","params":{...}}
//	response: {"id":<echoed>,"ok":true,"result":{...}}
//	          {"id":<echoed>,"ok":false,"error":"..."}
//	event   : {"event":"paneDelta","panes":{key:content,…}}   // UNSOLICITED — no id
//
// `id` is echoed untouched so the caller (warden) can be a multiplexing client
// with many requests in flight on the one stdio channel. stderr is for human
// diagnostics only — warden never parses it.
//
// subscribePanes (WARDEN-413) is the one unsolicited-emitter: after it ACKs, the
// companion pushes paneDelta event lines for ONLY the panes that changed (an
// empty-panes line is a liveness heartbeat) so warden can render idle panes from
// the push instead of polling capturePanes every tick. Events carry NO id, so
// warden's _onLine routes any line with an `event` field to a handler instead of
// matching it against a pending request — a strictly additive protocol addition.
package main

import (
	"bufio"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"
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

	// All stdout writes go through one encoder + mutex so the subscription
	// watcher's unsolicited paneDelta events can never interleave half-lines with
	// RPC responses (both go through writeLine). Requests are read serially today;
	// only the watcher goroutine runs concurrently, and it shares this mutex.
	var outMu sync.Mutex
	enc := json.NewEncoder(os.Stdout)
	writeLine := func(v any) {
		outMu.Lock()
		defer outMu.Unlock()
		_ = enc.Encode(v) // json.Encoder appends the newline delimiter
	}
	write := func(r Response) { writeLine(r) }

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
				"methods": []string{"ping", "discover", "capturePanes", "hasSession", "spawnSession", "killSession", "resize", "send", "sendKeys", "subscribePanes", "unsubscribePanes"},
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
		case "resize":
			// resize is the interactive-pane control-plane op (WARDEN-409): runs
			// `set-option -t <target> window-size latest` LOCALLY. It returns the
			// raw cmdResult (ok/code/stdout/stderr), never an RPC error for a
			// host-side command failure — same "never fails the RPC" shape as
			// hasSession, only richer (it carries stdout/stderr/code so the JS side
			// maps it to the identical runTmux result the default path produces).
			write(Response{ID: req.ID, OK: true, Result: resize(req.Params)})
		case "send":
			// send is the user-input WRITE op (WARDEN-888): runs the WARDEN-254
			// bracketed-paste sequence host-side in ONE atomic bash -lc script. It
			// returns the raw cmdResult — never an RPC error for a host-side command
			// failure (e.g. "can't find session") — same shape as resize, so the JS
			// side maps it to the identical runTmux result the default path produces.
			write(Response{ID: req.ID, OK: true, Result: send(req.Params)})
		case "sendKeys":
			// sendKeys is the special-key WRITE op (WARDEN-888): runs
			// `send-keys -t <target> <key>` for a key the JS side ALREADY validated
			// against its ALLOWED_KEYS trust boundary. Returns the raw cmdResult,
			// same shape as send/resize.
			write(Response{ID: req.ID, OK: true, Result: sendKeys(req.Params)})
		case "subscribePanes":
			// WARDEN-413: start (or replace) a background watcher that re-captures
			// the pane set on a short interval and pushes paneDelta events for ONLY
			// the panes that changed (empty-panes = heartbeat). The ACK returns
			// immediately; emission happens asynchronously via writeLine. An empty
			// pane list stops any running watcher (treated as unsubscribe).
			var p capturePanesParams
			if len(req.Params) > 0 {
				_ = json.Unmarshal(req.Params, &p) // bad params -> empty -> stop watcher
			}
			startSubscription(p.Panes, writeLine)
			write(Response{ID: req.ID, OK: true, Result: map[string]any{"subscribed": len(p.Panes)}})
		case "unsubscribePanes":
			stopSubscription()
			write(Response{ID: req.ID, OK: true, Result: map[string]any{"unsubscribed": true}})
		default:
			write(Response{ID: req.ID, OK: false, Error: "unknown method: " + req.Method})
		}
	}
	// Stop the watcher if the channel (stdin) closed so a reconnect starts clean.
	stopSubscription()
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
	k := line[len(prefix) : len(line)-len(suffix)]
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

// capturePanesList runs the batched capture for an already-parsed pane list and
// returns the key->content map. Shared by capturePanes (the RPC) and the
// subscribePanes watcher (which re-captures the same set on each tick to diff).
func capturePanesList(panes []capturePaneReq) (map[string]string, error) {
	if len(panes) == 0 {
		return map[string]string{}, nil
	}
	script := buildCaptureScript(panes)
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
	return capturePanesList(p.Panes)
}

// ----------------------------- subscribePanes --------------------------------
// WARDEN-413 (problem #3 of roadmap WARDEN-270). capture-pane is polled every 2s
// monitor tick + every observer poll even when nothing changed; for an idle fleet
// (the common state) that is pure waste scaled by hosts × panes × scrollback.
// subscribePanes flips REMOTE pane capture from PULL to PUSH: after an initial
// capture, a background watcher re-captures the pane set on a short interval,
// content-hashes each pane, and emits unsolicited paneDelta event lines for ONLY
// the panes whose hash changed (an empty-panes line is a liveness heartbeat). The
// Node side renders idle panes from the push and SKIPS the capturePanes RPC on
// the monitor tick, collapsing idle-fleet channel traffic to ~0 while active panes
// still update within one tick interval.
//
// Emission rides the SAME stdio channel (no port) through writeLine so event
// lines never interleave with RPC responses. Stays user-space: a local content
// hash is the change signal — no tmux change-detection prerequisite.

// paneDeltaEvent is the unsolicited push line. Panes carries ONLY the panes that
// changed since the last push; an empty map is a liveness heartbeat (the Node
// side refreshes its freshness timer on any paneDelta, payload or not).
type paneDeltaEvent struct {
	Event string            `json:"event"`
	Panes map[string]string `json:"panes"`
}

const (
	// subscribeInterval is the watcher's local re-capture cadence. Kept just under
	// one monitor-tick interval (2s) so a pane whose content changes is pushed
	// within ~one tick — the success measure's "active panes update as promptly as
	// today".
	subscribeInterval = 1 * time.Second
	// subscribeHeartbeat is how long the watcher stays silent before emitting an
	// empty-panes heartbeat. Must stay BELOW warden's freshness window
	// (PANE_DELTA_FRESH_MS in src/companion.js, 3 monitor ticks = 6s) so a live
	// idle host keeps warden out of its poll backstop; small enough that idle
	// channel traffic is ~0 (one tiny line every few seconds, not a 60-line × N
	// capture every tick).
	subscribeHeartbeat = 4 * time.Second
)

// paneSubscription is one active watcher. Exactly one is live per process (the
// companion serves one warden client over its one stdio channel).
type paneSubscription struct {
	mu     sync.Mutex
	panes  []capturePaneReq  // current pane set (the latest subscribePanes)
	hashes map[string]string // key -> last-emitted content hash
	stop   chan struct{}
	done   chan struct{}
}

var (
	subMu     sync.Mutex
	activeSub *paneSubscription
)

// hashContent returns a stable hex digest of a pane's captured content. Only used
// for change detection, so a collision would at worst skip one push (corrected on
// the next change) — sha256 makes that effectively impossible.
func hashContent(content string) string {
	sum := sha256.Sum256([]byte(content))
	return hex.EncodeToString(sum[:])
}

// diffPanes computes which captured panes changed vs the last-emitted hashes and
// updates the hash map in place. Pure (no I/O) so it is unit-testable. A pane
// present in hashes but absent from captured is dropped (the pane left the set).
func diffPanes(captured, hashes map[string]string) map[string]string {
	changed := map[string]string{}
	for k, content := range captured {
		h := hashContent(content)
		if prev, ok := hashes[k]; !ok || prev != h {
			hashes[k] = h
			changed[k] = content
		}
	}
	for k := range hashes {
		if _, ok := captured[k]; !ok {
			delete(hashes, k)
		}
	}
	return changed
}

// captureOnce re-captures the current pane set and pushes a paneDelta for the
// changed panes (or an empty-heartbeat if idle longer than subscribeHeartbeat).
// lastEmit is the time of the last push (in/out) so heartbeats reset the timer.
// A capture failure is non-fatal: the watcher skips this tick and tries again
// next interval (a transient bash/tmux failure must never break the push path or
// wedge the ACK'd RPC channel — warden's freshness backstop covers a stuck push).
func (s *paneSubscription) captureOnce(writeLine func(any), lastEmit *time.Time, now time.Time) {
	s.mu.Lock()
	panes := append([]capturePaneReq(nil), s.panes...)
	s.mu.Unlock()
	if len(panes) == 0 {
		return
	}
	captured, err := capturePanesList(panes)
	if err != nil {
		return // transient — retry next tick; never wedge the channel.
	}
	s.mu.Lock()
	changed := diffPanes(captured, s.hashes)
	dueHeartbeat := now.Sub(*lastEmit) >= subscribeHeartbeat
	s.mu.Unlock()
	if len(changed) > 0 || dueHeartbeat {
		writeLine(paneDeltaEvent{Event: "paneDelta", Panes: changed})
		*lastEmit = now
	}
}

// loop runs the watcher until stop is closed. An immediate first capture pushes
// the full initial state (every pane is "changed" against an empty hash map), so
// warden's cache populates within ~one interval of the ACK rather than waiting a
// tick.
func (s *paneSubscription) loop(writeLine func(any)) {
	defer close(s.done)
	ticker := time.NewTicker(subscribeInterval)
	defer ticker.Stop()
	lastEmit := time.Now()
	// Immediate initial capture: the first diff sees every pane as new and pushes
	// the full set, so the Node cache is seeded without waiting for a tick.
	s.captureOnce(writeLine, &lastEmit, lastEmit)
	for {
		select {
		case <-s.stop:
			return
		case now := <-ticker.C:
			s.captureOnce(writeLine, &lastEmit, now)
		}
	}
}

// startSubscription stops any running watcher and starts a new one for panes.
// Called from the dispatch loop (synchronously handling subscribePanes); it
// returns once the new watcher goroutine has started (the goroutine runs in the
// background). An empty pane list stops the watcher without starting a new one
// (unsubscribe semantics). Blocking on the previous watcher's done channel
// guarantees a clean handoff: no two watchers ever capture/emit concurrently.
func startSubscription(panes []capturePaneReq, writeLine func(any)) {
	subMu.Lock()
	defer subMu.Unlock()
	if activeSub != nil {
		close(activeSub.stop)
		<-activeSub.done
		activeSub = nil
	}
	if len(panes) == 0 {
		return
	}
	s := &paneSubscription{
		panes:  panes,
		hashes: map[string]string{},
		stop:   make(chan struct{}),
		done:   make(chan struct{}),
	}
	activeSub = s
	go s.loop(writeLine)
}

// stopSubscription stops the running watcher (unsubscribePanes, or stdin close).
func stopSubscription() {
	subMu.Lock()
	defer subMu.Unlock()
	if activeSub != nil {
		close(activeSub.stop)
		<-activeSub.done
		activeSub = nil
	}
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
// buildCaptureScript (tmuxCmdFor: `docker exec <container> tmux` when container
// is set, else bare `tmux`). The target falls back session → container → "agent"
// (same fallback chain as capturePanes). has-session exits 0 only when the
// session exists, so exists = (exit 0). `bash -lc` mirrors capturePanes / the
// default runWithPool path so docker and tmux resolve on PATH identically.
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
	script := tmuxCmdFor(p.Container) + " has-session -t " + shellQuote(target)
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

// ------------------------------- resize -------------------------------------
// WARDEN-409 (slice 4 of roadmap WARDEN-270). The interactive-pane CONTROL-PLANE
// tmux command — `resize` (set-option window-size latest) — is a one-line
// request/response tmux-option op that fires on every pane OPEN and every
// in-session RESIZE (resize again). Routing it over the persistent companion
// channel collapses the per-open / per-resize SSH handshake the default runTmux
// path pays — after this slice the ONLY remaining raw-SSH path on the attach
// flow is the live interactive PTY itself (the roadmap's separate open question).
// The bootstrap+channel are slice 1's, reused verbatim; this only adds the RPC.
//
// Unlike hasSession (which returns only {exists} and captures no stdout), this
// returns the RAW cmdResult {ok, code, stdout, stderr} — the same shape runTmux
// produces — so the JS side maps it to the identical result the default path
// emits and the server.js best-effort call site is unchanged.

// cmdResult is the raw {ok, code, stdout, stderr} shape src/ssh.js runTmux /
// runLocalTmux produce. The control-plane RPC (resize) returns it verbatim
// so the JS client can feed it straight back as the runTmux result (the
// "both paths agree by construction" parity contract). Mirrors the JS result
// shape, not the {exists}/{panes} domain envelopes the other RPCs use.
type cmdResult struct {
	OK     bool   `json:"ok"`
	Code   int    `json:"code"`
	Stdout string `json:"stdout"`
	Stderr string `json:"stderr"`
}

// tmuxCmdFor builds the `docker exec <container> tmux` prefix (container set) or
// bare `tmux` (bare-tmux / manual chat) — the IDENTICAL selection
// buildCaptureScript makes per-pane (main.go buildCaptureScript). Shared by the
// control-plane RPC (resize), the lifecycle RPCs (spawnSession/killSession),
// and hasSession so the docker-exec vs bare-tmux resolution lives once. The
// container is shell-quoted (byte-identical to buildCaptureScript / ssh.js shellQuote).
func tmuxCmdFor(container string) string {
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
//
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
	script := tmuxCmdFor(p.Container) + " " + strings.Join(quoted, " ")
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
	script := tmuxCmdFor(p.Container) + " kill-session -t " + shellQuote(session)
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

// runTmuxRaw runs a tmux command via `bash -lc` LOCALLY on the host (the per-op-
// handshake win — no further ssh) and returns the raw {ok, code, stdout, stderr}
// result. Unlike hasSession's `.Run()` (exit only), this captures BOTH streams so
// the control-plane RPC can return stdout. `bash -lc` mirrors capturePanes / the
// default runWithPool path so docker and tmux resolve on PATH exactly as they do
// over SSH today.
func runTmuxRaw(script string) cmdResult {
	cmd := exec.Command("bash", "-lc", script)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()
	code := 0
	if err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok {
			code = exitErr.ExitCode()
		} else {
			code = -1 // spawn-level failure (bash missing, etc.) — mirrors runTmux's -1
		}
	}
	return cmdResult{OK: err == nil, Code: code, Stdout: stdout.String(), Stderr: stderr.String()}
}

// resizeParams is the resize RPC params (WARDEN-409). Container is the docker
// container (empty for a bare-tmux / manual chat); Session is the tmux target,
// falling back to Container then "agent" — identical to hasSession / capturePanes.
// Both are JSON-serialized RPC params, never persisted fields.
type resizeParams struct {
	Container string `json:"container"`
	Session   string `json:"session"`
}

// buildResizeScript builds the `set-option -t <target> window-size latest` command
// the resize RPC runs host-side via bash -lc. <target> is shellQuoted and defaults
// to "agent"; the docker-exec/bare-tmux prefix is selected by container. Byte-for-
// byte identical to src/tmux.js resize() (the default runTmux path), so the
// companion and default paths build the SAME command — the "both paths agree by
// construction" parity contract. Exposed + tested directly (mirrors
// buildCaptureScript / buildActivityScript).
func buildResizeScript(container, target string) string {
	if target == "" {
		target = "agent"
	}
	return tmuxCmdFor(container) + " set-option -t " + shellQuote(target) + " window-size latest"
}

// resize runs `set-option -t <target> window-size latest` LOCALLY via bash -lc,
// mirroring src/tmux.js resize() byte-for-byte (window-size latest so tmux follows
// whichever client is active; ConPTY's SIGWINCH then propagates through ssh →
// tmux). Returns the raw cmdResult — never an RPC error for a host-side command
// failure — so the JS side maps it to the identical runTmux result the default
// path produces.
func resize(params json.RawMessage) cmdResult {
	var p resizeParams
	if len(params) > 0 {
		_ = json.Unmarshal(params, &p) // bad params → fall through to defaults
	}
	target := p.Session
	if target == "" {
		target = p.Container
	}
	return runTmuxRaw(buildResizeScript(p.Container, target))
}

// ------------------------------- send / sendKeys ------------------------------
// WARDEN-888 (the final slice of roadmap WARDEN-270). The user-input WRITE path —
// send (a directive) + sendKey (a special key) — is the last op family that still
// pays a per-op SSH handshake on remote hosts. Routing it over the persistent
// companion channel collapses the per-message handshake (the ~30s/action cost on
// the ControlMaster-disabled / Windows path that is this roadmap's reason for
// existing). The bootstrap + channel are slice 1's, reused verbatim; this only
// adds the two RPCs. Both return the raw cmdResult (ok/code/stdout/stderr) —
// never an RPC error for a host-side command failure — identical to resize, so
// the JS side maps each to the runTmux result the default path produces.

// sendParams is the send RPC params (WARDEN-888). Container is the docker
// container (empty for a bare-tmux / manual chat); Session is the tmux target,
// falling back to Container then "agent" — identical to resize / hasSession. Text
// is the message body (an arbitrary user directive; shell-quoted host-side via
// shellQuote, never interpolated raw). All JSON-serialized RPC params, never
// persisted fields (the same trust boundary resize's target already relies on).
type sendParams struct {
	Container string `json:"container"`
	Session   string `json:"session"`
	Text      string `json:"text"`
}

// sendKeysParams is the sendKey RPC params (WARDEN-888). Key is a special-key
// name the JS side has ALREADY validated against its ALLOWED_KEYS allowlist
// (tmux.js); the trust boundary stays JS-side, so the host runs send-keys with
// the already-validated key verbatim.
type sendKeysParams struct {
	Container string `json:"container"`
	Session   string `json:"session"`
	Key       string `json:"key"`
}

// sendSeqCounter + sendBufMu generate a per-process-unique tmux buffer name for
// one multiline send, mirroring the JS `warden-send-${Date.now()}-${++sendSeq}`
// (src/tmux.js). Uniqueness keeps two concurrent sends to the same tmux server
// from clobbering each other's buffer between the set-buffer and paste-buffer
// calls. Requests are read serially today, but the mutex makes the counter safe
// if that ever changes.
var (
	sendBufSeq uint64
	sendBufMu  sync.Mutex
)

func nextSendBuffer() string {
	sendBufMu.Lock()
	defer sendBufMu.Unlock()
	sendBufSeq++
	return fmt.Sprintf("warden-send-%d-%d", time.Now().UnixNano(), sendBufSeq)
}

// buildSendScript builds the atomic bash -lc script the send RPC runs host-side.
// It reproduces src/tmux.js send()'s WARDEN-254 bracketed-paste sequence in ONE
// shell script (one local round-trip, zero further ssh), building the SAME tmux
// argv the default runTmux path issues:
//
//   - single-line (no embedded newline): `send-keys -t <target> -l <text>` then
//     `send-keys -t <target> Enter` (chained with && so Enter fires only on
//     success, exactly like the JS `if (r.ok) r = await … Enter`).
//   - multiline: `set-buffer -b <buf> -- <text>` && `paste-buffer -p -d -b <buf>
//     -t <target>` && `send-keys -t <target> Enter`, then a best-effort
//     delete-buffer on failure.
//
// The multiline buffer is reclaimed two ways, matching tmux.js:63-74: paste-buffer
// `-d` deletes it on a successful paste (happy path → single -d), and the
// `|| { rc=$?; delete-buffer; exit $rc; }` block reclaims it when the paste itself
// failed (the buffer would otherwise leak on the durable tmux server once per retry
// against a dead session). Capturing rc BEFORE the cleanup (delete-buffer would
// clobber $?) and explicitly `exit $rc` preserves the REAL failure's exit code —
// the cleanup never turns a failed send into a 0. delete-buffer errors if the
// buffer is already gone (a -d-reclaimed successful paste, or a failed set-buffer)
// — `2>/dev/null` swallows that stderr so it can't clobber the real tmux error.
// <buf> is unique per call (see nextSendBuffer) so two concurrent sends can't
// clobber each other's buffer. <text> is shellQuoted (handles arbitrary user input
// + embedded newlines + a leading "-"); the `--` separator protects leading-dash
// data from tmux itself. Exposed + tested directly (mirrors buildResizeScript /
// buildCaptureScript).
func buildSendScript(container, target, text, buf string) string {
	tmux := tmuxCmdFor(container)
	if target == "" {
		target = "agent"
	}
	// Single-line (no embedded newline): literal text via send-keys -l, then Enter
	// (chained with && so Enter fires only on success — exactly like the JS
	// `if (r.ok) r = await … Enter`).
	if !strings.Contains(text, "\n") {
		return tmux + " send-keys -t " + shellQuote(target) + " -l " + shellQuote(text) +
			" && " + tmux + " send-keys -t " + shellQuote(target) + " Enter"
	}
	// Multiline → one bracketed paste via a per-call named buffer, then a single
	// Enter. On success the buffer is already reclaimed by paste-buffer -d and the
	// `||` cleanup is skipped; on failure the cleanup reclaims it and propagates
	// the real exit code via `exit $rc`.
	return tmux + " set-buffer -b " + shellQuote(buf) + " -- " + shellQuote(text) +
		" && " + tmux + " paste-buffer -p -d -b " + shellQuote(buf) + " -t " + shellQuote(target) +
		" && " + tmux + " send-keys -t " + shellQuote(target) + " Enter" +
		" || { rc=$?; " + tmux + " delete-buffer -b " + shellQuote(buf) + " 2>/dev/null; exit $rc; }"
}

// buildSendKeysScript builds the `send-keys -t <target> <key>` command the sendKey
// RPC runs host-side via bash -lc, byte-for-byte identical to src/tmux.js
// sendKey()'s default runTmux path. <key> is the already-VALIDATED special-key
// name (ALLOWED_KEYS lives JS-side). Exposed + tested directly.
func buildSendKeysScript(container, target, key string) string {
	if target == "" {
		target = "agent"
	}
	return tmuxCmdFor(container) + " send-keys -t " + shellQuote(target) + " " + shellQuote(key)
}

// send runs the WARDEN-254 write sequence LOCALLY via bash -lc, mirroring
// src/tmux.js send() byte-for-byte for both single-line and multiline input.
// Returns the raw cmdResult — never an RPC error for a host-side command failure
// (e.g. "can't find session") — so the JS side maps it to the identical runTmux
// result the default path produces.
func send(params json.RawMessage) cmdResult {
	var p sendParams
	if len(params) > 0 {
		_ = json.Unmarshal(params, &p) // bad params → fall through to defaults
	}
	target := resolveSession(p.Session, p.Container)
	return runTmuxRaw(buildSendScript(p.Container, target, p.Text, nextSendBuffer()))
}

// sendKeys runs `send-keys -t <target> <key>` LOCALLY via bash -lc, mirroring
// src/tmux.js sendKey() byte-for-byte (the key is already validated JS-side).
// Returns the raw cmdResult — same shape as send / resize.
func sendKeys(params json.RawMessage) cmdResult {
	var p sendKeysParams
	if len(params) > 0 {
		_ = json.Unmarshal(params, &p) // bad params → fall through to defaults
	}
	target := resolveSession(p.Session, p.Container)
	return runTmuxRaw(buildSendKeysScript(p.Container, target, p.Key))
}
