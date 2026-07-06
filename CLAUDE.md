# CLAUDE.md — Yatfa Warden

`warden` is a desktop dashboard for **AI agent chats** — see and control every agent from one place.
Works with [yatfa](https://npmjs.org/package/yatfa) agents (auto-discovered) or any SSH/tmux terminal.

## The agent topology
A yatfa agent chat is layered:
```
SSH host  →  Docker container ({project}-{role})  →  tmux session "agent"  →  agent-bridge TUI
```
- Roles: `planner | worker | reviewer | researcher`.
- The chat is the `agent` tmux session **inside** the container.
- Bare-tmux chats (no docker) also supported — `host` decides where tmux runs.

## The control path (always use this)
Non-interactive SSH doesn't load PATH, so **always wrap remote commands in a login shell**:
`ssh <host> 'bash -lc "<cmd>"'`.

| Action | Remote command (inside `bash -lc`) |
|---|---|
| discover | `docker ps --format '{{.Names}}\t{{.Image}}\t{{.Status}}'` + `docker exec <c> tmux has-session -t agent` |
| read | `docker exec <c> tmux capture-pane -t agent -p -e -S -500 -E -` |
| send | `docker exec <c> tmux send-keys -t agent '<text>' Enter` |
| attach (PTY) | `docker exec -it <c> tmux attach -t agent` |

## Stack
- **Backend** (`src/`): Node.js v24, deps `express`, `ws`, `node-pty`. CLI (`warden scan/tail/send/attach/observe/ui/dev`) is otherwise zero-dep.
- **Frontend** (`web/`): Vite + React + TS + Tailwind v4 + **shadcn/ui**, xterm via `@xterm/xterm`. `npm run build` → `web/dist`; node serves it.
- Headless verification: `node web/smoke.cjs` (puppeteer-core + Edge).

## Chat model — tmux everywhere
**tmux is required** (native on Linux/macOS; MSYS2 on Windows). Every chat is a tmux session:
- **yatfa** (`kind:'yatfa'`): `container` set, `session='agent'`, in a docker container.
- **manual** (`kind:'tmux'`): `container=null`, `session=<name>`. `host='(local)'` → local tmux; any other host → tmux over SSH.
All durable; survive a warden restart (reattaches to tmux).

**Resume** (`/api/resume`): spawn `claude --resume <id>` in tmux. Per-host Claude Code sessions listed lazily (`/api/claude-sessions?host=`).

## Observer — the "meta chat"
An LLM agent layered on the control plane. Tools: `list_chats`, `read_chat`, `send_directive`. Draft-then-confirm: every send is gated by human approval.

## LLM wiring
Credential resolution: `process.env` → `~/.yatfa-warden/config.json` (`llm`) → `~/.claude/settings.json` (`env`). The model id carries a `[1m]` context tag the raw API rejects — `llm.js` strips it. Override with `WARDEN_MODEL`.
