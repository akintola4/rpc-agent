// Rich terminal UI: banner, clack rail, spinners, prompts and boxes.
// Only loaded when stdout is an interactive terminal (see term.ts). Never
// imported by `rpc mcp` or the --json paths.
import { readFileSync, statSync } from 'node:fs';
import { connect } from 'node:net';
import { relative } from 'node:path';
import * as p from '@clack/prompts';
import pc from 'picocolors';
import { BrowserMissingError, installHint, launchBrowser, type DoctorReport } from './browser.js';
import { capture, type DeviceShot, type ShotResult } from './capture.js';
import {
  CATEGORY_ORDER,
  DEVICE_ALIASES,
  DEVICES,
  type Device,
  type DeviceCategory,
} from './devices.js';
import { defaultShotOptions, normalizeUrl, type ShotOptions } from './options.js';
import { openCommand, openPath } from './term.js';

export type Colors = ReturnType<typeof pc.createColors>;

export function colors(enabled: boolean): Colors {
  return pc.createColors(enabled);
}

// ------------------------------------------------------------------ helpers

const ANSI = /\x1b\[[0-9;]*m/g;

export function visibleLength(s: string): number {
  return s.replace(ANSI, '').length;
}

function padAnsi(s: string, width: number): string {
  return s + ' '.repeat(Math.max(0, width - visibleLength(s)));
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function formatMs(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

export function formatList(items: string[], max = 5): string {
  if (items.length <= max) return items.join(', ');
  return `${items.slice(0, max).join(', ')} +${items.length - max} more`;
}

function rel(path: string): string {
  const r = relative(process.cwd(), path);
  if (r === '') return '.';
  return r.startsWith('..') ? path : r;
}

function size(path: string): string {
  try {
    return formatBytes(statSync(path).size);
  } catch {
    return '';
  }
}

function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/)) {
    if (line && line.length + 1 + word.length > width) {
      out.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) out.push(line);
  return out;
}

function textWidth(): number {
  return Math.max(40, Math.min(process.stdout.columns || 80, 110) - 12);
}

function version(): string {
  try {
    return (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;
  } catch {
    return '';
  }
}

function viewport(d: { width: number; height: number; dpr: number }): string {
  return `${d.width}×${d.height} @${d.dpr}x`;
}

function quote(arg: string): string {
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}

/** The `rpc shot …` command that reproduces these options. */
export function shotCommand(o: ShotOptions): string {
  const base = defaultShotOptions(o.url);
  const parts = ['rpc', 'shot', quote(o.url)];
  if (o.devices.join(',') !== base.devices.join(',')) parts.push('-d', o.devices.join(','));
  if (o.bezels) parts.push('--bezels');
  if (o.fullPage) parts.push('--full-page');
  if (o.colorScheme) parts.push('--color-scheme', o.colorScheme);
  if (o.reducedMotion) parts.push('--reduced-motion');
  if (o.outDir !== base.outDir) parts.push('-o', quote(o.outDir));
  return parts.join(' ');
}

// ------------------------------------------------------------------ banner

const LOGO = [
  '██████╗ ██████╗  ██████╗',
  '██╔══██╗██╔══██╗██╔════╝',
  '██████╔╝██████╔╝██║     ',
  '██╔══██╗██╔═══╝ ██║     ',
  '██║  ██║██║     ╚██████╗',
  '╚═╝  ╚═╝╚═╝      ╚═════╝',
];
// 256-colour greys, light to dark: readable on light and dark backgrounds.
const GRAYS = [250, 248, 245, 243, 240, 238];

export function banner(c: Colors): string {
  const lines = LOGO.map((l, i) => (c.isColorSupported ? `\x1b[38;5;${GRAYS[i]}m${l}\x1b[0m` : l));
  return ['', ...lines, '', c.dim('Screenshots of your UI at real device sizes, in real bezels'), ''].join('\n');
}

function printBanner(c: Colors): void {
  if ((process.stdout.columns || 80) < 30) return;
  process.stdout.write(banner(c) + '\n');
}

function intro(c: Colors): void {
  p.intro(`${c.bgCyan(c.black(' rpc '))} ${c.dim(`v${version()}`)}`);
}

// ------------------------------------------------------------------ devices

const GROUP_LABELS: Record<DeviceCategory, string> = {
  'apple-phone': 'Apple phones',
  'android-phone': 'Android phones',
  tablet: 'Tablets',
  laptop: 'Laptops & desktops',
};

function categoryColor(c: Colors, cat: DeviceCategory): (s: string) => string {
  switch (cat) {
    case 'apple-phone':
      return c.cyan;
    case 'android-phone':
      return c.green;
    case 'tablet':
      return c.magenta;
    case 'laptop':
      return c.yellow;
  }
}

function aliasesFor(id: string): string[] {
  return Object.entries(DEVICE_ALIASES)
    .filter(([, target]) => target === id)
    .map(([alias]) => alias);
}

/** `rpc devices` in a terminal: grouped, aligned, coloured by category. */
export function devicesTable(c: Colors): string {
  const idW = Math.max(...DEVICES.map(d => d.id.length));
  const sizeW = Math.max(...DEVICES.map(d => `${d.width}×${d.height}`.length));
  const nameW = Math.max(...DEVICES.map(d => d.name.length));
  const dprW = Math.max(...DEVICES.map(d => `@${d.dpr}x`.length));
  const out: string[] = [''];
  out.push(
    `  ${c.dim('device'.padEnd(idW))}  ${c.dim('css px'.padEnd(sizeW))}  ${c.dim('dpr'.padEnd(dprW))}  ${c.dim('name'.padEnd(nameW))}  ${c.dim('aliases')}`
  );
  for (const cat of CATEGORY_ORDER) {
    const list = DEVICES.filter(d => d.category === cat);
    const tint = categoryColor(c, cat);
    out.push('', `${c.bold(tint(GROUP_LABELS[cat]))} ${c.dim(String(list.length))}`);
    for (const d of list) {
      const aliases = aliasesFor(d.id);
      out.push(
        `  ${tint(d.id.padEnd(idW))}  ${`${d.width}×${d.height}`.padEnd(sizeW)}  ${c.dim(`@${d.dpr}x`.padEnd(dprW))}  ${d.name.padEnd(nameW)}  ${aliases.length ? c.yellow(aliases.join(', ')) : ''}`.trimEnd()
      );
    }
  }
  out.push(
    '',
    `${c.dim(`${DEVICES.length} devices. Use ids or aliases with`)} rpc shot <url> -d iphone-15,ipad,desktop`,
    ''
  );
  return out.join('\n');
}

export function printDevices(c: Colors): void {
  process.stdout.write(devicesTable(c));
}

// ------------------------------------------------------------------ shot

/** Lines for the "Capture Summary" box. */
export function summaryLines(o: ShotOptions, c: Colors): string[] {
  const yes = (b: boolean) => (b ? c.green('yes') : c.dim('no'));
  const rows: [string, string][] = [
    ['devices', formatList(o.devices.map(d => c.cyan(d)))],
    ['bezels', yes(o.bezels)],
    ['full page', o.fullPage ? `${c.green('yes')}${o.saveSlices ? c.dim(' + slices') : ''}` : c.dim('no')],
    ['colour scheme', o.colorScheme ?? c.dim('default')],
  ];
  if (o.reducedMotion) rows.push(['reduced motion', c.green('yes')]);
  if (o.waitFor) rows.push(['wait for', o.waitFor]);
  if (!o.emulate) rows.push(['emulation', c.yellow('viewport + DPR only')]);
  rows.push(['output', `${rel(o.outDir)}/`]);
  const w = Math.max(...rows.map(([k]) => k.length)) + 1;
  return [c.cyan(o.url), ...rows.map(([k, v]) => `  ${c.dim(`${k}:`.padEnd(w))} ${v}`)];
}

export interface Timed {
  shot: DeviceShot;
  ms: number;
}

function statusCell(s: DeviceShot, c: Colors): string {
  if (s.error) return c.red(s.code ?? 'error');
  if (s.status == null) return c.dim('--');
  if (s.status >= 400) return c.red(String(s.status));
  if (s.status >= 300) return c.yellow(String(s.status));
  return c.green(String(s.status));
}

/** The per-device results table (device, viewport, status, time, console). */
export function resultsTable(rows: Timed[], c: Colors): string[] {
  const cells = rows.map(({ shot, ms }) => {
    const n = shot.consoleErrors?.length ?? 0;
    return [
      c.cyan(shot.device),
      viewport({ ...shot.viewport, dpr: shot.dpr }),
      statusCell(shot, c),
      formatMs(ms),
      shot.error ? c.dim('--') : n === 0 ? c.green('0') : c.yellow(String(n)),
    ];
  });
  const head = ['device', 'viewport', 'status', 'time', 'console'];
  const widths = head.map((h, i) => Math.max(h.length, ...cells.map(r => visibleLength(r[i]!))));
  const line = (r: string[]) =>
    r.map((cell, i) => (i === r.length - 1 ? cell : padAnsi(cell, widths[i]! + 2))).join('');
  return [line(head.map(h => c.dim(h))), ...cells.map(line)];
}

/** Lines for the final "Captured N devices" box. */
export function capturedLines(result: ShotResult, c: Colors): string[] {
  const out: string[] = [];
  const width = textWidth();
  const paths = result.shots.flatMap(s => [s.shot?.path, s.framed?.path].filter((x): x is string => Boolean(x)));
  const pathW = Math.min(Math.max(0, ...paths.map(x => rel(x).length)), width - 24);
  const file = (path: string, w: number, h: number, extra = '') => {
    const meta = [`${w}×${h}`, size(path), extra].filter(Boolean).join(' · ');
    out.push(`${c.green('✓')} ${padAnsi(c.cyan(rel(path)), pathW)}  ${c.dim(meta)}`);
  };
  // Devices that failed the same way share one line and one hint.
  const failures = new Map<string, DeviceShot[]>();
  for (const s of result.shots) {
    if (!s.error) continue;
    const key = `${s.error}\n${s.hint ?? ''}`;
    failures.set(key, [...(failures.get(key) ?? []), s]);
  }
  for (const s of result.shots) {
    if (s.error) continue;
    if (s.shot) {
      const extra = [
        s.segments && s.segments > 1 ? `${s.segments} segments` : '',
        s.clipped ? c.yellow(`clipped at ${s.capturedHeight} of ${s.scrollHeight} css px`) : '',
      ]
        .filter(Boolean)
        .join(' · ');
      file(s.shot.path, s.shot.width, s.shot.height, extra);
    }
    if (s.framed) file(s.framed.path, s.framed.width, s.framed.height);
    if (s.slices?.saved && s.slices.items[0]?.path) {
      const first = rel(s.slices.items[0].path).replace(/-slice-\d+\.jpg$/, '-slice-NN.jpg');
      out.push(`${c.green('✓')} ${c.cyan(first)}  ${c.dim(`${s.slices.total} slices · ${s.slices.items[0].width}px wide`)}`);
    }
    if (s.consoleErrors?.length) {
      const msg = s.consoleErrors[0]!.length > width - 20 ? `${s.consoleErrors[0]!.slice(0, width - 21)}…` : s.consoleErrors[0]!;
      out.push(`    ${c.yellow('console:')} ${c.dim(msg)}`);
    }
  }
  for (const group of failures.values()) {
    const first = group[0]!;
    out.push(`${c.red('✗')} ${group.map(g => g.device).join(', ')}`);
    for (const l of wrap(first.error ?? '', width - 4)) out.push(`    ${c.red(l)}`);
    if (first.hint) {
      const [line, ...rest] = wrap(first.hint, width - 10);
      out.push(`    ${c.yellow('hint:')} ${c.dim(line ?? '')}`);
      for (const l of rest) out.push(`          ${c.dim(l)}`);
    }
  }
  return out;
}


interface RunOptions {
  open: boolean;
  /** Already showed the banner and intro (interactive flow). */
  continued?: boolean;
  /** Show the equivalent `rpc shot` command at the end. */
  showCommand?: boolean;
}

export async function runShot(options: ShotOptions, run: RunOptions, c: Colors): Promise<number> {
  if (!run.continued) {
    printBanner(c);
    intro(c);
    p.note(summaryLines(options, c).join('\n'), 'Capture Summary');
  }

  const s = p.spinner();
  s.start('Starting Chromium');
  let browser;
  try {
    browser = await launchBrowser();
  } catch (err) {
    if (err instanceof BrowserMissingError) {
      s.error(c.red("Playwright's Chromium is not installed"));
      p.note(wrap(installHint().replace(/^Fix: /, ''), textWidth()).join('\n'), c.yellow('Fix'));
      p.outro(`${c.red('Nothing captured.')}  ${c.dim('Run: rpc install')}`);
      return 1;
    }
    s.error(c.red(`Chromium did not start: ${(err as Error).message.split('\n')[0]}`));
    p.outro(c.red('Nothing captured.'));
    return 1;
  }
  s.stop(`Chromium ${c.dim(browser.version())}`);

  const timed: Timed[] = [];
  let current: ReturnType<typeof p.spinner> | undefined;
  let started = 0;
  let result: ShotResult;
  const picked = options.devices.map(id => DEVICES.find(d => d.id === id)).filter((d): d is Device => Boolean(d));
  const idW = Math.max(0, ...picked.map(d => d.id.length));
  const vpW = Math.max(0, ...picked.map(d => viewport(d).length));
  const label = (id: string, vp: string) => `${id.padEnd(idW)}  ${c.dim(vp.padEnd(vpW))}`;
  try {
    result = await capture(options, {
      browser,
      onDeviceStart: (d: Device) => {
        started = performance.now();
        current = p.spinner();
        current.start(label(d.id, viewport(d)));
      },
      onDevice: shot => {
        const ms = performance.now() - started;
        timed.push({ shot, ms });
        const line = `${label(shot.device, viewport({ ...shot.viewport, dpr: shot.dpr }))}  ${statusCell(shot, c)}  ${c.dim(formatMs(ms))}`;
        if (shot.error) current?.error(line);
        else current?.stop(line);
        current = undefined;
      },
    });
  } catch (err) {
    current?.error(c.red((err as Error).message));
    p.outro(c.red('Capture failed.'));
    return 1;
  } finally {
    await browser.close().catch(() => {});
  }

  const failed = result.shots.filter(x => x.error).length;
  const ok = result.shots.length - failed;
  p.note(resultsTable(timed, c).join('\n'), 'Results');
  const n = result.shots.length;
  const title =
    failed === 0
      ? c.green(`Captured ${n} device${n === 1 ? '' : 's'}`)
      : ok === 0
        ? c.red(`Failed on ${n} device${n === 1 ? '' : 's'}`)
        : c.yellow(`Captured ${ok} of ${n} devices`);
  p.note(capturedLines(result, c).join('\n'), title);

  if (run.showCommand) p.log.message(`${c.dim('Re-run with:')} ${shotCommand(options)}`);

  const dir = rel(result.outDir);
  let advice = `Open with: ${openCommand().cmd} ${dir}`;
  if (run.open && ok > 0) advice = openPath(result.outDir) ? `Opened ${dir}` : advice;

  if (ok === 0) p.outro(`${c.red('Nothing captured.')}  ${c.dim('See the hints above.')}`);
  else if (failed > 0) p.outro(`${c.yellow(`Done, ${failed} failed.`)}  ${c.dim(advice)}`);
  else p.outro(`${c.green('Done!')}  ${c.dim(advice)}`);
  return failed > 0 ? 1 : 0;
}

// ------------------------------------------------------------------ interactive

const PRESELECT = ['iphone-15-pro', 'ipad-air-11', 'desktop-1440'];
const DEV_PORTS = [3000, 5173, 4321, 8080];

function listening(port: number, timeoutMs = 300): Promise<boolean> {
  return new Promise(res => {
    const sock = connect({ host: 'localhost', port });
    const done = (ok: boolean) => {
      sock.destroy();
      res(ok);
    };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}

/** First local dev server that accepts a connection, if any. */
export async function detectDevServer(ports = DEV_PORTS): Promise<string | undefined> {
  const open = await Promise.all(ports.map(port => listening(port)));
  const i = open.indexOf(true);
  return i === -1 ? undefined : `http://localhost:${ports[i]}`;
}

function cancelled(): number {
  p.cancel('Cancelled. Nothing was captured.');
  return 130;
}

/** `rpc` with no arguments in a terminal. */
export async function runInteractive(c: Colors): Promise<number> {
  printBanner(c);
  intro(c);

  const detected = await detectDevServer();
  if (detected) p.log.info(`Found a dev server on ${c.cyan(detected)}`);

  const url = await p.text({
    message: 'Which URL should rpc capture?',
    placeholder: detected ? `${detected}  (enter to use)` : 'localhost:3000, example.com or ./page.html',
    ...(detected ? { defaultValue: detected } : {}),
    validate: v => {
      if ((!v || !v.trim()) && detected) return undefined;
      if (!v || !v.trim()) return 'Enter a URL, a local host:port or a path to an .html file';
      try {
        normalizeUrl(v);
        return undefined;
      } catch (err) {
        return (err as Error).message;
      }
    },
  });
  if (p.isCancel(url)) return cancelled();
  const options = defaultShotOptions(url.trim() || detected || '');
  if (options.url !== url.trim()) p.log.message(`${c.dim('URL:')} ${c.cyan(options.url)}`);

  p.log.info(`Found ${c.green(String(DEVICES.length))} devices in ${CATEGORY_ORDER.length} groups`);
  const groups: Record<string, { value: string; label: string; hint: string }[]> = {};
  for (const cat of CATEGORY_ORDER) {
    groups[GROUP_LABELS[cat]] = DEVICES.filter(d => d.category === cat).map(d => ({
      value: d.id,
      label: d.id,
      hint: viewport(d),
    }));
  }
  const devices = await p.groupMultiselect({
    message: 'Which devices?',
    options: groups,
    initialValues: PRESELECT,
    cursorAt: PRESELECT[0],
    required: true,
    maxItems: Math.max(8, (process.stdout.rows || 30) - 12),
  });
  if (p.isCancel(devices)) return cancelled();
  // Keep catalog order (phones first), whatever order they were ticked in.
  options.devices = DEVICES.map(d => d.id).filter(id => devices.includes(id));

  const extras = await p.multiselect({
    message: 'Options',
    options: [
      { value: 'bezels', label: 'Device bezels', hint: 'also write a framed copy' },
      { value: 'fullPage', label: 'Full page', hint: 'whole scroll height, stitched' },
      { value: 'dark', label: 'Dark mode', hint: 'prefers-color-scheme: dark' },
      { value: 'reducedMotion', label: 'Reduced motion', hint: 'prefers-reduced-motion: reduce' },
    ],
    initialValues: ['bezels'],
    required: false,
  });
  if (p.isCancel(extras)) return cancelled();
  options.bezels = extras.includes('bezels');
  options.fullPage = extras.includes('fullPage');
  if (extras.includes('dark')) options.colorScheme = 'dark';
  options.reducedMotion = extras.includes('reducedMotion');

  p.note(summaryLines(options, c).join('\n'), 'Capture Summary');
  const go = await p.confirm({ message: 'Proceed with capture?' });
  if (p.isCancel(go)) return cancelled();
  if (!go) {
    p.outro(c.dim('Nothing captured.'));
    return 0;
  }
  return runShot(options, { open: false, continued: true, showCommand: true }, c);
}

// ------------------------------------------------------------------ doctor

export async function runDoctor(check: () => Promise<DoctorReport>, c: Colors): Promise<number> {
  intro(c);
  const s = p.spinner();
  s.start('Launching Chromium');
  const r = await check();
  s.stop(`Node ${c.dim(r.node)}`);
  p.log.step(`Playwright ${c.dim(r.playwright)}`);
  p.log.step(`Browsers ${c.dim(r.browsersPath)}`);
  if (r.ok) {
    p.log.success(`Chromium ${c.green('launches')} ${c.dim(r.version ?? '')}`);
    p.outro(`${c.green('Ready.')}  ${c.dim('Try: rpc shot localhost:3000 --bezels')}`);
    return 0;
  }
  p.log.error(`Chromium ${c.red(r.chromium === 'missing' ? 'is not installed' : 'did not launch')}`);
  const body = r.chromium === 'missing' ? installHint().replace(/^Fix: /, '') : r.error ?? '';
  p.note(wrap(body, textWidth()).join('\n'), c.yellow(r.chromium === 'missing' ? 'Fix' : 'Error'));
  p.outro(`${c.red('Not ready.')}  ${c.dim(r.chromium === 'missing' ? 'Run: rpc install' : 'See the error above.')}`);
  return 1;
}
