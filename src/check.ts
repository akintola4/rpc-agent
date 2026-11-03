// Ship-check: a pre-launch audit of one URL. Each device gets the same
// context `rpc shot` would use; the page loads, settles, idles, scrolls once,
// and in-page scripts (check-page.ts) collect what the checks need. The
// findings that come out identical on several devices are merged.
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
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
import { describeFailure, fileStem, newDeviceContext, settle } from './capture.js';
import {
  FONTS_JS,
  LABELS_JS,
  LAYOUT_SHIFT_INIT_JS,
  LAYOUT_SHIFTS_JS,
  META_JS,
  MOBILE_JS,
  SCROLL_ONCE_JS,
} from './check-page.js';
import { resolveDevices, type Device } from './devices.js';
import { plainText } from './errors.js';
import { detectMotion, motionCheckFindings, settleMotion } from './motion.js';
import type { CheckOptions, FailOn } from './options.js';
import { imageSize } from './png.js';

export type Severity = 'error' | 'warn' | 'info';
export type CheckId = 'basics' | 'meta' | 'layout-shift' | 'labels' | 'fonts' | 'mobile' | 'motion';

/** Report order and headings. */
export const CHECKS: { id: CheckId; title: string }[] = [
  { id: 'basics', title: 'Basics' },
  { id: 'meta', title: 'Meta and social' },
  { id: 'layout-shift', title: 'Layout shift' },
  { id: 'labels', title: 'Unlabelled controls' },
  { id: 'fonts', title: 'Fonts' },
  { id: 'mobile', title: 'Mobile viewport' },
  { id: 'motion', title: 'Motion' },
];

/** Bumped when a field changes meaning or goes away; new fields don't bump it. */
export const REPORT_SCHEMA = 1;

/** Google's CLS thresholds: good up to 0.1, poor above 0.25. */
export const CLS_GOOD = 0.1;
export const CLS_POOR = 0.25;
/** Totals below this are sub-pixel noise and count as zero. */
export const CLS_TOLERANCE = 0.001;
/** Fixed idle after load and settle, before the scroll. */
export const IDLE_MS = 500;
/** Motion: how long the settle probe waits for animations to stop before reporting what is still moving. */
export const MOTION_PROBE_MS = 1000;
export const MIN_TAP = 44;

export interface FindingItem {
  selector?: string;
  url?: string;
  /** A tag snippet, a size like `24×24`, a CSS declaration, a console line. */
  text?: string;
  /** The number behind the item: shift score, px of overflow, px of size. */
  value?: number;
  /** With --shots: a PNG of the element. */
  screenshot?: string;
}

export interface Finding {
  /** Stable kebab-case id, e.g. `og-image-missing`. */
  id: string;
  check: CheckId;
  severity: Severity;
  message: string;
  fix: string;
  /** Devices the finding came up on. */
  devices: string[];
  selector?: string;
  url?: string;
  value?: number;
  items?: FindingItem[];
}

export interface DeviceCheck {
  device: string;
  name: string;
  viewport: { width: number; height: number };
  dpr: number;
  status?: number | null;
  finalUrl?: string;
  title?: string;
  /** Largest session window of layout shifts, 0 below the tolerance. */
  cls?: number;
  /** Layout-shift entries seen (input-driven ones excluded). */
  layoutShifts?: number;
  /** Phone-only checks ran on this device. */
  mobile: boolean;
  error?: string;
  code?: string;
  hint?: string;
}

export interface OgImageInfo {
  url: string;
  status?: number;
  contentType?: string;
  width?: number;
  height?: number;
  error?: string;
}

export interface CheckReport {
  schema: number;
  url: string;
  devices: DeviceCheck[];
  summary: { errors: number; warnings: number; info: number };
  findings: Finding[];
  ogImage?: OgImageInfo;
  /** Present only when cookies, headers, a storage state or a saved session were involved. Values are masked. */
  auth?: AuthSummary;
}

export interface CheckHooks {
  browser?: Browser;
  onDeviceStart?: (device: Device) => void;
  onDevice?: (result: DeviceCheck) => void;
  auth?: ResolvedAuth;
  onAuth?: (summary: AuthSummary) => void;
}

type Draft = Omit<Finding, 'devices'>;

/** Per-run cache so page-level fetches (og:image, stylesheets) happen once. */
interface RunCache {
  probes: Map<string, Promise<Probe>>;
}

interface Probe {
  status?: number;
  contentType?: string;
  body?: Buffer;
  error?: string;
}

export async function runCheck(opts: CheckOptions, hooks: CheckHooks = {}): Promise<CheckReport> {
  const devices = resolveDevices(opts.devices);
  const auth = hooks.auth ?? resolveAuth(opts.url, opts.auth ?? {});
  if (auth.summary) hooks.onAuth?.(auth.summary);
  if (opts.shots) await mkdir(resolve(opts.outDir), { recursive: true });

  const browser = hooks.browser ?? (await launchBrowser());
  const cache: RunCache = { probes: new Map() };
  const results: DeviceCheck[] = [];
  const found: { device: string; finding: Draft }[] = [];
  let ogImage: OgImageInfo | undefined;
  try {
    for (const device of devices) {
      hooks.onDeviceStart?.(device);
      const result: DeviceCheck = {
        device: device.id,
        name: device.name,
        viewport: { width: device.width, height: device.height },
        dpr: device.dpr,
        mobile: isPhone(device),
      };
      try {
        const out = await checkDevice(browser, device, opts, auth, cache, result);
        for (const f of out.findings) found.push({ device: device.id, finding: f });
        ogImage ??= out.ogImage;
      } catch (err) {
        const failure = describeFailure(err, opts, auth);
        Object.assign(result, failure);
        found.push({
          device: device.id,
          finding: {
            id: failure.code === 'AUTH_REQUIRED' ? 'auth-required' : 'page-load-failed',
            check: 'basics',
            severity: 'error',
            message: failure.error,
            fix: failure.hint ?? 'Check that the URL loads in a browser, then run the check again.',
          },
        });
      }
      hooks.onDevice?.(result);
      results.push(result);
    }
  } finally {
    if (!hooks.browser) await browser.close();
  }

  const findings = mergeFindings(found).map(f => scrub(f, auth.secrets));
  return {
    schema: REPORT_SCHEMA,
    url: opts.url,
    devices: results,
    summary: summarize(findings),
    findings,
    ...(ogImage ? { ogImage } : {}),
    ...(auth.summary ? { auth: auth.summary } : {}),
  };
}

export function isPhone(device: Device): boolean {
  return device.category === 'apple-phone' || device.category === 'android-phone';
}

async function checkDevice(
  browser: Browser,
  device: Device,
  opts: CheckOptions,
  auth: ResolvedAuth,
  cache: RunCache,
  result: DeviceCheck
): Promise<{ findings: Draft[]; ogImage?: OgImageInfo }> {
  const context = await newDeviceContext(browser, device, opts, auth);
  const uncaught = new Set<string>();
  const consoleErrors = new Set<string>();
  const mixed = new Map<string, 'blocked' | 'upgraded' | 'loaded'>();
  const fonts = new Map<string, number>();
  try {
    const page = await context.newPage();
    await applyHeaders(context, page, auth);
    await page.addInitScript(LAYOUT_SHIFT_INIT_JS);
    page.on('pageerror', e => uncaught.add(plainText(e.message.split('\n')[0] ?? e.message)));
    page.on('console', m => {
      const text = m.text();
      if (/Mixed Content/i.test(text)) {
        const url = /requested an insecure [^']*'(http:[^']+)'/i.exec(text)?.[1];
        if (url) mixed.set(url, /upgraded/i.test(text) ? 'upgraded' : 'blocked');
        return;
      }
      if (m.type() === 'error') consoleErrors.add(plainText(text));
    });
    page.on('response', r => {
      if (r.request().resourceType() === 'font') fonts.set(r.url(), r.status());
    });
    page.on('request', r => {
      if (r.url().startsWith('http:') && page.url().startsWith('https:') && !mixed.has(r.url())) mixed.set(r.url(), 'loaded');
    });

    const response = await page.goto(opts.url, { waitUntil: 'load', timeout: opts.timeoutMs });
    result.status = response?.status() ?? null;
    await settle(page, opts.timeoutMs);
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
    // Deterministic CLS window: settled, a fixed idle, one scroll down and back.
    await page.waitForTimeout(IDLE_MS);
    await page.evaluate(SCROLL_ONCE_JS);
    if (opts.waitMs > 0) await page.waitForTimeout(opts.waitMs);
    checkLogin();
    result.finalUrl = page.url();
    result.title = await page.title();

    const findings: Draft[] = [];
    findings.push(...basicsFindings({ status: result.status, uncaught: [...uncaught], consoleErrors: [...consoleErrors], mixed }));

    const meta = (await page.evaluate(META_JS)) as MetaData;
    const og = meta.og.image ? await probeOgImage(context, meta.og.image, meta.baseUrl, cache) : undefined;
    const faviconOk = meta.icons.length > 0 ? true : await probeFavicon(context, page.url(), cache);
    findings.push(...metaFindings(meta, { og, faviconOk }));

    const shifts = (await page.evaluate(LAYOUT_SHIFTS_JS)) as LayoutShift[];
    const score = layoutShiftScore(shifts);
    result.cls = score.cls;
    result.layoutShifts = shifts.filter(s => !s.hadRecentInput).length;
    const shift = layoutShiftFindings(score);
    if (opts.shots) await attachShots(page, shift, opts, device, 'layout-shift');
    findings.push(...shift);

    findings.push(...labelFindings((await page.evaluate(LABELS_JS)) as LabelData));

    const fontData = (await page.evaluate(FONTS_JS)) as FontData;
    for (const href of fontData.unreadable) fontData.faces.push(...(await fetchFaces(context, href, cache)));
    findings.push(...fontFindings(fontData, fonts));

    if (result.mobile) {
      const mobile = mobileFindings((await page.evaluate(MOBILE_JS)) as MobileData);
      if (opts.shots) await attachShots(page, mobile, opts, device, 'horizontal-overflow');
      findings.push(...mobile);
    }

    const still = await settleMotion(page, undefined, MOTION_PROBE_MS);
    for (const f of motionCheckFindings(await detectMotion(page, 'viewport'), still)) findings.push({ ...f, check: 'motion' });
    return { findings, ...(og ? { ogImage: og } : {}) };
  } finally {
    await context.close();
  }
}

/** PNGs of the elements behind one finding id, written next to `rpc shot` output. */
async function attachShots(page: Page, findings: Draft[], opts: CheckOptions, device: Device, id: string): Promise<void> {
  const target = findings.find(f => f.id === id || f.id.startsWith(`${id}-`));
  if (!target?.items) return;
  const base = fileStem(opts.url, device.id);
  let n = 0;
  for (const item of target.items) {
    if (!item.selector) continue;
    const path = resolve(opts.outDir, `${base}-check-${id}-${++n}.png`);
    try {
      await page.locator(item.selector).first().screenshot({ path, animations: 'disabled', timeout: 3000 });
      item.screenshot = path;
    } catch {
      // Gone, hidden or zero-sized by now: nothing to show.
    }
  }
}

// ------------------------------------------------------------------ fetches

function probe(context: BrowserContext, url: string, cache: RunCache): Promise<Probe> {
  const cached = cache.probes.get(url);
  if (cached) return cached;
  const p = context.request
    .get(url, { timeout: 10_000, failOnStatusCode: false, maxRedirects: 5 })
    .then(async (r): Promise<Probe> => ({
      status: r.status(),
      contentType: (r.headers()['content-type'] ?? '').split(';')[0]!.trim(),
      ...(r.ok() ? { body: await r.body() } : {}),
    }))
    .catch((err: Error): Probe => ({ error: (err.message.split('\n')[0] ?? err.message).replace(/^apiRequestContext\.get: /, '') }));
  cache.probes.set(url, p);
  return p;
}

async function probeOgImage(context: BrowserContext, raw: string, base: string, cache: RunCache): Promise<OgImageInfo> {
  let url: string;
  try {
    url = new URL(raw, base).href;
  } catch {
    return { url: raw, error: 'not a valid URL' };
  }
  if (!/^https?:/.test(url)) return { url };
  const r = await probe(context, url, cache);
  const info: OgImageInfo = { url };
  if (r.error) info.error = r.error;
  if (r.status !== undefined) info.status = r.status;
  if (r.contentType) info.contentType = r.contentType;
  const size = r.body ? imageSize(r.body) : undefined;
  if (size) Object.assign(info, size);
  return info;
}

async function probeFavicon(context: BrowserContext, pageUrl: string, cache: RunCache): Promise<boolean> {
  const u = new URL(pageUrl);
  if (!/^https?:$/.test(u.protocol)) return false;
  const r = await probe(context, `${u.origin}/favicon.ico`, cache);
  return r.status !== undefined && r.status < 400 && /^image\//.test(r.contentType ?? '');
}

/** @font-face rules from a stylesheet the page can't read (cross-origin), parsed from its text. */
async function fetchFaces(context: BrowserContext, href: string, cache: RunCache): Promise<FontFaceRule[]> {
  const r = await probe(context, href, cache);
  return r.body ? parseFontFaces(r.body.toString('utf8'), href) : [];
}

export function parseFontFaces(css: string, base: string): FontFaceRule[] {
  const out: FontFaceRule[] = [];
  for (const m of css.matchAll(/@font-face\s*{([^}]*)}/gi)) {
    const body = m[1]!;
    const prop = (name: string) => new RegExp(`(?:^|;)\\s*${name}\\s*:\\s*([^;]+)`, 'i').exec(body)?.[1]?.trim() ?? '';
    const urls: string[] = [];
    for (const u of prop('src').matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/g)) {
      try {
        urls.push(new URL(u[2]!, base).href);
      } catch {
        // Unparseable url(): skip it.
      }
    }
    out.push({ family: prop('font-family').replace(/^["']|["']$/g, ''), display: prop('font-display'), urls, sheet: base });
  }
  return out;
}

// ------------------------------------------------------------------ basics

export function basicsFindings(d: {
  status?: number | null | undefined;
  uncaught: string[];
  consoleErrors: string[];
  mixed: Map<string, 'blocked' | 'upgraded' | 'loaded'>;
}): Draft[] {
  const out: Draft[] = [];
  if (d.status != null && d.status >= 400) {
    out.push({
      id: 'http-status',
      check: 'basics',
      severity: 'error',
      message: `The page answered HTTP ${d.status}`,
      fix: 'Serve the page with a 200. If it should be a 404 page, check that you meant to audit it.',
      value: d.status,
    });
  }
  if (d.mixed.size) {
    const blocked = [...d.mixed].filter(([, how]) => how !== 'upgraded');
    out.push({
      id: 'mixed-content',
      check: 'basics',
      severity: blocked.length ? 'error' : 'warn',
      message: `${plural(d.mixed.size, 'http:// resource')} on an https page${blocked.length ? '' : ' (the browser upgraded them)'}`,
      fix: 'Load every resource over https://, or use protocol-relative or relative URLs.',
      items: [...d.mixed].slice(0, 10).map(([url, how]) => ({ url, text: how })),
    });
  }
  if (d.uncaught.length) {
    out.push({
      id: 'uncaught-exception',
      check: 'basics',
      severity: 'error',
      message: `${plural(d.uncaught.length, 'uncaught exception')} during load`,
      fix: 'Open the page with the browser console open and fix the first exception; later ones often follow from it.',
      items: d.uncaught.slice(0, 3).map(text => ({ text })),
    });
  }
  if (d.consoleErrors.length) {
    out.push({
      id: 'console-errors',
      check: 'basics',
      severity: 'warn',
      message: `${plural(d.consoleErrors.length, 'console error')} during load`,
      fix: 'Fix or silence the errors logged while the page loads (failed requests, hydration warnings, missing env vars).',
      items: d.consoleErrors.slice(0, 3).map(text => ({ text })),
    });
  }
  return out;
}

// ------------------------------------------------------------------ meta and social

export interface MetaData {
  title: string | null;
  lang: string | null;
  description: string | null;
  canonical: string | null;
  viewport: string | null;
  icons: string[];
  appleTouchIcon: boolean;
  og: { title: string | null; description: string | null; image: string | null; url: string | null };
  twitterCard: string | null;
  themeColor: string | null;
  baseUrl: string;
}

const OG_W = 1200;
const OG_H = 630;

export function metaFindings(m: MetaData, probes: { og?: OgImageInfo | undefined; faviconOk: boolean }): Draft[] {
  const out: Draft[] = [];
  const add = (id: string, severity: Severity, message: string, fix: string, extra: Partial<Draft> = {}) =>
    out.push({ id, check: 'meta', severity, message, fix, ...extra });
  const title = (m.title ?? '').trim();
  if (!title) add('title-missing', 'error', 'No <title>', 'Add a <title> that names the page and the site, about 50 to 60 characters.');
  else if (title.length > 60) {
    add('title-long', 'warn', `<title> is ${title.length} characters; search results cut it at about 60`, 'Shorten the title to 60 characters or fewer, key words first.', {
      value: title.length,
    });
  }
  const desc = (m.description ?? '').trim();
  if (!desc) add('description-missing', 'warn', 'No meta description', 'Add <meta name="description" content="…"> with one or two sentences, up to about 160 characters.');
  else if (desc.length > 160) {
    add('description-long', 'info', `Meta description is ${desc.length} characters; search results cut it at about 160`, 'Trim the description to 160 characters or fewer.', {
      value: desc.length,
    });
  }
  if (!m.canonical) add('canonical-missing', 'warn', 'No canonical link', 'Add <link rel="canonical" href="https://…"> with the absolute URL this page should be indexed under.');
  if (!(m.lang ?? '').trim()) {
    add('lang-missing', 'error', '<html> has no lang attribute', 'Set the page language, e.g. <html lang="en">, so screen readers pronounce it correctly.', {
      selector: 'html',
    });
  }
  if (!m.viewport) {
    add('viewport-missing', 'error', 'No viewport meta tag', 'Add <meta name="viewport" content="width=device-width, initial-scale=1">.');
  } else {
    const v = m.viewport.toLowerCase().replace(/\s+/g, '');
    const max = /maximum-scale=([\d.]+)/.exec(v)?.[1];
    if (/user-scalable=(no|0)(,|;|$)/.test(v) || (max !== undefined && Number(max) < 2)) {
      add('viewport-no-zoom', 'error', `The viewport blocks pinch zoom (${m.viewport.trim()})`, 'Remove user-scalable=no and maximum-scale from the viewport meta; people need to zoom.', {
        selector: 'meta[name="viewport"]',
      });
    }
  }
  if (!m.icons.length && !probes.faviconOk) {
    add('favicon-missing', 'warn', 'No favicon: no <link rel="icon"> and /favicon.ico does not load', 'Add <link rel="icon" href="/favicon.svg"> (or .ico/.png) to the <head>.');
  }
  if (!m.appleTouchIcon) {
    add('apple-touch-icon-missing', 'info', 'No apple-touch-icon', 'Add <link rel="apple-touch-icon" href="/apple-touch-icon.png"> (180×180 PNG) for iOS home screens.');
  }
  for (const [key, label] of [
    ['title', 'og:title'],
    ['description', 'og:description'],
    ['image', 'og:image'],
    ['url', 'og:url'],
  ] as const) {
    if (!(m.og[key] ?? '').trim()) {
      add(`og-${key}-missing`, 'warn', `No ${label}`, `Add <meta property="${label}" content="…">; link previews in Slack, iMessage and social apps use it.`);
    }
  }
  if (!(m.twitterCard ?? '').trim()) {
    add('twitter-card-missing', 'warn', 'No twitter:card', 'Add <meta name="twitter:card" content="summary_large_image"> so X shows a large image preview.');
  }
  const og = probes.og;
  if (m.og.image && og) {
    if (!/^https?:\/\//i.test(m.og.image.trim())) {
      add('og-image-relative', 'warn', `og:image is a relative URL (${m.og.image.trim()})`, 'Use an absolute https:// URL; most scrapers do not resolve relative ones.', { url: og.url });
    }
    if (og.error || (og.status !== undefined && og.status >= 400)) {
      add('og-image-broken', 'error', `og:image does not load (${og.error ?? `HTTP ${og.status}`})`, 'Point og:image at an image URL that returns 200 to an anonymous request.', { url: og.url });
    } else if (og.contentType && !og.contentType.startsWith('image/')) {
      add('og-image-not-image', 'error', `og:image is served as ${og.contentType}, not an image`, 'Point og:image at the image file itself (PNG or JPEG), not a page.', { url: og.url });
    } else if (og.width && og.height) {
      const size = `${og.width}×${og.height}`;
      if (og.width < OG_W / 2 || og.height < OG_H / 2) {
        add('og-image-small', 'warn', `og:image is ${size}; large previews need at least 600×315`, `Export the image at ${OG_W}×${OG_H}.`, { url: og.url, value: og.width });
      } else if (Math.abs(og.width / og.height - OG_W / OG_H) > 0.05) {
        add('og-image-ratio', 'info', `og:image is ${size}, not the 1.91:1 shape previews crop to (${OG_W}×${OG_H})`, `Export the image at ${OG_W}×${OG_H} so previews don't crop it.`, {
          url: og.url,
          value: og.width,
        });
      }
    }
  }
  if (!(m.themeColor ?? '').trim()) {
    out.push({
      id: 'theme-color-missing',
      check: 'basics',
      severity: 'info',
      message: 'No theme-color',
      fix: 'Add <meta name="theme-color" content="#…"> to tint the mobile browser bar to match the page.',
    });
  }
  return out;
}

// ------------------------------------------------------------------ layout shift

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LayoutShift {
  value: number;
  startTime: number;
  hadRecentInput: boolean;
  sources: { selector: string; previousRect: Rect | null; currentRect: Rect | null }[];
}

export interface ShiftScore {
  cls: number;
  /** Elements in the worst session window, biggest share first. */
  sources: { selector: string; score: number }[];
}

const round = (n: number, places = 4) => Math.round(n * 10 ** places) / 10 ** places;

/**
 * CLS as Chrome reports it: the largest session window (shifts less than 1 s
 * apart, at most 5 s long), input-driven shifts excluded. Each shift's score
 * is shared among its sources by the area they moved through.
 */
export function layoutShiftScore(shifts: LayoutShift[]): ShiftScore {
  const counted = shifts.filter(s => !s.hadRecentInput).sort((a, b) => a.startTime - b.startTime);
  let best = 0;
  let bestWindow: LayoutShift[] = [];
  let window: LayoutShift[] = [];
  let sum = 0;
  for (const s of counted) {
    const first = window[0];
    const last = window[window.length - 1];
    if (first && last && s.startTime - last.startTime < 1000 && s.startTime - first.startTime < 5000) {
      window.push(s);
      sum += s.value;
    } else {
      window = [s];
      sum = s.value;
    }
    if (sum > best) {
      best = sum;
      bestWindow = [...window];
    }
  }
  if (best < CLS_TOLERANCE) return { cls: 0, sources: [] };
  const area = (r: Rect | null) => (r ? r.width * r.height : 0);
  const by = new Map<string, number>();
  for (const s of bestWindow) {
    const srcs = s.sources.filter(x => x.selector);
    const total = srcs.reduce((n, x) => n + area(x.previousRect) + area(x.currentRect), 0);
    for (const x of srcs) {
      const share = total > 0 ? (area(x.previousRect) + area(x.currentRect)) / total : 1 / srcs.length;
      by.set(x.selector, (by.get(x.selector) ?? 0) + s.value * share);
    }
  }
  const sources = [...by]
    .map(([selector, score]) => ({ selector, score: round(score) }))
    .sort((a, b) => b.score - a.score);
  return { cls: round(best), sources };
}

export function layoutShiftFindings(score: ShiftScore): Draft[] {
  if (score.cls === 0) return [];
  const severity: Severity = score.cls > CLS_POOR ? 'error' : score.cls > CLS_GOOD ? 'warn' : 'info';
  const verdict = severity === 'error' ? 'poor' : severity === 'warn' ? 'needs improvement' : 'good, but not zero';
  const top = score.sources.slice(0, 3);
  return [
    {
      id: 'layout-shift',
      check: 'layout-shift',
      severity,
      message: `CLS ${score.cls.toFixed(3)} (${verdict}; good is ${CLS_GOOD} or less)`,
      fix: 'Reserve space for what loads late: width/height or aspect-ratio on images and embeds, min-height on async sections, and no content inserted above what is on screen.',
      value: score.cls,
      ...(top[0] ? { selector: top[0].selector } : {}),
      items: top.map(s => ({ selector: s.selector, text: `${s.score.toFixed(3)} of the shift`, value: s.score })),
    },
  ];
}

// ------------------------------------------------------------------ labels

export interface LabelData {
  controls: { selector: string; text: string; kind: 'button' | 'link' }[];
  images: { selector: string; text: string }[];
  fields: { selector: string; text: string; placeholder: boolean }[];
}

export function labelFindings(d: LabelData): Draft[] {
  const out: Draft[] = [];
  const group = (id: string, severity: Severity, message: string, fix: string, items: { selector: string; text: string }[]) => {
    if (!items.length) return;
    out.push({ id, check: 'labels', severity, message, fix, selector: items[0]!.selector, items: items.slice(0, 20).map(({ selector, text }) => ({ selector, text })) });
  };
  const buttons = d.controls.filter(c => c.kind === 'button');
  const links = d.controls.filter(c => c.kind === 'link');
  group('button-no-name', 'error', `${plural(buttons.length, 'button')} with no accessible name`, 'Give icon-only buttons an aria-label (or visually hidden text), e.g. <button aria-label="Open menu">.', buttons);
  group('link-no-name', 'error', `${plural(links.length, 'link')} with no accessible name`, 'Give icon-only links an aria-label, or alt text on the image inside them.', links);
  group('img-no-alt', 'error', `${plural(d.images.length, 'image')} without an alt attribute`, 'Add alt text that says what the image shows, or alt="" if it is decorative.', d.images);
  const bare = d.fields.filter(f => !f.placeholder);
  const placeholderOnly = d.fields.filter(f => f.placeholder);
  group('field-no-label', 'error', `${plural(bare.length, 'form field')} without a label`, 'Add a <label for="…">, wrap the field in a <label>, or set aria-label.', bare);
  group('field-placeholder-only', 'warn', `${plural(placeholderOnly.length, 'form field')} labelled only by a placeholder`, 'Add a visible <label>; the placeholder disappears as soon as someone types.', placeholderOnly);
  return out;
}

// ------------------------------------------------------------------ fonts

export interface FontFaceRule {
  family: string;
  display: string;
  urls: string[];
  /** The stylesheet it came from (or the page URL for inline styles). */
  sheet: string;
}

export interface FontData {
  faces: FontFaceRule[];
  unreadable: string[];
  /** Lower-cased families in the font stacks of text in the first viewport. */
  aboveFold: string[];
  /** Lower-cased families with at least one loaded face. */
  loaded: string[];
  preloads: { href: string; crossorigin: boolean }[];
}

/** `downloaded`: font URL -> HTTP status, from the page's responses. */
export function fontFindings(d: FontData, downloaded: Map<string, number>): Draft[] {
  const out: Draft[] = [];
  const above = new Set(d.aboveFold);
  const loaded = new Set(d.loaded);
  const fileName = (u: string) => decodeURIComponent(new URL(u).pathname.split('/').pop() || u);

  // Faces that actually served a file, or whose family has a loaded face.
  // local()-only faces (next/font's size-adjusted fallbacks) never block text.
  const used = d.faces.filter(f => f.urls.length > 0 && (f.urls.some(u => downloaded.has(u)) || loaded.has(f.family.toLowerCase())));
  const families = new Map<string, FontFaceRule[]>();
  for (const f of used) families.set(f.family, [...(families.get(f.family) ?? []), f]);

  for (const [family, faces] of families) {
    const blocking = faces.filter(f => !f.display || f.display === 'auto' || f.display === 'block');
    if (!blocking.length) continue;
    const missing = blocking.some(f => !f.display || f.display === 'auto');
    const isAbove = above.has(family.toLowerCase());
    const files = blocking.flatMap(f => f.urls.filter(u => downloaded.has(u)));
    out.push({
      id: missing ? 'font-display-missing' : 'font-display-block',
      check: 'fonts',
      severity: 'warn',
      message:
        `@font-face "${family}" ${missing ? 'has no font-display' : 'uses font-display: block'}` +
        (isAbove ? '; it sets text above the fold, which stays invisible until the font loads (FOIT)' : ''),
      fix: 'Add font-display: swap (or optional) to the @font-face rule. With Google Fonts, add &display=swap to the URL; next/font sets it for you.',
      url: blocking[0]!.sheet,
      items: [...new Set(files.length ? files : blocking.flatMap(f => f.urls))].slice(0, 5).map(url => ({ url })),
    });
  }

  const preloads = new Map(d.preloads.map(p => [p.href, p]));
  for (const [url, status] of downloaded) {
    if (status >= 400) {
      out.push({
        id: 'font-failed',
        check: 'fonts',
        severity: 'error',
        message: `Font file failed to load (HTTP ${status}): ${fileName(url)}`,
        fix: 'Fix the font URL in the @font-face src, or deploy the file.',
        url,
      });
      continue;
    }
    const face = d.faces.find(f => f.urls.includes(url));
    if (!face || !above.has(face.family.toLowerCase())) continue;
    const pre = preloads.get(url);
    if (!pre) {
      out.push({
        id: 'font-not-preloaded',
        check: 'fonts',
        severity: 'warn',
        message: `"${face.family}" sets text above the fold but ${fileName(url)} is not preloaded`,
        fix: `Add <link rel="preload" href="${url}" as="font" type="font/woff2" crossorigin> to the <head>.`,
        url,
      });
    }
  }
  for (const p of d.preloads) {
    if (!p.crossorigin) {
      out.push({
        id: 'font-preload-no-crossorigin',
        check: 'fonts',
        severity: 'warn',
        message: `Font preload without crossorigin: ${fileName(p.href)} is downloaded twice`,
        fix: 'Add the crossorigin attribute to the <link rel="preload" as="font">; fonts are always fetched in CORS mode.',
        url: p.href,
      });
    }
    if (!d.faces.some(f => f.urls.includes(p.href))) {
      out.push({
        id: 'font-preload-unused',
        check: 'fonts',
        severity: 'info',
        message: `Preloaded font ${fileName(p.href)} is not used by any @font-face rule`,
        fix: 'Remove the preload, or make its href match the URL in the @font-face src exactly.',
        url: p.href,
      });
    }
  }
  return out;
}

// ------------------------------------------------------------------ mobile

export interface MobileData {
  /** Layout viewport width (documentElement.clientWidth). */
  viewportWidth: number;
  scrollWidth: number;
  vh: { selector: string; text: string; value: number }[];
  overflow: { selector: string; text: string; value: number }[];
  tapTargets: number;
  smallTargets: { selector: string; text: string; value: number }[];
  zoom: { selector: string; text: string; value: number }[];
}

export function mobileFindings(d: MobileData): Draft[] {
  const out: Draft[] = [];
  if (d.scrollWidth > d.viewportWidth + 1) {
    out.push({
      id: 'horizontal-overflow',
      check: 'mobile',
      severity: 'error',
      message: `The page scrolls sideways: ${d.scrollWidth}px wide in a ${d.viewportWidth}px viewport`,
      fix: 'Find the element that sticks out (fixed widths, 100vw with a scrollbar, wide tables or code blocks, negative margins) and constrain it with max-width: 100% or overflow-x: auto on its wrapper.',
      value: d.scrollWidth - d.viewportWidth,
      ...(d.overflow[0] ? { selector: d.overflow[0].selector } : {}),
      items: d.overflow.map(({ selector, text, value }) => ({ selector, text, value })),
    });
  }
  if (d.vh.length) {
    out.push({
      id: 'vh-units',
      check: 'mobile',
      severity: 'warn',
      message: `${plural(d.vh.length, 'element')} sized with 100vh; on phones that is taller than the visible area when the browser bars show`,
      fix: 'Use 100dvh (follows the browser bars) or 100svh (the smallest viewport). Keep 100vh first as a fallback: height: 100vh; height: 100dvh.',
      selector: d.vh[0]!.selector,
      items: d.vh.slice(0, 10).map(({ selector, text, value }) => ({ selector, text, value })),
    });
  }
  if (d.smallTargets.length) {
    out.push({
      id: 'tap-target-small',
      check: 'mobile',
      severity: 'warn',
      message: `${d.smallTargets.length} of ${d.tapTargets} tap targets are smaller than ${MIN_TAP}×${MIN_TAP}px`,
      fix: `Make each control at least ${MIN_TAP}×${MIN_TAP} CSS px: padding, min-height/min-width, or a larger hit area with a ::before inset. Inline links in a sentence are exempt (WCAG 2.5.8).`,
      selector: d.smallTargets[0]!.selector,
      items: d.smallTargets.slice(0, 15).map(({ selector, text, value }) => ({ selector, text, value })),
    });
  }
  if (d.zoom.length) {
    out.push({
      id: 'input-zoom',
      check: 'mobile',
      severity: 'warn',
      message: `${plural(d.zoom.length, 'text field')} under 16px; iOS Safari zooms the page when one gets focus`,
      fix: 'Set font-size: 16px (1rem) or more on inputs, selects and textareas, at least on small screens.',
      selector: d.zoom[0]!.selector,
      items: d.zoom.slice(0, 10).map(({ selector, text, value }) => ({ selector, text, value })),
    });
  }
  return out;
}

// ------------------------------------------------------------------ report

const SEVERITY_ORDER: Severity[] = ['error', 'warn', 'info'];

/** One finding per id/message/selector/url, listing every device it came up on, in report order. */
export function mergeFindings(found: { device: string; finding: Draft }[]): Finding[] {
  const merged = new Map<string, Finding>();
  for (const { device, finding } of found) {
    const key = [finding.id, finding.message, finding.selector ?? '', finding.url ?? ''].join('\n');
    const existing = merged.get(key);
    if (existing) {
      if (!existing.devices.includes(device)) existing.devices.push(device);
      continue;
    }
    const { id, check, severity, message, fix, ...rest } = finding;
    merged.set(key, { id, check, severity, message, fix, devices: [device], ...rest });
  }
  const checkIndex = (c: CheckId) => CHECKS.findIndex(x => x.id === c);
  return [...merged.values()]
    .map((f, i) => ({ f, i }))
    .sort(
      (a, b) =>
        checkIndex(a.f.check) - checkIndex(b.f.check) ||
        SEVERITY_ORDER.indexOf(a.f.severity) - SEVERITY_ORDER.indexOf(b.f.severity) ||
        a.i - b.i
    )
    .map(x => x.f);
}

export function summarize(findings: Finding[]): CheckReport['summary'] {
  const n = (s: Severity) => findings.filter(f => f.severity === s).length;
  return { errors: n('error'), warnings: n('warn'), info: n('info') };
}

/** 1 when there are errors, or warnings with `--fail-on warn`; else 0. */
export function checkExitCode(report: Pick<CheckReport, 'summary'>, failOn: FailOn): number {
  if (report.summary.errors > 0) return 1;
  if (failOn === 'warn' && report.summary.warnings > 0) return 1;
  return 0;
}

/** `2 errors, 5 warnings, 3 info` (zero counts included, so the line always has the same shape). */
export function summaryLine(s: CheckReport['summary']): string {
  return `${plural(s.errors, 'error')}, ${plural(s.warnings, 'warning')}, ${s.info} info`;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function scrub(f: Finding, secrets: readonly string[]): Finding {
  if (!secrets.length) return f;
  const r = (s: string) => redact(s, secrets);
  return {
    ...f,
    message: r(f.message),
    ...(f.url ? { url: r(f.url) } : {}),
    ...(f.items ? { items: f.items.map(i => ({ ...i, ...(i.text ? { text: r(i.text) } : {}), ...(i.url ? { url: r(i.url) } : {}) })) } : {}),
  };
}
