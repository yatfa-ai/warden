package main

import (
	"bufio"
	"bytes"
	"encoding/base64"
	"encoding/json"
	"sync"
	"testing"
	"time"
)

// --------------------------- WARDEN-1402 outbound ----------------------------
//
// The queue + writer replace the mutex-guarded encoder whose blocking write
// froze the serial dispatch loop behind a saturated channel (the pane-echo
// tail). These tests drive the REAL pieces — the queue, the writer goroutine,
// the pacer — with fake sinks, because the properties under test (input is
// never hostage to output; the echo overtakes bulk; bulk is bounded; the pacer
// adapts) are concurrency properties, not JSON properties.

// blockedWriter is an io.Writer whose Write blocks until released, recording
// how many writes landed. It stands in for a stdout pipe whose reader (sshd's
// TCP drain, in production) has stopped draining.
type blockedWriter struct {
	mu      sync.Mutex
	buf     bytes.Buffer
	release chan struct{}
	writes  int
}

func newBlockedWriter() *blockedWriter {
	return &blockedWriter{release: make(chan struct{})}
}

func (w *blockedWriter) Write(p []byte) (int, error) {
	<-w.release
	w.mu.Lock()
	defer w.mu.Unlock()
	w.buf.Write(p)
	w.writes++
	return len(p), nil
}

func (w *blockedWriter) unblock() { close(w.release) }

func (w *blockedWriter) String() string {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.buf.String()
}

// TestDispatchLoopIsNeverHostageToOutput — THE fix's core regression. With the
// writer's stdout blocked (a saturated channel), enqueueLine — the dispatch
// loop's response path — must return immediately, repeatedly, with the queue
// accepting everything: the loop must keep reading stdin (keystrokes!) while
// output waits. The pre-fix daemon blocked inside write() here: this test
// hangs against it.
func TestDispatchLoopIsNeverHostageToOutput(t *testing.T) {
	w := newBlockedWriter()
	q := newOutboundQueue(func(string) bool { return false })
	go q.serve(bufio.NewWriter(w), nil)

	done := make(chan struct{})
	go func() {
		defer close(done)
		for i := 0; i < 1000; i++ {
			q.enqueueLine(Response{ID: json.RawMessage(`1`), OK: true})
		}
	}()
	select {
	case <-done:
		// 1000 responses enqueued while the channel is fully blocked — the
		// dispatch loop stays live.
	case <-time.After(5 * time.Second):
		t.Fatal("enqueueLine blocked while stdout was blocked — the dispatch loop would stall on output again")
	}
	w.unblock()
}

// TestEchoOvertakesFloodInOurQueue — a pane with a recent keystroke has its
// next output chunk classified interactive, and interactive items dequeue
// ahead of previously-queued bulk, so the echo does not wait FIFO behind
// another pane's flood within OUR queue.
func TestEchoOvertakesFloodInOurQueue(t *testing.T) {
	q := newOutboundQueue(func(sid string) bool { return sid == "echo-pane" })

	// Bulk floods first: three chunks of another pane.
	q.enqueueAttachData("flood-pane", []byte("BULK1-"))
	q.enqueueAttachData("flood-pane", []byte("BULK2-"))
	// Then a keystroke lands on echo-pane and its echo arrives.
	q.enqueueLine(Response{ID: json.RawMessage(`"resp"`), OK: true})
	q.enqueueAttachData("echo-pane", []byte("ECHO"))

	var got []string
	for i := 0; i < 3; i++ {
		it := q.take()
		if it.line != nil {
			got = append(got, string(it.line))
		} else {
			got = append(got, string(it.data))
		}
	}
	// The contract: interactive items (the response and the echo) dequeue
	// ahead of the previously-queued bulk flood, in enqueue order among
	// themselves; bulk order is preserved behind them.
	if got[0] == "BULK1-BULK2-" || got[1] == "BULK1-BULK2-" {
		t.Fatalf("both interactive items must dequeue before queued bulk; order: %q", got)
	}
	if got[2] != "BULK1-BULK2-" {
		t.Fatalf("bulk order after the interactives must be preserved and merged: %q", got)
	}
	if len(got) != 3 || got[0] != "{\"id\":\"resp\",\"ok\":true}\n" || got[1] != "ECHO" {
		t.Fatalf("unexpected dequeue order: %q", got)
	}
}

// TestBulkCapBlocksProducer — a bulk producer parks (instead of growing memory
// or the link queue without bound) until the writer drains; backpressure lands
// on the PTY producer. The parked producer must WAKE and complete when bytes
// drain.
func TestBulkCapBlocksProducer(t *testing.T) {
	q := newOutboundQueue(func(string) bool { return false })
	// Fill bulk with one big chunk (cap is 512KB; 400KB twice exceeds it).
	big := make([]byte, 400<<10)
	q.enqueueAttachData("s", big)

	blocked := make(chan struct{})
	go func() {
		q.enqueueAttachData("s", big) // must block on the cap
		close(blocked)
	}()
	select {
	case <-blocked:
		t.Fatal("a producer exceeded the bulk cap without blocking — the backlog is unbounded again")
	case <-time.After(200 * time.Millisecond):
		// parked on the cap, as designed
	}
	// Drain everything; the parked producer must complete. (Two items exist:
	// the oversized first chunk, then the producer's chunk once the cap
	// releases it.)
	for i := 0; i < 2; i++ {
		q.take()
	}
	select {
	case <-blocked:
	case <-time.After(5 * time.Second):
		t.Fatal("the blocked producer was never released after drain")
	}
}

// TestSameSidChunksMergeInOrder — consecutive same-sid chunks become ONE item
// with concatenated bytes (terminal streams are order-sensitive,
// boundary-agnostic), so a backed-up queue merges instead of accumulating
// framing overhead.
func TestSameSidChunksMergeInOrder(t *testing.T) {
	q := newOutboundQueue(func(string) bool { return false })
	q.enqueueAttachData("s", []byte("abc"))
	q.enqueueAttachData("s", []byte("def"))
	q.enqueueAttachData("other", []byte("X")) // interleaved: no merge across panes

	it := q.take()
	if string(it.data) != "abcdef" {
		t.Fatalf("same-sid chunks must merge in order, got %q", it.data)
	}
	it = q.take()
	if string(it.data) != "X" {
		t.Fatalf("a different pane's chunk must not merge, got %q", it.data)
	}
}

// TestAttachDataWireFormatUnchanged — the writer's attachData line must be
// byte-identical to the old pump's json.Marshal(attachDataEvent) line: the
// JS side's base64 + JSON framing contract is load-bearing.
func TestAttachDataWireFormatUnchanged(t *testing.T) {
	want, _ := json.Marshal(attachDataEvent{Event: "attachData", Sid: "a1", Data: base64.StdEncoding.EncodeToString([]byte("hi"))})
	got := attachDataLine("a1", []byte("hi"))
	if string(got) != string(want)+"\n" {
		t.Fatalf("attachData wire format drifted:\n got %q\nwant %q", got, string(want)+"\n")
	}
}

// TestRecentInputClassification — a keystroke stamps the pane's echo window;
// an unknown or dead sid is never classified interactive; dropAttachSession
// clears the stamp.
func TestRecentInputClassification(t *testing.T) {
	if recentInput("ghost", inputEchoWindow) {
		t.Fatal("an unknown sid must never be echo-classified")
	}
	attachMu.Lock()
	attachSessions["a-test"] = &attachSession{sid: "a-test"}
	attachMu.Unlock()
	t.Cleanup(func() { dropAttachSession("a-test") })

	noteAttachInput("a-test")
	if !recentInput("a-test", inputEchoWindow) {
		t.Fatal("a just-typed pane must be echo-classified")
	}
	dropAttachSession("a-test")
	if recentInput("a-test", inputEchoWindow) {
		t.Fatal("a dropped session must not stay echo-classified")
	}
}

// TestPacerCongestionResponse — a write blocked far beyond its own expected
// drain halves the rate toward the floor; sustained on-expectation writes
// double it back toward the cap. This is the mechanism that keeps sshd's TCP
// send buffer (the kernel backlog the echo had to drain through) at RTT scale
// instead of megabytes.
func TestPacerCongestionResponse(t *testing.T) {
	p := newPacer()
	start := p.rate
	// A 32KB write at the initial 8MB/s rate should drain in 4ms; blocking
	// 200ms is 196ms of excess — congestion.
	p.observe(200*time.Millisecond, 32<<10)
	if p.rate >= start {
		t.Fatalf("an excess-blocked write must halve the rate: %v -> %v", start, p.rate)
	}
	floor := p.rate
	p.observe(200*time.Millisecond, 32<<10)
	if p.rate != minPaceRate && p.rate >= floor {
		t.Fatalf("repeated congestion must keep descending to the floor (or sit at it), got %v", p.rate)
	}
	// Sustained on-expectation writes recover, no faster than doubling per
	// window. (At the floor, 32KB takes ~0.5s — on expectation.)
	deadline := time.Now().Add(4 * time.Second)
	for p.rate < maxPaceRate && time.Now().Before(deadline) {
		time.Sleep(paceRecover + 10*time.Millisecond)
		p.observe(time.Duration((float64(32<<10)/p.rate)*float64(time.Second)), 32<<10)
	}
	if p.rate != maxPaceRate {
		t.Fatalf("sustained fast writes must recover to the cap, got %v", p.rate)
	}
}

// TestPacerDoesNotMisreadOwnDrainAsCongestion — a write whose duration is
// explained by the drain of its own bytes at the current rate (a 32KB slice
// takes 32ms through a 1MB/s link at ANY pacing) must NOT halve the rate.
// Keying the decrease on raw duration instead sent the rate to the floor on
// every healthy link under ~1.6MB/s and held each slice ~0.5s.
func TestPacerDoesNotMisreadOwnDrainAsCongestion(t *testing.T) {
	p := newPacer()
	start := p.rate
	p.observe(32*time.Millisecond, 32<<10) // expected at 8MB/s is 4ms; 32ms is within expected+paceExcess
	if p.rate != start {
		t.Fatalf("a write explained by its own drain must not halve the rate: %v -> %v", start, p.rate)
	}
}

// TestPacerSmallWritesRideTheBurst — echoes and responses (tiny) must never
// wait on the bucket: pacing bounds the BACKLOG, it must not tax the echo.
func TestPacerSmallWritesRideTheBurst(t *testing.T) {
	p := newPacer()
	p.mu.Lock()
	p.tokens = 0 // bucket empty on purpose
	p.mu.Unlock()
	start := time.Now()
	p.acquire(64)
	if time.Since(start) > 50*time.Millisecond {
		t.Fatalf("a tiny write waited on an empty bucket (%v) — pacing would tax the echo", time.Since(start))
	}
}
