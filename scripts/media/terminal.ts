// Record the interactive CLI in a pseudo-terminal, then turn the recording
// into screen states the GIF page can draw. See docs/media.md.
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import xterm from '@xterm/headless';

const HERE = dirname(fileURLToPath(import.meta.url));

export interface Recording {
  cols: number;
  rows: number;
  /** [seconds since start, 'o' output | 'i' keystrokes, data] */
  events: [number, 'o' | 'i', string][];
  exitCode: number;
}

/** One scripted answer: wait for `when` on screen, pause, then type `keys`. */
export interface Step {
  when: RegExp;
  pause: number;
  keys: string[];
  /** Delay between keys, ms. */
  gap: number;
}

const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** Run `argv` in a cols x rows pty, answer each step in turn, record everything. */
export async function record(argv: string[], opts: { cols: number; rows: number; cwd: string; steps: Step[] }): Promise<Recording> {
  const child = spawn('python3', ['-I', join(HERE, 'pty_bridge.py'), String(opts.cols), String(opts.rows), ...argv], {
    cwd: opts.cwd,
    stdio: ['pipe', 'pipe', 'inherit'],
    env: { ...process.env, TERM: 'xterm-256color', COLORTERM: '', CI: '', NO_COLOR: '', FORCE_COLOR: '' },
  });
  const t0 = performance.now();
  const now = () => (performance.now() - t0) / 1000;
  const events: Recording['events'] = [];
  let seen = '';
  let wake: (() => void) | undefined;
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d: string) => {
    events.push([now(), 'o', d]);
    seen += d.replace(ANSI_RE, '');
    wake?.();
  });
  const exited = new Promise<number>(res => child.on('exit', code => res(code ?? 1)));
  let done = false;
  void exited.then(() => {
    done = true;
    wake?.();
  });

  for (const step of opts.steps) {
    while (!step.when.test(seen)) {
      if (done) throw new Error(`rpc exited before ${step.when}:\n${seen}`);
      await new Promise<void>(r => (wake = r));
    }
    seen = '';
    await sleep(step.pause);
    for (const [i, key] of step.keys.entries()) {
      if (i) await sleep(step.gap);
      events.push([now(), 'i', key]);
      child.stdin.write(key);
    }
  }
  const exitCode = await exited;
  child.stdin.end();
  return { cols: opts.cols, rows: opts.rows, events, exitCode };
}

// ------------------------------------------------------------------ cells to HTML

// Dark terminal palette (GitHub dark-ish), indices 0-15.
const ANSI16 = [
  '#1b1f26', '#ff7b72', '#5fd38d', '#e3b341', '#79c0ff', '#d2a8ff', '#4fd1d9', '#d7dde5',
  '#6e7681', '#ffa198', '#7ee2a8', '#f2cc60', '#a5d6ff', '#e2c5ff', '#7ee7ee', '#ffffff',
];
export const TERM_BG = '#0d1015';
export const TERM_FG = '#d7dde5';

function palette256(i: number): string {
  if (i < 16) return ANSI16[i]!;
  if (i >= 232) {
    const v = 8 + (i - 232) * 10;
    return `rgb(${v},${v},${v})`;
  }
  const n = i - 16;
  const steps = [0, 95, 135, 175, 215, 255];
  return `rgb(${steps[Math.floor(n / 36)]},${steps[Math.floor(n / 6) % 6]},${steps[n % 6]})`;
}

function hex(n: number): string {
  return `#${n.toString(16).padStart(6, '0')}`;
}

/** Characters drawn as cell-filling masks so lines join across rows. */
export const BOX_CHARS = '│─┌┐└┘├┤┬┴┼╭╮╰╯═║╔╗╚╝█';

interface Style { fg: string; bg: string; bold: boolean; dim: boolean }

type Cell = NonNullable<ReturnType<xterm.IBufferLine['getCell']>>;

function styleOf(c: Cell): Style {
  let fg = TERM_FG;
  let bg = '';
  if (c.isFgRGB()) fg = hex(c.getFgColor());
  else if (c.isFgPalette()) fg = palette256(c.getFgColor());
  if (c.isBgRGB()) bg = hex(c.getBgColor());
  else if (c.isBgPalette()) bg = palette256(c.getBgColor());
  if (c.isInverse()) [fg, bg] = [bg || TERM_BG, fg];
  return { fg, bg, bold: Boolean(c.isBold()), dim: Boolean(c.isDim()) };
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * One terminal row as HTML. Every column is its own fixed-width element (runs
 * of plain spaces are merged), so no glyph can push the next column along.
 */
function lineHtml(line: xterm.IBufferLine | undefined, cols: number): string {
  if (!line) return '';
  // Trim trailing default blanks.
  let end = cols;
  for (; end > 0; end--) {
    const c = line.getCell(end - 1)!;
    const ch = c.getChars();
    if ((ch !== '' && ch !== ' ') || styleOf(c).bg) break;
  }
  let html = '';
  let blanks = 0;
  const flush = () => {
    if (blanks) html += `<s style="width:calc(var(--cw)*${blanks})"></s>`;
    blanks = 0;
  };
  for (let x = 0; x < end; x++) {
    const c = line.getCell(x)!;
    if (c.getWidth() === 0) continue;
    const ch = c.getChars() || ' ';
    const s = styleOf(c);
    if (ch === ' ' && !s.bg) {
      blanks++;
      continue;
    }
    flush();
    const css = [
      s.fg !== TERM_FG || s.dim ? `color:${s.dim ? `color-mix(in srgb, ${s.fg} 55%, ${TERM_BG})` : s.fg}` : '',
      s.bg ? `background:${s.bg}` : '',
      s.bold ? 'font-weight:700' : '',
    ].filter(Boolean).join(';');
    const cls = BOX_CHARS.includes(ch) ? ` class="k k${BOX_CHARS.indexOf(ch)}"` : '';
    html += `<b${cls}${css ? ` style="${css}"` : ''}>${cls ? '' : esc(ch)}</b>`;
  }
  return html;
}

// ------------------------------------------------------------------ playback

export interface Snapshot {
  /** Seconds into the GIF. */
  t: number;
  /** First buffer row shown at the top of the window. */
  top: number;
  /** Line ids (into `lines`) for buffer rows 0..n. */
  rows: number[];
}

export interface Playback {
  lines: string[];
  snaps: Snapshot[];
  /** GIF time of the last state. */
  end: number;
}

const SPINNER = /[◒◐◓◑]/;

/**
 * Replay a recording through a headless terminal and keep the states worth
 * showing, with GIF times. `pre` is fed first (the typed shell command).
 * Waits longer than `maxGap` are cut to it, and each spinner run keeps only
 * its first `spinFrames` ticks: the capture itself takes 15-20 s per device.
 */
export async function playback(rec: Recording, opts: { pre: [number, string][]; start: number; maxGap: number; blockGap: number; spinFrames: number }): Promise<Playback> {
  const term = new xterm.Terminal({ cols: rec.cols, rows: rec.rows, scrollback: 1000, allowProposedApi: true });
  const write = (d: string) => new Promise<void>(r => term.write(d, r));
  const ids = new Map<string, number>();
  const lines: string[] = [];
  const snaps: Snapshot[] = [];
  const snap = (t: number) => {
    const buf = term.buffer.active;
    const rows: number[] = [];
    for (let y = 0; y < buf.length; y++) {
      const h = lineHtml(buf.getLine(y), rec.cols);
      let id = ids.get(h);
      if (id === undefined) {
        id = lines.length;
        lines.push(h);
        ids.set(h, id);
      }
      rows.push(id);
    }
    const s = { t, top: buf.baseY, rows };
    const prev = snaps.at(-1);
    if (prev && prev.top === s.top && prev.rows.join() === s.rows.join()) return;
    snaps.push(s);
  };

  let t = 0;
  for (const [at, d] of opts.pre) {
    await write(d);
    t = at;
    snap(t);
  }
  t = opts.start;

  const out = rec.events.filter(e => e[1] === 'o');
  let last = 0;
  let pending = 0;
  let spinRun = 0;
  let rowsBefore = term.buffer.active.baseY + term.buffer.active.cursorY;
  for (const [at, , d] of out) {
    pending += at - last;
    last = at;
    await write(d);
    const plain = d.replace(ANSI_RE, '');
    // Pure cursor moves and erases: show the state once the redraw lands.
    if (!plain.trim() && !plain.includes('\n')) continue;
    const tick = SPINNER.test(plain) && !/[◇■▲]/.test(plain);
    spinRun = tick ? spinRun + 1 : 0;
    if (tick && spinRun > opts.spinFrames) {
      pending = 0;
      continue;
    }
    let gap = Math.min(pending, opts.maxGap);
    pending = 0;
    // When a block of new lines lands (a box, a new prompt), the state before
    // it is held for at least `blockGap` so it can be read.
    const grew = term.buffer.active.baseY + term.buffer.active.cursorY - rowsBefore;
    if (grew >= 4) gap = Math.max(gap, opts.blockGap);
    rowsBefore = term.buffer.active.baseY + term.buffer.active.cursorY;
    t += gap;
    snap(t);
  }
  term.dispose();
  return { lines, snaps, end: t };
}
