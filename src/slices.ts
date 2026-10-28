/** A vertical range of the page, in CSS px. */
export interface Band {
  y: number;
  height: number;
}

export interface SliceSpec extends Band {
  /** 1-based. */
  index: number;
  total: number;
  label: string;
}

/** Chromium can't produce a bitmap taller than this in one capture. */
export const MAX_CAPTURE_PX = 16_384;
/** Device px per stitched segment: well under the limit, a few MB raw each. */
export const SEGMENT_PX = 8_192;
/** Default absolute cap on full-page height, in CSS px. */
export const DEFAULT_MAX_HEIGHT = 60_000;

const isWhole = (n: number) => Math.abs(n - Math.round(n)) < 1e-6;

/**
 * Split `totalCss` into capture segments of at most `maxDevicePx` device px.
 * Every segment but the last is a CSS height whose device height is a whole
 * number of pixels (e.g. multiples of 8 at DPR 2.625), so stitched seams
 * land exactly on pixel rows.
 */
export function planSegments(totalCss: number, dpr: number, maxDevicePx = SEGMENT_PX): Band[] {
  const total = Math.max(1, Math.ceil(totalCss));
  let seg = Math.max(1, Math.floor(maxDevicePx / dpr));
  while (seg > 1 && !isWhole(seg * dpr)) seg--;
  const out: Band[] = [];
  for (let y = 0; y < total; y += seg) out.push({ y, height: Math.min(seg, total - y) });
  return out;
}

/** True when a page this tall fits a single Chromium capture. */
export function fitsOneCapture(totalCss: number, dpr: number): boolean {
  return Math.ceil(totalCss) * dpr <= MAX_CAPTURE_PX;
}

/**
 * Cut a page into top-to-bottom review slices of `sliceHeight` CSS px (one
 * viewport by default). A last slice shorter than a fifth of `sliceHeight` is
 * folded into the one before it rather than shown as a sliver.
 */
export function planSlices(device: string, totalCss: number, sliceHeight: number): SliceSpec[] {
  const total = Math.max(1, Math.round(totalCss));
  const step = Math.max(1, Math.round(sliceHeight));
  const bands: Band[] = [];
  for (let y = 0; y < total; y += step) bands.push({ y, height: Math.min(step, total - y) });
  if (bands.length > 1 && bands[bands.length - 1]!.height < step / 5) {
    const last = bands.pop()!;
    bands[bands.length - 1]!.height += last.height;
  }
  return bands.map((b, i) => ({
    ...b,
    index: i + 1,
    total: bands.length,
    label: sliceLabel(device, i + 1, bands.length, b),
  }));
}

export function sliceLabel(device: string, index: number, total: number, b: Band): string {
  return `${device} · slice ${index}/${total} · y=${b.y}–${b.y + b.height} css px`;
}

/**
 * Preview scale (output px per CSS px) for slices: as sharp as the capture
 * allows (never above the DPR) but no wider than `maxWidth`.
 */
export function sliceScale(cssWidth: number, dpr: number, maxWidth: number): number {
  return Math.min(dpr, maxWidth / cssWidth);
}
