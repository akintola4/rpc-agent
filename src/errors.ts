/** A navigation/capture failure turned into something an agent can act on. */
export interface ExplainedError {
  /** One-line message, e.g. `Could not resolve host example.test (net::ERR_NAME_NOT_RESOLVED)`. */
  error: string;
  /** `ERR_NAME_NOT_RESOLVED`, `TIMEOUT`, `WAIT_FOR_TIMEOUT`, ... or `UNKNOWN`. */
  code: string;
  /** What to do about it, when we can say. */
  hint?: string;
}

export interface ErrorContext {
  url: string;
  timeoutMs?: number;
  waitFor?: string | undefined;
}

const SANDBOX_HINT =
  'If the host works in a normal browser, this process may be blocked by a sandbox or network allowlist ' +
  '(e.g. the Claude Code sandbox: add the domain to the allowed hosts, or run outside the sandbox). ' +
  'Note that nslookup can succeed while the sandboxed process still cannot connect.';

function isLocalHost(host: string): boolean {
  return /^(localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|\[::1\]|::1)$/i.test(host) || host.endsWith('.localhost');
}

function describeTarget(url: string): { host: string; local: boolean; file: boolean; port: string } {
  try {
    const u = new URL(url);
    const port = u.port || (u.protocol === 'https:' ? '443' : u.protocol === 'http:' ? '80' : '');
    return { host: u.host || u.pathname, local: isLocalHost(u.hostname), file: u.protocol === 'file:', port };
  } catch {
    return { host: url, local: false, file: false, port: '' };
  }
}

/** Map a Playwright/Chromium error to `{ error, code, hint }`. */
export function explainError(err: unknown, ctx: ErrorContext): ExplainedError {
  const raw = err instanceof Error ? err.message : String(err);
  const first = (raw.split('\n')[0] ?? raw).trim();
  const t = describeTarget(ctx.url);
  const net = /net::(ERR_[A-Z0-9_]+)/.exec(raw)?.[1];

  if (net) {
    const tag = `(net::${net})`;
    switch (net) {
      case 'ERR_NAME_NOT_RESOLVED':
      case 'ERR_NAME_RESOLUTION_FAILED':
        return {
          code: net,
          error: `Could not resolve host ${t.host} ${tag}`,
          hint: t.local
            ? `Check the host name in the URL.`
            : `Check the URL for typos. ${SANDBOX_HINT}`,
        };
      case 'ERR_CONNECTION_REFUSED':
        return {
          code: net,
          error: `Connection refused by ${t.host} ${tag}`,
          hint: t.local
            ? `Nothing is listening on port ${t.port}. Start the dev server (or check which port it printed) and retry.`
            : `The server refused the connection. ${SANDBOX_HINT}`,
        };
      case 'ERR_INTERNET_DISCONNECTED':
        return {
          code: net,
          error: `No network connection ${tag}`,
          hint: `This process has no network access. ${SANDBOX_HINT}`,
        };
      case 'ERR_PROXY_CONNECTION_FAILED':
      case 'ERR_TUNNEL_CONNECTION_FAILED':
      case 'ERR_PROXY_AUTH_REQUESTED':
      case 'ERR_PROXY_CERTIFICATE_INVALID':
      case 'ERR_NO_SUPPORTED_PROXIES':
        return {
          code: net,
          error: `Proxy refused the connection to ${t.host} ${tag}`,
          hint: `Traffic goes through a proxy that did not allow this host. ${SANDBOX_HINT}`,
        };
      case 'ERR_CONNECTION_TIMED_OUT':
      case 'ERR_TIMED_OUT':
      case 'ERR_ADDRESS_UNREACHABLE':
      case 'ERR_NETWORK_ACCESS_DENIED':
      case 'ERR_CONNECTION_RESET':
      case 'ERR_CONNECTION_CLOSED':
      case 'ERR_CONNECTION_FAILED':
      case 'ERR_EMPTY_RESPONSE':
      case 'ERR_BLOCKED_BY_ADMINISTRATOR':
        return {
          code: net,
          error: `Could not connect to ${t.host} ${tag}`,
          hint: t.local
            ? `Check that the dev server on port ${t.port} is running and healthy.`
            : `The host is unreachable from here. ${SANDBOX_HINT}`,
        };
      case 'ERR_SSL_PROTOCOL_ERROR':
      case 'ERR_SSL_VERSION_OR_CIPHER_MISMATCH':
        return {
          code: net,
          error: `TLS handshake with ${t.host} failed ${tag}`,
          hint: t.local
            ? `The server probably speaks plain HTTP. Use http:// instead of https://.`
            : `The server's TLS setup is broken or something intercepts the connection.`,
        };
      case 'ERR_FILE_NOT_FOUND':
        return { code: net, error: `File not found: ${t.host} ${tag}`, hint: `Check the path; relative paths resolve against the working directory.` };
      case 'ERR_TOO_MANY_REDIRECTS':
        return { code: net, error: `Redirect loop at ${t.host} ${tag}`, hint: `The page redirects to itself; check auth/locale redirects on the server.` };
      case 'ERR_ABORTED':
        return { code: net, error: `Navigation to ${ctx.url} was aborted ${tag}`, hint: `The URL may trigger a download or an immediate client-side redirect.` };
      default:
        return { code: net, error: first };
    }
  }

  if (/TimeoutError|Timeout \d+ms exceeded/i.test(raw)) {
    const secs = ctx.timeoutMs ? `${Math.round(ctx.timeoutMs / 1000)} s` : 'the timeout';
    if (/waitForSelector|waiting for locator/i.test(raw) && ctx.waitFor) {
      return {
        code: 'WAIT_FOR_TIMEOUT',
        error: `Selector "${ctx.waitFor}" did not become visible within ${secs}`,
        hint: `Check the selector, or that the page reaches that state without interaction.`,
      };
    }
    if (/goto|navigat/i.test(raw)) {
      return {
        code: 'TIMEOUT',
        error: `Loading ${t.host} did not finish within ${secs}`,
        hint: t.local
          ? `The dev server may still be compiling; retry or raise timeoutMs.`
          : `Raise timeoutMs if the site is slow. A silently dropped connection can also mean the host is blocked: ${SANDBOX_HINT}`,
      };
    }
    return { code: 'TIMEOUT', error: first, hint: `Raise timeoutMs or waitMs and retry.` };
  }

  return { code: 'UNKNOWN', error: first };
}
