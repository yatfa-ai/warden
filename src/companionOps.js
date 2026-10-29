// Per-host companion op tally — WARDEN-2014. Moved verbatim from companion.js so
// the transport layer (companionTransport.js) can record ops without importing
// companion.js. companion.js re-exports the test getter and mutates the live Map
// (delete/clear) through its import.

// ---- per-host op tallies (WARDEN-1312 — "are operations actually riding it") ----
// Per-host, per-method counts of the ops issued over the companion channel:
//   host -> { [method]: { n, failures, lastAt } }
//   n        — ops issued for this method, INCLUDING ones that go on to fail,
//              so `failures <= n` is a true invariant ("12 ops · 1 failed").
//   failures — ops that failed at the TRANSPORT level (dead channel / timeout /
//              write throw — the three CompanionTransportError rejects lexically
//              inside CompanionChannel.call). A host-side command failure
//              (msg.ok === false → CompanionRpcError, rejected in _onLine) is the
//              op's own result semantics and is NOT a transport failure.
//   lastAt   — epoch ms of the last ride.
// PING IS NOT COUNTED, on purpose: both ping call sites (pingOnce — the bootstrap
// probe — and channelMethods — the feature-detect fallback) are the channel's own
// infrastructure, not product ops. Counting them would put ops:{ping:…} on every
// bootstrapped host, (a) breaking the exact-shape status contract pinned by the
// deepStrictEqual assertions in companion.test.js for bootstrapped-but-idle hosts,
// and (b) making "exactly send: 2, discover: 1, exec: 1" unreadable. The tally is
// keyed by host × the method names actually called, so it is bounded; repeated
// ops mutate the same entry in place. Like companionStatus this is process-
// lifetime in-memory state: a restart resets it, which is correct for an
// "is it working right now" signal. NOT persisted, NOT telemetry — warden's own
// product UI state (WARDEN-1265's surface is untouched).
export const companionOps = new Map();

// Module-private writers — the single recording site is CompanionChannel.call
// (the one choke point every RPC already passes through), so today's op set and
// every future op is covered with no per-call-site edits. Two narrow mutators,
// mirroring the setCompanionStatus one-writer discipline above:
//   recordCompanionOp         — the op is ISSUED: n += 1, lastAt = now.
//   recordCompanionOpFailure  — the op FAILED at the transport level:
//                               failures += 1 ONLY (n was already counted at
//                               issue time; double-counting would break the
//                               "failures <= n, 12 ops · 1 failed" read).
// Plain synchronous map mutation wrapped in a catch: the tally must NEVER throw
// into the op path.
function _companionOpTally(host, method) {
  let perMethod = companionOps.get(host);
  if (!perMethod) companionOps.set(host, (perMethod = {}));
  let t = perMethod[method];
  if (!t) t = perMethod[method] = { n: 0, failures: 0, lastAt: 0 };
  return t;
}

export function recordCompanionOp(host, method) {
  if (method === 'ping') return; // infra probe — see the block comment above
  try {
    const t = _companionOpTally(host, method);
    t.n += 1;
    t.lastAt = Date.now();
  } catch { /* bookkeeping must never break an op */ }
}

export function recordCompanionOpFailure(host, method) {
  if (method === 'ping') return;
  try {
    _companionOpTally(host, method).failures += 1;
  } catch { /* bookkeeping must never break an op */ }
}

// Join the tally onto a status read — used by BOTH getters below. `ops` is added
// ONLY when the host has a non-empty tally, so a host that has bootstrapped but
// issued no ops keeps its byte-identical status shape (the exact-shape contract
// pinned by companion.test.js's deepStrictEqual assertions).
export function joinCompanionOps(host, status) {
  const ops = companionOps.get(host);
  return ops && Object.keys(ops).length > 0 ? { ...status, ops } : status;
}

// Test-only: read the raw op-tally map (host -> method -> {n, failures, lastAt})
// so tally behavior is unit-testable directly (a host can hold tallies before any
// status transition has been asserted). Live map, same convention as
// _getPaneSubscriptionsForTests. Not for production use. (WARDEN-1312)
export function _getCompanionOpsForTests() {
  return companionOps;
}
