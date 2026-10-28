// Regenerate the README media in docs/media from real rpc captures.
//
//   pnpm media              # capture (cached in .media-cache), then render everything
//   pnpm media --fresh      # re-capture the demo sites first
//   pnpm media --only gif   # hero | gif | slices
//
// Needs ffmpeg on PATH. Captures hit the live demo sites, so they need network.
// See docs/media.md for why it works this way.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import type { Browser } from 'playwright';
import { bezelLayoutFor, loadBezelSvg } from '../../src/bezel.js';
import { launchBrowser } from '../../src/browser.js';
import { resolveDevice } from '../../src/devices.js';
import { pngSize } from '../../src/png.js';
import { DEFAULT_MAX_SLICES } from '../../src/options.js';
import { planSlices } from '../../src/slices.js';

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

/** The two commands the GIF replays. They are run for real, from CACHE. */
const RUNS = {
  devices: ['shot', 'hello-greetings.vercel.app', '-d', 'iphone-15,ipad,desktop-1440', '--bezels'],
  fullPage: ['shot', 'devakintola.com', '-d', 'iphone-15', '--full-page', '--slices'],
} as const;
type RunName = keyof typeof RUNS;

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

function bezelSvg(deviceId: string): string {
  const layout = bezelLayoutFor(resolveDevice(deviceId));
  return loadBezelSvg(layout.src).replace(/<svg\b[^>]*>/, tag =>
    tag.replace(/\s(width|height)="[^"]*"/g, '').replace('<svg', '<svg style="position:absolute;inset:0;width:100%;height:100%"')
  );
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

async function gif(browser: Browser, logs: Record<RunName, string>) {
  const W = 960, H = 540;
  const row = deviceRow(W, 1, 1);

  // Scene B phone: bezel SVG plus the stitched full-page PNG scrolled inside the screen rect.
  const phone = bezelLayoutFor(resolveDevice('iphone-15'));
  const phoneH = 468;
  const ps = phoneH / phone.outerHeight;
  const fullPng = join(SHOTS, `${FULL_STEM}.png`);
  const fullSize = pngSize(readFileSync(fullPng));
  const pageCss = Math.round(fullSize.height / 3);
  const screenW = Math.round(phone.screen.width * ps);
  const fullSrc = resized(fullPng, screenW, 'full.png');
  const fullDisplayH = Math.round((fullSize.height * screenW) / fullSize.width);
  const screenH = Math.round(phone.screen.height * ps);

  const termLines = (name: RunName) =>
    logs[name].trimEnd().split('\n').filter(l => !/console error/.test(l));
  const cmdA = `rpc ${RUNS.devices.join(' ')}`;
  const cmdB = `rpc ${RUNS.fullPage.join(' ')}`;
  const segs = /\((\d+) segments stitched\)/.exec(logs.fullPage)?.[1] ?? '?';
  const slices = /(\d+) slice\(s\)/.exec(logs.fullPage)?.[1] ?? '?';

  // Seconds. Each scene fades out to the background before the next fades in,
  // and the last frame fades to the background so the loop seam is clean.
  const CPS = 50; // typing speed
  const timeline = {
    typeA: [0.3, 0.3 + cmdA.length / CPS],
    outA: 2.1,
    termOutA: [3.6, 3.9],
    devIn: 3.95,
    aOut: [6.0, 6.3],
    bIn: [6.3, 6.6],
    typeB: [6.7, 6.7 + cmdB.length / CPS],
    outB: 8.2,
    phoneIn: 8.4,
    scroll: [9.0, 12.0],
    end: [12.6, 13.0],
    total: 13.0,
  };

  const html = `<!doctype html><html><head><style>
  html,body{margin:0;width:${W}px;height:${H}px;overflow:hidden;background:#eceef1}
  *{box-sizing:border-box}
  .term{position:absolute;background:#0d1015;border-radius:10px;box-shadow:0 10px 30px rgba(15,20,30,.18);overflow:hidden}
  .bar{height:30px;display:flex;align-items:center;gap:7px;padding:0 13px;background:#171b22}
  .bar i{width:11px;height:11px;border-radius:50%;background:#3a3f48;display:block}
  .body{padding:14px 18px;font:13px/1.62 ${FONT_MONO};color:#d7dde5;white-space:pre-wrap;word-break:break-all}
  .p{color:#7ee2a8}.ok{color:#7ee2a8}.dim{color:#7d8794}.cur{display:inline-block;width:8px;height:15px;background:#d7dde5;vertical-align:-2px}
  .d{position:absolute;display:block}
  .l{position:absolute;font:500 12.5px/1 ${FONT_UI};color:#57606a;text-align:center;white-space:nowrap}
  #phone{position:absolute;width:${Math.round(phone.outerWidth * ps)}px;height:${phoneH}px}
  #screen{position:absolute;left:${Math.round(phone.screen.x * ps)}px;top:${Math.round(phone.screen.y * ps)}px;width:${screenW}px;height:${screenH}px;
    border-radius:${Math.round(phone.screen.radius * ps)}px;overflow:hidden;background:#000;z-index:2}
  #screen img{position:absolute;left:0;top:0;width:${screenW}px;height:${fullDisplayH}px}
  .cap{position:absolute;font:600 22px/1.25 ${FONT_UI};color:#1f2328;letter-spacing:-.01em}
  .sub{position:absolute;font:13.5px/1.5 ${FONT_MONO};color:#57606a}
  .track{position:absolute;width:4px;border-radius:2px;background:#d3d7dd}
  .thumb{position:absolute;left:0;width:4px;border-radius:2px;background:#1f2328}
  </style></head><body>
  <div id="A">
    <div class="term" id="termA" style="left:70px;top:80px;width:820px;height:280px">
      <div class="bar"><i></i><i></i><i></i></div><div class="body" id="bodyA"></div>
    </div>
    ${row.map(d => `<img class="d dev" src="${d.src}" style="left:${d.x}px;top:${450 - d.h}px;width:${d.w}px;height:${d.h}px">
      <div class="l dev" style="left:${d.x - 40}px;top:472px;width:${d.w + 80}px">${esc(d.label)}</div>`).join('')}
  </div>
  <div id="B">
    <div class="term" style="left:36px;top:56px;width:624px;height:200px">
      <div class="bar"><i></i><i></i><i></i></div><div class="body" id="bodyB" style="font-size:12px"></div>
    </div>
    <div class="cap" style="left:40px;top:316px">Full page, no height limit</div>
    <div class="sub" style="left:40px;top:358px;width:560px">${pageCss.toLocaleString('en-US')} css px tall, ${segs} segments stitched,<br>${slices} labelled review slices for the agent</div>
    <div class="sub" id="ypos" style="left:40px;top:424px;color:#1f2328"></div>
    <div id="phone" style="left:${W - 58 - Math.round(phone.outerWidth * ps)}px;top:${Math.round((H - phoneH) / 2)}px">
      <div style="position:absolute;inset:0;z-index:1">${bezelSvg('iphone-15')}</div>
      <div id="screen"><img id="full" src="${fullSrc}"></div>
    </div>
    <div class="track" style="left:${W - 38}px;top:${Math.round((H - phoneH) / 2) + 20}px;height:${phoneH - 40}px">
      <div class="thumb" id="thumb"></div>
    </div>
  </div>
  <script>
  const T = ${JSON.stringify(timeline)};
  const A = { cmd: ${JSON.stringify(cmdA)}, out: ${JSON.stringify(termLines('devices'))} };
  const B = { cmd: ${JSON.stringify(cmdB)}, out: ${JSON.stringify(termLines('fullPage'))} };
  const PAGE = ${pageCss}, SCREEN_H = ${screenH}, IMG_H = ${fullDisplayH}, TRACK = ${phoneH - 40};
  const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
  const prog = (t, a, b) => clamp((t - a) / (b - a));
  const out3 = p => 1 - Math.pow(1 - p, 3);
  const inOut = p => p < .5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
  const esc = s => s.replace(/&/g,'&amp;').replace(/</g,'&lt;');
  function fmt(line) {
    if (/^ok /.test(line)) return '<span class="ok">ok</span>' + esc(line.slice(2));
    return '<span class="dim">' + esc(line) + '</span>';
  }
  function term(el, t, s, typeAt, outAt) {
    const n = Math.floor(prog(t, typeAt[0], typeAt[1]) * s.cmd.length);
    const typing = t < typeAt[1] + 0.25;
    const blink = Math.floor(t * 2.5) % 2 === 0;
    let h = '<span class="p">$</span> ' + esc(s.cmd.slice(0, n));
    if (typing) h += '<span class="cur" style="opacity:' + (blink || t > typeAt[0] ? 1 : 0) + '"></span>';
    const shown = t < outAt ? 0 : Math.min(s.out.length, 1 + Math.floor((t - outAt) / 0.11));
    if (shown) h += '\\n' + s.out.slice(0, shown).map(fmt).join('\\n');
    el.innerHTML = h;
  }
  window.render = t => {
    const a = document.getElementById('A'), b = document.getElementById('B');
    const aOut = prog(t, T.aOut[0], T.aOut[1]), bIn = prog(t, T.bIn[0], T.bIn[1]);
    a.style.opacity = String(1 - aOut);
    a.style.display = aOut >= 1 ? 'none' : '';
    b.style.opacity = String(bIn * (1 - prog(t, T.end[0], T.end[1])));
    b.style.display = bIn <= 0 ? 'none' : '';
    // scene A
    const ta = document.getElementById('termA');
    const fade = out3(prog(t, T.termOutA[0], T.termOutA[1]));
    ta.style.opacity = String(Math.min(prog(t, 0, 0.3), 1 - fade));
    ta.style.transform = 'translateY(' + (-16 * fade) + 'px) scale(' + (1 - 0.03 * fade) + ')';
    term(document.getElementById('bodyA'), t, A, T.typeA, T.outA);
    document.querySelectorAll('#A .dev').forEach((el, i) => {
      const p = out3(prog(t, T.devIn + Math.floor(i / 2) * 0.14, T.devIn + Math.floor(i / 2) * 0.14 + 0.55));
      el.style.opacity = String(p);
      el.style.transform = 'translateY(' + Math.round(24 * (1 - p)) + 'px)';
    });
    // scene B
    term(document.getElementById('bodyB'), t, B, T.typeB, T.outB);
    const ph = out3(prog(t, T.phoneIn, T.phoneIn + 0.55));
    const phone = document.getElementById('phone');
    phone.style.opacity = String(ph);
    phone.style.transform = 'translateY(' + Math.round(24 * (1 - ph)) + 'px)';
    const s = inOut(prog(t, T.scroll[0], T.scroll[1]));
    const y = Math.round(s * (IMG_H - SCREEN_H));
    document.getElementById('full').style.transform = 'translateY(' + (-y) + 'px)';
    const thumbH = Math.max(14, Math.round(TRACK * SCREEN_H / IMG_H));
    const th = document.getElementById('thumb');
    th.style.height = thumbH + 'px';
    th.style.top = Math.round(s * (TRACK - thumbH)) + 'px';
    th.parentElement.style.opacity = String(ph);
    const css = Math.round(s * (PAGE - ${resolveDevice('iphone-15').height}));
    document.getElementById('ypos').textContent = t >= T.phoneIn ? 'y = ' + css.toLocaleString('en-US') + ' / ' + PAGE.toLocaleString('en-US') : '';
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
  console.log(`${out}  ${kb(out)}  (${n} frames, ${timeline.total}s @ ${FPS} fps)`);
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

// ---------------------------------------------------------------- main

mkdirSync(STAGE, { recursive: true });
mkdirSync(OUT, { recursive: true });
const logs = { devices: capture('devices'), fullPage: capture('fullPage') };
const browser = await launchBrowser();
try {
  if (!only || only === 'hero') await hero(browser);
  if (!only || only === 'gif') await gif(browser, logs);
  if (!only || only === 'slices') await slicesImage(browser);
} finally {
  await browser.close();
}
