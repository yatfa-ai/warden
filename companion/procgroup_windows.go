//go:build windows

package main

import "os/exec"

// armProcessGroupKill (Windows): process groups via Setpgid / kill(-pid) are a
// Unix facility with no syscall twin here, so the exec RPC keeps
// exec.CommandContext's default behavior — kill the direct child — which is
// also the ceiling the default transport offers on Windows hosts (run()'s JS
// timer can only SIGKILL the ssh client process it owns). The runScriptCtx
// WaitDelay backstop still applies: Wait() never blocks past the deadline
// waiting for descendants to release the pipes.
func armProcessGroupKill(cmd *exec.Cmd) {}
