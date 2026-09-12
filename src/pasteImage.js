// Deliver a pasted clipboard IMAGE to where the agent lives (WARDEN-1282).
//
// The owner pastes an image into an agent pane with the SAME gesture as text.
// The image travels as a FILE, beside the terminal — never through it. Two tmux
// layers plus ssh carry TEXT; pushing image bytes through that pty would be
// corrupted by the terminal's own escape handling long before it reached disk.
// So only a short marker line crosses the pty (the renderer pastes it through
// the identical text path); the bytes take this module's route instead.
//
// This is `streamFileToHost`'s idiom (src/companion.js:482) extended ONE link.
// That function proved the shape — ssh argv from `buildSshArgv`, the payload on
// the child's stdin, a far side that is nothing but `mkdir -p … && cat > "…"` —
// but it stops at the HOST. A yatfa agent lives one layer deeper, inside a
// docker container, so the far side here becomes `docker exec -i <c> sh -c
// '<same script>'`: the exec's OWN stdin is the pipe, which is why it is `-i`
// and NOT the `-it` every other docker exec in this repo uses (a tty would
// line-discipline the binary and mangle it).
//
// Four chat shapes, one script:
//   remote + container → ssh host 'docker exec -i <c> sh -c "<script>"'
//   remote, no container → ssh host 'bash -lc "<script>"'   (plain-tmux host)
//   local  + container → docker exec -i <c> sh -c '<script>' (no ssh hop)
//   local, no container → a direct fs write (no child at all)
//
// WARDEN-1350 — under the companion transport the two REMOTE shapes stop
// spawning ssh per paste (this module was created on the raw-ssh pattern five
// days AFTER the generic exec RPC landed, un-pooled, one full handshake per
// paste): they ride the persistent channel's byte-carrying `writeFile` RPC
// instead, via companion.js writeFileToHost. The receive script is carried
// INTACT — same mkdir, same failure-isolated WARDEN-1320 prune, same `cat >` —
// so a paste is byte-identical across the toggle. Companion-or-fail, like every
// migrated sibling; the ssh legs below remain the default (toggle off).
//
// What ACCUMULATES in the destination is bounded (WARDEN-1320). A pasted
// screenshot is the densest privacy artifact a person can hand over — before
// this bound, every paste on every host and container lived forever,
// unreferenced-but-not-gone once its pane closed. Each delivery prunes the
// paste directory with the stall-log.js house policy (age first, then a count
// cap keeping the newest): the three script legs carry the prune inside
// buildReceiveScript — failure-isolated, so retention can never cost a paste —
// and the direct-write leg, which bypasses that script entirely, prunes in JS
// via prunePasteDir.
//
// The command builders are pure and exported so the ssh/docker legs are pinned
// by byte-exact unit tests without ssh or docker present — the buildSshArgv
// precedent (WARDEN-986), and the same argument that made buildUploadScript and
// buildDockerGitArgv exported helpers rather than hand-assembled strings.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn as defaultSpawn } from 'node:child_process';
import { buildSshArgv, shellQuote, SSH_BIN } from './ssh.js';
import { isCompanionTransportEnabled, writeFileToHost } from './companion.js';

const LOCAL = '(local)';

// The docker CLI name, mirroring SSH_BIN's platform switch. Every other docker
// invocation in this repo goes through a remote shell string where the name is
// literal; this module also spawns docker DIRECTLY (local + container), so the
// binary name needs a symbol.
export const DOCKER_BIN = process.platform === 'win32' ? 'docker.exe' : 'docker';

// The destination directory, fixed and predictable — the roadmap's explicit bar
// is that the agent's own process can READ what lands there. /tmp is
// world-readable and present in every agent container and on every POSIX host,
// and it needs no host-side prep (the script mkdir -p's it). A per-user path
// (~/.warden/paste) would be readable only if the agent runs as the SAME user
// the ssh/docker exec lands as, which is not something warden can know from
// here — warden creates no containers (zero `docker run` hits repo-wide), so it
// cannot know the agent's uid or its HOME. /tmp is the choice that cannot be
// wrong for the reader.
export const PASTE_DIR = '/tmp/warden/paste';

// Where a LOCAL, container-less write lands. POSIX hosts get the identical
// PASTE_DIR so the marker path a user sees is the same string everywhere; only
// Windows (no /tmp) diverges to the OS temp dir.
export function localPasteDir() {
  return process.platform === 'win32' ? path.join(os.tmpdir(), 'warden', 'paste') : PASTE_DIR;
}

// Retention policy for what the paste directory is allowed to accumulate
// (WARDEN-1320) — the stall-log.js house policy (age first, then a count cap
// keeping the newest), applied at delivery time on all four legs.
//
// 7 days is the house value, not a fresh judgement: SEVEN_DAYS_MS in
// stall-log.js, activity.js and observer.js all use it. The count cap is tuned
// for PIXELS, not lines: a screenshot is single-digit MB, so a stall-log-style
// cap of 2000 would permit ~6GB; 200 bounds a burst day to a few hundred MB
// while leaving a long session's history readable by the agent it named.
export const PASTE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_RETAINED_PASTES = 200;

// How long a delivery child may run before it is killed. Generous — an image is
// small (a screenshot is single-digit MB) and the ssh handshake dominates — but
// bounded, so a wedged ssh can never leave the paste promise pending forever.
export const DELIVER_TIMEOUT_MS = 60_000;

// Wait for 'close' after 'exit' before settling. Same reason (and same value)
// as companion.js's UPLOAD_CLOSE_GRACE_MS: we resolve on 'close' so the remote
// stderr — the ONLY diagnostic when a host refuses the write — has drained, and
// this is the hang guard for a child whose stdio never closes (WARDEN-1007).
export const CLOSE_GRACE_MS = 1000;

// ------------------------------ pure helpers -------------------------------

// The far-side script: bound what already lives in the directory, then receive
// the file on stdin. `mkdir -p` first so the very first paste to a host/
// container needs zero prep, then the prune (WARDEN-1320), then `cat >` so the
// payload never appears in an argv (an argv is visible in `ps` and is
// length-bounded; a 3MB screenshot is neither of those things).
//
// The prune is the stall-log.js house policy in POSIX sh — age first, then a
// count cap keeping the newest — and it is FAILURE-ISOLATED, the load-bearing
// property: the whole prune group is wrapped in `2>/dev/null || true`, so a
// missing or misflagged `find`/`ls`/`tail` (a minimal agent image, a busybox
// quirk) degrades to a no-op and the delivery proceeds untouched. Retention
// must never cost a paste; that is pinned by a test that stubs `find` to exit
// 127 and asserts the payload still lands byte-exact.
//
// Both clauses keep only plain files at depth 1 (`-type f` / `rm -f` on names
// `ls` lists), so nothing outside this directory is ever touched, and the
// filename charset is `[a-z0-9.-]` by construction (pasteFileName — the client
// supplies bytes only, never a name), so the `while read` loop cannot be fed a
// hostile name.
export function buildReceiveScript(destPath) {
  const slash = destPath.lastIndexOf('/');
  const dir = slash > 0 ? destPath.slice(0, slash) : '/';
  const d = shellQuote(dir);
  // find's -mtime counts WHOLE 24h days, so the house 7-day window is spelled
  // +6 (age in whole days strictly greater than 6 ≡ older than 7 days). Derived
  // from PASTE_RETENTION_MS so the two encodings cannot drift apart.
  const findDays = Math.floor(PASTE_RETENTION_MS / 86_400_000) - 1;
  return (
    `mkdir -p ${d} && { ` +
      `find ${d} -maxdepth 1 -type f -mtime +${findDays} -exec rm -f {} + 2>/dev/null || true; ` +
      `ls -1t ${d} 2>/dev/null | tail -n +${MAX_RETAINED_PASTES + 1} | ` +
        `while IFS= read -r f; do rm -f ${d}/"$f" 2>/dev/null || true; done; ` +
    `} 2>/dev/null || true; cat > ${shellQuote(destPath)}`
  );
}

// The JS twin of the far-side prune above (WARDEN-1320): the local,
// container-less delivery leg writes straight to disk and bypasses
// buildReceiveScript entirely, so the same age-then-count bound is applied
// here in JS, mirroring pruneStallLog's shape (stall-log.js).
//
// WHERE IT RUNS, and why on the delivery path rather than at boot: the
// stall-log precedent prunes once at server start because the stall log has
// exactly one writer process with a boot hook. The paste directory has four
// writer legs and the three far-side ones can have no boot hook at all —
// warden never starts on a remote host or inside the agent's container — so
// their bound necessarily rides the delivery. One policy applied at one moment
// on all four legs beats a boot-time special case for the fourth; pastes are
// rare, human-paced gestures (not the per-second appends that made per-append
// pruning wrong for the stall log), so an O(n) readdir here costs nothing.
//
// Age first (anything older than `maxAgeMs` goes), then the count cap keeping
// the NEWEST — `ls -1t`'s order. Only plain files are candidates, so a
// stray subdirectory is never touched. Returns the number removed.
export async function prunePasteDir(dir = localPasteDir(), maxAgeMs = PASTE_RETENTION_MS, maxRetained = MAX_RETAINED_PASTES) {
  let names;
  try {
    names = await fs.promises.readdir(dir);
  } catch (err) {
    if (err.code === 'ENOENT') return 0; // nothing has ever landed — the healthy first-paste case
    throw err;
  }
  const cutoff = Date.now() - maxAgeMs;
  const entries = [];
  for (const name of names) {
    try {
      const st = await fs.promises.stat(path.join(dir, name));
      if (st.isFile()) entries.push({ name, mtimeMs: st.mtimeMs });
    } catch { /* the file vanished mid-prune — there is nothing left to remove */ }
  }
  entries.sort((a, b) => b.mtimeMs - a.mtimeMs); // newest first, like `ls -1t`
  const doomed = [];
  entries.forEach((e, i) => {
    if (e.mtimeMs < cutoff || i >= maxRetained) doomed.push(e.name);
  });
  // Best-effort, file by file: a single rm that fails (a raced reader, an odd
  // permission) must not abort the sweep — the next delivery retries it.
  for (const name of doomed) {
    try { await fs.promises.rm(path.join(dir, name), { force: true }); } catch { /* leave it for the next delivery */ }
  }
  return doomed.length;
}

// argv for a DIRECT `docker exec` (the local+container leg) — an array, so no
// shell parses it and the container name cannot become an option or a command.
// `-i` and never `-it`: this exec's stdin IS the transport, and a tty would
// impose a line discipline that corrupts binary. `sh -c` (not bash) because a
// minimal agent image may not ship bash.
export function buildContainerExecArgv(container, destPath) {
  return ['exec', '-i', String(container), 'sh', '-c', buildReceiveScript(destPath)];
}

// The single remote COMMAND string ssh runs. With a container it is the docker
// exec above, re-expressed as a shell string (ssh takes one command string, not
// an argv) with every interpolation quoted. Without one it is the plain-tmux
// host leg — `bash -lc`, exactly as streamFileToHost does.
export function buildRemoteCommand(container, destPath) {
  const script = buildReceiveScript(destPath);
  return container
    ? `docker exec -i ${shellQuote(String(container))} sh -c ${shellQuote(script)}`
    : `bash -lc ${shellQuote(script)}`;
}

// Full ssh argv for a remote delivery. Routed through buildSshArgv so the `--`
// option-terminator invariant is carried here too — hand-assembling it per call
// site is exactly what leaked twice (WARDEN-969, WARDEN-979).
export function buildPasteSshArgv(host, container, destPath, cfg = {}) {
  return buildSshArgv(host, {
    opts: ['-o', `ConnectTimeout=${cfg.connectTimeout ?? 10}`],
    command: buildRemoteCommand(container, destPath),
  });
}

// Sniff format + pixel dimensions from the file's own header bytes. Used only
// for the marker's human-readable "(PNG 1024×640)" tail, so every branch
// degrades to null rather than throwing — an unrecognised image still delivers,
// it just gets a plainer marker.
//
// The BYTES are the authority, not the clipboard's declared MIME type: the
// extension we write is derived from this, so a mislabeled clipboard entry
// cannot make us name a PNG `.jpg`.
export function describeImage(buf) {
  if (!buf || buf.length < 12) return null;
  // PNG: 8-byte signature, then the IHDR chunk — width/height are big-endian
  // u32 at offsets 16 and 20.
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    if (buf.length < 24) return { format: 'PNG', ext: 'png' };
    return { format: 'PNG', ext: 'png', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  // GIF: "GIF87a"/"GIF89a", then width/height as LITTLE-endian u16.
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) {
    return { format: 'GIF', ext: 'gif', width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  }
  // WEBP: RIFF....WEBP. Three sub-formats carry the size differently; VP8X and
  // VP8L are 24-bit-packed, lossy VP8 keeps plain LE u16s after its start code.
  if (buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WEBP') {
    const chunk = buf.slice(12, 16).toString('latin1');
    if (chunk === 'VP8X' && buf.length >= 30) {
      const w = 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16));
      const h = 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16));
      return { format: 'WEBP', ext: 'webp', width: w, height: h };
    }
    if (chunk === 'VP8L' && buf.length >= 25) {
      const b = buf.readUInt32LE(21);
      return { format: 'WEBP', ext: 'webp', width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
    }
    if (chunk === 'VP8 ' && buf.length >= 30) {
      return { format: 'WEBP', ext: 'webp', width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
    }
    return { format: 'WEBP', ext: 'webp' };
  }
  // JPEG: walk the marker segments to the first Start-Of-Frame (SOFn), whose
  // payload carries height then width as big-endian u16. SOF0/1/2/3/5/6/7/
  // 9/10/11/13/14/15 are frame headers; 0xC4/0xC8/0xCC are NOT (Huffman table,
  // JPG extension, arithmetic table) and must be skipped like any other segment.
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i += 1; continue; }
      const marker = buf[i + 1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
      const len = buf.readUInt16BE(i + 2);
      const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSof) {
        return { format: 'JPEG', ext: 'jpg', height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
      }
      if (len < 2) break;
      i += 2 + len;
    }
    return { format: 'JPEG', ext: 'jpg' };
  }
  return null;
}

// The destination filename. Server-generated from a timestamp and a
// byte-sniffed extension — the client supplies BYTES ONLY and never a name or a
// path, so nothing user-controlled reaches the far-side script. The charset is
// [a-z0-9-] plus a dot by construction.
export function pasteFileName(info, now = Date.now()) {
  const ext = info && typeof info.ext === 'string' && /^[a-z0-9]{1,5}$/.test(info.ext) ? info.ext : 'bin';
  const stamp = new Date(now).toISOString().replace(/[:.]/g, '-').replace(/Z$/, '');
  return `paste-${stamp}.${ext}`;
}

// The ONE line that crosses the terminal. Everything about the image the agent
// could want is here: where the file is, and what it is.
export function buildMarker(destPath, info) {
  const dims = info && info.width && info.height ? ` ${info.width}×${info.height}` : '';
  const fmt = info && info.format ? ` (${info.format}${dims})` : '';
  return `[pasted image → ${destPath}${fmt}]`;
}

// ---------------------------- delivery plumbing -----------------------------

// Spawn `bin argv`, write `buf` to its stdin, resolve { ok, code, stderr }.
//
// Every discipline here is a scar from the streamFileToHost siblings and NOT
// boilerplate:
//   - resolve on 'close', NOT 'exit' (WARDEN-464/1007): 'exit' fires before the
//     stdio pipes drain, and the remote stderr it would truncate is the only
//     diagnostic a user gets for a refused write ("No space left on device"
//     degrading to a bare "exit 1");
//   - 'exit' arms a bounded grace instead, so a child holding stdio open cannot
//     leave this promise pending forever;
//   - child.stdin is its OWN emitter and an unlistened 'error' THROWS, taking
//     the warden server down mid-request (WARDEN-982/983). A remote that dies
//     while MBs are still in flight EPIPEs exactly here;
//   - that handler APPENDS to the accumulated stderr rather than replacing it
//     (WARDEN-1018): on the dominant failure leg the local symptom ("write
//     EPIPE") would otherwise discard the remote cause;
//   - stderr.setEncoding('utf8') BEFORE the 'data' listener (WARDEN-1045):
//     `+=` on raw Buffers decodes each chunk in isolation and destroys a
//     multibyte character split across a read boundary;
//   - stdout is drained: 'close' waits for every pipe, and an unread one fills
//     its buffer and stalls the child.
function streamToChild(bin, argv, buf, spawnFn) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnFn(bin, argv, { windowsHide: true });
    } catch (e) {
      resolve({ ok: false, code: -1, stderr: `spawn failed: ${e.message}` });
      return;
    }
    let stderr = '';
    let resolved = false;
    let graceTimer = null;
    let killTimer = null;
    const done = (r) => {
      if (graceTimer) { clearTimeout(graceTimer); graceTimer = null; }
      if (killTimer) { clearTimeout(killTimer); killTimer = null; }
      if (!resolved) { resolved = true; resolve(r); }
    };
    killTimer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* noop */ }
      done({ ok: false, code: -1, stderr: `${stderr}timed out after ${DELIVER_TIMEOUT_MS}ms` });
    }, DELIVER_TIMEOUT_MS);
    child.on('error', (e) => done({ ok: false, code: -1, stderr: String(e) }));
    if (child.stderr) {
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (d) => { stderr += d; });
    }
    if (child.stdout) child.stdout.resume();
    child.on('close', (code) => done({ ok: code === 0, code: code ?? -1, stderr }));
    child.on('exit', (code) => {
      if (resolved) return;
      graceTimer = setTimeout(() => {
        graceTimer = null;
        done({ ok: code === 0, code: code ?? -1, stderr });
      }, CLOSE_GRACE_MS);
    });
    if (child.stdin) {
      child.stdin.on('error', (e) => done({ ok: false, code: -1, stderr: `${stderr}stdin write failed: ${e.message}` }));
      try { child.stdin.end(buf); }
      catch (e) { done({ ok: false, code: -1, stderr: `${stderr}stdin write failed: ${e.message}` }); }
    } else {
      done({ ok: false, code: -1, stderr: 'child has no stdin' });
    }
  });
}

/**
 * Deliver `buf` to where `chat`'s agent lives.
 *
 * Returns { ok, path, marker, info } on success and { ok: false, error } on
 * failure — never throws, and NEVER returns a marker it did not earn. The
 * caller may only show the marker when ok is true: a marker without a delivered
 * file would tell the agent to open something that is not there, which is a
 * worse defect than the silence this ticket exists to fix.
 *
 * `deps` are test seams (spawn, writeFile, now, prune); production callers omit
 * them, mirroring the deps seam in tmux.js send() and ssh.js runWithPool.
 */
export async function deliverPastedImage(chat, cfg = {}, buf, deps = {}) {
  const spawnFn = deps.spawn ?? defaultSpawn;
  const now = deps.now ?? Date.now();
  if (!buf || !buf.length) return { ok: false, error: 'empty image' };

  const info = describeImage(buf);
  const name = pasteFileName(info, now);
  const isLocal = !chat || chat.host === LOCAL;
  const container = (chat && chat.container) || null;

  // Local + no container: the agent's tmux session runs on THIS machine, so the
  // file is simply written here. No child, no shell, no quoting question.
  if (isLocal && !container) {
    const dir = localPasteDir();
    const dest = path.join(dir, name);
    try {
      await (deps.mkdir ?? fs.promises.mkdir)(dir, { recursive: true });
      await (deps.writeFile ?? fs.promises.writeFile)(dest, buf);
    } catch (e) {
      return { ok: false, error: `write failed: ${e.message}` };
    }
    // Bound the directory (WARDEN-1320) — the same bound the other three legs
    // carry inside buildReceiveScript; this leg bypasses that script (no child,
    // no shell), so it prunes here in JS instead. AFTER the write is settled, so
    // a fresh paste can never race its own retention, and best-effort: a
    // failing prune must never fail a delivery that already succeeded. A FAILED
    // delivery deliberately skips it — a failed write adds no new file, so
    // there is nothing new to bound and the next successful delivery prunes.
    try {
      await (deps.prune ?? prunePasteDir)(dir, PASTE_RETENTION_MS, MAX_RETAINED_PASTES);
    } catch (e) {
      console.warn(`[warden:paste] prune failed: ${e.message}`);
    }
    return { ok: true, path: dest, marker: buildMarker(dest, info), info };
  }

  const dest = `${PASTE_DIR}/${name}`;
  // WARDEN-1350 — the REMOTE legs (with or without a container) route through the
  // companion channel when the transport is on, exactly as chats.js/tmux.js gate
  // their remote branches: companion-or-fail, NEVER a silent raw-ssh fallback
  // (the error surfaces; a marker is only ever shown when ok is true). This is
  // the one leg that needed a NEW channel capability — exec has no stdin, so it
  // structurally cannot carry a payload — served by the writeFile RPC. The
  // receive script rides intact, so the WARDEN-1320 prune is byte-identical on
  // both transports, and the op becomes visible in the companion tally (an op
  // that never calls channel.call is not counted, not failed, not shown).
  //
  // The LOCAL legs below stay untouched — a local docker exec is not a reach to
  // another machine, and the roadmap governs reaches between hosts. The ssh path
  // remains the DEFAULT (toggle off) and is byte-identical to what shipped in
  // WARDEN-1282.
  if (!isLocal && (deps.isCompanionTransportEnabled ?? isCompanionTransportEnabled)()) {
    const r = await (deps.writeFileToHost ?? writeFileToHost)(
      chat.host,
      { script: buildReceiveScript(dest), container, buf },
      cfg,
      { timeout: DELIVER_TIMEOUT_MS },
    );
    if (!r.ok) {
      // The same degrading idiom the ssh legs use: prefer the far side's own
      // words, fall back to the exit code when it said nothing.
      return { ok: false, error: (r.stderr || '').trim() || `delivery failed (exit ${r.code})` };
    }
    return { ok: true, path: dest, marker: buildMarker(dest, info), info };
  }
  const [bin, argv] = isLocal
    ? [deps.dockerBin ?? DOCKER_BIN, buildContainerExecArgv(container, dest)]
    : [deps.sshBin ?? SSH_BIN, buildPasteSshArgv(chat.host, container, dest, cfg)];

  const r = await streamToChild(bin, argv, buf, spawnFn);
  if (!r.ok) {
    // The same degrading idiom every spawn-and-collect sibling uses: prefer the
    // far side's own words, fall back to the exit code when it said nothing.
    return { ok: false, error: (r.stderr || '').trim() || `delivery failed (exit ${r.code})` };
  }
  return { ok: true, path: dest, marker: buildMarker(dest, info), info };
}
