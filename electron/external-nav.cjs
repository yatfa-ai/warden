'use strict';
// Pure navigation classifier for the Electron main process (WARDEN-1906).
//
// Electron's default for window.open / <a target="_blank"> is to open a second
// in-app BrowserWindow on the remote page. The main process instead routes
// every such navigation through classifyNavigation():
//   'allow'    — the app's own origin (exact origin match; never a prefix or
//                substring match, so `127.0.0.1.evil.com` is NOT the app).
//   'external' — any other http(s) URL → handed to the OS browser.
//   'deny'     — everything else (file:, javascript:, data:, malformed, ...).

function classifyNavigation(url, appOrigin) {
  let parsed;
  try {
    parsed = new URL(String(url));
  } catch {
    return 'deny';
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return 'deny';
  if (appOrigin) {
    let app;
    try {
      app = new URL(String(appOrigin));
    } catch {
      app = null;
    }
    if (app && parsed.origin === app.origin) return 'allow';
  }
  return 'external';
}

module.exports = { classifyNavigation };
