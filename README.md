# Yatfa Warden

### See and control all your AI agents from one screen.

[![License: ISC](https://img.shields.io/badge/License-ISC-blue.svg)](LICENSE)

Yatfa Warden is a desktop dashboard for **AI agent chats** — see every agent's live output, type directly into any of them, and manage sessions across multiple hosts. Works with [yatfa](https://yatfa.com) agents (auto-discovered) or any SSH + tmux terminal.

## Features

- **Live agent panes** — real interactive terminals (xterm.js). Every agent's full TUI, colors, cursor. Type directly.
- **Cross-host** — agents spread across servers? One sidebar, every host, every agent.
- **Session resume** — pick from your Claude Code history on any host, click to resume.
- **The Observer** — an AI assistant that watches your agents, summarizes what's happening, and drafts directives you approve before they reach an agent.
- **Spawn / kill / hide** — spawn new Claude Code sessions or shells on any host. Force-kill stuck sessions. Hide agents you don't watch often.
- **100% local** — no cloud, no sync, no third-party analytics. Optional, off-by-default telemetry (anonymous errors/crashes) can send to a self-hosted receiver only if you turn it on. Your credentials stay on your machine.

## Quick start

```bash
git clone https://github.com/yatfa-ai/warden.git
cd warden
npm install && npm --prefix web install
npm start
# → http://localhost:7421
```

**Requires tmux** on Linux/macOS, and on every **remote** host you connect to (native package: `tmux`).
**On Windows, local terminals need nothing extra** — they run natively through ConPTY (the same primitive
VSCode's integrated terminal uses), so you get PowerShell/cmd rather than bash, and no MSYS2 install.
Remote hosts you SSH into still need tmux on their side. (Local Windows sessions live in the Warden
process and, like a VSCode terminal, don't survive Warden being closed; set `WARDEN_WIN_TMUX=1` to fall
back to the old MSYS2-tmux behavior, or `WARDEN_WIN_SHELL=C:\path\to\shell.exe` to spawn a shell other
than the auto-detected PowerShell/cmd.)

**Requires Node.js 18+** (tested on v24).

## How it works

```
┌─────────────────────────────────────────────────┐
│ Yatfa Warden                                     │
│┌──────────┬──────────────────────┬─────────────┐│
││ sidebar  │  agent panes          │ observer    ││
││          │                       │             ││
││ ▸ host-1 │  ┌──────────────────┐ │  🤖 summary ││
││   agent-1│  │ agent-1           │ │  + draft    ││
││   agent-2│  │ ❯ working…        │ │  directive  ││
││ ▸ host-2 │  └──────────────────┘ │             ││
││   shell  │  ┌──────────────────┐ │  [approve]   ││
││          │  │ agent-2           │ │  [decline]   ││
││ + new    │  │ ❯ idle            │ │             ││
│└──────────┴──────────────────────┴─────────────┘│
└─────────────────────────────────────────────────┘
```

Each agent runs in a **tmux session** (inside a Docker container for yatfa, or directly on a host). Yatfa Warden attaches to those sessions over SSH and streams them to your browser as live terminals.

## Config

Edit `~/.yatfa-warden/config.json`:
```jsonc
{
  "hosts": ["my-server"],   // SSH aliases from ~/.ssh/config
  "tmuxSession": "agent",   // tmux session name (yatfa default: "agent")
  "pins": []                // chats to surface first
}
```

Or use the CLI: `warden config edit`.

## CLI

```bash
warden scan                    # discover chats
warden tail <id>               # print current pane
warden send <id> "message"     # send a chat message
warden attach <id>             # full interactive attach
warden ui                      # launch the web dashboard
warden observe                 # CLI observer (meta-chat)
```

## Troubleshooting: the app felt frozen

Warden's backend is a single-threaded process, so one slow blocking call stalls
every request, WebSocket message and pane poll at once — which is what a hang
"for no reason" (a spinner that sits for seconds) usually is. The backend watches
its own event loop and records every multi-second block, always on, no setup:

```bash
cat ~/.yatfa-warden/stalls.jsonl        # newest last, one JSON line per stall
curl localhost:7421/api/diagnostics/stalls   # same records, newest first
```

Each record says how long the loop was blocked (`lagMs`) and what was running
while it was (`attribution` — the request, the background sweep, and the
individual synchronous call, with the time each covered):

```jsonc
{ "type": "performance-stall", "runtime": "server", "lagMs": 3507,
  "attribution": [{ "label": "fs.readFileSync", "overlapMs": 3506, "durationMs": 4004 }] }
```

An empty file means the backend has not stalled. Stalls are also printed as
`[warden:stall] …` lines, and records older than 7 days are dropped at startup.
This is local-only and unrelated to telemetry (which stays off by default).

## Development

```bash
npm run dev          # Vite HMR (5173) + node API (7421)
npm run build        # production build → web/dist
node web/smoke.cjs   # headless smoke test (puppeteer)
```

Stack: **Node.js** (backend: Express, ws, node-pty) + **React + TypeScript + Tailwind v4 + shadcn/ui** (frontend, xterm.js terminals).

## Privacy & security

- **100% local.** Runs entirely on your machine. No data leaves your computer unless you explicitly opt into optional telemetry (off by default).
- **Credentials stay yours.** API keys, SSH keys — all stay in the app process.
- **No remote access.** Binds to localhost only.
- **Human-in-the-loop.** The observer drafts directives, but **you approve every one**.

## License

[ISC](LICENSE) — free to use, modify, and distribute.

---

<p align="center">
  <a href="https://yatfa.com">
    <img src="assets/built-with-yatfa.png" alt="Built with yatfa — a team of AI agents that plans, builds &amp; ships software." width="100%">
  </a>
</p>
