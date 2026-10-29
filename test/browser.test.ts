import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { parseCli } from '../src/args.js';

const ROOT = resolve(import.meta.dirname, '..');
const CLI = resolve(ROOT, 'src', 'cli.ts');
// An empty browsers dir: Playwright looks there and finds no Chromium. The
// real browser cache is never touched.
const EMPTY = mkdtempSync(join(tmpdir(), 'rpc-no-browsers-'));
const noBrowserEnv = { ...process.env, PLAYWRIGHT_BROWSERS_PATH: EMPTY } as Record<string, string>;

function rpc(args: string[], env: NodeJS.ProcessEnv = noBrowserEnv) {
  return spawnSync(process.execPath, ['--import', 'tsx', CLI, ...args], { cwd: ROOT, env, encoding: 'utf8', timeout: 60_000 });
}

afterAll(() => rmSync(EMPTY, { recursive: true, force: true }));

describe('missing Chromium', () => {
  it('parses doctor and install', () => {
    expect(parseCli(['doctor'])).toEqual({ command: 'doctor', json: false });
    expect(parseCli(['doctor', '--json'])).toEqual({ command: 'doctor', json: true });
    expect(parseCli(['install'])).toEqual({ command: 'install' });
  });

  it('rpc shot fails with the fix, not a Playwright banner', () => {
    const r = rpc(['shot', 'test/fixtures/page.html', '-d', 'iphone', '-o', join(EMPTY, 'out')]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/^rpc: Playwright's Chromium is not installed \(expected .*rpc-no-browsers-/);
    expect(r.stderr).toContain('npx rpc-agent install');
    expect(r.stderr).toContain('rpc install');
    expect(r.stderr).not.toContain('╔');
  });

  it('rpc doctor reports missing and exits 1', () => {
    const r = rpc(['doctor', '--json']);
    expect(r.status).toBe(1);
    const report = JSON.parse(r.stdout);
    expect(report).toMatchObject({ ok: false, chromium: 'missing', browsersPath: EMPTY });
    expect(report.fix).toContain('npx rpc-agent install');
  });

  it('rpc doctor passes with the real browser', () => {
    const env = { ...process.env };
    delete env.PLAYWRIGHT_BROWSERS_PATH;
    const r = rpc(['doctor'], env);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/chromium\s+ok \(\d+\./);
  });

  it('the MCP server stays up and returns the fix as a tool error', async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['--import', 'tsx', CLI, 'mcp'],
      cwd: ROOT,
      env: noBrowserEnv,
      stderr: 'pipe',
    });
    const client = new Client({ name: 'test', version: '0' });
    await client.connect(transport);
    try {
      const res = await client.callTool({ name: 'screenshot', arguments: { url: 'https://example.com' } });
      expect(res.isError).toBe(true);
      const text = (res.content as Array<{ text: string }>)[0]!.text;
      expect(text).toMatch(/^Could not start the browser: Playwright's Chromium is not installed/);
      expect(text).toContain('npx rpc-agent install');
      // Still serving after the failure.
      const list = await client.callTool({ name: 'list_devices', arguments: {} });
      expect(list.isError).toBeFalsy();
    } finally {
      await client.close();
    }
  }, 60_000);
});
