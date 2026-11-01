import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';

/**
 * Wraps a test server's handler so a throw (a missing fixture file, say)
 * answers 500 with the error message instead of leaving the request open
 * until the test times out.
 */
export function failFast(handler: (req: IncomingMessage, res: ServerResponse) => unknown): RequestListener {
  return async (req, res) => {
    try {
      await handler(req, res);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' });
      res.end(message);
    }
  };
}
