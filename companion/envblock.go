package main

import (
	"os"
	"strings"
	"unicode/utf16"
)

// buildUnicodeEnvBlock builds the environment block CreateProcess consumes
// (paired with CREATE_UNICODE_ENVIRONMENT, pty_windows.go): os.Environ() with
// every inherited TERM entry dropped and TERM=<term> appended last.
//
// The inherited drop is CASE-INSENSITIVE and must happen BEFORE the append:
// CreateProcess resolves duplicate keys by first match on Windows (os/exec
// dedups last-wins on unix), so an entry sshd/MSYS set — in any casing —
// would beat warden's forwarded value. Entries that merely CONTAIN "TERM"
// (XTERM_PATH, TERMCAP, `=C:`-style oddities) are not TERM and are kept.
//
// The block is NUL-separated UTF-16 that MUST end in two NULs: the loop
// terminates each entry, and the final append terminates the whole block.
// Without it, CreateProcess reads past the slice into adjacent heap memory
// until it happens to find a zero (Go's own syscall.createEnvBlock appends
// the same final 0).
//
// This lives outside pty_windows.go — the only Windows-coupled part of the
// env path is its CONSUMER, CreateProcess — so the encoding rules above (the
// case-insensitive drop and the double-NUL terminator, both audit findings)
// stay unit-testable on every platform, CI's ubuntu runner included
// (envblock_test.go).
func buildUnicodeEnvBlock(term string) []uint16 {
	var envv []string
	for _, kv := range os.Environ() {
		if name, _, _ := strings.Cut(kv, "="); strings.EqualFold(name, "TERM") {
			continue
		}
		envv = append(envv, kv)
	}
	envv = append(envv, "TERM="+term)
	var block []uint16
	for _, kv := range envv {
		block = append(block, utf16.Encode([]rune(kv))...)
		block = append(block, 0)
	}
	block = append(block, 0) // the block's own terminator — two NULs total at the end
	return block
}
