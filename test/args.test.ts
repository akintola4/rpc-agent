import { describe, expect, it } from 'vitest';
import { ArgError, parseCli } from '../src/args.js';
import { normalizeUrl } from '../src/options.js';

function shot(...argv: string[]) {
  const cmd = parseCli(['shot', ...argv]);
  if (cmd.command !== 'shot') throw new Error('expected shot');
  return cmd;
}

describe('parseCli', () => {
  it('routes commands', () => {
    expect(parseCli([])).toEqual({ command: 'help' });
    expect(parseCli(['--help'])).toEqual({ command: 'help' });
    expect(parseCli(['mcp'])).toEqual({ command: 'mcp' });
    expect(parseCli(['devices', '--json'])).toEqual({ command: 'devices', json: true });
    expect(() => parseCli(['frobnicate'])).toThrow(ArgError);
  });

  it('applies defaults', () => {
    const { options, json } = shot('https://example.com');
    expect(json).toBe(false);
    expect(options).toEqual({
      url: 'https://example.com/',
      devices: ['iphone-15-pro', 'desktop-1440'],
      bezels: false,
      fullPage: false,
      outDir: '.rpc-shots',
      waitMs: 0,
      timeoutMs: 30000,
      emulate: true,
    });
  });

  it('parses every flag', () => {
    const { options, json } = shot(
      'localhost:3000/about',
      '--devices', 'iphone-15, ipad ,desktop-1440',
      '--bezels', '--full-page',
      '-o', 'shots',
      '--wait-for', '#app',
      '--wait', '250',
      '--color-scheme', 'dark',
      '--timeout', '5000',
      '--no-emulate',
      '--json'
    );
    expect(json).toBe(true);
    expect(options).toEqual({
      url: 'http://localhost:3000/about',
      devices: ['iphone-15', 'ipad-air-11', 'desktop-1440'],
      bezels: true,
      fullPage: true,
      outDir: 'shots',
      waitFor: '#app',
      waitMs: 250,
      colorScheme: 'dark',
      timeoutMs: 5000,
      emulate: false,
    });
  });

  it('accepts short flags', () => {
    const { options } = shot('example.com', '-d', 'pixel', '-b', '-f');
    expect(options.devices).toEqual(['pixel-8']);
    expect(options.bezels && options.fullPage).toBe(true);
  });

  it('rejects bad input', () => {
    expect(() => shot()).toThrow(/Missing <url>/);
    expect(() => shot('a.com', 'b.com')).toThrow(/one URL/);
    expect(() => shot('a.com', '-d', 'nokia-3310')).toThrow(/Unknown device/);
    expect(() => shot('a.com', '--color-scheme', 'sepia')).toThrow(/color-scheme/);
    expect(() => shot('a.com', '--wait', '-5')).toThrow(ArgError);
    expect(() => shot('a.com', '--bogus')).toThrow(ArgError);
  });
});

describe('normalizeUrl', () => {
  it('keeps explicit schemes', () => {
    expect(normalizeUrl('http://localhost:5173')).toBe('http://localhost:5173/');
    expect(normalizeUrl('file:///tmp/x.html')).toBe('file:///tmp/x.html');
  });
  it('defaults local hosts to http and others to https', () => {
    expect(normalizeUrl('localhost:3000')).toBe('http://localhost:3000/');
    expect(normalizeUrl('127.0.0.1:8080/x')).toBe('http://127.0.0.1:8080/x');
    expect(normalizeUrl('example.com/path')).toBe('https://example.com/path');
  });
  it('turns existing local files into file URLs', () => {
    expect(normalizeUrl('./test/fixtures/page.html', process.cwd())).toMatch(/^file:\/\/.*page\.html$/);
  });
  it('rejects other schemes', () => {
    expect(() => normalizeUrl('ftp://x')).toThrow(/Unsupported/);
  });
});
