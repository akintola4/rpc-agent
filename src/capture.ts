import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { basename, extname, resolve } from 'node:path';
import type { Browser, Page } from 'playwright';
import { launchBrowser } from './browser.js';
import { renderFramed, renderSlices, type Segment } from './composite.js';
import { explainError } from './errors.js';
import { emulationFor, resolveDevices, type Device } from './devices.js';
import type { ShotOptions } from './options.js';
import { pngSize, stitchPngs } from './png.js';
import { fitsOneCapture, planSegments, planSlices, sliceScale, type SliceSpec } from './slices.js';

export { MAX_CAPTURE_PX } from './slices.js';
export { launchBrowser } from './browser.js';

export interface ImageFile {
  path: string;
  width: number;
  height: number;
}

export interface DeviceShot {
  device: string;
  name: string;
  viewport: { width: number; height: number };
  dpr: number;
  /** Raw page screenshot (viewport, or full page when fullPage). */
  shot?: ImageFile;
  /** Viewport composited into the device bezel (when bezels). */
  framed?: ImageFile;
  /** Document scroll height in CSS px. */
  scrollHeight?: number;
  /** Full page: CSS px actually captured (scrollHeight, or maxHeight when clipped). */
  capturedHeight?: number;
  /** Full page: number of capture segments stitched together (1 = single capture). */
  segments?: number;
  /** Full page: the page is taller than maxHeight and the shot stops there. */
  clipped?: boolean;
  /** Full page: review slices that were rendered (inline and/or saved). */
  slices?: SliceSet;
  status?: number | null;
  finalUrl?: string;
  title?: string;
  /** Uncaught exceptions and console.error lines, deduped, max 20. */
  consoleErrors?: string[];
  /** One-line failure message (navigation, wait or capture). */
  error?: string;
  /** Machine-readable failure code: `ERR_NAME_NOT_RESOLVED`, `TIMEOUT`, ... */
  code?: string;
  /** What to do about the failure. */
  hint?: string;
  /** In-memory buffers for callers that want them (MCP previews). */
  buffers?: { shot?: Buffer; framed?: Buffer; slices?: Buffer[] };
}

export interface SliceInfo extends SliceSpec {
  /** JPEG on disk, when slices were saved. */
  path?: string;
  /** Output size in px. */
  width: number;
  pxHeight: number;
}

export interface SliceSet {
  /** Slices the whole captured page divides into. */
  total: number;
  /** CSS px per slice (the viewport height). */
  sliceHeight: number;
  /** The slices rendered, top first: the first maxSlices, or all when saved. */
  items: SliceInfo[];
  /** True when slice files were written to disk. */
  saved: boolean;
}

export interface ShotResult {
  url: string;
  outDir: string;
  shots: DeviceShot[];
}

export interface CaptureHooks {
  /** Reuse a browser; otherwise one is launched and closed. */
  browser?: Browser;
  onDevice?: (shot: DeviceShot) => void;
  /** Keep image buffers on the result (default false). */
  keepBuffers?: boolean;
  /**
   * Render the first `opts.maxSlices` full-page slices for inline use (MCP).
   * When the page has more, all slices are saved to disk unless
   * `opts.saveSlices === false`.
   */
  inlineSlices?: boolean;
}

export async function capture(opts: ShotOptions, hooks: CaptureHooks = {}): Promise<ShotResult> {
  const devices = resolveDevices(opts.devices);
  const outDir = resolve(opts.outDir);
  await mkdir(outDir, { recursive: true });

  const browser = hooks.browser ?? (await launchBrowser());
  try {
    const shots: DeviceShot[] = [];
    for (const device of devices) {
      let shot: DeviceShot;
      try {
        shot = await captureDevice(browser, device, opts, outDir, hooks);
      } catch (err) {
        shot = baseShot(device);
        const e = explainError(err, { url: opts.url, timeoutMs: opts.timeoutMs, waitFor: opts.waitFor });
        shot.error = e.error;
        shot.code = e.code;
        if (e.hint) shot.hint = e.hint;
      }
      if (!hooks.keepBuffers) delete shot.buffers;
      hooks.onDevice?.(shot);
      shots.push(shot);
    }
    return { url: opts.url, outDir, shots };
  } finally {
    if (!hooks.browser) await browser.close();
  }
}

function baseShot(device: Device): DeviceShot {
  return {
    device: device.id,
    name: device.name,
    viewport: { width: device.width, height: device.height },
    dpr: device.dpr,
  };
}

async function captureDevice(
  browser: Browser,
  device: Device,
  opts: ShotOptions,
  outDir: string,
  hooks: CaptureHooks
): Promise<DeviceShot> {
  const emu = opts.emulate ? emulationFor(device) : undefined;
  const context = await browser.newContext({
    viewport: { width: device.width, height: device.height },
    deviceScaleFactor: device.dpr,
    isMobile: emu?.isMobile ?? false,
    hasTouch: emu?.hasTouch ?? false,
    ...(emu?.userAgent ? { userAgent: emu.userAgent } : {}),
    ...(opts.colorScheme ? { colorScheme: opts.colorScheme } : {}),
    ...(opts.reducedMotion ? { reducedMotion: 'reduce' as const } : {}),
    ignoreHTTPSErrors: true, // self-signed local dev certs
  });
  const result = baseShot(device);
  const errors = new Set<string>();

  try {
    const page = await context.newPage();
    page.on('pageerror', e => errors.add(`pageerror: ${e.message}`));
    page.on('console', m => {
      if (m.type() === 'error') errors.add(`console: ${m.text()}`);
    });

    const response = await page.goto(opts.url, { waitUntil: 'load', timeout: opts.timeoutMs });
    result.status = response?.status() ?? null;
    await settle(page, opts.timeoutMs);
    if (opts.waitFor) {
      await page.waitForSelector(opts.waitFor, { state: 'visible', timeout: opts.timeoutMs });
    }
    if (opts.fullPage) {
      await warmUpScroll(page, opts.maxHeight);
      await settle(page, opts.timeoutMs);
    }
    if (opts.waitMs > 0) await page.waitForTimeout(opts.waitMs);

    result.finalUrl = page.url();
    result.title = await page.title();
    result.scrollHeight = await page.evaluate<number>(SCROLL_HEIGHT_JS);

    const base = fileStem(opts.url, device.id);
    const shotOpts = { animations: 'disabled', caret: 'hide', type: 'png' } as const;

    // Viewport shot: the raw output when !fullPage, and the bezel input either way.
    let viewportPng: Buffer | undefined;
    if (!opts.fullPage || opts.bezels) {
      viewportPng = await page.screenshot(shotOpts);
    }

    let shotPng: Buffer;
    let segments: Segment[] | undefined;
    if (opts.fullPage) {
      const total = Math.min(result.scrollHeight, opts.maxHeight);
      result.clipped = result.scrollHeight > opts.maxHeight;
      result.capturedHeight = total;
      if (fitsOneCapture(total, device.dpr) && !result.clipped) {
        // One pass, as in v0.1: no seams, Playwright sizes it.
        shotPng = await page.screenshot({ ...shotOpts, fullPage: true });
        segments = [{ y: 0, height: total, png: shotPng }];
      } else {
        // Clipped full-page captures render exactly what one tall capture
        // would (sticky/fixed elements at their scroll-0 position, nothing
        // scrolls), so the segments stitch without repeated headers.
        const width = Math.max(device.width, await page.evaluate<number>(SCROLL_WIDTH_JS));
        segments = [];
        for (const band of planSegments(total, device.dpr)) {
          const png = await page.screenshot({
            ...shotOpts,
            fullPage: true,
            clip: { x: 0, y: band.y, width, height: band.height },
          });
          segments.push({ ...band, png });
        }
        shotPng = await stitchPngs(segments.map(s => s.png));
      }
      result.segments = segments.length;
    } else {
      shotPng = viewportPng!;
    }

    result.shot = await save(resolve(outDir, `${base}.png`), shotPng);
    result.buffers = { shot: shotPng };

    if (segments && (opts.saveSlices || hooks.inlineSlices)) {
      const cssWidth = result.shot.width / device.dpr;
      const scale = sliceScale(cssWidth, device.dpr, opts.sliceWidth);
      const all = planSlices(device.id, result.capturedHeight!, device.height);
      const save =
        opts.saveSlices === true ||
        (opts.saveSlices === undefined && Boolean(hooks.inlineSlices) && all.length > opts.maxSlices);
      const wanted = save ? all : all.slice(0, opts.maxSlices);
      const rendered = await renderSlices(browser, segments, wanted, cssWidth, scale);
      if (save) await removeOldSlices(outDir, base);
      const items: SliceInfo[] = [];
      for (const { data, ...info } of rendered) {
        const item: SliceInfo = { ...info };
        if (save) {
          item.path = resolve(outDir, `${base}-slice-${String(info.index).padStart(2, '0')}.jpg`);
          await writeFile(item.path, data);
        }
        items.push(item);
      }
      result.slices = { total: all.length, sliceHeight: device.height, items, saved: save };
      result.buffers.slices = rendered.map(r => r.data);
    }

    if (opts.bezels && viewportPng) {
      const framedPng = await renderFramed(browser, device, viewportPng);
      result.framed = await save(resolve(outDir, `${base}-framed.png`), framedPng);
      result.buffers.framed = framedPng;
    }
  } finally {
    result.consoleErrors = [...errors].slice(0, 20);
    await context.close();
  }
  return result;
}

/** Drop `<stem>-slice-NN.jpg` files from earlier runs so a shorter page doesn't leave stale slices. */
async function removeOldSlices(outDir: string, base: string): Promise<void> {
  const prefix = `${base}-slice-`; // base is a [a-z0-9-] slug
  for (const f of await readdir(outDir)) {
    if (f.startsWith(prefix) && /^\d+\.jpg$/.test(f.slice(prefix.length))) await rm(resolve(outDir, f), { force: true });
  }
}

async function save(path: string, png: Buffer): Promise<ImageFile> {
  await writeFile(path, png);
  return { path, ...pngSize(png) };
}

// In-page scripts are plain strings: when this file runs through tsx/vitest,
// esbuild wraps named arrow functions in a `__name()` helper that doesn't
// exist inside the page, so a serialized function would throw there.

const WAIT_FOR_ASSETS_JS = `(async () => {
  const imgs = Array.from(document.images).filter(i => !i.complete);
  await Promise.race([
    Promise.all([
      document.fonts ? document.fonts.ready : null,
      ...imgs.map(i => new Promise(r => { i.addEventListener('load', r); i.addEventListener('error', r); })),
    ]),
    new Promise(r => setTimeout(r, 5000)),
  ]);
})()`;

/**
 * Walk the page one viewport at a time so loading="lazy" images and
 * IntersectionObserver-driven content render, then return to the top.
 * Replaces the 120 ms per-segment pause in RPC's scroll-and-stitch.
 * Bounded to 100 steps and the full-page height cap.
 */
const warmUpScrollJs = (maxHeight: number) => `(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const root = document.scrollingElement || document.documentElement;
  const step = Math.max(200, Math.floor(window.innerHeight * 0.9));
  for (let i = 0, y = 0; i < 100 && y < ${maxHeight}; i++, y += step) {
    if (y > root.scrollHeight - window.innerHeight) break;
    window.scrollTo({ top: y, behavior: 'instant' });
    await sleep(100);
  }
  window.scrollTo({ top: Math.min(root.scrollHeight, ${maxHeight}), behavior: 'instant' });
  await sleep(150);
  window.scrollTo({ top: 0, behavior: 'instant' });
  await sleep(150);
})()`;

const SCROLL_WIDTH_JS = `Math.max(document.documentElement.scrollWidth, document.body ? document.body.scrollWidth : 0)`;

const SCROLL_HEIGHT_JS = `Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0)`;

/**
 * Network idle (bounded: dev servers with HMR or analytics beacons may never
 * go idle), web fonts, and pending <img> loads.
 */
async function settle(page: Page, timeoutMs: number): Promise<void> {
  await page
    .waitForLoadState('networkidle', { timeout: Math.min(timeoutMs, 10_000) })
    .catch(() => {});
  await page.evaluate(WAIT_FOR_ASSETS_JS).catch(() => {});
}

async function warmUpScroll(page: Page, maxHeight: number): Promise<void> {
  await page.evaluate(warmUpScrollJs(Math.round(maxHeight)));
}

/** `<host>[-<path>]-<device>`, e.g. `localhost-3000-about-iphone-15`. */
export function fileStem(url: string, deviceId: string): string {
  const u = new URL(url);
  let parts: string;
  if (u.protocol === 'file:') {
    parts = `file-${basename(u.pathname, extname(u.pathname))}`;
  } else {
    parts = `${u.hostname}${u.port ? `-${u.port}` : ''}${u.pathname}`;
  }
  const slug = parts
    .toLowerCase()
    .replace(/^www\./, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/, '');
  return `${slug || 'page'}-${deviceId}`;
}
