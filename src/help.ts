import pc from 'picocolors';
import type { HelpTopic } from './args.js';

type Colors = ReturnType<typeof pc.createColors>;
type Row = [left: string, right: string];

interface CommandHelp {
  usage: string;
  summary: string;
  options?: Row[];
  examples: Row[];
}

const SHOT_OPTIONS: Row[] = [
  ['-d, --devices <ids>', 'comma-separated device ids or aliases (default: iphone-15-pro,desktop-1440)'],
  ['-b, --bezels', 'also write a copy framed in the device bezel'],
  ['-f, --full-page', 'capture the full scroll height (stitched, any height)'],
  ['    --slices', 'with --full-page: also write viewport-tall JPEG review slices'],
  ['    --slice-width <px>', 'max slice width (default: 768)'],
  ['    --max-height <px>', 'full-page cap in CSS px (default: 60000)'],
  ['    --reduced-motion', 'emulate prefers-reduced-motion: reduce'],
  ['-o, --out <dir>', 'output directory (default: ./.rpc-shots)'],
  ['    --wait-for <selector>', 'wait for a CSS selector before capturing'],
  ['    --wait <ms>', 'extra settle delay after load (default: 0)'],
  ['    --color-scheme <s>', 'light | dark | no-preference'],
  ['    --timeout <ms>', 'navigation timeout (default: 30000)'],
  ['    --no-emulate', 'viewport + DPR only (no mobile UA / touch)'],
  ['    --open', 'open the output folder when done'],
  ['    --json', 'print the result as JSON (no colour, no progress)'],
];

export const COMMANDS: Record<HelpTopic, CommandHelp> = {
  shot: {
    usage: 'rpc shot <url> [options]',
    summary: 'Capture a URL at device viewports, optionally framed in device bezels.',
    options: SHOT_OPTIONS,
    examples: [
      ['rpc shot localhost:3000 -d iphone-15,ipad,desktop-1440 --bezels', ''],
      ['rpc shot example.com/pricing --full-page --slices', 'whole page + review slices'],
      ['rpc shot localhost:5173 --color-scheme dark --open', 'dark mode, open when done'],
      ['rpc shot localhost:3000 -d pixel --json', 'machine-readable result'],
    ],
  },
  devices: {
    usage: 'rpc devices [--json]',
    summary: 'List the 49 device ids, their CSS viewport, pixel ratio and aliases.',
    options: [['    --json', 'print devices and aliases as JSON']],
    examples: [
      ['rpc devices', ''],
      ['rpc devices --json', 'for scripts'],
    ],
  },
  doctor: {
    usage: 'rpc doctor [--json]',
    summary: "Check that Playwright's Chromium is installed and launches.",
    options: [['    --json', 'print the report as JSON']],
    examples: [['rpc doctor', 'exits 1 when Chromium is missing']],
  },
  install: {
    usage: 'rpc install',
    summary: "Download Playwright's Chromium with the Playwright version rpc uses, then run doctor.",
    examples: [['rpc install', '']],
  },
  mcp: {
    usage: 'rpc mcp',
    summary: 'Run the MCP server on stdio (tools: screenshot, list_devices).',
    examples: [['claude mcp add --scope user rpc -- node /abs/path/dist/cli.js mcp', 'add to Claude Code']],
  },
};

const TOP: Row[] = [
  ['shot <url>', 'capture screenshots'],
  ['devices', 'list device ids and aliases'],
  ['doctor', "check that Playwright's Chromium is installed and launches"],
  ['install', "download Playwright's Chromium (same version rpc uses)"],
  ['mcp', 'run the MCP server on stdio'],
  ['help <command>', 'options and examples for one command'],
];

function pad(rows: Row[]): number {
  return Math.max(...rows.map(([l]) => l.length));
}

function examples(rows: Row[], c: Colors): string[] {
  const width = Math.max(0, ...rows.filter(([, d]) => d).map(([cmd]) => cmd.length));
  return rows.map(([cmd, d]) => {
    const comment = d ? `${' '.repeat(Math.max(2, width - cmd.length + 2))}${c.dim(`# ${d}`)}` : '';
    return `  ${c.dim('$')} ${cmd}${comment}`;
  });
}

function table(rows: Row[], c: Colors, indent = 2): string[] {
  const w = pad(rows);
  return rows.map(([l, r]) => `${' '.repeat(indent)}${l.padEnd(w)}   ${c.dim(r)}`);
}

/** Top-level help, styled. (Plain mode prints USAGE from args.ts unchanged.) */
export function richHelp(c: Colors): string {
  const out = [
    '',
    `${c.bold('rpc')} ${c.dim('— screenshot a URL at device viewports, optionally in device bezels')}`,
    '',
    `${c.bold('Usage:')} rpc ${c.dim('[command] [options]')}`,
    '',
    `  ${c.dim('$')} rpc                          ${c.dim('# interactive: pick a URL, devices and options')}`,
    '',
    c.bold('Commands:'),
    ...table(TOP, c),
    '',
    c.bold('Shot options:'),
    ...table(SHOT_OPTIONS, c),
    '',
    c.bold('Examples:'),
    ...examples(COMMANDS.shot.examples, c),
    '',
    `${c.dim('Docs:')} ${c.cyan('https://github.com/akintola4/rpc-agent')}`,
    '',
  ];
  return out.join('\n');
}

/** Help for one command; plain when colours are off. */
export function commandHelp(topic: HelpTopic, c: Colors): string {
  const h = COMMANDS[topic];
  const out = ['', `${c.bold('Usage:')} ${h.usage}`, '', h.summary, ''];
  if (h.options) out.push(c.bold('Options:'), ...table(h.options, c), '');
  out.push(c.bold('Examples:'), ...examples(h.examples, c), '');
  return out.join('\n');
}
