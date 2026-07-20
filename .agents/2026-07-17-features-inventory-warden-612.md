# Warden — complete feature inventory (for slice-by-slice human review)

**Date:** 2026-07-17
**Ticket:** WARDEN-612 (related: WARDEN-541 — bring the shipped app to order)
**Deliverable:** a complete catalog of every user-facing feature/surface in the warden desktop app, organized by area, with the real UX entry path for each, so a human can walk the app slice-by-slice and mark what's OK vs broken.
**Repo state at capture:** `warden` @ `b7e2200` (main, 0.1.18-line).

> **🔁 RECONCILED 2026-07-20 (WARDEN-843) against `origin/main` @ `b542fd2` (stale-count 0).** A wave of fixes shipped after the 2026-07-17 capture, so the Consolidated list and several Area "rough edges" no longer matched the code. This pass re-verified every claim against the live tree and stamped each with a current verdict — **`[RECONCILED — FIXED ⌐ file:line]`**, **`[RECONCILED — BY-DESIGN]`**, **`[RECONCILED — INTENTIONAL]`**, or **`[RECONCILED — STILL-TRUE]`**. The next walk-pass starts from these tags, not from the original `☐ UNVERIFIED`-era assertions. Two sure, behavior-neutral code fixes were applied in the same motion (the `write_file` chip label and a stale `observerLifecycle.ts` comment — see Consolidated #13 and #21). Entries #2 and #3 were already reconciled green in a prior pass (WARDEN-759) and remain current. Note: some original line-number citations drifted as the file grew; every reconciled tag carries a CURRENT file:line.

---

## ⚠️ How this was assembled — read this first (verification status)

This inventory was assembled by **reading the application source** (the React component tree under `web/src/` and the Node backend under `src/`), **not** by driving the live running app in a browser.

Why: the worker sandbox **blocks Chromium** (a seccomp filter kills it the instant it enables the debugging port — a documented, repeatedly-rediscovered limit of this environment, WARDEN-130). So a real click-through UX walk was not possible here. The ticket explicitly prescribes the honest fallback for exactly this case: **flag every surface not actually driven live as `UNVERIFIED` rather than claiming it was walked.** That convention is used throughout this doc.

What *was* verified live:

- **Backend boot-verified.** The server boots clean (`node src/server.js` on a free port). All HTTP API routes respond `200 OK` (see "Backend verification log" below). So the *backend half* of every feature is wired and live; the gap this doc flags is the *frontend reachability / usability* of each surface, which a browser walk must confirm.
- **Entry paths are traced from the React render tree** — i.e. where each component is actually mounted and which button/hotkey/context-menu/callback opens it. This is the field previous inventories kept getting wrong, so each entry names the concrete trigger and its location.

What a reviewer with a working browser (the reviewer sandbox can run Chromium) should do: walk each area below, follow each entry path in the **running** app, and fill the **Human review** slot. If a path doesn't actually reach the feature in the live app, that's the bug this exercise exists to surface.

### Status legend (per-feature `Human review` slot)

| Value | Meaning |
|---|---|
| `OK` | Reached it live, works as described. |
| `BROKEN` | Reached it, but it doesn't work (errors, hangs, no-op, wrong behavior). |
| `CANT-FIND` | Could not reach it via the documented entry path (unreachable / orphaned / hidden). |
| `SLOW` | Works but painfully slow / hangs (the "feels broken" signal). |
| `UNVERIFIED` | Default. Not yet walked live in a browser. **Every entry starts here** — that is the point of this doc. |

> Convention: every feature below ships with `Human review: UNVERIFIED` because none were driven live in this pass. Overwrite as you walk.

---

## App at a glance (the layout this inventory is organized around)

Single-page React app (no router — views are boolean toggles). The default screen is a 4-column dashboard with a header; Settings and the "Open chat" browser are full-screen overlays.

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ HEADER (h-11)                                                                │
│  ◂ sidebar │ Yatfa Warden │ N open │ [ Workspace tab strip … ] │ ● ⚠ ⌕ Health ▸ Observer ▸ ⚙ │
│                                  (tabs: select/new/rename/close/drag-pane)   │
│                                  ●=WS status  ⚠=Attention  ⌕=Global search    │
├──────────┬───────────────────────────────────┬───────────────┬───────────────┤
│ SIDEBAR  │  PANE GRID (center)               │  OBSERVER     │  HEALTH       │
│ (resizable)│  terminal tiles, one per chat   │  (resizable)  │  (fixed width)│
│          │  split/spawn/kill/broadcast/...   │  meta-chat +  │  fleet health │
│ chats    │                                   │  directives + │  per-host     │
│ new chat │                                   │  transcript   │               │
│ filter/  │                                   │               │               │
│ sort     │                                   │               │               │
│ git chips│                                   │               │               │
│ collections│                                 │               │               │
└──────────┴───────────────────────────────────┴───────────────┴───────────────┘
  Full-screen overlays:  Settings (⚙)  ·  Open-chat browser (sidebar entry)
  Top-of-app banners:   Return banner ("You're needed in…") · Watch catch-up
  Global dialogs:       Global search (Ctrl+Shift+F) · Kill/Force-kill/Close-workspace confirms
```

Header control cluster (right side, all `shrink-0`, each a tooltip-wrapped icon button):
- **◂/▸** toggle sidebar (resizable; drag right edge)
- **● StatusDot** — WebSocket connected/disconnected
- **⚠ AttentionBadge** — popover with ranked "you're needed HERE" callout + alert states
- **⌕ Global search** — also `Ctrl+Shift+F`
- **◂/▸ Health** — toggle the right-hand fleet health panel
- **▸/◂ Observer** — toggle the observer panel (resizable; drag left edge)
- **⚙ Settings** — full-screen settings overlay

Backend is a single Express + `ws` server (`src/server.js`) serving the built frontend from `/` and ~60 JSON API routes under `/api/*`, plus a WebSocket at `/` for live pane streaming. The CLI (`warden …`) is a separate user-facing surface (see "CLI surface" near the end).

---

## Backend verification log (boot-verified live)

Server: `PORT=8529 node src/server.js`. Booted clean, no SSH/tmux hang (lazy mode seeds from disk). Every probed route returned `200 OK`:

```
GET /                  200   (serves built frontend)
GET /api/config        200   → hosts:[], model:glm-5.2, observerConfirmMode/observerAutoStart/
                              observerSessionTimeout, healthWarning/Critical thresholds,
                              tokenBudget* (disabled), companionTransport* (disabled),
                              telemetryEndpoint (""), llm.authTokenSet:false
GET /api/chats         200   → {"chats":[]}   (empty — no hosts configured in sandbox)
GET /api/ssh-hosts     200   → hosts:[] / configured:[]
GET /api/health        200
GET /api/hosts/status  200
GET /api/hosts/health  200
GET /api/activity      200
GET /api/activity/stats 200
GET /api/agent-states/fleet 200
GET /api/collections   200
GET /api/directives    200
GET /api/budget        200
GET /api/pins          200
GET /api/session-tags  200
GET /api/agent-notes   200
GET /api/sessions      200
```

Full backend route inventory (~60 endpoints) — every one is a live surface some feature calls:

- **Chats / discovery:** `GET /api/chats`, `GET /api/discover`, `GET /api/ssh-hosts`, `GET /api/sessions`, `POST /api/sessions`, `PATCH|DELETE /api/sessions/:id`, `POST /api/resume`, `POST /api/respawn`, `POST /api/spawn`, `POST /api/kill`, `POST /api/session-kill`, `POST /api/rename`, `GET /api/claude-session(s)(-all|-search)`, `GET /api/this-session`
- **Pane / terminal (WS + HTTP):** WS `/`, `GET /api/pane`, `GET /api/pane-export`, `GET /api/search-pane`, `POST /api/send`, `POST /api/key`
- **Git:** `GET /api/git-{status,diff,log,blame,branch,show,cat-file,conflict,range-diff,reflog,remote,stash,ls}`, `GET /api/cross-agent-diff`
- **Files:** `POST /api/read-file`, `POST /api/file-exists`, `POST /api/search-files`
- **Fleet / health / activity / attention:** `GET /api/health`, `GET /api/hosts/health`, `GET /api/hosts/status`, `GET /api/activity(/series|/stats)`, `GET /api/agent-states(/fleet)`, `GET /api/directives`, `GET /api/budget`
- **Collections / tags / notes / pins:** `GET|POST|PATCH|DELETE /api/collections(/:id/agents)`, `GET|PUT /api/session-tags`, `GET|PUT /api/agent-notes`, `GET|PUT /api/pins`
- **Config / telemetry / webhooks:** `GET|PUT /api/config`, `POST /api/telemetry-test`, `POST /api/webhook-test`

All boot-green. The open question this doc carries forward is **frontend reachability/usability**, not backend existence.

---

## How to read each entry

Each feature is one line in compact form:

> `- **Feature** — Entry: <real reachability>. Does: <what>. API: <calls>. Notes: <caveat>. ☐`

- **Entry** is the field previous inventories kept getting wrong — it is traced from the actual React mount/call site, not assumed.
- **☐** is the per-feature human-judgment slot. Default verdict is **UNVERIFIED** (nothing was driven live in this pass). As you walk the running app, overwrite each with **OK / BROKEN / CAN'T-FIND / SLOW**.
- "Notes" only appears when there is a real caveat (half-wired, conditionally hidden, narrower than expected, orphaned). If Notes is absent the feature reads as fully wired in code.
- Every entry below is **UNVERIFIED-live** until a browser walk in the reviewer sandbox confirms it. The backend for each is already boot-green (see log above).

## Areas in this inventory

1. [Sidebar — chats, hosts, collections, new chat, filter/sort, multi-select](#area-1--sidebar--chats-hosts-collections-new-chat)
2. [Sidebar — git surfaces (branch badges, dirty files, collisions, fleet commit/code search)](#area-2--sidebar--git-surfaces)
3. [Panes & pane chrome (terminal tiles, split/spawn/kill, context menus, drag)](#area-3--panes--pane-chrome)
4. [Workspaces, File Viewer, file-open flow, diff/conflict views](#area-4--workspaces-file-viewer--file-open-flow)
5. [Fleet health panel, attention badge, activity timeline, watch catch-up, return banner](#area-5--fleet-health-attention-activity-watch)
6. [Observer (meta-chat, directives, transcript viewer)](#area-6--observer)
7. [Settings (13 sections + reset)](#area-7--settings)
8. [Global search, broadcast/key-send/kill/snooze dialogs, telemetry transparency, open-chat browser](#area-8--dialogs-global-search-telemetry-open-chat-browser)
9. [CLI surface](#cli-surface)
10. [Consolidated — suspected-broken / half-wired / orphaned surfaces](#consolidated--suspected-broken--half-wired--orphaned-surfaces)
11. [Reviewer live-walk runbook](#reviewer-live-walk-runbook)

---

## Area 1 — Sidebar (chats, hosts, collections, new chat)

_Sources: `ChatSidebar.tsx`, `NewChatForm.tsx`, `sidebar/ChatRows.tsx`, `sidebar/AgentFilterSortControls.tsx`, `sidebar/SessionTags.tsx`, `sidebar/SidebarBits.tsx`, `CollectionsSection.tsx`, `CreateCollectionDialog.tsx`._

### Sidebar root toolbar
- **Open-panes filter input** — Entry: sidebar root toolbar → "filter..." text box. Does: substring-filters the open-panes list by name/host/type. API: none. Hidden `<20rem`. ☐
- **"+ New" chat trigger** — Entry: sidebar root body → "＋ new" pill. Does: expands the inline spawn form. API: none. ☐
- **Agent filter & sort button** — Entry: root toolbar → SlidersHorizontal icon ("filter & sort"). Does: opens filter/sort popover. Icon tints primary when active. API: none. ☐
- **Fleet commit/code search button** — Entry: root toolbar → GitCommitHorizontal icon. Does: opens fleet-wide git search popover (see Area 2). Root-header only. API: `/api/git-log`, `/api/search-files`. ☐
- **Fleet git collision badge (⚠ live / ⏱ impending)** — Entry: root toolbar → red ⚠N and/or amber ⏱N chips (hidden when clean). Does: ⚠ = files edited by 2+ active agents; ⏱ = file one agent committed while another edits. Click → popover → "Compare edits". Re-homed from the abolished project-chip row (WARDEN-565/601). API: none (cached). ☐
- **Open-panes count badge** — Entry: root toolbar → secondary Badge. Does: count of panes matching filter. Hidden `<18rem`. ☐
- **"updated Xs ago" indicator** — Entry: root toolbar → small text next to refresh. Does: relative time since last refresh. ☐
- **Refresh (↻)** — Entry: root toolbar → ↻. Does: re-reads chat catalog. Skeleton while loading. API: `GET /api/chats`. ☐

### New chat form (collapsed "＋ new" pill → expands)
- **Host picker** — Entry: form top Select. Does: picks where tmux runs — "this machine (direct)" or a remote SSH host; each suffixed with live load (red+⚠ ≥90% mem). API: `/api/ssh-hosts`, `/api/health`. Falls back to local if stored default host gone. ☐
- **Preset buttons (agent type)** — Entry: "claude" / "shell" / `<custom>` row. Does: picks the command preset; custom presets come from Settings. For `claude` the command is `claude --dangerously-skip-permissions` (local uses discovered `claudePath`). API: `/api/this-session`. ☐
- **Session name input** — Entry: "session name" Input. Does: optional tmux session name; blank → random `chat-XXXXXX`. ☐
- **cwd input** — Entry: "cwd (dir)" Input. Does: working dir; pre-filled host-aware from defaults. ☐
- **Command input** — Entry: "command" / "auto (host login shell)" Input. Does: the command to run; editable per-spawn. ☐
- **Durability hint / inline error / Spawn / Cancel** — Entry: under command / red error line / footer buttons. Does: spawn POSTs and opens the chat (API: `POST /api/spawn`); cancel collapses. ☐

### Open-panes list (OpenPaneRow — root view)
- **Open pane row (click to focus)** — Entry: root → "open panes" → click a row. Does: opens/focuses the pane. Dead panes dimmed + line-through. ☐
- **Status dot / last-activity / type·host·project badges** — Entry: row left dot / right timestamp / colored chips. Does: green=solid Open, red square=Dead, muted ring=Idle; relative last-activity (hover=absolute); type/role/project/host chips (gated by display prefs). ☐
- **Per-row git branch badge + What's-new ✦N + dirty-file list** — Entry: row → cyan branch chip / indigo ✦N pill / indented sub-rows. (Detail in Area 2.) ☐
- **Watch toggle (Eye)** — Entry: row → Eye icon (hover-revealed when unwatched; always shown when watched). Does: opts the chat into a desktop ping when it needs you. API: none (App state). ☐
- **Rename (✎)** — Entry: row → ✎ (hover/focus). Does: inline rename. Manual/spawned chats only (`kind==='tmux'`); yatfa not renameable. API: `PUT /api/rename` (via App). ☐
- **Close pane (×)** — Entry: row → ×. Does: removes pane, records it in workspace's recently-closed. Dead panes show red bold ×. ☐
- **Per-pane note (🗒)** — Entry: row → indented italic note line / inline editor. Does: shows/edits per-agent note. API: `GET/PUT /api/agent-notes`. ☐
- **Open-pane context menu** — Entry: right-click an open pane row. Items: Open · Add/Edit note · Kill session (live only, `POST /api/kill`) · Close pane. ☐

### Recently closed list (root view)
- **Reopen entry** — Entry: "recently closed" → click a row. Does: `onReopenClosed`. Shows status dot + name + host + closed-at. API: none. ☐
- **"show N more / less"** — Entry: ghost button. Does: expands from preview count to full capped list. ☐

### "↗ Open chat…" launcher — Entry: sidebar root → blue ghost button. Does: opens the full-page chat browser (Area 8). ☐

### Hosts section (root view)
- **Host row (click to enter)** — Entry: "hosts" → click a host. Does: if offline → error toast + abort; else enters host view + fetches sessions + discovers. API: `/api/claude-sessions?host=`, `/api/discover`. ☐
- **Host active-chats dot / connectivity dot / label / count+chevron** — Entry: host row dots + label + "N ›". Does: green solid = N active chats / muted ring = none; connectivity green/red/gray (online/offline/unknown, +latency); "(local)" shows as "this machine" + cyan tag; active count + nav chevron. ☐
- **Host row context menu** — Entry: right-click a host row. Items: Open · Discover (`/api/discover`) · Copy host name · Copy SSH address (`ssh <host>`, non-local only). ☐
- **Offline hosts collapsed section** — Entry: "▸ Offline (N)" toggle (only when "Hide offline hosts" pref on + ≥1 offline). Does: collapses offline SSH hosts; click expands inline. ☐

### Collections section
- **Collections header / refresh (↻) / create (+)** — Entry: "collections" row + ↻ + "+". Does: label + count; refresh re-fetches; "+" opens CreateCollectionDialog. API: `GET /api/collections`. ☐
- **Collection card (click to open)** — Entry: click a card. Does: enters the collection view. Shows color dot, name, live agent count, "›". Keyboard accessible. ☐
- **Collection card context menu** — Entry: right-click a card. Items: Open · Rename (inline) · Edit… (CreateCollectionDialog edit mode) · Copy name · Copy criteria (JSON) · Delete (confirm). API: `PATCH/DELETE /api/collections/:id`. ☐
- **Inline rename / delete-confirm / empty state** — Entry: Rename via menu or card Input; Delete → ConfirmDialog. Does: PATCH on rename; DELETE on confirm ("underlying chats not affected"). Empty state: "no collections — create one…". ☐

### Host view (drill-in)
- **Back (‹) / label / filter&sort / collision badge / rescan (↻)** — Entry: host-view header. Does: back→root; filter&sort popover (no "Host" sort option); host-scoped collision badge; rescan re-fetches sessions. API: `GET /api/claude-sessions?host=`. ☐
- **Live (tmux) / idle lists** — Entry: "● live (tmux)" and "idle" sections. Does: ChatRows of this host's active/inactive chats, **with full git context** (see Area 2). ☐
- **Claude-not-found warning** — Entry: yellow banner when `claudeAvailable===false`. Does: warns claude isn't installed there. ☐
- **☁ sessions history header + host token total** — Entry: "☁ sessions (history — click to resume)" header. Does: labels resume list; shows summed token total (loaded window) + tooltip. ☐
- **Session tag filter row + per-session tag chips** — Entry: chip row above sessions; chips on each resume row. Does: tag filters (union); per-session "+ tag" add / × remove. API: `GET/PUT /api/session-tags`. ☐
- **Past-session resume row** — Entry: ☁ sessions → click a row. Does: `handleResume` → returns to root. Shows summary, mtime · cwd · token total; "● live" if running. API: `POST /api/resume`. Notes: **[RECONCILED 2026-07-20 — FIXED]** now has a "show N more / show less" affordance (WARDEN-742; `ChatSidebar.tsx:223`/`:1256`) — was hard-capped at 12 (`SESSION_PREVIEW`). See Consolidated #15. ☐
- **Empty states** — Entry: no live+sessions → "nothing-here"; tag-filter excludes all → "no sessions match the selected tag(s) — clear filter". ☐
- **Host-view multi-select action bar** — Entry: foot bar when ≥1 selected. (See "Multi-select action bar" below.) ☐

### Collection view (drill-in)
- **Back (‹) / color dot + name / Broadcast-all / description** — Entry: collection-view header. Does: back→root; identity dot+name; "Broadcast N" one-click selects all matching + opens BroadcastDialog (disabled when none match); description under header. ☐
- **Matching agents / idle lists** — Entry: "● matching agents" / "idle" sections. Does: ChatRows matching criteria. Notes: **[RECONCILED 2026-07-20 — FIXED]** these rows now get FULL git context (branch badge, dirty files, ✦ marker, diff/conflict/open-file) — identical to host-view rows (`ChatSidebar.tsx:1022`/`:1026`). See Consolidated #1. Watch still works. ☐
- **No-match empty / collection-view multi-select action bar** — Entry: "no agents match this collection" EmptyState; action bar when ≥1 selected. ☐

### Chat row (fleet — host & collection views)
- **Click to open / multi-select checkbox** — Entry: click row / left checkbox (hover-or-selection-revealed). Does: open returns view to root; checkbox toggles membership (stopPropagation). Notes: **no context menu** (unlike OpenPaneRow/host-row/collection-card) — actions are hover buttons + double-click rename only. ☐
- **Status dot / name + double-click rename (manual only) / type·role·project·host badges** — Entry: row dot / name / chips. Does: green solid=Open, ◐=Active, muted ring=Idle, red square+WifiOff=host offline; double-click rename only for `kind==='tmux'`; chips gated by display prefs. ☐
- **Per-row git branch badge / What's-new ✦N / dirty-file list** — (host view only — Area 2.) ☐
- **Watch toggle / Pin (📌) / Note (🗒) / Kill+forget (×)** — Entry: hover buttons. Does: watch ping; pin (yellow when pinned); note editor; kill. Notes: **kill button is manual-chats only** — yatfa rows render no × (bulk action bar is the only way to stop a yatfa agent). API: `PUT /api/pins`, `PUT /api/agent-notes`, `POST /api/kill`. ☐

### Watch toggle (shared by ChatRow + OpenPaneRow)
- **Neutral watch/unwatch (Eye) / state-aware "needs you" indicator** — Entry: Eye icon, or a red-pulsing/amber dot that replaces it when a watched chat needs you. Does: toggle watch membership; the state-aware dot names the reason + quotes the signal. Clicking it unwatches. ☐

### Agent filter & sort (popover from SlidersHorizontal)
- **Filter select** — Options: All · Yatfa agents only · Claude sessions only · Manual/shell only. ☐
- **Sort select** — Options: Manual order · Name (A-Z) · Host (hidden in host view) · Status (active first) · Last activity. Notes: Manual = no-op. ☐

### Session tags (host view)
- **Per-session tag chips / tag-filter chip row** — (covered above.) ☐

### Multi-select action bar (root/host/collection fleet lists + health panel subset)
- **Selection count / All / Clear** — Entry: foot bar when ≥1 selected. Does: count; All selects every rendered id; Clear empties. ☐
- **"Send to N…" (broadcast)** — Entry: action bar button. Does: opens BroadcastDialog; confirm fans `POST /api/send` per target. ☐
- **"Interrupt N…"** — Entry: action bar button. Does: opens KeySendDialog; confirm sends Ctrl-C/Esc per target. API: `POST /api/key`. ☐
- **"Snooze N…"** — Entry: action bar button. Does: opens SnoozeDialog; snoozes desktop alerts for all (1h / until tomorrow). Local state only. Notes: **no permanent-mute in bulk** (deliberate). ☐
- **"Watch N / Unwatch N"** — Entry: action bar button. Does: adds/removes every selected key in one write. ☐
- **"Kill N…"** — Entry: destructive button. Does: opens KillDialog; confirm fans `POST /api/kill` + reconciles. ☐

### Rough edges in this area
- **[RECONCILED 2026-07-20 — FIXED] ~~⚠ Collection view strips ALL per-agent git context.~~** `ChatSidebar.tsx:1022` (active) / `:1026` (idle) now pass the FULL git prop set to the collection drill-in's `ChatRow`s, identical to host-view rows (`:1163`/`:1167`). See Consolidated #1.
- **[RECONCILED 2026-07-20 — FIXED] ~~Newly-created collections don't auto-open.~~** `handleCollectionCreated` now calls `enterCollection(collection)` (`ChatSidebar.tsx:801`) — the navigation is live, not commented out. The new collection opens immediately.
- **ChatRow has no right-click context menu** — asymmetric with OpenPaneRow/host-row/collection-card (intentional, but noted for completeness).
- **Fleet-row kill (×) is manual-chats only** — yatfa rows have no kill button (by design; orchestrator-managed).
- **[RECONCILED 2026-07-20 — FIXED] ~~Past-session resume list hard-capped at 12.~~** Now has a "show N more / show less" affordance (WARDEN-742). See Consolidated #15.
- **[RECONCILED 2026-07-20 — FIXED/REVIVED] ~~`GitStateBadges`/`GIT_STATE_KIND` orphaned.~~** Now rendered in both fleet headers (`ChatSidebar.tsx:1142`/`:1388`, WARDEN-635). See Consolidated #6.

---

## Area 2 — Sidebar git surfaces

_Sources: `sidebar/GitBadges.tsx`, `sidebar/FleetCommitSearch.tsx`, `sidebar/DiffStatChip.tsx`._

### Per-chat branch badge (GitBranchBadge) — cyan `⎇ {branch}` button on each chat row; all glyphs inline, silent-when-clean; click opens one big popover.
- **Branch-name label (attached / detached)** — Entry: row → cyan branch button. Does: branch name; detached HEAD → amber `⎇` + short sha (not the misleading literal "HEAD"). ☐
- **In-progress op glyph `⚠ {op}` (red)** — Entry: red prepend on branch badge. Does: agent blocked mid merge/rebase/cherry-pick/revert/bisect; tooltip folds in detail. ☐
- **Last-commit freshness `· Nd`** — Entry: append after branch name. Does: recency from `%cI`; >7d tints amber. NaN-guarded. ☐
- **Dirty glyph `±` (yellow)** — Entry: after freshness. Does: uncommitted changes; tooltip folds `(+N −M)`. ☐
- **No-upstream marker `🔒` (muted)** — Entry: after dirty. Does: named branch with no tracking ref (local-only, not backed up). Omitted for detached. ☐
- **Ahead/unpushed `↑N` (amber) / behind `↓N` (blue) / stash `🗄N` (fuchsia)** — Entry: glyphs after dirty. Does: commits ahead of/behind `@{u}`; shelved stash count separate from dirty tree. ☐
- **Assembled tooltip** — Entry: hover the cyan button. Does: one compound `title`: branch/detached, tracking/no-remote, last-commit absolute, in-progress op, dirty magnitude, stash, unpushed, behind — each term only when applicable. Ends "— click for recent commits". ☐

### Branch-badge click → popover (lazy-fetches on first open; repeat opens reuse caches)
- **Header — branch/detached deep-links + amber `· ↑N unpushed` + refresh (↻)** — Entry: popover header. Does: branch/sha as outbound anchors to `{originWeb}/tree|commit/…` once remote resolves; ↻ re-fetches recent+incoming+outgoing at once (disabled while loading). API: `/api/git-remote`. ☐
- **Origin / remote-identity row** — Entry: row under header (when remote resolved). Does: `{host} · {owner}/{repo}` web link (or raw URL, non-clickable for SSH-only); upstream-branch deep-link. API: `/api/git-remote`. ☐
- **Commit-message search box** — Entry: "search commit messages…" input. Does: debounced (300ms) `git log --grep` across each visible range (recent/outgoing/incoming); ✕ clears. API: `/api/git-log?grep=&range=`. ☐
- **Recent commits list (expandable → files → diff)** — Entry: "recent commits" rows. Does: each row expands to fetch changed files (`git show`) + message body; each file expands to its per-file `DiffBlock` diff. API: `/api/git-show`. ☐
- **"uncommitted · ±" section + `+N −M` chip + "full diff"** — Entry: section (only when dirty). Does: DiffStatChip magnitude + "full diff" opens aggregated `git diff HEAD` in DiffViewer (`worktree` range) + closes popover. ☐
- **"unpushed · ↑ N ahead" / "incoming · ↓ N behind" sections** — Entry: sections (when ahead/behind). Does: each lists explorable commits + a "full diff" → DiffViewer (`outgoing`/`incoming` range → `/api/git-range-diff`). ☐
- **"🗄 stashed work" section** — Entry: section (when `stashN>0`). Does: lazily lists stashes + own ↻. API: `/api/git-stash`. ☐
- **"⏱ recent operations" (reflog) section** — Entry: section (no count gate). Does: lazily lists non-commit ops (resets, checkouts, abandoned rebases, force-pushes) + own ↻. API: `/api/git-reflog`. ☐
- **"⎇ branches" topology section (WARDEN-577)** — Entry: section. Does: lazily lists every local branch — `●`/`○` current, name (deep-linked), freshness, `↑N`/`↓N`, `gone` (upstream deleted), `✓` merged (non-current). Read-only (no checkout/merge/delete). API: `/api/git-branch`. ☐

### Changed-file rows (GitChangedFile) + open-file affordance — used in dirty-file lists, expanded-commit files, and What's-new popover.
- **Status segments (staged/worktree/conflict coloring)** — Entry: row X/Y columns. Does: staged slot green, worktree yellow, untracked `??` gray, conflict `!{code}` red; committed files fall back to single-letter coloring. ☐
- **Click → per-file diff (staged vs unstaged)** — Entry: click a dirty-file row. Does: staged file → `git diff --cached`; else unstaged. stopPropagation (never opens the pane). API: DiffViewer `/api/git-diff?path=&staged=`. ☐
- **Click → conflict view** — Entry: click a conflicted file (`UU/AA/UD/…`). Does: opens read-only ours-vs-theirs ConflictView (not a staged diff). API: `/api/git-conflict?path=`. ☐
- **Open-in-FileViewer affordance (file icon)** — Entry: small file icon at row's right edge. Does: opens file content in FileViewer. Always visible (not hover-gated); Enter/Space + stopPropagation. ☐
- **`+N −M` magnitude chip (DiffStatChip)** — Entry: inline next to dirty-file count / popover headers / DiffViewer. Does: green insertions / red deletions; renders nothing for clean or all-untracked WIP. ☐

### Conflict/collision indicators (GitCollisionBadge) — in root fleet header + host-view header (with `showProject`).
- **Live-collision `⚠N` (red, worktree×worktree) / impending `⏱N` (amber, committed-outgoing×worktree)** — Entry: header badges (hidden when 0). Does: ⚠ = ≥2 active agents editing the same file; ⏱ = one committed (unpushed) while another edits. API: none (computed from cached gitStatus). ☐
- **Collision popover (per path + contributors + Compare)** — Entry: click ⚠/⏱. Does: lists each colliding path (project-tagged), each contributor as a jump-to row, side-tags (committed/editing) for impending. ☐
- **"Compare edits" button** — Entry: popover → button under a path. Does: closes popover + opens `CollisionCompareDialog` (impending → committer's panel from its OUTGOING change). ☐

### Per-agent "What's new since your last visit" (WhatsNewMarker)
- **`✦N[+]` indigo review pill** — Entry: row → pill (only when new commits since `lastSeen`). Does: since-signal ("commits on THIS agent since YOU last visited"); `+` if truncated; clears on pane open/focus. API: none (cached git-log/status). ☐
- **What's-new catch-up popover** — Entry: click ✦N. Does: summary line ("3 new commits · 7 changed files · 1 stash") + new-commits list (display-only) + working-tree changes (openable GitChangedFile rows) + stash line. ☐

### Fleet commit/code search (FleetCommitSearch) — root toolbar only.
- **Trigger button** — Entry: root toolbar → GitCommitHorizontal icon. Does: opens popover; tints primary when last results had hits. ☐
- **Mode toggle Messages / Content / Code** — Entry: popover → segmented buttons. Does: Messages = `git log --grep` (as-you-type); Content = pickaxe `-S`/`-G` over commit-history diffs (Enter-to-submit only); Code = working-tree `git grep` (as-you-type). Switching axis clears results. API: `/api/git-log?grep=|pickaxe=`, `/api/search-files`. ☐
- **Regex sub-toggle (Content only)** — Entry: Content mode → "regex" button. Does: toggles `-S` ⇄ `-G`. API: `/api/git-log?pickaxe=&pickaxeRegex=`. ☐
- **Search input + clear + Enter hint** — Entry: popover input (autofocus). Does: 300ms debounce (Messages/Code); Content shows "press Enter…" hint; ✕ clears. ☐
- **Fleet fan-out + per-agent result groups** — Entry: results area. Does: `Promise.allSettled` across every active project agent; one unreachable agent never blanks others; commit axes join outgoing (tag `↑`); groups + rows are jump-to-agent. Honest "(N unreachable)" note + per-agent failures logged. ☐
- **Empty/loading/error states** — Entry: results area. Does: per-mode help / "searching N agents…" / "no matching commits|code" (+ unreachable line). ☐

### Click-throughs to compare/conflict/range-diff views (entry targets; detail in Area 4)
- **CollisionCompareDialog** — Entry: collision popover → "Compare edits". Fans `/api/git-diff` per contributor + A↔B `/api/cross-agent-diff`. ☐
- **ConflictView** — Entry: click a conflicted dirty-file row. Read-only ours-vs-theirs via `/api/git-conflict`. ☐
- **DiffViewer range modal** — Entry: branch-badge "full diff" (worktree/unpushed/incoming). `/api/git-range-diff` / `/api/git-diff`. ☐

### Rough edges in this area
- **[RECONCILED 2026-07-20 — FIXED/REVIVED] ~~`GitStateBadges` / `GitStateBadge` / `GIT_STATE_KIND` — ORPHANED.~~** No longer dead code — now imported and rendered (`ChatSidebar.tsx:58`/`:1142`/`:1388`, WARDEN-635). See Consolidated #6.
- Otherwise everything here reads as wired.

## Area 3 — Panes & pane chrome

_Sources: `PaneGrid.tsx`, `PaneTile.tsx`._

### Pane grid layout
- **Focused-pane name banner** — Entry: PaneGrid top header bar (always visible). Does: shows focused tile's name, or `open a chat →` placeholder. Notes: right side is empty — old grid-toolbar 🔍/📄 were retired to each pane's context menu (PaneGrid.tsx:296-301). ☐
- **Empty grid state** — Entry: grid body with zero tiles. Does: `click a chat to open a live pane`. ☐
- **Layout mode `auto`/`stacked`/`side-by-side`** — Entry: driven by `paneLayout` pref. Does: auto = `ceil(sqrt(n))` cols; stacked = 1 col; side-by-side = 1 row (overflow-x-auto). ☐
- **Maximize → 1×1** — Entry: any maximize trigger. Does: tile fills grid; stale-maximized guard falls back to all tiles if the maximized id is gone. ☐
- **[RECONCILED 2026-07-20 — FIXED] ~~Pane-to-pane manual resize — ABSENT.~~** WARDEN-660 added draggable resize gutters (`col-resize`/`row-resize` strips + crossing pads at intersections + double-click-to-reset, driven by `paneColRatios`/`paneRowRatios` props); CSS-grid `minmax(9rem,1fr)` cols are the fallback only. The xterm PTY `resize` WS msg on container resize is unchanged. See Consolidated #10. ☐

### Keyboard shortcuts (global window listener; PaneGrid.tsx:190-255)
- **Alt+S** — toggle sidebar. ☐
- **Alt+O** — toggle observer. ☐
- **Alt+← / Alt+→** — focus prev/next tile (wraps). ☐
- **Ctrl+Tab / Shift+Ctrl+Tab** — cycle panes forward/backward (wraps). ☐
- **Alt+1 … Alt+9** — focus Nth tile (no-op if out of range). ☐
- **Alt+0** — focus last tile. ☐
- **Ctrl+W** — close focused pane. ☐
- **Alt+Enter** — toggle maximize. ☐
- **Alt+Escape** — exit maximize (no-op in normal grid). ☐

### Pane tile toolbar (header bar — also the drag handle)
- **StatusDot (connection/exit)** — Entry: header → leftmost dot + label. Does: connected=green solid, connecting=yellow pulse, session_dead=red square "Session ended", host_unreachable=red square "Unresponsive", error=red square; dimmed (agent exited)=gray "Exited". Notes: `keep` on-exit previously left a misleading "Connecting" yellow dot — FIXED (WARDEN-759): the StatusDot is now keyed on `agentExited` (set on a genuine live→exited transition for BOTH `dim` and `keep`), so `keep` shows the honest gray "Exited" dot too; the body stays full-brightness (no opacity-60, no overlay — those remain `dim`-only). ☐
- **Tile label + host tag** — Entry: header → truncated bold text. Does: chat name; user-spawned chats get a host tag (yatfa suppressed — role shown in sidebar instead). ☐
- **"new" activity badge** — Entry: header → cyan pulsing `new` chip. Does: new content in an unfocused pane; cleared on focus. ☐
- **⌕ search (toggle in-pane search bar)** — Entry: header → ⌕. Does: toggles the xterm SearchAddon search bar. ☐
- **⊘ clear** — Entry: header → ⊘. Does: clears xterm scrollback (keeps current line). ☐
- **⬇ download as .txt** — Entry: header → ⬇ (disabled while downloading / no chat). Does: fetches pane, prepends metadata header, triggers `<chat>_<date>_<time>.txt` download. API: `GET /api/pane-export?id=`. ☐
- **⏹ force-kill tmux session** — Entry: header → ⏹. Does: App `forceKill` → (ConfirmDialog if Safety pref on) → `POST /api/session-kill`. Distinct from sidebar kill-chat (`/api/kill`). ☐
- **A− / A+ smaller/bigger font** — Entry: header → A− / A+. Does: decrements/increments the shared global terminal font pref (floored 8, capped 24) — changes ALL panes. ☐
- **⤢ / ⤡ maximize-restore** — Entry: header button (icon swaps). Does: toggles maximize. ☐
- **× close** — Entry: header → ×. Does: closes this pane (detach); tmux session untouched. No confirm. ☐
- **Double-click header → maximize** — Entry: dbl-click header. Header title advertises "drag to another workspace · double-click to maximize". ☐

### Terminal interactions (xterm surface)
- **Terminal rendering & theming** — Entry: tile terminal (auto-mounted). Does: xterm + Fit/Search/Unicode11 addons; palette from resolved theme; `--terminal-background` CSS token; cursor style/blink from pref. Re-themes live on pref/OS flip. ☐
- **Type input → PTY** — Entry: terminal typing. Does: `onData` → WS `{type:'input'}`. ☐
- **Resize → PTY** — Entry: container resize (ResizeObserver → fit). Does: WS `{type:'resize',cols,rows}`. ☐
- **Ctrl/Cmd+C — copy selection (or SIGINT)** — Entry: terminal → Ctrl/Cmd+C. Does: if selection → copy + swallow; else pass through (so SIGINT still works). ☐
- **Ctrl/Cmd+V — paste** — Entry: terminal → Ctrl/Cmd+V. Does: reads clipboard + `term.paste` (bracketed-paste aware for multiline). ☐
- **Copy-on-select** — Entry: drag-select (when pref on). Does: `onSelectionChange` → copy. No-op on empty selection. Default off. ☐
- **OSC 52 clipboard** — Entry: remote tmux emits OSC 52. Does: routes SET sequences to system clipboard (copy on hosts where tmux owns the selection); ignores QUERY. ☐
- **Ctrl/Cmd-click clickable file paths** — Entry: hover a path token → underline + pointer (if file exists) → modifier-click opens it. Does: link provider probes `/api/file-exists` (cached), opens the per-pane FileViewer at the line. Tooltip "⌘/Ctrl+Click to open file". **This is the primary "open a file from a terminal" path.** API: `POST /api/file-exists`. ☐
- **Click terminal → focus / scrollback** — Entry: click terminal surface. Does: focuses xterm. Scrollback depth from pref (clamped 100–100000). ☐

### Terminal-surface context menu (inner menu — right-click the terminal surface)
- **Copy / Paste / Clear / Search** — Entry: right-click terminal surface. Does: copy (no-op empty) / paste / clear / toggle search bar. Inner menu preventDefaults so the outer pane menu doesn't also open. Mouse right-clicks pass through to xterm. ☐

### Pane context menu (outer menu — right-click the pane outside the terminal)
- **Search / Clear** — Entry: right-click pane. Does: toggle search bar / clear. ☐
- **Snippets submenu** — Entry: right-click pane → Snippets (only when `snippets.length>0`). Does: one-click `POST /api/send` of that snippet to THIS pane (no confirm). Success toast. ☐
- **Download / Force-kill / Smaller font / Bigger font** — Entry: right-click pane. Does: same as toolbar ⬇/⏹/A−/A+. ☐
- **Browse files in directory** — Entry: right-click pane → "Browse files in directory". Does: opens `FileBrowserDialog` scoped to THIS pane's cwd → select opens FileViewer. ☐
- **Search workspace files** — Entry: right-click pane → "Search workspace files". Does: opens `WorkspaceSearchDialog` (content grep) scoped to THIS pane's repo → select opens FileViewer at the matched line. ☐
- **Open file from directory** — Entry: right-click pane → "Open file from directory". Does: opens a path-entry dialog prefilled `<cwd>/` → FileViewer at top. Validates non-empty; rejects `..`/`~`. ☐
- **Split shell here** — Entry: right-click pane → "Split shell here". Does: App spawns a bash shell on this pane's host/cwd. API: `POST /api/spawn`. ☐
- **Maximize/Restore / Close** — Entry: right-click pane. Does: toggle maximize / close pane. ☐

### Search within pane (toggle bar)
- **Search input / ↑ prev / ↓ next / × close** — Entry: search bar. Does: xterm SearchAddon findNext/findPrevious; Enter=next, Escape=closes. ☐
- **External search trigger (from global search)** — Entry: via `externalSearchQuery` prop. Does: sets query, opens bar, findNext after 100ms. ☐

### Drag & drop
- **Header drag handle → move pane to another workspace** — Entry: drag the header (draggable, cursor-grab). Does: sets `PANE_DRAG_MIME` payload; dropped on a workspace tab (Area 4) moves the pane. Only the toolbar is draggable (terminal surface is not, so selection/Ctrl+click are unaffected). ☐
- **Within-grid drag reorder — ABSENT.** Drag payload is consumed only by workspace-tab drop targets; dropping a pane in the grid does nothing; no reorder. ☐

### Spawn / split / kill (recovery paths)
- **Split shell here** — (see outer menu above.) Spawns host shell via `/api/spawn`. ☐
- **Open shell here (recovery — session_dead)** — Entry: RecoveryPanel → "Open shell here". Does: `POST /api/spawn {cmd:'bash',session:'shell-<rand>'}` → replaces dead pane. ☐
- **Re-spawn agent (recovery — session_dead, respawnable only)** — Entry: RecoveryPanel → "Re-spawn agent" (only `kind==='tmux' && chat.cmd`). Does: `POST /api/respawn` recreates the tmux session by re-running its own command; not offered for yatfa chats. ☐
- **Retry (recovery — host_unreachable/error)** — Entry: RecoveryPanel → "Retry". Does: bumps `retryNonce` → re-fires WS `attach`, resets phase to connecting, restarts 15s watchdog. This is the "reconnect" affordance (no standalone reconnect button on a live pane). ☐
- **Force-kill** — Entry: toolbar ⏹ or outer menu "Force-kill". `POST /api/session-kill`. ☐
- **Close (pane only, no kill)** — Entry: toolbar × / outer menu "Close" / Ctrl+W. WS `detach`. ☐

### Tile states (overlays over the terminal surface)
- **connecting** — spinner + `connecting… Ns` (elapsed counter); 15s watchdog → host_unreachable. ☐
- **connected + "agent exited" dim overlay** — (when `onExitBehavior==='dim'` + real exit) overlay "agent exited" + opacity-60 + gray "Exited"; output stays readable. Re-arms on agent restart. ☐
- **session_dead** — RecoveryPanel "Agent session not found" with [Open shell here]/[Re-spawn agent]/[Close]. ☐
- **host_unreachable** — RecoveryPanel "Host is unresponsive" (+ elapsed) with [Retry]/[Close]. ☐
- **error** — writes `[error: …]` to terminal + RecoveryPanel "Couldn't attach" with [Retry]/[Close]. ☐

### Rough edges in this area
- **[RECONCILED — BY-DESIGN] ~~Retired grid-toolbar is an empty shell.~~** Normal one-line header; 🔍/📄 were deliberately retired into each pane's context menu (WARDEN-563). See Consolidated #9.
- **[RECONCILED 2026-07-20 — PARTIAL] ~~No pane-to-pane manual resize; no within-grid drag reorder.~~** Resize now EXISTS (WARDEN-660 gutters); within-grid drag reorder is still absent (by-design). See Consolidated #10.
- **Send-text input / key-send / broadcast are NOT in-pane** — they live in `BroadcastDialog`/`KeySendDialog`, surfaced from sidebar/health/App, not the pane tile. Only single-target Snippets→`/api/send` is in-pane.
- **`/api/key`, `/api/search-pane`, `/api/read-file`, `/api/pane`, `/api/this-session` unused in PaneTile/PaneGrid** (used by dialogs/FileViewer/GlobalSearch elsewhere).
- **`keep` on-exit previously left a misleading "Connecting" dot** — FIXED (WARDEN-759): the StatusDot is now keyed on `agentExited`, so `keep` shows an honest gray "Exited" dot (dot-only; body stays full-brightness, no overlay).
- **Live scrollback change on open panes is unreliable** (xterm v6 often ignores mid-session option change; only new/reopened panes pick it up).
- **Recovery "Open shell here"/"Re-spawn" only from `session_dead`** — `host_unreachable`/`error` only offer Retry/Close.

---

## Area 4 — Workspaces, File Viewer, file-open flow

_Sources: `WorkspaceTabs.tsx`, `FileViewer.tsx`, `FileBrowserDialog.tsx`, `WorkspaceSearchDialog.tsx`, `DiffViewer.tsx`, `DiffBlock.tsx`, `ConflictView.tsx`, `CollisionCompareDialog.tsx`._

### Workspace tabs (header strip — App.tsx:1811)
- **Select workspace** — Entry: header strip → click a tab name. Does: makes it active; pane grid shows that workspace's panes (maximized resets). ☐
- **Create workspace (＋)** — Entry: strip → trailing ＋. Does: new empty workspace + switch to it. ＋ is also a drop target. ☐
- **Rename** — Entry: double-click a tab name OR right-click → "Rename". Does: inline Input; Enter/blur commits, Escape cancels. ☐
- **Copy name** — Entry: right-click → "Copy name". Does: clipboard + toast. ☐
- **Close (X / context menu)** — Entry: tab X (hover/active; hidden if only 1 workspace) OR right-click → "Close" (disabled if ≤1). Does: sets a close-confirmation target (request, not immediate). ☐
- **Drop pane onto existing tab** — Entry: drag a pane → drop on a tab. Does: moves pane into that workspace. Drop-target ring while dragging; non-pane drags ignored. ☐
- **Drop pane onto ＋ → new workspace** — Entry: drag a pane → drop on ＋. Does: creates a workspace seeded with the pane + switches to it. ☐

### File Viewer (single `<Dialog>`, read-only — three toolbar toggles + context menu)
- **Open file (content fetch)** — Entry: any of the 3 mount sites opening it. Does: `POST /api/read-file`; renders one of loading/error/plain-source/plain-rendered-markdown/line-jump/annotate/history. ☐
- **Rendered ⇄ Source toggle** — Entry: title bar → "Rendered"/"Source" (only for `.md`/`.markdown`). Does: switches between rendered docs and raw source; honored in plain + historical-snapshot views. State is App-owned + persisted (NOT reset on close). ☐
- **Annotate (git blame) toggle** — Entry: title bar → "Annotate". Does: fetches `/api/git-blame` (cached); renders provenance gutter (hash/author/date at each blame-run boundary). Mutually exclusive with History. API: `GET /api/git-blame`. ☐
- **Blame/History hash → per-file commit diff popover** — Entry: click a cyan hash. Does: fetches what that commit did to THIS file (`/api/git-show?hash&path`) → DiffBlock + commit body. Per-hash cache. ☐
- **History (file commit log) toggle** — Entry: title bar → "History". Does: fetches `/api/git-log?path=&limit=20` (`git log --follow`); newest-first list; each row has a hash popover + "view file at this commit" eye. Mutually exclusive with Annotate. ☐
- **View file at commit (snapshot)** — Entry: History → eye icon. Does: amber banner (←Back/hash/subject/author/date) over the full file blob at that commit; rendered or source per viewMode. API: `GET /api/git-cat-file?hash&path`. ☐
- **Syntax highlighting / line-jump + highlight** — Entry: implicit. Does: `languageFromPath`+`tokenizeCode` per-line color for supported exts (unsupported → plain mono); when `line` is set, scrolls target line to center + highlights. ☐
- **Context menu (Copy path / Copy filename / Copy content / Close)** — Entry: right-click FileViewer body. Copy content disabled while `displayedContent===null`. ☐
- **Title path display — NO breadcrumbs.** Single truncated `<span>`; path is display-only (not clickable). Prev/next diff-hunk nav, open-in-pane, follow/tail, and font control are **ABSENT (never implemented)**. ☐

### File open entry paths (traced — the field previous inventories got wrong)
- **A. Terminal Ctrl/Cmd-click (per-pane)** — Entry: any pane terminal → modifier-click a `path`/`path:line` token (probe underlines it first). Opens per-pane FileViewer bound to THAT pane's chat/cwd, scrolled to the line. API: `POST /api/file-exists` probe + FileViewer fetches. **Primary "open a file from a terminal" path.**
- **B. PaneGrid discovery (search / browse / type-a-path)** — Entry: right-click a pane → "Search workspace files" / "Browse files in directory" / "Open file from directory". Each scoped to the RIGHT-CLICKED pane's chat (`actingPaneId`), not focused. Selecting opens the grid FileViewer (grep result jumps to the line). APIs: `/api/search-files` / `/api/git-ls`.
- **C. Sidebar git panel (per-file open-file icon)** — Entry: sidebar chat row → git panel/commit/What's-new popover → file row → click the open-file icon → sidebar FileViewer bound to that chat. Sibling of the dirty-file diff click and conflicted-file conflict click.

### File browser dialog (mounted only in PaneGrid)
- **Browse directory tree** — Entry: pane context menu → "Browse files in directory". Does: `GET /api/git-ls?id=&dir=` (`git ls-files --exclude-standard`); lazily expanded tree; click a file → FileViewer + close. Honest error discipline (non-git cwd → red message, not fake "empty"). ☐

### Workspace search dialog (mounted only in PaneGrid)
- **Content search input / result row → FileViewer** — Entry: pane context menu → "Search workspace files". Does: `POST /api/search-files`; result rows `file:line:text`; click or right-click → FileViewer at that file+line (WARDEN-334). Checks `data.error` (not just `res.ok`). Context menu: Open in file viewer / Copy matched line / Copy file path / Copy file:line. ☐

### Diff viewer (two mount sites, three modes)
- **Single-file working-tree diff** — Entry: sidebar dirty-file / expanded-commit / What's-new → click a GitChangedFile. Does: `GET /api/git-diff?id=&path=[&staged=1]`; "staged" chip when staged; distinguishes loading/error/untracked/empty. Conflict file → ConflictView instead. ☐
- **Aggregated range diff (unpushed/incoming/uncommitted)** — Entry: branch-badge popover "full diff" buttons. Does: `GET /api/git-range-diff?id=&range=outgoing|incoming|worktree`; titles the modal accordingly; worktree shows a DiffStatChip. ☐
- **Context menu (Copy path [disabled range] / Copy filename [disabled range] / Copy diff / Close)** — Entry: right-click DiffViewer body. ☐
- **DiffBlock (shared primitive)** — stateless colorized unified-diff renderer; used by blame popover, CollisionCompare panels, expanded commits — "no second classifier." ☐

### Conflict / collision compare
- **ConflictView (read-only ours-vs-theirs)** — Entry: click a conflicted GitChangedFile. Does: `GET /api/git-conflict?id=&path=` (stage blobs `:2:` ours / `:3:` theirs) → two side-by-side panes; handles loading/error/empty/absent-side. Strictly a VIEW — no merge editor, no `--ours/--theirs`, no `git add`. Context menu: Copy path/filename/"ours"/"theirs"/Close. ☐
- **CollisionCompareDialog (cross-agent "Compare edits")** — Entry: collision popover → "Compare". Does: fans one `GET /api/git-diff` per contributor (`&range=outgoing` for an impending committer) via `Promise.allSettled`; each result a collapsible `AgentDiffPanel` (name/host/branch + DiffBlock + Open→jump); partial failure is per-panel. Read-only v1. ☐
- **A ↔ B working-tree overlap panel** — Entry: auto-rendered at top of CollisionCompareDialog when ≥2 agents. Does: single `GET /api/cross-agent-diff?idA=&idB=&path=` → `differ`/`identical`/`error`; "(showing first 2 of N)" note for >2. ☐
- **Per-agent panel collapse / jump-to-agent** — Entry: chevron (collapse/expand) / "Open" (closes dialog + opens that agent's chat). Skeleton placeholders during load. ☐

### Rough edges in this area
- **No FileViewer feature is orphaned** — all 3 mount sites (PaneTile Ctrl+click, PaneGrid search/browse/path-entry, ChatSidebar git open-file) are reachable.
- **FileViewer toolbar leaner than expected — ABSENT (never implemented, not orphaned):** breadcrumbs, open-in-pane, follow/tail, font control, prev/next diff-hunk navigation.
- **Path-entry dialog rejects `..`/`~`** — intentional path-traversal guard; absolute/home-relative paths typed by hand are refused (browse + Ctrl+click bypass it by enumerating/probing real files).
- **Workspace close is a "request" through a confirmation target**, not an immediate close (intentional).
- **No viewer/dialog in this area is unreachable.**

## Area 5 — Fleet health, attention, activity, watch

_Sources: `HealthDashboard.tsx`, `AttentionBadge.tsx`, `ActivityTimeline.tsx`, `FleetActivityHeatmap.tsx`, `WatchCatchup.tsx`, `HealthBadge.tsx`, `StatusDot.tsx`, `Sparkline.tsx`, `App.tsx` (header + return banner)._

### Header status dot
- **WebSocket connection dot** — Entry: header → StatusDot left of AttentionBadge. Does: green solid "Connected" / red ring "Disconnected" (shape + color cue + aria-label). ☐

### Attention badge & popover
- **AttentionBadge trigger** — Entry: header → alarm-glyph button + count. Does: renders NOTHING when the fleet is truly idle; else `TriangleAlert`+`total` (problems) or `CheckCircle2`+`done.length` emerald (all-finished, WARDEN-575). Tone red/yellow/emerald. Click opens popover. Rollup polls `/api/health`, `/api/activity/stats`, `/api/agent-states(/fleet)`. ☐
- **Directed "You're needed HERE" callout** — Entry: popover → top bordered headline. Does: single ranked answer (WARDEN-384) + reason + live duration suffix + "open →". Rendered only when `calloutTop` non-null AND `ranked.length>=2`; `calloutTop` is focus-EXCLUDED (never the pane you're reading). Click deep-links into the pane. ☐
- **Sectioned ranked rundown** — Entry: popover → scrollable list. Sections (severity order): Critical / Stuck / Erroring / Warnings / Waiting on you / Blocked / Watch patterns / Finished / Pending directives (LinkRow→Activity) / Recent errors (LinkRow→Activity). Each agent row: dot+name+role+host+detail+live duration; click deep-links. Only Critical & Warnings rows carry the mute bell. ☐
- **Per-agent mute/snooze bell (Critical & Warnings rows only)** — Entry: row → bell icon (only when `attentionDesktopAlerts` master on). Does: nested menu — Mute permanently + time-boxed snooze (1h / until tomorrow); or "End snooze now"/"Resume alerts" when suppressed; countdown while snoozed. Icon swaps Bell/BellOff/Clock. stopPropagation. Client state only. ☐
- **Mute/snooze visual suppression** — Entry: same rows after mute/snooze. Does: opacity-60 + name line-through. ☐

### Return banner (full-width blue bar — App.tsx:1637-1710)
- **"You're needed in X" callout** — Entry: top of app (appears once after a >60s absence, within a 30s return window, when there's content). Does: ghost Button + reason + "open →" + state dot. Click deep-links. Notes: uses the raw ranked `top` — **NOT focus-excluded** (deliberate divergence from the badge callout). No `>=2` gate here. ☐
- **"While you were away" tally** — Entry: banner, right of callout. Does: counts from `/api/activity/stats?after=<lastClose>` fetched once on mount (never re-fetched) — directives sent / sessions attached / errors / total. ☐
- **"View Activity" button** — Entry: banner → right cluster. Does: expands observer panel + sets external view to Activity timeline. Notes: **the header proper has no View-Activity button** — only the banner (and attention-popover LinkRows / observer tab) expose it. ☐
- **Dismiss (×)** — Entry: banner far-right ×. Does: suppresses for the rest of the session. ☐

### Watch catch-up banner (amber bar — always mounted, renders null when empty)
- **WatchCatchup banner** — Entry: amber bar below the return banner. Does: surfaces per-chat watch pings lost while away (OS-notification channel unsupported/denied/cleared/DND); header summary + one ghost row per miss (dot + reason + "open →"). Reads durable localStorage miss log + reconciles against current watched states (suppresses misses whose chats recovered — WARDEN-476). Re-read on mount + every visibilitychange→visible. ☐
- **Row open (per-key ack) / dismiss (×, ack-all)** — Entry: click a miss row / top-right ×. Does: row → deep-link via `openChat` + ack that key (also acked at the `openChat` chokepoint so ANY open path clears misses); × → `stampWatchSeen` (ack-all). ☐

### Health dashboard (right panel — fixed `HEALTH_WIDTH`=320px)
- **Panel toggle (header "Health" button) / refresh (↻) / close (×)** — Entry: header "◂/▸ Health" / panel header ↻ / ×. Does: expand/collapse; ↻ one-shot `GET /api/health`; × collapses. Notes: **↻ is the ONLY manual refresh — there is NO manual ping/re-probe button.** Per-host connectivity is auto-polled by the shared 30s `/api/hosts/status` singleton. ☐
- **Group-by toggle (Health | Host)** — Entry: panel header button group. Does: groups by health state (default) or host; lifted to App + persisted. ☐
- **Fleet summary bar** — Entry: strip under header. Does: `total · healthy · warning · critical · idle · closed` color-coded. API: `/api/health` (10s poll). ☐
- **Health-mode sections (Healthy/Warning/Critical/Idle/Closed/Unknown)** — Entry: Group-by=Health → one section per non-empty bucket. Does: header icon+title+true count. ☐
- **Section select-all checkbox** — Entry: section header checkbox. Does: tri-state — selects/deselects exactly the RENDERED ids in that section. ☐
- **Closed-section bounding + expansion** — Entry: "Closed Sessions" when count>5. Does: capped 5 most-recent collapsed / up to 20 expanded (WARDEN-245); "show more/less"; header count shows true total. ☐
- **Host-mode per-host header / collapse / select-all** — Entry: Group-by=Host → per-host block. Does: 2-line header (chevron + connectivity StatusDot incl. latency + label + health distribution + rolled-up "X% cpu · Y% mem"); click toggles collapse; checkbox selects rendered ids on host. Connectivity auto-polled. ☐
- **Agent row (shared)** — Entry: any visible agent row. Does: click/Enter/Space → deep-link into chat. Contents: selection checkbox (subtle until active) · HealthDot glyph · name · role badge · host tag (health mode only) · activity sparkline (yatfa only) · last activity · ResourceChip (CPU%/mem, amber≥80/red≥90) · TokenChip (lifetime token spend). ☐
- **Per-row sparkline (WARDEN-299)** — Entry: inline in yatfa agent rows. Does: compact SVG bar series of last 24h activity (hourly); error buckets red; idle container draws flat baseline. Data: `/api/activity/series` (60s cadence). Read-only. ☐
- **Selection action bar (WARDEN-371)** — Entry: pinned bottom when ≥1 selected. Does: count + **All** (rendered ids) / **Clear** / **Interrupt** (→KeySendDialog) / **Kill** (→KillDialog). Notes: **health panel bar is a strict subset — no Broadcast, no Snooze** (sidebar-only). ☐
- **Kill… confirm + fan-out** — Entry: action bar → "Kill N…" → KillDialog → Confirm. Does: `POST /api/kill` per target + re-discover each host + re-fetch health; toast (gated `notifyChatOps`); clears selection. ☐
- **Interrupt… confirm + fan-out (WARDEN-492)** — Entry: action bar → "Interrupt" → KeySendDialog → Confirm. Does: sends Ctrl-C/Esc per target (non-destructive); toast; clears selection. ☐
- **"Last updated" timestamp** — Entry: panel footer. Does: time of last `/api/health`. ☐

### Activity timeline (rendered in the observer panel's external 'activity' view)
- **Activity tab entry** — Entry: header "View Activity" (return banner) / attention-popover LinkRows / observer tab strip. Does: `openActivityTab` expands observer + sets external view to Activity; renders `ActivityTimeline`. API: `/api/activity?limit=`. ☐
- **Live/Pause toggle / Refresh** — Entry: timeline header buttons. Does: Live → polls on cadence while tab visible (visibility-gated); Pause stops; Refresh one-shot. API: `/api/activity?limit=`. ☐
- **Type/Host/Agent/Limit filters** — Entry: header Selects. Does: compose; Limit (50/100/500/1000) re-fetches. ☐
- **"Showing X of Y · Updated Ns ago"** — Entry: header muted line. Does: filtered/total + "Paused"/"Updated Ns ago" (1s ticker). ☐
- **Time-bucketed event list** — Entry: scrollable body. Does: groups into Last hour/Today/Yesterday/This week/Older; per-event type-colored icon + label + timestamp + host badge + per-type detail (directive/attached/error/lifecycle/killed/spawned/resumed…). ☐
- **Per-event context menu** — Entry: right-click an event. Does: Copy details / Copy directive (when present) / Filter submenu (to this type/host/agent). ☐

### Fleet activity heatmap (top of the health panel scroll area)
- **Collapse/expand** — Entry: "Fleet activity · 24h" header button (chevron; defaults OPEN; local state, not persisted). ☐
- **Heatmap matrix** — Entry: expanded body. Does: `role="grid"` rows=agents/cols=24 hourly buckets; cell opacity ∝ volume (red for error buckets); "now" labels the last column. Data: `/api/activity/series`. Pure renderer. ☐
- **Row/cell accessibility + tooltips / legend / empty state** — Entry: Tab through rows; hover cells. Does: rows keyboard-focusable with full aria-label; cells have per-bucket title tooltips; legend (opacity ramp + red error swatch); empty state "No agent activity…". ☐

### Shared primitives
- **StatusDot** — variants solid/ring/square/pulse/glyph, tones green/red/yellow/gray/muted/cyan; label required (WCAG). Used by header, health host dot, HealthDot, + out-of-area. ☐
- **Sparkline** — dependency-free SVG bar series; used by HealthDashboard per-agent rows only. ☐
- **HealthBadge** — Notes: **ORPHANED — zero importers anywhere in `web/src`** (the dashboard uses `HealthDot` = a StatusDot glyph variant, not HealthBadge). **Confirmed by grep.** Dead code.

### Rough edges in this area
- **HealthBadge.tsx ORPHANED** (confirmed — zero importers).
- **No manual ping/health-probe trigger** — the only user-triggered refresh is ↻ (re-fetches `/api/health`); per-host connectivity is auto-polled only. If a "ping this host" control was intended, it's absent.
- **Return-banner callout is NOT focus-excluded** (deliberate divergence from the badge callout — easy to mis-read).
- **Header has no "View Activity" button** — it's the return banner / attention-popover LinkRows / observer tab.
- **TokenChip join is acknowledged-stale** (matched by cwd+host — multiple roles for one repo may show the heaviest role's spend; surfaced in tooltip).
- **`useHostStatuses` is a singleton but only HealthDashboard consumes it in-scope** — the sidebar still runs its own separate 30s `/api/hosts/status` poll (dedup not yet realized).
- **HealthDashboard action bar is a subset** — Kill + Interrupt only, no Broadcast/Snooze (by design).

---

## Area 6 — Observer

_Sources: `ObserverTabs.tsx`, `ObserverPanel.tsx`, `ObserverMarkdown.tsx`, `DirectiveHistory.tsx`, `SessionTranscriptViewer.tsx`; backend `src/observer.js`, `src/server.js`._

### Observer panel entry & tabs (right resizable section)
- **Show/hide (header toggle)** — Entry: header → "toggle observer" icon button (◂/▸); also via `Alt+O` from the pane grid. Does: flips `observerCollapsed` (animated width 0; persists). Collapsed panels stay mounted (CSS hidden) so WebSockets stay alive. ☐
- **Resize handle** — Entry: 1px drag handle on the LEFT edge. Does: changes `observerWidth`; clamped vs viewport/sidebar/health. ☐
- **Sessions / Activity / Directives tab switcher** — Entry: top of ObserverTabs → three pills. Does: switches body between observer-chat sessions, ActivityTimeline, DirectiveHistory; selection persists. `externalViewMode='activity'` can deep-link to Activity (App.tsx:1370); **no external deep-link to Directives.** ☐
- **New observer session — 👁 "observe <focused chat>" / ＋ blank** — Entry: Sessions tab header → 👁 (disabled when no chat focused) / ＋. Does: 👁 POSTs a session bound to the focused chat; ＋ an unbound session. New session prepended, auto-opened. API: `POST /api/sessions`. ☐
- **Session tab strip (switch / close)** — Entry: Sessions tab → pill per open session. Does: click activates (only active visible; inactive CSS-hidden, WS kept alive); × closes the tab client-side. Notes: **[RECONCILED 2026-07-20 — FIXED]** closing a tab now `DELETE`s the server-side session (`ObserverTabs.tsx:151`) — was client-only. See Consolidated #8. ☐

### Observer chat stream (per-panel, one WS per tab)
- **Status / context bar** — Entry: top of each ObserverPanel. Does: StatusDot (green Connected / red error) + bound-chat context (eye + container/chatKey @ host) or "drafts directives you approve"; yellow "taking longer than expected…" at the 10s loading timeout. Notes: **NO model display anywhere in the observer UI** — the model is resolved entirely server-side and never echoed. ☐
- **Conversation message stream** — Entry: panel scrollable body. Does: 5 item kinds — `user` (right "You"), `observer` (left markdown + streaming caret), `tool` (ToolChip), `meta` (centered pill: connected/stopped/reconnecting/error), `card` (directive proposal). Auto-stick-to-bottom + "Jump to latest". Empty/connecting/error states. ☐
- **Composer (text input)** — Entry: panel bottom → Textarea ("Ask the observer… (Enter to send, Shift+Enter newline)"). Does: auto-grows to 160px; Enter sends. On send: WS `{type:'user', text, panes}` where `panes` is read from the DOM (`[data-pane-id]`). Notes: this is a meta-chat — you instruct the observer, which *proposes* directives as cards; you don't type directives here. ☐
- **Send / Stop / Reconnect buttons** — Entry: composer footer. Does: Send (disabled unless conn+!busy+trim); Stop (closes WS + "Stopped" meta + suppresses auto-reconnect); Reconnect (when !conn+!busy → reopens WS). ☐
- **Summarize quick action** — Entry: composer footer left → "Summarize". Does: sends canned "summarize what everyone is working on" directly. ☐
- **Reconnect / connection-timeout affordances** — Entry: in conversation area. Does: 10s → "taking longer…"; 15s → hard `connectionError` + toast; non-user-initiated close → in-flight stream flagged for retry + auto-reconnect after 1.5s. Reconnect reopens `/api/observe?sid=` WS. ☐
- **Per-message affordances (copy / regenerate)** — Entry: hover a message → action bar; right-click → ContextMenu (Copy; Regenerate on observer msgs). Regenerate re-sends the last user turn (append-only, no branching). Copy fails silently if clipboard unavailable. ☐

### Directive draft / approve flow (every send gated; mode from `observerConfirmMode` `always` vs `auto-safe`)
- **Directive card — Approve & send** — Entry: a "proposed directive" card → "Approve & send". Does: WS `gate_decision {approved:true}` → card flips to "Sent" (green check) → backend sends the directive + logs it. In `auto-safe`, read-only directives (leading verbs list/read/show/…) auto-send, no card (still logged). ☐
- **Directive card — Edit (then approve)** — Entry: card → "Edit" → Dialog. Does: pre-filled textarea; "Approve & send" sends `gate_decision` with `edited`; Cancel just closes (does NOT decline). ☐
- **Directive card — Decline / context menu** — Entry: card → "Decline" / right-click card. Does: Decline → `gate_decision {approved:false}` → "Declined" (red X) + activity event; context menu: Copy directive / Copy agent. ☐

### Tool calls rendering
- **Tool chip** — Entry: inline in the timeline whenever the observer calls a tool. Does: small chip mapped from tool id — `list_chats`/`read_chat`/`read_chats`/`send_directive` (→"compose directive"); `write_file` + unknown fall through to `name.replace(/_/g,' ')`. Right-click: Copy tool name / argument. Notes: **tool RESULTS are not rendered** (backend UI-history reconstruction drops `tool_result` blocks; you see the observer's summary). **`write_file` is unlabelled** (a real tool in the system prompt, missing from `TOOL_LABELS`). ☐

### Directive history (Directives tab)
- **Read-only history** — Entry: ObserverTabs → "Directives". Does: lists every directive that reached an agent (full text) from `directives.md`; grouped Last hour/Today/Yesterday/This week/Older; green "sent" tag + timestamp + container@host + role + scrollable markdown body. API: `GET /api/directives?limit=`. ☐
- **Live/Paused toggle / Refresh** — Entry: header buttons. Does: Live polls on cadence (refreshes on tab-visibility regain); Paused stops; Refresh manual. ☐
- **Filters (Host / Agent / Limit)** — Entry: header Selects. Does: Host/Agent filter client-side; Limit (50/100/500/1000) re-fetches. Stats line "Showing X of Y · Updated Ns ago · Paused". ☐
- **Directive entry context menu** — Entry: right-click a row. Does: Copy directive text / agent@host / timestamp; Filter to this agent/host. ☐

### Session transcript viewer (mounted in OpenChatBrowserPage, NOT the observer panel)
- **Open transcript (eye)** — Entry: OpenChatBrowserPage → a past-session row → EyeIcon. Does: opens `SessionTranscriptViewer` Dialog for `{id,host,label}`. API: `GET /api/claude-session?id=&host=`. ☐
- **Dialog states & content** — Entry: the dialog. Does: loading skeletons → ready bubble list (user right/assistant left via ObserverMarkdown) / error / empty; per-turn amber token chip (hover breakdown input/output/cache-write/cache-read/total); visible-total token banner. ☐
- **Load earlier messages (backwards pagination)** — Entry: top → "↑ load earlier messages" (while `hasMore`). Does: fetches next-older bounded byte-window via `before=<cursor>` + prepends preserving scroll. ☐
- **Truncated notice / Close** — Entry: inline banner / footer "Close" (or Dialog X/overlay). Does: notice when `truncated`; close resets state. ☐

### Observer settings/controls (in Settings → Observer section; live-flow into ObserverTabs)
- **Auto-start Observer toggle / Session Auto-stop (min) / Directive Confirmation mode** — (see Area 7.) ☐

### Rough edges in this area
- **[RECONCILED 2026-07-20 — write_file FIXED] Tool results not rendered** (intentional); ~~**`write_file` tool unlabelled** (missed affordance)~~ — `write_file` is now in `TOOL_LABELS` (`ObserverPanel.tsx:1000`). See Consolidated #13.
- **[RECONCILED 2026-07-20 — FIXED] ~~Closing an observer tab does NOT delete the server-side session.~~** Now calls `DELETE /api/sessions/:id` (`ObserverTabs.tsx:151`). See Consolidated #8.
- **Session-transcript viewer is only reachable from the chat-history browser**, not the observer panel.
- **No external trigger for the Directives tab** (Activity has one via `externalViewMode`; Directives doesn't).
- **[RECONCILED 2026-07-20 — FIXED] ~~Stale "ZERO behavioral consumers" comment in `observerLifecycle.ts`.~~** Comment corrected (past-tense timeline). See Consolidated #21.

## Area 7 — Settings

_Source: `SettingsPage.tsx` (3,222 lines). Full-screen overlay from header ⚙. Left nav rail (13 sections) on `md+`, dropdown below `md`. Footer Cancel / Save._

**Two persistence channels (read first — explains "Save"):** (1) **Server config** (`GET/PUT /api/config`; committed only on footer **Save** then page closes): hosts, pollIntervalMs, tmuxSession, connectTimeout, observer*, llm, health thresholds, tokenBudget*, companionTransport, confirmDestructiveActions, notify*, Display (show*), telemetry*, webhook*, watchPatterns. (2) **Client UI prefs** (props+setters from App; applied **instantly**, persisted by App's save effect — NOT by Save, NOT reverted by Cancel): theme, density, paneLayout, onExitBehavior, autoFocusNewPane, restoreOnStartup, terminal*, copyOnSelect, timestampFormat, defaultNewChat*, customPresets, snippets, defaultShell*, hostLabels, rememberWindowBounds, launchAtLogin, closeToTray, attentionDesktopAlerts, attentionStates, alert*. **Three write-only secrets** (observer/webhook/telemetry auth tokens) show only a masked `set (…tail)`; sent on Save only when non-empty.

### Header / nav
- **Back to dashboard / title / section picker** — Entry: header back arrow (Ghost, "Back to dashboard"); "Settings" title; nav rail (13 entries) or `<md` dropdown. Active section not persisted. A 14th section (Reset) is rendered but NOT in the nav (see rough edges). ☐

### Hosts & Connection (`hosts`)
- **Configured Hosts (click × to remove)** — Entry: badge list; "No hosts configured" empty. Does: click removes from `config.hosts`. ☐
- **Add Host** — Entry: Select of `availableHostsToAdd` (SSH hosts minus configured); only rendered when a candidate exists. Does: appends to `config.hosts`. ☐
- **Display label per host** — Entry: one Input per host (incl. "this machine (local)"). Does: writes `hostLabels` **client-only — never sent to backend** (explicit comment). Blank = raw host name. ☐
- **Dashboard Refresh Interval (ms)** — Entry: number input `min=10000 max=120000 step=5000`. Does: `setConfig({pollIntervalMs})`. Notes: **the displayed value AND the runtime cadence are both resolved, not raw** — the field renders `resolvePollIntervalMs(config.pollIntervalMs)` (`SettingsPage.tsx:1510`) and the App feeds the same resolver into both refresh `setInterval`s (`App.tsx:670` → `:834`/`:881`). The resolver (`web/src/lib/pollInterval.ts`, WARDEN-394, unit-tested in `web/pollInterval.test.mjs`) maps absent/sub-floor/`1500` → `60000`, passes `10000–120000` through, clamps `>120000` to `120000`; the UI's `min=10000` prevents entering 1500. So **the value shown IS the cadence you get** (helper text at `SettingsPage.tsx:1516` says so explicitly). The only raw-`1500` scraps are the `config.js`/CLI default (the CLI's own watch mode reads it raw at 1500ms) and the Settings state-seed/`onChange` fallback — neither is what the field displays. Reads as well-behaved + documented, not a gap. ☐
- **Tmux Session Name / Connect Timeout (s)** — Entry: text / number (`min=1 max=60`, default 10). Server config. Notes: **[RECONCILED 2026-07-20 — PARTIAL]** `connectTimeout` is now backend-clamped `[1,60]` (WARDEN-747, `config-schema.js:86`) — the `onChange` is still a bare `parseInt`, so the clamp is backend-side (999 persists as 60). See Consolidated #17. ☐

### Observer Preferences (`observer`)
- **Directive Confirmation** — Entry: Select `[always (default) | auto-safe]`. Does: `auto-safe` auto-sends read-only directives. ☐
- **Auto-start Observer** — Entry: Switch (default off). Does: focusing a chat pane spawns a bound observer session. Server config. ☐
- **Session Auto-stop (minutes)** — Entry: number `min=1 max=180`; empty=disabled. Server config. No clamping. ☐
- **Observer model sub-panel (Model / Base URL / Auth token / Max tokens)** — Entry: 4 inputs. Does: round-trip `config.llm`; `[1m]` tag auto-stripped; token write-only; applies live to next observer call. Notes: **this is the ONLY place the model is surfaced** (the observer panel itself never shows it). ☐

### Safety (`safety`)
- **Confirm before destructive actions** — Entry: checkbox (default on). Does: gates force-kill + kill-chat confirmations. Does NOT gate the "Reset preferences" confirm. ☐

### Attention thresholds (`attention`)
- **Warning after (min) / Critical after (min)** — Entry: number inputs (defaults 5/30). Does: warning→critical boundary (critical is the desktop-alert trigger). On blur, client clamps warning down to critical when inverted (WARDEN-374) + red hint. ☐

### Token budget (`tokenbudget`)
- **Enable budget alerts (master) / Fleet threshold / Window (hours) / Per-session threshold** — Entry: checkbox + 3 numbers (defaults off / 2,000,000 / 24 / 1,000,000). Does: alarm only **notifies** (toast + desktop alert) — never auto-kills/pauses. Counts are model-agnostic tokens, not dollars. The 3 numbers are visually disabled when master off but stay editable in state. ☐

### Performance (`performance`)
- **Companion transport `[experimental]`** — Entry: checkbox (default off). Does: routes remote tmux ops through one persistent SSH channel; takes effect next op; remote-only. Notes: **inert when `companionTransportOverridden` (env `WARDEN_COMPANION_TRANSPORT` set at boot)** — checkbox disabled + notice. ☐

### Telemetry (`telemetry`)
- **Base tier (anonymous errors/crashes/freezes) / Extended tier (also chat & session names)** — Entry: Switch / Switch (extended disabled while base off; turning base off revokes extended). Server config. Chat content is never sent — names only. ☐
- **Telemetry sending status (read-only banner)** — Entry: derived. Does: hidden when base off; amber "Enabled, but nothing is being sent." when base on + blank endpoint; green "Configured — events will go to <host>" when base on + endpoint set (not a reachability claim). `role=status`. ☐
- **Receiver endpoint / Receiver auth token (write-only)** — Entry: text / password. Does: token sent as `Authorization: Bearer`; editing either clears the test verdict. ☐
- **Test connection** — Entry: outline button → "Testing…". Does: `POST /api/telemetry-test` with the **in-memory draft** (works before Save). Multi-line colored verdict; never persisted. Disabled while testing/blank endpoint. ☐
- **Telemetry transparency panel** — Entry: last in section (read-only). (Detail in Area 8.) ☐

### Display (`display`) — 5 checkboxes, server config
- **Show host tags / Show type badges / Show status indicators** (default on) · **Show project badges** (default off) · **Hide offline hosts** (default off). ☐

### Appearance (`appearance`) — all client UI prefs (instant)
- **Terminal font size** — number `min=8 max=24`; blur clamps 8-24, NaN→14. Same value as per-pane A−/A+. ☐
- **Terminal font family** — Select (System default, Cascadia Code, JetBrains Mono, Fira Code, Source Code Pro, Menlo, Consolas) + **"Custom…"** sentinel → free-text. Applies live. ☐
- **Terminal scrollback (lines)** — number `min=100 max=100000`; blur clamps, NaN→10000; default 10000. New panes only (existing pick up on reopen). ☐
- **Theme** — Select: System + Light group (GitHub Light, Light+ VS Code) + Dark group (GitHub Dark, Dark+ VS Code, Catppuccin Mocha, Dracula, Nord, One Dark). Live. ☐
- **Terminal color scheme / cursor style / Copy on select / Density / Timestamp format / Pane layout / When an agent exits / Auto-focus pane on open / Restore workspace on startup** — Entry: Selects/Switches. Does: scheme `[auto|dark|light]`; cursor `[blink|steady]-[block|underline|bar]`; copy-on-select default off; density `[comfortable|compact]`; timestamp `[relative|absolute]`; layout `[auto|stacked|side-by-side]`; on-exit `[keep|dim|auto-close]`; auto-focus default on; restore `[previous|empty]`. All instant. ☐
- **Remember window position & size / Launch at login / Close to tray** — Entry: Switches (default off). Notes: **disabled when `!hasWindowBridge()`** (browser/dev/smoke) — desktop-app-only, main-owned via IPC. ☐

### New Chats (`newchats`) — all client UI prefs
- **Default agent type** — Select `[claude (default) | shell | <custom presets>]`; deleted-preset default renders disabled "<name> (deleted)". ☐
- **Custom presets (list + add form)** — Entry: per-row inline name/command Inputs + Trash; add form (name + command + "Add preset"). Does: names can't reuse built-ins `claude`/`shell`; rename/delete keeps default in sync + updates per-host overrides. ☐
- **Default host / Default shell / Default shell per host / Default cwd / Agent type per host / cwd per host** — Entry: Selects/Inputs. Does: per-host overrides; "Use global default" sentinel deletes the key; stored host/preset no longer available renders disabled "(no longer available)/(deleted)" and falls back. ☐

### Instruction snippets (`snippets`) — client UI prefs (used in Broadcast insert + pane right-click send)
- **Snippet list + add form** — Entry: per-row name Input + instruction Textarea + Trash; add form (name + instruction + "Add snippet", Cmd/Ctrl+Enter). Does: `validateSnippetName` (empty/too-long/duplicate); names unique; starter examples ship on new installs. ☐

### Watch patterns (`patterns`) — server config (matcher runs server-side in pollAgentStates; matches only over output already captured for watched chats — no extra SSH)
- **Pattern list + add form** — Entry: per-row name Input + enable Switch + expression Input + mode Select `[text|regex]` + Trash; add form. Does: keys on stable `id`; capped `WATCH_PATTERN_MAX_COUNT`; regex validated (`isValidRegex`) with inline hint + toast; new patterns start enabled, default mode string; matching case-insensitive. ☐

### Notifications (`notifications`) — MIXED channels (see rough edges)
- **Chat operations / Errors / Success messages / Observer events** — Entry: 4 Switches (server config `notify*`, default on). Does: toast gating. ☐
- **Desktop alerts when agents need attention (master)** — Entry: Switch (client pref). Does: on enable → `requestAlertPermission()` (OS prompt); denied → toggle still flips but alerts no-op until granted. Fires OS notification when an agent newly needs attention while Warden unfocused. ☐
- **Per-pane-state attention toggles** — Entry: 5 Switches (client pref, default on): Erroring / Stuck / Waiting on you / Blocked / Finished. ☐
- **Per-severity desktop routing** — Entry: 4 Switches (Critical / Warning / Pending directives / Recent errors), greyed when master off. Notes: per-agent muting uses the bell on the attention row (health signals only; directives/errors aren't per-agent). ☐
- **Webhook push sub-panel (Enable / URL / Shared secret write-only / Which-alerts 3 Switches / Send test alert)** — Entry: bordered sub-panel. Does: secret sent as `Authorization: Bearer` + `X-Webhook-Secret`; 3 alert Switches (Attention/Budget/Finished, default on). Notes: **[RECONCILED 2026-07-20 — FIXED]** "Send test alert" now works BEFORE Save — sends the DRAFT `webhookUrl` + secret (`useBackendConfig.ts:320`–`:332`), same as Telemetry's Test connection. See Consolidated #20. ☐

### Reset section (danger zone)
- **Reset preferences to defaults** — Entry: **Reset** section (rendered outside the nav rail — always visible at the bottom of every section). Does: destructive button → ConfirmDialog → `resetUiPrefsToDefaults()` (snaps every **client UI pref** to default; **not** server config; preserves open tabs/panes/focus/layout); always confirm-gated regardless of Safety pref. ☐

### Footer
- **Cancel** — outline button (disabled while saving) → `onClose()` without saving server config (client prefs already live, NOT reverted). ☐
- **Save** — primary button → `PUT /api/config` (merges write-only secrets when non-empty) → `onConfigChange()` → close. Only persists server config. ☐

### Rough edges in this area
- **[RECONCILED — INTENTIONAL] ~~Reset section orphaned from the nav rail.~~** By design — always-visible-at-bottom is intended (`SettingsPage.tsx:41`–`:43`). See Consolidated #16.
- **[RECONCILED 2026-07-20 — PARTIAL] ~~Numeric inputs are not range-clamped on either side.~~** `connectTimeout` is now backend-clamped `[1,60]` (`config-schema.js:86`, WARDEN-747) and `tokenBudget*` floored at 1 (WARDEN-773); but `observerSessionTimeout`/`tokenBudget*`/`health*` still accept oversized values (no universal upper clamp). See Consolidated #17.
- **Save/Cancel only affect server config** — most user-facing prefs are client-side (instant, persisted by App); Cancel doesn't roll them back, Save doesn't commit them — a split not surfaced in the UI.
- **[RECONCILED 2026-07-20 — FIXED] ~~Notifications section mixes two persistence channels with no divider.~~** Now THREE titled bordered channel containers, each documenting its persistence path (WARDEN-784). See Consolidated #19.
- **3 desktop Switches inert outside Electron** (window bounds / launch-at-login / close-to-tray).
- **Companion transport inert under env override.**
- **Host labels never sent to backend** (client-only).
- **Auth fields are write-only** — no "remove secret" control (blank on Save no-clobbers).
- **[RECONCILED 2026-07-20 — FIXED] ~~Webhook "Send test alert" gated behind Save.~~** Now sends the DRAFT (`useBackendConfig.ts:320`–`:332`); testable before Save, same as Telemetry's Test connection. See Consolidated #20.

---

## Area 8 — Dialogs, global search, telemetry, open-chat browser

_Sources: `GlobalSearchDialog.tsx`, `BroadcastDialog.tsx`, `KeySendDialog.tsx`, `KillDialog.tsx`, `SnoozeDialog.tsx`, `TelemetryTransparency.tsx`, `OpenChatBrowserPage.tsx`._

### Global search dialog (Ctrl+Shift+F)
- **Search-across-panes dialog** — Entry: header ⌕ button OR global `Ctrl+Shift+F` (App.tsx:593-602). Does: cross-pane text search; query Input + Search (Enter submits); results in 40vh ScrollArea (pane name/host/matched text + before/after context); auto-focus input on open (Radix open-auto-focus suppressed); resets on close. API: `GET /api/search-pane?query=&panes=`. Treats both `!res.ok` and `data.error` as failure (a capture-pane failure ≠ fake "No results"). Empty states present. ☐
- **Result-row click → focus pane + jump to match** — Entry: click a row. Does: `onFocusPane` then `onJumpToMatch(key, query)` then close. ☐
- **Result-row context menu** — Entry: right-click a row. Does: Open / Copy matched line / Copy pane name / Copy host (Electron-safe copy + toast). ☐

### Broadcast dialog (confirm-and-send to N)
- **Send-to-N confirm gate** — Entry: sidebar multi-select action bar → "Send to N…" (mounted in all 3 sidebar views); ALSO collection-detail header one-click "Broadcast {N}" (auto-selects all matching + opens pre-targeted). Does: safety gate (WARDEN-292); title "Send to N agent(s)"; full Recipients list (name/type/host/role); Cancel / Send to N; sends on resolve; close blocked while sending. API: `POST /api/send` per target (`Promise.allSettled`). Notes: **NOT mounted in HealthDashboard** (out of scope there). ☐
- **Snippet picker (insert-only)** — Entry: dialog → "Insert snippet" Select (only when `snippets.length>0`). Does: fills the Textarea; does NOT auto-send. ☐
- **Message textarea + ⌘/Ctrl+Enter send** — Entry: Textarea (autoFocus). Does: free-text; bare Enter = newline; nothing sent until confirm. ☐

### Key-send dialog (confirm-and-interrupt)
- **Interrupt-N / send-key confirm gate** — Entry: sidebar multi-select action bar → "Interrupt N…"; ALSO HealthDashboard action bar. Mounted in all 3 sidebar views. Does: non-destructive framing (WARDEN-492); title/button verb tracks key ("Interrupt N" for C-c / "Send Esc to N" for Escape); full Targets list; Cancel / `<verb> N`; ⌘/Ctrl+Enter confirms; defaults to C-c + resets on open; info note (only foreground process signaled; session+scrollback survive). API: `POST /api/key` per target. Notes: **key vocabulary bounded to exactly C-c + Escape** — no arrow keys, no Enter, no other keys (deliberate FE guard: "control vocabulary only"). ☐

### Kill dialog (confirm-and-stop batch)
- **Stop-N confirm gate** — Entry: sidebar multi-select action bar → "Kill N…"; ALSO HealthDashboard action bar. Mounted in all 3 sidebar views. Does: destructive gate (WARDEN-328); "Stop N agent(s)?"; full Targets list; red callout (tmux session killed; container keeps running; yatfa re-discovered, manual forgotten); Cancel / destructive Stop N; always shown. API: `POST /api/kill` per target. Notes: this is the **multi-select batch** kill gate — distinct from App's `ConfirmDialog` single-row kill (both reachable). ☐

### Snooze dialog (confirm + duration bulk)
- **Snooze-N confirm + duration gate** — Entry: sidebar multi-select action bar → "Snooze N…". Mounted in all 3 sidebar views; NOT in HealthDashboard. Does: gate (WARDEN-581); "Snooze N agent(s)"; full Targets list; duration Select bounded to **1h / until tomorrow** (default 1h, reset on open); **permanent mute deliberately absent in bulk**; non-destructive info note; Cancel / Snooze N. API: **none** (pure client state via `snoozeMany` → one UiState write). Notes: the per-row bell in AttentionBadge still offers permanent mute (bulk dialog doesn't). ☐

### Telemetry transparency (read-only, in Settings → Telemetry section, last)
- **"What each tier collects" catalog / event types & fields / identifier + hard-excluded content fields** — Entry: always-visible cards/chips. Does: two `TierSummaryCard`s (Base / Extended "requires base", "your tier" badge); per-event structural-field chips; identifier fields (retained at extended, dropped at base) + "Never collected" content/prompt chips. ☐
- **Sample-event preview tier toggle (Base / Extended)** — Entry: segmented control. Does: compares the SAME sample event across tiers; defaults to current effective tier; "current" badge; re-runs `previewPayload`. ☐
- **Validity + redaction summary badges** — Entry: under the toggle. Does: `schema-valid|invalid`; redaction summary ("N path, N host, N secret redacted" or "nothing redacted"); "N content field dropped"; name summary. ☐
- **Enumerated redaction diff** — Entry: "What redaction did (N)". Does: itemizes every `PreviewChange` (content dropped / name dropped|retained / redacted · category [×N]) + field path. ☐
- **"Show exact transmitted payload" disclosure (default expanded) / "Show original sample event (input)" (default collapsed)** — Entry: ghost disclosure buttons. Does: toggle `<pre>` of the redacted JSON payload / the raw `SAMPLE_ERROR_EVENT` fixture. Notes: **zero API calls by design** — pure renderer over pure functions; sample event is a hardcoded fixture, never transmitted. ☐

### Open-chat browser page (full-screen overlay — App.tsx:1786-1800)
- **Open / close** — Entry: open = sidebar "↗ Open chat…" button (`setChatBrowserOpen(true)`); close = page header back ArrowLeft OR Escape (defers to an open transcript viewer via `defaultPrevented`). Does: replaces the dashboard. ☐
- **Fleet token-usage summary (header)** — Entry: header, when `fleetTotals.total>0`. Does: `☁ <total> · <N> host(s)` + per-host tooltip (model-agnostic, not dollars). Derived from per-row tokenUsage (`/api/claude-sessions-all`). ☐
- **Budget progress chip (header)** — Entry: only when `budget.enabled && threshold>0`. Does: spent/threshold + fill bar + over%; tone red when breached, amber ≥80%; tooltip (window label, spent/threshold/percent, `topOffender`). Reads App's `/api/budget` snapshot. ☐
- **Host scope multiselect chips** — Entry: row of host chips (each with online/offline/unknown StatusDot). Does: toggles host in/out of scope; persists `localStorage`; resolution persisted→usual-hosts→all; clicking a new non-local host fires discover. API: `/api/discover`. ☐
- **"Offline (N)" expander** — Entry: only when "Hide offline hosts" pref on + ≥1 offline SSH host. Does: expands/collapses hidden offline chips inline; visibility-only. ☐
- **Search input (live + history, full-content)** — Entry: Input ("Search live + history sessions…"). Does: non-empty → 300ms debounce → full-content search; clears stale on new query; matches as history rows with snippet; empty restores instant top-40. API: `GET /api/claude-sessions-search?q=`. ☐
- **"usage" sort toggle** — Entry: `usage` button. Does: toggles sort by heaviest **lifetime** token usage first (recency tiebreak; no-usage sink). Seeded by `initialSortUsage` (budget-breach deep-link sets it true). ☐
- **Merged list — live session row** — Entry: per active chat on a selected host. Does: green dot + name + timestamp + host tag + `live` label; click → `onOpenChat` + close. Live resume-key sessions dedupe vs history (8-char sid prefix). ☐
- **Merged list — history (resumable Claude) session row** — Entry: per Claude history session. Does: cyan ring dot + label (summary or "cwd · host") + optional content snippet + timestamp + optional amber token badge + host tag + 3 actions. Per-row token usage flows only from the All-Sessions list (content-search rows carry none — honest). ☐
- **Budget-offender row marker (⚑ offender)** — Entry: auto-applied to the row matching `budget.topOffender` while `budget.alerted`. Does: red ring + "⚑ offender" + tooltip (in-window heaviest the alert deep-linked to; explains why it may sit below an older larger-lifetime session under usage sort). ☐
- **"View transcript" (read-only) — eye button** — Entry: history row → EyeIcon. Does: opens `SessionTranscriptViewer` (Area 6). API: `GET /api/claude-session?id=&host=`. ☐
- **"↻ resume" — bump history session to live** — Entry: history row → "↻ resume" (or click the label); disabled while another resume in flight. Does: `onResume` then close; skeleton on the button. API: `POST /api/resume` (`claude --resume <id>` in tmux). ☐
- **"↓ load more" pagination** — Entry: bottom of list (only when not searching AND `hasMoreSessions` AND non-empty). Does: appends next page (size 40) of cross-host recency timeline; dedupes by `host:id`. API: `GET /api/claude-sessions-all?offset=&limit=40`. ☐
- **Initial load / on-open refresh** — Entry: implicit on mount. Does: fetches page 1 + fire-and-forget discovers each effective non-local host. ☐

### Rough edges in this area
- **KeySendDialog key set narrower than backend allows** — only C-c + Escape (deliberate FE guard; no arrow/Enter/other keys despite the broad `ALLOWED_KEYS`).
- **SnoozeDialog has no permanent-mute** (deliberate; per-row bell still has it).
- **HealthDashboard action bar is a strict subset** — Kill + Interrupt only (no Broadcast/Snooze).
- **KillDialog vs ConfirmDialog duplication** — batch kill uses KillDialog; single-row kill uses App's ConfirmDialog (both reachable, correct for scope).
- **TelemetryTransparency makes zero API calls by design** (hardcoded fixture, never transmitted).
- **No truly orphaned/unreachable dialogs found** — every dialog has ≥1 reachable trigger.

## CLI surface

`warden` is a separate user-facing surface (the dashboard is `warden ui`). From `warden help` (all UNVERIFIED-live except `ui`/`dev` which are the same server booted-green above):

| Command | What it does | Human review |
|---|---|---|
| `warden scan [--host H] [--json]` | discover chats (● active, ○ idle) | ☐ |
| `warden tail <id> [-f] [--lines N]` | print pane; `-f` = live watch (redraw) | ☐ |
| `warden send <id> <message...>` | send a chat message (+ Enter) | ☐ |
| `warden key <id> <C-c\|Escape\|Up\|...>` | send a special key | ☐ |
| `warden attach <id>` | attach interactively (full PTY) | ☐ |
| `warden dash [--host H]` | one tmux with a window per active chat | ☐ |
| `warden observe` | the meta-chat observer (GLM) that watches agents + sends approved directives | ☐ |
| `warden ui [--port N] [--open]` | web dashboard (chats + live panes + observer) | ☐ (boot-green) |
| `warden dev` | vite (5173, HMR) + node api (7421) together | ☐ |
| `warden config [list\|path\|init\|edit]` | manage `~/.yatfa-warden/config.json` | ☐ |
| `warden version` / `warden help` | version / help | ☐ |

`<id>` is any unique substring (yatfa-planner, planner, my-shell…). Hosts come from `~/.yatfa-warden/config.json`. Note: the CLI's `key` command advertises a broader key vocabulary (`Up`, …) than the UI's KeySendDialog (C-c / Escape only) — see Area 8.

---

## Consolidated — suspected-broken / half-wired / orphaned surfaces

These are the highest-signal items for the human review — surfaces that, from the code, look like they won't behave as a user expects. Each was flagged by an area pass; the four marked **✅ confirmed** were independently re-verified by grep/boot. None have been driven live, so each is a hypothesis to confirm in the browser walk — but they are the most likely "feels broken" findings this exercise exists to surface.

### Highest-impact (likely user-visible gaps)
1. **[RECONCILED 2026-07-20 — FIXED] ~~Collection view shows NO git context per agent.~~** The asymmetry is gone. The collection drill-in's `ChatRow`s now receive the FULL git prop set: `ChatSidebar.tsx:1022` (active) and `:1026` (idle) pass `gitInfo`/`gitCommits`/`gitLogLoading`/`onFetchGitLog`/`incomingCommits`/`incomingLoading`/`onFetchIncoming`/`outgoingCommits`/`outgoingLoading`/`onFetchOutgoing`/`onOpenDiff`/`onOpenConflict`/`onOpenFile` — identically to the host-view rows at `:1163`/`:1167`. Only the open handler differs (`openFromCollection` vs `openFromHost`). The same agent now shows full git badges + dirty-file diffs in both views. (Original cites `:916`/`:920`/`:1034`/`:1038` drifted as the file grew.)
2. **✅ Checked — NOT a gap (corrected during the review pass). Dashboard Refresh Interval is well-behaved.** An earlier draft inferred a displayed-vs-runtime mismatch from the raw `1500` config/CLI default + the `onChange` `|| 1500` fallback. That was wrong: the field displays `resolvePollIntervalMs(config.pollIntervalMs)` (`SettingsPage.tsx:1510`) and the App runs the SAME resolver into both refresh `setInterval`s (`App.tsx:670`), so the value shown IS the cadence you get, and the UI's `min=10000` blocks entering 1500. The resolver (`web/src/lib/pollInterval.ts`, WARDEN-394, unit-tested in `web/pollInterval.test.mjs`) maps `1500`/sub-floor → `60000`. Verified live in the reviewer sandbox (field showed 60000 with floor-documented helper text). Kept here, not deleted, so the slice-by-slice pass doesn't re-chase a bug that isn't there.
3. **FIXED (WARDEN-759) — `keep` on-exit previously left a misleading "Connecting" dot.** The StatusDot is now keyed on `agentExited` (set on a genuine live→exited transition for BOTH `dim` and `keep`), so a `keep` pane whose agent has exited shows a neutral gray "Exited" dot instead of the yellow pulsing "Connecting" dot. Dot-only override: the body stays full-brightness (no opacity-60, no "agent exited" overlay) — those remain `dim`-only. (PaneTile.tsx StatusDot render + exit effect.)
4. **[RECONCILED — BY-DESIGN] No manual ping / health-probe trigger.** The health panel's only user-triggered refresh is ↻ (re-fetches `/api/health`); per-host connectivity is auto-polled only (shared 30s `/api/hosts/status` singleton). There is no "ping this host now" button anywhere — by design (auto-poll is the intended model). Not a gap.
5. **[RECONCILED — BY-DESIGN] Two "you're needed in X" callouts behave differently.** The attention-badge callout is focus-excluded (never the pane you're reading); the return-banner callout is NOT (uses the raw ranked top) and can promote the focused pane. Deliberate divergence — not a bug.

### Orphaned / dead code (renders nothing harmful, but unused)
6. **[RECONCILED 2026-07-20 — FIXED / REVIVED] ~~`GitStateBadges` / `GitStateBadge` / `GIT_STATE_KIND` — ORPHANED.~~** No longer dead code. `GitStateBadges` is imported (`ChatSidebar.tsx:58`) and actively rendered in BOTH fleet views — the host-view header at `:1142` and the collection-view header at `:1388` (WARDEN-635 re-homed the fleet WIP ±N/↑N/↓N badges here after the project-chip row was abolished). `GIT_STATE_KIND` glyph/color conventions are also reused by `FileViewer.tsx:679`. Has live consumers now.
7. **[RECONCILED 2026-07-20 — STILL-TRUE / OK as dead code] `HealthBadge.tsx`** — re-verified: zero importers anywhere in `web/src`; the dashboard uses `HealthDot` (a StatusDot glyph variant) instead. Confirmed orphan, harmless dead code (unlike `GitStateBadges`, which was revived — see #6).
8. **[RECONCILED 2026-07-20 — FIXED] ~~`DELETE /api/sessions/:id` is never called from the UI.~~** Closing an observer tab now deletes server-side. `ObserverTabs.tsx:151` calls `fetch(`/api/sessions/${id}`, { method: 'DELETE' })` from a shared `deleteSession` helper, and BOTH close paths — `closeTab` (`ObserverTabs.tsx:278`) and the idle-close tick — route through it (comments at `:143`/`:149`). The endpoint is no longer orphaned; closed sessions no longer linger.
9. **[RECONCILED — BY-DESIGN] ~~Retired grid-toolbar is an empty shell.~~** This is a normal one-line header, not a half-finished surface. `PaneGrid.tsx:708`–`:716` renders a focused-name label + flex spacer; WARDEN-563 deliberately retired the 🔍/📄 toolbar buttons into each pane's own context menu (where they act on the right-clicked pane, not the focused one) — documented in the comment at `:711`–`:716`. By design.

### Missing affordances a user might expect (absent, not broken)
10. **[RECONCILED 2026-07-20 — PARTIAL]** The **no pane-to-pane manual resize** clause is **FIXED**: `PaneGrid.tsx` renders WARDEN-660 draggable resize gutters — `col-resize`/`row-resize` strips + crossing pads at intersections + double-click-to-reset, driven by `paneColRatios`/`paneRowRatios` props. The **no within-grid drag reorder** clause is **STILL-TRUE / by-design**: pane drag (`PANE_DRAG_MIME`) is consumed ONLY by workspace-tab drop targets (`WorkspaceTabs.tsx:67`/`:74`/`:82`/`:85`/`:93`/`:128`/`:194`); dropping a pane in the grid does nothing. Split verdict: resize=FIXED, reorder=absent-by-design.
11. **[RECONCILED — BY-DESIGN / not-implemented] FileViewer is leaner than expected — absent:** breadcrumbs (path is a non-clickable span), open-in-pane, follow/tail, font control, prev/next diff-hunk navigation. Never implemented (not orphaned); a known not-implemented affordance, not a bug.
12. **[RECONCILED — BY-DESIGN] No model display in the observer UI** (resolved server-side, never echoed — the only place the model is visible is Settings → Observer → model sub-panel). By design.
13. **[RECONCILED 2026-07-20 — PARTIAL]** The **`write_file` tool unlabelled** clause is **FIXED**: `write_file` is now listed in `TOOL_LABELS` (`ObserverPanel.tsx:1000`) — it's a real first-class observer tool (`src/observer.js:104`; system prompt at `:45`) and was the one real tool missing from the chip map. (The `_→space` fallback already rendered "write file"; the explicit map entry matches the pattern of the other file-op tools.) The **Observer tool results are not rendered** clause is **BY-DESIGN**: the backend UI-history reconstruction intentionally drops `tool_result` blocks; you see the observer's summary, not raw `read_chat` output.
14. **[RECONCILED — BY-DESIGN] KeySendDialog (UI) key set is narrower than the backend** — only C-c + Escape; no arrow keys/Enter/other (the CLI `warden key` advertises the broader set). Deliberate FE guard (control vocabulary only).
15. **[RECONCILED 2026-07-20 — FIXED] ~~Past-session resume list hard-capped at 12 rows.~~** Now has a "show more" affordance (WARDEN-742). `ChatSidebar.tsx:223` holds `showAllSessions` state; `sessionPreview` slices to `SESSION_PREVIEW` (12) only when collapsed (`:506`–`:507`); the "show N more / show less" toggle renders at `:1256`. Same shape as the recently-closed list.

### Settings-specific inconsistencies
16. **[RECONCILED — INTENTIONAL] ~~Reset section is orphaned from the nav rail.~~** By design. `SettingsPage.tsx:41`–`:43` code comment: "Reset is intentionally absent here: it is always visible at the bottom of the content pane, outside the activeSection gating." Always-visible-at-the-bottom is the intended UX, not a nav bug.
17. **[RECONCILED 2026-07-20 — PARTIAL]** The flagship example is **FIXED**: the backend PUT was refactored into a per-field `CONFIG_FIELDS` guard registry (`src/config-schema.js`, WARDEN-773), and `connectTimeout` is now clamped to `[1,60]` (`config-schema.js:86`, WARDEN-747) — so `connectTimeout: 999` persists as 60, not 999 (test at `config-schema.test.js:159`). The `tokenBudgetThresholdTokens`/`windowHours`/`perSession` fields are `flooredNumber` → `Math.max(1)` (`config-schema.js:689`), and the health thresholds keep the WARDEN-374 client blur clamp + cross-field warning≤critical ordering. **But the general "no universal upper-bound clamp" is STILL-TRUE for several fields:** `observerSessionTimeout` (`config-schema.js:159`, type `nullablePositiveNumber`) and the `tokenBudget*`/`health*` fields accept arbitrarily large positive values — so an oversized `observerSessionTimeout=999` still types and persists, and HTML `min`/`max` remains advisory there. Smaller real gap remains; do not re-chase connectTimeout.
18. **[RECONCILED — BY-DESIGN] Save/Cancel only affect server config** — most prefs are client-side (instant, persisted by App); Cancel doesn't roll them back, Save doesn't commit them. The two persistence channels are now surfaced in the Notifications section UI (#19); the Settings footer split itself is by-design (not surfaced in the footer).
19. **[RECONCILED 2026-07-20 — FIXED] ~~Notifications section mixes two persistence channels with no divider.~~** The split is now visibly surfaced. `NotificationsSection.tsx` renders THREE titled bordered channel containers — "Channel 1 of 3 — In-app toasts", "Channel 2 of 3 — Desktop alerts", "Channel 3 of 3 — Webhook" — each with a description documenting its persistence path (server `/api/config` committed on Save vs client localStorage applied instantly). The two-channel persistence difference is now explicit (WARDEN-784 mirroring).
20. **[RECONCILED 2026-07-20 — PARTIAL]** The **webhook "Send test alert" gated behind Save** clause is **FIXED**: `useBackendConfig.ts:320`–`:332` `sendTestAlert` now POSTs the DRAFT `webhookUrl` + draft `webhookSecret` to `/api/webhook-test` (testable BEFORE Save; comment at `:314`–`:316`). The remaining clauses are **STILL-TRUE / by-design**: 3 desktop Switches inert outside Electron (window bounds / launch-at-login / close-to-tray); companion transport inert under env override; host labels never sent to backend (client-only); auth fields write-only with no "remove secret".

### Stale commentary (code correct, comments wrong)
21. **[RECONCILED 2026-07-20 — FIXED] ~~`observerLifecycle.ts` stale "ZERO behavioral consumers" comment.~~** Comment-only fix applied. The opening "ship dead in Settings" (present tense) was stale — the two prefs are fully wired post-WARDEN-332 via THIS module. The comment now reads "shipped dead in Settings (pre-WARDEN-332)" / "until this module, had ZERO behavioral consumers" / "This file is the extraction that wired them" (`observerLifecycle.ts:3`–`:11`), making the timeline unambiguous. No code-behavior change.
22. **[RECONCILED 2026-07-20 — FIXED] ~~`SettingsPage.tsx` subtitle hardcoded "Manage SSH hosts…".~~** Every section now has its own subtitle. `SETTINGS_SECTIONS` (`SettingsPage.tsx:44`–`:58`) carries a per-section `description` on every entry, rendered at `:125`. The "Manage SSH hosts…" string lives ONLY on the hosts entry (`:45`).

---

## Reviewer live-walk runbook

This inventory was assembled from code (the worker sandbox blocks Chromium). To convert UNVERIFIED → OK/BROKEN/CANT-FIND/SLOW, walk the running app in the **reviewer sandbox** (which can run Chromium — `agent-browser doctor` passes there). Suggested slice order, matching the areas above:

1. **Boot & shell.** `warden ui` (or `PORT=8431 node src/server.js` on a free port — 7421 may be squatted by a stale sidecar; verify the served JS hash matches a fresh `npm run build`). Confirm the header, 4-column layout, and that the WS status dot goes green.
2. **Sidebar (Area 1).** Open a chat → pane. Try +New spawn (local shell + claude). Right-click rows (open-pane menu, host menu, collection card menu). Create a collection → **drill into it and check whether git badges/dirty-file lists appear** (Consolidated #1). Filter & sort. Multi-select → each action-bar action.
3. **Git surfaces (Area 2).** On a chat with a real repo: click the branch badge → popover → expand a commit → expand a file → diff. Dirty file → diff → FileViewer open-file icon. Fleet commit search (Messages/Content/Code).
4. **Panes (Area 3).** All keyboard shortcuts. Right-click pane → Browse files / Search workspace / Open file from directory / Split shell here / Snippets. Force-kill vs close. Drag a pane onto a workspace tab. Check the `keep`-on-exit dot (#3). Confirm the **pane resize gutters now work** (drag a col/row gutter + double-click-to-reset, WARDEN-660); within-grid drag reorder is still absent (#10).
5. **File Viewer (Area 4).** The 3 entry paths: terminal Ctrl/Cmd-click a `path:line`; pane right-click → search/browse/type; sidebar git open-file icon. Annotate (blame) + History + view-at-commit. Confirm **no breadcrumbs/follow/open-in-pane** (#11).
6. **Health/attention/activity (Area 5).** Toggle health panel; group-by Health vs Host; expand a host; select agents → Interrupt/Kill. Trigger an attention state on a real agent → badge popover → ranked callout → mute/snooze bell. Return banner (close+reopen the app after >60s). Watch a chat, background the app, trigger a ping → watch catch-up.
7. **Observer (Area 6).** Toggle observer; 👁 observe focused chat; ask it something; when it proposes a directive → Approve / Edit / Decline. Directives tab. Activity tab. Confirm **no model shown** (#12). Close an observer tab and confirm the server-side session is now DELETED (#8, FIXED — was lingering).
8. **Settings (Area 7).** Walk all 13 sections. Toggle theme/density/font live. Refresh Interval field: confirm it shows the resolved cadence (60000 for the 1500 CLI default) and `min=10000` is enforced — this is NOT a gap (#2, already corrected + verified live). Notifications toggles. Webhook/Telemetry "Test" buttons — both now test the DRAFT before Save (#20, FIXED — webhook used to need Save first). Reset section visibility (#16).
9. **Dialogs & open-chat browser (Area 8).** Ctrl+Shift+F global search. Broadcast / Interrupt / Snooze / Kill from multi-select. Open-chat browser → resume a history session → view its transcript → usage sort → budget offender marker.

As you walk, overwrite each `☐` with the verdict. **CANT-FIND** on a documented entry path is the most valuable signal — it means the entry path traced from code doesn't actually reach the feature in the live app, which is exactly the discoverability gap this inventory exists to surface.

---

## Coverage notes / known limits of this pass

- **Not driven live.** Every `☐` starts UNVERIFIED. The backend is boot-green (all ~60 routes `200 OK`); the frontend reachability is what a browser walk must confirm.
- **Derived from the React render tree + backend routes**, read in full for every component in `web/src/components` (+ `App.tsx`, `sidebar/*`) and the route table in `src/server.js`. No feature was knowingly omitted; if a feature exists only in unreferenced dead code it may be absent here (the three confirmed orphans — `GitStateBadges`, `HealthBadge`, `DELETE /api/sessions/:id` — ARE listed, in the Consolidated).
- **Layout/visual claims are statically reasoned from the flex/grid model, not browser-measured** (worker sandbox blocks Chromium; deferred to the reviewer per WARDEN-130/WARDEN-68).
- **Related:** WARDEN-541 (bring the shipped app to order) — this inventory is the map for that effort.

