//go:build !windows

package main

// conPTYGateForTest is the non-windows twin of the helper in
// conpty_gate_windows_test.go: unix builds always allocate a PTY (the const in
// pty_unix.go), so the expected gate value is simply true. Only consulted under
// GOOS=windows by TestHostPTYSupportedMatchesPlatform; defined here so the
// shared test file compiles on every platform.
func conPTYGateForTest() bool { return true }
