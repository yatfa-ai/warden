import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { describeImage, buildMarker } from './pasteImage.js';

/**
 * WARDEN-2087 — pin the describeImage branches pasteImage.test.js never
 * touches: the WEBP VP8X and lossy-VP8 dimension decodes, the WEBP/VP8
 * truncation fallbacks, and the rest of the JPEG marker-walker's branches.
 *
 * WHY THESE AND NOT MORE OF THE SAME. The existing suite covers PNG, GIF, a
 * JPEG SOF0 walk with a 0xC4 skip, one VP8L decode, and the null cases. The
 * uncovered branches are exactly the ones whose failure mode is silent: VP8X
 * (what Chrome/Electron-originated lossless-with-alpha and animated WEBP
 * clipboard data uses) and lossy VP8 are the common WEBP forms, and
 * describeImage's output goes into the marker line the agent reads
 * (`buildMarker`: `[pasted image → path (WEBP 640×480)]`). A transposed axis,
 * a dropped +1 bias, an unmasked scale bit or a guard off by two silently
 * reports wrong dimensions — or reads past the buffer.
 *
 * Each assertion below was chosen to fail under a specific one-token mutant of
 * src/pasteImage.js (see the ticket for the 19-mutant list): the 70000×300
 * VP8X case kills the bias, shift and offset mutants at once; the 10×20 case
 * kills axis transposition; the scale-bit case kills a removed 0x3fff mask;
 * the length-29/24 cases kill each guard-by-two mutant; the 0xC8/0xCC/RST/TEM/
 * resync/len-0 cases kill the walker's skip and stop mutants.
 */

// A zeroed RIFF container carrying `chunk` as its first sub-chunk tag.
function webp(chunk, len = 32) {
  const b = Buffer.alloc(len);
  b.write('RIFF', 0, 'latin1');
  b.write('WEBP', 8, 'latin1');
  b.write(chunk, 12, 'latin1');
  return b;
}

// 24-bit little-endian write (the VP8X canvas-N-1 fields).
function writeU24LE(b, off, v) {
  b[off] = v & 0xff;
  b[off + 1] = (v >> 8) & 0xff;
  b[off + 2] = (v >> 16) & 0xff;
}

const u16be = (v) => [v >> 8, v & 0xff];

// SOI, optional leading segments, then an SOFn frame header carrying
// height then width as big-endian u16, plus 16 trailing bytes so the walker
// has room to run.
function jpeg(marker, h, w, { before = [] } = {}) {
  return Buffer.from([
    0xff, 0xd8,
    ...before.flat(),
    0xff, marker, 0x00, 0x11, 0x08,
    ...u16be(h),
    ...u16be(w),
    ...new Array(16).fill(0),
  ]);
}

describe('describeImage — WEBP VP8X dimensions (24-bit LE canvas-1 fields, +1 bias)', () => {
  it('decodes the 24-bit little-endian canvas-1 fields with the +1 bias', () => {
    // 69999 needs all three bytes and a true 16-bit shift on the middle one:
    // a dropped +1 gives 69999, a <<16→<<8 swap gives 8816, a <<8→<<7 swap
    // gives 1116400 — every one of those mutants dies on this value.
    const b = webp('VP8X');
    writeU24LE(b, 24, 69999);
    writeU24LE(b, 27, 299);
    assert.deepStrictEqual(describeImage(b), {
      format: 'WEBP', ext: 'webp', width: 70000, height: 300,
    });
  });

  it('does not transpose the axes — width comes from offsets 24-26, height from 27-29', () => {
    const b = webp('VP8X');
    writeU24LE(b, 24, 10 - 1);
    writeU24LE(b, 27, 20 - 1);
    assert.deepStrictEqual(describeImage(b), {
      format: 'WEBP', ext: 'webp', width: 10, height: 20,
    });
  });

  it('reads all-zero canvas-1 fields as 1×1 — the fields are canvas-1, not canvas', () => {
    const b = webp('VP8X');
    assert.deepStrictEqual(describeImage(b), {
      format: 'WEBP', ext: 'webp', width: 1, height: 1,
    });
  });

  it('drops the dimensions below the 30-byte guard instead of reading past the buffer', () => {
    // 29 bytes: the VP8X branch is refused, the format is still honest.
    assert.deepStrictEqual(describeImage(webp('VP8X', 29)), {
      format: 'WEBP', ext: 'webp',
    });
  });
});

describe('describeImage — WEBP lossy VP8 dimensions (plain LE u16 after the start code)', () => {
  it('reads width and height as little-endian u16 at offsets 26 and 28', () => {
    const b = webp('VP8 ');
    b.writeUInt16LE(640, 26);
    b.writeUInt16LE(480, 28);
    assert.deepStrictEqual(describeImage(b), {
      format: 'WEBP', ext: 'webp', width: 640, height: 480,
    });
  });

  it('masks the 2-bit scale fields off both dimensions', () => {
    // Real lossy headers carry scale bits in the top two bits of each field.
    // Without the 0x3fff mask the decode would report 49792×16864.
    const b = webp('VP8 ');
    b.writeUInt16LE(640 | (0b11 << 14), 26);
    b.writeUInt16LE(480 | (0b01 << 14), 28);
    assert.deepStrictEqual(describeImage(b), {
      format: 'WEBP', ext: 'webp', width: 640, height: 480,
    });
  });

  it('drops the dimensions below the 30-byte guard instead of reading past the buffer', () => {
    assert.deepStrictEqual(describeImage(webp('VP8 ', 29)), {
      format: 'WEBP', ext: 'webp',
    });
  });
});

describe('describeImage — WEBP fallbacks', () => {
  it('drops VP8L dimensions below the 25-byte guard instead of reading past the buffer', () => {
    assert.deepStrictEqual(describeImage(webp('VP8L', 24)), {
      format: 'WEBP', ext: 'webp',
    });
  });

  it('reports an unknown first-chunk tag as a dimension-less WEBP', () => {
    assert.deepStrictEqual(describeImage(webp('ABCD')), {
      format: 'WEBP', ext: 'webp',
    });
  });

  it('returns null for a RIFF container whose form tag is not WEBP', () => {
    const b = Buffer.alloc(32);
    b.write('RIFF', 0, 'latin1');
    b.write('WAVE', 8, 'latin1');
    assert.equal(describeImage(b), null);
  });

  it('buildMarker renders a dimension-less WEBP without inventing dimensions', () => {
    const info = describeImage(webp('VP8X', 29));
    assert.equal(buildMarker('/tmp/p.webp', info), '[pasted image → /tmp/p.webp (WEBP)]');
  });
});

describe('describeImage — JPEG marker-walker branches', () => {
  it('reads SOF2 (progressive) height-then-width — the axes are not transposed', () => {
    assert.deepStrictEqual(describeImage(jpeg(0xc2, 300, 500)), {
      format: 'JPEG', ext: 'jpg', height: 300, width: 500,
    });
  });

  it('accepts SOF1 (extended) and SOF15 (lossless) as frame headers too', () => {
    assert.deepStrictEqual(describeImage(jpeg(0xc1, 100, 200)), {
      format: 'JPEG', ext: 'jpg', height: 100, width: 200,
    });
    assert.deepStrictEqual(describeImage(jpeg(0xcf, 111, 222)), {
      format: 'JPEG', ext: 'jpg', height: 111, width: 222,
    });
  });

  it('skips 0xC8 (JPG extension) and 0xCC (arithmetic table) inside the SOF range', () => {
    // Like 0xC4, these fall inside 0xC0..0xCF but are NOT frame headers;
    // misreading one would report its payload bytes as the image's dimensions.
    const jpgExt = [0xff, 0xc8, 0x00, 0x06, 0x11, 0x22, 0x33, 0x44];
    const arith = [0xff, 0xcc, 0x00, 0x06, 0x11, 0x22, 0x33, 0x44];
    assert.deepStrictEqual(describeImage(jpeg(0xc0, 128, 64, { before: [jpgExt] })), {
      format: 'JPEG', ext: 'jpg', height: 128, width: 64,
    });
    assert.deepStrictEqual(describeImage(jpeg(0xc0, 128, 64, { before: [arith] })), {
      format: 'JPEG', ext: 'jpg', height: 128, width: 64,
    });
  });

  it('steps over standalone RST0 and TEM markers, which carry no length field', () => {
    assert.deepStrictEqual(describeImage(jpeg(0xc0, 128, 64, { before: [[0xff, 0xd0]] })), {
      format: 'JPEG', ext: 'jpg', height: 128, width: 64,
    });
    assert.deepStrictEqual(describeImage(jpeg(0xc0, 128, 64, { before: [[0xff, 0x01]] })), {
      format: 'JPEG', ext: 'jpg', height: 128, width: 64,
    });
  });

  it('resynchronises past stray non-marker bytes instead of misreading them', () => {
    assert.deepStrictEqual(describeImage(jpeg(0xc0, 128, 64, { before: [[0x00, 0x00, 0x00]] })), {
      format: 'JPEG', ext: 'jpg', height: 128, width: 64,
    });
  });

  it('returns a dimension-less JPEG when no SOF segment exists at all', () => {
    // SOI, a real APP0 (JFIF) segment to skip, then zero padding — the walk
    // runs to the end of the buffer and finds no frame header.
    const app0 = [0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00,
      0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00];
    assert.deepStrictEqual(
      describeImage(Buffer.from([0xff, 0xd8, ...app0, ...new Array(16).fill(0)])),
      { format: 'JPEG', ext: 'jpg' },
    );
  });

  it('stops the walk on a segment declaring length < 2 instead of running past it', () => {
    // A zero-length APP0 is malformed; the walker treats it as the end of the
    // readable stream and reports what it knows — a JPEG with no dimensions —
    // rather than misreading whatever follows.
    assert.deepStrictEqual(
      describeImage(jpeg(0xc0, 128, 64, { before: [[0xff, 0xe0, 0x00, 0x00]] })),
      { format: 'JPEG', ext: 'jpg' },
    );
  });

  it('buildMarker renders a dimension-less JPEG without inventing dimensions', () => {
    const info = describeImage(jpeg(0xc0, 128, 64, { before: [[0xff, 0xe0, 0x00, 0x00]] }));
    assert.equal(buildMarker('/tmp/p.jpg', info), '[pasted image → /tmp/p.jpg (JPEG)]');
  });
});
