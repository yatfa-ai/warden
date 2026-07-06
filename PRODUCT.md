# Yatfa Warden

### See and control all your AI agents from one screen.

---

## The problem

You've got AI agents working for you — planning, coding, reviewing, researching. They're powerful, but they're scattered across terminals, SSH sessions, and Docker containers. Checking on them means switching between windows. Giving them instructions means typing into raw terminals. Keeping track of what's happening is a mess.

**You're managing a team of autonomous workers with a terminal and a prayer.**

---

## What warden does

warden is a **dashboard for your AI agents**. One window, every agent visible, full control.

- **See everything at once.** Every agent's live output in its own pane — side by side, real-time. No more terminal switching.
- **Type directly into any agent.** Click a pane, type. It's a real terminal — your keystrokes go straight to the agent, exactly like being in its session.
- **Know when something needs you.** A badge pulses on any pane that has new output while you're looking elsewhere. Never miss an agent that's stuck or waiting for your input.
- **Manage agents across machines.** Your agents run on different servers? No problem. warden connects to all of them over SSH. Build server, CI box, local machine — all in one view.
- **Spawn new agents.** Need a fresh Claude Code session in a project directory? Two clicks — it's running in a persistent tmux session that survives warden restarting.
- **Resume past sessions.** Pick from your Claude Code history — every conversation you've ever had, on any machine. Click to resume. The agent picks up right where you left off.

---

## Who it's for

**Teams and individuals running multiple AI coding agents** (Claude Code, yatfa agents, or any terminal-based AI) who are tired of juggling terminals.

If you've ever had 5 agent windows open and lost track of which one is stuck — warden is for you.

---

## How it works

```
┌─────────────────────────────────────────────────┐
│ warden                                           │
│┌──────────┬──────────────────────┬─────────────┐│
││ sidebar  │  agent panes          │ observer    ││
││          │                       │             ││
││ ▸ build  │  ┌──────────────────┐ │  🤖 "The    ││
││   planner│  │ agent-planner     │ │  planner    ││
││   worker │  │ ❯ roadmap active  │ │  finished   ││
││   review │  │                   │ │  the        ││
││ ▸ ci-box │  └──────────────────┘ │  roadmap."  ││
││   claude │  ┌──────────────────┐ │             ││
││ ▸ local  │  │ cham-worker       │ │  You: "send ││
││   shell  │  │ ❯ running tests…  │ │  it to the  ││
││          │  └──────────────────┘ │  worker"    ││
││ + new    │                       │             ││
││ ↻ refresh│  [＋ split]           │  [approve]   ││
│└──────────┴──────────────────────┴─────────────┘│
└─────────────────────────────────────────────────┘
```

**Three columns:**
1. **Sidebar** — your agents, organized by host. Browse, spawn, resume, pin your working set. Hide agents you don't check often.
2. **Panes** — live terminals for the agents you're watching. Type directly. Search scrollback. Maximize one when you need focus. New output badges tell you where to look.
3. **Observer** — an AI assistant (GLM) that reads your agents' output, summarizes what's happening, and writes directives you approve before they reach an agent.

---

## Key features

### Live agent panes
Every agent is a real, interactive terminal. You see exactly what the agent sees — its full TUI, colors, cursor, everything. Type to interact. No watered-down preview.

### Activity tracking
When an agent produces output while you're looking at another pane, a **`new`** badge appears. You always know where to look without checking every pane manually.

### Cross-host management
Agents spread across your build server, CI box, or your local machine? warden connects to all of them. One sidebar, every host, every agent.

### Session resume
Your Claude Code conversations are saved automatically. warden lists them — click any past session to resume it. The agent loads the full history and continues.

### The Observer — your AI chief of staff
The observer watches your agents and tells you what's happening in plain English:
- *"The planner finished the roadmap and is waiting for your approval."*
- *"The worker hit a test failure in the auth module."*
- *"The researcher has been idle for 20 minutes."*

Ask it to act: *"Tell the worker to fix the failing tests."* It drafts a directive, you approve, it sends. **Nothing reaches an agent without your say-so.**

### Spawn and manage
- **Spawn** a new Claude Code session or a plain shell on any host — directly in warden.
- **Kill** a stuck session with one click (force-terminate, not just Ctrl-C).
- **Persist** — sessions run in tmux, so they survive warden restarting. Come back tomorrow, your agents are still running.

### Hidden agents
Got 10 autonomous agents running but only watch 3? Hide the rest. They keep working — collapsed into a section you can expand when you need to check.

---

## Works with yatfa

warden is a **showcase project for [yatfa](https://npmjs.org/package/yatfa)** — it auto-discovers yatfa agent containers and gives you a dashboard to manage them.

- Detects `{project}-{role}` containers automatically (planners, workers, reviewers, researchers).
- Shows the agent-bridge TUI live — exactly what the agent is doing.
- The observer understands yatfa roles and can direct specific agents.

**Don't use yatfa?** warden works standalone with any SSH-accessible tmux session or Claude Code installation.

---

## Download

warden is a **desktop app** (Electron). Download for your platform:

- **Windows**: `warden-setup.exe`
- **macOS**: `warden.dmg`
- **Linux**: `warden.AppImage`

No server to set up. No cloud account. No network configuration. Download, run, connect to your hosts.

---

## Privacy & security

- **100% local.** warden runs entirely on your machine. No data leaves your computer. No cloud sync. No telemetry.
- **Your credentials stay yours.** API keys, SSH keys, tokens — all stay in the app process. Nothing is transmitted to any external service (except the LLM API you configure, e.g. GLM via Z.ai).
- **No remote access.** The app binds to localhost only. No one can reach your warden from another machine.
- **Human-in-the-loop.** The observer can draft directives, but **you approve every single one** before it reaches an agent. No autonomous actions without your explicit say-so.

---

## Open source

warden is **ISC licensed** — free to use, modify, and distribute.

Contribute, fork, or just star it: [github.com/yatfa-ai/warden](https://github.com/yatfa-ai/warden)

---

## Quick start

1. **Download** warden for your platform.
2. **Run** the app.
3. **Open** the sidebar → click a host (e.g. `build-server`) → click an agent.
4. The agent's live terminal opens in a pane. Type to interact.
5. Want the observer? Click the right panel → ask *"what's going on?"*

That's it. No config files, no terminal, no setup wizard.

---

*warden — your agents, one screen, full control.*
