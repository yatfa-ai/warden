#!/usr/bin/env node
// WARDEN-1385 — pane input latency probe: the conviction instrument.
//
// Measures the USER-FELT path end to end against a REAL warden server + REAL
// local tmux, under escalating load, and reports per-hop attribution by
// combining the two measurement halves:
//
//   client leg  — keystroke sent → THAT pane's next frame (the e2e the user
//                 feels; measured in THIS process, the renderer's stand-in).
//                 Frames are counted PER PANE: under many-panes/streaming
//                 load, another pane's output must never resolve the wait —
//                 a global frame count degenerates to the poll floor there
//                 (it measures nothing about the typed pane).
//                 Caveat, disclosed: when the TYPED pane itself streams
//                 (stream-same / flood-same), its next frame may be the
//                 stream's own output, so those readings are a lower bound
//                 (the production sampler's latest-wins correlation shares
//                 this property). The cross-pane scenarios — the workload
//                 the ticket names — measure the true echo.
//   server legs — write (WS→pty.write) + round-trip (pty.write→next frame)
//                 from GET /api/diagnostics/pane-latency (the producer window)
//
// The difference e2e − server round-trip is the WS relay + renderer delivery —
// exactly the attribution the ticket asks for (input write / tmux round trip /
// WS delivery / renderer paint is completed by the shipped in-app sampler).
//
// SCENARIOS (the user's real workload, compressed):
//   idle            1 pane, type 40 keystrokes
//   stream-same     1 pane + a flooding stream IN THE TYPED PANE
//   many-panes      8 attached panes, 3 streaming hard, type into pane 0
//   monitor-storm   many-panes + the 2s pane-monitor tick for all 8 (big
//                   snapshot JSON sharing the keystroke socket)
//
// Usage: node scripts/pane-latency-probe.mjs
// The script forks itself as the server child (same-module pattern as the test
// suites), runs every scenario, and prints a summary table. Skips (with an
// honest message) when tmux is absent.

import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = path.join(__dirname, '..', 'src', 'server.js');

const tmuxPresent = (() => {
  try { execFileSync('tmux', ['-V'], { stdio: ['ignore', 'ignore', 'ignore'] }); return true; } catch { return false; }
})();
if (!tmuxPresent) {
  console.error('tmux not installed — the probe needs a real pane to type into.');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Child mode: boot the server with a throwaway HOME + one bash tmux session.
// ---------------------------------------------------------------------------
if (process.env.PANE_PROBE_SERVER === '1') {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-probe-'));
  const wardenDir = path.join(tempHome, '.yatfa-warden');
  fs.mkdirSync(wardenDir, { recursive: true });
  fs.writeFileSync(path.join(wardenDir, 'config.json'), JSON.stringify({
    hosts: [],
    // The producer must RECORD for the endpoint legs to exist.
    telemetryOperationalMetricsEnabled: true,
  }));
  fs.writeFileSync(path.join(wardenDir, 'chats.json'), JSON.stringify(
    Array.from({ length: 8 }, (_, i) => ({
      kind: 'tmux', host: '(local)', session: `probe-${i}`, name: `probe pane ${i}`, cwd: '', cmd: 'bash',
    })),
  ));
  // The declared sessions must EXIST before a pane can attach (the attach path
  // probes liveness first and reports session_dead otherwise).
  for (let i = 0; i < 8; i += 1) {
    try { execFileSync('tmux', ['kill-session', '-t', `probe-${i}`], { stdio: 'ignore' }); } catch { /* noop */ }
    execFileSync('tmux', ['new-session', '-d', '-s', `probe-${i}`, 'bash'], { stdio: 'ignore' });
  }
  process.env.HOME = tempHome;
  process.on('exit', () => {
    for (let i = 0; i < 8; i += 1) { try { execFileSync('tmux', ['kill-session', '-t', `probe-${i}`], { stdio: 'ignore' }); } catch { /* noop */ } }
    try { fs.rmSync(tempHome, { recursive: true, force: true }); } catch { /* noop */ }
  });
  const { startServer, server } = await import(SERVER_PATH);
  startServer(0, '127.0.0.1');
  // startServer's banner prints the REQUESTED port (0) — announce the REAL one.
  const port = await new Promise((resolve, reject) => {
    const t0 = Date.now();
    const poll = () => {
      const a = server.address();
      if (a && typeof a === 'object' && a.port) resolve(a.port);
      else if (Date.now() - t0 > 15000) reject(new Error('server child never listened'));
      else setTimeout(poll, 50);
    };
    poll();
  });
  console.log(`PANE_PROBE_PORT=${port}`);
  await new Promise(() => {}); // serve until the parent kills us
}

// ---------------------------------------------------------------------------
// Parent mode: fork the server child, drive the scenarios, print the table.
// ---------------------------------------------------------------------------

const pct = (values, p) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
};

function connect(url) {
  const ws = new WebSocket(url);
  const state = { framesByPane: Object.create(null) };
  // Per-pane frame accounting + a 2ms poll: the wait must resolve on the
  // TYPED pane's frame only, and the poll floor must sit far under the
  // ~50ms perception floor so it cannot mask the signal it exists to see.
  const waitPaneFrames = async (paneId, minCount, timeoutMs = 8000) => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if ((state.framesByPane[paneId] || 0) >= minCount) return;
      await new Promise((r) => setTimeout(r, 2));
    }
    throw new Error(`timed out waiting for frame ${minCount} of pane ${paneId} (got ${state.framesByPane[paneId] || 0})`);
  };
  const opened = new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw.toString()); } catch { return; }
    if (m.type === 'pty') state.framesByPane[m.id] = (state.framesByPane[m.id] || 0) + 1;
    const cb = state.waiting?.get(m.type);
    if (cb) { state.waiting.delete(m.type); cb(m); }
  });
  state.waiting = new Map();
  const once = (type, timeoutMs = 8000) => new Promise((resolve, reject) => {
    const t = setTimeout(() => { state.waiting.delete(type); reject(new Error(`timeout waiting ${type}`)); }, timeoutMs);
    state.waiting.set(type, (m) => { clearTimeout(t); resolve(m); });
  });
  const send = (obj) => ws.send(JSON.stringify(obj));
  return { ws, opened, send, once, waitPaneFrames, state };
}

// Type ONE keystroke and time it until THAT pane's next frame arrives.
async function typeOnce(c, id) {
  const before = c.state.framesByPane[id] || 0;
  const t0 = performance.now();
  c.send({ type: 'input', id, data: 'x' });
  await c.waitPaneFrames(id, before + 1);
  return performance.now() - t0;
}

function stats(values) {
  return { n: values.length, p50: pct(values, 50), p95: pct(values, 95), max: pct(values, 100) };
}
const fmt = (s) => s.n === 0 ? '  (none)' :
  `n=${String(s.n).padStart(3)}  p50=${s.p50.toFixed(1).padStart(7)}ms  p95=${s.p95.toFixed(1).padStart(7)}ms  max=${s.max.toFixed(1).padStart(8)}ms`;

async function attach(c, id) {
  c.send({ type: 'attach', id, cols: 100, rows: 30 });
  await c.once('attached');
}

async function startStream(c, id, rateMs) {
  // A flooding producer INSIDE the pane — the streaming-agent stand-in.
  c.send({ type: 'input', id, data: `while true; do echo probe-stream-$(date +%s%N); sleep ${rateMs}; done\r` });
  await new Promise((r) => setTimeout(r, 500));
}

async function fetchEndpoint(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/diagnostics/pane-latency`);
    return await res.json();
  } catch { return null; }
}

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-probe-parent-'));
process.on('exit', () => { try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* noop */ } });

// Boot the server child.
const child = spawn(process.execPath, [import.meta.filename], {
  env: { ...process.env, PANE_PROBE_SERVER: '1', PORT: '0' },
  stdio: ['ignore', 'pipe', 'inherit'],
});
const port = await new Promise((resolve, reject) => {
  let buf = '';
  const t = setTimeout(() => reject(new Error('server child did not announce a port')), 20000);
  child.stdout.on('data', (d) => {
    buf += d.toString();
    const m = buf.match(/PANE_PROBE_PORT=(\d+)/);
    if (m) { clearTimeout(t); resolve(Number(m[1])); }
  });
});
child.on('exit', (code) => { if (code && code !== 0) process.exit(code); });
console.log(`server up on 127.0.0.1:${port}`);

const LOCAL = '(local)';
const ids = Array.from({ length: 8 }, (_, i) => `${LOCAL}:probe-${i}`);
const KEYS = 40;

async function runScenario(name, setup, typeId) {
  const c = connect(`ws://127.0.0.1:${port}/api/stream`);
  await c.opened;
  try {
    const sample = await setup(c);
    // Warm-up attach repaint settled; type KEYS keystrokes, 120ms apart.
    const samples = [];
    for (let i = 0; i < KEYS; i += 1) {
      samples.push(await typeOnce(c, typeId));
      await new Promise((r) => setTimeout(r, 120));
    }
    sample();
    console.log(`\n== ${name} ==`);
    console.log('  e2e (client)   ', fmt(stats(samples)));
    return stats(samples);
  } finally {
    c.ws.close();
  }
}

// Scenario setups return a teardown.
const idleSetup = async (c) => {
  await attach(c, ids[0]);
  await new Promise((r) => setTimeout(r, 400));
  return () => {};
};

const streamSameSetup = async (c) => {
  await attach(c, ids[0]);
  await startStream(c, ids[0], 0.005);
  return async () => { c.send({ type: 'input', id: ids[0], data: '\u0003' }); };
};

const manyPanesSetup = async (c) => {
  for (const id of ids) await attach(c, id);
  for (const id of [ids[1], ids[2], ids[3]]) await startStream(c, id, 0.004);
  return async () => { for (const id of [ids[1], ids[2], ids[3]]) c.send({ type: 'input', id, data: '\u0003' }); };
};

// A SUSTAINED high-volume flood — `seq 1 50000` in a loop for `secs` seconds.
// This is the streaming-agent stand-in at full rate (megabytes of output per
// second through the pane pty), the load the user's three agents produce.
const floodSetup = (secs) => async (c) => {
  for (const id of ids) await attach(c, id);
  c.send({ type: 'input', id: ids[1], data: `timeout ${secs} bash -c 'while true; do seq 1 50000; done'\r` });
  c.send({ type: 'input', id: ids[2], data: `timeout ${secs} bash -c 'while true; do seq 1 50000; done'\r` });
  c.send({ type: 'input', id: ids[3], data: `timeout ${secs} bash -c 'while true; do seq 1 50000; done'\r` });
  await new Promise((r) => setTimeout(r, 800));
  return async () => { /* floods are time-bounded by `timeout` */ };
};

const monitorStormSetup = async (c) => {
  const teardown = await manyPanesSetup(c);
  // The 2s monitor tick for all 8 panes: capturePanes → big snapshot JSON on
  // the SAME socket the keystrokes ride.
  for (const id of ids) c.send({ type: 'monitor', id });
  await new Promise((r) => setTimeout(r, 4500)); // ≥2 monitor ticks
  return async () => { for (const id of ids) c.send({ type: 'unmonitor', id }); await teardown(); };
};

console.log('\nPane input latency probe — WARDEN-1385');
console.log('======================================');

await runScenario('idle (1 pane, quiet)', idleSetup, ids[0]);

await runScenario('stream-same (typing INTO a streaming pane)',
  streamSameSetup, ids[0]);

await runScenario('many-panes (8 attached, 3 streaming)',
  manyPanesSetup, ids[0]);

await runScenario('flood (3 panes at full output rate, type into a quiet pane)',
  floodSetup(14), ids[0]);

await runScenario('flood-same (type INTO a pane at full output rate)',
  floodSetup(14), ids[1]);

await runScenario('monitor-storm (many-panes + 2s snapshots on the same socket)',
  monitorStormSetup, ids[0]);

// Server legs for the whole run (the producer window is cumulative until flush).
const endpoint = await fetchEndpoint(port);
if (endpoint) {
  console.log('\n== server legs (whole-run producer window) ==');
  for (const op of endpoint.window.operations) {
    console.log(`  ${op.operation.padEnd(22)} n=${String(op.count).padStart(4)}  p-boundaries=${JSON.stringify(op.buckets)}  avg=${op.avg.toFixed(2)}ms  max=${op.max.toFixed(1)}ms`);
  }
  console.log(`  boundaries=${JSON.stringify(endpoint.window.boundaries)}`);
} else {
  console.log('\n(server endpoint unavailable — legs not fetched)');
}

child.kill('SIGTERM');
console.log('\nprobe complete');
process.exit(0);
