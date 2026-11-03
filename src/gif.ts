// A small animated-GIF encoder for `rpc record --gif`, so a GIF needs no
// image library: one median-cut palette shared by all frames, pixels that
// didn't change since the previous frame written as transparent (the frame
// is drawn over the last one), and GIF's variable-width LZW.
import type { RawImage } from './png.js';

/** Palette entries for colours; the last index is transparent. */
const COLOURS = 255;
const TRANSPARENT = 255;
/** Pixels sampled for the palette, across all frames. */
const SAMPLES = 250_000;

const bucket = (r: number, g: number, b: number) => ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);

/** Median cut over a 15-bit colour histogram: up to COLOURS RGB triples. */
export function buildPalette(frames: RawImage[]): Uint8Array {
  const counts = new Uint32Array(32768);
  const sums = new Float64Array(32768 * 3);
  const total = frames.reduce((n, f) => n + f.width * f.height, 0);
  const step = Math.max(1, Math.floor(total / SAMPLES));
  for (const f of frames) {
    for (let i = 0; i < f.width * f.height; i += step) {
      const o = i * f.channels;
      const r = f.data[o]!, g = f.data[o + 1]!, b = f.data[o + 2]!;
      const k = bucket(r, g, b);
      counts[k]!++;
      sums[k * 3] = sums[k * 3]! + r;
      sums[k * 3 + 1] = sums[k * 3 + 1]! + g;
      sums[k * 3 + 2] = sums[k * 3 + 2]! + b;
    }
  }
  const used: number[] = [];
  for (let k = 0; k < 32768; k++) if (counts[k]) used.push(k);
  const chan = (k: number, c: number) => (k >> (10 - 5 * c)) & 31;
  type Box = { keys: number[]; range: number; channel: number };
  const measure = (keys: number[]): Box => {
    let best = 0;
    let channel = 0;
    for (let c = 0; c < 3; c++) {
      let lo = 31, hi = 0;
      for (const k of keys) {
        const v = chan(k, c);
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      if (hi - lo > best) {
        best = hi - lo;
        channel = c;
      }
    }
    return { keys, range: best, channel };
  };
  const boxes: Box[] = [measure(used)];
  while (boxes.length < COLOURS) {
    let pick = -1;
    for (let i = 0; i < boxes.length; i++) if (boxes[i]!.range > 0 && (pick < 0 || boxes[i]!.range > boxes[pick]!.range)) pick = i;
    if (pick < 0) break;
    const box = boxes[pick]!;
    box.keys.sort((a, b) => chan(a, box.channel) - chan(b, box.channel));
    const half = box.keys.reduce((n, k) => n + counts[k]!, 0) / 2;
    let acc = 0;
    let cut = 1;
    for (; cut < box.keys.length - 1; cut++) {
      acc += counts[box.keys[cut - 1]!]!;
      if (acc >= half) break;
    }
    boxes.splice(pick, 1, measure(box.keys.slice(0, cut)), measure(box.keys.slice(cut)));
  }
  const palette = new Uint8Array(256 * 3);
  boxes.forEach((box, i) => {
    let n = 0, r = 0, g = 0, b = 0;
    for (const k of box.keys) {
      n += counts[k]!;
      r += sums[k * 3]!;
      g += sums[k * 3 + 1]!;
      b += sums[k * 3 + 2]!;
    }
    palette[i * 3] = Math.round(r / n);
    palette[i * 3 + 1] = Math.round(g / n);
    palette[i * 3 + 2] = Math.round(b / n);
  });
  return palette.subarray(0, Math.max(1, boxes.length) * 3);
}

/** Nearest palette entry per 15-bit bucket, filled on first use. */
function mapper(palette: Uint8Array): (r: number, g: number, b: number) => number {
  const cache = new Int16Array(32768).fill(-1);
  const n = palette.length / 3;
  return (r, g, b) => {
    const k = bucket(r, g, b);
    let hit = cache[k]!;
    if (hit >= 0) return hit;
    const cr = ((k >> 10) << 3) | 4, cg = (((k >> 5) & 31) << 3) | 4, cb = ((k & 31) << 3) | 4;
    let best = Infinity;
    for (let i = 0; i < n; i++) {
      const dr = palette[i * 3]! - cr, dg = palette[i * 3 + 1]! - cg, db = palette[i * 3 + 2]! - cb;
      const d = dr * dr * 2 + dg * dg * 4 + db * db * 3;
      if (d < best) {
        best = d;
        hit = i;
      }
    }
    cache[k] = hit;
    return hit;
  };
}

/** GIF LZW with 8-bit minimum code size, split into data sub-blocks. */
export function lzw(indices: Uint8Array): Buffer {
  const min = 8;
  const clear = 1 << min;
  const eoi = clear + 1;
  const out: number[] = [];
  let acc = 0;
  let bits = 0;
  let size = min + 1;
  const emit = (code: number) => {
    acc |= code << bits;
    bits += size;
    while (bits >= 8) {
      out.push(acc & 0xff);
      acc >>>= 8;
      bits -= 8;
    }
  };
  let table = new Map<number, number>();
  let next = eoi + 1;
  emit(clear);
  let prefix = indices[0] ?? 0;
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i]!;
    const key = prefix * 256 + k;
    const code = table.get(key);
    if (code !== undefined) {
      prefix = code;
      continue;
    }
    emit(prefix);
    if (next === 4096) {
      emit(clear);
      table = new Map();
      next = eoi + 1;
      size = min + 1;
    } else {
      if (next >= 1 << size) size++;
      table.set(key, next++);
    }
    prefix = k;
  }
  emit(prefix);
  emit(eoi);
  if (bits > 0) out.push(acc & 0xff);
  const blocks: number[] = [min];
  for (let i = 0; i < out.length; i += 255) {
    const chunk = out.slice(i, i + 255);
    blocks.push(chunk.length, ...chunk);
  }
  blocks.push(0);
  return Buffer.from(blocks);
}

/** Encode same-sized frames as a looping GIF, `delayCs` hundredths of a second each. */
export function encodeGif(frames: RawImage[], delayCs: number): Buffer {
  if (!frames.length) throw new Error('No frames to encode');
  const { width, height } = frames[0]!;
  const palette = buildPalette(frames);
  const nearest = mapper(palette);
  const table = Buffer.alloc(256 * 3);
  table.set(palette);
  const u16 = (n: number) => [n & 0xff, (n >> 8) & 0xff];
  const parts: Buffer[] = [
    Buffer.from('GIF89a', 'latin1'),
    Buffer.from([...u16(width), ...u16(height), 0xf7, 0, 0]), // global table, 256 entries
    table,
    Buffer.from([0x21, 0xff, 11, ...Buffer.from('NETSCAPE2.0', 'latin1'), 3, 1, 0, 0, 0]), // loop forever
  ];
  let shown: Uint8Array | undefined;
  for (const f of frames) {
    if (f.width !== width || f.height !== height) throw new Error('GIF frames must all be the same size');
    const idx = new Uint8Array(width * height);
    const now = new Uint8Array(width * height);
    for (let i = 0; i < width * height; i++) {
      const o = i * f.channels;
      now[i] = nearest(f.data[o]!, f.data[o + 1]!, f.data[o + 2]!);
      idx[i] = shown && shown[i] === now[i] ? TRANSPARENT : now[i]!;
    }
    // Graphic control: keep the previous frame under this one, transparent index after the first frame.
    parts.push(Buffer.from([0x21, 0xf9, 4, shown ? 0x05 : 0x04, ...u16(delayCs), TRANSPARENT, 0]));
    parts.push(Buffer.from([0x2c, 0, 0, 0, 0, ...u16(width), ...u16(height), 0]));
    parts.push(lzw(idx));
    shown = now;
  }
  parts.push(Buffer.from([0x3b]));
  return Buffer.concat(parts);
}
