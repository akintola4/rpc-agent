import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser } from 'playwright';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ArgError, parseCli } from '../src/args.js';
import {
  domainMatches,
  fileMode,
  isLoginUrl,
  MASK,
  parseCookie,
  parseHeader,
  redact,
  redirectedToLogin,
  resolveAuth,
  scopeState,
  sessionPath,
  writeSession,
} from '../src/auth.js';
import { capture, launchBrowser } from '../src/capture.js';
import { createServer as createMcpServer } from '../src/mcp.js';
import { defaultShotOptions } from '../src/options.js';
import { capturedLines, colors, summaryLines } from '../src/ui.js';

const ROOT = resolve(import.meta.dirname, '..');
const CLI = resolve(ROOT, 'src', 'cli.ts');
const TMP = mkdtempSync(join(tmpdir(), 'rpc-auth-'));
const SESSIONS = join(TMP, 'sessions');
// In-process captures and the MCP server read sessions from here, never ~/.config.
process.env.RPC_SESSIONS_DIR = SESSIONS;

const EMAIL = 'ada@example.test';
const PASSWORD = 'pw-correct-horse-battery';
const COOKIE_SECRET = 'cookie-secret-7f3a9c';
const HEADER_SECRET = 'header-secret-b81d2e';
const LS_SECRET = 'ls-secret-44e1aa';

const tokens = new Set<string>([COOKIE_SECRET]);
const thirdParty: { url: string; headers: IncomingMessage['headers'] }[] = [];
const appHits: { url: string; headers: IncomingMessage['headers'] }[] = [];

let app: Server;
let third: Server;
let APP: string; // http://localhost:<port>
let THIRD: string; // http://127.0.0.1:<port>, a different origin
let browser: Browser;

function sid(req: IncomingMessage): string | undefined {
  return /(?:^|;\s*)sid=([^;]+)/.exec(req.headers.cookie ?? '')?.[1];
}

const html = (title: string, body = '') =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body style="margin:0;font:16px sans-serif">${body}</body></html>`;

function loginPage(error = ''): string {
  return html(
    'Sign in',
    `<form method="post" action="/login">
      ${error ? `<p role="alert">${error}</p>` : ''}
      <input type="email" name="email"><input type="password" name="password"><button type="submit">Sign in</button>
    </form>`
  );
}

beforeAll(async () => {
  third = createServer((req, res) => {
    thirdParty.push({ url: req.url!, headers: req.headers });
    res.writeHead(200, { 'content-type': 'text/html' }).end(html('third'));
  });
  await new Promise<void>(r => third.listen(0, '127.0.0.1', r));
  THIRD = `http://127.0.0.1:${(third.address() as AddressInfo).port}`;

  app = createServer((req, res) => {
    appHits.push({ url: req.url!, headers: req.headers });
    const url = new URL(req.url!, 'http://x');
    const send = (body: string, status = 200) => res.writeHead(status, { 'content-type': 'text/html' }).end(body);
    if (url.pathname === '/login' && req.method === 'POST') {
      let body = '';
      req.on('data', d => (body += d));
      req.on('end', () => {
        const form = new URLSearchParams(body);
        if (form.get('email') === EMAIL && form.get('password') === PASSWORD) {
          const t = randomBytes(12).toString('hex');
          tokens.add(t);
          res.writeHead(302, { location: '/dashboard', 'set-cookie': `sid=${t}; HttpOnly; Path=/; Max-Age=3600` }).end();
        } else {
          send(loginPage('Invalid email or password'));
        }
      });
      return;
    }
    if (url.pathname === '/login') return send(loginPage());
    if (url.pathname === '/dashboard') {
      if (!tokens.has(sid(req) ?? '')) {
        res.writeHead(302, { location: '/login?next=/dashboard' }).end();
        return;
      }
      return send(html('Dashboard', `<h1>Dashboard</h1><img src="${THIRD}/pixel.png" width="1" height="1">`));
    }
    if (url.pathname === '/header-page') {
      const ok = req.headers['x-api-key'] === HEADER_SECRET;
      return send(html(ok ? 'Header ok' : 'No header', `<img src="${THIRD}/from-header-page.png" width="1" height="1">`));
    }
    if (url.pathname === '/echo') {
      // A careless app logging its cookies.
      return send(html('echo', `<script>console.error('cookie ' + document.cookie)</script>`));
    }
    if (url.pathname === '/redirect-out') {
      res.writeHead(302, { location: `${THIRD}/landed` }).end();
      return;
    }
    if (url.pathname === '/ls') {
      return send(html('LS', `<script>document.title = localStorage.getItem('token') === '${LS_SECRET}' ? 'LS ok' : 'LS missing'</script>`));
    }
    send(html('Not found'), 404);
  });
  await new Promise<void>(r => app.listen(0, 'localhost', r));
  APP = `http://localhost:${(app.address() as AddressInfo).port}`;
  browser = await launchBrowser();
});

afterAll(async () => {
  await browser?.close();
  await new Promise(r => app?.close(r));
  await new Promise(r => third?.close(r));
  rmSync(TMP, { recursive: true, force: true });
});

function out(name: string): string {
  return join(TMP, 'shots', name);
}

/** Spawned CLI (plain output: stdout is a pipe). */
function rpc(args: string[], env: Record<string, string | undefined> = {}): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const full = { ...process.env, RPC_SESSIONS_DIR: SESSIONS, ...env } as Record<string, string | undefined>;
  for (const k of ['FORCE_COLOR', 'NO_COLOR', 'CI', 'RPC_LOGIN_EMAIL', 'RPC_LOGIN_PASSWORD']) if (!(k in env)) delete full[k];
  return new Promise((res, rej) => {
    const child = spawn(process.execPath, ['--import', 'tsx', CLI, ...args], { cwd: ROOT, env: full as NodeJS.ProcessEnv });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => (stdout += d));
    child.stderr.on('data', d => (stderr += d));
    child.on('error', rej);
    child.on('close', status => res({ status, stdout, stderr }));
  });
}

const SECRETS = [COOKIE_SECRET, HEADER_SECRET, PASSWORD, LS_SECRET];
function expectNoSecrets(text: string): void {
  for (const s of SECRETS) expect(text).not.toContain(s);
}

describe('parsing', () => {
  it('parses cookies with attributes', () => {
    expect(parseCookie('sid=abc=def; Domain=.example.com; Path=/app; Secure; HttpOnly; SameSite=strict')).toEqual({
      name: 'sid',
      value: 'abc=def',
      domain: '.example.com',
      path: '/app',
      secure: true,
      httpOnly: true,
      sameSite: 'Strict',
    });
    expect(() => parseCookie('novalue')).toThrow(/name=value/);
    expect(() => parseCookie('a=b; Colour=red')).toThrow(/unknown attribute/);
  });

  it('parses headers and never echoes the value in errors', () => {
    expect(parseHeader('Authorization: Bearer abc:def')).toEqual(['Authorization', 'Bearer abc:def']);
    expect(() => parseHeader('bad header: x')).toThrow();
    try {
      parseCookie(`bad name=${COOKIE_SECRET}`);
    } catch (err) {
      expect((err as Error).message).not.toContain(COOKIE_SECRET);
    }
  });

  it('rejects a cookie Domain that is not the target', () => {
    expect(() => resolveAuth('https://app.example.com/', { cookies: [{ name: 'a', value: COOKIE_SECRET, domain: 'evil.test' }] })).toThrow(
      /Domain=evil\.test.*allow-origin/
    );
    const ok = resolveAuth('https://app.example.com/', { cookies: [{ name: 'a', value: COOKIE_SECRET, domain: 'example.com' }] });
    expect(ok.cookies[0]!.domain).toBe('.example.com');
    const host = resolveAuth('https://app.example.com/', { cookies: [{ name: 'a', value: COOKIE_SECRET }] });
    expect(host.cookies[0]!.domain).toBe('app.example.com');
    expect(JSON.stringify(host.summary)).not.toContain(COOKIE_SECRET);
    expect(host.summary!.cookies![0]!.value).toBe(MASK);
  });

  it('domain-matches like a browser', () => {
    expect(domainMatches('app.example.com', '.example.com')).toBe(true);
    expect(domainMatches('example.com', 'example.com')).toBe(true);
    expect(domainMatches('badexample.com', 'example.com')).toBe(false);
  });

  it('scopes storage state to the allowed origins', () => {
    const state = {
      cookies: [
        { name: 'a', value: '1', domain: 'localhost', path: '/', expires: -1, httpOnly: false, secure: false, sameSite: 'Lax' as const },
        { name: 'b', value: '2', domain: '.tracker.test', path: '/', expires: -1, httpOnly: false, secure: false, sameSite: 'Lax' as const },
      ],
      origins: [
        { origin: 'http://localhost:3000', localStorage: [{ name: 'k', value: 'v' }] },
        { origin: 'https://tracker.test', localStorage: [{ name: 'k', value: 'v' }] },
      ],
    };
    const s = scopeState(state, ['http://localhost:3000']);
    expect(s.cookies.map(c => c.name)).toEqual(['a']);
    expect(s.origins.map(o => o.origin)).toEqual(['http://localhost:3000']);
  });

  it('spots login URLs', () => {
    for (const u of ['/login', '/sign-in', '/signin', '/auth/callback', '/users/sign_in', '/login.php', '/en/sign-in']) {
      expect(isLoginUrl(`https://x.test${u}`), u).toBe(true);
    }
    for (const u of ['/', '/authors', '/blog/login-tips', '/dashboard']) expect(isLoginUrl(`https://x.test${u}`), u).toBe(false);
    expect(redirectedToLogin('https://x.test/billing', 'https://x.test/sign-in?next=/billing')).toBe(true);
    expect(redirectedToLogin('https://x.test/sign-in', 'https://x.test/sign-in?e=1')).toBe(false);
  });

  it('redacts', () => {
    expect(redact(`token ${COOKIE_SECRET} here`, [COOKIE_SECRET])).toBe(`token ${MASK} here`);
  });

  it('parses login and shot auth flags', () => {
    const env = { RPC_LOGIN_EMAIL: EMAIL, RPC_LOGIN_PASSWORD: PASSWORD };
    const cmd = parseCli(['login', 'localhost:3400/sign-in', '--form'], env);
    expect(cmd).toMatchObject({ command: 'login', url: 'http://localhost:3400/sign-in', form: { email: EMAIL, password: PASSWORD } });
    expect(cmd.command === 'login' && cmd.passwordFromFlag).toBeFalsy();
    expect(() => parseCli(['login', 'localhost:3400', '--form'], {})).toThrow(/RPC_LOGIN_EMAIL/);
    expect(() => parseCli(['login', 'localhost:3400', '--email', 'x'], {})).toThrow(/needs --form/);
    const shot = parseCli(['shot', 'localhost:3400/x', '--cookie', 'a=b', '--cookie', 'c=d', '--header', 'X-A: 1', '--no-session']);
    expect(shot.command === 'shot' && shot.options.auth).toEqual({
      cookies: [
        { name: 'a', value: 'b' },
        { name: 'c', value: 'd' },
      ],
      headers: { 'X-A': '1' },
      useSession: false,
    });
    expect(() => parseCli(['shot', 'localhost:3400', '--cookie', 'a=b; Domain=evil.test'])).toThrow(ArgError);
    expect(() => parseCli(['shot', 'localhost:3400', '--storage-state', join(TMP, 'nope.json')])).toThrow(/not found/);
    expect(parseCli(['sessions'])).toEqual({ command: 'sessions', action: 'list', json: false });
    expect(parseCli(['sessions', 'clear', 'localhost:3000'])).toEqual({ command: 'sessions', action: 'clear', origin: 'localhost:3000', json: false });
  });
});

describe('captures with auth', () => {
  it('--cookie reaches the protected page, and the result masks it', async () => {
    const result = await capture(
      { ...defaultShotOptions(`${APP}/dashboard`), devices: ['iphone-15'], outDir: out('cookie'), auth: { cookies: [{ name: 'sid', value: COOKIE_SECRET }] } },
      { browser }
    );
    expect(result.shots[0]!.error).toBeUndefined();
    expect(result.shots[0]!.title).toBe('Dashboard');
    expect(result.auth?.cookies).toEqual([{ name: 'sid', value: MASK, domain: 'localhost', path: '/' }]);
    expectNoSecrets(JSON.stringify(result));
  });

  it('--header goes to the target origin only, not to third parties or redirects off-origin', async () => {
    thirdParty.length = 0;
    const result = await capture(
      { ...defaultShotOptions(`${APP}/header-page`), devices: ['desktop-1440'], outDir: out('header'), auth: { headers: { 'X-Api-Key': HEADER_SECRET } } },
      { browser }
    );
    expect(result.shots[0]!.title).toBe('Header ok');
    const pixel = thirdParty.find(r => r.url === '/from-header-page.png');
    expect(pixel).toBeDefined();
    expect(pixel!.headers['x-api-key']).toBeUndefined();

    thirdParty.length = 0;
    appHits.length = 0;
    const redirected = await capture(
      { ...defaultShotOptions(`${APP}/redirect-out`), devices: ['desktop-1440'], outDir: out('header-redirect'), auth: { headers: { 'X-Api-Key': HEADER_SECRET } } },
      { browser }
    );
    expect(redirected.shots[0]!.finalUrl).toBe(`${THIRD}/landed`);
    expect(appHits.find(h => h.url === '/redirect-out')!.headers['x-api-key']).toBe(HEADER_SECRET);
    expect(thirdParty.find(r => r.url === '/landed')!.headers['x-api-key']).toBeUndefined();
    expectNoSecrets(JSON.stringify(redirected));
  });

  it('--storage-state loads cookies and localStorage', async () => {
    const file = join(TMP, 'state.json');
    writeFileSync(
      file,
      JSON.stringify({
        cookies: [{ name: 'sid', value: COOKIE_SECRET, domain: 'localhost', path: '/', expires: -1, httpOnly: true, secure: false, sameSite: 'Lax' }],
        origins: [{ origin: APP, localStorage: [{ name: 'token', value: LS_SECRET }] }],
      })
    );
    const ls = await capture({ ...defaultShotOptions(`${APP}/ls`), devices: ['iphone-15'], outDir: out('ls'), auth: { storageState: file } }, { browser });
    expect(ls.shots[0]!.title).toBe('LS ok');
    expect(ls.auth?.storageState).toBe(file);
    const dash = await capture({ ...defaultShotOptions(`${APP}/dashboard`), devices: ['iphone-15'], outDir: out('ls'), auth: { storageState: file } }, { browser });
    expect(dash.shots[0]!.title).toBe('Dashboard');
    expectNoSecrets(JSON.stringify([ls, dash]));
  });
});

describe('rpc login --form and saved sessions', () => {
  let sessionFile: string;
  let savedSid: string;

  it('signs in headlessly, saves a 0600 session in a 0700 dir', async () => {
    const r = await rpc(['login', `${APP}/login`, '--form'], { RPC_LOGIN_EMAIL: EMAIL, RPC_LOGIN_PASSWORD: PASSWORD });
    expect(r.status, r.stderr).toBe(0);
    sessionFile = sessionPath(APP, SESSIONS);
    expect(r.stdout).toContain(`saved session for ${APP}: ${sessionFile}`);
    expect(await fileMode(sessionFile)).toBe(0o600);
    expect(await fileMode(dirname(sessionFile))).toBe(0o700);
    const state = JSON.parse(readFileSync(sessionFile, 'utf8'));
    savedSid = state.cookies.find((c: { name: string }) => c.name === 'sid').value;
    expect(tokens.has(savedSid)).toBe(true);
    expect(state.rpc.origin).toBe(APP);
    expectNoSecrets(r.stdout + r.stderr);
    expect(r.stdout + r.stderr).not.toContain(savedSid);
  });

  it('warns when the password comes from a flag', async () => {
    const r = await rpc(['login', `${APP}/login`, '--form', '--email', EMAIL, '--password', PASSWORD, '--save', join(TMP, 'flag.json')]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toContain('--password is visible in shell history');
    expect(await fileMode(join(TMP, 'flag.json'))).toBe(0o600);
  });

  it('fails clearly on wrong credentials', async () => {
    const r = await rpc(['login', `${APP}/login`, '--form', '--timeout', '3000'], { RPC_LOGIN_EMAIL: EMAIL, RPC_LOGIN_PASSWORD: 'wrong-password-123' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('Still on');
    expect(r.stderr).toContain('Invalid email or password');
    expect(r.stderr).not.toContain('wrong-password-123');
  });

  it('rpc shot uses the saved session automatically (JSON)', async () => {
    const r = await rpc(['shot', `${APP}/dashboard`, '-d', 'iphone', '-o', out('session'), '--json']);
    expect(r.status, r.stderr).toBe(0);
    const json = JSON.parse(r.stdout);
    expect(Object.keys(json)).toEqual(['url', 'outDir', 'shots', 'auth']);
    expect(json.shots[0].title).toBe('Dashboard');
    expect(json.auth.session).toMatchObject({ origin: APP, path: sessionFile, loaded: true, cookies: 1 });
    expect(r.stdout).not.toContain(savedSid);
  });

  it('rpc shot plain output names the session, not its values', async () => {
    const r = await rpc(['shot', `${APP}/dashboard`, '-d', 'iphone', '-o', out('session')]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(new RegExp(`^auth: session ${APP} \\(saved \\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d\\)\\nok iphone-15-pro`));
    expect(r.stdout).not.toContain(savedSid);
  });

  it('--no-session skips it and reports the login redirect', async () => {
    const r = await rpc(['shot', `${APP}/dashboard`, '-d', 'iphone', '-o', out('nosession'), '--no-session', '--json']);
    expect(r.status).toBe(1);
    const s = JSON.parse(r.stdout).shots[0];
    expect(s.code).toBe('AUTH_REQUIRED');
    expect(s.finalUrl).toBe(`${APP}/login?next=/dashboard`);
    expect(s.hint).toBe(`Session missing or expired: run \`rpc login ${APP}\``);
    expect(s.shot).toBeUndefined();
  });

  it('rpc sessions list shows the origin, never values', async () => {
    const r = await rpc(['sessions', '--json']);
    expect(r.status).toBe(0);
    const json = JSON.parse(r.stdout);
    expect(json.sessions).toHaveLength(1);
    expect(json.sessions[0]).toMatchObject({ origin: APP, cookies: 1 });
    expect(r.stdout).not.toContain(savedSid);
    const plain = await rpc(['sessions']);
    expect(plain.stdout).toContain(`${APP}  1 cookie(s)  saved `);
  });

  it('MCP list_sessions lists it without values', async () => {
    const client = await mcpClient();
    try {
      const r = await client.callTool({ name: 'list_sessions', arguments: {} });
      const text = (r.content as { text: string }[])[0]!.text;
      expect(text).toContain(`${APP}: 1 cookie(s)`);
      expect(text).not.toContain(savedSid);
    } finally {
      await client.close();
    }
  });

  it('rpc sessions clear removes it', async () => {
    const r = await rpc(['sessions', 'clear', APP]);
    expect(r.stdout).toBe(`removed ${APP}\n`);
    expect((await rpc(['sessions', '--json'])).stdout).toContain('"sessions": []');
  });
});

describe('missing or expired sessions', () => {
  it('a missing session gives the login hint (plain)', async () => {
    const r = await rpc(['shot', `${APP}/dashboard`, '-d', 'iphone', '-o', out('missing')], { RPC_SESSIONS_DIR: join(TMP, 'empty') });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`x iphone-15-pro (393x852 @3x): Redirected to a login page (${APP}/login) instead of ${APP}/dashboard`);
    expect(r.stderr).toContain(`hint: Session missing or expired: run \`rpc login ${APP}\``);
  });

  it('a session whose cookies have expired is not loaded and gives the same hint', async () => {
    const dir = join(TMP, 'expired');
    mkdirSync(dir, { recursive: true });
    const past = Math.floor(Date.now() / 1000) - 3600;
    await writeSession(
      { cookies: [{ name: 'sid', value: COOKIE_SECRET, domain: 'localhost', path: '/', expires: past, httpOnly: true, secure: false, sameSite: 'Lax' }], origins: [] },
      { origin: APP, savedAt: new Date().toISOString() },
      sessionPath(APP, dir)
    );
    const r = await rpc(['shot', `${APP}/dashboard`, '-d', 'iphone', '-o', out('expired'), '--json'], { RPC_SESSIONS_DIR: dir });
    expect(r.status).toBe(1);
    const json = JSON.parse(r.stdout);
    expect(json.auth.session).toMatchObject({ origin: APP, expired: true, loaded: false });
    expect(json.shots[0].hint).toBe(`Session missing or expired: run \`rpc login ${APP}\``);
    expectNoSecrets(r.stdout);
  });

  it('a session the server no longer accepts gives the same hint', async () => {
    const dir = join(TMP, 'revoked');
    const future = Math.floor(Date.now() / 1000) + 3600;
    await writeSession(
      { cookies: [{ name: 'sid', value: 'revoked-token-0000', domain: 'localhost', path: '/', expires: future, httpOnly: true, secure: false, sameSite: 'Lax' }], origins: [] },
      { origin: APP, savedAt: new Date().toISOString() },
      sessionPath(APP, dir)
    );
    const r = await rpc(['shot', `${APP}/dashboard`, '-d', 'iphone', '-o', out('revoked'), '--json'], { RPC_SESSIONS_DIR: dir });
    const json = JSON.parse(r.stdout);
    expect(json.auth.session).toMatchObject({ loaded: true });
    expect(json.shots[0].code).toBe('AUTH_REQUIRED');
    expect(json.shots[0].hint).toBe(`Session missing or expired: run \`rpc login ${APP}\``);
  });
});

describe('redaction', () => {
  const authArgs = ['--cookie', `sid=${COOKIE_SECRET}`, '--header', `X-Api-Key: ${HEADER_SECRET}`];

  it('plain output', async () => {
    const r = await rpc(['shot', `${APP}/dashboard`, '-d', 'iphone', '-o', out('redact'), ...authArgs]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain(`auth: cookie sid=${MASK}, header X-Api-Key: ${MASK}\nok iphone-15-pro`);
    expectNoSecrets(r.stdout + r.stderr);
  });

  it('JSON output', async () => {
    const r = await rpc(['shot', `${APP}/dashboard`, '-d', 'iphone', '-o', out('redact'), '--json', ...authArgs]);
    expect(r.status, r.stderr).toBe(0);
    const json = JSON.parse(r.stdout);
    expect(json.shots[0].title).toBe('Dashboard');
    expect(json.auth).toEqual({ cookies: [{ name: 'sid', value: MASK, domain: 'localhost', path: '/' }], headers: { 'X-Api-Key': MASK } });
    expectNoSecrets(r.stdout + r.stderr);
  });

  it('usage errors', async () => {
    const r = await rpc(['shot', APP, '--cookie', `sid=${COOKIE_SECRET}; Domain=evil.test`]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('Cookie "sid" has Domain=evil.test');
    expectNoSecrets(r.stderr);
  });

  it('rich output (summary and results boxes)', async () => {
    const opts = { ...defaultShotOptions(`${APP}/dashboard`), devices: ['iphone-15'], outDir: out('rich'), auth: { cookies: [{ name: 'sid', value: COOKIE_SECRET }], headers: { 'X-Api-Key': HEADER_SECRET } } };
    const auth = resolveAuth(opts.url, opts.auth);
    const result = await capture(opts, { browser, auth });
    for (const c of [colors(false), colors(true)]) {
      const text = [...summaryLines(opts, c, auth.summary), ...capturedLines(result, c)].join('\n');
      expect(text.replace(/\x1b\[[0-9;]*m/g, '')).toContain(`cookies:`);
      expect(text).toContain(MASK);
      expectNoSecrets(text);
    }
  });

  it('console errors that echo a secret are scrubbed', async () => {
    const result = await capture(
      { ...defaultShotOptions(`${APP}/echo`), devices: ['iphone-15'], outDir: out('scrub'), auth: { cookies: [{ name: 'sid', value: COOKIE_SECRET }] } },
      { browser }
    );
    expect(result.shots[0]!.consoleErrors).toEqual([`console: cookie sid=${MASK}`]);
    expectNoSecrets(JSON.stringify(result));
  });
});

async function mcpClient(): Promise<Client> {
  const server = createMcpServer();
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(clientT);
  return client;
}

describe('MCP screenshot with auth', () => {
  it('advertises the new params and tool', async () => {
    const client = await mcpClient();
    try {
      const { tools } = await client.listTools();
      expect(tools.map(t => t.name)).toEqual(['screenshot', 'list_devices', 'list_sessions']);
      const props = Object.keys((tools[0]!.inputSchema as { properties: object }).properties);
      expect(props).toEqual(expect.arrayContaining(['cookies', 'headers', 'storageState', 'useSession', 'allowOrigins']));
    } finally {
      await client.close();
    }
  });

  it('captures the protected page with cookies and headers, never echoing them', async () => {
    const client = await mcpClient();
    try {
      const r = await client.callTool({
        name: 'screenshot',
        arguments: {
          url: `${APP}/dashboard`,
          devices: ['iphone-15'],
          outDir: out('mcp'),
          cookies: [{ name: 'sid', value: COOKIE_SECRET }],
          headers: { 'X-Api-Key': HEADER_SECRET },
        },
      });
      expect(r.isError).toBeFalsy();
      const content = r.content as { type: string; text?: string }[];
      const text = content.filter(c => c.type === 'text').map(c => c.text).join('\n');
      expect(text.startsWith(`auth: cookie sid=${MASK}, header X-Api-Key: ${MASK}\nok iphone-15`)).toBe(true);
      const json = JSON.parse(content[0]!.text!.slice(content[0]!.text!.indexOf('\n\n') + 2));
      expect(json.shots[0].title).toBe('Dashboard');
      expect(json.auth.headers).toEqual({ 'X-Api-Key': MASK });
      expect(content.some(c => c.type === 'image')).toBe(true);
      expectNoSecrets(JSON.stringify(r));
    } finally {
      await client.close();
    }
  });

  it('reports the login redirect with the hint', async () => {
    const client = await mcpClient();
    try {
      const r = await client.callTool({ name: 'screenshot', arguments: { url: `${APP}/dashboard`, devices: ['iphone-15'], outDir: out('mcp-missing'), inline: false } });
      expect(r.isError).toBe(true);
      const text = (r.content as { text: string }[])[0]!.text;
      expect(text).toContain(`hint: Session missing or expired: run \`rpc login ${APP}\``);
    } finally {
      await client.close();
    }
  });

  it('rejects an off-origin cookie as a tool error without the value', async () => {
    const client = await mcpClient();
    try {
      const r = await client.callTool({
        name: 'screenshot',
        arguments: { url: `${APP}/dashboard`, cookies: [{ name: 'sid', value: COOKIE_SECRET, domain: 'evil.test' }] },
      });
      expect(r.isError).toBe(true);
      expectNoSecrets(JSON.stringify(r));
    } finally {
      await client.close();
    }
  });
});
