import { readFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { capture, launchBrowser, type DeviceShot } from './capture.js';
import { renderPreview } from './composite.js';
import {
  CATEGORY_LABELS,
  CATEGORY_ORDER,
  DEFAULT_DEVICES,
  DEVICE_ALIASES,
  DEVICES,
  resolveDevices,
  type DeviceCategory,
} from './devices.js';
import {
  COLOR_SCHEMES,
  DEFAULT_MAX_SLICES,
  DEFAULT_OUT_DIR,
  DEFAULT_SLICE_WIDTH,
  DEFAULT_TIMEOUT_MS,
  normalizeUrl,
  type ShotOptions,
} from './options.js';
import { DEFAULT_MAX_HEIGHT } from './slices.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };

const screenshotInput = {
  url: z
    .string()
    .describe('Page to capture. http(s)://, file://, a bare host like localhost:3000, or a path to a local .html file.'),
  devices: z
    .array(z.string())
    .min(1)
    .max(8)
    .optional()
    .describe(
      `Device ids or aliases (see list_devices). Default: ${DEFAULT_DEVICES.join(', ')}. ` +
        `Aliases: ${Object.keys(DEVICE_ALIASES).join(', ')}.`
    ),
  bezels: z.boolean().optional().describe('Also write a copy framed in the device bezel (above-the-fold only). Default false.'),
  fullPage: z
    .boolean()
    .optional()
    .describe(
      'Capture the full scroll height (any height, stitched; capped by maxHeight). The result then shows the whole page ' +
        'as top-to-bottom JPEG slices, one viewport tall each, after the framed first screen when bezels is on. Default false.'
    ),
  maxSlices: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .describe(
      `Full page: most slices returned inline per device. Default ${DEFAULT_MAX_SLICES}. ` +
        'When a page has more, every slice is also saved as a JPEG and the paths are listed so you can Read the rest.'
    ),
  saveSlices: z
    .boolean()
    .optional()
    .describe('Full page: always (true) or never (false) write slice JPEGs next to the PNGs. Default: only when slices were cut by maxSlices.'),
  sliceWidth: z
    .number()
    .int()
    .min(256)
    .max(1568)
    .optional()
    .describe(`Full page: max slice width in px. Default ${DEFAULT_SLICE_WIDTH}; raise it (e.g. 1200) to read small text on desktop widths.`),
  maxHeight: z
    .number()
    .int()
    .min(500)
    .max(200_000)
    .optional()
    .describe(`Full page: capture at most this many CSS px; taller pages are marked clipped. Default ${DEFAULT_MAX_HEIGHT}.`),
  reducedMotion: z
    .boolean()
    .optional()
    .describe('Emulate prefers-reduced-motion: reduce. Helps when scroll-triggered entrance animations (GSAP, Framer Motion) leave sections blank.'),
  waitFor: z.string().optional().describe('CSS selector to wait for (visible) before capturing.'),
  waitMs: z.number().int().min(0).max(30_000).optional().describe('Extra settle delay after load, in ms.'),
  colorScheme: z.enum(COLOR_SCHEMES as [string, ...string[]]).optional().describe('Emulate prefers-color-scheme.'),
  outDir: z.string().optional().describe(`Output directory, relative to the server's cwd. Default ${DEFAULT_OUT_DIR}.`),
  timeoutMs: z.number().int().min(1000).max(120_000).optional().describe(`Navigation timeout. Default ${DEFAULT_TIMEOUT_MS}.`),
  inline: z
    .boolean()
    .optional()
    .describe('Return JPEG previews inline: one per device, or the full-page slices when fullPage. Default true.'),
};

export function createServer(): McpServer {
  const server = new McpServer({ name: 'rpc', version: pkg.version });

  server.registerTool(
    'screenshot',
    {
      title: 'Screenshot at device viewports',
      description:
        'Load a URL in headless Chromium at one or more device viewports (with device pixel ratio, mobile user agent and touch) ' +
        'and save PNG screenshots, optionally framed in a device bezel. Use it to check responsive layout of a page you are building, ' +
        'including local dev servers. Returns file paths, page title, HTTP status and console errors, plus inline previews.',
      inputSchema: screenshotInput,
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async args => {
      let options: ShotOptions;
      try {
        options = {
          url: normalizeUrl(args.url),
          devices: resolveDevices(args.devices ?? DEFAULT_DEVICES).map(d => d.id),
          bezels: args.bezels ?? false,
          fullPage: args.fullPage ?? false,
          outDir: args.outDir ?? DEFAULT_OUT_DIR,
          waitFor: args.waitFor,
          waitMs: args.waitMs ?? 0,
          colorScheme: args.colorScheme as ShotOptions['colorScheme'],
          timeoutMs: args.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          emulate: true,
          reducedMotion: args.reducedMotion ?? false,
          maxHeight: args.maxHeight ?? DEFAULT_MAX_HEIGHT,
          saveSlices: args.saveSlices,
          maxSlices: args.maxSlices ?? DEFAULT_MAX_SLICES,
          sliceWidth: args.sliceWidth ?? DEFAULT_SLICE_WIDTH,
        };
      } catch (err) {
        return { isError: true, content: [{ type: 'text', text: (err as Error).message }] };
      }

      const inline = args.inline ?? true;
      const browser = await launchBrowser();
      try {
        const result = await capture(options, { browser, keepBuffers: true, inlineSlices: inline && options.fullPage });
        const content: Content[] = [
          {
            type: 'text',
            text:
              headline(result.shots, options) +
              '\n\n' +
              JSON.stringify(summarise(result.url, result.outDir, result.shots), null, 2),
          },
        ];

        if (inline) {
          for (const s of result.shots) {
            if (s.error) continue;
            if (options.fullPage) {
              content.push(...(await fullPageImages(browser, s, options.maxSlices)));
              continue;
            }
            const src = s.framed && s.buffers?.framed ? { buf: s.buffers.framed, size: s.framed } : s.shot && s.buffers?.shot ? { buf: s.buffers.shot, size: s.shot } : undefined;
            if (!src) continue;
            const p = await renderPreview(browser, src.buf, src.size);
            content.push({
              type: 'text',
              text: `${s.device}${s.framed ? ' (framed)' : ''}: preview ${p.width}x${p.height}${p.cropped ? ', cropped to top of page' : ''}`,
            });
            content.push({ type: 'image', data: p.data.toString('base64'), mimeType: 'image/jpeg' });
          }
        }
        const allFailed = result.shots.every(s => s.error);
        return allFailed ? { isError: true, content } : { content };
      } finally {
        await browser.close();
      }
    }
  );

  server.registerTool(
    'list_devices',
    {
      title: 'List device presets',
      description: 'List device ids, CSS viewport sizes and pixel ratios usable in screenshot.devices, plus short aliases.',
      inputSchema: {
        category: z
          .enum(CATEGORY_ORDER as [DeviceCategory, ...DeviceCategory[]])
          .optional()
          .describe('Filter to one category.'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ category }) => {
      const lines: string[] = [];
      for (const cat of CATEGORY_ORDER) {
        if (category && cat !== category) continue;
        lines.push(`## ${CATEGORY_LABELS[cat]}`);
        for (const d of DEVICES.filter(x => x.category === cat)) {
          lines.push(`${d.id}: ${d.width}x${d.height} @${d.dpr}x (${d.name})`);
        }
        lines.push('');
      }
      lines.push('## Aliases');
      for (const [a, id] of Object.entries(DEVICE_ALIASES)) lines.push(`${a} -> ${id}`);
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    }
  );

  return server;
}

type Content = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };

/** Framed first screen (the hero), then the first maxSlices slices, each with a label. */
async function fullPageImages(
  browser: Awaited<ReturnType<typeof launchBrowser>>,
  s: DeviceShot,
  maxSlices: number
): Promise<Content[]> {
  const out: Content[] = [];
  if (s.framed && s.buffers?.framed) {
    const p = await renderPreview(browser, s.buffers.framed, s.framed);
    out.push({ type: 'text', text: `${s.device} · first screen in bezel` });
    out.push({ type: 'image', data: p.data.toString('base64'), mimeType: 'image/jpeg' });
  }
  const items = s.slices?.items ?? [];
  const bufs = s.buffers?.slices ?? [];
  for (let i = 0; i < Math.min(items.length, maxSlices); i++) {
    out.push({ type: 'text', text: items[i]!.label });
    out.push({ type: 'image', data: bufs[i]!.toString('base64'), mimeType: 'image/jpeg' });
  }
  return out;
}

/** Plain-language first lines: failures with hints, and what full-page output covers. */
export function headline(shots: DeviceShot[], options: Pick<ShotOptions, 'fullPage' | 'maxSlices' | 'maxHeight'>): string {
  const lines: string[] = [];
  const failed = shots.filter(s => s.error);
  if (failed.length === shots.length) lines.push(`All ${shots.length} device(s) failed.`);
  for (const s of shots) {
    if (s.error) {
      lines.push(`FAILED ${s.device}: ${s.error}${s.hint ? `\n  hint: ${s.hint}` : ''}`);
      continue;
    }
    const size = s.shot ? `${s.shot.width}x${s.shot.height}px` : '';
    if (!options.fullPage) {
      lines.push(`ok ${s.device}: ${size}${s.shot ? ` ${s.shot.path}` : ''}`);
      continue;
    }
    const parts = [
      `ok ${s.device}: full page ${s.capturedHeight} css px tall (${size}` +
        `${s.segments && s.segments > 1 ? `, ${s.segments} segments stitched` : ''}) ${s.shot ? s.shot.path : ''}`,
    ];
    if (s.clipped) {
      parts.push(`  clipped: the page is ${s.scrollHeight} css px; only the top ${options.maxHeight} were captured (raise maxHeight).`);
    }
    const sl = s.slices;
    if (sl) {
      const shown = Math.min(sl.items.length, options.maxSlices);
      if (sl.total > shown) {
        const firstSkipped = sl.items[shown] ?? undefined;
        const from = firstSkipped ? firstSkipped.y : shown * sl.sliceHeight;
        parts.push(
          `  inline: slices 1-${shown} of ${sl.total}; slices ${shown + 1}-${sl.total} (y=${from}-${s.capturedHeight} css px) skipped inline.`
        );
      } else {
        parts.push(`  inline: all ${sl.total} slice(s), top to bottom.`);
      }
      if (sl.saved) {
        const first = sl.items[0]?.path;
        parts.push(
          `  slice files: ${first ? first.replace(/-slice-\d+\.jpg$/, '-slice-NN.jpg') : '(none)'} (01-${String(sl.total).padStart(2, '0')}); full PNG: ${s.shot ? s.shot.path : ''}`
        );
      } else if (sl.total > shown) {
        parts.push(`  full PNG: ${s.shot ? s.shot.path : ''}`);
      }
    }
    lines.push(parts.join('\n'));
  }
  return lines.join('\n');
}

function summarise(url: string, outDir: string, shots: DeviceShot[]) {
  return {
    url,
    outDir,
    shots: shots.map(({ buffers: _b, ...s }) => s),
  };
}

export async function runMcpServer(): Promise<void> {
  const server = createServer();
  await server.connect(new StdioServerTransport());
}
