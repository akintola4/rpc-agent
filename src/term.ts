import { spawn } from 'node:child_process';

// Output-mode decisions. Pure: no imports of the UI libraries, so `rpc mcp`
// and the --json paths never load them.

export interface OutputMode {
  /** Banner, clack rail, spinners, prompts and boxes. */
  rich: boolean;
  /** ANSI colour (in either layout). */
  color: boolean;
}

export interface ModeInput {
  isTTY: boolean;
  env: NodeJS.ProcessEnv;
  json?: boolean;
}

function set(v: string | undefined): boolean {
  return v !== undefined && v !== '';
}

/**
 * Rich output needs a real terminal: stdout is a TTY, not CI, TERM isn't
 * `dumb`, and no --json. NO_COLOR turns colour off; FORCE_COLOR (except `0`)
 * turns it on, even for the plain layout, and wins over NO_COLOR.
 */
export function outputMode({ isTTY, env, json = false }: ModeInput): OutputMode {
  if (json) return { rich: false, color: false };
  const rich = isTTY && !set(env.CI) && env.TERM !== 'dumb';
  // Same precedence as Node's own util.styleText, which clack uses for its
  // symbols: FORCE_COLOR beats NO_COLOR, NO_COLOR beats the TTY check.
  let color = rich;
  if (set(env.NO_COLOR)) color = false;
  if (set(env.FORCE_COLOR)) color = env.FORCE_COLOR !== '0';
  return { rich, color };
}

export function currentMode(json = false): OutputMode {
  return outputMode({ isTTY: Boolean(process.stdout.isTTY), env: process.env, json });
}

/** Command that opens a folder or file in the desktop shell. */
export function openCommand(platform: NodeJS.Platform = process.platform): { cmd: string; args: string[] } {
  if (platform === 'darwin') return { cmd: 'open', args: [] };
  if (platform === 'win32') return { cmd: 'explorer', args: [] };
  return { cmd: 'xdg-open', args: [] };
}

/** Open a folder or file in the desktop shell, detached and silent. */
export function openPath(path: string): boolean {
  const { cmd, args } = openCommand();
  try {
    const child = spawn(cmd, [...args, path], { detached: true, stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve when a line (Enter) arrives on stdin. EOF never resolves it, so a
 * caller can race it against something else (the login window closing).
 */
export function waitForEnter(input: NodeJS.ReadStream = process.stdin): { promise: Promise<void>; stop: () => void } {
  let onData: (chunk: Buffer | string) => void = () => {};
  const promise = new Promise<void>(res => {
    onData = chunk => {
      if (/[\r\n]/.test(String(chunk))) res();
    };
    input.on('data', onData);
    input.resume();
  });
  const stop = () => {
    input.off('data', onData);
    input.pause();
  };
  return { promise, stop };
}
