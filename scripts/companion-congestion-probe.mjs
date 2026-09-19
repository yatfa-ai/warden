#!/usr/bin/env node
// WARDEN-1402 — companion-channel congestion harness: the live-system A/B
// instrument for the pane-echo tail diagnosis.
//
// Drives the REAL companion daemon binary over stdio pipes — byte-for-byte the
// production channel (spawnPersistentChannel) minus the ssh segment — and
// measures the felt path: attachInput written → that pane's attachData echo
// back. The "remote link" is simulated by THROTTLING the harness's stdout
// reads: when the daemon produces pane output faster than the throttle drains
// it, the stdout pipe backpressures exactly as sshd's TCP send buffer does in
// production, and whatever the daemon does while blocked is the mechanism
// under test.
//
// Scenarios:
//   idle      one quiet echo pane; 40 keystrokes.
//   flood     a second pane streaming at full line rate (`yes`), reader
//             throttled to ~64 KB/s; 40 keystrokes into the quiet pane.
//
// Usage: node scripts/companion-congestion-probe.mjs [--bin <path>]
// Prints one stats line per scenario; exit 0 always (the numbers ARE the result).

import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const platform = `linux-${process.arch === 'x64' ? 'amd64' : process.arch === 'arm64' ? 'arm64' : process.arch}`;
const DEFAULT_BIN = path.join(__dirname, '..', 'companion', 'dist', `warden-companion-${platform}`);
const binIdx = process.argv.indexOf('--bin');
const BIN = binIdx >= 0 ? process.argv[binIdx + 1] : DEFAULT_BIN;
if (!fs.existsSync(BIN)) {
  console.error(`companion binary not found: ${BIN} (build it: companion/build.sh)`);
  process.exit(1);
}

const pct = (values, p) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
};

// ---- channel: spawn the daemon, speak newline-delimited JSON-RPC -----------

const child = spawn(BIN, [], { stdio: ['pipe', 'pipe', process.env.DBGOUT ? 'pipe' : 'inherit'] });

// The throttle: the stdout stream stays PAUSED and we read EXACT small slices
// per tick against a refill budget. When the budget is gone we simply stop
// reading — the daemon's stdout PIPE fills and its writes actually BLOCK, the
// real backpressure shape (a stopped reader stands in for a saturated
// sshd→local TCP drain). Reading in ≤8KB slices keeps the HARNESS's own
// buffering (~KBs, single-digit ms at these rates) from masking the latency
// being measured: node never applies backpressure on its own, and big-gulp
// reads queue megabytes invisibly — a topology the production channel does
// not have, and one that hides exactly the mechanism under test.
let rateBps = Infinity;
let budget = 0;
let lineCb = null;
child.stdout.pause();
child.stdout.on('readable', () => { pump(); });
setInterval(() => {
  // pump() runs in BOTH modes: the budget refill above drives the throttled
  // drain, and the Infinity path must keep draining too — a paused stream
  // only fires 'readable' on new data, so a buffer drained to null with the
  // daemon blocked on the full pipe would otherwise wait for an edge that
  // never comes (a harness-only topology; production consumers read
  // continuously).
  budget = Math.min(budget + (rateBps === Infinity ? 0 : rateBps / 100), 16 * 1024);
  pump();
}, 10).unref();
function pump() {
  if (rateBps === Infinity) {
    for (;;) {
      const b = child.stdout.read();
      if (!b) break;
      accPush(b);
    }
    drainLines();
    return;
  }
  for (;;) {
    if (budget < 1024) return; // link saturated — stop reading; the pipe fills, the daemon blocks
    // read(1024), never read(0-arg): read(N) returns null while fewer than N
    // bytes are buffered, so a big N deadlocks the throttle with a partial
    // chunk parked in the stream buffer (the daemon blocked on the full pipe,
    // the harness waiting for bytes it already holds).
    const b = child.stdout.read(1024);
    if (!b) return;
    budget -= b.length;
    accPush(b);
    drainLines();
  }
}
// Line accumulator over everything the throttle has allowed through so far.
// AMORTIZED on purpose: this used to concatenate a fresh Buffer per read and
// rescan the whole accumulator per read — O(n²) in the bytes drained — which
// stalled THIS harness's own event loop for seconds at a time in the 64KB/s
// scenario. The daemon's writes then blocked on a reader that had stopped,
// and every tail measurement inherited harness-side stalls of its own making
// (seen on the WARDEN-1402 rework's A/B: one 4.6KB daemon write blocked
// 2.24s against a 64KB/s drain — the reader was stalled, not the link). Same
// read cadence and budget semantics; only the buffering is fixed.
const acc = { buf: Buffer.alloc(1 << 16), filled: 0, scanned: 0 };
function accPush(b) {
  if (acc.filled + b.length > acc.buf.length) {
    acc.buf.copy(acc.buf, 0, acc.scanned, acc.filled); // drop the consumed prefix
    acc.filled -= acc.scanned;
    acc.scanned = 0;
    if (acc.filled + b.length > acc.buf.length) {
      const grown = Buffer.alloc(Math.max(acc.buf.length * 2, acc.filled + b.length));
      acc.buf.copy(grown, 0, 0, acc.filled);
      acc.buf = grown;
    }
  }
  b.copy(acc.buf, acc.filled);
  acc.filled += b.length;
}
function drainLines() {
  for (;;) {
    const idx = acc.buf.subarray(acc.scanned, acc.filled).indexOf(0x0a);
    if (idx < 0) return;
    const line = acc.buf.toString('utf8', acc.scanned, acc.scanned + idx);
    acc.scanned += idx + 1;
    if (lineCb && line.length) lineCb(line);
  }
}

let nextId = 1;
const pending = new Map();
lineCb = (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.event === 'attachData') {
    for (const [, p] of pending) { if (p.onData) p.onData(msg); }
    return;
  }
  if (msg.id === undefined) return;
  const p = pending.get(msg.id);
  if (p && p.resolve) { pending.delete(msg.id); p.resolve(msg); }
};
function call(method, params) {
  const id = nextId++;
  const req = JSON.stringify({ id, method, params }) + '\n';
  return new Promise((resolve) => {
    pending.set(id, { resolve });
    child.stdin.write(req);
  });
}

// ---- scenario helpers ------------------------------------------------------

async function attachStart(script, cols = 100, rows = 30) {
  const r = await call('attachStart', { script, cols, rows, term: 'xterm' });
  if (!r.ok) throw new Error(`attachStart failed: ${r.error}`);
  return r.result.sid;
}
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const unb64 = (s) => Buffer.from(s, 'base64').toString('utf8');

// Type one keystroke into `sid`; resolve with the elapsed ms when the echo of
// THAT byte arrives on THAT pane's attachData (sid-filtered — another pane's
// stream output must never resolve the wait).
async function typeOnce(sid, ch) {
  return new Promise((resolve, reject) => {
    const t0 = performance.now();
    const onData = (msg) => {
      if (msg.sid !== sid) return;
      if (unb64(msg.Data ?? msg.data ?? '').includes(ch)) {
        p.onData = null;
        resolve(performance.now() - t0);
      }
    };
    const p = { onData };
    const id = nextId++;
    pending.set(id, p);
    child.stdin.write(JSON.stringify({ id, method: 'attachInput', params: { sid, data: b64(ch) } }) + '\n');
    setTimeout(() => { if (p.onData) { p.onData = null; pending.delete(id); reject(new Error('echo timeout')); } }, ECHO_TIMEOUT_MS);
  });
}

const stats = (values) => `n=${values.length} p50=${pct(values, 50)?.toFixed(1)}ms p95=${pct(values, 95)?.toFixed(1)}ms max=${pct(values, 100)?.toFixed(1)}ms`;

async function typeBurst(sid, n) {
  const samples = [];
  for (let i = 0; i < n; i++) {
    try { samples.push(await typeOnce(sid, String.fromCharCode(97 + (i % 26)))); }
    catch { /* a timeout IS a tail datapoint — record it at the ceiling */ samples.push(ECHO_TIMEOUT_MS); }
    await new Promise((r) => setTimeout(r, 100));
  }
  return samples;
}

// ---- run -------------------------------------------------------------------

const KEYS = 40;
// The echo-wait ceiling: a keystroke whose echo has not arrived within this is
// RECORDED at this value (and the wait abandoned) — a bounded tail datapoint
// instead of a multi-minute hang. 5s is far above the 300ms felt bar.
const ECHO_TIMEOUT_MS = 8000;

// Scenario 1: idle — quiet link (throttle off), one echo pane.
{
  console.error('scenario: idle starting');
  const sid = await attachStart('cat');
  console.error('scenario: idle attached', sid);
  await new Promise((r) => setTimeout(r, 300));
  rateBps = Infinity;
  const samples = await typeBurst(sid, KEYS);
  console.log(`idle (line-speed drain)      ${stats(samples)}`);
  await call('attachKill', { sid });
}

// Scenario 2/3: flood — second pane streaming at full line rate (`yes`), link
// throttled by pausing the reader (real pipe backpressure), keystrokes into
// the quiet pane. Two drain rates:
//   1 MB/s   — a realistically degraded Wi-Fi uplink (8 Mbps).
//   64 KB/s  — the extreme floor (0.5 Mbps): here a ~1s floor is physics, not
//              warden — one 64KB pipe + the paused-stream buffers ahead of the
//              echo drain at the link rate even with perfect prioritization;
//              the scenario pins that bound rather than the felt bar.
for (const [label, drain, keys, floodScript] of [
  ['flood (1MB/s link)', 1 << 20, KEYS, 'yes flood-line-padding-xxxxxxxxxxxx'],
  // The extreme floor (0.5 Mbps uplink under sustained flood) with a
  // rate-limited flood (still ~3x the drain): here a ~1s floor is physics,
  // not warden — one 64KB pipe ahead of the echo drains at the link rate even
  // with perfect prioritization; the scenario pins that bound, not the bar.
  ['flood (64KB/s link)', 64 * 1024, 10, 'while :; do echo flood-line-padding-xxxxxxxxxxxx; sleep 0.0005; done'],
]) {
  console.error(`scenario: ${label} starting`);
  const sid = await attachStart('cat');
  const flood = await attachStart(floodScript);
  console.error(`scenario: ${label} attached`, sid, flood?.result?.sid ?? flood?.sid);
  await new Promise((r) => setTimeout(r, 300));
  rateBps = drain;
  const samples = await typeBurst(sid, keys);
  console.error(`scenario: ${label} typed`);
  const okN = samples.filter((s) => s < ECHO_TIMEOUT_MS).length;
  console.log(`${label.padEnd(28)} ${stats(samples)}  (echoed ${okN}/${samples.length})`);
  rateBps = Infinity;
  await call('attachKill', { sid });
  await call('attachKill', { flood });
  await new Promise((r) => setTimeout(r, 100));
}

child.kill('SIGKILL');
process.exit(0);
