import { describe, expect, it } from 'vitest';
import { explainError } from '../src/errors.js';

const gotoErr = (code: string, url: string) =>
  new Error(`page.goto: net::${code} at ${url}\nCall log:\n  - navigating to "${url}", waiting until "load"`);

describe('explainError', () => {
  it('DNS failure on a public host mentions the sandbox allowlist', () => {
    const e = explainError(gotoErr('ERR_NAME_NOT_RESOLVED', 'https://devakintola.vercel.app/'), {
      url: 'https://devakintola.vercel.app/',
    });
    expect(e.code).toBe('ERR_NAME_NOT_RESOLVED');
    expect(e.error).toBe('Could not resolve host devakintola.vercel.app (net::ERR_NAME_NOT_RESOLVED)');
    expect(e.hint).toMatch(/sandbox or network allowlist/);
    expect(e.hint).toMatch(/Claude Code sandbox/);
  });

  it('refused connection on localhost points at the dev server port', () => {
    const e = explainError(gotoErr('ERR_CONNECTION_REFUSED', 'http://localhost:3000/'), { url: 'http://localhost:3000/' });
    expect(e.code).toBe('ERR_CONNECTION_REFUSED');
    expect(e.hint).toMatch(/Nothing is listening on port 3000/);
  });

  it('refused connection on a public host suggests the allowlist', () => {
    const e = explainError(gotoErr('ERR_CONNECTION_REFUSED', 'https://example.com/'), { url: 'https://example.com/' });
    expect(e.hint).toMatch(/allowlist/);
  });

  it('proxy, tunnel and offline errors', () => {
    for (const code of ['ERR_PROXY_CONNECTION_FAILED', 'ERR_TUNNEL_CONNECTION_FAILED', 'ERR_INTERNET_DISCONNECTED']) {
      const e = explainError(gotoErr(code, 'https://example.com/'), { url: 'https://example.com/' });
      expect(e.code).toBe(code);
      expect(e.hint).toMatch(/allowlist/);
    }
  });

  it('TLS error on localhost suggests http://', () => {
    const e = explainError(gotoErr('ERR_SSL_PROTOCOL_ERROR', 'https://localhost:5173/'), { url: 'https://localhost:5173/' });
    expect(e.hint).toMatch(/http:\/\//);
  });

  it('navigation timeouts', () => {
    const err = Object.assign(new Error('page.goto: Timeout 30000ms exceeded.\nCall log: navigating to ...'), { name: 'TimeoutError' });
    const pub = explainError(err, { url: 'https://example.com/', timeoutMs: 30000 });
    expect(pub).toMatchObject({ code: 'TIMEOUT', error: 'Loading example.com did not finish within 30 s' });
    expect(pub.hint).toMatch(/timeoutMs/);
    expect(pub.hint).toMatch(/allowlist/);
    const local = explainError(err, { url: 'http://localhost:3000/', timeoutMs: 30000 });
    expect(local.hint).toMatch(/compiling/);
  });

  it('waitFor timeouts name the selector', () => {
    const err = new Error('page.waitForSelector: Timeout 5000ms exceeded.\nwaiting for locator(\'#app\') to be visible');
    const e = explainError(err, { url: 'http://localhost:3000/', timeoutMs: 5000, waitFor: '#app' });
    expect(e.code).toBe('WAIT_FOR_TIMEOUT');
    expect(e.error).toMatch(/"#app"/);
  });

  it('unknown errors keep the first line and no hint', () => {
    const e = explainError(new Error('boom\nstack'), { url: 'https://example.com/' });
    expect(e).toEqual({ code: 'UNKNOWN', error: 'boom' });
    const n = explainError(gotoErr('ERR_UNKNOWN_URL_SCHEME', 'x://y'), { url: 'x://y' });
    expect(n.code).toBe('ERR_UNKNOWN_URL_SCHEME');
    expect(n.hint).toBeUndefined();
  });
});
