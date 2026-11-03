// In-page scripts for `rpc check`. Plain strings, like the ones in
// capture.ts: under tsx/vitest, esbuild wraps named functions in a
// `__name()` helper that doesn't exist inside the page.

/** Shared helpers: a short unique selector, rendering tests and accessible names. */
export const HELPERS = `
  const esc = s => (window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/[^\\w-]/g, '\\\\$&'));
  const uniq = s => { try { return document.querySelectorAll(s).length === 1; } catch (e) { return false; } };
  const sel = el => {
    if (!el || el.nodeType !== 1) return '';
    if (el.id && uniq('#' + esc(el.id))) return '#' + esc(el.id);
    const parts = [];
    for (let node = el; node && node.nodeType === 1 && parts.length < 6; node = node.parentElement) {
      if (node === document.documentElement) { parts.unshift('html'); break; }
      if (node === document.body) { parts.unshift('body'); break; }
      if (node.id && uniq('#' + esc(node.id))) { parts.unshift('#' + esc(node.id)); break; }
      let part = node.localName;
      const cls = Array.from(node.classList).filter(c => /^[A-Za-z_-][\\w-]*$/.test(c) && c.length <= 32).slice(0, 2);
      if (cls.length) part += '.' + cls.join('.');
      const parent = node.parentElement;
      if (parent && !uniq([part, ...parts].join(' > '))) {
        const same = Array.from(parent.children).filter(c => c.localName === node.localName);
        if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(node) + 1) + ')';
      }
      parts.unshift(part);
      if (uniq(parts.join(' > '))) break;
    }
    return parts.join(' > ');
  };
  const tag = el => {
    const t = el.outerHTML.slice(0, el.outerHTML.indexOf('>') + 1);
    return t.length > 90 ? t.slice(0, 89) + '…>' : t;
  };
  /** In the accessibility tree: rendered, not visibility:hidden, not aria-hidden or inert. */
  const exposed = el => {
    if (el.closest('[aria-hidden="true"], [inert]')) return false;
    return el.checkVisibility ? el.checkVisibility({ visibilityProperty: true }) : el.getClientRects().length > 0;
  };
  /** Painted and big enough to see or tap. */
  const painted = el => {
    if (el.checkVisibility && !el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return false;
    const r = el.getBoundingClientRect();
    return r.width >= 2 && r.height >= 2;
  };
  const hiddenNode = e => {
    if (e.getAttribute('aria-hidden') === 'true') return true;
    const cs = getComputedStyle(e);
    return cs.display === 'none' || cs.visibility === 'hidden';
  };
  const pseudoText = (e, which) => {
    const c = getComputedStyle(e, which).content;
    if (!c || c === 'none' || c === 'normal') return '';
    const m = /^"(.*)"$/.exec(c);
    // Icon fonts put private-use code points in content; those aren't names.
    return m ? m[1].replace(/[\\uE000-\\uF8FF]/g, '') : '';
  };
  const textOf = node => {
    let out = node.nodeType === 1 ? pseudoText(node, '::before') : '';
    for (const n of node.childNodes) {
      if (n.nodeType === 3) { out += n.textContent; continue; }
      if (n.nodeType !== 1 || hiddenNode(n)) continue;
      const label = n.getAttribute('aria-label');
      if (label && label.trim()) { out += ' ' + label + ' '; continue; }
      if (n.localName === 'img' || n.localName === 'area' || (n.localName === 'input' && n.type === 'image')) {
        out += ' ' + (n.getAttribute('alt') || '') + ' ';
        continue;
      }
      if (n.localName === 'svg') {
        const t = n.querySelector('title');
        if (t) out += ' ' + t.textContent + ' ';
        continue;
      }
      out += ' ' + textOf(n) + ' ';
    }
    if (node.nodeType === 1) out += pseudoText(node, '::after');
    return out;
  };
  const clean = s => (s || '').replace(/\\s+/g, ' ').trim();
  /** Accessible name, close enough to the accname algorithm for "is it empty?". */
  const nameOf = el => {
    const by = el.getAttribute('aria-labelledby');
    if (by) {
      const t = clean(by.split(/\\s+/).map(id => document.getElementById(id)).filter(Boolean).map(n => textOf(n)).join(' '));
      if (t) return t;
    }
    const label = clean(el.getAttribute('aria-label'));
    if (label) return label;
    const field = el.localName === 'input' || el.localName === 'select' || el.localName === 'textarea';
    if (field && el.labels && el.labels.length) {
      const t = clean(Array.from(el.labels).map(l => textOf(l)).join(' '));
      if (t) return t;
    }
    if (el.localName === 'input') {
      if (el.type === 'submit' || el.type === 'reset' || el.type === 'button') return clean(el.value) || (el.type === 'button' ? '' : el.type);
      if (el.type === 'image') return clean(el.getAttribute('alt'));
    }
    if (el.localName === 'img') return clean(el.getAttribute('alt'));
    if (!field) {
      const t = clean(textOf(el));
      if (t) return t;
    }
    return clean(el.getAttribute('title'));
  };
`;

/**
 * Init script: record every layout-shift entry with its sources' selectors
 * (taken when the entry arrives, before the node can be removed).
 */
export const LAYOUT_SHIFT_INIT_JS = `(() => {
  if (window.top !== window || !window.PerformanceObserver) return;
  ${HELPERS}
  const shifts = (window.__rpcShifts = []);
  const rect = r => r ? { x: r.x, y: r.y, width: r.width, height: r.height } : null;
  try {
    new PerformanceObserver(list => {
      for (const e of list.getEntries()) {
        shifts.push({
          value: e.value,
          startTime: e.startTime,
          hadRecentInput: e.hadRecentInput,
          sources: (e.sources || []).map(s => ({
            selector: s.node && s.node.nodeType === 1 ? sel(s.node) : s.node && s.node.parentElement ? sel(s.node.parentElement) : '',
            previousRect: rect(s.previousRect),
            currentRect: rect(s.currentRect),
          })),
        });
      }
    }).observe({ type: 'layout-shift', buffered: true });
  } catch (e) {}
})()`;

export const LAYOUT_SHIFTS_JS = `(window.__rpcShifts || [])`;

/** Scroll down one viewport and back, pausing so lazy content and shifts land. */
export const SCROLL_ONCE_JS = `(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  window.scrollTo({ top: window.innerHeight, behavior: 'instant' });
  await sleep(300);
  window.scrollTo({ top: 0, behavior: 'instant' });
  await sleep(300);
})()`;

export const META_JS = `(() => {
  const attr = (s, a) => { const e = document.querySelector(s); return e ? e.getAttribute(a) : null; };
  const meta = key => attr('meta[property="' + key + '"], meta[name="' + key + '"]', 'content');
  return {
    title: document.querySelector('title') ? document.title : null,
    lang: document.documentElement.getAttribute('lang'),
    description: attr('meta[name="description"]', 'content'),
    canonical: attr('link[rel~="canonical"]', 'href'),
    viewport: attr('meta[name="viewport"]', 'content'),
    icons: Array.from(document.querySelectorAll('link[rel~="icon"]')).map(l => l.href),
    appleTouchIcon: Boolean(document.querySelector('link[rel~="apple-touch-icon"], link[rel~="apple-touch-icon-precomposed"]')),
    og: { title: meta('og:title'), description: meta('og:description'), image: meta('og:image'), url: meta('og:url') },
    twitterCard: meta('twitter:card'),
    themeColor: attr('meta[name="theme-color"]', 'content'),
    baseUrl: document.baseURI,
  };
})()`;

export const LABELS_JS = `(() => {
  ${HELPERS}
  const controls = [];
  for (const el of document.querySelectorAll('button, a[href], [role="button"], [role="link"], input[type="button"], input[type="submit"], input[type="reset"], input[type="image"]')) {
    if (!exposed(el)) continue;
    if (!nameOf(el)) controls.push({ selector: sel(el), text: tag(el), kind: el.localName === 'a' || el.getAttribute('role') === 'link' ? 'link' : 'button' });
  }
  const images = [];
  for (const el of document.querySelectorAll('img:not([alt])')) {
    const role = el.getAttribute('role');
    if (role === 'presentation' || role === 'none' || !exposed(el)) continue;
    images.push({ selector: sel(el), text: tag(el) });
  }
  const fields = [];
  const skip = new Set(['hidden', 'submit', 'reset', 'button', 'image']);
  for (const el of document.querySelectorAll('input, select, textarea')) {
    if (el.localName === 'input' && skip.has(el.type)) continue;
    if (!exposed(el) || nameOf(el)) continue;
    fields.push({ selector: sel(el), text: tag(el), placeholder: Boolean(clean(el.getAttribute('placeholder'))) });
  }
  return { controls, images, fields };
})()`;

export const FONTS_JS = `(() => {
  ${HELPERS}
  const faces = [];
  const unreadable = [];
  const unquote = s => clean(s).replace(/^["']|["']$/g, '');
  const walk = (rules, base) => {
    for (const r of rules) {
      if (r.type === 5) {
        const s = r.style;
        const src = s.getPropertyValue('src');
        const urls = [];
        src.replace(/url\\(\\s*(['"]?)(.*?)\\1\\s*\\)/g, (_, q, u) => { try { urls.push(new URL(u, base).href); } catch (e) {} return ''; });
        faces.push({ family: unquote(s.getPropertyValue('font-family')), display: clean(s.getPropertyValue('font-display')), urls, sheet: base });
      } else if (r.type === 3 && r.styleSheet) {
        try { walk(r.styleSheet.cssRules, r.styleSheet.href || base); } catch (e) { if (r.styleSheet.href) unreadable.push(r.styleSheet.href); }
      } else if (r.cssRules) {
        walk(r.cssRules, base);
      }
    }
  };
  for (const sheet of document.styleSheets) {
    try { walk(sheet.cssRules, sheet.href || location.href); } catch (e) { if (sheet.href) unreadable.push(sheet.href); }
  }
  // Families that render text in the first (layout) viewport.
  const vw = document.documentElement.clientWidth;
  const vh = document.documentElement.clientHeight;
  const aboveFold = new Set();
  const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  for (let n = walker.nextNode(), i = 0; n && i < 3000; n = walker.nextNode(), i++) {
    if (!n.textContent.trim() || !n.parentElement) continue;
    range.selectNodeContents(n);
    const r = range.getBoundingClientRect();
    if (r.width === 0 || r.bottom <= 0 || r.top >= vh || r.right <= 0 || r.left >= vw) continue;
    const cs = getComputedStyle(n.parentElement);
    if (cs.visibility === 'hidden') continue;
    for (const f of cs.fontFamily.split(',')) aboveFold.add(unquote(f).toLowerCase());
  }
  const loaded = [];
  if (document.fonts) for (const f of document.fonts) if (f.status === 'loaded') loaded.push(unquote(f.family).toLowerCase());
  const preloads = Array.from(document.querySelectorAll('link[rel~="preload"][as="font"]')).map(l => ({
    href: l.href,
    crossorigin: l.hasAttribute('crossorigin'),
  }));
  return { faces, unreadable: Array.from(new Set(unreadable)), aboveFold: Array.from(aboveFold), loaded: Array.from(new Set(loaded)), preloads };
})()`;

export const MOBILE_JS = `(() => {
  ${HELPERS}
  // 100vh in height properties of rules that apply, and inline styles.
  const vh = /(^|[^\\d.])100(\\.0+)?vh/;
  const props = ['height', 'min-height', 'max-height', 'block-size', 'min-block-size', 'max-block-size'];
  const rules = [];
  const walk = list => {
    for (const r of list) {
      if (r.type === 4) { if (matchMedia(r.media.mediaText).matches) walk(r.cssRules); continue; }
      if (r.type === 12) { if (CSS.supports(r.conditionText)) walk(r.cssRules); continue; }
      if (r.type === 3) { try { if (r.styleSheet) walk(r.styleSheet.cssRules); } catch (e) {} continue; }
      if (r.type === 1) {
        for (const p of props) {
          const v = r.style.getPropertyValue(p);
          if (vh.test(v)) rules.push({ selector: r.selectorText, decl: p + ': ' + v });
        }
      }
      if (r.cssRules) walk(r.cssRules);
    }
  };
  for (const sheet of document.styleSheets) { try { walk(sheet.cssRules); } catch (e) {} }
  const vhHits = [];
  const seen = new Set();
  const add = (el, decl) => {
    if (seen.has(el) || !painted(el)) return;
    seen.add(el);
    vhHits.push({ selector: sel(el), text: decl, value: Math.round(el.getBoundingClientRect().height) });
  };
  for (const r of rules) {
    let els = [];
    try { els = document.querySelectorAll(r.selector); } catch (e) {}
    for (const el of els) add(el, r.decl + ' (' + r.selector + ')');
  }
  for (const el of document.querySelectorAll('[style*="vh"]')) {
    for (const p of props) { const v = el.style.getPropertyValue(p); if (vh.test(v)) add(el, p + ': ' + v + ' (inline style)'); }
  }

  // Horizontal overflow: the outermost elements that stick out past the
  // layout viewport. Not innerWidth: a phone zooms out to fit wide content,
  // which makes innerWidth the content width.
  const vw = document.documentElement.clientWidth;
  const root = document.scrollingElement || document.documentElement;
  const scrollWidth = Math.max(root.scrollWidth, document.body ? document.body.scrollWidth : 0);
  const overflow = [];
  if (scrollWidth > vw + 1) {
    const offenders = new Set();
    const clipped = el => {
      for (let p = el.parentElement; p && p !== document.body && p !== document.documentElement; p = p.parentElement) {
        const cs = getComputedStyle(p);
        if (cs.position === 'fixed' || cs.overflowX !== 'visible') return true;
      }
      return false;
    };
    for (const el of document.body.querySelectorAll('*')) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0 || (r.right <= vw + 1 && r.left >= -1)) continue;
      if (getComputedStyle(el).position === 'fixed' || clipped(el)) continue;
      offenders.add(el);
    }
    const outer = Array.from(offenders).filter(el => !offenders.has(el.parentElement));
    outer.sort((a, b) => b.getBoundingClientRect().right - a.getBoundingClientRect().right);
    for (const el of outer.slice(0, 5)) {
      const r = el.getBoundingClientRect();
      const by = Math.round(Math.max(r.right - vw, -r.left));
      overflow.push({ selector: sel(el), text: Math.round(r.width) + 'px wide, ' + by + 'px past the edge', value: by });
    }
  }

  // Tap targets under 44x44 CSS px. Inline links in a sentence are exempt
  // (WCAG 2.5.8): display inline, with letters or digits outside any control
  // in the same block of text. Buttons and links laid out as boxes count.
  const interactive = 'a[href], button, input:not([type="hidden"]), select, textarea, summary, [role="button"], [role="link"], [role="checkbox"], [role="switch"], [role="tab"], [role="menuitem"]';
  const blockOf = node => {
    let p = node.parentElement;
    while (p && p !== document.body && ['inline', 'contents'].includes(getComputedStyle(p).display)) p = p.parentElement;
    return p;
  };
  const inSentence = el => {
    const isLink = (el.localName === 'a' && !el.hasAttribute('role')) || el.getAttribute('role') === 'link';
    if (!isLink || getComputedStyle(el).display !== 'inline') return false;
    const block = blockOf(el);
    if (!block) return false;
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (!/[\\p{L}\\p{N}]/u.test(n.textContent)) continue;
      if (n.parentElement.closest(interactive) || blockOf(n) !== block) continue;
      return true;
    }
    return false;
  };
  const small = [];
  let tapTargets = 0;
  for (const el of document.querySelectorAll(interactive)) {
    if (!painted(el) || el.closest('[aria-hidden="true"], [inert]')) continue;
    const outerTarget = el.parentElement && el.parentElement.closest(interactive);
    if (outerTarget) continue;
    if (inSentence(el)) continue;
    tapTargets++;
    let { width, height } = el.getBoundingClientRect();
    if (el.labels) for (const l of el.labels) {
      const r = l.getBoundingClientRect();
      width = Math.max(width, r.width);
      height = Math.max(height, r.height);
    }
    if (width < 44 || height < 44) small.push({ selector: sel(el), text: Math.round(width) + '×' + Math.round(height), value: Math.round(Math.min(width, height)), area: width * height });
  }
  small.sort((a, b) => a.area - b.area);

  // Text fields under 16px: iOS Safari zooms the page when they get focus.
  const zoom = [];
  const noText = new Set(['hidden', 'checkbox', 'radio', 'range', 'color', 'file', 'submit', 'reset', 'button', 'image']);
  for (const el of document.querySelectorAll('input, select, textarea')) {
    if (el.localName === 'input' && noText.has(el.type)) continue;
    if (!painted(el)) continue;
    const size = parseFloat(getComputedStyle(el).fontSize);
    if (size < 16) zoom.push({ selector: sel(el), text: size + 'px', value: size });
  }

  return {
    viewportWidth: vw,
    scrollWidth,
    vh: vhHits,
    overflow,
    tapTargets,
    smallTargets: small.map(({ area, ...rest }) => rest),
    zoom,
  };
})()`;
