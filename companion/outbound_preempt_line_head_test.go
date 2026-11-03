package main

import (
	"encoding/json"
	"testing"
)

// preemptBulkForEcho's second refusal arm (companion/outbound.go, the
// `q.inter[0].sid == ""` clause) — a LINE (a response, a paneDelta, the
// sentinel: any item with sid "") at the head of the interactive queue is not
// a preemption trigger. The writer keeps its in-hand bulk remainder and
// finishes it in place; the line is then the very next take(). No other test
// holds a bulk remainder while a line heads the interactive queue (the two
// direct preempt tests head with another pane's attachData echo), so this
// clause is pinned here (WARDEN-2108).
func TestPreemptRefusesWhenALineHeadsTheInteractiveQueue(t *testing.T) {
	q := newOutboundQueue(func(string) bool { return false }) // everything bulk
	q.enqueueAttachData("P", []byte("AAAA"))
	it := q.take() // the writer holds P's item mid-write (bulkBytes back to 0)
	q.enqueueLine(Response{ID: json.RawMessage(`1`), OK: true})

	if q.preemptBulkForEcho(it.sid, it.data) {
		t.Fatal("a line at the interactive head must not preempt the in-hand bulk remainder")
	}
	if inter, bulk, nbytes := queueCounts(q); inter != 1 || bulk != 0 || nbytes != 0 {
		t.Fatalf("a refused preempt must leave the queue byte-identical: inter=%d bulk=%d bulkBytes=%d", inter, bulk, nbytes)
	}
	if got := q.take(); got.line == nil {
		t.Fatalf("the queued line must still be the next item, got attachData %q", got.data)
	}
}

// The line arm looks at the HEAD only, and a line ahead of another pane's
// echo still refuses — the echo waits for the line to be written, then is
// served by the writer's next unit check. The control: the same two items in
// the other order DO preempt, so the test is not vacuous — it is the head
// item's class (line vs attachData echo), not the queue's contents, that
// decides.
func TestPreemptLineHeadClauseIsHeadOnlyControl(t *testing.T) {
	echoFirst := func() *outboundQueue {
		q := newOutboundQueue(func(sid string) bool { return sid == "O" })
		q.enqueueAttachData("O", []byte("OOOO"))
		q.enqueueLine(Response{ID: json.RawMessage(`1`), OK: true})
		return q
	}
	lineFirst := func() *outboundQueue {
		q := newOutboundQueue(func(sid string) bool { return sid == "O" })
		q.enqueueLine(Response{ID: json.RawMessage(`1`), OK: true})
		q.enqueueAttachData("O", []byte("OOOO"))
		return q
	}
	if !echoFirst().preemptBulkForEcho("P", []byte("REST")) {
		t.Fatal("control: another pane's echo at the head must preempt")
	}
	if lineFirst().preemptBulkForEcho("P", []byte("REST")) {
		t.Fatal("a line at the head must refuse even with another pane's echo queued behind it")
	}
}
