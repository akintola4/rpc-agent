import { parseArgs, type ParseArgsOptionsConfig } from 'node:util';
import { parseCookie, parseHeader, resolveAuth, toOrigin, type AuthOptions } from './auth.js';
import { resolveDevices } from './devices.js';
import type { FormLogin } from './login.js';
import {
  COLOR_SCHEMES,
  DEFAULT_TIMEOUT_MS,
  defaultCheckOptions,
  defaultRecordOptions,
  defaultShotOptions,
  FAIL_ON,
  MAX_RECORD_SECONDS,
  normalizeUrl,
  type CheckOptions,
  type RecordOptions,
  type ColorScheme,
  type FailOn,
  type ShotOptions,
} from './options.js';

export type Command =
  | { command: 'shot'; options: ShotOptions; json: boolean; open: boolean }
  | { command: 'check'; options: CheckOptions; json: boolean }
  | { command: 'record'; options: RecordOptions; json: boolean; open: boolean }
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

export const HELP_TOPICS = ['shot', 'check', 'record', 'login', 'sessions', 'devices', 'doctor', 'install', 'mcp'] as const;
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
  rpc check <url> [options]  pre-launch audit: meta, layout shift, labels, fonts, mobile,
                             motion
  rpc record <url> [options] record a short video of the page or one element
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
      --finish-animations    jump animations (CSS, Web Animations, GSAP) to
                             their end before capturing
      --no-unpin             with --full-page: keep pinned sections as they
                             are (default: collapse each to its section)
  -o, --out <dir>            output directory (default: ./.rpc-shots)
      --wait-for <selector>  wait for a CSS selector before capturing
      --wait <ms>            extra settle delay after load (default: 0)
      --color-scheme <s>     light | dark | no-preference
      --timeout <ms>         navigation timeout (default: 30000)
      --no-emulate           viewport + DPR only (no mobile UA / touch)
      --json                 print the result as JSON
      --open                 open the output folder when done

Check options (plus -d, --wait-for, --wait, --timeout, --color-scheme, -o, --json):
      --fail-on <level>      error (default) | warn: exit 1 on warnings too
      --shots                screenshot the elements behind layout-shift and
                             overflow findings (into --out)

Record options (plus --wait-for, --wait, --timeout, --color-scheme,
--reduced-motion, --no-emulate, -o, --json, --open):
  -d, --device <id>          one device id or alias (default: desktop-1440)
      --selector <css>       crop to this element (scrolled into view first)
      --duration <s>         seconds of video, up to 30 (default: 5)
      --gif                  also write a GIF
      --mp4                  also write an mp4 (needs ffmpeg with H.264 on PATH)

Auth options (values are never printed; shot, check and record):
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
  rpc check localhost:3000 --fail-on warn
  rpc record localhost:3000 --selector '.carousel' --duration 6 --gif
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
    case 'check':
      return parseCheck(rest);
    case 'record':
      return parseRecord(rest);
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
      'finish-animations': { type: 'boolean' },
      'no-unpin': { type: 'boolean' },
      json: { type: 'boolean' },
      open: { type: 'boolean' },
      ...AUTH_FLAGS,
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

  if (typeof values.devices === 'string') options.devices = parseDevices(values.devices);
  if (values.bezels) options.bezels = true;
  if (values['full-page']) options.fullPage = true;
  if (typeof values.out === 'string') options.outDir = values.out;
  if (typeof values['wait-for'] === 'string') options.waitFor = values['wait-for'];
  if (typeof values.wait === 'string') options.waitMs = parseMs('--wait', values.wait);
  if (typeof values.timeout === 'string') options.timeoutMs = parseMs('--timeout', values.timeout);
  if (typeof values['color-scheme'] === 'string') options.colorScheme = parseColorScheme(values['color-scheme']);
  if (values['no-emulate']) options.emulate = false;
  if (values.slices) options.saveSlices = true;
  if (values['reduced-motion']) options.reducedMotion = true;
  if (values['finish-animations']) options.finishAnimations = true;
  if (values['no-unpin']) options.unpin = false;
  if (typeof values['slice-width'] === 'string') {
    options.sliceWidth = parseInt_('--slice-width', values['slice-width'], 256, 4096);
  }
  if (typeof values['max-height'] === 'string') {
    options.maxHeight = parseInt_('--max-height', values['max-height'], 500, 200_000);
  }

  const auth = parseAuth(values, options.url);
  if (auth) options.auth = auth;

  return { command: 'shot', options, json: Boolean(values.json), open: Boolean(values.open) };
}

const AUTH_FLAGS = {
  cookie: { type: 'string', multiple: true },
  header: { type: 'string', multiple: true },
  'storage-state': { type: 'string' },
  'no-session': { type: 'boolean' },
  'allow-origin': { type: 'string', multiple: true },
} as const;

interface AuthValues {
  cookie?: string[] | undefined;
  header?: string[] | undefined;
  'storage-state'?: string | undefined;
  'no-session'?: boolean | undefined;
  'allow-origin'?: string[] | undefined;
}

/** Cookie/header/session flags, validated against the URL now: bad input is a usage error. */
function parseAuth(values: AuthValues, url: string): AuthOptions | undefined {
  const auth: AuthOptions = {};
  try {
    if (values.cookie?.length) auth.cookies = values.cookie.map(parseCookie);
    if (values.header?.length) auth.headers = Object.fromEntries(values.header.map(parseHeader));
    if (typeof values['storage-state'] === 'string') auth.storageState = values['storage-state'];
    if (values['no-session']) auth.useSession = false;
    if (values['allow-origin']?.length) auth.allowOrigins = values['allow-origin'].flatMap(splitList).map(toOrigin);
    if (!Object.keys(auth).length) return undefined;
    resolveAuth(url, auth);
    return auth;
  } catch (err) {
    throw new ArgError((err as Error).message);
  }
}

function parseDevices(raw: string): string[] {
  const list = splitList(raw);
  if (list.length === 0) throw new ArgError('--devices is empty');
  try {
    return resolveDevices(list).map(d => d.id);
  } catch (err) {
    throw new ArgError((err as Error).message);
  }
}

function parseCheck(args: string[]): Command {
  if (wantsHelp(args)) return { command: 'help', topic: 'check' };
  const { values, positionals } = parse(
    args,
    {
      devices: { type: 'string', short: 'd' },
      out: { type: 'string', short: 'o' },
      'wait-for': { type: 'string' },
      wait: { type: 'string' },
      'color-scheme': { type: 'string' },
      timeout: { type: 'string' },
      'fail-on': { type: 'string' },
      shots: { type: 'boolean' },
      json: { type: 'boolean' },
      ...AUTH_FLAGS,
    },
    true
  );
  if (positionals.length === 0) throw new ArgError('Missing <url>. Usage: rpc check <url> [options]');
  if (positionals.length > 1) throw new ArgError(`Expected one URL, got: ${positionals.join(' ')}`);

  let options: CheckOptions;
  try {
    options = defaultCheckOptions(positionals[0]!);
  } catch (err) {
    throw new ArgError((err as Error).message);
  }
  if (typeof values.devices === 'string') options.devices = parseDevices(values.devices);
  if (typeof values.out === 'string') options.outDir = values.out;
  if (typeof values['wait-for'] === 'string') options.waitFor = values['wait-for'];
  if (typeof values.wait === 'string') options.waitMs = parseMs('--wait', values.wait);
  if (typeof values.timeout === 'string') options.timeoutMs = parseMs('--timeout', values.timeout);
  if (typeof values['color-scheme'] === 'string') options.colorScheme = parseColorScheme(values['color-scheme']);
  if (typeof values['fail-on'] === 'string') {
    if (!FAIL_ON.includes(values['fail-on'] as FailOn)) throw new ArgError(`--fail-on must be one of ${FAIL_ON.join(', ')}`);
    options.failOn = values['fail-on'] as FailOn;
  }
  if (values.shots) options.shots = true;
  const auth = parseAuth(values, options.url);
  if (auth) options.auth = auth;
  return { command: 'check', options, json: Boolean(values.json) };
}

function parseRecord(args: string[]): Command {
  if (wantsHelp(args)) return { command: 'help', topic: 'record' };
  const { values, positionals } = parse(
    args,
    {
      device: { type: 'string', short: 'd' },
      devices: { type: 'string' },
      selector: { type: 'string' },
      duration: { type: 'string' },
      gif: { type: 'boolean' },
      mp4: { type: 'boolean' },
      out: { type: 'string', short: 'o' },
      'wait-for': { type: 'string' },
      wait: { type: 'string' },
      'color-scheme': { type: 'string' },
      timeout: { type: 'string' },
      'no-emulate': { type: 'boolean' },
      'reduced-motion': { type: 'boolean' },
      json: { type: 'boolean' },
      open: { type: 'boolean' },
      ...AUTH_FLAGS,
    },
    true
  );
  if (positionals.length === 0) throw new ArgError('Missing <url>. Usage: rpc record <url> [options]');
  if (positionals.length > 1) throw new ArgError(`Expected one URL, got: ${positionals.join(' ')}`);
  let options: RecordOptions;
  try {
    options = defaultRecordOptions(positionals[0]!);
  } catch (err) {
    throw new ArgError((err as Error).message);
  }
  const device = values.device ?? values.devices;
  if (typeof device === 'string') {
    const list = parseDevices(device);
    if (list.length !== 1) throw new ArgError('rpc record takes one device (-d desktop-1440)');
    options.device = list[0]!;
  }
  if (typeof values.selector === 'string') {
    if (!values.selector.trim()) throw new ArgError('--selector is empty');
    options.selector = values.selector;
  }
  if (typeof values.duration === 'string') {
    const n = Number(values.duration);
    if (!Number.isFinite(n) || n < 0.5 || n > MAX_RECORD_SECONDS) throw new ArgError(`--duration must be a number of seconds from 0.5 to ${MAX_RECORD_SECONDS}`);
    options.duration = n;
  }
  if (values.gif) options.gif = true;
  if (values.mp4) options.mp4 = true;
  if (typeof values.out === 'string') options.outDir = values.out;
  if (typeof values['wait-for'] === 'string') options.waitFor = values['wait-for'];
  if (typeof values.wait === 'string') options.waitMs = parseMs('--wait', values.wait);
  if (typeof values.timeout === 'string') options.timeoutMs = parseMs('--timeout', values.timeout);
  if (typeof values['color-scheme'] === 'string') options.colorScheme = parseColorScheme(values['color-scheme']);
  if (values['no-emulate']) options.emulate = false;
  if (values['reduced-motion']) options.reducedMotion = true;
  const auth = parseAuth(values, options.url);
  if (auth) options.auth = auth;
  return { command: 'record', options, json: Boolean(values.json), open: Boolean(values.open) };
}

function parseColorScheme(s: string): ColorScheme {
  if (!COLOR_SCHEMES.includes(s as ColorScheme)) throw new ArgError(`--color-scheme must be one of ${COLOR_SCHEMES.join(', ')}`);
  return s as ColorScheme;
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
