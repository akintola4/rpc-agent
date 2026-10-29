// `rpc login`: sign in once, save the browser's storage state for the origin.
import { chromium, type Browser, type Page } from 'playwright';
import { isLoginUrl, redact, scopeState, toOrigin, writeSession, type StorageState } from './auth.js';
import { launchBrowser } from './browser.js';

export const DEFAULT_SELECTORS = {
  email: 'input[type=email], input[autocomplete=username], input[name=email], input[name=username], input#email',
  password: 'input[type=password]',
  submit: 'button[type=submit], input[type=submit]',
} as const;

export interface FormLogin {
  email: string;
  password: string;
  emailSelector?: string | undefined;
  passwordSelector?: string | undefined;
  submitSelector?: string | undefined;
}

export interface LoginOptions {
  url: string;
  /** Write here instead of the per-origin session file. */
  save?: string | undefined;
  timeoutMs: number;
}

export interface LoginResult {
  origin: string;
  path: string;
  /** Page URL when the state was saved. */
  finalUrl: string;
  /** Cookies saved for the origin (all cookies are saved; only the origin's are loaded later). */
  cookies: number;
  /** Origins with localStorage saved. */
  localStorage: number;
  /** The page was still on a login URL when saved: the sign-in probably didn't finish. */
  stillOnLogin: boolean;
}

export class HeadedBrowserMissingError extends Error {
  override name = 'HeadedBrowserMissingError';
  constructor() {
    super(
      'rpc login opens a browser window, which needs full Chromium (`rpc install` only downloads the headless shell). ' +
        'Run `rpc install --headed`, or install Google Chrome, or sign in headlessly with `rpc login <url> --form`.'
    );
  }
}

/** Headed Chromium; falls back to an installed Google Chrome. */
export async function launchHeaded(): Promise<Browser> {
  try {
    return await chromium.launch({ headless: false });
  } catch (err) {
    if (!/Executable doesn't exist|playwright install/i.test((err as Error).message)) throw err;
  }
  try {
    return await chromium.launch({ headless: false, channel: 'chrome' });
  } catch {
    throw new HeadedBrowserMissingError();
  }
}

async function save(state: StorageState, opts: LoginOptions, finalUrl: string): Promise<LoginResult> {
  const origin = toOrigin(opts.url);
  const path = await writeSession(state, { origin, savedAt: new Date().toISOString(), url: opts.url }, opts.save);
  const own = scopeState(state, [origin]);
  return {
    origin,
    path,
    finalUrl,
    cookies: own.cookies.length,
    localStorage: own.origins.length,
    stillOnLogin: isLoginUrl(finalUrl) && new URL(finalUrl).origin === origin,
  };
}

/**
 * Open a visible browser at the URL and save the storage state when `done`
 * resolves (the user pressed Enter) or the window is closed.
 */
export async function interactiveLogin(
  opts: LoginOptions,
  done: Promise<unknown>,
  onOpen?: () => void
): Promise<LoginResult> {
  const browser = await launchHeaded();
  try {
    const context = await browser.newContext({ viewport: null, ignoreHTTPSErrors: true });
    const page = await context.newPage();
    let lastUrl = opts.url;
    page.on('framenavigated', f => {
      if (f === page.mainFrame()) lastUrl = f.url();
    });
    await page.goto(opts.url, { timeout: opts.timeoutMs }).catch(() => {});
    onOpen?.();

    // Snapshot regularly: once the window is closed the context can't be read.
    let snapshot = await context.storageState();
    const timer = setInterval(() => {
      context.storageState().then(s => (snapshot = s), () => {});
    }, 1000);
    const closed = new Promise(res => {
      page.on('close', res);
      browser.on('disconnected', res);
    });
    try {
      await Promise.race([done, closed]);
    } finally {
      clearInterval(timer);
    }
    const state = await context.storageState().catch(() => snapshot);
    if (!page.isClosed()) lastUrl = page.url();
    return await save(state, opts, lastUrl);
  } finally {
    await browser.close().catch(() => {});
  }
}

/**
 * Headless: fill an email + password form, submit, wait to leave the login
 * URL, save. For CI and agents.
 */
export async function formLogin(opts: LoginOptions, form: FormLogin): Promise<LoginResult> {
  const browser = await launchBrowser();
  try {
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage();
    await page.goto(opts.url, { waitUntil: 'load', timeout: opts.timeoutMs });
    // Let client-side forms hydrate, so submit runs the app's handler rather
    // than a native GET that would put the password in the URL.
    await page.waitForLoadState('networkidle', { timeout: Math.min(opts.timeoutMs, 10_000) }).catch(() => {});
    const start = new URL(page.url());

    const email = page.locator(form.emailSelector ?? DEFAULT_SELECTORS.email).first();
    const password = page.locator(form.passwordSelector ?? DEFAULT_SELECTORS.password).first();
    await waitVisible(email, 'email field', form.emailSelector ? '--email-selector' : undefined, opts.timeoutMs);
    await email.fill(form.email);
    await waitVisible(password, 'password field', form.passwordSelector ? '--password-selector' : undefined, opts.timeoutMs);
    await password.fill(form.password);

    const submit = page.locator(form.submitSelector ?? DEFAULT_SELECTORS.submit).first();
    if (form.submitSelector || (await submit.count()) > 0) {
      await waitVisible(submit, 'submit button', form.submitSelector ? '--submit-selector' : undefined, opts.timeoutMs);
      await submit.click();
    } else {
      await password.press('Enter');
    }

    try {
      await page.waitForURL(u => u.origin + u.pathname !== start.origin + start.pathname, { timeout: opts.timeoutMs });
    } catch {
      const shown = await pageMessage(page);
      const message = shown && redact(shown, [form.password]);
      throw new Error(
        `Still on ${start.origin}${start.pathname} ${Math.round(opts.timeoutMs / 1000)} s after submitting the form` +
          `${message ? ` (the page says: "${message}")` : ''}. Check the credentials, or the selectors (--email-selector, --password-selector, --submit-selector).`
      );
    }
    await page.waitForLoadState('networkidle', { timeout: Math.min(opts.timeoutMs, 10_000) }).catch(() => {});
    return await save(await context.storageState(), opts, page.url());
  } finally {
    await browser.close().catch(() => {});
  }
}

async function waitVisible(
  loc: ReturnType<Page['locator']>,
  what: string,
  flag: string | undefined,
  timeoutMs: number
): Promise<void> {
  try {
    await loc.waitFor({ state: 'visible', timeout: Math.min(timeoutMs, 15_000) });
  } catch {
    throw new Error(`No ${what} found on the page${flag ? ` for ${flag}` : ''}. Pass ${flag ?? `--${what.split(' ')[0]}-selector`} with a CSS selector that matches it.`);
  }
}

/** A visible alert or error message, if the login page shows one. */
async function pageMessage(page: Page): Promise<string | undefined> {
  const loc = page.locator('[role=alert], [aria-live=assertive], .error, [data-error]').filter({ hasText: /\S/ }).first();
  try {
    if ((await loc.count()) === 0) return undefined;
    const t = (await loc.innerText({ timeout: 1000 })).trim().replace(/\s+/g, ' ');
    return t ? t.slice(0, 160) : undefined;
  } catch {
    return undefined;
  }
}
