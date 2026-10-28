#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { relative } from 'node:path';
import { ArgError, parseCli, USAGE } from './args.js';
import { capture, type DeviceShot } from './capture.js';
import { CATEGORY_LABELS, CATEGORY_ORDER, DEVICE_ALIASES, DEVICES } from './devices.js';

async function main(argv: string[]): Promise<number> {
  const cmd = parseCli(argv);
  switch (cmd.command) {
    case 'help':
      process.stdout.write(USAGE);
      return 0;
    case 'version': {
      const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
      console.log(pkg.version);
      return 0;
    }
    case 'devices':
      if (cmd.json) {
        console.log(JSON.stringify({ devices: DEVICES, aliases: DEVICE_ALIASES }, null, 2));
      } else {
        process.stdout.write(formatDeviceTable());
      }
      return 0;
    case 'mcp': {
      const { runMcpServer } = await import('./mcp.js');
      await runMcpServer();
      return -1; // keep running; stdio transport owns the process
    }
    case 'shot': {
      const result = await capture(cmd.options, cmd.json ? {} : { onDevice: printShot });
      if (cmd.json) console.log(JSON.stringify(result, null, 2));
      return result.shots.some(s => s.error) ? 1 : 0;
    }
  }
}

function rel(p: string): string {
  const r = relative(process.cwd(), p);
  return r.startsWith('..') ? p : r;
}

function printShot(s: DeviceShot): void {
  const label = `${s.device} (${s.viewport.width}x${s.viewport.height} @${s.dpr}x)`;
  if (s.error) {
    console.error(`x ${label}: ${s.error}`);
    if (s.hint) console.error(`   hint: ${s.hint}`);
    return;
  }
  const lines = [`ok ${label}${s.status && s.status >= 400 ? ` HTTP ${s.status}` : ''}`];
  if (s.shot) lines.push(`   ${rel(s.shot.path)}  ${s.shot.width}x${s.shot.height}${s.clipped ? ' (clipped)' : ''}`);
  if (s.framed) lines.push(`   ${rel(s.framed.path)}  ${s.framed.width}x${s.framed.height}`);
  if (s.consoleErrors?.length) lines.push(`   ${s.consoleErrors.length} console error(s), first: ${s.consoleErrors[0]}`);
  console.log(lines.join('\n'));
}

export function formatDeviceTable(): string {
  const out: string[] = [];
  for (const cat of CATEGORY_ORDER) {
    out.push(CATEGORY_LABELS[cat]);
    for (const d of DEVICES.filter(x => x.category === cat)) {
      out.push(`  ${d.id.padEnd(20)} ${`${d.width}x${d.height}`.padEnd(10)} @${String(d.dpr).padEnd(6)} ${d.name}`);
    }
    out.push('');
  }
  out.push('Aliases');
  for (const [alias, id] of Object.entries(DEVICE_ALIASES)) out.push(`  ${alias.padEnd(20)} -> ${id}`);
  return out.join('\n') + '\n';
}

main(process.argv.slice(2)).then(
  code => {
    if (code >= 0) process.exitCode = code;
  },
  err => {
    if (err instanceof ArgError) {
      console.error(`rpc: ${err.message}`);
      process.exitCode = 2;
    } else {
      console.error(`rpc: ${(err as Error).message}`);
      process.exitCode = 1;
    }
  }
);
