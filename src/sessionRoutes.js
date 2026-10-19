import express from 'express';
import { loadCatalog, mutateCatalog, sameCatalogEntry } from './config.js';
import { hasSession, spawn as spawnTmux, kill as killTmux } from './tmux.js';
import { splitCmd, detectClaude, validateHost } from './ssh.js';
import { appendEvent } from './activity.js';
import { uninstallCompanion, recordCompanionUninstall } from './companion.js';

// Session lifecycle routes (/api/rename, /api/save-session, /api/spawn, /api/resume,
// /api/kill, /api/session-kill, /api/respawn, /api/companion/uninstall) and their
// helpers (resolveClaudeCmd, buildAndSpawn, appendEventSafe, NAME_RE), extracted
// verbatim from server.js (WARDEN-1868). Injected: the live `cfg` object (mutated
// in place), `local` (server.js's LOCAL const, aliased back inside the factory so
// the moved bodies stay byte-identical), the shared chat `resolve` (also handed to
// the git / user-data / chat-file routers), `preflightTmux` (still defined and
// exported by server.js), and the config-write pair `save`/`afterSave` plus the
// shared `afterSaveDeps` object — the same five afterSave dependencies the config
// router mounts with (WARDEN-1810's shape); /api/companion/uninstall's persist
// passes them through unchanged (WARDEN-1475).
export function createSessionRouter({ cfg, local, resolve, preflightTmux, save, afterSave, afterSaveDeps }) {
  const router = express.Router();

  // The moved bodies below read `LOCAL` verbatim; alias the injected dep so they
  // stay byte-identical.
  const LOCAL = local;

  // A tmux session id may be [A-Za-z0-9_-] only. `.` is deliberately ABSENT even
  // though tmux ACCEPTS it at creation: tmux silently rewrites `.` (and `:`) to
  // `_` (WARDEN-1422 QA — `new-session -d -s a.b.c` creates `a_b_c`), so a dotted
  // id would name a session warden can never find with `has-session`. Keeping the
  // class dot-free means every id we validate is byte-identical to the session
  // tmux actually creates.
  const NAME_RE = /^[A-Za-z0-9_-]+$/;

  // If cmd invokes bare `claude`, replace it with the full path found on the host —
  // claude is often in a .zshrc-only PATH that tmux's shell (bash) can't see, and on
  // Windows it is an npm `.cmd` shim that only a full path can launch (WARDEN-922).
  async function resolveClaudeCmd(host, cmd) {
    if (!/^claude(\s|$)/.test(cmd)) return { cmd };
    const claudePath = await detectClaude(host);
    if (!claudePath) return { error: `\`claude\` not found on ${host}. Install it or add its dir to PATH (e.g. ~/.local/bin).` };
    // A resolved path containing a space (routine on Windows: C:\Program Files\…)
    // must be quoted, or the argv split downstream would tear it into two args.
    // Unspaced paths — every Unix case — are emitted verbatim as before.
    const quoted = /\s/.test(claudePath) ? `"${claudePath}"` : claudePath;
    return { cmd: cmd.replace(/^claude(\s|$)/, (_m, sp) => `${quoted}${sp}`) };
  }

  router.post('/api/rename', async (req, res) => {
    const session = String(req.body?.session || '');
    const host = String(req.body?.host || LOCAL).trim() || LOCAL;
    const name = String(req.body?.name || '').trim().slice(0, 60);
    if (!session || !name) return res.status(400).json({ error: 'session and name required' });
    // Serialized read-modify-write (WARDEN-991). Composite identity: a session name
    // can repeat across hosts, so scope the find to host+session (host defaults to
    // local for callers that don't send it). Returning undefined when the entry is
    // absent skips the write and preserves the 404.
    const updated = await mutateCatalog((catalog) => {
      const entry = catalog.find((c) => sameCatalogEntry(c, host, session));
      if (!entry) return undefined;
      entry.name = name;
      return catalog;
    });
    if (!updated) return res.status(404).json({ error: 'not a renameable chat' });
    res.json({ ok: true });
  });

  // Save a temporary (unnamed) shell session — the recently-closed flyout's "save"
  // action (WARDEN-1422). Clearing the entry's `temporary` flag promotes it to a
  // persistent session: it stops being filtered from every listing and appears
  // under its host in the sidebar's saved list. Identity stays untouched — the
  // tmux session name, cwd and cmd are exactly what was running, so a save of a
  // still-running shell re-homes the SAME process under the host's saved list
  // (and a stopped one is respawnable from there). Idempotent: saving an
  // already-saved entry is a no-op that still answers ok.
  router.post('/api/save-session', async (req, res) => {
    const r = await resolve(String(req.body?.id || ''));
    if (r.error) return res.status(404).json(r);
    const chat = r.chat;
    if (chat.kind !== 'tmux') return res.status(400).json({ error: 'only spawned shell sessions can be saved' });
    const updated = await mutateCatalog((catalog) => {
      const entry = catalog.find((c) => sameCatalogEntry(c, chat.host, chat.session));
      if (!entry) return undefined;
      if (!entry.temporary) return catalog; // already saved — no write needed
      return catalog.map((c) => (sameCatalogEntry(c, chat.host, chat.session) ? { ...c, temporary: false } : c));
    });
    if (!updated) return res.status(404).json({ error: 'no saved session matches this id' });
    res.json({ ok: true, chat: { ...chat, temporary: false } });
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
      const bin = splitCmd(finalCmd || '')[0] || 'the command';
      return { error: `\`${bin}\` failed to start on ${host} — the session died immediately. Is it installed and on PATH there?`, status: 500 };
    }
    return { chat: { id: `${host}:${session}`, key: session, kind: 'tmux', host, container: null, session, project: 'manual', role: 'claude', name: chat.name, cwd, cmd: finalCmd, active: true } };
  }

  // WARDEN-1661 — the activity timeline is bookkeeping, not part of the action. The
  // human lifecycle routes (/api/spawn, /api/resume, /api/kill) append their event AFTER
  // the irreversible work (tmux session + catalog mutation) is done; a failing append
  // (full disk, EACCES, EISDIR) must not turn that success into a 500 (a retry would then
  // 409 "already exists"). The await is kept so the event is on disk before res.json.
  async function appendEventSafe(route, event) {
    try { await appendEvent(event); } catch (e) { console.error(`[warden] ${route}: activity-log append failed (action succeeded):`, e?.message || e); }
  }

  router.post('/api/spawn', async (req, res) => {
    const host = String(req.body?.host || LOCAL).trim() || LOCAL;
    const cwd = String(req.body?.cwd || '').trim();
    // WARDEN-1422 — the sidebar's spawn is a PLAIN SHELL (like opening a terminal):
    // host ▾ + directory + optional name. An OMITTED session name means the human
    // did not name it, so the session is TEMPORARY: a generated `shell-xxxxxx`
    // tmux name, cataloged with `temporary: true` so panes/kill still resolve, but
    // filtered from every LISTING (/api/chats, /api/discover, /api/health) —
    // unsaved sessions are never listed anywhere in the UI. A NAMED spawn is
    // persistent (listed under its host) exactly as before.
    const requestedSession = String(req.body?.session || '').trim();
    // A human-typed name may carry characters the tmux session id cannot (the
    // design's saved sessions are named things like "release train 0.1.75"), so
    // when the caller sent a NAME instead of an explicit session id, the id is
    // DERIVED from it (invalid runs → '-') and the raw text stays the display
    // name. An explicit `session` keeps the strict NAME_RE check.
    //
    // WARDEN-1422 QA: `.` is tmux-UNSAFE in a session name — tmux silently
    // rewrites `.` (and `:`) to `_` at creation (`tmux new -d -s a.b.c` creates
    // `a_b_c`), so an id that keeps `.` describes a session tmux does not have:
    // `has-session -t <derived>` then misses, the spawn is misreported as "died
    // immediately" while the REAL session lives on as an orphan (one per retry).
    // The derivation therefore maps every character outside [A-Za-z0-9_-] — the
    // dot included — to '-', so the id we check is byte-identical to the one
    // tmux created. The display name keeps the dot; only the id is normalized.
    const requestedName = String(req.body?.name || '').trim().slice(0, 60);
    const temporary = !requestedSession && !requestedName;
    // A temporary shell's name is GENERATED here (the caller deliberately sent
    // none); `newTempName` draws fresh candidates for the collision loop below.
    const newTempName = () => `shell-${Math.random().toString(36).slice(2, 8)}`;
    const derivedFromName = requestedName.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
    let session = requestedSession || derivedFromName || newTempName();
    // An OMITTED cmd defaults by naming: a temporary shell is a shell (empty cmd →
    // the host's own login shell, the WARDEN-223 semantics), a named spawn keeps
    // the historical claude default. An EXPLICIT cmd is honored as-is in both
    // paths (the split-shell / open-shell callers still pass theirs).
    const cmdRaw = req.body?.cmd;
    const cmd = (cmdRaw === undefined ? (temporary ? '' : 'claude --dangerously-skip-permissions') : String(cmdRaw)).trim();
    if (requestedSession && !NAME_RE.test(requestedSession)) return res.status(400).json({ error: 'invalid session name (letters/digits/_-)' });
    // Generate a unique name for a temporary shell, re-drawing on the (rare) same-host
    // collision with an existing catalog entry instead of 409ing — the caller never
    // chose the name, so a retry with a fresh draw is always the right answer.
    for (let tries = 0; temporary && tries < 5; tries++) {
      if (!(await loadCatalog()).some((c) => sameCatalogEntry(c, host, session))) break;
      session = newTempName();
    }
    // Pre-flight duplicate check: fail fast with a 409 BEFORE paying for a real
    // tmux/ssh spawn. Composite identity: the same session name may exist on a
    // DIFFERENT host (each host's tmux server is independent), so only a same-host
    // collision blocks spawn. This snapshot is deliberately NOT reused for the append
    // below — buildAndSpawn awaits a full spawn, and appending against a stale
    // snapshot across that window is exactly the lost-update bug (WARDEN-991).
    if ((await loadCatalog()).some((c) => sameCatalogEntry(c, host, session))) return res.status(409).json({ error: `"${session}" already exists` });
    const r = await buildAndSpawn({ host, session, name: requestedName || session, cwd, cmd });
    if (r.error) return res.status(r.status).json({ error: r.error });
    // Append under serialization with a FRESH read, and re-check the collision here:
    // a concurrent spawn of the same host+session may have landed between the
    // pre-check and now. Same 409 body/status as the pre-flight rejection.
    const appended = await mutateCatalog((catalog) => {
      if (catalog.some((c) => sameCatalogEntry(c, host, session))) return undefined;
      return [...catalog, temporary
        ? { kind: 'tmux', host, session, name: r.chat.name, cwd, cmd, temporary: true }
        : { kind: 'tmux', host, session, name: r.chat.name, cwd, cmd }];
    });
    if (!appended) return res.status(409).json({ error: `"${session}" already exists` });
    if (temporary) r.chat.temporary = true;
    // Record the human's own spawn action so a returning human can see the agents
    // they brought up (WARDEN-484). Mirrors the existing attached/ended row shape.
    await appendEventSafe('/api/spawn', { type: 'spawned', id: r.chat.id, host, container: r.chat.container ?? null, role: r.chat.role, name: r.chat.name });
    res.json({ ok: true, chat: r.chat });
  });

  router.post('/api/resume', async (req, res) => {
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
    // Serialized filter-then-append in ONE mutation (WARDEN-991) — split across two
    // catalog writes it would race a concurrent kill/spawn. Composite identity: only
    // replace THIS host's same-named resume entry; a different host may legitimately
    // carry the same resume-<sid> session name.
    await mutateCatalog((catalog) => [
      ...catalog.filter((c) => !sameCatalogEntry(c, host, session)),
      { kind: 'tmux', host, session, name, cwd, cmd: chat.cmd },
    ]);
    // Record the human's own resume action (WARDEN-484). container is always null
    // here (resume spawns a bare-tmux session), matching the existing row shape.
    await appendEventSafe('/api/resume', { type: 'resumed', id: out.id, host, container: null, role: out.role, name });
    res.json({ ok: true, chat: out });
  });

  router.post('/api/kill', async (req, res) => {
    const r = await resolve(String(req.body?.id || ''));
    if (r.error) return res.status(404).json(r);
    const chat = r.chat;
    // Kill the tmux session for ANY chat type (yatfa or spawned). For yatfa this
    // kills the agent's tmux session inside the container (container keeps running).
    try { await killTmux(chat, cfg); } catch { /* noop */ }
    // Remove from catalog (spawned chats only; yatfa are auto-discovered).
    // Serialized (WARDEN-991): a fleet batch-kill fires N concurrent POSTs, and
    // unserialized only ONE removal survived — every tmux session died but the
    // catalog kept ghosts that re-rendered in the sidebar until killed one at a time.
    // Composite identity: only drop the killed chat's own host+session entry — a
    // different host may carry the same session name and must be left intact.
    if (chat.kind === 'tmux') await mutateCatalog((c) => c.filter((x) => !sameCatalogEntry(x, chat.host, chat.session)));
    // Record the human's deliberate kill — the authoritative signal that lets a
    // returning human tell an agent THEY stopped apart from one that crashed. Emitted
    // here rather than via the attach-PTY onExit handler, which stays silent for
    // client-killed sessions (server.js:3339) — so this ALWAYS lands, even with no
    // attach-viewer open (WARDEN-484). yatfa chats carry no `name`, so fall back to
    // the container (the agent's display name) for a friendlier label.
    await appendEventSafe('/api/kill', { type: 'killed', id: chat.id, host: chat.host, container: chat.container ?? null, role: chat.role, name: chat.name ?? chat.container ?? null });
    res.json({ ok: true });
  });

  // Force-kill a tmux session (the running process, even if hung). Does NOT remove
  // from catalog — the chat can be re-spawned/resumed later. Different from Ctrl-C
  // (which just signals the foreground command) and from /api/kill (which also
  // forgets the chat).
  router.post('/api/session-kill', async (req, res) => {
    const r = await resolve(String(req.body?.id || ''));
    if (r.error) return res.status(404).json(r);
    try { await killTmux(r.chat, cfg); res.json({ ok: true }); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Re-create a chat's tmux session by re-running its command (WARDEN-231 recovery
  // panel → [Re-spawn agent]). Only chats warden owns — manual/spawned kind:'tmux'
  // with a stored `cmd` — are respawnable; yatfa chats have no cmd (their session
  // is managed by the running container) and are rejected. Kills any stale session
  // first (a dead session is a no-op for kill-session), then spawns under the SAME
  // session name so the existing pane/tab re-attaches by id. Does NOT touch the
  // catalog — the entry already carries the right cmd/cwd/host/session.
  router.post('/api/respawn', async (req, res) => {
    const r = await resolve(String(req.body?.id || ''));
    if (r.error) return res.status(404).json(r);
    const chat = r.chat;
    // WARDEN-1422: an EMPTY stored cmd is a valid command — the host's own login
    // shell (the plain-shell spawn, WARDEN-223) — and exactly what a stopped
    // saved shell must respawn with. Only a chat with NO cmd at all (yatfa/
    // legacy rows) is unrespawnable.
    if (chat.kind !== 'tmux' || chat.cmd === undefined || chat.cmd === null) {
      return res.status(400).json({ error: 'this chat has no command to re-spawn (only spawned tmux chats can be re-spawned)' });
    }
    const err = await preflightTmux(chat.host);
    if (err) return res.status(400).json({ error: err });
    // Clear any dead/stale session under this name before recreating it.
    try { await killTmux(chat, cfg); } catch { /* a dead session may not exist */ }
    // Resolve a bare `claude` cmd to its full path on the host — claude is often in
    // a .zshrc-only PATH (e.g. ~/.local/bin) that tmux's non-login shell can't see,
    // so spawning the raw catalog cmd verbatim makes the session die on start on the
    // very remote hosts this recovery path targets (the WARDEN-231 bug report). The
    // catalog stores the RAW user-typed cmd, so resolution must happen here at
    // respawn time. Mirrors buildAndSpawn / /api/resume (both resolve before spawn).
    const resolved = await resolveClaudeCmd(chat.host, chat.cmd);
    if (resolved.error) return res.status(400).json({ error: resolved.error });
    const spawnChat = { host: chat.host, session: chat.session, cwd: chat.cwd || '', cmd: resolved.cmd };
    try { await spawnTmux(spawnChat); }
    catch (e) { return res.status(500).json({ error: e.message }); }
    // `new-session -d` returns ok even when the inner command fails to start, so
    // verify the session actually came up — mirroring /api/spawn's check.
    if (!(await hasSession(spawnChat, cfg))) {
      const bin = splitCmd(resolved.cmd)[0] || 'the command';
      return res.status(500).json({ error: `\`${bin}\` failed to start on ${chat.host} — the session died immediately. Is it installed and on PATH there?` });
    }
    res.json({ ok: true });
  });

  // Remove warden's auto-bootstrapped companion binary from a remote host on
  // request (WARDEN-882 — the Removability outcome of roadmap WARDEN-270). The
  // write/action sibling of the Visibility slice: once installed, it can be taken
  // off. Mirrors install: uninstallCompanion kills the cached ssh child, then
  // rm -f's ~/.warden/companion-<ver> (and rmdir's ~/.warden only-if-empty) over
  // the SAME raw-ssh path bootstrap/probe use — no new port, no root. Body
  // {host}; the companion serves REMOTE hosts only, so LOCAL/(local) is rejected.
  //
  // Host-validation correction: this endpoint takes a HOST (not a chat id), so it
  // validates with validateHost(host, cfg) — the helper /api/hosts/health uses —
  // rather than resolve() (which resolves a chat id). Mirrors /api/kill's
  // {ok}/{error} response shape. Companion-or-fail: surfaces what failed via
  // {error}; it does not fall back to raw SSH. Not gated on the companion flag:
  // a host that had the flag on (then off) must still be cleanable, so the
  // endpoint works regardless of the current toggle state.
  //
  // WARDEN-1475: a successful removal is also PERSISTED (recordCompanionUninstall
  // + save + afterSave, below) so the uninstall survives the next lifecycle tick
  // and a restart. Response carries `excluded` — whether the host is now on the
  // persisted no-bootstrap list — so the UI can say the removal will hold.
  router.post('/api/companion/uninstall', async (req, res) => {
    const host = String(req.body?.host || '');
    if (!host || host === LOCAL) {
      return res.status(400).json({ error: 'a remote host is required (the companion serves remote hosts only)' });
    }
    // Validate the host the same way /api/hosts/health does, so an unreachable
    // host surfaces a clear connectivity message rather than an opaque ssh
    // failure from the uninstall run.
    try {
      const check = await validateHost(host, cfg);
      if (!check.ok) {
        return res.status(400).json({ error: check.error || `host ${host} is unreachable` });
      }
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }
    try {
      const result = await uninstallCompanion(host, cfg);
      if (!result.ok) {
        const stderr = (result.stderr || '').trim();
        return res.status(500).json({ error: stderr || `failed to remove companion on ${host}` });
      }
      // WARDEN-1475 — PERSIST THE REMOVAL. uninstallCompanion's writes are all
      // in-memory (channelCache / companionStatus / companionOps /
      // bootstrapFailures), so before this slice the very next ordinary op —
      // including the unconditional 60s lifecycle tick, which needs no human
      // gesture — re-uploaded the binary and respawned the channel: the
      // operator's removal was undone by the system within ~60 seconds, with no
      // error and no user-visible signal (roadmap WARDEN-270's Removability
      // outcome, "nothing gets installed that cannot be taken off").
      //
      // uninstallCompanion has ALREADY recorded the fact into `cfg` and applied
      // it to the live env gate (recordCompanionUninstall) — what is missing is
      // the DISK write, and that is exactly what this route owns: `save` /
      // `afterSave` live in this file's import graph, and keeping them out of
      // companion.js preserves uninstallCompanion's `deps.run`/`deps.manifest`
      // test seam. The call below is the idempotent backstop (it no-ops for the
      // host the uninstall just added), so the persist cannot silently depend on
      // WHERE the recording happened.
      recordCompanionUninstall(host, cfg);
      const persisted = cfg.companionExcludedHosts?.includes(host) ?? false;
      if (persisted) {
        // PUT /api/config's shape verbatim, so the removal takes effect live
        // (afterSave → applyCompanionExclusions re-serializes the env gate every
        // routing predicate reads) AND survives a restart, instead of one or the
        // other.
        await save(cfg);
      afterSave(cfg, afterSaveDeps);
      }
      res.json({ ok: true, excluded: persisted });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  return router;
}
