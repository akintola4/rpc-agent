import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { basename, extname, resolve } from 'node:path';
import type { Browser, BrowserContext, Page } from 'playwright';
import {
  applyHeaders,
  AuthRequiredError,
  redact,
  redirectedToLogin,
  resolveAuth,
  type AuthSummary,
  type ResolvedAuth,
} from './auth.js';
import { launchBrowser } from './browser.js';
import { renderFramed, renderSlices, type Segment } from './composite.js';
import { explainError } from './errors.js';
import { emulationFor, resolveDevices, type Device } from './devices.js';
import {
  detectMotion,
  finishAnimations,
  settleMotion,
  shotWarnings,
  unpin,
  warmUpScrollJs,
  type FinishResult,
  type MotionFinding,
  type SettleResult,
  type UnpinResult,
} from './motion.js';
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
  /** How the page was settled, skipped ahead and unpinned before capture. */
  motion?: MotionMeta;
  /**
   * Where the capture differs from what a person scrolling sees: elements
   * still animating, pinned sections left in place, hidden reveals,
   * carousels. Present only when there is something to say.
   */
  warnings?: MotionFinding[];
  /** One-line failure message (navigation, wait or capture). */
  error?: string;
  /** Machine-readable failure code: `ERR_NAME_NOT_RESOLVED`, `TIMEOUT`, ... */
  code?: string;
  /** What to do about the failure. */
  hint?: string;
  /** In-memory buffers for callers that want them (MCP previews). */
  buffers?: { shot?: Buffer; framed?: Buffer; slices?: Buffer[] };
}

export interface MotionMeta {
  /** The final wait before capture (see motion.ts). */
  settle: SettleResult;
  /** Full page: the warm-up scroll's settle steps. */
  warmUp?: { steps: number; settled: number; ms: number };
  /** --finish-animations: what was sent to its end. */
  finished?: FinishResult;
  /** Full page: pinned sections collapsed so each shows once (off with --no-unpin). */
  unpinned?: UnpinResult[];
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
  /** Present only when cookies, headers, a storage state or a saved session were involved. Values are masked. */
  auth?: AuthSummary;
}

export interface CaptureHooks {
  /** Reuse a browser; otherwise one is launched and closed. */
  browser?: Browser;
  /** Called before each device is captured (CLI progress). */
  onDeviceStart?: (device: Device) => void;
  onDevice?: (shot: DeviceShot) => void;
  /** Keep image buffers on the result (default false). */
  keepBuffers?: boolean;
  /**
   * Render the first `opts.maxSlices` full-page slices for inline use (MCP).
   * When the page has more, all slices are saved to disk unless
   * `opts.saveSlices === false`.
   */
  inlineSlices?: boolean;
  /** Auth already resolved by the caller (to show it before capture); otherwise resolved here. */
  auth?: ResolvedAuth;
  /** Called once with the masked auth summary, before the first device, when auth is in play. */
  onAuth?: (summary: AuthSummary) => void;
}

export async function capture(opts: ShotOptions, hooks: CaptureHooks = {}): Promise<ShotResult> {
  const devices = resolveDevices(opts.devices);
  const outDir = resolve(opts.outDir);
  const auth = hooks.auth ?? resolveAuth(opts.url, opts.auth ?? {});
  await mkdir(outDir, { recursive: true });
  if (auth.summary) hooks.onAuth?.(auth.summary);

  const browser = hooks.browser ?? (await launchBrowser());
  try {
    const shots: DeviceShot[] = [];
    for (const device of devices) {
      let shot: DeviceShot;
      hooks.onDeviceStart?.(device);
      try {
        shot = await captureDevice(browser, device, opts, outDir, hooks, auth);
      } catch (err) {
        shot = { ...baseShot(device), ...describeFailure(err, opts, auth) };
      }
      if (shot.consoleErrors?.length && auth.secrets.length) {
        shot.consoleErrors = shot.consoleErrors.map(l => redact(l, auth.secrets));
      }
      if (!hooks.keepBuffers) delete shot.buffers;
      hooks.onDevice?.(shot);
      shots.push(shot);
    }
    return { url: opts.url, outDir, shots, ...(auth.summary ? { auth: auth.summary } : {}) };
  } finally {
    if (!hooks.browser) await browser.close();
  }
}

export interface DeviceFailure {
  error: string;
  code: string;
  hint?: string;
  status?: number | null;
  finalUrl?: string;
}

/** A device's navigation/capture failure as `{ error, code, hint }`, secrets scrubbed. */
export function describeFailure(
  err: unknown,
  opts: { url: string; timeoutMs: number; waitFor?: string | undefined },
  auth: ResolvedAuth
): DeviceFailure {
  if (err instanceof AuthRequiredError) {
    return { status: err.status, finalUrl: err.finalUrl, error: err.message, code: err.code, hint: err.hint };
  }
  const e = explainError(err, { url: opts.url, timeoutMs: opts.timeoutMs, waitFor: opts.waitFor });
  return {
    error: redact(e.error, auth.secrets),
    code: e.code,
    ...(e.hint ? { hint: redact(e.hint, auth.secrets) } : {}),
  };
}

function baseShot(device: Device): DeviceShot {
  return {
    device: device.id,
    name: device.name,
    viewport: { width: device.width, height: device.height },
    dpr: device.dpr,
  };
}

/** A fresh context for one device: viewport, DPR, mobile emulation, media features and auth state. */
export async function newDeviceContext(
  browser: Browser,
  device: Device,
  opts: Pick<ShotOptions, 'emulate' | 'colorScheme' | 'reducedMotion'>,
  auth: ResolvedAuth
): Promise<BrowserContext> {
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
    ...(auth.state ? { storageState: auth.state } : {}),
  });
  if (auth.cookies.length) await context.addCookies(auth.cookies);
  return context;
}

async function captureDevice(
  browser: Browser,
  device: Device,
  opts: ShotOptions,
  outDir: string,
  hooks: CaptureHooks,
  auth: ResolvedAuth
): Promise<DeviceShot> {
  const context = await newDeviceContext(browser, device, opts, auth);
  const result = baseShot(device);
  const errors = new Set<string>();

  try {
    const page = await context.newPage();
    await applyHeaders(context, page, auth);
    page.on('pageerror', e => errors.add(`pageerror: ${e.message}`));
    page.on('console', m => {
      if (m.type() === 'error') errors.add(`console: ${m.text()}`);
    });

    const response = await page.goto(opts.url, { waitUntil: 'load', timeout: opts.timeoutMs });
    result.status = response?.status() ?? null;
    await settle(page, opts.timeoutMs);
    // A login page instead of the requested one: say so rather than capture it.
    const checkLogin = () => {
      if (redirectedToLogin(opts.url, page.url())) throw new AuthRequiredError(opts.url, page.url(), result.status ?? null);
    };
    checkLogin();
    if (opts.waitFor) {
      try {
        await page.waitForSelector(opts.waitFor, { state: 'visible', timeout: opts.timeoutMs });
      } catch (err) {
        checkLogin();
        throw err;
      }
    }
    let warmUp: MotionMeta['warmUp'];
    if (opts.fullPage) {
      warmUp = await warmUpScroll(page, opts.maxHeight);
      await settle(page, opts.timeoutMs);
    }
    const finished = opts.finishAnimations ? await finishAnimations(page) : undefined;
    // Collapse pins before measuring, so the stitched height is the unpinned one.
    const unpinned = opts.fullPage && opts.unpin ? await unpin(page) : [];
    if (opts.waitMs > 0) await page.waitForTimeout(opts.waitMs);
    const motion: MotionMeta = { settle: await settleMotion(page) };
    if (warmUp) motion.warmUp = warmUp;
    if (finished) motion.finished = finished;
    if (unpinned.length) motion.unpinned = unpinned;
    result.motion = motion;
    checkLogin();

    result.finalUrl = page.url();
    result.title = await page.title();
    result.scrollHeight = await page.evaluate<number>(SCROLL_HEIGHT_JS);
    const warnings = shotWarnings(await detectMotion(page, opts.fullPage ? 'page' : 'viewport'), motion.settle, {
      fullPage: opts.fullPage,
      unpinned,
    });
    if (warnings.length) result.warnings = warnings;

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

const SCROLL_WIDTH_JS = `Math.max(document.documentElement.scrollWidth, document.body ? document.body.scrollWidth : 0)`;

const SCROLL_HEIGHT_JS = `Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0)`;

/**
 * Network idle (bounded: dev servers with HMR or analytics beacons may never
 * go idle), web fonts, and pending <img> loads.
 */
export async function settle(page: Page, timeoutMs: number): Promise<void> {
  await page
    .waitForLoadState('networkidle', { timeout: Math.min(timeoutMs, 10_000) })
    .catch(() => {});
  await page.evaluate(WAIT_FOR_ASSETS_JS).catch(() => {});
}

async function warmUpScroll(page: Page, maxHeight: number): Promise<NonNullable<MotionMeta['warmUp']>> {
  return (await page.evaluate(warmUpScrollJs(Math.round(maxHeight)))) as NonNullable<MotionMeta['warmUp']>;
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
