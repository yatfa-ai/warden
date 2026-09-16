//go:build windows

package main

import "errors"

// ---------------------------- host-side PTY (windows) ------------------------
// WARDEN-1295. Windows has no openpty and no TIOCSWINSZ; its terminal facility
// is ConPTY, which is a CGO/Win32 API surface with no pure-Go equivalent that
// would keep this binary a dependency-free static build with no host runtime
// prerequisite (the roadmap's hard boundary).
//
// So a Windows companion is HONEST about it rather than silently degrading:
// hostPTYSupported is false, which (1) keeps the attach* names OUT of the ping
// `methods` list, so warden's stale-binary/feature gate refuses the attach up
// front with an actionable message, and (2) makes any attachStart that still
// arrives return the actionable error below. Neither path falls back to raw SSH
// inside the experimental path — that is the companion-or-fail contract
// (WARDEN-1295 AC #6). A Windows HOST keeps the default `ssh -tt` transport by
// turning the companion toggle off; a Windows CLIENT attaching to a Linux/macOS
// host is unaffected (the companion runs on the HOST).
//
// Mirrors the procgroup_windows.go precedent: the platform that cannot do the
// thing says so in one small file instead of contorting the shared path.

const hostPTYSupported = false

// errNoHostPTY is the actionable attachStart error a Windows companion returns.
// It surfaces through warden's existing attach_error path (server.js:2873-2877),
// so the pane shows a real message instead of a spinner. WARDEN-1390: the
// remedy is the PER-HOST exclusion (Settings → Performance), not the
// fleet-global toggle — a Windows host must keep every OTHER host on the
// channel, so turning the transport off everywhere is offered only as the
// broader alternative.
var errNoHostPTY = errors.New(
	"this host's companion cannot allocate a PTY (windows hosts have no openpty/TIOCSWINSZ; " +
		"the companion is a dependency-free static binary and does not link ConPTY). " +
		"Exclude this host in Warden Settings (Performance, \"Companion excluded hosts\") " +
		"to attach over the default SSH path — only this host is affected, so the fleet-global " +
		"toggle (WARDEN_COMPANION_TRANSPORT=0) is not needed")

func startHostPTY(_ string, _ string, _ uint16, _ uint16) (hostPTY, error) {
	return nil, errNoHostPTY
}
