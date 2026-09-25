//go:build windows

package main

import "golang.org/x/sys/windows"

// processAlive reports whether pid is still running — the windows twin of the
// unix signal-0 probe in procgroup_unix_test.go. STILL_ACTIVE is the exit code
// GetExitCodeProcess reports for a process that has not exited yet.
func processAlive(pid int) bool {
	h, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(pid))
	if err != nil {
		return false // no handle ⇒ no live process we can see
	}
	defer windows.CloseHandle(h)
	var code uint32
	if err := windows.GetExitCodeProcess(h, &code); err != nil {
		return false
	}
	return code == uint32(windows.STATUS_PENDING) // 259, a.k.a. STILL_ACTIVE
}

// killTestProcess force-kills a test process (best-effort cleanup in failure
// paths only — never part of an assertion's success path).
func killTestProcess(pid int) {
	if h, err := windows.OpenProcess(windows.PROCESS_TERMINATE, false, uint32(pid)); err == nil {
		_ = windows.TerminateProcess(h, 1)
		_ = windows.CloseHandle(h)
	}
}
