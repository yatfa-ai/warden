package main

import (
	"context"
	"testing"
)

// useCaptureScript swaps the watcher's capture script for the test's duration.
func useCaptureScript(t *testing.T, script string) {
	t.Helper()
	captureScriptMu.Lock()
	prev := captureScriptFn
	captureScriptFn = func([]capturePaneReq) string { return script }
	captureScriptMu.Unlock()
	t.Cleanup(func() {
		stopSubscription()
		captureScriptMu.Lock()
		captureScriptFn = prev
		captureScriptMu.Unlock()
	})
}

func contextWithCancelForTest() (context.Context, context.CancelFunc) {
	return context.WithCancel(context.Background())
}
