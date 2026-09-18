package main

// The outbound half of the stdio channel (WARDEN-1402 — the pane-echo tail).
//
// THE MECHANISM THIS REPLACES. Every write to stdout used to funnel through one
// mutex-guarded json.Encoder (writeLine in main.go), and the RPC dispatch loop
// was SERIAL: read request → run handler → write(response) → read next. When a
// streaming pane's output saturated the channel — the pipe fills, sshd's TCP
// send buffer fills, enc.Encode blocks inside the mutex — the dispatch loop
// blocked INSIDE write, and every later request (first among them attachInput:
// the user's keystrokes) sat unread in stdin until the logjam drained. Measured
// against the real binary with a throttled reader
// (scripts/companion-congestion-probe.mjs): idle echo p50 0.5ms; under flood
// with a 64KB/s drain, 100% of keystrokes never echoed at all — they were never
// read. The owner's shipped histograms show the same episode shape live:
// file-exists-remote (a tiny exec RPC) and pane-input-roundtrip degrade
// TOGETHER, in bursts, to 2-10s — every channel passenger hostage to one
// blocked write.
//
// THE SHAPE OF THE FIX, in four moves:
//
//  1. A dedicated WRITER goroutine owns stdout. Producers enqueue and return;
//     none of them — the dispatch loop above all — ever blocks on output I/O.
//     Keystrokes are read and written to their PTYs within microseconds
//     regardless of how backed up the link is.
//
//  2. TWO CLASSES. `interactive` (RPC responses, pane deltas, attach exits,
//     and attachData for a pane with a recent keystroke — the echo itself)
//     always dequeues ahead of `bulk` (everything else). The echo overtakes the
//     flood inside OUR queue instead of waiting FIFO behind it.
//
//  3. BOUNDED bulk with same-sid merging. A flooding pane's queued chunks
//     merge (byte-exact concatenation) and the queue caps out, blocking the
//     PUMP goroutines — backpressure lands on tmux's own pane buffer, where it
//     belongs, instead of growing our memory or the link's queue. The bulk cap
//     bounds the backlog the echo can find itself behind.
//
//  4. AIMD PACING on stdout writes (token bucket, 8MB/s cap, 128KB burst;
//     halve on a blocked write, double after sustained fast writes). sshd
//     refills its TCP send buffer as fast as we feed it, so an unpaced daemon
//     manufactures a multi-megabyte kernel backlog the echo must drain through
//     — the multi-second tail. Pacing to ~the link rate keeps that backlog at
//     RTT-scale. Real agent output (< 1MB/s in bursts) never engages it: the
//     bucket's burst absorbs every tmux redraw whole.

import (
	"bufio"
	"encoding/base64"
	"encoding/json"
	"math"
	"sync"
	"time"
)

// ------------------------------- knobs --------------------------------------

const (
	// bulkCapBytes bounds the bulk queue. A pump that would exceed it blocks
	// until the writer drains — backpressure on the PTY producer, never on
	// input processing. 512KB is ~10 full-screen tmux redraws: a streaming
	// agent absorbs this transparently; a flooded link drains it in a few
	// hundred ms instead of the megabytes the unpaced kernel queue used to
	// hold.
	bulkCapBytes = 512 << 10

	// maxMergeBytes caps one merged attachData item. Merging shrinks framing
	// overhead while queued, but it also sizes the unit the writer commits to:
	// an interactive item (an echo) can only be taken BETWEEN items, so the
	// merge cap is the echo's worst wait behind one bulk item. 64KB is ~4
	// full-screen redraws — well past anything one coalescing window needs —
	// and ≈64ms of hold at a 1MB/s link (the measured wait behind an uncapped
	// merge was ~500ms, the dominant residual of the first fixed build).
	maxMergeBytes = 64 << 10

	// interCapBytes bounds the interactive queue's attachData payload
	// (responses are exempt: they are tiny and their producers — the serial
	// dispatch loop — must never block). Past the cap an echo-candidate chunk
	// blocks its pump exactly like bulk; 256KB of echo-ahead-of-you is far
	// outside the felt bar already, and the cap exists only against
	// pathological producers.
	interCapBytes = 256 << 10

	// inputEchoWindow decides "echo candidate": attachData for a pane whose
	// last attachInput is younger than this rides the interactive queue. 1s is
	// an order of magnitude above the felt bar (300ms) and far below the
	// multi-second tails being removed, so a slow echo keeps its priority
	// while routine output of a recently-typed pane cannot monopolize it.
	inputEchoWindow = time.Second
)

// pacing knobs — see the header note, move 4.
const (
	maxPaceRate  = 8 << 20                // sustained cap: bytes/sec
	minPaceRate  = 64 << 10               // congestion floor
	paceBurst    = 32 << 10               // bucket + max slice: real redraw bursts ride free, and a queued echo never waits behind more than one slice of bulk
	paceExcess   = 50 * time.Millisecond  // a write blocked THIS much beyond its own expected drain ⇒ congested
	paceTolerate = 10 * time.Millisecond  // a write within expected+this of its drain is fast
	paceRecover  = 300 * time.Millisecond // sustained fast writes ⇒ double back
)

// ------------------------------- pacer --------------------------------------

// pacer is a token-bucket rate limiter with AIMD adaptation driven by observed
// write latency. All fields are guarded by mu; acquire/observe take it.
type pacer struct {
	mu        sync.Mutex
	rate      float64     // bytes/sec
	burst     float64     // bucket size
	tokens    float64
	last      time.Time
	fastSince time.Time
}

func newPacer() *pacer {
	return &pacer{
		rate:      maxPaceRate,
		burst:     paceBurst,
		tokens:    paceBurst,
		last:      time.Now(),
		fastSince: time.Now(),
	}
}

// acquire blocks until the bucket can pay for n bytes. Small writes (echoes,
// responses) ride the burst reserve and return immediately.
func (p *pacer) acquire(n int) {
	if n > paceBurst {
		// A single item larger than the bucket pays for itself in slices;
		// treat it as burst-size so one huge chunk cannot stall the writer
		// behind a full bucket for (n-burst)/rate in one sleep loop.
		n = paceBurst
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	for {
		now := time.Now()
		p.tokens = math.Min(p.burst, p.tokens+now.Sub(p.last).Seconds()*p.rate)
		p.last = now
		if p.tokens >= float64(n) {
			p.tokens -= float64(n)
			return
		}
		need := time.Duration(((float64(n) - p.tokens) / p.rate) * float64(time.Second))
		p.mu.Unlock()
		if need > 10*time.Millisecond {
			need = 10 * time.Millisecond // short sleeps: rate changes apply promptly
		}
		time.Sleep(need)
		p.mu.Lock()
	}
}

// observe feeds one write's latency back into the AIMD loop. The congestion
// signal is EXCESS block — a write that took far longer than the drain time of
// its own bytes at the current rate (dt > n/rate + paceExcess) means the pipe
// backed up behind it (sshd's TCP send buffer full, in production) and the
// rate must halve. A write whose time is explained by its own drain (a 32KB
// slice takes 32ms through a 1MB/s link at ANY pacing) is NOT congestion:
// keying the decrease on raw duration instead sent the rate to the floor on
// every healthy link below 1.6MB/s and held each slice ~0.5s — the echo
// hostage to the floor rather than to the flood. Sustained on-expectation
// writes double the rate back toward the cap.
func (p *pacer) observe(writeDt time.Duration, n int) {
	expected := time.Duration((float64(n) / p.rate) * float64(time.Second))
	p.mu.Lock()
	defer p.mu.Unlock()
	if writeDt > expected+paceExcess {
		p.rate = math.Max(minPaceRate, p.rate/2)
		p.fastSince = time.Now()
		return
	}
	if writeDt <= expected+paceTolerate && time.Since(p.fastSince) >= paceRecover {
		p.rate = math.Min(maxPaceRate, p.rate*2)
		p.fastSince = time.Now()
	}
}

// ------------------------------- items --------------------------------------

// outItem is one unit bound for stdout: either a pre-encoded JSON line
// (responses, paneDelta, attachExit, …) or a RAW attachData payload (base64'd
// at write time, mergeable with its siblings).
type outItem struct {
	line []byte // pre-encoded line INCLUDING the trailing newline; nil for attachData
	sid  string // attachData only
	data []byte // attachData only: RAW pty bytes
}

// wireBytes is what this item will put on the wire (the pacer pays in wire
// bytes — base64 inflates by 4/3, the JSON envelope adds ~60).
func (it *outItem) wireBytes() int {
	if it.line != nil {
		return len(it.line)
	}
	return base64.StdEncoding.EncodedLen(len(it.data)) + 64
}

// merge concatenates another same-sid attachData payload into it (byte-exact:
// terminal streams are order-sensitive but boundary-agnostic).
func (it *outItem) merge(data []byte) {
	it.data = append(it.data, data...)
}

// encodeItem renders a pre-encoded JSON line + newline. Marshal errors (the
// old code silently dropped them via `_ = enc.Encode(v)`) are dropped the same
// way, so behavior is unchanged for the types already flowing.
func encodeItem(v any) []byte {
	b, err := json.Marshal(v)
	if err != nil {
		return nil
	}
	return append(b, '\n')
}

// attachDataLine renders one attachData event line from raw pty bytes.
func attachDataLine(sid string, data []byte) []byte {
	return encodeItem(attachDataEvent{Event: "attachData", Sid: sid, Data: base64.StdEncoding.EncodeToString(data)})
}

// ------------------------------- queue --------------------------------------

// outboundQueue is the bounded, two-class, mergeable queue between the
// producers (dispatch loop, attach pumps, pane-delta watcher) and the single
// stdout writer goroutine.
type outboundQueue struct {
	mu        sync.Mutex
	empty     *sync.Cond // broadcast when ANY item becomes available
	space     *sync.Cond // broadcast when bytes are drained (blocked producers re-check)
	inter     []*outItem
	bulk      []*outItem
	interNat  int // interactive attachData payload bytes (responses are exempt from the cap)
	bulkBytes int

	// isInteractive reports whether sid has a recent keystroke — the echo
	// classifier. Wired in main.go; tests inject fakes.
	isInteractive func(sid string) bool
}

func newOutboundQueue(isInteractive func(sid string) bool) *outboundQueue {
	q := &outboundQueue{isInteractive: isInteractive}
	q.empty = sync.NewCond(&q.mu)
	q.space = sync.NewCond(&q.mu)
	return q
}

// enqueueLine queues a pre-encodable value on the interactive class. NEVER
// blocks: this is the dispatch loop's response path, and blocking here is
// precisely the mechanism under repair. Marshal errors drop silently — the
// prior `_ = enc.Encode(v)` behavior, unchanged.
func (q *outboundQueue) enqueueLine(v any) {
	line := encodeItem(v)
	if line == nil {
		return
	}
	q.mu.Lock()
	q.inter = append(q.inter, &outItem{line: line})
	q.empty.Signal()
	q.mu.Unlock()
}

// enqueueAttachData queues one chunk of pane output. Its class is decided by
// the echo classifier: a pane with a recent keystroke rides interactive so the
// echo overtakes the flood; everything else rides bulk. Either way the chunk
// MERGES into a same-sid tail already queued (the common case: one pump
// producing consecutive chunks), and the byte CAP is checked BEFORE the merge
// — merging adds bytes, so a full queue blocks its producer through the merge
// path too (a cap bypassed by merges would be no cap at all). The producer
// that blocks is always a pump goroutine; backpressure lands on the PTY
// producer (tmux buffers its own pane output), never on input processing.
func (q *outboundQueue) enqueueAttachData(sid string, data []byte) {
	interactive := q.isInteractive != nil && q.isInteractive(sid)
	wire := base64.StdEncoding.EncodedLen(len(data)) + 64
	q.mu.Lock()
	defer q.mu.Unlock()
	queue := &q.bulk
	if interactive {
		queue = &q.inter
	}
	for {
		atCap := q.bulkBytes+wire > bulkCapBytes
		if interactive {
			atCap = q.interNat+wire > interCapBytes
		}
		// An oversized chunk into an EMPTY queue must always enqueue: a cap
		// smaller than one chunk is a deadlock (the producer waits for a
		// drain only the writer can perform, and the writer waits for an
		// item), not a bound.
		if !atCap || len(*queue) == 0 {
			break
		}
		q.space.Wait() // the writer's take() broadcasts on every drain
	}
	// Merge into the same-class, same-sid tail when possible — up to
	// maxMergeBytes, past which a new item starts (the merge cap is the echo's
	// worst wait behind one bulk item, see the knob note). The tail check is
	// O(1) and covers the dominant shape (one pump, consecutive chunks);
	// interleaved panes simply do not merge, and the caps above still bound
	// them.
	if len(*queue) > 0 {
		tail := (*queue)[len(*queue)-1]
		if tail.line == nil && tail.sid == sid && len(tail.data)+len(data) <= maxMergeBytes {
			tail.merge(data)
			q.bumpBytesLocked(interactive, len(data))
			return
		}
	}
	*queue = append(*queue, &outItem{sid: sid, data: append([]byte(nil), data...)})
	q.bumpBytesLocked(interactive, len(data))
	q.empty.Signal()
}

func (q *outboundQueue) bumpBytesLocked(interactive bool, n int) {
	if interactive {
		q.interNat += n
	} else {
		q.bulkBytes += n
	}
}

// take blocks until at least one item is queued, then removes the
// highest-priority one: interactive ahead of bulk, always.
func (q *outboundQueue) take() *outItem {
	q.mu.Lock()
	defer q.mu.Unlock()
	for len(q.inter) == 0 && len(q.bulk) == 0 {
		q.empty.Wait()
	}
	var it *outItem
	if len(q.inter) > 0 {
		it = q.inter[0]
		q.inter[0] = nil
		q.inter = q.inter[1:]
		if it.line == nil {
			q.interNat -= len(it.data)
		}
	} else {
		it = q.bulk[0]
		q.bulk[0] = nil
		q.bulk = q.bulk[1:]
		q.bulkBytes -= len(it.data)
	}
	q.space.Broadcast()
	return it
}

// serve is the writer goroutine: pop (interactive first), pace to the wire
// byte cost, write, feed the latency back into the AIMD loop. Large items are
// written in burst-size SLICES, each paced — a merged multi-hundred-KB bulk
// item must never bypass the limiter in one blocking syscall, or a queued echo
// would wait behind one multi-second write (the very tail this removes). Write
// errors are ignored — the prior behavior (`_ = enc.Encode(v)`); channel death
// is detected on the stdin side and tears the process down.
func (q *outboundQueue) serve(w *bufio.Writer, clock func() time.Time) {
	if clock == nil {
		clock = time.Now
	}
	p := newPacer()
	for {
		it := q.take()
		payload := it.line
		if payload == nil {
			payload = attachDataLine(it.sid, it.data)
		}
		for len(payload) > 0 {
			slice := payload
			if len(slice) > paceBurst {
				slice = slice[:paceBurst]
			}
			p.acquire(len(slice))
			t0 := clock()
			_, _ = w.Write(slice)
			_ = w.Flush()
			p.observe(clock().Sub(t0), len(slice))
			payload = payload[len(slice):]
		}
	}
}
