import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';
import type { AuthOptions } from './auth.js';
import { DEFAULT_DEVICES } from './devices.js';
import { DEFAULT_MAX_HEIGHT } from './slices.js';

export type ColorScheme = 'light' | 'dark' | 'no-preference';
export const COLOR_SCHEMES: readonly ColorScheme[] = ['light', 'dark', 'no-preference'];

export interface ShotOptions {
  url: string;
  devices: string[];
  bezels: boolean;
  fullPage: boolean;
  outDir: string;
  waitFor?: string | undefined;
  waitMs: number;
  colorScheme?: ColorScheme | undefined;
  timeoutMs: number;
  /** Mobile UA + touch for phones/tablets. False = viewport + DPR only. */
  emulate: boolean;
  /** Emulate prefers-reduced-motion: reduce. */
  reducedMotion: boolean;
  /** Full-page cap in CSS px; taller pages are cut off and marked clipped. */
  maxHeight: number;
  /**
   * Write full-page review slices (`<stem>-slice-NN.jpg`) to disk.
   * Undefined = only when inline slices were cut by maxSlices (MCP).
   */
  saveSlices?: boolean | undefined;
  /** Inline slices per device (MCP). */
  maxSlices: number;
  /** Slice JPEG width cap, px. */
  sliceWidth: number;
  /** Cookies, headers, storage state and saved-session use. */
  auth?: AuthOptions | undefined;
}

export const DEFAULT_MAX_SLICES = 10;
export const DEFAULT_SLICE_WIDTH = 768;

export const DEFAULT_OUT_DIR = '.rpc-shots';
export const DEFAULT_TIMEOUT_MS = 30_000;

export function defaultShotOptions(url: string): ShotOptions {
  return {
    url: normalizeUrl(url),
    devices: [...DEFAULT_DEVICES],
    bezels: false,
    fullPage: false,
    outDir: DEFAULT_OUT_DIR,
    waitMs: 0,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    emulate: true,
    reducedMotion: false,
    maxHeight: DEFAULT_MAX_HEIGHT,
    maxSlices: DEFAULT_MAX_SLICES,
    sliceWidth: DEFAULT_SLICE_WIDTH,
  };
}

/**
 * Accept what an agent is likely to type:
 *   http(s)://…, file://…  -> unchanged
 *   localhost:3000/x, 127.0.0.1:8080, [::1]:3000 -> http://
 *   ./page.html, /abs/page.html (existing file) -> file://
 *   example.com -> https://
 */
export function normalizeUrl(input: string, cwd = process.cwd()): string {
  const raw = input.trim();
  if (!raw) throw new Error('URL is required');
  if (/^(https?|file):\/\//i.test(raw)) return new URL(raw).href;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    throw new Error(`Unsupported URL scheme in "${raw}" (use http, https or file)`);
  }
  if (/^(localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|\[::1\])(:\d+)?(\/|$)/i.test(raw)) {
    return new URL(`http://${raw}`).href;
  }
  const asPath = isAbsolute(raw) ? raw : resolve(cwd, raw);
  if ((raw.startsWith('.') || raw.startsWith('/') || /\.html?$/i.test(raw)) && existsSync(asPath)) {
    return pathToFileURL(asPath).href;
  }
  return new URL(`https://${raw}`).href;
}
