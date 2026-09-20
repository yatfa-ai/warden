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
// THE SHAPE OF THE FIX, in six moves:
//
//  1. A dedicated WRITER goroutine owns stdout. Producers enqueue and return;
//     none of them — the dispatch loop above all — ever blocks on output I/O.
//     Keystrokes are read and written to their PTYs within microseconds
//     regardless of how backed up the link is.
//
//  2. TWO CLASSES, ORDER-SAFE. `interactive` (RPC responses, pane deltas,
//     attach exits, and attachData for a pane with a recent keystroke — the
//     echo itself) always dequeues ahead of `bulk` (everything else), so the
//     echo overtakes the flood inside OUR queue. Per-chunk classification
//     would otherwise reorder a single pane's own stream (its pre-keystroke
//     output queued bulk, its echo queued interactive, take() writing the
//     echo first — out-of-order PTY bytes, display corruption), so an
//     interactive enqueue first HOISTS that pane's queued bulk ahead of
//     itself, in production order (migrateBulkToInteractiveLocked): its own
//     stream stays ordered; other panes' flood stays behind it.
//
//  3. BOUNDED bulk with same-sid merging. A flooding pane's queued chunks
//     merge (byte-exact concatenation) and the queue caps out, blocking the
//     PUMP goroutines — backpressure lands on tmux's own pane buffer, where it
//     belongs, instead of growing our memory or the link's queue. The bulk cap
//     bounds the backlog the echo can find itself behind.
//
//  4. AIMD PACING on stdout writes (token bucket, 8MB/s cap, 32KB burst;
//     halve on excess-block, double after sustained on-expectation writes).
//     sshd refills its TCP send buffer as fast as we feed it, so an unpaced
//     daemon manufactures a multi-megabyte kernel backlog the echo must drain
//     through — the multi-second tail. Pacing to ~the link rate keeps that
//     backlog at RTT-scale. Real agent output (< 1MB/s in bursts) never
//     engages it: the bucket's burst absorbs every tmux redraw whole.
//
//  5. PRIORITY BETWEEN WRITE UNITS, WAITS OVERLAPPED (the second build's two
//     residuals, both measured on the reviewer's A/B harness). Draining a
//     whole queued item before re-checking the queue let an echo arriving
//     mid-item wait out a full merged item (~64KB wire) — and even
//     slice-granular re-checks left the echo waiting inside one 24KB-raw
//     slice's token installments and pipe drain (1-1.5s per slice at the
//     64KB/s floor). serve() now re-checks BEFORE EACH 3KB-raw write unit and
//     parks a bulk item's unwritten remainder at the head of bulk (order
//     preserved) whenever a DIFFERENT pane's interactive item waits, so the
//     echo's writer-side wait is one unit. And pacing pays in token-sized
//     installments (acquireUpTo) instead of sleeping a full slice before
//     writing it: the token wait overlaps the pipe drain, so throughput
//     converges to the link rate instead of half of it — the first build ran
//     the 64KB/s scenario at 2× the unpaced code's latency, a regression this
//     removes.
//
//  6. THE AIMD RECOVERY GATE. The first build doubled the rate after
//     sustained "fast" writes — but a fast write means THE PIPE HAD ROOM,
//     not that the link is faster; doubling on it walked the rate to 8× the
//     drain and kept the kernel pipe+socket reservoir pinned full, so every
//     echo entered behind ~128KB of flood (measured 1.7-3s blocked unit
//     writes at a 64KB/s drain). Under queued demand the loop now only
//     ratchets down toward the observed drain — the reservoir drains ahead of
//     the echo instead of refilling, at unchanged throughput (anything ≥ the
//     drain is full throughput) — and recovers to the cap only when the
//     queue is empty.

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
	// overhead while queued; with serve() preempting BETWEEN WRITE UNITS, a
	// queued echo's worst wait behind one bulk item is one unit regardless of
	// the merge cap, so this cap is now a memory/framing bound (one item =
	// one allocation) rather than a latency bound — but it still sizes the
	// run migration hoists, keeping it O(small). 64KB is ~4 full-screen
	// redraws — well past anything one coalescing window needs.
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
	paceMinChunk = 4 << 10                // smallest installment acquireUpTo will wait for: the unit the token WAIT overlaps the previous installment's DRAIN with (see acquireUpTo)
	paceExcess   = 50 * time.Millisecond  // a write blocked THIS much beyond its own expected drain ⇒ congested
	paceTolerate = 10 * time.Millisecond  // a write within expected+this of its drain is fast
	paceRecover  = 300 * time.Millisecond // sustained fast writes ⇒ double back
)

// ------------------------------- pacer --------------------------------------

// pacer is a token-bucket rate limiter with AIMD adaptation driven by observed
// write latency. All fields are guarded by mu; acquire/observe take it.
type pacer struct {
	mu        sync.Mutex
	rate      float64 // bytes/sec
	burst     float64 // bucket size
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

// acquireUpTo pays for as much of n as the bucket allows — UP TO n, never
// necessarily all of it — blocking only until it can pay a floor installment
// (paceMinChunk, or n itself when n is smaller). It returns the payable byte
// count m ≤ n.
//
// WHY NOT BLOCK FOR THE WHOLE n (the first fixed build's acquire): a full-slice
// acquire SERIALIZES the token wait with the pipe drain — sleep n/rate, then
// block on a write that itself takes n/link ≈ n/rate, so every slice costs ~2×
// link time. Measured: at a 64KB/s drain the paced daemon ran the flood
// scenario at half the THROUGHPUT of the unpaced code it replaced (2.2–2.9s vs
// 1.1–1.5s per keystroke) — the pacer became the tail. Serving in
// token-sized installments instead lets the next installment's tokens accrue
// DURING the current installment's write/drain: in steady state the bucket
// refills while the pipe drains, the waits overlap, and throughput converges
// to min(rate, link) instead of half of it. The installments grow back toward
// full slices on their own — whenever tokens are plentiful acquireUpTo pays
// the whole n, so a fast link sees one 32KB slice per write exactly as before.
func (p *pacer) acquireUpTo(n int) int {
	if n > paceBurst {
		// A single write larger than the bucket pays in slices; treat it as
		// burst-size so one huge line cannot stall the writer behind a full
		// bucket for (n-burst)/rate in one sleep loop.
		n = paceBurst
	}
	floor := paceMinChunk
	if n < floor {
		floor = n
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	for {
		now := time.Now()
		p.tokens = math.Min(p.burst, p.tokens+now.Sub(p.last).Seconds()*p.rate)
		p.last = now
		if p.tokens >= float64(n) {
			p.tokens -= float64(n)
			return n
		}
		if p.tokens >= float64(floor) {
			// Pay a partial installment: the remainder's tokens accrue while
			// THIS installment drains (see the note above).
			m := int(p.tokens)
			p.tokens -= float64(m)
			return m
		}
		// Wait for the FLOOR, not for n — that is the whole point.
		need := time.Duration(((float64(floor) - p.tokens) / p.rate) * float64(time.Second))
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
// hostage to the floor rather than to the flood.
//
// hasDemand gates the RECOVERY half, and it is the second rework's correction:
// the first build doubled after sustained "fast" writes — but a fast write
// means THE PIPE HAD ROOM, not that the link is faster than the rate. Doubling
// on it walked the rate to 8× the drain, kept the 64KB pipe + socket buffer
// reservoir pinned FULL at all times, and every echo entered behind ~128KB of
// flood (the measured 1.7-3s blocked unit writes at a 64KB/s drain, and the
// dominant congested-scenario residual vs the pre-fix daemon). With demand
// queued the loop now only ratchets DOWN toward ~the drain: the reservoir
// drains ahead of the echo instead of refilling, and throughput is unchanged
// (anything ≥ the drain is full throughput). Recovery to the cap happens only
// when the queue is EMPTY — no demand, no latency to protect — so idle bursts
// still ride the bucket at full speed.
func (p *pacer) observe(writeDt time.Duration, n int, hasDemand bool) {
	expected := time.Duration((float64(n) / p.rate) * float64(time.Second))
	p.mu.Lock()
	defer p.mu.Unlock()
	if writeDt > expected+paceExcess {
		p.rate = math.Max(minPaceRate, p.rate/2)
		p.fastSince = time.Now()
		return
	}
	if !hasDemand && writeDt <= expected+paceTolerate && time.Since(p.fastSince) >= paceRecover {
		p.rate = math.Min(maxPaceRate, p.rate*2)
		p.fastSince = time.Now()
	}
}

// ------------------------------- items --------------------------------------

// outItem is one unit bound for stdout: either a pre-encoded JSON line
// (responses, paneDelta, attachExit, …) or a RAW attachData payload (base64'd
// at write time, mergeable with its siblings). inter is the item's CLASS AT
// ENQUEUE TIME (interactive = the echo/response class): the writer consults it
// to decide whether an in-flight item may be preempted mid-unit — only a
// bulk-origin item may (a bulk remainder parks at the head of bulk, its
// production order; an interactive remainder would have to park in front of
// same-sid interactive successors it must precede, which the bulk park breaks).
// A bulk item MIGRATED into the interactive queue keeps inter=false — its
// remainder still parks correctly (see migrateBulkToInteractiveLocked).
type outItem struct {
	line  []byte // pre-encoded line INCLUDING the trailing newline; nil for attachData
	sid   string // attachData only
	data  []byte // attachData only: RAW pty bytes
	inter bool   // classified interactive at enqueue (responses, deltas, echoes)
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
//
// The LINE side of this queue is deliberately UNCAPPED: its producers are the
// serial dispatch loop (responses) and the pane-delta watcher, whose rates are
// bounded by warden's own request cadence — a handful of small lines. Only the
// attachData payload (raw pane bytes, the flood) is capped, on both queues.
// Do not "fix" this into a blocking cap: blocking the dispatch loop on output
// is exactly the bug this file exists to keep dead.
func (q *outboundQueue) enqueueLine(v any) {
	line := encodeItem(v)
	if line == nil {
		return
	}
	q.mu.Lock()
	q.inter = append(q.inter, &outItem{line: line, inter: true})
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
	if interactive {
		// An echo whose pane's EARLIER output still sits queued as bulk must
		// not leapfrog it: take() writes interactive ahead of bulk, so the
		// pane's PTY byte stream would arrive out of order — display
		// corruption until a redraw. Hoist this pane's queued bulk to the
		// front of the interactive queue, in production order, BEFORE the
		// echo enqueues: its own stream stays ordered, and the echo still
		// overtakes every OTHER pane's queued bulk (the actual goal).
		q.migrateBulkToInteractiveLocked(sid)
	}
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
	// maxMergeBytes, past which a new item starts (a memory/framing bound,
	// see the knob note). The tail check is
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
	*queue = append(*queue, &outItem{sid: sid, data: append([]byte(nil), data...), inter: interactive})
	q.bumpBytesLocked(interactive, len(data))
	q.empty.Signal()
}

// migrateBulkToInteractiveLocked moves every queued bulk item of sid into the
// interactive queue, preserving their order, and re-points the byte accounting
// (the item changed queues, so it now counts against the interactive cap — a
// producer cannot launder bulk backlog past interCapBytes by typing). Called
// under q.mu whenever a sid's chunk classifies interactive while its earlier
// output may still sit in bulk; it is what makes the per-chunk class split
// order-SAFE (see enqueueAttachData). Also covers an in-flight item the writer
// preempted mid-slice: a parked remainder is an ordinary bulk item
// (requeueBulkHead), so a later echo of the same pane hoists it back into the
// interactive queue ahead of itself.
//
// The run is inserted AFTER the sid's LAST item already in the interactive
// queue (the head when there is none) — not blindly at the head: an earlier
// echo of the same pane can still be queued interactive (a keystroke whose
// window closed before the bulk chunks were produced), and that echo PREDATES
// the bulk items. Per-sid FIFO is positional: same-sid interactive items sit
// in production order, the hoisted run slots in directly after the newest of
// them, and the echo that triggered the migration is enqueued after the run.
func (q *outboundQueue) migrateBulkToInteractiveLocked(sid string) {
	if len(q.bulk) == 0 {
		return
	}
	migrated := make([]*outItem, 0, len(q.bulk))
	kept := q.bulk[:0]
	for _, it := range q.bulk {
		if it.sid == sid {
			migrated = append(migrated, it)
			q.bulkBytes -= len(it.data)
		} else {
			kept = append(kept, it)
		}
	}
	if len(migrated) == 0 {
		return
	}
	q.bulk = kept
	for _, it := range migrated {
		q.interNat += len(it.data)
	}
	at := 0 // after the sid's last interactive item; the head when none
	for i, it := range q.inter {
		if it.sid == sid {
			at = i + 1
		}
	}
	if at == 0 {
		q.inter = append(migrated, q.inter...)
		return
	}
	rest := append([]*outItem(nil), q.inter[at:]...)
	q.inter = append(append(q.inter[:at:at], migrated...), rest...)
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

// preemptBulkForEcho decides — ATOMICALLY, under ONE hold of q.mu — whether
// the writer's in-flight bulk remainder may park at the head of bulk so a
// queued interactive item can be served first, and parks it in that same hold
// when it may. The atomicity is the fix: the decision READS q.inter and the
// park WRITES the bulk head, and an echo enqueued between those two steps
// lands in the one blind spot migration cannot cover —
// migrateBulkToInteractiveLocked hoists only QUEUED bulk, and the remainder
// is still in the writer's hand — so the echo would enqueue behind nothing,
// take() would serve it ahead of its own predecessor bytes, and the pane's
// stream would corrupt (per-sid reordering, the exact invariant the two-class
// design exists to protect). The old shape held that window open between two
// lock acquisitions (interactiveHeadSid, then requeueBulkHead); q.mu guards
// both q.inter and the bulk head, so one hold closes it.
//
// The refusal rule is pane-WIDE, not a head check. The remainder precedes
// EVERY item of its pane that is queued interactive — its echo, and any bulk
// chunk an earlier echo's migration hoisted in ahead of that echo — wherever
// those items sit in the queue. A head-only check is order-blind to them: with
// another pane's echo at the head and this pane's echo behind it (the pane has
// no queued bulk to hoist — its output is all in flight), the head says
// "preempt" while parking would put the remainder BELOW its own echo, and
// take() serves the interactive queue first. So: refuse while ANY same-sid
// item sits in q.inter, whatever its class flag and position; preempt only
// when the pane has nothing queued interactive AND another pane's
// ATTACHDATA item actually heads the queue. A LINE at the head (sid "" —
// responses, paneDelta, sentinel) does not preempt, exactly as the old
// head-sid read treated it: lines are not preemption triggers, and the
// writer finishing its remainder in place keeps their dispatch order anyway.
// Refusing leaves the queue byte-identical — the writer simply keeps the
// remainder, whose units each re-decide.
func (q *outboundQueue) preemptBulkForEcho(sid string, data []byte) bool {
	q.mu.Lock()
	defer q.mu.Unlock()
	if len(q.inter) == 0 || q.inter[0].sid == "" {
		return false
	}
	for _, it := range q.inter {
		if it.sid == sid {
			return false // the pane's own item is queued interactive: the remainder precedes it
		}
	}
	q.requeueBulkHeadLocked(sid, data)
	return true
}

// requeueBulkHeadLocked parks an in-flight bulk attachData item's unwritten
// RAW remainder at the HEAD of the bulk queue. The head, because every item
// behind it was produced after it — its production order within bulk is
// exactly preserved, and any same-sid bulk item still queued behind it stays
// behind it. Byte accounting mirrors take()'s bulk branch (which subtracted
// len(data) when the item left the queue). Callers must hold q.mu; the writer
// reaches this only through preemptBulkForEcho, which owns the decision — a
// producer that woke on take()'s space broadcast re-checks the caps in its own
// loop and re-parks if the re-added bytes closed the gap again, so no
// condition broadcast is needed here.
func (q *outboundQueue) requeueBulkHeadLocked(sid string, data []byte) {
	q.bulk = append([]*outItem{{sid: sid, data: data}}, q.bulk...)
	q.bulkBytes += len(data)
}

// hasDemand reports whether ANY work is queued — the pacer's recovery gate:
// the rate may climb back toward the cap only when nothing is waiting, since
// queued demand is exactly the traffic a too-high rate buries under a full
// kernel reservoir (see observe).
func (q *outboundQueue) hasDemand() bool {
	q.mu.Lock()
	defer q.mu.Unlock()
	return len(q.inter) > 0 || len(q.bulk) > 0
}

// serve is the writer goroutine: pop (interactive first), pace to the wire
// byte cost, write, feed the latency back into the AIMD loop. Four properties
// carry the fix:
//
//   - Large items are written in SMALL UNITS, each paced through acquireUpTo —
//     a merged multi-hundred-KB bulk item must never bypass the limiter in one
//     blocking syscall, or a queued echo would wait behind one multi-second
//     write (the very tail this removes).
//
//   - BEFORE EACH UNIT of a bulk item the writer re-checks the queue (the
//     first fixed build drained a whole item — up to 64KB of wire — before
//     looking, and the rework build checked only between 24KB-raw slices, but
//     the writer spends its time INSIDE unit writes, each blocked on a full
//     pipe for the drain of its own bytes, so at the 64KB/s floor a slice
//     cost 1-1.5s of drain and an echo arriving mid-slice waited it all out —
//     both measured in the rework A/B). If a DIFFERENT pane's interactive
//     item is waiting, the unwritten RAW remainder parks at the head of bulk
//     (its production order — see preemptBulkForEcho) and the echo is served
//     now; the echo's worst writer-side wait is one 3KB-raw unit. A same-sid
//     interactive item ANYWHERE in the interactive queue — not merely at its
//     head — refuses the preempt: the remainder precedes it in production
//     order (the pane's echo follows its own stream — that ordering is
//     migrateBulkToInteractiveLocked's whole job), and parking below any
//     queued same-sid item would let take() serve that item first, corrupting
//     the pane's stream. The check and the park are ONE lock hold
//     (preemptBulkForEcho): an echo enqueued between a read of the queue and
//     the park would land in the blind spot migration cannot hoist (the
//     remainder is not yet queued). Interactive items are never preempted at
//     all: their remainders cannot park without reordering same-sid
//     successors, and nothing outranks them anyway.
//
//   - attachData is ENCODED PER UNIT (raw data sliced, each unit's attachData
//     line rendered fresh) so the preemptable remainder is RAW bytes — a
//     wire-bytes remainder cannot be parked (a base64 suffix is not the
//     base64 of a byte suffix). Extra event boundaries, ~60 bytes of envelope
//     per 4KB: the JS side reassembles event-split payloads by design
//     (stateful UTF-8 decode across attachData events), and the pre-fix
//     daemon emitted one event per ~35-byte pty line anyway. The byte STREAM
//     is identical; only event boundaries move.
//
//   - The AIMD recovery gate (observe's hasDemand): the first build doubled
//     on "fast" writes — an instant write means the PIPE had room, not that
//     the link is faster — and that walked the rate to 8× the drain, keeping
//     the kernel pipe+socket reservoir actively pinned full; every echo then
//     entered behind the whole reservoir (measured 1.3-2.7s blocked unit
//     writes at a 64KB/s drain — the reservoir's own drain time). Under
//     queued demand the rate now only ratchets down toward the drain, so the
//     reservoir stops being over-filled above the link rate; recovering to
//     the cap is deferred until the queue is EMPTY (no demand, no latency to
//     protect).
//
// Write errors are ignored — the prior behavior (`_ = enc.Encode(v)`);
// channel death is detected on the stdin side and tears the process down.
func (q *outboundQueue) serve(w *bufio.Writer, clock func() time.Time) {
	if clock == nil {
		clock = time.Now
	}
	p := newPacer()
	for {
		it := q.take()
		if it.line != nil {
			// A pre-encoded line (response, paneDelta, attachExit): written
			// whole in burst-size installments, never preempted — nothing
			// outranks the interactive class, and its remainder cannot park.
			for len(it.line) > 0 {
				n := len(it.line)
				if n > paceBurst {
					n = paceBurst
				}
				m := p.acquireUpTo(n)
				t0 := clock()
				_, _ = w.Write(it.line[:m])
				_ = w.Flush()
				p.observe(clock().Sub(t0), m, it.inter || q.hasDemand()) // a line in flight IS demand
				it.line = it.line[m:]
			}
			continue
		}
		// attachData: the RAW remainder is written in SMALL units, and the
		// preempt check runs before EACH unit (see the block comment above).
		for len(it.data) > 0 {
			if !it.inter {
				// ONE atomic decision+park (see preemptBulkForEcho): a split
				// check-then-park let a same-sid echo enqueue in the gap and
				// jump the parked remainder.
				if q.preemptBulkForEcho(it.sid, it.data) {
					it.data = nil
					break
				}
			}
			rawCap := paceMinChunk * 3 / 4 // 3KB raw → ~4.1KB wire + envelope
			if rawCap > len(it.data) {
				rawCap = len(it.data)
			}
			// The unit line is written in token-sized installments:
			// acquireUpTo may pay less than the whole payload (that is the
			// point), and every unpaid byte must be written by a later
			// installment — a dropped tail here would truncate a JSON line
			// mid-payload (caught by the ordering tests: the framing newline
			// lives at the END of the payload, so a one-shot partial write
			// silently concatenates two attachData events).
			payload := attachDataLine(it.sid, it.data[:rawCap])
			for len(payload) > 0 {
				m := p.acquireUpTo(len(payload))
				t0 := clock()
				_, _ = w.Write(payload[:m])
				_ = w.Flush()
				dt := clock().Sub(t0)
				p.observe(dt, m, it.inter || q.hasDemand())
				payload = payload[m:]
			}
			it.data = it.data[rawCap:]
		}
	}
}
