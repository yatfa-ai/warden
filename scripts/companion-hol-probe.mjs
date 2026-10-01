#!/usr/bin/env node
// WARDEN-1491 — head-of-line probe for the companion's REQUEST loop.
//
// Question it answers: while a SLOW RPC is in flight on the channel (an `exec`
// that sleeps — the shape of a hung git / file-exists probe), how long does a
// keystroke's echo take? Against the pre-1491 serial loop the echo waits out
// the whole RPC (8s timeout + 2s WaitDelay = the recurring ~10s tail in
// production `pane-input-roundtrip`); against the dispatcher it is ~1ms.
//
//   node scripts/companion-hol-probe.mjs [binary] [slowMs]
//   (default binary: companion/dist/warden-companion-<platform>-<arch>; build
//    with `npm run companion:build`. Runs the companion locally over stdio —
//    no ssh, no host. Needs a unix host: it attaches `cat` under a host PTY.)
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const here = path.dirname(fileURLToPath(import.meta.url));
const plat = process.platform === 'darwin' ? 'darwin' : 'linux';
const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';
const bin = process.argv[2] || path.join(here, '..', 'companion', 'dist', `warden-companion-${plat}-${arch}`);
const slowMs = Number(process.argv[3] || 3000);
if (!fs.existsSync(bin)) { console.error(`companion binary not found: ${bin} (npm run companion:build)`); process.exit(2); }

const p = spawn(bin, [], { stdio: ['pipe', 'pipe', 'inherit'] });
let buf = '';
const waiters = [];
let id = 0;
const pend = new Map();
p.stdout.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.event === 'attachData') {
      const s = Buffer.from(m.data, 'base64').toString();
      for (const w of [...waiters]) if (w.re.test(s)) { waiters.splice(waiters.indexOf(w), 1); w.res(performance.now()); }
    } else if (m.id !== undefined && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
  }
});
const call = (method, params) => new Promise((res) => { const i = ++id; pend.set(i, res); p.stdin.write(JSON.stringify({ id: i, method, params }) + '\n'); });
const waitOut = (re) => new Promise((res) => waiters.push({ re, res }));
const b64 = (s) => Buffer.from(s).toString('base64');

const a = await call('attachStart', { script: 'cat', cols: 80, rows: 24 });
const sid = a.result.sid;
let t0 = performance.now();
const w1 = waitOut(/BASE/);
await call('attachInput', { sid, data: b64('BASE\n') });
const base = Math.round(await w1 - t0);

const slow = call('exec', { script: `sleep ${slowMs / 1000}`, timeoutMs: 8000 });
await new Promise((r) => setTimeout(r, 100));
t0 = performance.now();
const w2 = waitOut(/BLOCKED/);
await call('attachInput', { sid, data: b64('BLOCKED\n') });
const blocked = Math.round(await w2 - t0);
await slow;
p.kill();

console.log(`idle echo:                     ${base} ms`);
console.log(`echo while a ${slowMs}ms exec runs:  ${blocked} ms`);
const bad = blocked > slowMs / 2;
console.log(bad ? 'FAIL — the request loop is head-of-line blocked' : 'OK — keystrokes are not queued behind slow RPCs');
process.exit(bad ? 1 : 0);
