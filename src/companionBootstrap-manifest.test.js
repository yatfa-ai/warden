// Pins loadManifest (src/companionBootstrap.js): the two validation throws and the
// success-only cache. The version is interpolated into a REMOTE SHELL PATH
// (remoteBinaryPath), so the ^[a-f0-9]+$ guard is an injection boundary; the
// binaries check keeps a partial cross-compile from shipping a manifest that
// cannot serve one of the six targets. companion.test.js only ever loads the
// real, valid companion/dist/manifest.json.
//
// loadManifest caches ONLY on success (module-level `_manifest`), so every
// failing case runs first and the single success is last in this file.
import { describe, it, afterEach, mock } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { loadManifest, distDir, SUPPORTED_TARGETS } from './companionBootstrap.js';

const BINARIES = Object.fromEntries(SUPPORTED_TARGETS.map((t) => [t, `bin-${t.replace('/', '-')}`]));
const MANIFEST_PATH = path.join(distDir(), 'manifest.json');
const realRead = fs.readFileSync;

// Serve `doc` for the manifest path only; everything else reads through.
function serve(doc) {
  const seen = [];
  mock.method(fs, 'readFileSync', (p, ...rest) => {
    if (String(p) === MANIFEST_PATH) { seen.push(String(p)); return JSON.stringify(doc); }
    return realRead.call(fs, p, ...rest);
  });
  return seen;
}

afterEach(() => mock.restoreAll());

describe('loadManifest validation (WARDEN-1982 bootstrap helpers)', () => {
  it('rejects a version that is not lowercase hex — the shell-path injection guard', () => {
    for (const version of ['abc; rm -rf ~', '$(id)', 'ABCDEF', 'abc/../x', 'abc def', '', undefined, null]) {
      serve({ version, binaries: BINARIES });
      assert.throws(() => loadManifest(), /companion manifest has invalid version/, `version ${JSON.stringify(version)}`);
      mock.restoreAll();
    }
  });

  it('echoes the offending version in the message', () => {
    serve({ version: 'zz9', binaries: BINARIES });
    assert.throws(() => loadManifest(), (e) => e.message.includes('"zz9"'));
  });

  it('rejects a manifest with no binaries map', () => {
    serve({ version: 'abc123' });
    assert.throws(() => loadManifest(), /companion manifest missing binary entries/);
  });

  it('rejects a manifest missing any ONE of the six targets, naming all of them', () => {
    assert.equal(SUPPORTED_TARGETS.length, 6);
    for (const missing of SUPPORTED_TARGETS) {
      const binaries = { ...BINARIES };
      delete binaries[missing];
      serve({ version: 'abc123', binaries });
      assert.throws(() => loadManifest(), (e) => /missing binary entries/.test(e.message)
        && SUPPORTED_TARGETS.every((t) => e.message.includes(t)), `missing ${missing}`);
      mock.restoreAll();
    }
  });

  it('rejects an entry whose value is falsy (empty filename)', () => {
    serve({ version: 'abc123', binaries: { ...BINARIES, 'windows/arm64': '' } });
    assert.throws(() => loadManifest(), /missing binary entries/);
  });

  it('a failed load is NOT cached: the next valid manifest still loads', () => {
    serve({ version: 'abc123', binaries: BINARIES });
    const m = loadManifest();
    assert.equal(m.version, 'abc123');
    assert.deepEqual(m.binaries, BINARIES);
  });

  it('a successful load IS cached: later calls return the same object without re-reading', () => {
    const seen = serve({ version: 'ffffff', binaries: BINARIES });
    const m = loadManifest();
    assert.equal(m.version, 'abc123', 'still the first success, not the newly served doc');
    assert.equal(seen.length, 0, 'no manifest read on a cached call');
    assert.equal(loadManifest(), m);
  });
});
