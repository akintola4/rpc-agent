# CLI design notes: what we borrow from `skills`

Reference: the `skills` CLI behind [skills.sh](https://skills.sh/)
(`npx skills add <owner/repo>`), source at
[vercel-labs/skills](https://github.com/vercel-labs/skills), read at v1.7.4
and run in a scratch directory (`skills`, `skills --help`,
`skills add vercel-labs/agent-skills --list`, and an interactive
`skills add` cancelled before anything was installed).

## What makes it feel good

**Two libraries, nothing else for the UI.** `@clack/prompts` for the whole
interaction (intro/outro, spinners, prompts, boxed notes, log lines) and
`picocolors` for inline colour. Everything else is plain `console.log` with a
handful of raw 256-colour escapes.

**A banner, but only where it pays.** Running `skills` with no command prints
a six-row block wordmark (`███╗` "ANSI Shadow" style letters: solid blocks
with a double-line outline that reads as a drop shadow), each row a slightly
darker 256-colour grey (250 → 238), then a one-line tagline and a short list
of `$ npx skills <cmd>` lines with the description dimmed. It never prints
in `--json` mode or when it detects that an AI agent is driving it.

**One rail per run.** Every interactive command opens with
`p.intro(pc.bgCyan(pc.black(' skills ')))`: a black-on-cyan badge at the top
of a grey `│` rail that runs down the left edge. Everything after hangs off
that rail:

- `◇` (green) for a completed step, with its answer dimmed underneath
  (`Installation scope` / `Global`).
- `◆` (cyan) for the prompt that's waiting on you, `●`/`◻`/`◼` for radio and
  checkbox options.
- Spinners (`◒◐◓◑`) that resolve in place into a `◇` line with the result:
  `Found 9 skills` with the count in green.
- Info lines with one or two highlighted tokens, never whole coloured
  sentences: `Source: https://…`, `Skill: <cyan name>`.
- Long lists are a comma list with `+N more` after five.
- `p.note(lines, title)` boxes with rounded corners and the title set into the
  top border (`Installation Summary ───╮`). Inside: a cyan path first, then
  indented `key: value` lines where only the key is coloured (green
  `universal:`, dim `symlink →`, yellow `overwrites:`).
- A table in a note for the security audit: dim column headers, padded
  columns, values coloured by severity (green `Safe` / `0 alerts`, yellow
  `Med Risk`, red `High Risk`), dim `--` for no data.
- A `Proceed with installation?` Yes/No confirm before anything is written.
- `p.outro(pc.green('Done!') + pc.dim('  <one piece of advice>'))` to close
  the rail. Failures use `■` (red) and `p.cancel`.

**Colour is spent on data, not chrome.** Cyan for names and paths, green for
success counts, yellow for warnings, red only for failures, dim grey for
everything secondary. No bold paragraphs, no emoji.

**Help is static text with structure.** `--help` is a bold section heading
per command group (`Manage Skills:`, `Add Options:`), two-column flag lists,
and an examples block of `$ skills …` lines with dimmed `# comments` aligned
in one column.

**It degrades instead of breaking.** `--json` swaps the spinner for a no-op
(`silentSpinner`) and prints only JSON, with "no ANSI codes" promised in the
help. Without a TTY on stdin it doesn't prompt; it prints a tip about `-y` /
`-g` and fails fast. Clack itself turns spinners into plain lines under CI
and falls back to ASCII symbols when the terminal lacks Unicode.

## What rpc takes

| skills | rpc |
| --- | --- |
| Block wordmark, grey gradient | The same treatment spelling `RPC`, shown only by `rpc` with no args and `rpc shot` on an interactive terminal |
| `' skills '` cyan badge intro | `' rpc '` badge, then a dim `vX.Y.Z` |
| Step rail with dimmed answers | Interactive `rpc`: URL → devices → options → summary → confirm |
| `Found 9 skills` (count green) | `Found 49 devices`, `Devices: iphone-15-pro, ipad-air-11, …` (names cyan, `+N more`) |
| `Installation Summary` note | `Capture Summary` note: URL, devices, bezels, full page, colour scheme, output |
| Security table | Results table: device, viewport, status (green 200 / red code), time, console errors (green 0 / yellow N) |
| `Installed N skills` green note | `Captured N devices` note: `✓` + cyan path + dims + size per file, `✗` + error + hint per failure |
| `Proceed with installation?` | `Proceed with capture?` (interactive flow only; `rpc shot` with flags just runs) |
| `Done!` + dim advice | `Done!  Open with: open .rpc-shots` |
| `silentSpinner` in `--json` | `--json` never loads the UI module at all |

Not taken: telemetry, agent auto-detection, the search prompt, the `skills`
help's very long single page (rpc gets per-command help instead:
`rpc shot --help`, `rpc help shot`).

## When the rich UI runs

Rich output (banner, rail, spinners, prompts, boxes) needs all of:

- stdout is a TTY,
- `CI` is not set,
- `TERM` is not `dumb`,
- no `--json`,
- the command isn't `mcp` (the MCP server owns stdout; `rpc mcp` never
  imports the UI module).

Otherwise rpc prints exactly what 0.2 printed (the `ok …` / `x …` lines,
the plain device table, `node …` / `chromium ok` doctor lines, the old usage
text), byte for byte, so scripts and agents that read it keep working.
That includes AI agents: Claude Code and Cursor run commands without a TTY,
so they get the plain output without any agent sniffing.

Colour, separately:

- `NO_COLOR` (any non-empty value) turns colour off everywhere; the rich
  layout stays, in monochrome.
- `FORCE_COLOR` (anything but `0`) turns colour on for the plain output too
  (`ok` green, `x` red, `hint:` yellow), e.g. for coloured CI logs. The
  layout stays plain.
- Both set: `FORCE_COLOR` wins. That's Node's own precedence, and clack 1.x
  colours its symbols through `node:util` `styleText`, so following Node
  keeps clack's symbols and our text in agreement.

## Dependencies

- `@clack/prompts` (1.x): prompts, spinners, rail, notes. Pulls in
  `@clack/core`, `sisteransi`, `fast-string-width`, `fast-wrap-ansi`; all
  small and dependency-free. Writing grouped multi-select, cursor handling
  and cancellation by hand would be more code than the rest of the CLI.
- `picocolors`: 2.6 kB, no dependencies, and `createColors(enabled)` lets us
  decide colour ourselves instead of trusting its own CI heuristics (it turns
  colour on when `CI` is set, which we don't want for a plain log).

Nothing else: no commander/yargs (`node:util` `parseArgs` stays), no
ora/chalk/boxen/cli-table, no node-pty (tests check the mode decisions and
renderers directly, and the real TTY run is checked by hand through a
pseudo-terminal).

## Exit codes

Unchanged for every 0.2 path. The interactive flow adds two: answering "No"
at `Proceed with capture?` exits 0, and Ctrl-C or Escape at any prompt exits
130, the usual code for an interrupt.
