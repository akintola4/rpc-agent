import { parseArgs } from 'node:util';
import { resolveDevices } from './devices.js';
import {
  COLOR_SCHEMES,
  defaultShotOptions,
  type ColorScheme,
  type ShotOptions,
} from './options.js';

export type Command =
  | { command: 'shot'; options: ShotOptions; json: boolean }
  | { command: 'devices'; json: boolean }
  | { command: 'mcp' }
  | { command: 'doctor'; json: boolean }
  | { command: 'install' }
  | { command: 'help' }
  | { command: 'version' };

export class ArgError extends Error {
  override name = 'ArgError';
}

export const USAGE = `rpc - screenshot a URL at device viewports, optionally in device bezels

Usage:
  rpc shot <url> [options]   capture screenshots
  rpc devices [--json]       list device ids and aliases
  rpc mcp                    run the MCP server on stdio
  rpc doctor [--json]        check that Playwright's Chromium is installed and launches
  rpc install                download Playwright's Chromium (same version rpc uses)

Shot options:
  -d, --devices <ids>        comma-separated device ids or aliases
                             (default: iphone-15-pro,desktop-1440)
  -b, --bezels               frame each shot in its device bezel
  -f, --full-page            capture the full scroll height (stitched, any height)
      --slices               with --full-page: also write viewport-tall JPEG
                             review slices (<stem>-slice-NN.jpg)
      --slice-width <px>     max slice width (default: 768)
      --max-height <px>      full-page cap in CSS px (default: 60000)
      --reduced-motion       emulate prefers-reduced-motion: reduce
  -o, --out <dir>            output directory (default: ./.rpc-shots)
      --wait-for <selector>  wait for a CSS selector before capturing
      --wait <ms>            extra settle delay after load (default: 0)
      --color-scheme <s>     light | dark | no-preference
      --timeout <ms>         navigation timeout (default: 30000)
      --no-emulate           viewport + DPR only (no mobile UA / touch)
      --json                 print the result as JSON

Examples:
  rpc shot localhost:3000 -d iphone-15,ipad,desktop-1440 --bezels
  rpc shot https://example.com --full-page --color-scheme dark
`;

export function parseCli(argv: readonly string[]): Command {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case undefined:
    case 'help':
    case '-h':
    case '--help':
      return { command: 'help' };
    case '-v':
    case '--version':
      return { command: 'version' };
    case 'mcp':
      return { command: 'mcp' };
    case 'install':
      return { command: 'install' };
    case 'doctor': {
      const { values } = parse(rest, { json: { type: 'boolean' } }, false);
      return { command: 'doctor', json: Boolean(values.json) };
    }
    case 'devices': {
      const { values } = parse(rest, { json: { type: 'boolean' } }, false);
      return { command: 'devices', json: Boolean(values.json) };
    }
    case 'shot':
      return parseShot(rest);
    default:
      throw new ArgError(`Unknown command "${cmd}". Run \`rpc --help\`.`);
  }
}

function parseShot(args: string[]): Command {
  const { values, positionals } = parse(
    args,
    {
      devices: { type: 'string', short: 'd' },
      bezels: { type: 'boolean', short: 'b' },
      'full-page': { type: 'boolean', short: 'f' },
      out: { type: 'string', short: 'o' },
      'wait-for': { type: 'string' },
      wait: { type: 'string' },
      'color-scheme': { type: 'string' },
      timeout: { type: 'string' },
      'no-emulate': { type: 'boolean' },
      slices: { type: 'boolean' },
      'slice-width': { type: 'string' },
      'max-height': { type: 'string' },
      'reduced-motion': { type: 'boolean' },
      json: { type: 'boolean' },
    },
    true
  );

  if (positionals.length === 0) throw new ArgError('Missing <url>. Usage: rpc shot <url> [options]');
  if (positionals.length > 1) throw new ArgError(`Expected one URL, got: ${positionals.join(' ')}`);

  let options: ShotOptions;
  try {
    options = defaultShotOptions(positionals[0]!);
  } catch (err) {
    throw new ArgError((err as Error).message);
  }

  if (typeof values.devices === 'string') {
    const list = splitList(values.devices);
    if (list.length === 0) throw new ArgError('--devices is empty');
    try {
      options.devices = resolveDevices(list).map(d => d.id);
    } catch (err) {
      throw new ArgError((err as Error).message);
    }
  }
  if (values.bezels) options.bezels = true;
  if (values['full-page']) options.fullPage = true;
  if (typeof values.out === 'string') options.outDir = values.out;
  if (typeof values['wait-for'] === 'string') options.waitFor = values['wait-for'];
  if (typeof values.wait === 'string') options.waitMs = parseMs('--wait', values.wait);
  if (typeof values.timeout === 'string') options.timeoutMs = parseMs('--timeout', values.timeout);
  if (typeof values['color-scheme'] === 'string') {
    const s = values['color-scheme'];
    if (!COLOR_SCHEMES.includes(s as ColorScheme)) {
      throw new ArgError(`--color-scheme must be one of ${COLOR_SCHEMES.join(', ')}`);
    }
    options.colorScheme = s as ColorScheme;
  }
  if (values['no-emulate']) options.emulate = false;
  if (values.slices) options.saveSlices = true;
  if (values['reduced-motion']) options.reducedMotion = true;
  if (typeof values['slice-width'] === 'string') {
    options.sliceWidth = parseInt_('--slice-width', values['slice-width'], 256, 4096);
  }
  if (typeof values['max-height'] === 'string') {
    options.maxHeight = parseInt_('--max-height', values['max-height'], 500, 200_000);
  }

  return { command: 'shot', options, json: Boolean(values.json) };
}

type Spec = NonNullable<Parameters<typeof parseArgs>[0]>['options'];

function parse<T extends Spec>(args: string[], options: T, allowPositionals: boolean) {
  try {
    return parseArgs({ args, options: options!, allowPositionals, strict: true });
  } catch (err) {
    throw new ArgError((err as Error).message);
  }
}

function splitList(s: string): string[] {
  return s.split(',').map(x => x.trim()).filter(Boolean);
}

function parseInt_(flag: string, raw: string, min: number, max: number): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw new ArgError(`${flag} must be an integer from ${min} to ${max}`);
  return n;
}

function parseMs(flag: string, raw: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new ArgError(`${flag} must be a non-negative number of ms`);
  return Math.round(n);
}
