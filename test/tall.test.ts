import { createServer, type Server } from 'node:http';
import { readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser } from 'playwright';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { capture, launchBrowser, type DeviceShot } from '../src/capture.js';
import { createServer as createMcpServer } from '../src/mcp.js';
import { defaultShotOptions } from '../src/options.js';
import { decodePng, pngSize } from '../src/png.js';

// Layout of test/fixtures/tall.html, in CSS px.
const HEADER = 56;
const BAND = 700;
const BANDS = 30;
const REVEAL = 400;
const FOOTER = 200;
const TOTAL = HEADER + BANDS * BAND + REVEAL + FOOTER; // 21,656

const HEADER_RGB = [17, 17, 17];
const BLUE = [0, 90, 255];
const YELLOW = [255, 200, 0];
const GREEN = [0, 170, 60];
const FOOTER_RGB = [60, 60, 60];
const BADGE = [0, 200, 200];

function expectedAt(yCss: number): number[] {
  if (yCss < HEADER) return HEADER_RGB;
  const b = yCss - HEADER;
  if (b < BANDS * BAND) return Math.floor(b / BAND) % 2 === 0 ? BLUE : YELLOW;
  if (b < BANDS * BAND + REVEAL) return GREEN; // red if the lazy section never ran
  return FOOTER_RGB;
}

const near = (a: number[], b: number[], tol = 3) => a.every((v, i) => Math.abs(v - b[i]!) <= tol);

const FIXTURES = resolve(import.meta.dirname, 'fixtures');
const OUT = resolve(import.meta.dirname, '..', '.rpc-shots', 'e2e-tall');

let server: Server;
let url: string;
let browser: Browser;
let phone: DeviceShot;

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const file = join(FIXTURES, req.url === '/' ? 'tall.html' : req.url!.slice(1));
    if (!file.startsWith(FIXTURES) || !existsSync(file)) return void res.writeHead(404).end();
    res.writeHead(200, { 'content-type': 'text/html' }).end(await readFile(file));
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  browser = await launchBrowser();
  await rm(OUT, { recursive: true, force: true });

  const result = await capture(
    { ...defaultShotOptions(url), devices: ['iphone-15'], bezels: true, fullPage: true, saveSlices: true, outDir: OUT },
    { browser, keepBuffers: true }
  );
  phone = result.shots[0]!;
}, 180_000);

afterAll(async () => {
  await browser?.close();
  await new Promise(r => server?.close(r));
});

describe('tall page at DPR 3 (stitched)', () => {
  it('captures the full height in segments, unclipped', () => {
    expect(phone.error).toBeUndefined();
    expect(phone.scrollHeight).toBe(TOTAL);
    expect(phone.capturedHeight).toBe(TOTAL);
    expect(phone.clipped).toBe(false);
    expect(phone.segments).toBe(8); // 2730 CSS px (8190 device px) each
    expect(pngSize(phone.buffers!.shot!)).toEqual({ width: 393 * 3, height: TOTAL * 3 }); // 64,968 px
    expect(phone.shot!.height).toBe(TOTAL * 3);
  });

  it('every row matches the layout: seams aligned, header once, lazy section revealed', () => {
    const img = decodePng(phone.buffers!.shot!);
    const at = (x: number, y: number) => [...img.data.subarray((y * img.width + x) * img.channels, (y * img.width + x) * img.channels + 3)];
    const x = 5; // left gutter: clear of band text and the badge
    const bad: string[] = [];
    let headerRows = 0;
    for (let y = 0; y < img.height; y++) {
      const got = at(x, y);
      if (near(got, HEADER_RGB)) headerRows++;
      if (!near(got, expectedAt(y / 3)) && bad.length < 5) bad.push(`row ${y}: ${got} != ${expectedAt(y / 3)}`);
    }
    expect(bad).toEqual([]);
    expect(headerRows).toBe(HEADER * 3); // the sticky header appears exactly once

    // The fixed badge (40x40, 8px from the bottom-right of the viewport) appears once.
    const bx = (393 - 8 - 20) * 3;
    let badgeRows = 0;
    for (let y = 0; y < img.height; y++) if (near(at(bx, y), BADGE)) badgeRows++;
    expect(badgeRows).toBe(40 * 3);
  });

  it('writes viewport-tall slices with labels', () => {
    const sl = phone.slices!;
    expect(sl.saved).toBe(true);
    expect(sl.total).toBe(26); // 25 x 852 + 356
    expect(sl.items).toHaveLength(26);
    expect(sl.items[1]!.label).toBe('iphone-15 · slice 2/26 · y=852–1704 css px');
    expect(sl.items[25]!.label).toBe(`iphone-15 · slice 26/26 · y=21300–${TOTAL} css px`);
    for (const s of sl.items) {
      expect(s.width).toBe(768);
      expect(existsSync(s.path!)).toBe(true);
    }
    expect(sl.items[0]!.pxHeight).toBe(Math.round(852 * (768 / 393)));
    expect(sl.items[0]!.path).toMatch(/-iphone-15-slice-01\.jpg$/);
    expect(phone.framed).toBeDefined(); // the hero
  });

  it('caps the height with maxHeight and flags clipped', async () => {
    const r = await capture(
      { ...defaultShotOptions(url), devices: ['desktop-1440'], fullPage: true, maxHeight: 5000, outDir: OUT },
      { browser }
    );
    const s = r.shots[0]!;
    expect(s.clipped).toBe(true);
    expect(s.capturedHeight).toBe(5000);
    expect(s.shot!.height).toBe(5000);
  });
});

describe('reducedMotion', () => {
  it('emulates prefers-reduced-motion: reduce', async () => {
    const colour = async (reducedMotion: boolean) => {
      const r = await capture(
        { ...defaultShotOptions(`${url}motion.html`), devices: ['desktop-1440'], reducedMotion, outDir: join(OUT, 'motion') },
        { browser, keepBuffers: true }
      );
      const img = decodePng(r.shots[0]!.buffers!.shot!);
      return [...img.data.subarray(0, 3)];
    };
    expect(await colour(false)).toEqual([220, 0, 0]);
    expect(await colour(true)).toEqual(GREEN);
  });
});

describe('MCP screenshot with fullPage', () => {
  it('returns the hero then labelled slices, and says what was skipped', async () => {
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await createMcpServer().connect(serverT);
    const client = new Client({ name: 'test', version: '0' });
    await client.connect(clientT);
    try {
      const res = await client.callTool({
        name: 'screenshot',
        arguments: { url, devices: ['iphone-15'], bezels: true, fullPage: true, maxSlices: 3, outDir: join(OUT, 'mcp') },
      });
      const content = res.content as Array<{ type: string; text?: string; mimeType?: string; data?: string }>;
      expect(res.isError).toBeFalsy();
      const head = content[0]!.text!;
      expect(head).toMatch(/ok iphone-15: full page 21656 css px tall \(1179x64968px, 8 segments stitched\)/);
      expect(head).toMatch(/inline: slices 1-3 of 26; slices 4-26 \(y=2556-21656 css px\) skipped inline/);
      expect(head).toMatch(/slice files: .*-iphone-15-slice-NN\.jpg \(01-26\)/);

      const rest = content.slice(1);
      expect(rest.map(c => c.type)).toEqual(['text', 'image', 'text', 'image', 'text', 'image', 'text', 'image']);
      expect(rest[0]!.text).toBe('iphone-15 · first screen in bezel');
      expect(rest.filter(c => c.type === 'text').slice(1).map(c => c.text)).toEqual([
        'iphone-15 · slice 1/26 · y=0–852 css px',
        'iphone-15 · slice 2/26 · y=852–1704 css px',
        'iphone-15 · slice 3/26 · y=1704–2556 css px',
      ]);
      for (const c of rest.filter(c => c.type === 'image')) {
        expect(c.mimeType).toBe('image/jpeg');
        expect(c.data!.length).toBeLessThan(400_000);
      }
      // All slices were saved because some were skipped inline.
      expect(existsSync(join(OUT, 'mcp', `127-0-0-1-${new URL(url).port}-iphone-15-slice-26.jpg`))).toBe(true);
    } finally {
      await client.close();
    }
  }, 120_000);

  it('reports a structured error and hint for an unreachable host', async () => {
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await createMcpServer().connect(serverT);
    const client = new Client({ name: 'test', version: '0' });
    await client.connect(clientT);
    try {
      const res = await client.callTool({
        name: 'screenshot',
        arguments: { url: 'https://rpc-agent-no-such-host.invalid', devices: ['iphone-15', 'desktop-1440'], outDir: join(OUT, 'mcp') },
      });
      expect(res.isError).toBe(true);
      const text = (res.content as Array<{ text: string }>)[0]!.text;
      expect(text).toMatch(/^All 2 device\(s\) failed\./);
      expect(text).toMatch(/FAILED iphone-15: Could not resolve host rpc-agent-no-such-host\.invalid \(net::ERR_NAME_NOT_RESOLVED\)/);
      expect(text).toMatch(/hint: .*allowlist/);
      const json = JSON.parse(text.slice(text.indexOf('{')));
      expect(json.shots[1]).toMatchObject({ device: 'desktop-1440', code: 'ERR_NAME_NOT_RESOLVED' });
      expect(json.shots[1].hint).toMatch(/Claude Code sandbox/);
    } finally {
      await client.close();
    }
  }, 60_000);
});
