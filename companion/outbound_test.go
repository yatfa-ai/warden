package main

import (
	"bufio"
	"bytes"
	"encoding/base64"
	"encoding/json"
	"math/rand"
	"strings"
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

// TestSameSidBulkAheadOfItsEchoStaysOrdered — the cross-class reordering
// defect, pinned: a pane's pre-keystroke output queues bulk, its echo queues
// interactive, and take() drains interactive first — so the echo would be
// WRITTEN BEFORE bytes produced before it (out-of-order PTY bytes, display
// corruption until a redraw). The interactive enqueue must hoist the pane's
// queued bulk ahead of itself, in production order; the echo still overtakes
// every OTHER pane's queued bulk.
func TestSameSidBulkAheadOfItsEchoStaysOrdered(t *testing.T) {
	recent := map[string]bool{"P": false}
	q := newOutboundQueue(func(sid string) bool { return recent[sid] })

	// Pane P streams before any keystroke: bulk. Another pane floods: bulk.
	q.enqueueAttachData("P", []byte("STREAM-A-"))
	q.enqueueAttachData("F", []byte("FLOOD-1-"))
	// The user types into P; its echo arrives while STREAM-A is still queued.
	recent["P"] = true
	q.enqueueAttachData("P", []byte("ECHO-B"))

	var got []string
	for len(q.inter)+len(q.bulk) > 0 {
		it := q.take()
		if it.line != nil {
			got = append(got, string(it.line))
		} else {
			got = append(got, string(it.data))
		}
	}
	stream := strings.Join(got, "")
	pIdx, bIdx := strings.Index(stream, "STREAM-A-"), strings.Index(stream, "ECHO-B")
	fIdx := strings.Index(stream, "FLOOD-1-")
	if pIdx == -1 || bIdx == -1 || fIdx == -1 {
		t.Fatalf("a chunk was lost: %q", stream)
	}
	if pIdx > bIdx {
		t.Fatalf("pane P's own stream arrived out of order (echo before its predecessor) — display corruption: %q", stream)
	}
	if fIdx < bIdx {
		t.Fatalf("the echo must still overtake ANOTHER pane's queued bulk: %q", stream)
	}
}

// TestMigrationSlotsAfterThePanesEarlierEcho — the subtle corner in
// migrateBulkToInteractiveLocked: a pane's EARLIER echo can still be queued
// interactive when a later keystroke triggers migration (its window closed in
// between, so the in-between chunks classified bulk). The hoisted run must
// slot in AFTER that earlier echo — it predates the bulk chunks — not at the
// head of the queue. Per-sid FIFO is the invariant; other panes' interactive
// items may legitimately be overtaken by the run.
func TestMigrationSlotsAfterThePanesEarlierEcho(t *testing.T) {
	recent := map[string]bool{"P": true}
	q := newOutboundQueue(func(sid string) bool { return recent[sid] })

	q.enqueueAttachData("P", []byte("ECHO1-")) // inter: first keystroke's echo
	q.enqueueAttachData("X", []byte("X-"))     // inter: another pane's echo
	recent["P"] = false                        // the window closes; P streams bulk
	q.enqueueAttachData("P", []byte("STREAM-"))
	// A second keystroke on P while everything above is still queued.
	recent["P"] = true
	q.enqueueAttachData("P", []byte("ECHO2"))

	var got string
	for len(q.inter)+len(q.bulk) > 0 {
		it := q.take()
		if it.line != nil {
			got += string(it.line)
		} else {
			got += string(it.data)
		}
	}
	want := "ECHO1-STREAM-ECHO2" + "X-"
	if got != want {
		t.Fatalf("per-sid FIFO broken across a double keystroke:\n got %q\nwant %q", got, want)
	}
}

// TestQueuePerSidFIFOUnderRandomClasses — a seeded soak over the queue's
// class transitions: random chunks for four panes, random keystrokes opening
// and closing echo windows (driving chunks across the bulk/interactive split
// with migrations, merges and cap stalls), then a full drain. The invariant
// the whole two-class design exists to protect: each pane's reassembled byte
// stream equals its production stream, exactly, every time.
func TestQueuePerSidFIFOUnderRandomClasses(t *testing.T) {
	const sids = "ABCD"
	for seed := int64(1); seed <= 25; seed++ {
		rng := rand.New(rand.NewSource(seed))
		recent := map[string]bool{}
		window := map[string]int{} // chunks left in this keystroke's echo window
		q := newOutboundQueue(func(sid string) bool { return recent[sid] })
		var produced [4][]byte
		var got [4][]byte

		record := func(it *outItem) {
			i := int(it.sid[0] - 'A')
			got[i] = append(got[i], it.data...)
		}
		for op := 0; op < 400; op++ {
			switch {
			case rng.Intn(10) == 0: // a keystroke: reopen the echo window
				sid := string(sids[rng.Intn(len(sids))])
				recent[sid] = true
				window[sid] = 1 + rng.Intn(4)
			default:
				i := rng.Intn(len(sids))
				sid := string(sids[i])
				chunk := []byte{byte('a' + i), byte(op%26 + '0')}
				if window[sid] > 0 {
					window[sid]--
					if window[sid] == 0 {
						recent[sid] = false
					}
				}
				produced[i] = append(produced[i], chunk...)
				q.enqueueAttachData(sid, chunk)
				// Interleave takes so the writer drains mid-production —
				// migrations then run against a partially drained queue.
				if rng.Intn(3) == 0 {
					record(q.take())
				}
			}
		}
		// Drain everything and reassemble per pane.
		for {
			q.mu.Lock()
			empty := len(q.inter) == 0 && len(q.bulk) == 0
			q.mu.Unlock()
			if empty {
				break
			}
			record(q.take())
		}
		for i := range produced {
			if !bytes.Equal(got[i], produced[i]) {
				t.Fatalf("seed %d: pane %c's stream corrupted across class transitions (%d bytes out, want %d)",
					seed, rune('A'+i), len(got[i]), len(produced[i]))
			}
			if q.bulkBytes != 0 || q.interNat != 0 {
				t.Fatalf("seed %d: byte accounting leaked: bulk=%d inter=%d", seed, q.bulkBytes, q.interNat)
			}
		}
	}
}

// TestBulkRemainderParksAheadOfItsOwnSuccessors — the writer-side preempt
// primitives: a bulk item the writer holds mid-item can be parked back at the
// head of bulk, another pane's interactive item served, and the remainder
// resumed with its production order (and its pane's later queued bulk behind
// it) intact; byte accounting must return to zero once everything drains.
func TestBulkRemainderParksAheadOfItsOwnSuccessors(t *testing.T) {
	q := newOutboundQueue(func(sid string) bool { return sid == "O" })
	q.enqueueAttachData("P", []byte("AAAA"))
	q.enqueueAttachData("Z", []byte("ZZZZ")) // interleaved: breaks the same-sid tail merge
	q.enqueueAttachData("P", []byte("BBBB"))

	it := q.take() // the writer holds P's first item mid-write
	if string(it.data) != "AAAA" {
		t.Fatalf("expected P's first item, got %q", it.data)
	}
	q.enqueueAttachData("O", []byte("OOOO")) // another pane's echo, mid-item

	// serve's preempt: park the unwritten remainder, take the echo.
	q.requeueBulkHead(it.sid, it.data)
	if got := q.interactiveHeadSid(); got != "O" {
		t.Fatalf("interactive head must be the echo pane, got %q", got)
	}
	if it2 := q.take(); string(it2.data) != "OOOO" {
		t.Fatalf("the echo must be served before the parked remainder, got %q", it2.data)
	}
	if it3 := q.take(); string(it3.data) != "AAAA" {
		t.Fatalf("the parked remainder must resume next, in order, got %q", it3.data)
	}
	if it4 := q.take(); string(it4.data) != "ZZZZ" {
		t.Fatalf("the interleaved pane's bulk must follow, got %q", it4.data)
	}
	if it5 := q.take(); string(it5.data) != "BBBB" {
		t.Fatalf("P's later bulk must stay behind its remainder, got %q", it5.data)
	}
	if q.bulkBytes != 0 || q.interNat != 0 {
		t.Fatalf("byte accounting must return to zero after a full drain: bulk=%d inter=%d", q.bulkBytes, q.interNat)
	}
}

// ------------------- serve-level ordering integration ------------------------

// recordedWriter lets the test pace the writer goroutine one write at a time
// and inspect the WIRE stream it produced. Chunks are recorded in write order;
// the assertions decode attachData events back out of the joined stream and
// check PER-PANE byte order — the property the whole two-class design must
// protect. The gate is BUFFERED: a release is a queued token, never a lost
// one, so the writer cannot strand mid-stream between steps.
type recordedWriter struct {
	mu     sync.Mutex
	chunks [][]byte
	gate   chan struct{}
}

func newRecordedWriter() *recordedWriter {
	return &recordedWriter{gate: make(chan struct{}, 4096)}
}

func (w *recordedWriter) Write(p []byte) (int, error) {
	<-w.gate
	chunk := append([]byte(nil), p...)
	w.mu.Lock()
	w.chunks = append(w.chunks, chunk)
	w.mu.Unlock()
	return len(p), nil
}

func (w *recordedWriter) release() { w.gate <- struct{}{} }

func (w *recordedWriter) chunkCount() int {
	w.mu.Lock()
	defer w.mu.Unlock()
	return len(w.chunks)
}

func (w *recordedWriter) stream() string {
	w.mu.Lock()
	defer w.mu.Unlock()
	buf := make([]byte, 0, 4096)
	for _, c := range w.chunks {
		buf = append(buf, c...)
	}
	return string(buf)
}

// queueEmpty / queueCounts read the queue's internals under its lock — the
// writer goroutine mutates them concurrently, and the race detector (rightly)
// fails an unlocked poll.
func queueEmpty(q *outboundQueue) bool {
	q.mu.Lock()
	defer q.mu.Unlock()
	return len(q.inter) == 0 && len(q.bulk) == 0 && q.bulkBytes == 0
}

func queueCounts(q *outboundQueue) (inter, bulk, bytes int) {
	q.mu.Lock()
	defer q.mu.Unlock()
	return len(q.inter), len(q.bulk), q.bulkBytes
}

// paneEvents decodes the stream's attachData lines into ordered (sid, raw
// bytes) events — what the renderer would reassemble per pane.
func paneEvents(t *testing.T, stream string) []struct {
	sid  string
	data []byte
} {
	t.Helper()
	var events []struct {
		sid  string
		data []byte
	}
	for _, line := range strings.Split(stream, "\n") {
		if !strings.Contains(line, `"attachData"`) {
			continue
		}
		var ev attachDataEvent
		if err := json.Unmarshal([]byte(line), &ev); err != nil {
			t.Fatalf("writer emitted a non-attachData attachData line: %v", err)
		}
		raw, err := base64.StdEncoding.DecodeString(ev.Data)
		if err != nil {
			t.Fatalf("attachData payload is not valid base64: %v", err)
		}
		events = append(events, struct {
			sid  string
			data []byte
		}{ev.Sid, raw})
	}
	return events
}

// runGatedServe steps the writer through `n` writes of one bulk item, calls
// step mid-item (between recorded writes), then releases everything and waits
// for the queue to drain. Completion is detected with a SENTINEL line, not a
// queue-empty poll: with the queue empty, a line enqueued now is written AFTER
// every prior write by the single writer goroutine, so its appearance in the
// stream proves every prior write (every byte of every prior item) has fully
// landed — a queue-empty poll can pass while the last write is still in
// flight, truncating the stream the assertions read.
func runGatedServe(t *testing.T, q *outboundQueue, w *recordedWriter, n int, step func()) {
	t.Helper()
	go q.serve(bufio.NewWriterSize(w, 1<<20), nil)
	for i := 0; i < n; i++ {
		w.release()
		// Wait until write i is recorded before scheduling the next.
		deadline := time.Now().Add(5 * time.Second)
		for w.chunkCount() < i+1 {
			if time.Now().After(deadline) {
				t.Fatalf("writer stalled: only %d/%d writes recorded", w.chunkCount(), i+1)
			}
			time.Sleep(time.Millisecond)
		}
	}
	if step != nil {
		step()
	}
	for i := 0; i < 4096; i++ { // release the rest of the stream
		select {
		case w.gate <- struct{}{}:
		default:
			i = 4096
		}
	}
	deadline := time.Now().Add(10 * time.Second)
	for !queueEmpty(q) && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if inter, bulk, bytes := queueCounts(q); inter+bulk > 0 || bytes > 0 {
		t.Fatalf("queue never drained: inter=%d bulk=%d bulkBytes=%d", inter, bulk, bytes)
	}
	q.enqueueLine(struct {
		Marker string `json:"marker"`
	}{"drain-done"})
	for time.Now().Before(deadline) {
		if strings.Contains(w.stream(), `"marker":"drain-done"`) {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("writer never reached the drain sentinel")
}

// TestServeEchoOvertakesAnotherPanesMidItemBacklog — blocking finding 2,
// writer-side: an echo arriving while a merged bulk item is MID-ITEM must not
// wait out the item's whole remainder. serve() parks the unwritten remainder
// at the head of bulk and serves the echo between slices; the pane's own
// stream (its part before the echo, remainder after) stays byte-exact.
func TestServeEchoOvertakesAnotherPanesMidItemBacklog(t *testing.T) {
	q := newOutboundQueue(func(sid string) bool { return sid == "echo" })
	w := newRecordedWriter()

	// One merged 60KB bulk item: two 30KB chunks under the 64KB merge cap.
	chunk := bytes.Repeat([]byte("A"), 30<<10)
	bulkRaw := append(append([]byte(nil), chunk...), chunk...)
	q.enqueueAttachData("pane-a", chunk)
	q.enqueueAttachData("pane-a", chunk)

	// Step the writer into the item (two 24KB-raw slices recorded), then let
	// the echo arrive before the remainder is written.
	runGatedServe(t, q, w, 2, func() {
		q.enqueueAttachData("echo", []byte("ECHO-MARK"))
	})

	events := paneEvents(t, w.stream())
	var paneA []byte
	echoSeenBeforeTail := false
	for i, ev := range events {
		if ev.sid == "echo" {
			// The echo must appear before pane-a's LAST event (its parked
			// remainder, resumed after the echo).
			echoSeenBeforeTail = i < len(events)-1
		} else {
			paneA = append(paneA, ev.data...)
		}
	}
	if !bytes.Equal(paneA, bulkRaw) {
		t.Fatalf("pane-a's stream was corrupted across the preemption (%d bytes, want %d)", len(paneA), len(bulkRaw))
	}
	if !echoSeenBeforeTail {
		t.Fatalf("the echo did not overtake the mid-item bulk remainder; events=%d", len(events))
	}
}

// TestServeDoesNotPreemptForSameSidEcho — the ordering guard on the preempt:
// while pane-a's own bulk item is mid-item, pane-a's echo must NOT leapfrog
// the unwritten remainder (the remainder precedes it in production order).
// Migration hoists the pane's queued NEXT item ahead of the echo; serve
// finishes the in-flight one first. Per-pane reassembly must be exact.
func TestServeDoesNotPreemptForSameSidEcho(t *testing.T) {
	q := newOutboundQueue(func(sid string) bool { return sid == "pane-a" })
	w := newRecordedWriter()

	chunk := bytes.Repeat([]byte("A"), 30<<10)
	q.enqueueAttachData("pane-a", chunk)
	q.enqueueAttachData("pane-a", chunk)                             // merged with the first (60KB ≤ 64KB cap)
	q.enqueueAttachData("pane-a", bytes.Repeat([]byte("B"), 30<<10)) // next bulk item

	runGatedServe(t, q, w, 2, func() {
		// The user types into pane-a while its first item is mid-item: its
		// echo classifies interactive and must NOT preempt the remainder.
		q.enqueueAttachData("pane-a", []byte("ECHO-MARK"))
	})

	events := paneEvents(t, w.stream())
	var paneA []byte
	echoIdx := -1
	for i, ev := range events {
		if ev.sid == "pane-a" {
			paneA = append(paneA, ev.data...)
		} else if echoIdx == -1 {
			echoIdx = i
		}
	}
	want := append(append([]byte(nil), chunk...), chunk...)
	want = append(want, bytes.Repeat([]byte("B"), 30<<10)...)
	want = append(want, []byte("ECHO-MARK")...)
	if !bytes.Equal(paneA, want) {
		t.Fatalf("pane-a's stream was reordered across its own echo (%d bytes, want %d)", len(paneA), len(want))
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
// double it back toward the cap — but ONLY when nothing is queued (see the
// hasDemand note on observe). This is the mechanism that keeps sshd's TCP send
// buffer (the kernel backlog the echo had to drain through) at RTT scale
// instead of megabytes.
func TestPacerCongestionResponse(t *testing.T) {
	p := newPacer()
	start := p.rate
	// A 32KB write at the initial 8MB/s rate should drain in 4ms; blocking
	// 200ms is 196ms of excess — congestion.
	p.observe(200*time.Millisecond, 32<<10, false)
	if p.rate >= start {
		t.Fatalf("an excess-blocked write must halve the rate: %v -> %v", start, p.rate)
	}
	floor := p.rate
	p.observe(200*time.Millisecond, 32<<10, false)
	if p.rate != minPaceRate && p.rate >= floor {
		t.Fatalf("repeated congestion must keep descending to the floor (or sit at it), got %v", p.rate)
	}
	// Sustained on-expectation writes recover, no faster than doubling per
	// window — but ONLY while the queue is EMPTY. At the floor, 32KB takes
	// ~0.5s — on expectation.
	deadline := time.Now().Add(4 * time.Second)
	for p.rate < maxPaceRate && time.Now().Before(deadline) {
		time.Sleep(paceRecover + 10*time.Millisecond)
		p.observe(time.Duration((float64(32<<10)/p.rate)*float64(time.Second)), 32<<10, false)
	}
	if p.rate != maxPaceRate {
		t.Fatalf("sustained fast writes with no demand must recover to the cap, got %v", p.rate)
	}
}

// TestPacerDoesNotRecoverWhileDemandIsQueued — the second rework's correction,
// pinned: doubling on "fast" writes walked the rate to 8× the drain and kept
// the kernel pipe+socket reservoir pinned full, so every echo entered behind
// ~128KB of flood (measured 1.7-3s blocked unit writes at a 64KB/s drain).
// With demand queued, on-expectation writes must NOT raise the rate.
func TestPacerDoesNotRecoverWhileDemandIsQueued(t *testing.T) {
	p := newPacer()
	// Descend to the floor first (one excess-blocked write per halving).
	for i := 0; i < 10 && p.rate > minPaceRate; i++ {
		p.observe(2*time.Second, 32<<10, true)
	}
	if p.rate != minPaceRate {
		t.Fatalf("repeated congestion under demand must reach the floor, got %v", p.rate)
	}
	// Sustained on-expectation writes WHILE demand is queued: the rate must
	// stay at the floor.
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		time.Sleep(paceRecover + 10*time.Millisecond)
		p.observe(time.Duration((float64(32<<10)/p.rate)*float64(time.Second)), 32<<10, true)
	}
	if p.rate != minPaceRate {
		t.Fatalf("the rate must not recover while demand is queued: %v", p.rate)
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
	p.observe(32*time.Millisecond, 32<<10, false) // expected at 8MB/s is 4ms; 32ms is within expected+paceExcess
	if p.rate != start {
		t.Fatalf("a write explained by its own drain must not halve the rate: %v -> %v", start, p.rate)
	}
}

// TestPacerSmallWritesRideTheBurst — echoes and responses (tiny) must never
// wait long on the bucket: pacing bounds the BACKLOG, it must not tax the echo.
func TestPacerSmallWritesRideTheBurst(t *testing.T) {
	p := newPacer()
	p.mu.Lock()
	p.tokens = 0 // bucket empty on purpose
	p.mu.Unlock()
	start := time.Now()
	m := p.acquireUpTo(64)
	if m != 64 {
		t.Fatalf("a tiny write must be paid in full, got %d bytes", m)
	}
	if time.Since(start) > 50*time.Millisecond {
		t.Fatalf("a tiny write waited on an empty bucket (%v) — pacing would tax the echo", time.Since(start))
	}
}

// TestPacerOverlapsTokenWaitWithDrain — the second build's regression, pinned:
// on an empty bucket at the 64KB/s floor rate, acquireUpTo must pay a FLOOR
// installment quickly instead of sleeping a full slice's worth (~500ms) before
// any byte moves. The full-slice wait serialized the token sleep with the pipe
// drain and ran the slow-link scenario at 2× the unpaced code's latency; the
// installment form lets the next tokens accrue during the current write.
func TestPacerOverlapsTokenWaitWithDrain(t *testing.T) {
	p := newPacer()
	p.mu.Lock()
	p.rate = minPaceRate // 64KB/s: a full 32KB slice's worth of tokens ≈ 500ms away
	p.tokens = 0
	p.mu.Unlock()
	start := time.Now()
	m := p.acquireUpTo(32 << 10)
	elapsed := time.Since(start)
	if m < paceMinChunk || m > 32<<10 {
		t.Fatalf("installment out of range [paceMinChunk, 32KB]: %d bytes", m)
	}
	if elapsed > 150*time.Millisecond {
		t.Fatalf("acquireUpTo blocked %v before the first installment — the token wait serializes with the drain again (pre-fix shape: ~500ms)", elapsed)
	}
}

// TestPacerPaysFullSliceWhenTokensArePlentiful — on a fast link the installment
// form must be indistinguishable from the old full-slice acquire: the bucket
// refills while the previous slice drains, so a 32KB write is paid whole.
func TestPacerPaysFullSliceWhenTokensArePlentiful(t *testing.T) {
	p := newPacer()
	if m := p.acquireUpTo(32 << 10); m != 32<<10 {
		t.Fatalf("a fresh bucket must pay a full slice, got %d bytes", m)
	}
}
