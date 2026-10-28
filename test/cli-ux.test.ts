import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ArgError, parseCli, USAGE } from '../src/args.js';
import type { DeviceShot, ShotResult } from '../src/capture.js';
import { DEVICES } from '../src/devices.js';
import { commandHelp, richHelp } from '../src/help.js';
import { defaultShotOptions } from '../src/options.js';
import { openCommand, outputMode } from '../src/term.js';
import {
  banner,
  capturedLines,
  colors,
  devicesTable,
  formatBytes,
  formatList,
  formatMs,
  resultsTable,
  shotCommand,
  summaryLines,
  visibleLength,
} from '../src/ui.js';

const ROOT = resolve(import.meta.dirname, '..');
const CLI = resolve(ROOT, 'src', 'cli.ts');
const ESC = '\x1b[';
const OUT = mkdtempSync(join(tmpdir(), 'rpc-ux-'));
afterAll(() => rmSync(OUT, { recursive: true, force: true }));

/** Spawned with pipes, so stdout is never a TTY. */
function rpc(args: string[], extraEnv: Record<string, string> = {}) {
  const env = { ...process.env, ...extraEnv } as Record<string, string | undefined>;
  for (const k of ['FORCE_COLOR', 'NO_COLOR', 'CI']) if (!(k in extraEnv)) delete env[k];
  return spawnSync(process.execPath, ['--import', 'tsx', CLI, ...args], {
    cwd: ROOT,
    env: env as NodeJS.ProcessEnv,
    encoding: 'utf8',
    timeout: 60_000,
  });
}

describe('outputMode', () => {
  const tty = (env: NodeJS.ProcessEnv, json = false) => outputMode({ isTTY: true, env, json });
  const pipe = (env: NodeJS.ProcessEnv) => outputMode({ isTTY: false, env });

  it('is rich and coloured only on an interactive terminal', () => {
    expect(tty({})).toEqual({ rich: true, color: true });
    expect(pipe({})).toEqual({ rich: false, color: false });
  });

  it('is plain under CI or TERM=dumb', () => {
    expect(tty({ CI: 'true' })).toEqual({ rich: false, color: false });
    expect(tty({ CI: '1' }).rich).toBe(false);
    expect(tty({ TERM: 'dumb' }).rich).toBe(false);
    expect(tty({ CI: '' }).rich).toBe(true);
  });

  it('respects NO_COLOR and FORCE_COLOR', () => {
    expect(tty({ NO_COLOR: '1' })).toEqual({ rich: true, color: false });
    expect(pipe({ FORCE_COLOR: '1' })).toEqual({ rich: false, color: true });
    expect(tty({ FORCE_COLOR: '0' })).toEqual({ rich: true, color: false });
    // Node's precedence (clack colours through util.styleText): FORCE_COLOR wins.
    expect(pipe({ FORCE_COLOR: '1', NO_COLOR: '1' }).color).toBe(true);
    expect(tty({ NO_COLOR: '' }).color).toBe(true);
  });

  it('--json is always plain and colourless', () => {
    expect(tty({}, true)).toEqual({ rich: false, color: false });
    expect(tty({ FORCE_COLOR: '1' }, true)).toEqual({ rich: false, color: false });
  });

  it('picks an opener per platform', () => {
    expect(openCommand('darwin').cmd).toBe('open');
    expect(openCommand('linux').cmd).toBe('xdg-open');
    expect(openCommand('win32').cmd).toBe('explorer');
  });
});

describe('argument compatibility', () => {
  it('accepts every 0.2 shot flag unchanged', () => {
    const cmd = parseCli([
      'shot', 'localhost:3000', '-d', 'iphone,ipad', '-b', '-f', '--slices', '--slice-width', '900',
      '--max-height', '20000', '--reduced-motion', '-o', 'shots', '--wait-for', '#app', '--wait', '200',
      '--color-scheme', 'dark', '--timeout', '5000', '--no-emulate', '--json',
    ]);
    expect(cmd).toEqual({
      command: 'shot',
      json: true,
      open: false,
      options: {
        ...defaultShotOptions('localhost:3000'),
        devices: ['iphone-15-pro', 'ipad-air-11'],
        bezels: true,
        fullPage: true,
        saveSlices: true,
        sliceWidth: 900,
        maxHeight: 20000,
        reducedMotion: true,
        outDir: 'shots',
        waitFor: '#app',
        waitMs: 200,
        colorScheme: 'dark',
        timeoutMs: 5000,
        emulate: false,
      },
    });
  });

  it('adds --open', () => {
    const cmd = parseCli(['shot', 'example.com', '--open']);
    expect(cmd.command === 'shot' && cmd.open).toBe(true);
  });

  it('routes per-command help', () => {
    expect(parseCli([])).toEqual({ command: 'help' });
    expect(parseCli(['-h'])).toEqual({ command: 'help' });
    expect(parseCli(['help', 'shot'])).toEqual({ command: 'help', topic: 'shot' });
    expect(parseCli(['shot', '--help'])).toEqual({ command: 'help', topic: 'shot' });
    expect(parseCli(['shot', 'example.com', '-h'])).toEqual({ command: 'help', topic: 'shot' });
    expect(parseCli(['devices', '-h'])).toEqual({ command: 'help', topic: 'devices' });
    expect(parseCli(['doctor', '--help'])).toEqual({ command: 'help', topic: 'doctor' });
    expect(parseCli(['mcp', '--help'])).toEqual({ command: 'help', topic: 'mcp' });
    expect(() => parseCli(['help', 'nope'])).toThrow(ArgError);
  });

  it('still rejects unknown flags and missing URLs', () => {
    expect(() => parseCli(['shot', 'example.com', '--nope'])).toThrow(ArgError);
    expect(() => parseCli(['shot'])).toThrow(ArgError);
  });
});

function fakeShot(over: Partial<DeviceShot> = {}): DeviceShot {
  return { device: 'iphone-15-pro', name: 'iPhone 15 Pro', viewport: { width: 393, height: 852 }, dpr: 3, ...over };
}

describe('rich renderers', () => {
  const plain = colors(false);
  const tinted = colors(true);

  it('render without escape codes when colour is off (NO_COLOR)', () => {
    const opts = { ...defaultShotOptions('https://example.com'), bezels: true };
    const result: ShotResult = {
      url: opts.url,
      outDir: join(OUT, 'x'),
      shots: [
        fakeShot({ shot: { path: join(OUT, 'x', 'a.png'), width: 1179, height: 2556 }, status: 200, consoleErrors: [] }),
        fakeShot({ device: 'desktop-1440', error: 'boom', code: 'ERR_X', hint: 'do the thing' }),
      ],
    };
    const text = [
      banner(plain),
      devicesTable(plain),
      summaryLines(opts, plain).join('\n'),
      resultsTable(result.shots.map(shot => ({ shot, ms: 1234 })), plain).join('\n'),
      capturedLines(result, plain).join('\n'),
      richHelp(plain),
      commandHelp('shot', plain),
    ].join('\n');
    expect(text).not.toContain(ESC);
    expect(devicesTable(tinted)).toContain(ESC);
  });

  it('lists every device, with aliases', () => {
    const t = devicesTable(plain);
    for (const d of DEVICES) expect(t).toContain(d.id);
    expect(t).toMatch(/iphone-15-pro .*iphone, mobile, phone/);
    expect(t).toContain('Laptops & desktops 15');
  });

  it('aligns the results table columns, coloured or not', () => {
    const rows = [
      { shot: fakeShot({ status: 200, consoleErrors: [] }), ms: 900 },
      { shot: fakeShot({ device: 'desktop-1440', viewport: { width: 1440, height: 900 }, dpr: 1, status: 404, consoleErrors: ['x', 'y'] }), ms: 12_300 },
      { shot: fakeShot({ device: 'pixel-8', error: 'nope', code: 'ERR_NAME_NOT_RESOLVED' }), ms: 80 },
    ];
    for (const c of [plain, tinted]) {
      const lines = resultsTable(rows, c);
      expect(lines).toHaveLength(4);
      const col = (l: string) => l.replace(/\x1b\[[0-9;]*m/g, '').indexOf('status');
      expect(col(lines[0]!)).toBeGreaterThan(0);
      const statusAt = lines.map(l => l.replace(/\x1b\[[0-9;]*m/g, '')).map((l, i) => (i === 0 ? col(l) : l.search(/(200|404|ERR_)/)));
      expect(new Set(statusAt).size).toBe(1);
    }
    const t = resultsTable(rows, plain).join('\n');
    expect(t).toContain('900ms');
    expect(t).toContain('12.3s');
  });

  it('groups identical failures under one hint', () => {
    const fail = { error: 'Could not resolve host x.invalid', code: 'ERR_NAME_NOT_RESOLVED', hint: 'Check the URL.' };
    const lines = capturedLines(
      { url: 'https://x.invalid/', outDir: OUT, shots: [fakeShot(fail), fakeShot({ ...fail, device: 'desktop-1440' })] },
      plain
    );
    expect(lines[0]).toBe('✗ iphone-15-pro, desktop-1440');
    expect(lines.filter(l => l.includes('hint:'))).toHaveLength(1);
  });

  it('lines up the size column in the captured box when dimensions differ in length', () => {
    const dir = join(ROOT, '.rpc-shots', 'ux-align-test');
    mkdirSync(dir, { recursive: true });
    try {
      const shot = (device: string, w: number, h: number, kb: number) => {
        const path = join(dir, `${device}.png`);
        writeFileSync(path, Buffer.alloc(kb * 1024));
        return fakeShot({ device, status: 200, consoleErrors: [], shot: { path, width: w, height: h } });
      };
      const lines = capturedLines(
        { url: 'https://example.com/', outDir: dir, shots: [shot('iphone-15', 1179, 2556, 158), shot('desktop-1440', 1440, 900, 72)] },
        plain
      );
      const rows = lines.filter(l => l.startsWith('✓'));
      expect(rows).toHaveLength(2);
      expect(new Set(rows.map(l => l.search(/\d+×\d+/))).size).toBe(1);
      expect(new Set(rows.map(l => l.indexOf(' · '))).size).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('prints a shot command that parses back to the same options', () => {
    const o = { ...defaultShotOptions('https://example.com/?a=1&b=2'), devices: ['iphone-15-pro', 'ipad-air-11'], bezels: true, fullPage: true, colorScheme: 'dark' as const };
    const cmd = shotCommand(o);
    expect(cmd).toBe(`rpc shot 'https://example.com/?a=1&b=2' -d iphone-15-pro,ipad-air-11 --bezels --full-page --color-scheme dark`);
    const argv = cmd.split(' ').slice(1).map(a => a.replace(/^'|'$/g, ''));
    const parsed = parseCli(argv);
    expect(parsed.command === 'shot' && parsed.options).toEqual(o);
  });

  it('formats sizes, times and lists', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(160_000)).toBe('156 KB');
    expect(formatBytes(3_500_000)).toBe('3.3 MB');
    expect(formatMs(80)).toBe('80ms');
    expect(formatMs(1400)).toBe('1.4s');
    expect(formatList(['a', 'b', 'c', 'd', 'e', 'f', 'g'])).toBe('a, b, c, d, e +2 more');
    expect(visibleLength(tinted.cyan('abc'))).toBe(3);
  });
});

describe('non-TTY output (pipes, agents, CI)', () => {
  it('rpc with no args prints the usage text', () => {
    const r = rpc([]);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(USAGE);
  });

  it('rpc --help is the plain usage, even with CI set', () => {
    expect(rpc(['--help'], { CI: 'true' }).stdout).toBe(USAGE);
  });

  it('per-command help is plain', () => {
    const r = rpc(['shot', '--help']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Usage: rpc shot <url> [options]');
    expect(r.stdout).toContain('--open');
    expect(r.stdout).not.toContain(ESC);
  });

  it('rpc devices keeps the 0.2 table', () => {
    const r = rpc(['devices']);
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain(ESC);
    expect(r.stdout.startsWith('Apple Phones\n  iphone-se            375x667    @2      iPhone SE\n')).toBe(true);
    expect(r.stdout).toContain('Aliases\n  iphone               -> iphone-15-pro\n');
  });

  it('rpc devices --json is pure JSON even with FORCE_COLOR', () => {
    const r = rpc(['devices', '--json'], { FORCE_COLOR: '1' });
    expect(r.stdout).not.toContain(ESC);
    expect(JSON.parse(r.stdout).devices).toHaveLength(DEVICES.length);
  });

  it('FORCE_COLOR colours the plain markers; NO_COLOR keeps them plain', () => {
    const args = ['shot', 'http://127.0.0.1:59321/', '-d', 'iphone', '-o', join(OUT, 'f'), '--timeout', '5000'];
    const forced = rpc(args, { FORCE_COLOR: '1' });
    expect(forced.status).toBe(1);
    expect(forced.stderr).toContain(`${ESC}31mx${ESC}39m iphone-15-pro`);
    const none = rpc(args, { NO_COLOR: '1' });
    expect(none.stderr.startsWith('x iphone-15-pro (393x852 @3x): Connection refused')).toBe(true);
    expect(none.stderr).not.toContain(ESC);
  });

  it('rpc shot --json stays machine-readable with FORCE_COLOR', () => {
    const r = rpc(['shot', 'test/fixtures/page.html', '-d', 'iphone', '-o', join(OUT, 'j'), '--json'], { FORCE_COLOR: '1' });
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain(ESC);
    expect(r.stderr).toBe('');
    const out = JSON.parse(r.stdout);
    expect(out.shots[0].device).toBe('iphone-15-pro');
    expect(Object.keys(out)).toEqual(['url', 'outDir', 'shots']);
  });

  it('rpc shot keeps the 0.2 progress lines', () => {
    const r = rpc(['shot', 'test/fixtures/page.html', '-d', 'iphone', '-o', join(OUT, 'p')]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/^ok iphone-15-pro \(393x852 @3x\)\n   .*file-page-iphone-15-pro\.png  1179x2556\n$/);
  });
});
