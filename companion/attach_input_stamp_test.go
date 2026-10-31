package main

import (
	"encoding/base64"
	"encoding/json"
	"testing"
)

// These tests pin the wiring between prepareAttachInput and the WARDEN-1402
// echo-priority clock (noteAttachInput / recentInput). TestRecentInputClassification
// exercises noteAttachInput directly and the attachInput tests assert only PTY
// bytes / error strings, so deleting the stamp from prepareAttachInput (or the
// empty-payload early return) would otherwise leave the suite green.

// prepInput base64-encodes raw into attachInputParams and runs prepareAttachInput.
func prepInput(t *testing.T, sid string, raw []byte) (*attachSession, []byte, error) {
	t.Helper()
	params, err := json.Marshal(attachInputParams{Sid: sid, Data: base64.StdEncoding.EncodeToString(raw)})
	if err != nil {
		t.Fatalf("marshal params: %v", err)
	}
	return prepareAttachInput(params)
}

// registerFakeSession registers a PTY-less attach session under sid so the
// tests run on every platform, and removes it on cleanup.
func registerFakeSession(t *testing.T, sid string) *attachSession {
	t.Helper()
	s := &attachSession{sid: sid}
	attachMu.Lock()
	attachSessions[sid] = s
	attachMu.Unlock()
	t.Cleanup(func() { dropAttachSession(sid) }) // also clears the echo stamp
	return s
}

func TestPrepareAttachInputOpensTheEchoWindowAtReceipt(t *testing.T) {
	const sid = "stamp-open"
	want := registerFakeSession(t, sid)
	if recentInput(sid, inputEchoWindow) {
		t.Fatal("a fresh session must not be echo-classified before any input")
	}
	s, data, err := prepInput(t, sid, []byte("x"))
	if err != nil {
		t.Fatalf("prepareAttachInput: %v", err)
	}
	if s != want || string(data) != "x" {
		t.Fatalf("got (%v, %q), want (session, \"x\")", s, data)
	}
	if !recentInput(sid, inputEchoWindow) {
		t.Fatal("receiving a non-empty payload must open the echo window")
	}
}

func TestPrepareAttachInputEmptyPayloadIsANoOpThatDoesNotStamp(t *testing.T) {
	const sid = "stamp-empty"
	registerFakeSession(t, sid)
	s, data, err := prepInput(t, sid, nil)
	if s != nil || data != nil || err != nil {
		t.Fatalf("empty payload = (%v, %v, %v), want (nil, nil, nil)", s, data, err)
	}
	if recentInput(sid, inputEchoWindow) {
		t.Fatal("an empty payload must not open the echo window")
	}
}

func TestPrepareAttachInputRefusalsDoNotStamp(t *testing.T) {
	const sid = "stamp-refuse"
	registerFakeSession(t, sid)

	if _, _, err := prepInput(t, "stamp-unknown", []byte("x")); err == nil {
		t.Fatal("unknown sid must return an error")
	}
	if recentInput("stamp-unknown", inputEchoWindow) {
		t.Fatal("an unknown sid must not be stamped")
	}

	params, err := json.Marshal(attachInputParams{Sid: sid, Data: "!!!not-base64!!!"})
	if err != nil {
		t.Fatalf("marshal params: %v", err)
	}
	if _, _, err := prepareAttachInput(params); err == nil {
		t.Fatal("bad base64 must return an error")
	}
	if recentInput(sid, inputEchoWindow) {
		t.Fatal("a refused (bad base64) payload must not open the echo window")
	}
}
