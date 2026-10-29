import { parseArgs, type ParseArgsOptionsConfig } from 'node:util';
import { parseCookie, parseHeader, resolveAuth, toOrigin, type AuthOptions } from './auth.js';
import { resolveDevices } from './devices.js';
import type { FormLogin } from './login.js';
import {
  COLOR_SCHEMES,
  DEFAULT_TIMEOUT_MS,
  defaultShotOptions,
  normalizeUrl,
  type ColorScheme,
  type ShotOptions,
} from './options.js';

export type Command =
  | { command: 'shot'; options: ShotOptions; json: boolean; open: boolean }
  | { command: 'devices'; json: boolean }
  | { command: 'mcp' }
  | { command: 'doctor'; json: boolean }
  | { command: 'install'; headed?: true }
  | LoginCommand
  | { command: 'sessions'; action: 'list' | 'clear'; origin?: string; json: boolean }
  | { command: 'help'; topic?: HelpTopic }
  | { command: 'version' };

export interface LoginCommand {
  command: 'login';
  url: string;
  /** Storage state file to write instead of the per-origin session. */
  save?: string;
  /** Headless form login (CI, agents). */
  form?: FormLogin;
  /** The password came from --password (shell history, process list). */
  passwordFromFlag?: true;
  timeoutMs: number;
  json: boolean;
}

export const HELP_TOPICS = ['shot', 'login', 'sessions', 'devices', 'doctor', 'install', 'mcp'] as const;
export type HelpTopic = (typeof HELP_TOPICS)[number];

function isTopic(s: string | undefined): s is HelpTopic {
  return (HELP_TOPICS as readonly string[]).includes(s ?? '');
}

function wantsHelp(args: readonly string[]): boolean {
  return args.includes('--help') || args.includes('-h');
}

export class ArgError extends Error {
  override name = 'ArgError';
}

export const USAGE = `rpc - screenshot a URL at device viewports, optionally in device bezels

Usage:
  rpc shot <url> [options]   capture screenshots
  rpc login <url> [--form]   sign in once and save the session for that origin
  rpc sessions [list|clear [origin]]
                             list or delete saved sessions
  rpc devices [--json]       list device ids and aliases
  rpc mcp                    run the MCP server on stdio
  rpc doctor [--json]        check that Playwright's Chromium is installed and launches
  rpc install [--headed]     download Playwright's Chromium (same version rpc uses)

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
      --open                 open the output folder when done

Auth options (values are never printed):
      --cookie <c>           "name=value[; Domain=…; Path=…]", repeatable;
                             sent to the target origin only
      --header <h>           "Name: value", repeatable; target origin only
      --storage-state <file> load a Playwright storageState JSON
      --no-session           don't use the session saved by \`rpc login\`
      --allow-origin <o>     also send headers/cookies to this origin, repeatable

Run \`rpc help <command>\` for one command's options and examples.
Run \`rpc\` with no arguments in a terminal for an interactive capture.

Examples:
  rpc shot localhost:3000 -d iphone-15,ipad,desktop-1440 --bezels
  rpc shot https://example.com --full-page --color-scheme dark
  rpc login localhost:3000/sign-in && rpc shot localhost:3000/dashboard
`;

export function parseCli(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): Command {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case undefined:
    case 'help':
    case '-h':
    case '--help': {
      const topic = rest[0];
      if (topic === undefined) return { command: 'help' };
      if (!isTopic(topic)) throw new ArgError(`No help for "${topic}". Topics: ${HELP_TOPICS.join(', ')}`);
      return { command: 'help', topic };
    }
    case '-v':
    case '--version':
      return { command: 'version' };
    case 'mcp':
      if (wantsHelp(rest)) return { command: 'help', topic: 'mcp' };
      return { command: 'mcp' };
    case 'install': {
      if (wantsHelp(rest)) return { command: 'help', topic: 'install' };
      const { values } = parse(rest, { headed: { type: 'boolean' } }, false);
      return values.headed ? { command: 'install', headed: true } : { command: 'install' };
    }
    case 'login':
      return parseLogin(rest, env);
    case 'sessions':
      return parseSessions(rest);
    case 'doctor': {
      if (wantsHelp(rest)) return { command: 'help', topic: 'doctor' };
      const { values } = parse(rest, { json: { type: 'boolean' } }, false);
      return { command: 'doctor', json: Boolean(values.json) };
    }
    case 'devices': {
      if (wantsHelp(rest)) return { command: 'help', topic: 'devices' };
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
  if (wantsHelp(args)) return { command: 'help', topic: 'shot' };
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
      open: { type: 'boolean' },
      cookie: { type: 'string', multiple: true },
      header: { type: 'string', multiple: true },
      'storage-state': { type: 'string' },
      'no-session': { type: 'boolean' },
      'allow-origin': { type: 'string', multiple: true },
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

  const auth: AuthOptions = {};
  try {
    if (values.cookie?.length) auth.cookies = values.cookie.map(parseCookie);
    if (values.header?.length) auth.headers = Object.fromEntries(values.header.map(parseHeader));
    if (typeof values['storage-state'] === 'string') auth.storageState = values['storage-state'];
    if (values['no-session']) auth.useSession = false;
    if (values['allow-origin']?.length) auth.allowOrigins = values['allow-origin'].flatMap(splitList).map(toOrigin);
    if (Object.keys(auth).length) {
      resolveAuth(options.url, auth); // validate now: bad input is a usage error
      options.auth = auth;
    }
  } catch (err) {
    throw new ArgError((err as Error).message);
  }

  return { command: 'shot', options, json: Boolean(values.json), open: Boolean(values.open) };
}

function parseLogin(args: string[], env: NodeJS.ProcessEnv): Command {
  if (wantsHelp(args)) return { command: 'help', topic: 'login' };
  const { values, positionals } = parse(
    args,
    {
      save: { type: 'string' },
      form: { type: 'boolean' },
      email: { type: 'string' },
      password: { type: 'string' },
      'email-selector': { type: 'string' },
      'password-selector': { type: 'string' },
      'submit-selector': { type: 'string' },
      timeout: { type: 'string' },
      json: { type: 'boolean' },
    },
    true
  );
  if (positionals.length !== 1) throw new ArgError('Usage: rpc login <url> [--form] [--save <file>]');
  let url: string;
  try {
    url = normalizeUrl(positionals[0]!);
    toOrigin(url);
  } catch (err) {
    throw new ArgError((err as Error).message);
  }
  const cmd: LoginCommand = {
    command: 'login',
    url,
    timeoutMs: typeof values.timeout === 'string' ? parseMs('--timeout', values.timeout) : DEFAULT_TIMEOUT_MS,
    json: Boolean(values.json),
  };
  if (typeof values.save === 'string') cmd.save = values.save;

  const formOnly = ['email', 'password', 'email-selector', 'password-selector', 'submit-selector'] as const;
  if (!values.form) {
    const used = formOnly.filter(k => values[k] !== undefined);
    if (used.length) throw new ArgError(`--${used[0]} needs --form`);
    return cmd;
  }
  const email = values.email ?? env.RPC_LOGIN_EMAIL;
  const password = values.password ?? env.RPC_LOGIN_PASSWORD;
  if (!email) throw new ArgError('--form needs an email: set RPC_LOGIN_EMAIL (or pass --email)');
  if (!password) throw new ArgError('--form needs a password: set RPC_LOGIN_PASSWORD');
  cmd.form = {
    email,
    password,
    ...(values['email-selector'] ? { emailSelector: values['email-selector'] } : {}),
    ...(values['password-selector'] ? { passwordSelector: values['password-selector'] } : {}),
    ...(values['submit-selector'] ? { submitSelector: values['submit-selector'] } : {}),
  };
  if (values.password !== undefined) cmd.passwordFromFlag = true;
  return cmd;
}

function parseSessions(args: string[]): Command {
  if (wantsHelp(args)) return { command: 'help', topic: 'sessions' };
  const { values, positionals } = parse(args, { json: { type: 'boolean' } }, true);
  const [action = 'list', origin, ...extra] = positionals;
  if (action !== 'list' && action !== 'clear') throw new ArgError(`Unknown sessions action "${action}". Use list or clear.`);
  if (extra.length || (action === 'list' && origin)) throw new ArgError('Usage: rpc sessions list | rpc sessions clear [origin]');
  if (origin) {
    try {
      toOrigin(origin);
    } catch (err) {
      throw new ArgError((err as Error).message);
    }
  }
  return { command: 'sessions', action, ...(origin ? { origin } : {}), json: Boolean(values.json) };
}

function parse<const T extends ParseArgsOptionsConfig>(args: string[], options: T, allowPositionals: boolean) {
  try {
    return parseArgs({ args, options, allowPositionals, strict: true });
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
