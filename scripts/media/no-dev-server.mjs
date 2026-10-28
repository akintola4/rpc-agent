// Preloaded into the recorded `rpc` run (node --import) so the "Found a dev
// server" probe sees nothing on localhost, whatever the recording machine has
// running. Probes of the dev ports are pointed at port 1, which refuses.
import net from 'node:net';
import { syncBuiltinESMExports } from 'node:module';

const PORTS = new Set([3000, 5173, 4321, 8080]);
const connect = net.connect;
net.connect = net.createConnection = function (opts, ...rest) {
  if (opts && typeof opts === 'object' && opts.host === 'localhost' && PORTS.has(Number(opts.port))) {
    return connect.call(this, { ...opts, port: 1 }, ...rest);
  }
  return connect.call(this, opts, ...rest);
};
syncBuiltinESMExports();
