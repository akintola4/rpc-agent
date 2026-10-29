#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { relative } from 'node:path';
import { ArgError, parseCli, USAGE, type LoginCommand } from './args.js';
import { clearSessions, describeAuth, listSessions, sessionsDir, type SessionInfo } from './auth.js';
import { doctor, installChromium, type DoctorReport } from './browser.js';
import { capture, type DeviceShot } from './capture.js';
import { CATEGORY_LABELS, CATEGORY_ORDER, DEVICE_ALIASES, DEVICES } from './devices.js';
import { currentMode, openPath, waitForEnter } from './term.js';

/** Plain-output colours: identity unless FORCE_COLOR asks for colour. */
interface Paint {
  ok: (s: string) => string;
  bad: (s: string) => string;
  warn: (s: string) => string;
}
const NO_PAINT: Paint = { ok: s => s, bad: s => s, warn: s => s };
let paint: Paint = NO_PAINT;

async function plainPaint(): Promise<Paint> {
  if (!currentMode().color) return NO_PAINT;
  const { default: pc } = await import('picocolors');
  const c = pc.createColors(true);
  return { ok: c.green, bad: c.red, warn: c.yellow };
}

// Loaded only for rich (interactive terminal) runs; `rpc mcp` and --json
// never import clack.
async function loadUi() {
  const ui = await import('./ui.js');
  return { ui, c: ui.colors(currentMode().color) };
}

async function main(argv: string[]): Promise<number> {
  const cmd = parseCli(argv);
  if (cmd.command === 'mcp') {
    const { runMcpServer } = await import('./mcp.js');
    await runMcpServer();
    return -1; // keep running; stdio transport owns the process
  }
  const json = 'json' in cmd && cmd.json;
  const mode = currentMode(json);
  if (!mode.rich && !json) paint = await plainPaint();

  switch (cmd.command) {
    case 'help': {
      if (argv.length === 0 && mode.rich) {
        const { ui, c } = await loadUi();
        return ui.runInteractive(c);
      }
      if (!cmd.topic && !mode.rich) {
        process.stdout.write(USAGE);
        return 0;
      }
      const { commandHelp, richHelp } = await import('./help.js');
      const { default: pc } = await import('picocolors');
      const c = pc.createColors(mode.color);
      process.stdout.write(cmd.topic ? commandHelp(cmd.topic, c) : richHelp(c));
      return 0;
    }
    case 'version': {
      const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
      console.log(pkg.version);
      return 0;
    }
    case 'devices':
      if (cmd.json) {
        console.log(JSON.stringify({ devices: DEVICES, aliases: DEVICE_ALIASES }, null, 2));
      } else if (mode.rich) {
        const { ui, c } = await loadUi();
        ui.printDevices(c);
      } else {
        process.stdout.write(formatDeviceTable());
      }
      return 0;
    case 'doctor': {
      if (mode.rich) {
        const { ui, c } = await loadUi();
        return ui.runDoctor(doctor, c);
      }
      const report = await doctor();
      if (cmd.json) console.log(JSON.stringify(report, null, 2));
      else printDoctor(report);
      return report.ok ? 0 : 1;
    }
    case 'install': {
      const code = await installChromium({ headed: Boolean(cmd.headed) });
      if (code !== 0) return code;
      if (mode.rich) {
        const { ui, c } = await loadUi();
        return ui.runDoctor(doctor, c);
      }
      const report = await doctor();
      printDoctor(report);
      return report.ok ? 0 : 1;
    }
    case 'shot': {
      if (mode.rich) {
        const { ui, c } = await loadUi();
        return ui.runShot(cmd.options, { open: cmd.open }, c);
      }
      const result = await capture(
        cmd.options,
        cmd.json ? {} : { onDevice: printShot, onAuth: a => console.log(`auth: ${describeAuth(a)}`) }
      );
      if (cmd.json) console.log(JSON.stringify(result, null, 2));
      if (cmd.open && result.shots.some(s => !s.error)) openPath(result.outDir);
      return result.shots.some(s => s.error) ? 1 : 0;
    }
    case 'login': {
      if (cmd.passwordFromFlag) {
        console.error(`rpc: ${paint.warn('warning:')} --password is visible in shell history and the process list; set RPC_LOGIN_PASSWORD instead`);
      }
      if (mode.rich) {
        const { ui, c } = await loadUi();
        return ui.runLogin(cmd, c);
      }
      return plainLogin(cmd);
    }
    case 'sessions': {
      if (mode.rich) {
        const { ui, c } = await loadUi();
        return ui.runSessions(cmd.action, cmd.origin, c);
      }
      if (cmd.action === 'clear') {
        const gone = await clearSessions(cmd.origin);
        if (cmd.json) console.log(JSON.stringify({ removed: gone }, null, 2));
        else if (gone.length === 0) console.log(cmd.origin ? `No saved session for ${cmd.origin}` : 'No saved sessions');
        else for (const o of gone) console.log(`removed ${o}`);
        return 0;
      }
      const list = await listSessions();
      if (cmd.json) console.log(JSON.stringify({ dir: sessionsDir(), sessions: list }, null, 2));
      else if (list.length === 0) console.log(`No saved sessions in ${sessionsDir()}. Create one with: rpc login <url>`);
      else for (const s of list) console.log(sessionLine(s));
      return 0;
    }
  }
}

async function plainLogin(cmd: LoginCommand): Promise<number> {
  const { formLogin, interactiveLogin } = await import('./login.js');
  let result;
  if (cmd.form) {
    if (!cmd.json) console.log(`signing in at ${cmd.url} (headless form)`);
    result = await formLogin(cmd, cmd.form);
  } else {
    const enter = waitForEnter();
    try {
      result = await interactiveLogin(cmd, enter.promise, () => {
        if (!cmd.json) console.log(`Opened ${cmd.url}. Sign in in the browser window, then press Enter here (or close the window).`);
      });
    } finally {
      enter.stop();
    }
  }
  if (cmd.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`${paint.ok('saved')} session for ${result.origin}: ${result.path} (${result.cookies} cookie(s), ${result.localStorage} localStorage origin(s))`);
    if (result.stillOnLogin) {
      console.error(`${paint.warn('warning:')} the page was still on a login URL (${result.finalUrl}); the sign-in may not have finished`);
    }
  }
  return 0;
}

function sessionLine(s: SessionInfo): string {
  const when = (iso?: string) => (iso ? iso.slice(0, 16).replace('T', ' ') : '');
  const parts = [s.origin, `${s.cookies} cookie(s)`];
  if (s.savedAt) parts.push(`saved ${when(s.savedAt)}`);
  if (s.expired) parts.push(paint.bad(`expired ${when(s.expires)}`));
  else if (s.expires) parts.push(`expires ${when(s.expires)}`);
  parts.push(rel(s.path));
  return parts.join('  ');
}

function rel(p: string): string {
  const r = relative(process.cwd(), p);
  return r.startsWith('..') ? p : r;
}

function printDoctor(r: DoctorReport): void {
  console.log(`node        ${r.node}`);
  console.log(`playwright  ${r.playwright}`);
  console.log(`browsers    ${r.browsersPath}`);
  if (r.ok) {
    console.log(`chromium    ${paint.ok('ok')} (${r.version})`);
    return;
  }
  console.log(`chromium    ${paint.bad(r.chromium)}`);
  console.error(`rpc: ${r.error}`);
  if (r.chromium === 'missing') console.error('Run `rpc install` to download it now.');
}

function printShot(s: DeviceShot): void {
  const label = `${s.device} (${s.viewport.width}x${s.viewport.height} @${s.dpr}x)`;
  if (s.error) {
    console.error(`${paint.bad('x')} ${label}: ${s.error}`);
    if (s.hint) console.error(`   ${paint.warn('hint:')} ${s.hint}`);
    return;
  }
  const lines = [`${paint.ok('ok')} ${label}${s.status && s.status >= 400 ? ` HTTP ${s.status}` : ''}`];
  if (s.shot) {
    const extra = [
      s.segments && s.segments > 1 ? `${s.segments} segments stitched` : '',
      s.clipped ? `clipped at ${s.capturedHeight} of ${s.scrollHeight} css px` : '',
    ].filter(Boolean);
    lines.push(`   ${rel(s.shot.path)}  ${s.shot.width}x${s.shot.height}${extra.length ? ` (${extra.join(', ')})` : ''}`);
  }
  if (s.framed) lines.push(`   ${rel(s.framed.path)}  ${s.framed.width}x${s.framed.height}`);
  if (s.slices?.saved && s.slices.items[0]?.path) {
    const first = rel(s.slices.items[0].path);
    lines.push(`   ${first.replace(/-slice-\d+\.jpg$/, '-slice-NN.jpg')}  ${s.slices.total} slice(s), ${s.slices.items[0].width}px wide`);
  }
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
