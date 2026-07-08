// Yatfa Warden — Electron main process (CommonJS).
// Spawns the backend server (ESM) as a child process, then opens a window.
const { app, BrowserWindow } = require('electron');
const { fork, execSync } = require('child_process');
const path = require('path');
const http = require('http');

const PORT = parseInt(process.env.WARDEN_PORT || '7421', 10);
const HOST = '127.0.0.1';

let serverProcess = null;
let win = null;

// Kill anything occupying the port (stale server from a previous run)
function killStalePort() {
  try {
    const out = execSync(`netstat -ano | findstr ":${PORT} " | findstr LISTENING`, { encoding: 'utf8' });
    const pids = [...new Set(out.trim().split('\n').map(l => l.trim().split(/\s+/).pop()))];
    for (const pid of pids) {
      if (pid && pid !== '0') {
        try { execSync(`taskkill /F /PID ${pid}`, { stdio: 'ignore' }); } catch {}
      }
    }
  } catch { /* port is free */ }
}

function waitForServer(cb) {
  let attempts = 0;
  const tryConnect = () => {
    if (attempts++ > 50) { console.error('Server did not start in time'); return; }
    const req = http.get(`http://${HOST}:${PORT}/`, (res) => {
      if (res.statusCode === 200) cb();
      else setTimeout(tryConnect, 200);
      res.destroy();
    });
    req.on('error', () => setTimeout(tryConnect, 200));
    req.setTimeout(1000, () => { req.destroy(); setTimeout(tryConnect, 200); });
  };
  tryConnect();
}

function createWindow() {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'Yatfa Warden',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.webContents.session.clearCache().then(() => {
    win.loadURL(`http://${HOST}:${PORT}/?_t=${Date.now()}`);
  });
  win.on('closed', () => { win = null; });
}

app.whenReady().then(() => {
  // Kill any stale server from a previous run
  killStalePort();

  // Start the backend (ESM — can't require() it, so fork it)
  serverProcess = fork(path.join(__dirname, '..', 'src', 'server.js'), [], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: 'pipe',
  });
  serverProcess.stdout.on('data', (d) => console.log(`[server] ${d.toString().trim()}`));
  serverProcess.stderr.on('data', (d) => console.error(`[server] ${d.toString().trim()}`));
  serverProcess.on('exit', (code) => {
    console.error(`[server] exited with code ${code}`);
  });

  // Clean up server when Electron is killed externally
  process.on('SIGTERM', cleanup);
  process.on('SIGINT', cleanup);

  waitForServer(createWindow);
});

function cleanup() {
  if (serverProcess) {
    try { serverProcess.kill('SIGTERM'); } catch {}
    // Force kill after 2s if still alive
    setTimeout(() => { try { serverProcess.kill('SIGKILL'); } catch {} }, 2000);
  }
}

app.on('window-all-closed', () => { cleanup(); app.quit(); });
app.on('before-quit', () => { cleanup(); });
