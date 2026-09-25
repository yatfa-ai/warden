//go:build windows

package main

import "golang.org/x/sys/windows"

// conPTYGateForTest is an INDEPENDENT evaluation of the same predicate
// hostPTYSupported is initialized from (pty_windows.go), so
// TestHostPTYSupportedMatchesPlatform compares two evaluations of the lookup
// rather than restating a constant. On a Windows 10 1809+ host this is true;
// on anything older, false.
func conPTYGateForTest() bool {
	return windows.NewLazySystemDLL("kernel32.dll").NewProc("CreatePseudoConsole").Find() == nil
}
