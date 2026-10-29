// Authenticated captures: cookies, headers, storage state and saved sessions.
//
// Everything rpc injects is scoped to the target origin (plus any origins the
// caller allows explicitly). Secret values never appear in output: summaries
// carry names only, and error text is scrubbed of every value we injected.
import { existsSync, readFileSync } from 'node:fs';
import { chmod, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { BrowserContext, Page } from 'playwright';

export const MASK = '•••';

export type StorageState = Awaited<ReturnType<BrowserContext['storageState']>>;
type StateCookie = StorageState['cookies'][number];
type SameSite = StateCookie['sameSite'];

export interface CookieInput {
  name: string;
  value: string;
  /** Defaults to the target host (host-only). */
  domain?: string | undefined;
  path?: string | undefined;
  secure?: boolean | undefined;
  httpOnly?: boolean | undefined;
  sameSite?: SameSite | undefined;
}

export interface AuthOptions {
  /** Cookies set on the target origin before loading. */
  cookies?: CookieInput[] | undefined;
  /** Request headers sent only to the target origin (and allowOrigins). */
  headers?: Record<string, string> | undefined;
  /** Playwright storageState JSON to load (cookies + localStorage). */
  storageState?: string | undefined;
  /**
   * Load the session saved by `rpc login` for the target origin, if there is
   * one. Default true. Ignored when storageState is given.
   */
  useSession?: boolean | undefined;
  /** Extra origins that also get the headers and loaded cookies/localStorage. */
  allowOrigins?: string[] | undefined;
}

/** What auth a capture used, with every secret value masked. */
export interface AuthSummary {
  session?: SessionSummary;
  storageState?: string;
  cookies?: { name: string; value: string; domain: string; path: string }[];
  headers?: Record<string, string>;
  allowOrigins?: string[];
}

export interface SessionSummary {
  origin: string;
  path: string;
  savedAt?: string;
  /** Cookies for this origin in the file. */
  cookies: number;
  /** All of the origin's cookies are past their expiry; the session was not loaded. */
  expired?: boolean;
  /** Latest cookie expiry (ISO), when every cookie has one. */
  expires?: string;
  /** False when the session file exists but wasn't loaded (expired, or useSession false). */
  loaded: boolean;
}

export interface ResolvedAuth {
  /** Target origin, e.g. `http://localhost:3400`. Undefined for file:// URLs. */
  origin?: string;
  /** Origins that get headers and loaded state. */
  allowed: string[];
  state?: StorageState;
  cookies: StateCookie[];
  headers: Record<string, string>;
  /** Present only when some auth is in play (or a saved session was found). */
  summary?: AuthSummary;
  /** Values to scrub from any text we print. */
  secrets: string[];
}

// ------------------------------------------------------------------ parsing

const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/** `name=value; Domain=example.com; Path=/; Secure; HttpOnly; SameSite=Lax` */
export function parseCookie(raw: string): CookieInput {
  const [pair = '', ...attrs] = raw.split(';');
  const eq = pair.indexOf('=');
  const name = (eq === -1 ? pair : pair.slice(0, eq)).trim();
  if (eq === -1 || !name || !TOKEN.test(name)) {
    throw new Error(`--cookie expects "name=value[; Domain=…; Path=…]", got "${name || '(empty)'}${eq === -1 ? '' : `=${MASK}`}"`);
  }
  const cookie: CookieInput = { name, value: pair.slice(eq + 1).trim() };
  for (const attr of attrs) {
    const i = attr.indexOf('=');
    const key = (i === -1 ? attr : attr.slice(0, i)).trim().toLowerCase();
    const val = i === -1 ? '' : attr.slice(i + 1).trim();
    if (!key) continue;
    if (key === 'domain') cookie.domain = val;
    else if (key === 'path') cookie.path = val || '/';
    else if (key === 'secure') cookie.secure = true;
    else if (key === 'httponly') cookie.httpOnly = true;
    else if (key === 'samesite') {
      const s = val.toLowerCase();
      if (s !== 'lax' && s !== 'strict' && s !== 'none') throw new Error(`Cookie "${name}": SameSite must be Lax, Strict or None`);
      cookie.sameSite = (s[0]!.toUpperCase() + s.slice(1)) as SameSite;
    } else if (key === 'expires' || key === 'max-age') continue;
    else throw new Error(`Cookie "${name}": unknown attribute "${key}" (supported: Domain, Path, Secure, HttpOnly, SameSite)`);
  }
  return cookie;
}

/** `Name: value` */
export function parseHeader(raw: string): [string, string] {
  const i = raw.indexOf(':');
  const name = (i === -1 ? raw : raw.slice(0, i)).trim();
  if (i === -1 || !name || !TOKEN.test(name)) {
    throw new Error(`--header expects "Name: value", got "${name || '(empty)'}${i === -1 ? '' : `: ${MASK}`}"`);
  }
  return [name, raw.slice(i + 1).trim()];
}

function originOf(url: string): string | undefined {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin : undefined;
  } catch {
    return undefined;
  }
}

/** Accept `localhost:3000`, `https://x.com/path` or a bare host; return its origin. */
export function toOrigin(input: string): string {
  const raw = input.trim();
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw)
    ? raw
    : /^(localhost|127\.|0\.0\.0\.0|\[::1\])/i.test(raw)
      ? `http://${raw}`
      : `https://${raw}`;
  const o = originOf(withScheme);
  if (!o) throw new Error(`"${input}" is not an http(s) origin`);
  return o;
}

/** Cookie domain-match (RFC 6265 5.1.3), ignoring a leading dot. */
export function domainMatches(host: string, domain: string): boolean {
  const d = domain.replace(/^\./, '').toLowerCase();
  const h = host.toLowerCase();
  return h === d || h.endsWith(`.${d}`);
}

function hostOf(origin: string): string {
  return new URL(origin).hostname;
}

// ------------------------------------------------------------------ sessions

/** `$RPC_SESSIONS_DIR`, else `$XDG_CONFIG_HOME/rpc-agent/sessions`, else `~/.config/rpc-agent/sessions`. */
export function sessionsDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.RPC_SESSIONS_DIR) return resolve(env.RPC_SESSIONS_DIR);
  return join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'rpc-agent', 'sessions');
}

/** `http://localhost:3400` -> `http-localhost-3400` */
export function originSlug(origin: string): string {
  return origin
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function sessionPath(origin: string, dir = sessionsDir()): string {
  return join(dir, `${originSlug(origin)}.json`);
}

interface SessionMeta {
  origin: string;
  savedAt: string;
  url?: string;
}

type SessionFile = StorageState & { rpc?: SessionMeta };

/**
 * Write a storage state readable only by this user: the file is 0600 and,
 * for the default sessions dir, the directory is 0700.
 */
export async function writeSession(
  state: StorageState,
  meta: SessionMeta,
  file?: string
): Promise<string> {
  const target = file ? resolve(file) : sessionPath(meta.origin);
  const dir = dirname(target);
  if (!file) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700);
  } else {
    await mkdir(dir, { recursive: true });
  }
  const body: SessionFile = { cookies: state.cookies, origins: state.origins, rpc: meta };
  const tmp = `${target}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(body, null, 2) + '\n', { mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, target);
  return target;
}

function readState(path: string): SessionFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`Could not read storage state ${path}: ${(err as Error).message.split('\n')[0]}`);
  }
  const s = parsed as Partial<SessionFile>;
  if (!s || typeof s !== 'object' || !Array.isArray(s.cookies ?? []) || !Array.isArray(s.origins ?? [])) {
    throw new Error(`${path} is not a Playwright storageState file (expected { cookies: [], origins: [] })`);
  }
  return { cookies: s.cookies ?? [], origins: s.origins ?? [], ...(s.rpc ? { rpc: s.rpc } : {}) };
}

/** Cookies and localStorage that belong to the allowed origins only. */
export function scopeState(state: StorageState, allowed: string[]): StorageState {
  const hosts = allowed.map(hostOf);
  return {
    cookies: state.cookies.filter(c => hosts.some(h => domainMatches(h, c.domain))),
    origins: state.origins.filter(o => allowed.includes(o.origin)),
  };
}

/** Latest expiry of the cookies, and whether all of them have passed it. */
function expiry(cookies: StateCookie[], now = Date.now() / 1000): { expired: boolean; expires?: string } {
  if (cookies.length === 0 || cookies.some(c => !(c.expires > 0))) return { expired: false };
  const latest = Math.max(...cookies.map(c => c.expires));
  return { expired: latest < now, expires: new Date(latest * 1000).toISOString() };
}

export interface SessionInfo extends Omit<SessionSummary, 'loaded'> {
  /** Origins with localStorage in the file. */
  localStorage: number;
}

function describeSession(path: string, file: SessionFile, origin: string): SessionInfo {
  const own = scopeState(file, [origin]);
  const e = expiry(own.cookies);
  return {
    origin,
    path,
    ...(file.rpc?.savedAt ? { savedAt: file.rpc.savedAt } : {}),
    cookies: own.cookies.length,
    localStorage: own.origins.length,
    ...(e.expired ? { expired: true } : {}),
    ...(e.expires ? { expires: e.expires } : {}),
  };
}

export async function listSessions(dir = sessionsDir()): Promise<SessionInfo[]> {
  let names: string[];
  try {
    names = (await readdir(dir)).filter(n => n.endsWith('.json')).sort();
  } catch {
    return [];
  }
  const out: SessionInfo[] = [];
  for (const n of names) {
    const path = join(dir, n);
    try {
      const file = readState(path);
      const origin = file.rpc?.origin ?? originFromSlug(n);
      if (origin) out.push(describeSession(path, file, origin));
    } catch {
      // Not ours or unreadable; skip.
    }
  }
  return out;
}

function originFromSlug(name: string): string | undefined {
  const m = /^(https?)-(.+?)(?:-(\d+))?\.json$/.exec(name);
  return m ? `${m[1]}://${m[2]!.replace(/-/g, '.')}${m[3] ? `:${m[3]}` : ''}` : undefined;
}

/** Delete the saved session for one origin, or all of them. Returns the origins removed. */
export async function clearSessions(origin?: string, dir = sessionsDir()): Promise<string[]> {
  const all = await listSessions(dir);
  const target = origin ? toOrigin(origin) : undefined;
  const gone = all.filter(s => !target || s.origin === target);
  for (const s of gone) await rm(s.path, { force: true });
  return gone.map(s => s.origin);
}

/** File mode bits, for tests and `rpc sessions list`. */
export async function fileMode(path: string): Promise<number> {
  return (await stat(path)).mode & 0o777;
}

// ------------------------------------------------------------------ resolve

/**
 * Validate cookies and headers against the target URL and load the storage
 * state or saved session. Throws on bad input (names only in messages).
 */
export function resolveAuth(url: string, opts: AuthOptions, dir = sessionsDir()): ResolvedAuth {
  const origin = originOf(url);
  const secrets: string[] = [];
  const summary: AuthSummary = {};
  const allowed: string[] = [];
  if (origin) allowed.push(origin);
  for (const o of opts.allowOrigins ?? []) {
    const n = toOrigin(o);
    if (!allowed.includes(n)) allowed.push(n);
  }
  if (opts.allowOrigins?.length) summary.allowOrigins = allowed.slice(1);

  const wantsInjection = Boolean(opts.cookies?.length || (opts.headers && Object.keys(opts.headers).length));
  if (!origin && (wantsInjection || opts.storageState)) {
    throw new Error('Cookies, headers and storage state need an http(s) URL');
  }

  // Cookies: host-only on the target unless a Domain that matches it (or an allowed origin) is given.
  const cookies: StateCookie[] = [];
  for (const c of opts.cookies ?? []) {
    const host = hostOf(origin!);
    let domain = host;
    if (c.domain) {
      const ok = allowed.some(o => domainMatches(hostOf(o), c.domain!));
      if (!ok) {
        throw new Error(
          `Cookie "${c.name}" has Domain=${c.domain}, which doesn't match ${host}. Cookies only go to the target origin; add --allow-origin to widen it.`
        );
      }
      // A Domain attribute means "this host and its subdomains", as in a browser.
      domain = `.${c.domain.replace(/^\./, '')}`;
    }
    cookies.push({
      name: c.name,
      value: c.value,
      domain,
      path: c.path ?? '/',
      expires: -1,
      httpOnly: c.httpOnly ?? false,
      secure: c.secure ?? false,
      sameSite: c.sameSite ?? 'Lax',
    });
    secrets.push(c.value);
  }
  if (cookies.length) {
    summary.cookies = cookies.map(c => ({ name: c.name, value: MASK, domain: c.domain, path: c.path }));
  }

  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(opts.headers ?? {})) {
    if (!TOKEN.test(k)) throw new Error(`Invalid header name "${k}"`);
    headers[k] = String(v);
    secrets.push(String(v));
  }
  if (Object.keys(headers).length) {
    summary.headers = Object.fromEntries(Object.keys(headers).map(k => [k, MASK]));
  }

  let state: StorageState | undefined;
  if (opts.storageState) {
    const path = resolve(opts.storageState);
    if (!existsSync(path)) throw new Error(`Storage state file not found: ${path}`);
    state = scopeState(readState(path), allowed);
    summary.storageState = path;
  } else if (origin) {
    const path = sessionPath(origin, dir);
    if (existsSync(path)) {
      const file = readState(path);
      const info = describeSession(path, file, origin);
      const load = opts.useSession !== false && !info.expired;
      const { localStorage: _ls, ...rest } = info;
      summary.session = { ...rest, loaded: load };
      if (load) state = scopeState(file, allowed);
    }
  }
  for (const c of state?.cookies ?? []) secrets.push(c.value);
  for (const o of state?.origins ?? []) for (const kv of o.localStorage) secrets.push(kv.value);

  const used = Object.keys(summary).length > 0;
  return {
    ...(origin ? { origin } : {}),
    allowed,
    ...(state ? { state } : {}),
    cookies,
    headers,
    ...(used ? { summary } : {}),
    secrets: [...new Set(secrets.filter(s => s.length >= 4))].sort((a, b) => b.length - a.length),
  };
}

/** Replace every secret value in text with •••. */
export function redact(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const s of secrets) if (out.includes(s)) out = out.split(s).join(MASK);
  return out;
}

/** One line for plain output: `session http://x (saved …), cookie sid=•••, header Authorization: •••`. */
export function describeAuth(s: AuthSummary): string {
  const parts: string[] = [];
  if (s.session) {
    const when = s.session.savedAt ? `saved ${s.session.savedAt.slice(0, 16).replace('T', ' ')}` : '';
    if (s.session.loaded) parts.push(`session ${s.session.origin}${when ? ` (${when})` : ''}`);
    else if (s.session.expired) parts.push(`session ${s.session.origin} expired, not loaded`);
    else parts.push(`session ${s.session.origin} skipped (--no-session)`);
  }
  if (s.storageState) parts.push(`storage state ${s.storageState}`);
  for (const c of s.cookies ?? []) parts.push(`cookie ${c.name}=${MASK}`);
  for (const h of Object.keys(s.headers ?? {})) parts.push(`header ${h}: ${MASK}`);
  if (s.allowOrigins?.length) parts.push(`also ${s.allowOrigins.join(', ')}`);
  return parts.join(', ');
}

// ------------------------------------------------------------------ apply

/**
 * Send the extra headers on requests to allowed origins only. Uses the CDP
 * Fetch domain rather than page.route: route() header overrides follow
 * redirects, so a 302 to another host would carry the header there. Fetch
 * pauses each redirect hop separately, so every hop is checked.
 */
export async function applyHeaders(context: BrowserContext, page: Page, auth: ResolvedAuth): Promise<void> {
  const extra = Object.entries(auth.headers);
  if (extra.length === 0) return;
  const lower = new Set(extra.map(([k]) => k.toLowerCase()));
  const cdp = await context.newCDPSession(page);
  cdp.on('Fetch.requestPaused', e => {
    const allowed = auth.allowed.includes(originOf(e.request.url) ?? '');
    const params: { requestId: string; headers?: { name: string; value: string }[] } = { requestId: e.requestId };
    if (allowed) {
      params.headers = [
        ...Object.entries(e.request.headers)
          .filter(([k]) => !lower.has(k.toLowerCase()))
          .map(([name, value]) => ({ name, value: String(value) })),
        ...extra.map(([name, value]) => ({ name, value })),
      ];
    }
    cdp.send('Fetch.continueRequest', params).catch(() => {});
  });
  await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
}

// ------------------------------------------------------------------ login pages

const LOGIN_SEGMENT = /^(log-?in|sign-?in|sign_in|signin|auth|authenticate|oauth2?|sso)(\.\w+)?$/i;

/** True when a path segment looks like a login page (`/login`, `/sign-in`, `/auth/...`). */
export function isLoginUrl(url: string): boolean {
  try {
    return new URL(url).pathname.split('/').some(seg => LOGIN_SEGMENT.test(seg));
  } catch {
    return false;
  }
}

/** The page ended on a login URL that isn't the one requested. */
export function redirectedToLogin(requested: string, final: string): boolean {
  try {
    const a = new URL(requested);
    const b = new URL(final);
    if (b.protocol !== 'http:' && b.protocol !== 'https:') return false;
    return isLoginUrl(final) && a.origin + a.pathname !== b.origin + b.pathname;
  } catch {
    return false;
  }
}

export function loginHint(origin: string): string {
  return `Session missing or expired: run \`rpc login ${origin}\``;
}

export class AuthRequiredError extends Error {
  override name = 'AuthRequiredError';
  readonly code = 'AUTH_REQUIRED';
  readonly hint: string;
  constructor(
    readonly requested: string,
    readonly finalUrl: string,
    readonly status: number | null
  ) {
    const final = new URL(finalUrl);
    super(`Redirected to a login page (${final.origin}${final.pathname}) instead of ${requested}`);
    this.hint = loginHint(new URL(requested).origin);
  }
}
