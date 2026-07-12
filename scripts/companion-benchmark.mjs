#!/usr/bin/env node
// companion-benchmark — the ssh-spawn / handshake-count counter + ControlMaster-
// disabled replay that defines "done" for the companion-transport roadmap
// (WARDEN-272, slice 1 of WARDEN-270).
//
// It measures the REAL win this slice ships: collapsing the per-op SSH handshake
// across the polling cadence. discover() already sends one DISCOVER_SCRIPT per
// host per tick over a single ssh session (O(hosts) spawns/tick, not
// O(hosts×containers)) — but each of those spawns pays a full SSH handshake. A
// persistent companion channel pays the handshake ONCE at bootstrap, then zero
// per tick. On the ControlMaster-disabled / Windows path (warden's win32
// getConnection returns socketPath:null → a fresh ssh handshake every op) that is
// the difference between ~seconds and near-instant per discover tick.
//
// WARDEN-276 (slice 2) adds a capture-pane leg: capture-pane is the HIGHEST-
// frequency remote op (it fires on every observer poll — summarizeOpenChats,
// readChats, suggestNextActions, alertChangedAgents — PLUS the 2s monitor tick),
// so the same handshake collapse compounds at a much higher cadence than
// discover. capturePanes() already batches every pane into ONE runWithPool ssh
// spawn per host per tick (O(hosts), not O(hosts×panes)); the companion win is
// still purely the per-tick handshake elimination, now across the busier polling
// surface. Both legs are reported below.
//
// Two parts:
//   Part 1 (always):  a deterministic spawn/handshake-count projection per tick —
//                     the roadmap's success measure, with no host required.
//                     Covers BOTH discover and capture-pane (slice 2).
//   Part 2 (--host):  a LIVE replay against a real host. The default side runs
//                     ops on the ControlMaster-disabled path (the Windows-
//                     equivalent, one handshake per tick); the companion side
//                     runs the real src/companion.js (bootstrap once, then RPC
//                     over the one channel). Reports real spawn counts + the
//                     before/after per-tick wall-clock cost, for discover AND
//                     capture-pane.
//
// Usage:
//   node scripts/companion-benchmark.mjs                       # Part 1 only
//   node scripts/companion-benchmark.mjs --host user@box       # Part 1 + live Part 2
//   node scripts/companion-benchmark.mjs --host user@box --ticks 8 --hosts 3

import { spawn } from 'node:child_process';
import { SSH_BASE_OPTS, SSH_BIN, shellQuote, run as sshRun } from '../src/ssh.js';
import {
  discover as companionDiscover,
  capturePanes as companionCapturePanes,
  _resetChannelCacheForTests,
  projectSpawnModel,
} from '../src/companion.js';
import { DISCOVER_SCRIPT, buildCaptureScript } from '../src/chats.js';

// --------------------------------- args -------------------------------------

function parseArgs(argv) {
  const out = { host: null, ticks: 5, hosts: 3 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if ((a === '--host' || a === '-H') && argv[i + 1]) { out.host = argv[++i]; }
    else if (a === '--ticks' && argv[i + 1]) { out.ticks = Math.max(1, parseInt(argv[++i], 10) || 5); }
    else if (a === '--hosts' && argv[i + 1]) { out.hosts = Math.max(1, parseInt(argv[++i], 10) || 3); }
    else if (a === '--help' || a === '-h') {
      out.help = true;
    }
  }
  return out;
}

const HELP = `companion-benchmark — ssh-spawn/handshake counter + ControlMaster-disabled replay

Usage:
  node scripts/companion-benchmark.mjs [options]

Options:
  --host <host>     SSH host for the live Part 2 replay (e.g. user@10.0.0.5).
                    Omit to run the deterministic Part 1 projection only.
  --ticks <n>       Discover ticks to simulate/measure (default 5).
  --hosts <h>       Hosts to simulate in Part 1 (default 3).
  -h, --help        Show this help.

What it proves:
  The companion transport collapses the per-op SSH handshake. On the default
  (ControlMaster-disabled / Windows) path every discover tick pays a full
  handshake per host; the companion pays it once at bootstrap, then zero/tick.`;

// ----------------------------- Part 1: model --------------------------------

// How often capture-pane actually fires in warden — used to size the capture-pane
// leg at its real (busy) polling cadence. The monitor ticks every 2s; the observer
// polls on readChats/summarizeOpenChats/suggestNextActions/alertChangedAgents.
const MONITOR_TICK_MS = 2000;
const CAPTURE_TICKS_PER_MIN = Math.round(60_000 / MONITOR_TICK_MS); // 30/min (monitor alone)

function printProjection(hosts, ticks) {
  const m = projectSpawnModel({ hosts, ticks });
  const steadyTicks = Math.max(0, ticks - 1); // ticks after the first (bootstrap) one

  console.log('━'.repeat(72));
  console.log(`Part 1.a — discover: handshake projection  (${hosts} host(s), ${ticks} tick(s))`);
  console.log('━'.repeat(72));
  console.log('Each discover tick fans out one ssh op per host. The model counts ssh');
  console.log('spawns (= handshakes on the ControlMaster-disabled / Windows path):');
  console.log();
  console.log('  DEFAULT path (runWithPool, no companion):');
  console.log(`    1 handshake / host / tick  →  ${hosts} × ${ticks} = ${m.before.totalSpawns} handshakes`);
  console.log('  COMPANION path:');
  console.log(`    bootstrap once/host: probe + upload + channel = 3 spawns × ${hosts} = ${m.after.bootstrap}`);
  console.log(`    then 0 / tick for the remaining ${steadyTicks} steady tick(s)`);
  console.log(`    total = ${m.after.totalSpawns} handshakes`);
  console.log();
  const delta = m.before.totalSpawns - m.after.totalSpawns;
  console.log(`  ▶ handshakes saved over ${ticks} ticks: ${m.before.totalSpawns} → ${m.after.totalSpawns}  (−${delta})`);
  if (ticks > 0) {
    const winTicks = m.after.bootstrap / hosts; // ticks until companion breaks even (3/host)
    console.log(`  ▶ companion breaks even after ~${Math.ceil(winTicks)} tick(s)/host, then every further tick is free.`);
  }
  console.log();
  console.log('discover fires on the 60s lifecycle poll + 2s monitor + refreshes.');
  console.log();
}

// Slice 2 (WARDEN-276): the capture-pane leg. capturePanes() ALREADY batches every
// pane into ONE runWithPool ssh spawn per host per tick (O(hosts), not O(panes)),
// so — like discover — the companion win is purely the per-tick handshake
// elimination, NOT a spawn-count reduction. The difference is CADENCE: capture-pane
// fires on every observer poll PLUS the 2s monitor tick, so the handshake savings
// compound far faster than discover's. This projection sizes that at the real rate.
function printCaptureProjection(hosts, ticks) {
  const m = projectSpawnModel({ hosts, ticks });
  console.log('━'.repeat(72));
  console.log(`Part 1.b — capture-pane: handshake projection  (${hosts} host(s), ${ticks} tick(s))`);
  console.log('━'.repeat(72));
  console.log('capture-pane is the highest-frequency remote op: it fires on EVERY');
  console.log('observer poll (summarizeOpenChats/readChats/suggestNextActions/');
  console.log('alertChangedAgents) PLUS the 2s monitor tick. capturePanes() already');
  console.log('batches all panes/host into ONE ssh spawn (O(hosts)/tick, not O(panes)),');
  console.log('so the companion win is the per-tick HANDSHAKE, not a spawn reduction:');
  console.log();
  console.log('  DEFAULT path (runWithPool, no companion):');
  console.log(`    1 handshake / host / tick  →  ${hosts} × ${ticks} = ${m.before.totalSpawns} handshakes`);
  console.log('  COMPANION path:');
  console.log(`    reuses slice 1's bootstrapped channel — 0 handshakes/tick`);
  console.log(`    (bootstrap cost was paid by discover; capture-pane rides the same channel)`);
  console.log(`    total = ${m.after.totalSpawns} handshakes (all bootstrap, 0 capture)`);
  console.log();
  const delta = m.before.totalSpawns - m.after.totalSpawns;
  console.log(`  ▶ handshakes saved over ${ticks} capture ticks: ${m.before.totalSpawns} → ${m.after.totalSpawns}  (−${delta})`);
  // Size the win at the real monitor cadence (30 ticks/min) over a minute.
  const perMin = projectSpawnModel({ hosts, ticks: CAPTURE_TICKS_PER_MIN });
  console.log(`  ▶ at the 2s monitor rate (${CAPTURE_TICKS_PER_MIN} ticks/min), ${hosts} host(s) save`);
  console.log(`    ${perMin.before.totalSpawns} → ${perMin.after.totalSpawns} handshakes/min  (−${perMin.savedSpawns}/min from capture-pane alone)`);
  console.log();
  console.log('This is the roadmap\'s "polling-tick" success-metric leg: per-tick');
  console.log('handshake collapse on the busiest remote op.');
  console.log();
}

// ---------------------- Part 2: live ControlMaster-off replay ----------------

// One ssh op with ControlMaster explicitly DISABLED — the Windows-equivalent
// path (warden's win32 getConnection returns socketPath:null → a fresh ssh
// process + handshake every call). This is the genuine shipped default on win32.
// `spawnCount` is incremented once per real ssh spawn.
function sshRunNoMaster(host, cmd, timeout, spawnCount) {
  const args = [
    ...SSH_BASE_OPTS,
    '-o', 'ControlMaster=no',
    '-o', 'ControlPath=none',
    '-o', `ConnectTimeout=10`,
    host, `bash -lc ${shellQuote(cmd)}`,
  ];
  return new Promise((resolve) => {
    const child = spawn(SSH_BIN, args, { windowsHide: true });
    spawnCount.val++;
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, ms: 0, stderr: String(e) }); });
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, ms: 0, stdout, stderr }); // ms filled by caller
    });
  });
}

async function timed(promiseFactory) {
  const t0 = process.hrtime.bigint();
  const r = await promiseFactory();
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  return { ...r, ms };
}

function summarize(samples) {
  const vals = samples.map((s) => s.ms).sort((a, b) => a - b);
  const sum = vals.reduce((a, b) => a + b, 0);
  const avg = vals.length ? sum / vals.length : 0;
  const p95 = vals.length ? vals[Math.min(vals.length - 1, Math.floor(vals.length * 0.95))] : 0;
  return { n: vals.length, avg, p95, min: vals[0] || 0, max: vals[vals.length - 1] || 0 };
}

async function liveDiscoverBenchmark(host, ticks) {
  console.log('━'.repeat(72));
  console.log(`Part 2.a — discover: LIVE ControlMaster-disabled replay  (host: ${host}, ${ticks} tick(s))`);
  console.log('━'.repeat(72));
  console.log('Default side: one fresh ssh handshake per discover tick (ControlMaster off).');
  console.log('Companion side: real src/companion.js — bootstrap once, then RPC over one channel.');
  console.log();

  const defaultSpawns = { val: 0 };
  const companionSpawns = { val: 0 };
  const countingSpawn = (...a) => { companionSpawns.val++; return spawn(...a); };
  // The bootstrap PROBE runs through ssh.js `run()`, which spawns its own ssh
  // process internally (independent of the `spawn` above). Without wrapping it,
  // the probe's handshake is invisible to the counter and the live replay
  // undercounts bootstrap spawns (reports 2 instead of the model's 3: probe +
  // upload + channel). Inject a counting `run` so all three bootstrap legs are
  // counted and the live Part 2 agrees with the Part 1 projection. (WARDEN-272
  // review #2.)
  const countingRun = (...a) => { companionSpawns.val++; return sshRun(...a); };
  const companionDeps = { spawn: countingSpawn, run: countingRun };

  // ---- DEFAULT: N ticks, each a ControlMaster-disabled ssh discover ----
  console.log(`▶ default path: ${ticks} discover tick(s), handshake each …`);
  const defaultSamples = [];
  for (let i = 0; i < ticks; i++) {
    const r = await timed(() => sshRunNoMaster(host, DISCOVER_SCRIPT, 60000, defaultSpawns));
    defaultSamples.push(r);
    process.stdout.write(`   tick ${i + 1}/${ticks}: ${r.ms.toFixed(0).padStart(6)} ms  ${r.ok ? 'ok' : 'cmd-failed (handshake still measured)'}\n`);
  }

  // ---- COMPANION: bootstrap once, then N ticks over the channel ----
  console.log(`▶ companion path: bootstrap + ${ticks} discover tick(s) over the channel …`);
  _resetChannelCacheForTests();
  const bootR = await timed(() =>
    companionDiscover(host, { connectTimeout: 10 }, { timeout: 60000 }, companionDeps));
  // First call bootstraps (probe + upload + channel) AND does a discover.
  console.log(`   bootstrap + 1st discover: ${bootR.ms.toFixed(0).padStart(6)} ms  ${bootR.ok ? 'ok' : `error: ${(bootR.error || '').slice(0, 80)}`}`);
  const companionSamples = [{ ms: bootR.ms, ok: bootR.ok }];
  for (let i = 1; i < ticks; i++) {
    const r = await timed(() =>
      companionDiscover(host, { connectTimeout: 10 }, { timeout: 60000 }, companionDeps));
    companionSamples.push(r);
    process.stdout.write(`   tick ${i + 1}/${ticks}: ${r.ms.toFixed(0).padStart(6)} ms  ${r.ok ? 'ok' : `error: ${(r.error || '').slice(0, 80)}`}\n`);
  }
  _resetChannelCacheForTests();

  // ---- report ----
  const def = summarize(defaultSamples);
  // For the companion, separate the bootstrap-bundled first tick from steady state.
  const steady = summarize(companionSamples.slice(1));

  console.log();
  console.log('── results ──────────────────────────────────────────────────────');
  console.log(`  spawns (ssh processes started):`);
  console.log(`     default   : ${defaultSpawns.val}  (≈ ${ticks} handshakes — one per tick)`);
  console.log(`     companion : ${companionSpawns.val}  (bootstrap: probe+upload+channel, then 0/tick)`);
  console.log(`  per-tick wall-clock (handshake + remote work):`);
  console.log(`     default   : avg ${def.avg.toFixed(0)} ms  (p95 ${def.p95.toFixed(0)} ms) over ${def.n}`);
  if (steady.n > 0) {
    console.log(`     companion : avg ${steady.avg.toFixed(0)} ms  (p95 ${steady.p95.toFixed(0)} ms) over ${steady.n} steady tick(s)`);
    const saved = def.avg - steady.avg;
    console.log(`  ▶ handshake cost eliminated per tick: ~${Math.max(0, saved).toFixed(0)} ms  (default avg − companion steady avg)`);
  }
  console.log('────────────────────────────────────────────────────────────────');
  console.log('Note: the default per-tick time includes one full SSH handshake every');
  console.log('tick; the companion pays that only at bootstrap. The gap above IS the');
  console.log('per-op handshake win (the roadmap’s success measure).');
  console.log();
}

// Slice 2 (WARDEN-276): the capture-pane live leg. Same shape as the discover
// leg — default side runs the batched capture script via a fresh
// ControlMaster-disabled ssh per tick; companion side runs the real
// capturePanes RPC over the persistent channel (0 handshakes/tick). The pane list
// is discovered once up front (default path) so both sides capture the same
// panes; if the host has no discoverable panes the leg is skipped gracefully.
async function liveCaptureBenchmark(host, ticks) {
  console.log('━'.repeat(72));
  console.log(`Part 2.b — capture-pane: LIVE ControlMaster-disabled replay  (host: ${host}, ${ticks} tick(s))`);
  console.log('━'.repeat(72));
  console.log('Default side: one fresh ssh handshake per capture tick (ControlMaster off).');
  console.log('Companion side: capturePanes RPC over slice 1\'s channel — 0 handshakes/tick.');
  console.log();

  // Discover the host once (default path) to get the pane list both sides capture.
  const probe = await sshRunNoMaster(host, DISCOVER_SCRIPT, 60000, { val: 0 });
  const chats = chatsFromDiscoverStdout(host, probe.stdout);
  if (!chats.length) {
    console.log(`(no discoverable yatfa chats on ${host} — capture-pane leg skipped; discover leg above still valid.)\n`);
    return;
  }
  console.log(`discovered ${chats.length} pane(s) to capture: ${chats.map((c) => c.key).slice(0, 6).join(', ')}${chats.length > 6 ? ' …' : ''}`);
  const captureScript = buildCaptureScript(chats);
  console.log();

  const defaultSpawns = { val: 0 };
  const companionSpawns = { val: 0 };
  const countingSpawn = (...a) => { companionSpawns.val++; return spawn(...a); };

  // ---- DEFAULT: N ticks, each a ControlMaster-disabled ssh capture batch ----
  console.log(`▶ default path: ${ticks} capture tick(s), handshake each …`);
  const defaultSamples = [];
  for (let i = 0; i < ticks; i++) {
    const r = await timed(() => sshRunNoMaster(host, captureScript, 30000, defaultSpawns));
    defaultSamples.push(r);
    const panes = countSentinels(r.stdout);
    process.stdout.write(`   tick ${i + 1}/${ticks}: ${r.ms.toFixed(0).padStart(6)} ms  ${r.ok ? `ok (${panes} pane(s))` : 'cmd-failed (handshake still measured)'}\n`);
  }

  // ---- COMPANION: bootstrap once, then N capture ticks over the channel ----
  console.log(`▶ companion path: bootstrap + ${ticks} capture tick(s) over the channel …`);
  _resetChannelCacheForTests();
  const bootR = await timed(() =>
    companionCapturePanes(host, chats, { connectTimeout: 10 }, { timeout: 30000 }, { spawn: countingSpawn }));
  console.log(`   bootstrap + 1st capture: ${bootR.ms.toFixed(0).padStart(6)} ms  ${bootR.ok ? `ok (${Object.keys(bootR.panes).length} pane(s))` : `error: ${(bootR.error || '').slice(0, 80)}`}`);
  const companionSamples = [{ ms: bootR.ms, ok: bootR.ok }];
  for (let i = 1; i < ticks; i++) {
    const r = await timed(() =>
      companionCapturePanes(host, chats, { connectTimeout: 10 }, { timeout: 30000 }, { spawn: countingSpawn }));
    companionSamples.push(r);
    process.stdout.write(`   tick ${i + 1}/${ticks}: ${r.ms.toFixed(0).padStart(6)} ms  ${r.ok ? `ok (${Object.keys(r.panes).length} pane(s))` : `error: ${(r.error || '').slice(0, 80)}`}\n`);
  }
  _resetChannelCacheForTests();

  // ---- report ----
  const def = summarize(defaultSamples);
  const steady = summarize(companionSamples.slice(1));

  console.log();
  console.log('── results ──────────────────────────────────────────────────────');
  console.log(`  spawns (ssh processes started):`);
  console.log(`     default   : ${defaultSpawns.val}  (≈ ${ticks} handshakes — one capture batch/tick)`);
  console.log(`     companion : ${companionSpawns.val}  (bootstrap only; capture rides the channel, 0/tick)`);
  console.log(`  per-tick wall-clock (handshake + remote work):`);
  console.log(`     default   : avg ${def.avg.toFixed(0)} ms  (p95 ${def.p95.toFixed(0)} ms) over ${def.n}`);
  if (steady.n > 0) {
    console.log(`     companion : avg ${steady.avg.toFixed(0)} ms  (p95 ${steady.p95.toFixed(0)} ms) over ${steady.n} steady tick(s)`);
    const saved = def.avg - steady.avg;
    console.log(`  ▶ handshake cost eliminated per capture tick: ~${Math.max(0, saved).toFixed(0)} ms`);
  }
  console.log('────────────────────────────────────────────────────────────────');
  console.log('Note: capture-pane fires on every observer poll + the 2s monitor tick,');
  console.log('so this per-tick handshake win compounds at the roadmap\'s busiest cadence.');
  console.log();
}

// Parse the default discover script's stdout into chat objects capturePanes can
// consume (key/container/session). The discover TSV is name \t status \t cwd \t
// active; only name (the container) is needed to target a capture. yatfa chats
// use session 'agent' (CLAUDE.md topology).
function chatsFromDiscoverStdout(host, stdout) {
  const chats = [];
  for (const line of (stdout || '').split('\n')) {
    const name = line.split('\t')[0];
    if (!name) continue;
    chats.push({ host, key: name, container: name, session: 'agent' });
  }
  return chats;
}

// Count how many ___B_<key>___ sentinel lines a capture batch returned — a cheap
// correctness signal that panes were actually captured (not just that ssh ok'd).
function countSentinels(stdout) {
  const m = (stdout || '').match(/^___B_.+___$/gm);
  return m ? m.length : 0;
}


// --------------------------------- main -------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(HELP); return; }

  console.log('warden companion-transport benchmark  (WARDEN-272 + WARDEN-276 / roadmap WARDEN-270)\n');

  // Part 1 always runs — deterministic, no host needed. Both the discover and
  // capture-pane handshake projections (the roadmap's success measure).
  printProjection(args.hosts, args.ticks);
  printCaptureProjection(args.hosts, args.ticks);

  if (!args.host) {
    console.log('Part 2 (live replay) skipped — pass --host <ssh-host> to measure the real');
    console.log('before/after per-op handshake cost on the ControlMaster-disabled path.');
    console.log('  e.g.  node scripts/companion-benchmark.mjs --host user@10.0.0.5 --ticks 8');
    console.log();
    return;
  }

  try {
    await liveDiscoverBenchmark(args.host, args.ticks);
    await liveCaptureBenchmark(args.host, args.ticks);
  } catch (e) {
    console.error(`\nbenchmark failed: ${e?.message ?? e}`);
    console.error('(is the host reachable over SSH with key auth? BatchMode=yes is used.)');
    process.exitCode = 1;
  }
}

main();
