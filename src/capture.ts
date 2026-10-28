import { mkdir, writeFile } from 'node:fs/promises';
import { basename, extname, resolve } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { renderFramed } from './composite.js';
import { explainError } from './errors.js';
import { emulationFor, resolveDevices, type Device } from './devices.js';
import type { ShotOptions } from './options.js';
import { pngSize } from './png.js';

/** Chromium can't produce a bitmap taller than this in one capture. */
export const MAX_CAPTURE_PX = 16_384;

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
  /** Full-page capture hit MAX_CAPTURE_PX and was cut off. */
  clipped?: boolean;
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
  buffers?: { shot?: Buffer; framed?: Buffer };
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
}

export async function launchBrowser(): Promise<Browser> {
  try {
    return await chromium.launch({ headless: true });
  } catch (err) {
    const msg = (err as Error).message;
    if (/Executable doesn't exist|playwright install/i.test(msg)) {
      throw new Error(
        'Playwright Chromium is not installed. Run: npx playwright install chromium'
      );
    }
    throw err;
  }
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
        shot = await captureDevice(browser, device, opts, outDir);
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
  outDir: string
): Promise<DeviceShot> {
  const emu = opts.emulate ? emulationFor(device) : undefined;
  const context = await browser.newContext({
    viewport: { width: device.width, height: device.height },
    deviceScaleFactor: device.dpr,
    isMobile: emu?.isMobile ?? false,
    hasTouch: emu?.hasTouch ?? false,
    ...(emu?.userAgent ? { userAgent: emu.userAgent } : {}),
    ...(opts.colorScheme ? { colorScheme: opts.colorScheme } : {}),
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
      await warmUpScroll(page);
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
    if (opts.fullPage) {
      const maxCss = Math.floor(MAX_CAPTURE_PX / device.dpr);
      result.clipped = result.scrollHeight > maxCss;
      shotPng = await page.screenshot({
        ...shotOpts,
        fullPage: true,
        ...(result.clipped
          ? { clip: { x: 0, y: 0, width: device.width, height: maxCss } }
          : {}),
      });
    } else {
      shotPng = viewportPng!;
    }

    result.shot = await save(resolve(outDir, `${base}.png`), shotPng);
    result.buffers = { shot: shotPng };

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
 * Bounded to 40 steps / 30k CSS px.
 */
const WARM_UP_SCROLL_JS = `(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const root = document.scrollingElement || document.documentElement;
  const step = Math.max(200, Math.floor(window.innerHeight * 0.8));
  for (let i = 0, y = 0; i < 40 && y < 30000; i++, y += step) {
    if (y > root.scrollHeight - window.innerHeight) break;
    window.scrollTo({ top: y, behavior: 'instant' });
    await sleep(120);
  }
  window.scrollTo({ top: root.scrollHeight, behavior: 'instant' });
  await sleep(150);
  window.scrollTo({ top: 0, behavior: 'instant' });
  await sleep(150);
})()`;

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

async function warmUpScroll(page: Page): Promise<void> {
  await page.evaluate(WARM_UP_SCROLL_JS);
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
