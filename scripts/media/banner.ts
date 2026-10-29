// The README banner: tagline, two-line wordmark, line-art on the right.
// Same family as the Responsive Point Check banner (IBM Plex Mono on near
// black, grey hyphen bars, white 2px line-art). Rendered by build.ts
// (`pnpm media --only banner`) to docs/media/banner.png (3200x1600) and
// docs/media/og.png (1200x630).
//
// Everything is laid out on a 1600-wide design canvas. Art coordinates are on
// a 4px grid, so they stay on whole pixels at 2x and at the OG's 0.75 scale,
// and every stroke is 2 screen px centred on a whole pixel: crisp edges.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Browser } from 'playwright';

const BG = '#0c0c0d';
const FG = '#ffffff';
const DIM = '#737373';
const TAG = '#8a8a8a';

export interface BannerSpec {
  tagline: string;
  /** Wordmark lines; a trailing "-" on a line is drawn as a grey bar. */
  lines: [string, string];
  art: { width: number; height: number; svg: string };
}

export interface BannerOut {
  /** Design canvas height (width is always 1600). */
  height: number;
  /** Design px → CSS px. */
  scale: number;
  dpr: number;
}
export const BANNER: BannerOut = { height: 800, scale: 1, dpr: 2 };
export const OG: BannerOut = { height: 840, scale: 0.75, dpr: 1 };

const W = 1600, MARGIN = 72, FONT = 112, TAG_SIZE = 16, TAG_GAP = 40, LEADING = 116;

function fontFace(root: string): string {
  const dir = join(root, 'node_modules', '@fontsource', 'ibm-plex-mono', 'files');
  return [400, 500]
    .map((w) => {
      const b64 = readFileSync(join(dir, `ibm-plex-mono-latin-${w}-normal.woff2`)).toString('base64');
      return `@font-face{font-family:"Plex";font-weight:${w};src:url(data:font/woff2;base64,${b64}) format("woff2")}`;
    })
    .join('');
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function html(spec: BannerSpec, out: BannerOut, root: string): string {
  const s = out.scale, H = out.height;
  const artX = W - MARGIN - spec.art.width, artY = H / 2 - spec.art.height / 2;
  const line = (t: string, i: number) => {
    const bar = t.endsWith('-');
    return `<div class="w" id="l${i}">${esc(bar ? t.slice(0, -1) : t)}${bar ? '<i class="bar"></i>' : ''}</div>`;
  };
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  ${fontFace(root)}
  html,body{margin:0;width:${W * s}px;height:${H * s}px;overflow:hidden;background:${BG}}
  .w,.tag{position:absolute;left:${MARGIN * s}px;white-space:pre;font-family:"Plex";-webkit-font-smoothing:antialiased;font-kerning:none}
  .w{font-size:${FONT * s}px;font-weight:500;line-height:1;color:${FG};letter-spacing:-0.01em}
  .tag{font-size:${TAG_SIZE * s}px;font-weight:400;line-height:1;color:${TAG};letter-spacing:0}
  .bar{position:absolute;background:${DIM}}
  svg{position:absolute;left:${artX * s}px;top:${artY * s}px;overflow:visible}
  </style></head><body>
  <div class="tag" id="tag">${esc(spec.tagline)}</div>
  ${line(spec.lines[0], 0)}${line(spec.lines[1], 1)}
  <svg width="${spec.art.width * s}" height="${spec.art.height * s}" viewBox="0 0 ${spec.art.width} ${spec.art.height}"
    fill="none" stroke="${FG}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <style>*{vector-effect:non-scaling-stroke}</style>
    ${spec.art.svg}
  </svg>
  <script>
  // Place the wordmark so its block (cap top of line 1 to baseline of line 2)
  // is centred on the canvas, the same centre as the art. Baselines and bars
  // are rounded to whole CSS px.
  window.layout = async () => {
    await document.fonts.ready;
    const s = ${s}, H = ${H * s}, size = ${FONT * s};
    const ctx = document.createElement('canvas').getContext('2d');
    ctx.font = '500 ' + size + 'px Plex';
    const cap = ctx.measureText('H').actualBoundingBoxAscent;
    const xh = ctx.measureText('x').actualBoundingBoxAscent;
    const lead = ${LEADING} * s;
    const blockH = cap + lead;
    const base0 = Math.round(H / 2 - blockH / 2 + cap);
    const lines = [document.getElementById('l0'), document.getElementById('l1')];
    // Distance from an element's top to its baseline, read off a zero-size inline-block.
    const baseline = (el) => {
      const sp = document.createElement('span');
      sp.style.cssText = 'display:inline-block;width:0;height:0;vertical-align:baseline';
      el.prepend(sp);
      const y = sp.getBoundingClientRect().top - el.getBoundingClientRect().top;
      sp.remove();
      return y;
    };
    const asc = baseline(lines[0]);
    lines.forEach((el, i) => { el.style.top = (base0 + i * Math.round(lead) - asc) + 'px'; });
    // One monospace cell, tracking included. The bar fills the cell a hyphen would take.
    const cell = ctx.measureText('m').width + (parseFloat(getComputedStyle(lines[0]).letterSpacing) || 0);
    for (const el of lines) {
      const bar = el.querySelector('.bar');
      if (!bar) continue;
      const h = Math.round(size * 0.1);
      bar.style.left = Math.round(el.textContent.length * cell + cell * 0.08) + 'px';
      bar.style.width = Math.round(cell * 0.78) + 'px';
      bar.style.height = h + 'px';
      // Centred on the x-height: baseline - xh/2.
      bar.style.top = Math.round(asc - xh / 2 - h / 2) + 'px';
    }
    const tag = document.getElementById('tag');
    tag.style.top = Math.round(base0 - cap - ${TAG_GAP} * s - baseline(tag)) + 'px';
  };
  </script></body></html>`;
}

export async function renderBanner(browser: Browser, spec: BannerSpec, out: BannerOut, root: string, file: string) {
  const ctx = await browser.newContext({ viewport: { width: W * out.scale, height: Math.round(out.height * out.scale) }, deviceScaleFactor: out.dpr });
  const page = await ctx.newPage();
  await page.setContent(html(spec, out, root));
  await page.evaluate('window.layout()');
  await page.screenshot({ path: file });
  await ctx.close();
}

// ---------------------------------------------------------------- art helpers

export const rect = (x: number, y: number, w: number, h: number, r: number, fill = false, extra = '') =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}"${fill ? ` fill="${FG}" stroke="none"` : ''}${extra}/>`;
export const block = (x: number, y: number, w: number, h: number, r = Math.min(4, h / 2), color = FG) =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${color}" stroke="none"/>`;
export const path = (d: string, extra = '') => `<path d="${d}"${extra}/>`;
export const circle = (cx: number, cy: number, r: number, fill = false) =>
  `<circle cx="${cx}" cy="${cy}" r="${r}"${fill ? ` fill="${FG}" stroke="none"` : ''}/>`;
export { BG as ART_BG, DIM as ART_DIM };
