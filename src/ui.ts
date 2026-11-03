// Rich terminal UI: banner, clack rail, spinners, prompts and boxes.
// Only loaded when stdout is an interactive terminal (see term.ts). Never
// imported by `rpc mcp` or the --json paths.
import { readFileSync, statSync } from 'node:fs';
import { connect } from 'node:net';
import { relative } from 'node:path';
import * as p from '@clack/prompts';
import pc from 'picocolors';
import type { LoginCommand } from './args.js';
import {
  clearSessions,
  listSessions,
  localTime,
  MASK,
  resolveAuth,
  sessionsDir,
  type AuthSummary,
  type ResolvedAuth,
} from './auth.js';
import { BrowserMissingError, installHint, launchBrowser, type DoctorReport } from './browser.js';
import { capture, type DeviceShot, type ShotResult } from './capture.js';
import { checkExitCode, runCheck as audit, summaryLine, type CheckReport, type DeviceCheck } from './check.js';
import { countsPhrase, groupFindings, groupLines } from './check-format.js';
import {
  CATEGORY_ORDER,
  DEVICE_ALIASES,
  DEVICES,
  type Device,
  type DeviceCategory,
} from './devices.js';
import { unpinnedLines, warningWhere } from './motion.js';
import { record, type RecordResult } from './record.js';
import { defaultShotOptions, normalizeUrl, type CheckOptions, type RecordOptions, type ShotOptions } from './options.js';
import { openCommand, openPath, waitForEnter } from './term.js';

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
  if (o.finishAnimations) parts.push('--finish-animations');
  if (o.fullPage && !o.unpin) parts.push('--no-unpin');
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
export function summaryLines(o: ShotOptions, c: Colors, auth?: AuthSummary): string[] {
  const yes = (b: boolean) => (b ? c.green('yes') : c.dim('no'));
  const rows: [string, string][] = [
    ['devices', formatList(o.devices.map(d => c.cyan(d)))],
    ['bezels', yes(o.bezels)],
    ['full page', o.fullPage ? `${c.green('yes')}${o.saveSlices ? c.dim(' + slices') : ''}` : c.dim('no')],
    ['colour scheme', o.colorScheme ?? c.dim('default')],
  ];
  if (o.reducedMotion) rows.push(['reduced motion', c.green('yes')]);
  if (o.finishAnimations) rows.push(['finish animations', c.green('yes')]);
  if (o.fullPage && !o.unpin) rows.push(['unpin', c.yellow('no')]);
  if (o.waitFor) rows.push(['wait for', o.waitFor]);
  if (!o.emulate) rows.push(['emulation', c.yellow('viewport + DPR only')]);
  if (auth) rows.push(...authRows(auth, c));
  rows.push(['output', `${rel(o.outDir)}/`]);
  const w = Math.max(...rows.map(([k]) => k.length)) + 1;
  return [c.cyan(o.url), ...rows.map(([k, v]) => `  ${c.dim(`${k}:`.padEnd(w))} ${v}`)];
}

/** Auth rows for the summary box: names only, values masked. */
export function authRows(a: AuthSummary, c: Colors): [string, string][] {
  const rows: [string, string][] = [];
  if (a.session) {
    const saved = a.session.savedAt ? c.dim(` saved ${localTime(a.session.savedAt)}`) : '';
    if (a.session.loaded) rows.push(['session', `${c.green(a.session.origin)}${saved}`]);
    else if (a.session.expired) rows.push(['session', c.yellow(`${a.session.origin} expired, not loaded`)]);
    else rows.push(['session', c.dim(`${a.session.origin} skipped (--no-session)`)]);
  }
  if (a.storageState) rows.push(['storage state', rel(a.storageState)]);
  if (a.cookies?.length) rows.push(['cookies', formatList(a.cookies.map(x => `${x.name}=${c.dim(MASK)}`))]);
  if (a.headers) rows.push(['headers', formatList(Object.keys(a.headers).map(h => `${h}: ${c.dim(MASK)}`))]);
  if (a.allowOrigins?.length) rows.push(['also allowed', formatList(a.allowOrigins)]);
  return rows;
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
  const pathW = Math.min(Math.max(0, ...paths.map(x => rel(x).length)), width - 18);
  // Pad dimensions to one width so the " · size" separators line up in a column.
  const dims = result.shots.flatMap(s => [s.shot, s.framed].filter(Boolean).map(f => `${f!.width}×${f!.height}`));
  const dimsW = Math.max(0, ...dims.map(d => d.length));
  const file = (path: string, w: number, h: number, extra = '') => {
    const meta = [`${w}×${h}`.padEnd(dimsW), size(path), extra].filter(Boolean).join(' · ');
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
    for (const u of unpinnedLines(s.motion?.unpinned)) out.push(`    ${c.cyan('unpinned')} ${c.dim(u)}`);
    for (const w of s.warnings ?? []) {
      const where = warningWhere(w);
      out.push(`    ${c.yellow('▲')} ${w.message}${where ? `  ${c.dim(where)}` : ''}`);
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
  const auth: ResolvedAuth = resolveAuth(options.url, options.auth ?? {});
  if (!run.continued) {
    printBanner(c);
    intro(c);
    p.note(summaryLines(options, c, auth.summary).join('\n'), 'Capture Summary');
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
      auth,
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

// ------------------------------------------------------------------ record

/** Lines for the final "Recorded" box. */
export function recordedLines(r: RecordResult, c: Colors): string[] {
  const out: string[] = [];
  const file = (path: string, meta: string) => out.push(`${c.green('✓')} ${c.cyan(rel(path))}  ${c.dim(meta)}`);
  if (r.video) file(r.video.path, `${r.video.width}×${r.video.height} · ${r.video.duration}s · ${r.video.fps} fps · ${size(r.video.path)}`);
  if (r.poster) file(r.poster.path, `${r.poster.width}×${r.poster.height} · poster`);
  if (r.gif) file(r.gif.path, `${r.gif.width}×${r.gif.height} · ${r.gif.frames} frames · ${size(r.gif.path)}`);
  if (r.mp4) file(r.mp4.path, `${r.mp4.encoder} · ${size(r.mp4.path)}`);
  for (const w of r.warnings ?? []) for (const [i, l] of wrap(w, textWidth() - 4).entries()) out.push(`${i ? '  ' : c.yellow('▲ ')}${c.dim(l)}`);
  return out;
}

export async function runRecord(options: RecordOptions, run: { open: boolean }, c: Colors): Promise<number> {
  const auth: ResolvedAuth = resolveAuth(options.url, options.auth ?? {});
  printBanner(c);
  intro(c);
  const rows: [string, string][] = [
    ['device', c.cyan(options.device)],
    ['element', options.selector ?? c.dim('whole viewport')],
    ['duration', `${options.duration}s`],
    ['also', [options.gif ? 'gif' : '', options.mp4 ? 'mp4' : ''].filter(Boolean).join(', ') || c.dim('webm only')],
  ];
  if (options.reducedMotion) rows.push(['reduced motion', c.green('yes')]);
  if (auth.summary) rows.push(...authRows(auth.summary, c));
  rows.push(['output', `${rel(options.outDir)}/`]);
  const w = Math.max(...rows.map(([k]) => k.length)) + 1;
  p.note([c.cyan(options.url), ...rows.map(([k, v]) => `  ${c.dim(`${k}:`.padEnd(w))} ${v}`)].join('\n'), 'Record Summary');

  const s = p.spinner();
  s.start('Starting Chromium');
  let browser;
  try {
    browser = await launchBrowser();
  } catch (err) {
    s.error(c.red(err instanceof BrowserMissingError ? "Playwright's Chromium is not installed" : `Chromium did not start: ${(err as Error).message.split('\n')[0]}`));
    if (err instanceof BrowserMissingError) p.note(wrap(installHint().replace(/^Fix: /, ''), textWidth()).join('\n'), c.yellow('Fix'));
    p.outro(c.red('Nothing recorded.'));
    return 1;
  }
  s.message(`Loading ${c.cyan(options.url)}`);
  let result: RecordResult;
  try {
    result = await record(options, { browser, auth, onRecording: secs => s.message(`Recording ${secs}s`) });
  } finally {
    await browser.close().catch(() => {});
  }
  if (result.error) {
    s.error(c.red(result.error));
    if (result.hint) p.note(wrap(result.hint, textWidth()).join('\n'), c.yellow('Hint'));
    p.outro(c.red('Nothing recorded.'));
    return 1;
  }
  s.stop(`Recorded ${result.video?.duration ?? options.duration}s on ${result.device}`);
  p.note(recordedLines(result, c).join('\n'), c.green('Recorded'));
  const dir = rel(result.outDir);
  let advice = `Open with: ${openCommand().cmd} ${dir}`;
  if (run.open) advice = openPath(result.outDir) ? `Opened ${dir}` : advice;
  p.outro(`${c.green('Done!')}  ${c.dim(advice)}`);
  return 0;
}

// ------------------------------------------------------------------ check

/** Lines for the "Check Summary" box. */
export function checkSummaryLines(o: CheckOptions, c: Colors, auth?: AuthSummary): string[] {
  const rows: [string, string][] = [
    ['devices', formatList(o.devices.map(d => c.cyan(d)))],
    ['fail on', o.failOn === 'warn' ? c.yellow('errors and warnings') : 'errors'],
  ];
  if (o.colorScheme) rows.push(['colour scheme', o.colorScheme]);
  if (o.waitFor) rows.push(['wait for', o.waitFor]);
  if (auth) rows.push(...authRows(auth, c));
  if (o.shots) rows.push(['shots', `${rel(o.outDir)}/`]);
  const w = Math.max(...rows.map(([k]) => k.length)) + 1;
  return [c.cyan(o.url), ...rows.map(([k, v]) => `  ${c.dim(`${k}:`.padEnd(w))} ${v}`)];
}

/** The spinner line once a device is done: status, CLS, time. */
function checkDeviceLine(d: DeviceCheck, ms: number, label: string, c: Colors): string {
  if (d.error) return `${label}  ${c.red(d.code ?? 'error')}  ${c.dim(formatMs(ms))}`;
  const status = d.status == null ? c.dim('--') : d.status >= 400 ? c.red(String(d.status)) : c.green(String(d.status));
  const cls = d.cls === undefined ? '' : d.cls > 0.25 ? c.red(d.cls.toFixed(3)) : d.cls > 0.1 ? c.yellow(d.cls.toFixed(3)) : c.green(d.cls.toFixed(3));
  return `${label}  ${status}  ${c.dim('CLS')} ${cls}  ${c.dim(formatMs(ms))}`;
}

/** One box per check that found something, titled with its counts. */
export function checkBoxes(report: CheckReport, c: Colors): { title: string; lines: string[] }[] {
  const all = report.devices.map(d => d.device);
  return groupFindings(report).map(g => {
    const counts = countsPhrase(g.findings);
    const tint = g.findings.some(f => f.severity === 'error') ? c.red : g.findings.some(f => f.severity === 'warn') ? c.yellow : c.cyan;
    return { title: `${g.title} ${c.dim('·')} ${tint(counts)}`, lines: groupLines(g, all, c, { icons: true, width: textWidth() }) };
  });
}

export async function runCheck(options: CheckOptions, c: Colors): Promise<number> {
  const auth: ResolvedAuth = resolveAuth(options.url, options.auth ?? {});
  intro(c);
  p.note(checkSummaryLines(options, c, auth.summary).join('\n'), 'Check Summary');

  const s = p.spinner();
  s.start('Starting Chromium');
  let browser;
  try {
    browser = await launchBrowser();
  } catch (err) {
    if (err instanceof BrowserMissingError) {
      s.error(c.red("Playwright's Chromium is not installed"));
      p.note(wrap(installHint().replace(/^Fix: /, ''), textWidth()).join('\n'), c.yellow('Fix'));
      p.outro(`${c.red('Nothing checked.')}  ${c.dim('Run: rpc install')}`);
      return 1;
    }
    s.error(c.red(`Chromium did not start: ${(err as Error).message.split('\n')[0]}`));
    p.outro(c.red('Nothing checked.'));
    return 1;
  }
  s.stop(`Chromium ${c.dim(browser.version())}`);

  let current: ReturnType<typeof p.spinner> | undefined;
  let started = 0;
  let report: CheckReport;
  const picked = options.devices.map(id => DEVICES.find(d => d.id === id)).filter((d): d is Device => Boolean(d));
  const idW = Math.max(0, ...picked.map(d => d.id.length));
  const vpW = Math.max(0, ...picked.map(d => viewport(d).length));
  const label = (id: string, vp: string) => `${id.padEnd(idW)}  ${c.dim(vp.padEnd(vpW))}`;
  try {
    report = await audit(options, {
      browser,
      auth,
      onDeviceStart: (d: Device) => {
        started = performance.now();
        current = p.spinner();
        current.start(label(d.id, viewport(d)));
      },
      onDevice: d => {
        const line = checkDeviceLine(d, performance.now() - started, label(d.device, viewport({ ...d.viewport, dpr: d.dpr })), c);
        if (d.error) current?.error(line);
        else current?.stop(line);
        current = undefined;
      },
    });
  } catch (err) {
    current?.error(c.red((err as Error).message));
    p.outro(c.red('Check failed.'));
    return 1;
  } finally {
    await browser.close().catch(() => {});
  }

  for (const box of checkBoxes(report, c)) p.note(box.lines.join('\n'), box.title);
  const code = checkExitCode(report, options.failOn);
  const line = summaryLine(report.summary);
  const sum = report.summary;
  if (sum.errors) p.outro(`${c.red(line)}  ${c.dim('Exit code 1.')}`);
  else if (sum.warnings) p.outro(`${c.yellow(line)}  ${c.dim(code ? 'Exit code 1 (--fail-on warn).' : 'No errors.')}`);
  else p.outro(`${c.green(line)}  ${c.dim('Ready to ship.')}`);
  return code;
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

// ------------------------------------------------------------------ login

export async function runLogin(cmd: LoginCommand, c: Colors): Promise<number> {
  intro(c);
  const { formLogin, interactiveLogin, HeadedBrowserMissingError } = await import('./login.js');
  const s = p.spinner();
  let spinning = false;
  try {
    let result;
    if (cmd.form) {
      s.start(`Signing in at ${c.cyan(cmd.url)} ${c.dim('(headless, form)')}`);
      spinning = true;
      result = await formLogin(cmd, cmd.form);
      spinning = false;
      s.stop(`Signed in ${c.dim(`now at ${result.finalUrl}`)}`);
    } else {
      s.start('Opening Chromium');
      spinning = true;
      const enter = waitForEnter();
      try {
        result = await interactiveLogin(cmd, enter.promise, () => {
          spinning = false;
          s.stop(`Opened ${c.cyan(cmd.url)}`);
          p.log.info(`Sign in in the browser window, then press ${c.bold('Enter')} here ${c.dim('(or close the window)')}`);
        });
      } finally {
        enter.stop();
      }
    }
    if (result.stillOnLogin) {
      p.log.warn(c.yellow(`The page was still on a login URL (${result.finalUrl}). The sign-in may not have finished.`));
    }
    p.note(
      [
        `${c.dim('origin:')}       ${c.cyan(result.origin)}`,
        `${c.dim('file:')}         ${rel(result.path)} ${c.dim('(mode 0600)')}`,
        `${c.dim('cookies:')}      ${result.cookies}`,
        `${c.dim('localStorage:')} ${result.localStorage} origin(s)`,
      ].join('\n'),
      'Saved session'
    );
    const next = cmd.save ? `rpc shot <url> --storage-state ${quote(rel(result.path))}` : `rpc shot ${result.origin}/…`;
    p.outro(`${c.green('Done!')}  ${c.dim(`Next: ${next}`)}`);
    return 0;
  } catch (err) {
    const msg = (err as Error).message;
    if (spinning) s.error(c.red(err instanceof HeadedBrowserMissingError || err instanceof BrowserMissingError ? 'No browser to open' : 'Sign-in failed'));
    if (err instanceof HeadedBrowserMissingError || err instanceof BrowserMissingError) {
      p.note(wrap(msg.replace(/^Fix: /, ''), textWidth()).join('\n'), c.yellow('Fix'));
    } else {
      p.log.error(wrap(msg, textWidth()).join('\n'));
    }
    p.outro(c.red('No session saved.'));
    return 1;
  }
}

export async function runSessions(action: 'list' | 'clear', origin: string | undefined, c: Colors): Promise<number> {
  intro(c);
  if (action === 'clear') {
    const gone = await clearSessions(origin);
    if (gone.length === 0) p.log.info(origin ? `No saved session for ${c.cyan(origin)}` : 'No saved sessions');
    for (const o of gone) p.log.success(`Removed ${c.cyan(o)}`);
    p.outro(c.dim(`${gone.length} removed`));
    return 0;
  }
  const list = await listSessions();
  if (list.length === 0) {
    p.log.info(`No saved sessions in ${c.dim(sessionsDir())}`);
    p.outro(c.dim('Create one with: rpc login <url>'));
    return 0;
  }
  const when = localTime;
  const originW = Math.max(...list.map(s => s.origin.length));
  const lines = list.map(s => {
    const exp = s.expired ? c.red(`expired ${when(s.expires)}`) : s.expires ? c.dim(`expires ${when(s.expires)}`) : c.dim('no expiry');
    return `${c.cyan(s.origin.padEnd(originW))}  ${String(s.cookies).padStart(2)} cookie${s.cookies === 1 ? ' ' : 's'}  ${c.dim(`saved ${when(s.savedAt)}`)}  ${exp}`;
  });
  p.note(lines.join('\n'), `${list.length} saved session${list.length === 1 ? '' : 's'}`);
  p.outro(c.dim(sessionsDir()));
  return 0;
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
  if (r.ffmpeg.source === 'missing') p.log.warn(`ffmpeg ${c.yellow('missing')} ${c.dim('(only rpc record needs it; rpc install fetches it)')}`);
  else p.log.step(`ffmpeg ${c.dim(`${r.ffmpeg.source} · ${r.ffmpeg.path}`)}`);
  p.log.step(`mp4 ${r.mp4.ok ? c.dim(r.mp4.encoder ?? '') : c.dim('no (optional: ffmpeg with H.264 on PATH)')}`);
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
