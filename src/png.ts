import { createDeflate, inflateSync } from 'node:zlib';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Read width/height from a PNG's IHDR chunk without decoding it. */
export function pngSize(buf: Uint8Array): { width: number; height: number } {
  if (buf.length < 24 || SIGNATURE.some((b, i) => buf[i] !== b)) {
    throw new Error('Not a PNG');
  }
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

export interface RawImage {
  width: number;
  height: number;
  /** 3 (RGB) or 4 (RGBA). */
  channels: 3 | 4;
  /** Unfiltered pixel rows, `width * channels` bytes each. */
  data: Buffer;
}

/**
 * Decode an 8-bit RGB/RGBA non-interlaced PNG, which is what Chromium
 * screenshots are. Anything else throws: this is not a general decoder.
 */
export function decodePng(buf: Buffer): RawImage {
  const { width, height } = pngSize(buf);
  let pos = 8;
  const idat: Buffer[] = [];
  let channels: 3 | 4 | undefined;
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    const body = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      const [depth, color, , , interlace] = body.subarray(8, 13);
      if (depth !== 8 || (color !== 2 && color !== 6) || interlace !== 0) {
        throw new Error(`Unsupported PNG (bit depth ${depth}, colour type ${color}, interlace ${interlace})`);
      }
      channels = color === 6 ? 4 : 3;
    } else if (type === 'IDAT') {
      idat.push(body);
    } else if (type === 'IEND') {
      break;
    }
    pos += 12 + len;
  }
  if (!channels) throw new Error('PNG has no IHDR');

  const filtered = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  if (filtered.length < height * (stride + 1)) throw new Error('Truncated PNG data');
  const out = Buffer.alloc(height * stride);
  const bpp = channels;
  for (let y = 0; y < height; y++) {
    const f = filtered[y * (stride + 1)]!;
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    const up = dst - stride;
    for (let i = 0; i < stride; i++) {
      const x = filtered[src + i]!;
      const a = i >= bpp ? out[dst + i - bpp]! : 0;
      const b = y > 0 ? out[up + i]! : 0;
      let v: number;
      switch (f) {
        case 0: v = x; break;
        case 1: v = x + a; break;
        case 2: v = x + b; break;
        case 3: v = x + ((a + b) >> 1); break;
        case 4: {
          const c = y > 0 && i >= bpp ? out[up + i - bpp]! : 0;
          const p = a + b - c;
          const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default: throw new Error(`Bad PNG filter type ${f}`);
      }
      out[dst + i] = v & 0xff;
    }
  }
  return { width, height, channels, data: out };
}

function toChannels(img: RawImage, channels: 3 | 4): Buffer {
  if (img.channels === channels) return img.data;
  const n = img.width * img.height;
  const out = Buffer.alloc(n * channels, 0xff);
  for (let p = 0; p < n; p++) {
    for (let c = 0; c < 3; c++) out[p * channels + c] = img.data[p * img.channels + c]!;
  }
  return out;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(parts: Buffer[]): number {
  let c = 0xffffffff;
  for (const buf of parts) for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, body: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32([head.subarray(4), body]));
  return Buffer.concat([head, body, crc]);
}

/**
 * Stack PNGs of equal width top to bottom into one PNG. Each input is decoded,
 * filtered (Up) and streamed into a single deflate stream, so peak memory is
 * about one input's raw pixels plus the compressed output: the result can be
 * far taller than any canvas or Chromium capture allows.
 */
export async function stitchPngs(pngs: Buffer[]): Promise<Buffer> {
  if (pngs.length === 0) throw new Error('Nothing to stitch');
  if (pngs.length === 1) return pngs[0]!;

  const sizes = pngs.map(pngSize);
  const width = sizes[0]!.width;
  if (sizes.some(s => s.width !== width)) throw new Error('stitchPngs: inputs differ in width');
  const height = sizes.reduce((h, s) => h + s.height, 0);
  // Peek each IHDR colour type so mixed RGB/RGBA inputs share one format.
  const channels: 3 | 4 = pngs.some(p => p[25] === 6) ? 4 : 3;
  const stride = width * channels;

  const deflate = createDeflate({ level: 6, memLevel: 9 });
  const compressed: Buffer[] = [];
  deflate.on('data', (d: Buffer) => compressed.push(d));
  const done = new Promise<void>((res, rej) => {
    deflate.on('end', res);
    deflate.on('error', rej);
  });

  let prev: Buffer | undefined;
  for (const png of pngs) {
    const img = decodePng(png);
    const raw = toChannels(img, channels);
    const out = Buffer.alloc(img.height * (stride + 1));
    for (let y = 0; y < img.height; y++) {
      const row = raw.subarray(y * stride, (y + 1) * stride);
      const o = y * (stride + 1);
      if (!prev) {
        out[o] = 0;
        row.copy(out, o + 1);
      } else {
        out[o] = 2; // Up
        for (let i = 0; i < stride; i++) out[o + 1 + i] = (row[i]! - prev[i]!) & 0xff;
      }
      prev = row;
    }
    // Keep the last row alive past this iteration for the next input's Up filter.
    prev = Buffer.from(prev!);
    if (!deflate.write(out)) await new Promise(r => deflate.once('drain', r));
  }
  deflate.end();
  await done;

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = channels === 4 ? 6 : 2;
  const data = Buffer.concat(compressed);
  const idats: Buffer[] = [];
  const MAX_IDAT = 8 * 1024 * 1024;
  for (let i = 0; i < data.length; i += MAX_IDAT) idats.push(chunk('IDAT', data.subarray(i, i + MAX_IDAT)));
  return Buffer.concat([SIGNATURE, chunk('IHDR', ihdr), ...idats, chunk('IEND', Buffer.alloc(0))]);
}
