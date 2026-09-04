package main

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"sync"
	"sync/atomic"
)

// ------------------------------- attachSession -------------------------------
// WARDEN-1295 (the streaming slice of roadmap WARDEN-270). Every other op family
// is request/response: one command, one result. The LIVE WEB-PANE ATTACH is not
// — it is a bidirectional byte stream with a terminal on the far end, and it was
// the last runtime path still spawning a raw `ssh -tt` child per open pane
// (attachStream → attachTmux → attachPty, one node-pty-wrapped ssh process per
// pane, per open).
//
// This family serves it over the SAME stdio channel every other op rides, with
// no second transport and no listening port:
//
//	attachStart {script, cols, rows, term} -> ACK {sid}   then, unsolicited:
//	  {"event":"attachData","sid":…,"data":<base64>}      // pty output
//	  {"event":"attachExit","sid":…,"code":…}             // child exited
//	attachInput  {sid, data:<base64>} -> {ok:true}        // pty input
//	attachResize {sid, cols, rows}    -> {ok:true}        // TIOCSWINSZ -> SIGWINCH
//	attachKill   {sid}                -> {ok:true}        // tear down
//
// ACK-THEN-STREAM is the subscribePanes contract (main.go:216-227), tightened:
// the output pump is launched only AFTER the {sid} ACK has been written, so the
// client can never receive an attachData for an sid it has not yet learned. The
// serial dispatch loop plus the shared writeLine mutex give the rest for free.
//
// BASE64 FRAMING is not a preference: the channel is newline-delimited JSON, and
// raw PTY bytes are arbitrary binary (control sequences, partial UTF-8 mid-chunk,
// and \n itself). Base64 makes every payload line-safe and byte-exact — a
// terminal stream cannot survive lossy re-encoding, and a UTF-8-decoded chunk
// boundary would corrupt multibyte glyphs. The JS side decodes with the same
// 'binary'/latin1 discipline node-pty's utf8 decoder replaces.
//
// The PTY itself is allocated per-platform (pty_unix.go / pty_windows.go), the
// same split procgroup_unix.go / procgroup_windows.go established.

// hostPTY is one live host-side terminal. The unix implementation wraps
// creack/pty's master fd; the windows one does not exist (see pty_windows.go).
type hostPTY interface {
	Read(b []byte) (int, error)
	Write(b []byte) (int, error)
	Resize(cols, rows uint16) error
	Kill()
	Wait() int
}

// attachDataEvent is the unsolicited output push. Data is base64 of the raw PTY
// bytes — never a decoded string (see the framing note above).
type attachDataEvent struct {
	Event string `json:"event"`
	Sid   string `json:"sid"`
	Data  string `json:"data"`
}

// attachExitEvent is the unsolicited end-of-session push, mirroring node-pty's
// onExit({exitCode}). Code is -1 for a signal death (our own Kill, or the
// session ending under us) — the same convention runScriptCtx uses.
type attachExitEvent struct {
	Event string `json:"event"`
	Sid   string `json:"sid"`
	Code  int    `json:"code"`
}

type attachStartParams struct {
	// Script is the ALREADY-ASSEMBLED host-side command. The Go side EXECUTES
	// it and never rebuilds it — identical to the exec RPC's contract, and the
	// reason the byte-for-byte parity with attachPty is provable JS-side (one
	// builder, both paths: buildAttachRemoteCommand in src/ssh.js).
	Script string `json:"script"`
	Cols   int    `json:"cols"`
	Rows   int    `json:"rows"`
	// Term is the TERM the child should see. warden forwards what node-pty puts
	// on the default path's child (process.env.TERM || 'xterm'), which `ssh -tt`
	// then propagates to the host.
	Term string `json:"term"`
}

type attachInputParams struct {
	Sid string `json:"sid"`
	// Data is base64 of the raw input bytes.
	Data string `json:"data"`
}

type attachResizeParams struct {
	Sid  string `json:"sid"`
	Cols int    `json:"cols"`
	Rows int    `json:"rows"`
}

type attachSidParams struct {
	Sid string `json:"sid"`
}

// attachSession is one live attach. `exitOnce` guarantees exactly one
// attachExit per session however the end arrives (natural exit, our Kill, or a
// read error racing both) — a duplicate 'ended' is precisely what WARDEN-365's
// identity gating exists to survive, so the transport must not manufacture one.
type attachSession struct {
	sid      string
	pty      hostPTY
	exitOnce sync.Once
}

var (
	attachMu       sync.Mutex
	attachSessions = map[string]*attachSession{}
	attachSeq      atomic.Uint64
)

// attachReadChunk is the pty read buffer size. Generous enough that a full-screen
// tmux repaint (a `clear` + redraw of a 200x50 pane with colors) lands in one or
// two events rather than dozens of base64 lines.
const attachReadChunk = 32 * 1024

// defaults mirroring src/ssh.js attachPty's `{ cols = 100, rows = 30 }`.
const (
	attachDefaultCols = 100
	attachDefaultRows = 30
)

// clampDim keeps a wire-supplied dimension inside what a winsize can express.
// warden already floors cols/rows server-side (server.js:2843-2844); this is the
// host-side backstop so a malformed param cannot produce a 0x0 or overflowed
// terminal.
func clampDim(v, def int) uint16 {
	if v <= 0 {
		v = def
	}
	if v > 65535 {
		v = 65535
	}
	return uint16(v)
}

func nextSid() string {
	return fmt.Sprintf("a%d", attachSeq.Add(1))
}

func getAttachSession(sid string) *attachSession {
	attachMu.Lock()
	defer attachMu.Unlock()
	return attachSessions[sid]
}

func dropAttachSession(sid string) {
	attachMu.Lock()
	defer attachMu.Unlock()
	delete(attachSessions, sid)
}

// startAttach allocates the host PTY and REGISTERS the session, returning the
// sid plus a `launch` closure that starts the output pump. The two-phase shape
// is the ACK-then-stream guarantee: main writes the {sid} ACK, THEN calls
// launch(), so no attachData can reach the client before it knows the sid.
// An error (no PTY on this platform, spawn failure) returns before anything is
// registered and surfaces as an {ok:false} attachStart — which warden maps to
// its existing attach_error path (server.js:2873-2877). Never a silent fallback.
func startAttach(params json.RawMessage, writeLine func(any)) (string, func(), error) {
	var p attachStartParams
	if len(params) > 0 {
		if err := json.Unmarshal(params, &p); err != nil {
			return "", nil, fmt.Errorf("invalid attachStart params: %s", err)
		}
	}
	if p.Script == "" {
		return "", nil, fmt.Errorf("attachStart requires a script")
	}
	cols := clampDim(p.Cols, attachDefaultCols)
	rows := clampDim(p.Rows, attachDefaultRows)
	tty, err := startHostPTY(p.Script, p.Term, cols, rows)
	if err != nil {
		return "", nil, fmt.Errorf("attachStart failed to allocate a host PTY: %s", err)
	}
	s := &attachSession{sid: nextSid(), pty: tty}
	attachMu.Lock()
	attachSessions[s.sid] = s
	attachMu.Unlock()
	return s.sid, func() { go s.pump(writeLine) }, nil
}

// pump streams PTY output as base64 attachData events until the terminal closes,
// then reaps the child and emits exactly one attachExit. Runs in its own
// goroutine; writeLine is the shared mutex-guarded encoder, so an event line can
// never interleave with an RPC response or with another session's event.
func (s *attachSession) pump(writeLine func(any)) {
	buf := make([]byte, attachReadChunk)
	for {
		n, err := s.pty.Read(buf)
		if n > 0 {
			writeLine(attachDataEvent{
				Event: "attachData",
				Sid:   s.sid,
				Data:  base64.StdEncoding.EncodeToString(buf[:n]),
			})
		}
		if err != nil {
			// EOF / EIO — the slave side closed (the child exited, or we killed
			// it). Either way the stream is over; reap and report.
			break
		}
	}
	code := s.pty.Wait()
	s.emitExit(writeLine, code)
}

// emitExit publishes the session's single attachExit and deregisters it. The
// sync.Once is what makes "exactly one" true when a kill and a natural exit race.
func (s *attachSession) emitExit(writeLine func(any), code int) {
	s.exitOnce.Do(func() {
		dropAttachSession(s.sid)
		writeLine(attachExitEvent{Event: "attachExit", Sid: s.sid, Code: code})
	})
}

// attachInput writes decoded input bytes to the session's PTY. An unknown sid is
// an error (the session already exited, or the client is confused) rather than a
// silent success, so a wedged pane is diagnosable; warden's wrapper swallows it,
// matching node-pty's write-after-exit being a no-op.
func attachInput(params json.RawMessage) error {
	var p attachInputParams
	if len(params) > 0 {
		if err := json.Unmarshal(params, &p); err != nil {
			return fmt.Errorf("invalid attachInput params: %s", err)
		}
	}
	s := getAttachSession(p.Sid)
	if s == nil {
		return fmt.Errorf("unknown attach session: %s", p.Sid)
	}
	data, err := base64.StdEncoding.DecodeString(p.Data)
	if err != nil {
		return fmt.Errorf("attachInput data is not valid base64: %s", err)
	}
	if len(data) == 0 {
		return nil
	}
	if _, err := s.pty.Write(data); err != nil {
		return fmt.Errorf("attachInput write failed: %s", err)
	}
	return nil
}

// attachResize sets the terminal winsize, which signals SIGWINCH to the
// foreground process group — the host-side equivalent of node-pty's resize()
// propagating through `ssh -tt` on the default path.
func attachResize(params json.RawMessage) error {
	var p attachResizeParams
	if len(params) > 0 {
		if err := json.Unmarshal(params, &p); err != nil {
			return fmt.Errorf("invalid attachResize params: %s", err)
		}
	}
	s := getAttachSession(p.Sid)
	if s == nil {
		return fmt.Errorf("unknown attach session: %s", p.Sid)
	}
	if err := s.pty.Resize(clampDim(p.Cols, attachDefaultCols), clampDim(p.Rows, attachDefaultRows)); err != nil {
		return fmt.Errorf("attachResize failed: %s", err)
	}
	return nil
}

// attachKill tears a session down. IDEMPOTENT like killSession: an already-gone
// sid is a benign success (the caller wanted it gone, and it is), so a
// detach→attach race can never surface a spurious failure to warden's
// best-effort kill call site (server.js:2919).
func attachKill(params json.RawMessage) error {
	var p attachSidParams
	if len(params) > 0 {
		if err := json.Unmarshal(params, &p); err != nil {
			return fmt.Errorf("invalid attachKill params: %s", err)
		}
	}
	s := getAttachSession(p.Sid)
	if s == nil {
		return nil // already gone — exactly what the caller wanted
	}
	s.pty.Kill()
	// The pump observes the closed master, reaps, and emits the single
	// attachExit; we do NOT emit it here (that would race the pump's own).
	return nil
}

// stopAllAttachSessions kills every live attach. Called when stdin closes (the
// channel died), so a reconnect never leaves an orphaned PTY — and a tmux client
// — running on the host. Mirrors stopSubscription's placement at the end of main.
func stopAllAttachSessions() {
	attachMu.Lock()
	sessions := make([]*attachSession, 0, len(attachSessions))
	for _, s := range attachSessions {
		sessions = append(sessions, s)
	}
	attachMu.Unlock()
	for _, s := range sessions {
		s.pty.Kill()
	}
}

// _attachSessionCountForTests reports the live session count so the registry's
// lifecycle (register on start, drop on exit) is assertable. Not used in
// production paths.
func _attachSessionCountForTests() int {
	attachMu.Lock()
	defer attachMu.Unlock()
	return len(attachSessions)
}
