# Performance regression — app-wide freeze in 0.1.7 (WARDEN-147)

**Date:** 2026-07-12
**Release affected:** 0.1.7 (introduced by WARDEN-147, `feat(activity): capture cross-host agent lifecycle events`)
**Severity:** critical — the whole desktop app became unusable ("30s to open Settings", every interaction slow)

## Symptom

After upgrading to 0.1.7 the entire app — not just one view — became sluggish. Opening
Settings took ~30s; every interaction felt frozen. Reported across all parts of the UI.

## Root cause

Two problems compounded; WARDEN-147 was the trigger that turned a latent inefficiency
into a constant freeze.

### 1. New unconditional 60s full-fleet sweep (the regression)

WARDEN-147 added `startLifecyclePoll()` (`src/server.js`) which fires
`discoverAll(cfg.hosts, cfg)` on a blind `setInterval(…, 60_000)` — from startup,
forever, regardless of user activity — to feed the Activity timeline's cross-host
lifecycle diff. Before 0.1.7, `discoverAll` only ran on explicit CLI `scan` or while the
Observer was active. Now it runs automatically.

`discover()` does **one fresh SSH per active agent** (the activity-timestamp capture,
`src/chats.js` `discover()`). On Windows there is **no SSH ControlMaster multiplexing**
(`src/ssh.js` `getConnection()` short-circuits to `socketPath: null` on win32), so each of
those is a full `ssh.exe` TCP+auth handshake. The lifecycle sweep now duplicated the
frontend's own 60s discovery (`web/src/App.tsx`) and, if a tick exceeded 60s, ticks
**overlapped and piled up**.

### 2. Latent event-loop block the sweep exposed

`discoverAll` / `discoverHost` resolved the local catalog's alive/dead state with a
**synchronous `.map`** calling `runLocalTmux(['has-session', …])` — i.e. `spawnSync`
(`src/ssh.js`) — **once per local chat, in a tight loop**:

```js
entries.map((e) => ({ e, active: runLocalTmux(['has-session', '-t', e.session]).ok }))
```

Node is single-threaded: while that loop ran (plus a second per-active-session
`capture-pane` `spawnSync` loop), **every HTTP request queued behind it** — including the
`/api/config` call Settings opens with. With the new automatic 60s sweep (and the
frontend's own 60s `/api/discover?host=(local)`), the event loop froze on a timer.

## The fix (3 changes, backend only — `src/chats.js`, `src/server.js`)

1. **Batch local alive-detection.** Replaced the per-chat `spawnSync(has-session)` loop in
   both `discoverAll` and `discoverHost` with a single `tmux list-sessions -F
   '#{session_name}'` + JS `Set` membership (new helper `localAliveSessions()`).
   **N blocking spawns → 1**, regardless of catalog size. Same tmux socket, canonical
   enumeration.

2. **Lean lifecycle sweep.** `discover()` and `discoverAll()` take an `{ activity }` opt.
   `tickLifecycle` passes `{ activity: false }`, skipping the per-active-agent SSH
   (remote) and per-session `capture-pane` (local). The lifecycle diff needs only
   alive/dead **transitions** (`src/lifecycle.js`), never timestamps — so that per-agent
   work was pure overhead.

3. **Re-entrancy guard.** `tickLifecycle` is now a thin wrapper around `tickLifecycleBody`
   gated by a `lifecycleRunning` flag (`return tickLifecycleBody().finally(reset)`): a slow
   tick makes the next interval a no-op instead of stacking a second full-fleet sweep.

## Verification

Local Electron app (`npm run electron`) — backend forked from the patched `src/server.js`:

```
/api/config            (the call Settings opens with)   ~0.26 s   (was ~30 s)
/api/health                                                ~0.26 s
/api/discover?host=(local)   (frontend, every 60s)        ~0.30 s
/api/chats                                                 ~0.26 s
```

Boot clean, no native-module ABI error, window opens immediately. Confirmed working in the
real desktop app (local catalog chat `(local):chat-eo86pu` present → the previously-blocking
local path is exercised and now fast).

## Tests

`src/server-lifecycle.test.js` and `src/git-status.test.js` time out **on this Windows
machine** — confirmed to fail identically on the original 0.1.7 code (changes stashed).
Cause is environmental: every `spawnSync(tmux|git)` takes ~15 s in this shell, which is the
same pathology behind the user-visible freeze. The fix reduces spawn count, so it moves in
the right direction; the batched `list-sessions` logic is the canonical form and queries the
same socket the old per-chat `has-session` did.

## Follow-ups (not done in this change)

- `src/observer.js` `discoverAll(...)` runs its own periodic full-fleet sweep when the
  Observer is active. Pre-existing (not new in 0.1.7) but contributes to the same churn;
  could take the same `{ activity: false }` lean path.
- `[server] fatal: not a git repository … .git` log noise: `runLocalGit` inherits git's
  stderr, so a chat whose `cwd` is empty/non-repo logs a (handled, benign) `fatal` per
  git-status fetch. Cosmetic; swallow it in `runLocalGit`.
