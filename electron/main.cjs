// Yatfa Warden — Electron main process (CommonJS).
// Spawns the backend server (ESM) as a child process, then opens a window.
const { app, BrowserWindow } = require('electron');
const { fork } = require('child_process');
const path = require('path');
const http = require('http');

const PORT = parseInt(process.env.WARDEN_PORT || '7421', 10);
const HOST = '127.0.0.1';

let serverProcess = null;
let win = null;

function waitForServer(cb) {
  const tryConnect = () => {
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
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadURL(`http://${HOST}:${PORT}/`);
  win.on('closed', () => { win = null; });
}

app.whenReady().then(() => {
  // Start the backend (ESM — can't require() it, so fork it)
  serverProcess = fork(path.join(__dirname, '..', 'src', 'server.js'), [], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: 'pipe',
  });
  serverProcess.stdout.on('data', (d) => console.log(`[server] ${d.toString().trim()}`));
  serverProcess.stderr.on('data', (d) => console.error(`[server] ${d.toString().trim()}`));

  // Wait for the server to be ready, then open the window
  waitForServer(createWindow);
});

app.on('window-all-closed', () => {
  if (serverProcess) serverProcess.kill();
  app.quit();
});

app.on('before-quit', () => {
  if (serverProcess) serverProcess.kill();
});
