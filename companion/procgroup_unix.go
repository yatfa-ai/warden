//go:build !windows

package main

import (
	"os/exec"
	"syscall"
)

// armProcessGroupKill (Unix) runs the script in its OWN process group and arms
// the ctx-cancel hook to SIGKILL the WHOLE group, not just the direct bash
// child (WARDEN-1261 QA rework).
//
// Why the default exec.CommandContext kill is not enough: every real script the
// exec RPC serves is multi-command or a pipeline (`cd '<cwd>' && git …
// 2>/dev/null`, `… | cut | head`, `sleep N & wait`) — shapes under which bash
// FORKS the work processes instead of exec-optimizing into them. Killing only
// bash orphans those forks host-side (the exact orphan the ticket forbids),
// they keep the inherited stdout pipe open, and cmd.Wait() then blocks on the
// copy goroutine until the last orphan exits — so a timed-out probe produced NO
// response at all (the JS backstop surfaced a transport-error envelope instead
// of the kill shape) and, worse, stalled the companion's SERIAL dispatch loop
// for the orphan's full remaining lifetime: one hung probe froze every
// companion op for the host.
//
// Setpgid gives the child its own process group (pgid == child pid — it can
// never collide with the companion's own group, so kill(-pid) can never signal
// the companion itself); kill(-pid, SIGKILL) reaps bash plus every fork it
// left behind, the pipes close, and Wait returns promptly with the partial-
// output kill shape {ok:false, code:-1, stdout-so-far}. runScriptCtx layers a
// WaitDelay backstop on top for the rare holder outside the group.
func armProcessGroupKill(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error {
		if cmd.Process == nil {
			return nil // not started — nothing to kill (defensive; Cancel only fires post-Start)
		}
		err := syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
		if err == syscall.ESRCH {
			return nil // the group is already gone — lost the race with natural exit; nothing to do
		}
		return err
	}
}
