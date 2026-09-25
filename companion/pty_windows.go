//go:build windows

package main

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"unicode/utf16"
	"unsafe"

	"golang.org/x/sys/windows"
)

// ---------------------------- host-side PTY (windows) ------------------------
// WARDEN-1437. The live web-pane attach is a STREAM, and it needs a real
// terminal ON THE HOST so tmux (and everything under it) sees a tty, gets
// resize signals, and renders colors/control sequences exactly as it does
// under `ssh -tt` — pty_unix.go carries the full rationale, and this file
// mirrors it.
//
// The terminal facility on Windows is ConPTY, and the earlier premise that it
// was out of reach (a CGO/Win32 API surface with no pure-Go route to it) was
// simply wrong. golang.org/x/sys/windows — the Go team's pure-Go syscall
// module; it calls kernel32 through SyscallN, with no cgo — exports everything
// ConPTY needs: CreatePipe, CreateProcess, StartupInfoEx, the
// ProcThreadAttributeList machinery (PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE),
// ClosePseudoConsole, and the Job object APIs. CreatePseudoConsole and
// ResizePseudoConsole are present as x/sys's UNexported generated wrappers, so
// this file binds them directly through the same LazySystemDLL/LazyProc
// mechanism x/sys itself uses — still pure Go, still CGO_ENABLED=0, still a
// static binary with no host runtime prerequisite.
//
// RUNTIME GATE, NOT BUILD GATE: ConPTY exists only on Windows 10 1809 or
// later, and one windows/amd64 binary serves Windows 7 through 11. So
// hostPTYSupported is computed ONCE AT INIT from a kernel32 proc lookup. On a
// pre-1809 host the attach* names stay OUT of the ping `methods` list
// (pingMethods, main.go) and any attachStart that still arrives returns the
// actionable errNoHostPTY — exactly the pre-1437 behaviour, preserved. The
// per-host exclusion (Settings → Performance, WARDEN-1390) remains the right
// remedy for a genuinely incapable host; a Windows CLIENT attaching to a
// Linux/macOS host was never affected (the companion runs on the HOST).
//
// TREE KILL (the WARDEN-1261 lesson, same shape as pty_unix.go's kill(-pid)):
// the attach script is `bash -c` wrapping an inner `bash -lc` wrapping
// tmux/docker, so killing only the direct child would orphan the rest. There
// is no process-group facility here, so the child is created SUSPENDED,
// assigned to a Job object carrying JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, and
// only then resumed — the job catches every descendant the child ever spawns,
// and teardown terminates the whole tree in one call. No direct-child ceiling.
//
// CLOSE DISCIPLINE (why teardown is split the way it is): the pump goroutine
// blocks inside ReadFile on the output pipe, and closing a pipe end under a
// blocked synchronous ReadFile is the one unsafe close on Windows. So nothing
// ever closes the reader's end underneath it — shutdownIO ends the conhost
// session via ClosePseudoConsole, which closes the WRITER end the conhost
// holds, and the blocked ReadFile then fails with a broken pipe on its own.
// THREE sites reach shutdownIO, and ioOnce makes the order of arrival
// irrelevant: Kill, the natural-exit WATCHER (see newConPTY — conhost holds
// the writer end open past the child's own death, so an exit that never goes
// through Kill would otherwise never EOF the reader), and Wait as the
// once-guarded backstop. Wait (running on the pump goroutine, after its Read
// has already returned) is the only site that closes the reader's own end,
// and it closes the proc/job handles only after BOTH waits on the process
// handle have completed, so no handle value is ever closed twice or reused
// underneath us. ClosePseudoConsole is additionally guarded by pcMu + closed
// so an attachResize arriving in the window between teardown and the pump's
// attachExit refuses instead of touching a freed HPCON.

var conptyKernel32 = windows.NewLazySystemDLL("kernel32.dll")

var (
	procCreatePseudoConsole = conptyKernel32.NewProc("CreatePseudoConsole")
	procResizePseudoConsole = conptyKernel32.NewProc("ResizePseudoConsole")
)

// hostPTYSupported reports whether this HOST can allocate a ConPTY. The unix
// twin is a build-time const; here it is a runtime lookup, because the same
// windows/amd64 binary runs on every Windows version and only 1809+ exports
// CreatePseudoConsole. pingMethods() and the tests read it exactly the way
// they read the old constant. On a host where the lookup fails, attach* is
// never advertised and startHostPTY returns errNoHostPTY. (ResizePseudoConsole
// shipped in the same 1809 release, so the one lookup gates both.)
var hostPTYSupported = procCreatePseudoConsole.Find() == nil

// errNoHostPTY is the actionable attachStart error a companion on a host with
// no ConPTY returns. It surfaces through warden's existing attach_error path
// (server.js:2873-2877), so the pane shows a real message instead of a
// spinner. WARDEN-1390: the remedy is the PER-HOST exclusion (Settings →
// Performance), not the fleet-global toggle — an old host must keep every
// OTHER host on the channel, so turning the transport off everywhere is
// offered only as the broader alternative.
var errNoHostPTY = errors.New(
	"this host's companion cannot allocate a PTY (ConPTY requires Windows 10 1809 or later; " +
		"Windows older than 10 1809 has no ConPTY, so the CreatePseudoConsole API is absent). " +
		"Exclude this host in Warden Settings (Performance, \"Companion excluded hosts\") " +
		"to attach over the default SSH path — only this host is affected, so the fleet-global " +
		"toggle (WARDEN_COMPANION_TRANSPORT=0) is not needed")

// createPseudoConsole binds kernel32!CreatePseudoConsole. size is the packed
// COORD DWORD (X in the low 16 bits, Y in the high); the return is an HRESULT
// — 0 (S_OK) on success, a non-zero code otherwise — mirroring x/sys's own
// generated wrapper byte for byte. Only ever called after hostPTYSupported
// proved the proc resolves.
func createPseudoConsole(size uint32, in, out windows.Handle, flags uint32, pconsole *windows.Handle) error {
	r1, _, _ := procCreatePseudoConsole.Call(
		uintptr(size), uintptr(in), uintptr(out), uintptr(flags), uintptr(unsafe.Pointer(pconsole)))
	if r1 != 0 {
		return syscall.Errno(r1)
	}
	return nil
}

// resizePseudoConsole binds kernel32!ResizePseudoConsole (same HRESULT shape).
func resizePseudoConsole(console windows.Handle, size uint32) error {
	r1, _, _ := procResizePseudoConsole.Call(uintptr(console), uintptr(size))
	if r1 != 0 {
		return syscall.Errno(r1)
	}
	return nil
}

// coordDim packs a clampDim'ed uint16 into the COORD DWORD's int16 half. A
// terminal wider/taller than 32767 is absurd, but wrap-to-negative would read
// as an invalid size error — cap instead.
func coordDim(v uint16) uint32 {
	if v > 32767 {
		return 32767
	}
	return uint32(v)
}

// conPTY is one live host-side terminal on Windows: the pseudo console (which
// owns the conhost session), the pipe ends THIS process holds, and the child
// process living in its kill-on-close job. It implements the hostPTY interface
// (attach.go) — the same five methods the unix twin implements.
type conPTY struct {
	pc   windows.Handle // the pseudo console handle
	job  windows.Handle // the child's job object (JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE)
	inW  *os.File       // we write keystrokes here; ConPTY reads the other end
	outR *os.File       // we read pane output here; ConPTY writes the other end
	proc windows.Handle // the bash process handle — Wait reads its exit code

	killed atomic.Bool // a Kill happened — Wait settles -1, never the job's exit code
	ioOnce sync.Once   // guards shutdownIO: job terminate + console close + input-pipe close
	pcMu   sync.Mutex  // guards pc's liveness: shutdownIO closes it exactly once, Resize refuses once closed
	closed bool        // teardown has run (read/written only under pcMu)
}

// startHostPTY allocates a host-side ConPTY, runs `bash -c <script>` under it
// at the requested size, and returns the handle. Mirrors pty_unix.go's
// contract byte for byte: `bash -c` — NOT `bash -lc` — is the deliberate
// parity choice (attachPty hands ssh a bare remote command string, which sshd
// executes as a NON-login `-c`; the login shell the sibling RPCs need is
// already INSIDE the delivered script), and TERM defaults to `xterm` (node-pty's
// DEFAULT_NAME, what the default path's child sees).
func startHostPTY(script, term string, cols, rows uint16) (hostPTY, error) {
	if !hostPTYSupported {
		return nil, errNoHostPTY
	}
	if term == "" {
		term = "xterm"
	}
	return newConPTY(script, term, cols, rows)
}

func newConPTY(script, term string, cols, rows uint16) (*conPTY, error) {
	p := &conPTY{}
	ok := false
	// The deferred unwind closes exactly what was created so far, in creation
	// order — every failure path below funnels through here. (The job is
	// closed last: once KILL_ON_JOB_CLOSE is set, closing it also reaps
	// anything already assigned.)
	defer func() {
		if !ok {
			if p.inW != nil {
				_ = p.inW.Close()
			}
			if p.outR != nil {
				_ = p.outR.Close()
			}
			if p.pc != 0 {
				windows.ClosePseudoConsole(p.pc)
			}
			if p.job != 0 {
				_ = windows.CloseHandle(p.job)
			}
		}
	}()

	// Two pipe pairs, per the ConPTY contract: ConPTY READS keystrokes from
	// inR (we keep inW) and WRITES pane output to outW (we keep outR).
	var inR, inW, outR, outW windows.Handle
	if err := windows.CreatePipe(&inR, &inW, nil, 0); err != nil {
		return nil, fmt.Errorf("conpty input pipe: %w", err)
	}
	p.inW = os.NewFile(uintptr(inW), "conpty-in")
	if err := windows.CreatePipe(&outR, &outW, nil, 0); err != nil {
		windows.CloseHandle(inR)
		return nil, fmt.Errorf("conpty output pipe: %w", err)
	}
	p.outR = os.NewFile(uintptr(outR), "conpty-out")

	size := coordDim(cols) | coordDim(rows)<<16
	if err := createPseudoConsole(size, inR, outW, 0, &p.pc); err != nil {
		windows.CloseHandle(inR)
		windows.CloseHandle(outW)
		return nil, fmt.Errorf("CreatePseudoConsole: %w", err)
	}
	// ConPTY holds its own references now; drop ours. Note the reader's EOF
	// does NOT ride the child's death — conhost keeps the writer end open
	// until ClosePseudoConsole runs (see the natural-exit watcher below for
	// who guarantees that on a natural exit).
	windows.CloseHandle(inR)
	windows.CloseHandle(outW)

	// The child's job: created BEFORE the child, KILL_ON_JOB_CLOSE so teardown
	// reaps the whole tree in one call (see the header — why a direct-child
	// kill is not enough here).
	job, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		return nil, fmt.Errorf("CreateJobObject: %w", err)
	}
	p.job = job
	info := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{}
	info.BasicLimitInformation.LimitFlags = windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
	if _, err := windows.SetInformationJobObject(job, windows.JobObjectExtendedLimitInformation,
		uintptr(unsafe.Pointer(&info)), uint32(unsafe.Sizeof(info))); err != nil {
		return nil, fmt.Errorf("SetInformationJobObject: %w", err)
	}

	// bash is a precondition on every Windows host (the host probe keys on
	// MINGW/CYGWIN/MSYS uname, and every exec RPC runs bash) — resolve it the
	// way the sibling RPCs' exec.Command would, so a missing bash fails HERE
	// with the same clarity instead of inside CreateProcess.
	bash, err := exec.LookPath("bash")
	if err != nil {
		return nil, fmt.Errorf("bash: %w", err)
	}
	cmdline, err := windows.UTF16PtrFromString(`"` + bash + `" -c ` + windows.EscapeArg(script))
	if err != nil {
		return nil, fmt.Errorf("attach script command line: %w", err)
	}

	// TERM parity with the unix twin: same env as this process plus TERM, so
	// the child sees exactly what `ssh -tt` would have propagated. Any
	// INHERITED TERM must go first: CreateProcess resolves duplicate keys by
	// first match on Windows (os/exec dedups last-wins on unix), so an entry
	// sshd/MSYS set would beat warden's forwarded value. Drop existing TERM
	// entries case-insensitively before appending ours. The block itself is
	// NUL-separated UTF-16 that MUST end in two NULs — the loop terminates
	// each entry, and the final append terminates the whole block; without
	// it, CreateProcess reads past the slice into adjacent heap memory until
	// it happens to find a zero (Go's own syscall.createEnvBlock appends the
	// same final 0). CREATE_UNICODE_ENVIRONMENT (below) tells CreateProcess
	// which encoding it is reading.
	var envv []string
	for _, kv := range os.Environ() {
		if name, _, _ := strings.Cut(kv, "="); strings.EqualFold(name, "TERM") {
			continue
		}
		envv = append(envv, kv)
	}
	envv = append(envv, "TERM="+term)
	var envBlock []uint16
	for _, kv := range envv {
		envBlock = append(envBlock, utf16.Encode([]rune(kv))...)
		envBlock = append(envBlock, 0)
	}
	envBlock = append(envBlock, 0) // the block's own terminator — two NULs total at the end
	var envPtr *uint16
	if len(envBlock) > 0 {
		envPtr = &envBlock[0]
	}

	// PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE is how the child is born attached
	// to the console — the ConPTY equivalent of the unix slave fd. The
	// attribute VALUE is the pseudo console handle itself (the documented
	// sample passes hPC, not &hPC — the API stores the pointer's bits), so
	// the handle is passed AS the pointer, never as a pointer to the handle.
	attr, err := windows.NewProcThreadAttributeList(1)
	if err != nil {
		return nil, fmt.Errorf("NewProcThreadAttributeList: %w", err)
	}
	defer attr.Delete()
	pc := p.pc
	if err := attr.Update(uintptr(windows.PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE),
		*(*unsafe.Pointer)(unsafe.Pointer(&pc)), unsafe.Sizeof(pc)); err != nil {
		return nil, fmt.Errorf("UpdateProcThreadAttribute: %w", err)
	}

	var siEx windows.StartupInfoEx
	siEx.Cb = uint32(unsafe.Sizeof(siEx))
	siEx.ProcThreadAttributeList = attr.List()
	// STARTF_USESTDHANDLES with the hStd* handles left NULL: without it,
	// Windows duplicates the COMPANION's own standard handles into a
	// console-subsystem child even under a pseudoconsole (the pseudoconsole
	// does not suppress that for non-console handles) — and our stdin/stdout
	// are the sshd pipes carrying the JSON-RPC stream (main.go's scanner and
	// writer). bash — MSYS bash especially, whose runtime prefers real pipe
	// handles over the console — would then read RPC bytes off our stdin and
	// write pane output straight into our JSON-lines stdout, corrupting the
	// channel for EVERY op on this host, not only the attach. NULLed std
	// handles make the CRT fall back to the attached ConPTY instead. The
	// same thing node-pty does (src/win/conpty.cc) and Go's own
	// syscall.StartProcess.
	siEx.StartupInfo.Flags |= windows.STARTF_USESTDHANDLES
	var pi windows.ProcessInformation
	// CREATE_SUSPENDED + AssignProcessToJobObject BEFORE ResumeThread: the
	// job owns the tree from the child's first instruction — there is no
	// window in which a descendant can escape it. EXTENDED_STARTUPINFO_PRESENT
	// is what makes Windows read the attribute list; CREATE_UNICODE_ENVIRONMENT
	// is what makes it read the env block as UTF-16.
	err = windows.CreateProcess(nil, cmdline, nil, nil, false,
		windows.CREATE_UNICODE_ENVIRONMENT|windows.CREATE_SUSPENDED|windows.EXTENDED_STARTUPINFO_PRESENT,
		envPtr, nil, &siEx.StartupInfo, &pi)
	if err != nil {
		return nil, fmt.Errorf("CreateProcess bash: %w", err)
	}
	defer windows.CloseHandle(pi.Thread)
	if err := windows.AssignProcessToJobObject(p.job, pi.Process); err != nil {
		windows.TerminateJobObject(p.job, 1) // suspended child, tree of one — kill it
		windows.CloseHandle(pi.Process)
		return nil, fmt.Errorf("AssignProcessToJobObject: %w", err)
	}
	windows.ResumeThread(pi.Thread)

	p.proc = pi.Process

	// Natural-exit WATCHER: EOF reaches the pump only when the conhost
	// session is CLOSED, and conhost holds its end of the output pipe past
	// the child's own death — ClosePseudoConsole is the only thing that ends
	// it, and without this watcher nothing calls it on a natural exit (Wait
	// cannot: it runs on the pump goroutine, only after Read has already
	// returned — circular). A tmux detach or `kill-session`, an ordinary end
	// that never goes through Kill, would then freeze the pane and leak the
	// session until warden happened to send attachKill — breaking the
	// "exactly one attachExit however the end arrives" contract
	// (attach.go's exitOnce, which the unix twin meets by construction).
	// This goroutine wakes at the child's exit and tears the session down
	// OFF the reader goroutine — also safe on pre-24H2 builds where
	// ClosePseudoConsole blocks until the buffer drains, because the pump
	// keeps draining while it waits. Wait's own shutdownIO stays as the
	// once-guarded backstop (and reads the exit code).
	go func() {
		_, _ = windows.WaitForSingleObject(p.proc, windows.INFINITE)
		p.shutdownIO()
	}()

	ok = true
	return p, nil
}

func (p *conPTY) Read(b []byte) (int, error)  { return p.outR.Read(b) }
func (p *conPTY) Write(b []byte) (int, error) { return p.inW.Write(b) }

// Resize sets the terminal size (ResizePseudoConsole), which resizes the
// conhost screen buffer — the ConPTY counterpart of the unix twin's
// TIOCSWINSZ/SIGWINCH, and of `ssh -tt`'s window-change message. Refuses
// once teardown has run: the session stays registered until the pump reaches
// attachExit, so an attachResize can legitimately arrive in that window (after
// attachKill, or during Wait), and ResizePseudoConsole on a closed HPCON
// would touch a dangling pointer into kernelbase — not an fd that fails
// EBADF like the unix twin's.
func (p *conPTY) Resize(cols, rows uint16) error {
	p.pcMu.Lock()
	defer p.pcMu.Unlock()
	if p.closed {
		return errors.New("conpty: resize refused — the session has been torn down")
	}
	return resizePseudoConsole(p.pc, coordDim(cols)|coordDim(rows)<<16)
}

// Kill tears the session down. TerminateJobObject reaps the whole tree (every
// descendant the bash→tmux chain spawned), and ClosePseudoConsole ends the
// conhost session — which closes the WRITER end of the output pipe, so the
// pump's blocked Read fails with a broken pipe on its own and the session
// settles with exactly one attachExit. The reader's own end is NOT closed
// here (close-under-blocked-ReadFile is the one unsafe close; see the header).
// Idempotent by construction: the once makes a second Kill a no-op.
func (p *conPTY) Kill() {
	p.killed.Store(true)
	p.shutdownIO()
}

// shutdownIO is the once-guarded teardown shared by Kill, the natural-exit
// watcher and Wait: terminate the tree, end the conhost session (EOF for the
// reader), close our write end (the dispatch loop serializes writes with
// Kill, so none is in flight here). The console close and the closed stamp
// sit under pcMu so Resize can never observe a half-torn-down session.
func (p *conPTY) shutdownIO() {
	p.ioOnce.Do(func() {
		// No-op when the tree already exited; authoritative when it has not.
		_ = windows.TerminateJobObject(p.job, 1)
		p.pcMu.Lock()
		if p.pc != 0 {
			windows.ClosePseudoConsole(p.pc) // void — releasing the conhost session
			p.pc = 0
		}
		p.closed = true
		p.pcMu.Unlock()
		_ = p.inW.Close()
	})
}

// Wait reaps the child and returns its exit code, mirroring node-pty's onExit
// `exitCode` and the unix twin: the real exit status after a natural exit,
// -1 after our own Kill (a job termination has no meaningful status — the
// same convention runScriptCtx uses for a non-ExitError outcome). It runs on
// the pump goroutine AFTER the read loop ended, so closing the reader's end
// here cannot land under an in-flight Read, and it closes proc/job only after
// both its wait and the watcher's wait on the process handle have completed.
// Its own shutdownIO is the once-guarded backstop — a no-op when the
// natural-exit watcher already ran, authoritative if it somehow did not.
func (p *conPTY) Wait() int {
	code := -1
	if event, err := windows.WaitForSingleObject(p.proc, windows.INFINITE); err == nil && event == windows.WAIT_OBJECT_0 {
		var c uint32
		if windows.GetExitCodeProcess(p.proc, &c) == nil {
			code = int(c)
		}
	}
	p.shutdownIO()
	// Our read already returned — this is the one safe moment to close it.
	_ = p.outR.Close()
	_ = windows.CloseHandle(p.job)
	_ = windows.CloseHandle(p.proc)
	if p.killed.Load() {
		return -1
	}
	return code
}
