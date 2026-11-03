// Motion: what is animating on a page, and the in-page steps that make a
// capture match what a person scrolling sees (settle, finish, unpin). Shared
// by `rpc shot` (capture.ts) and the Motion group of `rpc check`. In-page
// scripts are plain strings, as in capture.ts and check-page.ts.
import type { Page } from 'playwright';
import { HELPERS } from './check-page.js';

export interface MotionItem {
  selector: string;
  text?: string;
  value?: number;
}

export interface PinInfo {
  /** The pinned element. */
  selector: string;
  /** What reserves its scroll distance: the `.pin-spacer`, or a sticky section's tall parent. */
  spacer: string;
  kind: 'pin-spacer' | 'scrolltrigger' | 'sticky' | 'fixed';
  spacerHeight: number;
  height: number;
}

export interface MotionData {
  /** Running animations on the document timeline: finite ones and infinite loops. */
  animations: { finite: MotionItem[]; loops: MotionItem[] };
  pins: PinInfo[];
  /** Elements still at opacity ~0 or offset, with a reveal-style class, attribute or inline style. */
  hidden: MotionItem[];
  /** Carousel and marquee roots: a known library, scroll-snap, or seen moving. */
  carousels: MotionItem[];
  /** `gsap` and/or `ScrollTrigger` when they are on `window`. */
  libraries: string[];
}

export interface SettleResult {
  /** True when nothing visible was animating or changing for the quiet period before the cap. */
  settled: boolean;
  ms: number;
  /** Visible elements still animating or changing at the end (max 20 selectors). */
  active: string[];
  /** How many there were. */
  count: number;
}

export interface FinishResult {
  /** Web Animations (CSS animations and transitions included) sent to their end. */
  animations: number;
  /** GSAP tweens and timelines set to progress(1). */
  gsap: number;
  /** ScrollTrigger animations (not scrubbed, not pinned) set to progress(1). */
  scrollTriggers: number;
}

export interface UnpinResult {
  selector: string;
  spacer: string;
  kind: PinInfo['kind'];
  /** CSS px of spacer removed. */
  removed: number;
}

export interface MotionFinding {
  id: string;
  severity: 'warn' | 'info';
  message: string;
  fix: string;
  selector?: string;
  value?: number;
  items?: MotionItem[];
}

/** Final settle before a capture: quiet period and cap, in ms. */
export const SETTLE_QUIET_MS = 150;
export const SETTLE_CAP_MS = 2000;
/** Per warm-up scroll step, and for all steps together. */
export const STEP_QUIET_MS = 120;
export const STEP_CAP_MS = 800;
export const WARM_UP_BUDGET_MS = 8000;

/**
 * `__rpcSettle(quiet, cap)`: resolves when no finite animation on the
 * document timeline runs on a visible element and no `style`/`class`
 * attribute on a visible element changed for `quiet` ms, or at `cap` ms.
 * Elements still changing at the cap are remembered as loops (a JS marquee,
 * a ticker) and don't hold up later calls on the same page.
 */
const SETTLE_FN = `
  const __rpcSettle = async (quiet, cap) => {
    const loops = (window.__rpcLoops = window.__rpcLoops || new WeakSet());
    const start = performance.now();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const visible = el => {
      if (!el || el.nodeType !== 1 || !el.isConnected) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < vh && r.left < vw;
    };
    const changed = new Map();
    let last = start;
    const mo = new MutationObserver(list => {
      const now = performance.now();
      for (const m of list) {
        if (!visible(m.target)) continue;
        changed.set(m.target, now);
        if (!loops.has(m.target)) last = now;
      }
    });
    mo.observe(document.documentElement, { subtree: true, attributes: true, attributeFilter: ['style', 'class'] });
    const running = () => (document.getAnimations ? document.getAnimations() : []).filter(a => {
      if (a.playState !== 'running' || (a.timeline && a.timeline !== document.timeline)) return false;
      const t = a.effect && a.effect.getComputedTiming ? a.effect.getComputedTiming() : null;
      return Boolean(t) && t.endTime !== Infinity && visible(a.effect.target);
    });
    let settled = false;
    try {
      for (;;) {
        await new Promise(r => setTimeout(r, 30));
        const now = performance.now();
        if (now - last >= quiet && running().length === 0) { settled = true; break; }
        if (now - start >= cap) break;
      }
    } finally {
      mo.disconnect();
    }
    const now = performance.now();
    const active = new Set(running().map(a => a.effect.target));
    for (const [el, t] of changed) if (now - t < quiet && el.isConnected) active.add(el);
    if (!settled) for (const el of active) loops.add(el);
    return { settled, ms: Math.round(now - start), active: Array.from(active) };
  };
`;

/** Settle at the current scroll position (see SETTLE_FN). */
export const settleJs = (quiet = SETTLE_QUIET_MS, cap = SETTLE_CAP_MS) => `(async () => {
  ${HELPERS}
  ${SETTLE_FN}
  const r = await __rpcSettle(${quiet}, ${cap});
  return { settled: r.settled, ms: r.ms, active: r.active.slice(0, 20).map(sel), count: r.active.length };
})()`;

/**
 * Walk the page one viewport at a time so loading="lazy" images and
 * IntersectionObserver-driven content render, settling at each step, then
 * return to the top. Bounded to 100 steps and the full-page height cap; once
 * the settle budget is spent, steps fall back to a fixed 100 ms pause.
 */
export const warmUpScrollJs = (maxHeight: number) => `(async () => {
  ${SETTLE_FN}
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const root = document.scrollingElement || document.documentElement;
  const step = Math.max(200, Math.floor(window.innerHeight * 0.9));
  let spent = 0;
  let steps = 0;
  let settled = 0;
  const pause = async () => {
    steps++;
    const left = ${WARM_UP_BUDGET_MS} - spent;
    if (left < ${STEP_QUIET_MS}) return sleep(100);
    const r = await __rpcSettle(${STEP_QUIET_MS}, Math.min(${STEP_CAP_MS}, left));
    spent += r.ms;
    if (r.settled) settled++;
  };
  for (let i = 0, y = 0; i < 100 && y < ${maxHeight}; i++, y += step) {
    if (y > root.scrollHeight - window.innerHeight) break;
    window.scrollTo({ top: y, behavior: 'instant' });
    await pause();
  }
  window.scrollTo({ top: Math.min(root.scrollHeight, ${maxHeight}), behavior: 'instant' });
  await pause();
  window.scrollTo({ top: 0, behavior: 'instant' });
  await sleep(150);
  return { steps, settled, ms: Math.round(spent) };
})()`;

/**
 * Pinned sections: `.pin-spacer` wrappers (GSAP ScrollTrigger), pins
 * ScrollTrigger reports, and sticky or fixed sections (half a viewport or
 * more) that are the only child of a parent at least half a viewport
 * taller. Sets `pins` to `{ el, spacer, kind }`.
 */
const PINS_FN = `
  const pins = [];
  {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const taken = new Set();
    const h = el => el.getBoundingClientRect().height;
    const add = (el, spacer, kind) => {
      if (taken.has(el) || !spacer || spacer === document.body || spacer === document.documentElement) return;
      taken.add(el);
      pins.push({ el, spacer, kind });
    };
    for (const sp of document.querySelectorAll('.pin-spacer')) {
      const el = sp.firstElementChild;
      if (el && h(sp) - h(el) >= vh / 4) add(el, sp, 'pin-spacer');
    }
    try {
      const ST = window.ScrollTrigger;
      if (ST && typeof ST.getAll === 'function') {
        for (const st of ST.getAll()) {
          const el = st && st.pin;
          if (el && el.nodeType === 1 && el.parentElement && h(el.parentElement) - h(el) >= vh / 4) add(el, el.parentElement, 'scrolltrigger');
        }
      }
    } catch (e) {}
    for (const el of document.body ? document.body.querySelectorAll('*') : []) {
      const cs = getComputedStyle(el);
      if (cs.position !== 'sticky' && cs.position !== 'fixed') continue;
      const r = el.getBoundingClientRect();
      if (r.height < vh / 2 || r.width < vw / 2 || cs.visibility === 'hidden' || parseFloat(cs.opacity) < 0.1) continue;
      const parent = el.parentElement;
      if (!parent || parent.children.length !== 1) continue;
      if (h(parent) - r.height >= vh / 2) add(el, parent, cs.position);
    }
  }
`;

/** Detect running animations, pins, hidden reveals and carousels. `scope` 'page' looks past the viewport. */
export const motionJs = (scope: 'viewport' | 'page') => `(async () => {
  ${HELPERS}
  ${PINS_FN}
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const wholePage = ${scope === 'page'};
  const inScope = r => r.width > 0 && r.height > 0 && (wholePage || (r.bottom > -vh / 2 && r.top < vh * 1.5));
  const rounded = (n, p) => Math.round(n * 10 ** p) / 10 ** p;

  const finite = new Map();
  const loops = new Map();
  for (const a of document.getAnimations ? document.getAnimations() : []) {
    if (a.playState !== 'running' || (a.timeline && a.timeline !== document.timeline)) continue;
    const el = a.effect && a.effect.target;
    if (!el || el.nodeType !== 1 || !inScope(el.getBoundingClientRect())) continue;
    const t = a.effect.getComputedTiming();
    const kind = a.animationName !== undefined ? 'CSS animation ' + a.animationName
      : a.transitionProperty !== undefined ? 'CSS transition ' + a.transitionProperty
      : 'Web Animation' + (a.id ? ' ' + a.id : '');
    (t.endTime === Infinity ? loops : finite).set(el, kind);
  }
  const items = m => Array.from(m).slice(0, 20).map(([el, text]) => ({ selector: sel(el), text }));

  const pinInfo = pins.map(p => ({
    selector: sel(p.el),
    spacer: sel(p.spacer),
    kind: p.kind,
    spacerHeight: Math.round(p.spacer.getBoundingClientRect().height),
    height: Math.round(p.el.getBoundingClientRect().height),
  }));

  // Reveals: hidden or offset, and marked as animated content by a class,
  // a data attribute or inline styles a library wrote.
  const REVEAL_CLASS = /(^|[\\s_-])(reveal|reveals|fade|fade-in|fadein|aos|appear|animate|animated|animation|inview|in-view|is-visible|visible|scroll|motion|enter|wow|sal|slide-in|observe|observed)([\\s_-]|$)/i;
  const REVEAL_ATTRS = ['data-aos', 'data-sal', 'data-scroll', 'data-animate', 'data-animation', 'data-reveal', 'data-motion', 'data-inview', 'data-in-view', 'data-framer-appear-id'];
  const LIB_STYLE = /opacity|transform|translate|scale|visibility/i;
  const hidden = [];
  const hiddenEls = [];
  for (const el of document.body ? document.body.querySelectorAll('*') : []) {
    if (hidden.length >= 20) break;
    if (hiddenEls.some(h => h.contains(el))) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 8 || r.height < 8 || !inScope(r)) continue;
    if (el.closest('[aria-hidden="true"], [inert], [hidden], dialog:not([open])')) continue;
    const cs = getComputedStyle(el);
    if (cs.position === 'fixed') continue;
    const opacity = parseFloat(cs.opacity);
    const m = cs.transform && cs.transform !== 'none' ? new DOMMatrixReadOnly(cs.transform) : null;
    let offset = m ? Math.max(Math.abs(m.m41), Math.abs(m.m42)) : 0;
    let scale = m ? Math.hypot(m.a, m.b) : 1;
    if (cs.translate && cs.translate !== 'none') offset = Math.max(offset, ...cs.translate.split(/\\s+/).map(v => Math.abs(parseFloat(v)) || 0));
    if (cs.scale && cs.scale !== 'none') scale = Math.min(scale, parseFloat(cs.scale) || 1);
    const faded = opacity < 0.1 || cs.visibility === 'hidden';
    const moved = offset >= 24 || scale < 0.85;
    if (!faded && !moved) continue;
    const media = /^(img|svg|video|canvas|picture)$/.test(el.localName) || el.querySelector('img, svg, video, canvas, picture');
    if (!(el.textContent || '').trim() && !media) continue;
    const cls = el.getAttribute('class') || '';
    const why = REVEAL_CLASS.test(cls) ? 'reveal class' : REVEAL_ATTRS.some(a => el.hasAttribute(a)) ? 'reveal attribute' : LIB_STYLE.test(el.getAttribute('style') || '') ? 'inline style' : '';
    if (!why) continue;
    hiddenEls.push(el);
    const state = faded ? (cs.visibility === 'hidden' ? 'visibility hidden' : 'opacity ' + rounded(opacity, 2)) : scale < 0.85 ? 'scale ' + rounded(scale, 2) : 'offset ' + Math.round(offset) + 'px';
    hidden.push({ selector: sel(el), text: state + ' (' + why + ')', value: rounded(opacity, 2) });
  }

  // Carousels: library roots, horizontal scroll-snap, and tracks seen moving.
  const LIBS = [['.swiper', 'Swiper'], ['.swiper-container', 'Swiper'], ['.embla', 'Embla'], ['.splide', 'Splide'], ['.keen-slider', 'Keen'], ['.flickity-enabled', 'Flickity'], ['.slick-slider', 'Slick'], ['.glide', 'Glide'], ['[aria-roledescription="carousel"]', 'carousel']];
  const found = new Map();
  const note = (el, key, value) => found.set(el, Object.assign(found.get(el) || {}, { [key]: value }));
  for (const [s, name] of LIBS) {
    for (const el of document.querySelectorAll(s)) if (inScope(el.getBoundingClientRect())) note(el, 'lib', name);
  }
  const watch = [];
  for (const el of document.body ? document.body.querySelectorAll('*') : []) {
    if (watch.length >= 200) break;
    const r = el.getBoundingClientRect();
    if (r.width < 40 || r.height < 40 || !inScope(r)) continue;
    const cs = getComputedStyle(el);
    if (el.scrollWidth > el.clientWidth + 1 && cs.overflowX !== 'visible') {
      watch.push({ el, root: el, scroller: true });
      if (/x|inline|both/.test(cs.scrollSnapType || '')) note(el, 'snap', true);
    }
    const p = el.parentElement;
    if (p && p !== document.body && r.width > p.clientWidth + 1 && getComputedStyle(p).overflowX !== 'visible') {
      watch.push({ el, root: p, scroller: false });
    }
  }
  const pos = w => (w.scroller ? String(w.el.scrollLeft) : getComputedStyle(w.el).transform + '|' + getComputedStyle(w.el).translate);
  const before = watch.map(pos);
  await new Promise(r => setTimeout(r, 300));
  watch.forEach((w, i) => { if (pos(w) !== before[i]) note(w.root, 'moving', true); });
  const roots = Array.from(found.keys());
  const carousels = roots
    .filter(el => !roots.some(o => o !== el && o.contains(el)))
    .slice(0, 10)
    .map(el => {
      const f = found.get(el);
      return { selector: sel(el), text: [f.lib, f.snap ? 'scroll-snap' : '', f.moving ? 'moving' : ''].filter(Boolean).join(', ') };
    });

  const libraries = [];
  if (window.gsap) libraries.push('gsap');
  if (window.ScrollTrigger) libraries.push('ScrollTrigger');
  return { animations: { finite: items(finite), loops: items(loops) }, pins: pinInfo, hidden, carousels, libraries };
})()`;

/**
 * --finish-animations: every finite Web Animation to its end, then GSAP
 * when its globals are there. Scrubbed and pinned ScrollTriggers follow the
 * scroll position, so they are left alone. Each library step is guarded.
 */
export const FINISH_JS = `(() => {
  const out = { animations: 0, gsap: 0, scrollTriggers: 0 };
  for (const a of document.getAnimations ? document.getAnimations() : []) {
    try {
      if (a.playState === 'finished' || (a.timeline && a.timeline !== document.timeline)) continue;
      const t = a.effect && a.effect.getComputedTiming();
      if (!t || t.endTime === Infinity) continue;
      a.finish();
      out.animations++;
    } catch (e) {}
  }
  try {
    const ST = window.ScrollTrigger;
    if (ST && typeof ST.getAll === 'function') {
      for (const st of ST.getAll()) {
        try {
          const v = (st && st.vars) || {};
          if (v.scrub || v.pin || st.pin) continue;
          const anim = st.animation;
          if (anim && typeof anim.progress === 'function' && anim.progress() < 1) { anim.progress(1); out.scrollTriggers++; }
        } catch (e) {}
      }
    }
  } catch (e) {}
  try {
    const tl = window.gsap && window.gsap.globalTimeline;
    if (tl && typeof tl.getChildren === 'function') {
      for (const child of tl.getChildren(false, true, true)) {
        try {
          if (!child || child.scrollTrigger || typeof child.progress !== 'function') continue;
          if ((typeof child.repeat === 'function' ? child.repeat() : 0) === -1) continue;
          if (child.progress() < 1) { child.progress(1); out.gsap++; }
        } catch (e) {}
      }
    }
  } catch (e) {}
  return out;
})()`;

/**
 * Collapse each pin so the section shows once in a stitched shot. The rules
 * are `!important` in a stylesheet, which beats the inline styles a library
 * writes later (a ScrollTrigger refresh on the capture's resize).
 */
export const UNPIN_JS = `(() => {
  ${HELPERS}
  ${PINS_FN}
  if (!pins.length) return [];
  const height = el => el.getBoundingClientRect().height;
  const before = pins.map(p => height(p.spacer));
  if (!document.getElementById('rpc-unpin')) {
    const style = document.createElement('style');
    style.id = 'rpc-unpin';
    style.textContent =
      '[data-rpc-unpin="spacer"]{padding:0!important;height:auto!important;min-height:0!important;max-height:none!important}' +
      '[data-rpc-unpin="pin"]{position:relative!important;top:auto!important;left:auto!important;right:auto!important;bottom:auto!important;transform:none!important;translate:none!important}' +
      '[data-rpc-unpin="track"]{height:auto!important;min-height:0!important;padding-bottom:0!important}';
    (document.head || document.documentElement).appendChild(style);
  }
  const out = pins.map(p => ({ selector: sel(p.el), spacer: sel(p.spacer), kind: p.kind }));
  for (const p of pins) {
    if (p.kind === 'sticky') {
      p.spacer.setAttribute('data-rpc-unpin', 'track');
    } else {
      p.spacer.setAttribute('data-rpc-unpin', 'spacer');
      p.el.setAttribute('data-rpc-unpin', 'pin');
    }
  }
  return out.map((o, i) => ({ ...o, removed: Math.max(0, Math.round(before[i] - height(pins[i].spacer))) }));
})()`;

export async function settleMotion(page: Page, quiet = SETTLE_QUIET_MS, cap = SETTLE_CAP_MS): Promise<SettleResult> {
  return (await page.evaluate(settleJs(quiet, cap))) as SettleResult;
}

export async function detectMotion(page: Page, scope: 'viewport' | 'page'): Promise<MotionData> {
  return (await page.evaluate(motionJs(scope))) as MotionData;
}

export async function finishAnimations(page: Page): Promise<FinishResult> {
  return (await page.evaluate(FINISH_JS)) as FinishResult;
}

export async function unpin(page: Page): Promise<UnpinResult[]> {
  return (await page.evaluate(UNPIN_JS)) as UnpinResult[];
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const STILL_FIX =
  'Captures catch these mid-way. Use rpc shot --finish-animations to jump them to their end state, --wait <ms> to give ' +
  'them time, or --reduced-motion if the page skips animations under prefers-reduced-motion.';
const REVEAL_FIX =
  'Reveal-on-scroll content waits at opacity 0 or offset until it animates in. Try rpc shot --finish-animations or ' +
  '--reduced-motion, and make sure the content still shows when JavaScript or animations are off.';

function carouselFix(items: MotionItem[]): string {
  return `A still shows one slide. Record it: rpc record <url> --selector '${items[0]?.selector ?? '<css>'}' --duration 5.`;
}

/** `rpc shot` warnings: what the image shows differently from a person scrolling. */
export function shotWarnings(
  d: MotionData,
  settle: SettleResult,
  ctx: { fullPage: boolean; unpinned?: UnpinResult[] | undefined }
): MotionFinding[] {
  const out: MotionFinding[] = [];
  if (settle.count > 0) {
    out.push({
      id: 'motion-running',
      severity: 'warn',
      message: `${plural(settle.count, 'element was', 'elements were')} still animating when captured`,
      fix: STILL_FIX,
      value: settle.count,
      items: settle.active.map(selector => ({ selector })),
    });
  }
  if (ctx.fullPage) {
    const collapsed = new Set((ctx.unpinned ?? []).filter(u => u.removed > 0).map(u => u.selector));
    const left = d.pins.filter(p => !collapsed.has(p.selector));
    if (left.length) {
      out.push({
        id: 'motion-pinned',
        severity: 'warn',
        message: 'pinned section: the stitched shot may show blank space',
        fix:
          'Leave unpinning on (the default with --full-page; --no-unpin turns it off) so each pin is collapsed to its ' +
          'section, or record the section with rpc record --selector.',
        items: left.map(pinItem),
      });
    }
  }
  if (d.hidden.length) {
    out.push({
      id: 'motion-reveal-hidden',
      severity: 'warn',
      message: `${plural(d.hidden.length, 'element')} still hidden by a reveal animation`,
      fix: REVEAL_FIX,
      items: d.hidden,
    });
  }
  if (d.carousels.length) {
    out.push({ id: 'motion-carousel', severity: 'warn', message: 'carousel: use `rpc record` for motion', fix: carouselFix(d.carousels), items: d.carousels });
  }
  return out;
}

/** `rpc check` Motion findings. Warn or info only: motion is a capture concern, not a launch blocker. */
export function motionCheckFindings(d: MotionData, settle: SettleResult): MotionFinding[] {
  const out: MotionFinding[] = [];
  const running = new Map<string, MotionItem>();
  for (const s of settle.active) running.set(s, { selector: s });
  for (const a of d.animations.finite) running.set(a.selector, a);
  const loops = d.animations.loops.filter(a => !running.has(a.selector));
  if (running.size) {
    out.push({
      id: 'motion-running',
      severity: 'warn',
      message: `${plural(running.size, 'element')} still animating after load`,
      fix: STILL_FIX,
      selector: [...running.keys()][0]!,
      items: [...running.values()].slice(0, 20),
    });
  }
  if (d.hidden.length) {
    out.push({
      id: 'motion-reveal-hidden',
      severity: 'warn',
      message: `${plural(d.hidden.length, 'element')} in or near the viewport still hidden by a reveal animation`,
      fix: REVEAL_FIX,
      selector: d.hidden[0]!.selector,
      items: d.hidden,
    });
  }
  if (loops.length) {
    out.push({
      id: 'motion-loop',
      severity: 'info',
      message: `${plural(loops.length, 'infinite animation')} (loops never settle, so a shot shows one frame)`,
      fix: 'Stop decorative loops under prefers-reduced-motion: reduce; rpc shot --reduced-motion shows what that looks like.',
      selector: loops[0]!.selector,
      items: loops,
    });
  }
  if (d.pins.length) {
    out.push({
      id: 'motion-pinned',
      severity: 'info',
      message: `${plural(d.pins.length, 'pinned section')}: a stitched full-page shot would show the spacer as blank space`,
      fix: 'rpc shot --full-page collapses pins by default (listed under motion.unpinned in the result); rpc record --selector shows the pinned animation.',
      selector: d.pins[0]!.selector,
      items: d.pins.map(pinItem),
    });
  }
  if (d.carousels.length) {
    out.push({
      id: 'motion-carousel',
      severity: 'info',
      message: `${plural(d.carousels.length, 'carousel or marquee', 'carousels or marquees')}: a still shows one frame`,
      fix: carouselFix(d.carousels),
      selector: d.carousels[0]!.selector,
      items: d.carousels,
    });
  }
  return out;
}

/** `#a, .b +2 more`: where a warning applies, for one-line output. */
export function warningWhere(w: MotionFinding, max = 3): string {
  const sels = (w.items ?? []).map(i => i.selector).filter(Boolean);
  if (!sels.length) return '';
  return sels.slice(0, max).join(', ') + (sels.length > max ? ` +${sels.length - max} more` : '');
}

/** One line per collapsed pin: `#pinned (2100 css px of spacer removed)`. */
export function unpinnedLines(unpinned: UnpinResult[] | undefined): string[] {
  return (unpinned ?? []).filter(u => u.removed > 0).map(u => `${u.selector} (${u.removed} css px of spacer removed)`);
}

function pinItem(p: PinInfo): MotionItem {
  return { selector: p.selector, text: `${p.spacerHeight}px ${p.kind === 'sticky' ? 'track' : 'spacer'} for a ${p.height}px section`, value: p.spacerHeight - p.height };
}
