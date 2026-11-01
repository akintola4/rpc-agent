import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser } from 'playwright';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ArgError, parseCli } from '../src/args.js';
import { launchBrowser } from '../src/capture.js';
import {
  basicsFindings,
  checkExitCode,
  layoutShiftScore,
  mergeFindings,
  metaFindings,
  parseFontFaces,
  runCheck,
  summaryLine,
  type CheckReport,
  type Finding,
  type LayoutShift,
  type MetaData,
} from '../src/check.js';
import { countsPhrase, findingLines, plainReport, textSummary } from '../src/check-format.js';
import { createServer as createMcpServer } from '../src/mcp.js';
import { defaultCheckOptions, type CheckOptions } from '../src/options.js';
import { imageSize } from '../src/png.js';
import { checkBoxes, colors } from '../src/ui.js';
import { failFast } from './serve.js';

const ROOT = resolve(import.meta.dirname, '..');
const CLI = resolve(ROOT, 'src', 'cli.ts');
const FIXTURES = resolve(import.meta.dirname, 'fixtures', 'check');
const FONTS = resolve(ROOT, 'node_modules', '@fontsource', 'ibm-plex-mono', 'files');
const TMP = mkdtempSync(join(tmpdir(), 'rpc-check-'));
const PHONE = 'iphone-15-pro';
const DESKTOP = 'desktop-1440';

let server: Server;
let ORIGIN: string;
let browser: Browser;

const FONT_FILES: Record<string, string> = {
  '/fonts/plex-400.woff2': 'ibm-plex-mono-latin-400-normal.woff2',
  '/fonts/plex-400-italic.woff2': 'ibm-plex-mono-latin-400-italic.woff2',
};

beforeAll(async () => {
  const missing = Object.values(FONT_FILES).filter(f => !existsSync(join(FONTS, f)));
  if (missing.length) throw new Error(`run pnpm install: @fontsource/ibm-plex-mono is missing (${missing.join(', ')} not in ${FONTS})`);
  server = createServer(failFast(async (req, res) => {
    const path = new URL(req.url!, 'http://x').pathname;
    const font = FONT_FILES[path];
    if (font) {
      const body = await readFile(join(FONTS, font));
      res.writeHead(200, { 'content-type': 'font/woff2', 'access-control-allow-origin': '*' }).end(body);
      return;
    }
    if (path === '/og.png') {
      const body = await readFile(join(FIXTURES, 'og.png'));
      res.writeHead(200, { 'content-type': 'image/png' }).end(body);
      return;
    }
    if (path === '/gone') {
      const body = await readFile(join(FIXTURES, 'basics.html'));
      res.writeHead(404, { 'content-type': 'text/html' }).end(body);
      return;
    }
    const file = join(FIXTURES, path.slice(1));
    if (!file.startsWith(FIXTURES) || !file.endsWith('.html') || !existsSync(file)) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
      return;
    }
    const html = (await readFile(file, 'utf8')).replaceAll('{{ORIGIN}}', ORIGIN);
    res.writeHead(200, { 'content-type': 'text/html' }).end(html);
  }));
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  ORIGIN = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  browser = await launchBrowser();
});

afterAll(async () => {
  await browser?.close();
  // The font precheck throws before the server exists.
  if (server) await new Promise(r => server.close(r));
  rmSync(TMP, { recursive: true, force: true });
});

function opts(page: string, extra: Partial<CheckOptions> = {}): CheckOptions {
  return { ...defaultCheckOptions(`${ORIGIN}/${page}`), outDir: join(TMP, 'shots'), ...extra };
}

const reports = new Map<string, Promise<CheckReport>>();
/** One run per fixture, shared by the tests that read it. */
function check(page: string): Promise<CheckReport> {
  if (!reports.has(page)) reports.set(page, runCheck(opts(page), { browser }));
  return reports.get(page)!;
}

const ids = (r: CheckReport) => r.findings.map(f => f.id);
const byId = (r: CheckReport, id: string): Finding => {
  const f = r.findings.find(x => x.id === id);
  if (!f) throw new Error(`no ${id} finding; got ${ids(r).join(', ')}`);
  return f;
};
const selectors = (f: Finding) => (f.items ?? []).map(i => i.selector);

function rpc(args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const env = { ...process.env, RPC_SESSIONS_DIR: join(TMP, 'sessions') } as Record<string, string | undefined>;
  for (const k of ['FORCE_COLOR', 'NO_COLOR', 'CI']) delete env[k];
  return new Promise((res, rej) => {
    const child = spawn(process.execPath, ['--import', 'tsx', CLI, ...args], { cwd: ROOT, env: env as NodeJS.ProcessEnv });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => (stdout += d));
    child.stderr.on('data', d => (stderr += d));
    child.on('error', rej);
    child.on('close', status => res({ status, stdout, stderr }));
  });
}

describe('clean page', () => {
  it('has no errors or warnings on phone and desktop', async () => {
    const r = await check('clean.html');
    expect(r.devices.map(d => d.device)).toEqual([PHONE, DESKTOP]);
    expect(r.devices.every(d => d.status === 200 && !d.error)).toBe(true);
    expect(r.findings.filter(f => f.severity !== 'info'), JSON.stringify(r.findings, null, 2)).toEqual([]);
    expect(r.summary).toMatchObject({ errors: 0, warnings: 0 });
    expect(r.ogImage).toMatchObject({ url: `${ORIGIN}/og.png`, status: 200, contentType: 'image/png', width: 1200, height: 630 });
    expect(r.devices.map(d => d.cls)).toEqual([0, 0]);
    expect(checkExitCode(r, 'warn')).toBe(0);
  });
});

describe('meta and social', () => {
  it('reports every missing tag once, on both devices', async () => {
    const r = await check('meta.html');
    for (const id of [
      'lang-missing',
      'viewport-no-zoom',
      'title-long',
      'description-missing',
      'canonical-missing',
      'favicon-missing',
      'apple-touch-icon-missing',
      'og-title-missing',
      'og-description-missing',
      'og-url-missing',
      'twitter-card-missing',
      'og-image-relative',
      'og-image-broken',
      'theme-color-missing',
    ]) {
      expect(byId(r, id).devices).toEqual([PHONE, DESKTOP]);
    }
    expect(ids(r).filter(i => i === 'lang-missing')).toHaveLength(1);
    expect(byId(r, 'og-image-broken')).toMatchObject({ severity: 'error', url: `${ORIGIN}/missing-card.png`, message: expect.stringContaining('HTTP 404') });
    expect(byId(r, 'viewport-no-zoom').severity).toBe('error');
    expect(byId(r, 'theme-color-missing')).toMatchObject({ check: 'basics', severity: 'info' });
    expect(checkExitCode(r, 'error')).toBe(1);
  });

  it('flags a small or oddly shaped og:image and a non-image', () => {
    const base: MetaData = {
      title: 'A good title for a page',
      lang: 'en',
      description: 'd',
      canonical: '/',
      viewport: 'width=device-width, initial-scale=1',
      icons: ['/i.svg'],
      appleTouchIcon: true,
      og: { title: 't', description: 'd', image: 'https://x.test/og.png', url: 'https://x.test/' },
      twitterCard: 'summary_large_image',
      themeColor: '#000',
      baseUrl: 'https://x.test/',
    };
    const og = (extra: object) => ({ og: { url: 'https://x.test/og.png', status: 200, contentType: 'image/png', ...extra }, faviconOk: true });
    expect(metaFindings(base, og({ width: 1200, height: 630 }))).toEqual([]);
    expect(metaFindings(base, og({ width: 2400, height: 1260 }))).toEqual([]);
    expect(metaFindings(base, og({ width: 400, height: 210 })).map(f => f.id)).toEqual(['og-image-small']);
    expect(metaFindings(base, og({ width: 1200, height: 1200 })).map(f => f.id)).toEqual(['og-image-ratio']);
    expect(metaFindings(base, og({ contentType: 'text/html' })).map(f => f.id)).toEqual(['og-image-not-image']);
    expect(metaFindings({ ...base, viewport: 'width=device-width, maximum-scale=5' }, og({})).map(f => f.id)).toEqual([]);
    expect(metaFindings({ ...base, viewport: 'width=device-width,maximum-scale=1.0' }, og({})).map(f => f.id)).toEqual(['viewport-no-zoom']);
  });
});

describe('layout shift', () => {
  it('measures a known shift the same way every run', async () => {
    const runs = [await runCheck(opts('shift.html'), { browser }), await runCheck(opts('shift.html'), { browser })];
    for (const r of runs) {
      const [phone, desktop] = r.devices;
      // A 300px move of content that fills the viewport: impact 1 x distance 300 / the larger viewport side.
      expect(phone!.cls).toBeGreaterThan(300 / 852 - 0.02);
      expect(phone!.cls).toBeLessThan(300 / 852 + 0.02);
      expect(desktop!.cls).toBeGreaterThan(300 / 1440 - 0.02);
      expect(desktop!.cls).toBeLessThan(300 / 1440 + 0.02);
      const shifts = r.findings.filter(f => f.id === 'layout-shift');
      expect(shifts.map(f => [f.devices, f.severity])).toEqual([
        [[PHONE], 'error'],
        [[DESKTOP], 'warn'],
      ]);
      expect(shifts[0]!.selector).toBe('#content');
    }
    expect(Math.abs(runs[0]!.devices[0]!.cls! - runs[1]!.devices[0]!.cls!)).toBeLessThan(0.005);
  });

  it('uses the largest session window and ignores input-driven shifts', () => {
    const s = (startTime: number, value: number, hadRecentInput = false, selector = '#a'): LayoutShift => ({
      startTime,
      value,
      hadRecentInput,
      sources: [{ selector, previousRect: { x: 0, y: 0, width: 10, height: 10 }, currentRect: { x: 0, y: 5, width: 10, height: 10 } }],
    });
    // Window 1: 0.05 + 0.05 (500 ms apart). A 1.5 s gap starts window 2: 0.08.
    expect(layoutShiftScore([s(0, 0.05), s(500, 0.05), s(2000, 0.08)]).cls).toBeCloseTo(0.1, 4);
    // A window is capped at 5 s even when shifts keep coming.
    const steady = Array.from({ length: 12 }, (_, i) => s(i * 900, 0.01));
    expect(layoutShiftScore(steady).cls).toBeCloseTo(0.06, 4);
    expect(layoutShiftScore([s(0, 0.3, true)]).cls).toBe(0);
    expect(layoutShiftScore([s(0, 0.0004)])).toEqual({ cls: 0, sources: [] });
    expect(layoutShiftScore([s(0, 0.2, false, '#a'), s(10, 0.1, false, '#b')]).sources.map(x => x.selector)).toEqual(['#a', '#b']);
  });
});

describe('unlabelled controls', () => {
  it('flags icon-only controls, images without alt and unlabelled fields only', async () => {
    const r = await check('labels.html');
    expect(selectors(byId(r, 'button-no-name'))).toEqual(['button.icon-menu', 'div.fake-btn']);
    expect(selectors(byId(r, 'link-no-name'))).toEqual(['a.cart-link']);
    expect(selectors(byId(r, 'img-no-alt'))).toEqual(['img.no-alt']);
    expect(selectors(byId(r, 'field-no-label'))).toEqual(['input.bare']);
    expect(byId(r, 'field-placeholder-only')).toMatchObject({ severity: 'warn', selector: 'input.placeholder-only' });
    expect(byId(r, 'button-no-name')).toMatchObject({ severity: 'error', message: '2 buttons with no accessible name', devices: [PHONE, DESKTOP] });
    expect(byId(r, 'button-no-name').items![0]!.text).toContain('<button class="icon-menu">');
  });
});

describe('fonts', () => {
  it('names each font file and what it is missing', async () => {
    const r = await check('fonts.html');
    const display = byId(r, 'font-display-missing');
    expect(display.message).toBe('@font-face "Plex Hero" has no font-display; it sets text above the fold, which stays invisible until the font loads (FOIT)');
    expect(display.items).toEqual([{ url: `${ORIGIN}/fonts/plex-400.woff2` }]);
    expect(byId(r, 'font-not-preloaded')).toMatchObject({ severity: 'warn', url: `${ORIGIN}/fonts/plex-400.woff2` });
    expect(byId(r, 'font-preload-no-crossorigin')).toMatchObject({ url: `${ORIGIN}/fonts/plex-400-italic.woff2` });
    // swap and preloaded: nothing about Plex Italic beyond the missing crossorigin.
    expect(r.findings.filter(f => f.check === 'fonts').map(f => f.id).sort()).toEqual([
      'font-display-missing',
      'font-not-preloaded',
      'font-preload-no-crossorigin',
    ]);
  });

  it('parses @font-face rules from stylesheet text (cross-origin sheets)', () => {
    const css = `@font-face{font-family:'Inter';font-style:normal;font-weight:400;font-display:swap;src:url(https://fonts.gstatic.com/s/inter/v1/a.woff2) format('woff2');unicode-range:U+0000-00FF}
      @font-face { font-family: "Mono"; src: url("../f/m.woff2") format("woff2"), url(m.woff) }`;
    expect(parseFontFaces(css, 'https://cdn.test/css/site.css')).toEqual([
      { family: 'Inter', display: 'swap', urls: ['https://fonts.gstatic.com/s/inter/v1/a.woff2'], sheet: 'https://cdn.test/css/site.css' },
      { family: 'Mono', display: '', urls: ['https://cdn.test/f/m.woff2', 'https://cdn.test/css/m.woff'], sheet: 'https://cdn.test/css/site.css' },
    ]);
  });
});

describe('mobile viewport', () => {
  it('finds 100vh, sideways scroll, small tap targets and zooming inputs on the phone only', async () => {
    const r = await check('mobile.html');
    const vh = byId(r, 'vh-units');
    expect(selectors(vh)).toEqual(['section.hero']);
    expect(vh.items![0]!.text).toBe('min-height: 100vh (.hero)');
    const overflow = byId(r, 'horizontal-overflow');
    expect(overflow).toMatchObject({ severity: 'error', selector: 'div.wide', message: expect.stringMatching(/^The page scrolls sideways: 60\dpx wide in a 393px viewport$/) });
    expect(overflow.items![0]).toEqual({ selector: 'div.wide', text: '600px wide, 207px past the edge', value: 207 });
    expect(selectors(overflow)).not.toContain('div.clipped > div');
    const tap = byId(r, 'tap-target-small');
    expect(tap.items![0]).toMatchObject({ selector: 'button.tiny', text: '24×24', value: 24 });
    expect(byId(r, 'input-zoom').items).toEqual([{ selector: 'input.search', text: '14px', value: 14 }]);
    for (const f of r.findings.filter(x => x.check === 'mobile')) expect(f.devices).toEqual([PHONE]);
    expect(r.devices.map(d => d.mobile)).toEqual([true, false]);
  });

  it('skips inline links in a sentence and still counts small links and buttons', async () => {
    const r = await check('taps.html');
    const tap = byId(r, 'tap-target-small');
    expect(tap.message).toBe('6 of 7 tap targets are smaller than 44×44px');
    expect(tap.fix).toMatch(/Inline links in a sentence are exempt \(WCAG 2\.5\.8\)/);
    expect(selectors(tap).sort()).toEqual(['a.chip', 'a.nav.about', 'a.nav.home', 'a.solo', 'button.inline-btn', 'button.tiny']);
    expect(selectors(tap)).not.toContain('a.prose');
    expect(selectors(tap)).not.toContain('a.nested');
  });

  it('--shots saves the overflowing element and the shifted one', async () => {
    const r = await runCheck(opts('mobile.html', { devices: [PHONE], shots: true }), { browser });
    const shot = byId(r, 'horizontal-overflow').items![0]!.screenshot!;
    expect(shot).toMatch(/127-0-0-1-\d+-mobile-html-iphone-15-pro-check-horizontal-overflow-1\.png$/);
    expect(existsSync(shot)).toBe(true);
    const s = await runCheck(opts('shift.html', { devices: [PHONE], shots: true }), { browser });
    expect(existsSync(byId(s, 'layout-shift').items![0]!.screenshot!)).toBe(true);
  });
});

describe('basics', () => {
  it('reports console errors and uncaught exceptions', async () => {
    const r = await check('basics.html');
    expect(byId(r, 'uncaught-exception')).toMatchObject({ severity: 'error', items: [{ text: 'fixture: boom' }] });
    expect(byId(r, 'console-errors')).toMatchObject({ severity: 'warn', items: [{ text: 'fixture: failed to load config' }] });
  });

  it('reports an error status', async () => {
    const r = await runCheck(opts('gone', { devices: [DESKTOP] }), { browser });
    expect(r.devices[0]!.status).toBe(404);
    expect(byId(r, 'http-status')).toMatchObject({ severity: 'error', value: 404 });
  });

  it('reports mixed content, blocked or upgraded', () => {
    const blocked = basicsFindings({ uncaught: [], consoleErrors: [], mixed: new Map([['http://cdn.test/a.js', 'blocked']]) });
    expect(blocked[0]).toMatchObject({ id: 'mixed-content', severity: 'error', items: [{ url: 'http://cdn.test/a.js', text: 'blocked' }] });
    const upgraded = basicsFindings({ uncaught: [], consoleErrors: [], mixed: new Map([['http://cdn.test/a.png', 'upgraded']]) });
    expect(upgraded[0]!.severity).toBe('warn');
  });

  it('fails the device, not the run, when the page does not load', async () => {
    const closed = createServer();
    await new Promise<void>(r => closed.listen(0, '127.0.0.1', r));
    const port = (closed.address() as AddressInfo).port;
    await new Promise(r => closed.close(r));
    const r = await runCheck({ ...opts('clean.html', { devices: [DESKTOP] }), url: `http://127.0.0.1:${port}/` }, { browser });
    expect(r.devices[0]).toMatchObject({ code: 'ERR_CONNECTION_REFUSED' });
    expect(byId(r, 'page-load-failed').severity).toBe('error');
  });
});

describe('report', () => {
  it('merges identical findings across devices and keeps check order', () => {
    const f = (id: string, check: Finding['check'], severity: Finding['severity']) => ({ id, check, severity, message: id, fix: 'x' });
    const merged = mergeFindings([
      { device: 'a', finding: f('m', 'mobile', 'warn') },
      { device: 'a', finding: f('t', 'meta', 'info') },
      { device: 'b', finding: f('t', 'meta', 'info') },
      { device: 'a', finding: f('l', 'meta', 'error') },
    ]);
    expect(merged.map(x => [x.id, x.devices.join(',')])).toEqual([
      ['l', 'a'],
      ['t', 'a,b'],
      ['m', 'a'],
    ]);
  });

  it('exit code follows --fail-on', () => {
    expect(checkExitCode({ summary: { errors: 0, warnings: 2, info: 1 } }, 'error')).toBe(0);
    expect(checkExitCode({ summary: { errors: 0, warnings: 2, info: 1 } }, 'warn')).toBe(1);
    expect(checkExitCode({ summary: { errors: 1, warnings: 0, info: 0 } }, 'error')).toBe(1);
    expect(checkExitCode({ summary: { errors: 0, warnings: 0, info: 5 } }, 'warn')).toBe(0);
    expect(summaryLine({ errors: 2, warnings: 1, info: 0 })).toBe('2 errors, 1 warning, 0 info');
    expect(countsPhrase([])).toBe('no issues');
  });

  it('renders findings without escape codes when colour is off', async () => {
    const r = await check('labels.html');
    const c = colors(false);
    const text = plainReport(r, c);
    expect(text).not.toContain('\x1b[');
    expect(text).toContain('\nUnlabelled controls: 4 errors, 1 warning\n');
    expect(text).toContain('error 2 buttons with no accessible name');
    expect(text).toContain('fix: Give icon-only buttons an aria-label');
    const boxes = checkBoxes(r, c);
    expect(boxes.map(b => b.title)).toContain('Unlabelled controls · 4 errors, 1 warning');
    expect(boxes.flatMap(b => b.lines).join('\n')).toContain('✗ 2 buttons with no accessible name');
    // Devices are named only when a finding isn't on all of them.
    const one = findingLines({ ...byId(r, 'img-no-alt'), devices: [PHONE] }, [PHONE, DESKTOP], c, { icons: true, width: 80 });
    expect(one[0]).toBe(`✗ 1 image without an alt attribute (${PHONE})`);
    expect(textSummary(r)).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/labels\.html: 4 error\(s\), \d+ warning\(s\), \d+ info on iphone-15-pro, desktop-1440\.\n/);
  });
});

describe('images', () => {
  it('reads PNG, GIF, JPEG and WebP sizes from the header', () => {
    expect(imageSize(readFileSync(join(FIXTURES, 'og.png')))).toEqual({ width: 1200, height: 630 });
    const gif = Buffer.from('474946383961' + '2003' + '5802' + '0000', 'hex');
    expect(imageSize(gif)).toEqual({ width: 800, height: 600 });
    // SOI, APP0 (len 16), SOF0 with height 630 and width 1200.
    const jpeg = Buffer.concat([
      Buffer.from('ffd8ffe00010', 'hex'),
      Buffer.alloc(14),
      Buffer.from('ffc0001108' + '0276' + '04b0' + '03', 'hex'),
      Buffer.alloc(12),
    ]);
    expect(imageSize(jpeg)).toEqual({ width: 1200, height: 630 });
    const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8X'), Buffer.alloc(8), Buffer.from([0xaf, 0x04, 0x00, 0x75, 0x02, 0x00])]);
    expect(imageSize(webp)).toEqual({ width: 1200, height: 630 });
    expect(imageSize(Buffer.from('<svg/>'))).toBeUndefined();
  });
});

describe('cli', () => {
  it('parses check flags', () => {
    const cmd = parseCli(['check', 'localhost:3000', '-d', 'pixel,desktop', '--fail-on', 'warn', '--shots', '--json', '--header', 'X-Key: abcd']);
    expect(cmd).toMatchObject({
      command: 'check',
      json: true,
      options: { url: 'http://localhost:3000/', devices: ['pixel-8', 'desktop-1440'], failOn: 'warn', shots: true, auth: { headers: { 'X-Key': 'abcd' } } },
    });
    expect(parseCli(['check', 'x.test'])).toMatchObject({ options: { devices: [PHONE, DESKTOP], failOn: 'error', shots: false } });
    expect(() => parseCli(['check', 'x.test', '--fail-on', 'info'])).toThrow(ArgError);
    expect(() => parseCli(['check'])).toThrow(/Missing <url>/);
    expect(() => parseCli(['check', 'x.test', '--bezels'])).toThrow(ArgError);
    expect(parseCli(['check', '--help'])).toEqual({ command: 'help', topic: 'check' });
  });

  it('--json prints the report and exits 0 on a clean page', async () => {
    const r = await rpc(['check', `${ORIGIN}/clean.html`, '--json']);
    expect(r.status, r.stderr).toBe(0);
    const report = JSON.parse(r.stdout) as CheckReport;
    expect(report).toMatchObject({ schema: 1, url: `${ORIGIN}/clean.html`, summary: { errors: 0, warnings: 0 } });
    expect(Object.keys(report.devices[0]!)).toEqual(['device', 'name', 'viewport', 'dpr', 'mobile', 'status', 'finalUrl', 'title', 'cls', 'layoutShifts']);
  });

  it('plain output groups findings, ends with the summary and exits 1 on errors', async () => {
    const r = await rpc(['check', `${ORIGIN}/meta.html`, '-d', DESKTOP]);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/^ok desktop-1440 \(1440x900 @1x\) HTTP 200, CLS 0\.000 \(no phone checks\)$/m);
    expect(r.stdout).toContain('\nMeta and social: ');
    expect(r.stdout).toContain('  error <html> has no lang attribute');
    expect(r.stdout.trimEnd().split('\n').pop()).toMatch(/^\d+ errors?, \d+ warnings?, \d+ info$/);
    expect(r.stdout).not.toContain('\x1b[');
  });

  it('--fail-on warn fails a page with warnings only', async () => {
    const ok = await rpc(['check', `${ORIGIN}/fonts.html`, '-d', DESKTOP, '--json']);
    const report = JSON.parse(ok.stdout) as CheckReport;
    expect(report.summary.errors).toBe(0);
    expect(report.summary.warnings).toBeGreaterThan(0);
    expect(ok.status).toBe(0);
    expect((await rpc(['check', `${ORIGIN}/fonts.html`, '-d', DESKTOP, '--fail-on', 'warn'])).status).toBe(1);
  });
});

describe('mcp', () => {
  it('check returns a text summary and the JSON report', async () => {
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer();
    await server.connect(serverT);
    const client = new Client({ name: 'test', version: '0' });
    await client.connect(clientT);
    try {
      const { tools } = await client.listTools();
      expect(tools.map(t => t.name)).toContain('check');
      const res = await client.callTool({ name: 'check', arguments: { url: `${ORIGIN}/labels.html`, devices: ['desktop'] } });
      expect(res.isError).toBeFalsy();
      const [summary, json] = res.content as Array<{ type: string; text: string }>;
      expect(summary!.text).toMatch(/: 4 error\(s\), \d+ warning\(s\), \d+ info on desktop-1440\./);
      expect(summary!.text).toContain('ERROR [button-no-name] 2 buttons with no accessible name at button.icon-menu');
      const report = JSON.parse(json!.text) as CheckReport;
      expect(report.devices.map(d => d.device)).toEqual([DESKTOP]);
      expect(report.findings.some(f => f.id === 'img-no-alt')).toBe(true);
      const bad = await client.callTool({ name: 'check', arguments: { url: 'localhost:3000', devices: ['nope'] } });
      expect(bad.isError).toBe(true);
    } finally {
      await client.close();
    }
  });
});
