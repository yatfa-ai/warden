//go:build !windows

package main

import (
	"bytes"
	"fmt"
	"os"
	"syscall"
)

// processAlive reports whether pid is still RUNNING — the orphan check
// TestExecProcessGroupKill performs after a group kill. Unix twin of the
// windows helper in procgroup_windows_test.go; split per-platform so the whole
// test suite COMPILES under `GOOS=windows go vet ./...` (WARDEN-1437 AC #2)
// without dragging syscall.Kill — a Unix facility — into the windows build.
//
// kill(pid, 0) answers ESRCH only once the process is REAPED, not once it is
// dead: a SIGKILLed process whose parent died first sits as a ZOMBIE until
// init reaps it, still answering the signal-0 probe, while holding no live
// code, no tmux tree and no pty. The WARDEN-1261 contract forbids LIVE
// orphans, not pending reaps — so on a host whose PID 1 does not reap (some
// container supervisors), the signal-0 probe misreads an already-dead process
// as a survivor. Reading the kernel state directly is correct on every host
// and identical in outcome wherever init reaps promptly: gone or Z (zombie)
// or X (dead) ⇒ not alive; any running state ⇒ alive. /proc unreadable ⇒
// fall back to the signal-0 probe.
func processAlive(pid int) bool {
	if b, err := os.ReadFile(fmt.Sprintf("/proc/%d/stat", pid)); err == nil {
		// state is the field right after the parenthesized comm — comm can
		// contain ')' itself, so anchor on the LAST one.
		if i := bytes.LastIndexByte(b, ')'); i >= 0 && i+2 < len(b) {
			state := b[i+2]
			return state != 'Z' && state != 'x' && state != 'X'
		}
	}
	return syscall.Kill(pid, 0) != syscall.ESRCH
}

// killTestProcess force-kills a test process (best-effort cleanup in failure
// paths only — never part of an assertion's success path).
func killTestProcess(pid int) {
	_ = syscall.Kill(pid, syscall.SIGKILL)
}
