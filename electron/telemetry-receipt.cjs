// The ONE consent-gated "window receipt" for the Electron main process
// (WARDEN-1468). Every metrics / incidents / names window that arrives over IPC
// or the server-child message channel used to re-hand-write the same three-line
// consent gate → build → record receipt in main.cjs — five copies and growing
// (two landed in the week before this file did, under WARDEN-1265). The copied
// line is the CONSENT GATE, and main.cjs cannot be required under `node --test`,
// so nothing pinned which consent key each receipt actually checked: a future
// paste that kept the wrong key (e.g. a names-bearing event gated on
// 'operational-metrics') shipped silently.
//
// WHY THIS FILE IS SPLIT OUT OF main.cjs: main.cjs `require('electron')`, so it
// can only run under Electron itself — it cannot be exercised by `node --test`
// (same split as window-state.cjs / telemetry-config.cjs). The receipt is
// electron-free and pure: main.cjs injects the live seams (the consent resolver
// reading telemetryPrefs, the pipeline's record sink, the schema version, the
// non-identifying labels, the clock) and the five named receipts in main.cjs
// collapse to one-liners through the returned receiver. The receiver's contract
// is unit-tested in web/telemetry-receipt.test.mjs, whose source-assertion leg
// pins WHICH category → builder pair each of the five main.cjs receipts uses.
//
// Behavior is byte-preserving against the hand-copied receipts it replaces:
//   • the gate is `consent()[category] !== true` — only a literal `true` passes
//     (the same strict check every removed copy used), and a dropped window
//     returns null with build/record never touched;
//   • labels() is read PER CALL (not captured at construction) — same seams as
//     before, so a label change between windows is reflected immediately;
//   • `now` is passed through as the FUNCTION reference (the builders invoke
//     it), exactly as every removed copy passed `now: Date.now`;
//   • `extra` (e.g. `{ runtime: 'renderer' }`) spreads LAST so a receipt can
//     attach receipt-specific fields; receipts with no extra pass nothing and
//     the builder sees `runtime` undefined → its own 'main' default;
//   • a null/falsy build records nothing and returns null; a real build is
//     recorded and returned — so a receipt that must do more after an ACCEPTED
//     window (the pane culprit persist) can branch on the return value.

function createWindowReceipt({ consent, record, schemaVersion, labels, now }) {
  return function receive(category, build, snapshot, extra) {
    if (consent()[category] !== true) return null;
    const event = build({ snapshot, schemaVersion, ...labels(), now, ...extra });
    if (event) record(event);
    return event ?? null;
  };
}

module.exports = { createWindowReceipt };
