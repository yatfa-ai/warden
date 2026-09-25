package main

import (
	"strings"
	"testing"
	"unicode/utf16"
)

// decodeUTF16EnvBlock reverses buildUnicodeEnvBlock's encoding so tests can
// assert on entries rather than raw UTF-16. Entries are NUL-separated and the
// block ends in TWO NULs — the first terminates the last entry, the second is
// the block terminator (an empty final element).
func decodeUTF16EnvBlock(block []uint16) []string {
	var out []string
	start := 0
	for i, u := range block {
		if u == 0 {
			if i == start {
				break // the block's own terminator — two NULs in a row
			}
			out = append(out, string(utf16.Decode(block[start:i])))
			start = i + 1
		}
	}
	return out
}

// TestBuildUnicodeEnvBlockForwardsTERM pins the basic contract: the given
// TERM lands in the block exactly once, as the LAST entry.
func TestBuildUnicodeEnvBlockForwardsTERM(t *testing.T) {
	t.Setenv("TERM", "stale-value-that-must-be-dropped")
	block := buildUnicodeEnvBlock("xterm")
	entries := decodeUTF16EnvBlock(block)
	if len(entries) == 0 {
		t.Fatal("env block decoded to zero entries")
	}
	var terms []string
	for _, kv := range entries {
		if name, _, _ := strings.Cut(kv, "="); strings.EqualFold(name, "TERM") {
			terms = append(terms, kv)
		}
	}
	if len(terms) != 1 || terms[0] != "TERM=xterm" {
		t.Fatalf("TERM entries = %v, want exactly [TERM=xterm]", terms)
	}
	if last := entries[len(entries)-1]; last != "TERM=xterm" {
		t.Fatalf("last entry = %q, want TERM=xterm (the forwarded value must be appended last)", last)
	}
}

// TestBuildUnicodeEnvBlockDropsInheritedTERMCaseInsensitively pins the
// first-match hazard the case-insensitive drop exists for: CreateProcess
// resolves duplicate keys by FIRST match, so an inherited "Term" (the casing
// MSYS/sshd can set) would beat the forwarded TERM if only the exact spelling
// were dropped.
func TestBuildUnicodeEnvBlockDropsInheritedTERMCaseInsensitively(t *testing.T) {
	t.Setenv("TERM", "dumb")
	t.Setenv("Term", "cygwin")
	t.Setenv("term", "msys")
	entries := decodeUTF16EnvBlock(buildUnicodeEnvBlock("xterm-256color"))
	for _, kv := range entries {
		if name, _, _ := strings.Cut(kv, "="); strings.EqualFold(name, "TERM") && kv != "TERM=xterm-256color" {
			t.Fatalf("inherited TERM variant survived the drop: %q", kv)
		}
	}
	found := false
	for _, kv := range entries {
		if kv == "TERM=xterm-256color" {
			found = true
		}
	}
	if !found {
		t.Fatalf("forwarded TERM=xterm-256color missing from block: %v", entries)
	}
}

// TestBuildUnicodeEnvBlockKeepsNonTERMTermNames guards against an over-broad
// drop: entries whose name merely contains or extends TERM are NOT TERM.
func TestBuildUnicodeEnvBlockKeepsNonTERMTermNames(t *testing.T) {
	t.Setenv("TERMCAP", "keep-me")
	t.Setenv("XTERM_VERSION", "keep-me-too")
	entries := decodeUTF16EnvBlock(buildUnicodeEnvBlock("xterm"))
	var kept []string
	for _, kv := range entries {
		if strings.HasPrefix(kv, "TERMCAP=") || strings.HasPrefix(kv, "XTERM_VERSION=") {
			kept = append(kept, kv)
		}
	}
	if len(kept) != 2 {
		t.Fatalf("non-TERM entries dropped: kept %v, want TERMCAP= and XTERM_VERSION= intact", kept)
	}
}

// TestBuildUnicodeEnvBlockDoubleNULTerminator pins the block terminator: the
// encoding MUST end in two NULs — the first ends the final entry, the second
// ends the block — or CreateProcess reads past the slice into adjacent heap
// memory. The decoder treats the second NUL as an empty final element, which
// is exactly the malformed shape this test forbids.
func TestBuildUnicodeEnvBlockDoubleNULTerminator(t *testing.T) {
	t.Setenv("TERM", "dumb")
	block := buildUnicodeEnvBlock("xterm")
	if len(block) < 2 {
		t.Fatalf("block too short: %d units", len(block))
	}
	if block[len(block)-1] != 0 || block[len(block)-2] != 0 {
		t.Fatalf("block does not end in two NULs: tail = %v", block[len(block)-4:])
	}
	if block[len(block)-3] == 0 {
		t.Fatalf("block ends in three NULs — the last real entry was clobbered: tail = %v", block[len(block)-4:])
	}
}

// TestBuildUnicodeEnvBlockPreservesOtherVars pins that the block carries the
// rest of the environment through untouched.
func TestBuildUnicodeEnvBlockPreservesOtherVars(t *testing.T) {
	t.Setenv("TERM", "dumb")
	t.Setenv("WARDEN_TEST_MARKER", "present")
	entries := decodeUTF16EnvBlock(buildUnicodeEnvBlock("xterm"))
	found := false
	for _, kv := range entries {
		if kv == "WARDEN_TEST_MARKER=present" {
			found = true
		}
	}
	if !found {
		t.Fatalf("WARDEN_TEST_MARKER=present missing from block: %v", entries)
	}
}
