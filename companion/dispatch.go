package main

import (
	"encoding/json"
	"sync"
)

// ------------------------------- dispatcher ---------------------------------
// WARDEN-1491 — the surviving keystroke tail. The companion's request loop used
// to be SERIAL: read request → run handler → write response → read next, so ONE
// slow RPC held every later request — attachInput (the user's keystrokes)
// first among them — unread in stdin until it finished. WARDEN-1402 removed the
// OUTPUT half of that head-of-line block (the writer goroutine in outbound.go);
// this file removes the INPUT half.
//
// What the production histograms showed and the reproduction confirmed
// (scripts/companion-hol-probe.mjs against the pre-fix binary: an exec that
// sleeps 3s makes the next keystroke's echo take 2,914ms instead of 1ms):
//
//   • `exec` carries timeoutMs 8000 plus a 2s WaitDelay backstop — a hung git /
//     file-exists probe holds the loop for up to 10s, which is the recurring
//     ~9.9s max in `pane-input-roundtrip` (and the 9,777ms `file-exists-remote`
//     that ran PAST its own 8s timeout) on every day of telemetry.
//   • subscribePanes replaced the running watcher by closing it and WAITING for
//     its in-flight capture (a sequential docker-exec-per-pane bash script with
//     no deadline) — and warden's 30s TTL sweep restarts it once per released
//     pane, so a seconds-long capture froze the loop on every such restart (the
//     bimodal /api/agent-states: ~1ms one window, 1–8s the next).
//   • discover is one `docker ps` plus per-container docker exec probes — seconds
//     on a loaded host, entirely inside the serial loop.
//
// THE SHAPE OF THE FIX. The loop only DECODES and ROUTES; nothing it calls can
// block on a subprocess or a PTY:
//
//   inline        ping, attachResize, attachKill, subscribePanes,
//                 unsubscribePanes — in-memory/ioctl/signal work that cannot
//                 block (the subscription change is a swap, see startSubscription).
//   per-session   attachInput — a pty.Write can block when the child stops
//                 reading; it rides that SESSION's own ordered lane, so a stuck
//                 pane stalls only itself and keystrokes stay in order.
//   control lane  send / sendKeys / resize / spawnSession / killSession — one
//                 ordered lane: these mutate tmux state and callers (send then
//                 Enter) rely on the order the serial loop used to give them,
//                 but they no longer queue behind reads or exec.
//   heavy pool    exec / writeFile / discover / capturePanes / hasSession /
//                 attachStart — independent subprocess work, run concurrently
//                 (bounded) so one 10s probe delays only itself.
//
// Responses are written by whichever goroutine finished the work; the outbound
// queue (outbound.go) is the one writer and enqueues never block. The client
// matches responses by id, so completion order is free.

// maxHeavyConcurrent bounds concurrent subprocess-backed RPCs. Generous enough
// that a burst of git/file-exists probes (one per open pane) does not serialize,
// small enough that a flood cannot fork-bomb a loaded host. The bound is taken
// INSIDE the worker goroutine, never in the dispatch loop.
const maxHeavyConcurrent = 8

// serialLane runs submitted jobs one at a time, in submission order, on a
// goroutine that exists only while work is queued. Submit never blocks.
type serialLane struct {
	mu      sync.Mutex
	q       []func()
	running bool
}

func (l *serialLane) submit(job func()) {
	l.mu.Lock()
	l.q = append(l.q, job)
	if l.running {
		l.mu.Unlock()
		return
	}
	l.running = true
	l.mu.Unlock()
	go l.run()
}

func (l *serialLane) run() {
	for {
		l.mu.Lock()
		if len(l.q) == 0 {
			l.running = false
			l.mu.Unlock()
			return
		}
		job := l.q[0]
		l.q[0] = nil
		l.q = l.q[1:]
		l.mu.Unlock()
		job()
	}
}

type dispatcher struct {
	write           func(Response)
	writeLine       func(any)
	writeAttachData func(sid string, b []byte)

	control serialLane
	heavy   chan struct{}
}

func newDispatcher(write func(Response), writeLine func(any), writeAttachData func(sid string, b []byte)) *dispatcher {
	return &dispatcher{
		write:           write,
		writeLine:       writeLine,
		writeAttachData: writeAttachData,
		heavy:           make(chan struct{}, maxHeavyConcurrent),
	}
}

// heavyDo runs fn on its own goroutine under the concurrency bound.
func (d *dispatcher) heavyDo(fn func()) {
	go func() {
		d.heavy <- struct{}{}
		defer func() { <-d.heavy }()
		fn()
	}()
}

// reply writes the RPC-error shape for (err) or the ok shape for result.
func (d *dispatcher) reply(id json.RawMessage, result any, err error) {
	if err != nil {
		d.write(Response{ID: id, OK: false, Error: err.Error()})
		return
	}
	d.write(Response{ID: id, OK: true, Result: result})
}

// handle routes one decoded request. It must return promptly: it is called
// from the stdin read loop, and anything slow here is the bug this file fixes.
func (d *dispatcher) handle(req Request) {
	id := req.ID
	switch req.Method {
	case "ping":
		d.write(Response{ID: id, OK: true, Result: map[string]any{
			"version": version,
			"methods": pingMethods(),
		}})

	// ---- heavy pool: independent subprocess work, concurrent ----
	case "discover":
		d.heavyDo(func() {
			containers, err := discover(req.Params)
			d.reply(id, map[string]any{"containers": containers}, err)
		})
	case "capturePanes":
		d.heavyDo(func() {
			panes, err := capturePanes(req.Params)
			d.reply(id, map[string]any{"panes": panes}, err)
		})
	case "hasSession":
		d.heavyDo(func() {
			result, err := hasSession(req.Params)
			d.reply(id, result, err)
		})
	case "exec":
		// exec is the GENERIC script RPC (WARDEN-1261): the JS side assembled the
		// script; the Go side executes it and returns the raw cmdResult — never
		// an RPC error for a host-side failure. timeoutMs is honored host-side.
		d.heavyDo(func() { d.write(Response{ID: id, OK: true, Result: execScript(req.Params)}) })
	case "writeFile":
		// The byte-carrying RPC (WARDEN-1350); same raw-cmdResult contract.
		d.heavyDo(func() { d.write(Response{ID: id, OK: true, Result: writeFileRPC(req.Params)}) })

	// ---- control lane: tmux-mutating ops, ordered among themselves ----
	case "spawnSession":
		d.control.submit(func() { d.reply(id, map[string]any{}, spawnSession(req.Params)) })
	case "killSession":
		d.control.submit(func() { d.reply(id, map[string]any{}, killSession(req.Params)) })
	case "resize":
		// The interactive-pane control-plane op (WARDEN-409): returns the raw
		// cmdResult, never an RPC error for a host-side command failure.
		d.control.submit(func() { d.write(Response{ID: id, OK: true, Result: resize(req.Params)}) })
	case "send":
		// The user-input WRITE op (WARDEN-888): the WARDEN-254 bracketed-paste
		// sequence in one atomic script. Raw cmdResult, same shape as resize.
		d.control.submit(func() { d.write(Response{ID: id, OK: true, Result: send(req.Params)}) })
	case "sendKeys":
		d.control.submit(func() { d.write(Response{ID: id, OK: true, Result: sendKeys(req.Params)}) })

	// ---- subscriptions: a swap, never a wait (see startSubscription) ----
	case "subscribePanes":
		// WARDEN-413: start (or update) the background watcher over the pane set;
		// the ACK returns immediately and pushes arrive asynchronously. An empty
		// pane list stops the watcher (unsubscribe semantics).
		var p capturePanesParams
		if len(req.Params) > 0 {
			_ = json.Unmarshal(req.Params, &p) // bad params → empty → stop watcher
		}
		startSubscription(p.Panes, d.writeLine)
		d.write(Response{ID: id, OK: true, Result: map[string]any{"subscribed": len(p.Panes)}})
	case "unsubscribePanes":
		stopSubscription()
		d.write(Response{ID: id, OK: true, Result: map[string]any{"unsubscribed": true}})

	// ---- attach family ----
	case "attachStart":
		// WARDEN-1295: allocate a host PTY, ACK {sid} IMMEDIATELY, only THEN
		// start the output pump (no attachData can precede the sid). Spawning the
		// child (a fork, a ConPTY on Windows) is off the loop so opening a pane
		// never delays another pane's keystroke; it is deliberately NOT in the
		// bounded heavy pool — a saturated pool of slow probes must not delay a
		// pane open.
		go func() {
			sid, launch, err := startAttach(req.Params, d.writeLine, d.writeAttachData)
			if err != nil {
				// Platform without a PTY, or a spawn failure: an ordinary
				// {ok:false} so warden maps it to its attach_error path — never a
				// silent raw-SSH fallback.
				d.write(Response{ID: id, OK: false, Error: err.Error()})
				return
			}
			d.write(Response{ID: id, OK: true, Result: map[string]any{"sid": sid}})
			launch()
		}()
	case "attachInput":
		s, data, err := prepareAttachInput(req.Params)
		if err != nil {
			d.write(Response{ID: id, OK: false, Error: err.Error()})
			return
		}
		if s == nil || len(data) == 0 {
			d.write(Response{ID: id, OK: true, Result: map[string]any{}})
			return
		}
		// Per-session ordered lane: a pty.Write that blocks (a child that stopped
		// reading) stalls THIS pane's keystrokes only, never the loop.
		s.inputLane.submit(func() { d.reply(id, map[string]any{}, s.writeInput(data)) })
	case "attachResize":
		d.reply(id, map[string]any{}, attachResize(req.Params))
	case "attachKill":
		// Idempotent (an already-gone sid is a benign ok), mirroring killSession —
		// a detach→attach race must never surface a spurious failure.
		d.reply(id, map[string]any{}, attachKill(req.Params))

	default:
		d.write(Response{ID: id, OK: false, Error: "unknown method: " + req.Method})
	}
}
