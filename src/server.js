// warden web dashboard server. tmux is required everywhere — every chat is a tmux
// session (yatfa: in a docker container; manual: a host/local tmux session). The
// transport (ssh.js runTmux/attachTmux) routes each op to the remote host over SSH
// or to this machine locally. No more direct-PTY path.
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer } from 'ws';
import { load, loadCatalog, saveCatalog, allSshHosts } from './config.js';
import { discoverAll } from './chats.js';
import { read as readPane, send as sendPane, sendKey, hasSession, resize, spawn as spawnTmux, kill as killTmux, attachStream } from './tmux.js';
import { run, runLocalTmux, shellQuote, TMUX_BIN, detectClaude } from './ssh.js';
import { Observer } from './observer.js';
import { hasCredentials, resolveModel } from './llm.js';
import { listSessions, createSession, renameSession, deleteSession } from './sessions.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cfg = load();
const LOCAL = '(local)';

const app = express();
app.use(express.json({ limit: '1mb' }));

const DIST = path.join(__dirname, '..', 'web', 'dist');
if (fs.existsSync(DIST)) {
  // Never cache index.html (so new hashed bundles are picked up after a rebuild);
  // hashed assets under /assets are fine to cache (content-addressed).
  app.use((req, res, next) => {
    if (req.path === '/' || req.path.endsWith('.html')) res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    next();
  });
  app.use(express.static(DIST));
} else {
  app.get('/', (_req, res) => res.type('text/plain').send(
    'warden web build not found. Run `npm run build` in web/ (or `warden dev` for hot reload).',
  ));
}

// chat cache + resolver
let cache = [];
function matchIn(list, id) {
  const exact = list.filter((c) => c.id === id || c.key === id || c.container === id || c.session === id);
  if (exact.length) return exact;
  return list.filter((c) =>
    (c.container && c.container.includes(id)) ||
    (c.session && c.session.includes(id)) ||
    (c.id && c.id.includes(id)) ||
    c.project === id || c.role === id);
}
async function resolve(id) {
  let found = matchIn(cache, id);
  if (found.length !== 1) {
    const { chats } = await discoverAll(cfg.hosts, cfg);
    cache = chats;
    found = matchIn(chats, id);
  }
  if (found.length === 1) return { chat: found[0] };
  if (!found.length) return { error: `no chat matches "${id}"` };
  return { error: 'ambiguous', matches: found.map((c) => c.id) };
}

// Verify tmux is available (local exec or remote host). Returns null or an error string.
async function preflightTmux(host) {
  if (host === LOCAL) {
    const r = runLocalTmux(['-V']);
    return r.ok ? null : 'tmux not found on this machine. Install it (Linux/macOS: tmux; Windows: MSYS2 tmux).';
  }
  const r = await run(host, 'command -v tmux >/dev/null 2>&1 && echo OK || echo MISSING', { timeout: 8000 });
  return r.stdout.includes('OK') ? null : `tmux is required on ${host}. install:  ssh ${host} 'sudo apt-get install -y tmux'  (or: brew install tmux)`;
}

const NAME_RE = /^[A-Za-z0-9_.-]+$/;
// Capture panes for a set of chats in one round per host (local: runLocalTmux each;
// remote: one ssh batching all, docker-exec for yatfa, plain tmux for manual).
async function capturePanes(chats) {
  const byHost = {};
  for (const c of chats) (byHost[c.host] ||= []).push(c);
  const out = {};
  await Promise.all(Object.entries(byHost).map(async ([host, list]) => {
    if (host === LOCAL) {
      for (const c of list) {
        const r = runLocalTmux(['capture-pane', '-t', c.session || c.container, '-p', '-e', '-S', '-60', '-E', '-']);
        if (r.ok) out[c.key] = r.stdout;
      }
      return;
    }
    const script = list.map((c) => {
      const t = c.container ? `docker exec ${shellQuote(c.container)} tmux` : 'tmux';
      const s = shellQuote(c.session || c.container || 'agent');
      return `printf '___B_${c.key}___\\n'; ${t} capture-pane -t ${s} -p -e -S -60 -E - 2>/dev/null; printf '\\n___E_${c.key}___\\n'`;
    }).join('; ');
    const res = await run(host, script, { timeout: 15000 });
    if (!res.ok) return;
    let cur = null;
    const buf = [];
    for (const ln of res.stdout.split('\n')) {
      const b = ln.match(/^___B_(.+)___$/);
      if (b) { cur = b[1]; buf.length = 0; continue; }
      const e = ln.match(/^___E_(.+)___$/);
      if (e) { if (cur) out[cur] = buf.join('\n'); cur = null; continue; }
      if (cur != null) buf.push(ln);
    }
  }));
  return out;
}

app.get('/api/chats', async (_req, res) => {
  const { chats, errors } = await discoverAll(cfg.hosts, cfg);
  cache = chats;
  res.json({ chats, errors });
});
app.get('/api/pane', async (req, res) => {
  const r = await resolve(String(req.query.id || ''));
  if (r.error) return res.status(404).json(r);
  try { res.json({ pane: await readPane(r.chat, cfg, parseInt(req.query.lines || '200', 10)) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/send', async (req, res) => {
  const r = await resolve(String(req.body?.id || ''));
  if (r.error) return res.status(404).json(r);
  try { await sendPane(r.chat, cfg, String(req.body?.text || '')); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/key', async (req, res) => {
  const r = await resolve(String(req.body?.id || ''));
  if (r.error) return res.status(404).json(r);
  try { await sendKey(r.chat, cfg, String(req.body?.key || '')); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/sessions', (_req, res) => res.json({ sessions: listSessions() }));
app.post('/api/sessions', (req, res) => res.json(createSession(req.body?.name)));
app.patch('/api/sessions/:id', (req, res) => {
  const s = renameSession(String(req.params.id), String(req.body?.name || ''));
  return s ? res.json(s) : res.status(404).json({ error: 'not found' });
});
app.delete('/api/sessions/:id', (req, res) => { deleteSession(String(req.params.id)); res.json({ ok: true }); });

app.get('/api/ssh-hosts', (_req, res) => res.json({ hosts: allSshHosts(), configured: cfg.hosts }));
app.get('/api/this-session', (_req, res) => res.json({
  sessionId: process.env.CLAUDE_CODE_SESSION_ID || null,
  claudePath: process.env.CLAUDE_CODE_EXECPATH || null,
  cwd: process.cwd(),
}));

// ---- Claude Code session list (for the per-host "resume" list) ----
function parseJsonlHead(text) {
  let cwd = '';
  let summary = '';
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let j;
    try { j = JSON.parse(line); } catch { continue; }
    if (!cwd && j.cwd) cwd = j.cwd;
    if (!summary && j.type === 'user' && j.message) {
      const c = j.message.content;
      const txt = typeof c === 'string' ? c : (Array.isArray(c) ? (c.find((b) => b && b.type === 'text')?.text || '') : '');
      summary = txt.replace(/\s+/g, ' ').trim().slice(0, 100);
    }
    if (cwd && summary) break;
  }
  return { cwd, summary };
}
function localClaudeSessions() {
  const dir = path.join(os.homedir(), '.claude', 'projects');
  const files = [];
  try {
    for (const proj of fs.readdirSync(dir)) {
      const pdir = path.join(dir, proj);
      try { if (!fs.statSync(pdir).isDirectory()) continue; } catch { continue; }
      for (const f of fs.readdirSync(pdir)) {
        if (!f.endsWith('.jsonl')) continue;
        const fp = path.join(pdir, f);
        try { files.push({ id: f.slice(0, -6), file: fp, mtime: fs.statSync(fp).mtimeMs }); } catch { /* noop */ }
      }
    }
  } catch { return []; }
  files.sort((a, b) => b.mtime - a.mtime);
  return files.slice(0, 40).map((f) => {
    let cwd = '';
    let summary = '';
    try {
      const fd = fs.openSync(f.file, 'r');
      const buf = Buffer.alloc(8192);
      fs.readSync(fd, buf, 0, 8192, 0);
      fs.closeSync(fd);
      ({ cwd, summary } = parseJsonlHead(buf.toString('utf8')));
    } catch { /* noop */ }
    return { id: f.id, cwd, summary, mtime: f.mtime };
  }).filter((s) => s.cwd);
}
async function remoteClaudeSessions(host) {
  const script = `for f in ~/.claude/projects/*/*.jsonl; do [ -f "$f" ] || continue; id=$(basename "$f" .jsonl); mt=$(stat -c %Y "$f" 2>/dev/null || stat -f %m "$f" 2>/dev/null); printf '___S\\t%s\\t%s\\n' "$id" "$mt"; head -c 6000 "$f"; printf '\\n___E\\t%s\\n' "$id"; done`;
  const res = await run(host, script, { timeout: 15000 });
  if (!res.ok) return [];
  const out = [];
  let cur = null;
  const buf = [];
  for (const line of res.stdout.split('\n')) {
    const sm = line.match(/^___S\t(\S+)\t(\d+)/);
    if (sm) { cur = { id: sm[1], mtime: Number(sm[2]) * 1000 }; buf.length = 0; continue; }
    if (/^___E\t/.test(line)) {
      if (cur) {
        const { cwd, summary } = parseJsonlHead(buf.join('\n'));
        if (cwd) out.push({ id: cur.id, cwd, summary, mtime: cur.mtime });
      }
      cur = null;
      continue;
    }
    if (cur) buf.push(line);
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out.slice(0, 40);
}
app.get('/api/claude-sessions', async (req, res) => {
  const host = String(req.query.host || LOCAL);
  const sessions = host === LOCAL ? localClaudeSessions() : await remoteClaudeSessions(host);
  const claudeAvailable = !!(await detectClaude(host));
  res.json({ sessions, claudeAvailable });
});

// If cmd invokes bare `claude`, replace it with the full path found on the host —
// claude is often in a .zshrc-only PATH that tmux's shell (bash) can't see.
async function resolveClaudeCmd(host, cmd) {
  if (!/^claude(\s|$)/.test(cmd)) return { cmd };
  const claudePath = await detectClaude(host);
  if (!claudePath) return { error: `\`claude\` not found on ${host}. Install it or add its dir to PATH (e.g. ~/.local/bin).` };
  return { cmd: cmd.replace(/^claude(\s|$)/, (_m, sp) => `${claudePath}${sp}`) };
}

app.post('/api/rename', (req, res) => {
  const session = String(req.body?.session || '');
  const name = String(req.body?.name || '').trim().slice(0, 60);
  if (!session || !name) return res.status(400).json({ error: 'session and name required' });
  const catalog = loadCatalog();
  const entry = catalog.find((c) => c.session === session);
  if (!entry) return res.status(404).json({ error: 'not a renameable chat' });
  entry.name = name;
  saveCatalog(catalog);
  res.json({ ok: true });
});

// Spawn a chat (always tmux). host '(local)' → this machine; remote → host tmux.
async function buildAndSpawn({ host, session, name, cwd, cmd }) {
  const err = await preflightTmux(host);
  if (err) return { error: err, status: 400 };
  const resolved = await resolveClaudeCmd(host, cmd);
  if (resolved.error) return { error: resolved.error, status: 400 };
  const finalCmd = resolved.cmd;
  const chat = { host, session, cwd, cmd: finalCmd, name: name || session };
  try { await spawnTmux(chat); }
  catch (e) { return { error: e.message, status: 500 }; }
  // The session must actually be alive — `new-session -d` returns ok even when the
  // command inside fails to start, leaving no session.
  if (!(await hasSession(chat, cfg))) {
    const bin = String(finalCmd || '').split(/\s+/)[0] || 'the command';
    return { error: `\`${bin}\` failed to start on ${host} — tmux session died immediately. Is it installed and on PATH there?`, status: 500 };
  }
  return { chat: { id: `${host}:${session}`, key: session, kind: 'tmux', host, container: null, session, project: 'manual', role: 'claude', name: chat.name, cwd, cmd: finalCmd, active: true } };
}

app.post('/api/spawn', async (req, res) => {
  const host = String(req.body?.host || LOCAL).trim() || LOCAL;
  const session = String(req.body?.session || '').trim();
  const cwd = String(req.body?.cwd || '').trim();
  const cmd = String(req.body?.cmd || 'claude --dangerously-skip-permissions').trim();
  if (!session) return res.status(400).json({ error: 'session name is required' });
  if (!NAME_RE.test(session)) return res.status(400).json({ error: 'invalid session name (letters/digits/_-.)' });
  const catalog = loadCatalog();
  if (catalog.some((c) => c.session === session)) return res.status(409).json({ error: `"${session}" already exists` });
  const r = await buildAndSpawn({ host, session, name: req.body?.name || session, cwd, cmd });
  if (r.error) return res.status(r.status).json({ error: r.error });
  saveCatalog([...catalog, { kind: 'tmux', host, session, name: r.chat.name, cwd, cmd }]);
  res.json({ ok: true, chat: r.chat });
});

app.post('/api/resume', async (req, res) => {
  const sid = String(req.body?.id || '');
  if (!/^[\w-]+$/.test(sid)) return res.status(400).json({ error: 'invalid session id' });
  const host = String(req.body?.host || LOCAL);
  const cwd = String(req.body?.cwd || (host === LOCAL ? process.cwd() : ''));
  const session = `resume-${sid.slice(0, 8)}`;
  const name = String(req.body?.name || `resume ${sid.slice(0, 8)}`).trim().slice(0, 80);
  const resolved = await resolveClaudeCmd(host, `claude --resume ${sid} --dangerously-skip-permissions`);
  if (resolved.error) return res.status(400).json({ error: resolved.error });
  const chat = { host, session, cwd, cmd: resolved.cmd, name };
  const out = { id: `${host}:${session}`, key: session, kind: 'tmux', host, container: null, session, project: 'manual', role: 'claude', name, cwd, cmd: resolved.cmd, active: true };
  // Always kill the old resume session + spawn fresh: the old claude has a stale
  // snapshot; the new `claude --resume` reads the latest JSONL (picks up messages
  // posted to the original session since the last resume).
  if (await hasSession(chat, cfg)) {
    try { await killTmux(chat, cfg); } catch { /* noop */ }
  }
  {
    const err = await preflightTmux(host);
    if (err) return res.status(400).json({ error: err });
    try { await spawnTmux(chat); }
    catch (e) { return res.status(500).json({ error: e.message }); }
    if (!(await hasSession(chat, cfg))) {
      return res.status(500).json({ error: `\`claude\` failed to start on ${host} — tmux session died immediately. Is \`claude\` installed and on PATH there?` });
    }
  }
  const catalog = loadCatalog().filter((c) => c.session !== session);
  saveCatalog([...catalog, { kind: 'tmux', host, session, name, cwd, cmd: chat.cmd }]);
  res.json({ ok: true, chat: out });
});

app.post('/api/kill', async (req, res) => {
  const r = await resolve(String(req.body?.id || ''));
  if (r.error) return res.status(404).json(r);
  const chat = r.chat;
  // Kill the tmux session for ANY chat type (yatfa or spawned). For yatfa this
  // kills the agent's tmux session inside the container (container keeps running).
  try { await killTmux(chat, cfg); } catch { /* noop */ }
  // Remove from catalog (spawned chats only; yatfa are auto-discovered)
  if (chat.kind === 'tmux') saveCatalog(loadCatalog().filter((c) => c.session !== chat.session));
  res.json({ ok: true });
});

// Force-kill a tmux session (the running process, even if hung). Does NOT remove
// from catalog — the chat can be re-spawned/resumed later. Different from Ctrl-C
// (which just signals the foreground command) and from /api/kill (which also
// forgets the chat).
app.post('/api/session-kill', async (req, res) => {
  const r = await resolve(String(req.body?.id || ''));
  if (r.error) return res.status(404).json(r);
  try { await killTmux(r.chat, cfg); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

wss.on('connection', (ws, req) => {
  if (!hasCredentials()) {
    ws.send(JSON.stringify({ type: 'error', error: 'no LLM credentials (ANTHROPIC_AUTH_TOKEN missing in the server environment)' }));
    return;
  }
  const u = new URL(req.url || '', 'http://localhost');
  let sid = u.searchParams.get('sid');
  if (!sid) { const s = createSession(); sid = s.id; ws.send(JSON.stringify({ type: 'session_created', sid: s.id, name: s.name })); }

  let reqCounter = 0;
  const pending = new Map();
  const send = (obj) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj)); };

  const obs = new Observer(cfg, {
    sid,
    onTool: (name, input) => send({ type: 'tool', name, input: { ...input, id: input?.id } }),
    onText: (text) => send({ type: 'assistant', text }),
    gate: async (chat, directive) => {
      const requestId = String(++reqCounter);
      send({ type: 'directive_proposed', requestId, container: chat.container, host: chat.host, role: chat.role, directive });
      return new Promise((resolveDecision) => pending.set(requestId, resolveDecision));
    },
  });
  send({ type: 'history', name: obs.name, items: obs.serializeForUi() });

  ws.on('message', async (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    if (msg.type === 'user') {
      send({ type: 'thinking' });
      obs.openTabs = Array.isArray(msg.panes) ? msg.panes : [];
      try { send({ type: 'done', text: await obs.step(String(msg.text || '')) }); }
      catch (e) { send({ type: 'error', error: e.message }); }
    } else if (msg.type === 'gate_decision') {
      const r = pending.get(msg.requestId);
      if (r) { pending.delete(msg.requestId); r({ approved: !!msg.approved, edited: msg.edited }); }
    }
  });
  ws.on('close', () => { for (const [, r] of pending) r({ approved: false }); });
});

// Pane stream WS: live PTY attach (interactive) + monitor snapshots. tmux is the
// durable holder everywhere, so attach PTYs are per-WS (killed on disconnect; the
// tmux session lives on). Local chats attach to a local tmux, remotes over ssh.
const streamWss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  const p = (req.url || '').split('?')[0];
  const route = (w) => w.handleUpgrade(req, socket, head, (ws) => w.emit('connection', ws, req));
  if (p === '/api/observe') route(wss);
  else if (p === '/api/stream') route(streamWss);
  else socket.destroy();
});
streamWss.on('connection', (ws) => {
  const send = (obj) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj)); };
  const attaches = new Map(); // id -> { pty, chat }
  const monitors = new Set(); // chat keys
  let monitorTimer = null;

  const tickMonitor = async () => {
    if (!monitors.size) return;
    const chats = [...monitors].map((k) => cache.find((c) => c.key === k)).filter(Boolean);
    if (!chats.length) return;
    let out;
    try { out = await capturePanes(chats); } catch { return; }
    for (const [k, pane] of Object.entries(out)) send({ type: 'snapshot', id: k, pane });
  };
  const startMonitor = () => { if (!monitorTimer) { monitorTimer = setInterval(tickMonitor, 2000); tickMonitor(); } };
  const stopMonitorIfEmpty = () => { if (monitorTimer && !monitors.size) { clearInterval(monitorTimer); monitorTimer = null; } };

  ws.on('message', async (data) => {
    let m;
    try { m = JSON.parse(data.toString()); } catch { return; }
    if (m.type === 'monitor') { monitors.add(String(m.id)); await resolve(String(m.id)); startMonitor(); }
    else if (m.type === 'unmonitor') { monitors.delete(String(m.id)); stopMonitorIfEmpty(); }
    else if (m.type === 'attach') {
      if (attaches.has(m.id)) return;
      const r = await resolve(String(m.id));
      if (r.error) { send({ type: 'attach_error', id: m.id, error: r.error }); return; }
      const chat = r.chat;
      const cols = Math.max(20, Math.floor(m.cols || 100));
      const rows = Math.max(6, Math.floor(m.rows || 30));
      let pty;
      try { pty = attachStream(chat, cfg, { cols, rows }); }
      catch (e) { send({ type: 'attach_error', id: m.id, error: String((e && e.message) || e) }); return; }
      attaches.set(m.id, { pty, chat });
      pty.onData((d) => send({ type: 'pty', id: m.id, data: d }));
      pty.onExit(({ exitCode }) => { attaches.delete(m.id); send({ type: 'ended', id: m.id, code: exitCode }); });
      try { await resize(chat, cfg, cols, rows); } catch { /* noop */ }
      send({ type: 'attached', id: m.id });
    } else if (m.type === 'input') {
      const a = attaches.get(m.id);
      if (a) { try { a.pty.write(String(m.data || '')); } catch { /* noop */ } }
    } else if (m.type === 'resize') {
      const c = Math.max(20, Math.floor(m.cols || 80));
      const r = Math.max(6, Math.floor(m.rows || 24));
      const a = attaches.get(m.id);
      if (a) {
        try { a.pty.resize(c, r); } catch { /* noop */ }
        try { await resize(a.chat, cfg, c, r); } catch { /* noop */ }
      }
    } else if (m.type === 'detach') {
      const a = attaches.get(m.id);
      if (a) { try { a.pty.kill(); } catch { /* noop */ } attaches.delete(m.id); }
    }
  });

  ws.on('close', () => {
    for (const [, a] of attaches) { try { a.pty.kill(); } catch { /* noop */ } }
    if (monitorTimer) clearInterval(monitorTimer);
  });
});

export function startServer(port = 7421, host = '127.0.0.1') {
  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      console.error(`\nwarden: port ${port} is already in use — another warden running? Stop it, or start with PORT=<other> npm start.\n`);
    } else {
      console.error('warden: server error:', e.message);
    }
    process.exit(1);
  });
  server.listen(port, host, () => {
    console.log(`warden ui → http://${host}:${port}`);
    console.log(`  hosts: ${cfg.hosts.join(', ')}   model: ${resolveModel()}   tmux: ${TMUX_BIN}`);
  });
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  startServer(parseInt(process.env.PORT || '7421', 10));
}
