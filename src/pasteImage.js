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
// The command builders are pure and exported so the ssh/docker legs are pinned
// by byte-exact unit tests without ssh or docker present — the buildSshArgv
// precedent (WARDEN-986), and the same argument that made buildUploadScript and
// buildDockerGitArgv exported helpers rather than hand-assembled strings.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn as defaultSpawn } from 'node:child_process';
import { buildSshArgv, shellQuote, SSH_BIN } from './ssh.js';

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

// The far-side script: make the directory, then receive the file on stdin.
// Byte-identical in shape to companion.js's buildUploadScript — `mkdir -p`
// first so the very first paste to a host/container needs zero prep, and `cat >`
// so the payload never appears in an argv (an argv is visible in `ps` and is
// length-bounded; a 3MB screenshot is neither of those things).
export function buildReceiveScript(destPath) {
  const slash = destPath.lastIndexOf('/');
  const dir = slash > 0 ? destPath.slice(0, slash) : '/';
  return `mkdir -p ${shellQuote(dir)} && cat > ${shellQuote(destPath)}`;
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
 * `deps` are test seams (spawn, writeFile, now); production callers omit them,
 * mirroring the deps seam in tmux.js send() and ssh.js runWithPool.
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
    return { ok: true, path: dest, marker: buildMarker(dest, info), info };
  }

  const dest = `${PASTE_DIR}/${name}`;
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
