// Ported from responsive-point-check lib/bezel-asset.ts (MIT). Portrait only;
// the browser-extension fetch/cache is replaced by reading from assets/bezels.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BezelKind, Device } from './devices.js';

/** assets/ sits one level above both src/ (tsx) and dist/ (built). */
export const ASSETS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'assets');

export interface ScreenRect {
  x: number;
  y: number;
  width: number;
  height: number;
  radius: number;
}

export interface BezelLayout {
  /** Path relative to assets/, e.g. `bezels/ipad.svg`. */
  src: string;
  outerWidth: number;
  outerHeight: number;
  screen: ScreenRect;
}

interface Padding {
  top?: number; right?: number; bottom?: number; left?: number;
  topRatio?: number; rightRatio?: number; bottomRatio?: number; leftRatio?: number;
  radius?: number;
  radiusRatio?: number;
}

/** Per-kind padding around the viewport, verbatim from RPC. Ratios are
 *  fractions of the viewport dimension so the artwork scales uniformly. */
export const BEZEL_PADDING: Record<BezelKind, Padding> = {
  'phone-island': {
    topRatio: 32 / 874,
    bottomRatio: 38 / 874,
    leftRatio: 22 / 402,
    rightRatio: 22 / 402,
    radiusRatio: 50 / 402,
  },
  'phone-notch': {
    topRatio: 28 / 848,
    bottomRatio: 36 / 848,
    leftRatio: 20 / 407,
    rightRatio: 20 / 407,
    radiusRatio: 50 / 407,
  },
  'phone-classic': {
    topRatio: 28 / 850,
    bottomRatio: 36 / 850,
    leftRatio: 18 / 410,
    rightRatio: 22 / 410,
    radiusRatio: 50 / 410,
  },
  'phone-home': { top: 60, right: 14, bottom: 60, left: 14, radius: 4 },
  tablet: { top: 56, right: 50, bottom: 56, left: 50, radius: 36 },
  laptop: {
    top: 10, right: 180, bottom: 60, left: 180,
    radius: 22,
    radiusRatio: 32 / 2032.8,
  },
  monitor: {
    top: 0, right: 0, bottom: 320, left: 0,
    radius: 20,
    radiusRatio: 20 / 3082,
  },
};

export function bezelLayoutFor(device: Device): BezelLayout {
  const src = device.bezelSrc ?? `bezels/${device.bezel}.svg`;
  if (device.bezelLayout) {
    const o = device.bezelLayout;
    return { src, outerWidth: o.outerWidth, outerHeight: o.outerHeight, screen: { ...o.screen } };
  }

  const w = device.width;
  const h = device.height;
  const p = BEZEL_PADDING[device.bezel];
  const top = p.topRatio !== undefined ? Math.round(h * p.topRatio) : p.top ?? 0;
  const bottom = p.bottomRatio !== undefined ? Math.round(h * p.bottomRatio) : p.bottom ?? 0;
  const left = p.leftRatio !== undefined ? Math.round(w * p.leftRatio) : p.left ?? 0;
  const right = p.rightRatio !== undefined ? Math.round(w * p.rightRatio) : p.right ?? 0;
  const radius = p.radiusRatio !== undefined ? Math.round(w * p.radiusRatio) : p.radius ?? 0;

  return {
    src,
    outerWidth: w + left + right,
    outerHeight: h + top + bottom,
    screen: { x: left, y: top, width: w, height: h, radius },
  };
}

const svgCache = new Map<string, string>();

export function loadBezelSvg(src: string): string {
  let svg = svgCache.get(src);
  if (svg === undefined) {
    svg = readFileSync(resolve(ASSETS_DIR, src), 'utf8');
    svgCache.set(src, svg);
  }
  return svg;
}
