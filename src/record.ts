// `rpc record`: a short video of a page, or of one element on it. Frames
// come from a screenshot loop on the element's box (device pixels, cropped
// exactly), and ffmpeg (Playwright's own build, or one on PATH) turns them
// into a VP9 webm at a constant frame rate. See docs/plan.md, v0.6.
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Browser } from 'playwright';
import {
  applyHeaders,
  AuthRequiredError,
  redact,
  redirectedToLogin,
  resolveAuth,
  type AuthSummary,
  type ResolvedAuth,
} from './auth.js';
import { findFfmpeg, h264Encoder, launchBrowser, systemFfmpeg, type Ffmpeg } from './browser.js';
import { describeFailure, fileStem, newDeviceContext, settle, type ImageFile } from './capture.js';
import { resolveDevice, type Device } from './devices.js';
import { plainText } from './errors.js';
import { buildPalette, gifWriter } from './gif.js';
import { settleMotion } from './motion.js';
import type { RecordOptions } from './options.js';
import { decodePng, imageSize, pngSize, type RawImage } from './png.js';

/** Output frame rate of the webm. */
export const RECORD_FPS = 25;
/** GIF frame rate and width cap. */
export const GIF_FPS = 10;
export const GIF_MAX_WIDTH = 640;
/** Frames sampled (evenly) for the GIF's shared palette. */
const GIF_PALETTE_FRAMES = 12;

export interface VideoFile {
  path: string;
  /** Pixels (the clip times the device pixel ratio). */
  width: number;
  height: number;
  /** Seconds, as the container reports it. */
  duration: number;
  fps: number;
  /** Distinct screenshots taken; the rest of the frames repeat them. */
  captured: number;
}

export interface RecordResult {
  url: string;
  outDir: string;
  device: string;
  name: string;
  viewport: { width: number; height: number };
  dpr: number;
  selector?: string;
  /** The recorded box in CSS px, relative to the viewport. */
  clip?: { x: number; y: number; width: number; height: number };
  /** The element is bigger than the viewport; only the visible part was recorded. */
  clipped?: boolean;
  video?: VideoFile;
  /** The first frame as a PNG. */
  poster?: ImageFile;
  gif?: ImageFile & { frames: number };
  mp4?: { path: string; encoder: string };
  /** Which ffmpeg encoded the webm. */
  ffmpeg?: Ffmpeg['source'];
  status?: number | null;
  finalUrl?: string;
  title?: string;
  consoleErrors?: string[];
  /** Things that didn't stop the recording (mp4 skipped, element clipped). */
  warnings?: string[];
  error?: string;
  code?: string;
  hint?: string;
  auth?: AuthSummary;
}

export interface RecordHooks {
  browser?: Browser;
  /** The ffmpeg to encode with (default: findFfmpeg()). */
  ffmpeg?: Ffmpeg;
  auth?: ResolvedAuth;
  onAuth?: (summary: AuthSummary) => void;
  /** Called when frames start (after load, scroll and settle). */
  onRecording?: (seconds: number) => void;
}

/** A failure with its own code and hint (no element, no ffmpeg). */
export class RecordError extends Error {
  override name = 'RecordError';
  constructor(
    readonly code: string,
    message: string,
    readonly hint?: string
  ) {
    super(message);
  }
}

export async function record(opts: RecordOptions, hooks: RecordHooks = {}): Promise<RecordResult> {
  const device = resolveDevice(opts.device);
  const outDir = resolve(opts.outDir);
  const auth = hooks.auth ?? resolveAuth(opts.url, opts.auth ?? {});
  if (auth.summary) hooks.onAuth?.(auth.summary);
  const result: RecordResult = {
    url: opts.url,
    outDir,
    device: device.id,
    name: device.name,
    viewport: { width: device.width, height: device.height },
    dpr: device.dpr,
    ...(opts.selector ? { selector: opts.selector } : {}),
    ...(auth.summary ? { auth: auth.summary } : {}),
  };
  const ffmpeg = hooks.ffmpeg ?? findFfmpeg();
  if (!ffmpeg) {
    return {
      ...result,
      code: 'FFMPEG_MISSING',
      error: 'No ffmpeg to encode the video with',
      hint: 'Run `npx rpc-agent install` (Playwright downloads its ffmpeg next to Chromium), or put ffmpeg on PATH.',
    };
  }
  result.ffmpeg = ffmpeg.source;
  await mkdir(outDir, { recursive: true });

  const browser = hooks.browser ?? (await launchBrowser());
  const errors = new Set<string>();
  try {
    await recordDevice(browser, device, opts, auth, ffmpeg, result, errors, hooks);
  } catch (err) {
    if (err instanceof RecordError) Object.assign(result, { code: err.code, error: redact(err.message, auth.secrets), ...(err.hint ? { hint: err.hint } : {}) });
    else Object.assign(result, describeFailure(err, opts, auth));
  } finally {
    result.consoleErrors = [...errors].slice(0, 20).map(l => redact(l, auth.secrets));
    if (!hooks.browser) await browser.close();
  }
  return result;
}

async function recordDevice(
  browser: Browser,
  device: Device,
  opts: RecordOptions,
  auth: ResolvedAuth,
  ffmpeg: Ffmpeg,
  result: RecordResult,
  errors: Set<string>,
  hooks: RecordHooks
): Promise<void> {
  const context = await newDeviceContext(browser, device, opts, auth);
  try {
    const page = await context.newPage();
    await applyHeaders(context, page, auth);
    page.on('pageerror', e => errors.add(plainText(`pageerror: ${e.message}`)));
    page.on('console', m => {
      if (m.type() === 'error') errors.add(plainText(`console: ${m.text()}`));
    });
    const response = await page.goto(opts.url, { waitUntil: 'load', timeout: opts.timeoutMs });
    result.status = response?.status() ?? null;
    await settle(page, opts.timeoutMs);
    const checkLogin = () => {
      if (redirectedToLogin(opts.url, page.url())) throw new AuthRequiredError(opts.url, page.url(), result.status ?? null);
    };
    checkLogin();
    if (opts.waitFor) await page.waitForSelector(opts.waitFor, { state: 'visible', timeout: opts.timeoutMs });

    let clip = { x: 0, y: 0, width: device.width, height: device.height };
    if (opts.selector) {
      const el = page.locator(opts.selector).first();
      try {
        await el.waitFor({ state: 'visible', timeout: Math.min(opts.timeoutMs, 10_000) });
      } catch {
        checkLogin();
        throw new RecordError('SELECTOR_NOT_FOUND', `No visible element matches "${opts.selector}"`, 'Check the selector in the browser devtools (document.querySelector), or wait for it with --wait-for.');
      }
      await el.scrollIntoViewIfNeeded();
      // Let scroll-triggered reveals around it finish, so the video shows the element itself.
      await settleMotion(page);
      const box = await el.boundingBox();
      if (!box) throw new RecordError('SELECTOR_NOT_FOUND', `"${opts.selector}" has no box to record`, 'The element is not rendered (display: none or detached).');
      const x0 = Math.max(0, Math.floor(box.x));
      const y0 = Math.max(0, Math.floor(box.y));
      const x1 = Math.min(device.width, Math.ceil(box.x + box.width));
      const y1 = Math.min(device.height, Math.ceil(box.y + box.height));
      if (x1 - x0 < 2 || y1 - y0 < 2) throw new RecordError('SELECTOR_NOT_FOUND', `"${opts.selector}" is outside the viewport`, 'Record a smaller element, or pick a device with a larger viewport.');
      clip = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
      if (box.width > clip.width + 1 || box.height > clip.height + 1) {
        result.clipped = true;
        (result.warnings ??= []).push(
          `"${opts.selector}" is ${Math.round(box.width)}x${Math.round(box.height)} CSS px, larger than the ${device.width}x${device.height} viewport; only the visible part was recorded.`
        );
      }
    }
    if (opts.waitMs > 0) await page.waitForTimeout(opts.waitMs);
    checkLogin();
    result.finalUrl = page.url();
    result.title = await page.title();
    result.clip = clip;

    const stem = recordStem(opts.url, device.id, opts.selector);
    const posterPng = await page.screenshot({ clip, type: 'png', animations: 'allow', caret: 'initial' });
    result.poster = { path: resolve(result.outDir, `${stem}-poster.png`), ...pngSize(posterPng) };
    await writeFile(result.poster.path, posterPng);

    hooks.onRecording?.(opts.duration);
    const webm = resolve(result.outDir, `${stem}.webm`);
    let captured: number;
    try {
      captured = await encodeFrames(ffmpeg.path, webm, opts.duration, () =>
        page.screenshot({ clip, type: 'jpeg', quality: 90, animations: 'allow', caret: 'initial' })
      );
    } catch (err) {
      // No video: don't leave its poster behind next to an error result.
      await rm(result.poster.path, { force: true });
      delete result.poster;
      throw err;
    }
    result.video = { ...(await probeVideo(ffmpeg.path, webm)), path: webm, fps: RECORD_FPS, captured };

    if (opts.gif) result.gif = await writeGif(ffmpeg.path, webm, resolve(result.outDir, `${stem}.gif`), result.video);
    if (opts.mp4) {
      const mp4 = await writeMp4(webm, resolve(result.outDir, `${stem}.mp4`));
      if ('path' in mp4) result.mp4 = mp4;
      else (result.warnings ??= []).push(mp4.skipped);
    }
  } finally {
    await context.close();
  }
}

/** `<host>[-<path>]-<device>[-<selector>]`, e.g. `localhost-3000-desktop-1440-carousel`. */
export function recordStem(url: string, deviceId: string, selector?: string): string {
  const base = fileStem(url, deviceId);
  if (!selector) return base;
  const slug = selector.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
  return slug ? `${base}-${slug}` : base;
}

/**
 * Take frames for `seconds` and pipe them to ffmpeg as MJPEG at RECORD_FPS.
 * Each frame is repeated until the next one's timestamp (the middle of its
 * screenshot call), and the last fills the remainder, so the video is
 * exactly `seconds` long whatever the capture rate. Returns the number of
 * screenshots taken. If ffmpeg can't start or dies, or a screenshot fails,
 * the child is stopped and the partial file removed.
 */
export async function encodeFrames(ffmpeg: string, out: string, seconds: number, shot: () => Promise<Buffer>): Promise<number> {
  const total = Math.round(seconds * RECORD_FPS);
  const child = spawn(
    ffmpeg,
    [
      '-loglevel', 'error', '-y',
      '-f', 'image2pipe', '-c:v', 'mjpeg', '-framerate', String(RECORD_FPS), '-i', 'pipe:0',
      '-an', '-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-crf', '30', '-b:v', '0',
      '-pix_fmt', 'yuv420p', out,
    ],
    { stdio: ['pipe', 'ignore', 'pipe'] }
  );
  let stderr = '';
  child.stderr.on('data', d => (stderr += d));
  // Settles once, on exit or on a spawn failure; never rejects, so a failed
  // spawn can't become an unhandled rejection while frames are being taken.
  let spawnError: Error | undefined;
  let dead = false;
  const exited = new Promise<number>(res => {
    child.once('error', err => {
      spawnError = err;
      res(-1);
    });
    child.once('close', code => res(code ?? 1));
  }).finally(() => {
    dead = true;
  });
  // A dead ffmpeg makes writes fail (EPIPE); the exit code and stderr say why.
  child.stdin.on('error', () => {
    dead = true;
  });
  // Wait for room in the pipe, or for ffmpeg to go away ('drain' never comes then).
  const write = (buf: Buffer) =>
    dead || child.stdin.destroyed
      ? Promise.resolve()
      : new Promise<void>(res => {
          if (child.stdin.write(buf)) return res();
          const done = () => {
            child.stdin.off('drain', done);
            child.stdin.off('close', done);
            res();
          };
          child.stdin.once('drain', done);
          child.stdin.once('close', done);
          void exited.then(done);
        });

  let written = 0;
  let last: Buffer | undefined;
  let captured = 0;
  const fill = async (upTo: number) => {
    for (; written < Math.min(upTo, total) && last && !dead; written++) await write(last);
  };
  try {
    const t0 = performance.now();
    while (performance.now() - t0 < seconds * 1000 && !dead) {
      const before = performance.now();
      const buf = await shot();
      const at = ((before + performance.now()) / 2 - t0) / 1000;
      captured++;
      await fill(Math.round(at * RECORD_FPS));
      last = buf;
    }
    await fill(total);
  } catch (err) {
    child.kill('SIGKILL');
    await exited;
    await rm(out, { force: true });
    throw err;
  }
  child.stdin.end();
  const code = await exited;
  if (spawnError) throw new RecordError('ENCODE_FAILED', `Could not run ffmpeg: ${spawnError.message}`, `ffmpeg: ${ffmpeg}`);
  if (code !== 0) {
    await rm(out, { force: true });
    throw new RecordError('ENCODE_FAILED', `ffmpeg failed (exit ${code}): ${stderr.trim().split('\n').pop() ?? ''}`, `ffmpeg: ${ffmpeg}`);
  }
  return captured;
}

/** Run ffmpeg to completion; stderr in the error. */
function run(ffmpeg: string, args: string[]): Promise<string> {
  return new Promise((res, rej) => {
    const child = spawn(ffmpeg, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', d => (stderr += d));
    child.on('error', rej);
    child.on('close', code => (code === 0 ? res(stderr) : rej(new RecordError('ENCODE_FAILED', `ffmpeg failed (exit ${code}): ${stderr.trim().split('\n').pop() ?? ''}`))));
  });
}

/** Size and duration of a video, from `ffmpeg -i` (which exits 1 without an output; that's expected). */
export async function probeVideo(ffmpeg: string, path: string): Promise<{ width: number; height: number; duration: number }> {
  const info = await new Promise<string>((res, rej) => {
    const child = spawn(ffmpeg, ['-hide_banner', '-i', path], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', d => (stderr += d));
    child.on('error', rej);
    child.on('close', () => res(stderr));
  });
  const size = /Video: .*?\b(\d{1,5})x(\d{1,5})\b/.exec(info);
  const dur = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(info);
  if (!size || !dur) throw new RecordError('ENCODE_FAILED', `Could not read the video ffmpeg wrote: ${path}`);
  return {
    width: Number(size[1]),
    height: Number(size[2]),
    duration: Math.round((Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3])) * 100) / 100,
  };
}

/**
 * Decode the webm to PNG frames at GIF_FPS (Playwright's ffmpeg can), then
 * encode them in gif.ts: the palette from a sample of frames, then one frame
 * decoded and encoded at a time, so memory stays at about one frame.
 */
async function writeGif(
  ffmpeg: string,
  webm: string,
  out: string,
  video: { width: number; height: number; duration: number }
): Promise<ImageFile & { frames: number }> {
  const width = Math.min(video.width, GIF_MAX_WIDTH);
  const height = Math.max(1, Math.round((video.height * width) / video.width));
  // `-r` alone pads a frame or two at the edges; cap at the video's length.
  const count = Math.max(1, Math.round(video.duration * GIF_FPS));
  const dir = await mkdtemp(join(tmpdir(), 'rpc-gif-'));
  try {
    await run(ffmpeg, ['-loglevel', 'error', '-y', '-i', webm, '-r', String(GIF_FPS), '-frames:v', String(count), '-vf', `scale=${width}:${height}`, '-f', 'image2', join(dir, 'f-%04d.png')]);
    const files = (await readdir(dir)).filter(f => f.endsWith('.png')).sort();
    if (!files.length) throw new RecordError('ENCODE_FAILED', 'ffmpeg wrote no GIF frames');
    const frame = async (f: string) => decodePng(await readFile(join(dir, f)));
    const step = Math.max(1, Math.ceil(files.length / GIF_PALETTE_FRAMES));
    const sample: RawImage[] = [];
    for (let i = 0; i < files.length; i += step) sample.push(await frame(files[i]!));
    const gif = gifWriter(width, height, buildPalette(sample), Math.round(100 / GIF_FPS));
    sample.length = 0;
    for (const f of files) gif.add(await frame(f));
    const data = gif.end();
    await writeFile(out, data);
    return { path: out, ...imageSize(data)!, frames: files.length };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** mp4 needs an H.264 encoder, which Playwright's ffmpeg doesn't have: use a system ffmpeg when there is one. */
async function writeMp4(webm: string, out: string): Promise<{ path: string; encoder: string } | { skipped: string }> {
  const sys = systemFfmpeg();
  const encoder = sys ? h264Encoder(sys) : undefined;
  if (!sys || !encoder) {
    return { skipped: 'mp4 skipped: it needs an ffmpeg with an H.264 encoder on PATH (e.g. `brew install ffmpeg`); the webm was written.' };
  }
  const quality = encoder === 'h264_videotoolbox' ? ['-b:v', '8M'] : encoder === 'libx264' ? ['-crf', '20', '-preset', 'veryfast'] : [];
  await run(sys, [
    '-loglevel', 'error', '-y', '-i', webm,
    '-c:v', encoder, ...quality, '-pix_fmt', 'yuv420p', '-vf', 'pad=ceil(iw/2)*2:ceil(ih/2)*2', '-movflags', '+faststart', out,
  ]);
  return { path: out, encoder };
}
