// Text for `rpc check` results: plain lines (pipes, CI, agents), the rich
// terminal boxes and the MCP summary. No clack here, so `rpc mcp` and the
// plain paths can use it.
import { relative } from 'node:path';
import type pc from 'picocolors';
import { CHECKS, type CheckId, type CheckReport, type DeviceCheck, type Finding, type Severity } from './check.js';

type Colors = ReturnType<typeof pc.createColors>;

export interface FormatOptions {
  /** ✗ ▲ ● (rich) instead of the words error / warn / info (plain). */
  icons: boolean;
  /** Wrap width for messages and fix hints. */
  width: number;
  /** Items listed per finding before "+N more". Default 5. */
  maxItems?: number;
}

export interface FindingGroup {
  check: CheckId;
  title: string;
  findings: Finding[];
}

/** Findings by check, in report order; checks with nothing to say are left out. */
export function groupFindings(report: CheckReport): FindingGroup[] {
  return CHECKS.map(c => ({ check: c.id, title: c.title, findings: report.findings.filter(f => f.check === c.id) })).filter(
    g => g.findings.length > 0
  );
}

/** `2 errors, 1 warning` with zero counts left out, or `no issues`. */
export function countsPhrase(findings: Finding[]): string {
  const n = (s: Severity) => findings.filter(f => f.severity === s).length;
  const parts = [
    n('error') ? `${n('error')} error${n('error') === 1 ? '' : 's'}` : '',
    n('warn') ? `${n('warn')} warning${n('warn') === 1 ? '' : 's'}` : '',
    n('info') ? `${n('info')} info` : '',
  ].filter(Boolean);
  return parts.length ? parts.join(', ') : 'no issues';
}

export function severityMark(s: Severity, c: Colors, icons: boolean): string {
  if (icons) return s === 'error' ? c.red('✗') : s === 'warn' ? c.yellow('▲') : c.cyan('●');
  return s === 'error' ? c.red('error') : s === 'warn' ? c.yellow('warn ') : c.cyan('info ');
}

/** One finding: mark and message, devices when not all of them, items, then the fix. */
export function findingLines(f: Finding, allDevices: string[], c: Colors, o: FormatOptions): string[] {
  const mark = severityMark(f.severity, c, o.icons);
  const indent = ' '.repeat(o.icons ? 2 : 6);
  const onSome = f.devices.length < allDevices.length ? c.dim(` (${f.devices.join(', ')})`) : '';
  const [first = '', ...rest] = wrap(f.message, o.width - indent.length);
  const out = [`${mark} ${first}${rest.length ? '' : onSome}`];
  rest.forEach((l, i) => out.push(`${indent}${l}${i === rest.length - 1 ? onSome : ''}`));
  const max = o.maxItems ?? 5;
  const items = f.items ?? [];
  if (!items.length && (f.selector || f.url)) out.push(`${indent}${c.cyan(f.selector ?? f.url!)}`);
  for (const item of items.slice(0, max)) {
    const full = item.selector ?? item.url ?? '';
    const extra = item.text && item.text !== full ? item.text : '';
    // Long selectors lose their start: the end names the element.
    const room = Math.max(20, o.width - indent.length - 2 - (extra ? extra.length + 2 : 0));
    const where = full.length > room ? `…${full.slice(full.length - room + 1)}` : full;
    const line = [where ? c.cyan(where) : '', extra ? c.dim(extra) : ''].filter(Boolean).join('  ');
    out.push(`${indent}${c.dim('·')} ${line}`);
    if (item.screenshot) out.push(`${indent}  ${c.dim('shot:')} ${rel(item.screenshot)}`);
  }
  if (items.length > max) out.push(`${indent}${c.dim(`+${items.length - max} more (see --json)`)}`);
  const [fix = '', ...more] = wrap(f.fix, o.width - indent.length - 5);
  out.push(`${indent}${c.dim(`fix: ${fix}`)}`);
  for (const l of more) out.push(`${indent}${c.dim(`     ${l}`)}`);
  return out;
}

/** Lines for one check's findings. */
export function groupLines(g: FindingGroup, allDevices: string[], c: Colors, o: FormatOptions): string[] {
  return g.findings.flatMap(f => findingLines(f, allDevices, c, o));
}

/** `iphone-15-pro (393x852 @3x) HTTP 200, CLS 0.000, title "…"` or the failure. */
export function deviceLine(d: DeviceCheck, c: Colors): string {
  const label = `${d.device} (${d.viewport.width}x${d.viewport.height} @${d.dpr}x)`;
  if (d.error) return `${c.red('x')} ${label}: ${d.error}`;
  const status = d.status == null ? 'no status' : d.status >= 400 ? c.red(`HTTP ${d.status}`) : `HTTP ${d.status}`;
  const cls = d.cls === undefined ? '' : `, CLS ${d.cls.toFixed(3)}`;
  return `${c.green('ok')} ${label} ${status}${cls}${d.mobile ? '' : c.dim(' (no phone checks)')}`;
}

/** Plain output for pipes and CI: device lines, findings by check, the summary line. */
export function plainReport(report: CheckReport, c: Colors, width = 100): string {
  const all = report.devices.map(d => d.device);
  const out: string[] = [];
  for (const g of groupFindings(report)) {
    out.push('', `${g.title}: ${countsPhrase(g.findings)}`);
    for (const l of groupLines(g, all, c, { icons: false, width })) out.push(`  ${l}`);
  }
  return out.join('\n');
}

/** Short text for agents (MCP): the counts, then one line per error and warning. */
export function textSummary(report: CheckReport): string {
  const s = report.summary;
  const lines = [
    `${report.url}: ${s.errors} error(s), ${s.warnings} warning(s), ${s.info} info on ${report.devices.map(d => d.device).join(', ')}.`,
  ];
  for (const d of report.devices) {
    if (d.error) lines.push(`FAILED ${d.device}: ${d.error}${d.hint ? `\n  hint: ${d.hint}` : ''}`);
  }
  const top = report.findings.filter(f => f.severity !== 'info');
  for (const f of top.slice(0, 25)) {
    const where = f.selector ?? f.url;
    lines.push(`${f.severity === 'error' ? 'ERROR' : 'WARN'} [${f.id}] ${f.message}${where ? ` at ${where}` : ''}`);
  }
  if (top.length > 25) lines.push(`… ${top.length - 25} more in the JSON report.`);
  if (!top.length) lines.push('No errors or warnings.');
  return lines.join('\n');
}

function rel(p: string): string {
  const r = relative(process.cwd(), p);
  return r.startsWith('..') ? p : r;
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
