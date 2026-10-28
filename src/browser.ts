import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser } from 'playwright';

/** Repo/package root (one level above src/ and dist/). */
export const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const require = createRequire(import.meta.url);

/** Playwright's own CLI, from this package's dependency (so versions match). */
function playwrightCli(): string {
  return resolve(dirname(require.resolve('playwright/package.json')), 'cli.js');
}

export function playwrightVersion(): string {
  return (JSON.parse(readFileSync(require.resolve('playwright/package.json'), 'utf8')) as { version: string }).version;
}

/** The exact commands that fix a missing browser, for messages. */
export function installHint(): string {
  return (
    `Fix: run \`npx playwright install chromium\` inside ${PACKAGE_DIR} ` +
    `(or \`node ${resolve(PACKAGE_DIR, 'dist', 'cli.js')} install\`, which uses the same Playwright version as rpc).`
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

export interface DoctorReport {
  ok: boolean;
  node: string;
  playwright: string;
  browsersPath: string;
  chromium: 'ok' | 'missing' | 'launch-failed';
  version?: string;
  error?: string;
  fix?: string;
}

/** Check that Chromium is installed and actually launches. */
export async function doctor(): Promise<DoctorReport> {
  const base = {
    node: process.version,
    playwright: playwrightVersion(),
    browsersPath: process.env.PLAYWRIGHT_BROWSERS_PATH || '(Playwright default cache)',
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

/** Run `playwright install chromium` with this package's Playwright, streaming its output. */
export function installChromium(): Promise<number> {
  return new Promise((res, rej) => {
    const child = spawn(process.execPath, [playwrightCli(), 'install', 'chromium'], { stdio: 'inherit' });
    child.on('error', rej);
    child.on('exit', code => res(code ?? 1));
  });
}
