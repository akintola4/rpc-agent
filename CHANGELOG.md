# Changelog

## 0.3.1

Published to npm as `rpc-agent`.

### Added

- Install with `npx rpc-agent …` or `npm i -g rpc-agent`. MCP setup for
  Claude Code is `claude mcp add --scope user rpc -- npx -y rpc-agent mcp`;
  Cursor uses `"command": "npx", "args": ["-y", "rpc-agent", "mcp"]`.
- Package metadata (repository, homepage, bugs, keywords, author) and a
  `prepublishOnly` check that typechecks, builds and runs the tests.

### Changed

- The missing-Chromium message now says `npx rpc-agent install` (or
  `rpc install`) and names the Playwright version, instead of pointing at
  `npx playwright install chromium` inside the package folder, which under
  npx is a cache directory and could pull a different Playwright.
- `rpc install` run through npx no longer shows Playwright's "install your
  project's dependencies" warning box, which didn't apply.
- `rpc install` downloads only Chromium's headless shell (`--only-shell`),
  which is all rpc launches: about 210 MB on disk instead of about 580 MB.
- Requires Node 20.12 or newer (what `@clack/prompts` needs).
- Chromium is still never downloaded on install: run `rpc install` once.

## 0.3.0

A terminal UI modelled on the `skills` CLI (skills.sh). Nothing changes for
agents, scripts or CI.

### Added

- `rpc` with no arguments, in a terminal, is an interactive capture: URL
  (defaults to a running dev server on localhost), a grouped device picker,
  bezels / full page / dark mode / reduced motion, a summary and a confirm.
  It ends with the equivalent `rpc shot` command.
- `rpc shot` in a terminal: `RPC` banner, a capture summary, a spinner per
  device that resolves to status and time, a results table (status, time,
  console errors), the files written with pixel and file sizes, failures
  grouped with their hint, and `Done!  Open with: open .rpc-shots`.
- `--open` opens the output folder when the capture finishes.
- `rpc devices` in a terminal: aligned, coloured by category, with each
  device's aliases. `rpc doctor` in a terminal: a checklist with the fix in
  a box.
- Per-command help: `rpc help shot`, `rpc shot --help` (also devices,
  doctor, install, mcp). `rpc --help` in a terminal has sections and
  examples.
- `docs/cli-design.md`: what rpc borrows from the `skills` CLI and when the
  rich output is used.

### Unchanged

- Output to pipes, files and CI (`CI` set, `TERM=dumb`) is the 0.2 output.
  `--json` output, exit codes and the MCP server are untouched; `rpc mcp`
  and `--json` don't load the UI code. `NO_COLOR` turns colour off and
  `FORCE_COLOR` turns it on for the plain output.

### Dependencies

- `@clack/prompts` and `picocolors`.

## 0.2.0

From the first real use: an agent reviewing a deployed site on iphone-15,
ipad and desktop-1440 with bezels and full page.

### Added

- Full pages of any height. Pages taller than Chromium's 16,384 px capture
  limit are taken as clipped full-page segments and stitched in Node (no
  native dependencies). Sticky headers and fixed elements appear once. New
  `maxHeight` / `--max-height` cap (60,000 CSS px), reported as `clipped`,
  with `capturedHeight` and `segments` in the result.
- Full-page review in one MCP call. With `fullPage`, `screenshot` returns the
  framed first screen and then the whole page as labelled, viewport-tall JPEG
  slices (`iphone-15 · slice 2/7 · y=852–1704 css px`). New params
  `maxSlices` (10), `saveSlices` and `sliceWidth` (768). When slices are cut,
  the result says which range was skipped, and every slice is saved to disk
  with its path listed. CLI: `--slices`, `--slice-width`.
- Actionable errors. Navigation failures come back per device as `error`,
  `code` (`ERR_NAME_NOT_RESOLVED`, `TIMEOUT`, ...) and `hint`, covering
  sandbox / network allowlists, dev servers not running, proxies, TLS and
  timeouts. MCP results lead with the failures in plain text.
- `reducedMotion` / `--reduced-motion` emulates
  `prefers-reduced-motion: reduce`.
- Missing-browser check. If Playwright's Chromium isn't installed, the CLI and
  the MCP tool say so with the fix (`npx playwright install chromium`, or
  `rpc install`) instead of Playwright's raw error; the MCP server keeps
  running. New `rpc doctor` and `rpc install` commands.

### Changed

- The warm-up scroll covers the whole capped height (up to 100 steps) rather
  than stopping at 30,000 px.
- `pnpm smoke:mcp` takes `--full-page`, `--devices`, `--max-slices`, `--out`.

## 0.1.0

First version: CLI and stdio MCP server, 49 devices and bezels from
Responsive Point Check, Playwright Chromium capture, bezel compositing in a
Playwright page.
