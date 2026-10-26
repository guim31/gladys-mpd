// -----------------------------------------------------------------------------
// Artwork for the Gladys 5.3 music player, made small enough for the core, in
// plain JavaScript (no sharp, no native binary).
//
// The core serves an artwork only as PNG, JPEG or WebP of 300 KB at most and
// 4096 × 4096 px at most (capabilities/music.md, section 3), and never
// recompresses: the integration has to. Local sources (Mopidy-Local, MPD…)
// serve the cover as it is on disk, often a few megabytes.
//
//   - An image the core already accepts is returned as it is.
//   - A larger JPEG or PNG becomes a JPEG of at most `maxSize` px on its
//     longest side (400: the now-playing frame renders under 400 px wide, a
//     list thumbnail under 64 px), under `maxBytes`.
//   - Anything else (GIF, BMP, a WebP too large, a corrupt file) is refused
//     with an ArtworkError, never sent for the core to refuse.
//
// Memory is bounded for a 256 MB container, whatever the size of the image:
//   - JPEG is decoded here, at 1/8, 1/4 or 1/2 of its size straight from the
//     DCT coefficients (the libjpeg "scaled IDCT"): a baseline image keeps no
//     coefficient, a progressive one keeps the few it needs per 8 × 8 block
//     plus a bitmap of the others. A full decoder (jpeg-js) needs ~25 bytes per
//     pixel: a 3000 × 3000 cover would take 200 MB.
//   - PNG is inflated as a stream (node:zlib), row by row, each row added into
//     a reduced grid: two rows in memory, never the bitmap.
//   - The pixel count is capped (decoding time), and so is the memory the
//     decoder would allocate, both checked on the header, before allocating.
//     A forged JPEG cannot loop over empty scans: at most 100 scans, and a
//     scan whose data ran out stops.
//   - Resizings run one at a time, and the JPEG decoder yields to the event
//     loop every 40 ms (the PNG one is a stream).
//
// Not handled: arithmetic-coded, lossless, hierarchical and 12-bit JPEG,
// the EXIF orientation (covers are upright), color profiles. Transparent PNG
// pixels are laid on a white background (JPEG has no alpha).
//
// Self-contained on purpose: node:zlib and the jpeg-js encoder only, nothing
// from the integration. It is copied as is into other integrations (MPD…).
// -----------------------------------------------------------------------------

import { createInflate } from 'node:zlib';
import jpeg from 'jpeg-js';

export const ARTWORK_DEFAULTS = Object.freeze({
  /** The core refuses an artwork above 300 KB. */
  maxBytes: 300 * 1024,
  /** Longest side of a resized artwork, in px. */
  maxSize: 400,
  /** The core refuses a side above 4096 px. */
  maxDimension: 4096,
  /** Larger images are refused (decoding time: ~2 s for 25 Mpx). */
  maxPixels: 25_000_000,
  /** Memory the decoder may allocate for one image. */
  maxDecodeBytes: 48 * 1024 * 1024,
  /** JPEG quality of a resized artwork (lowered if it does not fit). */
  quality: 85,
  /** Under transparent pixels. */
  background: Object.freeze([255, 255, 255]),
});

/** Cap for a download read with `readLimited` (callers' choice). */
export const MAX_ARTWORK_DOWNLOAD = 10 * 1024 * 1024;

export class ArtworkError extends Error {
  /**
   * @param {'UNKNOWN_FORMAT'|'UNSUPPORTED'|'TOO_LARGE'|'CORRUPT'} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = 'ArtworkError';
    this.code = code;
  }
}

const corrupt = (what) => new ArtworkError('CORRUPT', `Corrupt image: ${what}`);

// --- Header ------------------------------------------------------------------

/**
 * The format and size of an image, read from its header only.
 * @param {Uint8Array} data
 * @returns {{ format: 'jpeg'|'png'|'webp'|'gif'|null, width: number|null, height: number|null }}
 */
export function imageInfo(data) {
  const none = { format: null, width: null, height: null };
  if (!data || data.length < 12) {
    return none;
  }
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return { format: 'jpeg', ...jpegSize(data) };
  }
  if (
    data[0] === 0x89 &&
    ascii(data, 1, 3) === 'PNG' &&
    data.length >= 24 &&
    ascii(data, 12, 4) === 'IHDR'
  ) {
    return { format: 'png', width: u32(data, 16) || null, height: u32(data, 20) || null };
  }
  if (ascii(data, 0, 4) === 'RIFF' && ascii(data, 8, 4) === 'WEBP') {
    return { format: 'webp', ...webpSize(data) };
  }
  if (ascii(data, 0, 4) === 'GIF8') {
    return { format: 'gif', width: data[6] | (data[7] << 8), height: data[8] | (data[9] << 8) };
  }
  return none;
}

const ascii = (data, at, length) => String.fromCharCode(...data.subarray(at, at + length));
const u16 = (data, at) => (data[at] << 8) | data[at + 1];
const u32 = (data, at) =>
  ((data[at] << 24) | (data[at + 1] << 16) | (data[at + 2] << 8) | data[at + 3]) >>> 0;

/** The size in the first SOF marker of a JPEG. */
function jpegSize(data) {
  let pos = 2;
  while (pos + 9 < data.length) {
    if (data[pos] !== 0xff) {
      return { width: null, height: null };
    }
    const marker = data[pos + 1];
    if (marker === 0xff) {
      pos += 1;
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      pos += 2;
      continue;
    }
    if (isSof(marker)) {
      return { width: u16(data, pos + 7) || null, height: u16(data, pos + 5) || null };
    }
    if (marker === 0xd9 || marker === 0xda) {
      break;
    }
    pos += 2 + u16(data, pos + 2);
  }
  return { width: null, height: null };
}

const isSof = (marker) =>
  marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;

function webpSize(data) {
  const chunk = ascii(data, 12, 4);
  if (chunk === 'VP8 ' && data.length >= 30) {
    return {
      width: (data[26] | (data[27] << 8)) & 0x3fff,
      height: (data[28] | (data[29] << 8)) & 0x3fff,
    };
  }
  if (chunk === 'VP8L' && data.length >= 25) {
    const bits = (data[21] | (data[22] << 8) | (data[23] << 16) | (data[24] << 24)) >>> 0;
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (chunk === 'VP8X' && data.length >= 30) {
    return {
      width: 1 + (data[24] | (data[25] << 8) | (data[26] << 16)),
      height: 1 + (data[27] | (data[28] << 8) | (data[29] << 16)),
    };
  }
  return { width: null, height: null };
}

// --- Entry points -------------------------------------------------------------

/**
 * An image the core accepts: the input itself when it already fits, else a
 * JPEG of at most `maxSize` px on its longest side and `maxBytes` bytes.
 * @param {Uint8Array} input the image as read from the source
 * @param {Partial<typeof ARTWORK_DEFAULTS>} [options]
 * @returns {Promise<Buffer>}
 * @throws {ArtworkError}
 */
export async function prepareArtwork(input, options = {}) {
  const o = { ...ARTWORK_DEFAULTS, ...options };
  const data = Buffer.isBuffer(input)
    ? input
    : Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  const info = imageInfo(data);
  if (info.format !== 'jpeg' && info.format !== 'png' && info.format !== 'webp') {
    throw new ArtworkError(
      'UNKNOWN_FORMAT',
      `Not a PNG, JPEG or WebP image${info.format ? ` (${info.format})` : ''}`,
    );
  }
  const fits =
    info.width !== null &&
    info.height !== null &&
    info.width <= o.maxDimension &&
    info.height <= o.maxDimension;
  if (fits && data.length <= o.maxBytes) {
    return data;
  }
  if (info.format === 'webp') {
    throw new ArtworkError(
      'UNSUPPORTED',
      `A WebP image of ${data.length} bytes cannot be made smaller here`,
    );
  }
  return queued(() => resizeArtwork(data, info, o));
}

/**
 * Reads a stream (a fetch body, a Node stream…) into a Buffer, refusing it as
 * soon as it goes over `maxBytes`.
 * @param {AsyncIterable<Uint8Array>|null|undefined} source
 * @param {number} [maxBytes]
 * @returns {Promise<Buffer>}
 */
export async function readLimited(source, maxBytes = MAX_ARTWORK_DOWNLOAD) {
  const chunks = [];
  let size = 0;
  for await (const chunk of source ?? []) {
    size += chunk.length;
    if (size > maxBytes) {
      throw new ArtworkError('TOO_LARGE', `Image larger than ${sizeText(maxBytes)}`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

const sizeText = (bytes) =>
  bytes >= 1024 * 1024 ? `${Math.round((bytes / 1024 / 1024) * 10) / 10} MB` : `${bytes} bytes`;

// One resizing at a time: their memory never adds up.
let queue = Promise.resolve();
function queued(work) {
  const run = queue.then(work);
  queue = run.catch(() => {});
  return run;
}

/** Decode reduced, resample, encode. */
async function resizeArtwork(data, info, o) {
  const { width, height } = info;
  if (!width || !height) {
    throw corrupt('no image size in the header');
  }
  if (width * height > o.maxPixels) {
    throw new ArtworkError(
      'TOO_LARGE',
      `Image of ${width} × ${height} px: more than ${o.maxPixels} pixels`,
    );
  }
  const scale = Math.min(1, o.maxSize / Math.max(width, height));
  const target = {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
  const reduced =
    info.format === 'jpeg' ? await decodeJpeg(data, target, o) : await decodePng(data, target, o);
  const rgba = resample(reduced, target.width, target.height);
  for (const quality of [o.quality, 70, 55, 40]) {
    const encoded = jpeg.encode(
      { data: rgba, width: target.width, height: target.height },
      quality,
    ).data;
    if (encoded.length <= o.maxBytes) {
      return encoded;
    }
  }
  throw new ArtworkError(
    'TOO_LARGE',
    `No JPEG of ${target.width} × ${target.height} px under ${o.maxBytes} bytes`,
  );
}

/**
 * Area-averaging resample of an RGB image into an RGBA buffer (the encoder's
 * input).
 * @param {{ width: number, height: number, data: Uint8Array }} src RGB
 */
function resample(src, width, height) {
  const xs = axisWeights(src.width, width);
  const ys = axisWeights(src.height, height);
  // Horizontal pass, then vertical.
  const row = new Float32Array(src.height * width * 3);
  for (let y = 0; y < src.height; y++) {
    const line = y * src.width * 3;
    for (let x = 0; x < width; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (const [i, w] of xs[x]) {
        const at = line + i * 3;
        r += src.data[at] * w;
        g += src.data[at + 1] * w;
        b += src.data[at + 2] * w;
      }
      const at = (y * width + x) * 3;
      row[at] = r;
      row[at + 1] = g;
      row[at + 2] = b;
    }
  }
  const out = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (const [i, w] of ys[y]) {
        const at = (i * width + x) * 3;
        r += row[at] * w;
        g += row[at + 1] * w;
        b += row[at + 2] * w;
      }
      const at = (y * width + x) * 4;
      out[at] = clamp(r);
      out[at + 1] = clamp(g);
      out[at + 2] = clamp(b);
      out[at + 3] = 255;
    }
  }
  return out;
}

/** For each destination index, the source indexes it covers and their weights (sum 1). */
function axisWeights(from, to) {
  const ratio = from / to;
  const weights = [];
  for (let d = 0; d < to; d++) {
    const start = d * ratio;
    const end = Math.min(from, (d + 1) * ratio);
    const list = [];
    for (let i = Math.floor(start); i < Math.ceil(end); i++) {
      list.push([i, (Math.min(end, i + 1) - Math.max(start, i)) / (end - start)]);
    }
    weights.push(list);
  }
  return weights;
}

const clamp = (v) => (v <= 0 ? 0 : v >= 255 ? 255 : Math.round(v));

// --- JPEG ---------------------------------------------------------------------

// Zigzag index -> natural index (row * 8 + column) of a coefficient.
const ZIGZAG = Uint8Array.from([
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20,
  13, 6, 7, 14, 21, 28, 35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52,
  45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63,
]);

// For an output block of k × k (k = 8 / reduction): where each zigzag
// coefficient goes in the k × k low-frequency block, -1 when it is not used;
// and the k-point IDCT matrix: out[x] = sum_u M[x * k + u] * F[u]. With the
// coefficients of the 8-point DCT, the k-point IDCT of the k lowest
// frequencies gives the block averaged down to k × k (libjpeg's jidctred).
const SCALED = new Map(
  [1, 2, 4, 8].map((k) => {
    const store = new Int8Array(64);
    for (let z = 0; z < 64; z++) {
      const row = ZIGZAG[z] >> 3;
      const col = ZIGZAG[z] & 7;
      store[z] = row < k && col < k ? row * k + col : -1;
    }
    const matrix = new Float64Array(k * k);
    for (let x = 0; x < k; x++) {
      for (let u = 0; u < k; u++) {
        matrix[x * k + u] =
          0.5 * (u === 0 ? Math.SQRT1_2 : 1) * Math.cos(((2 * x + 1) * u * Math.PI) / (2 * k));
      }
    }
    return [k, { store, matrix }];
  }),
);

// A real progressive JPEG has about ten scans; more is a forged file.
const MAX_SCANS = 100;
// Zero bytes a scan may read past its data (the reader prefetches 4) before
// it is cut short.
const MAX_PADDING = 64;
// The longest stretch of decoding between two yields to the event loop.
const SLICE_MS = 40;

function buildHuffman(counts, symbols) {
  const lookup = new Uint16Array(512); // 9-bit codes: (length << 8) | symbol
  const maxcode = new Int32Array(17).fill(-1);
  const mincode = new Int32Array(17);
  const valptr = new Int32Array(17);
  let code = 0;
  let k = 0;
  for (let length = 1; length <= 16; length++) {
    valptr[length] = k;
    mincode[length] = code;
    for (let i = 0; i < counts[length - 1]; i++, k++, code++) {
      if (code >= 1 << length) {
        throw corrupt('Huffman table');
      }
      if (length <= 9) {
        const shift = 9 - length;
        lookup.fill((length << 8) | symbols[k], code << shift, (code + 1) << shift);
      }
    }
    if (counts[length - 1]) {
      maxcode[length] = code - 1;
    }
    code <<= 1;
  }
  return { lookup, maxcode, mincode, valptr, symbols };
}

/**
 * Decodes a JPEG reduced by 1, 2, 4 or 8: the largest reduction that keeps
 * the image at least as large as the target.
 * @returns {{ width: number, height: number, data: Uint8Array }} RGB
 */
export async function decodeJpeg(data, target, o = ARTWORK_DEFAULTS) {
  const quant = [];
  const dcTables = [];
  const acTables = [];
  let frame = null;
  let restartInterval = 0;
  let adobe = null;

  // Entropy-coded data: a bit reader over `pos`, stopping at markers (it then
  // feeds zeros), unstuffing 0xFF00.
  let pos = 0;
  let bits = 0;
  let count = 0;
  let marker = false;
  // Zero bytes fed since the reader met a marker: a scan whose data ran out
  // (truncated, or forged: empty scans over a large frame) is cut short.
  let padding = 0;
  const fill = () => {
    while (count <= 24) {
      let byte = 0;
      if (!marker && pos < data.length) {
        byte = data[pos];
        if (byte === 0xff) {
          const next = data[pos + 1];
          if (next === 0) {
            pos += 2;
          } else {
            marker = true;
            byte = 0;
          }
        } else {
          pos += 1;
        }
      } else {
        padding += 1;
      }
      bits = ((bits << 8) | byte) >>> 0;
      count += 8;
    }
  };
  const readBits = (n) => {
    if (n === 0) {
      return 0;
    }
    if (count < n) {
      fill();
    }
    count -= n;
    return (bits >>> count) & ((1 << n) - 1);
  };
  const readBit = () => readBits(1);
  const extend = (v, n) => (v < 1 << (n - 1) ? v - (1 << n) + 1 : v);
  const receive = (n) => (n === 0 ? 0 : extend(readBits(n), n));
  const decodeHuffman = (table) => {
    if (count < 16) {
      fill();
    }
    const look = table.lookup[(bits >>> (count - 9)) & 0x1ff];
    if (look) {
      count -= look >> 8;
      return look & 0xff;
    }
    for (let length = 10; length <= 16; length++) {
      const code = (bits >>> (count - length)) & ((1 << length) - 1);
      if (code <= table.maxcode[length]) {
        count -= length;
        return table.symbols[table.valptr[length] + code - table.mincode[length]];
      }
    }
    throw corrupt('Huffman code');
  };
  const resetBits = () => {
    bits = 0;
    count = 0;
    marker = false;
    padding = 0;
  };

  let k = 8;
  let scaled = SCALED.get(8);
  const block = new Float64Array(64);
  const tmp = new Float64Array(64);

  /** k × k IDCT of `block` into a component plane. */
  const idct = (c, row, col) => {
    const m = scaled.matrix;
    for (let v = 0; v < k; v++) {
      for (let x = 0; x < k; x++) {
        let sum = 0;
        for (let u = 0; u < k; u++) {
          sum += m[x * k + u] * block[v * k + u];
        }
        tmp[v * k + x] = sum;
      }
    }
    let at = row * k * c.planeWidth + col * k;
    for (let y = 0; y < k; y++, at += c.planeWidth) {
      for (let x = 0; x < k; x++) {
        let sum = 128;
        for (let v = 0; v < k; v++) {
          sum += m[y * k + v] * tmp[v * k + x];
        }
        c.plane[at + x] = sum <= 0 ? 0 : sum >= 255 ? 255 : Math.round(sum);
      }
    }
  };

  const table = (c) => {
    const q = quant[c.tq];
    if (!q) {
      throw corrupt('missing quantization table');
    }
    return q;
  };

  // Sequential (baseline, extended): decoded block by block, no coefficient kept.
  const decodeBaseline = (c, row, col) => {
    const q = table(c);
    block.fill(0, 0, k * k);
    c.pred += receive(decodeHuffman(c.dc));
    block[0] = c.pred * q[0];
    for (let z = 1; z < 64;) {
      const rs = decodeHuffman(c.ac);
      const s = rs & 15;
      const r = rs >> 4;
      if (s === 0) {
        if (r !== 15) {
          break;
        }
        z += 16;
        continue;
      }
      z += r;
      if (z > 63) {
        break;
      }
      const value = receive(s);
      const i = scaled.store[z];
      if (i >= 0) {
        block[i] = value * q[z];
      }
      z += 1;
    }
    if (row < c.blocksPerColumn && col < c.blocksPerLine) {
      idct(c, row, col);
    }
  };

  // Progressive: the k × k coefficients kept per block, and a bitmap of the
  // non-zero ones among the 64 (an AC refinement scan reads a correction bit
  // for each non-zero coefficient of its band, kept or not).
  let eobrun = 0;
  let scan = null;
  const isNonZero = (c, b, z) => (c.nonZero[b * 2 + (z >> 5)] >>> (z & 31)) & 1;
  const setCoefficient = (c, b, z, value) => {
    c.nonZero[b * 2 + (z >> 5)] |= 1 << (z & 31);
    const i = scaled.store[z];
    if (i >= 0) {
      c.coefficients[b * c.kept + i] = value;
    }
  };
  const decodeDcFirst = (c, row, col) => {
    c.pred += receive(decodeHuffman(c.dc));
    c.coefficients[(row * c.blocksPerLineForMcu + col) * c.kept] = c.pred * (1 << scan.al);
  };
  const decodeDcRefine = (c, row, col) => {
    if (readBit()) {
      c.coefficients[(row * c.blocksPerLineForMcu + col) * c.kept] |= 1 << scan.al;
    }
  };
  const decodeAcFirst = (c, row, col) => {
    if (eobrun > 0) {
      eobrun -= 1;
      return;
    }
    const b = row * c.blocksPerLineForMcu + col;
    for (let z = scan.ss; z <= scan.se;) {
      const rs = decodeHuffman(c.ac);
      const s = rs & 15;
      const r = rs >> 4;
      if (s === 0) {
        if (r < 15) {
          eobrun = (1 << r) - 1 + readBits(r);
          break;
        }
        z += 16;
        continue;
      }
      z += r;
      if (z > 63) {
        break;
      }
      setCoefficient(c, b, z, receive(s) * (1 << scan.al));
      z += 1;
    }
  };
  // libjpeg's decode_mcu_AC_refine, on the kept coefficients and the bitmap.
  const decodeAcRefine = (c, row, col) => {
    const b = row * c.blocksPerLineForMcu + col;
    const p1 = 1 << scan.al;
    const m1 = -1 << scan.al;
    const refine = (z) => {
      if (readBit()) {
        const i = scaled.store[z];
        if (i >= 0) {
          const at = b * c.kept + i;
          const value = c.coefficients[at];
          if ((value & p1) === 0) {
            c.coefficients[at] = value + (value >= 0 ? p1 : m1);
          }
        }
      }
    };
    let z = scan.ss;
    if (eobrun === 0) {
      for (; z <= scan.se; z++) {
        const rs = decodeHuffman(c.ac);
        let r = rs >> 4;
        let s = rs & 15;
        if (s) {
          s = readBit() ? p1 : m1;
        } else if (r !== 15) {
          eobrun = (1 << r) + readBits(r);
          break;
        }
        while (z <= scan.se) {
          if (isNonZero(c, b, z)) {
            refine(z);
          } else if (--r < 0) {
            break;
          }
          z += 1;
        }
        if (s && z <= 63) {
          setCoefficient(c, b, z, s);
        }
      }
    }
    if (eobrun > 0) {
      for (; z <= scan.se; z++) {
        if (isNonZero(c, b, z)) {
          refine(z);
        }
      }
      eobrun -= 1;
    }
  };

  const startFrame = (at, progressive) => {
    if (frame) {
      throw new ArtworkError('UNSUPPORTED', 'JPEG with several frames');
    }
    if (data[at] !== 8) {
      throw new ArtworkError('UNSUPPORTED', `JPEG of ${data[at]} bits per sample`);
    }
    const height = u16(data, at + 1);
    const width = u16(data, at + 3);
    const n = data[at + 5];
    if (!width || !height) {
      throw new ArtworkError('UNSUPPORTED', 'JPEG without a size in its frame header');
    }
    if (width * height > o.maxPixels) {
      throw new ArtworkError(
        'TOO_LARGE',
        `Image of ${width} × ${height} px: more than ${o.maxPixels} pixels`,
      );
    }
    if (n !== 1 && n !== 3 && n !== 4) {
      throw new ArtworkError('UNSUPPORTED', `JPEG with ${n} components`);
    }
    const components = [];
    for (let i = 0; i < n; i++) {
      const h = data[at + 7 + i * 3] >> 4;
      const v = data[at + 7 + i * 3] & 15;
      if (h < 1 || h > 4 || v < 1 || v > 4) {
        throw corrupt('sampling factors');
      }
      components.push({ id: data[at + 6 + i * 3], h, v, tq: data[at + 8 + i * 3] & 3 });
    }
    const maxH = Math.max(...components.map((c) => c.h));
    const maxV = Math.max(...components.map((c) => c.v));
    for (const reduction of [8, 4, 2, 1]) {
      if (
        Math.ceil(width / reduction) >= target.width &&
        Math.ceil(height / reduction) >= target.height
      ) {
        k = 8 / reduction;
        break;
      }
    }
    scaled = SCALED.get(k);
    const mcusPerLine = Math.ceil(width / (8 * maxH));
    const mcusPerColumn = Math.ceil(height / (8 * maxV));
    let memory = 0;
    for (const c of components) {
      // As libjpeg: the blocks of the component's own samples.
      c.blocksPerLine = Math.ceil(Math.ceil((width * c.h) / maxH) / 8);
      c.blocksPerColumn = Math.ceil(Math.ceil((height * c.v) / maxV) / 8);
      c.blocksPerLineForMcu = mcusPerLine * c.h;
      c.blocksPerColumnForMcu = mcusPerColumn * c.v;
      c.planeWidth = c.blocksPerLine * k;
      memory += c.planeWidth * c.blocksPerColumn * k;
      if (progressive) {
        c.kept = k * k;
        memory += c.blocksPerLineForMcu * c.blocksPerColumnForMcu * (8 + 2 * c.kept);
      }
    }
    if (memory > o.maxDecodeBytes) {
      throw new ArtworkError('TOO_LARGE', `Decoding this JPEG would take ${memory} bytes`);
    }
    for (const c of components) {
      c.plane = new Uint8Array(c.planeWidth * c.blocksPerColumn * k);
      if (progressive) {
        const blocks = c.blocksPerLineForMcu * c.blocksPerColumnForMcu;
        c.coefficients = new Int16Array(blocks * c.kept);
        c.nonZero = new Uint32Array(blocks * 2);
      }
    }
    frame = { width, height, progressive, components, maxH, maxV, mcusPerLine, mcusPerColumn };
  };

  let scans = 0;
  const decodeScan = async (at) => {
    scans += 1;
    if (scans > MAX_SCANS) {
      throw corrupt('too many scans');
    }
    if (!frame) {
      throw corrupt('scan before the frame header');
    }
    const n = data[at];
    const components = [];
    for (let i = 0; i < n; i++) {
      const c = frame.components.find((x) => x.id === data[at + 1 + i * 2]);
      if (!c) {
        throw corrupt('unknown component in a scan');
      }
      c.dc = dcTables[data[at + 2 + i * 2] >> 4];
      c.ac = acTables[data[at + 2 + i * 2] & 15];
      c.pred = 0;
      components.push(c);
    }
    const after = at + 1 + n * 2;
    scan = {
      ss: data[after],
      se: data[after + 1],
      ah: data[after + 2] >> 4,
      al: data[after + 2] & 15,
    };
    let decodeBlock;
    if (!frame.progressive) {
      decodeBlock = decodeBaseline;
    } else if (scan.ss === 0) {
      if (scan.se !== 0) {
        throw corrupt('progressive DC scan');
      }
      decodeBlock = scan.ah === 0 ? decodeDcFirst : decodeDcRefine;
    } else {
      if (n !== 1 || scan.se > 63 || scan.ss > scan.se) {
        throw corrupt('progressive AC scan');
      }
      decodeBlock = scan.ah === 0 ? decodeAcFirst : decodeAcRefine;
    }
    const dcNeeded = decodeBlock === decodeBaseline || decodeBlock === decodeDcFirst;
    const acNeeded =
      decodeBlock === decodeBaseline ||
      decodeBlock === decodeAcFirst ||
      decodeBlock === decodeAcRefine;
    for (const c of components) {
      if ((dcNeeded && !c.dc) || (acNeeded && !c.ac)) {
        throw corrupt('missing Huffman table');
      }
    }
    resetBits();
    eobrun = 0;
    const single = components.length === 1;
    const mcusPerLine = single ? components[0].blocksPerLine : frame.mcusPerLine;
    const total = single
      ? mcusPerLine * components[0].blocksPerColumn
      : mcusPerLine * frame.mcusPerColumn;
    let slice = performance.now();
    for (let mcu = 0; mcu < total; mcu++) {
      if (padding > MAX_PADDING) {
        return; // no data left in this scan: the rest stays as it is
      }
      if ((mcu & 255) === 0 && performance.now() - slice > SLICE_MS) {
        // Let the integration breathe (acks, states) on a large image.
        await new Promise((resolve) => setImmediate(resolve));
        slice = performance.now();
      }
      if (restartInterval && mcu > 0 && mcu % restartInterval === 0) {
        // Skip to the RSTn marker; any other marker ends the scan.
        while (
          pos < data.length &&
          !(data[pos] === 0xff && data[pos + 1] >= 0xd0 && data[pos + 1] <= 0xd7)
        ) {
          if (data[pos] === 0xff && data[pos + 1] !== 0 && data[pos + 1] !== 0xff) {
            return;
          }
          pos += 1;
        }
        pos += 2;
        resetBits();
        eobrun = 0;
        for (const c of components) {
          c.pred = 0;
        }
      }
      const mcuRow = Math.floor(mcu / mcusPerLine);
      const mcuCol = mcu % mcusPerLine;
      if (single) {
        decodeBlock(components[0], mcuRow, mcuCol);
        continue;
      }
      for (const c of components) {
        for (let v = 0; v < c.v; v++) {
          for (let h = 0; h < c.h; h++) {
            decodeBlock(c, mcuRow * c.v + v, mcuCol * c.h + h);
          }
        }
      }
    }
  };

  // Markers.
  pos = 2;
  while (pos < data.length - 1) {
    if (data[pos] !== 0xff) {
      pos += 1; // garbage between segments, or the end of a scan
      continue;
    }
    const m = data[pos + 1];
    if (m === 0xff || m === 0x00 || m === 0x01 || m === 0xd8 || (m >= 0xd0 && m <= 0xd7)) {
      pos += m === 0xff ? 1 : 2;
      continue;
    }
    if (m === 0xd9) {
      break;
    }
    if (pos + 4 > data.length) {
      break;
    }
    const length = u16(data, pos + 2);
    const at = pos + 4;
    const end = pos + 2 + length;
    if (length < 2 || end > data.length) {
      throw corrupt('truncated segment');
    }
    if (m === 0xdb) {
      for (let i = at; i < end;) {
        const precision = data[i] >> 4;
        const id = data[i] & 3;
        const q = new Uint16Array(64);
        for (let z = 0; z < 64; z++) {
          q[z] = precision ? u16(data, i + 1 + z * 2) : data[i + 1 + z];
        }
        quant[id] = q;
        i += 1 + (precision ? 128 : 64);
      }
    } else if (m === 0xc4) {
      for (let i = at; i < end;) {
        const counts = data.subarray(i + 1, i + 17);
        const total = counts.reduce((a, b) => a + b, 0);
        const t = buildHuffman(counts, data.subarray(i + 17, i + 17 + total));
        (data[i] >> 4 ? acTables : dcTables)[data[i] & 15] = t;
        i += 17 + total;
      }
    } else if (m === 0xdd) {
      restartInterval = u16(data, at);
    } else if (m === 0xee && ascii(data, at, 5) === 'Adobe') {
      adobe = { transform: data[at + 11] };
    } else if (m === 0xc0 || m === 0xc1 || m === 0xc2) {
      startFrame(at, m === 0xc2);
    } else if (isSof(m)) {
      throw new ArtworkError('UNSUPPORTED', 'Lossless, hierarchical or arithmetic-coded JPEG');
    } else if (m === 0xda) {
      pos = end;
      await decodeScan(at);
      // Past the entropy-coded data: the next marker other than RSTn.
      while (
        pos < data.length - 1 &&
        !(
          data[pos] === 0xff &&
          data[pos + 1] !== 0 &&
          data[pos + 1] !== 0xff &&
          (data[pos + 1] < 0xd0 || data[pos + 1] > 0xd7)
        )
      ) {
        pos += 1;
      }
      continue;
    }
    pos = end;
  }
  if (!frame) {
    throw corrupt('no frame header');
  }

  if (frame.progressive) {
    for (const c of frame.components) {
      const q = table(c);
      for (let row = 0; row < c.blocksPerColumn; row++) {
        for (let col = 0; col < c.blocksPerLine; col++) {
          const base = (row * c.blocksPerLineForMcu + col) * c.kept;
          for (let z = 0; z < 64; z++) {
            const i = scaled.store[z];
            if (i >= 0) {
              block[i] = c.coefficients[base + i] * q[z];
            }
          }
          idct(c, row, col);
        }
      }
      c.coefficients = null;
      c.nonZero = null;
    }
  }
  return jpegToRgb(frame, k, adobe);
}

/** The component planes, upsampled to the reduced frame size, to RGB. */
function jpegToRgb(frame, k, adobe) {
  const width = Math.ceil((frame.width * k) / 8);
  const height = Math.ceil((frame.height * k) / 8);
  const out = new Uint8Array(width * height * 3);
  const comps = frame.components;
  // A subsampled component (chroma) is interpolated (bilinear, centers
  // aligned), the others are read as they are.
  const axis = (n, factor, size) => {
    const low = new Int32Array(n);
    const high = new Int32Array(n);
    const weight = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const at = Math.min(size - 1, Math.max(0, (i + 0.5) * factor - 0.5));
      low[i] = Math.floor(at);
      high[i] = Math.min(size - 1, low[i] + 1);
      weight[i] = at - low[i];
    }
    return { low, high, weight };
  };
  const columns = comps.map((c) => axis(width, c.h / frame.maxH, c.planeWidth));
  const rows = comps.map((c) => axis(height, c.v / frame.maxV, c.blocksPerColumn * k));
  const rgbIds =
    comps.length === 3 && comps[0].id === 82 && comps[1].id === 71 && comps[2].id === 66;
  const mode =
    comps.length === 1
      ? 'gray'
      : comps.length === 3
        ? (adobe ? adobe.transform === 0 : rgbIds)
          ? 'rgb'
          : 'ycc'
        : adobe?.transform === 2
          ? 'ycck'
          : adobe
            ? 'cmyk-inverted'
            : 'cmyk';
  const sample = new Float64Array(4);
  let o = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      for (let i = 0; i < comps.length; i++) {
        const { plane, planeWidth } = comps[i];
        const col = columns[i];
        const row = rows[i];
        const top = row.low[y] * planeWidth;
        const bottom = row.high[y] * planeWidth;
        const fx = col.weight[x];
        const fy = row.weight[y];
        const a = plane[top + col.low[x]] * (1 - fx) + plane[top + col.high[x]] * fx;
        const b = plane[bottom + col.low[x]] * (1 - fx) + plane[bottom + col.high[x]] * fx;
        sample[i] = a * (1 - fy) + b * fy;
      }
      let r = sample[0];
      let g = sample[0];
      let b = sample[0];
      if (mode === 'rgb') {
        g = sample[1];
        b = sample[2];
      } else if (mode === 'ycc' || mode === 'ycck') {
        const cb = sample[1] - 128;
        const cr = sample[2] - 128;
        r = sample[0] + 1.402 * cr;
        g = sample[0] - 0.344136 * cb - 0.714136 * cr;
        b = sample[0] + 1.772 * cb;
        if (mode === 'ycck') {
          // YCCK holds the inverted CMY of an Adobe CMYK image: C' = 255 - R…
          const key = sample[3] / 255;
          r = (255 - clamp(r)) * key;
          g = (255 - clamp(g)) * key;
          b = (255 - clamp(b)) * key;
        }
      } else if (mode === 'cmyk-inverted') {
        // Adobe CMYK is stored inverted (255 = no ink).
        const key = sample[3] / 255;
        r = sample[0] * key;
        g = sample[1] * key;
        b = sample[2] * key;
      } else if (mode === 'cmyk') {
        const key = 1 - sample[3] / 255;
        r = (255 - sample[0]) * key;
        g = (255 - sample[1]) * key;
        b = (255 - sample[2]) * key;
      }
      out[o++] = clamp(r);
      out[o++] = clamp(g);
      out[o++] = clamp(b);
    }
  }
  return { width, height, data: out };
}

// --- PNG ----------------------------------------------------------------------

const PNG_CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
const PNG_DEPTHS = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
// Adam7 passes: [x0, y0, dx, dy].
const ADAM7 = [
  [0, 0, 8, 8],
  [4, 0, 8, 8],
  [0, 4, 4, 8],
  [2, 0, 4, 4],
  [0, 2, 2, 4],
  [1, 0, 2, 2],
  [0, 1, 1, 2],
];

/**
 * Decodes a PNG into a grid reduced by an integer factor per axis (the
 * largest that keeps it at least as large as the target), inflating it as a stream: each
 * row is unfiltered then added into the grid, never kept.
 * @returns {Promise<{ width: number, height: number, data: Uint8Array }>} RGB
 */
export async function decodePng(data, target, o = ARTWORK_DEFAULTS) {
  let header = null;
  let palette = null;
  let paletteAlpha = null;
  let transparent = null;
  const idat = [];
  for (let at = 8; at + 8 <= data.length;) {
    const length = u32(data, at);
    const type = ascii(data, at + 4, 4);
    const body = data.subarray(at + 8, at + 8 + length);
    if (body.length < length) {
      throw corrupt('truncated PNG chunk');
    }
    if (type === 'IHDR') {
      header = {
        width: u32(body, 0),
        height: u32(body, 4),
        depth: body[8],
        colorType: body[9],
        interlace: body[12],
      };
      if (
        !PNG_DEPTHS[header.colorType]?.includes(header.depth) ||
        body[10] !== 0 ||
        body[11] !== 0 ||
        body[12] > 1
      ) {
        throw new ArtworkError('UNSUPPORTED', 'PNG with an unknown color type, depth or method');
      }
    } else if (type === 'PLTE') {
      palette = body;
    } else if (type === 'tRNS') {
      transparent = body;
    } else if (type === 'IDAT') {
      idat.push(body);
    } else if (type === 'IEND') {
      break;
    }
    at += 12 + length;
  }
  if (!header || !header.width || !header.height || idat.length === 0) {
    throw corrupt('PNG without a header or image data');
  }
  const { width, height, depth, colorType } = header;
  if (width * height > o.maxPixels) {
    throw new ArtworkError(
      'TOO_LARGE',
      `Image of ${width} × ${height} px: more than ${o.maxPixels} pixels`,
    );
  }
  if (colorType === 3) {
    if (!palette) {
      throw corrupt('PNG palette missing');
    }
    paletteAlpha = new Uint8Array(256).fill(255);
    paletteAlpha.set((transparent ?? new Uint8Array(0)).subarray(0, 256));
  }
  // One factor per axis: a 4 000 000 × 1 px image reduces along its width.
  const reductionX = Math.max(1, Math.floor(width / target.width));
  const reductionY = Math.max(1, Math.floor(height / target.height));
  const gridWidth = Math.ceil(width / reductionX);
  const gridHeight = Math.ceil(height / reductionY);
  const channels = PNG_CHANNELS[colorType];
  const bitsPerPixel = channels * depth;
  const bytesPerPixel = Math.max(1, bitsPerPixel >> 3);
  if (
    // Sums (Float64 × 3) and the result (× 3) per grid pixel, two rows.
    gridWidth * gridHeight * 27 + 2 * (Math.ceil((width * bitsPerPixel) / 8) + 1) >
    o.maxDecodeBytes
  ) {
    throw new ArtworkError('TOO_LARGE', 'Decoding this PNG would take too much memory');
  }
  const sums = new Float64Array(gridWidth * gridHeight * 3);
  const [bgR, bgG, bgB] = o.background;
  const max = (1 << depth) - 1;

  // Raw sample `i` of a row, at the PNG's depth.
  const sampleOf = (row, i) => {
    if (depth === 8) {
      return row[i];
    }
    if (depth === 16) {
      return (row[i * 2] << 8) | row[i * 2 + 1];
    }
    const bit = i * depth;
    return (row[bit >> 3] >> (8 - depth - (bit & 7))) & max;
  };
  const to8 = depth === 16 ? (v) => v / 257 : depth === 8 ? (v) => v : (v) => (v * 255) / max;
  const key =
    transparent?.length >= 2 && colorType === 0
      ? [u16(transparent, 0)]
      : transparent?.length >= 6 && colorType === 2
        ? [u16(transparent, 0), u16(transparent, 2), u16(transparent, 4)]
        : null;

  const addRow = (pass, y, row) => {
    const [x0, , dx] = pass;
    const gridRow = Math.floor(y / reductionY) * gridWidth;
    for (let p = 0, x = x0; x < width; p++, x += dx) {
      let r;
      let g;
      let b;
      let a = 255;
      const s = p * channels;
      if (colorType === 3) {
        const index = sampleOf(row, p);
        r = palette[index * 3] ?? 0;
        g = palette[index * 3 + 1] ?? 0;
        b = palette[index * 3 + 2] ?? 0;
        a = paletteAlpha[index];
      } else if (colorType === 0 || colorType === 4) {
        const raw = sampleOf(row, s);
        r = g = b = to8(raw);
        if (colorType === 4) {
          a = to8(sampleOf(row, s + 1));
        } else if (key && raw === key[0]) {
          a = 0;
        }
      } else {
        const rawR = sampleOf(row, s);
        const rawG = sampleOf(row, s + 1);
        const rawB = sampleOf(row, s + 2);
        r = to8(rawR);
        g = to8(rawG);
        b = to8(rawB);
        if (colorType === 6) {
          a = to8(sampleOf(row, s + 3));
        } else if (key && rawR === key[0] && rawG === key[1] && rawB === key[2]) {
          a = 0;
        }
      }
      if (a < 255) {
        const f = a / 255;
        r = r * f + bgR * (1 - f);
        g = g * f + bgG * (1 - f);
        b = b * f + bgB * (1 - f);
      }
      const at = (gridRow + Math.floor(x / reductionX)) * 3;
      sums[at] += r;
      sums[at + 1] += g;
      sums[at + 2] += b;
    }
  };

  // The passes (one without interlacing), each with its rows.
  const passes = (header.interlace ? ADAM7 : [[0, 0, 1, 1]])
    .map((pass) => {
      const [x0, y0, dx, dy] = pass;
      const columns = Math.ceil((width - x0) / dx);
      const rows = Math.ceil((height - y0) / dy);
      return {
        pass,
        rows: columns > 0 ? rows : 0,
        rowBytes: Math.ceil((columns * bitsPerPixel) / 8),
      };
    })
    .filter((p) => p.rows > 0);

  let passIndex = 0;
  let rowIndex = 0;
  // Two row buffers (filter byte + row), swapped: the current one and the prior.
  let current = new Uint8Array(passes[0].rowBytes + 1);
  let prior = new Uint8Array(passes[0].rowBytes + 1);
  let filled = 0;
  const unfilter = (filter, row, above) => {
    const n = row.length;
    switch (filter) {
      case 0:
        break;
      case 1:
        for (let i = bytesPerPixel; i < n; i++) row[i] = (row[i] + row[i - bytesPerPixel]) & 0xff;
        break;
      case 2:
        for (let i = 0; i < n; i++) row[i] = (row[i] + above[i]) & 0xff;
        break;
      case 3:
        for (let i = 0; i < n; i++) {
          const left = i >= bytesPerPixel ? row[i - bytesPerPixel] : 0;
          row[i] = (row[i] + ((left + above[i]) >> 1)) & 0xff;
        }
        break;
      case 4:
        for (let i = 0; i < n; i++) {
          const left = i >= bytesPerPixel ? row[i - bytesPerPixel] : 0;
          const upLeft = i >= bytesPerPixel ? above[i - bytesPerPixel] : 0;
          const p = left + above[i] - upLeft;
          const pa = Math.abs(p - left);
          const pb = Math.abs(p - above[i]);
          const pc = Math.abs(p - upLeft);
          const predictor = pa <= pb && pa <= pc ? left : pb <= pc ? above[i] : upLeft;
          row[i] = (row[i] + predictor) & 0xff;
        }
        break;
      default:
        throw corrupt('PNG filter type');
    }
  };

  const inflate = createInflate();
  for (const chunk of idat) {
    inflate.write(chunk);
  }
  inflate.end();
  try {
    feed: for await (const chunk of inflate) {
      for (let i = 0; i < chunk.length;) {
        const take = Math.min(current.length - filled, chunk.length - i);
        current.set(chunk.subarray(i, i + take), filled);
        filled += take;
        i += take;
        if (filled < current.length) {
          continue;
        }
        const row = current.subarray(1);
        unfilter(current[0], row, prior.subarray(1));
        const { pass } = passes[passIndex];
        addRow(pass, pass[1] + rowIndex * pass[3], row);
        [prior, current] = [current, prior];
        filled = 0;
        rowIndex += 1;
        if (rowIndex === passes[passIndex].rows) {
          passIndex += 1;
          rowIndex = 0;
          if (passIndex === passes.length) {
            break feed;
          }
          // A new pass starts with an empty prior row.
          current = new Uint8Array(passes[passIndex].rowBytes + 1);
          prior = new Uint8Array(passes[passIndex].rowBytes + 1);
        }
      }
    }
  } catch (error) {
    if (error instanceof ArtworkError) {
      throw error;
    }
    throw corrupt(`PNG data (${error.message})`);
  } finally {
    inflate.destroy();
  }
  if (passIndex < passes.length) {
    throw corrupt('truncated PNG data');
  }

  const out = new Uint8Array(gridWidth * gridHeight * 3);
  for (let gy = 0; gy < gridHeight; gy++) {
    const rows = Math.min(reductionY, height - gy * reductionY);
    for (let gx = 0; gx < gridWidth; gx++) {
      const n = rows * Math.min(reductionX, width - gx * reductionX);
      const at = (gy * gridWidth + gx) * 3;
      out[at] = clamp(sums[at] / n);
      out[at + 1] = clamp(sums[at + 1] / n);
      out[at + 2] = clamp(sums[at + 2] / n);
    }
  }
  return { width: gridWidth, height: gridHeight, data: out };
}
