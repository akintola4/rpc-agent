import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { delimiter, dirname, join, resolve } from 'node:path';
import { chromium, type Browser } from 'playwright';

const require = createRequire(import.meta.url);

/** Playwright's own CLI, from this package's dependency (so versions match). */
function playwrightCli(): string {
  return resolve(dirname(require.resolve('playwright/package.json')), 'cli.js');
}

export function playwrightVersion(): string {
  return (JSON.parse(readFileSync(require.resolve('playwright/package.json'), 'utf8')) as { version: string }).version;
}

/**
 * The command that fixes a missing browser. `rpc install` runs this package's
 * own Playwright CLI, so the downloaded Chromium matches the version rpc
 * launches, whether rpc came from npx, a global install or a clone.
 */
export function installHint(): string {
  return (
    'Fix: run `npx rpc-agent install` (or `rpc install` if rpc is on your PATH). ' +
    `It downloads Chromium for Playwright ${playwrightVersion()}, the version rpc uses.`
  );
}

export class BrowserMissingError extends Error {
  override name = 'BrowserMissingError';
  constructor(readonly executablePath: string | undefined) {
    super(
      `Playwright's Chromium is not installed${executablePath ? ` (expected ${executablePath})` : ''}. ` + installHint()
    );
  }
}

/** Launch headless Chromium, turning "Executable doesn't exist" into BrowserMissingError. */
export async function launchBrowser(): Promise<Browser> {
  try {
    return await chromium.launch({ headless: true });
  } catch (err) {
    const msg = (err as Error).message;
    if (/Executable doesn't exist|playwright install/i.test(msg)) {
      throw new BrowserMissingError(/Executable doesn't exist at (\S.*?)\s*$/m.exec(msg)?.[1]);
    }
    throw err;
  }
}

export interface Ffmpeg {
  path: string;
  /** Playwright's own build (downloaded with Chromium) or one on PATH. */
  source: 'playwright' | 'system';
}

/**
 * Playwright's ffmpeg build, which `playwright install chromium` downloads
 * next to the browser. It reads MJPEG, writes VP9 webm and PNG, and has the
 * crop, scale and pad filters: enough for `rpc record` and its GIF frames.
 * Found through Playwright's registry, so PLAYWRIGHT_BROWSERS_PATH applies.
 */
export function playwrightFfmpeg(): string | undefined {
  try {
    const fromPlaywright = createRequire(require.resolve('playwright/package.json'));
    const core = fromPlaywright('playwright-core/lib/coreBundle') as {
      registry?: { registry?: { findExecutable(name: string): { executablePath(): string | undefined } | undefined } };
    };
    const path = core.registry?.registry?.findExecutable('ffmpeg')?.executablePath();
    return path && existsSync(path) ? path : undefined;
  } catch {
    return undefined; // registry layout changed: fall back to PATH
  }
}

/** `ffmpeg` on PATH, if any. */
export function systemFfmpeg(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const names = process.platform === 'win32' ? ['ffmpeg.exe'] : ['ffmpeg'];
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    for (const n of names) if (dir && existsSync(join(dir, n))) return join(dir, n);
  }
  return undefined;
}

/** The ffmpeg `rpc record` uses: Playwright's build first, then PATH. */
export function findFfmpeg(): Ffmpeg | undefined {
  const pw = playwrightFfmpeg();
  if (pw) return { path: pw, source: 'playwright' };
  const sys = systemFfmpeg();
  return sys ? { path: sys, source: 'system' } : undefined;
}

/** An H.264 encoder in this ffmpeg build (Playwright's has none), for --mp4. */
export function h264Encoder(ffmpeg: string): string | undefined {
  const r = spawnSync(ffmpeg, ['-hide_banner', '-encoders'], { encoding: 'utf8', timeout: 10_000 });
  const list = `${r.stdout ?? ''}`;
  return ['libx264', 'h264_videotoolbox', 'libopenh264'].find(e => new RegExp(`\\s${e}\\s`).test(list));
}

export interface DoctorReport {
  ok: boolean;
  node: string;
  playwright: string;
  browsersPath: string;
  chromium: 'ok' | 'missing' | 'launch-failed';
  version?: string;
  error?: string;
  fix?: string;
  /** `rpc record`: which ffmpeg it would use. Not part of `ok`: only recording needs it. */
  ffmpeg: { source: 'playwright' | 'system' | 'missing'; path?: string; fix?: string };
  /** `rpc record --mp4`: a system ffmpeg with an H.264 encoder (optional). */
  mp4: { ok: boolean; encoder?: string };
}

/** ffmpeg for `rpc record`, and H.264 for --mp4. */
export function videoReport(): Pick<DoctorReport, 'ffmpeg' | 'mp4'> {
  const ff = findFfmpeg();
  const sys = systemFfmpeg();
  const encoder = sys ? h264Encoder(sys) : undefined;
  return {
    ffmpeg: ff
      ? { source: ff.source, path: ff.path }
      : { source: 'missing', fix: 'rpc record needs ffmpeg: run `npx rpc-agent install` (Playwright downloads its ffmpeg with Chromium), or put ffmpeg on PATH.' },
    mp4: encoder ? { ok: true, encoder } : { ok: false },
  };
}

/** Check that Chromium is installed and actually launches. */
export async function doctor(): Promise<DoctorReport> {
  const base = {
    node: process.version,
    playwright: playwrightVersion(),
    browsersPath: process.env.PLAYWRIGHT_BROWSERS_PATH || '(Playwright default cache)',
    ...videoReport(),
  };
  try {
    const browser = await launchBrowser();
    const version = browser.version();
    await browser.close();
    return { ok: true, ...base, chromium: 'ok', version };
  } catch (err) {
    if (err instanceof BrowserMissingError) {
      return { ok: false, ...base, chromium: 'missing', error: err.message, fix: installHint() };
    }
    return { ok: false, ...base, chromium: 'launch-failed', error: (err as Error).message.split('\n')[0] ?? String(err) };
  }
}

/**
 * Run `playwright install --only-shell chromium` with this package's
 * Playwright, streaming its output. Captures always run headless, which uses
 * the headless shell, so the full Chrome for Testing build (about 370 MB on
 * disk) is only fetched with `headed` (for `rpc login`'s browser window).
 */
export function installChromium(opts: { headed?: boolean } = {}): Promise<number> {
  return new Promise((res, rej) => {
    // Load the CLI through -e with a plain argv[1]. Under npx the real path is
    // in the `_npx` cache, and Playwright then prints a box telling the user
    // to install their project's dependencies, which doesn't apply here.
    const loader = `process.argv.splice(1, 0, 'playwright'); require(${JSON.stringify(playwrightCli())});`;
    // --headed: full Chromium as well, for `rpc login`'s visible window.
    const args = opts.headed ? ['install', 'chromium'] : ['install', '--only-shell', 'chromium'];
    const child = spawn(process.execPath, ['-e', loader, ...args], { stdio: 'inherit' });
    child.on('error', rej);
    child.on('exit', code => res(code ?? 1));
  });
}
