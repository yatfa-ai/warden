//go:build !windows

package main

import (
	"os"
	"os/exec"
	"syscall"

	"github.com/creack/pty"
)

// ---------------------------- host-side PTY (unix) ---------------------------
// WARDEN-1295. The live web-pane attach is the one op family that is not a
// request/response command but a STREAM: warden needs a real terminal on the
// host so tmux (and everything under it) sees a tty, gets SIGWINCH on resize,
// and renders colors/control sequences exactly as it does under `ssh -tt`.
//
// The default path gets that terminal LOCALLY (node-pty wrapping an `ssh -tt`
// child) and lets ssh carry the pty semantics to the host. On the companion
// path there is no ssh child to wrap, so the terminal must be allocated HERE,
// on the host, and its bytes framed over the existing stdio channel.
//
// creack/pty is the standard pure-Go openpty/TIOCSWINSZ wrapper — it is
// CGO-FREE (raw syscalls + generated ioctl constants), so it compiles into the
// same static CGO_ENABLED=0 binary the build script already produces and adds
// NO host runtime prerequisite. It is go.mod's first and only dependency.
//
// Platform split mirrors the procgroup_unix.go / procgroup_windows.go precedent
// (WARDEN-1261): Windows has no openpty and no TIOCSWINSZ, so the twin file
// returns an actionable error instead of pretending.

// hostPTYSupported reports whether this build can allocate a host-side PTY. It
// gates the attach* entries in the ping `methods` list, so a companion that
// physically cannot serve an attach never ADVERTISES one — the JS side then
// refuses the attach up front with an actionable message instead of opening a
// pane that can only die. (Platform honesty, WARDEN-1295 AC #6.)
const hostPTYSupported = true

// unixPTY is one live host-side terminal: the master side of the pty (an
// *os.File carrying both directions) plus the child running under its slave.
type unixPTY struct {
	f   *os.File
	cmd *exec.Cmd
}

// startHostPTY allocates a host-side PTY, runs `bash -c <script>` under it at
// the requested size, and returns the handle.
//
// `bash -c` — NOT `bash -lc` — is the deliberate parity choice. Every other
// companion RPC uses `bash -lc` because it mirrors run()/runTmux, which deliver
// `ssh <host> bash -lc <quoted>`. The attach path is different: attachPty
// (src/ssh.js) hands ssh a BARE remote command string, and sshd executes it
// with the user's shell as `$SHELL -c <command>` — a NON-login `-c`. The login
// shell the sibling RPCs need `-lc` for is already INSIDE this script: the
// delivered string is `export LANG=…; bash -lc <shellQuote(cmd)>`, whose inner
// `bash -lc` is what resolves docker/tmux on PATH. Using `-lc` here would source
// the profile a second time — a divergence from the default path, in the one
// place the ticket pins byte-for-byte parity.
//
// TERM is set from the caller (warden forwards its own `process.env.TERM ||
// 'xterm'`, which is exactly what node-pty puts on the child and what `ssh -tt`
// then propagates to the host). LANG/LC_ALL are NOT set here — they are set by
// the `export` inside the delivered script itself, byte-identical to today.
func startHostPTY(script, term string, cols, rows uint16) (hostPTY, error) {
	cmd := exec.Command("bash", "-c", script)
	env := os.Environ()
	if term == "" {
		term = "xterm" // node-pty's DEFAULT_NAME (lib/unixTerminal.js)
	}
	cmd.Env = append(env, "TERM="+term)
	f, err := pty.StartWithSize(cmd, &pty.Winsize{Cols: cols, Rows: rows})
	if err != nil {
		return nil, err
	}
	return &unixPTY{f: f, cmd: cmd}, nil
}

func (p *unixPTY) Read(b []byte) (int, error)  { return p.f.Read(b) }
func (p *unixPTY) Write(b []byte) (int, error) { return p.f.Write(b) }

// Resize sets the terminal winsize (TIOCSWINSZ), which delivers SIGWINCH to the
// foreground process group — the same signal `ssh -tt`'s window-change message
// produces on the default path, so tmux re-renders identically.
func (p *unixPTY) Resize(cols, rows uint16) error {
	return pty.Setsize(p.f, &pty.Winsize{Cols: cols, Rows: rows})
}

// Kill tears the session down. pty.Start puts the child in its own SESSION
// (Setsid + Setctty), so its process-group id equals its pid and kill(-pid)
// reaps the whole tree — the attach script is `bash -c` wrapping an inner
// `bash -lc` wrapping tmux/docker, so killing only the direct child would
// orphan the rest (the WARDEN-1261 lesson, same shape). Closing the master
// afterwards makes the reader's Read return EIO/EOF so the pump settles.
func (p *unixPTY) Kill() {
	if p.cmd != nil && p.cmd.Process != nil {
		if err := syscall.Kill(-p.cmd.Process.Pid, syscall.SIGKILL); err != nil {
			// The group may already be gone (lost the race with a natural exit),
			// or Setsid may not have applied — fall back to the direct child.
			_ = p.cmd.Process.Kill()
		}
	}
	_ = p.f.Close()
}

// Wait reaps the child and returns its exit code, mirroring node-pty's onExit
// `exitCode`. A signal death (our own Kill, or the session ending) has no exit
// status, so it settles as -1 — the same value runScriptCtx uses for a
// non-ExitError outcome.
func (p *unixPTY) Wait() int {
	err := p.cmd.Wait()
	_ = p.f.Close()
	if err == nil {
		return 0
	}
	if exitErr, ok := err.(*exec.ExitError); ok {
		return exitErr.ExitCode()
	}
	return -1
}
