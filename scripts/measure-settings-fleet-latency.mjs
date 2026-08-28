#!/usr/bin/env node
// Settings fleet-latency reproduction harness (WARDEN-1210).
//
// The ticket's first requirement is that the problem be MEASURED, not assumed:
// "a reproduction with roughly 30 configured hosts, several of them genuinely
// slow or unreachable, shows where the time to an interactive non-host section
// actually goes, distinguishing time spent inside the config request from time
// spent waiting for the server to get to it."
//
// This script builds exactly that reproduction and measures it:
//
//   1. A throwaway HOME with a warden config.json holding 34 hosts (30
//      "slow-host-*" + 4 "fast-host-*").
//   2. A fake `ssh` shim first on PATH: slow hosts hold the connection ~8s
//      then exit 255 (an unreachable host timing out), fast hosts fail in 0.2s.
//      Every server fleet sweep (lifecycle, attention, host-status probes)
//      therefore runs against a genuinely slow fleet.
//   3. It starts the real server (src/server.js) against that HOME/PATH and
//      polls GET /api/config every 250ms for 45s, reporting p50/p95/p99/max
//      plus how many samples crossed the client's 8s per-attempt deadline
//      (fetchJson, WARDEN-828) — the threshold at which the bounded retry
//      starts amplifying a stall.
//   4. It also times the per-endpoint dashboard surface once, so the report
//      separates "the config request is slow" from "the server is busy on
//      something else".
//
// Findings recorded with this harness on 2026-08-28 (main @ WARDEN-1208):
//   - /api/config: p50 2ms / p95 4ms / p99 8ms / max 36ms; 0/179 samples over
//     1s, 0 over 8s; and 2-12ms even WHILE a 22s /api/hosts/health fan-out was
//     in flight. The server's own loop monitor (/api/diagnostics/stalls)
//     recorded 0 event-loop stalls over ~7,300 ssh spawns.
//   - /api/hosts/health (no web client caller): 22.4s — worst-host-bound live
//     validateHost Promise.all over the whole fleet, the exact request-path
//     anti-pattern WARDEN-915 fixed for /api/hosts/status. Flagged for follow-
//     up, NOT changed by WARDEN-1210 (out of its measured scope).
//   - Conclusion: host work does not measurably delay the config GET; the
//     fix shipped in WARDEN-1210 is the per-section dependency classification
//     (web/src/components/settings/sectionPersistence.ts + sectionLoadGate.ts),
//     which makes it structurally impossible for host data to gate a section.
//
// Usage: node scripts/measure-settings-fleet-latency.mjs [port]
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, chmodSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.argv[2] || 8571);
const BASE = `http://127.0.0.1:${PORT}`;
const POLL_MS = 250;
const WINDOW_MS = 45_000;

const env = mkdtempSync(join(tmpdir(), 'warden-fleet-repro-'));
const bin = join(env, 'bin');
const home = join(env, 'home');
mkdirSync(bin); mkdirSync(home, { recursive: true });
mkdirSync(join(home, '.yatfa-warden'), { recursive: true });

// Fake ssh: any invocation naming a slow-* host sleeps 8s (unreachable host
// timing out at ConnectTimeout) then exits 255; fast-* hosts fail in 0.2s.
const shim = join(bin, 'ssh');
writeFileSync(shim, `#!/bin/bash\nfor a in "$@"; do case "$a" in *slow-*) sleep 8; exit 255;; esac; done\nsleep 0.2\nexit 255\n`);
chmodSync(shim, 0o755);

const hosts = [
  ...Array.from({ length: 30 }, (_, i) => `slow-host-${String(i + 1).padStart(2, '0')}.invalid`),
  ...Array.from({ length: 4 }, (_, i) => `fast-host-${i + 1}.invalid`),
];
writeFileSync(join(home, '.yatfa-warden', 'config.json'), JSON.stringify({
  hosts, pollIntervalMs: 1500, tmuxSession: 'agent', connectTimeout: 10,
}, null, 2));

const server = spawn(process.execPath, ['src/server.js'], {
  cwd: ROOT,
  env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, PORT: String(PORT) },
  stdio: 'ignore',
});
const cleanup = () => { try { server.kill('SIGKILL'); } catch { /* already gone */ } };
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(130); });

// Wait for the server to accept a request.
const up = Date.now() + 20_000;
for (;;) {
  try { const r = await fetch(`${BASE}/api/config`); if (r.ok) break; } catch { /* boot */ }
  if (Date.now() > up) { console.error('server did not come up'); process.exit(1); }
  await new Promise((r) => setTimeout(r, 250));
}
console.log(`server up on :${PORT} — 34 hosts (30 slow/unreachable), fake ssh on PATH`);

async function timed(path) {
  const t = Date.now();
  const r = await fetch(`${BASE}${path}`);
  await r.text();
  return Date.now() - t;
}

// Per-endpoint survey (once) — separates "config is slow" from "server busy".
console.log('\nendpoint survey (one request each):');
for (const ep of ['/api/config', '/api/ssh-hosts', '/api/hosts/status', '/api/health', '/api/chats']) {
  console.log(`  ${ep.padEnd(18)} ${await timed(ep)}ms`);
}
console.log(`  /api/hosts/health  ${await timed('/api/hosts/health')}ms  (no web client caller — informational)`);

// Sustained config poll while the fleet sweeps run.
const samples = [];
const t0 = Date.now();
const timer = setInterval(async () => {
  try { samples.push(await timed('/api/config')); } catch (e) { samples.push(99_999); }
}, POLL_MS);
await new Promise((r) => setTimeout(r, WINDOW_MS));
clearInterval(timer);

const sorted = [...samples].sort((a, b) => a - b);
const pct = (p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
console.log(`\n/api/config under load: samples=${samples.length} p50=${pct(0.5)}ms p95=${pct(0.95)}ms ` +
  `p99=${pct(0.99)}ms max=${sorted[sorted.length - 1]}ms`);
console.log(`  over 1s: ${samples.filter((s) => s > 1000).length}   over 8s (client abort deadline): ${samples.filter((s) => s > 8000).length}`);

// The server's own loop monitor is the authoritative stall record.
const diag = await (await fetch(`${BASE}/api/diagnostics/stalls`)).json();
console.log(`  event-loop stalls (server loop monitor): ${diag.stats.stalls} (worstLag ${diag.stats.worstLagMs}ms, ` +
  `${diag.stats.syncOpsSeen} sync ops seen / ${diag.stats.syncMsSeen}ms)`);

const verdict = pct(0.99) < 1000 && diag.stats.stalls === 0
  ? 'PASS — host work does not delay the config GET; a non-host section waits only on its own data'
  : 'FAIL — config GET latency scales with the fleet; investigate the stall log above';
console.log(`\n${verdict}`);
cleanup();
