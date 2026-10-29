// Regenerate the README media in docs/media from real rpc captures.
//
//   pnpm media              # capture (cached in .media-cache), then render everything
//   pnpm media --fresh      # re-capture the demo sites first
//   pnpm media --only gif   # hero | gif | slices | banner
//
// Needs ffmpeg and python3 on PATH. Captures hit the live demo sites, so they
// need network. See docs/media.md for why it works this way.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import type { Browser } from 'playwright';
import { launchBrowser } from '../../src/browser.js';
import { resolveDevice } from '../../src/devices.js';
import { pngSize } from '../../src/png.js';
import { DEFAULT_MAX_SLICES } from '../../src/options.js';
import { planSlices } from '../../src/slices.js';
import { BOX_CHARS, TERM_BG, TERM_FG, playback, record, type Recording } from './terminal.js';
import { BANNER, OG, block, circle, path, rect, renderBanner, ART_BG, ART_DIM, type BannerSpec, type Mark } from './banner.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CACHE = join(ROOT, '.media-cache');
const SHOTS = join(CACHE, '.rpc-shots');
const STAGE = join(CACHE, 'stage');
const FRAMES = join(CACHE, 'frames');
const OUT = join(ROOT, 'docs', 'media');

const { values } = parseArgs({
  options: { fresh: { type: 'boolean' }, only: { type: 'string' } },
});
const only = values.only;

/** Plain run for the MCP slices image. Run for real, from CACHE. */
const RUNS = {
  fullPage: ['shot', 'devakintola.com', '-d', 'iphone-15', '--full-page', '--slices'],
} as const;
type RunName = keyof typeof RUNS;

/**
 * The GIF's terminal scene: `rpc` with no arguments in a 108x28 pseudo-terminal,
 * answered like a person would. It writes the three device shots (and framed
 * copies) that the hero and the GIF's device scene use.
 */
const TERM = { cols: 108, rows: 28 };
const DEMO_URL = 'hello-greetings.vercel.app';
const UP = '\x1b[A';
const STEPS = [
  { when: /Which URL/, pause: 500, keys: [...DEMO_URL], gap: 45 },
  { when: /hello-greetings\.vercel\.app/, pause: 300, keys: ['\r'], gap: 0 },
  // iPhone 15 Pro, iPad Air 11 and Desktop 1440 are preselected, cursor on
  // the 15 Pro: untick it, go up two to iphone-15, tick that.
  { when: /Which devices/, pause: 700, keys: [' ', UP, UP, ' '], gap: 360 },
  { when: /◼ iphone-15 /, pause: 450, keys: ['\r'], gap: 0 },
  { when: /Options/, pause: 600, keys: ['\r'], gap: 0 },
  { when: /Proceed with capture/, pause: 800, keys: ['\r'], gap: 0 },
];

const DEVICE_STEMS = {
  phone: 'hello-greetings-vercel-app-iphone-15',
  tablet: 'hello-greetings-vercel-app-ipad-air-11',
  desktop: 'hello-greetings-vercel-app-desktop-1440',
};
const FULL_STEM = 'devakintola-com-iphone-15';

// ---------------------------------------------------------------- capture

function capture(name: RunName): string {
  const log = join(CACHE, `${name}.txt`);
  if (!values.fresh && existsSync(log)) return readFileSync(log, 'utf8');
  const cli = join(ROOT, 'dist', 'cli.js');
  if (!existsSync(cli)) throw new Error('dist/cli.js is missing: run pnpm build first');
  console.log(`capturing: rpc ${RUNS[name].join(' ')}`);
  // Live sites occasionally time out; retry rather than replay a failed run.
  for (let attempt = 1; ; attempt++) {
    const r = spawnSync(process.execPath, [cli, ...RUNS[name]], { cwd: CACHE, encoding: 'utf8' });
    if (r.status === 0) {
      writeFileSync(log, r.stdout);
      return r.stdout;
    }
    if (attempt === 3) throw new Error(`rpc failed:\n${r.stdout}\n${r.stderr}`);
    console.log(`  attempt ${attempt} failed, retrying`);
  }
}

async function recordInteractive(): Promise<Recording> {
  const file = join(CACHE, 'interactive.json');
  if (!values.fresh && existsSync(file)) return JSON.parse(readFileSync(file, 'utf8')) as Recording;
  const cli = join(ROOT, 'dist', 'cli.js');
  if (!existsSync(cli)) throw new Error('dist/cli.js is missing: run pnpm build first');
  const stub = join(ROOT, 'scripts', 'media', 'no-dev-server.mjs');
  for (let attempt = 1; ; attempt++) {
    console.log(`recording: rpc (interactive, ${TERM.cols}x${TERM.rows})`);
    const rec = await record([process.execPath, '--import', pathToFileURL(stub).href, cli], { ...TERM, cwd: CACHE, steps: STEPS });
    const text = rec.events.map(e => e[2]).join('');
    if (rec.exitCode === 0 && text.includes('Captured 3 devices')) {
      writeFileSync(file, JSON.stringify(rec));
      return rec;
    }
    if (attempt === 3) throw new Error(`interactive rpc failed (exit ${rec.exitCode})`);
    console.log(`  attempt ${attempt} failed, retrying`);
  }
}

// ---------------------------------------------------------------- helpers

function ffmpeg(args: string[]): void {
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', ...args], { stdio: 'inherit' });
}

/** Lanczos-resize a capture to an exact pixel width for the stage page. */
function resized(src: string, width: number, name: string): string {
  const out = join(STAGE, name);
  ffmpeg(['-i', src, '-vf', `scale=${width}:-1:flags=lanczos`, out]);
  return pathToFileURL(out).href;
}

function kb(path: string): string {
  return `${Math.round(statSync(path).size / 1024)} KB`;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function screenshot(browser: Browser, html: string, size: { width: number; height: number }, dpr: number, out: string, omitBackground = false) {
  const file = join(STAGE, 'page.html');
  writeFileSync(file, html);
  const ctx = await browser.newContext({ viewport: size, deviceScaleFactor: dpr });
  const page = await ctx.newPage();
  await page.goto(pathToFileURL(file).href);
  await page.waitForFunction('Array.from(document.images).every(i => i.complete)');
  await page.screenshot({ path: out, omitBackground });
  await ctx.close();
}

const FONT_UI = `-apple-system, BlinkMacSystemFont, "Segoe UI", "Helvetica Neue", Arial, sans-serif`;
const FONT_MONO = `"SF Mono", ui-monospace, Menlo, Consolas, "Liberation Mono", monospace`;

// ---------------------------------------------------------------- device row (hero + GIF)

interface Placed { key: keyof typeof DEVICE_STEMS; id: string; label: string; x: number; w: number; h: number; src: string }

/** Desktop, tablet, phone side by side, bottom-aligned, centred in `width`. */
function deviceRow(width: number, scale: number, pxScale: number): Placed[] {
  const spec = [
    { key: 'desktop' as const, id: 'desktop-1440', h: 330 },
    { key: 'tablet' as const, id: 'ipad-air-11', h: 290 },
    { key: 'phone' as const, id: 'iphone-15', h: 270 },
  ];
  const gap = 44 * scale;
  const items = spec.map(s => {
    const file = join(SHOTS, `${DEVICE_STEMS[s.key]}-framed.png`);
    const size = pngSize(readFileSync(file));
    const h = s.h * scale;
    const w = Math.round((h * size.width) / size.height);
    const d = resolveDevice(s.id);
    return { key: s.key, id: s.id, label: `${d.name.replace(/"$/, '″')} · ${d.width}×${d.height}`, w, h, file };
  });
  const total = items.reduce((a, i) => a + i.w, 0) + gap * (items.length - 1);
  let x = Math.round((width - total) / 2);
  return items.map(i => {
    const placed = { ...i, x, src: resized(i.file, Math.round(i.w * pxScale), `${i.key}.png`) };
    x += i.w + gap;
    return placed;
  });
}

// ---------------------------------------------------------------- hero

async function hero(browser: Browser) {
  const W = 960, H = 410, DPR = 2;
  const row = deviceRow(W, 1, DPR);
  const base = 360;
  for (const theme of ['light', 'dark'] as const) {
    const fg = theme === 'light' ? '#57606a' : '#8b949e';
    const html = `<!doctype html><html><head><style>
      html,body{margin:0;background:transparent}
      .d{position:absolute;display:block}
      .l{position:absolute;top:${base + 22}px;font:500 12.5px/1 ${FONT_UI};color:${fg};text-align:center;white-space:nowrap;letter-spacing:.01em}
    </style></head><body>
    ${row.map(d => `<img class="d" src="${d.src}" style="left:${d.x}px;top:${base - d.h}px;width:${d.w}px;height:${d.h}px">
      <div class="l" style="left:${d.x - 40}px;width:${d.w + 80}px">${esc(d.label)}</div>`).join('')}
    </body></html>`;
    const raw = join(STAGE, `hero-${theme}-raw.png`);
    await screenshot(browser, html, { width: W, height: H }, DPR, raw, true);
    const out = join(OUT, `hero-${theme}.png`);
    // Keep alpha: palettegen/paletteuse would cut the bezels' soft edges to 1-bit.
    ffmpeg(['-i', raw, '-compression_level', '9', out]);
    console.log(`${out}  ${kb(out)}`);
  }
}

// ---------------------------------------------------------------- GIF

const FPS = 20;

// Terminal cell, px. Box-drawing masks below are drawn on this grid.
const CW = 9, LH = 20;
const BOX_PATHS: Record<string, string> = {
  '│': 'M4.5 0V20', '─': 'M0 10.5H9',
  '┌': 'M9 10.5H4.5V20', '┐': 'M0 10.5H4.5V20', '└': 'M4.5 0V10.5H9', '┘': 'M4.5 0V10.5H0',
  '├': 'M4.5 0V20M4.5 10.5H9', '┤': 'M4.5 0V20M4.5 10.5H0', '┬': 'M0 10.5H9M4.5 10.5V20',
  '┴': 'M0 10.5H9M4.5 10.5V0', '┼': 'M0 10.5H9M4.5 0V20',
  '╭': 'M9 10.5H8.5Q4.5 10.5 4.5 14.5V20', '╮': 'M0 10.5H0.5Q4.5 10.5 4.5 14.5V20',
  '╰': 'M4.5 0V6.5Q4.5 10.5 8.5 10.5H9', '╯': 'M4.5 0V6.5Q4.5 10.5 0.5 10.5H0',
  '═': 'M0 8.5H9M0 12.5H9', '║': 'M2.5 0V20M6.5 0V20',
  '╔': 'M9 8.5H2.5V20M9 12.5H6.5V20', '╗': 'M0 8.5H6.5V20M0 12.5H2.5V20',
  '╚': 'M2.5 0V12.5H9M6.5 0V8.5H9', '╝': 'M6.5 0V12.5H0M2.5 0V8.5H0',
};

/** CSS for the box-drawing cells: each one is a mask over currentColor that fills its cell. */
function boxCss(): string {
  return [...BOX_CHARS].map((ch, i) => {
    const body = ch === '█'
      ? `<rect width="${CW}" height="${LH}"/>`
      : `<path d="${BOX_PATHS[ch]}" fill="none" stroke="#000" stroke-width="1"/>`;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${CW}" height="${LH}" viewBox="0 0 ${CW} ${LH}">${body}</svg>`;
    return `.k${i}{-webkit-mask-image:url("data:image/svg+xml,${encodeURIComponent(svg)}")}`;
  }).join('\n');
}

async function gif(browser: Browser, rec: Recording) {
  const PAD_X = 22, PAD_TOP = 12, PAD_BOTTOM = 16, BAR = 32, MARGIN = 20;
  const termW = PAD_X * 2 + TERM.cols * CW;
  const termH = BAR + PAD_TOP + TERM.rows * LH + PAD_BOTTOM;
  const W = termW + MARGIN * 2, H = termH + MARGIN * 2;

  // Scenes 1-2: the recorded session. "$ rpc" is typed first, as a shell would echo it.
  const prompt = '\x1b[32m$\x1b[39m ';
  const pre: [number, string][] = [[0, prompt], [0.45, 'r'], [0.55, 'p'], [0.65, 'c'], [0.95, '\r\n']];
  const pb = await playback(rec, { pre, start: 1.0, maxGap: 0.4, blockGap: 0.5, spinFrames: 5 });

  // Scene 3: the framed devices.
  const row = deviceRow(W, 1.15, 1);
  const rowH = Math.max(...row.map(d => d.h));
  const base = Math.round((H - rowH - 34) / 2) + rowH;

  // Seconds. Each scene fades out to the background before the next fades in,
  // and the last frame fades to the background so the loop seam is clean.
  const done = pb.end;
  const timeline = {
    termIn: [0, 0.25],
    termOut: [done + 2.3, done + 2.6],
    devIn: done + 2.65,
    end: [done + 5.0, done + 5.3],
    total: done + 5.3,
    typed: 0.95,
  };

  const html = `<!doctype html><html><head><style>
  html,body{margin:0;width:${W}px;height:${H}px;overflow:hidden;background:#eceef1}
  *{box-sizing:border-box}
  .term{position:absolute;left:${MARGIN}px;top:${MARGIN}px;width:${termW}px;height:${termH}px;background:${TERM_BG};border-radius:10px;
    box-shadow:0 6px 18px rgba(15,20,30,.16);overflow:hidden}
  .bar{height:${BAR}px;display:flex;align-items:center;gap:7px;padding:0 13px;background:#171b22}
  .bar i{width:11px;height:11px;border-radius:50%;background:#3a3f48;display:block}
  .bar span{position:absolute;left:0;right:0;text-align:center;font:500 12px/1 ${FONT_UI};color:#7d8794}
  .screen{position:absolute;left:${PAD_X}px;top:${BAR + PAD_TOP}px;width:${TERM.cols * CW}px;height:${TERM.rows * LH}px;overflow:hidden}
  #rows{position:absolute;left:0;top:0;width:100%}
  .r{--cw:${CW}px;height:${LH}px;white-space:nowrap;font:15px/${LH}px ${FONT_MONO};color:${TERM_FG};
    -webkit-font-smoothing:antialiased;font-variant-ligatures:none}
  .r b,.r s{display:inline-block;width:${CW}px;height:${LH}px;vertical-align:top;text-align:center;font-weight:400;text-decoration:none;overflow:visible}
  .r .k{background-color:currentColor;-webkit-mask-size:${CW}px ${LH}px;-webkit-mask-repeat:no-repeat}
  ${boxCss()}
  #cur{position:absolute;width:${CW}px;height:${LH}px;background:${TERM_FG}}
  .d{position:absolute;display:block}
  .l{position:absolute;font:500 14px/1 ${FONT_UI};color:#57606a;text-align:center;white-space:nowrap}
  </style></head><body>
  <div id="A">
    <div class="term" id="term">
      <div class="bar"><i></i><i></i><i></i><span>rpc — ${TERM.cols}×${TERM.rows}</span></div>
      <div class="screen"><div id="rows"></div><div id="cur"></div></div>
    </div>
    ${row.map(d => `<img class="d dev" src="${d.src}" style="left:${d.x}px;top:${base - d.h}px;width:${d.w}px;height:${d.h}px">
      <div class="l dev" style="left:${d.x - 40}px;top:${base + 24}px;width:${d.w + 80}px">${esc(d.label)}</div>`).join('')}
  </div>
  <script>
  const T = ${JSON.stringify(timeline)};
  const LINES = ${JSON.stringify(pb.lines)};
  const SNAPS = ${JSON.stringify(pb.snaps)};
  const ROWS = ${TERM.rows}, LH = ${LH}, CW = ${CW}, SCROLL = 0.28;
  const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
  const prog = (t, a, b) => clamp((t - a) / (b - a));
  const out3 = p => 1 - Math.pow(1 - p, 3);
  // Scrollback position: eases to each new top row instead of jumping a line at a time.
  function scrollAt(t) {
    let from = SNAPS[0].top, to = from, st = -1;
    for (const s of SNAPS) {
      if (s.t > t) break;
      if (s.top !== to) {
        from = st < 0 ? to : from + (to - from) * out3(prog(s.t, st, st + SCROLL));
        to = s.top; st = s.t;
      }
    }
    return st < 0 ? to : from + (to - from) * out3(prog(t, st, st + SCROLL));
  }
  let shown = '';
  function term(t) {
    let i = 0;
    while (i + 1 < SNAPS.length && SNAPS[i + 1].t <= t) i++;
    const s = SNAPS[i];
    const y = scrollAt(t);
    const top = Math.floor(y);
    const key = i + ':' + top;
    if (key !== shown) {
      let h = '';
      for (let r = top; r <= top + ROWS; r++) h += '<div class="r">' + (r < s.rows.length ? LINES[s.rows[r]] : '') + '</div>';
      document.getElementById('rows').innerHTML = h;
      shown = key;
    }
    document.getElementById('rows').style.transform = 'translateY(' + (-Math.round((y - top) * LH)) + 'px)';
    // The shell cursor while "rpc" is typed; the CLI draws its own after that.
    const cur = document.getElementById('cur');
    const typed = Math.min(3, Math.max(0, Math.floor((t - 0.35) / 0.1)));
    cur.style.display = t < T.typed && (t < 0.4 || t > 0.45 || Math.floor(t * 2.5) % 2 === 0) ? '' : 'none';
    cur.style.left = ((2 + typed) * CW) + 'px';
    cur.style.top = '0px';
  }
  window.render = t => {
    document.getElementById('A').style.opacity = String(1 - prog(t, T.end[0], T.end[1]));
    // scenes 1-2
    const el = document.getElementById('term');
    const fade = out3(prog(t, T.termOut[0], T.termOut[1]));
    el.style.opacity = String(Math.min(prog(t, T.termIn[0], T.termIn[1]), 1 - fade));
    el.style.transform = fade ? 'translateY(' + (-16 * fade) + 'px) scale(' + (1 - 0.03 * fade) + ')' : '';
    el.style.display = fade >= 1 ? 'none' : '';
    if (fade < 1) term(t);
    // scene 3
    document.querySelectorAll('#A .dev').forEach((d, i) => {
      const k = Math.floor(i / 2) * 0.14;
      const p = out3(prog(t, T.devIn + k, T.devIn + k + 0.55));
      d.style.opacity = String(p);
      d.style.transform = 'translateY(' + Math.round(24 * (1 - p)) + 'px)';
    });
  };
  </script></body></html>`;

  const file = join(STAGE, 'gif.html');
  writeFileSync(file, html);
  rmSync(FRAMES, { recursive: true, force: true });
  mkdirSync(FRAMES, { recursive: true });
  const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  await page.goto(pathToFileURL(file).href);
  await page.waitForFunction('Array.from(document.images).every(i => i.complete)');
  await page.evaluate('document.fonts.ready');
  const n = Math.round(timeline.total * FPS);
  for (let i = 0; i < n; i++) {
    await page.evaluate(`window.render(${i / FPS})`);
    await page.screenshot({ path: join(FRAMES, `f${String(i).padStart(4, '0')}.png`) });
  }
  await ctx.close();

  const out = join(OUT, 'demo.gif');
  // Two-pass palette: one global 256-colour palette from the frame diffs, then
  // only the changed rectangle of each frame is re-encoded. No dithering keeps
  // flat UI colours flat and the file small.
  ffmpeg([
    '-framerate', String(FPS), '-i', join(FRAMES, 'f%04d.png'),
    '-vf', 'split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=none:diff_mode=rectangle',
    '-loop', '0', out,
  ]);
  console.log(`${out}  ${kb(out)}  (${n} frames, ${timeline.total.toFixed(1)}s @ ${FPS} fps, ${W}x${H})`);
}

// ---------------------------------------------------------------- MCP slices

async function slicesImage(browser: Browser) {
  const files = readdirSync(SHOTS).filter(f => f.startsWith(`${FULL_STEM}-slice-`)).sort();
  const fullSize = pngSize(readFileSync(join(SHOTS, `${FULL_STEM}.png`)));
  const specs = planSlices('iphone-15', fullSize.height / 3, resolveDevice('iphone-15').height);
  const show = 5;
  const W = 960, colW = 148, gap = 30, top = 92;
  const x0 = Math.round((W - (show * colW + (show - 1) * gap)) / 2);
  const imgH = Math.round((colW * 852) / 393);
  const cells = files.slice(0, show).map((f, i) => {
    const src = resized(join(SHOTS, f), colW * 2, `slice-${i}.png`);
    const spec = specs[i]!;
    return `<div style="position:absolute;left:${x0 + i * (colW + gap)}px;top:${top}px;width:${colW}px">
      <div class="lab">${esc(`iphone-15 · slice ${spec.index}/${spec.total}`)}<br><span>y=${spec.y}–${spec.y + spec.height} css px</span></div>
      <img src="${src}" style="display:block;width:${colW}px;height:${imgH}px;border-radius:6px;outline:1px solid var(--line)">
    </div>`;
  });
  const labH = 44;
  const H = top + labH + imgH + 62;
  for (const theme of ['light', 'dark'] as const) {
    const c = theme === 'light'
      ? { fg: '#1f2328', dim: '#57606a', line: '#d0d7de' }
      : { fg: '#e6edf3', dim: '#8b949e', line: '#30363d' };
    const html = `<!doctype html><html><head><style>
      :root{--line:${c.line}}
      html,body{margin:0;background:transparent}
      .h{position:absolute;left:${x0}px;top:28px;font:600 17px/1.3 ${FONT_UI};color:${c.fg}}
      .h code{font:600 16px/1 ${FONT_MONO}}
      .h span{font:13px/1 ${FONT_MONO};color:${c.dim};font-weight:400;margin-left:8px}
      .lab{height:${labH - 8}px;font:11px/1.55 ${FONT_MONO};color:${c.fg};margin-bottom:8px;white-space:nowrap}
      .lab span{color:${c.dim}}
      .f{position:absolute;left:${x0}px;top:${top + labH + imgH + 22}px;font:12.5px/1.4 ${FONT_MONO};color:${c.dim}}
    </style></head><body>
      <div class="h">What the agent gets back from <code>screenshot</code> <span>fullPage: true</span></div>
      ${cells.join('')}
      <div class="f">…slices ${show + 1}–${Math.min(DEFAULT_MAX_SLICES, specs.length)} follow inline${specs.length > DEFAULT_MAX_SLICES ? `, ${DEFAULT_MAX_SLICES + 1}–${specs.length} are saved to disk and listed` : ''}. A JSON summary with every path comes first.</div>
    </body></html>`;
    const raw = join(STAGE, `slices-${theme}-raw.png`);
    await screenshot(browser, html, { width: W, height: H }, 2, raw, true);
    const out = join(OUT, `mcp-slices-${theme}.png`);
    ffmpeg(['-i', raw, '-compression_level', '9', out]);
    console.log(`${out}  ${kb(out)}`);
  }
}

// ---------------------------------------------------------------- banner

/**
 * The Responsive Point Check banner's laptop, tablet and phone, with a
 * terminal in front running `rpc shot`: the CLI/MCP sibling of the extension.
 * Coordinates are on a 4px grid (see banner.ts).
 */
function bannerArt(): BannerSpec['art'] {
  const bg = ` fill="${ART_BG}"`;
  return {
    width: 672,
    height: 400,
    svg: [
      // laptop
      rect(48, 0, 480, 328, 16, false, bg),
      rect(64, 16, 448, 296, 4),
      block(64, 16, 448, 12, 2),
      block(260, 16, 56, 16, 6, ART_BG),
      block(88, 48, 56, 12, 3),
      block(352, 51, 32, 6, 3), block(392, 51, 32, 6, 3), block(432, 51, 32, 6, 3),
      rect(88, 80, 400, 96, 4),
      block(88, 196, 120, 48, 4), block(224, 196, 120, 48, 4),
      block(88, 256, 120, 6, 3), block(224, 256, 88, 6, 3),
      block(88, 272, 120, 40, 4), block(224, 272, 120, 40, 4),
      rect(0, 328, 576, 16, 8),
      path('M256 328V332H320V328'),
      // tablet
      rect(384, 72, 208, 288, 20, false, bg),
      rect(396, 84, 184, 264, 10),
      block(412, 100, 40, 10, 3), block(548, 103, 16, 4, 2),
      rect(412, 124, 152, 56, 4),
      block(412, 196, 72, 40, 4), block(492, 196, 72, 40, 4),
      block(412, 244, 72, 6, 3), block(492, 244, 48, 6, 3),
      block(412, 264, 72, 40, 4), block(492, 264, 72, 40, 4),
      block(412, 312, 72, 6, 3), block(492, 312, 56, 6, 3),
      // phone
      rect(560, 184, 112, 216, 20, false, bg),
      rect(568, 192, 96, 200, 14),
      block(596, 200, 40, 8, 4),
      block(576, 220, 28, 8, 3),
      rect(576, 236, 80, 40, 4),
      block(576, 288, 80, 24, 4), block(576, 320, 80, 4, 2), block(576, 328, 48, 4, 2),
      block(576, 344, 80, 24, 4), block(576, 376, 56, 4, 2),
      // terminal, in front of the laptop's screen, above its base
      rect(0, 176, 320, 136, 12, false, bg),
      path('M0 208H320'),
      circle(20, 192, 5), circle(38, 192, 5), circle(56, 192, 5),
      `<text x="24" y="254" font-family="Plex" font-weight="500" font-size="20" stroke="none" fill="${ART_DIM}">$</text>`,
      `<text x="48" y="254" font-family="Plex" font-weight="500" font-size="20" stroke="none" fill="#ffffff">rpc shot</text>`,
      block(152, 236, 12, 22, 1),
      block(24, 276, 208, 6, 3, ART_DIM),
      block(24, 292, 152, 6, 3, ART_DIM),
    ].join(''),
  };
}

/**
 * The agents rpc works with, in a column left of the terminal with lines
 * into its prompt. Claude Code and Cursor are their companies' official SVGs
 * (sources in docs/media.md), unchanged: banner.ts draws them as monochrome
 * masks. Codex has no official mark here, so the art draws a neutral `>_`
 * prompt in the banner's own line style. Heights differ so the three read at
 * the same optical size.
 */
const COLUMN_X = -76;
const COLUMN_YS = [196, 248, 300];

function marks(): Mark[] {
  const logo = (f: string) => readFileSync(join(ROOT, 'scripts', 'media', 'logos', f), 'utf8');
  return [
    { svg: logo('claude-spark.svg'), label: 'Claude Code', height: 34 },
    { label: 'Codex', height: 32 },
    { svg: logo('cursor-cube.svg'), label: 'Cursor', height: 32 },
  ];
}

/** The Codex stand-in (centred on the column's middle mark) and the lines from the marks into the prompt. */
function columnArt(): string {
  const cx = COLUMN_X, cy = COLUMN_YS[1]!;
  const prompt = [
    rect(cx - 16, cy - 16, 32, 32, 8),
    path(`M${cx - 8} ${cy - 6}L${cx - 2} ${cy}L${cx - 8} ${cy + 6}`),
    path(`M${cx + 2} ${cy + 6}H${cx + 8}`),
  ];
  const from = cx + 28;
  const lines = COLUMN_YS.map((y) =>
    path(y === cy ? `M${from} ${cy}H0` : `M${from} ${y}C${from + 16} ${y} ${-16} ${cy} 0 ${cy}`, ` stroke="${ART_DIM}"`),
  );
  return lines.join('') + prompt.join('');
}

const BANNER_SPEC = (): BannerSpec => {
  const art = bannerArt();
  return {
    tagline: 'CLI + MCP server · device screenshots for AI agents · Claude Code, Codex, Cursor.',
    // One size down from motion-inspector's, so this longer line clears the laptop.
    taglineSize: 15,
    lines: ['rpc-', 'agent'],
    art: { ...art, svg: columnArt() + art.svg },
    marks: { items: marks(), x: COLUMN_X, ys: COLUMN_YS },
  };
};

async function banner(browser: Browser) {
  for (const [name, out] of [['banner', BANNER], ['og', OG]] as const) {
    const raw = join(STAGE, `${name}-raw.png`);
    await renderBanner(browser, BANNER_SPEC(), out, ROOT, raw);
    const file = join(OUT, `${name}.png`);
    // Everything is grey (the background is #0c0c0d), so an 8-bit greyscale
    // PNG keeps every anti-aliased edge and is a fraction of the RGBA size.
    ffmpeg(['-i', raw, '-pix_fmt', 'gray', '-compression_level', '9', file]);
    console.log(`${file}  ${kb(file)}  ${1600 * out.scale * out.dpr}x${Math.round(out.height * out.scale) * out.dpr}`);
  }
}

// ---------------------------------------------------------------- main

mkdirSync(STAGE, { recursive: true });
mkdirSync(OUT, { recursive: true });
// The banner is drawn, so it needs no recording or capture.
const rec = only === 'banner' ? null : await recordInteractive();
if (only !== 'banner') capture('fullPage');
const browser = await launchBrowser();
try {
  if (!only || only === 'hero') await hero(browser);
  if (!only || only === 'gif') await gif(browser, rec!);
  if (!only || only === 'slices') await slicesImage(browser);
  if (!only || only === 'banner') await banner(browser);
} finally {
  await browser.close();
}
