// `npm start` entry point — runs warden as a normal foreground process in YOUR
// terminal (not tied to Claude). Builds the web frontend if missing/stale, then
// starts the node server and forwards Ctrl-C. Run me outside of Claude.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const webDir = path.join(root, 'web');
const distIndex = path.join(webDir, 'dist', 'index.html');
const npmBin = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const PORT = process.env.PORT || '7421';

function newestMtime(dir, base = 0) {
  let m = base;
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const p = path.join(dir, e.name);
      const st = fs.statSync(p);
      m = Math.max(m, e.isDirectory() ? newestMtime(p, st.mtimeMs) : st.mtimeMs);
    }
  } catch { /* noop */ }
  return m;
}

function distStale() {
  if (!fs.existsSync(distIndex)) return true;
  return newestMtime(path.join(webDir, 'src')) > fs.statSync(distIndex).mtimeMs;
}

if (distStale()) {
  console.log('warden: building web frontend…');
  const r = spawnSync(npmBin, ['run', 'build'], { cwd: webDir, stdio: 'inherit' });
  if (r.status !== 0) { console.error('warden: web build failed.'); process.exit(r.status ?? 1); }
}

if (!fs.existsSync(path.join(root, 'node_modules', 'express'))) {
  console.log('warden: installing backend deps…');
  const r = spawnSync(npmBin, ['install', '--omit=dev'], { cwd: root, stdio: 'inherit' });
  if (r.status !== 0) { console.error('warden: npm install failed.'); process.exit(r.status ?? 1); }
}

console.log(`warden: starting server on http://localhost:${PORT}  (Ctrl-C to stop)`);
const child = spawn(process.execPath, [path.join(root, 'src', 'server.js')], {
  stdio: 'inherit',
  env: process.env,
});
const stop = (sig) => () => { try { child.kill(sig); } catch { /* noop */ } };
process.on('SIGINT', stop('SIGINT'));
process.on('SIGTERM', stop('SIGTERM'));
process.on('SIGHUP', stop('SIGTERM'));
child.on('exit', (c) => process.exit(c ?? 0));
