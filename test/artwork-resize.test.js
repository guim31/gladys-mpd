// The artwork resizer (src/artwork-resize.js): header reading, the reduced
// JPEG decoder against jpeg-js, the streaming PNG decoder against known
// pixels, the pass-through of images the core accepts, and the refusals.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { Readable } from 'node:stream';
import { crc32, deflateSync } from 'node:zlib';
import jpeg from 'jpeg-js';
import {
  ArtworkError,
  decodeJpeg,
  decodePng,
  imageInfo,
  prepareArtwork,
  readLimited,
} from '../src/artwork-resize.js';

const FIXTURES = new URL('./fixtures/artwork/', import.meta.url);
const fixture = (name) => readFileSync(new URL(name, FIXTURES));
const JPEGS = readdirSync(FIXTURES).filter((f) => f.endsWith('.jpg') && f !== 'arithmetic.jpg');

const isCode = (code) => (error) => error instanceof ArtworkError && error.code === code;

/** Mean absolute difference between two RGB buffers. */
const mae = (a, b) => {
  assert.equal(a.length, b.length);
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return sum / a.length;
};

/** Box average of an RGB image by an integer factor (edges: partial boxes). */
const boxDown = (rgb, width, height, r) => {
  const w = Math.ceil(width / r);
  const h = Math.ceil(height / r);
  const out = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      for (let c = 0; c < 3; c++) {
        let sum = 0;
        let n = 0;
        for (let yy = y * r; yy < Math.min(height, y * r + r); yy++) {
          for (let xx = x * r; xx < Math.min(width, x * r + r); xx++) {
            sum += rgb[(yy * width + xx) * 3 + c];
            n++;
          }
        }
        out[(y * w + x) * 3 + c] = Math.round(sum / n);
      }
    }
  }
  return out;
};

const reference = (buffer) => jpeg.decode(buffer, { formatAsRGBA: false, useTArray: true });

// --- A small PNG encoder for the tests: every color type and depth, Adam7,
// and the five filters used in turn (row n uses filter n % 5).
const ADAM7 = [
  [0, 0, 8, 8],
  [4, 0, 8, 8],
  [0, 4, 4, 8],
  [2, 0, 4, 4],
  [0, 2, 2, 4],
  [1, 0, 2, 2],
  [0, 1, 1, 2],
];
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

function chunk(type, body) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'latin1'), body])), 0);
  return Buffer.concat([head, body, crc]);
}

function encodePng({ width, height, colorType, depth, interlace = false, sample, palette, trns }) {
  const channels = CHANNELS[colorType];
  const bpp = Math.max(1, (channels * depth) >> 3);
  const rows = [];
  let n = 0;
  for (const [x0, y0, dx, dy] of interlace ? ADAM7 : [[0, 0, 1, 1]]) {
    const columns = Math.ceil((width - x0) / dx);
    if (columns <= 0) continue;
    let prior = null;
    for (let y = y0; y < height; y += dy) {
      const raw = Buffer.alloc(Math.ceil((columns * channels * depth) / 8));
      let bit = 0;
      for (let x = x0; x < width; x += dx) {
        for (const v of sample(x, y)) {
          if (depth === 16) {
            raw.writeUInt16BE(v, bit >> 3);
          } else if (depth === 8) {
            raw[bit >> 3] = v;
          } else {
            raw[bit >> 3] |= v << (8 - depth - (bit & 7));
          }
          bit += depth;
        }
      }
      const above = prior ?? Buffer.alloc(raw.length);
      const filter = n++ % 5;
      const out = Buffer.alloc(raw.length);
      for (let i = 0; i < raw.length; i++) {
        const left = i >= bpp ? raw[i - bpp] : 0;
        const upLeft = i >= bpp ? above[i - bpp] : 0;
        const p = left + above[i] - upLeft;
        const paeth =
          Math.abs(p - left) <= Math.abs(p - above[i]) && Math.abs(p - left) <= Math.abs(p - upLeft)
            ? left
            : Math.abs(p - above[i]) <= Math.abs(p - upLeft)
              ? above[i]
              : upLeft;
        const predictor = [0, left, above[i], (left + above[i]) >> 1, paeth][filter];
        out[i] = (raw[i] - predictor) & 0xff;
      }
      rows.push(Buffer.from([filter]), out);
      prior = raw;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = depth;
  ihdr[9] = colorType;
  ihdr[12] = interlace ? 1 : 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    ...(palette ? [chunk('PLTE', Buffer.from(palette))] : []),
    ...(trns ? [chunk('tRNS', Buffer.from(trns))] : []),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// --- Header -------------------------------------------------------------------

test('imageInfo reads the format and the size from the header', () => {
  assert.deepEqual(imageInfo(fixture('baseline-420.jpg')), {
    format: 'jpeg',
    width: 99,
    height: 75,
  });
  assert.deepEqual(imageInfo(fixture('progressive-444.jpg')), {
    format: 'jpeg',
    width: 99,
    height: 75,
  });
  const png = encodePng({ width: 7, height: 3, colorType: 0, depth: 8, sample: () => [0] });
  assert.deepEqual(imageInfo(png), { format: 'png', width: 7, height: 3 });

  const webp = (kind, bytes) => {
    const data = Buffer.alloc(40);
    data.write('RIFF', 0);
    data.write('WEBP', 8);
    data.write(kind, 12);
    for (const [at, v] of bytes) data[at] = v;
    return data;
  };
  assert.deepEqual(
    imageInfo(
      webp('VP8 ', [
        [26, 0x90],
        [27, 0x01],
        [28, 0x2c],
        [29, 0x01],
      ]),
    ),
    {
      format: 'webp',
      width: 400,
      height: 300,
    },
  );
  // VP8L: 14 bits of width - 1, then 14 bits of height - 1.
  const bits = 399 | (299 << 14);
  assert.deepEqual(
    imageInfo(
      webp('VP8L', [
        [21, bits & 0xff],
        [22, (bits >> 8) & 0xff],
        [23, (bits >> 16) & 0xff],
        [24, bits >>> 24],
      ]),
    ),
    { format: 'webp', width: 400, height: 300 },
  );
  assert.deepEqual(
    imageInfo(
      webp('VP8X', [
        [24, 0x8f],
        [25, 0x01],
        [27, 0x2b],
        [28, 0x01],
      ]),
    ),
    {
      format: 'webp',
      width: 400,
      height: 300,
    },
  );
  assert.equal(imageInfo(Buffer.from('GIF89a\x10\x00\x10\x00\x00\x00', 'latin1')).format, 'gif');
  assert.deepEqual(imageInfo(Buffer.from('not an image at all')), {
    format: null,
    width: null,
    height: null,
  });
  assert.equal(imageInfo(Buffer.alloc(3)).format, null);
});

// --- JPEG -----------------------------------------------------------------------

test('the JPEG decoder matches jpeg-js on every variant, at full size', async () => {
  for (const name of JPEGS) {
    const buffer = fixture(name);
    const ref = reference(buffer);
    const img = await decodeJpeg(buffer, { width: 99, height: 75 });
    assert.deepEqual([img.width, img.height], [99, 75], name);
    // jpeg-js upsamples the chroma by repetition, this decoder interpolates.
    assert.ok(mae(img.data, ref.data) < 2.5, `${name}: ${mae(img.data, ref.data)}`);
  }
});

test('a progressive JPEG decodes exactly like its baseline twin', async () => {
  // Same quality, same coefficients: only the order of the bits differs.
  for (const r of [1, 2, 4, 8]) {
    const target = { width: Math.ceil(99 / r), height: Math.ceil(75 / r) };
    assert.deepEqual(
      await decodeJpeg(fixture('progressive-420.jpg'), target),
      await decodeJpeg(fixture('baseline-420.jpg'), target),
    );
    assert.deepEqual(
      await decodeJpeg(fixture('gray-progressive.jpg'), target),
      await decodeJpeg(fixture('gray.jpg'), target),
    );
  }
});

test('the JPEG decoder reduces by 2, 4 and 8 from the DCT coefficients', async () => {
  for (const name of JPEGS) {
    const buffer = fixture(name);
    const ref = reference(buffer);
    for (const r of [2, 4, 8]) {
      const target = { width: Math.ceil(99 / r), height: Math.ceil(75 / r) };
      const img = await decodeJpeg(buffer, target);
      assert.deepEqual([img.width, img.height], [target.width, target.height], `${name} /${r}`);
      const expected = boxDown(ref.data, 99, 75, r);
      assert.ok(mae(img.data, expected) < 5, `${name} /${r}: ${mae(img.data, expected)}`);
    }
  }
});

test('the JPEG decoder refuses what it cannot read', async () => {
  const target = { width: 10, height: 10 };
  await assert.rejects(decodeJpeg(fixture('arithmetic.jpg'), target), isCode('UNSUPPORTED'));
  // 12 bits per sample.
  const twelve = Buffer.from(fixture('baseline-420.jpg'));
  const sof = twelve.indexOf(Buffer.from([0xff, 0xc0]));
  twelve[sof + 4] = 12;
  await assert.rejects(decodeJpeg(twelve, target), isCode('UNSUPPORTED'));
  // A header cut in the middle of a segment.
  const header = fixture('baseline-420.jpg').subarray(0, 100);
  await assert.rejects(decodeJpeg(header, target), isCode('CORRUPT'));
  // No frame at all.
  await assert.rejects(
    decodeJpeg(Buffer.from([0xff, 0xd8, 0xff, 0xd9]), target),
    isCode('CORRUPT'),
  );
  // Too many pixels for the limit, refused on the header.
  const huge = Buffer.from(fixture('baseline-420.jpg'));
  huge.writeUInt16BE(60000, sof + 5);
  huge.writeUInt16BE(60000, sof + 7);
  await assert.rejects(decodeJpeg(huge, target), isCode('TOO_LARGE'));
  // More memory than allowed, refused before allocating.
  await assert.rejects(
    decodeJpeg(
      fixture('progressive-444.jpg'),
      { width: 99, height: 75 },
      { maxPixels: 1e9, maxDecodeBytes: 1000 },
    ),
    isCode('TOO_LARGE'),
  );
});

test('a truncated JPEG decodes what it has instead of failing', async () => {
  const buffer = fixture('baseline-444.jpg');
  const img = await decodeJpeg(buffer.subarray(0, buffer.length - 1500), { width: 99, height: 75 });
  assert.deepEqual([img.width, img.height], [99, 75]);
  // The top of the image is intact.
  const ref = reference(buffer);
  assert.ok(mae(img.data.subarray(0, 99 * 8 * 3), ref.data.subarray(0, 99 * 8 * 3)) < 2);
});

/** gray.jpg turned into a 4000 × 4000 frame followed by `scans` scans without data. */
function emptyScans(scans) {
  const gray = fixture('gray.jpg');
  const sos = gray.indexOf(Buffer.from([0xff, 0xda]));
  const header = Buffer.from(gray.subarray(0, sos));
  const sof = header.indexOf(Buffer.from([0xff, 0xc0]));
  header.writeUInt16BE(4000, sof + 5);
  header.writeUInt16BE(4000, sof + 7);
  const scan = gray.subarray(sos, sos + 2 + gray.readUInt16BE(sos + 2));
  return Buffer.concat([header, ...Array(scans).fill(scan), Buffer.from([0xff, 0xd9])]);
}

test('a forged JPEG of empty scans neither loops nor blocks', async () => {
  const target = { width: 400, height: 400 };
  // Each scan stops once its data has run out.
  const start = performance.now();
  const img = await decodeJpeg(emptyScans(60), target);
  assert.deepEqual([img.width, img.height], [500, 500]);
  assert.ok(performance.now() - start < 1500, `${performance.now() - start} ms`);
  // Beyond 100 scans: refused.
  await assert.rejects(decodeJpeg(emptyScans(101), target), isCode('CORRUPT'));
});

test('the JPEG decoder lets the event loop run on a large image', async () => {
  // 1600 × 1600 of gray noise, baseline: decoded in slices.
  let ticks = 0;
  const timer = setInterval(() => ticks++, 5);
  const width = 1600;
  const height = 1600;
  const rgba = Buffer.alloc(width * height * 4, 255);
  let seed = 3;
  for (let i = 0; i < rgba.length; i += 4) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    rgba.fill(seed & 0xff, i, i + 3);
  }
  const big = jpeg.encode({ data: rgba, width, height }, 90).data;
  ticks = 0;
  await decodeJpeg(big, { width: 400, height: 400 });
  clearInterval(timer);
  assert.ok(ticks > 0, 'the timer never ran during the decoding');
});

// --- PNG ------------------------------------------------------------------------

const W = 23;
const H = 13;
// Expected 8-bit RGB of a pixel, laid on white.
const onWhite = (r, g, b, a) => [r, g, b].map((v) => Math.round((v * a + 255 * (255 - a)) / 255));

const PNG_CASES = [];
for (const interlace of [false, true]) {
  for (const depth of [1, 2, 4, 8, 16]) {
    const max = (1 << depth) - 1;
    const gray = (x, y) => (x * 7 + y * 3) % (max + 1);
    PNG_CASES.push({
      label: `gray ${depth} bits${interlace ? ' Adam7' : ''}`,
      png: { width: W, height: H, colorType: 0, depth, interlace, sample: (x, y) => [gray(x, y)] },
      rgb: (x, y) => Array(3).fill(Math.round((gray(x, y) * 255) / max)),
    });
    if (depth <= 8) {
      const index = (x, y) => (x + y) % Math.min(max + 1, 5);
      const palette = [255, 0, 0, 0, 255, 0, 0, 0, 255, 10, 20, 30, 200, 100, 50];
      const alpha = [255, 128, 0];
      PNG_CASES.push({
        label: `palette ${depth} bits with tRNS${interlace ? ' Adam7' : ''}`,
        png: {
          width: W,
          height: H,
          colorType: 3,
          depth,
          interlace,
          palette,
          trns: alpha,
          sample: (x, y) => [index(x, y)],
        },
        rgb: (x, y) => {
          const i = index(x, y);
          return onWhite(palette[i * 3], palette[i * 3 + 1], palette[i * 3 + 2], alpha[i] ?? 255);
        },
      });
    }
  }
  for (const depth of [8, 16]) {
    const k = depth === 16 ? 257 : 1;
    const color = (x, y) => [(x * 11) % 256, (y * 19) % 256, (x * y) % 256];
    const a = (x, y) => (x * 13 + y) % 256;
    PNG_CASES.push(
      {
        label: `RGB ${depth} bits${interlace ? ' Adam7' : ''}`,
        png: {
          width: W,
          height: H,
          colorType: 2,
          depth,
          interlace,
          sample: (x, y) => color(x, y).map((v) => v * k),
        },
        rgb: color,
      },
      {
        label: `RGBA ${depth} bits${interlace ? ' Adam7' : ''}`,
        png: {
          width: W,
          height: H,
          colorType: 6,
          depth,
          interlace,
          sample: (x, y) => [...color(x, y), a(x, y)].map((v) => v * k),
        },
        rgb: (x, y) => onWhite(...color(x, y), a(x, y)),
      },
      {
        label: `gray + alpha ${depth} bits${interlace ? ' Adam7' : ''}`,
        png: {
          width: W,
          height: H,
          colorType: 4,
          depth,
          interlace,
          sample: (x, y) => [color(x, y)[0] * k, a(x, y) * k],
        },
        rgb: (x, y) => onWhite(color(x, y)[0], color(x, y)[0], color(x, y)[0], a(x, y)),
      },
    );
  }
}

const expectedPixels = (rgb) => {
  const out = new Uint8Array(W * H * 3);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) out.set(rgb(x, y), (y * W + x) * 3);
  return out;
};

test('the PNG decoder reads every color type, depth and Adam7, filters included', async () => {
  for (const c of PNG_CASES) {
    const img = await decodePng(encodePng(c.png), { width: W, height: H });
    assert.deepEqual([img.width, img.height], [W, H], c.label);
    assert.ok(
      mae(img.data, expectedPixels(c.rgb)) < 0.6,
      `${c.label}: ${mae(img.data, expectedPixels(c.rgb))}`,
    );
  }
});

test('the PNG decoder averages into a grid reduced by an integer factor', async () => {
  for (const c of PNG_CASES.filter((x) => x.png.colorType === 6)) {
    const img = await decodePng(encodePng(c.png), { width: 7, height: 4 });
    // 23 × 13 to at least 7 × 4: a factor of 3, 8 × 5 with partial edges.
    assert.deepEqual([img.width, img.height], [8, 5], c.label);
    assert.ok(mae(img.data, boxDown(expectedPixels(c.rgb), W, H, 3)) < 0.6, c.label);
  }
});

test('the PNG decoder keeps the transparent color of a gray or RGB image', async () => {
  const gray = encodePng({
    width: 4,
    height: 1,
    colorType: 0,
    depth: 8,
    trns: [0, 9],
    sample: (x) => [x === 1 ? 9 : 0],
  });
  assert.deepEqual(
    [...(await decodePng(gray, { width: 4, height: 1 })).data.subarray(0, 6)],
    [0, 0, 0, 255, 255, 255],
  );
  const rgb = encodePng({
    width: 2,
    height: 1,
    colorType: 2,
    depth: 8,
    trns: [0, 1, 0, 2, 0, 3],
    sample: (x) => (x ? [1, 2, 3] : [1, 2, 4]),
  });
  assert.deepEqual(
    [...(await decodePng(rgb, { width: 2, height: 1 })).data],
    [1, 2, 4, 255, 255, 255],
  );
});

test('the PNG decoder refuses broken files', async () => {
  const target = { width: 4, height: 4 };
  const good = encodePng({ width: 8, height: 8, colorType: 2, depth: 8, sample: () => [1, 2, 3] });
  const idat = good.indexOf('IDAT');
  // Image data that is not zlib.
  const broken = Buffer.from(good);
  broken.fill(0x55, idat + 4, idat + 12);
  await assert.rejects(decodePng(broken, target), isCode('CORRUPT'));
  // Image data that stops early.
  const short = encodePng({ width: 8, height: 8, colorType: 2, depth: 8, sample: () => [1, 2, 3] });
  const rows = deflateSync(Buffer.alloc(3 * 25));
  const truncated = Buffer.concat([
    short.subarray(0, idat - 4),
    chunk('IDAT', rows),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  await assert.rejects(decodePng(truncated, target), isCode('CORRUPT'));
  // An unknown filter type.
  const filtered = Buffer.concat([
    short.subarray(0, idat - 4),
    chunk('IDAT', deflateSync(Buffer.alloc(8 * 25, 7))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  await assert.rejects(decodePng(filtered, target), isCode('CORRUPT'));
  // A color type that does not exist, a palette image without its palette.
  const odd = Buffer.from(good);
  odd[25] = 5;
  await assert.rejects(decodePng(odd, target), isCode('UNSUPPORTED'));
  const noPalette = encodePng({ width: 2, height: 2, colorType: 3, depth: 8, sample: () => [0] });
  await assert.rejects(decodePng(noPalette, target), isCode('CORRUPT'));
  // Huge on paper: refused on the header, nothing allocated.
  const huge = Buffer.from(good);
  huge.writeUInt32BE(100_000, 16);
  huge.writeUInt32BE(100_000, 20);
  await assert.rejects(decodePng(huge, target), isCode('TOO_LARGE'));
});

test('a PNG of an extreme aspect ratio is reduced along each axis', async () => {
  // 1 000 000 × 1 px of 1-bit gray: a few hundred bytes, never a 1 Mpx grid.
  const wide = encodePng({
    width: 1_000_000,
    height: 1,
    colorType: 0,
    depth: 1,
    sample: (x) => [x % 2],
  });
  const img = await decodePng(wide, { width: 400, height: 1 });
  assert.deepEqual([img.width, img.height], [400, 1]);
  assert.ok(Math.abs(img.data[0] - 128) < 2, `${img.data[0]}`);
  const out = await prepareArtwork(wide);
  assert.deepEqual(imageInfo(out), { format: 'jpeg', width: 400, height: 1 });
});

// --- prepareArtwork -------------------------------------------------------------

test('an image the core accepts is returned as it is', async () => {
  const small = fixture('baseline-420.jpg');
  assert.equal(await prepareArtwork(small), small);
  const png = encodePng({ width: 40, height: 40, colorType: 2, depth: 8, sample: () => [1, 2, 3] });
  assert.equal(await prepareArtwork(png), png);
  // A small WebP passes too (the core reads WebP).
  const webp = Buffer.alloc(40);
  webp.write('RIFF', 0);
  webp.write('WEBPVP8X', 8);
  assert.equal(await prepareArtwork(webp), webp);
  // A Uint8Array is accepted.
  assert.deepEqual(await prepareArtwork(new Uint8Array(small)), small);
});

test('a large JPEG becomes a JPEG of 400 px at most, under 300 KB', async () => {
  // Four colored quadrants under strong noise: well above 300 KB.
  const width = 1000;
  const height = 800;
  const rgba = Buffer.alloc(width * height * 4);
  const quadrant = [
    [200, 40, 40],
    [40, 200, 40],
    [40, 40, 200],
    [128, 128, 128],
  ];
  let seed = 42;
  const noise = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return (seed % 81) - 40;
  };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const q = quadrant[(y < height / 2 ? 0 : 2) + (x < width / 2 ? 0 : 1)];
      rgba.set([...q.map((v) => v + noise()), 255], (y * width + x) * 4);
    }
  }
  const big = jpeg.encode({ data: rgba, width, height }, 100).data;
  assert.ok(big.length > 300 * 1024, `fixture of ${big.length} bytes`);

  const out = await prepareArtwork(big);
  assert.ok(out.length <= 300 * 1024);
  assert.deepEqual(imageInfo(out), { format: 'jpeg', width: 400, height: 320 });
  const decoded = jpeg.decode(out, { formatAsRGBA: false, useTArray: true });
  // The noise averages out: each quadrant keeps its color.
  for (const [x, y, q] of [
    [100, 80, 0],
    [300, 80, 1],
    [100, 240, 2],
    [300, 240, 3],
  ]) {
    const at = (y * 400 + x) * 3;
    for (let c = 0; c < 3; c++) {
      assert.ok(
        Math.abs(decoded.data[at + c] - quadrant[q][c]) < 12,
        `quadrant ${q}: ${decoded.data.subarray(at, at + 3)}`,
      );
    }
  }
});

test('every JPEG variant and a PNG go through the resizing path', async () => {
  for (const name of JPEGS) {
    const buffer = fixture(name);
    const out = await prepareArtwork(buffer, { maxBytes: 1000, maxSize: 40 });
    assert.deepEqual(imageInfo(out), { format: 'jpeg', width: 40, height: 30 }, name);
    assert.ok(out.length <= 1000, name);
  }
  // A PNG with sides above 4096 px is resized even when it is small in bytes.
  const wide = encodePng({ width: 5000, height: 10, colorType: 0, depth: 1, sample: () => [1] });
  assert.ok(wide.length < 1000);
  const out = await prepareArtwork(wide);
  assert.deepEqual(imageInfo(out), { format: 'jpeg', width: 400, height: 1 });
  assert.ok(jpeg.decode(out, { useTArray: true }).data[0] > 250);
});

test('prepareArtwork refuses what the core would refuse and it cannot fix', async () => {
  await assert.rejects(
    prepareArtwork(Buffer.from('GIF89a\x10\x00\x10\x00\x00\x00', 'latin1')),
    (error) => {
      assert.ok(isCode('UNKNOWN_FORMAT')(error));
      assert.match(error.message, /gif/);
      return true;
    },
  );
  await assert.rejects(
    prepareArtwork(Buffer.from('<html>not found</html>')),
    isCode('UNKNOWN_FORMAT'),
  );
  const webp = Buffer.alloc(400 * 1024);
  webp.write('RIFF', 0);
  webp.write('WEBPVP8X', 8);
  await assert.rejects(prepareArtwork(webp), isCode('UNSUPPORTED'));
  // A JPEG without a frame header, larger than the core accepts.
  const headless = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(400_000)]);
  await assert.rejects(prepareArtwork(headless), isCode('CORRUPT'));
  // Above the pixel limit.
  await assert.rejects(
    prepareArtwork(fixture('baseline-420.jpg'), { maxBytes: 10, maxPixels: 1000 }),
    isCode('TOO_LARGE'),
  );
  // No quality fits.
  await assert.rejects(
    prepareArtwork(fixture('baseline-420.jpg'), { maxBytes: 200 }),
    isCode('TOO_LARGE'),
  );
  // After a refusal, the next resizing still runs.
  assert.ok(
    (await prepareArtwork(fixture('baseline-420.jpg'), { maxBytes: 1000, maxSize: 20 })).length <=
      1000,
  );
});

test('readLimited reads a stream, and stops above the limit', async () => {
  const parts = [Buffer.from('abc'), Buffer.from('def')];
  assert.equal((await readLimited(Readable.from(parts), 6)).toString(), 'abcdef');
  await assert.rejects(readLimited(Readable.from(parts), 5), isCode('TOO_LARGE'));
  assert.equal((await readLimited(null)).length, 0);
});
