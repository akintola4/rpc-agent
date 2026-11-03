import { createServer, type Server } from 'node:http';
import { existsSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser } from 'playwright';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ArgError, parseCli } from '../src/args.js';
import { findFfmpeg } from '../src/browser.js';
import { capture, launchBrowser, type DeviceShot } from '../src/capture.js';
import { runCheck, type CheckReport } from '../src/check.js';
import { encodeGif, lzw } from '../src/gif.js';
import { createServer as createMcpServer } from '../src/mcp.js';
import { defaultCheckOptions, defaultRecordOptions, defaultShotOptions, type RecordOptions, type ShotOptions } from '../src/options.js';
import { decodePng, imageSize, type RawImage } from '../src/png.js';
import { record, recordStem } from '../src/record.js';
import { failFast } from './serve.js';

const FIXTURES = resolve(import.meta.dirname, 'fixtures', 'motion');
const OUT = resolve(import.meta.dirname, '..', '.rpc-shots', 'e2e-motion');
const DESKTOP = 'desktop-1440';
const PHONE = 'iphone-15';

// test/fixtures/motion/pinned.html, in CSS px.
const INTRO = 800;
const SECTION = 700;
const PIN_DISTANCE = 2100;
const OUTRO = 800;
const BLUE = [0, 90, 255];
const ORANGE = [255, 140, 0];
const GREEN = [0, 170, 60];
const WHITE = [255, 255, 255];
// reveal.html: block tops and colour.
const REVEAL_TOPS = [40, 200, 360, 2000, 2160, 2320];
const REVEAL_RGB = [20, 40, 160];

let server: Server;
let ORIGIN: string;
let browser: Browser;

beforeAll(async () => {
  server = createServer(failFast(async (req, res) => {
    const path = new URL(req.url!, 'http://x').pathname;
    const file = join(FIXTURES, path.slice(1));
    if (!file.startsWith(FIXTURES) || !existsSync(file)) return void res.writeHead(404).end();
    const type = file.endsWith('.js') ? 'text/javascript' : 'text/html';
    res.writeHead(200, { 'content-type': type }).end(await readFile(file));
  }));
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  ORIGIN = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  browser = await launchBrowser();
  await rm(OUT, { recursive: true, force: true });
});

afterAll(async () => {
  await browser?.close();
  await new Promise(r => server?.close(r));
});

async function shot(page: string, extra: Partial<ShotOptions> = {}): Promise<DeviceShot> {
  const r = await capture(
    { ...defaultShotOptions(`${ORIGIN}/${page}`), devices: [DESKTOP], outDir: join(OUT, 'shots'), ...extra },
    { browser, keepBuffers: true }
  );
  const s = r.shots[0]!;
  expect(s.error, s.error).toBeUndefined();
  return s;
}

const checks = new Map<string, Promise<CheckReport>>();
function check(page: string): Promise<CheckReport> {
  if (!checks.has(page)) checks.set(page, runCheck({ ...defaultCheckOptions(`${ORIGIN}/${page}`), devices: [DESKTOP] }, { browser }));
  return checks.get(page)!;
}

const motion = (r: CheckReport) => r.findings.filter(f => f.check === 'motion');
const warningIds = (s: DeviceShot) => (s.warnings ?? []).map(w => w.id);

function pixels(png: Buffer) {
  const img = decodePng(png);
  return {
    img,
    at: (x: number, y: number) => [...img.data.subarray((y * img.width + x) * img.channels, (y * img.width + x) * img.channels + 3)],
  };
}
const near = (a: number[], b: number[], tol = 3) => a.every((v, i) => Math.abs(v - b[i]!) <= tol);

describe('rpc check: Motion group', () => {
  it('reports a finite keyframe animation still running and an infinite loop', async () => {
    const r = await check('keyframes.html');
    const [running, loop] = motion(r);
    expect(running).toMatchObject({ id: 'motion-running', severity: 'warn', selector: 'h1.hero-title', message: '1 element still animating after load' });
    expect(running!.items![0]!.text).toBe('CSS animation rise');
    expect(loop).toMatchObject({ id: 'motion-loop', severity: 'info', selector: 'div.spinner' });
  });

  it('reports a pinned section with its spacer', async () => {
    const [pin] = motion(await check('pinned.html'));
    expect(pin).toMatchObject({ id: 'motion-pinned', severity: 'info', selector: '#pinned' });
    expect(pin!.items![0]).toMatchObject({ selector: '#pinned', text: '2800px spacer for a 700px section', value: PIN_DISTANCE });
  });

  it('reports reveal blocks stuck hidden in the viewport', async () => {
    const [hidden] = motion(await check('reveal.html?stuck'));
    expect(hidden).toMatchObject({ id: 'motion-reveal-hidden', severity: 'warn', message: '3 elements in or near the viewport still hidden by a reveal animation' });
    expect(hidden!.items!.map(i => i.text)).toEqual(Array(3).fill('opacity 0 (reveal class)'));
  });

  it('reports a scroll-snap carousel and points at rpc record', async () => {
    const [carousel] = motion(await check('carousel.html'));
    expect(carousel).toMatchObject({ id: 'motion-carousel', severity: 'info', selector: '#carousel' });
    expect(carousel!.items![0]!.text).toMatch(/^scroll-snap/);
    expect(carousel!.fix).toContain("rpc record <url> --selector '#carousel'");
  });

  it('has no Motion findings on a static page, and never errors', async () => {
    expect(motion(await check('static.html'))).toEqual([]);
    for (const page of ['keyframes.html', 'pinned.html', 'reveal.html?stuck', 'carousel.html']) {
      expect(motion(await check(page)).every(f => f.severity !== 'error')).toBe(true);
    }
  });
});

describe('rpc shot: motion warnings', () => {
  it('warns about animations still running, carousels and kept pins', async () => {
    const kf = await shot('keyframes.html');
    expect(kf.warnings![0]).toMatchObject({ id: 'motion-running', message: '1 element was still animating when captured', items: [{ selector: 'h1.hero-title' }] });
    expect((await shot('carousel.html')).warnings).toEqual([expect.objectContaining({ id: 'motion-carousel', message: 'carousel: use `rpc record` for motion' })]);
    const kept = await shot('pinned.html', { fullPage: true, unpin: false });
    expect(kept.warnings).toEqual([expect.objectContaining({ id: 'motion-pinned', message: 'pinned section: the stitched shot may show blank space' })]);
    expect(warningIds(await shot('reveal.html?stuck'))).toEqual(['motion-reveal-hidden']);
  });

  it('a static page has no warnings and settles quickly', async () => {
    const s = await shot('static.html', { fullPage: true });
    expect(s.warnings).toBeUndefined();
    expect(s.motion!.settle).toMatchObject({ settled: true, count: 0 });
    expect(s.motion!.settle.ms).toBeLessThan(1000);
    expect(s.motion!.unpinned).toBeUndefined();
  });

  it('the JSON result carries warnings and motion metadata', async () => {
    const r = await capture({ ...defaultShotOptions(`${ORIGIN}/carousel.html`), devices: [DESKTOP], outDir: join(OUT, 'shots') }, { browser });
    const json = JSON.parse(JSON.stringify(r));
    expect(json.shots[0].warnings[0]).toMatchObject({ id: 'motion-carousel', severity: 'warn', items: [{ selector: '#carousel' }] });
    expect(json.shots[0].motion.settle.settled).toBe(true);
  });
});

describe('pinned sections in a stitched shot', () => {
  const blankRows = (png: Buffer) => {
    const { img, at } = pixels(png);
    let blank = 0;
    for (let y = 0; y < img.height; y++) if (near(at(5, y), WHITE)) blank++;
    return blank;
  };

  it('collapses the spacer: no blank band, section once, deterministic', async () => {
    const runs = [await shot('pinned.html', { fullPage: true }), await shot('pinned.html', { fullPage: true })];
    for (const s of runs) {
      expect(s.scrollHeight).toBe(INTRO + SECTION + OUTRO);
      expect(s.shot!.height).toBe(INTRO + SECTION + OUTRO);
      expect(s.motion!.unpinned).toEqual([{ selector: '#pinned', spacer: 'div.pin-spacer', kind: 'pin-spacer', removed: PIN_DISTANCE }]);
      expect(s.warnings).toBeUndefined();
      const png = s.buffers!.shot!;
      expect(blankRows(png)).toBe(0);
      const { at } = pixels(png);
      expect(at(5, INTRO - 1)).toEqual(BLUE);
      expect(at(5, INTRO)).toEqual(ORANGE);
      expect(at(5, INTRO + SECTION - 1)).toEqual(ORANGE);
      expect(at(5, INTRO + SECTION)).toEqual(GREEN);
    }
    expect(runs[0]!.buffers!.shot!.equals(runs[1]!.buffers!.shot!)).toBe(true);
  });

  it('collapses at DPR 3 too', async () => {
    const s = await shot('pinned.html', { fullPage: true, devices: [PHONE] });
    expect(s.shot!.height).toBe((INTRO + SECTION + OUTRO) * 3);
    expect(blankRows(s.buffers!.shot!)).toBe(0);
  });

  it('--no-unpin keeps the spacer, which captures as a blank band', async () => {
    const s = await shot('pinned.html', { fullPage: true, unpin: false });
    expect(s.shot!.height).toBe(INTRO + SECTION + PIN_DISTANCE + OUTRO);
    expect(s.motion!.unpinned).toBeUndefined();
    expect(blankRows(s.buffers!.shot!)).toBe(PIN_DISTANCE);
  });
});

describe('reveals', () => {
  const revealed = (png: Buffer, tops: number[]) => {
    const { at } = pixels(png);
    return tops.map(t => near(at(60, t + 100), REVEAL_RGB));
  };

  it('are fully visible after settle, in the viewport and on the full page', async () => {
    expect(revealed((await shot('reveal.html')).buffers!.shot!, REVEAL_TOPS.slice(0, 3))).toEqual([true, true, true]);
    const full = await shot('reveal.html', { fullPage: true });
    expect(revealed(full.buffers!.shot!, REVEAL_TOPS)).toEqual(Array(6).fill(true));
    expect(full.warnings).toBeUndefined();
  });

  it('a tween longer than the settle cap is caught mid-way and warned about', async () => {
    const s = await shot('reveal.html?slow');
    expect(revealed(s.buffers!.shot!, REVEAL_TOPS.slice(0, 3))).not.toEqual([true, true, true]);
    expect(s.motion!.settle.settled).toBe(false);
    expect(s.warnings![0]).toMatchObject({ id: 'motion-running', message: '3 elements were still animating when captured' });
  });

  it('--finish-animations jumps GSAP-style tweens to the end, every run', async () => {
    for (let i = 0; i < 2; i++) {
      const s = await shot('reveal.html?slow', { finishAnimations: true });
      expect(revealed(s.buffers!.shot!, REVEAL_TOPS.slice(0, 3))).toEqual([true, true, true]);
      expect(s.motion!.finished).toEqual({ animations: 0, gsap: 3, scrollTriggers: 0 });
      expect(s.warnings).toBeUndefined();
    }
    const full = await shot('reveal.html?slow', { fullPage: true, finishAnimations: true });
    expect(revealed(full.buffers!.shot!, REVEAL_TOPS)).toEqual(Array(6).fill(true));
  });

  it('--finish-animations ends CSS keyframes and leaves loops alone', async () => {
    const s = await shot('keyframes.html', { finishAnimations: true });
    expect(s.motion!.finished).toEqual({ animations: 1, gsap: 0, scrollTriggers: 0 });
    expect(s.warnings).toBeUndefined();
    expect(pixels(s.buffers!.shot!).at(60, 100)).toEqual([200, 0, 0]);
  });
});

describe('rpc record', () => {
  const opts = (extra: Partial<RecordOptions> = {}): RecordOptions => ({
    ...defaultRecordOptions(`${ORIGIN}/carousel.html`),
    device: PHONE,
    selector: '#carousel',
    duration: 2,
    outDir: join(OUT, 'record'),
    ...extra,
  });

  it('has an ffmpeg to encode with', () => {
    expect(findFfmpeg()).toBeDefined();
  });

  it('records the element at its size times DPR, for the requested length, every run', async () => {
    for (let i = 0; i < 2; i++) {
      const r = await record(opts(), { browser });
      expect(r.error, r.error).toBeUndefined();
      expect(r.clip).toMatchObject({ width: 360, height: 200 });
      expect(r.video).toMatchObject({ width: 1080, height: 600, fps: 25 });
      expect(Math.abs(r.video!.duration - 2)).toBeLessThanOrEqual(0.05);
      expect(r.video!.captured).toBeGreaterThan(10);
      expect(r.video!.path).toMatch(/127-0-0-1-\d+-carousel-html-iphone-15-carousel\.webm$/);
      expect(existsSync(r.video!.path)).toBe(true);
      expect(r.poster).toMatchObject({ width: 1080, height: 600 });
      expect(r.clipped).toBeUndefined();
    }
  }, 60_000);

  it('--gif writes a GIF of the same clip', async () => {
    const r = await record(opts({ duration: 1, gif: true }), { browser });
    expect(r.gif).toMatchObject({ width: 640, height: 356 });
    expect(r.gif!.frames).toBeGreaterThanOrEqual(9);
    const gif = await readFile(r.gif!.path);
    expect(gif.subarray(0, 6).toString('latin1')).toBe('GIF89a');
    expect(imageSize(gif)).toEqual({ width: 640, height: 356 });
  });

  it('records the whole viewport without a selector', async () => {
    const r = await record(opts({ device: DESKTOP, selector: undefined, duration: 1 }), { browser });
    expect(r.video).toMatchObject({ width: 1440, height: 900 });
    expect(r.video!.path).toMatch(/-desktop-1440\.webm$/);
  });

  it('fails with a code and hint when the selector matches nothing', async () => {
    const r = await record(opts({ selector: '#nope', duration: 1, timeoutMs: 2000 }), { browser });
    expect(r).toMatchObject({ code: 'SELECTOR_NOT_FOUND', error: 'No visible element matches "#nope"' });
    expect(r.hint).toMatch(/querySelector/);
    expect(r.video).toBeUndefined();
  });

  it('names files after the selector', () => {
    expect(recordStem('http://localhost:3000/', 'desktop-1440', '.hero > .carousel')).toBe('localhost-3000-desktop-1440-hero-carousel');
    expect(recordStem('http://localhost:3000/', 'desktop-1440')).toBe('localhost-3000-desktop-1440');
  });

  it('the MCP record tool returns paths, a summary and the poster', async () => {
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await createMcpServer().connect(serverT);
    const client = new Client({ name: 'test', version: '0' });
    await client.connect(clientT);
    try {
      const { tools } = await client.listTools();
      expect(tools.map(t => t.name)).toContain('record');
      const res = await client.callTool({
        name: 'record',
        arguments: { url: `${ORIGIN}/carousel.html`, device: 'iphone-15', selector: '#carousel', duration: 1, outDir: join(OUT, 'mcp') },
      });
      expect(res.isError).toBeFalsy();
      const content = res.content as Array<{ type: string; text?: string; mimeType?: string; data?: string }>;
      expect(content.map(c => c.type)).toEqual(['text', 'text', 'image']);
      const head = content[0]!.text!;
      expect(head).toMatch(/^ok iphone-15 #carousel: 1s webm 1080x600 at 25 fps .*-iphone-15-carousel\.webm\n {2}poster: .*-poster\.png/);
      const json = JSON.parse(head.slice(head.indexOf('{')));
      expect(json.video).toMatchObject({ width: 1080, height: 600, duration: 1 });
      expect(content[2]!.mimeType).toBe('image/jpeg');
      const bad = await client.callTool({ name: 'record', arguments: { url: `${ORIGIN}/carousel.html`, device: 'nope' } });
      expect(bad.isError).toBe(true);
    } finally {
      await client.close();
    }
  }, 60_000);
});

describe('cli', () => {
  it('parses record flags', () => {
    expect(parseCli(['record', 'localhost:3000', '--selector', '#c', '--duration', '3', '-d', 'iphone', '--gif', '--mp4', '--json', '-o', 'v'])).toMatchObject({
      command: 'record',
      json: true,
      options: { url: 'http://localhost:3000/', selector: '#c', duration: 3, device: 'iphone-15-pro', gif: true, mp4: true, outDir: 'v' },
    });
    expect(parseCli(['record', 'x.test'])).toMatchObject({ options: { device: DESKTOP, duration: 5, gif: false, mp4: false } });
    expect(() => parseCli(['record', 'x.test', '--duration', '31'])).toThrow(/--duration/);
    expect(() => parseCli(['record', 'x.test', '-d', 'iphone,ipad'])).toThrow(/one device/);
    expect(() => parseCli(['record'])).toThrow(ArgError);
    expect(parseCli(['record', '--help'])).toEqual({ command: 'help', topic: 'record' });
  });

  it('parses the shot motion flags', () => {
    expect(parseCli(['shot', 'x.test', '--finish-animations', '--no-unpin'])).toMatchObject({ options: { finishAnimations: true, unpin: false } });
    expect(parseCli(['shot', 'x.test'])).toMatchObject({ options: { finishAnimations: false, unpin: true } });
  });
});

describe('gif encoder', () => {
  /** GIF LZW decoder, to check the encoder round-trips (including table resets). */
  function unlzw(data: Buffer): number[] {
    const min = data[0]!;
    const bytes: number[] = [];
    for (let i = 1; data[i]; i += data[i]! + 1) bytes.push(...data.subarray(i + 1, i + 1 + data[i]!));
    const clear = 1 << min;
    let size = min + 1;
    let table: number[][] = [];
    const reset = () => {
      table = Array.from({ length: clear + 2 }, (_, i) => [i]);
      size = min + 1;
    };
    reset();
    const out: number[] = [];
    let prev: number[] | undefined;
    let acc = 0;
    let bits = 0;
    let pos = 0;
    for (;;) {
      while (bits < size && pos < bytes.length) {
        acc |= bytes[pos++]! << bits;
        bits += 8;
      }
      const code = acc & ((1 << size) - 1);
      acc >>>= size;
      bits -= size;
      if (code === clear) {
        reset();
        prev = undefined;
        continue;
      }
      if (code === clear + 1) break;
      const entry = table[code] ?? [...prev!, prev![0]!];
      out.push(...entry);
      if (prev) table.push([...prev, entry[0]!]);
      if (table.length === 1 << size && size < 12) size++;
      prev = entry;
    }
    return out;
  }

  it('LZW round-trips short and long inputs', () => {
    for (const len of [1, 2, 300, 20_000]) {
      const input = Uint8Array.from({ length: len }, (_, i) => (i * 7 + (i >> 5)) % 251);
      expect(unlzw(lzw(input))).toEqual([...input]);
    }
  });

  it('writes a looping GIF with a shared palette', () => {
    const frame = (rgb: number[]): RawImage => ({ width: 4, height: 2, channels: 3, data: Buffer.from(Array(8).fill(rgb).flat()) });
    const gif = encodeGif([frame([255, 0, 0]), frame([0, 0, 255])], 10);
    expect(gif.subarray(0, 6).toString('latin1')).toBe('GIF89a');
    expect(imageSize(gif)).toEqual({ width: 4, height: 2 });
    expect(gif.includes(Buffer.from('NETSCAPE2.0'))).toBe(true);
    expect(gif[gif.length - 1]).toBe(0x3b);
  });
});
