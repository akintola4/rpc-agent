import { createServer, type Server } from 'node:http';
import { readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser } from 'playwright';
import { bezelLayoutFor } from '../src/bezel.js';
import { capture, fileStem, launchBrowser, type ShotResult } from '../src/capture.js';
import { renderPreview } from '../src/composite.js';
import { resolveDevice } from '../src/devices.js';
import { defaultShotOptions } from '../src/options.js';

const FIXTURES = resolve(import.meta.dirname, 'fixtures');
const OUT = resolve(import.meta.dirname, '..', '.rpc-shots', 'e2e');

let server: Server;
let baseUrl: string;
let browser: Browser;
let result: ShotResult;

/** Sample one pixel of a PNG by drawing it into a canvas in the browser. */
async function pixel(path: string, x: number, y: number): Promise<[number, number, number, number]> {
  const page = await browser.newPage();
  try {
    const b64 = (await readFile(path)).toString('base64');
    return await page.evaluate(
      `(async () => {
        const img = new Image();
        img.src = 'data:image/png;base64,${b64}';
        await img.decode();
        const c = document.createElement('canvas');
        c.width = img.naturalWidth; c.height = img.naturalHeight;
        const ctx = c.getContext('2d');
        ctx.drawImage(img, 0, 0);
        return Array.from(ctx.getImageData(${x}, ${y}, 1, 1).data);
      })()`
    );
  } finally {
    await page.close();
  }
}

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const file = join(FIXTURES, req.url === '/' ? 'page.html' : req.url!.slice(1));
    if (!file.startsWith(FIXTURES) || !existsSync(file)) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' }).end(await readFile(file));
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  browser = await launchBrowser();
  await rm(OUT, { recursive: true, force: true });

  result = await capture(
    { ...defaultShotOptions(baseUrl), devices: ['iphone-15', 'desktop-1440'], bezels: true, fullPage: true, outDir: OUT },
    { browser, keepBuffers: true }
  );
});

afterAll(async () => {
  await browser?.close();
  await new Promise(r => server?.close(r));
});

describe('capture against a local fixture', () => {
  it('captures every device without errors', () => {
    expect(result.shots.map(s => s.device)).toEqual(['iphone-15', 'desktop-1440']);
    for (const s of result.shots) {
      expect(s.error).toBeUndefined();
      expect(s.status).toBe(200);
      expect(s.title).toBe('rpc fixture');
      expect(s.consoleErrors).toEqual([]);
    }
  });

  it('writes deterministic filenames', () => {
    const [phone] = result.shots;
    expect(phone!.shot!.path).toBe(join(OUT, `${fileStem(baseUrl, 'iphone-15')}.png`));
    expect(phone!.shot!.path).toMatch(/127-0-0-1-\d+-iphone-15\.png$/);
    expect(phone!.framed!.path).toMatch(/-iphone-15-framed\.png$/);
    expect(existsSync(phone!.shot!.path) && existsSync(phone!.framed!.path)).toBe(true);
  });

  it('full-page shot is viewport width x DPR and taller than the viewport', () => {
    for (const s of result.shots) {
      expect(s.shot!.width).toBe(s.viewport.width * s.dpr);
      expect(s.shot!.height).toBe(Math.round(s.scrollHeight! * s.dpr));
      expect(s.shot!.height).toBeGreaterThan(s.viewport.height * s.dpr * 2);
      expect(s.clipped).toBe(false);
    }
  });

  it('warm-up scroll triggers IntersectionObserver content before capture', async () => {
    const s = result.shots[1]!; // desktop, 1x
    const [r, g] = await pixel(s.shot!.path, 10, s.shot!.height - 10);
    expect(g).toBeGreaterThan(150); // #reveal turned green
    expect(r).toBeLessThan(50);
  });

  it('emulates the mobile user agent and viewport', async () => {
    // The fixture prints innerWidth in its sticky header; check the raw
    // phone shot is 393 CSS px wide and the hero (100vh) is magenta.
    const s = result.shots[0]!;
    const [r, g, b] = await pixel(s.shot!.path, s.shot!.width / 2, 300 * s.dpr);
    expect([r, g, b]).toEqual([255, 0, 170]);
  });

  it('framed shot is the bezel outer box x DPR, with content at the screen rect', async () => {
    for (const s of result.shots) {
      const layout = bezelLayoutFor(resolveDevice(s.device));
      expect(s.framed!.width).toBe(Math.round(layout.outerWidth * s.dpr));
      expect(s.framed!.height).toBe(Math.round(layout.outerHeight * s.dpr));

      // Inside the screen rect (15% across, 30% down: clear of the hero text)
      // we see the hero colour...
      const cx = Math.round((layout.screen.x + layout.screen.width * 0.15) * s.dpr);
      const cy = Math.round((layout.screen.y + layout.screen.height * 0.3) * s.dpr);
      const [r, g, b, a] = await pixel(s.framed!.path, cx, cy);
      expect([r, g, b, a], `${s.device} @ ${cx},${cy}`).toEqual([255, 0, 170, 255]);

      // ...and the outer corner is transparent background, not page content.
      const [, , , cornerAlpha] = await pixel(s.framed!.path, 0, 0);
      expect(cornerAlpha).toBe(0);
    }
  });

  it('phone screen is inset from the bezel edge', async () => {
    const s = result.shots[0]!;
    const layout = bezelLayoutFor(resolveDevice(s.device));
    // Just left of the screen rect, at mid height: bezel, not magenta.
    const x = Math.round((layout.screen.x - 4) * s.dpr);
    const y = Math.round((layout.screen.y + layout.screen.height / 2) * s.dpr);
    const [r, g, b, a] = await pixel(s.framed!.path, x, y);
    expect(a).toBe(255);
    expect([r, g, b]).not.toEqual([255, 0, 170]);
  });

  it('renders small inline previews', async () => {
    const s = result.shots[0]!;
    const p = await renderPreview(browser, s.buffers!.shot!, s.shot!);
    expect(p.cropped).toBe(true);
    expect(Math.max(p.width, p.height)).toBeLessThanOrEqual(1024);
    expect(p.data.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8])); // JPEG
    expect(p.data.length).toBeLessThan(300_000);
  });
});
