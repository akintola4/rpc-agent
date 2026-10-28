import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { decodePng, pngSize, stitchPngs } from '../src/png.js';

/** Minimal reference encoder: every row uses `filter`, RGB or RGBA. */
function encode(width: number, height: number, channels: 3 | 4, pixel: (x: number, y: number) => number[], filter = 0): Buffer {
  const stride = width * channels;
  const raw = Buffer.alloc(height * (stride + 1));
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(stride);
    for (let x = 0; x < width; x++) pixel(x, y).slice(0, channels).forEach((v, c) => (row[x * channels + c] = v));
    const o = y * (stride + 1);
    raw[o] = filter;
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? row[i - channels]! : 0;
      const b = prev[i]!;
      const c = i >= channels ? prev[i - channels]! : 0;
      let pred = 0;
      if (filter === 1) pred = a;
      if (filter === 2) pred = b;
      if (filter === 3) pred = (a + b) >> 1;
      if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      raw[o + 1 + i] = (row[i]! - pred) & 0xff;
    }
    prev = row;
  }
  const chunk = (type: string, body: Buffer) => {
    const h = Buffer.alloc(8);
    h.writeUInt32BE(body.length);
    h.write(type, 4, 'latin1');
    return Buffer.concat([h, body, Buffer.alloc(4)]); // CRC unchecked by our decoder
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = channels === 4 ? 6 : 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const px = (x: number, y: number) => [(x * 7 + y) & 255, (y * 13) & 255, (x ^ y) & 255, 200 + (x % 50)];

describe('png', () => {
  it('decodes every filter type', () => {
    for (const filter of [0, 1, 2, 3, 4]) {
      const img = decodePng(encode(9, 5, 3, px, filter));
      expect([img.width, img.height, img.channels]).toEqual([9, 5, 3]);
      for (const [x, y] of [[0, 0], [8, 4], [3, 2]] as const) {
        expect([...img.data.subarray((y * 9 + x) * 3, (y * 9 + x) * 3 + 3)], `filter ${filter}`).toEqual(px(x, y).slice(0, 3));
      }
    }
  });

  it('stitches inputs top to bottom, decodable and pixel exact', async () => {
    const a = encode(6, 4, 3, px, 4);
    const b = encode(6, 3, 3, (x, y) => px(x, y + 4), 1);
    const c = encode(6, 2, 4, (x, y) => px(x, y + 7), 2); // mixed RGBA input
    const out = await stitchPngs([a, b, c]);
    expect(pngSize(out)).toEqual({ width: 6, height: 9 });
    const img = decodePng(out);
    expect(img.channels).toBe(4);
    for (let y = 0; y < 9; y++) {
      for (let x = 0; x < 6; x++) {
        const got = [...img.data.subarray((y * 6 + x) * 4, (y * 6 + x) * 4 + 3)];
        expect(got, `${x},${y}`).toEqual(px(x, y).slice(0, 3));
      }
    }
  });

  it('rejects mismatched widths', async () => {
    await expect(stitchPngs([encode(2, 2, 3, px), encode(3, 2, 3, px)])).rejects.toThrow(/width/);
  });
});
