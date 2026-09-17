// Resolve WHICH container a manual tmux pane's foreground lives in, from the
// pane's own process tree (WARDEN-1377).
//
// The defect: a yatfa agent reached through a MANUAL tmux pane — the user
// docker-exec-attaches from a shell inside the pane — receives text fine, but a
// pasted image was written on the ssh host. A manual chat carries no `container`
// (chats.js/server.js both set `container: null`), so pasteImage.js took the
// plain-tmux host leg and the marker named `/tmp/warden/paste/…` on the HOST —
// a path the in-container agent can never read. Confirmed live on the user's
// host 2026-09-14: two pasted screenshots sat on the host while the agent's
// container had no /tmp/warden/paste at all.
//
// The mechanism, verified live with the user the same day: walking a pane's
// process tree (tmux `#{pane_pid}` → descendants via `pgrep -P`) exposes the
// container boundary directly in the command line —
//   `docker exec -it -u yatfa yatfa-planner-2 tmux attach -t agent`
// The user runs several planner containers concurrently and every pane resolved
// unambiguously to its own container. Two constraints the walk inherits from
// that session: the boundary can sit TWO levels deep (bash → zsh → docker
// exec), so the traversal is bounded-depth rather than a direct-children check;
// and the host is macOS, so the walk uses `pgrep -P` (works on macOS and
// Linux) — GNU `ps --ppid` does not.
//
// Delivery legs are UNTOUCHED: pasteImage.js already docker-execs when a
// container is known (remote+container, local+container). This module only
// supplies the missing container name. Catalog and yatfa chat shapes are
// untouched too — they carry a container already, and deliverPastedImage gates
// the resolution on `!chat.container`, so the shapes that already work can
// never reach it.
//
// When the evidence is absent or ambiguous the delivery falls back to today's
// host write, and the marker says so honestly (pasteImage.js buildMarker's
// `where: 'host'`): a marker must never name a path the agent cannot read.
//
// The builders and the decision rule are pure and exported so the whole
// pipeline is pinned by byte-exact unit tests without tmux, ssh, or docker —
// the buildReceiveScript precedent (WARDEN-1282), including the observed
// flags-before-container exec shape (`-it -u yatfa`).
import { spawn } from 'node:child_process';
import { captureAndSettle } from './childCapture.js';
import { shellQuote, runWithPool } from './ssh.js';
import { isCompanionTransportEnabled, isCompanionExcludedHost, deliverRemoteScript } from './companion.js';

const LOCAL = '(local)';

// How deep the walk may go BELOW the pane's root process (inclusive), and the
// timeout for one walk. The observed boundary sits two levels deep; 4 leaves
// headroom for a deeper nesting without ever being unbounded. The walk is one
// host-side script invocation — an ssh handshake dominates, so 10s is generous.
export const MAX_TREE_DEPTH = 4;
export const WALK_TIMEOUT_MS = 10_000;

// Resolution is cached PER PANE (host + tmux target) because a paste is a
// human-paced gesture but the walk must not re-run per paste either — one walk
// serves a burst. The TTL bounds the staleness the cache can cause: a user who
// detaches and attaches a DIFFERENT container inside the same pane is honored
// within 5 minutes. Tests clear it with clearPaneContainerCache().
export const RESOLUTION_TTL_MS = 5 * 60 * 1000;

// A docker container name's charset (and the length docker enforces); anything
// else fails CLOSED to "not a boundary" — a misparse must never deliver a user's
// screenshot into a guessed container.
const CONTAINER_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

// `docker exec` flags that CONSUME a following token, long and short forms.
// Everything else (`-i`, `-t`, `-d`, `--privileged`, `--rm`, …) is valueless.
const VALUE_LONG_FLAGS = new Set(['--user', '--env', '--env-file', '--workdir', '--detach-keys', '--hostname']);
const VALUE_SHORT_CHARS = new Set(['u', 'e', 'w']);

// ------------------------------ pure builders ------------------------------

// The ONE host-side script a resolution runs. Reads the target's current pane
// pid, then walks descendants level by level with `pgrep -P` (portable: macOS
// and Linux; GNU `ps --ppid` is not), printing one line per visited process:
//
//   depth<TAB>pid<TAB><raw `ps -o stat=,command=` output>
//
// `ps -o stat=,command=` (NOT `-o args=` / `--ppid`) because the stat column
// lets the decision rule drop a Ctrl-Z-suspended boundary in favor of the
// pane's live foreground chain, and the command column is where the `docker
// exec` boundary is visible verbatim. The stat field may be padded by ps to the
// header width; the parser tokenizes, so padding is harmless.
//
// POSIX sh throughout — it runs under `bash -lc` on remote hosts and `sh -c`
// locally. No `set -e`: every probe that can fail (`ps`, `pgrep`, a dead pane)
// must degrade to empty output, and the script exits 0 with EMPTY stdout when
// there is nothing to walk (no live pane = no boundary = honest 'none').
export function buildPaneTreeWalkScript(target, maxDepth = MAX_TREE_DEPTH) {
  const t = shellQuote(String(target));
  const d = Number.isFinite(Number(maxDepth)) ? Math.max(0, Math.floor(Number(maxDepth))) : MAX_TREE_DEPTH;
  return (
    `pid=$(tmux display-message -p -t ${t} '#{pane_pid}' 2>/dev/null | tr -d ' \\t\\r\\n')\n` +
    `[ -n "$pid" ] || exit 0\n` +
    `front=$pid\n` +
    `depth=0\n` +
    `while [ "$depth" -le ${d} ]; do\n` +
    `next=""\n` +
    `for p in $front; do\n` +
    `line=$(ps -p "$p" -o stat=,command= 2>/dev/null)\n` +
    `[ -n "$line" ] && printf '%s\\t%s\\t%s\\n' "$depth" "$p" "$line"\n` +
    `kids=$(pgrep -P "$p" 2>/dev/null | tr '\\n' ' ')\n` +
    `next="$next $kids"\n` +
    `done\n` +
    `front=$next\n` +
    `depth=$((depth + 1))\n` +
    `done`
  );
}

// Parse the walk's stdout into nodes. Tab-delimited by construction (the
// builder prints them), tolerant of everything else: blank lines, garbage
// lines, and ps's column padding on the stat field are all skipped or
// normalized rather than thrown on. The command is everything after the THIRD
// field, verbatim.
export function parseTreeWalkOutput(stdout) {
  const nodes = [];
  for (const raw of String(stdout ?? '').split('\n')) {
    const i1 = raw.indexOf('\t');
    if (i1 < 0) continue;
    const i2 = raw.indexOf('\t', i1 + 1);
    if (i2 < 0) continue;
    const depthField = raw.slice(0, i1);
    const pidField = raw.slice(i1 + 1, i2);
    if (!/^\d+$/.test(depthField) || !/^\d+$/.test(pidField)) continue;
    const rest = raw.slice(i2 + 1).trim();
    const sp = rest.search(/\s/);
    const stat = sp < 0 ? rest : rest.slice(0, sp);
    const command = sp < 0 ? '' : rest.slice(sp + 1).replace(/^\s+/, '');
    nodes.push({ depth: Number(depthField), pid: Number(pidField), stat, command });
  }
  return nodes;
}

// Pull the container name out of ONE process command line — the boundary
// detector. Returns the name only when the line really is a `docker exec`
// invocation and the first non-flag token is a well-formed container name;
// everything else returns null (fail closed).
//
// The flags-before-container shape the user's host actually produces is the
// case that names this function's tests: `docker exec -it -u yatfa
// yatfa-planner-2 tmux attach -t agent` — `-it` valueless, `-u` consuming
// `yatfa`, then the container. Combined short clusters (`-itu yatfa c`), the
// `=` forms (`--user=yatfa`, `-u=yatfa`), a path-prefixed docker binary, and a
// leading `sudo`/`doas` are all handled; a non-exec docker command (`docker
// run`, `docker ps`) is not a boundary.
export function extractDockerExecContainer(command) {
  const line = String(command ?? '').trim();
  if (!line) return null;
  const tokens = line.split(/\s+/);
  const base = (t) => t.split('/').pop();
  let i = 0;
  if (tokens[i] && (base(tokens[i]) === 'sudo' || base(tokens[i]) === 'doas')) i += 1;
  if (!tokens[i] || base(tokens[i]) !== 'docker') return null;
  if (tokens[i + 1] !== 'exec') return null;
  i += 2;
  while (i < tokens.length) {
    const tok = tokens[i];
    if (tok.startsWith('--')) {
      // `--flag=value` is self-contained; a bare value-taking flag eats the
      // next token; anything else is valueless.
      i += !tok.includes('=') && VALUE_LONG_FLAGS.has(tok) ? 2 : 1;
      continue;
    }
    if (tok.length > 1 && tok.startsWith('-')) {
      if (tok.includes('=')) { i += 1; continue; } // `-u=yatfa` — value inside the token
      i += VALUE_SHORT_CHARS.has(tok[tok.length - 1]) ? 2 : 1;
      continue;
    }
    return CONTAINER_NAME_RE.test(tok) ? tok : null;
  }
  return null;
}

// The decision rule over a whole walked tree. Boundaries are the visited
// processes whose command line is a docker exec; the rule, in order:
//
//   1. no boundary                        → { state: 'none' }        (agent is host-side)
//   2. exactly one boundary               → resolved                 (the pane's chain)
//   3. several                            → the pane's CURRENT FOREGROUND chain
//        decides: keep only the DEEPEST level (shallower boundaries are
//        finished or backgrounded leftovers), drop Ctrl-Z-suspended ones
//        (stat starts with T), and require ONE distinct container name to
//        remain. Anything else → { state: 'ambiguous', containers } and the
//        caller falls back to the honest host write.
//
// `containers` on the ambiguous arm is the sorted, deduped set of CONTENDERS —
// the names the rule could not decide between.
export function resolveContainerFromTree(nodes) {
  const boundaries = (nodes ?? [])
    .map((n) => ({ ...n, container: extractDockerExecContainer(n.command) }))
    .filter((n) => n.container);
  if (boundaries.length === 0) return { state: 'none' };
  if (boundaries.length === 1) return { state: 'resolved', container: boundaries[0].container };
  const maxDepth = Math.max(...boundaries.map((b) => b.depth));
  let candidates = boundaries.filter((b) => b.depth === maxDepth);
  const active = candidates.filter((b) => !(b.stat || '').startsWith('T'));
  if (active.length > 0) candidates = active;
  const names = [...new Set(candidates.map((b) => b.container))];
  if (names.length === 1) return { state: 'resolved', container: names[0] };
  return { state: 'ambiguous', containers: names.sort() };
}

// ------------------------------ the resolver -------------------------------

const resolutionCache = new Map(); // `${host}|${target}` → { at, resolution }

export function clearPaneContainerCache() {
  resolutionCache.clear();
}

// Resolve the container for a container-less manual chat, or say honestly why
// not. NEVER throws and NEVER decides on a guess: the outcome is one of
//   { state: 'resolved', container }   — deliver there
//   { state: 'none' }                  — no boundary found; the agent is host-side
//   { state: 'ambiguous', containers } — boundaries exist, the pane's foreground
//                                        chain does not settle one
//   { state: 'failed', reason }        — the walk itself could not run
// The caller (deliverPastedImage) treats everything but 'resolved' as today's
// host write, and uses 'ambiguous'/'failed' to qualify the marker.
export async function resolvePaneContainer(chat, cfg = {}, deps = {}) {
  const now = deps.now ?? Date.now();
  // The walk targets the SAME pane the paste's marker is keystroked into —
  // tmux.js send()'s `sess()` ladder (`chat.session || cfg.tmuxSession ||
  // 'agent'`), not chatMeta.js's paneTarget (no cfg leg). A chat with no
  // session has no pane to name, so the caller gates resolution on `session`.
  const target = chat.session || cfg.tmuxSession || 'agent';
  const key = `${chat.host}|${target}`;
  const hit = resolutionCache.get(key);
  if (hit && now - hit.at < RESOLUTION_TTL_MS) return hit.resolution;

  const r = await runWalk(chat.host, buildPaneTreeWalkScript(target), cfg, deps);
  let resolution;
  if (!r || !r.ok) {
    resolution = { state: 'failed', reason: ((r && r.stderr) || '').trim() || `walk failed (exit ${r ? r.code : -1})` };
  } else {
    resolution = resolveContainerFromTree(parseTreeWalkOutput(r.stdout));
  }
  resolutionCache.set(key, { at: now, resolution });
  return resolution;
}

// The transport for one walk. Remote hosts mirror discoverManual's routing
// (chats.js): companion channel when the toggle is on (companion-or-fail), the
// pooled ssh path otherwise. Local hosts spawn `sh -c` with runLocalTmux's
// discipline (captureAndSettle: 'close'-not-'exit, utf8 decode, bounded kill).
// Windows has no pgrep/ps to walk with — the local leg answers "nothing found"
// rather than guessing.
function runWalk(host, script, cfg, deps = {}) {
  if (host === LOCAL) {
    if (process.platform === 'win32') return Promise.resolve({ ok: true, code: 0, stdout: '', stderr: '' });
    return new Promise((resolve) => {
      let child;
      try {
        child = (deps.spawn ?? spawn)('sh', ['-c', script], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (e) {
        resolve({ ok: false, code: -1, stdout: '', stderr: String(e) });
        return;
      }
      const timer = setTimeout(() => { try { child.kill('SIGTERM'); } catch { /* noop */ } }, WALK_TIMEOUT_MS);
      captureAndSettle(child, resolve, {
        timer,
        onSpawnError: (err, stdout, stderr) => ({ ok: false, code: -1, stdout, stderr: stderr + String(err) }),
      });
    });
  }
  const companionOn = (deps.isCompanionTransportEnabled ?? isCompanionTransportEnabled)();
  return companionOn && !isCompanionExcludedHost(host)
    ? (deps.deliverRemoteScript ?? deliverRemoteScript)(host, script, { timeout: WALK_TIMEOUT_MS }, cfg, deps)
    : (deps.runWithPool ?? runWithPool)(host, script, { timeout: WALK_TIMEOUT_MS }, cfg);
}
