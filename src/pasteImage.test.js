import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import {
  buildReceiveScript,
  buildContainerExecArgv,
  buildRemoteCommand,
  buildPasteSshArgv,
  describeImage,
  pasteFileName,
  buildMarker,
  deliverPastedImage,
  prunePasteDir,
  PASTE_DIR,
  PASTE_RETENTION_MS,
  MAX_RETAINED_PASTES,
  CLOSE_GRACE_MS,
} from './pasteImage.js';
import { SSH_BASE_OPTS } from './ssh.js';

/**
 * WARDEN-1282 — pasting a clipboard IMAGE into an agent pane.
 *
 * WHY THIS SUITE IS SHAPED THIS WAY. The two delivery legs that matter most —
 * ssh to a remote host, and `docker exec -i` into the agent's container — cannot
 * run here: this sandbox has neither ssh nor docker. So they are pinned the way
 * every other remote command builder in this repo is pinned (the buildSshArgv
 * precedent, WARDEN-986): the builders are pure and exported, and these tests
 * assert the EXACT argv/script bytes. A regression in the far-side command is
 * caught without a remote in the loop.
 *
 * The legs that CAN run — the local filesystem write, the composed prune, and
 * the whole stdin-streaming child discipline — are exercised for real, the
 * last against a fake child so the WARDEN-982/1007/1018/1045 scars have live
 * coverage. The prune's far-side clauses run under the system's real `sh` (and
 * once under `dash`) because a retention script is exactly the kind of string
 * that rots syntactically without anyone noticing.
 */

// A minimal PNG header: 8-byte signature + IHDR length/type + 1024×640.
function pngHeader(w = 1024, h = 640) {
  const b = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.write('IHDR', 12, 'latin1');
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
}

const RECEIVE_SCRIPT_P = `mkdir -p '/tmp/warden/paste' && { find '/tmp/warden/paste' -maxdepth 1 -type f -mtime +6 -exec rm -f {} + 2>/dev/null || true; ls -1t '/tmp/warden/paste' 2>/dev/null | tail -n +${MAX_RETAINED_PASTES + 1} | while IFS= read -r f; do rm -f '/tmp/warden/paste'/"$f" 2>/dev/null || true; done; } 2>/dev/null || true; cat > '/tmp/warden/paste/p.png'`;

describe('buildReceiveScript — prune, then receive on stdin (WARDEN-1320)', () => {
  it('makes the parent dir, bounds what lives there, then cats stdin into the file', () => {
    assert.equal(buildReceiveScript('/tmp/warden/paste/p.png'), RECEIVE_SCRIPT_P);
  });

  it('the prune sits BETWEEN mkdir and cat, age first then count', () => {
    const s = buildReceiveScript('/tmp/warden/paste/p.png');
    const mkdir = s.indexOf('mkdir -p');
    const find = s.indexOf('find ');
    const ls = s.indexOf('ls -1t');
    const cat = s.indexOf('cat >');
    assert.ok(mkdir >= 0 && find > mkdir && ls > find && cat > ls, s);
  });

  it('encodes the house 7-day window as -mtime +6 and the cap as tail -n +<MAX+1>', () => {
    // find's -mtime counts WHOLE 24h days, so "older than 7 days" is +6; the
    // count clause keeps the newest MAX_RETAINED_PASTES and deletes from
    // line MAX+1 of `ls -1t` downward.
    const s = buildReceiveScript('/tmp/warden/paste/p.png');
    assert.ok(s.includes('-mtime +6'), s);
    assert.ok(s.includes(`tail -n +${MAX_RETAINED_PASTES + 1}`), s);
    assert.equal(PASTE_RETENTION_MS, 7 * 24 * 60 * 60 * 1000);
  });

  it('is failure-isolated — every prune clause ends in || true and the group cannot fail the cat', () => {
    const s = buildReceiveScript('/tmp/warden/paste/p.png');
    // Retention must never cost a paste: a missing/misflagged find or ls
    // degrades to a no-op. Pinned syntactically here, behaviourally below.
    assert.ok(s.includes('-exec rm -f {} + 2>/dev/null || true;'), s);
    assert.ok(s.includes('2>/dev/null || true; done; } 2>/dev/null || true; cat >'), s);
    // The cat is joined to the prune with `;`, never `&&` — even a wildly
    // unexpected prune failure must not short-circuit the delivery.
    assert.ok(s.includes('|| true; cat >'), s);
  });

  it('never puts the payload in an argv — the script mentions only the path', () => {
    // The bytes ride stdin precisely because an argv is visible in `ps` and is
    // length-bounded; a multi-MB screenshot is neither of those things.
    const script = buildReceiveScript('/tmp/warden/paste/a.png');
    assert.ok(script.includes('cat >'));
    assert.ok(!script.includes('base64'));
  });

  it('single-quotes the path, so a shell cannot reinterpret it', () => {
    const script = buildReceiveScript(`/tmp/warden/paste/it's.png`);
    assert.ok(script.includes(`'/tmp/warden/paste/it'\\''s.png'`));
  });

  it('a FAILING find still delivers the payload — retention never costs a paste', () => {
    // The load-bearing isolation property, under a real shell: a stub `find`
    // that exits 127 (absent from a minimal agent image, or a busybox quirk)
    // must leave exit 0 and the payload byte-exact on disk.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-paste-nofind-'));
    fs.writeFileSync(path.join(dir, 'find'), '#!/bin/sh\nexit 127\n', { mode: 0o755 });
    const dest = path.join(dir, 'paste-keep.png');
    const r = spawnSync('sh', ['-c', buildReceiveScript(dest)], {
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
      input: 'PAYLOAD',
      encoding: 'utf8',
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(fs.readFileSync(dest, 'utf8'), 'PAYLOAD');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('the age clause really removes a 10-day-old file and keeps a fresh one (real sh)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-paste-age-'));
    const oldFile = path.join(dir, 'paste-old.png');
    const freshFile = path.join(dir, 'paste-new.png');
    fs.writeFileSync(oldFile, 'old');
    fs.writeFileSync(freshFile, 'fresh');
    const tenDaysAgo = new Date(Date.now() - 10 * 86_400_000);
    fs.utimesSync(oldFile, tenDaysAgo, tenDaysAgo);
    const dest = path.join(dir, 'paste-2026-09-07T00-00-00-000.png');
    const r = spawnSync('sh', ['-c', buildReceiveScript(dest)], { input: 'PAYLOAD', encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!fs.existsSync(oldFile), 'the aged file survived — the age clause is dead');
    assert.ok(fs.existsSync(freshFile), 'a fresh file was wrongly pruned');
    assert.equal(fs.readFileSync(dest, 'utf8'), 'PAYLOAD');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('the count clause really keeps only the newest MAX_RETAINED_PASTES (real sh)', () => {
    // MAX_RETAINED_PASTES + 2 pre-existing files → the two OLDEST go, the cap
    // holds, and the new payload lands afterwards (MAX+1 files transiently —
    // the same steady-state shape as the stall log's once-per-delivery prune).
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-paste-cap-'));
    const base = Date.now() - 3_600_000; // an hour ago: recent enough to pass the age clause
    for (let i = 0; i < MAX_RETAINED_PASTES + 2; i++) {
      const p = path.join(dir, `paste-${String(i).padStart(3, '0')}.png`);
      fs.writeFileSync(p, `v${i}`);
      const t = new Date(base + i * 1000);
      fs.utimesSync(p, t, t);
    }
    const dest = path.join(dir, 'paste-new.png');
    const r = spawnSync('sh', ['-c', buildReceiveScript(dest)], { input: 'PAYLOAD', encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!fs.existsSync(path.join(dir, 'paste-000.png')), 'the oldest file survived — the cap is dead');
    assert.ok(!fs.existsSync(path.join(dir, 'paste-001.png')), 'the second-oldest file survived');
    assert.ok(fs.existsSync(path.join(dir, `paste-${String(MAX_RETAINED_PASTES + 1).padStart(3, '0')}.png`)), 'a recent file was wrongly pruned');
    assert.equal(fs.readdirSync(dir).length, MAX_RETAINED_PASTES + 1);
    assert.equal(fs.readFileSync(dest, 'utf8'), 'PAYLOAD');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('buildContainerExecArgv — the docker leg is `-i`, never `-it`', () => {
  it('builds the exact argv', () => {
    assert.deepStrictEqual(
      buildContainerExecArgv('yatfa-worker', '/tmp/warden/paste/p.png'),
      ['exec', '-i', 'yatfa-worker', 'sh', '-c', RECEIVE_SCRIPT_P],
    );
  });

  it('uses -i and NOT -it — a tty would line-discipline the binary', () => {
    // Every other docker exec in this repo attaches -it (ssh.js:733/:865). This
    // one must not: its stdin IS the image transport.
    const argv = buildContainerExecArgv('c', '/tmp/warden/paste/p.png');
    assert.ok(argv.includes('-i'));
    assert.ok(!argv.includes('-it'));
    assert.ok(!argv.includes('-t'));
  });

  it('is an ARRAY, so a hostile container name cannot become an option', () => {
    const argv = buildContainerExecArgv('--privileged', '/tmp/warden/paste/p.png');
    // No shell parses this; docker receives it as one positional argument.
    assert.equal(argv[2], '--privileged');
    assert.equal(argv.length, 6);
  });

  it('runs `sh -c`, not bash — a minimal agent image may not ship bash', () => {
    assert.equal(buildContainerExecArgv('c', '/tmp/x.png')[3], 'sh');
  });
});

describe('buildRemoteCommand — the one string ssh runs', () => {
  it('containerized chat → docker exec -i, with the script quoted whole', () => {
    assert.equal(
      buildRemoteCommand('yatfa-worker', '/tmp/warden/paste/p.png'),
      `docker exec -i 'yatfa-worker' sh -c 'mkdir -p '\\''/tmp/warden/paste'\\'' && { find '\\''/tmp/warden/paste'\\'' -maxdepth 1 -type f -mtime +6 -exec rm -f {} + 2>/dev/null || true; ls -1t '\\''/tmp/warden/paste'\\'' 2>/dev/null | tail -n +${MAX_RETAINED_PASTES + 1} | while IFS= read -r f; do rm -f '\\''/tmp/warden/paste'\\''/"$f" 2>/dev/null || true; done; } 2>/dev/null || true; cat > '\\''/tmp/warden/paste/p.png'\\'''`,
    );
  });

  it('plain-tmux host (no container) → bash -lc, the streamFileToHost shape', () => {
    assert.equal(
      buildRemoteCommand(null, '/tmp/warden/paste/p.png'),
      `bash -lc 'mkdir -p '\\''/tmp/warden/paste'\\'' && { find '\\''/tmp/warden/paste'\\'' -maxdepth 1 -type f -mtime +6 -exec rm -f {} + 2>/dev/null || true; ls -1t '\\''/tmp/warden/paste'\\'' 2>/dev/null | tail -n +${MAX_RETAINED_PASTES + 1} | while IFS= read -r f; do rm -f '\\''/tmp/warden/paste'\\''/"$f" 2>/dev/null || true; done; } 2>/dev/null || true; cat > '\\''/tmp/warden/paste/p.png'\\'''`,
    );
  });

  it('quotes the container name so a REAL shell cannot break out of it', () => {
    // Not an eyeball assertion about quote characters — the actual system shell
    // parses the command, with a stub `docker` on PATH that records its argv.
    // A quoting mistake shows up as an extra argument or a missing file, and a
    // successful injection would run `touch <canary>` (asserted absent).
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-paste-quote-'));
    const argvFile = path.join(dir, 'argv');
    const canary = path.join(dir, 'PWNED');
    fs.writeFileSync(
      path.join(dir, 'docker'),
      `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a"; done > ${argvFile}\ncat > /dev/null\n`,
      { mode: 0o755 },
    );
    const evil = `evil'; touch ${canary}; '`;
    const cmd = buildRemoteCommand(evil, '/tmp/warden/paste/p.png');
    const r = spawnSync('sh', ['-c', cmd], {
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
      input: '',
      encoding: 'utf8',
    });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!fs.existsSync(canary), 'the injected command RAN — quoting is broken');
    // The container name reached docker as ONE argument, verbatim.
    assert.deepStrictEqual(fs.readFileSync(argvFile, 'utf8').split('\n').slice(0, 6), [
      'exec', '-i', evil, 'sh', '-c', buildReceiveScript('/tmp/warden/paste/p.png'),
    ]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('the receive script survives a real shell round-trip with a quote-bearing path', () => {
    // The `bash -lc '<script>'` host leg, actually parsed: the file must land at
    // the exact path even when the name carries a single quote.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-paste-path-'));
    const dest = path.join(dir, `it's a paste.png`);
    const cmd = buildRemoteCommand(null, dest);
    const r = spawnSync('sh', ['-c', cmd], { input: 'PAYLOAD', encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(fs.readFileSync(dest, 'utf8'), 'PAYLOAD');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('buildPasteSshArgv — the remote leg carries the `--` invariant', () => {
  it('builds base opts, ConnectTimeout, `--`, host, command — in that order', () => {
    const argv = buildPasteSshArgv('example.com', 'agent-1', '/tmp/warden/paste/p.png', { connectTimeout: 10 });
    assert.deepStrictEqual(argv, [
      ...SSH_BASE_OPTS,
      '-o', 'ConnectTimeout=10',
      '--', 'example.com',
      buildRemoteCommand('agent-1', '/tmp/warden/paste/p.png'),
    ]);
  });

  it('`--` immediately precedes the host — an option-looking host stays a host', () => {
    // The WARDEN-969/979 invariant: routed through buildSshArgv so this call
    // site cannot leak it the way two hand-assembled ones already did.
    const argv = buildPasteSshArgv('-oProxyCommand=touch /tmp/pwned', null, '/tmp/warden/paste/p.png');
    const i = argv.indexOf('--');
    assert.ok(i >= 0);
    assert.equal(argv[i + 1], '-oProxyCommand=touch /tmp/pwned');
  });

  it('honors cfg.connectTimeout and defaults it to 10', () => {
    assert.ok(buildPasteSshArgv('h', null, '/tmp/p.png', { connectTimeout: 42 }).includes('ConnectTimeout=42'));
    assert.ok(buildPasteSshArgv('h', null, '/tmp/p.png').includes('ConnectTimeout=10'));
  });

  it('never attaches a tty', () => {
    assert.ok(!buildPasteSshArgv('h', 'c', '/tmp/p.png').includes('-tt'));
  });
});

describe('describeImage — the BYTES decide the format, not the clipboard MIME', () => {
  it('reads PNG dimensions from IHDR', () => {
    assert.deepStrictEqual(describeImage(pngHeader(1024, 640)), {
      format: 'PNG', ext: 'png', width: 1024, height: 640,
    });
  });

  it('reads GIF dimensions (little-endian)', () => {
    const b = Buffer.alloc(16);
    b.write('GIF89a', 0, 'latin1');
    b.writeUInt16LE(320, 6); b.writeUInt16LE(200, 8);
    assert.deepStrictEqual(describeImage(b), { format: 'GIF', ext: 'gif', width: 320, height: 200 });
  });

  it('reads JPEG dimensions by walking to the first SOF0', () => {
    // SOI, an APP0 segment to skip, then SOF0 carrying height then width.
    const b = Buffer.concat([
      Buffer.from([0xff, 0xd8]),
      Buffer.from([0xff, 0xe0, 0x00, 0x04, 0x00, 0x00]),
      Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08]),
      (() => { const d = Buffer.alloc(4); d.writeUInt16BE(480, 0); d.writeUInt16BE(800, 2); return d; })(),
      Buffer.alloc(16),
    ]);
    assert.deepStrictEqual(describeImage(b), { format: 'JPEG', ext: 'jpg', width: 800, height: 480 });
  });

  it('skips a Huffman table (0xC4) rather than misreading it as a frame header', () => {
    // 0xC4 falls inside the 0xC0..0xCF range but is NOT a SOF. Treating it as
    // one would report the Huffman table's bytes as the image's dimensions.
    const b = Buffer.concat([
      Buffer.from([0xff, 0xd8]),
      Buffer.from([0xff, 0xc4, 0x00, 0x06, 0x11, 0x22, 0x33, 0x44]),
      Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08]),
      (() => { const d = Buffer.alloc(4); d.writeUInt16BE(64, 0); d.writeUInt16BE(128, 2); return d; })(),
      Buffer.alloc(16),
    ]);
    assert.deepStrictEqual(describeImage(b), { format: 'JPEG', ext: 'jpg', width: 128, height: 64 });
  });

  it('reads WEBP (VP8L) dimensions from the 14-bit packed fields', () => {
    const b = Buffer.alloc(32);
    b.write('RIFF', 0, 'latin1'); b.write('WEBP', 8, 'latin1'); b.write('VP8L', 12, 'latin1');
    // width-1 in bits 0..13, height-1 in bits 14..27.
    b.writeUInt32LE((100 - 1) | ((50 - 1) << 14), 21);
    assert.deepStrictEqual(describeImage(b), { format: 'WEBP', ext: 'webp', width: 100, height: 50 });
  });

  it('returns null for a non-image and for a truncated buffer', () => {
    assert.equal(describeImage(Buffer.from('not an image at all')), null);
    assert.equal(describeImage(Buffer.alloc(4)), null);
    assert.equal(describeImage(null), null);
  });
});

describe('pasteFileName — server-generated, never client-supplied', () => {
  it('names the file from the SNIFFED format, so a mislabeled type cannot lie', () => {
    const name = pasteFileName(describeImage(pngHeader()), Date.parse('2026-09-03T04:05:06.789Z'));
    assert.equal(name, 'paste-2026-09-03T04-05-06-789.png');
  });

  it('falls back to .bin for an unrecognised image', () => {
    assert.ok(pasteFileName(null, 0).endsWith('.bin'));
  });

  it('only ever emits [a-z0-9.-] — nothing that needs quoting downstream', () => {
    for (const info of [describeImage(pngHeader()), null, { ext: '../../etc' }]) {
      assert.match(pasteFileName(info, Date.now()), /^paste-[0-9T-]+\.[a-z0-9]{1,5}$/);
    }
  });
});

describe('buildMarker — the ONE line that crosses the terminal', () => {
  it('names the path and describes the image', () => {
    assert.equal(
      buildMarker('/tmp/warden/paste/p.png', { format: 'PNG', width: 1024, height: 640 }),
      '[pasted image → /tmp/warden/paste/p.png (PNG 1024×640)]',
    );
  });

  it('degrades to the bare path when the format is unknown', () => {
    assert.equal(buildMarker('/tmp/warden/paste/p.bin', null), '[pasted image → /tmp/warden/paste/p.bin]');
  });

  it('is a single line — a newline would submit the pane input mid-marker', () => {
    assert.ok(!buildMarker('/tmp/p.png', { format: 'PNG', width: 1, height: 1 }).includes('\n'));
  });
});

// --- delivery ---------------------------------------------------------------

// A fake child process: an EventEmitter with the three stdio streams
// deliverPastedImage's streamToChild touches. `stdin.end` records what was
// written so a test can assert the EXACT bytes reached the pipe.
function fakeChild() {
  const child = new EventEmitter();
  child.written = null;
  child.killed = false;
  child.stdin = Object.assign(new EventEmitter(), {
    end(buf) { child.written = buf; },
  });
  child.stdout = Object.assign(new EventEmitter(), { resume() { child.stdoutResumed = true; } });
  child.stderr = Object.assign(new EventEmitter(), { setEncoding(e) { child.stderrEncoding = e; } });
  child.kill = () => { child.killed = true; };
  return child;
}

describe('deliverPastedImage — local, no container: a direct write', () => {
  it('writes the file and returns a marker naming it', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-paste-'));
    const buf = pngHeader(800, 600);
    const written = {};
    const r = await deliverPastedImage({ host: '(local)' }, {}, buf, {
      now: Date.parse('2026-09-03T00:00:00Z'),
      mkdir: async () => {},
      writeFile: async (p, b) => { written.path = p; written.bytes = b; },
      prune: async () => 0,
    });
    assert.equal(r.ok, true);
    assert.equal(written.bytes, buf);
    assert.ok(r.path.endsWith('paste-2026-09-03T00-00-00-000.png'));
    assert.equal(r.marker, `[pasted image → ${r.path} (PNG 800×600)]`);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('really lands on disk (no mocks) and the bytes round-trip', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-paste-real-'));
    const dest = path.join(home, 'sub', 'img.png');
    const buf = pngHeader(2, 3);
    const r = await deliverPastedImage({ host: '(local)' }, {}, buf, {
      mkdir: (d, o) => fs.promises.mkdir(path.dirname(dest), o),
      writeFile: () => fs.promises.writeFile(dest, buf),
      prune: async () => 0,
    });
    assert.equal(r.ok, true);
    assert.deepStrictEqual(fs.readFileSync(dest), buf);
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('a write failure returns an error and NO marker', async () => {
    // The load-bearing rule: a marker without a delivered file would point the
    // agent at something that is not there.
    const r = await deliverPastedImage({ host: '(local)' }, {}, pngHeader(), {
      mkdir: async () => {},
      writeFile: async () => { throw new Error('EACCES: permission denied'); },
      prune: async () => 0,
    });
    assert.equal(r.ok, false);
    assert.match(r.error, /EACCES/);
    assert.equal(r.marker, undefined);
  });

  it('refuses an empty body outright', async () => {
    const r = await deliverPastedImage({ host: '(local)' }, {}, Buffer.alloc(0));
    assert.equal(r.ok, false);
    assert.equal(r.marker, undefined);
  });

  it('bounds the directory: the prune runs with the paste dir and the house policy (WARDEN-1320)', async () => {
    // The local leg bypasses buildReceiveScript (no child, no shell), so THIS
    // is where its retention has to happen. The stub records the call: right
    // directory, the 7-day house window, the count cap — no defaults silently
    // drifting away from the far-side script's encodings.
    const seen = [];
    const r = await deliverPastedImage({ host: '(local)' }, {}, pngHeader(), {
      mkdir: async () => {},
      writeFile: async () => {},
      prune: async (...args) => { seen.push(args); },
    });
    assert.equal(r.ok, true);
    assert.deepStrictEqual(seen, [[path.dirname(r.path), PASTE_RETENTION_MS, MAX_RETAINED_PASTES]]);
  });

  it('a FAILING prune cannot fail the delivery', async () => {
    // Retention must never cost a paste — the JS twin of the far-side script's
    // `2>/dev/null || true` isolation.
    const r = await deliverPastedImage({ host: '(local)' }, {}, pngHeader(), {
      mkdir: async () => {},
      writeFile: async () => {},
      prune: async () => { throw new Error('EACCES: prune blew up'); },
    });
    assert.equal(r.ok, true);
    assert.ok(r.marker.includes(r.path));
  });

  it('a FAILED delivery skips the prune — nothing new landed, nothing new to bound', async () => {
    let pruned = false;
    const r = await deliverPastedImage({ host: '(local)' }, {}, pngHeader(), {
      mkdir: async () => {},
      writeFile: async () => { throw new Error('ENOSPC: no space left on device'); },
      prune: async () => { pruned = true; },
    });
    assert.equal(r.ok, false);
    assert.equal(pruned, false);
  });
});

describe('prunePasteDir — the local leg\u2019s JS prune, mirroring pruneStallLog', () => {
  it('removes an aged file, keeps a recent one, and reports the count', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-paste-prune-'));
    const oldFile = path.join(dir, 'paste-old.png');
    const freshFile = path.join(dir, 'paste-new.png');
    fs.writeFileSync(oldFile, 'old');
    fs.writeFileSync(freshFile, 'fresh');
    const tenDaysAgo = new Date(Date.now() - 10 * 86_400_000);
    fs.utimesSync(oldFile, tenDaysAgo, tenDaysAgo);
    const removed = await prunePasteDir(dir);
    assert.equal(removed, 1);
    assert.ok(!fs.existsSync(oldFile));
    assert.ok(fs.existsSync(freshFile));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('a file right at the age boundary survives (strictly OLDER than the window goes)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-paste-edge-'));
    const edge = path.join(dir, 'paste-edge.png');
    fs.writeFileSync(edge, 'edge');
    const justInside = new Date(Date.now() - (PASTE_RETENTION_MS - 60_000)); // a minute inside the window
    fs.utimesSync(edge, justInside, justInside);
    assert.equal(await prunePasteDir(dir), 0);
    assert.ok(fs.existsSync(edge));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('applies the count cap AFTER the age bound, keeping the NEWEST', async () => {
    // The pruneStallLog shape: age first, then the cap on what remains — five
    // recent files with a cap of 3 leave the three newest.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-paste-capjs-'));
    const base = Date.now() - 60_000;
    for (let i = 0; i < 5; i++) {
      const p = path.join(dir, `paste-${i}.png`);
      fs.writeFileSync(p, `v${i}`);
      const t = new Date(base + i * 1000);
      fs.utimesSync(p, t, t);
    }
    const removed = await prunePasteDir(dir, PASTE_RETENTION_MS, 3);
    assert.equal(removed, 2);
    assert.ok(!fs.existsSync(path.join(dir, 'paste-0.png')));
    assert.ok(!fs.existsSync(path.join(dir, 'paste-1.png')));
    for (const i of [2, 3, 4]) assert.ok(fs.existsSync(path.join(dir, `paste-${i}.png`)));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('an aged file counts against the cap too — age never resurrects a capped-out file', async () => {
    // Two aged + two fresh with a cap of 1: the aged pair goes on age, and the
    // cap keeps only the single newest of what is left.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-paste-mix-'));
    const aged = new Date(Date.now() - 10 * 86_400_000);
    for (const n of ['paste-a0.png', 'paste-a1.png']) {
      const p = path.join(dir, n);
      fs.writeFileSync(p, n);
      fs.utimesSync(p, aged, aged);
    }
    const base = Date.now() - 60_000;
    for (const i of [0, 1]) {
      const p = path.join(dir, `paste-f${i}.png`);
      fs.writeFileSync(p, `f${i}`);
      const t = new Date(base + i * 1000);
      fs.utimesSync(p, t, t);
    }
    const removed = await prunePasteDir(dir, PASTE_RETENTION_MS, 1);
    assert.equal(removed, 3);
    assert.ok(fs.existsSync(path.join(dir, 'paste-f1.png')), 'the newest file was wrongly pruned');
    assert.equal(fs.readdirSync(dir).length, 1);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('never touches a subdirectory, and a missing directory is a healthy zero', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-paste-skip-'));
    fs.mkdirSync(path.join(dir, 'not-a-paste'));
    fs.writeFileSync(path.join(dir, 'not-a-paste', 'keep.txt'), 'keep');
    assert.equal(await prunePasteDir(dir, PASTE_RETENTION_MS, 1), 0);
    assert.ok(fs.existsSync(path.join(dir, 'not-a-paste', 'keep.txt')));
    fs.rmSync(dir, { recursive: true, force: true });
    await assert.doesNotReject(() => prunePasteDir(path.join(dir, 'never-existed')));
  });
});

describe('deliverPastedImage — local + container: docker exec -i, no ssh hop', () => {
  it('spawns docker with the exec argv and pipes the bytes to its stdin', async () => {
    let seen;
    const child = fakeChild();
    const buf = pngHeader(10, 20);
    const p = deliverPastedImage({ host: '(local)', container: 'agent-7' }, {}, buf, {
      now: Date.parse('2026-09-03T00:00:00Z'),
      spawn: (bin, argv) => { seen = { bin, argv }; return child; },
    });
    child.emit('close', 0);
    const r = await p;
    assert.equal(seen.bin, 'docker');
    assert.deepStrictEqual(seen.argv, buildContainerExecArgv('agent-7', `${PASTE_DIR}/paste-2026-09-03T00-00-00-000.png`));
    // The IMAGE went to stdin, not to an argv, and not through any terminal.
    assert.equal(child.written, buf);
    assert.equal(r.ok, true);
    assert.equal(r.path, `${PASTE_DIR}/paste-2026-09-03T00-00-00-000.png`);
  });

  it('no ssh is spawned for a local container', async () => {
    const child = fakeChild();
    let bin;
    const p = deliverPastedImage({ host: '(local)', container: 'c' }, {}, pngHeader(), {
      spawn: (b) => { bin = b; return child; },
    });
    child.emit('close', 0);
    await p;
    assert.ok(!/ssh/.test(bin));
  });
});

describe('deliverPastedImage — remote: ssh carries the docker exec', () => {
  it('spawns ssh with the paste argv and pipes the bytes', async () => {
    let seen;
    const child = fakeChild();
    const buf = pngHeader();
    const p = deliverPastedImage({ host: 'box', container: 'agent-1' }, { connectTimeout: 7 }, buf, {
      now: Date.parse('2026-09-03T00:00:00Z'),
      spawn: (bin, argv) => { seen = { bin, argv }; return child; },
    });
    child.emit('close', 0);
    const r = await p;
    assert.match(seen.bin, /^ssh(\.exe)?$/);
    assert.deepStrictEqual(
      seen.argv,
      buildPasteSshArgv('box', 'agent-1', `${PASTE_DIR}/paste-2026-09-03T00-00-00-000.png`, { connectTimeout: 7 }),
    );
    assert.equal(child.written, buf);
    assert.equal(r.ok, true);
  });

  it('a remote chat with NO container gets the bash -lc host leg', async () => {
    let argv;
    const child = fakeChild();
    const p = deliverPastedImage({ host: 'box' }, {}, pngHeader(), {
      now: 0,
      spawn: (_b, a) => { argv = a; return child; },
    });
    child.emit('close', 0);
    await p;
    assert.ok(argv[argv.length - 1].startsWith('bash -lc '));
    assert.ok(!argv[argv.length - 1].includes('docker'));
  });
});

describe('deliverPastedImage — the child-process disciplines (the scars)', () => {
  it('resolves on close, NOT exit, so the far side\u2019s stderr is complete', async () => {
    // WARDEN-464/1007: 'exit' fires before the pipes drain, and this stderr is
    // the ONLY diagnostic when a host refuses the write.
    const child = fakeChild();
    const p = deliverPastedImage({ host: 'box', container: 'c' }, {}, pngHeader(), { spawn: () => child });
    child.emit('exit', 1);
    child.stderr.emit('data', 'No space left on device\n');
    child.emit('close', 1);
    const r = await p;
    assert.equal(r.ok, false);
    assert.match(r.error, /No space left on device/);
  });

  it('a child whose stdio never closes still settles, via the exit grace', async () => {
    const child = fakeChild();
    const p = deliverPastedImage({ host: 'box', container: 'c' }, {}, pngHeader(), { spawn: () => child });
    child.stderr.emit('data', 'partial');
    child.emit('exit', 3);          // and 'close' NEVER arrives
    const r = await p;              // must not hang
    assert.equal(r.ok, false);
    assert.match(r.error, /partial/);
  });

  it('the grace really is bounded by CLOSE_GRACE_MS', async () => {
    const child = fakeChild();
    const t0 = Date.now();
    const p = deliverPastedImage({ host: 'box', container: 'c' }, {}, pngHeader(), { spawn: () => child });
    child.emit('exit', 0);
    await p;
    const elapsed = Date.now() - t0;
    assert.ok(elapsed >= CLOSE_GRACE_MS - 50, `settled too fast (${elapsed}ms)`);
    assert.ok(elapsed < CLOSE_GRACE_MS + 2000, `settled too slow (${elapsed}ms)`);
  });

  it('an async stdin EPIPE is CAUGHT, not thrown — it would kill the server', async () => {
    // WARDEN-982/983: child.stdin is its own emitter, and an 'error' with no
    // listener THROWS, taking the whole warden process down mid-request.
    const child = fakeChild();
    const p = deliverPastedImage({ host: 'box', container: 'c' }, {}, pngHeader(), { spawn: () => child });
    child.stdin.emit('error', new Error('write EPIPE'));
    const r = await p;
    assert.equal(r.ok, false);
    assert.match(r.error, /EPIPE/);
    assert.equal(r.marker, undefined);
  });

  it('an EPIPE APPENDS to the remote stderr rather than replacing it', async () => {
    // WARDEN-1018: on the dominant failure leg the remote dies mid-upload and
    // stops reading, so the local symptom ("write EPIPE") would otherwise
    // discard the remote CAUSE.
    const child = fakeChild();
    const p = deliverPastedImage({ host: 'box', container: 'c' }, {}, pngHeader(), { spawn: () => child });
    child.stderr.emit('data', 'docker: no such container\n');
    child.stdin.emit('error', new Error('write EPIPE'));
    const r = await p;
    assert.match(r.error, /no such container/);
    assert.match(r.error, /EPIPE/);
  });

  it('stderr is decoded as utf8 BEFORE the data listener', async () => {
    // WARDEN-1045: accumulating raw Buffers with `+=` decodes each chunk in
    // isolation, destroying a multibyte character split across a read boundary.
    const child = fakeChild();
    const p = deliverPastedImage({ host: 'box', container: 'c' }, {}, pngHeader(), { spawn: () => child });
    assert.equal(child.stderrEncoding, 'utf8');
    child.emit('close', 0);          // settle it: an unresolved delivery holds its timeout timer
    await p;
  });

  it('stdout is drained, so an unread pipe cannot stall the child', async () => {
    const child = fakeChild();
    const p = deliverPastedImage({ host: 'box', container: 'c' }, {}, pngHeader(), { spawn: () => child });
    assert.equal(child.stdoutResumed, true);
    child.emit('close', 0);
    await p;
  });

  it('a spawn that throws resolves as a failure, never a rejection', async () => {
    const r = await deliverPastedImage({ host: 'box', container: 'c' }, {}, pngHeader(), {
      spawn: () => { throw new Error('ENOENT'); },
    });
    assert.equal(r.ok, false);
    assert.match(r.error, /ENOENT/);
  });

  it('a non-zero exit with silent stderr degrades to the exit code', async () => {
    const child = fakeChild();
    const p = deliverPastedImage({ host: 'box', container: 'c' }, {}, pngHeader(), { spawn: () => child });
    child.emit('close', 127);
    const r = await p;
    assert.equal(r.ok, false);
    assert.match(r.error, /exit 127/);
  });
});

describe('no image bytes ever reach a command line', () => {
  it('the payload appears in stdin ONLY — not in argv, not in the script', async () => {
    // Acceptance criterion 6, made grep-able: the ONLY thing that can cross the
    // terminal is the marker string, and the only thing carrying bytes is stdin.
    const child = fakeChild();
    const buf = Buffer.concat([pngHeader(), Buffer.from('SENTINEL-IMAGE-BYTES')]);
    let argv;
    const p = deliverPastedImage({ host: 'box', container: 'c' }, {}, buf, {
      spawn: (_b, a) => { argv = a; return child; },
    });
    child.emit('close', 0);
    const r = await p;
    assert.ok(!argv.join(' ').includes('SENTINEL-IMAGE-BYTES'));
    assert.ok(!r.marker.includes('SENTINEL-IMAGE-BYTES'));
    assert.equal(child.written, buf);
  });
});
