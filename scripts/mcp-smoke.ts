// Spawn the built MCP server over stdio and call list_devices, screenshot and record.
// Usage: pnpm build && pnpm smoke:mcp [url] [--full-page] [--devices a,b] [--max-slices n] [--out dir]
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    'full-page': { type: 'boolean' },
    devices: { type: 'string' },
    'max-slices': { type: 'string' },
    out: { type: 'string' },
  },
});
const url = positionals[0] ?? resolve('test/fixtures/page.html');
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [resolve('dist/cli.js'), 'mcp'],
  stderr: 'inherit',
});
const client = new Client({ name: 'rpc-smoke', version: '0.0.0' });
await client.connect(transport);

const { tools } = await client.listTools();
console.log('tools:', tools.map(t => t.name).join(', '));

const list = await client.callTool({ name: 'list_devices', arguments: { category: 'tablet' } });
console.log('\nlist_devices(tablet):\n' + (list.content as Array<{ text: string }>)[0]!.text);

const t0 = Date.now();
const shot = await client.callTool({
  name: 'screenshot',
  arguments: {
    url,
    devices: values.devices ? values.devices.split(',') : ['iphone', 'ipad', 'desktop-1440'],
    bezels: true,
    fullPage: Boolean(values['full-page']),
    ...(values['max-slices'] ? { maxSlices: Number(values['max-slices']) } : {}),
    outDir: values.out ?? '.rpc-shots/mcp-smoke',
  },
});
console.log(`\nscreenshot (${Date.now() - t0} ms), isError=${Boolean(shot.isError)}`);
let total = 0;
for (const c of shot.content as Array<{ type: string; text?: string; data?: string; mimeType?: string }>) {
  if (c.type === 'text') console.log(c.text);
  else {
    const kb = Math.round((c.data!.length * 3) / 4 / 1024);
    total += kb;
    console.log(`[${c.type} ${c.mimeType} ${kb} KB]`);
  }
}
console.log(`\ninline images: ${total} KB total`);

const t1 = Date.now();
const rec = await client.callTool({
  name: 'record',
  arguments: {
    url: resolve('test/fixtures/motion/carousel.html'),
    device: 'iphone',
    selector: '#carousel',
    duration: 1,
    outDir: values.out ?? '.rpc-shots/mcp-smoke',
  },
});
console.log(`\nrecord (${Date.now() - t1} ms), isError=${Boolean(rec.isError)}`);
for (const c of rec.content as Array<{ type: string; text?: string; data?: string; mimeType?: string }>) {
  if (c.type === 'text') console.log(c.text!.split('\n\n')[0]);
  else console.log(`[${c.type} ${c.mimeType} ${Math.round((c.data!.length * 3) / 4 / 1024)} KB]`);
}
if (rec.isError) process.exitCode = 1;
await client.close();
