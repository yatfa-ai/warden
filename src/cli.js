#!/usr/bin/env node
// warden — local manager for yatfa agent chats.
// Subcommands: scan | tail | send | key | attach | dash | config
import fs from 'node:fs';
import path from 'node:path';
import { load, save, configPath, cachePath } from './config.js';
import { discover, discoverAll, resolveChatWithRefresh, agentTarget } from './chats.js';
import { read, send, sendKey, attachInteractive, attachInteractiveCompanion } from './tmux.js';
import { run, attach, buildAttachRemoteScript } from './ssh.js';
import { deliverRemoteScript, isCompanionTransportEnabled } from './companion.js';
import { atomicWriteJson, readJsonDefensiveSync } from './persist.js';

// ---------- tiny ANSI ----------
const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', green: '\x1b[32m', yellow: '\x1b[33m',
  red: '\x1b[31m', cyan: '\x1b[36m', bold: '\x1b[1m', magenta: '\x1b[35m',
};
const paint = (s, c) => (process.stdout.isTTY ? `${c}${s}${C.reset}` : s);
function die(msg, code = 1) { console.error(paint(`warden: ${msg}`, C.red)); process.exit(code); }

// ---------- arg parsing ----------
function parseFlags(argv, bools = []) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { positional.push(...argv.slice(i + 1)); break; }
    if (a.startsWith('--')) {
      const k = a.slice(2);
      if (bools.includes(k)) flags[k] = true;
      else flags[k] = argv[++i];
    } else if (/^-[A-Za-z]+$/.test(a)) {
      const chars = a.slice(1).split('');
      if (chars.every((ch) => bools.includes(ch))) chars.forEach((ch) => (flags[ch] = true));
      else flags[a.slice(1)] = argv[++i];
    } else positional.push(a);
  }
  return { flags, positional };
}

// ---------- chat cache (last scan) ----------
// The CLI is a short-lived offline process, not the server request path, so a
// sync read is tolerable here — but the write is still atomic (WARDEN-831) and
// the read is defensive (backup-on-corrupt) so a half-written cache never makes
// `warden <id>` resolution silently fail.
function readCache() {
  return readJsonDefensiveSync(cachePath, { fallback: null });
}
async function writeCache(chats) {
  await atomicWriteJson(cachePath, { ts: Date.now(), chats });
}

// Resolve an id arg (substring) to one chat. Refreshes cache if no match.
async function resolveChat(idArg, cfg) {
  const cache = readCache();
  const pool = cache?.chats || [];

  const result = await resolveChatWithRefresh(idArg, pool, async () => {
    const { chats, errors } = await discoverAll(cfg.hosts, cfg);
    // Log refresh errors (cli.js specific behavior)
    for (const e of errors) console.error(paint(`! ${e.host}: ${e.error}`, C.red));
    // Update cache and return
    await writeCache(chats);
    return { chats, errors };
  });

  if (result.error) die(result.error);
  return result.chat;
}

// ---------- commands ----------
async function cmdScan(argv, cfg) {
  const { flags } = parseFlags(argv, ['json']);
  const hosts = flags.host ? [flags.host] : cfg.hosts;
  const { chats, errors } = await discoverAll(hosts, cfg);
  await writeCache(chats);
  if (flags.json) { console.log(JSON.stringify({ chats, errors })); return; }
  for (const e of errors) console.error(paint(`! ${e.host}: ${e.error}`, C.red));
  if (!chats.length) { console.log(paint('no chats found.', C.dim)); return; }
  for (const c of chats) {
    const mark = c.active ? paint('●', C.green) : paint('○', C.dim);
    const role = c.role
      ? paint(c.role.padEnd(9), c.role === 'planner' ? C.cyan : c.role === 'worker' ? C.magenta : C.dim)
      : ''.padEnd(9);
    const name = c.active ? c.container : paint(c.container, C.dim);
    console.log(` ${mark} ${name.padEnd(22)} ${role} ${paint('@' + c.host, C.dim)}  ${paint(c.status || '', C.dim)}`);
  }
  const active = chats.filter((c) => c.active).length;
  console.log(paint(`\n ${active} active / ${chats.length} total`, C.dim));
}

async function cmdTail(argv, cfg) {
  const { flags, positional } = parseFlags(argv, ['f']);
  const idArg = positional[0];
  if (!idArg) die('usage: warden tail <id> [-f] [--lines N]');
  const chat = await resolveChat(idArg, cfg);
  const lines = parseInt(flags.lines || '500', 10);
  const show = async () => {
    const pane = await read(chat, cfg, lines);
    process.stdout.write(pane);
  };
  if (!flags.f) { await show(); return; }
  // watch mode: the chat is a full-screen TUI, so clear + redraw each interval.
  const interval = parseInt(String(flags.interval || cfg.pollIntervalMs || 1500), 10);
  const redraw = async () => {
    try {
      const pane = await read(chat, cfg, lines);
      process.stdout.write('\x1b[2J\x1b[H');
      process.stdout.write(paint(`${agentTarget(chat)}  (Ctrl-C to exit)\n`, C.dim));
      process.stdout.write(pane);
    } catch (e) {
      process.stdout.write('\x1b[2J\x1b[H' + paint(`error: ${e.message}\n`, C.red));
    }
  };
  await redraw();
  setInterval(redraw, interval);
  process.on('SIGINT', () => process.exit(0));
}

async function cmdSend(argv, cfg) {
  const { positional } = parseFlags(argv);
  const idArg = positional[0];
  const msg = positional.slice(1).join(' ');
  if (!idArg || !msg) die('usage: warden send <id> <message...>');
  const chat = await resolveChat(idArg, cfg);
  if (!chat.active) console.error(paint(`warning: ${chat.container || chat.key || 'local'} has no active agent session — sending anyway.`, C.yellow));
  await send(chat, cfg, msg);
  console.log(paint(`✓ sent to ${agentTarget(chat)}`, C.green));
}

async function cmdKey(argv, cfg) {
  const { positional } = parseFlags(argv);
  const [idArg, k] = positional;
  if (!idArg || !k) die('usage: warden key <id> <C-c|Escape|Up|Down|Enter|...>');
  const chat = await resolveChat(idArg, cfg);
  await sendKey(chat, cfg, k);
  console.log(paint(`✓ ${k} → ${agentTarget(chat)}`, C.green));
}

async function cmdAttach(argv, cfg) {
  const { positional } = parseFlags(argv);
  const idArg = positional[0];
  if (!idArg) die('usage: warden attach <id>');
  const chat = await resolveChat(idArg, cfg);
  const code = await attachInteractive(chat, cfg);
  process.exit(code);
}

// The dash preflight script — dash builds a tmux session ON THE HOST, so the
// host needs tmux (yatfa containers have tmux; the host itself usually doesn't).
// Byte-for-byte the raw-SSH string today's cmdDash delivers, and the same script
// the server-side preflightTmux leg delivers over the shared router (the
// WARDEN-1283 mirror this slice follows). One constant, both transports.
const DASH_PREFLIGHT_SCRIPT = 'command -v tmux >/dev/null 2>&1 && echo OK || echo MISSING';

// The host-side dash script: one tmux session on the HOST with a window per
// active chat (window cmd `docker exec -it <c> tmux attach -t agent`), then the
// foreground `tmux attach`. ONE builder so BOTH transports — the default
// attach() path and the companion attach path — deliver the byte-identical
// script (WARDEN-1364 parity by construction), and so the delivered string is
// pinnable by test rather than reconstructed inline.
export function buildDashScript(session, containers) {
  const lines = [
    `tmux kill-session -t ${session} 2>/dev/null || true`,
  ];
  containers.forEach((c, i) => {
    const win = i === 0
      ? `tmux new-session -d -s ${session} -n ${c} "docker exec -it ${c} tmux attach -t agent"`
      : `tmux new-window -t ${session} -n ${c} "docker exec -it ${c} tmux attach -t agent"`;
    lines.push(win);
  });
  lines.push(`tmux attach -t ${session}`);
  return lines.join('\n');
}

// `deps` is an optional test seam (production callers omit it):
// isCompanionTransportEnabled / discover / run / deliverRemoteScript /
// attachInteractiveCompanion / attach / die / exit. The toggle-off path — every
// seam defaulted — is byte-for-byte the pre-WARDEN-1364 command.
//
// Companion routing (WARDEN-1364, roadmap WARDEN-270): both remote legs — the
// tmux preflight and the multi-window attach — ride the persistent companion
// channel under WARDEN_COMPANION_TRANSPORT=1 (zero ssh spawns: preflight via
// the shared deliverRemoteScript router → execInContext, the same shape the
// server-side preflightTmux leg took in WARDEN-1283; attach via the
// attachSession PTY family through the same interactive bridge `warden attach`
// uses). LOCAL never routes through the companion. Companion-or-fail: a dead
// channel or a stale binary dies with the actionable error on stderr and a
// non-zero exit — never a silent raw-SSH fallback (same call as exec and
// attachStream). The default path below is byte-for-byte today's, INCLUDING the
// fix this ticket is named for: `attach` is now actually imported from ssh.js
// — before WARDEN-1364 every non-dry-run remote `warden dash` died with
// `ReferenceError: attach is not defined` right after the preflight.
export async function cmdDash(argv, cfg, deps = {}) {
  const fail = (msg) => (deps.die ?? die)(msg);
  const { flags } = parseFlags(argv, ['dry-run']);
  const host = flags.host || cfg.hosts[0];
  if (!host) return fail('no host. set `hosts` in ~/.yatfa-warden/config.json or pass --host.');
  const r = await (deps.discover ?? discover)(host, cfg);
  if (!r.ok) return fail(`${host}: ${r.error}`);
  const active = r.chats.filter((c) => c.active);
  if (!active.length) return fail(`no active chats on ${host}.`);
  for (const c of active) {
    if (!/^[A-Za-z0-9_.-]+$/.test(c.container)) return fail(`bad container name: ${c.container}`);
  }
  const session = flags.session || 'warden';

  // Companion routing guard: REMOTE host + toggle on (LOCAL never routes through
  // the companion — same guard shape as every gated sibling in tmux.js).
  const useCompanion = (deps.isCompanionTransportEnabled ?? isCompanionTransportEnabled)() && host !== '(local)';

  // Preflight: dash builds a tmux session ON THE HOST, so the host needs tmux
  // (yatfa containers have tmux, but the host itself usually doesn't). The web
  // dashboard (Phase 2) has no such requirement — it polls over SSH instead.
  if (!flags['dry-run']) {
    let pf;
    if (useCompanion) {
      // Companion path: the shared deliverRemoteScript router (→ execInContext).
      // Companion-or-fail: a channel/bootstrap failure (or a stale binary —
      // execInContext already shapes the too-old error into stderr) dies here
      // with the actionable message instead of masquerading as "no tmux".
      pf = await (deps.deliverRemoteScript ?? deliverRemoteScript)(host, DASH_PREFLIGHT_SCRIPT, { timeout: 8000 }, cfg, deps);
      if (!pf.ok) {
        fail(`companion preflight on ${host} failed: ${(pf.stderr || '').trim() || `exit ${pf.code}`}\n` +
            `    (companion-or-fail: dash never falls back to raw SSH while the toggle reads on.\n` +
            `     fix the channel, or set WARDEN_COMPANION_TRANSPORT=0 to use the default SSH path.)`);
        return;
      }
    } else {
      pf = await (deps.run ?? run)(host, DASH_PREFLIGHT_SCRIPT, { timeout: 8000 });
    }
    if (!pf.stdout.includes('OK')) {
      fail(`host "${host}" has no tmux (dash runs tmux there). install it:\n` +
          `    ssh ${host} 'brew install tmux'        # macOS (Homebrew)\n` +
          `    ssh ${host} 'sudo apt-get install -y tmux'   # Debian/Ubuntu\n` +
          `then re-run. (The other commands — scan/tail/send/attach — work without host tmux.)`);
      return;
    }
  }

  const script = buildDashScript(session, active.map((c) => c.container));
  if (flags['dry-run']) { console.log(script); return; }
  console.error(paint(`opening ${active.length} chats on ${host}: ${active.map((c) => c.container).join(', ')} …`, C.dim));
  let code;
  if (useCompanion) {
    // The same interactive bridge `warden attach` uses, carrying the composed
    // multi-window script under the shared buildAttachRemoteScript wrapper (the
    // LANG/LC_ALL export + `bash -lc` the web pane delivers).
    code = await (deps.attachInteractiveCompanion ?? attachInteractiveCompanion)(host, buildAttachRemoteScript(script), cfg, deps);
  } else {
    code = await (deps.attach ?? attach)(host, script);
  }
  (deps.exit ?? process.exit)(code);
}

async function cmdConfig(argv, cfg) {
  const [action] = argv;
  if (!action || action === 'list') { console.log(JSON.stringify(cfg, null, 2)); return; }
  if (action === 'path') { console.log(configPath); return; }
  if (action === 'init') { await save(cfg); console.log('wrote', configPath); return; }
  if (action === 'edit') {
    if (!fs.existsSync(configPath)) await save(cfg);
    const editor = process.env.EDITOR || 'notepad';
    const { spawn } = await import('node:child_process');
    const c = spawn(editor, [configPath], { stdio: 'inherit' });
    c.on('exit', (code) => process.exit(code ?? 0));
    return;
  }
  die(`unknown config action "${action}"`);
}

async function cmdObserve(_argv, cfg) {
  const { hasCredentials } = await import('./llm.js');
  if (!hasCredentials()) {
    die('no LLM credentials. this Claude Code uses ANTHROPIC_AUTH_TOKEN + ANTHROPIC_BASE_URL; ' +
        'make sure those are in the environment warden runs in.');
  }
  const readline = (await import('node:readline')).default;
  const { Observer } = await import('./observer.js');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let closed = false;
  rl.on('close', () => { closed = true; });
  const ask = (q) => new Promise((r) => {
    if (closed) return r(null);
    rl.question(q, (ans) => r(ans));
  });

  // Human-in-the-loop gate around every send to a live agent.
  const gate = async (chat, directive) => {
    console.log('\n' + paint(`── proposed directive → ${agentTarget(chat)} ──`, C.cyan));
    console.log(directive);
    const raw = await ask(paint('send? [y]es / [n]o / [e]dit: ', C.yellow));
    if (raw === null) return { approved: false }; // stdin closed
    const a = raw.trim().toLowerCase();
    if (a === 'y' || a === '') return { approved: true };
    if (a === 'e') {
      const edited = await ask('replacement directive (one line): ');
      if (!edited || !edited.trim()) return { approved: false };
      return { approved: true, edited: edited.trim() };
    }
    return { approved: false };
  };

  const obs = new Observer(cfg, {
    gate,
    onTool: (name, input) => {
      if (name === 'list_chats') process.stderr.write(paint('  [observer: scanning chats…]\n', C.dim));
      else if (name === 'read_chat') process.stderr.write(paint(`  [observer: reading ${input.id}…]\n`, C.dim));
      else if (name === 'send_directive') process.stderr.write(paint(`  [observer: proposing directive to ${input.id}]\n`, C.dim));
    },
    onText: (t) => process.stderr.write(paint(`  ${t.trim()}\n`, C.dim)),
  });

  console.log(paint('warden observer (GLM). I watch your agents and help you direct them.', C.dim));
  console.log(paint('ask "what\'s going on?" to start  •  /refresh /help /quit\n', C.dim));

  while (true) {
    const line = await ask(paint('you> ', C.bold));
    if (line === null) break; // stdin closed (EOF)
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed === '/quit' || trimmed === '/exit') break;
    if (trimmed === '/refresh') {
      await obs._refreshChats();
      const active = obs.lastChats.filter((c) => c.active).length;
      console.log(paint(`found ${obs.lastChats.length} chats (${active} active)`, C.dim));
      continue;
    }
    if (trimmed === '/help') {
      console.log('/refresh — re-scan chats   /quit — exit   (or just talk to me)');
      continue;
    }
    try {
      const reply = await obs.step(trimmed);
      console.log('\n' + paint('observer>', C.magenta));
      console.log(reply);
    } catch (e) {
      console.error(paint(`observer error: ${e.message}`, C.red));
    }
  }
  rl.close();
}

async function cmdUi(argv, _cfg) {
  const { flags } = parseFlags(argv, ['open']);
  const port = parseInt(flags.port || process.env.PORT || '7421', 10);
  const { startServer } = await import('./server.js');
  startServer(port);
  if (flags.open) {
    const { spawn } = await import('node:child_process');
    const url = `http://localhost:${port}`;
    const launcher = process.platform === 'win32'
      ? ['cmd', ['/c', 'start', url]]
      : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
    spawn(launcher[0], launcher[1], { detached: true, stdio: 'ignore' }).unref();
  }
  // the http listener keeps the process alive
}

async function cmdDev(_argv, _cfg) {
  const { spawn } = await import('node:child_process');
  const webDir = path.join(process.cwd(), 'web');
  const server = spawn(process.execPath, ['src/server.js'], {
    stdio: 'inherit', env: { ...process.env, PORT: '7421' },
  });
  const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  const vite = spawn(npx, ['vite'], { stdio: 'inherit', cwd: webDir, shell: process.platform === 'win32' });
  console.log('warden dev → app on http://localhost:5173 (api proxied to 7421)');
  const cleanup = () => { server.kill(); vite.kill(); setTimeout(() => process.exit(0), 200); };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
  server.on('exit', cleanup);
  vite.on('exit', cleanup);
}

function printHelp() {
  console.log(`warden — manage yatfa agent chats (host → docker → tmux "agent")

usage:
  warden scan [--host H] [--json]      discover chats (● active, ○ idle)
  warden tail <id> [-f] [--lines N]    print pane; -f = live watch (redraw)
  warden send <id> <message...>        send a chat message (+ Enter)
  warden key <id> <C-c|Escape|Up|...>  send a special key
  warden attach <id>                   attach interactively (full PTY)
  warden dash [--host H]               one tmux w/ a window per active chat
  warden observe                       the meta-chat: an observer (GLM) that
                                        watches your agents and, with your
                                        approval, sends them proper directives
  warden ui [--port N] [--open]        web dashboard: chats + live panes + observer
  warden dev                           vite (5173, HMR) + node api (7421) together
  warden config [list|path|init|edit]  manage ~/.yatfa-warden/config.json

<id> is any unique substring: yatfa-planner, planner, my-shell…

hosts scanned come from ~/.yatfa-warden/config.json.`);
}

async function main() {
  const [sub, ...rest] = process.argv.slice(2);
  const cfg = load();
  switch (sub) {
    case 'scan': case 'ps': case 'ls': return cmdScan(rest, cfg);
    case 'tail': case 'cat': return cmdTail(rest, cfg);
    case 'send': return cmdSend(rest, cfg);
    case 'key': return cmdKey(rest, cfg);
    case 'attach': return cmdAttach(rest, cfg);
    case 'dash': case 'dashboard': return cmdDash(rest, cfg);
    case 'observe': return cmdObserve(rest, cfg);
    case 'ui': case 'web': return cmdUi(rest, cfg);
    case 'dev': return cmdDev(rest, cfg);
    case 'config': return cmdConfig(rest, cfg);
    case 'version': case '-v': case '--version': return console.log('warden 0.1.0');
    case 'help': case '-h': case '--help': case undefined: return printHelp();
    default: die(`unknown command "${sub}". try \`warden help\`.`);
  }
}

main().catch((e) => die(e.message));
