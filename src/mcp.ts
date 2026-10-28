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
import { COLOR_SCHEMES, DEFAULT_OUT_DIR, DEFAULT_TIMEOUT_MS, normalizeUrl, type ShotOptions } from './options.js';

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
  fullPage: z.boolean().optional().describe('Capture the full scroll height instead of just the viewport. Default false.'),
  waitFor: z.string().optional().describe('CSS selector to wait for (visible) before capturing.'),
  waitMs: z.number().int().min(0).max(30_000).optional().describe('Extra settle delay after load, in ms.'),
  colorScheme: z.enum(COLOR_SCHEMES as [string, ...string[]]).optional().describe('Emulate prefers-color-scheme.'),
  outDir: z.string().optional().describe(`Output directory, relative to the server's cwd. Default ${DEFAULT_OUT_DIR}.`),
  timeoutMs: z.number().int().min(1000).max(120_000).optional().describe(`Navigation timeout. Default ${DEFAULT_TIMEOUT_MS}.`),
  inline: z
    .boolean()
    .optional()
    .describe('Return a downscaled JPEG preview of each shot inline (max 1024px; tall pages cropped to the top). Default true.'),
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
        };
      } catch (err) {
        return { isError: true, content: [{ type: 'text', text: (err as Error).message }] };
      }

      const browser = await launchBrowser();
      try {
        const result = await capture(options, { browser, keepBuffers: true });
        const content: Array<
          { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }
        > = [{ type: 'text', text: JSON.stringify(summarise(result.url, result.outDir, result.shots), null, 2) }];

        if (args.inline ?? true) {
          for (const s of result.shots) {
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
